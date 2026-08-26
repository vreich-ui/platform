import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDateWindow,
  mapAnalyticsToChartSeries,
  normalizePathLabel,
  normalizeSourceLabel,
  formatTrafficCount,
  parseStoredTrafficRange,
  serializeStoredTrafficRange,
  trafficRangeStorageKey,
  buildLinePoints,
  pointsToPolyline,
  pointsToAreaPath,
  TOP_LIST_LIMIT,
  MAX_CUSTOM_RANGE_DAYS,
  type RawTrafficAnalytics,
} from './traffic-logic.js';

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
  const raw: RawTrafficAnalytics = {
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

// ─── formatTrafficCount ───────────────────────────────────────────────────────

test('formatTrafficCount compacts large numbers and leaves small ones alone', () => {
  assert.equal(formatTrafficCount(0), '0');
  assert.equal(formatTrafficCount(42), '42');
  assert.equal(formatTrafficCount(999), '999');
  assert.equal(formatTrafficCount(1200), '1.2k');
  assert.equal(formatTrafficCount(12000), '12k');
  assert.equal(formatTrafficCount(2_500_000), '2.5M');
  assert.equal(formatTrafficCount(-1200), '-1.2k');
});

// ─── stored-range parsing ─────────────────────────────────────────────────────

test('trafficRangeStorageKey is namespaced per site and per viewer', () => {
  assert.equal(trafficRangeStorageKey('drlurie', 'a@x.com'), 'drlurie-traffic-range-a@x.com');
  assert.equal(trafficRangeStorageKey('drlurie', ''), 'drlurie-traffic-range-anon');
});

test('parseStoredTrafficRange round-trips a valid value', () => {
  const value = { key: '90d' as const };
  const parsed = parseStoredTrafficRange(serializeStoredTrafficRange(value));
  assert.deepEqual(parsed, value);
});

test('parseStoredTrafficRange round-trips a custom value', () => {
  const value = { key: 'custom' as const, custom: { from: '2026-01-01', to: '2026-01-31' } };
  const parsed = parseStoredTrafficRange(serializeStoredTrafficRange(value));
  assert.deepEqual(parsed, value);
});

test('parseStoredTrafficRange never throws on garbage input', () => {
  assert.equal(parseStoredTrafficRange(null), null);
  assert.equal(parseStoredTrafficRange(''), null);
  assert.equal(parseStoredTrafficRange('not json'), null);
  assert.equal(parseStoredTrafficRange('{"key":"whatever"}'), null);
  assert.equal(parseStoredTrafficRange('{"key":"custom"}'), null);
  assert.equal(parseStoredTrafficRange('"just a string"'), null);
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
