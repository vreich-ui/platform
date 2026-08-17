/**
 * W14 F10 — the OAuth 2.1 authorization server, driven end to end.
 *
 * These run the REAL handler against the file-backed dev store, so every
 * assertion below is about the same code path a connector hits: metadata →
 * dynamic registration → authorize → human consent → code exchange → a token
 * that opens `/mcp`. The security properties the MCP authorization spec makes
 * MUST-level (PKCE, exact redirect matching, single-use codes, audience
 * binding, refresh rotation, and the WWW-Authenticate challenge) each have a
 * test that fails if the property is removed.
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import { handler as oauthHandler } from '../../netlify/functions/mcp-oauth.js';
import { handler as mcpHandler } from '../../netlify/functions/mcp.js';

const HOST = 'oauth-test.example';
const ORIGIN = `https://${HOST}`;
const ADMIN_EMAIL = 'owner@example.com';
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const previousEnv = {
  MCP_HTTP_AUTH_TOKEN: process.env.MCP_HTTP_AUTH_TOKEN,
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  LAMBDA_TASK_ROOT: process.env.LAMBDA_TASK_ROOT,
};

test.beforeEach(() => {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  delete process.env.LAMBDA_TASK_ROOT;
});

test.afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type OAuthEvent = {
  httpMethod: string;
  path: string;
  headers?: Record<string, string>;
  queryStringParameters?: Record<string, string>;
  body?: string;
};

type OAuthResponse = { statusCode: number; headers?: Record<string, string>; body: string };

const call = async (event: OAuthEvent, context?: unknown): Promise<OAuthResponse> =>
  (await oauthHandler(
    { headers: { host: HOST, ...(event.headers ?? {}) }, ...event },
    context as never
  )) as OAuthResponse;

const jsonBody = (response: OAuthResponse) => JSON.parse(response.body) as Record<string, string>;

/** A signed-in Netlify Identity user, exactly as the Functions runtime injects it. */
const identityContext = (email: string) => ({ clientContext: { user: { sub: `sub-${email}`, email } } });

const postJson = (path: string, body: unknown, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  path,
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify(body),
});

const postForm = (path: string, params: Record<string, string>, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  path,
  headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body: new URLSearchParams(params).toString(),
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier, 'utf8').digest('base64url') };
};

const registerClient = async (redirectUris: string[] = [REDIRECT_URI]) => {
  const response = await call(
    postJson('/oauth/register', { client_name: 'Test Connector', redirect_uris: redirectUris })
  );
  assert.equal(response.statusCode, 201, response.body);
  return jsonBody(response);
};

/** Registration → authorize → approve → code. The happy path, reused by most tests. */
const approvedCode = async (options: { resource?: string; scope?: string } = {}) => {
  const client = await registerClient();
  const { verifier, challenge } = pkce();

  const authorize = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'state-123',
      ...(options.scope ? { scope: options.scope } : {}),
      ...(options.resource ? { resource: options.resource } : {}),
    },
  });
  assert.equal(authorize.statusCode, 302, authorize.body);
  const requestId = new URL(authorize.headers?.Location ?? '', ORIGIN).searchParams.get('request_id');
  assert.ok(requestId, 'authorize must hand a request_id to the consent screen');

  const consent = await call(
    postJson('/oauth/consent', { request_id: requestId, action: 'approve' }),
    identityContext(ADMIN_EMAIL)
  );
  assert.equal(consent.statusCode, 200, consent.body);
  const redirectTo = new URL(jsonBody(consent).redirect_to);
  const code = redirectTo.searchParams.get('code');
  assert.ok(code, 'approval must return an authorization code');

  return { client, verifier, code, requestId, redirectTo };
};

// ─── metadata ────────────────────────────────────────────────────────────────

test('protected-resource metadata points at this origin as its own authorization server', async () => {
  const response = await call({ httpMethod: 'GET', path: '/.well-known/oauth-protected-resource' });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { resource: string; authorization_servers: string[] };
  assert.equal(body.resource, `${ORIGIN}/mcp`);
  assert.deepEqual(body.authorization_servers, [ORIGIN]);
});

test('metadata is served for the resource-path-suffixed probe too', async () => {
  // MCP clients try /.well-known/oauth-protected-resource/mcp before the bare
  // path; a 404 there sends some of them straight to "no auth server found".
  const response = await call({ httpMethod: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
  assert.equal(response.statusCode, 200);
});

test('authorization-server metadata advertises S256 PKCE and no weaker challenge method', async () => {
  const response = await call({ httpMethod: 'GET', path: '/.well-known/oauth-authorization-server' });

  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as Record<string, string[] | string>;
  assert.equal(body.issuer, ORIGIN);
  assert.equal(body.authorization_endpoint, `${ORIGIN}/oauth/authorize`);
  assert.equal(body.token_endpoint, `${ORIGIN}/oauth/token`);
  assert.equal(body.registration_endpoint, `${ORIGIN}/oauth/register`);
  assert.deepEqual(body.code_challenge_methods_supported, ['S256']);
  assert.deepEqual(body.grant_types_supported, ['authorization_code', 'refresh_token']);
  assert.deepEqual(body.scopes_supported, ['mcp', 'offline_access']);
});

test('protected-resource metadata advertises offline access for ChatGPT reconnects', async () => {
  const response = await call({ httpMethod: 'GET', path: '/.well-known/oauth-protected-resource/mcp' });
  const body = JSON.parse(response.body) as Record<string, string[]>;

  assert.deepEqual(body.scopes_supported, ['mcp', 'offline_access']);
});

// ─── dynamic client registration ─────────────────────────────────────────────

test('dynamic registration issues a public client with no secret by default', async () => {
  const client = await registerClient();

  assert.ok(client.client_id);
  assert.equal(client.client_secret, undefined, 'a public client must not be handed a secret it cannot protect');
  assert.equal(client.token_endpoint_auth_method, 'none');
  assert.equal(client.scope, 'mcp offline_access');
});

test('registration refuses a redirect URI that is not https or loopback', async () => {
  const response = await call(
    postJson('/oauth/register', { client_name: 'Bad', redirect_uris: ['http://evil.example/cb'] })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(jsonBody(response).error, 'invalid_redirect_uri');
});

test('registration refuses an empty redirect_uris list', async () => {
  const response = await call(postJson('/oauth/register', { client_name: 'Bad' }));
  assert.equal(response.statusCode, 400);
});

// ─── authorization request ───────────────────────────────────────────────────

test('an unknown client_id is refused in place, never redirected', async () => {
  const response = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: { response_type: 'code', client_id: 'nope', redirect_uri: REDIRECT_URI },
  });

  assert.equal(response.statusCode, 400);
  assert.match(response.headers?.['Content-Type'] ?? '', /text\/html/);
  assert.equal(response.headers?.Location, undefined, 'an unverified client must never trigger a redirect');
});

test('a redirect_uri that is not exactly registered is refused in place', async () => {
  const client = await registerClient();
  const { challenge } = pkce();

  const response = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      // A prefix of the registered URI: the classic open-redirect probe.
      redirect_uri: `${REDIRECT_URI}.attacker.example`,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });

  assert.equal(response.statusCode, 400);
  assert.equal(response.headers?.Location, undefined);
});

test('a request without PKCE is rejected back to the client, with state intact', async () => {
  const client = await registerClient();

  const response = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      state: 'keep-me',
    },
  });

  assert.equal(response.statusCode, 302);
  const location = new URL(response.headers?.Location ?? '');
  assert.equal(location.searchParams.get('error'), 'invalid_request');
  assert.equal(location.searchParams.get('state'), 'keep-me');
});

test('a resource parameter naming a different server is refused (RFC 8707 audience)', async () => {
  const client = await registerClient();
  const { challenge } = pkce();

  const response = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://someone-elses-server.example/mcp',
    },
  });

  assert.equal(response.statusCode, 302);
  assert.equal(new URL(response.headers?.Location ?? '').searchParams.get('error'), 'invalid_target');
});

// ─── consent ─────────────────────────────────────────────────────────────────

test('consent requires a signed-in user', async () => {
  const response = await call(postJson('/oauth/consent', { request_id: 'anything', action: 'info' }));
  assert.equal(response.statusCode, 401);
});

test('consent refuses a signed-in user who is not an admin of this site', async () => {
  const response = await call(
    postJson('/oauth/consent', { request_id: 'anything', action: 'info' }),
    identityContext('reader@example.com')
  );

  assert.equal(response.statusCode, 403);
});

test('approval returns the code to the registered redirect URI with state preserved', async () => {
  const { redirectTo } = await approvedCode();

  assert.equal(`${redirectTo.origin}${redirectTo.pathname}`, REDIRECT_URI);
  assert.equal(redirectTo.searchParams.get('state'), 'state-123');
  assert.ok(redirectTo.searchParams.get('code'));
});

test('denial returns access_denied instead of a code', async () => {
  const client = await registerClient();
  const { challenge } = pkce();
  const authorize = await call({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    },
  });
  const requestId = new URL(authorize.headers?.Location ?? '', ORIGIN).searchParams.get('request_id') ?? '';

  const consent = await call(
    postJson('/oauth/consent', { request_id: requestId, action: 'deny' }),
    identityContext(ADMIN_EMAIL)
  );

  assert.equal(consent.statusCode, 200);
  const location = new URL(jsonBody(consent).redirect_to);
  assert.equal(location.searchParams.get('error'), 'access_denied');
  assert.equal(location.searchParams.get('code'), null);
});

test('an authorization request can only be answered once', async () => {
  const { requestId } = await approvedCode();

  const second = await call(
    postJson('/oauth/consent', { request_id: requestId, action: 'approve' }),
    identityContext(ADMIN_EMAIL)
  );

  assert.equal(second.statusCode, 404);
});

// ─── token endpoint ──────────────────────────────────────────────────────────

test('the code exchange requires the matching PKCE verifier', async () => {
  const { client, code } = await approvedCode();

  const response = await call(
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: randomBytes(32).toString('base64url'),
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(jsonBody(response).error, 'invalid_grant');
});

test('a valid exchange returns a bearer access token and a refresh token', async () => {
  const { client, code, verifier } = await approvedCode();

  const response = await call(
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    })
  );

  assert.equal(response.statusCode, 200, response.body);
  const body = jsonBody(response);
  assert.equal(body.token_type, 'Bearer');
  assert.ok(body.access_token);
  assert.ok(body.refresh_token);
  assert.equal(body.scope, 'mcp offline_access');
  assert.equal(response.headers?.['Cache-Control'], 'no-store');
});

test('an explicit mcp-only request is not widened to offline access', async () => {
  const { client, code, verifier } = await approvedCode({ scope: 'mcp' });
  const response = await call(
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    })
  );

  assert.equal(response.statusCode, 200, response.body);
  assert.equal(jsonBody(response).scope, 'mcp');
});

test('an authorization code cannot be redeemed twice', async () => {
  const { client, code, verifier } = await approvedCode();
  const params = {
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: client.client_id,
    code_verifier: verifier,
  };

  assert.equal((await call(postForm('/oauth/token', params))).statusCode, 200);
  const replay = await call(postForm('/oauth/token', params));

  assert.equal(replay.statusCode, 400);
  assert.equal(jsonBody(replay).error, 'invalid_grant');
});

test('a code issued to one client cannot be redeemed by another', async () => {
  const { code, verifier } = await approvedCode();
  const other = await registerClient(['https://other.example/cb']);

  const response = await call(
    postForm('/oauth/token', {
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      client_id: other.client_id,
      code_verifier: verifier,
    })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(jsonBody(response).error, 'invalid_grant');
});

test('refresh tokens rotate: the presented one dies, a new pair is issued', async () => {
  const { client, code, verifier } = await approvedCode();
  const first = jsonBody(
    await call(
      postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
      })
    )
  );

  const refreshed = await call(
    postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    })
  );
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const second = jsonBody(refreshed);
  assert.notEqual(second.access_token, first.access_token);
  assert.notEqual(second.refresh_token, first.refresh_token);

  const replay = await call(
    postForm('/oauth/token', {
      grant_type: 'refresh_token',
      refresh_token: first.refresh_token,
      client_id: client.client_id,
    })
  );
  assert.equal(replay.statusCode, 400, 'a rotated refresh token must be dead');
});

test('an unsupported grant type is refused', async () => {
  const client = await registerClient();
  const response = await call(
    postForm('/oauth/token', { grant_type: 'client_credentials', client_id: client.client_id })
  );

  assert.equal(response.statusCode, 400);
  assert.equal(jsonBody(response).error, 'unsupported_grant_type');
});

// ─── the resource server ─────────────────────────────────────────────────────

const mcpCall = async (headers: Record<string, string>) => {
  const response = (await mcpHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', host: HOST, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }),
  })) as OAuthResponse;
  return response;
};

test('an OAuth access token opens /mcp even though it is not the shared secret', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'a-completely-different-shared-secret';
  const { client, code, verifier } = await approvedCode();
  const token = jsonBody(
    await call(
      postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
      })
    )
  ).access_token;

  const response = await mcpCall({ authorization: `Bearer ${token}` });

  assert.equal(response.statusCode, 200, response.body);
});

test('a 401 from /mcp carries the WWW-Authenticate challenge that points to the metadata', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';

  const response = await mcpCall({});

  assert.equal(response.statusCode, 401);
  const challenge = response.headers?.['WWW-Authenticate'] ?? '';
  assert.match(challenge, /^Bearer realm="/);
  assert.match(challenge, new RegExp(`resource_metadata="${ORIGIN}/\\.well-known/oauth-protected-resource"`));
});

test('a bad bearer token is an invalid_token challenge, not a silent 401', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';

  const response = await mcpCall({ authorization: 'Bearer not-a-real-token' });

  assert.equal(response.statusCode, 401);
  assert.match(response.headers?.['WWW-Authenticate'] ?? '', /error="invalid_token"/);
});

test('a revoked access token stops working immediately', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';
  const { client, code, verifier } = await approvedCode();
  const token = jsonBody(
    await call(
      postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
      })
    )
  ).access_token;
  assert.equal((await mcpCall({ authorization: `Bearer ${token}` })).statusCode, 200);

  const revoked = await call(postForm('/oauth/revoke', { token, client_id: client.client_id }));
  assert.equal(revoked.statusCode, 200);

  assert.equal(
    (await mcpCall({ authorization: `Bearer ${token}` })).statusCode,
    401,
    'revocation must take effect on the next request, with no cache to wait out'
  );
});

// ─── W18 T18.6b — the membership family over /mcp ─────────────────────────────

const rpc = async (headers: Record<string, string>, method: string, params?: Record<string, unknown>) => {
  const response = (await mcpHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', host: HOST, ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  })) as OAuthResponse;
  return { response, body: JSON.parse(response.body) as { result?: Record<string, unknown>; error?: unknown } };
};

const oauthToken = async () => {
  const { client, code, verifier } = await approvedCode();
  return jsonBody(
    await call(
      postForm('/oauth/token', {
        grant_type: 'authorization_code',
        code,
        redirect_uri: REDIRECT_URI,
        client_id: client.client_id,
        code_verifier: verifier,
      })
    )
  ).access_token as string;
};

const MEMBERSHIP_TOOL_NAMES = [
  'membership_contract',
  'member_list',
  'member_get',
  'member_audit',
  'membership_policy_get',
  'member_invite',
  'invitation_resend',
  'invitation_revoke',
  'member_set_role',
  'member_suspend',
  'member_reinstate',
  'member_remove',
  'member_purge',
  'ownership_transfer',
  'membership_policy_set',
  'member_export',
];

test('tools/list: the 16 membership tools are listed to an OAuth-bound human and HIDDEN from a shared-token session (snapshot)', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';
  const shared = await rpc({ authorization: 'Bearer the-shared-secret' }, 'tools/list');
  assert.equal(shared.response.statusCode, 200);
  const sharedNames = (shared.body.result?.tools as Array<{ name: string }>).map((t) => t.name);
  for (const name of MEMBERSHIP_TOOL_NAMES)
    assert.ok(!sharedNames.includes(name), `${name} must be hidden from the shared token`);
  assert.ok(sharedNames.includes('object_get'));

  const token = await oauthToken();
  const human = await rpc({ authorization: `Bearer ${token}` }, 'tools/list');
  assert.equal(human.response.statusCode, 200);
  const humanNames = (human.body.result?.tools as Array<{ name: string }>).map((t) => t.name);
  for (const name of MEMBERSHIP_TOOL_NAMES)
    assert.ok(humanNames.includes(name), `${name} must be listed to the OAuth human`);
  assert.deepEqual(
    humanNames.filter((n) => !sharedNames.includes(n)).sort(),
    [...MEMBERSHIP_TOOL_NAMES].sort(),
    'the ONLY difference between the two listings is the membership family'
  );
});

test('tools/call: a shared-token session calling a membership tool gets 403 membership_requires_human (defence in depth); the OAuth human (an ADMIN_EMAILS owner) can read the contract, list, and dry-run an invite', async () => {
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';
  const refused = await rpc({ authorization: 'Bearer the-shared-secret' }, 'tools/call', {
    name: 'member_list',
    arguments: { agent_name: 'owner@example.com' },
  });
  assert.equal(refused.response.statusCode, 200);
  const refusedResult = refused.body.result as { isError?: boolean; structuredContent?: { error_code?: string } };
  assert.equal(refusedResult.isError, true);
  assert.equal(refusedResult.structuredContent?.error_code, 'membership_requires_human');

  const token = await oauthToken();
  const contract = await rpc({ authorization: `Bearer ${token}` }, 'tools/call', {
    name: 'membership_contract',
    arguments: {},
  });
  const contractResult = contract.body.result as {
    isError?: boolean;
    structuredContent?: { contract?: { gate?: { rule?: string } } };
  };
  assert.equal(contractResult.isError, undefined, JSON.stringify(contract.body).slice(0, 300));
  assert.equal(contractResult.structuredContent?.contract?.gate?.rule, 'membership_requires_human');

  const list = await rpc({ authorization: `Bearer ${token}` }, 'tools/call', { name: 'member_list', arguments: {} });
  const listResult = list.body.result as {
    isError?: boolean;
    structuredContent?: { users?: Array<{ email: string; source: string }> };
  };
  assert.equal(listResult.isError, undefined, JSON.stringify(list.body).slice(0, 300));
  assert.ok(listResult.structuredContent?.users?.some((u) => u.email === ADMIN_EMAIL && u.source === 'environment'));

  const dry = await rpc({ authorization: `Bearer ${token}` }, 'tools/call', {
    name: 'member_invite',
    arguments: { email: 'newbie@example.com', role: 'editor', dry_run: true },
  });
  const dryResult = dry.body.result as {
    isError?: boolean;
    structuredContent?: { dry_run?: boolean; would?: string; gotrue_email?: boolean };
  };
  assert.equal(dryResult.isError, undefined, JSON.stringify(dry.body).slice(0, 300));
  assert.equal(dryResult.structuredContent?.dry_run, true);
  assert.equal(dryResult.structuredContent?.would, 'invite');
  assert.equal(dryResult.structuredContent?.gotrue_email, false, 'no GoTrue admin token on an MCP request');
});
