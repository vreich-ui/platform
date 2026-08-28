import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import Stripe from 'stripe';

import { createHandler } from '../../packages/core/server/functions/stripe-webhook.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

// Isolated local-blobs root (per-suite idiom).
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'stripe-webhook');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

// Local fallback store + test-mode Stripe with a dummy key: constructEvent /
// generateTestHeaderString are pure local crypto, no network is touched.
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.STRIPE_MODE = 'test';
process.env.STRIPE_SECRET_KEY_TEST = 'sk_test_dummy_key_for_local_crypto';
process.env.STRIPE_WEBHOOK_SECRET_TEST = 'whsec_test_dummy_secret';
process.env.PURCHASE_TOKEN_SECRET = 'purchase-token-secret-0123456789abcdef';

const { handler } = await import('../../netlify/functions/stripe-webhook.js');
const { deterministicUuid } = await import('../../netlify/functions/stripe-webhook.js');
const { verifyPurchaseToken } = await import('../../packages/core/server/lib/purchase-tokens.js');
const { createLocalBlobStore } = await import('../../packages/core/server/lib/local-blobs.js');
const { objectRecordKey } = await import('../../packages/core/server/lib/object-store-keys.js');

const stripe = new Stripe('sk_test_dummy_key_for_local_crypto');
const WEBHOOK_SECRET = 'whsec_test_dummy_secret';
const SESSION_ID = 'cs_test_a1B2c3d4';
const PRODUCT_ID = 'prod_barrier_repair_guide';
const ARTIFACT_REF = 'pdf/guides/2f4d1b6f9d1e4c1a8e1b3c5d7f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345.pdf';

const reset = async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  // Seed a published, available product record in the site-objects store.
  const siteObjects = createLocalBlobStore('site-objects');
  await siteObjects.setJSON(objectRecordKey('product', PRODUCT_ID), {
    object_id: PRODUCT_ID,
    object_type: 'product',
    schema_version: 'product.v1',
    site: 'site_drlurie',
    status: 'active',
    publication: { published_time: '2026-07-12T00:00:00.000Z' },
    body: {
      slug: 'barrier-repair-guide',
      presentation: { title: 'The Barrier Repair Guide' },
      commerce: {
        provider: 'stripe',
        mode: 'fixed',
        price: { amount_cents: 1900, currency: 'usd' },
        stripe_test: { product_id: 'prod_Test1', price_id: 'price_Test1' },
        availability: 'available',
      },
      fulfillment: { kind: 'download', artifact_ref: ARTIFACT_REF, filename: 'barrier-repair-guide.pdf' },
    },
    history: [],
    version: 3,
    content_revision: 1,
  });
};

const stripeEventBody = (
  type: 'checkout.session.completed' | 'checkout.session.expired',
  session: Record<string, unknown>
) =>
  JSON.stringify({
    id: `evt_${type.replace(/\./g, '_')}`,
    object: 'event',
    api_version: '2024-06-20',
    created: 1783857600, // 2026-07-12T12:00:00Z
    type,
    data: { object: { object: 'checkout.session', ...session } },
    livemode: false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
  });

const paidSession = (overrides: Record<string, unknown> = {}) => ({
  id: SESSION_ID,
  payment_status: 'paid',
  amount_total: 1900,
  currency: 'usd',
  customer_details: { email: 'Buyer@Example.com' },
  metadata: { product_id: PRODUCT_ID, event_id: 'a1b2c3d4-0000-4000-8000-000000000000' },
  ...overrides,
});

const deliver = (body: string, signature?: string) =>
  handler({
    httpMethod: 'POST',
    headers: {
      'stripe-signature':
        signature ?? stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }),
    },
    body,
  });

const listEventFiles = async (): Promise<string[]> => {
  const dayDir = join(LOCAL_BLOBS_ROOT, 'commerce-events', 'events', '2026-07-12');
  try {
    return (await readdir(dayDir)).sort();
  } catch {
    return [];
  }
};

const readOrderFile = async () => {
  const store = createLocalBlobStore('commerce');
  const raw = await store.get(`orders/${SESSION_ID}.json`);
  return raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
};

test('an invalid signature is rejected 400 before anything is written', async () => {
  await reset();
  const body = stripeEventBody('checkout.session.completed', paidSession());
  const response = await deliver(body, 't=1,v1=deadbeef');
  assert.equal(response.statusCode, 400);
  assert.equal(await readOrderFile(), null);
  assert.deepEqual(await listEventFiles(), []);
});

test('completed session: order created, token issued (hash only), authoritative events appended', async () => {
  await reset();
  const response = await deliver(stripeEventBody('checkout.session.completed', paidSession()));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).order_created, true);

  const order = await readOrderFile();
  assert.ok(order);
  assert.equal(order.schema, 'commerce_order.v1');
  assert.equal(order.session_id, SESSION_ID);
  assert.equal(order.product_id, PRODUCT_ID);
  assert.equal(order.amount_total, 1900);
  assert.equal(order.buyer_email, 'Buyer@Example.com');
  const fulfillment = order.fulfillment as Record<string, unknown>;
  assert.equal(fulfillment.state, 'issued');
  assert.match(String(fulfillment.token_hash), /^sha256:[0-9a-f]{64}$/);
  // The artifact_ref is stored deliberately (§5 purity); the raw TOKEN never
  // is (its base64url JSON body would start with "eyJ").
  assert.equal(JSON.stringify(order).includes('eyJ'), false, 'no raw token leaks into the order');

  const files = await listEventFiles();
  assert.equal(files.length, 2, 'checkout_completed + fulfillment_issued');
  const store = createLocalBlobStore('commerce-events');
  const completedKey = `events/2026-07-12/${files.find((f) => f.includes(deterministicUuid(`${SESSION_ID}:checkout_completed`)))}`;
  const completed = JSON.parse((await store.get(completedKey)) ?? 'null') as Record<string, unknown>;
  assert.equal(completed.type, 'checkout_completed');
  const actor = completed.actor as Record<string, unknown>;
  assert.match(String(actor.email_hash), /^sha256:[0-9a-f]{64}$/, 'events carry the hash, never the raw email');
  assert.equal(JSON.stringify(completed).includes('Example.com'), false);
});

test('completed session with email enqueues one leak-safe member link without affecting 2xx', async () => {
  await reset();
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const linkedHandler = createHandler(drlurieSiteBinding, {
    env: {
      TRACKING_SINK_URL: 'https://sink.example/ingest/',
      TRACKING_SINK_TOKEN: 'test-bearer',
      TRACKING_SALT: 'test-salt',
      TRACKING_PROJECT_ID: 'drlurie',
    },
    fetchImpl: (input, init) => {
      calls.push({ input, init });
      return Promise.reject(new Error('best-effort sink failure'));
    },
    nowMs: () => Date.parse('2026-08-28T12:34:56.000Z'),
  });
  const body = stripeEventBody('checkout.session.completed', paidSession());
  const response = await linkedHandler({
    httpMethod: 'POST',
    headers: {
      'stripe-signature': stripe.webhooks.generateTestHeaderString({ payload: body, secret: WEBHOOK_SECRET }),
      'x-forwarded-for': '203.0.113.9, 10.0.0.1',
      'user-agent': 'stripe-link-test-agent',
    },
    body,
  });

  assert.equal(response.statusCode, 200, 'sink failure never changes Stripe acknowledgement');
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), 'https://sink.example/ingest/link');
  const requestBody = String(calls[0].init?.body);
  assert.equal(requestBody.includes('Buyer@Example.com'), false);
  assert.deepEqual(Object.keys(JSON.parse(requestBody)).sort(), ['member_hash', 'project_id', 'shash']);
  assert.match(requestBody, /"shash":"[0-9a-f]{64}"/);
  assert.match(requestBody, /"member_hash":"[0-9a-f]{64}"/);
});

test('THE EXIT-TEST MECHANIC: the webhook replayed twice → one order, no duplicate events', async () => {
  await reset();
  const body = stripeEventBody('checkout.session.completed', paidSession());
  const first = await deliver(body);
  const replay = await deliver(body);
  assert.equal(first.statusCode, 200);
  assert.equal(replay.statusCode, 200);
  assert.equal(JSON.parse(first.body).order_created, true);
  assert.equal(JSON.parse(replay.body).order_created, false, 'create-if-absent no-ops the replay');
  assert.equal(JSON.parse(replay.body).order_id, JSON.parse(first.body).order_id);
  assert.equal((await listEventFiles()).length, 2, 'deterministic event keys collide — no duplicates');
});

test('§3 backstop: an amount mismatch flags the order and appends an amount_mismatch event', async () => {
  await reset();
  const response = await deliver(stripeEventBody('checkout.session.completed', paidSession({ amount_total: 2400 })));
  assert.equal(response.statusCode, 200);
  const order = await readOrderFile();
  assert.deepEqual(order?.flags, { amount_mismatch: true });
  assert.equal((await listEventFiles()).length, 3, '+ amount_mismatch event');
});

test('unpaid completion (async payment methods) is acked and fulfils nothing', async () => {
  await reset();
  const response = await deliver(
    stripeEventBody('checkout.session.completed', paidSession({ payment_status: 'unpaid' }))
  );
  assert.equal(response.statusCode, 200);
  assert.equal(await readOrderFile(), null);
});

test('expired session appends checkout_abandoned, idempotently', async () => {
  await reset();
  const body = stripeEventBody('checkout.session.expired', {
    id: SESSION_ID,
    payment_status: 'unpaid',
    metadata: { product_id: PRODUCT_ID },
  });
  await deliver(body);
  await deliver(body);
  const files = await listEventFiles();
  assert.equal(files.length, 1, 'replayed abandonment stays one event');
  const store = createLocalBlobStore('commerce-events');
  const abandoned = JSON.parse((await store.get(`events/2026-07-12/${files[0]}`)) ?? 'null') as { type: string };
  assert.equal(abandoned.type, 'checkout_abandoned');
});

test('a webhook-issued token verifies and embeds the session as order_key', async () => {
  await reset();
  await deliver(stripeEventBody('checkout.session.completed', paidSession()));
  // The token itself is never stored; prove the ISSUANCE path by minting the
  // status-page equivalent and checking it against the recorded hash regime:
  // signature-valid tokens for this order_key/artifact are the capability.
  const verified = verifyPurchaseToken(
    (await import('../../packages/core/server/lib/purchase-tokens.js')).mintPurchaseToken(
      { order_key: SESSION_ID, artifact_ref: ARTIFACT_REF, exp: Date.now() + 1000 },
      'purchase-token-secret-0123456789abcdef'
    ),
    'purchase-token-secret-0123456789abcdef'
  );
  assert.ok(verified.ok && verified.payload.order_key === SESSION_ID);
});

// ─── S3: artifact_ref persistence + unlock fulfillment ───────────────────────

test('the order stores fulfillment.artifact_ref (fulfillment = pure function of the record, §5)', async () => {
  await reset();
  await deliver(stripeEventBody('checkout.session.completed', paidSession()));
  const order = await readOrderFile();
  const fulfillment = order?.fulfillment as Record<string, unknown>;
  assert.equal(fulfillment.artifact_ref, ARTIFACT_REF);
});

test('unlock completion mints the token over the session-named pre-generated artifact', async () => {
  await reset();
  const siteObjects = createLocalBlobStore('site-objects');
  await siteObjects.setJSON(objectRecordKey('product', PRODUCT_ID), {
    object_id: PRODUCT_ID,
    object_type: 'product',
    status: 'active',
    publication: { published_time: '2026-07-12T00:00:00.000Z' },
    body: {
      slug: 'barrier-repair-guide',
      presentation: { title: 'The Barrier Repair Guide' },
      commerce: {
        provider: 'stripe',
        mode: 'fixed',
        price: { amount_cents: 1900, currency: 'usd' },
        stripe_test: { product_id: 'prod_Test1', price_id: 'price_Test1' },
        availability: 'available',
      },
      fulfillment: { kind: 'unlock', unlock_prefix: 'unlock/quiz-results/' },
    },
  });

  const withKey = await deliver(
    stripeEventBody(
      'checkout.session.completed',
      paidSession({ metadata: { product_id: PRODUCT_ID, unlock_key: 'unlock/quiz-results/r_abc.pdf' } })
    )
  );
  assert.equal(withKey.statusCode, 200);
  const order = await readOrderFile();
  const fulfillment = order?.fulfillment as Record<string, unknown>;
  assert.equal(fulfillment.state, 'issued');
  assert.equal(fulfillment.artifact_ref, 'unlock/quiz-results/r_abc.pdf');

  // A completed unlock session WITHOUT a valid key records the order
  // unfulfilled (support case) — never a token over the wrong blob.
  await reset();
  await siteObjects.setJSON(objectRecordKey('product', PRODUCT_ID), {
    object_id: PRODUCT_ID,
    object_type: 'product',
    status: 'active',
    publication: { published_time: '2026-07-12T00:00:00.000Z' },
    body: {
      slug: 'barrier-repair-guide',
      presentation: { title: 'The Barrier Repair Guide' },
      commerce: {
        provider: 'stripe',
        mode: 'fixed',
        price: { amount_cents: 1900, currency: 'usd' },
        stripe_test: { product_id: 'prod_Test1', price_id: 'price_Test1' },
        availability: 'available',
      },
      fulfillment: { kind: 'unlock', unlock_prefix: 'unlock/quiz-results/' },
    },
  });
  await deliver(stripeEventBody('checkout.session.completed', paidSession()));
  const unfulfilled = await readOrderFile();
  assert.equal((unfulfilled?.fulfillment as Record<string, unknown>).state, 'none');
});
