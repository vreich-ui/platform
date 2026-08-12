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
  /** PF3: emitted when fallback mode degrades a turn from the CMS-Agent
   *  engine to the provider path — loud by design, never silent. */
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

export const runSummarySchema = z.object({
  run_id: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  outcome: z.enum(['completed', 'error', 'cancelled', 'caps']),
  /** Human outcome chips for the hub list ("created X", "published Y"). */
  chips: z.array(z.string()),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

// ─── the chat doc ────────────────────────────────────────────────────────────

export const chatDocSchema = z.object({
  schema_version: z.literal(AGENT_CHAT_SCHEMA_VERSION),
  chat_id: z.string(),
  kind: z.enum(['object', 'free']),
  object_type: z.string().optional(),
  object_id: z.string().optional(),
  title: z.string(),
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum(['idle', 'queued', 'running', 'awaiting_approval', 'awaiting_candidate', 'error', 'cancelled']),
  seq: z.number().int().nonnegative(),
  events: z.array(chatEventSchema),
  run: chatRunSchema.optional(),
  runs: z.array(runSummarySchema),
});
export type ChatDoc = z.infer<typeof chatDocSchema>;

export interface AgentChatStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<{
    blobs: { key: string }[];
    directories?: string[];
  }>;
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

export const saveChatDoc = async (store: AgentChatStore, doc: ChatDoc): Promise<void> => {
  await store.setJSON(chatDocKey(doc.chat_id), chatDocSchema.parse(doc));
};

/** List every chat doc (corpus is small; the hub sorts by updated_at). Corrupt docs are skipped. */
export const listChatDocs = async (store: AgentChatStore): Promise<ChatDoc[]> => {
  const listed = await store.list({ prefix: KEY_PREFIX, directories: false, paginate: true });
  const docs: ChatDoc[] = [];
  for (const blob of listed.blobs ?? []) {
    const raw = await store.get(blob.key);
    if (!raw) continue;
    const parsed = chatDocSchema.safeParse(JSON.parse(raw));
    if (parsed.success) docs.push(parsed.data);
  }
  return docs.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
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

export const getAgentChatBlobStore = (event: unknown): Promise<AgentChatStore> =>
  getNetlifyBlobStore({ name: 'agent-chats', consistency: 'strong' }, event) as unknown as Promise<AgentChatStore>;
