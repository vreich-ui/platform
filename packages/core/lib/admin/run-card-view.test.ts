import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { activityTargetKey, runCardStatus, runCardView, type RunCardViewInput } from './run-card-view.js';
import { runCardStatesStatus } from './chat-liveness.js';

/** A quiet, nothing-to-see run — the common case a collapsed card must serve. */
const BASE: RunCardViewInput = {
  status: 'running',
  expanded: false,
  hasRetryTarget: false,
  hasOperatorAction: false,
  isBudgetExceeded: false,
  hasRetryHandler: false,
  isOwner: false,
  offerRecheck: false,
};

describe('runCardView — collapsed by default', () => {
  it('running, not toggled: fully collapsed', () => {
    const view = runCardView({ ...BASE, status: 'running' });
    assert.equal(view.expandedByDefault, false);
    assert.equal(view.showNodeList, false);
    assert.equal(view.showRecovery, false);
  });

  it('done, not toggled: fully collapsed', () => {
    const view = runCardView({ ...BASE, status: 'done' });
    assert.equal(view.expandedByDefault, false);
    assert.equal(view.showNodeList, false);
    assert.equal(view.showRecovery, false);
  });

  it('a user toggle opens everything, whatever the status', () => {
    const view = runCardView({ ...BASE, status: 'running', expanded: true });
    assert.equal(view.expandedByDefault, true);
    assert.equal(view.showNodeList, true);
    assert.equal(view.showRecovery, true);
  });
});

describe('runCardView — a run that needs a human opens itself partway', () => {
  it('failed, not toggled: recovery block opens, node list does not', () => {
    const view = runCardView({ ...BASE, status: 'failed' });
    assert.equal(view.expandedByDefault, true);
    assert.equal(view.showRecovery, true);
    assert.equal(view.showNodeList, false);
  });

  it('needs_you, not toggled: same partial open', () => {
    const view = runCardView({ ...BASE, status: 'needs_you' });
    assert.equal(view.expandedByDefault, true);
    assert.equal(view.showRecovery, true);
    assert.equal(view.showNodeList, false);
  });

  it('failed AND toggled: the node list joins the recovery block', () => {
    const view = runCardView({ ...BASE, status: 'failed', expanded: true });
    assert.equal(view.showNodeList, true);
    assert.equal(view.showRecovery, true);
  });
});

describe('runCardView — primary action precedence', () => {
  it('an Owner on budget_exceeded gets budget-raise, even with a retry target and handler', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      hasRetryTarget: true,
      hasRetryHandler: true,
      isBudgetExceeded: true,
      isOwner: true,
    });
    assert.deepEqual(view.primaryAction, { kind: 'budget-raise' });
  });

  it('a non-Owner on budget_exceeded gets no budget-raise — falls through to retry when available', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      hasRetryTarget: true,
      hasRetryHandler: true,
      isBudgetExceeded: true,
      isOwner: false,
    });
    assert.deepEqual(view.primaryAction, { kind: 'retry' });
  });

  it('a non-Owner on budget_exceeded with no retry handler wired yet gets nothing', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      hasRetryTarget: true,
      hasRetryHandler: false,
      isBudgetExceeded: true,
      isOwner: false,
    });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'no_retry_handler' });
  });

  it('retry is available once a host wires onRetry, for a plain (non-budget) failure', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      hasRetryTarget: true,
      hasRetryHandler: true,
    });
    assert.deepEqual(view.primaryAction, { kind: 'retry' });
  });

  it('retry is suppressed when the failure carries an operator_action, even with a handler wired', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      hasRetryTarget: true,
      hasRetryHandler: true,
      hasOperatorAction: true,
    });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'operator_action' });
  });

  it('no recovery target at all (nothing failed): no primary action', () => {
    const view = runCardView({ ...BASE, status: 'running' });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'no_recovery' });
  });

  it('today, with no call site passing onRetry: a plain failure shows no primary action', () => {
    const view = runCardView({ ...BASE, status: 'failed', hasRetryTarget: true, hasRetryHandler: false });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'no_retry_handler' });
  });
});

describe('runCardView — publication tail verbosity', () => {
  it('one line by default', () => {
    assert.equal(runCardView({ ...BASE, offerRecheck: false }).publicationLines, 'one');
  });

  it('full detail when the tail wants a recheck', () => {
    assert.equal(runCardView({ ...BASE, offerRecheck: true }).publicationLines, 'full');
  });
});

// ─── FIX 4: runCardStatus — all four sources of `needs_you` ──────────────────

/**
 * The card used to derive this with an inline ternary that knew about
 * `approvals` and nothing else, so three of the four things
 * `server/lib/requests/derive-status.ts` §5.1 calls `needs_you` fell through
 * to `running`: the list badged a row amber while the card sat collapsed
 * next to it, spinner turning, recovery block shut.
 *
 * These cases are that section's precedence, read back.
 */
describe('runCardStatus — the four things the server calls needs_you', () => {
  it('a genuine approval hold', () => {
    assert.equal(runCardStatus({ status: 'running', approvalCount: 1 }), 'needs_you');
  });

  it('a blocked run — and it now auto-opens, which is the whole point', () => {
    assert.equal(runCardStatus({ status: 'blocked', approvalCount: 0 }), 'blocked');
    assert.equal(runCardView({ ...BASE, status: 'blocked' }).expandedByDefault, true);
    assert.equal(runCardView({ ...BASE, status: 'blocked' }).showRecovery, true);
  });

  it('a paused run — likewise', () => {
    assert.equal(runCardStatus({ status: 'paused', approvalCount: 0 }), 'paused');
    assert.equal(runCardView({ ...BASE, status: 'paused' }).expandedByDefault, true);
  });

  it('an attached chat waiting on a human, which outranks even a failed run', () => {
    assert.equal(runCardStatus({ status: 'running', chatStatus: 'awaiting_approval' }), 'needs_you');
    assert.equal(runCardStatus({ status: 'running', chatStatus: 'awaiting_candidate' }), 'needs_you');
    // derive-status.ts §5.1 rule 1: the chat is the NEARER gate.
    assert.equal(runCardStatus({ status: 'failed', chatStatus: 'awaiting_approval' }), 'needs_you');
  });

  it('keeps the server’s order everywhere else', () => {
    assert.equal(runCardStatus({ status: 'cancelled', approvalCount: 3 }), 'cancelled');
    // The server checks `failed` before the approval hold; so does this.
    assert.equal(runCardStatus({ status: 'failed', approvalCount: 2 }), 'failed');
    assert.equal(runCardStatus({ status: 'completed' }), 'done');
    assert.equal(runCardStatus({ status: 'queued' }), 'queued');
    assert.equal(runCardStatus({ status: 'running' }), 'running');
  });

  it('an unknown or absent status lands in the quiet bucket, never in an attention one', () => {
    assert.equal(runCardStatus({ status: 'skipped' }), 'running');
    assert.equal(runCardStatus({ status: 'something_new_from_cms_agent' }), 'running');
    assert.equal(runCardStatus({}), 'running');
    for (const status of ['skipped', 'something_new_from_cms_agent', undefined]) {
      assert.equal(
        runCardView({ ...BASE, status: runCardStatus({ ...(status ? { status } : {}) }) }).expandedByDefault,
        false,
        'an unrecognised status must not open the card on its own'
      );
    }
  });

  it('a quiet run still opens on the user’s own click', () => {
    assert.equal(runCardView({ ...BASE, status: 'running', expanded: true }).expandedByDefault, true);
    assert.equal(runCardView({ ...BASE, status: 'running', expanded: true }).showNodeList, true);
    // …and an auto-opened one still keeps the node list behind a real click.
    assert.equal(runCardView({ ...BASE, status: 'blocked' }).showNodeList, false);
  });
});

// ─── FIX 10: which run is this card showing? ────────────────────────────────

/**
 * `RequestActivity` reset its cached run_id/ETag on a target change but not
 * `loaded`/`activity` — so between switching targets and the new response
 * landing, it rendered the previous run's status while reporting that it was
 * stating THIS one's (FIX 5's `onStatesStatusChange`), silencing the thread
 * on the strength of the wrong run. The reset is now keyed on this identity.
 */
describe('activityTargetKey — the identity a card resets on', () => {
  it('is stable for the same target and changes for a different one', () => {
    assert.equal(activityTargetKey({ requestId: 'req_1' }), activityTargetKey({ requestId: 'req_1' }));
    assert.notEqual(activityTargetKey({ requestId: 'req_1' }), activityTargetKey({ requestId: 'req_2' }));
    assert.notEqual(activityTargetKey({ runId: 'run_1' }), activityTargetKey({ runId: 'run_2' }));
  });

  it('keeps request and run in separate namespaces', () => {
    // The ambiguity a naive concat collapses: polling request `x` is not
    // polling run `x`, and switching between them must reset the card.
    assert.notEqual(activityTargetKey({ requestId: 'x' }), activityTargetKey({ runId: 'x' }));
  });

  it('distinguishes an absent field from a present one, and no target from any target', () => {
    assert.notEqual(activityTargetKey({ requestId: 'req_1' }), activityTargetKey({ requestId: 'req_1', runId: 'run_1' }));
    assert.notEqual(activityTargetKey({}), activityTargetKey({ requestId: 'req_1' }));
    assert.equal(activityTargetKey({}), activityTargetKey({}));
  });

  it('a card that has switched target states no status until the new one loads', () => {
    // The composition FIX 10 exists to protect: a reset sets `loaded` false,
    // and a card that has not loaded is not stating anything (FIX 5).
    assert.equal(runCardStatesStatus({ mounted: true, loaded: false, hasActivity: false }), false);
    // …and it is only honest again once the NEW target's poll has landed.
    assert.equal(runCardStatesStatus({ mounted: true, loaded: true, hasActivity: true }), true);
  });
});
