/**
 * P6 — tests for scripts/backfill-visual-standard.mjs.
 *
 * `visual_standard` (the object type) and `site_apply_brand_imagery` (the
 * verb) are being built concurrently elsewhere (BRIEF.md's dependency
 * note) — this script never imports either, so these tests exercise its
 * ORCHESTRATION against a small in-memory fake of what the merged server
 * will do: `object_get`/`object_create`/`object_checkout`/`object_publish`/
 * `object_checkin` plus the new `site_apply_brand_imagery` tool, all keyed
 * by `type:id` in a plain Map — the same shape
 * `tests/scripts/site-genesis-verify.test.mjs` already mocks
 * site-genesis-drive.mjs's `tool(name, args)` client with.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  backfillTenant,
  clientIdFor,
  parseArgs,
  planForTenant,
  runBackfill,
  siteIdFor,
} from '../../scripts/backfill-visual-standard.mjs';

// ─── id helpers ──────────────────────────────────────────────────────────────

test('clientIdFor / siteIdFor mirror create-site.mjs\'s idsFor convention', () => {
  assert.equal(clientIdFor('acme-clinic'), 'acme_clinic');
  assert.equal(siteIdFor('acme_clinic'), 'site_acme_clinic');
});

test('parseArgs reads --site/--endpoint/--all/--apply', () => {
  assert.deepEqual(parseArgs(['--site', 'acme', '--endpoint', 'https://x/mcp']), {
    slug: 'acme',
    endpoint: 'https://x/mcp',
    all: false,
    apply: false,
  });
  assert.deepEqual(parseArgs(['--all', '--apply']), { slug: undefined, endpoint: undefined, all: true, apply: true });
});

// ─── planForTenant (pure) ────────────────────────────────────────────────────

test('planForTenant: nothing exists yet — mint and apply both needed', () => {
  const plan = planForTenant({ siteBody: { name: 'Acme' }, existingVisualStandard: undefined, houseBody: {} });
  assert.equal(plan.mint, true);
  assert.equal(plan.apply, true);
});

test('planForTenant: the house standard already exists — mint skipped, apply still needed', () => {
  const plan = planForTenant({
    siteBody: { name: 'Acme' },
    existingVisualStandard: { body: { kind: 'house' } },
    houseBody: {},
  });
  assert.equal(plan.mint, false);
  assert.equal(plan.apply, true);
});

test('planForTenant: site.brandImagery already declared — apply skipped, NEVER overwritten', () => {
  const plan = planForTenant({
    siteBody: { name: 'Acme', brandImagery: { version: 1 } },
    existingVisualStandard: undefined,
    houseBody: {},
  });
  assert.equal(plan.mint, true);
  assert.equal(plan.apply, false);
});

test('planForTenant: both already present — fully idempotent, nothing left to do', () => {
  const plan = planForTenant({
    siteBody: { name: 'Acme', brandImagery: { version: 1 } },
    existingVisualStandard: { body: { kind: 'house' } },
    houseBody: {},
  });
  assert.equal(plan.mint, false);
  assert.equal(plan.apply, false);
});

// ─── a small in-memory fake of the (post-P1/P3) live surface ───────────────

/**
 * `store` is a Map keyed `type:id` -> body. Simulates the merged world: it
 * accepts `object_type: 'visual_standard'` and the `site_apply_brand_imagery`
 * tool, which this script itself never imports or type-checks against — this
 * fake stands in for exactly that not-yet-existing registry/verb.
 */
/** Per-`calls`-array record of {name, args}, so arg assertions never disturb
 *  the plain name list the existing assertions compare against. */
const CALL_ARGS = new WeakMap();

/** Every arg object recorded for `name`, in call order. */
const argsFor = (calls, name) =>
  (CALL_ARGS.get(calls) ?? []).filter((entry) => entry.name === name).map((entry) => entry.args);

const makeMockTool = (store, calls) => {
  CALL_ARGS.set(calls, []);
  let lockCounter = 0;
  /** `objectType:objectId` -> the lock token currently held on it. */
  const locks = new Map();
  return async (name, args) => {
    calls.push(name);
    // REVIEW: keep the ARGS too, so a test can assert what was actually sent
    // (a lock-free apply used to be indistinguishable from a correct one here).
    // Held OUTSIDE the `calls` array so the existing deepEqual(calls, [...])
    // assertions keep comparing a plain list of names.
    CALL_ARGS.get(calls)?.push({ name, args });
    switch (name) {
      case 'object_get': {
        const key = `${args.object_type}:${args.object_id}`;
        if (!store.has(key)) return { isError: true, data: { error: 'not found', not_found: true } };
        return { isError: false, data: { record: { body: store.get(key) } } };
      }
      case 'object_create': {
        const key = `${args.object_type}:${args.requested_id}`;
        store.set(key, structuredClone(args.body));
        return { isError: false, data: { record: { body: store.get(key) } } };
      }
      case 'object_checkout': {
        lockCounter += 1;
        const token = `lock_${lockCounter}`;
        locks.set(`${args.object_type}:${args.object_id}`, token);
        // The real verb returns `record_version` alongside `lockToken` so the
        // caller can pass it as `expected_record_version` (object-verbs.ts's
        // `withRecordVersion`).
        return { isError: false, data: { lockToken: token, record_version: 3 } };
      }
      case 'object_publish':
        // REVIEW: the real server REFUSES this for visual_standard —
        // publish-gate.ts denies any type outside governedObjectTypes with
        // `content_item_not_gated`, and the wave's rule 4 forbids widening
        // that list. A mock that said "ok" is what let a step that can only
        // ever fail sit in this script unnoticed.
        if (args.object_type === 'visual_standard') {
          return { isError: true, data: { error: 'visual_standard is not governed by the generic publish gate.', code: 'content_item_not_gated' } };
        }
        return { isError: false, data: {} };
      case 'object_checkin':
        locks.delete(`${args.object_type}:${args.object_id}`);
        return { isError: false, data: {} };
      case 'site_apply_brand_imagery': {
        const siteKey = `site:${args.site_id}`;
        const standardKey = `visual_standard:${args.visual_standard_id}`;
        if (!store.has(siteKey) || !store.has(standardKey)) {
          return { isError: true, data: { error: 'not found' } };
        }
        // REVIEW: a REAL apply needs the caller's own site checkout — the verb
        // 400s on a missing lock_token/expected_record_version and 423s on a
        // wrong one. The old mock applied regardless, so the script's
        // lock-free call looked like it worked.
        if (args.lock_token === undefined || args.expected_record_version === undefined) {
          return {
            isError: true,
            data: {
              error:
                'Applying brand imagery requires lock_token and expected_record_version from YOUR site checkout (only dry_run: true works without them).',
            },
          };
        }
        if (locks.get(siteKey) !== args.lock_token) {
          return { isError: true, data: { error: 'lock held by someone else', statusCode: 423 } };
        }
        const site = store.get(siteKey);
        const standard = store.get(standardKey);
        store.set(siteKey, { ...site, brandImagery: structuredClone(standard.brandImagery) });
        return { isError: false, data: { changedFields: ['brandImagery'] } };
      }
      default:
        return { isError: true, data: { error: `unmocked tool ${name}` } };
    }
  };
};

const SITE_BODY = {
  name: 'Acme',
  brandTokens: { colors: { primary: 'rgb(51 102 204)', accent: 'rgb(0 150 136)' } },
};

const freshStore = () => new Map([['site:site_acme', structuredClone(SITE_BODY)]]);

// ─── backfillTenant / runBackfill — the write path ──────────────────────────

test('dry run (default): lists the tenant and writes nothing', async () => {
  const store = freshStore();
  const calls = [];
  const tool = makeMockTool(store, calls);
  const results = await runBackfill({
    tenants: [{ slug: 'acme', siteId: 'site_acme', clientId: 'acme', tool }],
    apply: false,
    log: () => {},
  });

  assert.equal(results.length, 1);
  assert.equal(results[0].plan.mint, true);
  assert.equal(results[0].plan.apply, true);
  assert.equal(results[0].minted, false);
  assert.equal(results[0].applied, false);

  // Read-only: object_get for the site and for the (absent) standard, and
  // NOTHING else — no create/checkout/publish/checkin/apply call at all.
  assert.deepEqual([...new Set(calls)], ['object_get']);
  assert.equal(calls.length, 2);

  // Nothing was written to the store.
  assert.equal(store.has('visual_standard:vis_acme'), false);
  assert.equal(store.get('site:site_acme').brandImagery, undefined);
});

test('--apply (first run): writes the house standard AND the applied copy, exactly once each', async () => {
  const store = freshStore();
  const calls = [];
  const tool = makeMockTool(store, calls);
  const results = await runBackfill({
    tenants: [{ slug: 'acme', siteId: 'site_acme', clientId: 'acme', tool }],
    apply: true,
    log: () => {},
  });

  assert.equal(results[0].minted, true);
  assert.equal(results[0].applied, true);
  assert.equal(results[0].failed, false);

  const countOf = (name) => calls.filter((c) => c === name).length;
  assert.equal(countOf('object_create'), 1);
  // REVIEW: the ONE checkout/checkin pair is the SITE's, taken for the apply.
  // There is no publish call at all — visual_standard is not publishable.
  assert.equal(countOf('object_checkout'), 1);
  assert.equal(countOf('object_checkin'), 1);
  assert.equal(countOf('object_publish'), 0);
  assert.equal(countOf('site_apply_brand_imagery'), 1);
  const applyArgs = argsFor(calls, 'site_apply_brand_imagery')[0];
  assert.equal(applyArgs.site_id, 'site_acme');
  assert.ok(applyArgs.lock_token, 'the apply must carry the caller\'s own site lock');
  assert.equal(applyArgs.expected_record_version, 3);
  const checkoutArgs = argsFor(calls, 'object_checkout')[0];
  assert.equal(checkoutArgs.object_type, 'site');

  const standard = store.get('visual_standard:vis_acme');
  assert.ok(standard, 'expected vis_acme to have been minted');
  assert.equal(standard.kind, 'house');
  assert.equal(standard.status, 'active');
  assert.deepEqual(standard.derivedFrom, { method: 'tokens' });
  assert.ok(standard.sampleSubjects.length >= 1 && standard.sampleSubjects.length <= 6);
  assert.ok(standard.label.includes('Acme'));

  const site = store.get('site:site_acme');
  assert.ok(site.brandImagery, 'expected site.brandImagery to be populated');
  assert.deepEqual(site.brandImagery, standard.brandImagery, 'the applied copy must match the house standard exactly');
});

test('a second --apply run is idempotent: no create/checkout/publish/checkin/apply calls at all', async () => {
  const store = freshStore();
  const calls1 = [];
  await runBackfill({
    tenants: [{ slug: 'acme', siteId: 'site_acme', clientId: 'acme', tool: makeMockTool(store, calls1) }],
    apply: true,
    log: () => {},
  });
  const standardAfterFirstRun = structuredClone(store.get('visual_standard:vis_acme'));
  const siteAfterFirstRun = structuredClone(store.get('site:site_acme'));

  const calls2 = [];
  const results2 = await runBackfill({
    tenants: [{ slug: 'acme', siteId: 'site_acme', clientId: 'acme', tool: makeMockTool(store, calls2) }],
    apply: true,
    log: () => {},
  });

  assert.equal(results2[0].plan.mint, false);
  assert.equal(results2[0].plan.apply, false);
  assert.equal(results2[0].minted, false);
  assert.equal(results2[0].applied, false);

  // Purely read-only the second time around.
  assert.deepEqual([...new Set(calls2)], ['object_get']);

  // Nothing changed underneath the already-backfilled tenant.
  assert.deepEqual(store.get('visual_standard:vis_acme'), standardAfterFirstRun);
  assert.deepEqual(store.get('site:site_acme'), siteAfterFirstRun);
});

test('backfillTenant skips a site with no brandTokens to derive from, even with --apply', async () => {
  const store = new Map([['site:site_bare', { name: 'Bare Co' }]]);
  const calls = [];
  const tool = makeMockTool(store, calls);
  const result = await backfillTenant({
    slug: 'bare',
    siteId: 'site_bare',
    clientId: 'bare',
    tool,
    apply: true,
    log: () => {},
  });
  assert.equal(result.skipped, 'no_brand_tokens');
  assert.deepEqual(calls, ['object_get']);
});

test('backfillTenant skips a site id that does not exist on the store', async () => {
  const store = new Map();
  const calls = [];
  const tool = makeMockTool(store, calls);
  const result = await backfillTenant({
    slug: 'ghost',
    siteId: 'site_ghost',
    clientId: 'ghost',
    tool,
    apply: true,
    log: () => {},
  });
  assert.equal(result.skipped, 'site_not_found');
  assert.deepEqual(calls, ['object_get']);
});

test('runBackfill handles multiple independent tenants in one pass', async () => {
  const storeA = freshStore();
  const storeB = new Map([
    ['site:site_globex', { name: 'Globex', brandTokens: { colors: { primary: '#112233' } } }],
  ]);
  const callsA = [];
  const callsB = [];
  const results = await runBackfill({
    tenants: [
      { slug: 'acme', siteId: 'site_acme', clientId: 'acme', tool: makeMockTool(storeA, callsA) },
      { slug: 'globex', siteId: 'site_globex', clientId: 'globex', tool: makeMockTool(storeB, callsB) },
    ],
    apply: true,
    log: () => {},
  });
  assert.equal(results.length, 2);
  assert.ok(results.every((r) => r.minted && r.applied));
  assert.ok(storeA.has('visual_standard:vis_acme'));
  assert.ok(storeB.has('visual_standard:vis_globex'));
});
