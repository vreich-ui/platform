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
import { knownNodeLabel } from './chat-logic.js';
import { objectWorkspaceHref } from './request-logic.js';
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
 *
 * E1: `currentNode` — the sweeper's latest `detail.node` (`sweep.ts`,
 * `currentNodeFromEvents` below) — narrates WHAT is running instead of the
 * generic "Working", the same way `RequestProgressLine`'s `stepLine` does
 * for the inline progress row (`chat-logic.ts`'s `knownNodeLabel`, the ONE
 * lookup into `NODE_LABELS` both share). Only the `running` tier reads it:
 * `queued` has no node yet (nothing has started), and every other tier
 * already states its own outcome word.
 */
export function deriveLivenessChip(
  status: ChatStatus | undefined,
  lastOutcome: RunSummaryView | null | undefined,
  currentNode?: string
): LivenessChip | undefined {
  switch (status) {
    case 'queued':
      return { tier: 'working', label: 'Waking the agent…', severity: undefined };
    case 'running':
      return { tier: 'working', label: knownNodeLabel(currentNode) ?? 'Working', severity: undefined };
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

// ─── thread-wide liveness visibility (A2) ──────────────────────────────────

/**
 * A2: `ChatStateChip` (the header) is the thread's SINGLE live indicator —
 * this decides what else, if anything, is still allowed to say "still
 * going" alongside it. `trailingLine` is always `false`: the standalone
 * "Working…/Writing…" paragraph that used to sit under the transcript is
 * retired for good (W19/A2 — "Working / Failed" stated up to five times at
 * once), never conditionally reintroduced. `activityProgress` gates the
 * trailing activity group's `RunProgress` (step count + elapsed) treatment:
 * suppressed once a `RequestActivity` card is mounted for this chat's bound
 * request, since that card already live-renders the SAME run's progress —
 * showing `RunProgress` here too would state the same step count twice.
 */
export interface ThreadStatusVisibility {
  activityProgress: boolean;
  trailingLine: boolean;
}

/**
 * FIX 5 — what `hasRunCard` is allowed to mean.
 *
 * The suppressions keyed on `hasRunCard` (this function, and `receiptLine`'s
 * `showFailureText` below, and the thread's `request_progress` line) all say
 * the same thing: "the run card already states this, so the thread will not
 * restate it." That is only true while the card IS stating something. A
 * `RequestActivity` renders a Skeleton until its first poll resolves, and a
 * degraded notice — "we could not reach the workspace" — when the poll comes
 * back with `cms_agent_unavailable` or `no_workflow_run`. In both of those
 * the card states no run status at all.
 *
 * The host used to pass `Boolean(chat.request)`, i.e. "a request is bound",
 * which is true in every one of those states. A chat bound to a request
 * whose CMS-Agent read failed, whose last run ended in `run_error`, showed
 * the failure NOWHERE: the card said it could not reach the workspace and
 * the thread had been silenced on its behalf.
 *
 * This is the predicate the hosts must pass instead. The invariant it
 * exists to hold — the card is never silent while the thread is silenced —
 * is asserted over every combination in `chat-liveness.test.ts`.
 */
export interface RunCardPresence {
  /** A `RequestActivity` is mounted for this chat's bound request at all. */
  mounted: boolean;
  /** Its first poll has resolved — before that it is a Skeleton. */
  loaded: boolean;
  /** That poll returned an activity view, rather than a degraded notice. */
  hasActivity: boolean;
}

export const runCardStatesStatus = (presence: RunCardPresence): boolean =>
  presence.mounted && presence.loaded && presence.hasActivity;

export function threadStatusVisibility(params: { running: boolean; hasRunCard: boolean }): ThreadStatusVisibility {
  return {
    activityProgress: params.running && !params.hasRunCard,
    trailingLine: false,
  };
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
 * E1: the latest `request_progress` event's node id, verbatim
 * (`detail.node` — `sweep.ts`'s `progressDetail`). Fed to `deriveLivenessChip`
 * so the header chip can narrate the current step; a chat with no progress
 * event yet (or a non-string/absent `node`) yields `undefined`, which
 * `deriveLivenessChip` treats exactly like "no node named".
 */
export function currentNodeFromEvents(events: readonly ChatEventView[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'request_progress') continue;
    const node = event.detail?.node;
    return typeof node === 'string' ? node : undefined;
  }
  return undefined;
}

/**
 * FIX 2: the object this run has produced, read off the latest
 * `request_progress` event that names one (`detail.object_id`, stamped by
 * `sweep.ts`'s `progressDetail`).
 *
 * The chat's own request binding carries `object_id` too, but it is sent on
 * the FIRST poll only and the client latches it — and the sweeper records the
 * object well after that, so the binding never has one for a run in progress.
 * These events keep arriving, so this is where the fact actually shows up
 * mid-run. Scans backwards for the newest event that HAS an id rather than
 * reading only the last one: a later progress line written before the object
 * existed would otherwise erase a link that is genuinely there.
 *
 * `undefined` means "no object recorded yet", never "there is no object".
 */
export function objectIdFromEvents(events: readonly ChatEventView[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'request_progress') continue;
    const objectId = event.detail?.object_id;
    if (typeof objectId === 'string' && objectId) return objectId;
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

export interface ReceiptLineInput {
  outcome: RunSummaryView['outcome'];
  /** `RunSummaryView.chips`, verbatim — the loop's own `runChips()` (`agent/loop.ts`). */
  chips: readonly string[];
  /** The run's own failure text (`run_error`'s `runErrorCopy`), when this receipt is for a failed run. */
  message?: string;
  /**
   * A `RequestActivity` card is mounted for this chat's bound request — it
   * already states a failed run via the derive-status sentence
   * (`status_reason`, `sweep.ts` / `derive-status.ts`), so this run's own
   * failure text here would say the same failure a second time (A3:
   * "a failed-run thread states the failure exactly once").
   */
  hasRunCard: boolean;
  /**
   * E2: objects THIS run created, scoped exactly the way `chat.tsx` already
   * scopes them for the "details" popover (`createdObjectsFromEvents(events,
   * outcome.run_id)`, `chat-logic.ts`) — read, not recomputed here, the same
   * "one classifier" discipline `chips` already follows. No `title`: nothing
   * in this run's own event stream reliably carries one — `create_object`'s
   * `describe()` is just "Create a new <type>", the body an agent submits
   * varies per object type, and an auto-executed call doesn't even disclose
   * its args (only a human-approved one does). A caller that has separately
   * PROVEN a title for one of these ids may attach it; nothing here invents
   * one when it's missing.
   */
  created?: readonly ReceiptCreatedObject[];
  /**
   * E2b: the object this run PUBLISHED — `publishedObjectFromEvents`
   * (`chat-logic.ts`) reading the stamp a successful publish now leaves on
   * its own `tool_result` event (`publishedObjectRef`, `loop.ts`). Present
   * only when that publish returned `published: true` with an object id;
   * a refused, failed or half-completed publish stamps nothing, so this
   * stays absent and the receipt claims nothing.
   *
   * What it does NOT prove is LIVE. A publish commits the export with
   * `[skip netlify]` and going live is a separate, explicit release
   * (`server/lib/object-publish.ts`; the platform's own publish response
   * says `live: false, deploy_deferred: true` in as many words). So the
   * clause links what IS proven — see `liveUrl` below.
   */
  published?: ReceiptPublishedObject;
}

export interface ReceiptCreatedObject {
  id: string;
  type?: string;
  /** Set only when the caller has PROVEN this object's title — never guessed. */
  title?: string;
}

export interface ReceiptPublishedObject {
  id: string;
  type?: string;
  /**
   * A CONFIRMED live URL — set only by a caller that has separately PROVEN
   * go-live (deploy evidence, `publication-evidence.ts`'s `state: 'live'`),
   * never derived from the publish itself. With it the clause reads
   * "Published → view live"; without it "Published → open", pointing at the
   * object, which is the thing the publish result actually proves exists.
   * `RunReceipt` supplies no URL today: a chat's own event stream carries no
   * deploy evidence, and linking an article path that 404s until someone
   * releases would be the invented state guardrail 5 rules out.
   */
  liveUrl?: string;
}

/** One truthful "what changed" clause, already carrying its own link — the Action Receipt pattern at its cheapest. */
export interface ReceiptAction {
  /**
   * FIX 4 — React list identity. NOT the href: a run that creates an object
   * and then publishes THAT object yields two clauses with byte-identical
   * hrefs (the common draft-then-publish shape), and keying on the href
   * collides. This is the clause's role plus the object it names, which is
   * unique by construction.
   */
  key: string;
  label: string;
  href: string;
}

export interface ReceiptLineDecision {
  /** Chips worth showing — a lone "no changes" chip (`runChips`'s empty-run
   *  fallback) carries no information the headline doesn't already; drop it. */
  visibleChips: string[];
  /** Whether `message`/`providerDetail` render at all. */
  showFailureText: boolean;
  /**
   * E2: what this run PROVABLY changed, each already paired with a link to
   * the thing that changed — empty when neither `created` nor `published`
   * proved anything, which is today's plain line unchanged.
   */
  actions: ReceiptAction[];
}

const NO_CHANGES_CHIP = 'no changes';

/**
 * The object's own workspace — reachable for any object id this receipt can
 * prove. FIX 7: the shared helper (`request-logic.ts`), and FIX 3: NO default
 * type. This copy defaulted to `content_item`, and `ObjectWorkspace` trusts
 * `?type=` over its own id resolution, so an object of any other type got a
 * link that dead-ended on "<id> was not found".
 */
const receiptObjectHref = (object: { id: string; type?: string }): string =>
  objectWorkspaceHref(object.id, object.type);

/**
 * FIX 3 — say what was created, or say nothing.
 *
 * This read "Created draft" for every stamp, including a `page` and a
 * `section`. The type is now always proven at the source (`resultObjectRef`,
 * `server/lib/agent/loop.ts`, stamps nothing it cannot type), so the clause
 * names it: `content_item` IS the draft article an editor means by "draft",
 * and every other governed type says its own name.
 */
const createdObjectNoun = (type: string): string =>
  type === 'content_item' ? 'draft' : type.replace(/_/g, ' ');

const createdObjectLabel = (object: ReceiptCreatedObject & { type: string }): string => {
  const noun = createdObjectNoun(object.type);
  return object.title ? `Created ${noun} '${object.title}' → open` : `Created ${noun} → open`;
};

/**
 * FIX 3 — a stamp with no proven type is not a creation this receipt can
 * describe. The one tool that produced them, `instantiate_section_template`
 * with a non-`standalone` target, patches an existing PAGE and creates
 * nothing; its `object_id` is that page's. Persisted events from before the
 * source-side fix still carry those stamps, so they are dropped here too.
 */
const provenCreations = (created: readonly ReceiptCreatedObject[] | undefined) =>
  (created ?? []).filter((object): object is ReceiptCreatedObject & { type: string } => Boolean(object.type));

/** A3/E2: what the single-line receipt shows beyond its headline + elapsed time. */
export function receiptLine({ outcome, chips, message, hasRunCard, created, published }: ReceiptLineInput): ReceiptLineDecision {
  const visibleChips = chips.length === 1 && chips[0] === NO_CHANGES_CHIP ? [] : [...chips];
  const actions: ReceiptAction[] = [
    ...provenCreations(created).map((object, index) => ({
      key: `created:${index}:${object.id}`,
      label: createdObjectLabel(object),
      href: receiptObjectHref(object),
    })),
    // E2b: "view live" only where live is proven; otherwise the honest half
    // of the same fact — it IS published, and here is the object.
    ...(published
      ? [
          published.liveUrl
            ? { key: `published:${published.id}`, label: 'Published → view live', href: published.liveUrl }
            : { key: `published:${published.id}`, label: 'Published → open', href: receiptObjectHref(published) },
        ]
      : []),
  ];
  return {
    visibleChips,
    showFailureText: Boolean(message) && !(outcome === 'error' && hasRunCard),
    actions,
  };
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
 * reverting a standard discard"). U3 (brand-imagery wave): `apply_brand_imagery`
 * carries the SAME sentence verbatim for its own site-checkout patch
 * (`mcp-tool-definitions-2.ts`'s `site_apply_brand_imagery` description:
 * "the exact inverse makes reverting a standard discard") — an equally exact
 * inverse, so it belongs here too. Every other write this chat can call —
 * `create_object`/`create_variant`/`instantiate_template`/
 * `instantiate_section_template` (nothing un-creates an object),
 * `publish` (unpublish is explicitly rejected server-side today,
 * `server/lib/object-publish.ts`), `discard` itself, and the PDF-template
 * tools — has no exact inverse in this repo. Omit the link rather than
 * invent one.
 */
const UNDOABLE_TOOLS = new Set(['patch', 'submit_review', 'apply_theme', 'apply_brand_imagery']);

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
