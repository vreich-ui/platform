/**
 * W2 — genesis seeds the `editorial_strategy` default, and takes a
 * caller-supplied one (Wolf, 2026-09-09).
 *
 * The two failure modes this file exists to catch:
 *   1. A backfill that OVERWRITES a strategy somebody decided. The rule is
 *      "an existing strat_<client> is never touched", and it has to hold for a
 *      genesis_default too — a default somebody has since edited looks exactly
 *      like one nobody has.
 *   2. The scaffold and the backfill drifting apart, so a backfilled tenant
 *      and a freshly minted one carry different bodies at the same address.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { buildPlan } from '../../packages/core/cli/create-site.mjs';
import { genesisStrategyBody, planForTenant, runSeed, strategyIdFor } from '../../scripts/seed-editorial-strategy.mjs';

// ─── the scaffold ────────────────────────────────────────────────────────────

/** Pull `strategyBody` out of a scaffolded seed file without importing it from disk. */
const scaffoldedStrategy = (opts) => {
  const file = buildPlan(opts).files.find((entry) => entry.path.endsWith('seeds/strategy-seed-data.mjs'));
  assert.ok(file, 'expected create-site to scaffold a strategy seed');
  const match = /export const strategyBody = (\{[\s\S]*?\n\});/.exec(file.content);
  assert.ok(match, 'expected an emitted strategyBody object literal');
  return JSON.parse(match[1]);
};

test('a mint with NO strategy input seeds the skeleton, marked genesis_default', () => {
  const body = scaffoldedStrategy({ name: 'seed-probe' });
  assert.equal(body.provenance.set_by, 'genesis_default', 'the unset marker is what consumers warn on');
  assert.match(body.goal, /onboarding: fill with the client/, 'genesis invents nothing');
  // The conservative floor: top of funnel sells least.
  assert.ok(body.funnel_aggression.tofu <= body.funnel_aggression.mofu);
  assert.ok(body.funnel_aggression.mofu <= body.funnel_aggression.bofu);
});

test('a mint WITH a supplied strategy keeps the supplied values and is marked agent', () => {
  const body = scaffoldedStrategy({
    name: 'seed-probe',
    editorialStrategy: {
      goal: 'Publishing exists to sell the barrier-repair protocol.',
      angle_mix: [{ angle: 'teardown', share: 1 }],
      funnel_aggression: { tofu: 0.2, mofu: 0.5, bofu: 0.9 },
    },
  });
  assert.equal(body.provenance.set_by, 'agent', 'a supplied baseline is DECIDED — no warning fires on it');
  assert.equal(body.goal, 'Publishing exists to sell the barrier-repair protocol.');
  assert.deepEqual(body.angle_mix, [{ angle: 'teardown', share: 1 }]);
  assert.deepEqual(body.funnel_aggression, { tofu: 0.2, mofu: 0.5, bofu: 0.9 });
  // Un-supplied fields keep the skeleton's placeholder rather than vanishing.
  assert.match(body.offer, /onboarding: fill with the client/);
});

test('a supplied voice flips the VOICE marker the same way — the two baselines behave identically', () => {
  const voiceFile = (opts) =>
    buildPlan(opts).files.find((entry) => entry.path.endsWith('seeds/voice-seed-data.mjs')).content;
  assert.match(voiceFile({ name: 'seed-probe' }), /"set_by": "genesis_default"/);
  assert.match(voiceFile({ name: 'seed-probe', editorialVoice: { audience: 'Dermatology patients.' } }), /"set_by": "agent"/);
});

test('a supplied logo lands on the site singleton without wiping the derived wordmark', () => {
  const site = buildPlan({ name: 'seed-probe', logo: { src: '/img/logo.svg', alt: 'Seed Probe' } }).files.find((entry) =>
    entry.path.endsWith('seeds/site-seed-data.mjs')
  ).content;
  assert.match(site, /"src": "\/img\/logo\.svg"/);
  assert.match(site, /"text": "SEED PROBE"/, 'the derived wordmark survives a partial logo');
});

// ─── the backfill ────────────────────────────────────────────────────────────

test('an existing strategy is never overwritten — authored or still a genesis_default', () => {
  assert.equal(planForTenant({ existingStrategy: undefined }).mint, true);
  assert.equal(planForTenant({ existingStrategy: { body: { provenance: { set_by: 'human' } } } }).mint, false);
  assert.equal(
    planForTenant({ existingStrategy: { body: { provenance: { set_by: 'genesis_default' } } } }).mint,
    false,
    'a default somebody has since edited is indistinguishable from one nobody has — never re-seed either'
  );
});

/**
 * A fake `/mcp` holding one site and, optionally, a strategy. Records every
 * tool call so the test can assert on WRITES, not just on outcomes — "second
 * run is idempotent" means zero object_create calls, not merely no change.
 */
const fakeTenant = ({ withStrategy = false } = {}) => {
  const store = new Map([['site:site_acme', { body: { name: 'Acme' } }]]);
  if (withStrategy) store.set('editorial_strategy:strat_acme', { body: genesisStrategyBody('Acme') });
  const calls = [];
  const tool = async (name, args) => {
    calls.push({ name, args });
    if (name === 'object_get') {
      const record = store.get(`${args.object_type}:${args.object_id}`);
      return record ? { isError: false, data: { record } } : { isError: true, data: { error: 'not_found' } };
    }
    if (name === 'object_create') {
      store.set(`${args.object_type}:${args.requested_id}`, { body: args.body });
      return { isError: false, data: { record: { object_id: args.requested_id } } };
    }
    return { isError: true, data: { error: `unexpected tool ${name}` } };
  };
  return { tenant: { tool, slug: 'acme', siteId: 'site_acme', clientId: 'acme', brandName: 'Acme' }, calls, store };
};

test('the dry run is the default: it reads and writes nothing', async () => {
  const { tenant, calls } = fakeTenant();
  const [result] = await runSeed({ tenants: [tenant], apply: false, log: () => {} });
  assert.equal(result.minted, false);
  assert.equal(result.plan.mint, true, 'it still REPORTS what an --apply run would do');
  assert.deepEqual(
    calls.filter((call) => call.name !== 'object_get'),
    [],
    'a dry run issues no write calls at all'
  );
});

test('--apply mints strat_<client> as a genesis_default, and a second run issues zero writes', async () => {
  const { tenant, calls, store } = fakeTenant();
  const [first] = await runSeed({ tenants: [tenant], apply: true, log: () => {} });
  assert.equal(first.minted, true);
  assert.equal(first.strategyId, strategyIdFor('acme'));
  const seeded = store.get('editorial_strategy:strat_acme').body;
  assert.equal(seeded.provenance.set_by, 'genesis_default');
  // The seed identity, not this script's own name — the tenant creation policy
  // allowlists the conversion driver for editorial_strategy exactly as it does
  // for editorial_voice.
  assert.equal(calls.find((call) => call.name === 'object_create').args.agent_name, 'object-conversion-roundtrip');

  const writesAfterFirst = calls.filter((call) => call.name === 'object_create').length;
  const [second] = await runSeed({ tenants: [tenant], apply: true, log: () => {} });
  assert.equal(second.minted, false);
  assert.equal(
    calls.filter((call) => call.name === 'object_create').length,
    writesAfterFirst,
    'idempotent: the second --apply run creates nothing'
  );
});

test('a tenant whose site is missing is skipped by name, never a crash', async () => {
  const tool = async () => ({ isError: true, data: { error: 'not_found' } });
  const [result] = await runSeed({
    tenants: [{ tool, slug: 'ghost', siteId: 'site_ghost', clientId: 'ghost' }],
    apply: true,
    log: () => {},
  });
  assert.equal(result.skipped, 'site_not_found');
});

// ─── the two must not drift ──────────────────────────────────────────────────

test('the backfill body matches what create-site scaffolds, field for field', () => {
  const scaffolded = scaffoldedStrategy({ name: 'acme', brandName: 'Acme' });
  assert.deepEqual(genesisStrategyBody('Acme'), scaffolded);
});
