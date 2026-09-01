/**
 * T19.1 — editorial request registry (`editorial-requests` blob store, strong
 * consistency; 19-editorial-requests-plan §3).
 *
 * A request is the editorial JOB, not the conversation: one
 * `editorial-request.v1` doc per job under `requests/by-id/<request_id>.json`,
 * plus ONE polled summary doc `requests/index.json` (the F7 fix — one blob GET
 * per list call instead of N). The per-id docs stay authoritative; the index
 * is a projection, regenerable at any time via `rebuildIndex`.
 *
 * Concurrency model — the same discipline `agent/loop.ts` proved, stated
 * honestly. Netlify Blobs has no compare-and-swap, so correctness rests on
 * WRITER ASSIGNMENT (plan §3.4), not on storage atomicity:
 *
 *   - exactly one exported writer per legal transition, and exactly one
 *     component may call each (named on every writer below). There is
 *     deliberately NO general-purpose `saveRequest`;
 *   - every writer loads the current doc immediately before writing, applies
 *     its transition guards, then writes the doc FOLLOWED BY the index in the
 *     same call — an index row is never written without its doc;
 *   - an out-of-order transition (a sweeper write for a request a human just
 *     archived or cancelled, a duplicate chat attach, a re-archive) is a
 *     NO-OP returning the current doc — races are expected, never thrown;
 *   - what is NOT guaranteed: two writers whose load→write windows overlap
 *     can still lose one update (last `setJSON` wins), and interleaved index
 *     writes can leave the index transiently behind the doc. The §3.4
 *     assignment makes overlap rare, strong consistency makes the window
 *     small, and `rebuildIndex` re-converges the index from the docs.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import {
  collectBlobListItems,
  mapWithConcurrency,
  STORE_READ_CONCURRENCY,
  type BlobListResponse,
} from '../blob-list.js';

export const EDITORIAL_REQUEST_SCHEMA_VERSION = 'editorial-request.v1';
export const REQUEST_INDEX_SCHEMA_VERSION = 'editorial-request-index.v1';

/** Same shape as `REQUEST_ID_RE` in agent/tools.ts (`req_<flow>_<topic>_<yyyymmdd>_<nn>`) — keep them consistent. */
export const REQUEST_ID_PATTERN = /^req_[a-z0-9_]+_\d{8}_\d{2}$/;

/** `history` bound: drop-oldest once exceeded (the appendChatEvent discipline, sized for a 23-node run). */
export const HISTORY_MAX = 50;

/** `brief_excerpt` keeps the first ~240 chars of the editor's own words (plan §3.3). */
export const BRIEF_EXCERPT_MAX = 240;

// ─── status ──────────────────────────────────────────────────────────────────

/** Plan §5.1 — the editor-facing status. Order is part of the contract; sibling tasks depend on this exact set. */
export const requestStatusSchema = z.enum([
  'queued',
  'running',
  'needs_you',
  'stalled',
  'failed',
  'done',
  'cancelled',
  'archived',
]);
export type RequestStatus = z.infer<typeof requestStatusSchema>;

/** Statuses no sweeper touches again; the sweeper (T19.3) selects on the complement. */
export const TERMINAL_REQUEST_STATUSES = ['done', 'cancelled', 'archived'] as const satisfies readonly RequestStatus[];
export type TerminalRequestStatus = (typeof TERMINAL_REQUEST_STATUSES)[number];

export const NON_TERMINAL_REQUEST_STATUSES = requestStatusSchema.options.filter(
  (status): status is Exclude<RequestStatus, TerminalRequestStatus> =>
    !(TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(status)
);

// ─── schema (`editorial-request.v1`, plan §3.3) ──────────────────────────────
// Every optional field is genuinely schema-additive: a doc written before a
// later field existed must still parse — no `.default()` anywhere, so a
// round-trip never injects fields the writer did not put there.

export const requestKindSchema = z.enum(['article', 'page', 'section', 'theme', 'media', 'capture', 'other']);
export type RequestKind = z.infer<typeof requestKindSchema>;

export const requestWorkflowSchema = z.object({
  run_id: z.string(),
  workflow_id: z.string(),
  project_id: z.string(),
  node_total: z.number().int().nonnegative(),
  node_done: z.number().int().nonnegative(),
  node_failed: z.number().int().nonnegative(),
  /** Human label, not the raw node id, where one exists. */
  current_node: z.string().optional(),
  stalled: z.boolean(),
  approvals_required: z
    .array(z.object({ node_id: z.string(), reason: z.string(), requested_at: z.string() }))
    .optional(),
  /** `<node>:<code>` verbatim from CMS-Agent. */
  errors: z.array(z.string()).optional(),
  last_polled_at: z.string(),
  /** §5.3 bounded auto-advance counter. */
  nudges: z.number().int().nonnegative(),
});
export type RequestWorkflow = z.infer<typeof requestWorkflowSchema>;

export const requestChatLinkSchema = z.object({
  chat_id: z.string(),
  kind: z.enum(['object', 'free']),
  attached_at: z.string(),
});
export type RequestChatLink = z.infer<typeof requestChatLinkSchema>;

/** `status` is a plain string ON PURPOSE (plan §3.3): a status value added later must not break old docs' parse. */
export const requestHistoryEntrySchema = z.object({
  at: z.string(),
  status: z.string(),
  note: z.string().optional(),
});
export type RequestHistoryEntry = z.infer<typeof requestHistoryEntrySchema>;

export const editorialRequestSchema = z.object({
  schema_version: z.literal(EDITORIAL_REQUEST_SCHEMA_VERSION),
  request_id: z.string().regex(REQUEST_ID_PATTERN, 'request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn>'),
  kind: requestKindSchema,
  /** Human, editable; seeded from the brief. */
  title: z.string(),
  brief_excerpt: z.string().optional(),
  /** E-mail of the human who asked. */
  created_by: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: requestStatusSchema,
  /** One editor-facing sentence; always set for the four unhappy states (enforced by the T19.3 derivation, not here). */
  status_reason: z.string().optional(),
  /** Absent for non-workflow requests (plan D7). */
  workflow: requestWorkflowSchema.optional(),
  chats: z.array(requestChatLinkSchema),
  /** Once the article object exists. */
  object: z
    .object({
      object_type: z.string(),
      object_id: z.string(),
      /**
       * C1: the publish/release tail committed a publish for this object —
       * read from the run's OWN receipts (`publication-evidence.ts`), never
       * inferred from a `done` status. A run can finish without publishing,
       * so absent means "no evidence", which the row reads as not published.
       */
      published: z.boolean().optional(),
      /**
       * `article_path` from the publish receipt, recorded ONLY once the
       * release confirmed production serves it. A path for a publish whose
       * go-live is unconfirmed is a link to a page the site may not have yet,
       * so it is deliberately not stored.
       */
      live_path: z.string().optional(),
    })
    .optional(),
  artifact_count: z.number().int().nonnegative().optional(),
  archived_at: z.string().optional(),
  archived_by: z.string().optional(),
  history: z.array(requestHistoryEntrySchema),
});
export type EditorialRequest = z.infer<typeof editorialRequestSchema>;

// ─── the index (plan §3.2/§3.3) ──────────────────────────────────────────────
// One doc the UI polls. A row carries ONLY the fields named in plan §3.3 plus
// the two C1 added (`object_published`, `live_path`) — nothing else may be
// added without a plan change, because every admin tab polls this blob. The
// field set stays CLOSED: `projectIndexRow` below emits exactly these keys and
// `store.test.ts` asserts the list, so a new doc field cannot widen the index
// by accident.
//
// C1 widened it on purpose. `rowActions` (`lib/admin/request-logic.ts`) has
// read `object_published` since B1 and nothing ever supplied it, so a finished,
// published article offered Publish and a disabled Open object — the row model
// was right and its inputs never arrived.

export const requestIndexRowSchema = z.object({
  request_id: z.string(),
  kind: requestKindSchema,
  title: z.string(),
  status: requestStatusSchema,
  status_reason: z.string().optional(),
  created_by: z.string(),
  updated_at: z.string(),
  progress: z.object({ done: z.number().int().nonnegative(), total: z.number().int().nonnegative() }).optional(),
  current_node: z.string().optional(),
  /** Most recently attached chat. */
  chat_id: z.string().optional(),
  object_id: z.string().optional(),
  /**
   * C1 — whether the run's publish tail actually committed a publish for that
   * object. `.default(false)` and NOT a `REQUEST_INDEX_SCHEMA_VERSION` bump:
   * the field is required in the ROW (a boolean the surface can read without
   * a tri-state dance) but optional on the WIRE, so an index blob written
   * before this change still parses.
   *
   * That matters more than it looks. `loadIndex` answers `undefined` for an
   * unparseable blob, and `commitRequest` treats `undefined` as "no index
   * yet" and writes a fresh one holding only the row it just projected — so a
   * hard schema break would truncate the index to one row on the first write
   * after deploy, and nothing would ever rebuild it. Backward-compatible
   * parsing is what keeps the migration a no-op; the row is re-projected with
   * the real value by the next write or rebuild either way.
   */
  object_published: z.boolean().default(false),
  /** Where the article is live, once the release confirmed it. Absent = no confirmed live URL. */
  live_path: z.string().optional(),
  archived: z.boolean(),
});
export type RequestIndexRow = z.infer<typeof requestIndexRowSchema>;

export const requestIndexSchema = z.object({
  schema_version: z.literal(REQUEST_INDEX_SCHEMA_VERSION),
  /** Monotonic — bumped by every index write, including rebuilds. */
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  rows: z.array(requestIndexRowSchema),
});
export type RequestIndex = z.infer<typeof requestIndexSchema>;

/**
 * THE single place an index row is derived from a doc — every writer and
 * `rebuildIndex` project through here, so a row can never drift from the doc
 * shape it summarizes. The row field set is closed; see requestIndexRowSchema.
 */
export const projectIndexRow = (doc: EditorialRequest): RequestIndexRow => {
  const lastChat = doc.chats[doc.chats.length - 1];
  return {
    request_id: doc.request_id,
    kind: doc.kind,
    title: doc.title,
    status: doc.status,
    ...(doc.status_reason !== undefined ? { status_reason: doc.status_reason } : {}),
    created_by: doc.created_by,
    updated_at: doc.updated_at,
    ...(doc.workflow ? { progress: { done: doc.workflow.node_done, total: doc.workflow.node_total } } : {}),
    ...(doc.workflow?.current_node !== undefined ? { current_node: doc.workflow.current_node } : {}),
    ...(lastChat ? { chat_id: lastChat.chat_id } : {}),
    ...(doc.object ? { object_id: doc.object.object_id } : {}),
    // C1: publication is a fact about an OBJECT, so it can only be true where
    // an object was recorded and the run's receipts proved a publish. No
    // object, or no evidence, is `false` — never "probably" (guardrail 5).
    object_published: doc.object?.published === true,
    ...(doc.object?.live_path ? { live_path: doc.object.live_path } : {}),
    archived: doc.status === 'archived',
  };
};

// ─── store + keys (plan §3.2) ────────────────────────────────────────────────

/** The minimal surface this module needs (mirrors AgentChatStore); `getEditorialRequestsBlobStore` in blob-store.ts satisfies it. */
export interface EditorialRequestStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
  list(options: {
    prefix: string;
    directories?: boolean;
    paginate?: boolean;
  }): BlobListResponse | Promise<BlobListResponse>;
}

const KEY_PREFIX = 'requests/by-id/';
/** Blob keys keep `:`-free names — the chatDocKey escaping rule, applied even though minted ids never carry `:`. */
export const requestDocKey = (requestId: string) => `${KEY_PREFIX}${requestId.replaceAll(':', '__')}.json`;

export const REQUEST_INDEX_KEY = 'requests/index.json';

/**
 * Per-person notification state (plan §6), split across THREE keys by writer.
 *
 * Blob storage has no compare-and-swap, so the fleet's answer to concurrency
 * is that each document has exactly one writing component. These three had one
 * document and three writers — the person's own settings (mute, mail mode),
 * every open tab's delivery ack, and the sweeper's mail ledger — which is a
 * read-modify-write race between components, not within one. A person clicking
 * Mute while their other tab acked a transition could have the mute silently
 * reverted; the sweeper's mail ledger could be clobbered by a tab mid-send and
 * the same e-mail sent twice.
 *
 * One key per writer, and the race is gone:
 *   notify/       — the PERSON's settings. Written only by an explicit click.
 *   notify-seen/  — what the browser has shown. Written only by the ack path.
 *   notify-mailed/— what the mailer has sent. Written only by the sweeper.
 */
const personSlug = (personId: string) => personId.replaceAll(':', '__');
export const notifyStateKey = (personId: string) => `requests/notify/${personSlug(personId)}.json`;
export const notifySeenKey = (personId: string) => `requests/notify-seen/${personSlug(personId)}.json`;
export const notifyMailedKey = (personId: string) => `requests/notify-mailed/${personSlug(personId)}.json`;

// ─── reads ───────────────────────────────────────────────────────────────────

export const loadRequest = async (
  store: EditorialRequestStore,
  requestId: string
): Promise<EditorialRequest | undefined> => {
  const raw = await store.get(requestDocKey(requestId));
  if (!raw) return undefined;
  return editorialRequestSchema.parse(JSON.parse(raw));
};

/** `undefined` when absent OR unparseable — the caller decides whether to `rebuildIndex`. */
export const loadIndex = async (store: EditorialRequestStore): Promise<RequestIndex | undefined> => {
  const raw = await store.get(REQUEST_INDEX_KEY);
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = requestIndexSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

/**
 * The O(N)-blob-reads path — one GET per request doc. Used ONLY by
 * `rebuildIndex` and the T19.10 backfill; no polled surface may call it (the
 * index exists precisely so the shell's 15-second poll costs one GET, F7).
 * Unparseable docs are skipped. Sorted newest-updated first.
 */
export const listRequestDocs = async (store: EditorialRequestStore): Promise<EditorialRequest[]> => {
  const items = await collectBlobListItems(
    await store.list({ prefix: KEY_PREFIX, directories: false, paginate: true })
  );
  const raws = await mapWithConcurrency(items, STORE_READ_CONCURRENCY, (blob) => store.get(blob.key));
  const docs: EditorialRequest[] = [];
  for (const raw of raws) {
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const result = editorialRequestSchema.safeParse(parsed);
    if (result.success) docs.push(result.data);
  }
  return docs.sort(compareDocs);
};

// ─── internal write discipline ───────────────────────────────────────────────

const nowIso = () => new Date().toISOString();

const compareDocs = (a: EditorialRequest, b: EditorialRequest): number =>
  b.updated_at.localeCompare(a.updated_at) || a.request_id.localeCompare(b.request_id);

const compareRows = (a: RequestIndexRow, b: RequestIndexRow): number =>
  b.updated_at.localeCompare(a.updated_at) || a.request_id.localeCompare(b.request_id);

const appendHistory = (doc: EditorialRequest, at: string, status: string, note?: string): void => {
  doc.history.push({ at, status, ...(note !== undefined ? { note } : {}) });
  if (doc.history.length > HISTORY_MAX) doc.history = doc.history.slice(-HISTORY_MAX);
};

/**
 * The one write path: doc first, then the index row projected FROM that exact
 * doc — never the other way around, never one without the other. Both writes
 * are schema-parsed so a malformed doc can never be persisted.
 */
const commitRequest = async (
  store: EditorialRequestStore,
  doc: EditorialRequest,
  at: string
): Promise<EditorialRequest> => {
  await store.setJSON(requestDocKey(doc.request_id), editorialRequestSchema.parse(doc));
  const existing = await loadIndex(store);
  const rows = (existing?.rows ?? []).filter((row) => row.request_id !== doc.request_id);
  rows.push(projectIndexRow(doc));
  const index: RequestIndex = {
    schema_version: REQUEST_INDEX_SCHEMA_VERSION,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: at,
    rows: rows.sort(compareRows),
  };
  await store.setJSON(REQUEST_INDEX_KEY, requestIndexSchema.parse(index));
  return doc;
};

/** A doc a human closed (archived/cancelled) is off-limits to the sweeper's writers. */
const isSweeperLocked = (doc: EditorialRequest): boolean => doc.status === 'archived' || doc.status === 'cancelled';

/** The workflow fields the sweeper may rewrite each poll (a full recomputed snapshot, not a merge). */
export type RequestProgressPatch = {
  node_total: number;
  node_done: number;
  node_failed: number;
  stalled: boolean;
  /** Absent → cleared (the run has no current node any more). */
  current_node?: string;
  /** Absent → cleared. */
  approvals_required?: RequestWorkflow['approvals_required'];
  /** Absent → cleared. */
  errors?: string[];
  /** Absent → PRESERVED — the counter is owned by the §5.3 nudge path, not the poll. */
  nudges?: number;
};

const applyProgressPatch = (workflow: RequestWorkflow, patch: RequestProgressPatch, at: string): RequestWorkflow => ({
  run_id: workflow.run_id,
  workflow_id: workflow.workflow_id,
  project_id: workflow.project_id,
  node_total: patch.node_total,
  node_done: patch.node_done,
  node_failed: patch.node_failed,
  stalled: patch.stalled,
  ...(patch.current_node !== undefined ? { current_node: patch.current_node } : {}),
  ...(patch.approvals_required !== undefined ? { approvals_required: patch.approvals_required } : {}),
  ...(patch.errors !== undefined ? { errors: patch.errors } : {}),
  last_polled_at: at,
  nudges: patch.nudges ?? workflow.nudges,
});

const sameApprovals = (a: RequestWorkflow['approvals_required'], b: RequestWorkflow['approvals_required']): boolean => {
  if (!a || !b) return a === b;
  return (
    a.length === b.length &&
    a.every((item, i) => {
      const other = b[i];
      return (
        Boolean(other) &&
        item.node_id === other?.node_id &&
        item.reason === other?.reason &&
        item.requested_at === other?.requested_at
      );
    })
  );
};

const sameErrors = (a: string[] | undefined, b: string[] | undefined): boolean => {
  if (!a || !b) return a === b;
  return a.length === b.length && a.every((item, i) => item === b[i]);
};

/** True when anything besides `last_polled_at` differs. Field-wise on purpose — a
 *  serialized comparison is key-order sensitive and would turn every heartbeat
 *  into a false "change" (zod's parse emits schema key order, patches emit theirs). */
const workflowChanged = (before: RequestWorkflow, after: RequestWorkflow): boolean =>
  before.node_total !== after.node_total ||
  before.node_done !== after.node_done ||
  before.node_failed !== after.node_failed ||
  before.stalled !== after.stalled ||
  before.current_node !== after.current_node ||
  before.nudges !== after.nudges ||
  !sameApprovals(before.approvals_required, after.approvals_required) ||
  !sameErrors(before.errors, after.errors);

const progressNote = (workflow: RequestWorkflow): string =>
  `progress ${workflow.node_done}/${workflow.node_total}${workflow.current_node ? ` · ${workflow.current_node}` : ''}`;

// ─── writers — one per legal transition (plan §3.4) ──────────────────────────

export type CreateRequestInput = {
  request_id: string;
  kind: RequestKind;
  title: string;
  brief_excerpt?: string;
  created_by: string;
  /** The conversation that started the job, attached at creation. */
  chat?: { chat_id: string; kind: RequestChatLink['kind'] };
  /** Present for workflow-backed requests; counters start at zero. */
  workflow?: { run_id: string; workflow_id: string; project_id: string; node_total?: number };
  object?: { object_type: string; object_id: string };
};

/**
 * Create + first `queued`. WRITER: the chat tool that starts the job
 * (`run_workspace_workflow`, `instantiate_template`, `instantiate_section_template`,
 * `apply_theme`, `create_agent_artifact_job` — plan D7), inside the background
 * hop. Idempotent: an id that already exists is a no-op returning the existing
 * doc (a retried tool call must never clobber a live record).
 */
export const createRequest = async (
  store: EditorialRequestStore,
  input: CreateRequestInput,
  at: string = nowIso()
): Promise<EditorialRequest> => {
  const existing = await loadRequest(store, input.request_id);
  if (existing) return existing;
  const doc: EditorialRequest = {
    schema_version: EDITORIAL_REQUEST_SCHEMA_VERSION,
    request_id: input.request_id,
    kind: input.kind,
    title: input.title,
    ...(input.brief_excerpt !== undefined ? { brief_excerpt: input.brief_excerpt.slice(0, BRIEF_EXCERPT_MAX) } : {}),
    created_by: input.created_by,
    created_at: at,
    updated_at: at,
    status: 'queued',
    ...(input.workflow
      ? {
          workflow: {
            run_id: input.workflow.run_id,
            workflow_id: input.workflow.workflow_id,
            project_id: input.workflow.project_id,
            node_total: input.workflow.node_total ?? 0,
            node_done: 0,
            node_failed: 0,
            stalled: false,
            last_polled_at: at,
            nudges: 0,
          },
        }
      : {}),
    chats: input.chat ? [{ chat_id: input.chat.chat_id, kind: input.chat.kind, attached_at: at }] : [],
    history: [],
  };
  appendHistory(doc, at, 'queued');
  return commitRequest(store, doc, at);
};

/**
 * Workflow progress without a status change. WRITER: the sweeper
 * (`editorial-request-sweep`, T19.3), and only the sweeper. No-ops (returning
 * the current doc) on an archived/cancelled doc and on a doc with no
 * `workflow` block — both are races or misdirected polls, never errors.
 * `last_polled_at` is refreshed on EVERY accepted call (stall detection needs
 * it persisted), but `updated_at` and `history` move only when the progress
 * content actually changed — a pure poll heartbeat must not defeat the
 * §5.2 `updated_at`-based stall input or spam the timeline.
 */
export const recordProgress = async (
  store: EditorialRequestStore,
  requestId: string,
  patch: RequestProgressPatch,
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (isSweeperLocked(doc)) return doc;
  if (!doc.workflow) return doc;
  const next = applyProgressPatch(doc.workflow, patch, at);
  const changed = workflowChanged(doc.workflow, next);
  doc.workflow = next;
  if (changed) {
    doc.updated_at = at;
    appendHistory(doc, at, doc.status, progressNote(next));
  }
  return commitRequest(store, doc, at);
};

/** The statuses the sweeper's derivation (§5.1) may write. `cancelled` and `archived` have their own writers below. */
export type SweeperRequestStatus = Exclude<RequestStatus, 'cancelled' | 'archived'>;

/**
 * Status transition. WRITER: the sweeper (T19.3), and only the sweeper, from
 * the pure §5.1 derivation. No-ops (returning the current doc) on an
 * archived/cancelled doc — a human closed it while the sweeper was mid-poll —
 * and when nothing would change; a no-op writes NOTHING (unlike
 * recordProgress, this is not the heartbeat path). `status_reason` is
 * replaced wholesale on a status change (so a stale unhappy-state reason
 * never survives into a happy state) and only updated-if-provided otherwise.
 * An optional workflow snapshot lands in the same write so a transition and
 * its evidence are one blob write.
 */
export const setStatus = async (
  store: EditorialRequestStore,
  requestId: string,
  next: { status: SweeperRequestStatus; status_reason?: string; workflow?: RequestProgressPatch },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (isSweeperLocked(doc)) return doc;
  // Runtime guard mirroring the type: untyped callers must not smuggle human-owned statuses through here.
  if ((next.status as RequestStatus) === 'cancelled' || (next.status as RequestStatus) === 'archived') return doc;

  const statusChanged = doc.status !== next.status;
  const nextReason = statusChanged ? next.status_reason : (next.status_reason ?? doc.status_reason);
  const reasonChanged = nextReason !== doc.status_reason;
  const nextWorkflow = doc.workflow && next.workflow ? applyProgressPatch(doc.workflow, next.workflow, at) : undefined;
  const progressChanged = Boolean(doc.workflow && nextWorkflow && workflowChanged(doc.workflow, nextWorkflow));
  if (!statusChanged && !reasonChanged && !progressChanged) return doc;

  doc.status = next.status;
  if (nextReason !== undefined) doc.status_reason = nextReason;
  else delete doc.status_reason;
  if (nextWorkflow) doc.workflow = nextWorkflow;
  doc.updated_at = at;
  appendHistory(
    doc,
    at,
    next.status,
    nextReason ?? (progressChanged && nextWorkflow ? progressNote(nextWorkflow) : undefined)
  );
  return commitRequest(store, doc, at);
};

/**
 * Record the object a workflow produced. WRITER: the sweeper, when it first
 * sees the run name a `content_item`.
 *
 * Without this the Requests list can show a finished article but not open it —
 * `object_id` was in the schema and the row projection from day one, and
 * nothing ever set it. Idempotent, and never overwrites an object already
 * recorded: the first one a run produced is the one the request is about.
 *
 * FIX 6 — refuses a TERMINAL doc, which is the exact mirror of
 * `reconcileObject` below (which refuses everything that is NOT terminal).
 * That pair of guards is what actually makes the "two doors, disjoint
 * windows" claim true. It was only ever asserted in a comment: this function
 * had no guard at all, and `sweepRequest` called it AFTER the write that made
 * the doc `done` — so on that one pass both writers were live on the same doc,
 * with no compare-and-set under them, and a stale read here could erase a
 * publication the other had just recorded. The sweeper now records the object
 * BEFORE the status transition, while the doc is still its own.
 */
export const recordObject = async (
  store: EditorialRequestStore,
  requestId: string,
  object: { object_type: string; object_id: string },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if ((TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(doc.status)) return doc;
  if (doc.object) return doc;
  doc.object = object;
  doc.updated_at = at;
  appendHistory(doc, at, doc.status, `produced ${object.object_id}`);
  return commitRequest(store, doc, at);
};

/**
 * C2 — attach the object a TERMINAL run produced to a doc that never recorded
 * it. WRITER: the request registry's read path (`admin-requests.ts`), and only
 * for a request the sweeper has already finished with.
 *
 * Why a second writer for the same field as `recordObject`: that one refuses a
 * TERMINAL doc and this one refuses everything else, so the two windows cannot
 * overlap and §3.4's one-writer rule holds even though the field has two
 * doors. FIX 6 made that mutual — `recordObject` carries the mirror guard now,
 * and the sweeper does its object writes before the status transition rather
 * than after it. Before, the claim was a comment the code did not hold.
 *
 * It is a RECONCILIATION, not a transition. `updated_at` does not move and no
 * history line is appended: the object has existed since the run made it, so
 * stamping "produced X" with today's date would be a lie about when, and
 * bumping `updated_at` would jump a months-old row to the top of the inbox the
 * first time a poll noticed. Idempotent — a doc that already has an object
 * writes nothing.
 */
export const reconcileObject = async (
  store: EditorialRequestStore,
  requestId: string,
  object: { object_type: string; object_id: string; published?: boolean },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (!(TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(doc.status)) return doc;
  const existing = doc.object;
  // C2b: C1's sweeper-derived evidence is the PRIMARY source and always wins.
  // A doc whose `published` the sweeper already answered is closed to this
  // path — the object record is a fallback for docs that hold no evidence at
  // all (every run that finished before C1 shipped), never a second opinion
  // that can contradict the run's own receipts.
  if (existing?.published !== undefined) return doc;
  const next: NonNullable<EditorialRequest['object']> = {
    object_type: existing?.object_type ?? object.object_type,
    object_id: existing?.object_id ?? object.object_id,
    ...(object.published ? { published: true } : {}),
    // FIX 1: never a `live_path`. This path's evidence is an object record,
    // which can prove a publish and NEVER a go-live (`object-publish.ts`
    // commits the export with `[skip netlify]`), and `live_path` means
    // release-confirmed — see the field's own comment on the schema above.
    // The row reads published with View live disabled and `NO_LIVE_PATH`.
  };
  // Idempotent: a record that proves nothing new leaves the doc, and the
  // index, exactly as they were.
  if (existing && JSON.stringify(existing) === JSON.stringify(next)) return doc;
  doc.object = next;
  return commitRequest(store, doc, at);
};

/**
 * C1 — record that the run PUBLISHED the object it produced, and where the
 * article is live. WRITER: the sweeper, from `publication-evidence.ts`'s
 * reading of the publish/release executors' own receipts.
 *
 * FIX 6: like `recordObject`, this is a SWEEPER write and runs before the
 * status transition, so it never lands on a terminal doc that the read path's
 * `reconcileObject` could be writing at the same moment.
 *
 * Publication is a fact about an object, so a doc with no `object` is a no-op:
 * this never conjures the object the claim would be about. `live_path` is only
 * ever handed in for a CONFIRMED go-live (see the field's comment on the
 * schema), and a second pass with nothing new to say writes nothing — the
 * sweeper calls this on every pass once a run's publish tail has settled.
 */
export const recordPublication = async (
  store: EditorialRequestStore,
  requestId: string,
  publication: { live_path?: string },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (!doc.object) return doc;
  const nextPath = publication.live_path ?? doc.object.live_path;
  if (doc.object.published === true && nextPath === doc.object.live_path) return doc;
  doc.object = { ...doc.object, published: true, ...(nextPath !== undefined ? { live_path: nextPath } : {}) };
  doc.updated_at = at;
  appendHistory(doc, at, doc.status, nextPath ? `published — live at ${nextPath}` : 'published');
  return commitRequest(store, doc, at);
};

/**
 * Chat attach. WRITER: the chat send path, when a chat first references a
 * request (T19.5). A chat_id already attached is a no-op returning the
 * current doc — attach is idempotent by design, since every send re-asserts
 * the link. Attaching to an archived request is legal (people talk about
 * finished work); it does not resurrect the request.
 */
export const attachChat = async (
  store: EditorialRequestStore,
  requestId: string,
  chat: { chat_id: string; kind: RequestChatLink['kind'] },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (doc.chats.some((link) => link.chat_id === chat.chat_id)) return doc;
  doc.chats.push({ chat_id: chat.chat_id, kind: chat.kind, attached_at: at });
  doc.updated_at = at;
  appendHistory(doc, at, doc.status, `chat attached: ${chat.chat_id}`);
  return commitRequest(store, doc, at);
};

/**
 * Archive. WRITER: the archive verb only — an Owner (or `publisher`-tier, W18)
 * through the T19.2 endpoint or the ask-gated `archive_request` tool (T19.8).
 * Archiving never deletes (plan §8): the doc stays, `archived: true` on the
 * row, reachable behind the archived filter. Already archived → no-op
 * returning the current doc.
 */
export const archiveRequest = async (
  store: EditorialRequestStore,
  requestId: string,
  archivedBy: string,
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (doc.status === 'archived') return doc;
  doc.status = 'archived';
  doc.archived_at = at;
  doc.archived_by = archivedBy;
  doc.updated_at = at;
  appendHistory(doc, at, 'archived', `by ${archivedBy}`);
  return commitRequest(store, doc, at);
};

/**
 * Unarchive. WRITER: the archive verb only — same principals as
 * `archiveRequest`. Restores the most recent pre-archive status from
 * `history` (the entry `archiveRequest` appended sits directly after it, so
 * it is present unless 50 post-archive attaches trimmed it away — then the
 * honest fallback is `done`, the neutral terminal state). Not archived →
 * no-op returning the current doc.
 */
export const unarchiveRequest = async (
  store: EditorialRequestStore,
  requestId: string,
  unarchivedBy: string,
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if (doc.status !== 'archived') return doc;
  let restored: RequestStatus = 'done';
  for (let i = doc.history.length - 1; i >= 0; i -= 1) {
    const status = doc.history[i]?.status;
    const parsed = requestStatusSchema.safeParse(status);
    if (parsed.success && parsed.data !== 'archived') {
      restored = parsed.data;
      break;
    }
  }
  doc.status = restored;
  delete doc.archived_at;
  delete doc.archived_by;
  doc.updated_at = at;
  appendHistory(doc, at, restored, `unarchived by ${unarchivedBy}`);
  return commitRequest(store, doc, at);
};

/**
 * Re-open a stopped request so the sweeper will look at it again.
 *
 * WRITER: the human retry path (`retry_request`, and the surface's Retry
 * button). It exists because `failed` is deliberately NOT in the sweeper's
 * selection — a dead run is not polled forever — so clearing the nudge counter
 * alone was a no-op that reported success. Moving the row back to `queued` is
 * what actually puts it in front of the sweeper again.
 *
 * Refuses anything a retry cannot help: a terminal request, and a request
 * waiting on a human (a gate is not a stall; pushing it will not open it).
 */
export const requeueRequest = async (
  store: EditorialRequestStore,
  requestId: string,
  at: string = nowIso()
): Promise<{ ok: true; doc: EditorialRequest } | { ok: false; reason: string; status?: RequestStatus }> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return { ok: false, reason: `No request ${requestId}.` };
  if ((TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(doc.status)) {
    return { ok: false, reason: `This request is ${doc.status}; there is nothing left to retry.`, status: doc.status };
  }
  if (doc.status === 'needs_you') {
    return {
      ok: false,
      reason: 'This request is waiting for a human decision, not stalled — retrying would not open the gate.',
      status: doc.status,
    };
  }
  // `stalled` and `failed` ONLY. A `running` or `queued` request is the
  // sweeper's to write (§3.4 writer assignment); rewriting its status from the
  // human path can land inside a sweep's load→commit window and lose one of
  // the two writes. There is also nothing to retry — a job that is still
  // moving has not stopped.
  if (doc.status !== 'stalled' && doc.status !== 'failed') {
    return {
      ok: false,
      reason: `This request is ${doc.status} — it has not stopped, so there is nothing to retry yet.`,
      status: doc.status,
    };
  }
  if (!doc.workflow?.run_id) {
    return { ok: false, reason: 'This request has no workflow run behind it to retry.', status: doc.status };
  }
  doc.status = 'queued';
  doc.status_reason = 'Retried — waiting for the next sweep to push the run.';
  doc.workflow = { ...doc.workflow, nudges: 0, stalled: false };
  doc.updated_at = at;
  appendHistory(doc, at, 'queued', 'retried by a human');
  return { ok: true, doc: await commitRequest(store, doc, at) };
};

/**
 * Cancel. WRITER: the cancel path only — the request's creator or an Owner
 * (chat cancel, or an explicit request cancel; plan §8). A terminal doc
 * (done/cancelled/archived) is a no-op returning the current doc: there is
 * nothing left to cancel, and a late cancel must never claw back an archive.
 * `status_reason` is always set (plan §5.1's rule for the unhappy states).
 */
export const cancelRequest = async (
  store: EditorialRequestStore,
  requestId: string,
  cancel: { by: string; reason?: string },
  at: string = nowIso()
): Promise<EditorialRequest | undefined> => {
  const doc = await loadRequest(store, requestId);
  if (!doc) return undefined;
  if ((TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(doc.status)) return doc;
  doc.status = 'cancelled';
  doc.status_reason = cancel.reason ?? `Cancelled by ${cancel.by}`;
  doc.updated_at = at;
  appendHistory(doc, at, 'cancelled', doc.status_reason);
  return commitRequest(store, doc, at);
};

// ─── index rebuild ───────────────────────────────────────────────────────────

/**
 * REVIEW FIX (W19): the index is a single blob written read-modify-write, and
 * Netlify Blobs has no compare-and-swap — a human `archive`/`cancel` landing
 * while a sweep pass is committing can lose its index write. For a LIVE status
 * the next pass rewrites the row anyway; for a TERMINAL one the sweeper's own
 * writers refuse to commit, so the stale row would say `running` forever and
 * the request would be polled forever. This is the reconciliation: index-only,
 * projected from the authoritative doc, callable by the sweeper the moment it
 * notices it was handed a request that is already closed.
 */
export const repairIndexRow = async (
  store: EditorialRequestStore,
  doc: EditorialRequest,
  at: string = nowIso()
): Promise<boolean> => {
  const existing = await loadIndex(store);
  const current = existing?.rows.find((row) => row.request_id === doc.request_id);
  const expected = projectIndexRow(doc);
  if (current && JSON.stringify(current) === JSON.stringify(expected)) return false;
  const rows = (existing?.rows ?? []).filter((row) => row.request_id !== doc.request_id);
  rows.push(expected);
  await store.setJSON(
    REQUEST_INDEX_KEY,
    requestIndexSchema.parse({
      schema_version: REQUEST_INDEX_SCHEMA_VERSION,
      seq: (existing?.seq ?? 0) + 1,
      updated_at: at,
      rows: rows.sort(compareRows),
    })
  );
  return true;
};

/**
 * REVIEW FIX (W19): the sweep worker is a Netlify BACKGROUND function, i.e. a
 * public HTTP endpoint, and its side effects are real (up to 200 CMS-Agent
 * reads and `workflow_run_all` nudges per call). It therefore takes the same
 * one-shot trigger token the chat loop uses (`agent/loop.ts`): the scheduled
 * tick mints one into the store and POSTs it; the worker consumes it on start,
 * so a replay, a forged POST, and two overlapping passes are all inert.
 */
export const SWEEP_TOKEN_KEY = 'requests/sweep-token.json';

/** A token older than this is refused even if it was never consumed — a lost POST must not stay usable. */
export const SWEEP_TOKEN_TTL_MS = 10 * 60_000;

const sweepTokenSchema = z.object({ token: z.string().min(1), minted_at: z.string() });

export const mintSweepToken = async (
  store: EditorialRequestStore,
  at: string = nowIso(),
  token: string = randomUUID()
): Promise<string> => {
  await store.setJSON(SWEEP_TOKEN_KEY, sweepTokenSchema.parse({ token, minted_at: at }));
  return token;
};

/** Consumes the token: true exactly once per mint, and only inside the TTL. */
export const consumeSweepToken = async (
  store: EditorialRequestStore,
  token: string,
  nowMs: number = Date.now()
): Promise<boolean> => {
  const raw = await store.get(SWEEP_TOKEN_KEY);
  if (!raw) return false;
  const parsed = sweepTokenSchema.safeParse(JSON.parse(raw));
  if (!parsed.success || parsed.data.token !== token) return false;
  if (nowMs - Date.parse(parsed.data.minted_at) > SWEEP_TOKEN_TTL_MS) return false;
  await store.setJSON(SWEEP_TOKEN_KEY, { token: '', minted_at: parsed.data.minted_at });
  return true;
};

/**
 * Regenerate `requests/index.json` from the per-id docs: list the prefix, get
 * each doc, skip unparseable, project through `projectIndexRow`, sort. Safe
 * to run at any time and idempotent over content (`seq` still bumps — it is a
 * write counter, not a content hash). This is the convergence verb the
 * concurrency model above leans on: whatever interleaving the writers hit,
 * one rebuild puts the index back in lockstep with the docs.
 */
export const rebuildIndex = async (store: EditorialRequestStore, at: string = nowIso()): Promise<RequestIndex> => {
  const docs = await listRequestDocs(store);
  const existing = await loadIndex(store);
  const index: RequestIndex = {
    schema_version: REQUEST_INDEX_SCHEMA_VERSION,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: at,
    rows: docs.map(projectIndexRow).sort(compareRows),
  };
  await store.setJSON(REQUEST_INDEX_KEY, requestIndexSchema.parse(index));
  return index;
};
