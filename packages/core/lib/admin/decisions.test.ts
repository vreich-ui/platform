import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  assertDecided,
  canDecideRunPublish,
  decide,
  decisionAvailability,
  decisionKey,
  decisionKeys,
  describeDecision,
  type ChatToolTarget,
  type DecisionDeps,
  type DecisionTarget,
  type ObjectReviewTarget,
  type WorkflowGateTarget,
} from './decisions.js';
import { objectReviewDecisionTarget } from './object-detail-actions.js';
import {
  DECISION_OVERLAY_TTL_MS,
  EMPTY_DECISION_OVERLAY,
  pendingDecisionForRequest,
  reduceDecisionOverlay,
  rowsStillNeedingDecision,
} from './decision-overlay.js';

const OBJECT: ObjectReviewTarget = { mechanism: 'object_review', objectType: 'content_item', objectId: 'obj_1' };
const CHAT: ChatToolTarget = { mechanism: 'chat_tool', chatId: 'chat_1', callId: 'call_1', tool: 'object_publish' };
const RUN: WorkflowGateTarget = { mechanism: 'workflow_gate', requestId: 'req_1' };

const getToken = async () => 'token';

interface Recorder {
  deps: DecisionDeps;
  calls: string[];
  overlay: Array<[string, string]>;
  /** The alias keys handed to `begin`/`settle` alongside the primary, in order. */
  alsoKeys: Array<readonly string[]>;
  synced: number;
}

/** A deps double that records the dispatch instead of performing it. */
function recorder(overrides: Partial<DecisionDeps> = {}): Recorder {
  const calls: string[] = [];
  const overlay: Array<[string, string]> = [];
  const alsoKeys: Array<readonly string[]> = [];
  const state = { synced: 0 };
  const deps: DecisionDeps = {
    objectVerb: async (_token, body) => {
      calls.push(`object:${String(body.decision)}:${body.note === undefined ? 'no-note' : String(body.note)}`);
      return { status: 200, body: { review_state: body.decision === 'approve' ? 'approved' : 'changes_requested' } };
    },
    approveTool: async (_token, chatId, callId, editedArgs) => {
      calls.push(`approve_tool:${chatId}:${callId}:${editedArgs ? 'edited' : 'as-proposed'}`);
      return { approved: true, executing: true };
    },
    denyTool: async (_token, chatId, callId, reason) => {
      calls.push(`deny_tool:${chatId}:${callId}:${reason ?? 'no-reason'}`);
      return { denied: true };
    },
    decideRunPublish: async (_token, target, action) => {
      calls.push(`run:${target.request_id ?? target.run_id}:${action}`);
      return { activity: null, can_approve: true };
    },
    begin: (key, decision, also) => {
      overlay.push([key, `begin:${decision}`]);
      alsoKeys.push(also ?? []);
    },
    settle: (key, ok, also) => {
      overlay.push([key, ok ? 'confirm' : 'rollback']);
      alsoKeys.push(also ?? []);
    },
    sync: () => {
      state.synced += 1;
    },
    ...overrides,
  };
  return {
    deps,
    calls,
    overlay,
    alsoKeys,
    get synced() {
      return state.synced;
    },
  };
}

describe('decisionKey — one key space across three mechanisms', () => {
  it('gives every mechanism a distinct, stable key', () => {
    assert.equal(decisionKey(OBJECT), 'object_review:content_item:obj_1');
    assert.equal(decisionKey(CHAT), 'chat_tool:chat_1:call_1');
    assert.equal(decisionKey(RUN), 'workflow_gate:request:req_1');
  });

  it('adds the request keying — and only that — when the surface knows which request it is', () => {
    assert.deepEqual(decisionKeys({ ...OBJECT, requestId: 'req_42' }), [
      'object_review:content_item:obj_1',
      'workflow_gate:request:req_42',
    ]);
    assert.deepEqual(decisionKeys({ ...CHAT, requestId: 'req_42' }), [
      'chat_tool:chat_1:call_1',
      'workflow_gate:request:req_42',
    ]);
  });

  it('adds nothing at all when no request id is known — no phantom key', () => {
    assert.deepEqual(decisionKeys(OBJECT), ['object_review:content_item:obj_1']);
    assert.deepEqual(decisionKeys(CHAT), ['chat_tool:chat_1:call_1']);
  });

  it('never duplicates a key a mechanism already produces', () => {
    // The run gate addressed by request id IS the request key.
    assert.deepEqual(decisionKeys(RUN), ['workflow_gate:request:req_1']);
    // ...but addressed by run id it is not, and a surface holding both ids
    // (RequestActivity) would otherwise file under a key no inbox row reads.
    assert.deepEqual(decisionKeys({ mechanism: 'workflow_gate', requestId: 'req_1', runId: 'run_9' }), [
      'workflow_gate:run:run_9',
      'workflow_gate:request:req_1',
    ]);
  });
});

describe('decisionAvailability — where the façade leaks, stated in code', () => {
  it('object review has no Modify: the store records approve or request_changes and nothing else', () => {
    const availability = decisionAvailability(OBJECT);
    assert.equal(availability.approve, true);
    assert.equal(availability.reject, true);
    assert.equal(availability.modify, false);
    assert.match(availability.unavailableReason.modify ?? '', /two review decisions/);
  });

  it('object review reads object-review-ui.ts, so canRequestChanges finally decides a button', () => {
    const gated = decisionAvailability({
      ...OBJECT,
      availability: { canApprove: false, canRequestChanges: true },
    });
    assert.equal(gated.approve, false);
    assert.equal(gated.reject, true);
  });

  it('a chat tool call is the only mechanism that can be Modified — approve carries edited args', () => {
    const availability = decisionAvailability(CHAT);
    assert.deepEqual(
      { approve: availability.approve, reject: availability.reject, modify: availability.modify },
      { approve: true, reject: true, modify: true }
    );
  });

  it('says truthfully which actions carry a typed reason to the server', () => {
    // Only deny_tool has a reason field; approve_tool does not.
    assert.deepEqual(decisionAvailability(CHAT).reasonReaches, { approve: false, reject: true, modify: false });
    // review_decide stores `note` on either decision.
    assert.deepEqual(decisionAvailability(OBJECT).reasonReaches, { approve: true, reject: true, modify: false });
    // The publish-gate endpoint's whole schema is {request_id|run_id, action}.
    assert.deepEqual(decisionAvailability(RUN).reasonReaches, { approve: false, reject: false, modify: false });
    assert.match(decisionAvailability(RUN).unavailableReason.modify ?? '', /approve or withhold only/);
  });

  it('closes the run gate for a viewer the server already said cannot decide', () => {
    const availability = decisionAvailability({ ...RUN, canApprove: false });
    assert.equal(availability.approve, false);
    assert.equal(availability.reject, false);
    assert.match(availability.unavailableReason.approve ?? '', /publish-decision authority/);
  });

  it('mirrors the endpoint permission line for surfaces that never fetched the activity', () => {
    assert.equal(canDecideRunPublish(['admin']), true);
    assert.equal(canDecideRunPublish(['owner', 'admin', 'publisher']), true);
    assert.equal(canDecideRunPublish(['editor']), false);
    assert.equal(canDecideRunPublish(undefined), false);
  });
});

describe('decide — dispatch to the mechanism that owns the target', () => {
  it('sends an object review approve as review_decide:approve and reports it as already applied', async () => {
    const rec = recorder();
    const result = await decide(getToken, OBJECT, 'approve', {}, rec.deps);
    assert.equal(result.ok, true);
    assert.equal(result.effect, 'applied');
    assert.equal(result.reviewState, 'approved');
    assert.deepEqual(rec.calls, ['object:approve:no-note']);
  });

  it('sends an object review reject as request_changes and carries the reason as the note', async () => {
    const rec = recorder();
    const result = await decide(getToken, OBJECT, 'reject', { reason: '  needs sources  ' }, rec.deps);
    assert.equal(result.ok, true);
    assert.deepEqual(rec.calls, ['object:request_changes:needs sources']);
    assert.equal(result.reviewState, 'changes_requested');
  });

  it('sends a chat approve as approve_tool and reports the effect as still executing', async () => {
    const rec = recorder();
    const result = await decide(getToken, CHAT, 'approve', {}, rec.deps);
    assert.equal(result.effect, 'executing');
    assert.deepEqual(rec.calls, ['approve_tool:chat_1:call_1:as-proposed']);
  });

  it('sends a chat modify as approve_tool WITH edited args — the one real Modify of the three', async () => {
    const rec = recorder();
    await decide(getToken, CHAT, 'modify', { editedArgs: { title: 'new' } }, rec.deps);
    assert.deepEqual(rec.calls, ['approve_tool:chat_1:call_1:edited']);
  });

  it('sends a chat reject as deny_tool with the typed reason', async () => {
    const rec = recorder();
    await decide(getToken, CHAT, 'reject', { reason: 'not yet' }, rec.deps);
    assert.deepEqual(rec.calls, ['deny_tool:chat_1:call_1:not yet']);
  });

  it('maps the workflow gate onto approve / withhold, the only two words that endpoint knows', async () => {
    const rec = recorder();
    await decide(getToken, RUN, 'approve', {}, rec.deps);
    await decide(getToken, RUN, 'reject', { reason: 'dropped on the floor' }, rec.deps);
    assert.deepEqual(rec.calls, ['run:req_1:approve', 'run:req_1:withhold']);
  });

  it('never gives decideRunPublish anywhere to put a reason — the real client signature has no such parameter', async () => {
    // decisionAvailability says reasonReaches.reject is false for the
    // workflow gate; this pins the mechanism, not just the label. Capture the
    // actual arguments dispatch hands to decideRunPublish and show a typed
    // reason has nowhere to land, however long it is.
    let seenArgs: unknown[] = [];
    const rec = recorder({
      decideRunPublish: async (...args) => {
        seenArgs = args;
        return { activity: null, can_approve: true };
      },
    });
    await decide(getToken, RUN, 'reject', { reason: 'a whole paragraph explaining why not' }, rec.deps);
    assert.deepEqual(seenArgs, [getToken, { request_id: 'req_1' }, 'withhold']);
  });

  it('refuses an unsupported action without sending anything at all', async () => {
    const rec = recorder();
    const result = await decide(getToken, OBJECT, 'modify', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported_decision');
    assert.deepEqual(rec.calls, []);
    assert.deepEqual(rec.overlay, []);
  });

  it('refuses Modify on the workflow gate too — its whole schema is {request_id|run_id, action:approve|withhold}, with the reason surfacing as the tooltip', async () => {
    const rec = recorder();
    const result = await decide(getToken, RUN, 'modify', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'unsupported_decision');
    // The button's `title` comes straight from this string — nothing here is
    // swallowed on the way to the tooltip.
    assert.equal(result.error, decisionAvailability(RUN).unavailableReason.modify);
    assert.match(result.error ?? '', /approve or withhold only/);
    assert.deepEqual(rec.calls, [], 'Modify must never reach the network on a mechanism with no such verb');
    assert.deepEqual(rec.overlay, [], 'a refused decision must not even begin the optimistic overlay');
  });

  it('refuses a run decision this viewer may not make, without sending anything', async () => {
    const rec = recorder();
    const result = await decide(getToken, { ...RUN, canApprove: false }, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_permitted');
    assert.deepEqual(rec.calls, []);
  });
});

describe('decide — the optimistic path and its rollback', () => {
  it('marks the target the moment the request goes out and confirms it on success', async () => {
    const rec = recorder();
    await decide(getToken, RUN, 'approve', {}, rec.deps);
    assert.deepEqual(rec.overlay, [
      ['workflow_gate:request:req_1', 'begin:approve'],
      ['workflow_gate:request:req_1', 'confirm'],
    ]);
  });

  it('rolls the marker back when the server refuses, and does NOT invalidate the shared store', async () => {
    const rec = recorder({
      objectVerb: async () => ({ status: 403, body: { error: 'Deciding a review requires a configured role.' } }),
    });
    const result = await decide(getToken, OBJECT, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_permitted');
    assert.equal(result.error, 'Deciding a review requires a configured role.');
    assert.deepEqual(rec.overlay, [
      ['object_review:content_item:obj_1', 'begin:approve'],
      ['object_review:content_item:obj_1', 'rollback'],
    ]);
    assert.equal(rec.synced, 0);
  });

  it('rolls back on a thrown transport error rather than leaving the row hidden', async () => {
    const rec = recorder({
      decideRunPublish: async () => {
        throw new Error('Failed to fetch');
      },
    });
    const result = await decide(getToken, RUN, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'transport');
    assert.equal(result.error, 'Failed to fetch');
    assert.deepEqual(rec.overlay.at(-1), ['workflow_gate:request:req_1', 'rollback']);
  });

  it('treats a tool call someone else already decided as a refusal, not a crash', async () => {
    const rec = recorder({ approveTool: async () => ({ approved: false, executing: false }) });
    const result = await decide(getToken, CHAT, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'rejected_by_server');
    assert.deepEqual(rec.overlay.at(-1), ['chat_tool:chat_1:call_1', 'rollback']);
  });

  it('reports a workflow decision that was recorded but could not advance as partly applied', async () => {
    // The endpoint answers 200 with `error` when the durable decision stands
    // and only the advance failed — which half happened is the whole question.
    const rec = recorder({
      decideRunPublish: async () => ({ activity: null, reason: 'advance_failed', error: 'CMS-Agent refused' }),
    });
    const result = await decide(getToken, RUN, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'partly_applied');
    assert.equal(result.activity?.reason, 'advance_failed');
  });
});

describe('cross-surface sync', () => {
  /**
   * The acceptance criterion for T3.2: a decision taken on ANY of the three
   * surfaces invalidates the one shared request index (T2.3's
   * `requests-store`), which the header pill and the runs inbox both
   * subscribe to — so the other surfaces update without a reload. This
   * asserts the façade routes every mechanism through that single path, and
   * only on success.
   */
  it('invalidates the one shared store after a successful decision, whichever mechanism it was', async () => {
    for (const target of [OBJECT, CHAT, RUN] as DecisionTarget[]) {
      const rec = recorder();
      await decide(getToken, target, 'approve', {}, rec.deps);
      assert.equal(rec.synced, 1, `${target.mechanism} did not invalidate the shared store`);
    }
  });

  it('never invalidates on a decision that did not happen', async () => {
    const rec = recorder();
    await decide(getToken, OBJECT, 'modify', {}, rec.deps);
    assert.equal(rec.synced, 0);
  });

  /**
   * The object DETAIL view (`ObjectWorkspace.tsx`) used to decide through
   * `EditSession.approveReview()`/`requestChanges()` directly. Same verb, but
   * a second path: it never touched the shared store, so approving there left
   * the header pill and the runs inbox stale until a reload — the one thing
   * the criterion above forbids. It now builds its target with
   * `objectReviewDecisionTarget` and hands it to `decide()`, and this asserts
   * THAT builder's output — not a hand-written stand-in — lands on the object
   * mechanism, the shared overlay and the single sync path.
   */
  it('routes the object detail view own target through the same single sync path', async () => {
    const target = objectReviewDecisionTarget({
      objectType: 'content_item',
      objectId: 'obj_1',
      displayName: 'Knee pain',
      contentRevision: 7,
      availability: { canApprove: true, canRequestChanges: true },
      lock: { held: false },
    });
    // Same key space as every other surface deciding this object — that is
    // what lets one overlay entry hide the row on all three at once.
    assert.equal(decisionKey(target), decisionKey(OBJECT));

    const approving = recorder();
    const approved = await decide(getToken, target, 'approve', {}, approving.deps);
    assert.equal(approved.ok, true);
    assert.equal(approved.effect, 'applied');
    assert.deepEqual(approving.calls, ['object:approve:no-note']);
    assert.equal(approving.synced, 1);
    assert.deepEqual(approving.overlay, [
      ['object_review:content_item:obj_1', 'begin:approve'],
      ['object_review:content_item:obj_1', 'confirm'],
    ]);
    // The target carries what the receipt needs, so the detail view's toast
    // says what changed rather than a bare "Approved".
    assert.match(approved.receipt, /Knee pain/);
    assert.match(approved.receipt, /revision 7/);

    const rejecting = recorder();
    const rejected = await decide(getToken, target, 'reject', { reason: '  needs a source  ' }, rejecting.deps);
    assert.equal(rejected.ok, true);
    // The reviewer's words reach the object store as `note` on the SAME verb.
    assert.deepEqual(rejecting.calls, ['object:request_changes:needs a source']);
    assert.equal(rejecting.synced, 1);
  });

  it('carries the detail view request link onto the target, so the overlay gets the request keying too', async () => {
    // `ObjectWorkspace` passes the request its object chat is bound to
    // (W19 T19.5, resolved server-side) — never an id munged out of
    // `object_id`, which wears the same `req_*` shape without always being a
    // request. The builder is where that link has to survive.
    const linked = objectReviewDecisionTarget({
      objectType: 'content_item',
      objectId: 'obj_1',
      availability: { canApprove: true, canRequestChanges: true },
      requestId: 'req_1',
    });
    assert.equal(linked.requestId, 'req_1');
    assert.deepEqual(decisionKeys(linked), ['object_review:content_item:obj_1', 'workflow_gate:request:req_1']);

    const rec = recorder();
    await decide(getToken, linked, 'approve', {}, rec.deps);
    assert.deepEqual(rec.alsoKeys, [['workflow_gate:request:req_1'], ['workflow_gate:request:req_1']]);

    // ...and a detail view with no binding still builds a target with none.
    const unlinked = objectReviewDecisionTarget({
      objectType: 'content_item',
      objectId: 'obj_1',
      availability: { canApprove: true, canRequestChanges: true },
    });
    assert.equal('requestId' in unlinked, false);
    assert.deepEqual(decisionKeys(unlinked), ['object_review:content_item:obj_1']);
  });

  it('refuses a decision the detail view renders disabled before it reaches a server or the store', async () => {
    // `resolveObjectControls` disables Approve and `reviewDecisionAvailability`
    // says why; the same availability rides on the target, so the façade's
    // pre-flight and the greyed-out button can never disagree.
    const target = objectReviewDecisionTarget({
      objectType: 'content_item',
      objectId: 'obj_1',
      availability: { canApprove: false, canRequestChanges: true },
    });
    const rec = recorder();
    const result = await decide(getToken, target, 'approve', {}, rec.deps);
    assert.equal(result.ok, false);
    assert.equal(result.code, 'not_permitted');
    assert.deepEqual(rec.calls, []);
    assert.deepEqual(rec.overlay, []);
    assert.equal(rec.synced, 0);
  });
});

/**
 * The defect T6.2 found and proved here — reported then, fixed now.
 *
 * `pendingDecisionForRequest` (`decision-overlay.ts`) is still the ONLY place
 * anything in the admin UI reads this overlay by request id —
 * `RequestsWorkspace`'s row and `NeedsYouMenu`'s pill and dropdown all call
 * it, and nothing reads `objectReviewKey`/`chatToolKey` entries at all. It
 * looks a decision up by `workflowGateKey({requestId})`. `decide()` on an
 * `ObjectReviewTarget` or a `ChatToolTarget` used to record its optimistic
 * entry ONLY under `objectReviewKey`/`chatToolKey`, because those two target
 * types had no `requestId` field to key on — so approving from the object
 * page or a chat card left the inbox row, the header pill and the needs-you
 * dropdown reading "needs you" until the sweeper caught up, up to five
 * minutes later, even though `sync()` really had invalidated the shared
 * store.
 *
 * The ruling was option A: give both targets an optional `requestId` and file
 * the decision under the request key TOO, as a second keying of the same
 * entry (`decisionKeys`). The alternative — teaching
 * `pendingDecisionForRequest` to probe all three key shapes — was rejected as
 * three reads per row plus mechanism knowledge in the row renderer.
 *
 * These are the same scenarios that used to assert the gap, now asserting
 * convergence — plus the two the fix's own failure modes demand: the
 * `requestId`-absent path still behaves exactly as it did, and neither a
 * rollback nor an expiry can clear one keying and leave the other holding a
 * row shut.
 */
describe('cross-surface sync — one decision, both keyings', () => {
  const ROW = { request_id: 'req_42', status: 'needs_you', object_id: 'obj_42', chat_id: 'chat_42' };
  const LINKED_OBJECT: ObjectReviewTarget = { ...OBJECT, requestId: ROW.request_id };
  const LINKED_CHAT: ChatToolTarget = { ...CHAT, requestId: ROW.request_id };

  /** begin → confirm on one target, the way `decide()` drives the reducer. */
  const decided = (target: DecisionTarget, atMs = 1) => {
    const [key, ...alsoKeys] = decisionKeys(target);
    return reduceDecisionOverlay(
      reduceDecisionOverlay(EMPTY_DECISION_OVERLAY, {
        type: 'begin',
        key,
        decision: 'approve',
        atMs,
        alsoKeys,
      }),
      { type: 'confirm', key, atMs: atMs + 1, alsoKeys }
    );
  };

  it('an object-review approval now hides the row it belongs to, exactly as a workflow-gate one does', () => {
    const overlay = decided(LINKED_OBJECT);
    // Still recorded under its own mechanism's key, for the surface that made it...
    assert.equal(overlay[decisionKey(LINKED_OBJECT)]?.phase, 'confirmed');
    // ...and now findable by the row's own request id, which is the only
    // lookup the inbox, the pill and the dropdown have.
    assert.equal(pendingDecisionForRequest(overlay, ROW.request_id)?.decision, 'approve');
    assert.deepEqual(rowsStillNeedingDecision([ROW], overlay), []);
  });

  it('a chat-tool approval converges the same way', () => {
    const overlay = decided(LINKED_CHAT);
    assert.equal(overlay[decisionKey(LINKED_CHAT)]?.phase, 'confirmed');
    assert.equal(pendingDecisionForRequest(overlay, ROW.request_id)?.decision, 'approve');
    assert.deepEqual(rowsStillNeedingDecision([ROW], overlay), []);
  });

  it('both keyings are ONE entry, not two that could drift apart', () => {
    const overlay = decided(LINKED_OBJECT);
    assert.equal(
      overlay[decisionKey(LINKED_OBJECT)],
      overlay[decisionKey({ mechanism: 'workflow_gate', requestId: ROW.request_id })],
      'the alias must be the same entry object, not a copy'
    );
  });

  it('with no request id the behaviour is exactly what it was — one key, and the row is untouched', () => {
    const overlay = decided(OBJECT);
    assert.equal(overlay[decisionKey(OBJECT)]?.phase, 'confirmed');
    assert.equal(Object.keys(overlay).length, 1, 'no alias, no phantom key');
    // The row genuinely IS still undecided as far as this browser knows —
    // nothing linked it to this object — so it must keep asking for a human.
    assert.equal(pendingDecisionForRequest(overlay, ROW.request_id), undefined);
    assert.deepEqual(rowsStillNeedingDecision([ROW], overlay), [ROW]);
  });

  it('rollback clears BOTH keyings — a failed decision can never leave a row stuck as decided', () => {
    const [key, ...alsoKeys] = decisionKeys(LINKED_OBJECT);
    const pending = reduceDecisionOverlay(EMPTY_DECISION_OVERLAY, {
      type: 'begin',
      key,
      decision: 'approve',
      atMs: 1,
      alsoKeys,
    });
    assert.equal(pendingDecisionForRequest(pending, ROW.request_id)?.phase, 'pending');

    const rolledBack = reduceDecisionOverlay(pending, { type: 'rollback', key });
    assert.deepEqual(rolledBack, {}, 'rollback must leave nothing behind under either key');
    assert.equal(pendingDecisionForRequest(rolledBack, ROW.request_id), undefined);
    assert.deepEqual(rowsStillNeedingDecision([ROW], rolledBack), [ROW]);
  });

  it('a rollback addressed by the ALIAS key clears the primary too', () => {
    // Nothing calls it this way today, but a removal that only worked from
    // one direction would be exactly the desync this design rules out.
    const overlay = decided(LINKED_CHAT);
    const aliasKey = decisionKey({ mechanism: 'workflow_gate', requestId: ROW.request_id });
    assert.deepEqual(reduceDecisionOverlay(overlay, { type: 'rollback', key: aliasKey }), {});
  });

  it('expiry clears both keyings, so a decision the server silently dropped resurfaces the row', () => {
    const overlay = decided(LINKED_OBJECT, 1_000);
    const swept = reduceDecisionOverlay(overlay, { type: 'expire', nowMs: 1_001 + DECISION_OVERLAY_TTL_MS });
    assert.deepEqual(swept, {}, 'both keys expire together — they share one atMs on one entry');
    assert.equal(pendingDecisionForRequest(swept, ROW.request_id), undefined);
    assert.deepEqual(rowsStillNeedingDecision([ROW], swept), [ROW]);
  });

  it('a snapshot that still lists the row keeps the decision; one that drops it clears both keys', () => {
    const overlay = decided(LINKED_OBJECT);
    // The server has NOT caught up — `openDecisionKeys` still names this row.
    const stillOpen = reduceDecisionOverlay(overlay, {
      type: 'reconcile',
      keys: [decisionKey({ mechanism: 'workflow_gate', requestId: ROW.request_id })],
    });
    assert.equal(
      pendingDecisionForRequest(stillOpen, ROW.request_id)?.phase,
      'confirmed',
      'the whole point: the row stays hidden until the server agrees, not just for one tick'
    );
    assert.equal(stillOpen[decisionKey(LINKED_OBJECT)]?.phase, 'confirmed', 'and the primary key survives with it');

    // The next snapshot no longer lists it — the sweeper caught up.
    const caughtUp = reduceDecisionOverlay(stillOpen, { type: 'reconcile', keys: [] });
    assert.deepEqual(caughtUp, {});
  });

  it('two mechanisms racing for the same request never leave a half-keyed entry behind', () => {
    // Both an object review and a chat tool call bound to the same request,
    // decided one after the other in the same browser. The second takes the
    // request keying; the first must be dropped WHOLE, never left with its
    // own key pointing at a decision whose alias now belongs to someone else.
    const first = decided(LINKED_OBJECT, 1);
    const [chatKey, ...chatAliases] = decisionKeys(LINKED_CHAT);
    const second = reduceDecisionOverlay(first, {
      type: 'begin',
      key: chatKey,
      decision: 'reject',
      atMs: 10,
      alsoKeys: chatAliases,
    });
    assert.equal(second[decisionKey(LINKED_OBJECT)], undefined, 'the superseded decision is gone entirely');
    assert.equal(pendingDecisionForRequest(second, ROW.request_id)?.decision, 'reject');
    // ...and rolling the survivor back leaves nothing at all.
    assert.deepEqual(reduceDecisionOverlay(second, { type: 'rollback', key: chatKey }), {});
  });

  it('drives all of that through decide(), which hands the alias to begin and settle alike', async () => {
    const approving = recorder();
    const approved = await decide(getToken, LINKED_OBJECT, 'approve', {}, approving.deps);
    assert.equal(approved.ok, true);
    assert.deepEqual(approving.overlay, [
      ['object_review:content_item:obj_1', 'begin:approve'],
      ['object_review:content_item:obj_1', 'confirm'],
    ]);
    assert.deepEqual(approving.alsoKeys, [['workflow_gate:request:req_42'], ['workflow_gate:request:req_42']]);

    // A refusal settles with the alias too, so the rollback reaches it.
    const refusing = recorder({ approveTool: async () => ({ approved: false, executing: false }) });
    const refused = await decide(getToken, LINKED_CHAT, 'approve', {}, refusing.deps);
    assert.equal(refused.ok, false);
    assert.deepEqual(refusing.overlay.at(-1), ['chat_tool:chat_1:call_1', 'rollback']);
    assert.deepEqual(refusing.alsoKeys.at(-1), ['workflow_gate:request:req_42']);

    // ...and a target with no link hands over no alias at all.
    const unlinked = recorder();
    await decide(getToken, OBJECT, 'approve', {}, unlinked.deps);
    assert.deepEqual(unlinked.alsoKeys, [[], []]);
  });
});

describe('the receipt', () => {
  it('says what was decided AND what changed, per mechanism', () => {
    assert.match(describeDecision(OBJECT, 'approve'), /publishing is unblocked/);
    assert.match(describeDecision(OBJECT, 'reject'), /back to the editor/);
    // Never claims the tool succeeded — execution is asynchronous.
    assert.match(describeDecision(CHAT, 'approve'), /running object_publish now/);
    assert.match(describeDecision(CHAT, 'modify'), /edited arguments/);
    assert.match(describeDecision(RUN, 'approve'), /recorded and the run is advancing/);
    assert.match(describeDecision(RUN, 'reject'), /stays held/);
  });

  it('names the object by its display name when a surface has one', () => {
    assert.match(describeDecision({ ...OBJECT, displayName: 'Knee pain' }, 'approve'), /Knee pain/);
  });

  it('names the revision the approval is pinned to, so a stale approval is legible', () => {
    assert.match(describeDecision({ ...OBJECT, reviewRevision: 7 }, 'approve'), /unblocked for revision 7/);
    assert.match(describeDecision(OBJECT, 'approve'), /unblocked for this revision/);
  });

  it('carries the lock context into a reject — the editor cannot start until it is released', () => {
    const held = describeDecision({ ...OBJECT, lock: { held: true, ownerLabel: 'Writer agent' } }, 'reject');
    assert.match(held, /still held by Writer agent/);
    assert.doesNotMatch(describeDecision(OBJECT, 'reject'), /still held/);
  });

  it('names the gate node a run is held at when the surface knows it', () => {
    assert.match(
      describeDecision({ ...RUN, gateNodeId: 'publication_controller' }, 'approve'),
      /publication_controller/
    );
  });
});

describe('assertDecided — the ActionRow adapter', () => {
  it('passes a good result through and throws the server sentence on a bad one', async () => {
    const rec = recorder();
    const good = await decide(getToken, RUN, 'approve', {}, rec.deps);
    assert.equal(assertDecided(good), good);
    const bad = await decide(getToken, OBJECT, 'modify', {}, rec.deps);
    assert.throws(() => assertDecided(bad), /two review decisions/);
  });
});
