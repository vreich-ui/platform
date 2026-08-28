import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { setLocalBlobsRootForTesting, createLocalBlobStore } from '../../packages/core/server/lib/local-blobs.js';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'checkout-session');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'TRACKING_PROJECT_ID',
  'TRACKING_SALT',
  'TRACKING_SINK_TOKEN',
  'TRACKING_SINK_URL',
]) {
  delete process.env[key];
}
process.env.STRIPE_MODE = 'test';
process.env.PURCHASE_TOKEN_SECRET = 'purchase-token-secret-0123456789abcdef';
process.env.URL = 'https://drluriescience.netlify.app';

const { handler: createSession } = await import('../../netlify/functions/create-checkout-session.js');
const { handler: sessionStatus } = await import('../../netlify/functions/checkout-session-status.js');
const { createHandler: createCheckoutHandler } = await import(
  '../../packages/core/server/functions/create-checkout-session.js'
);
const { computeVisitorHashes } = await import('../../packages/core/server/lib/tracking-events.js');
const { setStripeClientForTesting, resetStripeClientForTesting, stripeMode, stripeSecretKey, stripeLinkageForMode } =
  await import('../../packages/core/server/lib/stripe-env.js');
const { objectRecordKey } = await import('../../packages/core/server/lib/object-store-keys.js');
const { drlurieSiteBinding } = await import('../../sites/drlurie/config/site-binding.js');

const SESSION_ID = 'cs_test_a1B2c3d4';
const PRODUCT_ID = 'prod_barrier_repair_guide';
const ARTIFACT_REF = 'pdf/guides/2f4d1b6f9d1e4c1a8e1b3c5d7f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345.pdf';

const seedProduct = async (commerceOverrides: Record<string, unknown> = {}) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  await createLocalBlobStore('site-objects').setJSON(objectRecordKey('product', PRODUCT_ID), {
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
        ...commerceOverrides,
      },
      fulfillment: { kind: 'download', artifact_ref: ARTIFACT_REF, filename: 'barrier-repair-guide.pdf' },
    },
  });
};

// ─── stripe-env selection rules (§8.7) ───────────────────────────────────────

test('STRIPE_MODE defaults to test — a missing flag must never charge real cards', () => {
  assert.equal(stripeMode({}), 'test');
  assert.equal(stripeMode({ STRIPE_MODE: 'live' }), 'live');
  assert.equal(stripeMode({ STRIPE_MODE: 'LIVE ' }), 'live');
  assert.equal(stripeMode({ STRIPE_MODE: 'production' }), 'test');
});

test('key + linkage selection follows the mode', () => {
  const env = {
    STRIPE_SECRET_KEY: 'sk_live_x',
    STRIPE_SECRET_KEY_TEST: 'sk_test_x',
  } as NodeJS.ProcessEnv;
  assert.equal(stripeSecretKey({ ...env, STRIPE_MODE: 'live' }), 'sk_live_x');
  assert.equal(stripeSecretKey({ ...env }), 'sk_test_x');

  const commerce = {
    stripe: { product_id: 'prod_L', price_id: 'price_L' },
    stripe_test: { product_id: 'prod_T', price_id: 'price_T' },
  };
  assert.equal(stripeLinkageForMode(commerce, { STRIPE_MODE: 'live' } as NodeJS.ProcessEnv)?.price_id, 'price_L');
  assert.equal(stripeLinkageForMode(commerce, {} as NodeJS.ProcessEnv)?.price_id, 'price_T');
});

// ─── create-checkout-session ─────────────────────────────────────────────────

type CreateParams = {
  mode: string;
  line_items: Array<{ price: string; quantity: number }>;
  success_url: string;
  cancel_url: string;
  metadata: Record<string, string>;
};

const withFakeStripe = async <T>(fake: unknown, run: () => Promise<T>): Promise<T> => {
  setStripeClientForTesting(fake);
  try {
    return await run();
  } finally {
    resetStripeClientForTesting();
  }
};

const post = (body: unknown) => createSession({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });

test('create-checkout-session charges the LINKED price and stamps metadata (§3/§5)', async () => {
  await seedProduct();
  let received: CreateParams | undefined;
  const fake = {
    checkout: {
      sessions: {
        create: async (params: CreateParams) => {
          received = params;
          return { id: SESSION_ID, url: 'https://checkout.stripe.com/c/pay/x' };
        },
      },
    },
  };
  const response = await withFakeStripe(fake, () => post({ product_id: PRODUCT_ID }));
  assert.equal(response.statusCode, 200);
  const body = JSON.parse(response.body) as { url: string; session_id: string; event_id: string };
  assert.equal(body.url, 'https://checkout.stripe.com/c/pay/x');
  assert.equal(body.session_id, SESSION_ID);

  assert.ok(received);
  assert.equal(received.mode, 'payment');
  assert.deepEqual(received.line_items, [{ price: 'price_Test1', quantity: 1 }], 'charges price_id, never the cache');
  assert.equal(received.metadata.product_id, PRODUCT_ID);
  assert.equal(received.metadata.event_id, body.event_id);
  assert.equal(received.metadata.visitor_shash, undefined, 'visitor hash metadata is present only with tracking env');
  assert.equal(
    received.success_url,
    'https://drluriescience.netlify.app/shop/thank-you?session_id={CHECKOUT_SESSION_ID}'
  );
  assert.equal(received.cancel_url, 'https://drluriescience.netlify.app/shop/barrier-repair-guide');
});

test('create-checkout-session stamps the browser visitor shash for the later Stripe webhook link', async () => {
  await seedProduct();
  const nowMs = Date.parse('2026-08-28T12:34:56.000Z');
  let received: CreateParams | undefined;
  const fake = {
    checkout: {
      sessions: {
        create: async (params: CreateParams) => {
          received = params;
          return { id: SESSION_ID, url: 'https://checkout.stripe.com/c/pay/x' };
        },
      },
    },
  };
  const linkedCreateSession = createCheckoutHandler(drlurieSiteBinding, {
    env: {
      TRACKING_SALT: 'test-salt',
      TRACKING_PROJECT_ID: 'drlurie',
    },
    nowMs: () => nowMs,
  });

  const response = await withFakeStripe(fake, () =>
    linkedCreateSession({
      httpMethod: 'POST',
      headers: {
        'x-forwarded-for': '198.51.100.7, 10.0.0.1',
        'user-agent': 'checkout-browser-agent',
      },
      body: JSON.stringify({ product_id: PRODUCT_ID }),
    })
  );

  assert.equal(response.statusCode, 200);
  assert.ok(received);
  const expected = computeVisitorHashes({
    salt: 'test-salt',
    utcDate: '2026-08-28',
    ip: '198.51.100.7',
    ua: 'checkout-browser-agent',
    projectId: 'drlurie',
    nowMs,
  }).shash;
  assert.deepEqual(Object.keys(received.metadata).sort(), ['event_id', 'product_id', 'visitor_shash']);
  assert.equal(received.metadata.visitor_shash, expected);
  assert.equal(JSON.stringify(received.metadata).includes('198.51.100.7'), false);
  assert.equal(JSON.stringify(received.metadata).includes('checkout-browser-agent'), false);
});

test('create-checkout-session refuses: bad ids, missing/unpublished products, unbuyable states', async () => {
  await seedProduct();
  const fake = { checkout: { sessions: { create: async () => assert.fail('must not reach Stripe') } } };

  await withFakeStripe(fake, async () => {
    assert.equal((await createSession({ httpMethod: 'GET' })).statusCode, 405);
    assert.equal((await post({ product_id: 'sku-1' })).statusCode, 400);
    assert.equal((await post({ product_id: 'prod_ghost' })).statusCode, 404);
  });

  await seedProduct({ availability: 'coming_soon' });
  await withFakeStripe(fake, async () => {
    const response = await post({ product_id: PRODUCT_ID });
    assert.equal(response.statusCode, 409);
    assert.equal(JSON.parse(response.body).reason, 'not_available');
  });

  await seedProduct({ mode: 'free', provider: 'none', price: undefined, stripe_test: undefined });
  await withFakeStripe(fake, async () => {
    assert.equal(
      JSON.parse((await post({ product_id: PRODUCT_ID })).body).reason,
      'free_product',
      'free products claim directly, never through Checkout (§1)'
    );
  });

  await seedProduct({ stripe_test: undefined });
  await withFakeStripe(fake, async () => {
    assert.equal(JSON.parse((await post({ product_id: PRODUCT_ID })).body).reason, 'not_linked');
  });

  // No client at all (no key configured) → 503.
  resetStripeClientForTesting();
  delete process.env.STRIPE_SECRET_KEY_TEST;
  await seedProduct();
  assert.equal((await post({ product_id: PRODUCT_ID })).statusCode, 503);
});

// ─── checkout-session-status (the §8.8 poller) ───────────────────────────────

const statusFor = (sessionId: string) =>
  sessionStatus({ httpMethod: 'GET', queryStringParameters: { session_id: sessionId } });

test('status: paid but webhook not landed → order_ready:false (the page keeps polling)', async () => {
  await seedProduct();
  const fake = {
    checkout: { sessions: { retrieve: async () => ({ id: SESSION_ID, payment_status: 'paid' }) } },
  };
  const response = await withFakeStripe(fake, () => statusFor(SESSION_ID));
  assert.equal(response.statusCode, 200);
  assert.deepEqual(JSON.parse(response.body), { ok: true, paid: true, order_ready: false });
});

test('status: order present → fresh download link minted from the product fulfillment', async () => {
  await seedProduct();
  await createLocalBlobStore('commerce').setJSON(`orders/${SESSION_ID}.json`, {
    schema: 'commerce_order.v1',
    order_id: 'ord_abc123def456',
    session_id: SESSION_ID,
    product_id: PRODUCT_ID,
    mode: 'fixed',
    amount_total: 1900,
    currency: 'usd',
    buyer_email: 'buyer@example.com',
    created_at: '2026-07-12T12:00:00.000Z',
    fulfillment: { state: 'issued', token_hash: `sha256:${'a'.repeat(64)}`, issued_at: null, reissues: [] },
    flags: {},
  });
  const fake = {
    checkout: { sessions: { retrieve: async () => ({ id: SESSION_ID, payment_status: 'paid' }) } },
  };
  const response = await withFakeStripe(fake, () => statusFor(SESSION_ID));
  const body = JSON.parse(response.body) as {
    order_ready: boolean;
    download: { url: string; filename: string } | null;
  };
  assert.equal(body.order_ready, true);
  assert.ok(body.download);
  assert.equal(body.download.filename, 'barrier-repair-guide.pdf');
  assert.match(body.download.url, /^\/\.netlify\/functions\/get-purchase\?token=/);
});

test('status: malformed session ids are refused before touching Stripe', async () => {
  const fake = { checkout: { sessions: { retrieve: async () => assert.fail('must not reach Stripe') } } };
  await withFakeStripe(fake, async () => {
    assert.equal((await statusFor('DROP TABLE')).statusCode, 400);
    assert.equal((await sessionStatus({ httpMethod: 'GET', queryStringParameters: {} })).statusCode, 400);
  });
});

// ─── S3: pwyw + unlock checkout paths ────────────────────────────────────────

test('pwyw: the session function is the minimum-enforcement point (§3) and charges price_data', async () => {
  await seedProduct({
    mode: 'pwyw',
    price: undefined,
    pwyw: { min_cents: 300, suggested_cents: 900 },
    stripe_test: { product_id: 'prod_Test1' },
  });
  let received: Record<string, unknown> | undefined;
  const fake = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          received = params;
          return { id: SESSION_ID, url: 'https://checkout.stripe.com/c/pay/x' };
        },
      },
    },
  };
  await withFakeStripe(fake, async () => {
    const below = await post({ product_id: PRODUCT_ID, amount_cents: 200 });
    assert.equal(below.statusCode, 400);
    assert.equal(JSON.parse(below.body).min_cents, 300);
    assert.equal((await post({ product_id: PRODUCT_ID, amount_cents: 900.5 })).statusCode, 400, 'integer cents only');
    assert.equal((await post({ product_id: PRODUCT_ID })).statusCode, 400, 'amount is required for pwyw');
    assert.equal((await post({ product_id: PRODUCT_ID, amount_cents: 900 })).statusCode, 200);
  });
  assert.deepEqual(received?.line_items, [
    { price_data: { currency: 'usd', unit_amount: 900, product: 'prod_Test1' }, quantity: 1 },
  ]);
});

test('unlock: checkout requires an EXISTING pre-generated artifact under the product prefix (§5)', async () => {
  await seedProduct();
  // Overwrite the fulfillment to the unlock kind.
  await createLocalBlobStore('site-objects').setJSON(objectRecordKey('product', PRODUCT_ID), {
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
  await createLocalBlobStore('artifacts').set('unlock/quiz-results/r_abc.pdf', '%PDF-1.7 unlock');

  let received: Record<string, unknown> | undefined;
  const fake = {
    checkout: {
      sessions: {
        create: async (params: Record<string, unknown>) => {
          received = params;
          return { id: SESSION_ID, url: 'https://checkout.stripe.com/c/pay/x' };
        },
      },
    },
  };
  await withFakeStripe(fake, async () => {
    assert.equal((await post({ product_id: PRODUCT_ID })).statusCode, 400, 'unlock_key required');
    assert.equal(
      (await post({ product_id: PRODUCT_ID, unlock_key: 'pdf/elsewhere/x.pdf' })).statusCode,
      400,
      'keys outside the product prefix are refused'
    );
    assert.equal(
      (await post({ product_id: PRODUCT_ID, unlock_key: 'unlock/quiz-results/ghost.pdf' })).statusCode,
      404,
      'nobody pays for a ghost artifact'
    );
    assert.equal((await post({ product_id: PRODUCT_ID, unlock_key: 'unlock/quiz-results/r_abc.pdf' })).statusCode, 200);
  });
  assert.equal(
    (received?.metadata as Record<string, string>).unlock_key,
    'unlock/quiz-results/r_abc.pdf',
    'the webhook fulfils exactly this artifact'
  );
});
