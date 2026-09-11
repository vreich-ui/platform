import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, visibleToolDefinitions } from '../../netlify/functions/mcp.js';
import { getGovernanceBlobStore } from '../../packages/core/server/lib/governance-store.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { putAccessTokenRecord, type OAuthBlobStore } from '../../packages/core/server/lib/oauth-store.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import {
  getPluginManifestBlobStore,
  putPluginManifestDoc,
} from '../../packages/core/server/lib/plugin/manifest-store.js';
import { emptyPluginManifestDoc } from '../../packages/core/server/lib/plugin/manifest-types.js';
import {
  charterRefusal,
  isPluginSurface,
  PLUGIN_FORBIDDEN_CREATE_TYPES,
} from '../../packages/core/server/lib/plugin/charter-gate.js';

/**
 * W0 T0.2 acceptance — D4: the publishing-plugin charter bites on `/mcp`.
 *
 * Until this wave the charter was enforced on `/api/plugin/*` and advisory on
 * `/mcp`, which meant the SAME promoted manifest bound a Custom GPT and not
 * the same tenant's Claude connector — the install that speaks the protocol
 * directly simply walked past it.
 *
 * What is under test is the refusal a real client gets, on the real handler,
 * from a real OAuth grant — plus the two documented places enforcement
 * degrades rather than cutting a tenant off (no promoted manifest; unreadable
 * manifest store), because a gap that is not tested is a gap nobody notices
 * closing by accident.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.MCP_HTTP_AUTH_TOKEN = 'shared-secret-for-the-non-plugin-principal';
process.env.ADMIN_EMAILS = 'owner@example.com';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-plugin-charter');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const HOST = 'drluriescience.netlify.app';
const HEADERS = { host: HOST, 'x-forwarded-proto': 'https', 'content-type': 'application/json' };

type ToolOutcome = { isError?: boolean; structuredContent?: Record<string, unknown> };

const call = async (name: string, args: Record<string, unknown>, authorization: string): Promise<ToolOutcome> => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { ...HEADERS, authorization },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200, response.body);
  return (JSON.parse(response.body) as { result: ToolOutcome }).result;
};

const errorCode = (outcome: ToolOutcome): unknown => outcome.structuredContent?.error_code;

const mintPluginToken = async (token: string) => {
  const store = (await getGovernanceBlobStore({ headers: HEADERS })) as unknown as OAuthBlobStore;
  await putAccessTokenRecord(store, token, {
    schema_version: 'oauth-access-token.v1',
    client_id: 'cl_claude',
    client_name: 'a name nothing trusts',
    subject_email: 'owner@example.com',
    subject_id: 'gotrue-owner',
    scope: 'mcp',
    surface: 'plugin:claude',
    site: 'site_drlurie',
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
  } as never);
};

/** The bundle a tenant promotes: derived from the live surface, exactly as the admin renders it. */
const promoteCharter = async () => {
  const bundle = buildManifestBundle({
    origin: `https://${HOST}`,
    definitions: visibleToolDefinitions(),
    voice: null,
    platform: 'claude',
    now: () => new Date('2026-09-11T12:00:00.000Z'),
    approval: { master: 'all-autonomous', overrides: { editorial_voice: 'require-approval' } },
  });
  await putPluginManifestDoc(await getPluginManifestBlobStore({ headers: HEADERS }), {
    ...emptyPluginManifestDoc(),
    active: bundle,
    updated_by: 'owner@example.com',
    updated_at: '2026-09-11T12:00:00.000Z',
  });
  return bundle;
};

// ─── the pure gate ───────────────────────────────────────────────────────────

test('only a plugin:* surface is a plugin principal', () => {
  assert.equal(isPluginSurface('plugin:claude'), true);
  assert.equal(isPluginSurface('plugin:openai-gpt'), true);
  assert.equal(isPluginSurface('plugin:openai-agent'), true);
  // The two shapes a non-plugin caller presents, and the one a client might invent.
  assert.equal(isPluginSurface(undefined), false);
  assert.equal(isPluginSurface('unknown'), false);
  assert.equal(isPluginSurface('not-a-plugin:claude'), false);
});

test('the forbidden-create list is exactly the four site-design types', () => {
  assert.deepEqual([...PLUGIN_FORBIDDEN_CREATE_TYPES].sort(), ['section_template', 'site', 'template', 'theme']);
  // The publishing types must NOT be on it, or the plugin cannot do its job.
  for (const allowed of ['page', 'section', 'content_item', 'navigation', 'taxonomy', 'product']) {
    assert.equal(PLUGIN_FORBIDDEN_CREATE_TYPES.has(allowed), false, `${allowed} must stay creatable`);
  }
});

test('a null charter disables the TOOL-NAME rule and nothing else', () => {
  const base = { surface: 'plugin:claude', charter: null, manifestVersion: null };
  // No manifest: an out-of-charter tool is answered, exactly as it was before D4.
  assert.equal(charterRefusal({ ...base, toolName: 'object_retire', args: {} }), undefined);
  // …but the object-type rule is not derived from the manifest, so it still binds.
  assert.equal(
    charterRefusal({ ...base, toolName: 'object_create', args: { object_type: 'theme' } })?.payload.error_code,
    'object_type_not_in_plugin_charter'
  );
});

test('mode (1) object_validate — an object that already exists — is a read, not a mint', () => {
  const base = { surface: 'plugin:claude', charter: null, manifestVersion: null } as const;
  assert.equal(
    charterRefusal({ ...base, toolName: 'object_validate', args: { object_type: 'theme', object_id: 'thm_x' } }),
    undefined
  );
  assert.equal(
    charterRefusal({ ...base, toolName: 'object_validate', args: { object_type: 'theme', body: {} } })?.payload
      .error_code,
    'object_type_not_in_plugin_charter'
  );
});

test('a non-plugin principal is never refused by this gate, whatever it asks for', () => {
  for (const surface of [undefined, 'unknown', '']) {
    assert.equal(
      charterRefusal({
        surface,
        toolName: 'object_create',
        args: { object_type: 'theme' },
        charter: ['whoami'],
        manifestVersion: 'v1',
      }),
      undefined
    );
  }
});

// ─── through the real handler: no promoted manifest ──────────────────────────

test('with NO promoted manifest the tool-name rule is off — four of five tenants live here', async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  await mintPluginToken('tok-no-manifest');

  // object_retire is in PLUGIN_TOOL_DENYLIST, so a promoted charter would
  // never list it. With no charter to read, it must still be ANSWERED — the
  // refusal it gets is the object store's, not the gate's.
  const retired = await call('object_retire', { object_id: 'page_does_not_exist' }, 'Bearer tok-no-manifest');
  assert.notEqual(errorCode(retired), 'tool_not_in_plugin_charter');

  // The object-type rule is independent of the manifest and binds anyway.
  const theme = await call('object_create', { object_type: 'theme', body: {} }, 'Bearer tok-no-manifest');
  assert.equal(theme.isError, true);
  assert.equal(errorCode(theme), 'object_type_not_in_plugin_charter');
});

// ─── through the real handler: a promoted manifest ───────────────────────────

test('a plugin principal is refused a tool outside the promoted charter', async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  await mintPluginToken('tok-charter');
  const bundle = await promoteCharter();
  assert.equal(
    bundle.tools.some((tool) => tool.name === 'object_retire'),
    false,
    'object_retire is denylisted — if it ever enters the charter this test is testing nothing'
  );

  const outcome = await call('object_retire', { object_id: 'page_home' }, 'Bearer tok-charter');
  assert.equal(outcome.isError, true);
  assert.equal(errorCode(outcome), 'tool_not_in_plugin_charter');
  assert.equal(outcome.structuredContent?.status, 403);
  assert.equal(outcome.structuredContent?.manifest_version, bundle.manifest_version);
  assert.equal(outcome.structuredContent?.surface, 'plugin:claude');
});

test('object_create is IN charter, and still refuses the four site-design types', async () => {
  await mintPluginToken('tok-charter-2');
  const bundle = await promoteCharter();
  assert.ok(
    bundle.tools.some((tool) => tool.name === 'object_create'),
    'the plugin must be able to create articles, or the object-type rule has nothing to add'
  );

  for (const objectType of ['theme', 'site', 'template', 'section_template']) {
    const outcome = await call('object_create', { object_type: objectType, body: {} }, 'Bearer tok-charter-2');
    assert.equal(outcome.isError, true, objectType);
    assert.equal(errorCode(outcome), 'object_type_not_in_plugin_charter', objectType);
    assert.equal(outcome.structuredContent?.object_type, objectType);
  }
});

test('a publishing type reaches validation rather than the charter', async () => {
  await mintPluginToken('tok-charter-3');
  await promoteCharter();
  // An empty page body is invalid, and that is the point: the refusal must
  // come from the validator, never from the charter gate.
  const outcome = await call('object_create', { object_type: 'page', body: {} }, 'Bearer tok-charter-3');
  assert.notEqual(errorCode(outcome), 'object_type_not_in_plugin_charter');
  assert.notEqual(errorCode(outcome), 'tool_not_in_plugin_charter');
});

test('whoami answers a plugin principal whatever the charter says — it is the diagnostic', async () => {
  await mintPluginToken('tok-charter-4');
  const bundle = await promoteCharter();
  await putPluginManifestDoc(await getPluginManifestBlobStore({ headers: HEADERS }), {
    ...emptyPluginManifestDoc(),
    // A manifest promoted before whoami existed — the state every already
    // installed tenant is in, and the one where the charter would refuse the
    // only tool that can explain the refusal.
    active: { ...bundle, tools: bundle.tools.filter((tool) => tool.name !== 'whoami') },
    updated_by: 'owner@example.com',
    updated_at: '2026-09-11T12:00:00.000Z',
  });

  const outcome = await call('whoami', {}, 'Bearer tok-charter-4');
  assert.ok(!outcome.isError, JSON.stringify(outcome.structuredContent));
  assert.equal(outcome.structuredContent?.surface, 'plugin:claude');
});

test('the shared token — a non-plugin principal — is unaffected by a promoted charter', async () => {
  await promoteCharter();
  // Same tool the plugin was just refused, same tenant, same promoted manifest.
  const outcome = await call(
    'object_retire',
    { object_id: 'page_does_not_exist' },
    'Bearer shared-secret-for-the-non-plugin-principal'
  );
  assert.notEqual(errorCode(outcome), 'tool_not_in_plugin_charter');

  const theme = await call(
    'object_create',
    { object_type: 'theme', body: {} },
    'Bearer shared-secret-for-the-non-plugin-principal'
  );
  assert.notEqual(errorCode(theme), 'object_type_not_in_plugin_charter');
});
