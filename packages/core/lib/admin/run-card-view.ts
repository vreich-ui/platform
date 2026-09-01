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
import { hasOperatorAction } from './cms-agent-error-copy.js';
import { requestObjectHref } from './request-logic.js';

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
  reason?: 'operator_action' | 'no_retry_handler' | 'no_recovery' | 'owner_required';
}

/**
 * C4: the slice of `ActivityNodeView` this module needs to resolve which
 * node `recovery.node_id` actually means. Structurally compatible with the
 * real thing, so `RequestActivity.tsx` passes `activity.nodes` straight
 * through.
 */
export interface RunCardRecoveryNode {
  id: string;
  status: string;
  /** Mirrors `ActivityNodeView['failure']` — only the fields this decision reads. */
  failure?: {
    code: string;
    operatorAction?: string;
    /**
     * FIX 8: CMS-Agent's own structured detail for the failure. `nodeId` is
     * its NAME for the node the budget belongs to — the authoritative answer
     * to "which node", and the one the raise buttons spend money against.
     */
    details?: { nodeId?: string };
  };
}

/**
 * C4 (live-confirmed) — `recovery.node_id` can name a node that is not in
 * `nodes` at all: an Owner hit a $6.47 spend against a $2 budget and the
 * server's own `node_id` didn't line up with anything in `activity.nodes`,
 * so the card's old `nodes.find(n => n.id === recovery.node_id)` came back
 * `undefined`, `isBudgetExceeded` read false, and the card offered a plain
 * Retry — the one button guaranteed to fail the exact same way. The honest
 * fallback is the node that actually failed, the same one the server itself
 * falls back to when its own `retryNodeId` is missing
 * (`failed?.id` in `server/lib/requests/activity.ts`).
 *
 * Exported so `RequestActivity.tsx` resolves the SAME node id for the
 * raise-buttons' own numbers (and their click target) that this module uses
 * to decide whether to offer them — one resolution, not two that can drift.
 *
 * FIX 8: three tiers, strongest proof first. The first-failed-node scan is a
 * LAST resort, because on a run with more than one failure it is a guess —
 * and the click it feeds ("Raise to $X as the default") writes a node's spend
 * ceiling for every future run, so guessing spends money on the wrong node
 * and leaves the real one still capped.
 *
 *   1. `recoveryNodeId` names a real node — the server got it right.
 *   2. Some node's own `failure.details.nodeId` names a real node. That field
 *      is CMS-Agent's own id for the budget it refused, carried on the failure
 *      itself (`lib/admin/budget-raise.ts`'s `BudgetExceededDetails`), so it
 *      is evidence rather than position.
 *   3. Only then, the first node that failed.
 */
export function resolveRecoveryNodeId(
  recoveryNodeId: string | undefined,
  nodes: readonly RunCardRecoveryNode[]
): string | undefined {
  if (!recoveryNodeId) return undefined;
  if (nodes.some((node) => node.id === recoveryNodeId)) return recoveryNodeId;
  const named = nodes
    .map((node) => node.failure?.details?.nodeId)
    .find((id): id is string => Boolean(id) && nodes.some((node) => node.id === id));
  if (named) return named;
  return nodes.find((node) => node.status === 'failed')?.id;
}

export interface RunCardViewInput {
  status: RunCardStatus;
  /** The user's own chevron toggle — not folded with the auto-open rule; that fold is this module's job. */
  expanded: boolean;
  /** `recovery?.node_id` — undefined when nothing failed / there is no recovery at all. */
  recoveryNodeId?: string;
  /** `recovery?.operator_action` — the RUN-level sentence's own instruction, when CMS-Agent sent one. */
  recoveryOperatorAction?: string;
  /**
   * `activity.nodes` (or an equivalent `RunCardRecoveryNode[]`). C4:
   * `recoveryNodeId` can name a node no longer in this list —
   * `resolveRecoveryNodeId` is the fallback this module applies before
   * reading a failure off of it.
   */
  nodes: readonly RunCardRecoveryNode[];
  /** The host wired `onRetry` at all — no call site does yet (B2 lands it); until then Retry never renders. */
  hasRetryHandler: boolean;
  /** Current viewer's resolved rights (`owner` expands to `admin`+`publisher` — `server/lib/roles.ts`). */
  isOwner: boolean;
  /** The publication tail's own `offerRecheck` (`lib/admin/publication-card.ts`). */
  offerRecheck: boolean;
  /**
   * E3: the object this run is (or was) working on, when the host knows it.
   * `ActivityView` itself carries none — CMS-Agent's run/cost reads never
   * echo one back (`server/lib/requests/activity.ts`) — so this is host-
   * supplied, the same pattern `chatStatus` already is on
   * `RequestActivityProps`. Absent means exactly "not known yet", never
   * "there is no object".
   */
  objectId?: string;
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
  /**
   * E3: the pinned card's own jump-to-artifact link — present as soon as an
   * object id is known, mid-run or not, INDEPENDENT of `primaryAction`
   * (a card can show both a recovery button and this at once; neither
   * displaces the other, they're separate slots on the row).
   */
  openDraftHref?: string;
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
  const resolvedNodeId = resolveRecoveryNodeId(input.recoveryNodeId, input.nodes);
  const recoveryNode = resolvedNodeId ? input.nodes.find((node) => node.id === resolvedNodeId) : undefined;
  const isBudgetExceeded = recoveryNode?.failure?.code === 'budget_exceeded';

  // Precedence 1: an Owner facing a budget ceiling gets the raise-and-retry
  // buttons — this wins even when a retry handler is wired, since retrying
  // as-is would only fail the same way again.
  if (isBudgetExceeded && input.isOwner) return { kind: 'budget-raise' };
  // C4/D3: a non-Owner can't raise the ceiling, and Retry is the one button
  // guaranteed to fail the same way it just did — a disabled control with
  // the honest reason (D3), never a live button that cannot help this viewer.
  if (isBudgetExceeded) return { kind: 'none', reason: 'owner_required' };

  if (!input.recoveryNodeId) return { kind: 'none', reason: 'no_recovery' };
  // Existing rule (kept, not re-derived): a classified provider error or the
  // budget guard already names the next step — offering Retry next to it
  // invites clicking the one action that will only fail the same way again.
  // C4 item 2: reads BOTH the run-level sentence's own `operator_action` AND
  // the resolved node's own — either one suppresses Retry. Previously only
  // the run-level one was checked, so a node that carried its own
  // `operator_action` with no run-level echo of it still offered Retry.
  if (hasOperatorAction({ operatorAction: input.recoveryOperatorAction }) || hasOperatorAction({ operatorAction: recoveryNode?.failure?.operatorAction })) {
    return { kind: 'none', reason: 'operator_action' };
  }
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
    // E3 (FIX 7): the shared route helper, not a fourth hand-typed copy of it.
    // A run card's object is a request's object, so its type is proven.
    ...(input.objectId ? { openDraftHref: requestObjectHref(input.objectId) } : {}),
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
