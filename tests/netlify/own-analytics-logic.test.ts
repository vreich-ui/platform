/**
 * T21.2b — the own-tracker traffic feed. Pure-shaping tests (pinned contract
 * fixture → chart series / stat row / capture rate — the "renders correctly
 * with a fixture stats payload" half) plus the sink module's env-presence
 * predicate and URL/auth construction (the "not connected when the sink env
 * is absent" half; `admin-analytics.ts`'s `?source=own` branch is exercised
 * only at the shallow auth-wall level in `admin-analytics.test.ts`, matching
 * this file's existing house pattern — no deep HTTP-handler mocking exists
 * for this suite).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ownTrackerChartSeries,
  ownTrackerStatRow,
  captureRate,
  isOwnTrackerDays,
  surfaceBarRows,
  resolveOwnAnalyticsPanel,
  type OwnTrackerStatsPayload,
  type OwnAnalyticsOverview,
} from '../../packages/core/lib/admin/own-analytics-logic.js';
import {
  ownTrackerMissingEnvVars,
  isOwnTrackerConfigured,
  fetchOwnTrackerStats,
} from '../../packages/core/server/lib/own-tracker-stats.js';

const FIXTURE: OwnTrackerStatsPayload = {
  project_id: 'drlurie',
  days: 7,
  totals: {
    events_by_kind: { pageview: 900, buy_click: 40 },
    sessions: 300,
    visitors: 250,
    consented_sessions: 210,
    commerce_events: 55,
    member_links: 12,
  },
  daily: [
    { date: '2026-08-24', pageviews: 400, sessions: 140, visitors: 120, buy_clicks: 10, purchases: 3 },
    { date: '2026-08-25', pageviews: 500, sessions: 160, visitors: 130, buy_clicks: 12, purchases: 5 },
  ],
  top_objects: [
    {
      object_id: 'art_skincare_101',
      object_type: 'content_item',
      pageviews: 300,
      sessions: 120,
      completion_rate: 0.62,
    },
    { object_id: 'page_home', object_type: 'page', pageviews: 200, sessions: 90, completion_rate: 0.4 },
  ],
  top_sources: [
    { referrer_host_or_utm_source: 'google.com', sessions: 180 },
    { referrer_host_or_utm_source: '(direct)', sessions: 90 },
  ],
  last_event_at: '2026-08-25T18:32:00.000Z',
  dims: { object_version: 'v1', producer: 'own-tracker', node_strategy: 'default' },
};

// ─── isOwnTrackerDays ───────────────────────────────────────────────────────

test('isOwnTrackerDays: only 7 and 30 are valid — the sink accepts nothing else', () => {
  assert.equal(isOwnTrackerDays(7), true);
  assert.equal(isOwnTrackerDays(30), true);
  assert.equal(isOwnTrackerDays(90), false);
  assert.equal(isOwnTrackerDays(0), false);
  assert.equal(isOwnTrackerDays('7'), false);
  assert.equal(isOwnTrackerDays(undefined), false);
});

// ─── ownTrackerChartSeries — renders correctly from a fixture payload ──────

test('ownTrackerChartSeries: daily pageviews/sessions become trend, top_objects/top_sources become ranked bar rows', () => {
  const series = ownTrackerChartSeries(FIXTURE);

  assert.deepEqual(series.trend, [
    { t: '2026-08-24', visits: 400, uniques: 140 },
    { t: '2026-08-25', visits: 500, uniques: 160 },
  ]);
  assert.equal(series.totals.visits, 900, 'summed pageviews');
  assert.equal(series.totals.uniques, 300, 'summed sessions');

  assert.deepEqual(
    series.topPaths.map((r) => [r.label, r.visits, r.share]),
    [
      ['art_skincare_101', 300, 1],
      ['page_home', 200, 200 / 300],
    ]
  );
  assert.deepEqual(
    series.topSources.map((r) => [r.label, r.visits, r.share]),
    [
      ['google.com', 180, 1],
      ['(direct)', 90, 0.5],
    ]
  );
});

test('ownTrackerChartSeries: a missing/malformed row degrades to a safe default, never throws', () => {
  const malformed = {
    ...FIXTURE,
    daily: [{ date: 'x' } as unknown as OwnTrackerStatsPayload['daily'][number]],
    top_objects: [{} as unknown as OwnTrackerStatsPayload['top_objects'][number]],
    top_sources: [{} as unknown as OwnTrackerStatsPayload['top_sources'][number]],
  };
  const series = ownTrackerChartSeries(malformed);
  assert.deepEqual(series.trend, [{ t: 'x', visits: 0, uniques: 0 }]);
  assert.equal(series.topPaths[0]!.label, '(unknown object)');
  assert.equal(series.topSources[0]!.label, 'Direct');
});

// ─── ownTrackerStatRow ──────────────────────────────────────────────────────

test('ownTrackerStatRow: sessions/visitors/consented %/purchases/last event, from a fixture payload', () => {
  const row = ownTrackerStatRow(FIXTURE);
  assert.equal(row.sessions, 300);
  assert.equal(row.visitors, 250);
  assert.equal(row.consentedPct, 70, '210/300 = 70%');
  assert.equal(row.purchases, 8, 'summed daily purchases (3 + 5) — there is no totals.purchases in the contract');
  assert.equal(row.lastEventAt, '2026-08-25T18:32:00.000Z');
});

test('ownTrackerStatRow: zero sessions ⇒ consentedPct is null (nothing to divide by), never NaN/Infinity', () => {
  const empty: OwnTrackerStatsPayload = {
    ...FIXTURE,
    totals: { ...FIXTURE.totals, sessions: 0, consented_sessions: 0 },
    daily: [],
    last_event_at: null,
  };
  const row = ownTrackerStatRow(empty);
  assert.equal(row.consentedPct, null);
  assert.equal(row.purchases, 0);
  assert.equal(row.lastEventAt, null);
});

// ─── captureRate — honest, range-matched, never a false "full coverage" ────

test('captureRate: own ÷ Netlify pageviews, only when both windows are the same day-count', () => {
  assert.equal(captureRate(900, 1200, 7, 7), 75, '900/1200 = 75.0%');
  assert.equal(captureRate(900, 1200, 30, 7), null, 'own is a 30-day window, Netlify a 7-day one — not the same range');
  assert.equal(captureRate(900, 1200, 7, 90), null, 'Netlify on 90d has no matching own-tracker window');
  assert.equal(captureRate(900, 1200, 7, null), null, 'Netlify on a custom range has no day-count to compare');
});

test('captureRate: zero Netlify pageviews ⇒ null, never a divide-by-zero Infinity read as "infinite capture"', () => {
  assert.equal(captureRate(900, 0, 7, 7), null);
});

// ─── own-tracker-stats: env presence + request shape (I/O module) ─────────

test('ownTrackerMissingEnvVars / isOwnTrackerConfigured: TRACKING_SINK_URL + TRACKING_PROJECT_ID only', () => {
  assert.deepEqual(ownTrackerMissingEnvVars({}).sort(), ['TRACKING_PROJECT_ID', 'TRACKING_SINK_URL']);
  assert.equal(isOwnTrackerConfigured({}), false);

  assert.deepEqual(ownTrackerMissingEnvVars({ TRACKING_SINK_URL: 'https://sink.example' }), ['TRACKING_PROJECT_ID']);

  assert.deepEqual(
    ownTrackerMissingEnvVars({ TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' }),
    []
  );
  assert.equal(
    isOwnTrackerConfigured({ TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' }),
    true
  );
});

test('fetchOwnTrackerStats: not configured ⇒ rejects without ever calling fetch', async () => {
  let called = false;
  await assert.rejects(() =>
    fetchOwnTrackerStats(7, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    })
  );
  assert.equal(called, false, 'an unconfigured sink is never actually requested');
});

test('fetchOwnTrackerStats: GET {sinkUrl}/stats?project_id&days, Bearer auth when a token is set, trailing slash stripped', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify({ ...FIXTURE, days: 30 }), { status: 200 });
  }) as typeof fetch;

  const result = await fetchOwnTrackerStats(30, {
    env: {
      TRACKING_SINK_URL: 'https://sink.example/base/',
      TRACKING_PROJECT_ID: 'drlurie',
      TRACKING_SINK_TOKEN: 'tok',
    },
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, 'https://sink.example/base/stats?project_id=drlurie&days=30');
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok');
  assert.equal(result.days, 30);
});

test('fetchOwnTrackerStats: no TRACKING_SINK_TOKEN ⇒ no Authorization header sent', async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  await fetchOwnTrackerStats(7, {
    env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
    fetchImpl,
  });

  assert.equal(calls[0]!.headers.Authorization, undefined);
});

test('fetchOwnTrackerStats: a non-2xx sink response throws (a real fault, not a soft "not connected")', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  await assert.rejects(() =>
    fetchOwnTrackerStats(7, {
      env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
      fetchImpl,
    })
  );
});

// ─── surfaceBarRows ─────────────────────────────────────────────────────────

test('surfaceBarRows: shares are relative to the largest surface, labels carry the object count', () => {
  const rows = surfaceBarRows([
    { surface: 'workflow', objects: 3, pageviews: 100 },
    { surface: 'plugin:claude', objects: 1, pageviews: 50 },
  ]);
  assert.deepEqual(rows, [
    { label: 'workflow (3 objects)', visits: 100, share: 1 },
    { label: 'plugin:claude (1 object)', visits: 50, share: 0.5 },
  ]);
});

test('surfaceBarRows: an all-zero split never divides by zero', () => {
  const rows = surfaceBarRows([{ surface: 'unknown', objects: 1, pageviews: 0 }]);
  assert.equal(rows[0]!.share, 0);
});

// ─── R6.1: resolveOwnAnalyticsPanel — one state per fixture ────────────────

test('resolveOwnAnalyticsPanel: loading, then no overview yet, are both "loading"', () => {
  assert.deepEqual(
    resolveOwnAnalyticsPanel({
      loading: true,
      error: null,
      overview: null,
      netlifyPageviews: null,
      netlifyRangeDays: null,
      days: 7,
    }),
    { kind: 'loading' }
  );
  assert.deepEqual(
    resolveOwnAnalyticsPanel({
      loading: false,
      error: null,
      overview: null,
      netlifyPageviews: null,
      netlifyRangeDays: null,
      days: 7,
    }),
    { kind: 'loading' }
  );
});

test('resolveOwnAnalyticsPanel: a fetch error surfaces as "error" with the human message', () => {
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: 'Could not load analytics data.',
    overview: null,
    netlifyPageviews: null,
    netlifyRangeDays: null,
    days: 7,
  });
  assert.deepEqual(panel, { kind: 'error', message: 'Could not load analytics data.' });
});

test('resolveOwnAnalyticsPanel: sink not configured — the "not connected" partial state (own present, Netlify off case starts here)', () => {
  const overview: OwnAnalyticsOverview = { configured: false, enabled: false, days: 7 };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    overview,
    netlifyPageviews: null,
    netlifyRangeDays: null,
    days: 7,
  });
  assert.equal(panel.kind, 'not_configured');
});

test('resolveOwnAnalyticsPanel: ready — capture rate lands in the FOOTER, never the KPI strip', () => {
  const overview: OwnAnalyticsOverview = { configured: true, enabled: true, days: 7, stats: FIXTURE };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    overview,
    netlifyPageviews: 1200,
    netlifyRangeDays: 7,
    days: 7,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.kpis.map((k) => k.id),
    ['pageviews', 'sessions', 'visitors', 'consented', 'purchases']
  );
  assert.equal(
    panel.kpis.some((k) => k.id === 'capture_rate' || k.id === 'last_event'),
    false,
    'health/meta must not be in the KPI strip'
  );
  const footerIds = panel.footer.map((f) => f.id);
  assert.deepEqual(footerIds, ['last_event', 'capture_rate']);
  assert.equal(panel.footer.find((f) => f.id === 'capture_rate')!.value, '75%', '900/1200 pageviews = 75.0%');
});

test('resolveOwnAnalyticsPanel: capture rate is honestly "Not available" when the ranges do not match — never a fabricated number', () => {
  const overview: OwnAnalyticsOverview = { configured: true, enabled: true, days: 7, stats: FIXTURE };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    overview,
    netlifyPageviews: 1200,
    netlifyRangeDays: null, // Netlify is on 90d/custom — no matching own-tracker window
    days: 7,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.footer.find((f) => f.id === 'capture_rate')!.value, 'Not available');
});

test('resolveOwnAnalyticsPanel: a single publishing surface does not get its own ranking card (one fact is not a chart)', () => {
  const overview: OwnAnalyticsOverview = {
    configured: true,
    enabled: true,
    days: 7,
    stats: FIXTURE,
    surfaces: [{ surface: 'workflow', objects: 2, pageviews: 500 }],
  };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    overview,
    netlifyPageviews: null,
    netlifyRangeDays: null,
    days: 7,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.rankings.map((r) => r.id),
    ['objects', 'sources']
  );
});

test('resolveOwnAnalyticsPanel: two+ publishing surfaces add the third ranking card', () => {
  const overview: OwnAnalyticsOverview = {
    configured: true,
    enabled: true,
    days: 7,
    stats: FIXTURE,
    surfaces: [
      { surface: 'workflow', objects: 2, pageviews: 500 },
      { surface: 'plugin:claude', objects: 1, pageviews: 200 },
    ],
  };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    overview,
    netlifyPageviews: null,
    netlifyRangeDays: null,
    days: 7,
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.deepEqual(
    panel.rankings.map((r) => r.id),
    ['objects', 'sources', 'surfaces']
  );
});
