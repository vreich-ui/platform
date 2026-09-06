/**
 * R12.3 / T21.20 — coverage for the tenant-analytics tools:
 * `analytics_summary`, `analytics_top_content`, `analytics_object`.
 *
 * Same stub-by-fetch + pinned-env discipline as `netlify-analytics.test.ts`
 * and `deploy-status.test.ts`. Site policy bindings are registered first
 * (mcp.ts and its neighbours resolve site identity / the object store at
 * import/call time) — same convention as `mcp-tool-handlers.test.ts`.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
// Import mcp.ts before mcp-analytics-handlers.js — the same real, normally-
// safe circular import mcp-tool-handlers.ts documents, kept one-directional
// in test files by always importing the mcp.ts side first.
import '../functions/mcp.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { callAnalyticsSummary, callAnalyticsTopContent, callAnalyticsObject } from './mcp-analytics-handlers.js';
import type { OwnTrackerStatsPayload } from '../../lib/admin/own-analytics-logic.js';
import type { LambdaEvent } from '../functions/mcp.js';

const ENV_KEYS = ['TRACKING_SINK_URL', 'TRACKING_PROJECT_ID', 'TRACKING_SINK_TOKEN'] as const;
const SECRET_TOKEN = 'trk-secret-should-never-leave-the-server-abc123';

const withEnv = async (overrides: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) => {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(overrides)) process.env[key] = value;
  try {
    await fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

type FetchRoute = (url: string) => Response | undefined;

const withFetch = async (route: FetchRoute, fn: () => Promise<void>) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const response = route(url);
    if (!response) throw new Error(`unexpected fetch: ${url}`);
    return response;
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
};

const jsonResponse = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

const CONFIGURED = { TRACKING_SINK_URL: 'https://sink.example.invalid', TRACKING_PROJECT_ID: 'site_drlurie' };
const CONFIGURED_WITH_TOKEN = { ...CONFIGURED, TRACKING_SINK_TOKEN: SECRET_TOKEN };

const FIXTURE_STATS: OwnTrackerStatsPayload = {
  project_id: 'site_drlurie',
  days: 7,
  totals: {
    events_by_kind: { pageview: 120 },
    sessions: 40,
    visitors: 30,
    consented_sessions: 10,
    commerce_events: 2,
    member_links: 0,
  },
  daily: [
    { date: '2026-09-01', pageviews: 60, sessions: 20, visitors: 15, buy_clicks: 1, purchases: 1 },
    { date: '2026-09-02', pageviews: 60, sessions: 20, visitors: 15, buy_clicks: 1, purchases: 1 },
  ],
  top_objects: [
    { object_id: 'page_home', object_type: 'page', pageviews: 100, sessions: 30, completion_rate: 0.4 },
    {
      object_id: 'content_item_sunscreen',
      object_type: 'content_item',
      pageviews: 20,
      sessions: 10,
      completion_rate: 0.9,
    },
  ],
  top_sources: [{ referrer_host_or_utm_source: 'google.com', sessions: 25 }],
  last_event_at: '2026-09-02T10:00:00.000Z',
};

const EMPTY_EVENT = {} as unknown as LambdaEvent;

// ─── sink-not-configured path ────────────────────────────────────────────────

test('all three tools degrade honestly (never crash, never a fabricated zero) when the sink is not configured', async () => {
  await withEnv({}, async () => {
    for (const call of [
      () => callAnalyticsSummary(EMPTY_EVENT, {}),
      () => callAnalyticsTopContent(EMPTY_EVENT, {}),
      () => callAnalyticsObject(EMPTY_EVENT, { object_id: 'page_home' }),
    ]) {
      const result = await call();
      const body = result.structuredContent as Record<string, unknown>;
      assert.equal(body.configured, false);
      assert.equal(body.error_code, 'analytics_not_configured');
      assert.ok(typeof body.message === 'string' && body.message.length > 0);
    }
  });
});

// ─── analytics_summary happy path ────────────────────────────────────────────

test('analytics_summary: happy path against a fixture sink response, deltas honestly omitted', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const result = await callAnalyticsSummary(EMPTY_EVENT, { range: '7d' });
        const body = result.structuredContent as Record<string, unknown>;
        assert.equal(body.configured, true);
        assert.equal(body.range, '7d');
        assert.equal(body.pageviews, 120);
        assert.equal(body.sessions, 40);
        assert.equal(body.visitors, 30);
        assert.equal(body.consented_share_pct, 25); // 10/40
        assert.equal(body.purchases, 2);
        assert.equal(body.last_event_at, '2026-09-02T10:00:00.000Z');
        // The sink does not serve a previous-period window yet — this must
        // stay an honest omission, never an invented delta.
        assert.equal(body.deltas, null);
        assert.ok(Array.isArray(body.degraded_fields) && body.degraded_fields.includes('deltas_vs_previous_period'));
      }
    );
  });
});

test('analytics_summary: a sink failure comes back as a tool error, not a thrown exception', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      () => new Response('boom', { status: 500 }),
      async () => {
        const result = await callAnalyticsSummary(EMPTY_EVENT, {});
        assert.equal((result as { isError?: boolean }).isError, true);
      }
    );
  });
});

// ─── analytics_top_content: happy path, sort, limit cap ─────────────────────

test('analytics_top_content: happy path ranks by pageviews and reports the honest funnel', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const result = await callAnalyticsTopContent(EMPTY_EVENT, { range: '7d' });
        const body = result.structuredContent as Record<string, unknown>;
        assert.equal(body.configured, true);
        assert.equal(body.sort, 'pageviews');
        assert.ok(!('sort_degraded' in body));
        const items = body.items as Array<Record<string, unknown>>;
        assert.equal(items.length, 2);
        assert.equal(items[0]!.object_id, 'page_home'); // 100 pageviews > 20
        assert.equal((items[0]!.funnel as Record<string, unknown>).pageview, 100);
        assert.equal((items[0]!.funnel as Record<string, unknown>).completion_rate, 0.4);
        // producer is honestly "unknown" here — no matching record exists in
        // this test's (empty) object store, and the tool must say so rather
        // than guessing "workflow".
        assert.equal(items[0]!.producer, 'unknown');
        assert.deepEqual(body.funnel_fields_unavailable, ['read_progress', 'cta_click', 'cta_ctr', 'buy_click']);
      }
    );
  });
});

test('analytics_top_content: completion_rate sort re-ranks; cta_ctr degrades to pageviews honestly', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const byCompletion = await callAnalyticsTopContent(EMPTY_EVENT, { range: '7d', sort: 'completion_rate' });
        const completionBody = byCompletion.structuredContent as Record<string, unknown>;
        const completionItems = completionBody.items as Array<Record<string, unknown>>;
        assert.equal(completionItems[0]!.object_id, 'content_item_sunscreen'); // 0.9 > 0.4

        const byCta = await callAnalyticsTopContent(EMPTY_EVENT, { range: '7d', sort: 'cta_ctr' });
        const ctaBody = byCta.structuredContent as Record<string, unknown>;
        assert.equal(ctaBody.sort, 'cta_ctr');
        assert.equal(ctaBody.sort_degraded, true);
        assert.ok(typeof ctaBody.sort_degraded_reason === 'string' && ctaBody.sort_degraded_reason.length > 0);
        const ctaItems = ctaBody.items as Array<Record<string, unknown>>;
        assert.equal(ctaItems[0]!.object_id, 'page_home'); // fell back to pageviews ranking
      }
    );
  });
});

test('analytics_top_content: limit is capped at 20 even when a caller asks for more', async () => {
  const manyTopObjects = Array.from({ length: 30 }, (_, i) => ({
    object_id: `obj_${i}`,
    object_type: 'content_item',
    pageviews: 30 - i,
    sessions: 1,
    completion_rate: 0.1,
  }));
  const bigFixture: OwnTrackerStatsPayload = { ...FIXTURE_STATS, top_objects: manyTopObjects };

  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(bigFixture) : undefined),
      async () => {
        const overLimit = await callAnalyticsTopContent(EMPTY_EVENT, { range: '7d', limit: 999 });
        const overBody = overLimit.structuredContent as Record<string, unknown>;
        assert.equal(overBody.limit, 20);
        assert.equal((overBody.items as unknown[]).length, 20);

        const defaultLimit = await callAnalyticsTopContent(EMPTY_EVENT, { range: '7d' });
        const defaultBody = defaultLimit.structuredContent as Record<string, unknown>;
        assert.equal(defaultBody.limit, 10);
        assert.equal((defaultBody.items as unknown[]).length, 10);
      }
    );
  });
});

// ─── analytics_object ─────────────────────────────────────────────────────────

test('analytics_object: happy path reports the sink funnel and honestly-null sources/producer for an unknown record', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const result = await callAnalyticsObject(EMPTY_EVENT, { object_id: 'page_home', range: '7d' });
        const body = result.structuredContent as Record<string, unknown>;
        assert.equal(body.configured, true);
        assert.equal(body.found_in_analytics, true);
        assert.deepEqual(body.funnel, { pageview: 100, sessions: 30, completion_rate: 0.4 });
        assert.equal(body.sources, null);
        assert.ok(typeof body.sources_unavailable_reason === 'string');
        // No matching object record exists in this test's object store.
        assert.equal(body.producer, null);
        assert.equal(body.prompt_version, null);
        assert.equal(body.found_in_object_store, false);
        assert.deepEqual(body.variants, []);
      }
    );
  });
});

test('analytics_object: requires object_id', async () => {
  await withEnv(CONFIGURED, async () => {
    const result = await callAnalyticsObject(EMPTY_EVENT, {});
    assert.equal((result as { isError?: boolean }).isError, true);
  });
});

test('analytics_object: an id unknown to both the sink and the object store is a clear not-found', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const result = await callAnalyticsObject(EMPTY_EVENT, { object_id: 'not_a_real_object' });
        assert.equal((result as { isError?: boolean }).isError, true);
        const body = result.structuredContent as Record<string, unknown>;
        assert.equal(body.error_code, 'object_not_found');
      }
    );
  });
});

// ─── the token must never leave the server ──────────────────────────────────

test('TRACKING_SINK_TOKEN never appears in any tool result, across all three tools', async () => {
  await withEnv(CONFIGURED_WITH_TOKEN, async () => {
    await withFetch(
      (url) => (url.includes('/stats') ? jsonResponse(FIXTURE_STATS) : undefined),
      async () => {
        const results = await Promise.all([
          callAnalyticsSummary(EMPTY_EVENT, {}),
          callAnalyticsTopContent(EMPTY_EVENT, {}),
          callAnalyticsObject(EMPTY_EVENT, { object_id: 'page_home' }),
        ]);
        for (const result of results) {
          const serialized = JSON.stringify(result);
          assert.ok(!serialized.includes(SECRET_TOKEN), `a tool result leaked the sink token: ${serialized}`);
        }
      }
    );
  });
});
