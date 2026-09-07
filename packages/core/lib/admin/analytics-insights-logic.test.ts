import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatEvidence,
  resolveInsightsPanel,
  summarizeOutcomeMetrics,
  INSIGHTS_EMPTY_COPY,
  INSIGHTS_WORKSPACE_SCOPE_COPY,
  type InsightsOverview,
  type TrackingOutcomeRow,
  type PlaybookTrackingItem,
  type OptimizerProposalRow,
  type StrategyObservationRow,
} from './analytics-insights-logic.js';

// ─── formatEvidence ─────────────────────────────────────────────────────────

test('formatEvidence: window + positive n is sufficient and renders both', () => {
  const result = formatEvidence({ windowStart: '2026-08-22', windowEnd: '2026-09-05', n: 5 });
  assert.equal(result.sufficient, true);
  assert.equal(result.windowLabel, '2026-08-22 → 2026-09-05');
  assert.equal(result.nLabel, 'n=5');
});

test('formatEvidence: missing window degrades to a named sentence, never a blank', () => {
  const result = formatEvidence({ n: 12 });
  assert.equal(result.sufficient, false);
  assert.equal(result.windowLabel, 'no evidence window recorded');
  assert.equal(result.nLabel, 'n=12');
});

test('formatEvidence: missing/zero/non-finite n says "insufficient evidence", never shows 0', () => {
  for (const n of [undefined, null, 0, Number.NaN, -3]) {
    const result = formatEvidence({ windowStart: 'a', windowEnd: 'b', n: n as number | null | undefined });
    assert.equal(result.sufficient, false, `n=${n}`);
    assert.equal(result.nLabel, 'insufficient evidence', `n=${n}`);
  }
});

test('formatEvidence: undefined evidence entirely degrades to both honest sentences', () => {
  const result = formatEvidence(undefined);
  assert.equal(result.sufficient, false);
  assert.equal(result.windowLabel, 'no evidence window recorded');
  assert.equal(result.nLabel, 'insufficient evidence');
});

// ─── summarizeOutcomeMetrics ────────────────────────────────────────────────

test('summarizeOutcomeMetrics: renders every present metric in human units', () => {
  const summary = summarizeOutcomeMetrics({
    sessions: 5,
    completion_rate: 0.6,
    cta_ctr: 0,
    purchase_rate: 0,
    revenue_cents: 0,
    p75_dwell_ms: 20394,
  });
  assert.match(summary, /5 sessions/);
  assert.match(summary, /60% completion/);
  assert.match(summary, /p75 dwell 20s/);
  // Zero-valued rate/revenue metrics are real ("this producer had 0% CTA
  // CTR"), but revenue of exactly 0 is written the same as "no revenue" —
  // asserting only what the function promises: it never fabricates a
  // metric that wasn't in the input.
});

test('summarizeOutcomeMetrics: no metrics at all is a named sentence, not an empty string', () => {
  assert.equal(summarizeOutcomeMetrics({}), 'no metrics reported');
});

test('summarizeOutcomeMetrics: single-session grammar is singular', () => {
  assert.match(summarizeOutcomeMetrics({ sessions: 1 }), /1 session(?!s)/);
});

// ─── resolveInsightsPanel ───────────────────────────────────────────────────

const outcomeRow: TrackingOutcomeRow = {
  id: 'fb_1',
  producer: 'plugin:claude',
  runId: 'run_1',
  createdAt: '2026-09-05T10:29:30.612Z',
  metrics: { sessions: 5, completion_rate: 0.6 },
  evidence: { windowStart: '2026-08-22', windowEnd: '2026-09-05', n: 5 },
};

const playbookItem: PlaybookTrackingItem = {
  id: 'pb_1',
  nodeId: 'plugin:claude',
  text: 'Lead with a concrete before/after claim in the hook.',
  evidenceSources: ['tracking'],
  evidence: { windowStart: '2026-08-22', windowEnd: '2026-09-05', n: 5 },
};

const proposalRow: OptimizerProposalRow = {
  id: 'prop_1',
  nodeId: 'plugin:claude',
  title: 'Shorten the hook node by ~20 words',
  status: 'proposed',
  createdAt: '2026-09-05T00:00:00.000Z',
  evidence: { windowStart: '2026-08-22', windowEnd: '2026-09-05', n: 5 },
};

const strategyRow: StrategyObservationRow = {
  id: 'strat_1',
  label: 'p75 dwell rises 40% when the hook cites a number',
  evidence: { windowStart: '2026-08-01', windowEnd: '2026-08-29', n: 64 },
};

test('resolveInsightsPanel: loading beats everything else', () => {
  const state = resolveInsightsPanel({ loading: true, error: null, overview: null });
  assert.equal(state.kind, 'loading');
});

test('resolveInsightsPanel: overview null while not loading and no error is still "loading" (fetch has not resolved)', () => {
  const state = resolveInsightsPanel({ loading: false, error: null, overview: null });
  assert.equal(state.kind, 'loading');
});

test('resolveInsightsPanel: a transport error renders the error state with the message', () => {
  const state = resolveInsightsPanel({ loading: false, error: 'network down', overview: null });
  assert.deepEqual(state, { kind: 'error', message: 'network down' });
});

test('resolveInsightsPanel: not configured uses the server message when present', () => {
  const overview: InsightsOverview = { configured: false, message: 'CMS-Agent env vars are not set for this site.' };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.deepEqual(state, { kind: 'not_configured', message: 'CMS-Agent env vars are not set for this site.' });
});

test('resolveInsightsPanel: not configured falls back to a default message when the server sends none', () => {
  const overview: InsightsOverview = { configured: false };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'not_configured');
  assert.match((state as { message: string }).message, /not configured/);
});

test('resolveInsightsPanel: all four sections ready from one fixture (2026-09-05 drlurie shape: outcomes populated, the rest genuinely empty)', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [outcomeRow] },
    playbookItems: { rows: [] },
    proposals: { rows: [] },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.outcomes, { kind: 'ready', rows: [outcomeRow] });
  assert.deepEqual(state.playbookItems, { kind: 'empty', message: INSIGHTS_EMPTY_COPY.playbookItems });
  assert.deepEqual(state.proposals, { kind: 'empty', message: INSIGHTS_EMPTY_COPY.proposals });
  assert.deepEqual(state.strategyObservations, {
    kind: 'empty',
    message: INSIGHTS_EMPTY_COPY.strategyObservations,
  });
});

test('resolveInsightsPanel: every section can independently be ready with real rows', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [outcomeRow] },
    playbookItems: { rows: [playbookItem] },
    proposals: { rows: [proposalRow] },
    strategyObservations: { rows: [strategyRow] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.outcomes, { kind: 'ready', rows: [outcomeRow] });
  assert.deepEqual(state.playbookItems, { kind: 'ready', rows: [playbookItem] });
  assert.deepEqual(state.proposals, { kind: 'ready', rows: [proposalRow] });
  assert.deepEqual(state.strategyObservations, { kind: 'ready', rows: [strategyRow] });
});

test('resolveInsightsPanel: one section failing (tool error) never blanks the other three', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [outcomeRow] },
    playbookItems: { message: 'CMS-Agent timed out calling playbook_get.' },
    proposals: { rows: [] },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.outcomes, { kind: 'ready', rows: [outcomeRow] });
  assert.deepEqual(state.playbookItems, {
    kind: 'error',
    message: 'CMS-Agent timed out calling playbook_get.',
  });
  assert.equal(state.proposals.kind, 'empty');
  assert.equal(state.strategyObservations.kind, 'empty');
});

test('resolveInsightsPanel: a section payload missing entirely renders as its own error, not a crash', () => {
  const overview: InsightsOverview = { configured: true, outcomes: { rows: [] } };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.playbookItems, { kind: 'error', message: 'This section did not load.' });
});

test('resolveInsightsPanel: an error payload with no message falls back to a generic sentence', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: {},
    playbookItems: { rows: [] },
    proposals: { rows: [] },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.outcomes, { kind: 'error', message: 'Could not load this section from CMS-Agent.' });
});

// ─── workspace_scope — playbook_get/optimizer_status are permanently out of tenant scope ──

test('resolveInsightsPanel: playbookItems/proposals with workspaceScope render as workspace_scope, not error, with the named copy', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [] },
    playbookItems: { workspaceScope: true },
    proposals: { workspaceScope: true },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  assert.equal(state.kind, 'ready');
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.playbookItems, {
    kind: 'workspace_scope',
    message: INSIGHTS_WORKSPACE_SCOPE_COPY.playbookItems,
  });
  assert.deepEqual(state.proposals, {
    kind: 'workspace_scope',
    message: INSIGHTS_WORKSPACE_SCOPE_COPY.proposals,
  });
  // Never rendered as the credential-failure copy this replaces.
  assert.doesNotMatch(state.playbookItems.message, /credential/i);
  assert.doesNotMatch(state.proposals.message, /credential/i);
});

test('resolveInsightsPanel: workspaceScope wins even if the payload also carries rows/message — it is a deliberate server fact, not inferred', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [] },
    playbookItems: { workspaceScope: true, rows: [playbookItem], message: 'should be ignored' },
    proposals: { rows: [] },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.equal(state.playbookItems.kind, 'workspace_scope');
});

test('resolveInsightsPanel: a server-supplied message on a workspaceScope payload overrides the default copy', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { rows: [] },
    playbookItems: { workspaceScope: true, message: 'custom workspace-wide sentence' },
    proposals: { rows: [] },
    strategyObservations: { rows: [] },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.playbookItems, { kind: 'workspace_scope', message: 'custom workspace-wide sentence' });
});

test('resolveInsightsPanel: a GENUINE failure on outcomes/strategy observations still renders as error, never workspace_scope', () => {
  const overview: InsightsOverview = {
    configured: true,
    outcomes: { message: 'CMS-Agent rejected the credential.' },
    playbookItems: { workspaceScope: true },
    proposals: { workspaceScope: true },
    strategyObservations: { message: 'CMS-Agent is unreachable from Platform.' },
  };
  const state = resolveInsightsPanel({ loading: false, error: null, overview });
  if (state.kind !== 'ready') throw new Error('unreachable');
  assert.deepEqual(state.outcomes, { kind: 'error', message: 'CMS-Agent rejected the credential.' });
  assert.deepEqual(state.strategyObservations, { kind: 'error', message: 'CMS-Agent is unreachable from Platform.' });
  // The two node-keyed sections are unaffected, in either direction.
  assert.equal(state.playbookItems.kind, 'workspace_scope');
  assert.equal(state.proposals.kind, 'workspace_scope');
});
