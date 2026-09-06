import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDateWindow,
  mapAnalyticsToChartSeries,
  normalizePathLabel,
  normalizeSourceLabel,
  formatAnalyticsCount,
  formatBytes,
  parseStoredAnalyticsRange,
  serializeStoredAnalyticsRange,
  analyticsRangeStorageKey,
  withShareLimit,
  TOP_LIST_LIMIT,
  MAX_CUSTOM_RANGE_DAYS,
  isAnalyticsRangeKey,
  isRangeAvailableForSource,
  clampRangeForSource,
  isCompareAvailable,
  defaultCompareForRange,
  computeDelta,
  analyticsFilterChips,
  hasAnalyticsFilters,
  parseAnalyticsSearchParams,
  serializeAnalyticsSearchParams,
  isAnalyticsSource,
  DEFAULT_ANALYTICS_SOURCE,
  DEFAULT_ANALYTICS_RANGE,
  resolveNetlifyAnalyticsPanel,
  isExcludedAdminPath,
  isInternalReferrerHost,
  type RawAnalyticsData,
  type AnalyticsSearchState,
  type AnalyticsOverview,
  type AnalyticsChartSeries,
} from './analytics-logic.js';

const NOW = new Date('2026-08-26T12:00:00.000Z');
const DAY_MS = 86_400_000;

// ─── resolveDateWindow ───────────────────────────────────────────────────────

test('resolveDateWindow: 7d/30d/90d derive from `now`, not wall-clock', () => {
  for (const [key, days] of [
    ['7d', 7],
    ['30d', 30],
    ['90d', 90],
  ] as const) {
    const result = resolveDateWindow(key, NOW);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.window.to, NOW.getTime());
    assert.equal(result.window.from, NOW.getTime() - days * DAY_MS);
  }
});

test('resolveDateWindow: short ranges bucket hourly, longer ranges bucket daily', () => {
  const seven = resolveDateWindow('7d', NOW);
  const ninety = resolveDateWindow('90d', NOW);
  assert.equal(seven.ok && seven.window.resolution, 'day');
  assert.equal(ninety.ok && ninety.window.resolution, 'day');
});

test('resolveDateWindow: custom range happy path', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2026-08-01', to: '2026-08-10' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.from, Date.parse('2026-08-01T00:00:00.000Z'));
  assert.equal(result.window.to, Date.parse('2026-08-10T23:59:59.999Z'));
  assert.equal(result.window.resolution, 'day');
});

test('resolveDateWindow: custom range at <=2 days buckets hourly', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2026-08-25', to: '2026-08-26' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.resolution, 'hour');
});

test('resolveDateWindow: custom range requires both dates', () => {
  const result = resolveDateWindow('custom', NOW, undefined);
  assert.equal(result.ok, false);
});

test('resolveDateWindow: custom range rejects start after end', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2026-08-10', to: '2026-08-01' });
  assert.equal(result.ok, false);
});

test('resolveDateWindow: custom range rejects a future start date', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2026-09-01', to: '2026-09-05' });
  assert.equal(result.ok, false);
});

test('resolveDateWindow: custom range clamps an end date beyond now', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2026-08-20', to: '2026-12-31' });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.window.to, NOW.getTime());
});

test('resolveDateWindow: custom range rejects a span over the cap', () => {
  const result = resolveDateWindow('custom', NOW, { from: '2020-01-01', to: '2026-08-01' });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, new RegExp(String(MAX_CUSTOM_RANGE_DAYS)));
});

test('resolveDateWindow: custom range rejects unparseable dates', () => {
  const result = resolveDateWindow('custom', NOW, { from: 'not-a-date', to: '2026-08-01' });
  assert.equal(result.ok, false);
});

// ─── mapAnalyticsToChartSeries ───────────────────────────────────────────────

test('mapAnalyticsToChartSeries: sorts the trend and sums totals', () => {
  const raw: RawAnalyticsData = {
    trend: [
      { t: '2026-08-03', visits: 30, uniques: 20 },
      { t: '2026-08-01', visits: 10, uniques: 8 },
      { t: '2026-08-02', visits: 20, uniques: 15 },
    ],
    topPaths: [],
    topSources: [],
  };
  const series = mapAnalyticsToChartSeries(raw);
  assert.deepEqual(
    series.trend.map((p) => p.t),
    ['2026-08-01', '2026-08-02', '2026-08-03']
  );
  assert.equal(series.totals.visits, 60);
  assert.equal(series.totals.uniques, 43);
  assert.equal(series.totals.avgPerBucket, 20);
});

test('mapAnalyticsToChartSeries: empty trend degrades to zeroed totals, not a throw', () => {
  const series = mapAnalyticsToChartSeries({ trend: [], topPaths: [], topSources: [] });
  assert.deepEqual(series.totals, { visits: 0, uniques: 0, avgPerBucket: 0 });
  assert.deepEqual(series.trend, []);
});

test('mapAnalyticsToChartSeries: ranking rows are capped, sorted desc, and given a share of the top row', () => {
  const rows = Array.from({ length: TOP_LIST_LIMIT + 5 }, (_, i) => ({ label: `/page-${i}`, visits: i }));
  const series = mapAnalyticsToChartSeries({ trend: [], topPaths: rows, topSources: [] });
  assert.equal(series.topPaths.length, TOP_LIST_LIMIT);
  assert.equal(series.topPaths[0].visits, rows.length - 1);
  assert.equal(series.topPaths[0].share, 1);
  // strictly descending
  for (let i = 1; i < series.topPaths.length; i++) {
    assert.ok(series.topPaths[i - 1].visits >= series.topPaths[i].visits);
  }
});

test('mapAnalyticsToChartSeries: all-zero ranking rows never divide by zero', () => {
  const series = mapAnalyticsToChartSeries({
    trend: [],
    topPaths: [{ label: '/a', visits: 0 }],
    topSources: [],
  });
  assert.equal(series.topPaths[0].share, 0);
});

// ─── label normalization ─────────────────────────────────────────────────────

test('normalizePathLabel adds a leading slash and has a fallback', () => {
  assert.equal(normalizePathLabel('about'), '/about');
  assert.equal(normalizePathLabel('/about'), '/about');
  assert.equal(normalizePathLabel(''), '(unknown page)');
  assert.equal(normalizePathLabel(undefined), '(unknown page)');
  assert.equal(normalizePathLabel(null), '(unknown page)');
});

test('normalizeSourceLabel collapses every direct-traffic spelling to one label', () => {
  assert.equal(normalizeSourceLabel(''), 'Direct');
  assert.equal(normalizeSourceLabel('(direct)'), 'Direct');
  assert.equal(normalizeSourceLabel('direct'), 'Direct');
  assert.equal(normalizeSourceLabel('google.com'), 'google.com');
});

// ─── R6.4/D8: isExcludedAdminPath / isInternalReferrerHost ─────────────────────

test('isExcludedAdminPath: /admin and /.netlify (and anything nested under either) are excluded', () => {
  assert.equal(isExcludedAdminPath('/admin'), true);
  assert.equal(isExcludedAdminPath('/admin/'), true);
  assert.equal(isExcludedAdminPath('/admin/analytics'), true);
  assert.equal(isExcludedAdminPath('/admin/content/abc123'), true);
  assert.equal(isExcludedAdminPath('/.netlify'), true);
  assert.equal(isExcludedAdminPath('/.netlify/functions/admin-analytics'), true);
  // No leading slash on the raw resource — normalizePathLabel adds one before the check runs.
  assert.equal(isExcludedAdminPath('admin/analytics'), true);
});

test('isExcludedAdminPath: a real public page never gets swept up by a prefix match', () => {
  assert.equal(isExcludedAdminPath('/admin-portal'), false);
  assert.equal(isExcludedAdminPath('/administration-guide'), false);
  assert.equal(isExcludedAdminPath('/about'), false);
  assert.equal(isExcludedAdminPath('/'), false);
  assert.equal(isExcludedAdminPath(''), false);
  assert.equal(isExcludedAdminPath(undefined), false);
});

test('isInternalReferrerHost: the exact site host matches, case-insensitively and ignoring a leading www.', () => {
  assert.equal(isInternalReferrerHost('drluriescience.netlify.app', 'https://drluriescience.netlify.app'), true);
  assert.equal(isInternalReferrerHost('DrLurieScience.netlify.app', 'https://drluriescience.netlify.app'), true);
  assert.equal(isInternalReferrerHost('www.drluriescience.netlify.app', 'https://drluriescience.netlify.app'), true);
  assert.equal(isInternalReferrerHost('drluriescience.netlify.app', 'https://www.drluriescience.netlify.app'), true);
  // A full URL with a path/port on either side is stripped down to the host before comparing.
  assert.equal(
    isInternalReferrerHost('drluriescience.netlify.app', 'https://drluriescience.netlify.app:443/admin'),
    true
  );
});

test('isInternalReferrerHost: a different host, or a missing side, is never internal', () => {
  assert.equal(isInternalReferrerHost('google.com', 'https://drluriescience.netlify.app'), false);
  assert.equal(isInternalReferrerHost('Direct', 'https://drluriescience.netlify.app'), false);
  assert.equal(isInternalReferrerHost('', 'https://drluriescience.netlify.app'), false);
  // siteHost unset/unresolvable (e.g. process.env.URL absent) — degrade to "nothing is internal", never a guess.
  assert.equal(isInternalReferrerHost('drluriescience.netlify.app', undefined), false);
  assert.equal(isInternalReferrerHost('drluriescience.netlify.app', ''), false);
});

// ─── formatAnalyticsCount ───────────────────────────────────────────────────────

test('formatAnalyticsCount compacts large numbers and leaves small ones alone', () => {
  assert.equal(formatAnalyticsCount(0), '0');
  assert.equal(formatAnalyticsCount(42), '42');
  assert.equal(formatAnalyticsCount(999), '999');
  assert.equal(formatAnalyticsCount(1200), '1.2k');
  assert.equal(formatAnalyticsCount(12000), '12k');
  assert.equal(formatAnalyticsCount(2_500_000), '2.5M');
  assert.equal(formatAnalyticsCount(-1200), '-1.2k');
});

// ─── stored-range parsing ─────────────────────────────────────────────────────

test('analyticsRangeStorageKey is namespaced per site and per viewer', () => {
  assert.equal(analyticsRangeStorageKey('drlurie', 'a@x.com'), 'drlurie-analytics-range-a@x.com');
  assert.equal(analyticsRangeStorageKey('drlurie', ''), 'drlurie-analytics-range-anon');
});

test('parseStoredAnalyticsRange round-trips a valid value', () => {
  const value = { key: '90d' as const };
  const parsed = parseStoredAnalyticsRange(serializeStoredAnalyticsRange(value));
  assert.deepEqual(parsed, value);
});

test('parseStoredAnalyticsRange round-trips a custom value', () => {
  const value = { key: 'custom' as const, custom: { from: '2026-01-01', to: '2026-01-31' } };
  const parsed = parseStoredAnalyticsRange(serializeStoredAnalyticsRange(value));
  assert.deepEqual(parsed, value);
});

test('parseStoredAnalyticsRange never throws on garbage input', () => {
  assert.equal(parseStoredAnalyticsRange(null), null);
  assert.equal(parseStoredAnalyticsRange(''), null);
  assert.equal(parseStoredAnalyticsRange('not json'), null);
  assert.equal(parseStoredAnalyticsRange('{"key":"whatever"}'), null);
  assert.equal(parseStoredAnalyticsRange('{"key":"custom"}'), null);
  assert.equal(parseStoredAnalyticsRange('"just a string"'), null);
});

// ─── R6.2: withShareLimit — the generalized bar-list ranking transform ─────

test('withShareLimit: a taller limit than TOP_LIST_LIMIT keeps more rows, same share math', () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ label: `c${i}`, visits: i }));
  const result = withShareLimit(rows, 20);
  assert.equal(result.length, 20);
  assert.equal(result[0]!.visits, 24);
  assert.equal(result[0]!.share, 1);
});

// ─── R6.2: comparison deltas ─────────────────────────────────────────────────

test('computeDelta: a real, signed percent change with an arrow baked into the label', () => {
  assert.deepEqual(computeDelta(120, 100), { pct: 20, direction: 'up', label: '▲ 20%' });
  assert.deepEqual(computeDelta(80, 100), { pct: -20, direction: 'down', label: '▼ 20%' });
  assert.deepEqual(computeDelta(100, 100), { pct: 0, direction: 'flat', label: '→ 0%' });
});

test('computeDelta: no previous value ⇒ null, never a fabricated delta', () => {
  assert.equal(computeDelta(100, null), null);
  assert.equal(computeDelta(100, undefined), null);
});

test('computeDelta: a zero/negative baseline is undefined or absurd, so it hides — except 0→0, a real flat', () => {
  assert.equal(computeDelta(50, 0), null, 'previous of 0 with a nonzero current has no honest percent');
  assert.deepEqual(computeDelta(0, 0), { pct: 0, direction: 'flat', label: '→ 0%' });
  assert.equal(computeDelta(10, -5), null, 'a negative baseline should never occur, but is defensively hidden too');
});

// ─── R6.2/D2: formatBytes ────────────────────────────────────────────────────

test('formatBytes: compacts to the largest unit that keeps at least one whole digit', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2 KB');
  assert.equal(formatBytes(1_500_000), '1.4 MB');
  assert.equal(formatBytes(-5), '0 B', 'a negative byte count never occurs but degrades safely');
});

// ─── R6.2/D7: filters + chips ────────────────────────────────────────────────

test('hasAnalyticsFilters / analyticsFilterChips: empty filters produce no chips', () => {
  assert.equal(hasAnalyticsFilters({}), false);
  assert.deepEqual(analyticsFilterChips({}), []);
});

test('analyticsFilterChips: one chip per active filter, in a stable order', () => {
  assert.deepEqual(analyticsFilterChips({ country: 'IL', source: 'newsletter', object_id: 'page_home' }), [
    { key: 'country', label: 'country', value: 'IL' },
    { key: 'source', label: 'source', value: 'newsletter' },
    { key: 'object_id', label: 'object', value: 'page_home' },
  ]);
  assert.equal(hasAnalyticsFilters({ country: 'IL' }), true);
});

// ─── R6.2: tab/range/compare/filters ↔ URL round-trip ──────────────────────

test('isRangeAvailableForSource / clampRangeForSource: R6.2 lifted the own-tracker restriction — every range is available on every source', () => {
  for (const range of ['7d', '30d', '90d', 'custom'] as const) {
    for (const source of ['own', 'netlify'] as const) {
      assert.equal(isRangeAvailableForSource(range, source), true);
      assert.equal(clampRangeForSource(range, source), range);
    }
  }
});

test('isCompareAvailable: the control is available on both feeds now (R6.2) — whether a delta RENDERS is a data question, decided per-KPI', () => {
  assert.equal(isCompareAvailable('own'), true);
  assert.equal(isCompareAvailable('netlify'), true);
});

test('defaultCompareForRange: on for every preset, off for custom (D3)', () => {
  assert.equal(defaultCompareForRange('7d'), true);
  assert.equal(defaultCompareForRange('30d'), true);
  assert.equal(defaultCompareForRange('90d'), true);
  assert.equal(defaultCompareForRange('custom'), false);
});

test('parseAnalyticsSearchParams: defaults when the query string is empty', () => {
  const state = parseAnalyticsSearchParams('');
  assert.deepEqual(state, {
    source: DEFAULT_ANALYTICS_SOURCE,
    range: DEFAULT_ANALYTICS_RANGE,
    custom: undefined,
    compare: true, // 30d is a preset — D3 defaults comparison on
    filters: {},
  });
});

test('parseAnalyticsSearchParams: reads source/range/custom/compare/filters off a real query string', () => {
  const state = parseAnalyticsSearchParams(
    '?source=netlify&range=custom&from=2026-01-01&to=2026-01-31&compare=1&country=IL&fsource=newsletter&object=page_home'
  );
  assert.equal(state.source, 'netlify');
  assert.equal(state.range, 'custom');
  assert.deepEqual(state.custom, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(state.compare, true);
  assert.deepEqual(state.filters, { country: 'IL', source: 'newsletter', object_id: 'page_home' });
});

test('parseAnalyticsSearchParams: no explicit compare param falls back to the per-range D3 default, not "off"', () => {
  assert.equal(parseAnalyticsSearchParams('?range=7d').compare, true);
  assert.equal(parseAnalyticsSearchParams('?range=custom').compare, false);
});

test('parseAnalyticsSearchParams: compare=0 is honoured even on a preset range that defaults on', () => {
  assert.equal(parseAnalyticsSearchParams('?range=7d&compare=0').compare, false);
});

test('parseAnalyticsSearchParams: an unknown source/range falls back to the default rather than throwing', () => {
  assert.equal(parseAnalyticsSearchParams('?source=bogus').source, DEFAULT_ANALYTICS_SOURCE);
  assert.equal(parseAnalyticsSearchParams('?range=bogus').range, DEFAULT_ANALYTICS_RANGE);
});

test('parseAnalyticsSearchParams: own+90d is no longer clamped (R6.2 lifted the restriction)', () => {
  const state = parseAnalyticsSearchParams('?source=own&range=90d');
  assert.equal(state.source, 'own');
  assert.equal(state.range, '90d');
});

test('parseAnalyticsSearchParams: custom range without both dates is not treated as custom-with-input', () => {
  const state = parseAnalyticsSearchParams('?source=netlify&range=custom&from=2026-01-01');
  assert.equal(state.range, 'custom');
  assert.equal(state.custom, undefined);
});

test('serializeAnalyticsSearchParams ↔ parseAnalyticsSearchParams round-trips a plain range', () => {
  const state: AnalyticsSearchState = { source: 'netlify', range: '7d', compare: true, filters: {} };
  assert.deepEqual(parseAnalyticsSearchParams(`?${serializeAnalyticsSearchParams(state)}`), {
    ...state,
    custom: undefined,
  });
});

test('serializeAnalyticsSearchParams ↔ parseAnalyticsSearchParams round-trips a custom range with filters', () => {
  const state: AnalyticsSearchState = {
    source: 'own',
    range: 'custom',
    custom: { from: '2026-02-01', to: '2026-02-10' },
    compare: false,
    filters: { country: 'IL', object_id: 'page_home' },
  };
  assert.deepEqual(parseAnalyticsSearchParams(`?${serializeAnalyticsSearchParams(state)}`), state);
});

test('isAnalyticsSource: accepts own/netlify/insights (R11.5) and rejects anything else', () => {
  assert.equal(isAnalyticsSource('own'), true);
  assert.equal(isAnalyticsSource('netlify'), true);
  assert.equal(isAnalyticsSource('insights'), true);
  assert.equal(isAnalyticsSource('bogus'), false);
  assert.equal(isAnalyticsSource(undefined), false);
});

test('serializeAnalyticsSearchParams ↔ parseAnalyticsSearchParams round-trips the insights tab (R11.5 — the Insights tab uses the SAME ?source= mechanism)', () => {
  const state: AnalyticsSearchState = { source: 'insights', range: '30d', compare: true, filters: {} };
  const search = serializeAnalyticsSearchParams(state);
  assert.match(search, /source=insights/);
  assert.deepEqual(parseAnalyticsSearchParams(`?${search}`), { ...state, custom: undefined });
});

test('parseAnalyticsSearchParams: ?source=insights parses directly off a bookmarked URL', () => {
  assert.equal(parseAnalyticsSearchParams('?source=insights').source, 'insights');
});

test('serializeAnalyticsSearchParams: always writes an explicit compare=0|1 — a bookmark must reproduce the SAME value even if the D3 default rule changes later', () => {
  const on: AnalyticsSearchState = { source: 'own', range: '7d', compare: true, filters: {} };
  const off: AnalyticsSearchState = { source: 'own', range: '7d', compare: false, filters: {} };
  assert.match(serializeAnalyticsSearchParams(on), /compare=1/);
  assert.match(serializeAnalyticsSearchParams(off), /compare=0/);
});

test('isAnalyticsRangeKey rejects anything outside the four known keys', () => {
  assert.equal(isAnalyticsRangeKey('7d'), true);
  assert.equal(isAnalyticsRangeKey('custom'), true);
  assert.equal(isAnalyticsRangeKey('24h'), false);
  assert.equal(isAnalyticsRangeKey(undefined), false);
});

// ─── R6.2: resolveNetlifyAnalyticsPanel — one state per fixture ─────────────

const OK_WINDOW = resolveDateWindow('7d', NOW);
if (!OK_WINDOW.ok) throw new Error('fixture window must resolve');

const READY_SERIES: AnalyticsChartSeries = {
  totals: { visits: 900, uniques: 400, avgPerBucket: 128 },
  trend: [{ t: '2026-08-24', visits: 400, uniques: 180 }],
  topPaths: [{ label: '/about', visits: 400, share: 1 }],
  topSources: [{ label: 'google.com', visits: 200, share: 1 }],
};

test('resolveNetlifyAnalyticsPanel: an invalid custom range is a range_error, checked before loading/overview', () => {
  const badWindow = resolveDateWindow('custom', NOW, undefined);
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: badWindow,
    overview: null,
    compare: false,
  });
  assert.equal(panel.kind, 'range_error');
});

test('resolveNetlifyAnalyticsPanel: loading, then no overview yet, are both "loading"', () => {
  assert.deepEqual(
    resolveNetlifyAnalyticsPanel({
      loading: true,
      error: null,
      windowResult: OK_WINDOW,
      overview: null,
      compare: false,
    }),
    { kind: 'loading' }
  );
  assert.deepEqual(
    resolveNetlifyAnalyticsPanel({
      loading: false,
      error: null,
      windowResult: OK_WINDOW,
      overview: null,
      compare: false,
    }),
    { kind: 'loading' }
  );
});

test('resolveNetlifyAnalyticsPanel: a fetch error surfaces as "error" with the human message', () => {
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: 'Could not load analytics data.',
    windowResult: OK_WINDOW,
    overview: null,
    compare: false,
  });
  assert.deepEqual(panel, { kind: 'error', message: 'Could not load analytics data.' });
});

test('resolveNetlifyAnalyticsPanel: not configured — the "credentials missing" partial state', () => {
  const overview: AnalyticsOverview = { configured: false, enabled: false, range: '7d' };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  assert.equal(panel.kind, 'not_configured');
});

test('resolveNetlifyAnalyticsPanel: configured but not enabled — the "add-on off" partial state', () => {
  const overview: AnalyticsOverview = { configured: true, enabled: false, range: '7d' };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  assert.equal(panel.kind, 'not_enabled');
});

test('resolveNetlifyAnalyticsPanel: ready — D2 KPI strip (pageviews/uniques only, pre-R6.2-endpoint payload)', () => {
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: READY_SERIES,
  };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  // top_page_share is derived from data already on hand (400/900), so it renders even
  // without the R6.2 endpoints; not_found/bandwidth stay absent (no topNotFound/bandwidthBytes yet).
  assert.deepEqual(
    panel.kpis.map((k) => k.id),
    ['visits', 'uniques', 'top_page_share']
  );
  assert.equal(panel.chart.points, READY_SERIES.trend);
  assert.deepEqual(
    panel.rankings.map((r) => r.id),
    ['pages', 'sources', 'locations', 'not_found']
  );
  assert.equal(panel.rankings[1]!.views[0]!.rows, READY_SERIES.topSources);
  // Netlify's ranking API takes no filter params (D7) — the tab says so, once.
  assert.match(panel.rankings[1]!.views[0]!.footnote ?? '', /links, not filters/);
  // Locations/Not found are present as cards even before R6.2's endpoints are wired for this tenant — empty, not missing.
  assert.deepEqual(panel.rankings[2]!.views[0]!.rows, []);
});

test('resolveNetlifyAnalyticsPanel: ready with an all-zero range renders real zeros, not an empty/loading state', () => {
  const emptySeries: AnalyticsChartSeries = {
    totals: { visits: 0, uniques: 0, avgPerBucket: 0 },
    trend: [],
    topPaths: [],
    topSources: [],
  };
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: emptySeries,
  };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.kpis[0]!.value, '0');
  assert.deepEqual(panel.chart.points, []);
  // No pageviews/rows at all ⇒ top_page_share has nothing to divide, so it's omitted.
  assert.equal(
    panel.kpis.some((k) => k.id === 'top_page_share'),
    false
  );
});

test('resolveNetlifyAnalyticsPanel: R6.2 fields present — deltas, not_found/bandwidth KPIs, wired rankings', () => {
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: READY_SERIES,
    previousSeries: { ...READY_SERIES, totals: { visits: 750, uniques: 400, avgPerBucket: 107 } },
    topNotFound: [{ label: '/dead-link', visits: 12, share: 1 }],
    topCountries: [{ label: 'Israel', visits: 300, share: 1 }],
    bandwidthBytes: 2_500_000,
  };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: true,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.kpis.map((k) => k.id),
    ['visits', 'uniques', 'top_page_share', 'not_found', 'bandwidth']
  );
  assert.deepEqual(panel.kpis[0]!.delta, { pct: 20, direction: 'up', label: '▲ 20%' });
  assert.equal(panel.kpis.find((k) => k.id === 'not_found')!.value, '12');
  assert.equal(panel.kpis.find((k) => k.id === 'bandwidth')!.value, '2.4 MB');
  assert.deepEqual(panel.chart.previousPoints, overview.previousSeries!.trend);
  assert.deepEqual(panel.rankings.find((r) => r.id === 'locations')!.views[0]!.rows, overview.topCountries);
  assert.deepEqual(panel.rankings.find((r) => r.id === 'not_found')!.views[0]!.rows, overview.topNotFound);
});

test('resolveNetlifyAnalyticsPanel: R6.4/D8 — excludedAdminVisits/internalReferrerVisits render as real footer numbers, including an honest zero', () => {
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: READY_SERIES,
    excludedAdminVisits: 42,
    internalReferrerVisits: 7,
  };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.footer.map((item) => [item.id, item.value]),
    [
      ['sink', 'Netlify Analytics — server-side, not blockable'],
      ['excluded_admin', '42'],
      ['internal', '7'],
    ]
  );

  // A real, computed zero is still a number worth showing — it's the answer
  // "nothing was excluded this window", not "we don't know" (never shown as 0).
  const zeroOverview: AnalyticsOverview = { ...overview, excludedAdminVisits: 0, internalReferrerVisits: 0 };
  const zeroPanel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview: zeroOverview,
    compare: false,
  });
  if (zeroPanel.kind !== 'ready') throw new Error(`expected ready, got ${zeroPanel.kind}`);
  assert.deepEqual(
    zeroPanel.footer.map((item) => item.id),
    ['sink', 'excluded_admin']
  );
  assert.equal(zeroPanel.footer.find((item) => item.id === 'excluded_admin')!.value, '0');

  // Not yet computed at all (older cached payload, or the field never made it back) ⇒ absent, not a fabricated 0.
  const absentOverview: AnalyticsOverview = {
    ...overview,
    excludedAdminVisits: undefined,
    internalReferrerVisits: undefined,
  };
  const absentPanel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview: absentOverview,
    compare: false,
  });
  if (absentPanel.kind !== 'ready') throw new Error(`expected ready, got ${absentPanel.kind}`);
  assert.deepEqual(
    absentPanel.footer.map((item) => item.id),
    ['sink']
  );
});

test('resolveNetlifyAnalyticsPanel: compare off ⇒ no deltas and no ghost series, even when `previous` is present', () => {
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: READY_SERIES,
    previousSeries: { ...READY_SERIES, totals: { visits: 750, uniques: 400, avgPerBucket: 107 } },
  };
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    compare: false,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.kpis[0]!.delta, undefined);
  assert.equal(panel.chart.previousPoints, undefined);
});
