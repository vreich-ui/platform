/**
 * Checkout Session creation (06-shop-module-plan §5) — hosted Checkout only;
 * no Elements, no PCI scope beyond SAQ-A.
 *
 * POST { product_id, anon_id? } → { url } (the Stripe-hosted redirect).
 *
 * - The product must be buyable in STORE state (published + active +
 *   'available', fixed mode with linkage for the running STRIPE_MODE) — a
 *   retired or unpublished product refuses even if an old page still shows a
 *   buy button.
 * - Charges the linked `price_id`; the display cache is never the charge
 *   source (§3 canonicality — a stale cache is cosmetic, never a wrong
 *   charge).
 * - Stamps `metadata: { product_id, event_id }` so the webhook can correlate
 *   the completed session back to the product and the event chain (§5).
 * - success/cancel URLs are built from the SERVER's site URL (never a
 *   request header — a forged Origin must not steer the redirect).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { randomUUID } from 'node:crypto';

import { getArtifactBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { checkBuyability, loadPublishedProduct } from '../lib/commerce-products.js';
import { visitorShashForRequest, type MemberLinkDeps } from '../lib/member-link.js';
import { getStripeClient } from '../lib/stripe-env.js';
import { isObjectIdForType } from '../../lib/object-ids.js';

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

/** The deploy's own URL (Netlify-provided); localhost for local dev. */
const siteOrigin = (): string => (process.env.URL ?? '').trim().replace(/\/$/, '') || 'http://localhost:8888';

const handlerImpl = async (event: LambdaEvent, memberLinkDeps: MemberLinkDeps = {}) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  if (!event.body) return reply(400, { error: 'A JSON body is required.' });
  let input: Record<string, unknown>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    input = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: 'Invalid JSON body.' });
  }

  const productId = typeof input.product_id === 'string' ? input.product_id.trim() : '';
  if (!productId || !isObjectIdForType('product', productId)) {
    return reply(400, { error: 'product_id must be a prod_… object id.' });
  }

  const stripe = await getStripeClient();
  if (!stripe) {
    return reply(503, { error: 'Checkout is not configured (no Stripe key for the running mode).' });
  }

  try {
    const store = await getSiteObjectsBlobStore(event);
    const product = await loadPublishedProduct(store, productId);
    if (!product) return reply(404, { error: 'Product not found or not published.' });

    const buyable = checkBuyability(product.body);
    if (!buyable.ok) {
      const message =
        buyable.reason === 'not_available'
          ? 'This product is not currently available for purchase.'
          : buyable.reason === 'free_product'
            ? 'Free products are claimed directly (claim-free), not through Checkout.'
            : buyable.reason === 'mode_not_supported'
              ? 'This commerce mode is not supported by Checkout.'
              : 'This product has no Stripe linkage for the running mode.';
      return reply(409, { error: message, reason: buyable.reason });
    }

    // Pay-what-you-want (§3): no Stripe Price exists — the buyer picks the
    // amount and THIS function is the enforcement point for the minimum.
    let lineItem: Record<string, unknown>;
    if (buyable.mode === 'pwyw') {
      const amountCents = typeof input.amount_cents === 'number' ? input.amount_cents : NaN;
      if (!Number.isInteger(amountCents) || amountCents < buyable.minCents || amountCents > 500_000) {
        return reply(400, {
          error: `amount_cents must be an integer between ${buyable.minCents} and 500000.`,
          min_cents: buyable.minCents,
          ...(buyable.suggestedCents !== undefined ? { suggested_cents: buyable.suggestedCents } : {}),
        });
      }
      lineItem = {
        price_data: {
          currency: 'usd',
          unit_amount: amountCents,
          ...(buyable.stripeProductId
            ? { product: buyable.stripeProductId }
            : { product_data: { name: product.body.presentation.title } }),
        },
        quantity: 1,
      };
    } else {
      lineItem = { price: buyable.priceId, quantity: 1 };
    }

    // Pay-to-unlock (§5, inverted timing): the artifact was generated BEFORE
    // payment under the product's unlock prefix; the buyer's session names it
    // and the webhook only flips retrieval. The key must sit under the
    // product's own prefix AND already exist — nobody pays for a ghost.
    const metadata: Record<string, string> = { product_id: productId, event_id: randomUUID() };
    const visitorShash = visitorShashForRequest(event, memberLinkDeps);
    if (visitorShash) metadata.visitor_shash = visitorShash;
    if (product.body.fulfillment.kind === 'unlock') {
      const unlockKey = typeof input.unlock_key === 'string' ? input.unlock_key.trim() : '';
      const prefix = product.body.fulfillment.unlock_prefix;
      if (!unlockKey || !unlockKey.startsWith(prefix)) {
        return reply(400, { error: `unlock_key is required and must start with "${prefix}".` });
      }
      const artifacts = await getArtifactBlobStore(event);
      if ((await artifacts.get(unlockKey)) === null) {
        return reply(404, { error: 'The unlock artifact does not exist yet — generate it before checkout.' });
      }
      metadata.unlock_key = unlockKey;
    }

    const origin = siteOrigin();
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: [lineItem],
      success_url: `${origin}/shop/thank-you?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${origin}/shop/${product.body.slug}`,
      metadata,
    });

    if (!session.url) return reply(502, { error: 'Stripe did not return a Checkout URL.' });
    return reply(200, { ok: true, url: session.url, session_id: session.id, event_id: metadata.event_id });
  } catch (error) {
    console.error('Failed to create a Checkout Session.', error);
    return reply(502, { error: 'Checkout Session could not be created.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler =
  (_binding: SiteBinding, memberLinkDeps: MemberLinkDeps = {}) =>
  (event: LambdaEvent) =>
    handlerImpl(event, memberLinkDeps);
