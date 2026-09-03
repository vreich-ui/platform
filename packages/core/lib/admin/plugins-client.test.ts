import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchPluginManifest,
  renderPluginDraft,
  platformCards,
  installerIdentityStep,
  ceilingRows,
  manifestStatus,
  hasUnpromotedDraft,
  type ManifestBundleView,
  type PluginManifestState,
} from './plugins-client.js';

const bundle = (version: string): ManifestBundleView => ({
  manifest_version: version,
  rendered_at: '2026-08-31T12:00:00.000Z',
  tools: [{ name: 'object_get', tool_class: 'read', consequential: false, summary: 'Read one object.' }],
  connection: {
    tenant: 'dr-lurie',
    site_id: 'site_drlurie',
    origin: 'https://drluriescience.netlify.app',
    mcp_url: 'https://drluriescience.netlify.app/mcp',
    mcp_auth_health_url: 'https://drluriescience.netlify.app/mcp?health=auth',
    oauth: { authorization_url: 'https://drluriescience.netlify.app/oauth/authorize' },
  },
  sources: {
    voice_object_id: 'voice_drlurie',
    voice_record_version: 14,
    aggression_ceiling: { claim_strength: 0.45, urgency: 0.1, emotional_agitation: 0.15, cta_density: 0.2 },
    approval_posture: 'all-autonomous',
    tool_surface_digest: 'sha_abcd1234_47',
  },
  warnings: [],
});

const state = (over: Partial<PluginManifestState> = {}): PluginManifestState => ({
  active: null,
  draft: null,
  stale: [],
  updated_by: 'wolf@example.test',
  updated_at: '2026-08-31T12:00:00.000Z',
  history: [],
  exports: null,
  ...over,
});

test('the platform cards carry URLs from the live bundle, never typed by hand', () => {
  const cards = platformCards(bundle('v1'));
  const byId = Object.fromEntries(cards.map((c) => [c.id, c]));

  assert.equal(byId.claude.copyUrl, 'https://drluriescience.netlify.app/mcp');
  assert.equal(byId.openai.copyUrl, 'https://drluriescience.netlify.app/api/plugin/openapi.json');
  assert.ok(byId.claude.downloadUrl?.includes('export=plugin'));
  assert.ok(byId.openai.downloadUrl?.includes('export=gpt'));
  assert.ok(byId.gemini.downloadUrl?.includes('export=gemini'));
});

test('no card offers a download before anything is promoted', () => {
  for (const card of platformCards(null)) {
    assert.equal(card.downloadUrl, null, `${card.id} offered a download with no active bundle`);
    assert.equal(card.copyUrl, null);
    // The steps still render, so the page explains the destination while empty.
    assert.ok(card.steps.length > 0);
  }
});

test('Gemini is labelled drafting-only and the other two are not', () => {
  const cards = platformCards(bundle('v1'));
  const gemini = cards.find((c) => c.id === 'gemini');
  assert.match(String(gemini?.limitation), /cannot reach the CMS/);
  for (const id of ['claude', 'openai'] as const) {
    assert.equal(cards.find((c) => c.id === id)?.limitation, null);
  }
});

test('the ChatGPT steps name the empty scope — the trap that reads as a bad credential', () => {
  const openai = platformCards(bundle('v1')).find((c) => c.id === 'openai');
  assert.ok(openai?.steps.some((s) => /scope EMPTY/i.test(s)));
});

test('the ceiling readout renders every dial, and an em dash when one is missing', () => {
  assert.deepEqual(ceilingRows(bundle('v1')), [
    { dial: 'claim_strength', value: '0.45' },
    { dial: 'urgency', value: '0.10' },
    { dial: 'emotional_agitation', value: '0.15' },
    { dial: 'cta_density', value: '0.20' },
  ]);
  assert.deepEqual(
    ceilingRows(null).map((r) => r.value),
    ['—', '—', '—', '—']
  );
});

test('status separates "nothing promoted" from "promoted but stale"', () => {
  assert.equal(manifestStatus(null).kind, 'none');
  assert.equal(manifestStatus(state()).kind, 'none');

  // A draft with no active bundle is NOT the same as current: the exports 409.
  const draftOnly = manifestStatus(state({ draft: bundle('v1') }));
  assert.equal(draftOnly.kind, 'draft-only');
  assert.equal(draftOnly.tone, 'warn');
  assert.match(draftOnly.detail, /nothing is promoted/);

  const stale = manifestStatus(state({ active: bundle('v1'), stale: ['The editorial voice moved.'] }));
  assert.equal(stale.kind, 'stale');
  assert.match(stale.detail, /1 change since/);

  const current = manifestStatus(state({ active: bundle('v1') }));
  assert.equal(current.kind, 'current');
  assert.equal(current.tone, 'ok');
  assert.ok(current.detail.includes('v1'));
});

test('stale detail pluralises, because an operator reads the count', () => {
  const two = manifestStatus(state({ active: bundle('v1'), stale: ['a', 'b'] }));
  assert.match(two.detail, /2 changes since/);
});

test('an unpromoted draft is only flagged when it differs from what is active', () => {
  assert.equal(hasUnpromotedDraft(state({ active: bundle('v1'), draft: bundle('v1') })), false);
  assert.equal(hasUnpromotedDraft(state({ active: bundle('v1'), draft: bundle('v2') })), true);
  assert.equal(hasUnpromotedDraft(state({ draft: bundle('v1') })), true);
  assert.equal(hasUnpromotedDraft(state()), false);
});

test('identity is step one, before any platform — the invite is not a footnote', () => {
  // Both OpenAI shapes and the Claude connector authenticate the human over
  // OAuth. An installer with no tenant account attaches the tools fine and then
  // fails every write, which reads as a broken connector.
  assert.match(installerIdentityStep.detail, /fail every write/);
  assert.deepEqual([...installerIdentityStep.roles], ['publisher', 'editor']);
  assert.ok(installerIdentityStep.action.href.startsWith('/admin/'));
});

test('each card names the ledger actors its shapes declare', () => {
  const byId = Object.fromEntries(platformCards(bundle('v1')).map((c) => [c.id, c]));
  assert.deepEqual(byId.claude.actors, ['plugin:claude']);
  // OpenAI ships two shapes; both must be separable in the ledger.
  assert.deepEqual(byId.openai.actors, ['plugin:openai-gpt', 'plugin:openai-agent']);
  assert.deepEqual(byId.gemini.actors, [], 'Gemini cannot publish, so it declares no actor');
});

test('the ChatGPT card explains that two shapes ship together', () => {
  const openai = platformCards(bundle('v1')).find((c) => c.id === 'openai');
  assert.match(String(openai?.downloadLabel), /both shapes/i);
  assert.ok(openai?.steps.some((s) => /Agent Studio/i.test(s)));
  assert.ok(openai?.steps.some((s) => /Remove any direct PDF-Tool app/i.test(s)));
});

/* ── transport: a domain failure now arrives as HTTP 200 ──────────────────── */

/**
 * The endpoint used to die and let Netlify answer 502, which is how
 * /admin/plugins ended up showing "Request failed (502)" and nothing else. It
 * now answers 200 with {ok:false, stage, error}. That makes `response.ok`
 * insufficient on its own: without the body check a stage failure would be
 * treated as a successful fetch and the page would render an empty manifest
 * instead of saying what broke.
 */
const withFetch = async (reply: { status: number; body: Record<string, unknown> }, run: () => Promise<unknown>) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    ({
      ok: reply.status >= 200 && reply.status < 300,
      status: reply.status,
      json: async () => reply.body,
    }) as unknown as Response) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
};

const noToken = async () => 'test-token';

test('a 200 carrying ok:false is a failure, and the message names the stage', async () => {
  await assert.rejects(
    () =>
      withFetch(
        { status: 200, body: { ok: false, stage: 'render', error: 'voice record unreadable' } },
        () => fetchPluginManifest(noToken) as Promise<unknown>
      ),
    /voice record unreadable \(failed at: render\)/,
    'the operator must be told WHICH step failed, not just that something did'
  );
});

test('a stage failure on render is a failure too — not an empty draft', async () => {
  await assert.rejects(
    () =>
      withFetch({ status: 200, body: { ok: false, stage: 'persist', error: 'store write refused' } }, () =>
        renderPluginDraft(noToken, 'claude')
      ),
    /store write refused \(failed at: persist\)/
  );
});

test('a failure with no stage still surfaces its message', async () => {
  await assert.rejects(
    () =>
      withFetch(
        { status: 200, body: { ok: false, error: 'something went wrong' } },
        () => fetchPluginManifest(noToken) as Promise<unknown>
      ),
    /^Error: something went wrong$/
  );
});

test('a genuine transport error still reports its status', async () => {
  await assert.rejects(
    () => withFetch({ status: 502, body: {} }, () => fetchPluginManifest(noToken) as Promise<unknown>),
    /Request failed \(502\)/
  );
});

test('ok:true passes straight through — the happy path is untouched', async () => {
  const state = await withFetch(
    { status: 200, body: { ok: true, active: null, draft: null, stale: [], history: [], exports: null } },
    () => fetchPluginManifest(noToken) as Promise<unknown>
  );
  assert.equal((state as PluginManifestState).active, null);
  assert.deepEqual((state as PluginManifestState).stale, []);
});
