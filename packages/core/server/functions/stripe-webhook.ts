/**
 * Stripe webhook (06-shop-module-plan §5) — signature-verified, idempotent,
 * replayable.
 *
 * - `checkout.session.completed` → create the order (create-if-absent on the
 *   session id — replays and double-fires no-op) → issue fulfillment (mint
 *   the expiring token for downloads; kind 'none' delivers nothing) → append
 *   the authoritative events.
 * - `checkout.session.expired` → append a `checkout_abandoned` event.
 * - Everything else acks 200 and is ignored.
 *
 * Idempotency, twice over: the order write is atomic create-if-absent (§5),
 * AND every event this function appends uses a DETERMINISTIC event_id + ts
 * derived from the Stripe event — so a replay collides on the same store key
 * and no-ops instead of duplicating (§8.2's duplicate window closes to the
 * genuinely-concurrent double-fire).
 *
 * The §3 backstop lives here too: `amount_total` is cross-checked against
 * the product's display cache; a mismatch flags the order and appends an
 * `amount_mismatch` event — the charge is still correct (price_id is
 * canonical), the display lied.
 *
 * kind 'unlock' (S3): the artifact was generated BEFORE payment under the
 * product's unlock prefix; the session's metadata.unlock_key names it and
 * payment only flips retrieval — the token is minted over that per-buyer
 * artifact. A completed unlock session without a valid key records the order
 * with state 'none' (support case), never a token over the wrong blob.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { createHash } from 'node:crypto';
import type Stripe from 'stripe';

import { getCommerceBlobStore, getCommerceEventsBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { appendCommerceEvent, hashEmail, newCommerceEvent, type CommerceEventType } from '../lib/commerce-events.js';
import { COMMERCE_ORDER_SCHEMA_VERSION, writeOrderIfAbsent, type OrderRecord } from '../lib/commerce-orders.js';
import { loadPublishedProduct } from '../lib/commerce-products.js';
import { enqueueMemberLinkForShash, type MemberLinkDeps } from '../lib/member-link.js';
import {
  DEFAULT_PURCHASE_TOKEN_TTL_MS,
  mintPurchaseToken,
  purchaseTokenHash,
  purchaseTokenSecret,
} from '../lib/purchase-tokens.js';
import { getStripeClient, stripeWebhookSecret } from '../lib/stripe-env.js';

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

const header = (headers: LambdaEvent['headers'], name: string): string | undefined => {
  const match = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name);
  return match?.[1];
};

/**
 * RFC-4122-shaped uuid derived from a seed — used for DETERMINISTIC event
 * ids (same Stripe event → same id → same store key → replays no-op).
 */
export const deterministicUuid = (seed: string): string => {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('');
  hex[12] = '4';
  hex[16] = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  const s = hex.join('');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`;
};

const isoFromEpochSeconds = (seconds: number): string => new Date(seconds * 1000).toISOString();

const handlerImpl = async (event: LambdaEvent, memberLinkDeps: MemberLinkDeps = {}) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  const webhookSecret = stripeWebhookSecret();
  const stripe = await getStripeClient();
  if (!webhookSecret || !stripe) {
    return reply(503, { error: 'Webhook is not configured (no Stripe webhook secret for the running mode).' });
  }

  const signature = header(event.headers, 'stripe-signature');
  if (!event.body || !signature) return reply(400, { error: 'Missing body or stripe-signature header.' });
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let stripeEvent: Stripe.Event;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (error) {
    console.error('Stripe webhook signature verification failed.', error);
    return reply(400, { error: 'Invalid webhook signature.' });
  }

  try {
    if (stripeEvent.type === 'checkout.session.completed') {
      return await handleCompleted(event, stripeEvent, memberLinkDeps);
    }
    if (stripeEvent.type === 'checkout.session.expired') {
      return await handleExpired(event, stripeEvent);
    }
    return reply(200, { received: true, ignored: stripeEvent.type });
  } catch (error) {
    // Non-2xx makes Stripe retry — exactly what we want for transient store
    // failures; the create-if-absent order write keeps retries safe.
    console.error(`Stripe webhook handling failed for ${stripeEvent.type}.`, error);
    return reply(500, { error: 'Webhook handling failed; Stripe will retry.' });
  }
};

const handleCompleted = async (event: LambdaEvent, stripeEvent: Stripe.Event, memberLinkDeps: MemberLinkDeps) => {
  const session = stripeEvent.data.object as Stripe.Checkout.Session;

  // v1 sells by card through hosted Checkout: completed ⇒ paid. Delayed
  // (async) payment methods complete unpaid and confirm later — out of scope
  // for v1; ack so Stripe stops retrying, fulfil nothing.
  if (session.payment_status !== 'paid') {
    return reply(200, { received: true, skipped: `payment_status ${session.payment_status}` });
  }

  const productId = session.metadata?.product_id ?? '';
  if (!productId) {
    // A session this system did not create (no metadata stamp) — ack, log.
    console.warn(`checkout.session.completed for ${session.id} carries no product_id metadata; skipping.`);
    return reply(200, { received: true, skipped: 'no product_id metadata' });
  }

  const siteObjects = await getSiteObjectsBlobStore(event);
  const product = await loadPublishedProduct(siteObjects, productId);
  const buyerEmail = session.customer_details?.email ?? session.customer_email ?? null;
  const createdAt = isoFromEpochSeconds(stripeEvent.created);
  const amountTotal = session.amount_total ?? 0;
  const currency = (session.currency ?? 'usd').toLowerCase();

  // §3 cross-check: what Stripe charged vs the display cache. The charge is
  // canonical; a mismatch means the SITE lied — flag it, never block.
  const expectedCents = product?.body.commerce.price?.amount_cents;
  const amountMismatch = expectedCents !== undefined && expectedCents !== amountTotal;

  // Fulfillment is decided from the product's CURRENT record. download →
  // token over the product's artifact; unlock → token over the PRE-generated
  // per-buyer artifact the session named at checkout (§5 inverted timing —
  // metadata.unlock_key, prefix-checked at session creation AND here);
  // none → nothing to deliver.
  const tokenSecret = purchaseTokenSecret();
  const fulfillmentKind = product?.body.fulfillment.kind;
  let artifactRef: string | undefined;
  if (product?.body.fulfillment.kind === 'download') {
    artifactRef = product.body.fulfillment.artifact_ref;
  } else if (product?.body.fulfillment.kind === 'unlock') {
    const unlockKey = session.metadata?.unlock_key ?? '';
    if (unlockKey.startsWith(product.body.fulfillment.unlock_prefix)) {
      artifactRef = unlockKey;
    } else {
      console.error(`unlock session ${session.id} carries no valid unlock_key; order recorded unfulfilled.`);
    }
  }
  let token: string | undefined;
  if (artifactRef && tokenSecret) {
    token = mintPurchaseToken(
      { order_key: session.id, artifact_ref: artifactRef, exp: Date.now() + DEFAULT_PURCHASE_TOKEN_TTL_MS },
      tokenSecret
    );
  }

  const order: OrderRecord = {
    schema: COMMERCE_ORDER_SCHEMA_VERSION,
    order_id: `ord_${createHash('sha256').update(session.id).digest('hex').slice(0, 12)}`,
    session_id: session.id,
    product_id: productId,
    mode: product?.body.commerce.mode ?? 'fixed',
    amount_total: amountTotal,
    currency,
    buyer_email: buyerEmail,
    created_at: createdAt,
    fulfillment: token
      ? {
          state: 'issued',
          token_hash: purchaseTokenHash(token),
          issued_at: new Date().toISOString(),
          // Stored so fulfillment stays a pure function of the order record
          // (order_reissue never needs Stripe or the product's CURRENT body).
          ...(artifactRef ? { artifact_ref: artifactRef } : {}),
          reissues: [],
        }
      : { state: 'none', token_hash: null, issued_at: null, reissues: [] },
    flags: amountMismatch ? { amount_mismatch: true } : {},
  };

  const commerce = await getCommerceBlobStore(event);
  const written = await writeOrderIfAbsent(commerce, order);

  // Events are deterministic per (session, type): replays collide and no-op
  // even when the order write raced. Best-effort — a failed append must not
  // fail the order that already exists.
  const events = await getCommerceEventsBlobStore(event);
  const emailHash = buyerEmail ? hashEmail(buyerEmail) : null;
  const appendAuthoritative = async (type: CommerceEventType, data: Record<string, string | number>) => {
    try {
      await appendCommerceEvent(
        events,
        newCommerceEvent({
          type,
          event_id: deterministicUuid(`${session.id}:${type}`),
          ts: createdAt,
          actor: { email_hash: emailHash },
          subject: { product_id: productId, order_id: written.order.order_id, session_id: session.id },
          data,
        })
      );
    } catch (error) {
      console.error(`Failed to append ${type} event for ${session.id}.`, error);
    }
  };

  await appendAuthoritative('checkout_completed', {
    amount_cents: amountTotal,
    currency,
    mode: order.mode,
  });
  if (written.order.fulfillment.state === 'issued') {
    await appendAuthoritative('fulfillment_issued', { kind: fulfillmentKind ?? 'download' });
  }
  if (written.order.flags.amount_mismatch) {
    await appendAuthoritative('amount_mismatch', {
      amount_cents: amountTotal,
      expected_cents: expectedCents ?? -1,
      currency,
    });
  }

  enqueueMemberLinkForShash(session.metadata?.visitor_shash, buyerEmail, memberLinkDeps);

  return reply(200, {
    received: true,
    order_created: written.created,
    order_id: written.order.order_id,
  });
};

const handleExpired = async (event: LambdaEvent, stripeEvent: Stripe.Event) => {
  const session = stripeEvent.data.object as Stripe.Checkout.Session;
  const events = await getCommerceEventsBlobStore(event);
  await appendCommerceEvent(
    events,
    newCommerceEvent({
      type: 'checkout_abandoned',
      event_id: deterministicUuid(`${session.id}:checkout_abandoned`),
      ts: isoFromEpochSeconds(stripeEvent.created),
      subject: { product_id: session.metadata?.product_id ?? null, session_id: session.id },
      data: {},
    })
  );
  return reply(200, { received: true });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler =
  (_binding: SiteBinding, memberLinkDeps: MemberLinkDeps = {}) =>
  (event: LambdaEvent) =>
    handlerImpl(event, memberLinkDeps);
