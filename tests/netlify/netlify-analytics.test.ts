/**
 * T21.2c / R1.4 — fixture-based coverage for the rewritten Netlify Analytics
 * v2 client (`packages/core/server/lib/netlify-analytics.ts`). Each fixture
 * below is the exact response shape diagnosed live against the real API
 * (see that module's doc comment) — this is the first test coverage this
 * module has ever had (it was previously undiagnosable-shape/untested by
 * design; the shape is now pinned).
 *
 * Same stub-by-URL + pinned-env discipline as `deploy-status.test.ts`.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fetchTrafficAnalytics,
  isNetlifyAnalyticsLookupConfigured,
  NetlifyAnalyticsNotEnabledError,
  type NetlifyAnalyticsWindow,
} from '../../packages/core/server/lib/netlify-analytics.js';

const ENV_KEYS = ['NETLIFY_SITE_ID', 'SITE_ID', 'NETLIFY_AUTH_TOKEN', 'NETLIFY_BLOBS_TOKEN'] as const;

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

const SITE_ID = 'site-abc-123';
const TOKEN = 'test-token-should-never-appear-in-logs';
const CONFIGURED = { NETLIFY_SITE_ID: SITE_ID, NETLIFY_AUTH_TOKEN: TOKEN };

const WINDOW: NetlifyAnalyticsWindow = { from: 1_735_689_600_000, to: 1_738_368_000_000, resolution: 'day' };

// Two adjacent day buckets, epoch-ms — mirrors the live tuple-array shape.
const BUCKET_A = 1_735_776_000_000; // 2025-01-02T00:00:00.000Z
const BUCKET_B = 1_735_862_400_000; // 2025-01-03T00:00:00.000Z

test('T21.2c: uses the v2 analytics.services.netlify.com host with SITE_ID (not analytics_instance_id) in the path', async () => {
  await withEnv(CONFIGURED, async () => {
    let sawExpectedHost = false;
    await withFetch(
      (url) => {
        if (url.startsWith(`https://analytics.services.netlify.com/v2/${SITE_ID}/pageviews?`)) {
          sawExpectedHost = true;
          return jsonResponse({ data: [] });
        }
        if (url.includes('/visitors') || url.includes('/ranking/')) return jsonResponse({ data: [] });
        return undefined;
      },
      async () => {
        await fetchTrafficAnalytics(WINDOW);
      }
    );
    assert.ok(sawExpectedHost, 'expected a request to the v2 host at /v2/{SITE_ID}/pageviews');
  });
});

test('T21.2c: pageviews/visitors tuple-array shape is parsed into visits/uniques trend points', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => {
        if (url.includes('/pageviews')) {
          return jsonResponse({
            data: [
              [BUCKET_A, 254],
              [BUCKET_B, 300],
            ],
          });
        }
        if (url.includes('/visitors')) {
          return jsonResponse({
            data: [
              [BUCKET_A, 120],
              [BUCKET_B, 140],
            ],
          });
        }
        if (url.includes('/ranking/')) return jsonResponse({ data: [] });
        return undefined;
      },
      async () => {
        const result = await fetchTrafficAnalytics(WINDOW);
        assert.equal(result.trend.length, 2);
        const byT = new Map(result.trend.map((point) => [point.t, point]));
        assert.deepEqual(byT.get(new Date(BUCKET_A).toISOString()), {
          t: new Date(BUCKET_A).toISOString(),
          visits: 254,
          uniques: 120,
        });
        assert.deepEqual(byT.get(new Date(BUCKET_B).toISOString()), {
          t: new Date(BUCKET_B).toISOString(),
          visits: 300,
          uniques: 140,
        });
      }
    );
  });
});

test('T21.2c: /ranking/pages shape ({count, resource}) maps to topPaths', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => {
        if (url.includes('/pageviews') || url.includes('/visitors')) return jsonResponse({ data: [] });
        if (url.includes('/ranking/pages')) {
          return jsonResponse({ data: [{ count: 254, resource: '/' }, { count: 88, resource: '/about' }] });
        }
        if (url.includes('/ranking/sources')) return jsonResponse({ data: [] });
        return undefined;
      },
      async () => {
        const result = await fetchTrafficAnalytics(WINDOW);
        assert.deepEqual(result.topPaths, [
          { label: '/', visits: 254 },
          { label: '/about', visits: 88 },
        ]);
      }
    );
  });
});

test('T21.2c: /ranking/sources shape maps to topSources, and an empty resource renders as "Direct" (never a blank row)', async () => {
  await withEnv(CONFIGURED, async () => {
    await withFetch(
      (url) => {
        if (url.includes('/pageviews') || url.includes('/visitors')) return jsonResponse({ data: [] });
        if (url.includes('/ranking/pages')) return jsonResponse({ data: [] });
        if (url.includes('/ranking/sources')) {
          return jsonResponse({
            data: [
              { count: 309, resource: '' },
              { count: 42, resource: 'https://google.com/' },
            ],
          });
        }
        return undefined;
      },
      async () => {
        const result = await fetchTrafficAnalytics(WINDOW);
        assert.deepEqual(result.topSources, [
          { label: 'Direct', visits: 309 },
          { label: 'https://google.com/', visits: 42 },
        ]);
      }
    );
  });
});

for (const status of [401, 403, 404] as const) {
  test(`T21.2c: HTTP ${status} on /pageviews still maps to NetlifyAnalyticsNotEnabledError`, async () => {
    await withEnv(CONFIGURED, async () => {
      await withFetch(
        (url) => {
          if (url.includes('/pageviews')) return new Response('', { status });
          return jsonResponse({ data: [] });
        },
        async () => {
          await assert.rejects(() => fetchTrafficAnalytics(WINDOW), NetlifyAnalyticsNotEnabledError);
        }
      );
    });
  });
}

test('T21.2c: the not-enabled log line records status + path and never the token', async () => {
  await withEnv(CONFIGURED, async () => {
    const originalWarn = console.warn;
    const lines: unknown[][] = [];
    console.warn = (...args: unknown[]) => {
      lines.push(args);
    };
    try {
      await withFetch(
        (url) => {
          if (url.includes('/pageviews')) return new Response('', { status: 404 });
          return jsonResponse({ data: [] });
        },
        async () => {
          await assert.rejects(() => fetchTrafficAnalytics(WINDOW), NetlifyAnalyticsNotEnabledError);
        }
      );
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(lines.length, 1);
    const logged = lines[0].join(' ');
    assert.match(logged, /404/);
    assert.match(logged, /pageviews/);
    assert.ok(!logged.includes(TOKEN), 'log line must never include the auth token');
  });
});

test('isNetlifyAnalyticsLookupConfigured stays true/false on the same env vars as deploy lookup (no new env var introduced)', async () => {
  await withEnv({}, async () => {
    assert.equal(isNetlifyAnalyticsLookupConfigured(), false);
  });
  await withEnv(CONFIGURED, async () => {
    assert.equal(isNetlifyAnalyticsLookupConfigured(), true);
  });
});
