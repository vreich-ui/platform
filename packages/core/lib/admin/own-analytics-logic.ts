/**
 * Own-tracker analytics (T21.2b; admin-traffic renamed admin-analytics, T21.9b;
 * R6.2 data points, T21.24) — pure transforms for the `admin-analytics`
 * `?source=own` feed, a first-party proxy over `${TRACKING_SINK_URL}/stats`
 * (contract: kugel-data's `/stats`, still deploying in parallel — see
 * `server/lib/own-tracker-stats.ts` for the I/O half).
 *
 * R6.2 rebases the own tracker onto the SAME shared range picker as Netlify
 * (`resolveDateWindow` in `analytics-logic.ts`) instead of a bespoke
 * `OwnTrackerDays = 7|30` union — the sink now accepts `from`/`to`, which is
 * what let the range picker drop its "own tracker can't do 90d/custom"
 * restriction. One useful side effect: capture rate (own ÷ Netlify
 * pageviews) no longer needs day-count matching — both tabs resolve the
 * exact same window now, so there is nothing left to disagree about.
 *
 * Same house split as `analytics-logic.ts`: I/O stays server-side, only pure
 * shaping lives here so it is unit-testable without a live sink. Every
 * consumer below degrades a missing/malformed field to a safe default rather
 * than throwing — the sink contract, including everything R6.2 adds, is
 * still moving, and "every field may be missing" is the standing posture.
 */
import {
  mapAnalyticsToChartSeries,
  formatAnalyticsCount,
  computeDelta,
  withShareLimit,
  type AnalyticsChartSeries,
  type AnalyticsDateWindow,
  type DateWindowResult,
  type AnalyticsRangeKey,
  type AnalyticsRankingRow,
  type RawAnalyticsData,
  type AnalyticsRankingRowWithShare,
  type AnalyticsFilters,
  type KpiDatum,
  type RankingGroup,
  type RankingView,
  type AnalyticsFooterItem,
  type AnalyticsPanelState,
} from './analytics-logic.js';

// ─── R6.2: the sink's ≤20-row dimensions get a taller cap than the original 8-row bar lists — the card's own scroll area covers the rest (no "view all" expand built). ──
const EXTENDED_LIST_LIMIT = 20;

export interface OwnTrackerDaily {
  date: string;
  pageviews: number;
  sessions: number;
  visitors: number;
  buy_clicks: number;
  purchases: number;
}

export interface OwnTrackerTopObject {
  object_id: string;
  object_type: string;
  pageviews: number;
  sessions: number;
  completion_rate: number;
}

export interface OwnTrackerTopSource {
  referrer_host_or_utm_source: string;
  sessions: number;
}

export interface OwnTrackerTotals {
  events_by_kind: Record<string, number>;
  sessions: number;
  visitors: number;
  consented_sessions: number;
  commerce_events: number;
  member_links: number;
}

// ─── R6.2: the new `/stats` fields (kugel-data, contract pinned in the R6.2 brief; every field optional/defensive — none of this may have deployed yet) ──

export interface OwnTrackerCountryRow {
  country: string;
  sessions: number;
}

export interface OwnTrackerReferrerHostRow {
  host: string;
  sessions: number;
}

export interface OwnTrackerReferrerHosts {
  hosts: OwnTrackerReferrerHostRow[];
  /** Same-host referrers, bucketed out (D8) — never itself a ranked row. */
  internal_sessions: number;
}

export interface OwnTrackerUtmRow {
  value: string;
  sessions: number;
}

export interface OwnTrackerUtm {
  source: OwnTrackerUtmRow[];
  medium: OwnTrackerUtmRow[];
  campaign: OwnTrackerUtmRow[];
}

export interface OwnTrackerViewportBuckets {
  lt640: number;
  w640to1023: number;
  gte1024: number;
}

export interface OwnTrackerLangRow {
  lang: string;
  sessions: number;
}

export interface OwnTrackerDevices {
  viewport: OwnTrackerViewportBuckets;
  top_langs: OwnTrackerLangRow[];
}

export interface OwnTrackerPageRow {
  url_path: string;
  sessions: number;
}

/** Cumulative scroll-depth buckets — each key's count includes everyone who scrolled at least that far. */
export interface OwnTrackerScrollDepth {
  '25'?: number;
  '50'?: number;
  '75'?: number;
  '90'?: number;
  '100'?: number;
}

export interface OwnTrackerEngagementFunnelRow {
  object_id: string;
  pageview: number;
  read_progress: number;
  completion: number;
  cta_click: number;
  buy_click: number;
}

export interface OwnTrackerEventsByKindDaily {
  date: string;
  events_by_kind: Record<string, number>;
}

export interface OwnTrackerHourlyRow {
  hour: string;
  pageviews: number;
  sessions: number;
  visitors: number;
  buy_clicks: number;
}

export interface OwnTrackerObjectNode {
  node_id: string;
  strategy: string | null;
  intent: string | null;
  position: number;
  impressions: number;
  sessions: number;
  dwell_ms_avg: number;
}

/**
 * R11.4 — per-variant traffic, when the sink can attribute events to a
 * specific variant version. `variant-experiments.ts`'s header is the reason
 * this is never called "arm metrics" in any label/copy this repo renders:
 * `create_variant` publishes each variant as its own permalink rather than
 * splitting traffic to one — so these are that variant's own read numbers,
 * not a randomized-arm comparison. Optional like everything else the sink
 * has not necessarily deployed yet.
 */
export interface OwnTrackerObjectVariantMetrics {
  pageviews: number;
  sessions: number;
  completion_rate: number;
}

export interface OwnTrackerObjectVariant {
  object_id: string;
  version: number;
  route: string | null;
  published_at: string | null;
  metrics?: OwnTrackerObjectVariantMetrics;
}

export interface OwnTrackerObjectDetail {
  object_id: string;
  object_type: string;
  pageviews: number;
  sessions: number;
  completion_rate: number;
  funnel: Omit<OwnTrackerEngagementFunnelRow, 'object_id'>;
  nodes: OwnTrackerObjectNode[];
  variants: OwnTrackerObjectVariant[];
}

export interface OwnTrackerDims {
  object_version?: string;
  producer?: string;
  node_strategy?: string;
}

/** The `/stats` response contract (kugel-data). Field names are pinned, not
 *  guessed; every consumer below still degrades a missing/malformed field to
 *  a safe default rather than throwing, since the contract is still moving —
 *  R6.2 in particular adds everything from `from` down through `previous`,
 *  none of which may have deployed yet. */
export interface OwnTrackerStatsPayload {
  project_id: string;
  days: number;
  /** R6.2 — ISO window bounds, echoing the request. */
  from?: string;
  to?: string;
  totals: OwnTrackerTotals;
  daily: OwnTrackerDaily[];
  top_objects: OwnTrackerTopObject[];
  top_sources: OwnTrackerTopSource[];
  last_event_at: string | null;
  dims?: OwnTrackerDims;
  // ─── R6.2 additions ───────────────────────────────────────────────────
  top_countries?: OwnTrackerCountryRow[];
  top_referrer_hosts?: OwnTrackerReferrerHosts;
  utm?: OwnTrackerUtm;
  devices?: OwnTrackerDevices;
  entry_pages?: OwnTrackerPageRow[];
  exit_pages?: OwnTrackerPageRow[];
  scroll_depth_distribution?: OwnTrackerScrollDepth;
  engagement_funnel?: OwnTrackerEngagementFunnelRow[];
  events_by_kind_daily?: OwnTrackerEventsByKindDaily[];
  /** Dropped from the UI per the approved spec's resolved Q3 (§9.3) — an hourly view is mostly noise at current volume. Typed here only so a payload that carries it is never rejected. */
  hourly?: OwnTrackerHourlyRow[];
  object?: OwnTrackerObjectDetail | null;
  /** D3 — the immediately-preceding, same-length window. Shape mirrors this payload minus `project_id`/`days`/`object`. */
  previous?: Omit<OwnTrackerStatsPayload, 'project_id' | 'days' | 'object' | 'previous'>;
}

export type OwnAnalyticsErrorCode = 'own_tracker_unconfigured';

/**
 * R6.2 — server-side resolution of an object id to its title/route/admin
 * link (D6), from the tenant's `data/site/**` exports, cached per deploy
 * (`analytics-object-directory.ts`). `null` for an id that was looked up and
 * NOT found (still rendered — the id, with a muted "unresolved" marker —
 * never hidden); an id absent from the map entirely was never looked up.
 */
export interface ObjectDirectoryEntry {
  title: string;
  route: string | null;
  objectType: string;
}
export type ObjectDirectory = Readonly<Record<string, ObjectDirectoryEntry | null>>;

/**
 * The `admin-analytics?source=own` response shape. Lives here, not in
 * `own-analytics-client.ts` (which re-exports it) — the panel resolver below
 * is pure and needs this shape without importing the fetch wrapper's I/O.
 */
export interface OwnAnalyticsOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: OwnAnalyticsErrorCode;
  message?: string;
  range: AnalyticsRangeKey;
  window?: AnalyticsDateWindow;
  stats?: OwnTrackerStatsPayload;
  /** R6.2/D6 — object id → title/route/type, for every id this response references (`top_objects` + `engagement_funnel`). */
  object_directory?: ObjectDirectory;
  /**
   * W7.4 — engagement grouped by the surface that PUBLISHED each object.
   * Computed server-side (admin-analytics joins the top objects against their
   * publish receipts), so it needs nothing from the sink and works today.
   */
  surfaces?: SurfaceSplitRow[];
}

/**
 * W7.4 — engagement split by the surface that PUBLISHED each object.
 *
 * The question this exists for: "do plugin-written articles perform differently
 * from workflow-written ones?" It is the whole reason the surface is stamped on
 * the publish receipt and the export.
 *
 * The join is done HERE, in the CMS, rather than waiting on the sink to grow a
 * dimension: the tenant already knows which surface published every object (the
 * publish receipt says so), and `top_objects` already carries object ids. No
 * external contract has to move for this to work, which is why it works today.
 */
export interface SurfaceSplitRow {
  /** `plugin:claude` … or `workflow` for the autonomous path, or `unknown`. */
  surface: string;
  objects: number;
  pageviews: number;
}

/** Objects published before W7.4, or by the workflow, carry no surface. */
export const WORKFLOW_SURFACE = 'workflow';

/**
 * Group `top_objects` by publishing surface.
 *
 * An object the map does not know is `unknown` rather than silently folded into
 * `workflow`: "we did not record this" and "the autonomous path published it"
 * are different facts, and merging them would quietly overstate the workflow's
 * share for every article published before the surface was stamped.
 */
export function surfaceSplit(
  stats: Pick<OwnTrackerStatsPayload, 'top_objects'>,
  surfaceByObjectId: Readonly<Record<string, string | null>>
): SurfaceSplitRow[] {
  const totals = new Map<string, SurfaceSplitRow>();
  for (const row of stats.top_objects ?? []) {
    const objectId = typeof row?.object_id === 'string' ? row.object_id : '';
    if (!objectId) continue;
    const known = Object.hasOwn(surfaceByObjectId, objectId);
    const surface = known ? (surfaceByObjectId[objectId] ?? WORKFLOW_SURFACE) : 'unknown';
    const existing = totals.get(surface) ?? { surface, objects: 0, pageviews: 0 };
    existing.objects += 1;
    existing.pageviews += typeof row?.pageviews === 'number' && Number.isFinite(row.pageviews) ? row.pageviews : 0;
    totals.set(surface, existing);
  }
  return [...totals.values()].sort((a, b) => b.pageviews - a.pageviews || a.surface.localeCompare(b.surface));
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const str = (value: unknown, fallback: string): string => (typeof value === 'string' && value ? value : fallback);

/**
 * Own-tracker daily/top-N rows → the SAME {trend, topPaths, topSources}
 * shape `mapAnalyticsToChartSeries` already turns into totals + shares —
 * reused as-is (T21.2b: "no new chart code"). Pageviews stand in for
 * "visits", sessions for "uniques" in the shared shape; the caller supplies
 * its own display labels ("Pageviews"/"Sessions") rather than relabeling
 * this as Netlify's "Visits"/"Unique visitors" (that would misdescribe the
 * numbers — see `TrendChart`'s seriesALabel/seriesBLabel).
 */
export function ownTrackerChartSeries(stats: OwnTrackerStatsPayload): AnalyticsChartSeries {
  const raw: RawAnalyticsData = {
    trend: (stats.daily ?? []).map((row) => ({
      t: str(row?.date, ''),
      visits: num(row?.pageviews),
      uniques: num(row?.sessions),
    })),
    topPaths: (stats.top_objects ?? []).map((row) => ({
      label: str(row?.object_id, '(unknown object)'),
      visits: num(row?.pageviews),
    })),
    topSources: (stats.top_sources ?? []).map((row) => ({
      label: str(row?.referrer_host_or_utm_source, 'Direct'),
      visits: num(row?.sessions),
    })),
  };
  return mapAnalyticsToChartSeries(raw);
}

export interface OwnTrackerStatRow {
  sessions: number;
  visitors: number;
  /** 0..100, one decimal. `null` when there are no sessions to divide by. */
  consentedPct: number | null;
  purchases: number;
  lastEventAt: string | null;
}

/** Totals + the daily-summed purchase count (there is no `totals.purchases` in the contract). */
export function ownTrackerStatRow(stats: OwnTrackerStatsPayload): OwnTrackerStatRow {
  const sessions = num(stats.totals?.sessions);
  const visitors = num(stats.totals?.visitors);
  const consentedSessions = num(stats.totals?.consented_sessions);
  const purchases = (stats.daily ?? []).reduce((sum, row) => sum + num(row?.purchases), 0);
  return {
    sessions,
    visitors,
    consentedPct: sessions > 0 ? Math.round((consentedSessions / sessions) * 1000) / 10 : null,
    purchases,
    lastEventAt: typeof stats.last_event_at === 'string' && stats.last_event_at ? stats.last_event_at : null,
  };
}

/**
 * R6.2 — capture rate = own-tracker pageviews ÷ Netlify pageviews, over the
 * SAME window. Both tabs resolve the identical window now (the shared range
 * picker, `resolveDateWindow`), so — unlike pre-R6.2 — there is no day-count
 * mismatch left to guard against; the only remaining "can't compare" case is
 * Netlify not having loaded/being unavailable (`netlifyPageviews === null`)
 * or having recorded zero pageviews (nothing to divide by, not "infinite
 * capture").
 */
export function captureRate(ownPageviews: number, netlifyPageviews: number | null): number | null {
  if (netlifyPageviews === null || netlifyPageviews <= 0) return null;
  return Math.round((ownPageviews / netlifyPageviews) * 1000) / 10;
}

/**
 * W7.4 — the surface split as bar-list rows.
 *
 * `share` is relative to the LARGEST surface, matching every other bar list
 * on this page (`withShare` in `analytics-logic.ts`). A bar list whose fills
 * meant something different from the one beside it would be read wrong at a
 * glance.
 */
export function surfaceBarRows(rows: readonly SurfaceSplitRow[]): AnalyticsRankingRowWithShare[] {
  const max = rows.reduce((most, row) => Math.max(most, row.pageviews), 0);
  return rows.map((row) => ({
    label: `${row.surface} (${row.objects} object${row.objects === 1 ? '' : 's'})`,
    visits: row.pageviews,
    share: max > 0 ? row.pageviews / max : 0,
  }));
}

// ─── R6.2/D6: object id → title/route/admin-link decoration ────────────────

const adminObjectHref = (objectId: string): string => `/admin/content/${encodeURIComponent(objectId)}`;

/** R11.4 — every row keyed by an object id also links to its analytics drill-down. */
const adminAnalyticsObjectHref = (objectId: string): string =>
  `/admin/analytics/object/${encodeURIComponent(objectId)}`;

/**
 * `directory` absent ⇒ resolution never ran (server-side object directory
 * unavailable, e.g. the export tree is unreadable) — every id renders as
 * itself with the "unresolved" marker, same as an id the directory actually
 * looked up and could not find. Both are visible, never hidden (D6).
 */
function objectDisplay(
  objectId: string,
  directory: ObjectDirectory | undefined
): { label: string; href?: string; adminHref: string; analyticsHref: string; unresolved: boolean } {
  const entry = directory ? directory[objectId] : undefined;
  if (entry)
    return {
      label: entry.title,
      href: entry.route ?? undefined,
      adminHref: adminObjectHref(objectId),
      analyticsHref: adminAnalyticsObjectHref(objectId),
      unresolved: false,
    };
  return {
    label: objectId,
    adminHref: adminObjectHref(objectId),
    analyticsHref: adminAnalyticsObjectHref(objectId),
    unresolved: true,
  };
}

/**
 * R11.1 — the one alternate sort a saved view can ask for (the "Content
 * performance" default: "Pages panel sorted by completion %", task brief
 * verbatim). `pageviews` (the default) is `withShareLimit`'s own visits-desc
 * sort, unchanged; `completion_rate` sorts the SAME rows by
 * `top_objects[].completion_rate` before the bar-share pass, so a low-traffic
 * object with a strong completion rate can out-rank a high-traffic one that
 * bores everyone by the first scroll — the whole point of the alternate view.
 * `share` still communicates relative PAGEVIEWS (not the sort key) so the bar
 * fill means the same thing on every view of this card; the completion
 * percentage itself already lives in each row's own `completion_rate`
 * field on `top_objects` and is surfaced via `sublabel` when this sort is
 * active, since a bar sorted by a number the bar's fill doesn't show would be
 * unreadable otherwise.
 */
export type ObjectRowsSort = 'pageviews' | 'completion_rate';

/** `stats.top_objects` → ranked, resolved rows (D6) — replaces the raw-id rows `ownTrackerChartSeries.topPaths` produced pre-R6.2. `value` carries the object id for click-to-filter (D7). */
export function topObjectRows(
  stats: Pick<OwnTrackerStatsPayload, 'top_objects'>,
  directory?: ObjectDirectory,
  sortBy: ObjectRowsSort = 'pageviews'
): AnalyticsRankingRowWithShare[] {
  const source = stats.top_objects ?? [];
  const ordered =
    sortBy === 'completion_rate'
      ? [...source].sort((a, b) => num(b?.completion_rate) - num(a?.completion_rate))
      : source;

  const rows: Array<
    AnalyticsRankingRow & {
      value: string;
      href?: string;
      adminHref?: string;
      analyticsHref?: string;
      unresolved?: boolean;
      sublabel?: string;
    }
  > = ordered
    .map((row) => {
      const objectId = str(row?.object_id, '');
      if (!objectId) return null;
      const display = objectDisplay(objectId, directory);
      return {
        label: display.label,
        visits: num(row?.pageviews),
        value: objectId,
        href: display.href,
        adminHref: display.adminHref,
        analyticsHref: display.analyticsHref,
        unresolved: display.unresolved,
        sublabel: sortBy === 'completion_rate' ? `${Math.round(num(row?.completion_rate) * 100)}% complete` : undefined,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);

  if (sortBy === 'completion_rate') {
    // Bypass `withShareLimit`'s own visits-desc sort (it would undo the
    // ordering just built) — cap to the same extended limit and share against
    // the same "largest pageview count in this set" baseline everything else
    // uses, so the bar fill still reads as "share of pageviews" here too.
    const top = rows.slice(0, EXTENDED_LIST_LIMIT);
    const max = top.reduce((m, row) => Math.max(m, row.visits), 0);
    return top.map((row) => ({ ...row, share: max > 0 ? row.visits / max : 0 }));
  }
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

/** The sink's own "no referrer" sentinel (`(direct)`, GA-style) reads oddly as a UI label — normalize it (and an absent/blank value) to "Direct"; any other value passes through untouched. */
function normalizeSourceLabel(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : '';
  return !raw || raw.toLowerCase() === '(direct)' ? 'Direct' : raw;
}

/** `stats.top_sources` (pre-R6.2 shape — a single label, no split by referrer/UTM dimension). Kept for the `dims` fallback footer stat and as the pre-R6.2-payload rendering path. */
export function topSourceRows(stats: Pick<OwnTrackerStatsPayload, 'top_sources'>): AnalyticsRankingRowWithShare[] {
  const rows = (stats.top_sources ?? []).map((row) => ({
    label: normalizeSourceLabel(row?.referrer_host_or_utm_source),
    visits: num(row?.sessions),
    value: str(row?.referrer_host_or_utm_source, 'Direct'),
  }));
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

// ─── R6.2: the new dimension rankings — every one defensive against an absent field ──

export function topCountryRows(stats: Pick<OwnTrackerStatsPayload, 'top_countries'>): AnalyticsRankingRowWithShare[] {
  const rows = (stats.top_countries ?? []).map((row) => ({
    label: str(row?.country, '(unknown)'),
    visits: num(row?.sessions),
    value: str(row?.country, ''),
  }));
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

export interface ReferrerHostResult {
  rows: AnalyticsRankingRowWithShare[];
  /** D8: same-host sessions, reported once as a footnote — never itself a ranked row. */
  internalSessions: number;
}

export function topReferrerHostRows(stats: Pick<OwnTrackerStatsPayload, 'top_referrer_hosts'>): ReferrerHostResult {
  const bucket = stats.top_referrer_hosts;
  const rows = (bucket?.hosts ?? []).map((row) => ({
    label: str(row?.host, 'Direct'),
    visits: num(row?.sessions),
    value: str(row?.host, ''),
  }));
  return { rows: withShareLimit(rows, EXTENDED_LIST_LIMIT), internalSessions: num(bucket?.internal_sessions) };
}

export type UtmDimension = 'source' | 'medium' | 'campaign';

export function utmRows(
  stats: Pick<OwnTrackerStatsPayload, 'utm'>,
  dimension: UtmDimension
): AnalyticsRankingRowWithShare[] {
  const rows = (stats.utm?.[dimension] ?? []).map((row) => ({
    label: str(row?.value, '(none)'),
    visits: num(row?.sessions),
    value: str(row?.value, ''),
  }));
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

const VIEWPORT_LABELS: Record<keyof OwnTrackerViewportBuckets, string> = {
  lt640: '< 640px',
  w640to1023: '640–1023px',
  gte1024: '≥ 1024px',
};

export function deviceViewportRows(stats: Pick<OwnTrackerStatsPayload, 'devices'>): AnalyticsRankingRowWithShare[] {
  const buckets = stats.devices?.viewport;
  if (!buckets) return [];
  const rows = (Object.keys(VIEWPORT_LABELS) as Array<keyof OwnTrackerViewportBuckets>).map((key) => ({
    label: VIEWPORT_LABELS[key],
    visits: num(buckets[key]),
  }));
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

export function deviceLangRows(stats: Pick<OwnTrackerStatsPayload, 'devices'>): AnalyticsRankingRowWithShare[] {
  const rows = (stats.devices?.top_langs ?? []).map((row) => ({
    label: str(row?.lang, '(unknown)'),
    visits: num(row?.sessions),
  }));
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

export function entryExitPageRows(
  stats: OwnTrackerStatsPayload,
  which: 'entry_pages' | 'exit_pages'
): AnalyticsRankingRowWithShare[] {
  const rows = (stats[which] ?? []).map((row) => {
    const path = str(row?.url_path, '(unknown page)');
    return { label: path, visits: num(row?.sessions), href: path.startsWith('/') ? path : undefined };
  });
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

const SCROLL_DEPTH_BUCKETS: ReadonlyArray<keyof OwnTrackerScrollDepth> = ['25', '50', '75', '90', '100'];

/** Cumulative buckets rendered as their own ranking rows — the caller (`RankingView`) carries no `filterKey`; scroll depth is not one of the three filterable dimensions. */
export function scrollDepthRows(
  stats: Pick<OwnTrackerStatsPayload, 'scroll_depth_distribution'>
): AnalyticsRankingRowWithShare[] {
  const dist = stats.scroll_depth_distribution;
  if (!dist) return [];
  const rows = SCROLL_DEPTH_BUCKETS.filter((bucket) => typeof dist[bucket] === 'number').map((bucket) => ({
    label: `${bucket}%`,
    visits: num(dist[bucket]),
  }));
  return withShareLimit(rows, SCROLL_DEPTH_BUCKETS.length);
}

/** Per-stage rate relative to `pageview` — `null` (renders as "—") when there is nothing to divide by. */
const stageRate = (stage: number, pageview: number): string =>
  pageview > 0 ? `${Math.round((stage / pageview) * 100)}%` : '—';

/**
 * `stats.engagement_funnel` → resolved, ranked rows (D6), sorted by
 * pageview. `sublabel` carries the per-stage conversion — the funnel shape
 * itself (5 numbers) doesn't fit a single bar-list row, so this is the
 * closest single-line summary that still reads at a glance. Clicking a row
 * filters by that object, same dimension as the Pages card's "Top" view.
 */
export function engagementFunnelRows(
  stats: Pick<OwnTrackerStatsPayload, 'engagement_funnel'>,
  directory?: ObjectDirectory
): AnalyticsRankingRowWithShare[] {
  const rows = (stats.engagement_funnel ?? [])
    .map((row) => {
      const objectId = str(row?.object_id, '');
      if (!objectId) return null;
      const pageview = num(row?.pageview);
      const display = objectDisplay(objectId, directory);
      const sublabel = `${stageRate(num(row?.read_progress), pageview)} read · ${stageRate(num(row?.completion), pageview)} complete · ${stageRate(num(row?.cta_click), pageview)} CTA · ${stageRate(num(row?.buy_click), pageview)} buy`;
      return {
        label: display.label,
        visits: pageview,
        value: objectId,
        sublabel,
        href: display.href,
        adminHref: display.adminHref,
        analyticsHref: display.analyticsHref,
        unresolved: display.unresolved,
      };
    })
    .filter((row): row is NonNullable<typeof row> => row !== null);
  return withShareLimit(rows, EXTENDED_LIST_LIMIT);
}

// ─── R6.2: the own tab's panel state ─────────────────────────────────────────

export interface OwnPanelInput {
  loading: boolean;
  error: string | null;
  /** R6.2 — the own tab now shares the Netlify tab's range picker (from/to, incl. custom), so an invalid custom range is a `range_error` here too, checked before loading/overview exactly like `resolveNetlifyAnalyticsPanel`. */
  windowResult: DateWindowResult;
  overview: OwnAnalyticsOverview | null;
  /** Netlify's window total, when that feed is loaded/enabled — `null` while unknown/unavailable. Both tabs share one window now (R6.2), so no day-count is needed alongside it. */
  netlifyPageviews: number | null;
  /** D3 — off by default for `custom` (the caller applies `defaultCompareForRange`); deltas render only when `stats.previous` is ALSO present. */
  compare: boolean;
  /** D7 — the active click-to-filter selection, echoed back so the panel can render removable chips and mark the matching rows' cards. */
  filters: AnalyticsFilters;
  /** R11.1 — a saved view's alternate Pages-card sort (`analytics-views-logic.ts`'s `AnalyticsPagesSort`). Absent = the page's normal pageviews-desc default. */
  pagesSort?: ObjectRowsSort;
}

const totalsOf = (
  stats: OwnTrackerStatsPayload['previous']
): { pageviews: number; sessions: number; visitors: number } => {
  const pageviews = (stats?.daily ?? []).reduce((sum, row) => sum + num(row?.pageviews), 0);
  return { pageviews, sessions: num(stats?.totals?.sessions), visitors: num(stats?.totals?.visitors) };
};

/** One card, one view — the shape most of these dimensions render as. */
const singleView = (
  id: string,
  label: string,
  rows: AnalyticsRankingRowWithShare[],
  emptyMessage: string,
  extra: Partial<RankingView> = {}
): RankingView => ({ id, label, rows, emptyMessage, ...extra });

/**
 * The own tab's panel state — `AnalyticsPanelState`, shared with the Netlify
 * tab's `resolveNetlifyAnalyticsPanel` (D1: same components, different
 * data). Capture rate and last-event live in `footer`, never `kpis` (R6.1:
 * "a health timestamp is not a metric"). D5's tabbed ranking cards: Pages
 * (top/entry/exit) · Sources (referrer/UTM source/medium/campaign) ·
 * Locations (country) · Devices (viewport/language) · Engagement (funnel,
 * scroll depth) — each dimension degrades to an empty view, never a missing
 * card, when its sink field hasn't deployed yet.
 */
export function resolveOwnAnalyticsPanel(input: OwnPanelInput): AnalyticsPanelState {
  const { loading, error, windowResult, overview, netlifyPageviews, compare, filters, pagesSort } = input;
  if (!windowResult.ok) return { kind: 'range_error', message: windowResult.error };
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error', message: error };
  if (!overview) return { kind: 'loading' };

  if (!overview.configured || !overview.stats) {
    return {
      kind: 'not_configured',
      message:
        overview.message ??
        'The own-tracker sink is not configured for this site. Set TRACKING_SINK_URL and TRACKING_PROJECT_ID to see first-party analytics here.',
    };
  }

  const stats = overview.stats;
  const directory = overview.object_directory;
  const series = ownTrackerChartSeries(stats);
  const stat = ownTrackerStatRow(stats);
  const rate = captureRate(series.totals.visits, netlifyPageviews);

  const previous = compare ? stats.previous : undefined;
  const previousTotals = previous ? totalsOf(previous) : undefined;

  const kpis: KpiDatum[] = [
    {
      id: 'pageviews',
      label: 'Pageviews',
      value: formatAnalyticsCount(series.totals.visits),
      delta: computeDelta(series.totals.visits, previousTotals?.pageviews) ?? undefined,
    },
    {
      id: 'sessions',
      label: 'Sessions',
      value: formatAnalyticsCount(stat.sessions),
      delta: computeDelta(stat.sessions, previousTotals?.sessions) ?? undefined,
    },
    {
      id: 'visitors',
      label: 'Visitors',
      value: formatAnalyticsCount(stat.visitors),
      delta: computeDelta(stat.visitors, previousTotals?.visitors) ?? undefined,
    },
    {
      id: 'consented',
      label: 'Consented',
      value: stat.consentedPct === null ? '—' : `${stat.consentedPct}%`,
      hint: 'Share of sessions with tracking consent',
    },
    { id: 'purchases', label: 'Purchases', value: formatAnalyticsCount(stat.purchases) },
  ];

  const { rows: referrerRows, internalSessions } = topReferrerHostRows(stats);
  const hasNewSourceDims = Boolean(stats.top_referrer_hosts || stats.utm);

  const rankings: RankingGroup[] = [
    {
      id: 'pages',
      title: 'Pages',
      views: [
        singleView(
          'top',
          'Top',
          topObjectRows(stats, directory, pagesSort),
          'No object views recorded in this range.',
          {
            filterKey: 'object_id',
            footnote: pagesSort === 'completion_rate' ? 'Sorted by completion rate (this view).' : undefined,
          }
        ),
        singleView(
          'entry',
          'Entry',
          entryExitPageRows(stats, 'entry_pages'),
          stats.entry_pages
            ? 'No entry-page data recorded in this range.'
            : 'Not available until the sink deploys this field.'
        ),
        singleView(
          'exit',
          'Exit',
          entryExitPageRows(stats, 'exit_pages'),
          stats.exit_pages
            ? 'No exit-page data recorded in this range.'
            : 'Not available until the sink deploys this field.'
        ),
      ],
    },
    {
      id: 'sources',
      title: 'Sources',
      views: hasNewSourceDims
        ? [
            singleView('referrer', 'Referrer', referrerRows, 'No referrer data recorded in this range.', {
              filterKey: 'source',
              footnote:
                internalSessions > 0
                  ? `Internal navigation: ${formatAnalyticsCount(internalSessions)} sessions (same-host referrers — not ranked as a source, D8).`
                  : undefined,
            }),
            singleView(
              'utm_source',
              'UTM source',
              utmRows(stats, 'source'),
              'No UTM source data recorded in this range.',
              { filterKey: 'source' }
            ),
            singleView(
              'utm_medium',
              'UTM medium',
              utmRows(stats, 'medium'),
              'No UTM medium data recorded in this range.',
              { filterKey: 'source' }
            ),
            singleView(
              'utm_campaign',
              'UTM campaign',
              utmRows(stats, 'campaign'),
              'No UTM campaign data recorded in this range.',
              { filterKey: 'source' }
            ),
          ]
        : // Pre-R6.2 payload shape (no `top_referrer_hosts`/`utm` yet) — fall back to the one combined dimension the old contract carried, still filterable.
          [
            singleView('legacy', 'Sources', topSourceRows(stats), 'No referrer/UTM data recorded in this range.', {
              filterKey: 'source',
            }),
          ],
    },
    {
      id: 'locations',
      title: 'Locations',
      views: [
        singleView(
          'country',
          'Country',
          topCountryRows(stats),
          stats.top_countries
            ? 'No country data recorded in this range.'
            : 'Not available until the sink deploys this field.',
          {
            filterKey: 'country',
          }
        ),
      ],
    },
    {
      id: 'devices',
      title: 'Devices',
      views: [
        singleView(
          'viewport',
          'Viewport',
          deviceViewportRows(stats),
          stats.devices ? 'No device data recorded in this range.' : 'Not available until the sink deploys this field.'
        ),
        singleView(
          'language',
          'Language',
          deviceLangRows(stats),
          stats.devices
            ? 'No language data recorded in this range.'
            : 'Not available until the sink deploys this field.'
        ),
      ],
    },
    {
      id: 'engagement',
      title: 'Engagement',
      views: [
        singleView(
          'funnel',
          'Funnel',
          engagementFunnelRows(stats, directory),
          stats.engagement_funnel
            ? 'No engagement data recorded in this range.'
            : 'Not available until the sink deploys this field.',
          {
            filterKey: 'object_id',
          }
        ),
        singleView(
          'scroll_depth',
          'Scroll depth',
          scrollDepthRows(stats),
          stats.scroll_depth_distribution
            ? 'No scroll-depth data recorded in this range.'
            : 'Not available until the sink deploys this field.'
        ),
      ],
    },
  ];

  // W7.4: the whole reason the publishing surface is stamped on a receipt —
  // rendered only when there is more than one surface in the window, because
  // a single-surface bar chart is a bar chart of one fact.
  if ((overview.surfaces?.length ?? 0) > 1) {
    rankings.push({
      id: 'surfaces',
      title: 'Publishing surface',
      views: [
        singleView(
          'surfaces',
          'By surface',
          surfaceBarRows(overview.surfaces ?? []),
          'No published-surface data for this range.',
          {
            footnote:
              'workflow is the autonomous path. unknown means the object could not be read, or was published before the surface was recorded — deliberately not folded into workflow, which would overstate its share.',
          }
        ),
      ],
    });
  }

  const footer: AnalyticsFooterItem[] = [
    {
      id: 'last_event',
      label: 'Last event',
      value: stat.lastEventAt ? new Date(stat.lastEventAt).toLocaleString() : 'None yet',
    },
    rate !== null
      ? {
          id: 'capture_rate',
          label: 'Capture rate',
          value: `${rate}%`,
          hint: 'Own-tracker pageviews ÷ Netlify pageviews (server-side, not blockable) over the same range — a lower bound on client-side visibility, not a completeness score.',
        }
      : {
          id: 'capture_rate',
          label: 'Capture rate',
          value: 'Not available',
          hint: 'Netlify has not loaded, or recorded zero pageviews, for this range.',
        },
  ];

  return {
    kind: 'ready',
    kpis,
    chart: {
      points: series.trend,
      seriesALabel: 'Pageviews',
      seriesBLabel: 'Sessions',
      emptyMessage: 'No events recorded in this range.',
      previousPoints: previous
        ? (previous.daily ?? []).map((row) => ({
            t: str(row?.date, ''),
            visits: num(row?.pageviews),
            uniques: num(row?.sessions),
          }))
        : undefined,
    },
    rankings,
    footer,
    filters,
  };
}
