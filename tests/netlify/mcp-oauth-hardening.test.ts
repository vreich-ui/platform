/**
 * The three ways a VALID OAuth grant used to read as an authorization failure,
 * and the diagnostics that now tell them apart.
 *
 * Each test here fails without its fix, and each maps to a real shape of the
 * connector-side message "Authorization with the MCP server failed. You can
 * check your credentials and permissions." — a message that is wrong in every
 * one of these cases, because the credentials were fine:
 *
 *   1. AUDIENCE DRIFT   — the grant was approved through one of this site's
 *      hosts and `/mcp` is called on another (apex vs `www.`, custom domain vs
 *      `*.netlify.app`, a deploy alias). Permanent 401, no diagnostic.
 *   2. READ-AFTER-WRITE LAG — the token record was written by the `/oauth/token`
 *      invocation and is read ~100ms later by the `/mcp` one, over a store
 *      whose requested strong consistency is silently eventual on the
 *      name-lookup path (blob-store.ts documents this for the whole fleet).
 *   3. AN UNHANDLED THROW — the authorization server reaching a blob store that
 *      is unavailable answered a bare 502, which a client reports as an
 *      authorization failure rather than the outage it is.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler as oauthHandler } from '../../netlify/functions/mcp-oauth.js';
import { handler as mcpHandler } from '../../netlify/functions/mcp.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { describeOAuthPrincipal, handleTokenRequest } from '../../packages/core/server/lib/oauth-server.js';
import {
  REFRESH_REUSE_GRACE_MS,
  accessTokenKey,
  putAccessTokenRecord,
  putOAuthClient,
  putRefreshTokenRecord,
  type OAuthBlobStore,
  type OAuthClientRecord,
} from '../../packages/core/server/lib/oauth-store.js';
import { runTenantOAuthFlow, type LambdaLikeHandler, type LambdaLikeResponse } from './tenant-oauth-flow.js';

const HOST = 'oauth-hardening.example';
const ADMIN_EMAIL = 'owner@example.com';
const SITE = 'site_drlurie';

const previousEnv = {
  ADMIN_EMAILS: process.env.ADMIN_EMAILS,
  DEPLOY_URL: process.env.DEPLOY_URL,
  LAMBDA_TASK_ROOT: process.env.LAMBDA_TASK_ROOT,
  MCP_HTTP_AUTH_TOKEN: process.env.MCP_HTTP_AUTH_TOKEN,
  NETLIFY: process.env.NETLIFY,
  NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID,
  URL: process.env.URL,
};

test.beforeEach(() => {
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  // The gate must be opened by the OAUTH token, never by an absent shared secret.
  process.env.MCP_HTTP_AUTH_TOKEN = 'a-different-shared-secret';
  delete process.env.LAMBDA_TASK_ROOT;
});

test.afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const callMcp = (headers: Record<string, string>, body: unknown): Promise<LambdaLikeResponse> =>
  (mcpHandler as unknown as LambdaLikeHandler)({
    httpMethod: 'POST',
    path: '/mcp',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

const toolsList = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

// ─── 1. audience drift ───────────────────────────────────────────────────────

test('a grant approved on the site primary URL still opens /mcp reached on another host of the same site', async () => {
  // The connector was configured with the apex domain; consent happened on the
  // Netlify primary URL. Same deployment, two names.
  process.env.URL = `https://${HOST}`;

  const { accessToken } = await runTenantOAuthFlow({
    oauthHandler: oauthHandler as unknown as LambdaLikeHandler,
    mcpHandler: mcpHandler as unknown as LambdaLikeHandler,
    host: HOST,
    adminEmail: ADMIN_EMAIL,
    mcpHost: 'www.drluriescience.example',
  });

  // And again directly, on a THIRD name of the same deploy.
  process.env.DEPLOY_URL = 'https://deploy-preview-7--drlurie.example';
  const viaDeployAlias = await callMcp(
    { host: 'deploy-preview-7--drlurie.example', authorization: `Bearer ${accessToken}` },
    toolsList
  );
  assert.equal(viaDeployAlias.statusCode, 200, viaDeployAlias.body);
});

test('a token minted for a DIFFERENT deployment is still refused — the spec MUST is intact', async () => {
  const store = laggingStore(0);
  const token = 'minted-for-another-server';
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'client-1',
    client_name: 'Connector',
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp',
    resource: 'https://someone-elses-mcp.example/mcp',
    site: SITE,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const resolved = await describeOAuthPrincipal(store, {
    token,
    site: SITE,
    // Every name of THIS deployment, and none of them is that one.
    resourceUris: [`https://${HOST}/mcp`, 'https://drluriescience.example/mcp'],
    nowMs: Date.now(),
  });

  assert.deepEqual(resolved, { ok: false, reason: 'audience_mismatch' });
});

test('the 401 for an audience mismatch names it in the body and in WWW-Authenticate', async () => {
  const store = laggingStore(0);
  const token = 'wrong-audience-over-http';
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'client-1',
    client_name: 'Connector',
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp',
    resource: 'https://someone-elses-mcp.example/mcp',
    site: SITE,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  process.env.URL = `https://${HOST}`;
  delete process.env.DEPLOY_URL;
  setNetlifyBlobsModuleForTesting({ connectLambda() {}, getStore: () => store as never });

  try {
    const refused = await callMcp({ host: HOST, authorization: `Bearer ${token}` }, toolsList);

    assert.equal(refused.statusCode, 401, refused.body);
    const body = JSON.parse(refused.body) as { error?: { data?: { oauth_failure?: string } } };
    assert.equal(
      body.error?.data?.oauth_failure,
      'audience_mismatch',
      'the one failure an operator cannot otherwise diagnose must be named in the body'
    );
    assert.match(
      refused.headers?.['WWW-Authenticate'] ?? '',
      /error="invalid_token"/,
      'a refused bearer must be told it is invalid so the client re-runs the flow instead of retrying it'
    );
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
  }
});

// ─── 2. read-after-write lag ─────────────────────────────────────────────────

/** A store whose first `misses` reads of any key come back empty, as an eventually-consistent one does. */
const laggingStore = (misses: number): OAuthBlobStore & { reads: number } => {
  const map = new Map<string, string>();
  let reads = 0;
  return {
    get reads() {
      return reads;
    },
    async get(key: string) {
      reads += 1;
      return reads > misses ? (map.get(key) ?? null) : null;
    },
    async setJSON(key: string, value: unknown) {
      map.set(key, JSON.stringify(value));
    },
  } as OAuthBlobStore & { reads: number };
};

test('an access token that the store has not yet made visible is retried, not refused', async () => {
  const store = laggingStore(2);
  const token = 'a-freshly-minted-access-token';
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'client-1',
    client_name: 'Lagging connector',
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp offline_access',
    resource: `https://${HOST}/mcp`,
    site: SITE,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const resolved = await describeOAuthPrincipal(store, {
    token,
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: Date.now(),
  });

  assert.equal(resolved.ok, true, 'two empty reads are a consistency lag, not an answer');
  assert.ok(store.reads >= 3, 'the read must actually have been retried');
});

test('a token that is genuinely absent is still refused after the retries', async () => {
  const store = laggingStore(Number.MAX_SAFE_INTEGER);
  const resolved = await describeOAuthPrincipal(store, {
    token: 'never-existed',
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: Date.now(),
  });

  assert.deepEqual(resolved, { ok: false, reason: 'no_record' });
});

/** A store that is reachable enough to be opened but fails every read. */
const unreadableStore = (): OAuthBlobStore =>
  ({
    async get() {
      throw new Error('blob store unreachable');
    },
    async setJSON() {},
  }) as unknown as OAuthBlobStore;

test('a store that throws on every read is store_error, NOT no_record', async () => {
  // The distinction is the whole point: reporting an outage as "that token
  // does not exist" is what makes a Blobs failure look like a bad credential.
  const resolved = await describeOAuthPrincipal(unreadableStore(), {
    token: 'anything',
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: Date.now(),
  });

  assert.equal(resolved.ok, false);
  assert.equal(resolved.ok === false && resolved.reason, 'store_error');
});

test('a read that throws once and then answers empty is absence, not an outage', async () => {
  // The store got its word in: two clean empty reads mean the record really is
  // not there, whatever happened on the first attempt.
  let call = 0;
  const store = {
    async get() {
      call += 1;
      if (call === 1) throw new Error('transient');
      return null;
    },
    async setJSON() {},
  } as unknown as OAuthBlobStore;

  const resolved = await describeOAuthPrincipal(store, {
    token: 'anything',
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: Date.now(),
  });

  assert.deepEqual(resolved, { ok: false, reason: 'no_record' });
});

test('an unreadable store 401s /mcp — never 500s it — and says store_error', async () => {
  // A governance-store outage must not become an outage for shared-key callers
  // who need no OAuth at all, so the resource server still answers 401.
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting({ connectLambda() {}, getStore: () => unreadableStore() as never });

  try {
    const refused = await callMcp({ host: HOST, authorization: 'Bearer some-token' }, toolsList);

    assert.equal(refused.statusCode, 401, refused.body);
    const body = JSON.parse(refused.body) as { error?: { data?: { oauth_failure?: string } } };
    assert.equal(body.error?.data?.oauth_failure, 'store_error');
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
  }
});

test('an unreadable store makes /oauth/token answer server_error, not invalid_grant', async () => {
  // Answering `invalid_grant` here would tell a client its authorization code
  // was bad when the truth is that we could not look it up at all.
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting({ connectLambda() {}, getStore: () => unreadableStore() as never });

  try {
    const response = await (oauthHandler as unknown as LambdaLikeHandler)({
      httpMethod: 'POST',
      path: '/oauth/token',
      headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: 'some-code',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        code_verifier: 'v'.repeat(43),
        client_id: 'some-client',
      }).toString(),
    });

    assert.equal(response.statusCode, 500, response.body);
    assert.equal((JSON.parse(response.body) as { error?: string }).error, 'server_error');
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
  }
});

test('a record written for another site never resolves, however many times it is read', async () => {
  const store = laggingStore(0);
  const token = 'another-tenants-token';
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'client-1',
    client_name: 'Other tenant',
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp',
    site: 'site_someone_else',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });
  assert.ok(accessTokenKey(token).startsWith('oauth/tokens/'));

  const resolved = await describeOAuthPrincipal(store, {
    token,
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: Date.now(),
  });

  assert.deepEqual(resolved, { ok: false, reason: 'no_record' });
});

// ─── 3. the authorization server never throws out of the function ────────────

test('an unreachable blob store answers a JSON server_error, not a bare 502', async () => {
  // The production fail-closed posture of blob-store.ts: a lambda runtime with
  // no Blobs context at all, where getStore() refuses rather than falling back
  // to the file-backed dev store.
  process.env.LAMBDA_TASK_ROOT = '/var/task';
  delete process.env.NETLIFY;
  delete process.env.NETLIFY_SITE_ID;

  const response = await (oauthHandler as unknown as LambdaLikeHandler)({
    httpMethod: 'POST',
    path: '/oauth/register',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'Probe', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }),
  });

  assert.equal(response.statusCode, 500);
  const body = JSON.parse(response.body) as { error?: string; error_description?: string };
  assert.equal(body.error, 'server_error');
  assert.match(String(body.error_description), /not with your credentials/);
});

test('GET /mcp?health=auth reports the accepted audiences and store reachability, and no secrets', async () => {
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  process.env.URL = `https://${HOST}`;
  process.env.DEPLOY_URL = 'https://deploy-preview-7--drlurie.example';
  process.env.MCP_HTTP_AUTH_TOKEN = 'super-secret-shared-token';
  setNetlifyBlobsModuleForTesting({ connectLambda() {}, getStore: () => laggingStore(0) as never });

  try {
    const probe = await (mcpHandler as unknown as LambdaLikeHandler)({
      httpMethod: 'GET',
      path: '/mcp',
      headers: { host: 'www.drluriescience.example' },
      queryStringParameters: { health: 'auth' },
    });

    assert.equal(probe.statusCode, 200, probe.body);
    const body = JSON.parse(probe.body) as {
      oauth?: { accepted_audiences?: string[]; token_store_reachable?: boolean };
    };
    assert.deepEqual(body.oauth?.accepted_audiences, [
      'https://www.drluriescience.example/mcp',
      `https://${HOST}/mcp`,
      'https://deploy-preview-7--drlurie.example/mcp',
    ]);
    assert.equal(body.oauth?.token_store_reachable, true);
    assert.doesNotMatch(probe.body, /super-secret-shared-token/, 'a public probe must never echo a credential');
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
  }
});

test('the plain liveness probe stays exactly as it was — no store read, no auth block', async () => {
  const probe = await (mcpHandler as unknown as LambdaLikeHandler)({
    httpMethod: 'GET',
    path: '/mcp',
    headers: { host: HOST },
    queryStringParameters: { health: '1' },
  });

  assert.equal(probe.statusCode, 200, probe.body);
  const body = JSON.parse(probe.body) as Record<string, unknown>;
  assert.equal(body.ok, true);
  assert.equal(body.oauth, undefined, 'the keep-warm ping must not pay for a blob read');
});

test('metadata discovery survives an unreachable blob store — it reads no store at all', async () => {
  process.env.LAMBDA_TASK_ROOT = '/var/task';
  delete process.env.NETLIFY;
  delete process.env.NETLIFY_SITE_ID;

  const response = await (oauthHandler as unknown as LambdaLikeHandler)({
    httpMethod: 'GET',
    path: '/.well-known/oauth-protected-resource',
    headers: { host: HOST },
  });

  assert.equal(response.statusCode, 200, response.body);
});

// ─── 4. refresh rotation: a retry must not destroy the grant ─────────────────

/**
 * The fourth shape of "Authorization with the MCP server failed", and the one
 * that survived the first hardening pass because it was deliberately left open
 * (KNOWN_ISSUES §6). Strict rotation deletes the presented refresh token before
 * it issues the replacement, so a RETRIED refresh — a lost response, an HTTP
 * layer that re-POSTs, two workers on the same grant — is `invalid_grant`
 * forever and the grant is gone. Nothing about that is distinguishable, to the
 * human, from a bad credential.
 *
 * These tests drive `handleTokenRequest` directly rather than over HTTP,
 * because the property under test is about the passage of time and `nowMs` is
 * an input here.
 */
const listableStore = (): OAuthBlobStore => {
  const map = new Map<string, string>();
  return {
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      map.set(key, JSON.stringify(value));
    },
    async delete(key: string) {
      map.delete(key);
    },
    list({ prefix }: { prefix: string }) {
      return { blobs: [...map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  } as unknown as OAuthBlobStore;
};

const CLIENT: OAuthClientRecord = {
  schema_version: 'oauth-client.v1',
  client_id: 'client-rotation',
  client_name: 'Connector',
  redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
  token_endpoint_auth_method: 'none',
  grant_types: ['authorization_code', 'refresh_token'],
  response_types: ['code'],
  scope: 'mcp offline_access',
  site: SITE,
  created_at: new Date(0).toISOString(),
  registration: 'dynamic',
};

const seedGrant = async (store: OAuthBlobStore, nowMs: number) => {
  await putOAuthClient(store, CLIENT);
  const refreshToken = 'refresh-original';
  await putRefreshTokenRecord(store, refreshToken, {
    schema_version: 'oauth-refresh-token.v1',
    client_id: CLIENT.client_id,
    client_name: CLIENT.client_name,
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp offline_access',
    site: SITE,
    family_id: 'family-1',
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 30 * 24 * 3_600_000).toISOString(),
  });
  return refreshToken;
};

const refresh = (store: OAuthBlobStore, refreshToken: string, nowMs: number) =>
  handleTokenRequest(store, {
    params: { grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT.client_id },
    site: SITE,
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
  });

test('a refresh retried inside the grace window is honoured instead of killing the grant', async () => {
  const store = listableStore();
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const original = await seedGrant(store, t0);

  const first = await refresh(store, original, t0);
  assert.equal(first.status, 200, JSON.stringify(first.body));

  // The client never saw that response and retried, one second later.
  const retry = await refresh(store, original, t0 + 1_000);
  assert.equal(retry.status, 200, JSON.stringify(retry.body));
  assert.notEqual(retry.body.refresh_token, first.body.refresh_token);

  // And the successor from the first exchange is still usable — the retry
  // widened nothing and destroyed nothing.
  const successor = await refresh(store, first.body.refresh_token as string, t0 + 2_000);
  assert.equal(successor.status, 200, JSON.stringify(successor.body));
});

test('a refresh replayed AFTER the grace window is reuse: refused, and the whole family is revoked', async () => {
  const store = listableStore();
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  const original = await seedGrant(store, t0);

  const first = await refresh(store, original, t0);
  assert.equal(first.status, 200);
  const successorToken = first.body.refresh_token as string;

  // Well past the window: this is a stolen token being replayed, not a retry.
  const replay = await refresh(store, original, t0 + REFRESH_REUSE_GRACE_MS + 1_000);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.error, 'invalid_grant');

  // Reuse detection's whole point: the token the attacker (or the client) holds
  // dies too. Strict deletion could never do this — a deleted record detects
  // nothing and its successor kept working.
  const successorAfterRevocation = await refresh(store, successorToken, t0 + REFRESH_REUSE_GRACE_MS + 2_000);
  assert.equal(successorAfterRevocation.status, 400);
  assert.equal(successorAfterRevocation.body.error, 'invalid_grant');
});

test('an access token is not handed out until its record reads back', async () => {
  // Two misses before the record becomes visible — the replication lag that
  // makes a brand-new token 401 on the connector's very first call.
  const store = laggingStore(2);
  await putOAuthClient(store, CLIENT);
  const t0 = Date.parse('2026-01-01T00:00:00.000Z');
  await putRefreshTokenRecord(store, 'refresh-lagging', {
    schema_version: 'oauth-refresh-token.v1',
    client_id: CLIENT.client_id,
    client_name: CLIENT.client_name,
    subject_email: ADMIN_EMAIL,
    subject_id: 'sub-1',
    scope: 'mcp offline_access',
    site: SITE,
    family_id: 'family-lag',
    issued_at: new Date(t0).toISOString(),
    expires_at: new Date(t0 + 30 * 24 * 3_600_000).toISOString(),
  });

  const issued = await refresh(store, 'refresh-lagging', t0);
  assert.equal(issued.status, 200, JSON.stringify(issued.body));

  // The token handed to the client resolves on the very next read — which is
  // what the connector's first /mcp call does.
  const resolved = await describeOAuthPrincipal(store, {
    token: issued.body.access_token as string,
    site: SITE,
    resourceUris: [`https://${HOST}/mcp`],
    nowMs: t0,
  });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
});
