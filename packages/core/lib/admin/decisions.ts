/**
 * T3.2 — the one CLIENT-SIDE decision façade (design decision D3).
 *
 * ## Why a façade and not a merged endpoint
 *
 * T0.1 §6 found three structurally separate approval mechanisms, and the
 * 2026-08-25 "one approval truth" ADR rules that two of them
 * (`approval-policy.ts` for the object store, `publishing-policy.ts` for the
 * chat agent) are *deliberately* separate — "two different fields answering
 * two different questions for two different surfaces". The third (the
 * CMS-Agent workflow publish-risk gate) is a third question on a third
 * surface, which that ADR does not mention (T0.1 §6.5). Merging any of them
 * server-side is a decision Wolf already made the other way, so this module
 * does not touch a backend: it gives the UI ONE button vocabulary, ONE
 * optimistic-update path and ONE receipt over three unchanged mechanisms.
 *
 * ## Where the abstraction leaks — read `decisionAvailability` before using it
 *
 * The three mechanisms do NOT have the same shape, and this module refuses to
 * pretend otherwise. `decisionAvailability(target)` is the honest table:
 *
 * | | Approve | Reject | Modify | a typed reason reaches the server |
 * |---|---|---|---|---|
 * | object review | `review_decide:approve` | `review_decide:request_changes` | **no such verb** | yes (`note`) |
 * | chat tool call | `approve_tool` | `deny_tool` | `approve_tool` + `edited_args` | reject only |
 * | workflow gate | `action:'approve'` | `action:'withhold'` | **no such action** | **never** |
 *
 * Two further asymmetries no signature can hide, carried on `DecisionResult`
 * as `effect` rather than papered over:
 *
 * - An object review decision is **applied** on the response — the review
 *   state changed and the body says so.
 * - A chat approval is only **recorded**: execution is asynchronous and the
 *   tool's success or failure arrives later as a `tool_result` event
 *   (`chat-client.ts`'s own comment). The receipt can say what was decided;
 *   it cannot yet say what the tool did.
 * - A workflow approve is TWO server facts (record the durable operator
 *   decision, then advance the run) and the second half may fail while the
 *   first half stands — the endpoint reports that in `error` while still
 *   returning 200, which this module preserves rather than flattening.
 *
 * ## W19
 *
 * A decision records a DECISION. Nothing here writes a request's
 * `running`/`stalled`/`failed`/`done` status — only the sweeper does. The
 * optimistic layer (`./decision-overlay.ts`) is client-only and reconciles
 * from the server's derived status on the next snapshot.
 */
import { callObjectVerb, type GetToken, type VerbResult } from '../edit-mode/verbs-client.js';
import { approveTool, denyTool } from './chat-client.js';
import { decideRunPublish, type ActivityResponse } from './requests-client.js';
import type { ReviewerActionAvailability } from './object-review-ui.js';
import {
  chatToolKey,
  objectReviewKey,
  workflowGateKey,
  type DecisionAction,
  type DecisionOverlayEntry,
} from './decision-overlay.js';

export type { DecisionAction, DecisionOverlayEntry };

// ─── targets ────────────────────────────────────────────────────────────────

/**
 * Object review (`object_review_decide`, T0.1 §6.1).
 *
 * There is no review *id* in the record model: a review is identified by the
 * `content_revision` its decisions pin to (D§3.9 — deliberately not
 * `version`, which lock ops and the publish stamp bump). `reviewRevision` is
 * therefore this variant's "review id", carried so a caller can tell a
 * decision on the revision it looked at from one on a revision that moved
 * underneath it.
 *
 * `lock` is context, not a parameter: `review_decide` takes no lock token, but
 * an agent lock held on the object is the thing that stops the *editor* work
 * a `reject` asks for, so the surface offering Reject needs it to say
 * something true afterwards.
 */
export interface ObjectReviewTarget {
  mechanism: 'object_review';
  objectType: string;
  objectId: string;
  displayName?: string;
  reviewRevision?: number;
  lock?: { held: boolean; ownerLabel?: string };
  /** Display-only availability from `object-review-ui.ts` — finally gives `canRequestChanges` a consumer. */
  availability?: Pick<ReviewerActionAvailability, 'canApprove' | 'canRequestChanges'>;
  /**
   * The editorial request this object's review belongs to, when the surface
   * genuinely knows it — see `decisionKeys` for what it buys.
   *
   * Deliberately NOT derived from `objectId`. A `content_item` id keeps the
   * `req_*` request-id shape (`object-ids.ts`), so the two LOOK
   * interchangeable, but `mintId` also mints `req_agent_<topic>_<date>_01`
   * ids for content items that no editorial request ever produced. Treating
   * the object id as a request id would file a phantom key for those. The
   * link is a server fact (`recordObject` / `requestRowForChat`) or it is
   * absent.
   */
  requestId?: string;
}

/** One pending tool call in one admin chat (`approve_tool`/`deny_tool`, T0.1 §6.2). */
export interface ChatToolTarget {
  mechanism: 'chat_tool';
  chatId: string;
  callId: string;
  /** The tool's name, for the receipt only. */
  tool?: string;
  /**
   * The editorial request this conversation is bound to, when the server has
   * resolved one (W19 T19.5: "chats attach to it rather than owning it" —
   * `requestRowForChat`, surfaced on `get_chat` as `request.request_id`).
   * Absent on a free chat that has not registered a job. See `decisionKeys`.
   */
  requestId?: string;
}

/**
 * A CMS-Agent workflow run held at its publish-risk gate (T0.1 §6.3).
 * Addressed by run id when one is known and request id otherwise — the same
 * either-or `admin-request-activity` accepts.
 */
export interface WorkflowGateTarget {
  mechanism: 'workflow_gate';
  requestId?: string;
  runId?: string;
  /** The gate node the run is held at, for the receipt only. */
  gateNodeId?: string;
  /**
   * The server's `can_approve` for this viewer when the surface already has
   * it (the activity response carries it). A surface that does not — an inbox
   * row, the header pill — passes `undefined` and gates on the display-only
   * role mirror instead; the endpoint re-checks either way.
   */
  canApprove?: boolean;
}

export type DecisionTarget = ObjectReviewTarget | ChatToolTarget | WorkflowGateTarget;

export const decisionKey = (target: DecisionTarget): string => {
  switch (target.mechanism) {
    case 'object_review':
      return objectReviewKey(target.objectType, target.objectId);
    case 'chat_tool':
      return chatToolKey(target.chatId, target.callId);
    case 'workflow_gate':
      return workflowGateKey(target);
  }
};

/**
 * Every key ONE decision on this target must answer to: its own key first,
 * then the request key when the surface knew which request it belongs to.
 *
 * ## The gap this closes
 *
 * `pendingDecisionForRequest` is the only way anything inbox-shaped reads the
 * overlay — `RequestsWorkspace`'s row and both of `NeedsYouMenu`'s reads call
 * it, and nothing anywhere looks up an `object_review:`/`chat_tool:` key. It
 * reads `workflow_gate:request:<id>`. An object-review or chat-tool decision
 * therefore used to record itself somewhere no row would ever look, so
 * approving from the object page or a chat card left the inbox row, the
 * header pill and the needs-you dropdown reading "needs you" until the
 * sweeper caught up — up to five minutes — even though the shared store WAS
 * invalidated. Filing the same decision under the request key too is what
 * makes `DecisionDeps.sync`'s own promise ("a chat tool approval and an
 * object review both move rows the header pill and the inbox are counting")
 * true in the tick the decision lands.
 *
 * The alternative — teaching `pendingDecisionForRequest` to try all three key
 * shapes — was rejected: it turns one map read per row into three and spreads
 * knowledge of every mechanism into the row renderer.
 *
 * A run gate that carries BOTH ids gets the same treatment, for the same
 * reason: `workflowGateKey` prefers the run key, which no inbox row looks up.
 *
 * Where no request id is known this returns exactly `[decisionKey(target)]`
 * and behaviour is unchanged — no phantom key, no second entry.
 */
export const decisionKeys = (target: DecisionTarget): readonly string[] => {
  const primary = decisionKey(target);
  if (!target.requestId) return [primary];
  const requestKey = workflowGateKey({ requestId: target.requestId });
  return requestKey === primary ? [primary] : [primary, requestKey];
};

// ─── availability ───────────────────────────────────────────────────────────

export interface DecisionAvailability {
  approve: boolean;
  reject: boolean;
  modify: boolean;
  /** Whether a reason typed into `ActionRow`'s textarea actually reaches the server for that action. */
  reasonReaches: Record<DecisionAction, boolean>;
  /**
   * Set when this mechanism has NO field for the reviewer's words at all, so
   * a surface can decline to open a textarea nobody will ever read rather
   * than collecting text it is about to drop on the floor.
   */
  reasonDroppedNote?: string;
  /** Why an unavailable action is unavailable — rendered as the button's `title`, never swallowed. */
  unavailableReason: Partial<Record<DecisionAction, string>>;
}

const NO_MODIFY_OBJECT_REVIEW =
  'The object store records exactly two review decisions — approve and request changes. Modify would have to invent a verb.';
const NO_MODIFY_WORKFLOW =
  'The workflow publish gate records approve or withhold only. There is nothing to edit before it runs.';
const REASON_DROPPED_WORKFLOW =
  'The publish-gate endpoint takes a decision and nothing else — a note typed here would not reach anyone.';

/**
 * The leak table, executable. Every surface reads this instead of hardcoding
 * which of the three buttons it happens to know its mechanism supports, so a
 * button that cannot work is never rendered as if it could.
 */
export function decisionAvailability(target: DecisionTarget): DecisionAvailability {
  switch (target.mechanism) {
    case 'object_review':
      return {
        approve: target.availability?.canApprove ?? true,
        reject: target.availability?.canRequestChanges ?? true,
        modify: false,
        reasonReaches: { approve: true, reject: true, modify: false },
        unavailableReason: { modify: NO_MODIFY_OBJECT_REVIEW },
      };
    case 'chat_tool':
      return {
        approve: true,
        reject: true,
        modify: true,
        // `approve_tool` has a `call_id` and optional `edited_args`, no reason
        // field; `deny_tool` is the only one of the three that carries text.
        reasonReaches: { approve: false, reject: true, modify: false },
        unavailableReason: {},
      };
    case 'workflow_gate':
      return {
        approve: target.canApprove ?? true,
        reject: target.canApprove ?? true,
        modify: false,
        reasonReaches: { approve: false, reject: false, modify: false },
        reasonDroppedNote: REASON_DROPPED_WORKFLOW,
        unavailableReason: {
          modify: NO_MODIFY_WORKFLOW,
          ...(target.canApprove === false
            ? {
                approve: 'You do not have publish-decision authority for this run.',
                reject: 'You do not have publish-decision authority for this run.',
              }
            : {}),
        },
      };
  }
}

/**
 * Display-only mirror of `admin-request-activity.ts`'s own permission line
 * (`can_approve: callerRoles.includes('admin')`), for the two surfaces that
 * render a run gate without having fetched the activity — the inbox row and
 * the header pill. Same posture as `verbs-client.ts`'s `canExecutePublish`:
 * a bug here shows a button the server then refuses; it can never grant one.
 */
export const canDecideRunPublish = (roles: readonly string[] | undefined): boolean => Boolean(roles?.includes('admin'));

// ─── results ────────────────────────────────────────────────────────────────

/**
 * How far the decision actually got. The three mechanisms genuinely differ
 * here and the receipt must not claim more than happened.
 */
export type DecisionEffect =
  /** The state the decision governs has already changed (object review). */
  | 'applied'
  /** The decision is durable; the work it unblocks is happening elsewhere, asynchronously. */
  | 'executing'
  /** The decision is durable and nothing else was meant to happen yet. */
  | 'recorded';

export type DecisionFailure =
  | 'unsupported_decision'
  | 'not_permitted'
  | 'rejected_by_server'
  | 'partly_applied'
  | 'transport';

export interface DecisionResult {
  ok: boolean;
  target: DecisionTarget;
  decision: DecisionAction;
  effect: DecisionEffect;
  /** One sentence: what was decided, and what changed because of it. */
  receipt: string;
  code?: DecisionFailure;
  error?: string;
  /** The workflow variant's refreshed activity, so a caller need not re-poll to redraw. */
  activity?: ActivityResponse;
  /** The object variant's new review state, when the server reported one. */
  reviewState?: string;
}

const targetNoun = (target: DecisionTarget): string => {
  switch (target.mechanism) {
    case 'object_review':
      return target.displayName ?? target.objectId;
    case 'chat_tool':
      return target.tool ?? 'the proposed action';
    case 'workflow_gate':
      return 'this run';
  }
};

/**
 * The receipt. One vocabulary (Approve/Reject/Modify) across three
 * mechanisms, but never one sentence — each says what actually changed,
 * which is the half a shared vocabulary would otherwise flatten away.
 */
export function describeDecision(target: DecisionTarget, decision: DecisionAction): string {
  const noun = targetNoun(target);
  switch (target.mechanism) {
    case 'object_review': {
      // The approval is pinned to the revision it was made on (D§3.9), so the
      // receipt names it when the surface knew it — an approval that silently
      // stops applying after the next edit is exactly what that pin prevents.
      const revision = target.reviewRevision === undefined ? 'this revision' : `revision ${target.reviewRevision}`;
      if (decision === 'approve') {
        return `Approved — the review on ${noun} is approved and publishing is unblocked for ${revision}.`;
      }
      // The lock is context, not a parameter: a reject asks the editor to do
      // work they cannot start while an agent still holds the object.
      const held = target.lock?.held
        ? ` The edit lock is still held by ${target.lock.ownerLabel ?? 'someone else'} — they have to release it first.`
        : '';
      return `Rejected — changes are requested on ${noun}; it goes back to the editor before it can be approved.${held}`;
    }
    case 'chat_tool':
      return decision === 'approve'
        ? `Approved — the agent is running ${noun} now; its result arrives in the transcript.`
        : decision === 'modify'
          ? `Modified — the agent is running ${noun} with your edited arguments.`
          : `Rejected — the agent was told not to run ${noun}.`;
    case 'workflow_gate': {
      const step = target.gateNodeId ? ` (${target.gateNodeId})` : '';
      return decision === 'approve'
        ? `Approved — the publish decision is recorded and the run is advancing past its publish-risk step${step}.`
        : `Rejected — the publish veto is recorded; every publish-risk step${step} on this run stays held until the decision is replaced.`;
    }
  }
}

const failure = (
  target: DecisionTarget,
  decision: DecisionAction,
  code: DecisionFailure,
  error: string
): DecisionResult => ({
  ok: false,
  target,
  decision,
  effect: 'recorded',
  receipt: error,
  code,
  error,
});

// ─── dispatch ───────────────────────────────────────────────────────────────

export interface DecisionOptions {
  /** Reject/Modify's typed reason. Reaches the server only where `reasonReaches` says so. */
  reason?: string;
  /** Chat `modify` only — the edited tool arguments. */
  editedArgs?: Record<string, unknown>;
  /** Object review only — pins the publish action the approval authorises (M-6). Defaults to immediate. */
  publishedTime?: string;
}

/**
 * Everything `decide` touches that is not a pure function, injected so the
 * dispatch table is testable without a `fetch` or a React tree. The default
 * bindings are the real client calls and the real shared store.
 */
export interface DecisionDeps {
  objectVerb: typeof callObjectVerb;
  approveTool: typeof approveTool;
  denyTool: typeof denyTool;
  decideRunPublish: typeof decideRunPublish;
  /**
   * Optimistic: called before the request goes out. `alsoKeys` are the extra
   * keys the same decision must answer to (`decisionKeys`); they are one
   * group with `key`, written and dropped together.
   */
  begin: (key: string, decision: DecisionAction, alsoKeys?: readonly string[]) => void;
  /**
   * Optimistic: `ok` keeps the entry until a snapshot agrees; a failure rolls
   * it back at once. Rollback clears the whole group — an alias that outlived
   * its decision would leave an inbox row stuck reading "already decided",
   * which is worse than the gap this alias exists to close.
   */
  settle: (key: string, ok: boolean, alsoKeys?: readonly string[]) => void;
  /**
   * Cross-surface sync — the ONE invalidation path (T2.3's shared
   * `requests-store`), never a second mechanism. Every mechanism calls it:
   * a chat tool approval and an object review both move rows the header
   * pill and the inbox are counting.
   */
  sync: (getToken: GetToken) => void;
}

/* c8 ignore start — thin bindings to modules with their own tests */
const storeModule = () => import('./requests-store.js');

export const defaultDecisionDeps: DecisionDeps = {
  objectVerb: callObjectVerb,
  approveTool,
  denyTool,
  decideRunPublish,
  begin: (key, decision, alsoKeys) => void storeModule().then((m) => m.beginDecisionOverlay(key, decision, alsoKeys)),
  settle: (key, ok, alsoKeys) => void storeModule().then((m) => m.settleDecisionOverlay(key, ok, alsoKeys)),
  sync: (getToken) => void storeModule().then((m) => m.refreshRequestsIndexNow(getToken)),
};
/* c8 ignore stop */

const verbError = (result: VerbResult): string =>
  (typeof result.body.error === 'string' && result.body.error) || `The server refused the decision (${result.status}).`;

/**
 * The one entry point. Dispatches on the target's variant to the mechanism
 * that owns it, normalises success and failure into `DecisionResult`, and
 * drives the optimistic overlay + the shared-store invalidation around it.
 *
 * Never throws: a caller that wants `ActionRow`'s toast-on-rejection
 * behaviour passes the result through `assertDecided`.
 */
export async function decide(
  getToken: GetToken,
  target: DecisionTarget,
  decision: DecisionAction,
  options: DecisionOptions = {},
  deps: DecisionDeps = defaultDecisionDeps
): Promise<DecisionResult> {
  const availability = decisionAvailability(target);
  if (!availability[decision]) {
    // Refused before anything goes out — an unsupported action must never
    // reach a server that would silently do something adjacent instead.
    // `modify` is unavailable because the mechanism has no such verb;
    // approve/reject are unavailable only because this viewer may not.
    return failure(
      target,
      decision,
      decision === 'modify' ? 'unsupported_decision' : 'not_permitted',
      availability.unavailableReason[decision] ?? `${decision} is not available for this decision.`
    );
  }

  const [key, ...alsoKeys] = decisionKeys(target);
  const reason = options.reason?.trim() || undefined;
  deps.begin(key, decision, alsoKeys);

  try {
    const result = await dispatch(getToken, target, decision, { ...options, reason }, deps);
    deps.settle(key, result.ok, alsoKeys);
    if (result.ok) deps.sync(getToken);
    return result;
  } catch (error) {
    deps.settle(key, false, alsoKeys);
    return failure(
      target,
      decision,
      'transport',
      error instanceof Error ? error.message : 'The decision could not be sent.'
    );
  }
}

async function dispatch(
  getToken: GetToken,
  target: DecisionTarget,
  decision: DecisionAction,
  options: DecisionOptions,
  deps: DecisionDeps
): Promise<DecisionResult> {
  const receipt = describeDecision(target, decision);

  switch (target.mechanism) {
    case 'object_review': {
      const result = await deps.objectVerb(getToken, {
        action: 'review_decide',
        object_type: target.objectType,
        object_id: target.objectId,
        decision: decision === 'approve' ? 'approve' : 'request_changes',
        ...(options.reason ? { note: options.reason } : {}),
        // M-6: an approval pins the publish action it authorises. Ignored by
        // the gate on request_changes, so it is only sent with an approve.
        ...(decision === 'approve' ? { publish_action: { published_time: options.publishedTime ?? 'immediate' } } : {}),
      });
      if (result.status !== 200) {
        return failure(
          target,
          decision,
          result.status === 403 ? 'not_permitted' : 'rejected_by_server',
          verbError(result)
        );
      }
      return {
        ok: true,
        target,
        decision,
        // The review state changed on this response — the one mechanism of
        // the three whose effect is already true when the promise resolves.
        effect: 'applied',
        receipt,
        ...(typeof result.body.review_state === 'string' ? { reviewState: result.body.review_state } : {}),
      };
    }

    case 'chat_tool': {
      if (decision === 'reject') {
        const denied = await deps.denyTool(getToken, target.chatId, target.callId, options.reason);
        if (!denied.denied) {
          return failure(target, decision, 'rejected_by_server', 'The chat did not record the rejection.');
        }
        return { ok: true, target, decision, effect: 'recorded', receipt };
      }
      const approved = await deps.approveTool(
        getToken,
        target.chatId,
        target.callId,
        decision === 'modify' ? options.editedArgs : undefined
      );
      if (!approved.approved) {
        // The server did not consume it — most often because the same call
        // was already decided somewhere else. Not a transport failure, and
        // the caller must be able to tell the difference (chat.tsx releases
        // its call_id claim on exactly this).
        return failure(target, decision, 'rejected_by_server', 'That tool call was already decided.');
      }
      return {
        ok: true,
        target,
        decision,
        // Recorded, then executed asynchronously — the tool's own result
        // arrives later as a `tool_result` event, never on this response.
        effect: approved.executing ? 'executing' : 'recorded',
        receipt,
      };
    }

    case 'workflow_gate': {
      const activity = await deps.decideRunPublish(
        getToken,
        {
          ...(target.requestId ? { request_id: target.requestId } : {}),
          ...(target.runId ? { run_id: target.runId } : {}),
        },
        decision === 'approve' ? 'approve' : 'withhold'
      );
      if (activity.error) {
        // 200 with an `error` is this endpoint's way of saying "half of it
        // happened" (the durable decision stands, the advance did not).
        // Preserved verbatim — "which half did not happen" is the whole
        // question when a publish stalls.
        return { ...failure(target, decision, 'partly_applied', activity.error), activity };
      }
      return {
        ok: true,
        target,
        decision,
        effect: decision === 'approve' ? 'executing' : 'recorded',
        receipt,
        activity,
      };
    }
  }
}

/**
 * Adapter for `<ActionRow>`, whose contract is a promise that REJECTS on
 * failure (it catches and toasts). Keeps the normalised result available to
 * callers that want it while giving the kit the shape it expects.
 */
export function assertDecided(result: DecisionResult): DecisionResult {
  if (!result.ok) throw new Error(result.error ?? 'The decision could not be recorded.');
  return result;
}
