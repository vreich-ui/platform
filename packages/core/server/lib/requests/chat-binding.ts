/**
 * W19 T19.5 — which editorial request a chat is talking about.
 *
 * The link already exists and points the right way: `createRequest` records the
 * conversation that started the job in the request's `chats[]`, and the index
 * carries the most recent one per row. So the binding is DERIVED, not stored a
 * second time on the chat doc — one source of truth, no migration, and no
 * write on a read path.
 *
 * Cost discipline: the resolve is one index GET, and callers do it once per
 * chat open (the first `get_chat` poll, and each `send`), never on every 1.2 s
 * poll of a live run.
 */
import { loadIndex, type EditorialRequestStore, type RequestIndexRow } from './store.js';

export const requestRowForChat = async (
  store: EditorialRequestStore,
  chatId: string
): Promise<RequestIndexRow | undefined> => {
  const index = await loadIndex(store);
  if (!index) return undefined;
  return index.rows.find((row) => row.chat_id === chatId);
};

/**
 * The request line composed into the run's `focus` (plan §7.1), so Client
 * Manager knows WHICH job this conversation is about and what state it is in
 * — the thing Wolf asked for when he said the chat manager should be able to
 * "distinguish and start to communicate about a specific req whether it is old
 * or new, running or stale or paused".
 *
 * Bounded to `max` (the wire caps `context.focus` at 500 chars) by dropping
 * the least useful part first: the workspace's own focus, then the brief, then
 * the progress, never the request id or its status.
 */
export const composeRequestFocus = (
  row: Pick<RequestIndexRow, 'request_id' | 'title' | 'status' | 'status_reason' | 'progress' | 'current_node'>,
  workspaceFocus?: string,
  max = 500
): string => {
  const head = `request ${row.request_id} · "${row.title}" · status ${row.status}`;
  const parts = [head];
  if (row.progress && row.progress.total > 0) parts.push(`${row.progress.done}/${row.progress.total} steps`);
  if (row.current_node) parts.push(`at ${row.current_node}`);
  if (row.status_reason) parts.push(row.status_reason);
  if (workspaceFocus) parts.push(workspaceFocus);

  let composed = parts.join(' · ');
  while (composed.length > max && parts.length > 1) {
    parts.pop();
    composed = parts.join(' · ');
  }
  return composed.length > max ? composed.slice(0, max) : composed;
};
