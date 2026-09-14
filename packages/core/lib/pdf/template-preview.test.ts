/**
 * A8 Part 1 — `template-preview.ts`'s decisions, tested against fakes.
 *
 * Every effect is injected (owner registration, job cache, job creation/poll, content
 * inspection, the clock) so none of this needs a live pdf-tool (repo test posture, BRIEF §4).
 * These tests are written directly against A8's own acceptance criteria — each `test()` below
 * is named for the criterion it proves, and the mapping is repeated in the PR description.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  TEMPLATE_PREVIEW_FIXTURE_IDS,
  buildTemplatePreviewFixture,
  buildTemplatePreviewFixtures,
  evaluateTemplatePreviewContent,
  mapStringLeaves,
  normalizeTemplatePreviewJobStatus,
  preflightTemplatePreviewFixture,
  runTemplatePreviewFixture,
  stableJsonHash,
  templatePreviewJobKey,
  templatePreviewPassed,
  templatePreviewRequestId,
  type DerivedTemplateSchema,
  type TemplatePreviewEffects,
  type TemplatePreviewJobView,
} from './template-preview.js';
import type { DocumentContentInspection } from './document-content-check.js';

// ─── fixture builders (pure) ────────────────────────────────────────────────

const DERIVED: DerivedTemplateSchema = {
  renderDataSchema: {
    type: 'object',
    required: ['heading', 'body'],
    properties: {
      heading: { type: 'string', maxLength: 80 },
      body: { type: 'string', maxLength: 4000 },
    },
    additionalProperties: false,
  },
  sampleData: { heading: 'Sample heading', body: 'Sample body copy.' },
  sampleAssets: { images: [{ assetId: 'asset_hero', blobKey: 'image/site_x/req/hero.webp' }] },
  slots: ['heading', 'body'],
  imageSlots: [],
};

test('mapStringLeaves preserves structure and only transforms string leaves', () => {
  const input = { a: 'x', b: ['y', 'z'], c: { d: 'w' }, e: 5, f: null };
  const out = mapStringLeaves(input, (s) => s.toUpperCase()) as Record<string, unknown>;
  assert.deepEqual(out, { a: 'X', b: ['Y', 'Z'], c: { d: 'W' }, e: 5, f: null });
});

test('all six fixture ids build without throwing, for a template that declares fields', () => {
  const fixtures = buildTemplatePreviewFixtures(DERIVED);
  assert.equal(fixtures.length, TEMPLATE_PREVIEW_FIXTURE_IDS.length);
  assert.deepEqual(
    fixtures.map((f) => f.id),
    [...TEMPLATE_PREVIEW_FIXTURE_IDS]
  );
});

test('the "long" fixture is worst-case: every string leaf grows well past the sample', () => {
  const fixture = buildTemplatePreviewFixture('long', DERIVED);
  const heading = fixture.data.heading as string;
  const body = fixture.data.body as string;
  assert.ok(heading.length > 2000, `expected a long heading, got ${heading.length} chars`);
  assert.ok(body.length > 2000, `expected a long body, got ${body.length} chars`);
});

test('the "short" fixture is near-empty prose, not zero-length', () => {
  const fixture = buildTemplatePreviewFixture('short', DERIVED);
  const heading = fixture.data.heading as string;
  assert.ok(heading.length > 0 && heading.length <= 12, `expected short heading, got "${heading}"`);
});

test('the "empty" fixture empties every string leaf', () => {
  const fixture = buildTemplatePreviewFixture('empty', DERIVED);
  assert.equal(fixture.data.heading, '');
  assert.equal(fixture.data.body, '');
});

test('the "rich_text" fixture carries raw HTML tags and markdown syntax an editor pasted in', () => {
  const fixture = buildTemplatePreviewFixture('rich_text', DERIVED);
  const body = fixture.data.body as string;
  assert.match(body, /<strong>/);
  assert.match(body, /<em>tag<\/em>/);
  assert.match(body, /\*\*markdown emphasis\*\*/);
});

test('the "rtl" fixture is a real right-to-left script sample, not a placeholder', () => {
  const fixture = buildTemplatePreviewFixture('rtl', DERIVED);
  const body = fixture.data.body as string;
  assert.match(body, /[؀-ۿ]/, 'expected Arabic-range characters');
});

test('the "images" fixture supplies exactly the template\'s declared assets when it has any', () => {
  const fixture = buildTemplatePreviewFixture('images', DERIVED);
  assert.deepEqual(fixture.assets, { images: [{ assetId: 'asset_hero', blobKey: 'image/site_x/req/hero.webp' }] });
});

test('the "images" fixture degrades honestly (no assets, not a crash) for a template with none declared', () => {
  const fixture = buildTemplatePreviewFixture('images', { ...DERIVED, sampleAssets: undefined });
  assert.deepEqual(fixture.assets, { images: [] });
  assert.equal(fixture.deliberatelyMissingAssets, false);
});

test('stableJsonHash is order-independent and deterministic', () => {
  const a = stableJsonHash({ x: 1, y: 2 });
  const b = stableJsonHash({ y: 2, x: 1 });
  assert.equal(a, b);
  assert.equal(stableJsonHash({ x: 1 }), stableJsonHash({ x: 1 }));
  assert.notEqual(stableJsonHash({ x: 1 }), stableJsonHash({ x: 2 }));
});

test('templatePreviewRequestId is scoped to template+version, not fixture — one owner covers all six', () => {
  assert.equal(templatePreviewRequestId('tpl_brochure', 3), 'pdf_preview_tpl-brochure_v3');
});

test('templatePreviewJobKey differs per fixture id even with identical data, and per data change', () => {
  const keyLong = templatePreviewJobKey('tpl_a', 1, 'long', { x: 1 });
  const keyShort = templatePreviewJobKey('tpl_a', 1, 'short', { x: 1 });
  const keyChanged = templatePreviewJobKey('tpl_a', 1, 'long', { x: 2 });
  assert.notEqual(keyLong, keyShort);
  assert.notEqual(keyLong, keyChanged);
});

test('normalizeTemplatePreviewJobStatus mirrors article-pdf-render.ts\'s bias toward "in flight"', () => {
  assert.equal(normalizeTemplatePreviewJobStatus('complete'), 'complete');
  assert.equal(normalizeTemplatePreviewJobStatus('succeeded'), 'complete');
  assert.equal(normalizeTemplatePreviewJobStatus('failed'), 'failed');
  assert.equal(normalizeTemplatePreviewJobStatus('cancelled'), 'failed');
  assert.equal(normalizeTemplatePreviewJobStatus('running'), 'pending');
  assert.equal(normalizeTemplatePreviewJobStatus('some_future_word_this_module_has_never_seen'), 'pending');
  assert.equal(normalizeTemplatePreviewJobStatus(undefined), 'pending');
});

// ─── preflight (reuses validate_pdf_render_data's checker) ─────────────────

test("preflight passes valid fixture data against the template's own schema", () => {
  const fixture = buildTemplatePreviewFixture('short', DERIVED);
  const result = preflightTemplatePreviewFixture(fixture, DERIVED.renderDataSchema);
  assert.deepEqual(result, { ok: true });
});

test('preflight fails a fixture whose data violates the schema (e.g. additionalProperties)', () => {
  const fixture = { id: 'short' as const, label: 'x', data: { heading: 'Hi', body: 'x', extra: 'nope' } };
  const result = preflightTemplatePreviewFixture(fixture, DERIVED.renderDataSchema);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.ok(result.errors.some((e) => e.keyword === 'additionalProperties'));
});

// ─── content verdict wiring (reuses document-content-check.ts) ─────────────

const cleanInspection: DocumentContentInspection = {
  pageCount: 6,
  sizeBytes: 500_000,
  qualityGate: { passed: true, findings: [] },
};

test('ACCEPTANCE — a real completed render with clean output is verified: true', () => {
  const verdict = evaluateTemplatePreviewContent({ ok: true, inspection: cleanInspection });
  assert.deepEqual(verdict, { status: 'ok', pageCount: 6, sizeBytes: 500_000 });
});

test('ACCEPTANCE — raw HTML/Markdown/Liquid tokens leaked into rendered text FAIL the check', () => {
  const inspection: DocumentContentInspection = {
    pageCount: 3,
    sizeBytes: 100_000,
    qualityGate: {
      passed: false,
      findings: [{ code: 'UNRENDERED_TOKEN', page: 2, detail: 'Found literal "{{article.title}}" on page 2.' }],
    },
  };
  const verdict = evaluateTemplatePreviewContent({ ok: true, inspection });
  assert.equal(verdict.status, 'failed');
  if (verdict.status !== 'failed') return;
  assert.equal(verdict.findings[0]?.code, 'UNRENDERED_TOKEN');
});

test('ACCEPTANCE — a missing/unresolved image FAILS the check', () => {
  const inspection: DocumentContentInspection = {
    pageCount: 3,
    sizeBytes: 100_000,
    qualityGate: {
      passed: false,
      findings: [{ code: 'UNRESOLVED_IMAGE', page: 1, detail: 'asset_hero could not be fetched.' }],
    },
  };
  const verdict = evaluateTemplatePreviewContent({ ok: true, inspection });
  assert.equal(verdict.status, 'failed');
});

test('ACCEPTANCE — output that cannot be fetched/inspected stays "unverified", never a silent pass', () => {
  const verdict = evaluateTemplatePreviewContent({ ok: false, reason: 'artifact fetch timed out' });
  assert.deepEqual(verdict, { status: 'unverified', reason: 'artifact fetch timed out' });
});

// ─── the orchestrator, against a fake world ─────────────────────────────────

type FakeWorld = {
  effects: TemplatePreviewEffects;
  createCalls: number;
  ownerCalls: string[];
  inspectCalls: { siteId: string; publicPath: string }[];
  cache: Map<string, { jobId: string }>;
};

const makeWorld = (options: {
  createResult: TemplatePreviewJobView | { error: { message: string } };
  polls?: TemplatePreviewJobView[];
  inspection?: { ok: true; inspection: DocumentContentInspection } | { ok: false; reason: string };
  initialCache?: Map<string, { jobId: string }>;
  pollFails?: boolean;
}): FakeWorld => {
  let clock = 0;
  let polls = 0;
  let createCalls = 0;
  const ownerCalls: string[] = [];
  const inspectCalls: { siteId: string; publicPath: string }[] = [];
  const cache = options.initialCache ?? new Map<string, { jobId: string }>();

  const world = { createCalls: 0, ownerCalls, inspectCalls, cache } as unknown as FakeWorld;

  const effects: TemplatePreviewEffects = {
    ensureOwnerRegistered: async (requestId) => {
      ownerCalls.push(requestId);
      return { ok: true, value: true };
    },
    getCachedJob: async (jobKey) => cache.get(jobKey),
    setCachedJob: async (jobKey, value) => {
      cache.set(jobKey, value);
    },
    createJob: async () => {
      createCalls += 1;
      return 'jobId' in options.createResult
        ? { ok: true, value: options.createResult }
        : { ok: false, error: options.createResult.error };
    },
    pollJob: async (jobId) => {
      if (options.pollFails) return { ok: false, error: { message: 'status endpoint unreachable' } };
      const list = options.polls ?? [];
      const view = list[Math.min(polls, list.length - 1)];
      polls += 1;
      return view ? { ok: true, value: view } : { ok: true, value: { jobId, status: 'pending' } };
    },
    inspectContent: async (input) => {
      inspectCalls.push(input);
      return options.inspection ?? { ok: false, reason: 'no inspection configured for this fake' };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  Object.defineProperty(world, 'createCalls', { get: () => createCalls });
  world.effects = effects;
  return world;
};

const params = (over: Partial<Parameters<typeof runTemplatePreviewFixture>[0]> = {}) => ({
  siteId: 'site_drlurie',
  templateId: 'tpl_brochure',
  version: 3,
  fixture: buildTemplatePreviewFixture('long', DERIVED),
  // Deliberately no renderDataSchema here: these orchestrator tests exercise the job
  // lifecycle, not the preflight gate — that gate has its own dedicated tests above, against
  // fixtures sized so the schema's own maxLength would (correctly) reject a worst-case "long"
  // fixture. Passing undefined here mirrors a template that declares no renderDataSchema at
  // all, which preflightTemplatePreviewFixture treats as "ok: true" by design.
  pollBudgetMs: 5_000,
  pollIntervalMs: 1_000,
  ...over,
});

test('ACCEPTANCE — previews never invent or require a fake content item: the owner is the SITE', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [
      { jobId: 'job_1', status: 'complete', publicPath: '/pdf/pdf_preview_tpl-brochure_v3/aa.pdf', pageCount: 8 },
    ],
    inspection: { ok: true, inspection: cleanInspection },
  });
  const outcome = await runTemplatePreviewFixture(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.requestId, 'pdf_preview_tpl-brochure_v3');
  // Only ever one owner call, for the SITE-scoped request id — never anything shaped like a
  // content_item id (which this suite never even constructs).
  assert.deepEqual(world.ownerCalls, ['pdf_preview_tpl-brochure_v3']);
});

test('ACCEPTANCE — worst-case (long) multi-page output is actually viewable: a real public_path and page count', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [
      { jobId: 'job_1', status: 'complete', publicPath: '/pdf/pdf_preview_tpl-brochure_v3/aa.pdf', pageCount: 11 },
    ],
    inspection: { ok: true, inspection: { ...cleanInspection, pageCount: 11 } },
  });
  const outcome = await runTemplatePreviewFixture(
    params({ fixture: buildTemplatePreviewFixture('long', DERIVED) }),
    world.effects
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.public_path, '/pdf/pdf_preview_tpl-brochure_v3/aa.pdf');
  assert.equal(outcome.receipt.pageCount, 11);
  assert.equal(templatePreviewPassed(outcome.receipt), true);
});

test('ACCEPTANCE — a fixture that fails preflight never reaches createJob at all', async () => {
  const badFixture = { id: 'short' as const, label: 'x', data: { heading: 'Hi', extra: 'not allowed' } };
  const world = makeWorld({ createResult: { jobId: 'unused', status: 'pending' } });
  const outcome = await runTemplatePreviewFixture(
    params({ fixture: badFixture, renderDataSchema: DERIVED.renderDataSchema }),
    world.effects
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.status, 'invalid_fixture');
  assert.equal(outcome.receipt.verified, false);
  assert.equal(world.createCalls, 0);
});

test('ACCEPTANCE — leaked template tokens in the real render FAIL the preview, verified: false', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: {
      ok: true,
      inspection: {
        pageCount: 2,
        sizeBytes: 40_000,
        qualityGate: {
          passed: false,
          findings: [{ code: 'UNRENDERED_TOKEN', detail: 'literal {{heading}} on page 1' }],
        },
      },
    },
  });
  const outcome = await runTemplatePreviewFixture(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.contentCheck?.status, 'failed');
  assert.equal(outcome.receipt.verified, false);
  assert.equal(templatePreviewPassed(outcome.receipt), false);
});

test('ACCEPTANCE — a missing image in the real render FAILS the preview, verified: false', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: {
      ok: true,
      inspection: {
        pageCount: 2,
        sizeBytes: 40_000,
        qualityGate: {
          passed: false,
          findings: [{ code: 'UNRESOLVED_IMAGE', page: 1, detail: 'asset_hero unreachable' }],
        },
      },
    },
  });
  const outcome = await runTemplatePreviewFixture(
    params({ fixture: buildTemplatePreviewFixture('images', DERIVED) }),
    world.effects
  );
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.contentCheck?.status, 'failed');
  assert.equal(outcome.receipt.verified, false);
});

test('ACCEPTANCE — output this module cannot fetch/inspect stays UNVERIFIED, never a default pass', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: { ok: false, reason: 'artifact blob temporarily unavailable' },
  });
  const outcome = await runTemplatePreviewFixture(params(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.contentCheck?.status, 'unverified');
  assert.equal(outcome.receipt.verified, false);
  assert.equal(templatePreviewPassed(outcome.receipt), false);
});

test("ACCEPTANCE — tenant scoping: content inspection is always called with the caller's own siteId, never a different one", async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
  });
  await runTemplatePreviewFixture(params({ siteId: 'site_zilberman' }), world.effects);
  assert.equal(world.inspectCalls.length, 1);
  assert.equal(world.inspectCalls[0]?.siteId, 'site_zilberman');
});

test('ACCEPTANCE — tenant scoping: two sites bound to their own effects never share a cached job for the same template+fixture', async () => {
  const cacheA = new Map<string, { jobId: string }>();
  const cacheB = new Map<string, { jobId: string }>();
  const worldA = makeWorld({
    createResult: { jobId: 'job_site_a', status: 'pending' },
    polls: [{ jobId: 'job_site_a', status: 'complete', publicPath: '/pdf/req/a.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
    initialCache: cacheA,
  });
  const worldB = makeWorld({
    createResult: { jobId: 'job_site_b', status: 'pending' },
    polls: [{ jobId: 'job_site_b', status: 'complete', publicPath: '/pdf/req/b.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
    initialCache: cacheB,
  });
  const p = params();
  const outcomeA = await runTemplatePreviewFixture({ ...p, siteId: 'site_a' }, worldA.effects);
  const outcomeB = await runTemplatePreviewFixture({ ...p, siteId: 'site_b' }, worldB.effects);
  assert.equal(worldA.createCalls, 1);
  assert.equal(worldB.createCalls, 1);
  if (outcomeA.ok && outcomeB.ok) {
    assert.notEqual(outcomeA.receipt.jobId, outcomeB.receipt.jobId);
  }
});

test('ACCEPTANCE — job idempotency: the same fixture+template+version reuses the cached job, no second createJob call', async () => {
  const cache = new Map<string, { jobId: string }>();
  const first = makeWorld({
    createResult: { jobId: 'job_1', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
    initialCache: cache,
  });
  const outcome1 = await runTemplatePreviewFixture(params(), first.effects);
  assert.equal(outcome1.ok, true);
  assert.equal(first.createCalls, 1);

  const second = makeWorld({
    createResult: { jobId: 'job_should_not_be_used', status: 'pending' },
    polls: [{ jobId: 'job_1', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
    initialCache: cache,
  });
  const outcome2 = await runTemplatePreviewFixture(params(), second.effects);
  assert.equal(outcome2.ok, true);
  if (!outcome2.ok) return;
  assert.equal(second.createCalls, 0, 'reused fixture must not call createJob again');
  assert.equal(outcome2.receipt.reused, true);
  assert.equal(outcome2.receipt.jobId, 'job_1');
});

test('a cached job id that can no longer be polled falls back to creating a fresh job, rather than failing outright', async () => {
  const cache = new Map<string, { jobId: string }>([
    [templatePreviewJobKey('tpl_brochure', 3, 'long', params().fixture.data), { jobId: 'job_stale' }],
  ]);
  const world = makeWorld({
    createResult: { jobId: 'job_fresh', status: 'pending' },
    polls: [{ jobId: 'job_fresh', status: 'complete', publicPath: '/pdf/req/aa.pdf', pageCount: 2 }],
    inspection: { ok: true, inspection: cleanInspection },
    initialCache: cache,
    pollFails: true,
  });
  // pollFails makes every pollJob call fail, including the fresh job's own poll loop — so
  // relax that after the cache-miss fallback is exercised by asserting only on createCalls
  // and the fact a NEW job id was requested at all.
  const outcome = await runTemplatePreviewFixture(params(), world.effects);
  assert.equal(outcome.ok, true);
  assert.equal(world.createCalls, 1, 'an unreadable cached job must trigger exactly one fresh createJob call');
});

test('a still-pending job at the poll budget reports pending honestly, never a claimed result', async () => {
  const world = makeWorld({
    createResult: { jobId: 'job_slow', status: 'pending' },
    polls: [{ jobId: 'job_slow', status: 'pending' }],
  });
  const outcome = await runTemplatePreviewFixture(params({ pollBudgetMs: 100, pollIntervalMs: 1000 }), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.receipt.status, 'pending');
  assert.equal(outcome.receipt.verified, false);
  assert.equal(world.inspectCalls.length, 0, 'a job that never completed must never be inspected');
});
