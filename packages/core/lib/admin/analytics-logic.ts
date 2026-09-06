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
  /**
   * R6.2/D3 — the same-length, immediately-preceding window, best-effort (a
   * second `fetchTrafficAnalytics` call in `admin-analytics.ts`; absent
   * on failure, never blocking the primary series). Compared on
   * pageviews/uniques only, per D9 — the two feeds are never cross-compared.
   */
  previousSeries?: AnalyticsChartSeries;
  /** R6.2/D5 — `/ranking/not_found`, newly wired. Absent while unwired/unavailable — the card hides, not zeroes. */
  topNotFound?: AnalyticsRankingRowWithShare[];
  /** R6.2/D5 — `/ranking/countries`, newly wired. */
  topCountries?: AnalyticsRankingRowWithShare[];
  /** R6.2/D2 — a one-shot `/bandwidth` probe. `null` when the endpoint 404s (the KPI is then omitted, never shown as zero); absent while the probe hasn't run at all. */
  bandwidthBytes?: number | null;
  /** R6.4/D8 — `topPaths` + `topNotFound` rows swept out as `/admin`/`/.netlify`, combined; computed server-side from visible ranking rows only (Netlify's aggregate totals can't be filtered directly), so this is a labelled approximation, never presented as exact. Absent while not yet computed; 0 is a real "nothing excluded" result. */
  excludedAdminVisits?: number;
  /** R6.4/D8 — `topSources` rows that were same-host referrers, bucketed out as "Internal" rather than ranked as a source. */
  internalReferrerVisits?: number;
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
  /** R6.4/D8 — summed visits of `/ranking/pages` rows swept out as `/admin` or `/.netlify` before `topPaths` was built. Undefined when nothing was excluded (0 is a real, renderable value; undefined means "not computed"). */
  excludedAdminPathVisits?: number;
  /** R6.4/D8 — summed visits of `/ranking/sources` rows that were same-host referrers, bucketed out before `topSources` was built rather than ranked as a source. */
  internalReferrerVisits?: number;
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
  /**
   * R6.2 — the raw value to filter/link by, when it differs from the
   * display `label` (e.g. an object id vs. its resolved title, D6). Absent
   * means `label` doubles as the value (the common case — a country code, a
   * referrer host).
   */
  value?: string;
  /** R6.2 — a second, muted line under the label (e.g. the engagement funnel's per-stage rates). */
  sublabel?: string;
  /** R6.2 — the row's live-page URL, when resolvable (D6). Also what a Cmd/Ctrl-click opens instead of filtering. */
  href?: string;
  /** R6.2 — a secondary link to the row's admin object (D6). */
  adminHref?: string;
  /** R11.4 — a third link to this object's analytics drill-down (`/admin/analytics/object/<id>`), for every row keyed by an object id. */
  analyticsHref?: string;
  /** R6.2/D6 — an object id that could not be resolved to a title/route — rendered visibly (id + a muted marker), never hidden. */
  unresolved?: boolean;
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

/**
 * R6.2 — generalized so `own-analytics-logic.ts`'s new dimension rankings
 * (up to the sink's own ≤20-row cap) can use a taller limit than the
 * original 8-row bar lists, relying on the ranking card's existing
 * `overflow-y-auto` for the rest rather than a "view all" expand-in-place
 * interaction. `withShare` below is this at the original limit — every
 * pre-R6.2 call site is unchanged.
 */
export function withShareLimit(rows: AnalyticsRankingRow[], limit: number): AnalyticsRankingRowWithShare[] {
  const top = sortRankingDesc(rows).slice(0, limit);
  const max = top.reduce((m, row) => Math.max(m, row.visits), 0);
  return top.map((row) => ({ ...row, share: max > 0 ? row.visits / max : 0 }));
}

const withShare = (rows: AnalyticsRankingRow[]): AnalyticsRankingRowWithShare[] => withShareLimit(rows, TOP_LIST_LIMIT);

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

// ─── R6.4/D8: admin + function path exclusion, same-host referrer detection ──
//
// The own tracker never needs either rule applied here: its client-side
// loader hard-bails before sending an event for any `/admin` page
// (`lib/tracking/loader/{core,index}.ts`) and never runs on a `/.netlify/*`
// function response (those aren't HTML pages that embed the loader), so
// admin/function traffic never reaches that sink to begin with. Same-host
// "Internal" bucketing for the own tab is likewise already done AT THE SINK
// (`top_referrer_hosts.internal_sessions`, surfaced in
// `own-analytics-logic.ts`'s referrer footnote since R6.2). Both predicates
// below exist for the ONE feed that actually needs them: Netlify's
// server-side Analytics API sees every request — admin and function traffic
// included — and takes no filter parameter, so the admin function
// (`netlify-analytics.ts`) has to sweep its ranking rows itself.

/**
 * `/admin` and `/.netlify` (and anything nested under either) are excluded
 * from every Netlify-tab ranking and total (D8). Slash-boundary matching
 * only — `startsWith('/admin')` alone would also swallow a real public page
 * like `/admin-portal`.
 */
export function isExcludedAdminPath(rawPath: string | undefined | null): boolean {
  const path = normalizePathLabel(rawPath);
  return path === '/admin' || path.startsWith('/admin/') || path === '/.netlify' || path.startsWith('/.netlify/');
}

/**
 * A `/ranking/sources` row is host-shaped, not URL-shaped, but `siteHost` is
 * `process.env.URL` (a full URL) — this strips scheme/path/port and an
 * optional leading `www.` from both sides before comparing, case-
 * insensitively. Either side blank (no referrer host on the row — "Direct" —
 * or `siteHost` unset/unreadable) means "not internal", never a guess.
 */
export function isInternalReferrerHost(
  rawHost: string | undefined | null,
  siteHost: string | undefined | null
): boolean {
  const host = normalizeHostForCompare(rawHost);
  const site = normalizeHostForCompare(siteHost);
  return Boolean(host) && Boolean(site) && host === site;
}

function normalizeHostForCompare(value: string | undefined | null): string {
  const trimmed = (value ?? '').trim().toLowerCase();
  if (!trimmed) return '';
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const hostOnly = withoutScheme.split('/')[0]!.split(':')[0]!;
  return hostOnly.replace(/^www\./, '');
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

// ─── R6.1: tabs + shared header state, persisted in the URL ─────────────────
//
// D1 (analytics-dashboard-spec §4): "Own tracker" and "Netlify" are two tabs
// over the SAME range picker and compare toggle, not two stacked sections —
// `?source=` is the tab, `?range=`/`?from=`/`?to=`/`?compare=` apply to
// whichever tab is active. Pure parse/serialize pair, mirroring the
// stored-range functions above, so the URL round-trip is unit-testable
// without a DOM/router — the component owns reading `location.search` and
// calling `history.replaceState`.

/**
 * R11.5 (T21.36) adds `insights` — the read-only "is the learning loop
 * working" tab (tracking outcomes ingested, playbook items citing tracking,
 * open optimizer proposals, strategy observations). Same `?source=`
 * mechanism as `own`/`netlify` (D1) — a tab is a change of data, not of
 * vocabulary — but it does not carry a KPI strip/chart/ranking-card shape
 * of its own, so it is resolved by `resolveInsightsPanel`
 * (`analytics-insights-logic.ts`), not `AnalyticsPanelState` below.
 */
export type AnalyticsSource = 'own' | 'netlify' | 'insights';

export const DEFAULT_ANALYTICS_SOURCE: AnalyticsSource = 'own';

export const isAnalyticsSource = (value: unknown): value is AnalyticsSource =>
  value === 'own' || value === 'netlify' || value === 'insights';

/**
 * R6.2: every range is available on both feeds now. The own tracker's
 * `/stats` used to accept only a `days=7|30` query, which is what forced the
 * range picker to disable `90d`/`custom` on that tab (the exact defect D10
 * calls out) — it now accepts `from`/`to` (`own-tracker-stats.ts`), so the
 * picker no longer needs a per-source restriction. Kept as a named predicate
 * (not deleted) because the picker and the tab-switch clamp below both call
 * through it, and a future feed-specific restriction should have exactly one
 * place to land rather than a hunt through the component.
 */
export const isRangeAvailableForSource = (_range: AnalyticsRangeKey, _source: AnalyticsSource): boolean => true;

/** Identity now that every range is available on every source (R6.2) — kept so existing call sites don't need to change. */
export const clampRangeForSource = (range: AnalyticsRangeKey, _source: AnalyticsSource): AnalyticsRangeKey => range;

/**
 * R6.2: both feeds can now carry a previous-period figure — the sink's
 * `previous` object for `own`, a second same-length-window fetch for
 * `netlify` (D9: compared on pageviews/uniques only). This gates the
 * CONTROL, not any specific number — whether a delta actually renders is a
 * data question (`computeDelta` returns `null` when the payload has no
 * comparison window yet, e.g. before the sink deploys), decided per-KPI, not
 * per-source.
 */
export const isCompareAvailable = (_source: AnalyticsSource): boolean => true;

/** D3: comparison defaults ON for a preset range, OFF for `custom` — a custom span has no single natural "previous period" a reader expects without being told what it is. */
export const defaultCompareForRange = (range: AnalyticsRangeKey): boolean => range !== 'custom';

// ─── R6.2/D7: click-to-filter, URL-persisted alongside source/range ────────

/**
 * The three dimensions the sink accepts as filters (own tab only — D7/§9.2
 * of the spec: the Netlify ranking API takes no filter parameters at all, so
 * Netlify-tab rows stay plain links). `source` here is the sink's one
 * filterable "where did this session come from" dimension — it covers every
 * sub-view of the Sources card (referrer host, UTM source/medium/campaign)
 * alike, since they are all just different labels for the same session set.
 */
export interface AnalyticsFilters {
  country?: string;
  source?: string;
  object_id?: string;
}

export const EMPTY_ANALYTICS_FILTERS: Readonly<AnalyticsFilters> = Object.freeze({});

export const hasAnalyticsFilters = (filters: AnalyticsFilters): boolean =>
  Boolean(filters.country || filters.source || filters.object_id);

/** A removable-chip view of the active filters — id doubles as the `AnalyticsFilters` key to clear on click. */
export interface AnalyticsFilterChip {
  key: keyof AnalyticsFilters;
  label: string;
  value: string;
}

export function analyticsFilterChips(filters: AnalyticsFilters): AnalyticsFilterChip[] {
  const chips: AnalyticsFilterChip[] = [];
  if (filters.country) chips.push({ key: 'country', label: 'country', value: filters.country });
  if (filters.source) chips.push({ key: 'source', label: 'source', value: filters.source });
  if (filters.object_id) chips.push({ key: 'object_id', label: 'object', value: filters.object_id });
  return chips;
}

export interface AnalyticsSearchState {
  source: AnalyticsSource;
  range: AnalyticsRangeKey;
  custom?: CustomRangeInput;
  compare: boolean;
  filters: AnalyticsFilters;
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

  // No explicit `compare` param (a bare/older bookmark) falls back to D3's
  // per-range default rather than treating "absent" as "off".
  const compareParam = params.get('compare');
  const compare = compareParam === null ? defaultCompareForRange(range) : compareParam === '1';

  // Distinct param names from `source` (the tab) and `range`/`from`/`to` (the
  // window) — `fsource` avoids colliding with the tab selector.
  const filters: AnalyticsFilters = {};
  const country = params.get('country');
  const sourceFilter = params.get('fsource');
  const objectId = params.get('object');
  if (country) filters.country = country;
  if (sourceFilter) filters.source = sourceFilter;
  if (objectId) filters.object_id = objectId;

  return { source, range, custom, compare, filters };
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
  // Always explicit (never omitted): a bookmark of a resolved default must
  // reproduce the SAME default even if D3's rule changes later — omitting it
  // when `compare` happens to equal the current default would silently
  // re-derive a possibly different value on a future load.
  params.set('compare', state.compare ? '1' : '0');
  if (state.filters.country) params.set('country', state.filters.country);
  if (state.filters.source) params.set('fsource', state.filters.source);
  if (state.filters.object_id) params.set('object', state.filters.object_id);
  return params.toString();
}

// ─── R6.2/D3: comparison-period deltas, shared by both feeds ───────────────

export interface AnalyticsDelta {
  /** Signed percent change, one decimal — e.g. `12.3` or `-4.1`. */
  pct: number;
  direction: 'up' | 'down' | 'flat';
  /** Arrow baked in, never colour alone (spec §8) — `"▲ 12.3%"` / `"▼ 4.1%"` / `"→ 0%"`. */
  label: string;
}

/**
 * `previous` is `null`/`undefined` whenever the payload carries no
 * comparison window yet (the sink's `/stats` addition may not have deployed,
 * or the Netlify branch's second fetch failed) — the caller hides the delta,
 * never fabricates one. A zero/negative `previous` also degrades to `null`
 * (a percent change off a non-positive baseline is undefined or absurd), the
 * one exception being `0 → 0`, which is a real "flat", not a hidden one.
 */
export function computeDelta(current: number, previous: number | null | undefined): AnalyticsDelta | null {
  if (previous === null || previous === undefined || !Number.isFinite(previous)) return null;
  if (previous <= 0) return current === 0 && previous === 0 ? { pct: 0, direction: 'flat', label: '→ 0%' } : null;

  const pct = Math.round(((current - previous) / previous) * 1000) / 10;
  const direction: AnalyticsDelta['direction'] = pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat';
  const arrow = direction === 'up' ? '▲' : direction === 'down' ? '▼' : '→';
  return { pct, direction, label: `${arrow} ${Math.abs(pct)}%` };
}

// ─── R6.1/D2: byte formatting (the Netlify tab's Bandwidth KPI) ────────────

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  const decimals = unitIndex === 0 ? 0 : value < 10 ? 1 : 0;
  const formatted = value.toFixed(decimals);
  // Trim a bare ".0" — "2 KB" reads better than "2.0 KB" when the value happens to be a whole number.
  return `${formatted.endsWith('.0') ? formatted.slice(0, -2) : formatted} ${units[unitIndex]}`;
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
  /** R6.2/D3 — the comparison-period change, when the payload carries a `previous` window and `compare` is on. Absent, never zeroed, when there is nothing honest to show. */
  delta?: AnalyticsDelta;
}

/**
 * R6.2/D5 — one card, one or more internally-tabbed VIEWS ("card with
 * internal tabs" — the spec's single most consistent convention across every
 * product surveyed). A card with exactly one view renders its rows directly,
 * no tab chrome — this is how the Netlify tab's simpler cards stay visually
 * unchanged while the own tab's Pages/Sources/Locations/Devices/Engagement
 * cards each get top/entry/exit, referrer/UTM ×3, etc.
 */
export interface RankingView {
  id: string;
  /** The internal-tab label, e.g. "Top" / "Entry" / "Exit". Ignored when the card has only one view. */
  label: string;
  rows: AnalyticsRankingRowWithShare[];
  emptyMessage: string;
  /** A short note under the view — e.g. the Netlify tab's "rows are links, not filters" (D7: that API takes no filter parameters). */
  footnote?: string;
  /** R6.2/D7 — which filter dimension a row click in THIS view sets. Absent ⇒ rows are inert (Netlify; or an own-tab dimension the sink cannot filter on, e.g. devices/engagement). */
  filterKey?: keyof AnalyticsFilters;
}

export interface RankingGroup {
  id: string;
  /** Card kicker, e.g. "Pages". */
  title: string;
  views: RankingView[];
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
  /** R6.2/D3 — the previous period's points, rendered as a dashed ghost series. Same length/labels as `points` is NOT guaranteed — the two windows can have different bucket counts. */
  previousPoints?: AnalyticsTrendPoint[];
}

export interface AnalyticsPanelReady {
  kind: 'ready';
  kpis: KpiDatum[];
  chart: AnalyticsChartView;
  rankings: RankingGroup[];
  footer: AnalyticsFooterItem[];
  /** R6.2/D7 — the active click-to-filter selection (own tab only; always empty on the Netlify tab, whose ranking API takes no filter parameters). Echoed back so the component can render removable chips without keeping a second copy of the same state. */
  filters?: AnalyticsFilters;
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
  /** R6.2/D3 — off by default for `custom` (handled by the caller via `defaultCompareForRange`); deltas render only when `overview.previousSeries` is ALSO present. */
  compare: boolean;
}

/** A page path that only ever links relatively — the admin panel and the public site share one Netlify origin, so a bare path resolves correctly without knowing the site's public URL. */
const pathHref = (label: string): string | undefined => (label.startsWith('/') ? label : undefined);

/**
 * The Netlify tab's panel state. R6.2/D2 swaps the KPI strip to the spec's
 * five: Pageviews · Unique visitors · Top page share · 404s · Bandwidth —
 * each of the last three OMITTED (not zeroed) while its data source is
 * absent, matching the sink-payload posture ("every field may be missing").
 * D5's ranking cards: Pages · Sources · Locations · Not found.
 */
export function resolveNetlifyAnalyticsPanel(input: NetlifyPanelInput): AnalyticsPanelState {
  const { loading, error, windowResult, overview, compare } = input;
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
  const previousTotals = compare ? overview.previousSeries?.totals : undefined;

  const kpis: KpiDatum[] = [
    {
      id: 'visits',
      label: 'Pageviews',
      value: formatAnalyticsCount(series.totals.visits),
      delta: computeDelta(series.totals.visits, previousTotals?.visits) ?? undefined,
    },
    {
      id: 'uniques',
      label: 'Unique visitors',
      value: formatAnalyticsCount(series.totals.uniques),
      delta: computeDelta(series.totals.uniques, previousTotals?.uniques) ?? undefined,
    },
  ];

  // Top page share — derived from data already on hand, so unlike 404s/
  // bandwidth it never depends on a not-yet-wired endpoint; it's simply
  // omitted when there is nothing to divide (no pageviews, or no ranking
  // rows at all).
  if (series.totals.visits > 0 && series.topPaths.length > 0) {
    const topShare = Math.round((series.topPaths[0]!.visits / series.totals.visits) * 1000) / 10;
    kpis.push({
      id: 'top_page_share',
      label: 'Top page share',
      value: `${topShare}%`,
      hint: series.topPaths[0]!.label,
    });
  }

  // 404s — R6.2 wires `/ranking/not_found`; omitted (not zeroed) while
  // `topNotFound` is absent (the endpoint hasn't been wired for this tenant,
  // or the probe failed) — a real zero and "we don't know" must render
  // differently, per the sink-payload defensive posture.
  if (overview.topNotFound) {
    const total = overview.topNotFound.reduce((sum, row) => sum + row.visits, 0);
    kpis.push({ id: 'not_found', label: '404s', value: formatAnalyticsCount(total) });
  }

  // Bandwidth — a one-shot probe (`admin-analytics.ts`); `null` means the
  // endpoint 404s for this tenant (omit), `undefined` means the probe
  // hasn't run (also omit) — a defined non-null number is the only case
  // that renders.
  if (typeof overview.bandwidthBytes === 'number') {
    kpis.push({ id: 'bandwidth', label: 'Bandwidth', value: formatBytes(overview.bandwidthBytes) });
  }

  const rankings: RankingGroup[] = [
    {
      id: 'pages',
      title: 'Pages',
      views: [
        {
          id: 'top',
          label: 'Top',
          rows: series.topPaths.map((row) => ({ ...row, href: pathHref(row.label) })),
          emptyMessage: 'No page views recorded in this range.',
          footnote: 'Rows are links, not filters — the Netlify API takes no filter parameters (D7).',
        },
      ],
    },
    {
      id: 'sources',
      title: 'Sources',
      views: [
        {
          id: 'referrer',
          label: 'Referrer',
          rows: series.topSources,
          emptyMessage: 'No referrer data recorded in this range.',
          footnote: 'Rows are links, not filters — the Netlify API takes no filter parameters (D7).',
        },
      ],
    },
    {
      id: 'locations',
      title: 'Locations',
      views: [
        {
          id: 'country',
          label: 'Country',
          rows: overview.topCountries ?? [],
          emptyMessage: overview.topCountries
            ? 'No country data recorded in this range.'
            : 'Not wired for this tenant.',
        },
      ],
    },
    {
      id: 'not_found',
      title: 'Not found',
      views: [
        {
          id: 'not_found',
          label: '404s',
          rows: overview.topNotFound ?? [],
          emptyMessage: overview.topNotFound ? 'No 404s recorded in this range.' : 'Not wired for this tenant.',
        },
      ],
    },
  ];

  // R6.4/D8 — the actual computed exclusion numbers, distinct from the
  // blanket "excl. admin & test" caption every footer already carries
  // (`FooterStrip`): "compute 'excl. admin' from ranking rows, label it"
  // (the task brief) means a real number here, not just prose. Omitted
  // entirely (not shown as 0) while the server hasn't computed a value —
  // an explicit 0 (nothing was excluded this window) still renders, since
  // that's a real answer, not an absence.
  const footer: AnalyticsFooterItem[] = [
    { id: 'sink', label: 'Sink', value: 'Netlify Analytics — server-side, not blockable' },
  ];
  if (typeof overview.excludedAdminVisits === 'number') {
    footer.push({
      id: 'excluded_admin',
      label: 'Excl. admin',
      value: formatAnalyticsCount(overview.excludedAdminVisits),
      hint: '/admin and /.netlify traffic swept out of the rankings above (D8) — approximated from visible ranking rows, since Netlify’s totals can’t be filtered directly.',
    });
  }
  if (typeof overview.internalReferrerVisits === 'number' && overview.internalReferrerVisits > 0) {
    footer.push({
      id: 'internal',
      label: 'Internal',
      value: formatAnalyticsCount(overview.internalReferrerVisits),
      hint: 'Same-host referrers — internal navigation, not ranked as a traffic source (D8).',
    });
  }

  return {
    kind: 'ready',
    kpis,
    chart: {
      points: series.trend,
      seriesALabel: 'Visits',
      seriesBLabel: 'Unique visitors',
      emptyMessage: 'No visits recorded in this range.',
      previousPoints: compare ? overview.previousSeries?.trend : undefined,
    },
    rankings,
    footer,
  };
}
