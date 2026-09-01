import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activityTargetKey,
  resolveRecoveryNodeId,
  runCardStatus,
  runCardView,
  type RunCardRecoveryNode,
  type RunCardViewInput,
} from './run-card-view.js';
import { runCardStatesStatus } from './chat-liveness.js';

/** A quiet, nothing-to-see run — the common case a collapsed card must serve. */
const BASE: RunCardViewInput = {
  status: 'running',
  expanded: false,
  recoveryNodeId: undefined,
  recoveryOperatorAction: undefined,
  nodes: [],
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
  it('no recovery at all (nothing failed): no primary action', () => {
    const view = runCardView({ ...BASE, status: 'running' });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'no_recovery' });
  });

  it('today, with no call site passing onRetry: a plain failure shows no primary action', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      recoveryNodeId: 'n1',
      nodes: [{ id: 'n1', status: 'failed', failure: { code: 'provider_error' } }],
      hasRetryHandler: false,
    });
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'no_retry_handler' });
  });

  it('retry is available once a host wires onRetry, for a plain (non-budget) failure with no operator_action', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      recoveryNodeId: 'n1',
      nodes: [{ id: 'n1', status: 'failed', failure: { code: 'provider_error' } }],
      hasRetryHandler: true,
    });
    assert.deepEqual(view.primaryAction, { kind: 'retry' });
  });
});

// ─── C4: budget_exceeded recovery is truthful ────────────────────────────────

/**
 * The live-confirmed lie: an Owner hit a $6.47 spend against a $2 budget and
 * the card offered a plain Retry — the one button guaranteed to fail the
 * same way — instead of the budget-raise buttons. Root cause was
 * `recovery.node_id` naming a node that was not (any longer, or under that
 * exact id) in `activity.nodes`, so the old `nodes.find(n => n.id ===
 * recovery.node_id)` came back `undefined` and `isBudgetExceeded` read
 * false. Two more places carried the same-shaped bug: the operator-action
 * check read only the run-level sentence, never the failing node's own; and
 * a non-Owner facing `budget_exceeded` fell through to a Retry that could
 * only fail the same way again, with no explanation.
 *
 * This table crosses every dimension the fix touches: whether the viewer is
 * an Owner, whether `recovery.node_id` actually matches a node in `nodes`
 * (`hit`) or names none of them the way the live bug did (`miss`, forcing
 * the fallback to the node that actually failed), where the failure's
 * `operator_action` sentence lives (the run-level `recovery.operator_action`
 * vs. the node's own `failure.operatorAction` vs. neither), and whether the
 * failure is `budget_exceeded` at all. The INVARIANT under test: for a
 * `budget_exceeded` failure, `hit` and `miss` must produce the IDENTICAL
 * decision — the fallback makes a stale node id behave exactly like a
 * matching one, never worse.
 */
describe('runCardView — C4: the full table (isOwner × node-match × operator_action location × failure code)', () => {
  const MATCHING_ID = 'exec_publish';
  const STALE_ID = 'exec_publish_stale'; // never appears in `nodes` — the live bug's shape
  const OPERATOR_ACTION_TEXT = 'Raise the budget or contact the owner.';

  type NodeMatch = 'hit' | 'miss';
  type OperatorActionAt = 'run' | 'node' | 'none';
  type FailureCode = 'budget_exceeded' | 'other';

  function buildInput(isOwner: boolean, nodeMatch: NodeMatch, operatorActionAt: OperatorActionAt, failureCode: FailureCode): RunCardViewInput {
    const node: RunCardRecoveryNode = {
      id: MATCHING_ID,
      status: 'failed',
      failure: {
        code: failureCode === 'budget_exceeded' ? 'budget_exceeded' : 'provider_error',
        ...(operatorActionAt === 'node' ? { operatorAction: OPERATOR_ACTION_TEXT } : {}),
      },
    };
    return {
      ...BASE,
      status: 'failed',
      isOwner,
      hasRetryHandler: true,
      recoveryNodeId: nodeMatch === 'hit' ? MATCHING_ID : STALE_ID,
      recoveryOperatorAction: operatorActionAt === 'run' ? OPERATOR_ACTION_TEXT : undefined,
      nodes: [node],
    };
  }

  for (const isOwner of [true, false]) {
    for (const nodeMatch of ['hit', 'miss'] as const) {
      for (const operatorActionAt of ['run', 'node', 'none'] as const) {
        for (const failureCode of ['budget_exceeded', 'other'] as const) {
          const where = `isOwner=${isOwner} nodeMatch=${nodeMatch} operatorAction=${operatorActionAt} failure=${failureCode}`;
          it(where, () => {
            const view = runCardView(buildInput(isOwner, nodeMatch, operatorActionAt, failureCode));
            if (failureCode === 'budget_exceeded') {
              // operator_action and node-match are both irrelevant here — a
              // budget ceiling routes on ownership alone, and hit/miss must
              // agree (the fallback finds the SAME failed node).
              assert.deepEqual(
                view.primaryAction,
                isOwner ? { kind: 'budget-raise' } : { kind: 'none', reason: 'owner_required' },
                where
              );
            } else if (operatorActionAt !== 'none') {
              assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'operator_action' }, where);
            } else {
              assert.deepEqual(view.primaryAction, { kind: 'retry' }, where);
            }
          });
        }
      }
    }
  }

  it('THE LIVE CASE: owner, budget_exceeded, recovery.node_id missing from activity.nodes — budget-raise, NOT retry', () => {
    const view = runCardView(buildInput(true, 'miss', 'none', 'budget_exceeded'));
    assert.deepEqual(view.primaryAction, { kind: 'budget-raise' });
  });

  it('the non-owner variant of the live case — none, with the owner reason, never Retry', () => {
    const view = runCardView(buildInput(false, 'miss', 'none', 'budget_exceeded'));
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'owner_required' });
  });

  it('a node-level operator_action alone (no run-level echo) still suppresses Retry', () => {
    const view = runCardView(buildInput(true, 'hit', 'node', 'other'));
    assert.deepEqual(view.primaryAction, { kind: 'none', reason: 'operator_action' });
  });
});

describe('resolveRecoveryNodeId', () => {
  const nodes: RunCardRecoveryNode[] = [
    { id: 'n_ok', status: 'completed' },
    { id: 'n_failed', status: 'failed', failure: { code: 'budget_exceeded' } },
  ];

  it('returns the id unchanged when it names a real node', () => {
    assert.equal(resolveRecoveryNodeId('n_ok', nodes), 'n_ok');
    assert.equal(resolveRecoveryNodeId('n_failed', nodes), 'n_failed');
  });

  it('C4: falls back to the failed node when the id names none of them', () => {
    assert.equal(resolveRecoveryNodeId('ghost_id', nodes), 'n_failed');
  });

  it('is undefined with no recovery at all, and undefined when even the fallback finds nothing', () => {
    assert.equal(resolveRecoveryNodeId(undefined, nodes), undefined);
    assert.equal(resolveRecoveryNodeId('ghost_id', [{ id: 'n_ok', status: 'completed' }]), undefined);
  });
});

// ─── FIX 8: a run with more than one failure ────────────────────────────────

/**
 * The scan the C4 fallback used picks the FIRST failed node, which on a
 * multi-failure run is position, not evidence. The click it feeds is
 * "Raise to $X as the default" — `workspace.update_node_model_config`, a
 * persistent spend ceiling — so picking wrong writes money against the wrong
 * node AND leaves the node that actually stopped the run still capped.
 * CMS-Agent already names the right one on the failure itself.
 */
describe('resolveRecoveryNodeId — FIX 8: multiple failures, evidence over position', () => {
  const multi: RunCardRecoveryNode[] = [
    { id: 'n_images', status: 'failed', failure: { code: 'provider_error' } },
    { id: 'n_draft', status: 'failed', failure: { code: 'budget_exceeded', details: { nodeId: 'n_draft' } } },
  ];

  it('prefers the node CMS-Agent itself named over whichever failed first', () => {
    assert.equal(resolveRecoveryNodeId('ghost_id', multi), 'n_draft');
  });

  it('so the budget-raise card offers buttons, against the node that actually hit the ceiling', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      recoveryNodeId: 'ghost_id',
      nodes: multi,
      isOwner: true,
      hasRetryHandler: true,
    });
    assert.equal(view.primaryAction.kind, 'budget-raise');
  });

  it('a real `recovery.node_id` still wins over the details — the server is not second-guessed', () => {
    assert.equal(resolveRecoveryNodeId('n_images', multi), 'n_images');
  });

  it('a `details.nodeId` naming a node that is not on this run is ignored, not trusted blindly', () => {
    const stale: RunCardRecoveryNode[] = [
      { id: 'n_images', status: 'failed', failure: { code: 'provider_error' } },
      { id: 'n_draft', status: 'failed', failure: { code: 'budget_exceeded', details: { nodeId: 'n_gone' } } },
    ];
    assert.equal(resolveRecoveryNodeId('ghost_id', stale), 'n_images', 'last resort: the first failure');
  });

  it('with no details anywhere it is still the first failed node — the old behaviour, unchanged', () => {
    const bare: RunCardRecoveryNode[] = [
      { id: 'n_images', status: 'failed', failure: { code: 'provider_error' } },
      { id: 'n_draft', status: 'failed', failure: { code: 'budget_exceeded' } },
    ];
    assert.equal(resolveRecoveryNodeId('ghost_id', bare), 'n_images');
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

describe('runCardView — E3: pinned step, jump to artifact', () => {
  it('object id known → the link is present', () => {
    const view = runCardView({ ...BASE, objectId: 'obj_1' });
    assert.equal(view.openDraftHref, '/admin/content/obj_1?type=content_item');
  });

  it('object id not known → no link — never a guess at where a draft might land', () => {
    const view = runCardView({ ...BASE });
    assert.equal(view.openDraftHref, undefined);
  });

  it('a budget-raise primary action and a known object id coexist — the link never displaces the primary action', () => {
    const view = runCardView({
      ...BASE,
      status: 'failed',
      isOwner: true,
      recoveryNodeId: 'exec_publish',
      nodes: [{ id: 'exec_publish', status: 'failed', failure: { code: 'budget_exceeded' } }],
      objectId: 'obj_1',
    });
    assert.deepEqual(view.primaryAction, { kind: 'budget-raise' });
    assert.equal(view.openDraftHref, '/admin/content/obj_1?type=content_item');
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
