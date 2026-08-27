/**
 * The connector flow, driven end to end against ONE tenant's function shims.
 *
 * Extracted so every site in the fleet can be held to it (P1: a change to core
 * that a tenant does not get is not finished). It is a helper, not a suite:
 * each tenant needs its OWN test file because `setSiteIdentityConfigProvider`
 * is a module-level singleton — importing two sites' `policy-bindings` into one
 * process leaves whichever registered last answering `getSiteIdentity()` for
 * both, which is exactly the cross-tenant confusion these tests exist to catch.
 * Separate files mean separate processes, which is also how the sites actually
 * run.
 *
 * The sequence below is the one a real client performs, in order:
 *   discovery → dynamic registration → authorize → consent → code exchange →
 *   an authenticated `tools/list` on `/mcp`.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';

export type LambdaLikeResponse = { statusCode: number; headers?: Record<string, string>; body: string };
export type LambdaLikeHandler = (event: unknown, context?: unknown) => Promise<LambdaLikeResponse>;

export type TenantFlowOptions = {
  /** The tenant's `mcp-oauth` shim handler. */
  oauthHandler: LambdaLikeHandler;
  /** The tenant's `mcp` shim handler. */
  mcpHandler: LambdaLikeHandler;
  /** The host the connector talks to, e.g. `example.netlify.app`. */
  host: string;
  /** An `ADMIN_EMAILS` bootstrap owner — the human who approves at consent. */
  adminEmail: string;
  /**
   * The host `/mcp` is finally called on, when it differs from the one the
   * grant was approved through. Defaults to `host`.
   */
  mcpHost?: string;
};

const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const jsonBody = (response: LambdaLikeResponse) => JSON.parse(response.body) as Record<string, string>;

/** A signed-in Netlify Identity user, exactly as the Functions runtime injects it. */
const identityContext = (email: string) => ({ clientContext: { user: { sub: `sub-${email}`, email } } });

export const pkcePair = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') };
};

/**
 * Runs the whole flow and asserts each step. Returns the credentials it
 * obtained so a caller can go on to probe them (expiry, revocation, a second
 * host, a refresh).
 */
export const runTenantOAuthFlow = async (
  options: TenantFlowOptions
): Promise<{ accessToken: string; refreshToken: string; clientId: string }> => {
  const { oauthHandler, mcpHandler, host, adminEmail } = options;
  const mcpHost = options.mcpHost ?? host;
  const resource = `https://${host}/mcp`;

  const call = (event: Record<string, unknown>, context?: unknown) =>
    oauthHandler({ headers: { host }, ...event }, context);

  // ── discovery ──────────────────────────────────────────────────────────────
  const protectedResource = await call({ httpMethod: 'GET', path: '/.well-known/oauth-protected-resource' });
  assert.equal(protectedResource.statusCode, 200, protectedResource.body);
  assert.equal(jsonBody(protectedResource).resource, resource);

  const serverMetadata = await call({ httpMethod: 'GET', path: '/.well-known/oauth-authorization-server' });
  assert.equal(serverMetadata.statusCode, 200, serverMetadata.body);
  assert.equal(jsonBody(serverMetadata).issuer, `https://${host}`);

  // ── dynamic registration ───────────────────────────────────────────────────
  const registration = await call({
    httpMethod: 'POST',
    path: '/oauth/register',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Fleet parity connector', redirect_uris: [REDIRECT_URI] }),
  });
  assert.equal(registration.statusCode, 201, registration.body);
  const client = jsonBody(registration);

  // ── authorize ──────────────────────────────────────────────────────────────
  const { verifier, challenge } = pkcePair();
  const authorize = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'fleet-state',
      resource,
    },
  });
  assert.equal(authorize.statusCode, 302, authorize.body);
  const requestId = new URL(authorize.headers?.Location ?? '', `https://${host}`).searchParams.get('request_id');
  assert.ok(requestId, 'authorize must hand a request_id to the consent screen');

  // ── consent (the human) ────────────────────────────────────────────────────
  const consent = await call(
    {
      httpMethod: 'POST',
      path: '/oauth/consent',
      headers: { host, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, action: 'approve' }),
    },
    identityContext(adminEmail)
  );
  assert.equal(consent.statusCode, 200, consent.body);
  const code = new URL(jsonBody(consent).redirect_to).searchParams.get('code');
  assert.ok(code, 'approval must return an authorization code');

  // ── code exchange ──────────────────────────────────────────────────────────
  const token = await call({
    httpMethod: 'POST',
    path: '/oauth/token',
    headers: { host, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: client.client_id,
      resource,
    }).toString(),
  });
  assert.equal(token.statusCode, 200, token.body);
  const granted = jsonBody(token);
  assert.ok(granted.access_token, 'the exchange must return an access token');
  assert.ok(granted.refresh_token, 'the exchange must return a refresh token');

  // ── the token opens /mcp ───────────────────────────────────────────────────
  const listed = await mcpHandler({
    httpMethod: 'POST',
    path: '/mcp',
    headers: {
      host: mcpHost,
      'content-type': 'application/json',
      authorization: `Bearer ${granted.access_token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
  assert.equal(listed.statusCode, 200, `the freshly granted token must open /mcp — got ${listed.body}`);
  const tools = JSON.parse(listed.body) as { result?: { tools?: unknown[] } };
  assert.ok((tools.result?.tools?.length ?? 0) > 0, 'an authorized tools/list must return this tenant’s tools');

  return { accessToken: granted.access_token, refreshToken: granted.refresh_token, clientId: client.client_id };
};
