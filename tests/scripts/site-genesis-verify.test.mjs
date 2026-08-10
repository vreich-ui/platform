/**
 * T16.8 — tests for `scripts/site-genesis-drive.mjs --verify`, the read-only
 * store-side proof of stage 1 (genesis) against the manifest.
 *
 * Plain, uncompiled node:test run directly against the real repo (the
 * admin-parity.test.mjs / genesis-manifest.test.mjs pattern). Every test here
 * drives the drive's exported functions against a scratch site directory
 * (real seed `.mjs` files + a real `data/site/pages/*.json`, so `loadSeeds`'s
 * dynamic `import()` behaves exactly as it does against a real tenant) and a
 * MOCKED MCP client — either the plain `tool(name, args)` function `runVerify`
 * takes directly, or (for the CLI-wiring tests) a stubbed `global.fetch` that
 * speaks the same JSON-RPC `tools/call` wire format the real `/mcp` endpoint
 * does.
 *
 * Three layers:
 *   1. the read-only guarantee: `createReadOnlyTool` refuses every tool name
 *      outside `READ_ONLY_TOOLS`, and `runVerify`'s own source never
 *      mentions a write verb literally;
 *   2. `runVerify` against fixtures — all-OK, a removed nav (MISSING), a
 *      mutated theme token (DRIFTED with a field-level diff), a
 *      still-bootstrap page export, and an onboarding-stage entry that never
 *      fails regardless of presence;
 *   3. the CLI: `parseArgs`, and `main()` end-to-end through a stubbed
 *      `fetch`, pinning the acceptance criteria's exact exit codes.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  READ_ONLY_TOOLS,
  checkBootstrapPages,
  createReadOnlyTool,
  loadOnboardingEntries,
  loadSeeds,
  main,
  parseArgs,
  runVerify,
} from '../../scripts/site-genesis-drive.mjs';

// ─── fixture helpers ─────────────────────────────────────────────────────────

const NAV_HEADER_BODY = { role: 'header', groups: [{ id: 'g_primary', items: [] }] };
const NAV_FOOTER_BODY = { role: 'footer', groups: [], footNote: '© Fixture.' };
const SITE_BODY = { name: 'Fixture Co', logo: { text: 'FIXTURE' } };
const THEME_TOKENS = { colors: { primary: '#111111', secondary: '#222222' }, fonts: { sans: 'Inter' } };
const THEME_BODY = { name: 'Default', tokens: THEME_TOKENS };
const PAGE_HOME_BODY = { title: 'Home', route: '/', sections: [] };

/** A scratch site directory with real seed .mjs files `loadSeeds` can import(). */
const makeSiteFixture = ({ pageBootstrapMarker = null } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genesis-verify-'));
  fs.mkdirSync(path.join(dir, 'seeds'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'data', 'site', 'pages'), { recursive: true });

  fs.writeFileSync(
    path.join(dir, 'seeds', 'navigation-seed-data.mjs'),
    `export const SEED_SITE = 'site_fixture';\n` +
      `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'navigation', objectId: 'nav_header', body: ${JSON.stringify(NAV_HEADER_BODY)} },\n` +
      `  { objectType: 'navigation', objectId: 'nav_footer', body: ${JSON.stringify(NAV_FOOTER_BODY)} },\n` +
      `];\n`
  );
  fs.writeFileSync(
    path.join(dir, 'seeds', 'site-seed-data.mjs'),
    `export const SEED_SITE = 'site_fixture';\n` +
      `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'site', objectId: 'site_fixture', body: ${JSON.stringify(SITE_BODY)} },\n` +
      `];\n`
  );
  fs.writeFileSync(
    path.join(dir, 'seeds', 'themes-seed-data.mjs'),
    `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'theme', objectId: 'thm_fixture_default', body: ${JSON.stringify(THEME_BODY)} },\n` +
      `];\n`
  );
  // taxonomy-seed-data.mjs / section-templates-seed-data.mjs / templates-seed-data.mjs
  // are deliberately NOT scaffolded here — `loadSeeds` skips a missing seed
  // file with a log line, same as a real not-yet-scaffolded tenant.

  fs.writeFileSync(
    path.join(dir, 'seeds', 'voice-seed-data.mjs'),
    `export const SEED_SITE = 'site_fixture';\n` +
      `export const CONVERSION_SEEDS = [\n` +
      `  { objectType: 'editorial_voice', objectId: 'voice_fixture', body: { tone: 'warm' } },\n` +
      `];\n`
  );

  const pageBody = pageBootstrapMarker
    ? { __generated: pageBootstrapMarker, ...PAGE_HOME_BODY }
    : PAGE_HOME_BODY;
  fs.writeFileSync(path.join(dir, 'data', 'site', 'pages', 'page_home.json'), JSON.stringify(pageBody, null, 2));

  return dir;
};

const BOOTSTRAP_MARKER = {
  at: '1970-01-01T00:00:00.000Z',
  from: 'create-site:bootstrap (not store-backed — replaced by the seed drive)',
  record_version: 0,
};
const MATERIALIZED_MARKER = { at: '2026-08-01T00:00:00.000Z', from: 'objects/page/by-id/page_home.json', record_version: 3 };

/** In-memory store keyed by `type:id`, matching the fixture's seeds exactly. */
const fixtureStore = (overrides = {}) => {
  const store = new Map([
    ['navigation:nav_header', structuredClone(NAV_HEADER_BODY)],
    ['navigation:nav_footer', structuredClone(NAV_FOOTER_BODY)],
    ['site:site_fixture', structuredClone(SITE_BODY)],
    ['theme:thm_fixture_default', structuredClone(THEME_BODY)],
    ['page:page_home', structuredClone(PAGE_HOME_BODY)],
  ]);
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) store.delete(key);
    else store.set(key, value);
  }
  return store;
};

/** A mocked MCP client: the plain `tool(name, args)` function `runVerify` takes. */
const mockTool = (store, { assertReadOnly = true } = {}) => async (name, args) => {
  if (assertReadOnly) assert.equal(name, 'object_get', 'a mocked verify client should only ever see object_get');
  const key = `${args.object_type}:${args.object_id}`;
  if (!store.has(key)) return { isError: true, data: { error: 'Object record not found', not_found: true } };
  return { isError: false, data: { record: { body: store.get(key) } } };
};

const rm = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ─── 1. the read-only guarantee ──────────────────────────────────────────────

test('READ_ONLY_TOOLS allows only object_get, and is frozen against accidental mutation', () => {
  assert.deepEqual(READ_ONLY_TOOLS, ['object_get']);
  assert.ok(Object.isFrozen(READ_ONLY_TOOLS));
});

test('createReadOnlyTool passes object_get through and refuses every write verb, synchronously', async () => {
  const calls = [];
  const base = async (name) => {
    calls.push(name);
    return { isError: false, data: { record: { body: {} } } };
  };
  const readOnly = createReadOnlyTool(base);

  await readOnly('object_get', { object_type: 'page', object_id: 'page_home' });
  assert.deepEqual(calls, ['object_get']);

  for (const forbidden of [
    'object_create',
    'object_patch',
    'object_publish',
    'object_checkout',
    'object_checkin',
    'object_discard',
    'object_retire',
    'release_to_production',
  ]) {
    await assert.rejects(() => readOnly(forbidden, {}), /read-only guarantee violated/);
  }
  // None of the rejected calls reached the base tool (no network call was made).
  assert.deepEqual(calls, ['object_get']);
});

test('runVerify never mentions a write verb literally in its own source (belt + suspenders on the allowlist)', () => {
  const source = runVerify.toString();
  for (const forbidden of [
    'object_create',
    'object_patch',
    'object_publish',
    'object_checkout',
    'object_checkin',
    'object_discard',
    'object_retire',
    'release_to_production',
  ]) {
    assert.ok(!source.includes(forbidden), `runVerify's source mentions '${forbidden}'`);
  }
});

// ─── 2. runVerify against fixtures ───────────────────────────────────────────

test('all-OK fixture: every genesis entry OK, bootstrap page replaced, overall PASS', async () => {
  const dir = makeSiteFixture();
  try {
    const store = fixtureStore();
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    assert.equal(report.ok, true);
    assert.deepEqual(
      report.genesis.map((e) => e.status),
      report.genesis.map(() => 'OK')
    );
    assert.deepEqual(new Set(report.genesis.map((e) => e.objectId)), new Set(['nav_header', 'nav_footer', 'site_fixture', 'thm_fixture_default', 'page_home']));
    assert.deepEqual(report.bootstrapPages, [{ file: 'page_home.json', status: 'OK' }]);
    assert.equal(report.summary.missing, 0);
    assert.equal(report.summary.drifted, 0);
    assert.equal(report.summary.bootstrapFailures, 0);
  } finally {
    rm(dir);
  }
});

test('a removed nav is reported MISSING, and fails the overall verdict', async () => {
  const dir = makeSiteFixture();
  try {
    const store = fixtureStore({ 'navigation:nav_header': undefined });
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    assert.equal(report.ok, false);
    const nav = report.genesis.find((e) => e.objectId === 'nav_header');
    assert.equal(nav.status, 'MISSING');
    assert.equal(report.summary.missing, 1);
    // Everything else is unaffected.
    assert.ok(report.genesis.filter((e) => e.objectId !== 'nav_header').every((e) => e.status === 'OK'));
  } finally {
    rm(dir);
  }
});

test('a mutated theme token is reported DRIFTED with a field-level diff naming the exact token', async () => {
  const dir = makeSiteFixture();
  try {
    const mutatedTokens = { colors: { primary: '#FF0000', secondary: '#222222' }, fonts: { sans: 'Inter' } };
    const store = fixtureStore({ 'theme:thm_fixture_default': { name: 'Default', tokens: mutatedTokens } });
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    assert.equal(report.ok, false);
    const theme = report.genesis.find((e) => e.objectId === 'thm_fixture_default');
    assert.equal(theme.status, 'DRIFTED');
    // Only the mutated leaf surfaces — untouched sibling fields do not.
    assert.deepEqual(theme.diff, { tokens: { colors: { primary: '#111111' } } });
    assert.equal(report.summary.drifted, 1);
  } finally {
    rm(dir);
  }
});

test('a stray field on the store record (present in current, absent from the seed) is reported DRIFTED too (trap 2)', async () => {
  const dir = makeSiteFixture();
  try {
    const store = fixtureStore({
      'site:site_fixture': { ...SITE_BODY, tagline: 'a stray field the seed never declared' },
    });
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    const site = report.genesis.find((e) => e.objectId === 'site_fixture');
    assert.equal(site.status, 'DRIFTED');
    assert.deepEqual(site.diff, { tagline: null }, 'a stray key is reported as a null-to-delete field, not silently ignored');
  } finally {
    rm(dir);
  }
});

test('a bootstrap page export still carrying the create-site marker fails verify, independent of the store', async () => {
  const dir = makeSiteFixture({ pageBootstrapMarker: BOOTSTRAP_MARKER });
  try {
    const store = fixtureStore(); // the store-backed object itself is perfectly fine
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    assert.equal(report.ok, false);
    assert.deepEqual(report.bootstrapPages, [{ file: 'page_home.json', status: 'STILL_BOOTSTRAP' }]);
    assert.equal(report.summary.bootstrapFailures, 1);
    // The page OBJECT can still read back OK — this is a distinct, file-level check.
    assert.equal(
      report.genesis.find((e) => e.objectId === 'page_home').status,
      'OK'
    );
  } finally {
    rm(dir);
  }
});

test('a real materialized export (from a genuine publish) passes the bootstrap check', async () => {
  const dir = makeSiteFixture({ pageBootstrapMarker: MATERIALIZED_MARKER });
  try {
    const store = fixtureStore();
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(store)) });
    assert.deepEqual(report.bootstrapPages, [{ file: 'page_home.json', status: 'OK' }]);
  } finally {
    rm(dir);
  }
});

test('checkBootstrapPages is a pure repo-file check — it never calls the tool client at all', () => {
  const dir = makeSiteFixture({ pageBootstrapMarker: BOOTSTRAP_MARKER });
  try {
    assert.deepEqual(checkBootstrapPages(dir), [{ file: 'page_home.json', status: 'STILL_BOOTSTRAP' }]);
  } finally {
    rm(dir);
  }
});

// NOTE: the manifest's onboarding-stage list is owned by a parallel task and
// may carry more entries than just `voice-seed-data.mjs` (e.g. a
// `tracking-config-seed-data.mjs` row) — these assertions look up the voice
// entry by name rather than assuming it is the only onboarding entry, so
// they stay correct as the manifest grows.

test('onboarding-stage entries are always INFO, present or absent, and never affect the overall verdict', async () => {
  const dir = makeSiteFixture();
  try {
    const entries = await loadOnboardingEntries(dir);
    const voice = entries.find((e) => e.file === 'voice-seed-data.mjs');
    assert.ok(voice, 'expected a voice-seed-data.mjs onboarding entry');
    assert.equal(voice.scaffolded, true);

    // Present in the store: still INFO, still passes overall.
    const presentStore = fixtureStore({ 'editorial_voice:voice_fixture': { tone: 'warm' } });
    const presentReport = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(presentStore)) });
    assert.equal(presentReport.ok, true);
    assert.deepEqual(
      presentReport.onboarding.find((e) => e.file === 'voice-seed-data.mjs'),
      { file: 'voice-seed-data.mjs', objectType: 'editorial_voice', objectId: 'voice_fixture', status: 'INFO', present: true }
    );
    assert.ok(
      presentReport.onboarding.every((e) => e.status === 'INFO'),
      'every onboarding-stage row is INFO, never a failure status'
    );

    // Absent from the store: STILL INFO, STILL passes overall — never a failure.
    const absentStore = fixtureStore();
    const absentReport = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(absentStore)) });
    assert.equal(absentReport.ok, true);
    const absentVoice = absentReport.onboarding.find((e) => e.file === 'voice-seed-data.mjs');
    assert.equal(absentVoice.status, 'INFO');
    assert.equal(absentVoice.present, false);
  } finally {
    rm(dir);
  }
});

test('an onboarding seed file never scaffolded onto the site reports INFO absent, not an error', async () => {
  const dir = makeSiteFixture();
  fs.rmSync(path.join(dir, 'seeds', 'voice-seed-data.mjs'));
  try {
    const entries = await loadOnboardingEntries(dir);
    const voice = entries.find((e) => e.file === 'voice-seed-data.mjs');
    assert.deepEqual(voice, { file: 'voice-seed-data.mjs', scaffolded: false, seeds: [] });
    const report = await runVerify({ siteRoot: dir, tool: createReadOnlyTool(mockTool(fixtureStore())) });
    assert.equal(report.ok, true);
    const voiceRow = report.onboarding.find((e) => e.file === 'voice-seed-data.mjs');
    assert.equal(voiceRow.status, 'INFO');
    assert.equal(voiceRow.present, false);
  } finally {
    rm(dir);
  }
});

test('loadSeeds skips a not-yet-scaffolded genesis seed rather than failing', async () => {
  const dir = makeSiteFixture();
  try {
    const plan = await loadSeeds(dir);
    // taxonomy/section-templates/templates were never written into this fixture.
    assert.ok(!plan.some((e) => e.objectType === 'taxonomy'));
    assert.ok(!plan.some((e) => e.objectType === 'template'));
    assert.ok(!plan.some((e) => e.objectType === 'section_template'));
  } finally {
    rm(dir);
  }
});

// ─── 3. the CLI ──────────────────────────────────────────────────────────────

test('parseArgs reads --verify and --json alongside the existing flags', () => {
  assert.deepEqual(parseArgs(['--site', 'sites/x', '--endpoint', 'https://x/mcp', '--verify', '--json']), {
    siteDir: 'sites/x',
    endpoint: 'https://x/mcp',
    dryRun: false,
    noRelease: false,
    verify: true,
    json: true,
  });
  assert.deepEqual(parseArgs(['--site', 'sites/x', '--endpoint', 'https://x/mcp']), {
    siteDir: 'sites/x',
    endpoint: 'https://x/mcp',
    dryRun: false,
    noRelease: false,
    verify: false,
    json: false,
  });
});

test('main() keeps the CLI contract: --verify still requires --site/--endpoint, exit code 2', async () => {
  const originalLog = console.error;
  console.error = () => {};
  try {
    await main(['--verify']);
    assert.equal(process.exitCode, 2);
  } finally {
    console.error = originalLog;
    process.exitCode = undefined;
  }
});

/** Stubs `global.fetch` to speak the same JSON-RPC wire format the real MCP endpoint uses. */
const withMockFetch = async (store, fn) => {
  const originalFetch = global.fetch;
  const seenToolNames = [];
  global.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    const name = body.params.name;
    seenToolNames.push(name);
    const args = body.params.arguments;
    const key = `${args.object_type}:${args.object_id}`;
    const found = store.has(key);
    const result = found
      ? { isError: false, structuredContent: { record: { body: store.get(key) } } }
      : { isError: true, structuredContent: { error: 'Object record not found', not_found: true } };
    return { text: async () => JSON.stringify({ jsonrpc: '2.0', id: body.id, result }) };
  };
  try {
    return await fn(seenToolNames);
  } finally {
    global.fetch = originalFetch;
  }
};

const withMockedConsole = async (fn) => {
  const lines = [];
  const originalLog = console.log;
  console.log = (line) => lines.push(String(line));
  try {
    return await fn(lines);
  } finally {
    console.log = originalLog;
  }
};

test('main() --verify --json: exit 0 on an all-OK store, and the wire only ever carries object_get', async () => {
  const dir = makeSiteFixture();
  const originalKey = process.env.MCP_HTTP_AUTH_TOKEN;
  process.env.MCP_HTTP_AUTH_TOKEN = 'test-token';
  try {
    await withMockFetch(fixtureStore(), async (seenToolNames) => {
      const lines = await withMockedConsole(async (l) => {
        await main(['--site', dir, '--endpoint', 'https://fixture.example/mcp', '--verify', '--json']);
        return l;
      });
      assert.equal(process.exitCode, 0);
      assert.ok(seenToolNames.every((name) => name === 'object_get'), `saw non-read-only tool calls: ${seenToolNames.join(', ')}`);
      assert.ok(seenToolNames.length > 0, 'expected at least one object_get call');
      // `--json`'s output is the LAST console.log call (loadSeeds logs "skip …"
      // lines for not-yet-scaffolded seeds before the report is printed).
      const report = JSON.parse(lines.at(-1));
      assert.equal(report.ok, true);
    });
  } finally {
    process.env.MCP_HTTP_AUTH_TOKEN = originalKey;
    process.exitCode = undefined;
    rm(dir);
  }
});

test('main() --verify --json: exit 1 with MISSING when a nav is absent from the live store', async () => {
  const dir = makeSiteFixture();
  const originalKey = process.env.MCP_HTTP_AUTH_TOKEN;
  process.env.MCP_HTTP_AUTH_TOKEN = 'test-token';
  try {
    await withMockFetch(fixtureStore({ 'navigation:nav_header': undefined }), async () => {
      const lines = await withMockedConsole(async (l) => {
        await main(['--site', dir, '--endpoint', 'https://fixture.example/mcp', '--verify', '--json']);
        return l;
      });
      assert.equal(process.exitCode, 1);
      const report = JSON.parse(lines.at(-1));
      assert.equal(report.ok, false);
      assert.equal(report.genesis.find((e) => e.objectId === 'nav_header').status, 'MISSING');
    });
  } finally {
    process.env.MCP_HTTP_AUTH_TOKEN = originalKey;
    process.exitCode = undefined;
    rm(dir);
  }
});

test('main() --verify --json: exit 1 with a field-level DRIFTED diff when a theme token is mutated', async () => {
  const dir = makeSiteFixture();
  const originalKey = process.env.MCP_HTTP_AUTH_TOKEN;
  process.env.MCP_HTTP_AUTH_TOKEN = 'test-token';
  try {
    const mutated = { name: 'Default', tokens: { colors: { primary: '#FF0000', secondary: '#222222' }, fonts: { sans: 'Inter' } } };
    await withMockFetch(fixtureStore({ 'theme:thm_fixture_default': mutated }), async () => {
      const lines = await withMockedConsole(async (l) => {
        await main(['--site', dir, '--endpoint', 'https://fixture.example/mcp', '--verify', '--json']);
        return l;
      });
      assert.equal(process.exitCode, 1);
      const report = JSON.parse(lines.at(-1));
      assert.equal(report.ok, false);
      const theme = report.genesis.find((e) => e.objectId === 'thm_fixture_default');
      assert.equal(theme.status, 'DRIFTED');
      assert.deepEqual(theme.diff, { tokens: { colors: { primary: '#111111' } } });
    });
  } finally {
    process.env.MCP_HTTP_AUTH_TOKEN = originalKey;
    process.exitCode = undefined;
    rm(dir);
  }
});
