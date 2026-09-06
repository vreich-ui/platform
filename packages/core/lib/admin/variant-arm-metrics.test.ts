import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ARM_METRICS_SESSION_FLOOR,
  BELOW_FLOOR_TEXT,
  armMetricCells,
  equalShares,
  familyArmMetrics,
  honestyLabel,
  normalizeArmShares,
  resolveArmMetricsPanel,
  rollupsByObjectId,
  type ArmRollupRow,
  type ArmMetricsOverview,
  type Experiment,
} from './variant-arm-metrics.js';
import type { VariantFamily } from './variant-experiments.js';

const row = (overrides: Partial<ArmRollupRow> & { object_id: string }): ArmRollupRow => ({
  exposures: 1000,
  sessions: 800,
  completion_rate: 0.5,
  cta_click_rate: 0.1,
  purchase_rate: 0.05,
  revenue: 250,
  ...overrides,
});

const experiment = (overrides: Partial<Experiment> & { object_id: string; arms: Experiment['arms'] }): Experiment => ({
  status: 'active',
  ...overrides,
});

// ─── honesty (§15.4 / §16) ──────────────────────────────────────────────────

describe('honestyLabel', () => {
  it('is directional when no experiment names the family at all', () => {
    assert.equal(honestyLabel(undefined, 'req_article_a_20260901_01').kind, 'directional');
    assert.equal(honestyLabel([], 'req_article_a_20260901_01').kind, 'directional');
  });

  it('is directional when the only matching entry is draft or concluded, never "active"', () => {
    const arms: Experiment['arms'] = [
      { variant_id: 'req_article_a_20260901_01', route: '/a' },
      { variant_id: 'req_article_a_20260901_02', route: '/a-b' },
    ];
    const draft = experiment({ object_id: 'req_article_a_20260901_01', arms, status: 'draft' });
    const concluded = experiment({ object_id: 'req_article_a_20260901_01', arms, status: 'concluded' });
    assert.equal(honestyLabel([draft], 'req_article_a_20260901_01').kind, 'directional');
    assert.equal(honestyLabel([concluded], 'req_article_a_20260901_01').kind, 'directional');
  });

  it('is directional when an active entry exists for a DIFFERENT family', () => {
    const other = experiment({
      object_id: 'req_other_20260901_01',
      arms: [
        { variant_id: 'req_other_20260901_01', route: '/other' },
        { variant_id: 'req_other_20260901_02', route: '/other-b' },
      ],
    });
    assert.equal(honestyLabel([other], 'req_article_a_20260901_01').kind, 'directional');
  });

  it('is ab_test — and carries the entry — only for an active entry naming this family', () => {
    const active = experiment({
      object_id: 'req_article_a_20260901_01',
      arms: [
        { variant_id: 'req_article_a_20260901_01', route: '/a' },
        { variant_id: 'req_article_a_20260901_02', route: '/a-b' },
      ],
    });
    const result = honestyLabel([active], 'req_article_a_20260901_01');
    assert.equal(result.kind, 'ab_test');
    assert.equal(result.experiment, active);
  });
});

// ─── the sample floor ───────────────────────────────────────────────────────

describe('armMetricCells — the sample floor', () => {
  it('shows real numbers at or above the floor', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'a', sessions: ARM_METRICS_SESSION_FLOOR })]);
    const [cell] = armMetricCells(['a'], rollups, undefined, undefined);
    assert.equal(cell!.belowFloor, false);
    assert.equal(cell!.completion, '50.0%');
    assert.equal(cell!.ctaCtr, '10.0%');
    assert.equal(cell!.purchase, '5.0%');
    assert.equal(cell!.revenue, '$250.00');
  });

  it('replaces completion/CTA/purchase/revenue with the exact words below the floor — never a zero, never blank', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'a', sessions: ARM_METRICS_SESSION_FLOOR - 1 })]);
    const [cell] = armMetricCells(['a'], rollups, undefined, undefined);
    assert.equal(cell!.belowFloor, true);
    assert.equal(cell!.completion, BELOW_FLOOR_TEXT);
    assert.equal(cell!.ctaCtr, BELOW_FLOOR_TEXT);
    assert.equal(cell!.purchase, BELOW_FLOOR_TEXT);
    assert.equal(cell!.revenue, BELOW_FLOOR_TEXT);
    assert.notEqual(cell!.completion, '0.0%');
  });

  it('keeps exposures/sessions as real numbers below the floor — the floor is unverifiable if they vanish too', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'a', sessions: 12, exposures: 40 })]);
    const [cell] = armMetricCells(['a'], rollups, undefined, undefined);
    assert.equal(cell!.sessions, 12);
    assert.equal(cell!.exposures, 40);
  });

  it('a member with no rollup row at all reads as zero sessions — below the floor, not an error', () => {
    const [cell] = armMetricCells(['missing'], {}, undefined, undefined);
    assert.equal(cell!.hasData, false);
    assert.equal(cell!.belowFloor, true);
    assert.equal(cell!.sessions, 0);
    assert.equal(cell!.completion, BELOW_FLOOR_TEXT);
  });
});

// ─── weight ─────────────────────────────────────────────────────────────────

describe('normalizeArmShares / equalShares', () => {
  it('splits 3 arms 34/33/33 with no data at all', () => {
    assert.deepEqual(equalShares(3), [34, 33, 33]);
  });

  it('uses the sink row when every arm has a usable value', () => {
    const result = normalizeArmShares(['a', 'b'], { a: 75, b: 25 });
    assert.equal(result.source, 'sink');
    assert.deepEqual(result.shares, [75, 25]);
  });

  it('falls back to equal for the WHOLE experiment when one arm is missing from the row', () => {
    const result = normalizeArmShares(['a', 'b'], { a: 90 });
    assert.equal(result.source, 'default_equal');
    assert.deepEqual(result.shares, [50, 50]);
  });

  it('falls back to equal on a negative or non-finite value', () => {
    assert.equal(normalizeArmShares(['a', 'b'], { a: -1, b: 1 }).source, 'default_equal');
    assert.equal(normalizeArmShares(['a', 'b'], { a: Number.NaN, b: 1 }).source, 'default_equal');
  });

  it('falls back to equal on a zero-sum row', () => {
    assert.equal(normalizeArmShares(['a', 'b'], { a: 0, b: 0 }).source, 'default_equal');
  });

  it('falls back to equal when the sink returned no row at all', () => {
    const result = normalizeArmShares(['a', 'b', 'c'], undefined);
    assert.equal(result.source, 'default_equal');
    assert.deepEqual(result.shares, [34, 33, 33]);
  });
});

describe('armMetricCells — weight column', () => {
  const arms: Experiment['arms'] = [
    { variant_id: 'parent', route: '/a' },
    { variant_id: 'child', route: '/a-b' },
  ];
  const active = experiment({ object_id: 'parent', arms });

  it('is not_experiment (no split running) for a directional family', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'parent' }), row({ object_id: 'child' })]);
    const cells = armMetricCells(['parent', 'child'], rollups, undefined, undefined);
    assert.ok(cells.every((cell) => cell.weight.source === 'not_experiment'));
  });

  it('reads the sink weight for each arm of an active experiment', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'parent' }), row({ object_id: 'child' })]);
    const cells = armMetricCells(['parent', 'child'], rollups, active, { parent: 70, child: 30 });
    assert.deepEqual(
      cells.map((cell) => cell.weight),
      [
        { pct: 70, source: 'sink' },
        { pct: 30, source: 'sink' },
      ]
    );
  });

  it('degrades to equal, source default_equal, when /weights has no usable row for the arm', () => {
    const rollups = rollupsByObjectId([row({ object_id: 'parent' }), row({ object_id: 'child' })]);
    const cells = armMetricCells(['parent', 'child'], rollups, active, undefined);
    assert.deepEqual(
      cells.map((cell) => cell.weight),
      [
        { pct: 50, source: 'default_equal' },
        { pct: 50, source: 'default_equal' },
      ]
    );
  });

  it('a family member outside the active experiment (e.g. a second, un-listed clone) gets not_experiment, not a bogus 0%', () => {
    const rollups = rollupsByObjectId([
      row({ object_id: 'parent' }),
      row({ object_id: 'child' }),
      row({ object_id: 'unlisted_clone' }),
    ]);
    const cells = armMetricCells(['parent', 'child', 'unlisted_clone'], rollups, active, { parent: 70, child: 30 });
    assert.equal(cells[2]!.weight.source, 'not_experiment');
  });
});

// ─── the page-level panel gate ──────────────────────────────────────────────

describe('resolveArmMetricsPanel', () => {
  it('is a named not_configured state, never zeros, when the sink is unconfigured', () => {
    const overview: ArmMetricsOverview = {
      configured: false,
      enabled: false,
      error_code: 'own_tracker_unconfigured',
      message: 'The tracking sink is not configured for this site.',
    };
    const state = resolveArmMetricsPanel({ loading: false, error: null, overview });
    assert.equal(state.kind, 'not_configured');
    if (state.kind === 'not_configured') assert.match(state.message, /not configured/);
  });

  it('is a named error state, never zeros, when the fetch failed', () => {
    const state = resolveArmMetricsPanel({
      loading: false,
      error: 'Arm metrics request failed (500).',
      overview: null,
    });
    assert.equal(state.kind, 'error');
  });

  it('is ready with indexed rollups when the sink answered', () => {
    const overview: ArmMetricsOverview = {
      configured: true,
      enabled: true,
      rows: [row({ object_id: 'a' })],
      experiments: [],
      weights: {},
    };
    const state = resolveArmMetricsPanel({ loading: false, error: null, overview });
    assert.equal(state.kind, 'ready');
    if (state.kind === 'ready') assert.ok(state.rollups.a);
  });
});

// ─── familyArmMetrics (the FamilyCard call site) ───────────────────────────

describe('familyArmMetrics', () => {
  const family: Pick<VariantFamily, 'parentId' | 'members'> = {
    parentId: 'parent',
    members: [
      {
        member: {
          object_id: 'parent',
          display_name: 'Parent',
          status: 'active',
          review_state: 'none',
          published_time: null,
          unpublished_changes: false,
          updated_at: '',
        },
        role: 'parent',
        severity: 'success',
        statusLabel: 'Published',
        live: true,
      },
      {
        member: {
          object_id: 'child',
          display_name: 'Child',
          status: 'active',
          review_state: 'none',
          published_time: null,
          unpublished_changes: false,
          updated_at: '',
        },
        role: 'variant',
        severity: 'info',
        statusLabel: 'Draft',
        live: false,
      },
    ],
  };

  it('directional family: honesty says directional, weights are not_experiment', () => {
    const ready = resolveArmMetricsPanel({
      loading: false,
      error: null,
      overview: {
        configured: true,
        enabled: true,
        rows: [row({ object_id: 'parent' }), row({ object_id: 'child' })],
        experiments: [],
        weights: {},
      },
    });
    assert.equal(ready.kind, 'ready');
    if (ready.kind !== 'ready') return;
    const result = familyArmMetrics(ready, family);
    assert.equal(result.honesty.kind, 'directional');
    assert.ok(result.cells.every((cell) => cell.weight.source === 'not_experiment'));
  });

  it('active-experiment family: honesty says ab_test and weights come from the sink row keyed by the control id', () => {
    const active = experiment({
      object_id: 'parent',
      arms: [
        { variant_id: 'parent', route: '/a' },
        { variant_id: 'child', route: '/a-b' },
      ],
    });
    const ready = resolveArmMetricsPanel({
      loading: false,
      error: null,
      overview: {
        configured: true,
        enabled: true,
        rows: [row({ object_id: 'parent', sessions: 200 }), row({ object_id: 'child', sessions: 5 })],
        experiments: [active],
        weights: { parent: { parent: 60, child: 40 } },
      },
    });
    assert.equal(ready.kind, 'ready');
    if (ready.kind !== 'ready') return;
    const result = familyArmMetrics(ready, family);
    assert.equal(result.honesty.kind, 'ab_test');
    const [parentCell, childCell] = result.cells;
    assert.deepEqual(parentCell!.weight, { pct: 60, source: 'sink' });
    assert.deepEqual(childCell!.weight, { pct: 40, source: 'sink' });
    // The child arm's own traffic is below the floor even though the family is a real test.
    assert.equal(childCell!.belowFloor, true);
    assert.equal(childCell!.completion, BELOW_FLOOR_TEXT);
    assert.equal(parentCell!.belowFloor, false);
  });
});
