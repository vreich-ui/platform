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
 * Counts for the shell's three pills (plan §6.1). Archived rows never count.
 * `failed` joins `stalled` deliberately: to an editor they are the same
 * sentence — "this one isn't going to finish on its own."
 */
export const summarizeRequestRows = (rows: readonly RequestRowLike[]) => {
  let working = 0;
  let needsYou = 0;
  let stalled = 0;
  for (const row of rows) {
    if (row.archived) continue;
    if (row.status === 'running' || row.status === 'queued') working += 1;
    else if (row.status === 'needs_you') needsYou += 1;
    else if (row.status === 'stalled' || row.status === 'failed') stalled += 1;
  }
  return { working, needsYou, stalled };
};

/** The tone a status pill takes. */
export const requestStatusTone = (status: RequestStatusName): 'success' | 'info' | 'warning' | 'danger' | 'neutral' => {
  if (status === 'needs_you') return 'warning';
  if (status === 'stalled' || status === 'failed') return 'danger';
  if (status === 'running' || status === 'queued') return 'info';
  if (status === 'done') return 'success';
  return 'neutral';
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
