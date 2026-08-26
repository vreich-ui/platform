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
 * Counts for the shell's pills (plan §6.1). Archived rows never count.
 * `needsYou` and `blocked` both read `STALLED_VS_FAILED_SPLIT`: split on
 * (the default), `stalled` joins the amber `needsYou` count and `blocked` is
 * `failed` alone; split off, `stalled` reverts to joining `blocked` and
 * `needsYou` is `needs_you` alone — the original merged behaviour, verbatim.
 */
export const summarizeRequestRows = (rows: readonly RequestRowLike[]) => {
  let working = 0;
  let needsYou = 0;
  let blocked = 0;
  for (const row of rows) {
    if (row.archived) continue;
    const level = requestSeverityLevel(row.status);
    if (row.status === 'running' || row.status === 'queued') working += 1;
    else if (level === 'needs_you') needsYou += 1;
    else if (level === 'blocked') blocked += 1;
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
      return requestSeverityLevel(row.status) === 'needs_you';
    case 'all':
      return true;
    case 'running':
      return row.status === 'running' || row.status === 'queued';
    case 'blocked':
      return requestSeverityLevel(row.status) === 'blocked';
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
