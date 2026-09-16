/**
 * M3.1 — the READ half of `snapshots/chats.json`: the row the Agents hub
 * renders, the vocabulary a row and a chat document share, and the ONE blob
 * read that fetches the list.
 *
 * `list_chats` read EVERY chat document — the whole event log, up to
 * `EVENTS_MAX` entries each — for an eight-field summary per chat. Measured
 * 3.8 s (`work=3447`). `chat-store.ts` already named the fix: "a
 * `chats/index.json` summary doc (the `requests/index.json` pattern)".
 *
 * The row is what the CLIENT renders (`admin-agent-chat.ts`'s `chatSummary`)
 * plus `created_by`, which never reaches the wire but decides whose chats a
 * caller may see. Two fields stay OUT and are re-derived per read, for the
 * reason `release/snapshot-view.ts` re-derives `deploy.state`: `starter_chips`
 * is a pure function of `object_type` through `buildObjectContract`, so
 * storing it would freeze a contract a deploy can change and multiply the blob
 * by the chip list; the `agent` view is two constants around one stored string.
 *
 * The three shared schemas live HERE, not in `chat-store.ts`, because a row
 * and a document must agree about them and this is the leaf of the two.
 * Defining them there would make the graph a cycle — `chat-store` ->
 * `chat-snapshot-store` -> `chat-store` — with a zod schema evaluated inside
 * it, which is a module-init crash rather than a type error.
 */
import { z } from 'zod';

import {
  readBlobWithEtag,
  trustedGuardedDoc,
  type GuardedDocReadStore,
} from '../snapshots/guarded-doc.js';

/** An object chat is bound to one object and named by it; a free chat is not. */
export const chatKindSchema = z.enum(['object', 'free']);
export type ChatKind = z.infer<typeof chatKindSchema>;

export const chatStatusSchema = z.enum([
  'idle',
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_candidate',
  /**
   * D6 — the chat is waiting on a human to clear a blockage. A sibling of
   * awaiting_approval/awaiting_candidate and written by the same single-writer
   * rule: only a path that HOLDS the doc sets it, and only resolve/cancel
   * clears it. Schema-additive; no pre-existing doc carries it.
   */
  'awaiting_blockage_resolution',
  'error',
  'cancelled',
]);
export type ChatStatus = z.infer<typeof chatStatusSchema>;

export const runSummarySchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  outcome: z.enum(['completed', 'error', 'cancelled', 'caps']),
  /** Human outcome chips for the hub list ("created X", "published Y"). */
  chips: z.array(z.string()),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const CHAT_SNAPSHOT_KEY = 'snapshots/chats.json';
export const CHAT_SNAPSHOT_SCHEMA_VERSION = 'chat-list-snapshot.v1';

export const chatSnapshotRowSchema = z.object({
  chat_id: z.string(),
  kind: chatKindSchema,
  object_type: z.string().optional(),
  object_id: z.string().optional(),
  title: z.string(),
  status: chatStatusSchema,
  updated_at: z.string(),
  /**
   * Never on the wire. The visibility rule (`visibleChatDocs`) is "your own
   * chats unless you are an Owner asking for all", and it was applied to the
   * DOCUMENTS; applying it to the snapshot needs the same field, so the row
   * carries it and every caller filters before it projects.
   */
  created_by: z.string(),
  last_outcome: runSummarySchema.nullable(),
  /** `run.agent_ref` — the versioned CMS-Agent ref, absent until one resolves. */
  agent_ref: z.string().optional(),
});
export type ChatSnapshotRow = z.infer<typeof chatSnapshotRowSchema>;

export const chatSnapshotSchema = z.object({
  schema_version: z.literal(CHAT_SNAPSHOT_SCHEMA_VERSION),
  as_of: z.string(),
  seq: z.number().int().nonnegative(),
  /** Sticky "this list is known to be short a row". See `snapshots/guarded-doc.ts`. */
  armed: z.boolean().optional(),
  chats: z.array(chatSnapshotRowSchema),
});
export type ChatSnapshot = z.infer<typeof chatSnapshotSchema>;

/** The rowless form an arm and a re-arm write. Schema-valid and untrustworthy by construction. */
export const emptyChatSnapshot = (seq: number, asOf: string): ChatSnapshot => ({
  schema_version: CHAT_SNAPSHOT_SCHEMA_VERSION,
  as_of: asOf,
  seq,
  chats: [],
});

/** The hub's order: most recently touched first, then by id so it is total. */
export const compareChatRows = (a: ChatSnapshotRow, b: ChatSnapshotRow): number =>
  b.updated_at.localeCompare(a.updated_at) || a.chat_id.localeCompare(b.chat_id);

/**
 * THE READ. One blob read. `undefined` means "rebuild from the transcripts" —
 * absent, unreadable, unparseable, written by another schema version, or
 * armed, which are one answer as far as a caller is concerned.
 */
export const readChatSnapshot = async (store: GuardedDocReadStore): Promise<ChatSnapshot | undefined> => {
  const { raw } = await readBlobWithEtag(store, CHAT_SNAPSHOT_KEY);
  return trustedGuardedDoc(raw, chatSnapshotSchema);
};
