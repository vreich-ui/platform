import type { ChatSummaryView } from './chat-client.js';
import type { LibraryRow } from './library-logic.js';

export interface WorkSummary {
  working: ChatSummaryView[];
  needsYouChats: ChatSummaryView[];
  pendingReviews: LibraryRow[];
  workingCount: number;
  needsYouCount: number;
}

export function getWorkSummary(rows: readonly LibraryRow[], chats: readonly ChatSummaryView[]): WorkSummary {
  const working = chats.filter((chat) => chat.status === 'queued' || chat.status === 'running');
  const needsYouChats = chats.filter(
    (chat) => chat.status === 'awaiting_approval' || chat.status === 'awaiting_candidate' || chat.status === 'error'
  );
  const chatObjectIds = new Set(needsYouChats.map((chat) => chat.object_id).filter(Boolean));
  const pendingReviews = rows.filter((row) => row.review_state === 'open' && !chatObjectIds.has(row.object_id));
  return {
    working,
    needsYouChats,
    pendingReviews,
    workingCount: working.length,
    needsYouCount: needsYouChats.length + pendingReviews.length,
  };
}

/** Reads only `status`, so any live-run summary can label itself — including the trimmed one `admin-editorial-view` returns (T5.1). */
export const chatWorkLabel = (chat: Pick<ChatSummaryView, 'status'>): string => {
  if (chat.status === 'awaiting_candidate') return 'Ready to review';
  if (chat.status === 'awaiting_approval') return 'Waiting for you';
  if (chat.status === 'error') return 'Failed';
  return chat.status === 'queued' ? 'Starting' : 'Working';
};
