/**
 * T13.3 — `tracking_event.v1` + the `/api/t` ingest relay (12-plan §5.2–5.3).
 *
 * Pins: schema validity per event kind; the props sanitizer is an allowlist
 * (never a passthrough); vhash rotates daily and the raw IP is discarded
 * (nothing persisted contains it); a batch drops invalid events
 * individually, never all-or-nothing; foreign Origins are rejected; events
 * mirror to the blob store when the sink is absent or failing (and the
 * mirror is append-only/idempotent); GET ?mode=region answers from the
 * pinned geo accessor.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';

import {
  createTrackIngestHandler,
  readGeo,
  resetSinkConfigCacheForTests,
  resetTokenBucketForTests,
} from '../../netlify/functions/track-ingest.js';
import {
  appendTrackingEvent,
  buildTrackingEvent,
  computeVisitorHashes,
  sanitizeObjectRef,
  sanitizeTrackingProps,
  trackingEventKey,
  resolveSinkConfig,
} from '../../packages/core/server/lib/tracking-events.js';
import {
  clientTrackingEventSchema,
  trackingBatchSchema,
  trackingEventSchema,
} from '../../packages/core/schema/tracking-event-v1.js';

const NOW = Date.parse('2026-07-19T12:00:00.000Z');

const clientEvent = (overrides: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  ts: '2026-07-19T12:00:00.000Z',
  event: 'pageview',
  url: { path: '/learn/library' },
  consent: { analytics: false, ads: false, gpc: false },
  ...overrides,
});

const enrichment = {
  projectId: 'drlurie',
  ua: 'test-agent',
  geo: { country: 'DE', subdivision: 'DE-BE' },
  vhash: 'a'.repeat(64),
  shash: 'b'.repeat(64),
};

// ═══ schema ═══════════════════════════════════════════════════════════════════

test('client schema: valid kinds parse; unknown kinds/extra keys/PII-shaped fields reject', () => {
  assert.ok(clientTrackingEventSchema.safeParse(clientEvent()).success);
  assert.ok(
    clientTrackingEventSchema.safeParse(
      clientEvent({ event: 'scroll_depth', props: { depth_pct: 75 }, object: { object_id: 'page_home' } })
    ).success
  );
  assert.ok(!clientTrackingEventSchema.safeParse(clientEvent({ event: 'keylogger' })).success);
  assert.ok(!clientTrackingEventSchema.safeParse(clientEvent({ email: 'a@b.com' })).success, 'strict envelope');
  assert.ok(!clientTrackingEventSchema.safeParse(clientEvent({ props: { raw_ip: '1.2.3.4' } })).success);
});

test('client schema: first pageview accepts live partial context without referrer but stays strict', () => {
  const liveFirstPageview = clientEvent({
    object: { object_type: 'page', object_id: 'page_home' },
    context: { viewport: { w: 1200, h: 800 }, lang: 'en-US' },
  });
  const parsed = clientTrackingEventSchema.safeParse(liveFirstPageview);
  assert.equal(parsed.success, true);
  assert.equal(parsed.success ? parsed.data.context?.referrer : undefined, undefined);
  assert.ok(
    !clientTrackingEventSchema.safeParse(
      clientEvent({ context: { viewport: { w: 1200, h: 800 }, lang: 'en-US', email: 'a@b.com' } })
    ).success,
    'client context remains strict'
  );
});

test('full schema: the enriched event parses; a client event does NOT (server stamps are required)', () => {
  const full = buildTrackingEvent(clientTrackingEventSchema.parse(clientEvent()), enrichment);
  assert.ok(trackingEventSchema.safeParse(full).success);
  assert.equal(full.project_id, 'drlurie');
  assert.equal(full.context.geo.country, 'DE');
  assert.ok(!trackingEventSchema.safeParse(clientEvent()).success);
  assert.ok(!('city' in (full.context.geo as Record<string, unknown>)), 'city never exists on the stored shape');
});

// ═══ sanitizers ═══════════════════════════════════════════════════════════════

test('props sanitizer is an allowlist per event kind — never a passthrough', () => {
  assert.deepEqual(sanitizeTrackingProps('scroll_depth', { depth_pct: 50, evil: 'x', dwell_ms: 9 }), {
    depth_pct: 50,
  });
  assert.deepEqual(sanitizeTrackingProps('pageview', { depth_pct: 50 }), {}, 'pageview carries NO props');
  assert.deepEqual(sanitizeTrackingProps('goal', { goal: 'opt_in', value_cents: 900, junk: true }), {
    goal: 'opt_in',
    value_cents: 900,
  });
  assert.deepEqual(sanitizeTrackingProps('outbound_click', { href_host: 'example.com' }), {
    href_host: 'example.com',
  });
});

test('object refs are re-validated against the REAL id grammars; bad refs degrade, never drop the event', () => {
  assert.deepEqual(sanitizeObjectRef({ object_type: 'page', object_id: 'page_home' }), {
    object_type: 'page',
    object_id: 'page_home',
  });
  assert.deepEqual(
    sanitizeObjectRef({ object_type: 'page', object_id: 'DROP TABLE' }),
    { object_type: 'page' },
    'an invalid id is nulled out, the typed ref survives'
  );
  assert.equal(sanitizeObjectRef({ object_type: 'nonsense', object_id: 'page_home' })?.object_id, undefined);
  assert.deepEqual(sanitizeObjectRef({ section_id: 's_hero1', node_id: 'n_a1', term_id: 't_abc' }), {
    section_id: 's_hero1',
    node_id: 'n_a1',
    term_id: 't_abc',
  });
});

// ═══ visitor hashes ═══════════════════════════════════════════════════════════

test('vhash rotates daily and the raw IP is discarded (only hashes come back)', () => {
  const base = { salt: 's3cret', ip: '203.0.113.7', ua: 'UA', projectId: 'drlurie', nowMs: NOW };
  const day1 = computeVisitorHashes({ ...base, utcDate: '2026-07-19' });
  const day2 = computeVisitorHashes({ ...base, utcDate: '2026-07-20' });
  assert.notEqual(day1.vhash, day2.vhash, 'daily rotation');
  assert.match(day1.vhash, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(day1).includes('203.0.113.7'), 'no raw IP in the output');

  const sameWindow = computeVisitorHashes({ ...base, utcDate: '2026-07-19', nowMs: NOW + 10 * 60 * 1000 });
  assert.equal(day1.shash, sameWindow.shash, 'same 30-min window → same session');
  const nextWindow = computeVisitorHashes({ ...base, utcDate: '2026-07-19', nowMs: NOW + 31 * 60 * 1000 });
  assert.notEqual(day1.shash, nextWindow.shash, 'window rollover → new session hash');
});

// ═══ the handler ══════════════════════════════════════════════════════════════

const memoryEventsStore = () => {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
  };
};

const failingObjectsStore = async () => {
  throw new Error('no objects store in this test');
};

type HandlerDeps = Parameters<typeof createTrackIngestHandler>[0];

const makeHandler = (deps: HandlerDeps = {}) => {
  resetTokenBucketForTests();
  resetSinkConfigCacheForTests();
  return createTrackIngestHandler({
    getObjectsStore: failingObjectsStore as never,
    nowMs: () => NOW,
    ...deps,
  });
};

const post = (body: unknown, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  headers: {
    host: 'drlurie.com',
    'user-agent': 'test-agent',
    'x-nf-client-connection-ip': '203.0.113.7',
    'x-nf-geo': JSON.stringify({ city: 'Berlin', country: { code: 'DE' }, subdivision: { code: 'BE' } }),
    ...headers,
  },
  body: JSON.stringify(body),
});

const batchOf = (...events: unknown[]) => ({ schema: 'tracking_batch.v1', events });

test('a valid batch 202s; invalid events and /admin paths drop INDIVIDUALLY; response carries the region', async () => {
  const store = memoryEventsStore();
  const handler = makeHandler({ getEventsStore: async () => store, env: { TRACKING_SALT: 's' } });
  const res = await handler(
    post(
      batchOf(
        clientEvent(),
        clientEvent({ event: 'nope' }),
        clientEvent({ url: { path: '/admin/agents' } }),
        clientEvent({ event: 'scroll_depth', props: { depth_pct: 50 } })
      )
    )
  );
  assert.equal(res.statusCode, 202, res.body);
  const body = JSON.parse(res.body) as Record<string, unknown>;
  assert.equal(body.accepted, 2);
  assert.equal(body.dropped, 2);
  assert.equal(body.country, 'DE');
  // Sink absent → mirrored (fallback default); no raw IP anywhere in the mirror.
  assert.equal(store.blobs.size, 2);
  const persisted = [...store.blobs.values()].join('');
  assert.ok(!persisted.includes('203.0.113.7'), 'the raw IP is never persisted');
  assert.ok(!persisted.includes('Berlin'), 'city is dropped at ingest');
});

test('live first pageview payload with viewport/lang and no referrer is accepted by /api/t', async () => {
  const store = memoryEventsStore();
  const handler = makeHandler({ getEventsStore: async () => store, env: { TRACKING_SALT: 's' } });
  const res = await handler(
    post(
      batchOf(
        clientEvent({
          object: { object_type: 'page', object_id: 'page_home' },
          context: { viewport: { w: 1200, h: 800 }, lang: 'en-US' },
        })
      )
    )
  );
  assert.equal(res.statusCode, 202, res.body);
  assert.deepEqual(JSON.parse(res.body), { ok: true, accepted: 1, dropped: 0, country: 'DE' });
  assert.equal(store.blobs.size, 1);
  const persisted = JSON.parse([...store.blobs.values()][0]!) as Record<string, unknown>;
  const context = persisted.context as Record<string, unknown>;
  assert.equal(context.referrer, null);
  assert.deepEqual(context.viewport, { w: 1200, h: 800 });
  assert.equal(context.lang, 'en-US');
  assert.ok(!('email' in context), 'strict client context prevents PII-shaped passthroughs');
});

test('foreign Origin is rejected; same-origin and absent Origin pass', async () => {
  const store = memoryEventsStore();
  const handler = makeHandler({ getEventsStore: async () => store, env: {} });
  const foreign = await handler(post(batchOf(clientEvent()), { origin: 'https://evil.example' }));
  assert.equal(foreign.statusCode, 403);
  const same = await handler(post(batchOf(clientEvent()), { origin: 'https://drlurie.com' }));
  assert.equal(same.statusCode, 202);
});

test('the sink receives NDJSON with Bearer auth; on sink failure events fall back to the mirror', async () => {
  const store = memoryEventsStore();
  const calls: { url: string; auth: string | undefined; body: string }[] = [];
  const okFetch = (async (url: string, init: RequestInit) => {
    calls.push({
      url,
      auth: (init.headers as Record<string, string>).Authorization,
      body: String(init.body),
    });
    return { ok: true } as Response;
  }) as unknown as typeof fetch;

  const handler = makeHandler({
    getEventsStore: async () => store,
    fetchImpl: okFetch,
    env: { TRACKING_SINK_URL: 'https://sink.example/ingest', TRACKING_SINK_TOKEN: 'tok123', TRACKING_SALT: 's' },
  });
  const res = await handler(post(batchOf(clientEvent())));
  assert.equal(res.statusCode, 202);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.auth, 'Bearer tok123');
  assert.ok(calls[0]!.body.endsWith('\n'), 'NDJSON lines');
  assert.ok(calls[0]!.body.includes('"tracking_event.v1"'));
  assert.equal(store.blobs.size, 0, 'sink ok → no mirror under fallback mode');

  const failFetch = (async () => {
    throw new Error('sink down');
  }) as unknown as typeof fetch;
  const failing = makeHandler({
    getEventsStore: async () => store,
    fetchImpl: failFetch,
    env: { TRACKING_SINK_URL: 'https://sink.example/ingest', TRACKING_SALT: 's' },
  });
  const res2 = await failing(post(batchOf(clientEvent())));
  assert.equal(res2.statusCode, 202, 'sink failure never fails the beacon');
  assert.equal(store.blobs.size, 1, 'failed forward → mirrored');
});

test('batch bounds: >25 events and >64KB bodies reject; malformed JSON rejects', async () => {
  const handler = makeHandler({ getEventsStore: async () => memoryEventsStore(), env: {} });
  const tooMany = await handler(post(batchOf(...Array.from({ length: 26 }, () => clientEvent()))));
  assert.equal(tooMany.statusCode, 400);
  assert.ok(!trackingBatchSchema.safeParse(batchOf()).success, 'empty batch is not a batch');
  const huge = await handler({
    httpMethod: 'POST',
    headers: { host: 'x' },
    body: 'x'.repeat(65 * 1024),
  });
  assert.equal(huge.statusCode, 413);
  const junk = await handler({ httpMethod: 'POST', headers: { host: 'x' }, body: 'not json' });
  assert.equal(junk.statusCode, 400);
});

test('GET ?mode=region answers from the pinned geo accessor (header JSON, base64, x-country fallback)', async () => {
  const handler = makeHandler({ getEventsStore: async () => memoryEventsStore(), env: {} });
  const plain = await handler({
    httpMethod: 'GET',
    queryStringParameters: { mode: 'region' },
    headers: { 'x-nf-geo': JSON.stringify({ country: { code: 'fr' } }) },
  });
  assert.deepEqual(JSON.parse(plain.body), { country: 'FR' });

  const b64 = Buffer.from(JSON.stringify({ country: { code: 'US' }, subdivision: { code: 'CA' } })).toString('base64');
  assert.deepEqual(readGeo({ headers: { 'x-nf-geo': b64 } }), { country: 'US', subdivision: 'CA' });
  assert.deepEqual(readGeo({ headers: { 'x-country': 'gb' } }), { country: 'GB', subdivision: null });
  assert.deepEqual(readGeo({ headers: {} }), { country: null, subdivision: null });
});

test('the mirror is append-only and idempotent on event_id (replay-safe)', async () => {
  const store = memoryEventsStore();
  const full = buildTrackingEvent(clientTrackingEventSchema.parse(clientEvent()), enrichment);
  const first = await appendTrackingEvent(store, full);
  assert.equal(first.appended, true);
  const replay = await appendTrackingEvent(store, full);
  assert.equal(replay.appended, false, 'same event never writes twice');
  assert.match(trackingEventKey(full), /^events\/2026-07-19\/\d+-.+\.json$/);
});

test('sink config resolves env NAMES from the own block, with OQ-W13-6 defaults on absence', () => {
  assert.deepEqual(resolveSinkConfig(undefined), {
    endpointEnv: 'TRACKING_SINK_URL',
    authEnv: 'TRACKING_SINK_TOKEN',
    blobMirror: 'fallback',
  });
  assert.deepEqual(resolveSinkConfig({ endpoint_env: 'MY_SINK', auth_env: 'MY_TOKEN', blob_mirror: 'always' }), {
    endpointEnv: 'MY_SINK',
    authEnv: 'MY_TOKEN',
    blobMirror: 'always',
  });
  assert.equal(
    resolveSinkConfig({ endpoint_env: 'https://x' }).endpointEnv,
    'TRACKING_SINK_URL',
    'a URL is not a name'
  );
});
