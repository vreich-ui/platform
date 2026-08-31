/**
 * Own-tracker traffic (T21.2b) — pure transforms for the `admin-traffic`
 * `?source=own` feed, a first-party proxy over `${TRACKING_SINK_URL}/stats`
 * (contract: kugel-data's `/stats`, built in parallel — see
 * `server/lib/own-tracker-stats.ts` for the I/O half and this repo's
 * TRACKING_SINK_URL/TRACKING_PROJECT_ID env pair, already wired for
 * commerce-events/member-link forwarding).
 *
 * Same house split as `traffic-logic.ts`: I/O stays server-side, only pure
 * shaping lives here so it is unit-testable without a live sink. The
 * trend/ranking shaping deliberately REUSES `mapAnalyticsToChartSeries` (no
 * new geometry/ranking math) so `TrendChart`/`BarList` render this feed
 * exactly like the Netlify one.
 */
import { mapAnalyticsToChartSeries, type TrafficChartSeries, type RawTrafficAnalytics } from './traffic-logic.js';

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
export function ownTrackerChartSeries(stats: OwnTrackerStatsPayload): TrafficChartSeries {
  const raw: RawTrafficAnalytics = {
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
