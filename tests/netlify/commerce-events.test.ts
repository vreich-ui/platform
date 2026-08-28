import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMMERCE_EVENT_SCHEMA_VERSION,
  appendCommerceEvent,
  clientCommerceEventTypes,
  commerceSinkPayload,
  commerceEventKey,
  commerceEventSchema,
  commerceEventTypes,
  hashEmail,
  isClientCommerceEventType,
  newCommerceEvent,
} from '../../packages/core/server/lib/commerce-events.js';

const TS = '2026-07-12T12:00:00.000Z';
const EVENT_ID = '3f1b1509-5ad7-4693-ae44-e25022ab270e';

const sampleEvent = () =>
  newCommerceEvent({
    type: 'checkout_completed',
    event_id: EVENT_ID,
    ts: TS,
    actor: { email_hash: hashEmail('Buyer@Example.com ') },
    subject: { product_id: 'prod_barrier_repair_guide', session_id: 'cs_test_abc', order_id: 'ord_1' },
    context: { path: '/shop/barrier-repair-guide' },
    data: { amount_cents: 1900, currency: 'usd', mode: 'fixed' },
  });

test('commerce_event.v1: a built event carries the full envelope with explicit nulls', () => {
  const event = sampleEvent();
  assert.equal(event.schema, COMMERCE_EVENT_SCHEMA_VERSION);
  assert.equal(event.actor.anon_id, null, 'unset envelope slots are explicit nulls, never absent');
  assert.equal(event.context.referrer, null);
  assert.equal(event.context.ua, null);
  assert.deepEqual(commerceEventSchema.parse(event), event);
});

test('commerce_event.v1 REJECTION: unknown types, malformed hashes, and stray keys fail', () => {
  const event = sampleEvent();
  assert.equal(commerceEventSchema.safeParse({ ...event, type: 'refund_issued' }).success, false);
  assert.equal(
    commerceEventSchema.safeParse({ ...event, actor: { ...event.actor, email_hash: 'buyer@example.com' } }).success,
    false,
    'raw email can never sit in the actor — sha256:<hex> only (§6 PII rule)'
  );
  assert.equal(commerceEventSchema.safeParse({ ...event, buyer_email: 'x@y.z' }).success, false, 'strict envelope');
  assert.equal(commerceEventSchema.safeParse({ ...event, ts: 'yesterday' }).success, false);
});

test('hashEmail normalizes case/whitespace and emits sha256:<hex>', () => {
  const hash = hashEmail('Buyer@Example.com ');
  assert.match(hash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(hash, hashEmail('buyer@example.com'), 'trim + lowercase before hashing');
  assert.notEqual(hash, hashEmail('other@example.com'));
});

test('client-authored allowlist is exactly product_viewed + checkout_started', () => {
  assert.deepEqual([...clientCommerceEventTypes], ['product_viewed', 'checkout_started']);
  for (const type of commerceEventTypes) {
    assert.equal(isClientCommerceEventType(type), type === 'product_viewed' || type === 'checkout_started', type);
  }
});

test('commerceEventKey: date directory from the event ts, digits-only time prefix, filename-safe', () => {
  const key = commerceEventKey({ ts: TS, event_id: EVENT_ID });
  assert.equal(key, `events/2026-07-12/20260712120000000-${EVENT_ID}.json`);
  assert.doesNotMatch(key, /[:.](?!json$)/, 'no colons/dots outside the extension (local FS safety)');

  const later = commerceEventKey({ ts: '2026-07-12T12:00:01.000Z', event_id: EVENT_ID });
  assert.ok(later > key, 'keys time-sort within the day');
});

test('appendCommerceEvent is create-if-absent: replays no-op, events are never overwritten', async () => {
  const blobs = new Map<string, string>();
  const store = {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown, options?: { onlyIfNew?: boolean }) {
      assert.equal(options?.onlyIfNew, true, 'writes must request the atomic create-if-absent path');
      if (blobs.has(key)) return { modified: false };
      blobs.set(key, JSON.stringify(value));
      return { modified: true };
    },
  };

  const event = sampleEvent();
  const first = await appendCommerceEvent(store, event);
  assert.equal(first.appended, true);
  assert.equal(blobs.size, 1);

  const replay = await appendCommerceEvent(store, event);
  assert.equal(replay.appended, false, 'same event replayed must no-op');
  assert.equal(replay.key, first.key);
  assert.equal(blobs.size, 1);

  // A racing writer that wins between the pre-read and the write is also a no-op.
  const racing = {
    async get() {
      return null; // pre-read sees nothing…
    },
    async setJSON() {
      return { modified: false }; // …but the atomic write reports the loss
    },
  };
  const raced = await appendCommerceEvent(racing, sampleEvent());
  assert.equal(raced.appended, false);
});

test('commerceSinkPayload flattens commerce_event.v1 into the kugel-data /commerce contract', () => {
  const event = sampleEvent();
  assert.deepEqual(commerceSinkPayload(event, 'drlurie'), {
    event_id: event.event_id,
    project_id: 'drlurie',
    ts: event.ts,
    kind: 'checkout_completed',
    product_id: 'prod_barrier_repair_guide',
    order_id: 'ord_1',
    session_id: 'cs_test_abc',
    amount_cents: 1900,
    currency: 'usd',
    payload: event,
  });
});

test('a successful commerce append forwards a sink-compatible event once as authenticated NDJSON', async () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const sequence: string[] = [];
  let stored = false;
  let timeoutMs: number | undefined;
  const store = {
    async get() {
      return stored ? '{}' : null;
    },
    async setJSON() {
      sequence.push('append');
      stored = true;
      return { modified: true };
    },
  };
  const fetchImpl: typeof fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    sequence.push('forward');
    calls.push({ input, init });
    return new Response(null, { status: 202 });
  };

  const event = sampleEvent();
  const result = await appendCommerceEvent(store, event, {
    env: {
      TRACKING_PROJECT_ID: 'drlurie',
      TRACKING_SINK_URL: 'https://sink.example/base/',
      TRACKING_SINK_TOKEN: 'test-token',
    },
    fetchImpl,
    timeoutSignal: (delay) => {
      timeoutMs = delay;
      return new AbortController().signal;
    },
  });
  const replay = await appendCommerceEvent(store, event, {
    env: {
      TRACKING_PROJECT_ID: 'drlurie',
      TRACKING_SINK_URL: 'https://sink.example/base/',
      TRACKING_SINK_TOKEN: 'test-token',
    },
    fetchImpl,
  });

  assert.equal(result.appended, true);
  assert.equal(replay.appended, false);
  assert.deepEqual(sequence, ['append', 'forward'], 'forwarding starts only after the blob append succeeds');
  assert.equal(calls.length, 1, 'a replayed event is not forwarded again');
  assert.equal(String(calls[0].input), 'https://sink.example/base/commerce');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, {
    'Content-Type': 'application/x-ndjson',
    Authorization: 'Bearer test-token',
  });
  assert.equal(calls[0].init?.body, `${JSON.stringify(commerceSinkPayload(event, 'drlurie'))}\n`);
  assert.equal(timeoutMs, 2_000, 'the sink request has a two-second timeout');
});

test('commerce sink failure is swallowed after a successful blob append', async () => {
  const result = await appendCommerceEvent(
    {
      async get() {
        return null;
      },
      async setJSON() {
        return { modified: true };
      },
    },
    sampleEvent(),
    {
      env: {
        TRACKING_PROJECT_ID: 'drlurie',
        TRACKING_SINK_URL: 'https://sink.example',
        TRACKING_SINK_TOKEN: 'test-token',
      },
      fetchImpl: async () => {
        throw new Error('sink unavailable');
      },
    }
  );

  assert.equal(result.appended, true, 'sink failure cannot fail the authoritative append');
  await new Promise((resolve) => setImmediate(resolve));
});

test('absent commerce sink env is a no-op', async () => {
  let calls = 0;
  const result = await appendCommerceEvent(
    {
      async get() {
        return null;
      },
      async setJSON() {
        return { modified: true };
      },
    },
    sampleEvent(),
    {
      env: {},
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    }
  );

  assert.equal(result.appended, true);
  assert.equal(calls, 0);
});
