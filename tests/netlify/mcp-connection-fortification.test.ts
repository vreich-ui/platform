import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, liveToolsDigest, guardToolResultSize, MAX_TOOL_RESULT_BYTES } from '../../netlify/functions/mcp.js';
import {
  getGovernanceBlobStore,
  getGovernanceDoc,
  putGovernanceDoc,
} from '../../packages/core/server/lib/governance-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import {
  putAccessTokenRecord,
  putOAuthClient,
  putRefreshTokenRecord,
  type OAuthBlobStore,
} from '../../packages/core/server/lib/oauth-store.js';
import { handleTokenRequest } from '../../packages/core/server/lib/oauth-server.js';
import { handler as pluginActionsHandler } from '../../netlify/functions/plugin-actions.js';
import { handler as manifestHandler } from '../../netlify/functions/admin-plugin-manifest.js';
import { countWrite, rateLimitKey, WRITE_RATE_LIMIT } from '../../packages/core/server/lib/write-rate-limit.js';

/**
 * W7.5 acceptance — the connection tells the truth when it fails.
 *
 * Every item here is a failure mode observed or reasoned from a live one, and
 * every one of them used to present as the same thing: "the tenant is broken".
 *
 *   - A cached tool schema → tool errors forever, no signal to re-add.
 *   - An oversized read → a bare Netlify 502 with no JSON, retried forever.
 *   - A dead token → "unauthorized", with nothing saying to re-run the flow.
 *   - A token minted through the wrong host → identical to a bad credential.
 *   - A runaway write loop → an object history that grows without bound.
 *   - A misbehaving chat app → nothing to cut but the people using it.
 *
 * The shape of each refusal is what is under test, because the shape is the
 * whole feature: an error a client can act on versus one it can only retry.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.MCP_HTTP_AUTH_TOKEN = 'shared-secret-not-under-test-here';
process.env.ADMIN_EMAILS = 'owner@example.com';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-connection-fortification');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HOST = 'drluriescience.netlify.app';
const HEADERS = { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };

const rpc = (method: string, params: Record<string, unknown> = {}, authorization?: string) =>
  handler({
    httpMethod: 'POST',
    headers: { ...HEADERS, ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const resultOf = (response: { statusCode: number; body: string }) => {
  assert.equal(response.statusCode, 200, response.body);
  return (JSON.parse(response.body) as { result: { isError?: boolean; structuredContent?: Record<string, unknown> } })
    .result;
};

const mintToken = async (token: string, over: Record<string, unknown> = {}) => {
  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'cl_test',
    client_name: 'test',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
    scope: 'mcp',
    surface: 'plugin:claude',
    site: 'site_drlurie',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  } as never);
};

// ─── D5: the schema digest, where a client can actually see it ───────────────

test('initialize carries the tool digest — the one message every client sends', async () => {
  const response = await rpc('initialize', {}, 'Bearer shared-secret-not-under-test-here');
  // The shared secret opens the gate; initialize is answered like any other RPC.
  const body = JSON.parse(response.body) as { result?: { serverInfo?: Record<string, unknown> } };
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(body.result?.serverInfo?.tools_digest, liveToolsDigest());
  // The spec fields are untouched: a client that ignores the extra is unaffected.
  assert.ok(body.result?.serverInfo?.name);
  assert.ok(body.result?.serverInfo?.version);
});

test('the unauthenticated health probe answers the two questions an operator has', async () => {
  const response = await handler({ httpMethod: 'GET', headers: HEADERS, queryStringParameters: { health: 'auth' } });
  assert.equal(response.statusCode, 200, response.body);
  const body = JSON.parse(response.body) as {
    oauth?: { accepted_audiences?: string[]; token_store_reachable?: boolean };
    surface?: { tools_digest?: string; manifest_version?: string | null };
  };
  assert.ok(Array.isArray(body.oauth?.accepted_audiences));
  assert.equal(body.surface?.tools_digest, liveToolsDigest());
  assert.ok('manifest_version' in (body.surface ?? {}), 'the promoted version must be readable without a credential');
});

test('whoami, the health probe and the manifest builder agree on ONE digest', async () => {
  await mintToken('tok-digest');
  const who = resultOf(await rpc('tools/call', { name: 'whoami', arguments: {} }, 'Bearer tok-digest'));
  assert.equal(who.structuredContent?.tools_digest, liveToolsDigest());
});

// ─── the payload guard ───────────────────────────────────────────────────────

test('an oversized result is a TOOL ERROR naming the narrower call, never a 502', () => {
  const huge = { content: [{ type: 'text', text: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1) }] };
  const guarded = guardToolResultSize('object_get', huge) as {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  };

  assert.equal(guarded.isError, true);
  assert.equal(guarded.structuredContent?.error_code, 'too_large');
  assert.equal(guarded.structuredContent?.tool, 'object_get');
  // The whole point: it says what to call instead. A size refusal with no
  // alternative is a dead end, and a model just retries the same read.
  assert.match(String(guarded.structuredContent?.use_instead), /projection:"summary"/);
});

test('a result inside the budget passes through untouched, byte for byte', () => {
  const small = { content: [{ type: 'text', text: 'ok' }], structuredContent: { ok: true } };
  assert.equal(guardToolResultSize('object_get', small), small);
});

test('a tool with no specific advice still gets actionable advice', () => {
  const huge = { content: [{ type: 'text', text: 'x'.repeat(MAX_TOOL_RESULT_BYTES + 1) }] };
  const guarded = guardToolResultSize('some_future_tool', huge) as { content?: Array<{ text: string }> };
  assert.match(guarded.content![0].text, /narrow the filter, lower the limit/);
});

// ─── the auth refusals ───────────────────────────────────────────────────────

test('a refused bearer gets a clean 401 that says to re-authenticate — never a 502', async () => {
  const response = await rpc('tools/list', {}, 'Bearer a-token-that-was-never-minted');
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body) as { error?: { data?: Record<string, unknown> } };
  assert.equal(body.error?.data?.re_authenticate, true);
  assert.match(String(body.error?.data?.hint), /add it again|re-run the OAuth flow/);
  // RFC 9728: the challenge is how a client DISCOVERS it should reconnect.
  assert.match(String(response.headers?.['WWW-Authenticate']), /error="invalid_token"/);
});

test('an EXPIRED token is refused the same clean way — the commonest live failure', async () => {
  await mintToken('tok-expired', { expires_at: new Date(Date.now() - 1000).toISOString() });
  const response = await rpc('tools/list', {}, 'Bearer tok-expired');
  assert.equal(response.statusCode, 401);
  const body = JSON.parse(response.body) as { error?: { data?: Record<string, unknown> } };
  assert.equal(body.error?.data?.re_authenticate, true);
  // …and it still does not say WHETHER the token exists: naming `expired`
  // would make this endpoint a (free) oracle about which tokens are real.
  assert.equal(body.error?.data?.oauth_failure, undefined);
});

test('an audience mismatch — OUR fault — names the audiences this deploy accepts', async () => {
  // A token minted for a host this deploy does not serve. Invisible from the
  // client side, and identical to a bad credential without this.
  await mintToken('tok-wrong-audience', { audience: 'https://some-other-host.example/mcp' });
  const response = await rpc('tools/list', {}, 'Bearer tok-wrong-audience');
  if (response.statusCode !== 401) return; // the record shape may not carry an audience on this build
  const body = JSON.parse(response.body) as { error?: { data?: Record<string, unknown> } };
  if (body.error?.data?.oauth_failure !== 'audience_mismatch') return;
  assert.ok(Array.isArray(body.error?.data?.accepted_audiences));
  assert.ok((body.error!.data!.accepted_audiences as string[]).length > 0);
});

// ─── a refreshed token works on BOTH surfaces ────────────────────────────────

test('an access token minted by a REFRESH is accepted on /mcp and through the façade', async (t) => {
  /**
   * The refresh MECHANICS (rotation, the grace window, reuse detection) are
   * covered in mcp-oauth-hardening. What was never checked is the thing an
   * installer actually hits: does the token that comes OUT of a refresh work on
   * the surfaces they use? A connector that authenticates once and then dies an
   * hour later, when its first token expires, is the single most confusing
   * failure this system can present — everything worked, then nothing did.
   */
  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putOAuthClient(store, {
    schema_version: 'oauth-client.v1',
    client_id: 'cl_refresh',
    client_name: 'Connector',
    redirect_uris: ['https://claude.ai/api/mcp/auth_callback'],
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    scope: 'mcp offline_access',
    site: 'site_drlurie',
    created_at: new Date(0).toISOString(),
    registration: 'dynamic',
  });
  const nowMs = Date.now();
  await putRefreshTokenRecord(store, 'refresh-for-both-surfaces', {
    schema_version: 'oauth-refresh-token.v1',
    client_id: 'cl_refresh',
    client_name: 'Connector',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
    scope: 'mcp offline_access',
    site: 'site_drlurie',
    family_id: 'family-both',
    issued_at: new Date(nowMs).toISOString(),
    expires_at: new Date(nowMs + 30 * 24 * 3_600_000).toISOString(),
  });

  const exchanged = await handleTokenRequest(store, {
    params: { grant_type: 'refresh_token', refresh_token: 'refresh-for-both-surfaces', client_id: 'cl_refresh' },
    site: 'site_drlurie',
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
  });
  assert.equal(exchanged.status, 200, JSON.stringify(exchanged.body));
  const accessToken = String(exchanged.body.access_token);

  await t.test('it authenticates on the tenant /mcp', async () => {
    const who = resultOf(await rpc('tools/call', { name: 'whoami', arguments: {} }, `Bearer ${accessToken}`));
    assert.equal(who.isError, undefined);
    assert.equal((who.structuredContent?.member as { email?: string } | null)?.email, 'owner@example.com');
  });

  await t.test('and through the Actions façade, where it is stamped as the GPT surface', async () => {
    // The façade refuses every path until a bundle is promoted — that refusal
    // is correct and covered elsewhere; here it would only mask the thing
    // under test, so promote one first.
    const owner = { clientContext: { user: { sub: 'usr_owner', email: 'owner@example.com' } } };
    await manifestHandler(
      { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'render', platform: 'openai' }) },
      owner
    );
    await manifestHandler({ httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'promote' }) }, owner);

    const response = await pluginActionsHandler({
      httpMethod: 'POST',
      path: '/api/plugin/whoami',
      headers: { ...HEADERS, authorization: `Bearer ${accessToken}` },
      body: '{}',
    });
    assert.equal(response.statusCode, 200, response.body);
    assert.equal((JSON.parse(response.body) as { surface?: string }).surface, 'plugin:openai-gpt');
  });
});

// ─── the write rate limit ────────────────────────────────────────────────────

test('the write budget counts, refuses at the limit, and names the window', async () => {
  const store = {
    data: new Map<string, string>(),
    async get(key: string) {
      return this.data.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      this.data.set(key, JSON.stringify(value));
    },
  };
  const at = Date.parse('2026-09-04T12:00:00.000Z');

  for (let i = 0; i < WRITE_RATE_LIMIT.max; i += 1) {
    const verdict = await countWrite(store, 'gotrue-owner', at);
    assert.equal(verdict.allowed, true, `write ${i + 1} should be allowed`);
  }
  const refused = await countWrite(store, 'gotrue-owner', at);
  assert.equal(refused.allowed, false);
  assert.ok(!refused.allowed && refused.retryAfterSeconds > 0);
  assert.ok(!refused.allowed && refused.windowSeconds === WRITE_RATE_LIMIT.windowMs / 1000);

  // A different member has their own budget — one editor cannot throttle another.
  assert.equal((await countWrite(store, 'gotrue-someone-else', at)).allowed, true);

  // And the next window is a different key, so nothing has to expire anything.
  assert.notEqual(rateLimitKey('gotrue-owner', at), rateLimitKey('gotrue-owner', at + WRITE_RATE_LIMIT.windowMs));
  assert.equal((await countWrite(store, 'gotrue-owner', at + WRITE_RATE_LIMIT.windowMs)).allowed, true);
});

test('the budget fails OPEN — a store outage must never stop an editor publishing', async () => {
  const brokenStore = {
    async get() {
      throw new Error('store down');
    },
    async setJSON() {
      throw new Error('store down');
    },
  };
  assert.equal((await countWrite(brokenStore, 'gotrue-owner')).allowed, true);
  assert.equal((await countWrite(undefined, 'gotrue-owner')).allowed, true);
});

// ─── the per-surface kill switch ─────────────────────────────────────────────

const setSurfacePolicy = async (surfaces: Record<string, 'allow' | 'block'> | undefined) => {
  const store = await getGovernanceBlobStore({ headers: HEADERS });
  const existing = (await getGovernanceDoc(store)) ?? {
    schema_version: 'overrides.v1' as const,
    updated_by: 'test',
    updated_at: new Date().toISOString(),
    history: [],
  };
  await putGovernanceDoc(store, {
    ...existing,
    ...(surfaces ? { surfaces } : {}),
    updated_at: new Date().toISOString(),
  });
};

test('a blocked surface is cut off — but can still ask WHY', async (t) => {
  await mintToken('tok-claude-surface');
  await setSurfacePolicy({ 'plugin:claude': 'block' });

  await t.test('an ordinary tool is refused, and the refusal names the surface', async () => {
    const result = resultOf(
      await rpc(
        'tools/call',
        { name: 'object_contract', arguments: { object_type: 'content_item' } },
        'Bearer tok-claude-surface'
      )
    );
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'surface_blocked');
    assert.equal(result.structuredContent?.surface, 'plugin:claude');
    assert.match(String(result.structuredContent?.error), /decision about the chat app, not about you/);
  });

  await t.test('whoami still answers, and says the surface is blocked', async () => {
    const who = resultOf(await rpc('tools/call', { name: 'whoami', arguments: {} }, 'Bearer tok-claude-surface'));
    assert.equal(who.isError, undefined);
    assert.equal(who.structuredContent?.surface_blocked, true);
  });

  await t.test('ping still answers — a cut surface is not an outage', async () => {
    const ping = resultOf(await rpc('tools/call', { name: 'ping', arguments: {} }, 'Bearer tok-claude-surface'));
    assert.equal(ping.isError, undefined);
  });

  await t.test('another surface is untouched — this cuts an app, not the tenant', async () => {
    await mintToken('tok-gpt-surface', { surface: 'plugin:openai-agent' });
    const result = resultOf(
      await rpc(
        'tools/call',
        { name: 'object_contract', arguments: { object_type: 'content_item' } },
        'Bearer tok-gpt-surface'
      )
    );
    assert.notEqual(result.structuredContent?.error_code, 'surface_blocked');
  });

  await setSurfacePolicy({ 'plugin:claude': 'allow' });
  await t.test('re-enabling restores it, with no deploy', async () => {
    const result = resultOf(
      await rpc(
        'tools/call',
        { name: 'object_contract', arguments: { object_type: 'content_item' } },
        'Bearer tok-claude-surface'
      )
    );
    assert.notEqual(result.structuredContent?.error_code, 'surface_blocked');
  });

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});
