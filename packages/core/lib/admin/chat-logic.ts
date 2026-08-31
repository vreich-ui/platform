import { classifyToolResult } from './activity-severity.js';
import type { ChatEventView } from './chat-client.js';
import { cmsAgentErrorCopy, type CmsAgentErrorCopy } from './cms-agent-error-copy.js';
import { requestSeverityLevel, requestStatusLabel, type RequestStatusName } from './request-logic.js';
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
    if (QUIET_TOOL_EVENTS.has(event.type) && !isProminentToolResult(event)) activity.push(event);
    else {
      flush();
      grouped.push({ kind: 'event', event });
    }
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
  return {
    status,
    level: requestSeverityLevel(status),
    label: requestStatusLabel(status),
    ...(done !== undefined && total !== undefined ? { progress: `${done}/${total}` } : {}),
    ...(summary ? { summary } : {}),
    ...(failure ? { failure } : {}),
  };
}
