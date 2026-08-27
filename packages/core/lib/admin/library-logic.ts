/**
 * Content library (T9.8) — pure, framework-free derivation over inventory
 * rows: the display status pill, the readiness dot, and the client-side
 * filter/sort. Kept out of the React island so it can be unit-tested as
 * plain TS. The corpus is ~50 objects, so one inventory fetch + client
 * filtering is all this needs (no server-side search).
 */
import type { ObjectType } from '../../schema/object-record-v1.js';
import { objectTypeLabel } from '../../lib/admin/display-name.js';
import { EDITORIAL_STATE_PRESENTATION } from './editorial-state.js';

/** The inventory-row fields the browse surface consumes (subset of InventoryRow). */
export interface LibraryRow {
  object_id: string;
  object_type: ObjectType;
  display_name: string;
  updated_at: string;
  status: 'active' | 'archived';
  review_state: 'none' | 'open' | 'changes_requested' | 'approved';
  approval_state?: 'none' | 'open' | 'changes_requested' | 'approved_stale' | 'approved_current';
  requires_approval?: boolean;
  published_time: string | null;
  published_content_revision?: number | null;
  content_revision?: number;
  publish_commit?: string | null;
  unpublished_changes: boolean;
}

export type LibraryStatusTone = 'neutral' | 'info' | 'success' | 'warning';
export interface LibraryStatus {
  label: string;
  tone: LibraryStatusTone;
}

/**
 * The single most salient lifecycle status for the status pill — the
 * fallback shown while `states[id]`'s real release-state fetch is still in
 * flight (T0.3 Table C: the two used to disagree — this returned green,
 * `EDITORIAL_STATE_PRESENTATION.published` amber — for the identical object,
 * flipping on nothing but load order). The `published` branch now reads its
 * label/tone straight from `EDITORIAL_STATE_PRESENTATION` instead of a second
 * hand-written literal, so there is exactly one table to keep in sync, not two.
 */
export function rowStatus(row: LibraryRow): LibraryStatus {
  if (row.status === 'archived') return { label: 'Archived', tone: 'neutral' };
  if (row.review_state === 'open') return { label: 'In review', tone: 'info' };
  if (row.review_state === 'changes_requested') return { label: 'Changes requested', tone: 'warning' };
  if (row.published_time) return { ...EDITORIAL_STATE_PRESENTATION.published };
  return { label: 'Draft', tone: 'neutral' };
}

export type ReadinessDot = 'ready' | 'attention' | 'idle';

/**
 * Coarse readiness signal available from an inventory row (no body): a review
 * in flight or unpublished changes need attention; a clean published record is
 * ready; anything else is idle (draft / never published).
 */
export function readinessDot(row: LibraryRow): ReadinessDot {
  if (row.review_state === 'open' || row.review_state === 'changes_requested') return 'attention';
  if (row.published_time && !row.unpublished_changes) return 'ready';
  if (row.published_time && row.unpublished_changes) return 'attention';
  return 'idle';
}

export interface LibraryFilter {
  type?: ObjectType | 'all';
  query?: string;
}

/** Filter by type + a case-insensitive query over display name / type / id, then sort newest-updated first. */
export function filterRows(rows: readonly LibraryRow[], filter: LibraryFilter): LibraryRow[] {
  const q = (filter.query ?? '').trim().toLowerCase();
  const type = filter.type ?? 'all';
  return rows
    .filter((row) => type === 'all' || row.object_type === type)
    .filter((row) => {
      if (!q) return true;
      return (
        row.display_name.toLowerCase().includes(q) ||
        objectTypeLabel(row.object_type).toLowerCase().includes(q) ||
        row.object_id.toLowerCase().includes(q)
      );
    })
    .slice()
    .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''));
}

/** Count rows per object type (for the type-filter chips). */
export function typeCounts(rows: readonly LibraryRow[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const row of rows) counts[row.object_type] = (counts[row.object_type] ?? 0) + 1;
  return counts;
}
