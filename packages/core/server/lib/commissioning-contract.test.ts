/**
 * Track C — the `commissioning` block, as contract law.
 *
 * The load-bearing assertion is the SECOND one: drlurie's live strategy, which
 * has no commissioning block and never will until an operator writes one, must
 * keep validating exactly as it did before this field existed. Everything else
 * here is about making the block impossible to misconfigure silently.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { editorialStrategyBodySchema } from '../../schema/bodies/editorial-strategy-v1.js';
import { validateObject } from './object-validate.js';
import { perTypeConstraints } from '../../lib/registry/object-contract.js';

/** A strategy exactly as tenants carry one today: no commissioning block anywhere. */
const legacyStrategy = () => ({
  name: 'Dr Lurie — strategy',
  goal: 'Turn evidence-led skin explanations into routine adoption.',
  offer: 'The barrier-repair protocol.',
  audience_segments: ['compromised barrier', 'retinoid starters'],
  topic_weights: [{ label: 'barrier repair', weight: 0.6 }],
  angle_mix: [{ angle: 'myth-correction', share: 0.4 }],
  funnel_aggression: { tofu: 0.1, mofu: 0.3, bofu: 0.6 },
  cadence: 'Two long-form articles a week.',
  provenance: { set_by: 'human' as const, set_at: '2026-09-09T00:00:00.000Z' },
});

const commissioning = () => ({
  enabled: true,
  runsPerDay: 2,
  dailyBudgetUsd: 10,
  maxConcurrentRuns: 1,
  stopAfterConsecutiveFailures: 2,
  readerStateMix: { recognition: 0.4, understanding: 0.3, investigation: 0.2, selection: 0.1 },
  archetypes: [
    {
      id: 'barrier_rebuilder',
      job: 'Decide what to stop using while the barrier heals.',
      defaultTrafficSource: 'organic_search' as const,
      defaultAwarenessStage: 'problem_aware' as const,
    },
  ],
  seeds: [{ topic: 'ceramides', readerState: 'recognition' as const, archetypeId: 'barrier_rebuilder', priority: 3 }],
  exclusions: ['prescription tretinoin dosing'],
});

const validate = (body: unknown) =>
  validateObject({ objectType: 'editorial_strategy', objectId: 'strat_drlurie', body });

const statusOf = (body: unknown, id: string) => {
  const groups = validate(body);
  for (const group of groups) {
    for (const criterion of group.criteria) if (criterion.id === id) return criterion.status;
  }
  return undefined;
};

describe('editorial_strategy.commissioning', () => {
  it('parses a strategy WITH the block', () => {
    const parsed = editorialStrategyBodySchema.safeParse({ ...legacyStrategy(), commissioning: commissioning() });
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it('parses a strategy WITHOUT the block — every tenant alive today', () => {
    const parsed = editorialStrategyBodySchema.safeParse(legacyStrategy());
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  });

  it('warns, never blocks, when the block is absent', () => {
    assert.equal(statusOf(legacyStrategy(), 'strategy_commissioning_present'), 'warning');
    const groups = validate(legacyStrategy());
    const blockers = groups.flatMap((g) => g.criteria).filter((c) => c.status === 'missing');
    assert.deepEqual(blockers, [], 'an absent commissioning block must not produce a blocker');
  });

  it('warns when the block is present but switched off', () => {
    const body = { ...legacyStrategy(), commissioning: { ...commissioning(), enabled: false } };
    assert.equal(statusOf(body, 'strategy_commissioning_present'), 'warning');
  });

  it('is complete when enabled with seeds', () => {
    const body = { ...legacyStrategy(), commissioning: commissioning() };
    assert.equal(statusOf(body, 'strategy_commissioning_present'), 'complete');
    assert.equal(statusOf(body, 'strategy_commissioning_shape'), 'complete');
  });

  it('warns when enabled with nothing to publish from', () => {
    const body = { ...legacyStrategy(), commissioning: { ...commissioning(), archetypes: [], seeds: [] } };
    assert.equal(statusOf(body, 'strategy_commissioning_shape'), 'warning');
  });

  it('REFUSES at write a seed naming an archetype the strategy does not define', () => {
    const bad = { ...commissioning(), seeds: [{ ...commissioning().seeds[0]!, archetypeId: 'ghost' }] };
    const parsed = editorialStrategyBodySchema.safeParse({ ...legacyStrategy(), commissioning: bad });
    assert.equal(parsed.success, false);
  });

  it('REFUSES at write a duplicate archetype id', () => {
    const bad = { ...commissioning(), archetypes: [commissioning().archetypes[0]!, commissioning().archetypes[0]!] };
    const parsed = editorialStrategyBodySchema.safeParse({ ...legacyStrategy(), commissioning: bad });
    assert.equal(parsed.success, false);
  });

  it('reports both new rules on the contract, each as a warning', () => {
    const rules = perTypeConstraints('editorial_strategy', 'allow');
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    assert.equal(byId.get('strategy_commissioning_present')?.severity, 'warns');
    assert.equal(byId.get('strategy_commissioning_shape')?.severity, 'warns');
  });
});
