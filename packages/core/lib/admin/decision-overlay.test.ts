import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  DECISION_OVERLAY_TTL_MS,
  EMPTY_DECISION_OVERLAY,
  openDecisionKeys,
  pendingDecisionForRequest,
  reduceDecisionOverlay,
  rowsStillNeedingDecision,
  workflowGateKey,
  type DecisionOverlay,
} from './decision-overlay.js';

const KEY = workflowGateKey({ requestId: 'req_1' });

const begun = (): DecisionOverlay =>
  reduceDecisionOverlay(EMPTY_DECISION_OVERLAY, { type: 'begin', key: KEY, decision: 'approve', atMs: 1_000 });

describe('reduceDecisionOverlay — the optimistic update', () => {
  it('records the decision the moment the request goes out', () => {
    const state = begun();
    // `keys` is the entry's own alias group — one key here, since a run gate
    // addressed by request id already IS the key every surface looks up.
    assert.deepEqual(state[KEY], { decision: 'approve', phase: 'pending', atMs: 1_000, keys: [KEY] });
  });

  it('rolls back to nothing when the decision fails — the row goes straight back to needing a human', () => {
    const state = reduceDecisionOverlay(begun(), { type: 'rollback', key: KEY });
    assert.equal(state[KEY], undefined);
    assert.deepEqual(state, {});
  });

  it('rolls back only the failed target, never anyone else in flight', () => {
    const other = workflowGateKey({ requestId: 'req_2' });
    const two = reduceDecisionOverlay(begun(), { type: 'begin', key: other, decision: 'reject', atMs: 1_100 });
    const state = reduceDecisionOverlay(two, { type: 'rollback', key: KEY });
    assert.equal(state[KEY], undefined);
    assert.equal(state[other]?.decision, 'reject');
  });

  it('keeps the marker after the server accepts, so the row does not flash back before the next poll', () => {
    const state = reduceDecisionOverlay(begun(), { type: 'confirm', key: KEY, atMs: 2_000 });
    assert.deepEqual(state[KEY], { decision: 'approve', phase: 'confirmed', atMs: 2_000, keys: [KEY] });
  });

  it('records a confirm nobody began — a surface may decide without an optimistic step first', () => {
    const state = reduceDecisionOverlay(EMPTY_DECISION_OVERLAY, { type: 'confirm', key: KEY, atMs: 5 });
    assert.equal(state[KEY]?.phase, 'confirmed');
  });
});

describe('reduceDecisionOverlay — reconciling with the server', () => {
  it('drops a confirmed decision once the server stops listing that target as open', () => {
    const confirmed = reduceDecisionOverlay(begun(), { type: 'confirm', key: KEY, atMs: 2_000 });
    const state = reduceDecisionOverlay(confirmed, { type: 'reconcile', keys: [] });
    assert.deepEqual(state, {});
  });

  it('keeps a confirmed decision while the server still lists the target — the poll may predate it', () => {
    const confirmed = reduceDecisionOverlay(begun(), { type: 'confirm', key: KEY, atMs: 2_000 });
    const state = reduceDecisionOverlay(confirmed, { type: 'reconcile', keys: [KEY] });
    assert.equal(state[KEY]?.phase, 'confirmed');
  });

  it('never reconciles away a decision that is still in flight', () => {
    // The snapshot was fetched before the request landed; dropping the marker
    // here would put the buttons back under the cursor mid-click.
    const state = reduceDecisionOverlay(begun(), { type: 'reconcile', keys: [] });
    assert.equal(state[KEY]?.phase, 'pending');
  });

  it('expires a confirmed decision the server never caught up with, so the row cannot hide forever', () => {
    const confirmed = reduceDecisionOverlay(begun(), { type: 'confirm', key: KEY, atMs: 2_000 });
    const tooSoon = reduceDecisionOverlay(confirmed, { type: 'expire', nowMs: 2_000 + DECISION_OVERLAY_TTL_MS - 1 });
    assert.equal(tooSoon[KEY]?.phase, 'confirmed');
    const expired = reduceDecisionOverlay(confirmed, { type: 'expire', nowMs: 2_000 + DECISION_OVERLAY_TTL_MS });
    assert.deepEqual(expired, {});
  });

  it('never expires a pending decision — only wall-clock on a CONFIRMED one counts', () => {
    const state = reduceDecisionOverlay(begun(), { type: 'expire', nowMs: 1_000 + DECISION_OVERLAY_TTL_MS * 10 });
    assert.equal(state[KEY]?.phase, 'pending');
  });

  it('leaves the state object identical when nothing changed', () => {
    const state = begun();
    assert.equal(reduceDecisionOverlay(state, { type: 'reconcile', keys: [KEY] }), state);
    assert.equal(reduceDecisionOverlay(state, { type: 'rollback', key: 'nobody' }), state);
  });
});

describe('overlay keys and selectors', () => {
  it('addresses a run gate by run id when there is one and by request id otherwise', () => {
    assert.equal(workflowGateKey({ runId: 'run_9' }), 'workflow_gate:run:run_9');
    assert.equal(workflowGateKey({ requestId: 'req_9' }), 'workflow_gate:request:req_9');
    assert.equal(workflowGateKey({ requestId: 'req_9', runId: 'run_9' }), 'workflow_gate:run:run_9');
  });

  it('finds the decision this browser already made for one inbox row', () => {
    const state = begun();
    assert.equal(pendingDecisionForRequest(state, 'req_1')?.decision, 'approve');
    assert.equal(pendingDecisionForRequest(state, 'req_2'), undefined);
  });
});

describe('rowsStillNeedingDecision — the header count and the inbox agree instantly', () => {
  const rows = [
    { request_id: 'req_1', status: 'needs_you' },
    { request_id: 'req_2', status: 'needs_you' },
    { request_id: 'req_3', status: 'running' },
  ];

  it('drops a decided row from the needs-you set without touching any status', () => {
    const state = begun();
    const still = rowsStillNeedingDecision(rows, state);
    assert.deepEqual(
      still.map((row) => row.request_id),
      ['req_2']
    );
    // W19: the row objects come back untouched — the overlay never rewrites a status.
    assert.equal(rows[0].status, 'needs_you');
  });

  it('puts the row back the instant a decision rolls back', () => {
    const rolled = reduceDecisionOverlay(begun(), { type: 'rollback', key: KEY });
    assert.equal(rowsStillNeedingDecision(rows, rolled).length, 2);
  });

  it('reports exactly the open targets a snapshot should reconcile against', () => {
    assert.deepEqual(openDecisionKeys(rows), [
      workflowGateKey({ requestId: 'req_1' }),
      workflowGateKey({ requestId: 'req_2' }),
    ]);
  });
});
