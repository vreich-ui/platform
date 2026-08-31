/**
 * T1.2 — pure logic behind `<ActionRow>` and `<RunProgress>`
 * (`@core/admin/approval`).
 *
 * This repo has no component-test infrastructure (T1.2's brief is explicit
 * that this task does not introduce one), so anything worth asserting on is
 * extracted here as plain functions the components consume, mirroring the
 * house pattern `RequestActivity.tsx` already uses for `progressPercent` /
 * `activityProgressPhrase` (`packages/core/lib/admin/*.ts` + a sibling
 * `.test.ts`, `packages/core/admin/*.tsx` left thin).
 *
 * Vocabulary ruling for this task (T1.2 brief): the three decision actions
 * are named **Approve**, **Reject**, **Modify** — not "Decline"/"Deny" or
 * "Hold" or "Ask for changes" (see `docs/plan/ux-inventory.md` Table C,
 * "Decision-reject/decision-modify button"). Existing call sites are not
 * renamed by this task (that's T3.2/T6.1); only this new vocabulary is.
 */

// ─── ActionRow: pending + reason-capture state machine ────────────────────

export type DecisionKey = 'approve' | 'reject' | 'modify';

/**
 * Reject/Modify may or may not require typed text before Confirm enables — the
 * chat.tsx Decline→reason→Deny pattern this mirrors treats it as optional.
 *
 * T3.2 added `'none'`: some mechanisms have NO field for the reviewer's words
 * at all (the workflow publish gate's whole request body is
 * `{request_id|run_id, action}` — see `decisions.ts`'s `reasonDroppedNote`).
 * Opening a textarea there would collect text the client is about to drop on
 * the floor, so the row skips the swap and decides on the first click.
 */
export type ReasonRequirement = 'required' | 'optional' | 'none';

export interface ActionRowState {
  /** Set while the row has swapped to the in-place capture textarea (this
   * unified chat.tsx's `denying`/`editing` local state into one field —
   * Reject and Modify use the identical swap). */
  reasonFor?: 'reject' | 'modify';
  reasonDraft: string;
  /** The action whose promise is currently in flight, if any. */
  pending?: DecisionKey;
  /**
   * A7: set when the capture's own `validate` refused the draft. The row
   * STAYS in capture with the typed text intact and shows this on the
   * textarea — the chat's Modify capture is the tool's arguments as JSON,
   * and a stray comma must not throw away what the human just edited (the
   * legacy chat.tsx card kept a `draftError` in component state for exactly
   * this; the state machine owns it now so it is testable).
   */
  draftError?: string;
}

export const INITIAL_ACTION_ROW_STATE: ActionRowState = { reasonDraft: '' };

export type ActionRowEvent =
  /** `draft` prefills the capture — A7's Modify opens on the current arguments, not on an empty box. */
  | { type: 'request_reason'; action: 'reject' | 'modify'; draft?: string }
  | { type: 'edit_reason'; text: string }
  | { type: 'cancel_reason' }
  /** The capture's `validate` refused the draft: keep it, explain why. */
  | { type: 'refuse_draft'; message: string }
  | { type: 'begin'; action: DecisionKey }
  | { type: 'settle' };

/** Drops a stale refusal without leaving an `undefined`-valued key behind. */
const withoutDraftError = (state: ActionRowState): ActionRowState => {
  if (state.draftError === undefined) return state;
  const next = { ...state };
  delete next.draftError;
  return next;
};

/**
 * `settle` is the only event that can change anything once a decision is
 * pending — a callback that is still in flight cannot be pre-empted by a
 * second click, a reason edit, or a cancel. This is what makes "all three
 * disabled while one is running" true of the state itself, not just of the
 * buttons' rendered `disabled` attribute.
 */
export function reduceActionRow(state: ActionRowState, event: ActionRowEvent): ActionRowState {
  if (state.pending !== undefined && event.type !== 'settle') return state;
  switch (event.type) {
    case 'request_reason':
      // Built fresh rather than spread: `pending` is undefined here (the
      // guard above), so a rebuild cannot lose anything and cannot carry a
      // previous refusal's message into a newly opened capture.
      return { reasonFor: event.action, reasonDraft: event.draft ?? '' };
    case 'edit_reason':
      return withoutDraftError({ ...state, reasonDraft: event.text });
    case 'cancel_reason':
      return { reasonDraft: '' };
    case 'refuse_draft':
      return { ...state, draftError: event.message };
    case 'begin':
      return withoutDraftError({ ...state, pending: event.action });
    case 'settle':
      // A settle (success or a caught rejection) always returns to full rest —
      // there is no state a stuck spinner or a stale reason draft can survive in.
      return { reasonDraft: '' };
  }
}

export const isActionRowBusy = (state: ActionRowState): boolean => state.pending !== undefined;

/** Whether the Confirm button in the reason-capture swap may be pressed. */
export const canConfirmReason = (state: ActionRowState, requirement: ReasonRequirement): boolean =>
  requirement !== 'required' || state.reasonDraft.trim().length > 0;

/**
 * Whether pressing Reject/Modify should swap the row for a textarea at all.
 * `'none'` decides on the click — one press, no dead-end prompt for words the
 * mechanism cannot carry.
 */
export const needsReasonCapture = (requirement: ReasonRequirement): boolean => requirement !== 'none';

/**
 * The decision action set, in row order. A7 made this an exported list
 * rather than three keys implied by `DECISION_LABEL`'s shape, so the
 * vocabulary invariant ("exactly approve | reject | modify, and the middle
 * one is called **Reject**") can be asserted against one source of truth
 * instead of restated per surface. `decision-overlay.ts`'s `DecisionAction`
 * is the same three words for the wire/optimistic layer; this is the button
 * row's own ordering.
 */
export const DECISION_KEYS: readonly DecisionKey[] = ['approve', 'reject', 'modify'];

export const DECISION_LABEL: Record<DecisionKey, string> = {
  approve: 'Approve',
  reject: 'Reject',
  modify: 'Modify',
};

/** In-flight button copy, e.g. "Rejecting…" — used for the busy button's label. */
export const DECISION_PENDING_LABEL: Record<DecisionKey, string> = {
  approve: 'Approving…',
  reject: 'Rejecting…',
  modify: 'Modifying…',
};

/** Toast title on a rejected decision promise. */
export const decisionFailedTitle = (key: DecisionKey): string => `${DECISION_LABEL[key]} failed`;

// ─── RunProgress: step/percent formatting ──────────────────────────────────

/**
 * Whole-percent complete, clamped 0-100. Deliberately reimplemented rather
 * than importing `RequestActivity.tsx`'s `progressPercent` (identical
 * clamping rule) — that module pulls in the activity-polling client and chat
 * transcript machinery this file, and the pure `lib/admin` layer generally,
 * must stay free of.
 */
export const runStepPercent = (step: number, totalSteps: number): number =>
  totalSteps > 0 ? Math.max(0, Math.min(100, Math.round((step / totalSteps) * 100))) : 0;

/** "Step 3 of 7" — clamps a negative/out-of-range step to something sane to read. */
export const runStepLabel = (step: number, totalSteps: number): string => {
  const clamped = Math.max(0, Math.min(step, Math.max(step, totalSteps)));
  return totalSteps > 0 ? `Step ${clamped} of ${totalSteps}` : `Step ${Math.max(0, step)}`;
};
