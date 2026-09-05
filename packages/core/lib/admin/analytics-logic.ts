/**
 * Analytics dashboard (T4.1; renamed from traffic-logic, T21.9b) — pure logic. Two independent transforms live
 * here, both framework-free and unit-testable (the only tested tier in this
 * codebase, per the admin audit §10/§11.8):
 *
 *  1. Range picker → date window: `resolveDateWindow` turns a range key (or a
 *     custom from/to pair) into the `{from, to, resolution}` the server asks
 *     Netlify Analytics for. Shared by the browser (building the query
 *     string) and the server (deriving the same window again from the same
 *     inputs, rather than trusting a client-computed window verbatim).
 *  2. Analytics response → chart series: `mapAnalyticsToChartSeries` takes
 *     the ALREADY-NORMALIZED intermediate shape (`RawAnalyticsData` — see
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

export type AnalyticsRangeKey = '7d' | '30d' | '90d' | 'custom';

export const DEFAULT_ANALYTICS_RANGE: AnalyticsRangeKey = '30d';

export const ANALYTICS_RANGE_OPTIONS: ReadonlyArray<{ key: AnalyticsRangeKey; label: string; days?: number }> = [
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

export interface AnalyticsDateWindow {
  /** inclusive, ms since epoch (UTC) */
  from: number;
  /** ms since epoch (UTC) — never later than `now` */
  to: number;
  resolution: 'hour' | 'day';
}

export type DateWindowResult = { ok: true; window: AnalyticsDateWindow } | { ok: false; error: string };

/** Mirrors the server's catalogued degrade states (`admin-analytics.ts`) — never a generic string the UI has to pattern-match. */
export type AnalyticsErrorCode = 'analytics_lookup_unconfigured' | 'analytics_not_enabled';

/**
 * The `admin-analytics?source=netlify` (default) response shape. Lives here,
 * not in `analytics-client.ts` (which re-exports it) — the R6.1 panel
 * resolver below is pure and needs this shape without importing the fetch
 * wrapper's I/O.
 */
export interface AnalyticsOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: AnalyticsErrorCode;
  message?: string;
  range: AnalyticsRangeKey;
  window?: AnalyticsDateWindow;
  series?: AnalyticsChartSeries;
}

/**
 * Pure — `now` is always supplied by the caller, never read internally, so
 * this is deterministic and safe to call on both the browser (to build the
 * query string) and the server (to re-derive the same window rather than
 * trust a client-supplied `from`/`to` verbatim).
 */
export function resolveDateWindow(key: AnalyticsRangeKey, now: Date, custom?: CustomRangeInput): DateWindowResult {
  const toMs = now.getTime();

  if (key !== 'custom') {
    const days = ANALYTICS_RANGE_OPTIONS.find((option) => option.key === key)?.days ?? 30;
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

export interface AnalyticsTrendPoint {
  /** ISO date (day resolution) or ISO timestamp (hour resolution). */
  t: string;
  visits: number;
  uniques: number;
}

export interface AnalyticsRankingRow {
  label: string;
  visits: number;
}

/** The already-normalized shape `server/lib/netlify-analytics.ts` produces from Netlify's raw, undocumented JSON. */
export interface RawAnalyticsData {
  trend: AnalyticsTrendPoint[];
  topPaths: AnalyticsRankingRow[];
  topSources: AnalyticsRankingRow[];
}

export interface AnalyticsTotals {
  visits: number;
  uniques: number;
  /** Rounded mean visits per bucket over the window — a "typical day" stat, not a forecast. */
  avgPerBucket: number;
}

export interface AnalyticsRankingRowWithShare extends AnalyticsRankingRow {
  /** 0..1 of the top row's visits — the bar-list fill width. */
  share: number;
}

export interface AnalyticsChartSeries {
  totals: AnalyticsTotals;
  /** Ascending by `t`. */
  trend: AnalyticsTrendPoint[];
  topPaths: AnalyticsRankingRowWithShare[];
  topSources: AnalyticsRankingRowWithShare[];
}

/** How many rows each bar list keeps — Netlify's ranking endpoints can return far more than a sidebar-width list can show. */
export const TOP_LIST_LIMIT = 8;

const sortRankingDesc = (rows: AnalyticsRankingRow[]): AnalyticsRankingRow[] =>
  [...rows].sort((a, b) => b.visits - a.visits);

const withShare = (rows: AnalyticsRankingRow[]): AnalyticsRankingRowWithShare[] => {
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
export function mapAnalyticsToChartSeries(raw: RawAnalyticsData): AnalyticsChartSeries {
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

export function formatAnalyticsCount(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)}`;
  if (abs < 1_000_000) return `${sign}${(abs / 1000).toFixed(abs < 10_000 ? 1 : 0)}k`;
  return `${sign}${(abs / 1_000_000).toFixed(1)}M`;
}

// ─── range persistence (pure key/parse — storage I/O stays in the component) ──

export const analyticsRangeStorageKey = (siteSlug: string, userKey: string): string =>
  `${siteSlug}-analytics-range-${userKey || 'anon'}`;

export interface StoredAnalyticsRange {
  key: AnalyticsRangeKey;
  custom?: CustomRangeInput;
}

export const isAnalyticsRangeKey = (value: unknown): value is AnalyticsRangeKey =>
  value === '7d' || value === '30d' || value === '90d' || value === 'custom';

/** Never throws — a corrupted or foreign `localStorage` value degrades to "nothing stored", not a crash. */
export function parseStoredAnalyticsRange(raw: string | null | undefined): StoredAnalyticsRange | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAnalyticsRange> | null;
    if (!parsed || !isAnalyticsRangeKey(parsed.key)) return null;
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

export function serializeStoredAnalyticsRange(value: StoredAnalyticsRange): string {
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

// ─── R6.1: tabs + shared header state, persisted in the URL ─────────────────
//
// D1 (analytics-dashboard-spec §4): "Own tracker" and "Netlify" are two tabs
// over the SAME range picker and compare toggle, not two stacked sections —
// `?source=` is the tab, `?range=`/`?from=`/`?to=`/`?compare=` apply to
// whichever tab is active. Pure parse/serialize pair, mirroring the
// stored-range functions above, so the URL round-trip is unit-testable
// without a DOM/router — the component owns reading `location.search` and
// calling `history.replaceState`.

export type AnalyticsSource = 'own' | 'netlify';

export const DEFAULT_ANALYTICS_SOURCE: AnalyticsSource = 'own';

export const isAnalyticsSource = (value: unknown): value is AnalyticsSource => value === 'own' || value === 'netlify';

/**
 * The own-tracker `/stats` endpoint only accepts a 7- or 30-day window today
 * (`OwnTrackerDays` — R6.2 adds `from`/`to`). Rather than the old silent
 * clamp-to-30 (the exact defect the spec's D10 calls out), the range picker
 * disables `90d`/`custom` while the own tab is active, with a "not available
 * yet" title — this is that disablement rule, factored out so the picker and
 * the tab-switch clamp below (`clampRangeForSource`) can't disagree.
 */
export const isRangeAvailableForSource = (range: AnalyticsRangeKey, source: AnalyticsSource): boolean =>
  source === 'netlify' || range === '7d' || range === '30d';

/** `range`, unchanged if the source can serve it, else the nearest available one (`30d`) — never silently keeps an unservable key around. */
export const clampRangeForSource = (range: AnalyticsRangeKey, source: AnalyticsSource): AnalyticsRangeKey =>
  isRangeAvailableForSource(range, source) ? range : '30d';

/**
 * R6.1: neither feed's current payload carries a previous-period figure yet
 * (R6.2 adds `previous` to `/stats`, and the Netlify branch needs a second
 * fetch) — the compare toggle is wired into the header for every source but
 * stays disabled everywhere until then. One function, so flipping it on per
 * source in R6.2 is a one-line change rather than a hunt through the
 * component for every place "can we compare" is decided.
 */
export const isCompareAvailable = (_source: AnalyticsSource): boolean => false;

export interface AnalyticsSearchState {
  source: AnalyticsSource;
  range: AnalyticsRangeKey;
  custom?: CustomRangeInput;
  /** Always `false` while `isCompareAvailable` is false for every source (R6.1) — never a fabricated "on". */
  compare: boolean;
}

/** Never throws — an unparseable/foreign query string degrades to the defaults, same posture as `parseStoredAnalyticsRange`. */
export function parseAnalyticsSearchParams(search: string): AnalyticsSearchState {
  const params = new URLSearchParams(search);

  const rawSource = params.get('source');
  const source: AnalyticsSource = isAnalyticsSource(rawSource) ? rawSource : DEFAULT_ANALYTICS_SOURCE;

  const rawRange = params.get('range');
  const range = clampRangeForSource(isAnalyticsRangeKey(rawRange) ? rawRange : DEFAULT_ANALYTICS_RANGE, source);

  const from = params.get('from');
  const to = params.get('to');
  const custom = range === 'custom' && from && to ? { from, to } : undefined;

  const compare = isCompareAvailable(source) && params.get('compare') === '1';

  return { source, range, custom, compare };
}

/** The inverse of `parseAnalyticsSearchParams` — round-trips everything it accepts, and only what it accepts (no stray params survive a state change). */
export function serializeAnalyticsSearchParams(state: AnalyticsSearchState): string {
  const params = new URLSearchParams();
  params.set('source', state.source);
  params.set('range', state.range);
  if (state.range === 'custom' && state.custom) {
    params.set('from', state.custom.from);
    params.set('to', state.custom.to);
  }
  if (state.compare && isCompareAvailable(state.source)) params.set('compare', '1');
  return params.toString();
}

// ─── R6.1: the shared panel shape both tabs render through ──────────────────
//
// D1: "both tabs render the SAME components — KPI strip, one chart, ranking
// cards — so moving between them is a change of data, not of vocabulary."
// `resolveNetlifyAnalyticsPanel` here and `resolveOwnAnalyticsPanel` in
// `own-analytics-logic.ts` are the pure "what should this tab show right
// now" decision for each feed — fetch/loading state in, one of these render
// states out. The component that consumes this is a thin switch (Skeleton /
// EmptyState / the shared KpiStrip+ChartCard+RankingCard layout), matching
// this file's own house rule: pure decision logic is the tested tier, JSX is
// not. `never a fabricated number` — every field here traces to a real
// series/stat value; nothing is a placeholder.

export interface KpiDatum {
  id: string;
  label: string;
  value: string;
  hint?: string;
}

export interface RankingGroup {
  id: string;
  title: string;
  caption: string;
  rows: AnalyticsRankingRowWithShare[];
  emptyMessage: string;
  /** A short note under the card — e.g. the Netlify tab's "rows are links, not filters" (D7: that API takes no filter parameters). */
  footnote?: string;
}

export interface AnalyticsFooterItem {
  id: string;
  label: string;
  value: string;
  hint?: string;
}

export interface AnalyticsChartView {
  points: AnalyticsTrendPoint[];
  seriesALabel: string;
  seriesBLabel: string;
  emptyMessage: string;
}

export interface AnalyticsPanelReady {
  kind: 'ready';
  kpis: KpiDatum[];
  chart: AnalyticsChartView;
  rankings: RankingGroup[];
  footer: AnalyticsFooterItem[];
}

/** One discriminated union, shared by both feeds — the "not connected"/"not enabled" states the spec calls out are named here, not inferred per-tab. */
export type AnalyticsPanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not_configured'; message: string }
  | { kind: 'not_enabled'; message: string }
  | { kind: 'range_error'; message: string }
  | AnalyticsPanelReady;

export interface NetlifyPanelInput {
  loading: boolean;
  error: string | null;
  windowResult: DateWindowResult;
  overview: AnalyticsOverview | null;
}

/**
 * The Netlify tab's panel state. R6.1 keeps exactly the three numbers the
 * current payload carries (visits/uniques/avgPerBucket) — the D2 vision's
 * "Top page share · 404s · Bandwidth" needs new data points that are R6.2's
 * job (`/ranking/not_found`, `/ranking/countries`, `/bandwidth`); showing
 * them here would mean fabricating a KPI with nothing behind it.
 */
export function resolveNetlifyAnalyticsPanel(input: NetlifyPanelInput): AnalyticsPanelState {
  const { loading, error, windowResult, overview } = input;
  if (!windowResult.ok) return { kind: 'range_error', message: windowResult.error };
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error', message: error };
  if (!overview) return { kind: 'loading' };

  if (!overview.configured) {
    return {
      kind: 'not_configured',
      message:
        overview.message ??
        'Netlify Analytics credentials are not configured for this site. Set the Netlify site id and access token this deployment already uses for deploy lookups.',
    };
  }
  if (!overview.enabled) {
    return {
      kind: 'not_enabled',
      message:
        overview.message ?? 'Turn on the Netlify Analytics add-on for this site in Netlify to see analytics data here.',
    };
  }
  if (!overview.series) return { kind: 'loading' };

  const series = overview.series;
  return {
    kind: 'ready',
    kpis: [
      { id: 'visits', label: 'Pageviews', value: formatAnalyticsCount(series.totals.visits) },
      { id: 'uniques', label: 'Unique visitors', value: formatAnalyticsCount(series.totals.uniques) },
      {
        id: 'avg',
        label: 'Avg per period',
        value: formatAnalyticsCount(series.totals.avgPerBucket),
        hint: overview.window?.resolution === 'hour' ? 'per hour' : 'per day',
      },
    ],
    chart: {
      points: series.trend,
      seriesALabel: 'Visits',
      seriesBLabel: 'Unique visitors',
      emptyMessage: 'No visits recorded in this range.',
    },
    rankings: [
      {
        id: 'pages',
        title: 'Pages',
        caption: 'Most-visited pages',
        rows: series.topPaths,
        emptyMessage: 'No page views recorded in this range.',
      },
      {
        id: 'sources',
        title: 'Sources',
        caption: 'Where visits came from',
        rows: series.topSources,
        emptyMessage: 'No referrer data recorded in this range.',
        footnote: 'Rows are links, not filters — the Netlify API takes no filter parameters (D7).',
      },
    ],
    footer: [{ id: 'sink', label: 'Sink', value: 'Netlify Analytics — server-side, not blockable' }],
  };
}
