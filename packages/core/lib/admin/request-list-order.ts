/**
 * request-list-order.ts — the request list's ORDER and its filter, as a leaf.
 *
 * WHY THIS IS A SEPARATE MODULE, and not still inside `request-logic.ts`:
 * `server/lib/requests/list-snapshot.ts` needs exactly two of that file's
 * functions — the filter and the sort — and it is on the cold-start path of
 * `admin-shell` and `admin-requests`, both capped at 500 KB by
 * `tests/netlify/function-bundle-budget.test.ts`. `request-logic.ts` is the
 * request surface's whole UI vocabulary: severity mapping, tones, labels,
 * row actions, empty states, detail facts — 52 KB, and a further 10 KB of
 * `severity.ts` behind it, none of which a server that sorts rows will ever
 * call.
 *
 * Measured on `admin-shell` while M2.1 added the `inventory` section: 488 KB
 * with this edge, 437 KB without it. Same cut and same reasoning as M0.1's
 * `server/lib/review-approval.ts` and ASV2-W5's
 * `lib/admin/quick-actions-registry.ts`.
 *
 * `request-logic.ts` re-exports every name below, so no call site moved — but
 * only the LEAF spelling is on the server's diet. Either import compiles.
 *
 * Why the order lives in `lib/admin` at all (unchanged, W19 plan §4.1): the
 * SERVER sorts and the client does not re-sort, so both sides must read one
 * definition of the order or the desk and the endpoint drift apart.
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
