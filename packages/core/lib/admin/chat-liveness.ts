/**
 * D5 — chat liveness (T3.1). Pure logic behind the four tiers rendered by
 * `@core/admin/chat`: an ambient header state chip, a collapsible progress
 * timeline, an interrupt reserved for actual decisions, and a completion
 * receipt. The governing line, verbatim: "an interrupt is for a decision,
 * not for a status."
 *
 * Nothing here re-classifies severity — `AdminSeverity` (T1.1,
 * `@core/lib/admin/severity`) is consumed as-is, never re-derived. This
 * module only maps CHAT RUN STATE (`ChatStatus`, `RunSummaryView`, the
 * event stream) onto that existing vocabulary, plus the timing/format/undo
 * logic the D5 components need and this repo has no other home for.
 */
import type { AdminSeverity } from './severity.js';
import type { ChatEventView, ChatStatus, RunSummaryView } from './chat-client.js';

// ─── tier 1: the ambient header chip ───────────────────────────────────────

export type LivenessTier = 'working' | 'waiting' | 'blocked' | 'done';

export interface LivenessChip {
  tier: LivenessTier;
  label: string;
  /**
   * `undefined` for `working` — D5 is explicit that "working is not a
   * severity" (it is neither good nor bad news, just in-progress), so it
   * gets the neutral/accent treatment rather than borrowing one of D4's
   * five colours.
   */
  severity: AdminSeverity | undefined;
}

/**
 * `status === 'idle'` covers two different pasts: a chat that has never run
 * (nothing to show) and one whose last run just finished (show the
 * receipt's headline). `lastOutcome` — `ChatSummaryView.last_outcome`,
 * already carried on every `get_chat` response, no new fetch — is what
 * tells them apart.
 *
 * A `caps`/wall-clock ending is deliberately NOT `success`-green: W19 F1
 * ("a `caps` ending in particular must tell the editor the job is still
 * alive") means this must read as a fact reported, not a finish line — D4's
 * `info` tone, not `success`.
 */
export function deriveLivenessChip(
  status: ChatStatus | undefined,
  lastOutcome: RunSummaryView | null | undefined
): LivenessChip | undefined {
  switch (status) {
    case 'queued':
      return { tier: 'working', label: 'Waking the agent…', severity: undefined };
    case 'running':
      return { tier: 'working', label: 'Working', severity: undefined };
    case 'awaiting_approval':
      return { tier: 'waiting', label: 'Needs you — approval', severity: 'needs_you' };
    case 'awaiting_candidate':
      return { tier: 'waiting', label: 'Needs you — pick a version', severity: 'needs_you' };
    case 'error':
      return { tier: 'blocked', label: 'Blocked', severity: 'blocked' };
    case 'cancelled':
      // A human stopped it on purpose — not a hard stop with no forward
      // path (that's `blocked`), and not a finished piece of work either.
      return { tier: 'done', label: 'Cancelled', severity: 'info' };
    case 'idle':
      if (!lastOutcome) return undefined;
      if (lastOutcome.outcome === 'caps') {
        return { tier: 'done', label: 'Paused — the job continues', severity: 'info' };
      }
      return { tier: 'done', label: 'Done', severity: 'success' };
    case undefined:
      return undefined;
  }
}

// ─── elapsed time ───────────────────────────────────────────────────────────

export function elapsedMsSince(startedAt: string | undefined, nowMs: number): number | undefined {
  if (!startedAt) return undefined;
  const start = Date.parse(startedAt);
  if (!Number.isFinite(start)) return undefined;
  return Math.max(0, nowMs - start);
}

/** The most recent `run_started` event's timestamp — the active run's clock start. */
export function activeRunStartedAt(events: readonly ChatEventView[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.type === 'run_started') return events[i]!.at;
  }
  return undefined;
}

/**
 * Elapsed time for the chip: ticking (now minus the active run's start)
 * while `working`/`waiting`, fixed (the last run's own duration) once
 * `blocked`/`done`. Returns `undefined` when there is nothing to time —
 * never a fabricated zero.
 */
export function elapsedMsForChip(
  tier: LivenessTier,
  events: readonly ChatEventView[],
  lastOutcome: RunSummaryView | null | undefined,
  nowMs: number
): number | undefined {
  if (tier === 'working' || tier === 'waiting') return elapsedMsSince(activeRunStartedAt(events), nowMs);
  if (!lastOutcome) return undefined;
  return elapsedMsSince(lastOutcome.started_at, Date.parse(lastOutcome.finished_at) || nowMs);
}

// ─── streaming vs. working-but-silent ───────────────────────────────────────

/**
 * There is no per-token transport here (`getChat` is a `since_seq` poll, not
 * a stream) — so "streaming" is approximated from the one honest signal the
 * client has: new events just landed. `lastEventAtMs` is a CLIENT clock
 * reading (`Date.now()` at the moment a poll ingested new events), captured
 * by `useChat` — comparing it to another client reading avoids any
 * server/client clock-skew that comparing against an event's own `at` would
 * risk. `windowMs` is a few poll ticks, not a single one, so an ordinary gap
 * between two 1.2s ticks does not flicker the indicator on and off.
 */
export function isStreamingNow(
  status: ChatStatus | undefined,
  lastEventAtMs: number | undefined,
  nowMs: number,
  windowMs = 3500
): boolean {
  if (status !== 'running') return false;
  if (lastEventAtMs === undefined) return false;
  return nowMs - lastEventAtMs < windowMs;
}

// ─── tier 4: the receipt ────────────────────────────────────────────────────

export interface TerminalReceiptInfo {
  label: string;
  severity: AdminSeverity;
}

/**
 * The receipt's headline + colour for how a run ended. Mirrors
 * `RunFinishedLine`'s existing `caps`/`wall_clock` copy (W19 F1) rather than
 * duplicating a second wording for the same fact.
 */
export function terminalReceiptInfo(outcome: RunSummaryView['outcome']): TerminalReceiptInfo {
  switch (outcome) {
    case 'error':
      return { label: 'Hit a problem', severity: 'blocked' };
    case 'cancelled':
      return { label: 'Cancelled', severity: 'info' };
    case 'caps':
      return { label: 'Paused this turn — anything already running keeps going', severity: 'info' };
    case 'completed':
      return { label: 'Done', severity: 'success' };
  }
}

/**
 * Tools whose effect can be undone by asking the SAME agent to run the
 * inverse verb in this chat session — it already holds (or can reacquire)
 * the checkout/lock context a direct `discard` call would need, so the
 * client never has to reconstruct the object identity itself, and this
 * stays inside the chat's own governed write path (the interrupt tier,
 * tier 3, if the inverse itself needs a decision) rather than opening a
 * second one.
 *
 * Exact inverses per the repo's own patch grammar: `patch` and
 * `submit_review` both compensate through `discardProposal`
 * (`server/lib/review-state.ts`, "compensating inverse write"); `apply_theme`
 * documents `discard` as its own exact inverse verbatim
 * (`server/lib/mcp-tool-definitions-2.ts`: "the exact inverse makes
 * reverting a standard discard"). Every other write this chat can call —
 * `create_object`/`create_variant`/`instantiate_template`/
 * `instantiate_section_template` (nothing un-creates an object),
 * `publish` (unpublish is explicitly rejected server-side today,
 * `server/lib/object-publish.ts`), `discard` itself, and the PDF-template
 * tools — has no exact inverse in this repo. Omit the link rather than
 * invent one.
 */
const UNDOABLE_TOOLS = new Set(['patch', 'submit_review', 'apply_theme']);

export const hasKnownInverse = (tool: string): boolean => UNDOABLE_TOOLS.has(tool);

/** The plain-language ask sent back into the same chat to invoke the inverse. */
export const undoPrompt = (tool: string): string | undefined =>
  hasKnownInverse(tool) ? 'Undo that — discard the change you just made.' : undefined;

/** The most recent successful write in this run whose tool has a known inverse, if any. */
export function lastUndoableWriteTool(events: readonly ChatEventView[], runId: string | undefined): string | undefined {
  if (!runId) return undefined;
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.detail?.run_id !== runId) continue;
    if (event.type !== 'tool_result' || event.detail?.is_error) continue;
    const tool = String(event.detail?.tool ?? '');
    if (hasKnownInverse(tool)) return tool;
  }
  return undefined;
}
