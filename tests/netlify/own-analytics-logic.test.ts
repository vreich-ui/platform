/**
 * T21.2b / R6.2 (T21.24) — the own-tracker analytics feed. Pure-shaping
 * tests (pinned contract fixture → chart series / stat row / capture rate /
 * every new R6.2 dimension ranking) plus the sink module's env-presence
 * predicate and URL/auth construction (the "not connected when the sink env
 * is absent" half; `admin-analytics.ts`'s `?source=own` branch is exercised
 * only at the shallow auth-wall level in `admin-analytics.test.ts`, matching
 * this file's existing house pattern — no deep HTTP-handler mocking exists
 * for this suite).
 *
 * Two fixtures per the R6.2 brief: `FIXTURE` is the OLD payload shape (no
 * R6.2 fields at all — the sink before it deploys); `FIXTURE_R62` is the
 * NEW shape with every addition populated. Every shaping function is
 * exercised against both, proving the "every field may be missing" posture
 * for real rather than by inspection.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ownTrackerChartSeries,
  ownTrackerStatRow,
  captureRate,
  surfaceBarRows,
  topObjectRows,
  topSourceRows,
  topCountryRows,
  topReferrerHostRows,
  utmRows,
  deviceViewportRows,
  deviceLangRows,
  entryExitPageRows,
  scrollDepthRows,
  engagementFunnelRows,
  resolveOwnAnalyticsPanel,
  type OwnTrackerStatsPayload,
  type OwnAnalyticsOverview,
  type ObjectDirectory,
} from '../../packages/core/lib/admin/own-analytics-logic.js';
import { resolveDateWindow } from '../../packages/core/lib/admin/analytics-logic.js';
import {
  ownTrackerMissingEnvVars,
  isOwnTrackerConfigured,
  fetchOwnTrackerStats,
} from '../../packages/core/server/lib/own-tracker-stats.js';

// ─── the OLD payload shape (pre-R6.2 — no `from`/`to`/`top_countries`/… at all) ──

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

// ─── the NEW payload shape (R6.2 — everything the brief adds, populated) ────

const FIXTURE_R62: OwnTrackerStatsPayload = {
  ...FIXTURE,
  from: '2026-08-24T00:00:00.000Z',
  to: '2026-08-25T23:59:59.999Z',
  top_countries: [
    { country: 'IL', sessions: 200 },
    { country: 'US', sessions: 80 },
  ],
  top_referrer_hosts: {
    hosts: [{ host: 'google.com', sessions: 150 }],
    internal_sessions: 40,
  },
  utm: {
    source: [{ value: 'newsletter', sessions: 60 }],
    medium: [{ value: 'email', sessions: 60 }],
    campaign: [{ value: 'launch', sessions: 40 }],
  },
  devices: {
    viewport: { lt640: 100, w640to1023: 80, gte1024: 120 },
    top_langs: [{ lang: 'en', sessions: 250 }],
  },
  entry_pages: [{ url_path: '/about', sessions: 90 }],
  exit_pages: [{ url_path: '/contact', sessions: 30 }],
  scroll_depth_distribution: { '25': 280, '50': 200, '75': 120, '90': 60, '100': 20 },
  engagement_funnel: [
    { object_id: 'art_skincare_101', pageview: 300, read_progress: 200, completion: 90, cta_click: 30, buy_click: 6 },
  ],
  events_by_kind_daily: [{ date: '2026-08-24', events_by_kind: { pageview: 400 } }],
  previous: {
    from: '2026-08-22T00:00:00.000Z',
    to: '2026-08-23T23:59:59.999Z',
    totals: {
      events_by_kind: { pageview: 700 },
      sessions: 250,
      visitors: 210,
      consented_sessions: 180,
      commerce_events: 40,
      member_links: 8,
    },
    daily: [{ date: '2026-08-22', pageviews: 750, sessions: 250, visitors: 210, buy_clicks: 8, purchases: 2 }],
    top_objects: [],
    top_sources: [],
    last_event_at: '2026-08-23T18:00:00.000Z',
  },
};

const DIRECTORY: ObjectDirectory = {
  art_skincare_101: { title: 'Skincare 101', route: '/skincare-101', objectType: 'content_item' },
  page_home: null, // looked up, not found
};

// ─── ownTrackerChartSeries — renders correctly from a fixture payload ──────

test('ownTrackerChartSeries: daily pageviews/sessions become trend, top_objects/top_sources become ranked bar rows (old payload shape)', () => {
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

test('ownTrackerChartSeries: the new payload shape shapes identically on the fields it shares with the old one', () => {
  const series = ownTrackerChartSeries(FIXTURE_R62);
  assert.equal(series.totals.visits, 900);
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

// ─── captureRate (R6.2: two args — both tabs share one window now, no day-count) ──

test('captureRate: own ÷ Netlify pageviews', () => {
  assert.equal(captureRate(900, 1200), 75, '900/1200 = 75.0%');
});

test('captureRate: Netlify unknown/unavailable or zero ⇒ null, never a divide-by-zero Infinity read as "infinite capture"', () => {
  assert.equal(captureRate(900, null), null);
  assert.equal(captureRate(900, 0), null);
});

// ─── R6.2: the new dimension row-builders — each tolerant of the OLD payload shape (field absent) ──

test('topObjectRows: resolves via the object directory, marks an unresolved id visibly, links to the admin object', () => {
  const rows = topObjectRows(FIXTURE, DIRECTORY);
  assert.deepEqual(
    rows.map((r) => [r.label, r.value, r.href, r.unresolved]),
    [
      ['Skincare 101', 'art_skincare_101', '/skincare-101', false],
      ['page_home', 'page_home', undefined, true],
    ]
  );
  assert.equal(rows[0]!.adminHref, '/admin/content/art_skincare_101');
  assert.equal(
    rows[0]!.analyticsHref,
    '/admin/analytics/object/art_skincare_101',
    'R11.4: every object row links to its drill-down'
  );
});

test('topObjectRows: no directory at all ⇒ every row unresolved, never hidden (D6)', () => {
  const rows = topObjectRows(FIXTURE);
  assert.ok(rows.every((r) => r.unresolved === true));
});

test('topSourceRows: the pre-R6.2 combined dimension, still usable as a fallback', () => {
  const rows = topSourceRows(FIXTURE);
  assert.deepEqual(
    rows.map((r) => r.label),
    ['google.com', 'Direct']
  );
});

test('topCountryRows: absent on the old payload ⇒ empty, never thrown', () => {
  assert.deepEqual(topCountryRows(FIXTURE), []);
});

test('topCountryRows: ranks countries by session, filter value is the raw code', () => {
  const rows = topCountryRows(FIXTURE_R62);
  assert.deepEqual(
    rows.map((r) => [r.label, r.value, r.visits]),
    [
      ['IL', 'IL', 200],
      ['US', 'US', 80],
    ]
  );
});

test('topReferrerHostRows: same-host sessions are reported separately as internalSessions, never ranked (D8)', () => {
  const { rows, internalSessions } = topReferrerHostRows(FIXTURE_R62);
  assert.deepEqual(
    rows.map((r) => r.label),
    ['google.com']
  );
  assert.equal(internalSessions, 40);
});

test('topReferrerHostRows: absent on the old payload ⇒ empty rows, zero internal sessions', () => {
  const { rows, internalSessions } = topReferrerHostRows(FIXTURE);
  assert.deepEqual(rows, []);
  assert.equal(internalSessions, 0);
});

test('utmRows: each dimension reads its own array, absent ⇒ empty', () => {
  assert.deepEqual(
    utmRows(FIXTURE_R62, 'source').map((r) => r.label),
    ['newsletter']
  );
  assert.deepEqual(
    utmRows(FIXTURE_R62, 'medium').map((r) => r.label),
    ['email']
  );
  assert.deepEqual(utmRows(FIXTURE, 'campaign'), []);
});

test('deviceViewportRows: the three fixed buckets, labeled, absent ⇒ empty', () => {
  const rows = deviceViewportRows(FIXTURE_R62);
  assert.deepEqual(
    rows.map((r) => [r.label, r.visits]),
    [
      ['≥ 1024px', 120],
      ['< 640px', 100],
      ['640–1023px', 80],
    ]
  );
  assert.deepEqual(deviceViewportRows(FIXTURE), []);
});

test('deviceLangRows: absent ⇒ empty, present ⇒ ranked', () => {
  assert.deepEqual(deviceLangRows(FIXTURE), []);
  assert.deepEqual(
    deviceLangRows(FIXTURE_R62).map((r) => r.label),
    ['en']
  );
});

test('entryExitPageRows: url_path becomes both label and a relative href', () => {
  const entry = entryExitPageRows(FIXTURE_R62, 'entry_pages');
  assert.deepEqual(
    entry.map((r) => [r.label, r.href]),
    [['/about', '/about']]
  );
  const exit = entryExitPageRows(FIXTURE_R62, 'exit_pages');
  assert.deepEqual(
    exit.map((r) => r.label),
    ['/contact']
  );
  assert.deepEqual(entryExitPageRows(FIXTURE, 'entry_pages'), []);
});

test('scrollDepthRows: cumulative buckets rendered as their own rows, in order, absent ⇒ empty', () => {
  const rows = scrollDepthRows(FIXTURE_R62);
  assert.deepEqual(
    rows.map((r) => r.label),
    ['25%', '50%', '75%', '90%', '100%']
  );
  assert.equal(rows[0]!.visits, 280);
  assert.deepEqual(scrollDepthRows(FIXTURE), []);
});

test('engagementFunnelRows: resolves the object id and summarizes every stage as a percent of pageview', () => {
  const rows = engagementFunnelRows(FIXTURE_R62, DIRECTORY);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, 'Skincare 101');
  assert.equal(rows[0]!.value, 'art_skincare_101');
  assert.equal(rows[0]!.sublabel, '67% read · 30% complete · 10% CTA · 2% buy');
  assert.equal(rows[0]!.unresolved, false);
  assert.equal(rows[0]!.analyticsHref, '/admin/analytics/object/art_skincare_101');
});

test('engagementFunnelRows: zero pageview never divides by zero', () => {
  const rows = engagementFunnelRows({
    engagement_funnel: [{ object_id: 'x', pageview: 0, read_progress: 0, completion: 0, cta_click: 0, buy_click: 0 }],
  });
  assert.equal(rows[0]!.sublabel, '— read · — complete · — CTA · — buy');
});

test('engagementFunnelRows: absent on the old payload ⇒ empty', () => {
  assert.deepEqual(engagementFunnelRows(FIXTURE), []);
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

const WINDOW = { from: '2026-08-24T00:00:00.000Z', to: '2026-08-25T23:59:59.999Z' };

test('fetchOwnTrackerStats: not configured ⇒ rejects without ever calling fetch', async () => {
  let called = false;
  await assert.rejects(() =>
    fetchOwnTrackerStats(WINDOW, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        return new Response('{}', { status: 200 });
      }) as typeof fetch,
    })
  );
  assert.equal(called, false, 'an unconfigured sink is never actually requested');
});

test('fetchOwnTrackerStats: GET {sinkUrl}/stats?project_id&from&to&exclude_test=1 by default, Bearer auth when a token is set, trailing slash stripped', async () => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(FIXTURE_R62), { status: 200 });
  }) as typeof fetch;

  const result = await fetchOwnTrackerStats(WINDOW, {
    env: {
      TRACKING_SINK_URL: 'https://sink.example/base/',
      TRACKING_PROJECT_ID: 'drlurie',
      TRACKING_SINK_TOKEN: 'tok',
    },
    fetchImpl,
  });

  assert.equal(calls.length, 1);
  assert.equal(
    calls[0]!.url,
    'https://sink.example/base/stats?project_id=drlurie&from=2026-08-24T00%3A00%3A00.000Z&to=2026-08-25T23%3A59%3A59.999Z&exclude_test=1'
  );
  assert.equal(calls[0]!.headers.Authorization, 'Bearer tok');
  assert.equal(result.top_countries?.length, 2);
});

test('fetchOwnTrackerStats: D7 filters are appended only when present', () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  return fetchOwnTrackerStats(WINDOW, {
    env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
    fetchImpl,
    filters: { country: 'IL', object_id: 'page_home' },
  }).then(() => {
    assert.match(calls[0]!, /country=IL/);
    assert.match(calls[0]!, /object_id=page_home/);
    assert.doesNotMatch(calls[0]!, /[?&]source=/);
  });
});

test('fetchOwnTrackerStats: excludeTest:false omits the exclude_test param', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  await fetchOwnTrackerStats(WINDOW, {
    env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
    fetchImpl,
    excludeTest: false,
  });
  assert.doesNotMatch(calls[0]!, /exclude_test/);
});

test('fetchOwnTrackerStats: no TRACKING_SINK_TOKEN ⇒ no Authorization header sent', async () => {
  const calls: Array<{ headers: Record<string, string> }> = [];
  const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls.push({ headers: (init?.headers as Record<string, string>) ?? {} });
    return new Response(JSON.stringify(FIXTURE), { status: 200 });
  }) as typeof fetch;

  await fetchOwnTrackerStats(WINDOW, {
    env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
    fetchImpl,
  });

  assert.equal(calls[0]!.headers.Authorization, undefined);
});

test('fetchOwnTrackerStats: a non-2xx sink response throws (a real fault, not a soft "not connected")', async () => {
  const fetchImpl = (async () => new Response('nope', { status: 500 })) as typeof fetch;
  await assert.rejects(() =>
    fetchOwnTrackerStats(WINDOW, {
      env: { TRACKING_SINK_URL: 'https://sink.example', TRACKING_PROJECT_ID: 'drlurie' },
      fetchImpl,
    })
  );
});

// ─── R6.2: resolveOwnAnalyticsPanel — one state per fixture ────────────────

const OK_WINDOW = resolveDateWindow('7d', new Date('2026-08-26T12:00:00.000Z'));
if (!OK_WINDOW.ok) throw new Error('fixture window must resolve');

test('resolveOwnAnalyticsPanel: an invalid custom range is a range_error, checked before loading/overview (R6.2: the own tab shares the range picker now)', () => {
  const badWindow = resolveDateWindow('custom', new Date('2026-08-26T12:00:00.000Z'), undefined);
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: badWindow,
    overview: null,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  assert.equal(panel.kind, 'range_error');
});

test('resolveOwnAnalyticsPanel: loading, then no overview yet, are both "loading"', () => {
  const base = {
    windowResult: OK_WINDOW,
    overview: null,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  } as const;
  assert.deepEqual(resolveOwnAnalyticsPanel({ ...base, loading: true, error: null }), { kind: 'loading' });
  assert.deepEqual(resolveOwnAnalyticsPanel({ ...base, loading: false, error: null }), { kind: 'loading' });
});

test('resolveOwnAnalyticsPanel: a fetch error surfaces as "error" with the human message', () => {
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: 'Could not load analytics data.',
    windowResult: OK_WINDOW,
    overview: null,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  assert.deepEqual(panel, { kind: 'error', message: 'Could not load analytics data.' });
});

test('resolveOwnAnalyticsPanel: sink not configured — the "not connected" partial state', () => {
  const overview: OwnAnalyticsOverview = { configured: false, enabled: false, range: '7d' };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  assert.equal(panel.kind, 'not_configured');
});

test('resolveOwnAnalyticsPanel: ready (old payload shape) — capture rate lands in the FOOTER, never the KPI strip; new-dimension cards render their "not deployed yet" empty state', () => {
  const overview: OwnAnalyticsOverview = { configured: true, enabled: true, range: '7d', stats: FIXTURE };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: 1200,
    compare: false,
    filters: {},
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

  assert.deepEqual(
    panel.rankings.map((r) => r.id),
    ['pages', 'sources', 'locations', 'devices', 'engagement']
  );
  const pages = panel.rankings.find((r) => r.id === 'pages')!;
  assert.deepEqual(
    pages.views.map((v) => v.id),
    ['top', 'entry', 'exit']
  );
  assert.match(pages.views.find((v) => v.id === 'entry')!.emptyMessage, /not available until the sink deploys/i);
  // Pre-R6.2 payload ⇒ Sources falls back to the single combined dimension.
  const sources = panel.rankings.find((r) => r.id === 'sources')!;
  assert.deepEqual(
    sources.views.map((v) => v.id),
    ['legacy']
  );
});

test('resolveOwnAnalyticsPanel: ready (R6.2 payload) — every new dimension card is populated, object rows are resolved and filterable', () => {
  const overview: OwnAnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    stats: FIXTURE_R62,
    object_directory: DIRECTORY,
  };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: 1200,
    compare: true,
    filters: { country: 'IL' },
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);

  const sources = panel.rankings.find((r) => r.id === 'sources')!;
  assert.deepEqual(
    sources.views.map((v) => v.id),
    ['referrer', 'utm_source', 'utm_medium', 'utm_campaign']
  );
  assert.match(sources.views[0]!.footnote ?? '', /Internal navigation: 40 sessions/);
  assert.equal(sources.views[0]!.filterKey, 'source');

  const locations = panel.rankings.find((r) => r.id === 'locations')!;
  assert.equal(locations.views[0]!.filterKey, 'country');
  assert.deepEqual(
    locations.views[0]!.rows.map((r) => r.value),
    ['IL', 'US']
  );

  const devices = panel.rankings.find((r) => r.id === 'devices')!;
  assert.deepEqual(
    devices.views.map((v) => v.id),
    ['viewport', 'language']
  );

  const engagement = panel.rankings.find((r) => r.id === 'engagement')!;
  assert.deepEqual(
    engagement.views.map((v) => v.id),
    ['funnel', 'scroll_depth']
  );
  assert.equal(engagement.views[0]!.filterKey, 'object_id');
  assert.equal(engagement.views[0]!.rows[0]!.label, 'Skincare 101');

  // filters echoed back for the chip row
  assert.deepEqual(panel.filters, { country: 'IL' });

  // compare on + `previous` present ⇒ real deltas
  assert.ok(panel.kpis.find((k) => k.id === 'pageviews')!.delta);
  assert.deepEqual(panel.chart.previousPoints, [{ t: '2026-08-22', visits: 750, uniques: 250 }]);
});

test('resolveOwnAnalyticsPanel: compare off ⇒ no deltas, no ghost series, even with `previous` present', () => {
  const overview: OwnAnalyticsOverview = { configured: true, enabled: true, range: '7d', stats: FIXTURE_R62 };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.kpis.find((k) => k.id === 'pageviews')!.delta, undefined);
  assert.equal(panel.chart.previousPoints, undefined);
});

test('resolveOwnAnalyticsPanel: capture rate is honestly "Not available" when Netlify has not loaded — never a fabricated number', () => {
  const overview: OwnAnalyticsOverview = { configured: true, enabled: true, range: '7d', stats: FIXTURE };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(panel.footer.find((f) => f.id === 'capture_rate')!.value, 'Not available');
});

test('resolveOwnAnalyticsPanel: a single publishing surface does not get its own ranking card (one fact is not a chart)', () => {
  const overview: OwnAnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    stats: FIXTURE,
    surfaces: [{ surface: 'workflow', objects: 2, pageviews: 500 }],
  };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.equal(
    panel.rankings.some((r) => r.id === 'surfaces'),
    false
  );
});

test('resolveOwnAnalyticsPanel: two+ publishing surfaces add the surfaces ranking card', () => {
  const overview: OwnAnalyticsOverview = {
    configured: true,
    enabled: true,
    range: '7d',
    stats: FIXTURE,
    surfaces: [
      { surface: 'workflow', objects: 2, pageviews: 500 },
      { surface: 'plugin:claude', objects: 1, pageviews: 200 },
    ],
  };
  const panel = resolveOwnAnalyticsPanel({
    loading: false,
    error: null,
    windowResult: OK_WINDOW,
    overview,
    netlifyPageviews: null,
    compare: false,
    filters: {},
  });
  if (panel.kind !== 'ready') throw new Error(`expected ready, got ${panel.kind}`);
  assert.ok(panel.rankings.find((r) => r.id === 'surfaces'));
});
