import assert from 'node:assert/strict';
import test from 'node:test';

import { fetchOwnTrackerRawExport, type OwnTrackerExportOptions } from './own-tracker-stats.js';

const baseOptions: Omit<OwnTrackerExportOptions, 'fetchImpl'> = {
  kind: 'events',
  from: '2026-08-01T00:00:00.000Z',
  to: '2026-08-31T23:59:59.999Z',
};

test('fetchOwnTrackerRawExport degrades to a named "not configured" state when env is absent — never throws', async () => {
  const result = await fetchOwnTrackerRawExport({
    ...baseOptions,
    env: {},
    fetchImpl: () => {
      throw new Error('must not fetch when unconfigured');
    },
  });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.errorCode, 'own_tracker_unconfigured');
});

test('fetchOwnTrackerRawExport attaches the Bearer token server-side, and it never appears in the returned result', async () => {
  let capturedAuth: string | null = null;
  const result = await fetchOwnTrackerRawExport({
    ...baseOptions,
    env: {
      TRACKING_SINK_URL: 'https://sink.example.test',
      TRACKING_PROJECT_ID: 'proj_1',
      TRACKING_SINK_TOKEN: 'super-secret-token-value',
    },
    fetchImpl: (async (_url: string, init?: RequestInit) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization ?? null;
      return new Response('{"a":1}\n{"a":2}\n', { status: 200 });
    }) as typeof fetch,
  });

  assert.equal(capturedAuth, 'Bearer super-secret-token-value', 'the sink request itself must carry the Bearer');
  assert.equal(result.available, true);
  if (result.available) {
    assert.equal(result.ndjson, '{"a":1}\n{"a":2}\n');
    // The Bearer token must not be embedded anywhere in what the caller returns to the browser.
    assert.ok(!JSON.stringify(result).includes('super-secret-token-value'));
  }
});

test('fetchOwnTrackerRawExport on a 404 (the endpoint not deployed yet) degrades to raw_export_not_available, not a throw', async () => {
  const result = await fetchOwnTrackerRawExport({
    ...baseOptions,
    env: { TRACKING_SINK_URL: 'https://sink.example.test', TRACKING_PROJECT_ID: 'proj_1' },
    fetchImpl: (async () => new Response('not found', { status: 404 })) as typeof fetch,
  });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.errorCode, 'raw_export_not_available');
    assert.equal(result.status, 404);
  }
});

test('fetchOwnTrackerRawExport on any other non-2xx degrades to raw_export_failed with the status', async () => {
  const result = await fetchOwnTrackerRawExport({
    ...baseOptions,
    env: { TRACKING_SINK_URL: 'https://sink.example.test', TRACKING_PROJECT_ID: 'proj_1' },
    fetchImpl: (async () => new Response('boom', { status: 500 })) as typeof fetch,
  });
  assert.equal(result.available, false);
  if (!result.available) {
    assert.equal(result.errorCode, 'raw_export_failed');
    assert.equal(result.status, 500);
  }
});

test('fetchOwnTrackerRawExport on a network failure degrades to raw_export_unreachable', async () => {
  const result = await fetchOwnTrackerRawExport({
    ...baseOptions,
    env: { TRACKING_SINK_URL: 'https://sink.example.test', TRACKING_PROJECT_ID: 'proj_1' },
    fetchImpl: (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch,
  });
  assert.equal(result.available, false);
  if (!result.available) assert.equal(result.errorCode, 'raw_export_unreachable');
});

test('fetchOwnTrackerRawExport requests the exact contract endpoint/params, kind included', async () => {
  let capturedUrl: string | null = null;
  await fetchOwnTrackerRawExport({
    ...baseOptions,
    kind: 'commerce',
    env: { TRACKING_SINK_URL: 'https://sink.example.test/', TRACKING_PROJECT_ID: 'proj_9' },
    fetchImpl: (async (url: string) => {
      capturedUrl = url;
      return new Response('', { status: 200 });
    }) as typeof fetch,
  });
  assert.ok(capturedUrl);
  const parsed = new URL(capturedUrl!);
  // S-22: TRACKING_SINK_URL is already the full `.../api/tracking-sink` relay URL, so the
  // export request appends only `/export` — the same convention every other sink reader
  // (stats, weights) uses against this env var.
  assert.equal(parsed.origin + parsed.pathname, 'https://sink.example.test/export');
  assert.equal(parsed.searchParams.get('project_id'), 'proj_9');
  assert.equal(parsed.searchParams.get('kind'), 'commerce');
  assert.equal(parsed.searchParams.get('from'), baseOptions.from);
  assert.equal(parsed.searchParams.get('to'), baseOptions.to);
});
