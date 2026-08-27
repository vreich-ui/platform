/**
 * Traffic dashboard (T4.1) — pure logic. Two independent transforms live
 * here, both framework-free and unit-testable (the only tested tier in this
 * codebase, per the admin audit §10/§11.8):
 *
 *  1. Range picker → date window: `resolveDateWindow` turns a range key (or a
 *     custom from/to pair) into the `{from, to, resolution}` the server asks
 *     Netlify Analytics for. Shared by the browser (building the query
 *     string) and the server (deriving the same window again from the same
 *     inputs, rather than trusting a client-computed window verbatim).
 *  2. Analytics response → chart series: `mapAnalyticsToChartSeries` takes
 *     the ALREADY-NORMALIZED intermediate shape (`RawTrafficAnalytics` — see
 *     `server/lib/netlify-analytics.ts` for the raw-Netlify-JSON guessing,
 *     which is deliberately NOT here, mirroring `netlify-deploys.ts`'s
 *     `mapNetlifyDeployToReceipt` staying server-side and untested-in-lib)
 *     and produces the totals/sorted-trend/top-N-with-share shape the charts
 *     render directly.
 *
 * Neither function performs I/O, reads `Date.now()` internally (the caller
 * always passes `now`), or touches `localStorage` — the range-persistence
 * helpers below are pure key/parse functions; the actual `localStorage`
 * read/write (wrapped in try/catch for private browsing) lives in the
 * component, matching `ObjectsPlane.tsx`'s `VIEW_MODE_STORAGE_KEY` pattern.
 */

// ─── range → date window ────────────────────────────────────────────────────

export type TrafficRangeKey = '7d' | '30d' | '90d' | 'custom';

export const DEFAULT_TRAFFIC_RANGE: TrafficRangeKey = '30d';

export const TRAFFIC_RANGE_OPTIONS: ReadonlyArray<{ key: TrafficRangeKey; label: string; days?: number }> = [
  { key: '7d', label: '7 days', days: 7 },
  { key: '30d', label: '30 days', days: 30 },
  { key: '90d', label: '90 days', days: 90 },
  { key: 'custom', label: 'Custom' },
];

/** A window this short is worth an hourly bucket instead of daily. */
const HOURLY_MAX_SPAN_DAYS = 2;

/** Guards a custom range from becoming a de-facto unlimited pull against an undocumented, presumably rate-limited API. */
export const MAX_CUSTOM_RANGE_DAYS = 180;

const DAY_MS = 86_400_000;

export interface CustomRangeInput {
  /** 'YYYY-MM-DD' */
  from: string;
  /** 'YYYY-MM-DD' */
  to: string;
}

export interface TrafficDateWindow {
  /** inclusive, ms since epoch (UTC) */
  from: number;
  /** ms since epoch (UTC) — never later than `now` */
  to: number;
  resolution: 'hour' | 'day';
}

export type DateWindowResult = { ok: true; window: TrafficDateWindow } | { ok: false; error: string };

/**
 * Pure — `now` is always supplied by the caller, never read internally, so
 * this is deterministic and safe to call on both the browser (to build the
 * query string) and the server (to re-derive the same window rather than
 * trust a client-supplied `from`/`to` verbatim).
 */
export function resolveDateWindow(key: TrafficRangeKey, now: Date, custom?: CustomRangeInput): DateWindowResult {
  const toMs = now.getTime();

  if (key !== 'custom') {
    const days = TRAFFIC_RANGE_OPTIONS.find((option) => option.key === key)?.days ?? 30;
    const fromMs = toMs - days * DAY_MS;
    return { ok: true, window: { from: fromMs, to: toMs, resolution: days <= HOURLY_MAX_SPAN_DAYS ? 'hour' : 'day' } };
  }

  if (!custom || !custom.from || !custom.to) {
    return { ok: false, error: 'Enter a start and end date for the custom range.' };
  }

  const fromMs = Date.parse(`${custom.from}T00:00:00.000Z`);
  const toMsCustom = Date.parse(`${custom.to}T23:59:59.999Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMsCustom)) {
    return { ok: false, error: 'Enter valid dates.' };
  }
  if (fromMs > toMsCustom) {
    return { ok: false, error: 'The start date must be on or before the end date.' };
  }
  // One minute of slack for clock skew between browser and server.
  if (fromMs > toMs + 60_000) {
    return { ok: false, error: 'The start date cannot be in the future.' };
  }

  const spanDays = (toMsCustom - fromMs) / DAY_MS;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    return { ok: false, error: `Custom ranges cannot exceed ${MAX_CUSTOM_RANGE_DAYS} days.` };
  }

  const clampedTo = Math.min(toMsCustom, toMs);
  return {
    ok: true,
    window: { from: fromMs, to: clampedTo, resolution: spanDays <= HOURLY_MAX_SPAN_DAYS ? 'hour' : 'day' },
  };
}

// ─── analytics response → chart series ──────────────────────────────────────

export interface TrafficTrendPoint {
  /** ISO date (day resolution) or ISO timestamp (hour resolution). */
  t: string;
  visits: number;
  uniques: number;
}

export interface TrafficRankingRow {
  label: string;
  visits: number;
}

/** The already-normalized shape `server/lib/netlify-analytics.ts` produces from Netlify's raw, undocumented JSON. */
export interface RawTrafficAnalytics {
  trend: TrafficTrendPoint[];
  topPaths: TrafficRankingRow[];
  topSources: TrafficRankingRow[];
}

export interface TrafficTotals {
  visits: number;
  uniques: number;
  /** Rounded mean visits per bucket over the window — a "typical day" stat, not a forecast. */
  avgPerBucket: number;
}

export interface TrafficRankingRowWithShare extends TrafficRankingRow {
  /** 0..1 of the top row's visits — the bar-list fill width. */
  share: number;
}

export interface TrafficChartSeries {
  totals: TrafficTotals;
  /** Ascending by `t`. */
  trend: TrafficTrendPoint[];
  topPaths: TrafficRankingRowWithShare[];
  topSources: TrafficRankingRowWithShare[];
}

/** How many rows each bar list keeps — Netlify's ranking endpoints can return far more than a sidebar-width list can show. */
export const TOP_LIST_LIMIT = 8;

const sortRankingDesc = (rows: TrafficRankingRow[]): TrafficRankingRow[] =>
  [...rows].sort((a, b) => b.visits - a.visits);

const withShare = (rows: TrafficRankingRow[]): TrafficRankingRowWithShare[] => {
  const top = sortRankingDesc(rows).slice(0, TOP_LIST_LIMIT);
  const max = top.reduce((m, row) => Math.max(m, row.visits), 0);
  return top.map((row) => ({ ...row, share: max > 0 ? row.visits / max : 0 }));
};

/**
 * Pure last-mile transform: sorts the trend, sums totals, and turns each
 * ranking list into a top-N-with-share list the bar charts render directly.
 * An empty/missing input array degrades to an empty output, never a throw —
 * the caller (the page component) decides what an all-empty series means
 * (e.g. "no visits in this window" vs. rendered as a real empty chart).
 */
export function mapAnalyticsToChartSeries(raw: RawTrafficAnalytics): TrafficChartSeries {
  const trend = [...(raw.trend ?? [])].sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const visits = trend.reduce((sum, point) => sum + point.visits, 0);
  const uniques = trend.reduce((sum, point) => sum + point.uniques, 0);

  return {
    totals: { visits, uniques, avgPerBucket: trend.length ? Math.round(visits / trend.length) : 0 },
    trend,
    topPaths: withShare(raw.topPaths ?? []),
    topSources: withShare(raw.topSources ?? []),
  };
}

// ─── label normalization (pure — used by the server-side parser, tested here) ──

export function normalizePathLabel(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return '(unknown page)';
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

export function normalizeSourceLabel(raw: string | undefined | null): string {
  const trimmed = (raw ?? '').trim();
  if (!trimmed || trimmed === '(direct)' || trimmed.toLowerCase() === 'direct') return 'Direct';
  return trimmed;
}

// ─── compact count formatting (stat cards, bar-list labels) ────────────────

export function formatTrafficCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
}

// ─── range persistence (pure key/parse — storage I/O stays in the component) ──

export const trafficRangeStorageKey = (siteSlug: string, userKey: string): string =>
  `${siteSlug}-traffic-range-${userKey || 'anon'}`;

export interface StoredTrafficRange {
  key: TrafficRangeKey;
  custom?: CustomRangeInput;
}

const isRangeKey = (value: unknown): value is TrafficRangeKey =>
  value === '7d' || value === '30d' || value === '90d' || value === 'custom';

/** Never throws — a corrupted or foreign `localStorage` value degrades to "nothing stored", not a crash. */
export function parseStoredTrafficRange(raw: string | null | undefined): StoredTrafficRange | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredTrafficRange> | null;
    if (!parsed || !isRangeKey(parsed.key)) return null;
    if (parsed.key === 'custom') {
      const custom = parsed.custom;
      if (!custom || typeof custom.from !== 'string' || typeof custom.to !== 'string') return null;
      return { key: 'custom', custom: { from: custom.from, to: custom.to } };
    }
    return { key: parsed.key };
  } catch {
    return null;
  }
}

export function serializeStoredTrafficRange(value: StoredTrafficRange): string {
  return JSON.stringify(value);
}

// ─── inline-SVG chart geometry (pure math — no DOM) ─────────────────────────

export interface ChartPoint {
  x: number;
  y: number;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * Maps a series of values onto an SVG viewport, padded on all sides. A
 * single point centers itself (there is no line to draw); an empty series
 * returns no points and the caller renders the chart's own empty state.
 */
export function buildLinePoints(values: number[], width: number, height: number, padding = 4): ChartPoint[] {
  if (values.length === 0) return [];
  if (values.length === 1) return [{ x: round2(width / 2), y: round2(height / 2) }];

  const max = Math.max(...values, 0);
  const min = Math.min(...values, 0);
  const span = max - min || 1;
  const usableW = Math.max(width - padding * 2, 0);
  const usableH = Math.max(height - padding * 2, 0);

  return values.map((value, index) => {
    const x = padding + (usableW * index) / (values.length - 1);
    const y = padding + usableH - ((value - min) / span) * usableH;
    return { x: round2(x), y: round2(y) };
  });
}

export function pointsToPolyline(points: ChartPoint[]): string {
  return points.map((p) => `${p.x},${p.y}`).join(' ');
}

/** The same points, closed down to the baseline — the `<path d>` for a filled area under the line. */
export function pointsToAreaPath(points: ChartPoint[], baselineY: number): string {
  if (points.length === 0) return '';
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x},${p.y}`).join(' ');
  const first = points[0];
  const last = points[points.length - 1];
  return `${line} L${last.x},${round2(baselineY)} L${first.x},${round2(baselineY)} Z`;
}
