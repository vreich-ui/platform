import { classifyToolResult } from './activity-severity.js';
import type { ChatEventView } from './chat-client.js';

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
