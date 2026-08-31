/**
 * A7 — what the chat's pending tool-call approval SAYS.
 *
 * Extracted out of `chat.tsx` when its own, older `ApprovalCard` was deleted
 * in favour of the kit card (`@core/admin/approval`, T1.2): this repo has no
 * component test stack (BRIEF.md), so the card's severity/title/cause
 * decision lives here as plain functions and the `.tsx` is left a thin
 * adapter — the same split `approval-actions.ts` already uses for
 * `<ActionRow>`.
 *
 * W19/D4 severity law: a pending approval is a HELD GATE, not a failure. Even
 * a dry run that came back with blockers stays `needs_you` (amber) — the run
 * PAUSED waiting for a human and there is a forward path. The dry run's
 * verdict is carried in the cause LINE, never by painting the card red.
 */
import type { AdminSeverity } from './severity.js';

// ─── the card's one-line cause ─────────────────────────────────────────────

/** Nothing to decide here yet — the call_id was already submitted. */
export const APPROVAL_CONSUMED_CAUSE = 'Approved — waiting for the agent…';
/** ux-inventory A9: a sequential section proposal is ALSO staged on the
 *  Object Stage, which owns the decision. Deliberate hand-off, so this card
 *  names the other surface instead of offering a second set of buttons. */
export const APPROVAL_IN_STAGE_CAUSE = 'Review the proposal here, then save it from the Object Stage.';
/** No dry run was attached — the write still needs a human. */
export const APPROVAL_NEEDED_CAUSE = 'This write needs your approval before it runs.';
export const DRY_RUN_CLEAN_CAUSE = 'Preview ran clean — the change validates.';
export const DRY_RUN_BLOCKED_CAUSE = 'Preview ran — validation reports blockers (see details).';

/** The `pending` fields this module reads — a structural subset of `chat-client.ts`'s `PendingView`. */
export interface PendingApprovalInput {
  tool: string;
  dryRun?: Record<string, unknown>;
  /** The server's human one-liner for the call, when it sent one. */
  summary?: string;
  /** `useChat.pendingConsumed` — this call_id has been submitted, the poll has not caught up. */
  consumed?: boolean;
  /** ux-inventory A9 — the decision belongs to the Object Stage, not to this card. */
  decidedElsewhere?: boolean;
}

export interface PendingApprovalPresentation {
  severity: AdminSeverity;
  title: string;
  cause: string;
  /** Whether the Approve/Reject/Modify row is this surface's to offer at all. */
  showActions: boolean;
}

/** The server's summary when it sent one, else the bare tool name. */
export const pendingApprovalTitle = (pending: { tool: string; summary?: string }): string =>
  pending.summary?.trim() || `Run ${pending.tool}`;

/**
 * The dry run's verdict as one sentence. `eligible: false` may sit either on
 * the dry-run body or on its nested `summary` — both shapes are in the wild,
 * and this reads both rather than picking one and silently calling the other
 * clean.
 */
export function dryRunCause(dryRun?: Record<string, unknown>): string | undefined {
  if (!dryRun) return undefined;
  if (dryRun.error) return `Preview failed: ${String(dryRun.error)}`;
  const nested = dryRun.summary;
  const nestedEligible =
    nested !== null && typeof nested === 'object' ? (nested as { eligible?: unknown }).eligible : undefined;
  if (dryRun.eligible === false || nestedEligible === false) return DRY_RUN_BLOCKED_CAUSE;
  return DRY_RUN_CLEAN_CAUSE;
}

/**
 * The whole card in one call. Order matters: an already-submitted call is a
 * receipt whatever its dry run said, and a proposal owned by the Object Stage
 * never grows buttons here.
 */
export function presentPendingApproval(input: PendingApprovalInput): PendingApprovalPresentation {
  const title = pendingApprovalTitle(input);
  if (input.consumed) return { severity: 'info', title, cause: APPROVAL_CONSUMED_CAUSE, showActions: false };
  if (input.decidedElsewhere) return { severity: 'info', title, cause: APPROVAL_IN_STAGE_CAUSE, showActions: false };
  return { severity: 'needs_you', title, cause: dryRunCause(input.dryRun) ?? APPROVAL_NEEDED_CAUSE, showActions: true };
}

// ─── Modify: the edited-arguments capture ──────────────────────────────────

export const EDITED_ARGS_INVALID = 'Not valid JSON.';
export const EDITED_ARGS_NOT_OBJECT = 'Arguments must be a JSON object.';

/** What the Modify capture opens on — the call's current arguments, pretty-printed. */
export const editedArgsDraft = (args: Record<string, unknown> | undefined): string =>
  JSON.stringify(args ?? {}, null, 2);

/**
 * Modify on a chat tool call is not a free-text "why" — it is the tool's
 * arguments, re-approved (`approve_tool` + `edited_args`, the only real
 * Modify of the three mechanisms `decisions.ts` tabulates). So the draft has
 * to parse, and it has to parse to an OBJECT: `approve_tool` spreads it as
 * named arguments, and a bare `3` or a `[…]` would reach the server as
 * something no tool has a signature for.
 */
export function parseEditedArgs(draft: string): { args: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(draft) as unknown;
  } catch {
    return { error: EDITED_ARGS_INVALID };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return { error: EDITED_ARGS_NOT_OBJECT };
  return { args: parsed as Record<string, unknown> };
}

/** `<ActionRow>`'s `modifyCapture.validate` shape — a message, or nothing. */
export const editedArgsError = (draft: string): string | undefined => {
  const result = parseEditedArgs(draft);
  return 'error' in result ? result.error : undefined;
};
