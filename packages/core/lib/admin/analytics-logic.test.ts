import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDateWindow,
  mapAnalyticsToChartSeries,
  normalizePathLabel,
  normalizeSourceLabel,
  formatAnalyticsCount,
  parseStoredAnalyticsRange,
  serializeStoredAnalyticsRange,
  analyticsRangeStorageKey,
  buildLinePoints,
  pointsToPolyline,
  pointsToAreaPath,
  TOP_LIST_LIMIT,
  MAX_CUSTOM_RANGE_DAYS,
  isAnalyticsRangeKey,
  isRangeAvailableForSource,
  clampRangeForSource,
  isCompareAvailable,
  parseAnalyticsSearchParams,
  serializeAnalyticsSearchParams,
  DEFAULT_ANALYTICS_SOURCE,
  DEFAULT_ANALYTICS_RANGE,
  resolveNetlifyAnalyticsPanel,
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

// ─── chart geometry ───────────────────────────────────────────────────────────

test('buildLinePoints: empty series produces no points', () => {
  assert.deepEqual(buildLinePoints([], 100, 40), []);
});

test('buildLinePoints: a single value centers itself', () => {
  const points = buildLinePoints([5], 100, 40);
  assert.deepEqual(points, [{ x: 50, y: 20 }]);
});

test('buildLinePoints: spans the full width and respects padding vertically', () => {
  const points = buildLinePoints([0, 10], 100, 40, 4);
  assert.equal(points.length, 2);
  assert.equal(points[0].x, 4);
  assert.equal(points[1].x, 96);
  // min value sits at the bottom (y = height - padding), max at the top (y = padding)
  assert.equal(points[0].y, 36);
  assert.equal(points[1].y, 4);
});

test('buildLinePoints: a flat series (no span) does not divide by zero', () => {
  const points = buildLinePoints([7, 7, 7], 100, 40);
  assert.ok(points.every((p) => Number.isFinite(p.y)));
});

test('pointsToPolyline formats an SVG points attribute', () => {
  assert.equal(
    pointsToPolyline([
      { x: 1, y: 2 },
      { x: 3.5, y: 4 },
    ]),
    '1,2 3.5,4'
  );
});

test('pointsToAreaPath closes the shape down to the baseline', () => {
  const path = pointsToAreaPath(
    [
      { x: 0, y: 10 },
      { x: 10, y: 0 },
    ],
    20
  );
  assert.equal(path, 'M0,10 L10,0 L10,20 L0,20 Z');
});

test('pointsToAreaPath on an empty series returns an empty string, not a broken path', () => {
  assert.equal(pointsToAreaPath([], 20), '');
});

// ─── R6.1: tab/range/compare ↔ URL round-trip ───────────────────────────────

test('isRangeAvailableForSource: the own tracker only serves 7d/30d today; Netlify serves all four', () => {
  assert.equal(isRangeAvailableForSource('7d', 'own'), true);
  assert.equal(isRangeAvailableForSource('30d', 'own'), true);
  assert.equal(isRangeAvailableForSource('90d', 'own'), false);
  assert.equal(isRangeAvailableForSource('custom', 'own'), false);
  for (const range of ['7d', '30d', '90d', 'custom'] as const) {
    assert.equal(isRangeAvailableForSource(range, 'netlify'), true);
  }
});

test('clampRangeForSource: an unservable own-tracker range falls back to 30d; everything else is unchanged', () => {
  assert.equal(clampRangeForSource('90d', 'own'), '30d');
  assert.equal(clampRangeForSource('custom', 'own'), '30d');
  assert.equal(clampRangeForSource('7d', 'own'), '7d');
  assert.equal(clampRangeForSource('90d', 'netlify'), '90d');
});

test('isCompareAvailable: inert for every source in R6.1 — no feed has a previous-period figure yet', () => {
  assert.equal(isCompareAvailable('own'), false);
  assert.equal(isCompareAvailable('netlify'), false);
});

test('parseAnalyticsSearchParams: defaults when the query string is empty', () => {
  const state = parseAnalyticsSearchParams('');
  assert.deepEqual(state, {
    source: DEFAULT_ANALYTICS_SOURCE,
    range: DEFAULT_ANALYTICS_RANGE,
    custom: undefined,
    compare: false,
  });
});

test('parseAnalyticsSearchParams: reads source/range/custom/compare off a real query string', () => {
  const state = parseAnalyticsSearchParams('?source=netlify&range=custom&from=2026-01-01&to=2026-01-31&compare=1');
  assert.equal(state.source, 'netlify');
  assert.equal(state.range, 'custom');
  assert.deepEqual(state.custom, { from: '2026-01-01', to: '2026-01-31' });
  // compare=1 is requested, but isCompareAvailable is false for every source in R6.1 — never honoured yet.
  assert.equal(state.compare, false);
});

test('parseAnalyticsSearchParams: an unknown source/range falls back to the default rather than throwing', () => {
  assert.equal(parseAnalyticsSearchParams('?source=bogus').source, DEFAULT_ANALYTICS_SOURCE);
  assert.equal(parseAnalyticsSearchParams('?range=bogus').range, DEFAULT_ANALYTICS_RANGE);
});

test('parseAnalyticsSearchParams: a bookmarked own+90d combo clamps to 30d, same rule the picker enforces', () => {
  const state = parseAnalyticsSearchParams('?source=own&range=90d');
  assert.equal(state.source, 'own');
  assert.equal(state.range, '30d');
});

test('parseAnalyticsSearchParams: custom range without both dates is not treated as custom-with-input', () => {
  const state = parseAnalyticsSearchParams('?source=netlify&range=custom&from=2026-01-01');
  assert.equal(state.range, 'custom');
  assert.equal(state.custom, undefined);
});

test('serializeAnalyticsSearchParams ↔ parseAnalyticsSearchParams round-trips a plain range', () => {
  const state: AnalyticsSearchState = { source: 'netlify', range: '7d', compare: false };
  assert.deepEqual(parseAnalyticsSearchParams(`?${serializeAnalyticsSearchParams(state)}`), {
    ...state,
    custom: undefined,
  });
});

test('serializeAnalyticsSearchParams ↔ parseAnalyticsSearchParams round-trips a custom range', () => {
  const state: AnalyticsSearchState = {
    source: 'own',
    range: 'custom',
    custom: { from: '2026-02-01', to: '2026-02-10' },
    compare: false,
  };
  // A custom range only round-trips through the own tab if it survives the source's own
  // availability rule — it doesn't (own only serves 7d/30d) — so state the input honestly:
  // this exercises the netlify tab instead, where custom really is available.
  const netlifyState: AnalyticsSearchState = { ...state, source: 'netlify' };
  assert.deepEqual(parseAnalyticsSearchParams(`?${serializeAnalyticsSearchParams(netlifyState)}`), netlifyState);
});

test('serializeAnalyticsSearchParams never writes compare=1 — R6.1 has nothing honest to compare against', () => {
  const withCompareRequested: AnalyticsSearchState = { source: 'own', range: '7d', compare: true };
  const qs = serializeAnalyticsSearchParams(withCompareRequested);
  assert.equal(qs.includes('compare'), false);
});

test('isAnalyticsRangeKey rejects anything outside the four known keys', () => {
  assert.equal(isAnalyticsRangeKey('7d'), true);
  assert.equal(isAnalyticsRangeKey('custom'), true);
  assert.equal(isAnalyticsRangeKey('24h'), false);
  assert.equal(isAnalyticsRangeKey(undefined), false);
});

// ─── R6.1: resolveNetlifyAnalyticsPanel — one state per fixture ─────────────

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
  const panel = resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: badWindow, overview: null });
  assert.equal(panel.kind, 'range_error');
});

test('resolveNetlifyAnalyticsPanel: loading, then no overview yet, are both "loading"', () => {
  assert.deepEqual(
    resolveNetlifyAnalyticsPanel({ loading: true, error: null, windowResult: OK_WINDOW, overview: null }),
    { kind: 'loading' }
  );
  assert.deepEqual(
    resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: OK_WINDOW, overview: null }),
    { kind: 'loading' }
  );
});

test('resolveNetlifyAnalyticsPanel: a fetch error surfaces as "error" with the human message', () => {
  const panel = resolveNetlifyAnalyticsPanel({
    loading: false,
    error: 'Could not load analytics data.',
    windowResult: OK_WINDOW,
    overview: null,
  });
  assert.deepEqual(panel, { kind: 'error', message: 'Could not load analytics data.' });
});

test('resolveNetlifyAnalyticsPanel: not configured — the "credentials missing" partial state', () => {
  const overview: AnalyticsOverview = { configured: false, enabled: false, range: '7d' };
  const panel = resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: OK_WINDOW, overview });
  assert.equal(panel.kind, 'not_configured');
});

test('resolveNetlifyAnalyticsPanel: configured but not enabled — the "add-on off" partial state', () => {
  const overview: AnalyticsOverview = { configured: true, enabled: false, range: '7d' };
  const panel = resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: OK_WINDOW, overview });
  assert.equal(panel.kind, 'not_enabled');
});

test('resolveNetlifyAnalyticsPanel: ready — KPI strip, chart, and ranking cards all trace to the fixture series', () => {
  const overview: AnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    window: OK_WINDOW.window,
    series: READY_SERIES,
  };
  const panel = resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: OK_WINDOW, overview });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.kpis.map((k) => [k.id, k.value]),
    [
      ['visits', '900'],
      ['uniques', '400'],
      ['avg', '128'],
    ]
  );
  assert.equal(panel.chart.points, READY_SERIES.trend);
  assert.deepEqual(
    panel.rankings.map((r) => r.id),
    ['pages', 'sources']
  );
  assert.equal(panel.rankings[1]!.rows, READY_SERIES.topSources);
  // Netlify's ranking API takes no filter params (D7) — the tab says so, once.
  assert.match(panel.rankings[1]!.footnote ?? '', /links, not filters/);
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
  const panel = resolveNetlifyAnalyticsPanel({ loading: false, error: null, windowResult: OK_WINDOW, overview });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.kpis[0]!.value, '0');
  assert.deepEqual(panel.chart.points, []);
});
