/**
 * T9.13 — agent chat store (`agent-chats` blob store, strong consistency).
 *
 * One doc per chat: a seq-ordered event log (the client polls
 * `get_chat?since_seq`) plus the CURRENT run's state and a summary trail of
 * finished runs. Concurrency model proven by the T9.12 spike — a single-writer
 * state machine instead of CAS (Netlify Blobs has no compare-and-swap):
 *
 *   idle ─send→ queued ─(one-shot trigger token)→ running ─ask tool→
 *   awaiting_approval ─approve/deny→ queued → … → idle | error | cancelled
 *
 * Every transition has exactly one legal writer: `queued` docs are taken only
 * by the background hop holding the trigger token (consumed on start, so
 * replays and forged POSTs are inert); `running` docs are written only by
 * that hop; `awaiting_approval` docs only by approve/deny/cancel. Stuck
 * queued/running docs (a lost trigger POST or a crashed hop — the two gaps
 * the spike identified) become takeover-able once `updated_at` is older than
 * STALE_RUN_MS.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import { getNetlifyBlobStore } from '../blob-store.js';
import type { SiteBinding } from '../site-binding.js';
import {
  collectBlobListItems,
  mapWithConcurrency,
  STORE_READ_CONCURRENCY,
  type BlobListResponse,
} from '../blob-list.js';
/** M3.1 — the chat LIST costs one blob read; see `chat-snapshot-view.ts`. */
import {
  chatKindSchema,
  chatStatusSchema,
  compareChatRows,
  readChatSnapshot,
  runSummarySchema,
  type ChatSnapshotRow,
} from './chat-snapshot-view.js';
import {
  armChatSnapshotRow,
  chatSnapshotRow,
  commitChatSnapshotRow,
  writeRebuiltChatSnapshot,
} from './chat-snapshot-store.js';

export const AGENT_CHAT_SCHEMA_VERSION = 'agent-chat.v1';

/** A run whose doc hasn't moved for this long may be taken over / cancelled. */
export const STALE_RUN_MS = 15 * 60_000;

/** Event-log bounds: trim to EVENTS_KEEP once EVENTS_MAX is exceeded. */
export const EVENTS_MAX = 800;
export const EVENTS_KEEP = 600;

// ─── neutral transcript (provider adapters map this to wire format) ──────────

export const chatToolCallSchema = z.object({
  id: z.string(),
  name: z.string(),
  args: z.record(z.string(), z.unknown()),
});
export type ChatToolCall = z.infer<typeof chatToolCallSchema>;

export const chatMsgSchema = z.union([
  z.object({ role: z.literal('user'), text: z.string() }),
  z.object({
    role: z.literal('assistant'),
    text: z.string().optional(),
    tool_calls: z.array(chatToolCallSchema).optional(),
  }),
  z.object({
    role: z.literal('tool'),
    tool_call_id: z.string(),
    content: z.string(),
    is_error: z.boolean().optional(),
  }),
]);
export type ChatMsg = z.infer<typeof chatMsgSchema>;

// ─── events ──────────────────────────────────────────────────────────────────

export const chatEventTypeSchema = z.enum([
  'user_message',
  'run_started',
  'assistant_text',
  'candidate_set',
  'candidate_selected',
  'candidate_rejected',
  'tool_call',
  'tool_result',
  'tool_approval_required',
  'tool_approved',
  'tool_denied',
  'run_finished',
  'run_error',
  'run_cancelled',
  /**
   * W19 T19.3: a progress line appended by the editorial-request sweeper, so
   * an editor who reloads sees the history of the job and not only its
   * current state. Schema-additive — pre-W19 docs never carry it.
   */
  'request_progress',
  /**
   * D6 — a wall a human can clear, in the transcript. Two things put one here:
   * a run STARTED FROM THIS CHAT that hit a ceiling/gate, and a run started
   * from a PAGE (the Imagery tab's button) that has no transcript of its own.
   * The second is the point: before this, a button-triggered propose that
   * failed left the chat panel beside it completely empty, so the surface that
   * is meant to be the ledger of what happened knew nothing about it.
   * `detail` carries `{blockage, origin}` — never a tenant path or a run SHA.
   */
  'blockage',
  /** The same wall, cleared — from either surface. `detail`: {blockage_id, remedy_id, by, outcome}. */
  'blockage_resolved',
  /** Historical PF3 event retained so pre-PF5 chat documents still parse. */
  'engine_fallback',
  'events_trimmed',
]);
export const chatEventSchema = z.object({
  seq: z.number().int().positive(),
  at: z.string(),
  type: chatEventTypeSchema,
  detail: z.record(z.string(), z.unknown()).optional(),
});
export type ChatEvent = z.infer<typeof chatEventSchema>;

// ─── run state ───────────────────────────────────────────────────────────────

export const pendingCallSchema = z.object({
  call_id: z.string(),
  tool: z.string(),
  args: z.record(z.string(), z.unknown()),
  /** sha256 of stableStringify(args) at pause time; plain approve re-verifies it. */
  args_hash: z.string(),
  /** Attached dry-run / preview result shown on the ApprovalCard (creation & privileged tools). */
  dry_run: z.record(z.string(), z.unknown()).optional(),
});
export type PendingCall = z.infer<typeof pendingCallSchema>;

/** The dedicated-agent snapshot stamped at send time (§4a): a mid-run
 *  reassignment or profile edit never switches a live run. */
export const runProfileSchema = z.object({
  profile_id: z.string(),
  name: z.string(),
  provider: z.enum(['anthropic', 'openai']),
  model: z.string(),
  avatar_artifact: z.string().optional(),
  system_prompt: z.string(),
});
export type RunProfile = z.infer<typeof runProfileSchema>;

export const toolAutonomySchema = z.enum(['auto', 'ask', 'off']);
export type ToolAutonomy = z.infer<typeof toolAutonomySchema>;

/** Task 3 — which chat-tool registry (agent/tools.ts's curated CHAT_TOOLS vs
 *  agent/generated-tools.ts's GENERATED_CHAT_TOOLS) a run is wired against.
 *  Schema-additive: an in-flight run stamped before this deploy has no
 *  `registry` field and is treated as 'legacy' at every read site
 *  (agent/registry.ts's `runRegistryKind`) — never silently promoted. */
export const registryKindSchema = z.enum(['legacy', 'generated']);
export type RegistryKind = z.infer<typeof registryKindSchema>;

export const pendingCandidateSetSchema = z.object({
  call_id: z.string(),
  run_id: z.string(),
  candidates: z
    .array(
      z.object({
        candidate_id: z.string(),
        label: z.string(),
        content: z.string(),
        self_description: z.string(),
        target: chatToolCallSchema,
      })
    )
    .min(2)
    .max(3),
});
export type PendingCandidateSet = z.infer<typeof pendingCandidateSetSchema>;

export const chatRunSchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  /** Captured server-side from the verified identity at send time — never client-supplied. */
  principal: z.object({ kind: z.literal('human'), id: z.string(), email: z.string() }),
  profile: runProfileSchema,
  /** Autonomy resolved at run start (defaults + governance chat_tools override), frozen for the run. */
  autonomy: z.record(z.string(), toolAutonomySchema),
  /** M2b governance is frozen at send time, exactly like autonomy/profile. */
  learning_mode: z.boolean().default(false),
  /** Human-readable object/section focus supplied by the workspace at send time. */
  focus: z.string().max(500).optional(),
  /** Server-derived: only an Owner who explicitly requested diagnostics may see technical detail. */
  diagnostics_requested: z.boolean().default(false),
  /** PF2 (schema-additive; old docs parse via the default): which TurnEngine
   *  actually reasoned this run — stamped 'cms_agent' by cmsAgentEngine on its
   *  first successful turn, left 'provider' on the legacy path. */
  engine: z.enum(['provider', 'cms_agent']).default('provider'),
  /** PF2 (schema-additive): the resolved CMS-Agent ref (agt_client_manager[@rev]) used for this run. */
  agent_ref: z.string().optional(),
  /** Task 3 (schema-additive): the chat-tool registry stamped at send time —
   *  frozen for the run, exactly like profile/autonomy. Absent on runs
   *  in-flight from before this deploy; treated as 'legacy' (see RegistryKind). */
  registry: registryKindSchema.optional(),
  /** Owner-only test mode, stamped at send time and frozen for the run exactly
   *  like autonomy/profile/registry. Already ANDed with the caller's resolved
   *  roles by the `send` handler, so anything reading it downstream is reading
   *  a decision, not a claim. Schema-additive and OPTIONAL — like `registry`
   *  above — so pre-existing run docs parse unchanged and an ordinary run
   *  carries no key at all. Every read site tests `=== true`. */
  test_mode: z.boolean().optional(),
  /**
   * CHAT-ORIGIN (per-send half). What THIS run is about, stamped at send time
   * and frozen for the run exactly like autonomy/profile/registry — a run is
   * minted per send, so a value here is per-send by construction, and a later
   * send re-derives it rather than inheriting a stale job.
   *
   * NAMED `origin_*`, not `request_id`/`run_id`: `run_id` above is THIS CHAT
   * RUN's own id, and two different `run_id`s on one object is how a reader
   * ends up debugging the wrong run. The wire field names (`context.origin.
   * request_id` / `.run_id`, CMS-Agent's `conversationContract.ts`) are
   * unchanged — `engine.ts` maps these onto them.
   *
   * `origin_request_id` is server-resolved where possible (the editorial
   * request bound to this chat); the browser's value is a fallback hint, and
   * neither is authority for anything — every verb re-derives rights.
   */
  origin_request_id: z.string().max(256).optional(),
  /** The WORKFLOW run the conversation is about (`request.workflow.run_id`), not this chat run. */
  origin_run_id: z.string().max(256).optional(),
  /**
   * The ASV2 dock's selection, when the chat is NOT already object-bound. An
   * object chat sends the pair as `context.object_type`/`object_id` already
   * (engine.ts constraint 7); repeating it as a "selection" would tell Client
   * Manager the editor had picked something new when they had not.
   */
  origin_selection: z.object({ object_type: z.string().max(128), object_id: z.string().max(256) }).optional(),
  /**
   * PCL-P4: the starter chip key this turn's opening text still traces back
   * to, when it does — stamped at send time like the rest of this family,
   * because (unlike `ChatDoc.origin_starter` below) a chip can be clicked on
   * any send while the transcript is still empty, not only at chat creation.
   * `engine.ts`'s `buildTurnOrigin` prefers this over the doc-level field.
   */
  origin_starter: z.string().max(64).optional(),
  trigger_token: z.string().optional(),
  transcript: z.array(chatMsgSchema),
  call_queue: z.array(chatToolCallSchema),
  pending: pendingCallSchema.optional(),
  /** Fix 1 (schema-additive): the approver's decision on the pending call,
   *  stamped by `approvePendingTool` and consumed by the NEXT background hop
   *  — execution itself never happens inline in the interactive function
   *  (long operational tools would blow the ~10s invocation cap before
   *  `saveChatDoc` runs). `args` is present ONLY for edit-and-approve (the
   *  human's replacement args); otherwise the hop uses the queued call's own
   *  args. A stale marker whose call_id no longer heads `call_queue` (crashed
   *  hop) is cleared at the next hop's start without effect. */
  approved_call: z
    .object({
      call_id: z.string(),
      /** Approver email. */
      by: z.string(),
      args: z.record(z.string(), z.unknown()).optional(),
      edited: z.boolean().optional(),
    })
    .optional(),
  candidate_selection: pendingCandidateSetSchema.optional(),
  preference_context: z
    .object({
      event_key: z.string(),
      chosen_candidate_id: z.string(),
      target_call_id: z.string(),
      chosen_args: z.record(z.string(), z.unknown()),
    })
    .optional(),
  cancel_requested: z.boolean().optional(),
  provider_turns: z.number().int().nonnegative(),
  tool_calls_used: z.number().int().nonnegative(),
  output_tokens_used: z.number().int().nonnegative(),
});
export type ChatRun = z.infer<typeof chatRunSchema>;

/** Defined in `chat-snapshot-view.ts` (the leaf); re-exported so every existing import of this module still resolves. */
export { chatKindSchema, chatStatusSchema, runSummarySchema, type RunSummary } from './chat-snapshot-view.js';

// ─── the chat doc ────────────────────────────────────────────────────────────

export const chatDocSchema = z.object({
  schema_version: z.literal(AGENT_CHAT_SCHEMA_VERSION),
  chat_id: z.string(),
  kind: chatKindSchema,
  object_type: z.string().optional(),
  object_id: z.string().optional(),
  title: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  /**
   * CHAT-ORIGIN (creation half). WHERE this conversation was opened — the
   * route-derived surface slug (`lib/admin/chat-origin.ts`) and, when a hub
   * starter seeded it, that starter's key.
   *
   * SET ONCE, AT `create_chat`, AND IMMUTABLE. A chat is opened from one
   * place; a later send from another tab does not rewrite where it began, and
   * an object chat's id is derived from the object (so `create_chat` is
   * idempotent and the SECOND caller's surface is simply not the origin).
   *
   * Schema-additive and optional: every chat doc written before this deploy
   * parses unchanged and sends no `origin.surface` (see `engine.ts`).
   */
  origin_surface: z.string().max(64).optional(),
  origin_starter: z.string().max(64).optional(),
  status: chatStatusSchema,
  seq: z.number().int().nonnegative(),
  events: z.array(chatEventSchema),
  run: chatRunSchema.optional(),
  /**
   * The wall this chat is currently waiting on. ON THE DOC, not on `run`,
   * deliberately: a page-origin blockage (the Imagery button, D6) has no chat
   * run at all, and putting it on `run` would mean the panel could only ever
   * show walls it had caused itself — which is the gap this closes.
   *
   * The blockage is stored as the engine minted it (`blockage.v1`), unvalidated
   * by zod beyond "an object": the shape is CMS-Agent's contract, `parseBlockage`
   * is where it is checked, and a schema copy here would be a second definition
   * to drift.
   */
  pending_blockage: z
    .object({
      blockage: z.record(z.string(), z.unknown()),
      origin: z.enum(['page', 'chat']),
      at: z.string(),
      /** The chat run that hit it, when a chat run did. */
      run_id: z.string().optional(),
    })
    .optional(),
  runs: z.array(runSummarySchema),
});
export type ChatDoc = z.infer<typeof chatDocSchema>;

export interface AgentChatStore {
  get(key: string): Promise<string | null>;
  /** M3.1 — optional: the only source of a CAS token (`snapshots/guarded-doc.ts`). */
  getWithMetadata?(
    key: string,
    options?: { type?: 'text' }
  ): Promise<{ data: unknown; etag?: string } | null | undefined>;
  setJSON(
    key: string,
    value: unknown,
    options?: { onlyIfNew?: true; onlyIfMatch?: string }
  ): Promise<void | { modified: boolean; etag?: string }>;
  list(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
}

const KEY_PREFIX = 'chats/by-id/';
/** Blob keys keep `:`-free names; chat ids keep the `obj:<objectId>` convention. */
export const chatDocKey = (chatId: string) => `${KEY_PREFIX}${chatId.replaceAll(':', '__')}.json`;

export const objectChatId = (objectId: string) => `obj:${objectId}`;
export const mintFreeChatId = () => `chat_${randomUUID().replaceAll('-', '').slice(0, 20)}`;

export const loadChatDoc = async (store: AgentChatStore, chatId: string): Promise<ChatDoc | undefined> => {
  const raw = await store.get(chatDocKey(chatId));
  if (!raw) return undefined;
  return chatDocSchema.parse(JSON.parse(raw));
};

/**
 * THE chat-document writer, and — since M3.1 — what keeps
 * `snapshots/chats.json` in step with it. The alarm is armed BEFORE the
 * document is written and disarmed by the commit after, so a crash between
 * leaves a sticky flag rather than a list quietly short a row; a save that does
 * not materially change the row arms nothing (`chat-snapshot-store.ts`).
 * Neither call can fail this write — the document is the truth, the list a
 * cache of it.
 */
export const saveChatDoc = async (store: AgentChatStore, doc: ChatDoc): Promise<void> => {
  const nowMs = Date.now();
  const lease = await armChatSnapshotRow(store, doc, nowMs);
  await store.setJSON(chatDocKey(doc.chat_id), chatDocSchema.parse(doc));
  await commitChatSnapshotRow(store, lease, Date.now());
};

/**
 * List every chat doc (the hub sorts by updated_at). Corrupt docs are skipped.
 *
 * T5.1 R9 (F4): the `store.get()`s used to run one-at-a-time in a serial
 * `for` loop, so a `list_chats` call cost C SEQUENTIAL blob reads — each
 * pulling a whole transcript (up to `EVENTS_MAX` events) to produce an
 * eight-field summary. `mapWithConcurrency` at `STORE_READ_CONCURRENCY` is
 * the same bound `object-verbs.ts`'s inventory sweep already uses, and turns
 * C serial reads into ceil(C/8) parallel batches. It does NOT reduce the
 * NUMBER of reads — the proper fix is a `chats/index.json` summary doc (the
 * `requests/index.json` pattern); this is the one-line first aid T0.2 called
 * for, and the aggregate `admin-editorial-view` avoids the sweep entirely on
 * the surface that paid for it worst.
 *
 * Failure semantics are unchanged: a read or `JSON.parse` that throws still
 * rejects the whole listing, exactly as the serial loop did.
 *
 * M3.1: this is now the REPAIR path, not the list path. `readChatList` below
 * serves the hub from one blob and falls through to here only when that blob
 * cannot be trusted — which is what "the proper fix is a summary doc" above
 * turned into.
 */
export const listChatDocs = async (store: AgentChatStore): Promise<ChatDoc[]> => {
  const items = await collectBlobListItems(
    await store.list({ prefix: KEY_PREFIX, directories: false, paginate: true })
  );
  const raws = await mapWithConcurrency(items, STORE_READ_CONCURRENCY, (blob) => store.get(blob.key));
  const docs: ChatDoc[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    const parsed = chatDocSchema.safeParse(JSON.parse(raw));
    if (parsed.success) docs.push(parsed.data);
  }
  return docs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
};

/**
 * THE LIST. One blob read on the happy path. `rebuilt` reports the repair the
 * way `objects/index-store.ts`'s `stats.rebuilt` does: a missing, unreadable,
 * unparseable, wrong-schema or ARMED snapshot is rebuilt here from the
 * transcripts and written back, so the next caller pays one read again. No
 * migration; a cold tenant pays one sweep, once. Rows come back in hub order
 * and unscoped — `visibleChatDocs` is still the caller's to apply.
 */
export const readChatList = async (
  store: AgentChatStore,
  nowMs: number = Date.now()
): Promise<{ rows: ChatSnapshotRow[]; rebuilt: boolean }> => {
  const snapshot = await readChatSnapshot(store);
  if (snapshot) return { rows: snapshot.chats, rebuilt: false };
  const rows = (await listChatDocs(store)).map(chatSnapshotRow).sort(compareChatRows);
  await writeRebuiltChatSnapshot(store, rows, nowMs);
  return { rows, rebuilt: true };
};

export const appendChatEvent = (
  doc: ChatDoc,
  at: string,
  type: ChatEvent['type'],
  detail?: Record<string, unknown>
): void => {
  doc.seq += 1;
  doc.events.push({ seq: doc.seq, at, type, ...(detail ? { detail } : {}) });
  doc.updated_at = at;
  if (doc.events.length > EVENTS_MAX) {
    const dropped = doc.events.length - EVENTS_KEEP;
    doc.events = doc.events.slice(-EVENTS_KEEP);
    doc.seq += 1;
    doc.events.push({ seq: doc.seq, at, type: 'events_trimmed', detail: { dropped } });
  }
};

/** A queued/running doc whose updated_at is older than STALE_RUN_MS is recoverable. */
export const isRunStale = (doc: ChatDoc, nowMs: number): boolean =>
  (doc.status === 'queued' || doc.status === 'running') && nowMs - Date.parse(doc.updated_at) > STALE_RUN_MS;

export const getAgentChatBlobStore = (event: unknown, binding?: SiteBinding): Promise<AgentChatStore> =>
  getNetlifyBlobStore(
    { name: 'agent-chats', consistency: 'strong' },
    event,
    binding
  ) as unknown as Promise<AgentChatStore>;

// ─── D6: blockages in the transcript ─────────────────────────────────────────

/**
 * Put a wall in front of the human, in this chat.
 *
 * THE STATUS RULE, and why it is conditional. A chat's status has exactly one
 * legal writer per transition (see this module's header). A page-origin
 * blockage arrives from a completely different code path — the Imagery tab's
 * propose endpoint — which holds no claim on this doc and may well arrive while
 * a chat run is mid-flight. So the EVENT is always appended (the transcript is
 * the ledger, and a wall that happened is a fact), but the STATUS only moves
 * when the doc is genuinely idle. A blockage that lands during a live run shows
 * as a transcript entry with its buttons; it does not hijack the run's state.
 *
 * Returns whether the status moved, so a caller can say so honestly.
 */
export const setPendingBlockage = (
  doc: ChatDoc,
  at: string,
  blockage: Record<string, unknown>,
  origin: 'page' | 'chat',
  runId?: string
): { statusChanged: boolean } => {
  doc.pending_blockage = { blockage, origin, at, ...(runId ? { run_id: runId } : {}) };
  appendChatEvent(doc, at, 'blockage', {
    blockage,
    origin,
    ...(runId ? { run_id: runId } : {}),
  });
  const idle = doc.status === 'idle' || doc.status === 'error';
  if (idle) doc.status = 'awaiting_blockage_resolution';
  return { statusChanged: idle };
};

/**
 * The wall is cleared — from EITHER surface (D4). Idempotent by design: called
 * with a blockage_id that is not the pending one (the card resolved it first,
 * and this is the chat catching up) it still writes the receipt, because the
 * transcript should record that it was resolved, and simply does not touch a
 * DIFFERENT pending blockage.
 */
export const resolvePendingBlockage = (
  doc: ChatDoc,
  at: string,
  detail: { blockage_id: string; remedy_id: string; by?: string; outcome: string }
): void => {
  const pendingId = doc.pending_blockage?.blockage?.blockage_id;
  if (pendingId === detail.blockage_id) {
    delete doc.pending_blockage;
    if (doc.status === 'awaiting_blockage_resolution') doc.status = 'idle';
  }
  appendChatEvent(doc, at, 'blockage_resolved', { ...detail });
};

/** The pending wall's id, when there is one — the key every surface resolves by. */
export const pendingBlockageId = (doc: ChatDoc): string | undefined => {
  const id = doc.pending_blockage?.blockage?.blockage_id;
  return typeof id === 'string' ? id : undefined;
};
