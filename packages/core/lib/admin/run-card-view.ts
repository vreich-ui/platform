/**
 * A1 (one-run-card) — the view decision behind `RequestActivity.tsx`'s run
 * card: what shows on the collapsed header row, what stays hidden until the
 * user opens it (or the run demands attention on its own), and which single
 * recovery button — if any — earns the primary-action slot next to the
 * chevron. Pure, so it is testable without the DOM/component harness this
 * repo does not have (BRIEF.md's test convention) — `RequestActivity.tsx`
 * only consumes this.
 *
 * The card used to show four things unconditionally (node list behind its own
 * disclosure, but approvals/recovery/publication always open) — this made
 * every run, including a boring `running`/`done` one, several lines tall.
 * The new rule: collapsed by default; a run that needs a human
 * (`failed`/`needs_you`) opens itself far enough to show the approval/recovery
 * block, but never the node list — that still costs a real click.
 */

/**
 * The one categorical fact this module needs about the run. `runCardStatus`
 * below derives it — that used to be a one-line ternary in the component,
 * which is exactly why it drifted (see that function's own comment).
 */
export type RunCardStatus = 'queued' | 'running' | 'blocked' | 'paused' | 'done' | 'failed' | 'needs_you' | 'cancelled';

/**
 * What `runCardStatus` reads. Everything is optional and structural: the
 * fields come from `ActivityView` (`status`, `approvals`) plus, where the
 * host happens to know it, the bound chat's own status.
 */
export interface RunCardStatusInput {
  /** CMS-Agent's RAW run status — never literally `needs_you`. */
  status?: string;
  /** GENUINE holds only (`ActivityView.approvals`) — advisory records are already filtered out server-side. */
  approvalCount?: number;
  /**
   * The attached chat's status, when the host has one (`AgentsHub`,
   * `AgentRail`). The request detail page has no chat in hand and omits it —
   * which is safe, because a chat gate that has reached the request's own
   * status is already visible there through the row badge.
   */
  chatStatus?: string;
}

/**
 * FIX 4 — the card's status, derived the way the SERVER derives the
 * request's.
 *
 * This was an inline ternary in `RequestActivity.tsx` that recognised one of
 * the four things `deriveRequestStatus` calls `needs_you`
 * (`server/lib/requests/derive-status.ts` §5.1): a non-empty `approvals`.
 * The other three — a `blocked` run, a `paused` run, and an attached chat
 * `awaiting_approval`/`awaiting_candidate` — all fell through to `running`,
 * so the list badged a row amber "Needs you" while the card beside it sat
 * collapsed, showed a spinner, and never opened its recovery block.
 *
 * The precedence is the server's, in the server's order, so the two cannot
 * disagree about which fact wins:
 *   1. the chat gate — the NEAREST gate, and it outranks even a failed run
 *      (`derive-status.test.ts`: "chat awaiting_approval outranks the run
 *      state — even a failed run reads needs_you");
 *   2. `cancelled`;
 *   3. `failed`;
 *   4. an approval hold;
 *   5. `blocked`, then `paused`;
 *   6. `completed` → done, `queued` → queued;
 *   7. anything else — including a status this client does not know — reads
 *      as `running`, the quiet bucket.
 */
export function runCardStatus(input: RunCardStatusInput): RunCardStatus {
  if (input.chatStatus === 'awaiting_approval' || input.chatStatus === 'awaiting_candidate') return 'needs_you';
  if (input.status === 'cancelled') return 'cancelled';
  if (input.status === 'failed') return 'failed';
  if ((input.approvalCount ?? 0) > 0) return 'needs_you';
  if (input.status === 'blocked') return 'blocked';
  if (input.status === 'paused') return 'paused';
  if (input.status === 'completed') return 'done';
  if (input.status === 'queued') return 'queued';
  return 'running';
}

export interface RunCardPrimaryAction {
  kind: 'budget-raise' | 'retry' | 'none';
  /** Why there is no button, when `kind` is `'none'` and there was something to explain. */
  reason?: 'operator_action' | 'no_retry_handler' | 'no_recovery';
}

export interface RunCardViewInput {
  status: RunCardStatus;
  /** The user's own chevron toggle — not folded with the auto-open rule; that fold is this module's job. */
  expanded: boolean;
  /** Recovery names a node to retry at all (`recovery?.node_id`). */
  hasRetryTarget: boolean;
  /** The recovery's node failure carries an `operator_action` sentence — suppresses Retry regardless of anything else. */
  hasOperatorAction: boolean;
  /** The recovery's node failure is `budget_exceeded`. */
  isBudgetExceeded: boolean;
  /** The host wired `onRetry` at all — no call site does yet (B2 lands it); until then Retry never renders. */
  hasRetryHandler: boolean;
  /** Current viewer's resolved rights (`owner` expands to `admin`+`publisher` — `server/lib/roles.ts`). */
  isOwner: boolean;
  /** The publication tail's own `offerRecheck` (`lib/admin/publication-card.ts`). */
  offerRecheck: boolean;
}

export interface RunCardView {
  /**
   * Whether the disclosure reads as open right now — the user's toggle OR the
   * run demanding attention on its own. Also the value to seed the
   * component's `expanded` state with on a target this hasn't been toggled
   * for yet.
   */
  expandedByDefault: boolean;
  /** The node timeline — ONLY the user's own toggle opens this; never automatic. */
  showNodeList: boolean;
  /** The approval / recovery block, and the publication tail — open whenever `expandedByDefault` is. */
  showRecovery: boolean;
  /** Whether the publication tail states its full detail (URL, facts, "Check again") or just its one-line headline. */
  publicationLines: 'one' | 'full';
  primaryAction: RunCardPrimaryAction;
}

/**
 * A run the human has to look at opens itself. `blocked` and `paused` are on
 * this list because `derive-status.ts` calls both of them `needs_you` — the
 * request row badges them amber, so the card must not sit collapsed and
 * silent next to it (FIX 4). `cancelled`/`done`/`queued`/`running` still
 * cost a click.
 */
const AUTO_OPEN_STATUSES: ReadonlySet<RunCardStatus> = new Set(['failed', 'needs_you', 'blocked', 'paused']);

function decidePrimaryAction(input: RunCardViewInput): RunCardPrimaryAction {
  // Precedence 1: an Owner facing a budget ceiling gets the raise-and-retry
  // buttons — this wins even when a retry handler is wired, since retrying
  // as-is would only fail the same way again.
  if (input.isOwner && input.isBudgetExceeded) return { kind: 'budget-raise' };

  if (!input.hasRetryTarget) return { kind: 'none', reason: 'no_recovery' };
  // Existing rule (kept, not re-derived): a classified provider error or the
  // budget guard already names the next step — offering Retry next to it
  // invites clicking the one action that will only fail the same way again.
  if (input.hasOperatorAction) return { kind: 'none', reason: 'operator_action' };
  // Precedence 2: Retry — but only once B2 actually wires a host's `onRetry`.
  if (!input.hasRetryHandler) return { kind: 'none', reason: 'no_retry_handler' };
  return { kind: 'retry' };
}

export function runCardView(input: RunCardViewInput): RunCardView {
  const autoOpen = AUTO_OPEN_STATUSES.has(input.status);
  const expandedByDefault = input.expanded || autoOpen;
  return {
    expandedByDefault,
    // The node list needs a real click, whatever the status says.
    showNodeList: input.expanded,
    showRecovery: expandedByDefault,
    publicationLines: input.offerRecheck ? 'full' : 'one',
    primaryAction: decidePrimaryAction(input),
  };
}

/**
 * FIX 10 — one string that identifies WHICH run a card is showing.
 *
 * `RequestActivity` resets its cached `run_id`, ETag and cadence when its
 * target changes, but it did not reset `loaded`/`activity`. Those two are
 * what `onStatesStatusChange` reports on (FIX 5), so for the one poll
 * between switching targets and the new response landing, the card said "I
 * am stating this run's status" while the status on screen still belonged
 * to the PREVIOUS run — and the thread stayed silenced on the strength of
 * it. Small window, wrong answer, and the same class of bug FIX 5 closed.
 *
 * Kept pure and separate so the "which target" question has one answer, and
 * so the `requestId`/`runId` ambiguity below is pinned by a test rather than
 * living in a template literal in the component: the two fields are
 * different namespaces, and a card polling request `x` is not a card polling
 * run `x`.
 */
export const activityTargetKey = (target: { requestId?: string; runId?: string }): string =>
  `request:${target.requestId ?? ''}|run:${target.runId ?? ''}`;
