import { classifyToolResult } from './activity-severity.js';
import type { ChatEventView } from './chat-client.js';
import { cmsAgentErrorCopy, type CmsAgentErrorCopy } from './cms-agent-error-copy.js';
import { NODE_LABELS, nodeLabel, requestSeverityLevel, requestStatusLabel, type RequestStatusName } from './request-logic.js';
import type { AdminSeverity } from './severity.js';

export type ChatTimelineItem = { kind: 'event'; event: ChatEventView } | { kind: 'activity'; events: ChatEventView[] };

const QUIET_TOOL_EVENTS = new Set(['tool_call', 'tool_result']);

/**
 * B8 (T0.3 Table B, ux-inventory.md): whether a `tool_result` must break out
 * of the collapsed activity group and render as a standalone prominent
 * event. This used to be raw `event.detail?.is_error` — which pulled every
 * held-gate outcome out of the group too, since a refused-by-design publish
 * (readiness `no_go`, an approval gate) is still `is_error: true` on the
 * wire. `classifyToolResult` (W19, `activity-severity.ts`, left untouched by
 * this fix) already knows the difference: a held gate classifies `attention`
 * (amber, "not alarming," T0.3's B1 category) and stays quiet; only an
 * actual `failure` earns prominence. Prominence now follows the CLASSIFIED
 * severity, exactly like colour already does one layer down in
 * `ToolCallCard`/`ActivityLine` — not a second read of `is_error`.
 */
const isProminentToolResult = (event: ChatEventView): boolean => {
  if (event.type !== 'tool_result') return false;
  const classified = classifyToolResult({
    tool: String(event.detail?.tool ?? 'tool'),
    isError: Boolean(event.detail?.is_error),
    output: event.detail?.output,
  });
  return classified.severity === 'failure';
};

export function groupChatEvents(events: readonly ChatEventView[]): ChatTimelineItem[] {
  const grouped: ChatTimelineItem[] = [];
  let activity: ChatEventView[] = [];
  const flush = () => {
    if (activity.length) grouped.push({ kind: 'activity', events: activity });
    activity = [];
  };
  for (const event of events) {
    if (QUIET_TOOL_EVENTS.has(event.type) && !isProminentToolResult(event)) {
      activity.push(event);
      continue;
    }
    flush();
    // A4: the sweeper appends a `request_progress` event on every status
    // transition (`sweep.ts`), so a job that moves through several steps
    // leaves a run of them back to back. Consecutive ones (nothing else
    // landed between them) fold into the latest — the thread shows where the
    // job stands NOW, not a scrollback of every intermediate step.
    const prior = grouped.at(-1);
    if (event.type === 'request_progress' && prior?.kind === 'event' && prior.event.type === 'request_progress') {
      grouped[grouped.length - 1] = { kind: 'event', event };
      continue;
    }
    grouped.push({ kind: 'event', event });
  }
  flush();
  return grouped;
}

// ─── created objects (T3.1 receipt tier + AgentsHub's quick-open bar) ──────

export interface CreatedObjectRef {
  id: string;
  type?: string;
}

/**
 * Creation tools stamp `object_id`/`object_type` on their own `tool_result`
 * event (`resultObjectRef`, `server/lib/agent/loop.ts`) so the UI can route
 * straight to the new object without re-fetching anything. Shared here so
 * the session-wide "quick open" bar (`AgentsHub.tsx`) and the per-run
 * receipt (`chat.tsx`'s `RunReceipt`) read the same rule instead of two
 * hand-copied filters. Pass `runId` to scope to one run's creations; omit it
 * for every creation the session has ever seen.
 */
export function createdObjectsFromEvents(events: readonly ChatEventView[], runId?: string): CreatedObjectRef[] {
  return events
    .filter((event) => event.type === 'tool_result' && !event.detail?.is_error && event.detail?.object_id)
    .filter((event) => runId === undefined || event.detail?.run_id === runId)
    .map((event) => ({
      id: String(event.detail!.object_id),
      ...(event.detail!.object_type ? { type: String(event.detail!.object_type) } : {}),
    }));
}

export interface PublishedObjectRef {
  id: string;
  type?: string;
}

/**
 * E2b: the object THIS run published, read off the `published_object_id`/
 * `published_object_type` stamp a successful publish leaves on its own
 * `tool_result` event (`publishedObjectRef`, `server/lib/agent/loop.ts`).
 *
 * Separate keys from `createdObjectsFromEvents`' `object_id` on purpose —
 * publishing is not creation and the receipt says different words for each,
 * so neither reader can ever pick up the other's events.
 *
 * A run that published more than once keeps the LAST one: the receipt shows
 * a single "Published" clause, and the newest publish is the state the
 * object is actually in. Undefined means exactly what it says — nothing in
 * this run proved a publish — never an optimistic "probably published".
 */
export function publishedObjectFromEvents(
  events: readonly ChatEventView[],
  runId?: string
): PublishedObjectRef | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== 'tool_result' || event.detail?.is_error) continue;
    if (runId !== undefined && event.detail?.run_id !== runId) continue;
    const id = event.detail?.published_object_id;
    if (typeof id !== 'string' || !id) continue;
    const type = event.detail?.published_object_type;
    return { id, ...(typeof type === 'string' && type ? { type } : {}) };
  }
  return undefined;
}

export const TOOL_LABELS: Record<string, string> = {
  get_object: 'Read an object',
  get_contract: 'Check what an object allows',
  list_objects: 'Browse objects',
  inventory: 'Browse the publication',
  validate: 'Check readiness',
  search_artifacts: 'Find media',
  checkout: 'Start editing',
  patch: 'Update an object',
  checkin: 'Finish editing',
  refresh_lock: 'Keep editing access',
  create_object: 'Create an object',
  create_variant: 'Create a variant',
  instantiate_template: 'Create a page from a template',
  instantiate_section_template: 'Create a section from a template',
  submit_review: 'Send for review',
  publish: 'Publish',
  discard: 'Discard changes',
  apply_theme: 'Apply a theme',
  // Legacy event names remain readable in persisted chat history.
  object_get: 'Read an object',
  object_validate: 'Check readiness',
};

/** Shared human vocabulary for chat activity, guardrails, and tool controls. */
export const toolLabelForName = (tool: string): string => TOOL_LABELS[tool] ?? 'Tool action';

export function toolLabel(event: ChatEventView): string {
  const tool = String(event.detail?.tool ?? 'tool');
  return String(event.detail?.summary ?? toolLabelForName(tool));
}

/**
 * E1: whether `NODE_LABELS` (`request-logic.ts`, the ONE source of these
 * gerunds) actually recognises a node id. `nodeLabel()` itself falls back to
 * the raw node id for an unknown one — right for the request list, which
 * would rather show something than nothing (its own doc comment says so) —
 * but that fallback is exactly the "invented" state guardrail 5 rules out
 * for a narrated sentence: a raw id like `capture_score` is not a step name
 * we can prove. So this checks membership first and only calls through to
 * `nodeLabel` once the label is real; an unknown/absent node gets
 * `undefined`, and callers fall back to their own existing wording.
 *
 * `NODE_LABELS` stores these lower-case for mid-sentence embedding (e.g.
 * `progressPhrase`'s "14 / 23 · drafting"); here the label OPENS a sentence
 * ("Drafting — step 14 of 23", the chip's own standalone label), so it gets
 * the same sentence-case lift `server/lib/requests/activity.ts`'s
 * `runningLabel` already does for the identical reason — not a second
 * gerund list, just capitalising the one that exists.
 */
export const knownNodeLabel = (node: string | undefined): string | undefined => {
  if (node === undefined || !(node in NODE_LABELS)) return undefined;
  const label = nodeLabel(node)!;
  return label.charAt(0).toUpperCase() + label.slice(1);
};

// ─── request_progress (W19) ────────────────────────────────────────────────

/**
 * Editor-facing copy for one `request_progress` event (`sweep.ts`'s
 * `progressDetail`, appended by the sweeper on every status transition).
 *
 * Before this existed, `chat.tsx` had no dedicated renderer for the type and
 * fell through to the generic `<ToolCallCard>`, which reads `event.detail.
 * tool`/`is_error` — fields this event never carries — so it always rendered
 * `severity: 'ok'` (a green check) no matter what the sweeper had just
 * written, including `failed`. Severity here instead goes through
 * `requestSeverityLevel`, the SAME map `/admin/requests` colours its rows
 * with, so the inline line and the request list can never disagree about
 * what red means.
 *
 * Task B: when the transition is `failed`, the first blocker carries
 * CMS-Agent's own structured detail where CMS-Agent supplied one (a
 * classified provider error or its own `budget_exceeded` guard) —
 * `derive-status.ts`'s `failedNodeBlockers` reads it off `node.output.error`.
 * Routed through the SAME `cmsAgentErrorCopy` function `run_error` and
 * `RequestActivity`'s node detail already use, so the code/message/
 * operatorAction sentence reads identically wherever a failure shows up.
 */
export interface RequestProgressCopy {
  status: RequestStatusName;
  level: AdminSeverity;
  label: string;
  /** "done/total", when the sweeper's snapshot carries both. */
  progress?: string;
  /** The sweeper's own status_reason, verbatim — shown when there is no structured failure to prefer instead. */
  summary?: string;
  /** Only for a `failed` transition whose first blocker parses as CMS-Agent's structured detail. */
  failure?: CmsAgentErrorCopy;
  /**
   * E1: "{NodeLabel} — step {done} of {total}", replacing the generic
   * `label`/`progress` pair while the run is actively moving (`running`)
   * and the sweeper named a node (`detail.node`, `sweep.ts`) that
   * `NODE_LABELS` recognises. `undefined` whenever the node is absent or
   * unrecognised, or the transition isn't `running` — a finished/failed
   * transition keeps stating its status word, not the step it happened to
   * be on — so the renderer falls back to today's `label`/`progress`
   * ("Working 12/23") rather than ever showing a raw node id (guardrail 5).
   */
  stepLine?: string;
}

export function requestProgressCopy(detail: Record<string, unknown> | undefined, isOwner: boolean): RequestProgressCopy {
  const status = (typeof detail?.status === 'string' ? detail.status : 'running') as RequestStatusName;
  const summary = typeof detail?.summary === 'string' ? detail.summary : undefined;
  const done = typeof detail?.done === 'number' ? detail.done : undefined;
  const total = typeof detail?.total === 'number' ? detail.total : undefined;
  const blockers = Array.isArray(detail?.blockers) ? detail.blockers : [];
  const firstBlocker = blockers.find((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null);
  const blockerCode = typeof firstBlocker?.code === 'string' ? firstBlocker.code : undefined;
  const blockerMessage = typeof firstBlocker?.message === 'string' ? firstBlocker.message : undefined;
  const operatorAction = typeof firstBlocker?.operator_action === 'string' ? firstBlocker.operator_action : undefined;
  const failure =
    status === 'failed' && blockerCode && blockerMessage
      ? cmsAgentErrorCopy(
          {
            code: blockerCode,
            message: blockerMessage,
            ...(operatorAction ? { operatorAction } : {}),
            // This blocker is already CMS-Agent's own parsed detail (never a
            // network/timeout ambiguity — that layer is CMS-Agent's problem),
            // so the "no JSON body" fallback text must never show here.
            fromJsonBody: true,
          },
          { isOwner }
        )
      : undefined;
  // E1: narrate the CURRENT STEP, not just its position — but only while
  // there is a current step to narrate. `sweep.ts` stamps `detail.node` on
  // every transition, but "drafting — step 14 of 23" only makes sense for
  // the live `running` line; a `failed`/`done` transition already states
  // its own outcome word above (`label`) and restating the node it happened
  // to stop on there would blur "what happened" with "where it was".
  const node = typeof detail?.node === 'string' ? detail.node : undefined;
  const stepLabel = status === 'running' ? knownNodeLabel(node) : undefined;
  const stepLine = stepLabel && done !== undefined && total !== undefined ? `${stepLabel} — step ${done} of ${total}` : undefined;
  return {
    status,
    level: requestSeverityLevel(status),
    label: requestStatusLabel(status),
    ...(done !== undefined && total !== undefined ? { progress: `${done}/${total}` } : {}),
    ...(summary ? { summary } : {}),
    ...(failure ? { failure } : {}),
    ...(stepLine ? { stepLine } : {}),
  };
}
