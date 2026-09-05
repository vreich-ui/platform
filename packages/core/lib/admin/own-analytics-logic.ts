/**
 * Own-tracker analytics (T21.2b; admin-traffic renamed admin-analytics, T21.9b) — pure transforms for the `admin-analytics`
 * `?source=own` feed, a first-party proxy over `${TRACKING_SINK_URL}/stats`
 * (contract: kugel-data's `/stats`, built in parallel — see
 * `server/lib/own-tracker-stats.ts` for the I/O half and this repo's
 * TRACKING_SINK_URL/TRACKING_PROJECT_ID env pair, already wired for
 * commerce-events/member-link forwarding).
 *
 * Same house split as `analytics-logic.ts`: I/O stays server-side, only pure
 * shaping lives here so it is unit-testable without a live sink. The
 * trend/ranking shaping deliberately REUSES `mapAnalyticsToChartSeries` (no
 * new geometry/ranking math) so `TrendChart`/`BarList` render this feed
 * exactly like the Netlify one.
 */
import {
  mapAnalyticsToChartSeries,
  formatAnalyticsCount,
  type AnalyticsChartSeries,
  type RawAnalyticsData,
  type AnalyticsRankingRowWithShare,
  type KpiDatum,
  type RankingGroup,
  type AnalyticsFooterItem,
  type AnalyticsPanelState,
} from './analytics-logic.js';

export type OwnTrackerDays = 7 | 30;

export const isOwnTrackerDays = (value: unknown): value is OwnTrackerDays => value === 7 || value === 30;

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

export interface OwnTrackerDims {
  object_version?: string;
  producer?: string;
  node_strategy?: string;
}

/** The `/stats` response contract (kugel-data, built in parallel — field
 *  names are pinned, not guessed; every consumer below still degrades a
 *  missing/malformed field to a safe default rather than throwing, since the
 *  contract is still moving). */
export interface OwnTrackerStatsPayload {
  project_id: string;
  days: number;
  totals: OwnTrackerTotals;
  daily: OwnTrackerDaily[];
  top_objects: OwnTrackerTopObject[];
  top_sources: OwnTrackerTopSource[];
  last_event_at: string | null;
  dims?: OwnTrackerDims;
}

export type OwnAnalyticsErrorCode = 'own_tracker_unconfigured';

/**
 * The `admin-analytics?source=own` response shape. Lives here, not in
 * `own-analytics-client.ts` (which re-exports it) — the R6.1 panel resolver
 * below is pure and needs this shape without importing the fetch wrapper's
 * I/O.
 */
export interface OwnAnalyticsOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: OwnAnalyticsErrorCode;
  message?: string;
  days: OwnTrackerDays;
  stats?: OwnTrackerStatsPayload;
  /**
   * W7.4 — engagement grouped by the surface that PUBLISHED each object.
   * Computed server-side (admin-analytics joins the top objects against their
   * publish receipts), so it needs nothing from the sink and works today.
   */
  surfaces?: SurfaceSplitRow[];
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
 * Capture rate = own-tracker pageviews ÷ Netlify pageviews, over the SAME
 * window — a lower-bound signal of client-side capture loss (own tracking
 * runs in the browser and is blockable; Netlify Analytics is server-side and
 * ad-blocker-proof), never a "how much of our traffic is real" number.
 * `null` (⇒ the caller hides the stat) whenever the two feeds are not
 * actually looking at the same range — own-tracker only supports 7/30-day
 * windows (`OwnTrackerDays`), so a Netlify range of 90d/custom has no
 * matching own-tracker window to compare against — or when Netlify recorded
 * zero pageviews (nothing to divide by, not "infinite capture").
 */
export function captureRate(
  ownPageviews: number,
  netlifyPageviews: number,
  ownDays: OwnTrackerDays,
  netlifyRangeDays: number | null
): number | null {
  if (netlifyRangeDays === null || netlifyRangeDays !== ownDays) return null;
  if (netlifyPageviews <= 0) return null;
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

// ─── R6.1: the own tab's panel state ─────────────────────────────────────────

export interface OwnPanelInput {
  loading: boolean;
  error: string | null;
  overview: OwnAnalyticsOverview | null;
  /** Netlify's window total, when that feed is loaded/enabled — `null` while unknown/unavailable. */
  netlifyPageviews: number | null;
  /** The day-count Netlify's CURRENT range actually covers (7/30), or `null` for 90d/custom — no matching own-tracker window to compare. */
  netlifyRangeDays: number | null;
  days: OwnTrackerDays;
}

/**
 * The own tab's panel state — `AnalyticsPanelState`, shared with the Netlify
 * tab's `resolveNetlifyAnalyticsPanel` (D1: same components, different
 * data). Capture rate and last-event live in `footer`, never `kpis` (R6.1:
 * "a health timestamp is not a metric").
 */
export function resolveOwnAnalyticsPanel(input: OwnPanelInput): AnalyticsPanelState {
  const { loading, error, overview, netlifyPageviews, netlifyRangeDays, days } = input;
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
  const series = ownTrackerChartSeries(stats);
  const stat = ownTrackerStatRow(stats);
  const rate =
    netlifyPageviews === null ? null : captureRate(series.totals.visits, netlifyPageviews, days, netlifyRangeDays);

  const kpis: KpiDatum[] = [
    { id: 'pageviews', label: 'Pageviews', value: formatAnalyticsCount(series.totals.visits) },
    { id: 'sessions', label: 'Sessions', value: formatAnalyticsCount(stat.sessions) },
    { id: 'visitors', label: 'Visitors', value: formatAnalyticsCount(stat.visitors) },
    {
      id: 'consented',
      label: 'Consented',
      value: stat.consentedPct === null ? '—' : `${stat.consentedPct}%`,
      hint: 'Share of sessions with tracking consent',
    },
    { id: 'purchases', label: 'Purchases', value: formatAnalyticsCount(stat.purchases) },
  ];

  const rankings: RankingGroup[] = [
    {
      id: 'objects',
      title: 'Top objects',
      caption: 'Most-visited objects',
      rows: series.topPaths,
      emptyMessage: 'No object views recorded in this range.',
    },
    {
      id: 'sources',
      title: 'Top sources',
      caption: 'Where visits came from',
      rows: series.topSources,
      emptyMessage: 'No referrer/UTM data recorded in this range.',
    },
  ];

  // W7.4: the whole reason the publishing surface is stamped on a receipt —
  // rendered only when there is more than one surface in the window, because
  // a single-surface bar chart is a bar chart of one fact.
  if ((overview.surfaces?.length ?? 0) > 1) {
    rankings.push({
      id: 'surfaces',
      title: 'Publishing surface',
      caption: 'Which chat app — or the autonomous workflow — published the objects being read',
      rows: surfaceBarRows(overview.surfaces ?? []),
      emptyMessage: 'No published-surface data for this range.',
      footnote:
        'workflow is the autonomous path. unknown means the object could not be read, or was published before the surface was recorded — deliberately not folded into workflow, which would overstate its share.',
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
          hint: 'Only 7d/30d ranges have a matching Netlify window to compare against today.',
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
    },
    rankings,
    footer,
  };
}
