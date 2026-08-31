/**
 * W19 T19.2/T19.4 — pure filtering, sorting, counting and labelling for the
 * request list.
 *
 * Lives in `lib/admin` (browser-safe, no server imports) and is used by BOTH
 * the `admin-requests` endpoint and the `/admin/requests` surface, so the two
 * can never disagree about order: the server sorts, the client does not
 * re-sort (plan §4.1). Typed structurally rather than on the store's row type
 * so neither side has to reach into the other's module.
 */
import { SEVERITY, type AdminSeverity } from './severity.js';

export type RequestStatusName =
  | 'queued'
  | 'running'
  | 'needs_you'
  | 'stalled'
  | 'failed'
  | 'done'
  | 'cancelled'
  | 'archived';

/** The shape both sides share — the index row, structurally. */
export interface RequestRowLike {
  request_id: string;
  kind: string;
  title: string;
  status: RequestStatusName;
  created_by: string;
  updated_at: string;
  archived: boolean;
}

export interface RequestListFilters {
  status?: readonly RequestStatusName[];
  kind?: readonly string[];
  /** Only requests this caller asked for. A view, not a permission (plan §8). */
  mine?: boolean;
  /**
   * `true` → archived only. `false` or absent → active only. "Every request
   * with any status unless archived" is what the surface opens on, so an
   * unset filter must never leak the archive into the desk.
   */
  archived?: boolean;
  /** Free text over title and request id. */
  q?: string;
  callerEmail?: string;
}

/**
 * ⚑ STALLED_VS_FAILED_SPLIT (T2.3) — OPEN QUESTION, WOLF HAS NOT RULED.
 *
 * This file used to merge `stalled` and `failed` into one red count and one
 * red tone — "to an editor they are the same sentence" (the original ruling,
 * kept verbatim below). D4 (T1.1) says red means a step DIED; a `stalled`
 * request has not been declared dead, it has just not moved — that is
 * definitionally still `needs_you` (amber), not `blocked` (red). T0.3
 * (`docs/plan/ux-inventory.md`, Table B row B6 / Table C "Run stalled vs.
 * run failed") flagged the collision and asked for an explicit call rather
 * than a silent inheritance into D4.
 *
 * `true` (current default) — the D4-consistent split this task implements:
 * `stalled` → amber `needs_you`, labelled "Taking longer than expected";
 * `failed` alone → red `blocked`. `requestSeverityLevel`, `requestStatusTone`,
 * `summarizeRequestRows` and the quick-filter tabs below all read this one
 * flag, so there is exactly one place to look.
 *
 * `false` — reverts to the original merged behaviour verbatim. Flip this one
 * constant; nothing else in this file needs to change either way.
 *
 * Original ruling, kept rather than deleted: "to an editor they are the same
 * sentence — 'this one isn't going to finish on its own.'" That framing is
 * still true of what an editor should DO (open it, look), it is D4's icon
 * colour it collides with, not that underlying instinct.
 */
export const STALLED_VS_FAILED_SPLIT = true;

/**
 * A request-row status, mapped onto D4's five-level vocabulary
 * (`@core/lib/admin/severity`). `running`/`queued` are `info` (a fact being
 * reported, nothing to decide yet); `done` is `success`; `cancelled` and
 * `archived` are settled facts with no open question, so they fall outside
 * D4's five active levels entirely — callers treat them as the quiet end of
 * the scale (see `requestStatusTone`, which maps them to `neutral`).
 */
export const requestSeverityLevel = (status: RequestStatusName): AdminSeverity => {
  if (status === 'needs_you') return 'needs_you';
  if (status === 'stalled') return STALLED_VS_FAILED_SPLIT ? 'needs_you' : 'blocked';
  if (status === 'failed') return 'blocked';
  if (status === 'done') return 'success';
  // running, queued, cancelled, archived — a fact, not a decision.
  return 'info';
};

/** Attention-first (plan §4.1): what needs a human, then what broke, then what is live, then the rest. */
export const REQUEST_STATUS_RANK: Record<RequestStatusName, number> = {
  needs_you: 0,
  stalled: 1,
  failed: 2,
  running: 3,
  queued: 4,
  done: 5,
  cancelled: 6,
  archived: 7,
};

export const filterRequestRows = <T extends RequestRowLike>(rows: readonly T[], filters: RequestListFilters): T[] => {
  const wantArchived = filters.archived === true;
  const email = filters.callerEmail?.trim().toLowerCase();
  const needle = filters.q?.trim().toLowerCase();
  return rows.filter((row) => {
    if (row.archived !== wantArchived) return false;
    if (filters.status?.length && !filters.status.includes(row.status)) return false;
    if (filters.kind?.length && !filters.kind.includes(row.kind)) return false;
    if (filters.mine && (!email || row.created_by.trim().toLowerCase() !== email)) return false;
    if (needle && !`${row.title} ${row.request_id}`.toLowerCase().includes(needle)) return false;
    return true;
  });
};

export const sortRequestRows = <T extends RequestRowLike>(rows: readonly T[]): T[] =>
  [...rows].sort((a, b) => {
    const rank = REQUEST_STATUS_RANK[a.status] - REQUEST_STATUS_RANK[b.status];
    return rank !== 0 ? rank : b.updated_at.localeCompare(a.updated_at);
  });

/**
 * B5: the ONE bucket a row falls into — the shell's pill counts, the
 * "Needs you"/"Blocked" quick-filter tabs and (structurally) `requestSeverityLevel`
 * all used to reimplement this same decision separately, which is exactly how a
 * header count and a tab's contents can drift apart (a real bug this closes:
 * the header and the "Needs you" tab must always agree on which rows are
 * which). `archived` rows classify as `'archived'` regardless of status — a
 * caller that has already excluded archived rows (most have) never sees it.
 * `needs_you`/`blocked` still read `STALLED_VS_FAILED_SPLIT` via
 * `requestSeverityLevel`, so flipping that flag moves `stalled` for every
 * consumer of `classifyRow` at once, same as it always has.
 */
export type RequestRowClass = 'needs_you' | 'blocked' | 'active' | 'done' | 'archived';

export const classifyRow = (row: RequestRowLike): RequestRowClass => {
  if (row.archived) return 'archived';
  if (row.status === 'running' || row.status === 'queued') return 'active';
  if (row.status === 'done' || row.status === 'cancelled') return 'done';
  const level = requestSeverityLevel(row.status);
  if (level === 'needs_you') return 'needs_you';
  if (level === 'blocked') return 'blocked';
  // Unreachable given today's RequestStatusName (every status is handled by
  // one of the branches above), but a status the type doesn't yet name must
  // still land somewhere quiet rather than in an attention bucket.
  return 'done';
};

/** Counts for the shell's pills (plan §6.1). Archived rows never count — see `classifyRow`. */
export const summarizeRequestRows = (rows: readonly RequestRowLike[]) => {
  let working = 0;
  let needsYou = 0;
  let blocked = 0;
  for (const row of rows) {
    switch (classifyRow(row)) {
      case 'active':
        working += 1;
        break;
      case 'needs_you':
        needsYou += 1;
        break;
      case 'blocked':
        blocked += 1;
        break;
      default:
        break;
    }
  }
  return { working, needsYou, blocked };
};

/**
 * The tone a status pill takes — derived from `requestSeverityLevel`'s D4
 * token family, with `cancelled`/`archived` (outside D4's five active
 * levels) pinned to `neutral`: a settled fact, not a colour that asks the
 * reader to do anything.
 */
export const requestStatusTone = (status: RequestStatusName): 'success' | 'info' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'cancelled' || status === 'archived') return 'neutral';
  return SEVERITY[requestSeverityLevel(status)].tokens.family;
};

/**
 * The editor-facing label for a status. Supersedes `requests-client.ts`'s
 * older `requestStatusLabel` for `stalled` specifically — when
 * `STALLED_VS_FAILED_SPLIT` is on, `stalled` reads "Taking longer than
 * expected" (D4's needs-you copy tone: a fact stated plainly, not an alarm)
 * rather than the bare status word, since it now shares its colour and its
 * quick-filter tab with `needs_you` and needs to read as a member of that
 * group, not as a lesser `failed`. Every other status keeps the same word
 * `requests-client.ts` already used.
 */
export const requestStatusLabel = (status: RequestStatusName): string => {
  if (status === 'stalled' && STALLED_VS_FAILED_SPLIT) return 'Taking longer than expected';
  return (
    {
      queued: 'Starting',
      running: 'Working',
      needs_you: 'Needs you',
      stalled: 'Stalled',
      failed: 'Failed',
      done: 'Done',
      cancelled: 'Cancelled',
      archived: 'Archived',
    } satisfies Record<RequestStatusName, string>
  )[status];
};

// ─── D1(b): the runs-inbox quick filters ──────────────────────────────────

/**
 * The inbox's quick-filter tabs (T2.3 brief: "Other filters (All / Running /
 * Blocked / Done / Muted / Archived) remain reachable"). `needsYou` is the
 * DEFAULT the inbox opens on — what is waiting for the operator, not
 * everything.
 *
 * `blocked` reads `STALLED_VS_FAILED_SPLIT` too, and that is deliberate, not
 * an oversight: split on, a `stalled` row is `needs_you` now (D4), so it
 * belongs in the `needsYou` tab and the `blocked` tab is `failed` alone —
 * the true D4 "died" set. Split off, both tabs revert together to the
 * original merge. One flag, every surface that reads status severity agrees.
 */
export type RequestQuickFilter = 'needsYou' | 'all' | 'running' | 'blocked' | 'done' | 'muted' | 'archived';

export const QUICK_FILTERS: ReadonlyArray<{ key: RequestQuickFilter; label: string }> = [
  { key: 'needsYou', label: 'Needs you' },
  { key: 'all', label: 'All' },
  { key: 'running', label: 'Running' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
  { key: 'muted', label: 'Muted' },
  { key: 'archived', label: 'Archived' },
];

export const DEFAULT_REQUEST_QUICK_FILTER: RequestQuickFilter = 'needsYou';

/**
 * Whether a row belongs on a given quick-filter tab. Pure, so the same
 * predicate that decides what the inbox shows is what a test asserts against
 * — no dependency on the shared poll store or on React.
 */
export const matchesQuickFilter = (
  row: RequestRowLike,
  filter: RequestQuickFilter,
  muted: readonly string[] = []
): boolean => {
  if (filter === 'archived') return row.archived;
  if (row.archived) return false;
  switch (filter) {
    case 'needsYou':
      // Same bucket the header pill counts (`classifyRow`) — this is the
      // fix for B5's bug: a row can never count in one and list in the other.
      return classifyRow(row) === 'needs_you';
    case 'all':
      return true;
    case 'running':
      return row.status === 'running' || row.status === 'queued';
    case 'blocked':
      return classifyRow(row) === 'blocked';
    case 'done':
      return row.status === 'done' || row.status === 'cancelled';
    case 'muted':
      return muted.includes(row.request_id);
  }
};

/**
 * The server-side `status` filter equivalent of a quick-filter tab, for the
 * one case (`mine`/`archived`/a live search) that has to ask the server
 * rather than filter the shared cache client-side (see `requests-store.ts`
 * and `RequestsWorkspace.tsx`'s own comments for why). `undefined` means
 * "no status constraint" — `all`, `muted` (not a status; filtered client-side
 * afterwards from the same universe as `all`) and `archived` (its own
 * `archived: true` param already does the narrowing) all return it.
 */
export const quickFilterToStatuses = (filter: RequestQuickFilter): RequestStatusName[] | undefined => {
  switch (filter) {
    case 'needsYou':
      return STALLED_VS_FAILED_SPLIT ? ['needs_you', 'stalled'] : ['needs_you'];
    case 'running':
      return ['running', 'queued'];
    case 'blocked':
      return STALLED_VS_FAILED_SPLIT ? ['failed'] : ['stalled', 'failed'];
    case 'done':
      return ['done', 'cancelled'];
    case 'all':
    case 'muted':
    case 'archived':
      return undefined;
  }
};

/**
 * Human labels for the `publishing_conductor` nodes, so a row reads
 * "researching" rather than "research". An unknown node falls back to its raw
 * id — hiding a node we do not recognise would be worse than showing it.
 */
export const NODE_LABELS: Record<string, string> = {
  input_triage: 'reading the brief',
  placement_resolver: 'placing it',
  topic_opportunity: 'sizing the topic',
  monetization_strategy: 'planning the offer',
  reader_insight: 'profiling the reader',
  research: 'researching',
  objection_mapping: 'mapping objections',
  narrative_movement: 'shaping the narrative',
  angle_strategy: 'choosing the angle',
  brief_architect: 'writing the brief',
  draft_writer: 'drafting',
  human_texture: 'reviewing texture',
  trust_factual: 'fact-checking',
  emotional_resonance: 'reviewing resonance',
  reader_simulation: 'simulating a reader',
  review_aggregator: 'gathering reviews',
  contract_intelligence: 'checking the contract',
  artifact_plan: 'planning media',
  article_body: 'building the article',
  publish_payload: 'preparing to publish',
  publication_controller: 'awaiting your approval',
  publish_executor: 'publishing',
  learning_recorder: 'recording what it learned',
  capture_crawl: 'crawling the source',
  capture_map: 'mapping the source',
  block_classifier: 'classifying blocks',
  capture_emit_live: 'building the site',
  capture_score: 'scoring fidelity',
  gap_adjudicator: 'adjudicating gaps',
  capture_report: 'writing the report',
};

export const nodeLabel = (nodeId: string | undefined): string | undefined =>
  nodeId ? (NODE_LABELS[nodeId] ?? nodeId) : undefined;

/**
 * B2: the Retry receipt.
 *
 * FIX 9 — this used to read "Retrying from planning media", naming the node
 * the run had stopped at as the point it would resume from. The server does
 * not promise that. `requeueRequest` takes a request id and nothing else: it
 * sets the status back to `queued`, clears the nudge count, and leaves the
 * run to the next sweep. It has no resume-point parameter, so the node in
 * that sentence was the UI's own inference dressed up as a server fact —
 * and a recovery button that overstates what it just did is exactly the
 * thing that stops being trusted the first time it is caught.
 *
 * So the receipt now says only what `requeueRequest` actually wrote — the
 * store's own `status_reason`, verbatim, the same way the 409 refusal quotes
 * the store's own refusal sentence.
 *
 * Takes no node. The node-precise wording is a one-line change here if and
 * when `requeueRequest` grows a resume point to make it true.
 */
export const retryReceipt = (): string => 'Re-queued — waiting for the next sweep to push the run';

/** "14 / 23 · drafting" — the one progress phrase the list, the pills and the chat card share. */
export const progressPhrase = (
  progress: { done: number; total: number } | undefined,
  currentNode: string | undefined
): string | undefined => {
  const label = nodeLabel(currentNode);
  if (!progress || progress.total === 0) return label;
  return label ? `${progress.done} / ${progress.total} · ${label}` : `${progress.done} / ${progress.total}`;
};

/** Coarse age phrasing for a row — "just now", "12m", "3h", "2d". */
export const relativeAge = (iso: string, nowMs: number): string => {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return '';
  const minutes = Math.floor((nowMs - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
};

/**
 * B4 — the row's one meta line, deliberately excluding `status_reason`.
 *
 * `status_reason` (e.g. "The artifact plan step failed, so the job has
 * stopped.") restates the `StatusBadge` sitting right above this line — it
 * still lives in the Drawer, and later in B1's Retry tooltip, but a list row
 * has no business repeating it. `primary` is the progress phrase; a live row
 * (`running`/`queued`) has none because `RunProgress` renders in its place
 * (kept as-is — see `RequestRow`), so callers never have to remember to
 * suppress it themselves. `secondary` is the two facts a row always carries:
 * owner, then age.
 */
export interface RowMetaLine {
  primary?: string;
  secondary: string[];
}

export const rowMetaLine = (
  row: {
    status: RequestStatusName;
    progress?: { done: number; total: number };
    current_node?: string;
    created_by: string;
    updated_at: string;
  },
  nowMs: number
): RowMetaLine => {
  const live = row.status === 'running' || row.status === 'queued';
  return {
    primary: live ? undefined : progressPhrase(row.progress, row.current_node),
    secondary: [row.created_by, relativeAge(row.updated_at, nowMs)],
  };
};

// ─── B1: the row's actions, as data ─────────────────────────────────────────

/**
 * The rights vocabulary a row action is gated on.
 *
 * Four coarse capabilities rather than the five role names
 * (`server/lib/roles.ts`): a surface should ask "may this person publish",
 * never "is this person a publisher" — `owner` already expands to
 * admin+publisher server-side and the tiers are additive, so the LADDER is
 * the only part the UI cares about. `read` is unconditional: every admin
 * principal, `viewer` included, may open a chat or an object.
 */
export type RowActionRight = 'read' | 'edit' | 'publish' | 'registry' | 'owner';

export type RowActionId =
  | 'approve'
  | 'reject'
  | 'retry'
  | 'raise_budget'
  | 'publish'
  | 'open_chat'
  | 'open_object'
  | 'mute'
  | 'cancel'
  | 'archive'
  | 'restore';

/**
 * One thing a person can do to a row. `kind` is the LAYOUT decision (at most
 * two `primary` actions sit in the row itself; every `menu` action lives in
 * the one overflow `DropdownMenu`), taken here rather than in the component
 * so the inbox row and the request Drawer cannot drift apart — they render
 * the same list.
 *
 * D3: a disabled action is still RETURNED, carrying the `reason` the surface
 * shows on hover/focus. Nothing rights-gated is ever dropped from the list —
 * a control that silently vanishes teaches an editor the feature does not
 * exist, where a disabled one with "Ask a publisher" teaches them who to ask.
 */
export interface RowAction {
  id: RowActionId;
  label: string;
  kind: 'primary' | 'menu';
  enabled: boolean;
  /** Why it is unavailable. Present exactly when `enabled` is false. */
  reason?: string;
  rightRequired: RowActionRight;
}

/**
 * What `rowActions` needs to know about a row. Structural, like
 * `RequestRowLike` above, and every field beyond `status`/`archived` is
 * optional: the shared index (`RequestRowView`) carries neither a failure
 * classification nor the object's publication state today, so a caller that
 * only has an index row still gets a correct — if coarser — list.
 */
export interface RowActionRowLike {
  status: RequestStatusName;
  archived: boolean;
  chat_id?: string;
  object_id?: string;
  /**
   * The run's classified failure code (CMS-Agent's `failure.code`, as
   * `ActivityView` carries it). Only `budget_exceeded` changes the answer:
   * retrying a run that hit its spend ceiling just hits it again, so the
   * primary becomes "Raise budget" instead of a Retry that cannot work.
   */
  failure_code?: string;
  /** Whether the attached object is already live. Unknown → treated as not published, which is what offers Publish. */
  object_published?: boolean;
  /** This person's own mute state for the row — the label, not a right. */
  muted?: boolean;
  /** Whether the caller started this run. An `editor` may cancel their own runs; a publisher may cancel anyone's. */
  mine?: boolean;
}

interface RowActionRights {
  read: boolean;
  edit: boolean;
  publish: boolean;
  /**
   * May call the request-registry endpoint AT ALL
   * (`server/functions/admin-requests.ts`) — see `registry` in
   * `rowActionRights` below for why this is not simply `edit`.
   */
  registry: boolean;
  owner: boolean;
}

/**
 * Roles (as `users-client.ts` reports them, i.e. `server/lib/roles.ts`
 * already expanded) → the capabilities. Additive on purpose: whatever a
 * publisher may do, an admin and an owner may do too.
 *
 * ## `registry`, and why the ladder is narrowed here (FIX 3)
 *
 * The `read`/`edit`/`publish`/`owner` ladder is the INTENDED model, and it
 * is the right vocabulary for a surface: "may this person publish", never
 * "is this person a publisher". But it describes rights the fleet has not
 * finished granting. Every action this row dispatches into the request
 * registry goes through ONE endpoint, and that endpoint's first gate is
 * `callerRoles.includes('admin')` for EVERY action it serves, `list`
 * included (`server/functions/admin-requests.ts`) — so `/admin/requests`
 * is an admin-only surface today, and the tiers below admin cannot reach
 * Retry, Mute, Cancel, Archive or Restore no matter what the ladder says.
 *
 * `registry` is that seam, named. Widening the SERVER gate to match the
 * ladder is a fleet-law decision (Wolf's), not a UI one; until it is taken,
 * the honest thing for the surface to do is render those actions disabled
 * with a reason (convention D3) rather than as live buttons that 403 on the
 * click. When the server gate moves, this one predicate moves with it and
 * every action re-widens at once.
 */
export const rowActionRights = (roles: readonly string[]): RowActionRights => {
  const has = (role: string) => roles.includes(role);
  const owner = has('owner');
  const publish = owner || has('admin') || has('publisher');
  const edit = publish || has('editor');
  // `owner` expands to admin+publisher server-side (`server/lib/roles.ts`),
  // so the `has('owner')` term is belt-and-braces for a caller that reports
  // an unexpanded tier.
  const registry = owner || has('admin');
  return { read: true, edit, publish, registry, owner };
};

/**
 * Who to ask, phrased from where the CALLER stands rather than from which
 * right is missing: a `viewer` denied Publish is told "Ask an editor",
 * because the next rung up is the one they can actually reach for — telling
 * them "Ask a publisher" answers a question they did not ask.
 */
const askReason = (rights: RowActionRights, required: RowActionRight): string => {
  // The registry seam does not sit on the ladder (see `rowActionRights`):
  // an editor denied Retry is not missing the `edit` right, they are on the
  // wrong side of an endpoint that admits admins only. Telling them "Ask an
  // editor" — which they ARE — would be the ladder answering a question the
  // server did not ask.
  if (required === 'registry') return 'Ask an admin';
  return !rights.edit ? 'Ask an editor' : !rights.publish ? 'Ask a publisher' : 'Ask an owner';
};

const NO_CHAT = 'No chat is attached to this request yet.';
const NO_OBJECT = 'No object is attached to this request yet.';

/**
 * B3 — how this client publishes, in the vocabulary a row needs.
 *
 * `auto` and `manual` are the two states the fleet's approval policy actually
 * resolves to (`lib/approval-policy.ts`): an `autonomous` type publishes on
 * the click, a `require-approval` one needs a current approved review on the
 * record first — which the server's `checkPublishGate` checks, not this row,
 * since an index row carries no review state. Both therefore still OFFER
 * Publish; the difference is what the confirmation says.
 *
 * `block` is the third posture the row must be able to draw — a client whose
 * publishing is switched off outright. NOTHING emits it today: no site config
 * carries the value (`approval-policy.ts` has two states, not three). It is
 * accepted here rather than assumed away so that the day a policy source does
 * emit it, the row already refuses instead of offering a button the server
 * will reject.
 */
export type PublishPolicy = 'auto' | 'manual' | 'block';

/** D3 hover text on the disabled Publish action when this client may not publish at all. */
export const PUBLISH_BLOCKED_REASON = 'Publishing is blocked for this client';

/** The approval policy's one boolean, in this surface's three-state vocabulary. */
export const publishPolicyFromApproval = (requiresApproval: boolean): PublishPolicy =>
  requiresApproval ? 'manual' : 'auto';

/**
 * B3 — the object-publish call's target, built from an inbox row.
 *
 * The inbox knows an `object_id`, a title and a timestamp, and nothing else:
 * `RequestRowView` comes from the requests index, which carries no object
 * type, review state or publication stamp. `object_publish`
 * (`quick-actions.ts`) reads exactly three of a row's fields — the type, the
 * id, and the display name it puts in the receipt — so those three are the
 * only ones stated from real data. The remaining fields exist to satisfy the
 * shared `LibraryRow` shape that path takes and are NEVER consulted on the
 * publish branch; the server's `checkPublishGate` is what actually decides
 * whether this publish may happen, over the record's own state.
 *
 * `content_item` is the same assumption the row's Open object link already
 * makes: an editorial request's object is an article.
 */
export interface PublishTargetRow {
  object_id: string;
  object_type: 'content_item';
  display_name: string;
  updated_at: string;
  status: 'active';
  review_state: 'none';
  published_time: null;
  unpublished_changes: true;
}

export const publishTargetFor = (row: {
  object_id?: string;
  title: string;
  updated_at: string;
}): PublishTargetRow | undefined =>
  row.object_id
    ? {
        object_id: row.object_id,
        object_type: 'content_item',
        display_name: row.title,
        updated_at: row.updated_at,
        status: 'active',
        review_state: 'none',
        published_time: null,
        unpublished_changes: true,
      }
    : undefined;

export interface RowActionOptions {
  /**
   * This client's publish posture. Defaults to `auto`: a caller that has not
   * resolved a policy must not silently take a publisher's only action away —
   * the server gate is the authority either way.
   */
  publishPolicy?: PublishPolicy;
}

/**
 * Every action a row offers, in render order: `primary` ones first (at most
 * two), then the overflow. Pure — the surface supplies the roles it already
 * resolved and gets back a list it only has to draw.
 *
 * The status → actions table is the authority (B1); this function is that
 * table, executable.
 */
export const rowActions = (
  row: RowActionRowLike,
  roles: readonly string[],
  options: RowActionOptions = {}
): RowAction[] => {
  const rights = rowActionRights(roles);

  const make = (
    id: RowActionId,
    label: string,
    kind: RowAction['kind'],
    rightRequired: RowActionRight,
    /** A reason unrelated to rights (missing chat, not your run) — applied only once the right is held. */
    blocked?: string
  ): RowAction => {
    const reason = rights[rightRequired] ? blocked : askReason(rights, rightRequired);
    return {
      id,
      label,
      kind,
      enabled: !reason,
      rightRequired,
      ...(reason ? { reason } : {}),
    };
  };

  /**
   * Cancel's SECOND gate, on top of `registry`. The endpoint's own line is
   * "the creator of this request, or an Owner"
   * (`admin-requests.ts`'s `cancel` case) — not the publish tier, which is
   * what this used to mirror. An admin who did not start the run and is not
   * an Owner is refused, so the button must say so.
   *
   * `mine` unknown fails closed — the surface knows the caller's e-mail and
   * this module does not, so guessing "yours" here would show someone a
   * button the server refuses.
   */
  const cancelBlocked = !rights.owner && row.mine !== true ? 'Only the editor who asked for this, or an Owner' : undefined;

  const openChat = (kind: RowAction['kind']) =>
    make('open_chat', 'Open chat', kind, 'read', row.chat_id ? undefined : NO_CHAT);
  const openObject = (kind: RowAction['kind']) =>
    make('open_object', 'Open object', kind, 'read', row.object_id ? undefined : NO_OBJECT);
  const mute = (kind: RowAction['kind']) => make('mute', row.muted ? 'Unmute' : 'Mute', kind, 'registry');
  const cancel = (kind: RowAction['kind']) => make('cancel', 'Cancel', kind, 'registry', cancelBlocked);
  /**
   * Archive/Restore answer to TWO server gates that intersect: the module's
   * `admin` gate and `canArchive` (`isOwner || publisher`). A membership
   * `publisher` never clears the first; a plain `admin` never clears the
   * second; only an Owner — who expands to owner+admin+publisher — clears
   * both. So the honest right here is `owner`, not `publish`.
   */
  const archive = (kind: RowAction['kind']) => make('archive', 'Archive', kind, 'owner');

  // B3: a client that may not publish at all beats the row's own reason — no
  // object attached is the smaller problem when nothing here publishes. The
  // rights check still comes first (`make`): an editor is told to ask a
  // publisher, which is the nearer truth for them than the site's posture.
  const publishBlocked =
    options.publishPolicy === 'block' ? PUBLISH_BLOCKED_REASON : row.object_id ? undefined : NO_OBJECT;

  // Settled: cancelled or filed away. Nothing is running, so there is nothing
  // to cancel, mute or archive — only to put back and to look at.
  if (row.archived || row.status === 'archived' || row.status === 'cancelled') {
    // Restore is `unarchive` on the same endpoint as Archive — same two
    // intersecting gates, same Owner-only answer.
    return [make('restore', 'Restore', 'primary', 'owner'), openChat('menu'), openObject('menu')];
  }

  switch (row.status) {
    case 'needs_you':
      // The one row where the decision IS the row: Approve/Reject sit in it,
      // everything else moves out of their way.
      return [
        make('approve', 'Approve', 'primary', 'publish'),
        make('reject', 'Reject', 'primary', 'publish'),
        openChat('menu'),
        openObject('menu'),
        mute('menu'),
        cancel('menu'),
        archive('menu'),
      ];
    case 'failed':
    case 'stalled':
      return [
        // A run that died on its spend ceiling cannot be retried into
        // success — raising the ceiling is the only move, and it is the
        // Owner's. (`stalled` shares this branch: if a stall reports a
        // budget failure it is the same problem, not a different one.)
        row.failure_code === 'budget_exceeded'
          ? make('raise_budget', 'Raise budget', 'primary', 'owner')
          : // B2's Retry posts `action: 'retry'` to the request registry, which
            // admits admins only — see `registry` in `rowActionRights`.
            make('retry', 'Retry', 'primary', 'registry'),
        openChat('primary'),
        openObject('menu'),
        cancel('menu'),
        archive('menu'),
      ];
    case 'queued':
    case 'running':
      // Live: nothing to decide and nothing to fix. Watching it (the chat) is
      // the only primary; archiving a run still in flight is not offered.
      return [openChat('primary'), openObject('menu'), mute('menu'), cancel('menu')];
    case 'done':
      // The last mile. An unpublished object is the ONE thing still owed, so
      // it takes the primary slot; once it is live, Open object is all that's left.
      return row.object_published
        ? [openObject('primary'), openChat('menu'), archive('menu')]
        : [
            make('publish', 'Publish', 'primary', 'publish', publishBlocked),
            openObject('primary'),
            openChat('menu'),
            archive('menu'),
          ];
  }
};

// ─── W19 T19.6: which transitions are worth telling a person about ───────────

/**
 * The ONLY four transitions that notify (plan §6). Everything else — a node
 * completing, a progress tick, a request starting — is visible on the surface
 * and is not worth interrupting anyone for. Keeping this list short is what
 * makes a notification mean something.
 */
export const NOTIFYING_STATUSES: readonly RequestStatusName[] = ['needs_you', 'stalled', 'failed', 'done'];

export interface PendingNotification {
  request_id: string;
  title: string;
  status: RequestStatusName;
  status_reason?: string;
}

/**
 * Compare the current index against what this person was last told, and
 * return only what is genuinely new to them.
 *
 * `lastNotified` is stored SERVER-side per person, so the dedup holds across
 * tabs, across devices and across a reload — a second tab opening must not
 * re-announce an approval the editor already saw, and neither must a refresh.
 * Muted requests are dropped here rather than at the surface, so muting one
 * silences every channel at once.
 */
export interface NotificationScan {
  /** What to show the person now. */
  notify: PendingNotification[];
  /**
   * Every row whose status differs from the stored one — INCLUDING the
   * non-notifying ones. Acking these is what lets a request that returns to a
   * notifying status be announced again.
   */
  ack: Record<string, string>;
}

/**
 * Compare the current index against what this person was last shown.
 *
 * The map tracks the CURRENT status, notifying or not. Tracking only the
 * notifying ones silently swallowed the most valuable event in the system: a
 * request that hits `needs_you`, is approved, runs, and hits a SECOND approval
 * gate would find `needs_you` already recorded and say nothing — the same for a
 * job that stalls, is revived, and stalls again. Acking the intermediate
 * `running` is what closes that hole.
 *
 * Muted requests are dropped here rather than at the surface, so muting one
 * silences every channel at once.
 */
/**
 * Combine the SERVER's ledger of what this person has been told with a tab's
 * own record of what it just showed, and prune what has gone stale.
 *
 * The local record exists only to cover the round-trip between showing
 * something and the ack landing — but an entry left in it after the row moved
 * on is worse than useless. A pinned tab that showed `needs_you`, watched the
 * job be approved and go `running`, and later saw it reach a SECOND gate would
 * find its stale `needs_you` entry matching the row again and suppress the
 * toast, the desktop notification AND the ack — permanently, for exactly the
 * event this engine exists to deliver.
 *
 * Returns the merged view to scan against, and the pruned local record to keep.
 */
export const mergeSeen = (
  rows: readonly RequestRowLike[],
  lastNotified: Readonly<Record<string, string>>,
  localSeen: Readonly<Record<string, string>>
): { seen: Record<string, string>; local: Record<string, string> } => {
  const seen: Record<string, string> = { ...lastNotified };
  const local: Record<string, string> = {};
  for (const [requestId, status] of Object.entries(localSeen)) {
    const row = rows.find((candidate) => candidate.request_id === requestId);
    if (!row || row.status !== status) continue;
    seen[requestId] = status;
    local[requestId] = status;
  }
  return { seen, local };
};

export const scanNotifications = (
  rows: readonly (RequestRowLike & { status_reason?: string })[],
  lastNotified: Readonly<Record<string, string>>,
  muted: readonly string[] = []
): NotificationScan => {
  const silenced = new Set(muted);
  const notify: PendingNotification[] = [];
  const ack: Record<string, string> = {};
  for (const row of rows) {
    if (row.archived || silenced.has(row.request_id)) continue;
    if (lastNotified[row.request_id] === row.status) continue;
    ack[row.request_id] = row.status;
    if (!NOTIFYING_STATUSES.includes(row.status)) continue;
    notify.push({
      request_id: row.request_id,
      title: row.title,
      status: row.status,
      ...(row.status_reason ? { status_reason: row.status_reason } : {}),
    });
  }
  return { notify, ack };
};

/** Convenience for callers that only want what to show. */
export const pendingNotifications = (
  rows: readonly (RequestRowLike & { status_reason?: string })[],
  lastNotified: Readonly<Record<string, string>>,
  muted: readonly string[] = []
): PendingNotification[] => scanNotifications(rows, lastNotified, muted).notify;

/** One sentence per transition — the toast body, the browser notification body, and the e-mail subject all use it. */
export const notificationSentence = (notification: PendingNotification): string => {
  switch (notification.status) {
    case 'needs_you':
      return notification.status_reason || 'Needs a decision from you.';
    case 'stalled':
      return notification.status_reason || 'Stopped moving — nothing has happened for a while.';
    case 'failed':
      return notification.status_reason || 'A step failed and the job stopped.';
    default:
      return 'Finished.';
  }
};

export const notificationHeadline = (notification: PendingNotification): string =>
  `${notification.title} — ${
    notification.status === 'needs_you'
      ? 'needs you'
      : notification.status === 'stalled'
        ? 'stalled'
        : notification.status === 'failed'
          ? 'failed'
          : 'done'
  }`;

/** `(3) ` for the tab title, and nothing at all at zero — a bare title must stay bare. */
export const titlePrefix = (count: number): string => (count > 0 ? `(${count}) ` : '');
