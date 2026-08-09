import type { ChatEventView } from './chat-client.js';

export type ChatTimelineItem = { kind: 'event'; event: ChatEventView } | { kind: 'activity'; events: ChatEventView[] };

const QUIET_TOOL_EVENTS = new Set(['tool_call', 'tool_result']);

export function groupChatEvents(events: readonly ChatEventView[]): ChatTimelineItem[] {
  const grouped: ChatTimelineItem[] = [];
  let activity: ChatEventView[] = [];
  const flush = () => {
    if (activity.length) grouped.push({ kind: 'activity', events: activity });
    activity = [];
  };
  for (const event of events) {
    if (QUIET_TOOL_EVENTS.has(event.type) && !event.detail?.is_error) activity.push(event);
    else {
      flush();
      grouped.push({ kind: 'event', event });
    }
  }
  flush();
  return grouped;
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
