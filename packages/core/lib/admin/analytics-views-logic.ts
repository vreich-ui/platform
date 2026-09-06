/**
 * Saved analytics views + operator notes (T21.27/T21.29;
 * analytics-dashboard-spec.md D1/D10; runner R11.1/R11.3) — pure logic.
 *
 * A saved view is an OPERATOR PREFERENCE — a bookmark over the page's own
 * `{tab, range, filters, compare, pagesSort}` state — not editorial content.
 * It does NOT go through the governed object substrate (no `object_type`, no
 * publish/release, no review, no `object_contract` entry): it is persisted in
 * the admin's own Blobs store (`analytics-views`, see
 * `server/lib/analytics-views-store.ts`) and is addressable from the URL as
 * `?view=<id>` (`AnalyticsWorkspace.tsx`). Operator notes (R11.3 — "click a
 * day, add a note") are stored beside the views in the SAME blob store, under
 * a separate key prefix — same reasoning: an operator annotation, not
 * content, so no object-substrate ceremony either.
 *
 * Same house split as the rest of this family: this file has zero I/O and is
 * the tested tier (`analytics-views-logic.test.ts`); the store module
 * (`server/lib/analytics-views-store.ts`) owns the blob reads/writes and the
 * admin function owns auth + wiring.
 */
import type { AnalyticsFilters, AnalyticsRangeKey, AnalyticsSearchState, AnalyticsSource } from './analytics-logic.js';

// ─── saved views ────────────────────────────────────────────────────────────

/**
 * The one alternate ranking sort R11.1's "Content performance" default view
 * needs (own-tab Pages card, "sorted by completion %" — the task brief,
 * verbatim). See `own-analytics-logic.ts`'s `topObjectRows`. Extending this
 * union later is additive, never a rename — a view already stored with the
 * current set must keep parsing.
 */
export type AnalyticsPagesSort = 'pageviews' | 'completion_rate';

export const DEFAULT_PAGES_SORT: AnalyticsPagesSort = 'pageviews';

export const isAnalyticsPagesSort = (value: unknown): value is AnalyticsPagesSort =>
  value === 'pageviews' || value === 'completion_rate';

export interface AnalyticsSavedView {
  id: string;
  name: string;
  tab: AnalyticsSource;
  range: AnalyticsRangeKey;
  /** Present only when `range === 'custom'`. */
  from?: string;
  to?: string;
  compare: boolean;
  filters: AnalyticsFilters;
  /** Absent = the page's normal pageviews-desc sort. Own tab only — the Netlify tab's Pages card has no completion-rate dimension to sort by. */
  pagesSort?: AnalyticsPagesSort;
  /** The three shipped defaults carry this; an operator-saved view never does. Not otherwise special — a builtin can be edited or deleted like any other view; nothing re-seeds a deleted default (seeding only ever fires against an EMPTY store, `ensureDefaultViews`). */
  builtin?: boolean;
  createdAt: string;
  updatedAt: string;
}

export const MAX_VIEW_NAME_LENGTH = 60;

export function isValidViewName(name: string): boolean {
  const trimmed = name.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_VIEW_NAME_LENGTH;
}

/** Stable, prefixed ids for the three shipped defaults — never `view_<random>` — so a future default can never collide with an operator-minted id, and re-seeding (an empty store) is idempotent by id. */
export const BUILTIN_VIEW_IDS = {
  weeklyReview: 'builtin_weekly_review',
  contentPerformance: 'builtin_content_performance',
  acquisition: 'builtin_acquisition',
} as const;

/**
 * The three defaults the task brief names, verbatim:
 *  - Weekly review — 7d vs previous, own tab.
 *  - Content performance — 30d, Pages panel sorted by completion %.
 *  - Acquisition — 30d, Sources panel.
 *
 * "Sources panel" / "Pages panel" name which CARD the operator lands looking
 * at, not a distinct piece of persisted state — a saved view's job is to
 * reproduce the tab/range/filters/sort that make that card the interesting
 * one; which ranking card view is expanded is left to the page's own default
 * (both panels are always rendered, per D5).
 */
export function defaultAnalyticsViews(at: string): AnalyticsSavedView[] {
  return [
    {
      id: BUILTIN_VIEW_IDS.weeklyReview,
      name: 'Weekly review',
      tab: 'own',
      range: '7d',
      compare: true,
      filters: {},
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: BUILTIN_VIEW_IDS.contentPerformance,
      name: 'Content performance',
      tab: 'own',
      range: '30d',
      compare: false,
      filters: {},
      pagesSort: 'completion_rate',
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
    {
      id: BUILTIN_VIEW_IDS.acquisition,
      name: 'Acquisition',
      tab: 'own',
      range: '30d',
      compare: false,
      filters: {},
      builtin: true,
      createdAt: at,
      updatedAt: at,
    },
  ];
}

/** A view → the page's own URL-search-state shape — what `AnalyticsWorkspace` applies wholesale when a view is selected from the Views menu or resolved off `?view=<id>` on load. */
export function viewToSearchState(view: AnalyticsSavedView): AnalyticsSearchState {
  return {
    source: view.tab,
    range: view.range,
    custom: view.range === 'custom' && view.from && view.to ? { from: view.from, to: view.to } : undefined,
    compare: view.compare,
    filters: { ...view.filters },
  };
}

/** The inverse — what "Save current view as…" persists, built from the page's live state plus a name and (own-tab only) the active pages-sort. Timestamps/id are the store's job (`saveAnalyticsView` stamps them), so this returns everything else. */
export interface AnalyticsViewInput {
  name: string;
  tab: AnalyticsSource;
  range: AnalyticsRangeKey;
  from?: string;
  to?: string;
  compare: boolean;
  filters: AnalyticsFilters;
  pagesSort?: AnalyticsPagesSort;
}

export function buildViewInput(
  name: string,
  state: AnalyticsSearchState,
  pagesSort?: AnalyticsPagesSort
): AnalyticsViewInput {
  return {
    name: name.trim(),
    tab: state.source,
    range: state.range,
    from: state.range === 'custom' ? state.custom?.from : undefined,
    to: state.range === 'custom' ? state.custom?.to : undefined,
    compare: state.compare,
    filters: { ...state.filters },
    pagesSort: state.source === 'own' ? pagesSort : undefined,
  };
}

/** Builtins first (a stable landing set), then most-recently-updated first among the rest — a growing list of operator views never buries the three shipped ones. */
export function sortAnalyticsViews(views: readonly AnalyticsSavedView[]): AnalyticsSavedView[] {
  return [...views].sort((a, b) => {
    if (Boolean(a.builtin) !== Boolean(b.builtin)) return a.builtin ? -1 : 1;
    return b.updatedAt.localeCompare(a.updatedAt) || a.name.localeCompare(b.name);
  });
}

// ─── `?view=<id>` URL addressing (D1-style: parse/serialize pair, pure) ────

/** `undefined` for a bare `/admin/analytics` visit or a query string that carries no `view` param — never throws on a malformed search string. */
export function viewIdFromSearch(search: string): string | undefined {
  try {
    const id = new URLSearchParams(search).get('view');
    return id && id.trim() ? id.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** The inverse of `viewIdFromSearch` — a selected view bookmarks as `?view=<id>` alone, not the fully expanded `source`/`range`/… params (those are what a *diverged* selection falls back to; see `AnalyticsWorkspace`'s `activeViewId` handling). */
export function serializeViewSearch(id: string): string {
  return new URLSearchParams({ view: id }).toString();
}

// ─── operator notes (R11.3 — "click a day, add a note") ───────────────────

export const MAX_NOTE_LENGTH = 500;

export interface AnalyticsNoteInput {
  /** `YYYY-MM-DD` — the clicked bucket's date. */
  date: string;
  text: string;
}

export interface AnalyticsNote extends AnalyticsNoteInput {
  id: string;
  createdBy: string;
  createdAt: string;
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const isValidNoteDate = (date: string): boolean => ISO_DATE_RE.test(date);

export function isValidNoteText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= MAX_NOTE_LENGTH;
}

/** Notes touching a date range, inclusive both ends — `YYYY-MM-DD` string compare is safe since every note date is already validated to that exact shape. */
export function notesInRange(notes: readonly AnalyticsNote[], from: string, to: string): AnalyticsNote[] {
  return notes.filter((note) => note.date >= from && note.date <= to);
}

export function sortAnalyticsNotes(notes: readonly AnalyticsNote[]): AnalyticsNote[] {
  return [...notes].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));
}
