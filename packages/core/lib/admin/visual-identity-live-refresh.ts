/**
 * A7 — the visual-identity page refreshes itself.
 *
 * Two independent staleness sources, one fix shape for both: a pure
 * transition predicate decides WHEN a `.tsx` component (untested,
 * `tsconfig.test.json` excludes every `packages/core/admin/**\/*.tsx`) should
 * call its existing `load()`/`onChanged()` refresh path. Nothing here talks
 * to the network or React — the component is left with only "call this
 * function with the latest status, act on what it returns."
 *
 * 1. CHAT COMPLETION. `useDockedVisualIdentityChat`'s conversation can run a
 *    tool that changes the standard, the site, or the mood board — but never
 *    called `load()` itself, so the docked chat finishing a run left the rest
 *    of the page showing what was true before the run started.
 *    `chatRunJustFinished` fires exactly once per run: true only on the tick
 *    where the PREVIOUS `ChatStatus` was still active and the tick's own
 *    status has landed on a terminal one. Two terminal ticks in a row (the
 *    transition already fired, or the chat has simply never run) are both
 *    false, so a caller that feeds every status tick through this gets
 *    `load()` called once per completed run — not once per poll.
 *
 * 2. EXAMPLES JOB. A6's background job (`visual-standard-examples-jobs.ts`)
 *    leaves `examples_job.examples_status` at `pending` until the round
 *    settles; A7 polls it and calls `onChanged()` (the SAME refresh
 *    `ImageryBoard` already runs after every mechanical action) once it
 *    reaches a terminal status. `examplesJobJustSettled` is the identical
 *    shape of predicate as `chatRunJustFinished`, and `shouldContinuePolling`
 *    is the scheduling half: whether to queue another tick at all, given how
 *    many have already run — the sane ceiling that stops a caller polling a
 *    job that will never finish.
 */
import type { ChatStatus } from './chat-client.js';
import type { ExamplesJobView } from './visual-identity-examples-client.js';

// ─── 1. chat run completion ─────────────────────────────────────────────────

const ACTIVE_CHAT_STATUSES: ReadonlySet<ChatStatus> = new Set<ChatStatus>([
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_candidate',
]);

/** A run is in flight — the docked chat is doing (or waiting on) something. */
export function isActiveChatStatus(status: ChatStatus | undefined): boolean {
  return status !== undefined && ACTIVE_CHAT_STATUSES.has(status);
}

/**
 * `idle` (no run active — including "never run"), `error`, or `cancelled`:
 * whatever happened, nothing is still going. `undefined` (no poll has landed
 * yet) is deliberately NOT terminal — there is no run to have finished.
 */
export function isTerminalChatStatus(status: ChatStatus | undefined): boolean {
  return status !== undefined && !isActiveChatStatus(status);
}

/**
 * True only on the tick a run just ended: the previous status was active and
 * this one is terminal. Feed it every status tick (including the first,
 * `undefined` one) — it is false for "nothing has run yet" (`undefined` →
 * `idle`) and false again on every terminal tick after the one that fired,
 * so a caller gets its refresh exactly once per completed run.
 */
export function chatRunJustFinished(previous: ChatStatus | undefined, next: ChatStatus | undefined): boolean {
  return isActiveChatStatus(previous) && isTerminalChatStatus(next);
}

// ─── 2. examples job polling ────────────────────────────────────────────────

type ExamplesJobStatus = ExamplesJobView['status'];

export function isPendingExamplesJob(status: ExamplesJobStatus | undefined): boolean {
  return status === 'pending';
}

/** `ready`, `partial`, and `failed` are all terminal — a job never resumes
 *  from any of them; a *new* job starts a fresh round instead. */
export function isTerminalExamplesJob(status: ExamplesJobStatus | undefined): boolean {
  return status === 'ready' || status === 'partial' || status === 'failed';
}

/** Same shape as `chatRunJustFinished`: true only the tick a pending round
 *  lands on a terminal status. */
export function examplesJobJustSettled(
  previous: ExamplesJobStatus | undefined,
  next: ExamplesJobStatus | undefined
): boolean {
  return isPendingExamplesJob(previous) && isTerminalExamplesJob(next);
}

/** Cadence and ceiling for the poll loop. At the default interval, the
 *  ceiling is ~2 minutes of polling — long enough for a real generation
 *  round, short enough that a stuck background job stops spinning the tab. */
export const EXAMPLES_POLL_INTERVAL_MS = 4000;
export const EXAMPLES_POLL_MAX_ATTEMPTS = 30;

/**
 * The attempt number for the tick that just landed, given the round the
 * PREVIOUS tick saw. A round is identified by its `started_at`: every trigger
 * opens a new record with a new one, so a changed `started_at` means this is a
 * fresh round and the ceiling below starts over at 1.
 *
 * W5 F6 — WHY THIS EXISTS. The counter used to be a plain `attempts + 1` kept
 * per standard for the life of the page, and nothing ever reset it. A round
 * that outran the ~2-minute ceiling (flux routinely does) left the count at
 * `EXAMPLES_POLL_MAX_ATTEMPTS`, so EVERY later regenerate on that standard
 * polled exactly once, saw the ceiling already spent, and scheduled nothing —
 * while the button went on promising "this tab refreshes on its own once they
 * are ready". Budget is per round, not per session.
 */
export function examplesPollAttempt(
  previousRound: string | undefined,
  nextRound: string | undefined,
  attemptsSoFar: number
): number {
  if (nextRound !== undefined && nextRound !== previousRound) return 1;
  return attemptsSoFar + 1;
}

/**
 * Whether another poll tick should be scheduled. `attempts` counts polls
 * already MADE in THIS round (the first tick that established `status` passes
 * `1`, not `0`) — with the defaults above the 30th attempt still schedules a
 * 31st, which then observes the ceiling and stops. Never true once the job is
 * no longer `pending`, regardless of `attempts`.
 */
export function shouldContinuePollingExamples(
  status: ExamplesJobStatus | undefined,
  attempts: number,
  maxAttempts: number = EXAMPLES_POLL_MAX_ATTEMPTS
): boolean {
  return isPendingExamplesJob(status) && attempts < maxAttempts;
}
