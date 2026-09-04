import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, visibleToolDefinitions } from '../../netlify/functions/mcp.js';
import { handler as pluginActionsHandler } from '../../netlify/functions/plugin-actions.js';
import { getGovernanceBlobStore } from '../../packages/core/server/lib/governance-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { putAccessTokenRecord, type OAuthBlobStore } from '../../packages/core/server/lib/oauth-store.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import {
  getPluginManifestBlobStore,
  putPluginManifestDoc,
} from '../../packages/core/server/lib/plugin/manifest-store.js';
import { emptyPluginManifestDoc } from '../../packages/core/server/lib/plugin/manifest-types.js';
import { toolSurfaceDigest, buildPluginTools } from '../../packages/core/server/lib/plugin/build-tools.js';
import { toWireTool } from '../../packages/core/server/lib/mcp-tool-annotations.js';

/**
 * W7.2 acceptance — `whoami` through the REAL handlers, on both surfaces.
 *
 * The thing under test is not the shape of a payload; it is that the five
 * facts an install can silently get wrong are answered by the SERVER, from the
 * credential, on the path a real client takes:
 *
 *   - a Claude connector (OAuth grant, claude.ai redirect host) → plugin:claude
 *   - a Custom GPT (the Actions façade) → plugin:openai-gpt, BY CONSTRUCTION
 *
 * The façade case is the one that has drifted before: a Custom GPT registers
 * chatgpt.com callbacks, so a redirect-host derivation calls it
 * `plugin:openai-agent`. If `whoami` ever reports that here, the install page's
 * "Prove it" step is proving the wrong install.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.MCP_HTTP_AUTH_TOKEN = 'a-shared-secret-that-must-not-be-what-opens-this';
// Roles resolve through the same async resolver every gate uses; the env
// allowlists are its documented fallback when there is no membership record.
process.env.ADMIN_EMAILS = 'owner@example.com';
process.env.ROLE_EMAILS_EDITOR = 'editor@example.com';
process.env.ROLE_EMAILS_ADMIN = '';
process.env.ROLE_EMAILS_PUBLISHER = '';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-whoami');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HOST = 'drluriescience.netlify.app';
const HEADERS = { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };

type WhoamiPayload = {
  ok: boolean;
  server: string;
  tenant: string;
  member: { id: string; email: string; role: string; roles: string[]; status: string } | null;
  surface: string;
  attribution: string;
  can_write: boolean;
  refuse_reason?: string;
  manifest_version: string | null;
  charter: string[] | null;
  tools_digest: string;
  manifest_tools_digest: string | null;
  tools_digest_matches: boolean;
  aggression_ceiling: Record<string, number> | null;
  publish_policy: { master: string; require_approval: string[] };
};

const mintToken = async (token: string, over: Record<string, unknown>) => {
  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'cl_test',
    client_name: 'a name nothing trusts',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
    scope: 'mcp',
    site: 'site_drlurie',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    ...over,
  } as never);
};

const whoamiOverMcp = async (token: string): Promise<WhoamiPayload> => {
  const res = await handler({
    httpMethod: 'POST',
    headers: { ...HEADERS, authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  assert.equal(res.statusCode, 200, res.body);
  const result = (JSON.parse(res.body) as { result: { isError?: boolean; structuredContent: WhoamiPayload } }).result;
  assert.ok(!result.isError, `whoami errored: ${res.body}`);
  return result.structuredContent;
};

// ─── the tool surface ────────────────────────────────────────────────────────

test('whoami is on the surface, read-class, and takes no arguments it could be lied to with', () => {
  const definition = visibleToolDefinitions().find((tool) => tool.name === 'whoami');
  assert.ok(definition, 'whoami is not on the tool surface');
  assert.equal(definition.governance.toolClass, 'read');

  // Every input comes from the request's auth. A property here would be a
  // field a caller could use to describe itself — the exact defect
  // caller-actor.ts exists to close.
  const schema = definition.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
  assert.deepEqual(Object.keys(schema.properties ?? {}), []);
  assert.deepEqual(schema.required ?? [], []);

  // A client must not confirm a read (mcp-tool-annotations.ts).
  assert.equal(toWireTool(definition).annotations.readOnlyHint, true);
});

test('whoami is in the plugin charter — it is what an installer runs to prove the install', () => {
  const names = buildPluginTools(visibleToolDefinitions()).map((tool) => tool.name);
  assert.ok(names.includes('whoami'), 'whoami must be in the derived plugin tool list');
});

// ─── surface 1: a Claude connector, over /mcp ────────────────────────────────

test('an OAuth call from a claude.ai grant reports the human, the role and plugin:claude', async (t) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  await mintToken('tok-claude-owner', { surface: 'plugin:claude', client_id: 'cl_claude' });

  const who = await whoamiOverMcp('tok-claude-owner');

  await t.test('identity comes from the grant, not from anything the model said', () => {
    assert.equal(who.member?.email, 'owner@example.com');
    assert.equal(who.member?.id, 'gotrue-owner');
    assert.equal(who.attribution, 'oauth');
  });

  await t.test('the surface is the one the ledger will record for this caller', () => {
    assert.equal(who.surface, 'plugin:claude');
  });

  await t.test('an owner may write, and is told so before writing rather than at the gate', () => {
    assert.equal(who.can_write, true);
    assert.equal(who.refuse_reason, undefined);
    assert.ok(who.member?.roles.includes('owner'));
  });

  await t.test('the rules that decide whether a draft can ever publish travel with it', () => {
    assert.deepEqual(who.aggression_ceiling, {
      claim_strength: 0.45,
      urgency: 0.1,
      emotional_agitation: 0.15,
      cta_density: 0.2,
    });
    assert.ok(who.publish_policy.master.length > 0);
  });

  await t.test('the live tool digest is the one a stale client can be compared against', () => {
    assert.equal(who.tools_digest, toolSurfaceDigest(buildPluginTools(visibleToolDefinitions())));
  });
});

// ─── standing: the refusal happens at session start, not at the gate ─────────

test('a member with no write standing is refused up front, and told why', async () => {
  await mintToken('tok-nobody', {
    surface: 'plugin:claude',
    subject_email: 'reader@example.com',
    subject_id: 'gotrue-reader',
  });

  const who = await whoamiOverMcp('tok-nobody');
  assert.equal(who.member?.email, 'reader@example.com');
  assert.equal(who.can_write, false);
  assert.match(who.refuse_reason ?? '', /reader@example\.com/);
});

test('an editor may write; the role reported is the one the gates will read', async () => {
  await mintToken('tok-editor', {
    surface: 'plugin:claude',
    subject_email: 'editor@example.com',
    subject_id: 'gotrue-editor',
  });

  const who = await whoamiOverMcp('tok-editor');
  assert.equal(who.can_write, true);
  assert.deepEqual(who.member?.roles, ['editor']);
});

test('a grant whose surface the tenant cannot place refuses the write it could not attribute', async () => {
  // No `surface` on the record: an unrecognised redirect host resolves to
  // unknown rather than guessing (caller-surface.ts).
  await mintToken('tok-surfaceless', { subject_email: 'owner@example.com', subject_id: 'gotrue-owner' });

  const who = await whoamiOverMcp('tok-surfaceless');
  assert.equal(who.surface, 'unknown');
  assert.equal(who.can_write, false, 'an unattributable write must be refused even for an owner');
  assert.match(who.refuse_reason ?? '', /re-add the connector/i);
});

// ─── surface 2: a Custom GPT, through the Actions façade ─────────────────────

test('through the façade whoami reports plugin:openai-gpt, and stays in charter when the manifest predates it', async (t) => {
  // A manifest promoted BEFORE whoami existed: its charter cannot list it.
  // This is the exact state every already-installed tenant is in.
  const bundle = buildManifestBundle({
    origin: `https://${HOST}`,
    definitions: visibleToolDefinitions(),
    voice: null,
    platform: 'openai',
    now: () => new Date('2026-09-01T12:00:00.000Z'),
    approval: { master: 'all-autonomous', overrides: { editorial_voice: 'require-approval' } },
  });
  const stale = {
    ...bundle,
    tools: bundle.tools.filter((tool) => tool.name !== 'whoami'),
    sources: { ...bundle.sources, tool_surface_digest: 'sha_deadbeef_0' },
  };
  const store = await getPluginManifestBlobStore({ headers: HEADERS });
  await putPluginManifestDoc(store, {
    ...emptyPluginManifestDoc(),
    active: stale,
    updated_by: 'test',
    updated_at: new Date().toISOString(),
  });

  // A Custom GPT's OAuth callbacks live on chatgpt.com, so the grant itself
  // says `plugin:openai-agent`. The façade must outrank it.
  await mintToken('tok-gpt', {
    surface: 'plugin:openai-agent',
    client_id: 'cl_gpt',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
  });

  const res = await pluginActionsHandler({
    httpMethod: 'POST',
    path: '/api/plugin/whoami',
    headers: { ...HEADERS, authorization: 'Bearer tok-gpt' },
    body: '{}',
  });

  await t.test('the charter admits it even though the promoted manifest does not list it', () => {
    assert.equal(res.statusCode, 200, res.body);
  });

  const who = JSON.parse(res.body) as WhoamiPayload;

  await t.test('the façade stamps its own surface, outranking the redirect host', () => {
    assert.equal(who.surface, 'plugin:openai-gpt');
    assert.equal(who.attribution, 'oauth');
  });

  await t.test('the stale cached schema is diagnosable in one glance', () => {
    assert.equal(who.manifest_version, stale.manifest_version);
    assert.equal(who.manifest_tools_digest, 'sha_deadbeef_0');
    assert.equal(who.tools_digest_matches, false);
    assert.ok(who.charter && !who.charter.includes('whoami'));
  });

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});

// ─── the gate is still the gate ──────────────────────────────────────────────

test('whoami is not a way past authentication', async () => {
  const res = await handler({
    httpMethod: 'POST',
    headers: HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'whoami', arguments: {} } }),
  });
  assert.equal(res.statusCode, 401, 'an unauthenticated caller must never reach whoami');
});
