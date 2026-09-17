/**
 * M3.1 — the WRITE half of `snapshots/chats.json`, and the only module in the
 * server tree that names its key (`KEY_HELPERS` in
 * `tests/netlify/object-inventory-index.test.ts` fails the build otherwise).
 * See `chat-snapshot-view.ts` for the row and `snapshots/guarded-doc.ts` for
 * the alarm and the two compare-and-swaps.
 *
 * ## The one thing this snapshot does that M0's and M1's do not
 *
 * It projects `saveChatDoc`, which runs on EVERY step of a run — `loop.ts`
 * persists after each assistant turn, tool call and tool result, so a ten-tool
 * run saves about twenty times. Arming and committing on each would triple the
 * blob traffic of the hottest write path in the admin to keep a list column in
 * sync that nobody is looking at while the run is in flight (the open chat
 * renders from `get_chat`, which reads the document).
 *
 * So an amendment is made only when the ROW MATERIALLY CHANGES: any field but
 * `updated_at` differs — every status transition, the title, the object
 * binding, a run finishing — or `updated_at` moved by more than
 * `CHAT_ROW_TOUCH_TOLERANCE_MS`. What that costs, stated plainly: mid-run the
 * hub's "last active" for that one chat can lag by up to a minute, and its
 * sort position with it. Every transition the hub draws a badge for is exact,
 * because a transition changes `status`, and the save that ENDS a run always
 * commits.
 *
 * The rebuild lives in `chat-store.ts` (it owns the transcript sweep) and
 * calls `writeRebuiltChatSnapshot` here, which keeps the scan true and the
 * import graph acyclic.
 */
import {
  armGuardedDoc,
  commitGuardedDoc,
  readBlobWithEtag,
  writeRebuiltDoc,
  type GuardedDocIo,
  type GuardedDocReadStore,
  type GuardedLease,
  type GuardedWriteGuard,
  type GuardedWriteResult,
} from '../snapshots/guarded-doc.js';
import {
  chatSnapshotSchema,
  compareChatRows,
  emptyChatSnapshot,
  CHAT_SNAPSHOT_KEY,
  CHAT_SNAPSHOT_SCHEMA_VERSION,
  type ChatSnapshot,
  type ChatSnapshotRow,
} from './chat-snapshot-view.js';
import type { ChatDoc } from './chat-store.js';

/** Structural: `AgentChatStore` satisfies it, which keeps the import above type-only. */
export interface ChatSnapshotStore extends GuardedDocReadStore {
  setJSON(key: string, value: unknown, options?: GuardedWriteGuard): Promise<unknown>;
}

/** The one place a chat document becomes a list row. */
export const chatSnapshotRow = (doc: ChatDoc): ChatSnapshotRow => ({
  chat_id: doc.chat_id,
  kind: doc.kind,
  ...(doc.object_type ? { object_type: doc.object_type } : {}),
  ...(doc.object_id ? { object_id: doc.object_id } : {}),
  title: doc.title,
  status: doc.status,
  updated_at: doc.updated_at,
  created_by: doc.created_by,
  last_outcome: doc.runs[doc.runs.length - 1] ?? null,
  ...(doc.run?.agent_ref ? { agent_ref: doc.run.agent_ref } : {}),
});

/** How far `updated_at` may drift before a save is worth a snapshot amendment. See the header. */
export const CHAT_ROW_TOUCH_TOLERANCE_MS = 60_000;

/**
 * REVIEW2 — key-ORDER-independent, and that is load bearing rather than tidy.
 *
 * The two rows this compares are built by different code. `next` comes from
 * `chatSnapshotRow` over a document a caller assembled in memory; `previous`
 * comes out of `snapshots/chats.json` through `chatSnapshotSchema.parse`, and
 * zod rebuilds an object in SCHEMA order whatever order the JSON carried. They
 * agree today only because `runSummarySchema`'s field order happens to match
 * the two `doc.runs.push({ … })` literals in `agent/loop.ts`.
 *
 * A plain `JSON.stringify` compare therefore had a silent failure mode in the
 * wrong direction: reorder those literals, or insert a field in the row builder
 * at a different position from the schema, and every save of every chat looks
 * MATERIAL. The hub stays correct and the damping evaporates — twenty arms and
 * twenty commits per run on the admin's hottest write path, which is the exact
 * cost this module exists to avoid and which no test would fail on. Sorting the
 * keys makes the predicate depend on the values it is actually about.
 */
const stableJson = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    inner && typeof inner === 'object' && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner as Record<string, unknown>).sort(([x], [y]) => x.localeCompare(y)))
      : inner
  );

const sameExceptTouch = (a: ChatSnapshotRow, b: ChatSnapshotRow): boolean =>
  stableJson({ ...a, updated_at: '' }) === stableJson({ ...b, updated_at: '' });

/** Is this save worth an arm and a commit? Pure, so the rule is testable without a store. */
export const chatRowNeedsCommit = (
  previous: ChatSnapshotRow | undefined,
  next: ChatSnapshotRow,
  toleranceMs: number = CHAT_ROW_TOUCH_TOLERANCE_MS
): boolean => {
  if (!previous) return true;
  if (!sameExceptTouch(previous, next)) return true;
  const before = Date.parse(previous.updated_at);
  const after = Date.parse(next.updated_at);
  // An unparseable stamp on either side is not an argument for skipping.
  if (!Number.isFinite(before) || !Number.isFinite(after)) return true;
  return Math.abs(after - before) >= toleranceMs;
};

/** The ONE `.setJSON(CHAT_SNAPSHOT_KEY, …)` in the server tree, and the read that pairs with it. */
const io = (store: ChatSnapshotStore): GuardedDocIo<ChatSnapshot> => ({
  label: CHAT_SNAPSHOT_KEY,
  schema: chatSnapshotSchema,
  empty: emptyChatSnapshot,
  read: () => readBlobWithEtag(store, CHAT_SNAPSHOT_KEY),
  write: (doc, guard) =>
    (guard
      ? store.setJSON(CHAT_SNAPSHOT_KEY, doc, guard)
      : store.setJSON(CHAT_SNAPSHOT_KEY, doc)) as Promise<GuardedWriteResult>,
});

export type ChatSnapshotLease = GuardedLease<ChatSnapshot> & { row: ChatSnapshotRow };

/**
 * Arm before the chat document is written, unless the row this save produces
 * is not materially different from the one already listed. The skip is
 * evaluated inside the arm's own read, so an immaterial save costs ONE blob
 * read and no write.
 */
export const armChatSnapshotRow = async (
  store: ChatSnapshotStore,
  doc: ChatDoc,
  nowMs: number
): Promise<ChatSnapshotLease> => {
  const row = chatSnapshotRow(doc);
  const lease = await armGuardedDoc(io(store), nowMs, {
    skip: (current) =>
      Boolean(current) && !chatRowNeedsCommit(current?.chats.find((entry) => entry.chat_id === row.chat_id), row),
  });
  return { ...lease, row };
};

/** Amend the list with this chat's row and put the alarm down, or do neither. */
export const commitChatSnapshotRow = async (
  store: ChatSnapshotStore,
  lease: ChatSnapshotLease,
  nowMs: number
): Promise<boolean> => {
  if (!lease.armed || !lease.previous) return false;
  const chats = [...lease.previous.chats.filter((entry) => entry.chat_id !== lease.row.chat_id), lease.row].sort(
    compareChatRows
  );
  return commitGuardedDoc(io(store), lease, { ...lease.previous, chats }, nowMs);
};

/** The repair write — only a full transcript sweep may put a sticky alarm down. */
export const writeRebuiltChatSnapshot = async (
  store: ChatSnapshotStore,
  rows: readonly ChatSnapshotRow[],
  nowMs: number
): Promise<boolean> =>
  writeRebuiltDoc(io(store), {
    schema_version: CHAT_SNAPSHOT_SCHEMA_VERSION,
    as_of: new Date(nowMs).toISOString(),
    seq: 0,
    chats: [...rows].sort(compareChatRows),
  });
