import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { getGovernanceBlobStore } from '../../packages/core/server/lib/governance-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { putAccessTokenRecord, type OAuthBlobStore } from '../../packages/core/server/lib/oauth-store.js';
import {
  actorFromMcpAuth,
  inheritActorFromLock,
  decodeCallerActor,
  encodeCallerActor,
} from '../../packages/core/server/lib/caller-actor.js';
import { surfaceForRedirectUris } from '../../packages/core/server/lib/caller-surface.js';

/**
 * Attribution comes from AUTH, not from the model (Wolf's ruling, 2026-09-03).
 *
 * THE RUN THAT FORCED THIS. The ChatGPT agent published
 * `req_plugin_moisturizer_functions_20260903_01` through the live tenant. Its
 * 17-entry ledger recorded `create` as `plugin:openai-agent` and the following
 * sixteen verbs — four patches and THREE PUBLISHES — as `unattributed-agent`,
 * because the model passed `agent_name` once and then stopped. The skill text
 * already instructed it to keep passing the field. Prose lost to sixteen tool
 * calls, so identity stops being prose.
 *
 * The test that matters is the last one in this file: it drives the REAL `/mcp`
 * handler with a real OAuth access token and NO `agent_name` anywhere — the
 * exact shape that produced `unattributed-agent` in production — and asserts
 * the ledger entry names the human and the surface.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
// The gate must be opened by the OAUTH token, never by an absent shared secret.
process.env.MCP_HTTP_AUTH_TOKEN = 'a-different-shared-secret';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-actor-from-auth');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HOST = 'drluriescience.netlify.app';
const HEADERS = { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };

// ─── the pure derivation ─────────────────────────────────────────────────────

test('surface is read from the registered redirect HOST, never from client_name', () => {
  assert.equal(surfaceForRedirectUris(['https://claude.ai/api/mcp/auth_callback']), 'plugin:claude');
  assert.equal(
    surfaceForRedirectUris(['https://chatgpt.com/connector_platform_oauth_redirect']),
    'plugin:openai-agent'
  );
  // Subdomains of a registered host count; look-alikes do not.
  assert.equal(surfaceForRedirectUris(['https://foo.claude.ai/cb']), 'plugin:claude');
  assert.equal(surfaceForRedirectUris(['https://claude.ai.evil.test/cb']), undefined);
  // The host is matched as a host — not as a substring of the whole URI.
  assert.equal(surfaceForRedirectUris(['https://evil.test/cb?next=claude.ai']), undefined);
  // Unanimous or nothing: a client registering two surfaces is not one surface.
  assert.equal(surfaceForRedirectUris(['https://claude.ai/cb', 'https://chatgpt.com/cb']), undefined);
  assert.equal(surfaceForRedirectUris([]), undefined);
  assert.equal(surfaceForRedirectUris(undefined), undefined);
});

test('the actor is derived from the credential, and agent_name is only ever a label', () => {
  const oauth = {
    subject_email: 'wolf@example.com',
    subject_id: 'gotrue-7',
    client_id: 'cl_1',
    surface: 'plugin:claude',
  };

  // 1. OAuth wins, and a self-declared name rides along DEMOTED to `label`.
  assert.deepEqual(actorFromMcpAuth({ oauthPrincipal: oauth }, 'plugin:openai-agent'), {
    kind: 'human',
    id: 'gotrue-7',
    email: 'wolf@example.com',
    client_id: 'cl_1',
    surface: 'plugin:claude',
    label: 'plugin:openai-agent',
    attribution: 'oauth',
  });

  // The label CANNOT become the identity — this is the whole ruling.
  const impersonation = actorFromMcpAuth({ oauthPrincipal: oauth }, 'someone-else@example.com');
  assert.equal(impersonation.kind, 'human');
  assert.equal(impersonation.kind === 'human' && impersonation.email, 'wolf@example.com');

  // 2. A verified per-agent token outranks a self-declared name.
  assert.deepEqual(actorFromMcpAuth({ verifiedAgentName: 'workflow-runner' }, 'i-am-the-owner'), {
    kind: 'agent',
    agent_name: 'workflow-runner',
    auth: 'mcp_token',
    attribution: 'verified_agent_token',
  });

  // 3. Publish key + a declared label: still allowed, still marked self-declared.
  assert.deepEqual(actorFromMcpAuth({}, 'plugin:claude'), {
    kind: 'agent',
    agent_name: 'plugin:claude',
    auth: 'publish_key',
    attribution: 'self_declared',
  });

  // 4. Nothing at all.
  assert.deepEqual(actorFromMcpAuth({}, undefined), {
    kind: 'agent',
    agent_name: 'unattributed-agent',
    auth: 'publish_key',
    attribution: 'publish_key',
  });
});

test('the Actions façade stamps its own surface, outranking the redirect host', () => {
  // A Custom GPT registers chatgpt.com callbacks, so the redirect-host
  // derivation would call it plugin:openai-agent. The façade knows better.
  const actor = actorFromMcpAuth(
    {
      oauthPrincipal: { subject_email: 'w@x.com', subject_id: 'g1', client_id: 'c1', surface: 'plugin:openai-agent' },
      pluginSurface: 'plugin:openai-gpt',
    },
    undefined
  );
  assert.equal(actor.kind === 'human' && actor.surface, 'plugin:openai-gpt');
});

test('lock inheritance is a LAST resort, stamped, and never inherits from the creator', () => {
  const unattributed = actorFromMcpAuth({}, undefined);
  assert.deepEqual(inheritActorFromLock(unattributed, 'wolf@example.com'), {
    kind: 'agent',
    agent_name: 'wolf@example.com',
    auth: 'publish_key',
    attribution: 'inherited_lock',
  });

  // It never overwrites an actor that already has an identity.
  const real = actorFromMcpAuth({ verifiedAgentName: 'runner' }, undefined);
  assert.deepEqual(inheritActorFromLock(real, 'someone-else'), real);

  // And inheriting the sentinel from a lock is not attribution.
  assert.deepEqual(inheritActorFromLock(unattributed, 'unattributed-agent'), unattributed);
  assert.deepEqual(inheritActorFromLock(unattributed, undefined), unattributed);
});

test('the internal actor header round-trips, and refuses junk instead of failing a write', () => {
  const actor = actorFromMcpAuth({ verifiedAgentName: 'runner' }, undefined);
  assert.deepEqual(decodeCallerActor(encodeCallerActor(actor)), actor);

  // Case 4 carries nothing worth sending.
  assert.equal(encodeCallerActor(actorFromMcpAuth({}, undefined)), undefined);

  for (const junk of ['', '   ', 'not-base64!!', Buffer.from('{}').toString('base64'), undefined, 42]) {
    assert.equal(decodeCallerActor(junk), undefined, `must reject ${String(junk)}`);
  }
});

// ─── end to end, through the real handler ────────────────────────────────────

const rpc = (method: string, params: Record<string, unknown>, authorization?: string) =>
  handler({
    httpMethod: 'POST',
    headers: { ...HEADERS, ...(authorization ? { authorization } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });

const articleBody = (slug: string) => ({
  slug,
  title: 'A fixture article for the attribution ledger',
  deck: 'Short, but complete enough to create.',
  description: 'A fixture article used to pin who the ledger says wrote it.',
  author: 'Dr. Lurie',
  taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
  seo: { meta_description: 'A fixture article used to pin who the ledger says wrote it.' },
  nodes: [
    {
      id: 'n_01',
      kind: 'content' as const,
      public: { body: '<p>A short opening paragraph that carries the point without asserting much.</p>' },
      private: { strategy: 'explanation', intent: 'educate' },
    },
  ],
});

test('an OAuth call with NO agent_name lands a HUMAN + SURFACE in the ledger', async (t) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

  const token = 'oauth-access-token-for-the-agent-surface';
  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'cl_chatgpt_agent',
    client_name: 'ChatGPT',
    subject_email: 'wolf@example.com',
    subject_id: 'gotrue-wolf',
    scope: 'mcp',
    // Denormalised at issuance from the client's registered redirect hosts.
    surface: 'plugin:openai-agent',
    site: 'site_drlurie',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  });

  const requestedId = 'req_plugin_attribution_20260903_01';
  const created = await rpc(
    'tools/call',
    {
      name: 'object_create',
      // NOTE: no agent_name. This is the exact shape that produced
      // 'unattributed-agent' on the live run.
      arguments: {
        object_type: 'content_item',
        site: 'site_drlurie',
        requested_id: requestedId,
        body: articleBody('attribution-ledger-fixture'),
      },
    },
    `Bearer ${token}`
  );
  assert.equal(created.statusCode, 200, created.body);
  const createResult = (JSON.parse(created.body) as { result: { isError?: boolean; content?: { text: string }[] } })
    .result;
  assert.ok(!createResult.isError, `object_create failed: ${createResult.content?.[0]?.text}`);

  const read = await rpc(
    'tools/call',
    { name: 'object_get', arguments: { object_type: 'content_item', object_id: requestedId } },
    `Bearer ${token}`
  );
  assert.equal(read.statusCode, 200, read.body);
  const record = (
    JSON.parse(read.body) as {
      result: { structuredContent?: { record?: { history?: { action: string; actor: Record<string, unknown> }[] } } };
    }
  ).result.structuredContent?.record;

  const created0 = record?.history?.find((entry) => entry.action === 'create');
  assert.ok(created0, `expected a create entry, got ${JSON.stringify(record?.history)}`);

  await t.test('the actor is the approving human, not a sentinel', () => {
    assert.equal(created0.actor.kind, 'human');
    assert.equal(created0.actor.email, 'wolf@example.com');
    assert.equal(created0.actor.id, 'gotrue-wolf');
  });

  await t.test('and it names the surface and how it was established', () => {
    assert.equal(created0.actor.surface, 'plugin:openai-agent');
    assert.equal(created0.actor.client_id, 'cl_chatgpt_agent');
    assert.equal(created0.actor.attribution, 'oauth');
  });

  await t.test('the sentinel that started all this is gone from this entry', () => {
    assert.notEqual(created0.actor.agent_name, 'unattributed-agent');
  });

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});
