/**
 * The objects plane (T2.1) — pure filter/search/sort/status/pagination logic
 * over `LibraryRow`, the existing inventory-row shape (`library-logic.ts`).
 * Kept framework-free so it is unit-testable without a DOM; the React
 * component (`admin/ObjectsPlane.tsx`) is a thin renderer over these
 * functions plus the existing `library-client.ts` fetch/cache.
 *
 * Object status renders through D4 (`lib/admin/severity.ts`) — `statusFor`
 * below is the ONE place a `LibraryRow` (+ the optional release-derived
 * `EditorialObjectState`) becomes an `AdminSeverity` + label. No new status
 * vocabulary is introduced.
 */
import { objectTypes, type ObjectType } from '../../schema/object-record-v1.js';
import type { LibraryRow } from './library-logic.js';
import { EDITORIAL_STATE_PRESENTATION, type EditorialObjectState } from './editorial-state.js';
import { ADMIN_SEVERITY_ORDER, type AdminSeverity } from './severity.js';

// ─── type facets (multi-select, authoritative from the schema) ─────────────

/** The governed object types, in schema declaration order — never hand-guessed. */
export const OBJECT_TYPE_FACETS: readonly ObjectType[] = objectTypes;

export type TypeFacetSelection = ReadonlySet<ObjectType> | 'all';

const KNOWN_TYPES = new Set<string>(objectTypes);

/** Parses a comma-separated `?type=` query value into a selection. Unknown tokens are dropped. */
export function parseTypeFacetParam(raw: string | null | undefined): TypeFacetSelection {
  if (!raw) return 'all';
  const picked = raw
    .split(',')
    .map((token) => token.trim())
    .filter((token): token is ObjectType => KNOWN_TYPES.has(token));
  return picked.length ? new Set(picked) : 'all';
}

/** Inverse of {@link parseTypeFacetParam} — `undefined` means "omit the param" (facet is 'all'). */
export function typeFacetToParam(selection: TypeFacetSelection): string | undefined {
  if (selection === 'all' || selection.size === 0) return undefined;
  return [...selection].join(',');
}

export function matchesTypeFacet(row: LibraryRow, selection: TypeFacetSelection): boolean {
  return selection === 'all' || selection.has(row.object_type);
}

export function toggleTypeFacet(selection: TypeFacetSelection, type: ObjectType): TypeFacetSelection {
  if (selection === 'all') return new Set([type]);
  const next = new Set(selection);
  if (next.has(type)) next.delete(type);
  else next.add(type);
  return next.size ? next : 'all';
}

// ─── search ──────────────────────────────────────────────────────────────

/**
 * `LibraryRow` (the inventory-row wire shape) carries no dedicated `slug`
 * field today — only `object_id` (the governed identifier) and
 * `display_name` (the title). Real slugs live inside each type's own body
 * (`page.route`, `content_item`/`product.slug`) and are not surfaced on the
 * list row a browse surface fetches. Rather than fabricate a slug or fetch
 * every body just to search it, this matches id + title — the id is
 * slug-derived for most governed types, so it is the closest honest stand-in
 * available without a server-side inventory-row change (a reasonable, small
 * follow-up, out of scope here).
 */
export function matchesSearch(row: LibraryRow, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return row.display_name.toLowerCase().includes(q) || row.object_id.toLowerCase().includes(q);
}

// ─── sort ────────────────────────────────────────────────────────────────

export type ObjectSortKey = 'updated_at' | 'title' | 'type' | 'status';
export type SortDirection = 'asc' | 'desc';

export const OBJECT_SORT_OPTIONS: ReadonlyArray<{ key: ObjectSortKey; label: string }> = [
  { key: 'updated_at', label: 'Last updated' },
  { key: 'title', label: 'Title' },
  { key: 'type', label: 'Type' },
  { key: 'status', label: 'Status' },
];

const SEVERITY_RANK: Record<AdminSeverity, number> = Object.fromEntries(
  ADMIN_SEVERITY_ORDER.map((level, index) => [level, index])
) as Record<AdminSeverity, number>;

/** A `LibraryRow`'s D4 status: the ONE place status becomes `{level, label}`. */
export function statusFor(
  row: LibraryRow,
  editorialState?: EditorialObjectState
): { level: AdminSeverity; label: string } {
  if (row.status === 'archived') return { level: 'info', label: 'Archived' };
  if (row.review_state === 'changes_requested') return { level: 'needs_you', label: 'Changes requested' };
  if (row.review_state === 'open') return { level: 'needs_you', label: 'In review' };
  if (editorialState) {
    const presentation = EDITORIAL_STATE_PRESENTATION[editorialState];
    const level: AdminSeverity = editorialState === 'live' || editorialState === 'published' ? 'success' : 'info';
    return { level, label: presentation.label };
  }
  if (row.published_time) return { level: 'success', label: 'Published' };
  return { level: 'info', label: 'Draft' };
}

const sortValue = (
  row: LibraryRow,
  key: ObjectSortKey,
  states: Readonly<Record<string, EditorialObjectState>>
): string | number => {
  switch (key) {
    case 'updated_at':
      return row.updated_at ?? '';
    case 'title':
      return row.display_name.toLowerCase();
    case 'type':
      return row.object_type;
    case 'status':
      // Worst-first rank so "sort by status" surfaces what needs attention —
      // the same ordering D4's own SEVERITY_ORDER already defines.
      return SEVERITY_RANK[statusFor(row, states[row.object_id]).level];
  }
};

/** Stable comparator: nullish/empty sinks last regardless of direction. */
export function compareObjectRows(
  a: LibraryRow,
  b: LibraryRow,
  key: ObjectSortKey,
  direction: SortDirection,
  states: Readonly<Record<string, EditorialObjectState>> = {}
): number {
  const av = sortValue(a, key, states);
  const bv = sortValue(b, key, states);
  const an = av === '' || av === null || av === undefined;
  const bn = bv === '' || bv === null || bv === undefined;
  if (an && bn) return 0;
  if (an) return 1;
  if (bn) return -1;
  const cmp =
    typeof av === 'number' && typeof bv === 'number'
      ? av - bv
      : String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
  return direction === 'desc' ? -cmp : cmp;
}

export function sortObjectRows(
  rows: readonly LibraryRow[],
  key: ObjectSortKey,
  direction: SortDirection,
  states: Readonly<Record<string, EditorialObjectState>> = {}
): LibraryRow[] {
  return [...rows].sort((a, b) => compareObjectRows(a, b, key, direction, states));
}

// ─── combined filter (facet + search) ───────────────────────────────────────

export interface ObjectsPlaneFilter {
  type: TypeFacetSelection;
  query: string;
}

export function filterObjectRows(rows: readonly LibraryRow[], filter: ObjectsPlaneFilter): LibraryRow[] {
  return rows.filter((row) => matchesTypeFacet(row, filter.type) && matchesSearch(row, filter.query));
}

/** Rows per type, for the facet chip counts — always over the UNFILTERED set. */
export function typeFacetCounts(rows: readonly LibraryRow[]): Partial<Record<ObjectType, number>> {
  const counts: Partial<Record<ObjectType, number>> = {};
  for (const row of rows) counts[row.object_type] = (counts[row.object_type] ?? 0) + 1;
  return counts;
}

// ─── pagination ──────────────────────────────────────────────────────────

/**
 * Pagination, not virtualized scroll: `fetchInventoryRows` already pulls the
 * WHOLE corpus in one cached request (library-client.ts — there is no
 * server-side paged endpoint to virtualize against), and this fleet's
 * object counts are in the low hundreds at most (T0.2's own N≈200 estimate).
 * A hand-rolled virtualizer earns its complexity on lists of thousands with
 * variable row heights; simple offset pagination over an already-in-memory
 * array is simpler to get right, keyboard/screen-reader friendly for free,
 * and trivially testable as pure arithmetic — which a virtualizer's
 * scroll-position math is not.
 */
export const DEFAULT_PAGE_SIZE = 25;

export interface ObjectsPage<T> {
  items: T[];
  page: number;
  pageCount: number;
  total: number;
  pageSize: number;
}

export function paginateRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number = DEFAULT_PAGE_SIZE
): ObjectsPage<T> {
  const total = rows.length;
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const clamped = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const start = (clamped - 1) * pageSize;
  return { items: rows.slice(start, start + pageSize), page: clamped, pageCount, total, pageSize };
}
