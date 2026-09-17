/**
 * Who may see which chat.
 *
 * M3.1 made this generic over the SHAPE. It used to take `ChatDoc[]`, because
 * the list path had just read every document; it now also runs over
 * `ChatSnapshotRow[]` from `snapshots/chats.json`. The rule is unchanged and
 * lives in one place — a caller that scoped rows differently from documents
 * would be a way to leak someone else's conversation.
 */
export const visibleChatDocs = <T extends { created_by: string }>(
  docs: readonly T[],
  callerEmail: string,
  includeAll: boolean,
  owner: boolean
): T[] => {
  if (includeAll && owner) return [...docs];
  const email = callerEmail.trim().toLowerCase();
  return docs.filter((doc) => doc.created_by.trim().toLowerCase() === email);
};
