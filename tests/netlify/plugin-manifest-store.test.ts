import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getPluginManifestDoc,
  putPluginManifestDoc,
  promoteDraft,
  recordRenderedDraft,
  PLUGIN_MANIFEST_DOC_KEY,
  type PluginManifestBlobStore,
} from '../../packages/core/server/lib/plugin/manifest-store.js';
import { emptyPluginManifestDoc, type ManifestBundle } from '../../packages/core/server/lib/plugin/manifest-types.js';

const bundle = (version: string): ManifestBundle => ({
  manifest_version: version,
  rendered_at: '2026-08-31T12:00:00.000Z',
  skill_md: '# skill',
  tools: [{ name: 'object_get', tool_class: 'read', consequential: false, summary: 'Read one object.' }],
  connection: {
    tenant: 'drlurie',
    site_id: 'site_drlurie',
    origin: 'https://example.test',
    mcp_url: 'https://example.test/mcp',
    mcp_auth_health_url: 'https://example.test/mcp?health=auth',
    oauth: {
      authorization_url: 'https://example.test/oauth/authorize',
      token_url: 'https://example.test/oauth/token',
      registration_url: 'https://example.test/oauth/register',
      revocation_url: 'https://example.test/oauth/revoke',
      authorization_server_metadata_url: 'https://example.test/.well-known/oauth-authorization-server',
      protected_resource_metadata_url: 'https://example.test/.well-known/oauth-protected-resource',
    },
  },
  sources: {
    voice_object_id: 'voice_drlurie',
    voice_record_version: 14,
    aggression_ceiling: { claim_strength: 0.5, urgency: 0.3, emotional_agitation: 0.4, cta_density: 0.5 },
    approval_posture: 'all-autonomous',
    tool_surface_digest: 'sha_00000001_1',
  },
  warnings: [],
});

const memoryStore = (initial?: unknown): PluginManifestBlobStore & { value: unknown } => ({
  value: initial,
  async get(key: string) {
    assert.equal(key, PLUGIN_MANIFEST_DOC_KEY);
    return this.value;
  },
  async setJSON(key: string, value: unknown) {
    assert.equal(key, PLUGIN_MANIFEST_DOC_KEY);
    this.value = value;
    return value;
  },
});

test('an absent doc reads as the empty doc', async () => {
  assert.deepEqual(await getPluginManifestDoc(memoryStore(undefined)), emptyPluginManifestDoc());
  assert.deepEqual(await getPluginManifestDoc(memoryStore(null)), emptyPluginManifestDoc());
});

test('a corrupt doc recovers to empty instead of throwing — the fix is to render again', async () => {
  assert.deepEqual(await getPluginManifestDoc(memoryStore({ schema_version: 'nonsense' })), emptyPluginManifestDoc());
  assert.deepEqual(await getPluginManifestDoc(memoryStore('not json at all')), emptyPluginManifestDoc());
});

test('a store that throws on read recovers to empty', async () => {
  const throwing: PluginManifestBlobStore = {
    get: async () => {
      throw new Error('blobs unavailable');
    },
    setJSON: async () => undefined,
  };
  assert.deepEqual(await getPluginManifestDoc(throwing), emptyPluginManifestDoc());
});

test('rendering records a draft and never touches active', () => {
  const next = recordRenderedDraft(emptyPluginManifestDoc(), bundle('v1'), 'wolf@example.test');
  assert.equal(next.draft?.manifest_version, 'v1');
  assert.equal(next.active, undefined);
  assert.equal(next.history[0].action, 'render_draft');
  assert.equal(next.history[0].actor_email, 'wolf@example.test');
});

test('promote refuses when there is no draft, so it can never publish an empty bundle', () => {
  const result = promoteDraft(emptyPluginManifestDoc(), 'wolf@example.test', '2026-08-31T12:00:00.000Z');
  assert.equal(result.ok, false);
});

test('promote makes the draft active and appends history', () => {
  const rendered = recordRenderedDraft(emptyPluginManifestDoc(), bundle('v1'), 'wolf@example.test');
  const promoted = promoteDraft(rendered, 'wolf@example.test', '2026-08-31T13:00:00.000Z');
  assert.ok(promoted.ok);
  if (!promoted.ok) return;
  assert.equal(promoted.doc.active?.manifest_version, 'v1');
  assert.equal(promoted.doc.history[0].action, 'promote_active');
  assert.equal(promoted.doc.history[1].action, 'render_draft');
});

test('a re-render leaves the previously promoted active bundle in place', () => {
  const first = recordRenderedDraft(emptyPluginManifestDoc(), bundle('v1'), 'wolf@example.test');
  const promoted = promoteDraft(first, 'wolf@example.test', '2026-08-31T13:00:00.000Z');
  assert.ok(promoted.ok);
  if (!promoted.ok) return;
  const second = recordRenderedDraft(promoted.doc, bundle('v2'), 'wolf@example.test');
  assert.equal(second.active?.manifest_version, 'v1', 'active must not move until an explicit promote');
  assert.equal(second.draft?.manifest_version, 'v2');
});

test('history is bounded so the doc cannot grow without limit', () => {
  let doc = emptyPluginManifestDoc();
  for (let i = 0; i < 60; i += 1) doc = recordRenderedDraft(doc, bundle(`v${i}`), 'wolf@example.test');
  assert.equal(doc.history.length, 50);
});

test('a round trip through the store validates', async () => {
  const store = memoryStore(undefined);
  const rendered = recordRenderedDraft(emptyPluginManifestDoc(), bundle('v1'), 'wolf@example.test');
  await putPluginManifestDoc(store, rendered);
  const read = await getPluginManifestDoc(store);
  assert.equal(read.draft?.manifest_version, 'v1');
});
