/**
 * Free-product claim (06-shop-module-plan §5) — free products never touch
 * Stripe (`provider: 'none'`): the "purchase" is a direct token issuance
 * through the SAME order/event machinery, which is exactly a lead magnet.
 *
 * POST { product_id, email? } → { ok, download: { url, filename } | null }.
 *
 * - The order is real (`ord_free_…`, session_id null, amount 0) so support
 *   and reissue work identically to paid orders; each claim is a fresh order
 *   (no dedupe — a lead magnet claimed twice is two hand-raises).
 * - `email` is OPTIONAL and goes two places, per the §6 PII rules: RAW into
 *   the order record, and into the existing opt-ins capture store (the
 *   lead-capture tie-in) — the event log gets only the hash.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { randomUUID, createHash } from 'node:crypto';

import {
  getCommerceBlobStore,
  getCommerceEventsBlobStore,
  getOptInBlobStore,
  getSiteObjectsBlobStore,
} from '../lib/blob-store.js';
import { appendCommerceEvent, hashEmail, newCommerceEvent } from '../lib/commerce-events.js';
import { COMMERCE_ORDER_SCHEMA_VERSION, writeOrderIfAbsent, type OrderRecord } from '../lib/commerce-orders.js';
import { loadPublishedProduct } from '../lib/commerce-products.js';
import {
  DEFAULT_PURCHASE_TOKEN_TTL_MS,
  mintPurchaseToken,
  purchaseTokenHash,
  purchaseTokenSecret,
} from '../lib/purchase-tokens.js';
import { buildRecord } from '../lib/opt-in-record.js';
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

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  let input: Record<string, unknown>;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
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
  const email = typeof input.email === 'string' && input.email.includes('@') ? input.email.trim() : null;

  try {
    const siteObjects = await getSiteObjectsBlobStore(event, binding);
    const product = await loadPublishedProduct(siteObjects, productId);
    if (!product) return reply(404, { error: 'Product not found or not published.' });
    if (product.body.commerce.mode !== 'free' || product.body.commerce.availability !== 'available') {
      return reply(409, { error: 'This product is not claimable for free.' });
    }

    const tokenSecret = purchaseTokenSecret();
    const artifactRef =
      product.body.fulfillment.kind === 'download' ? product.body.fulfillment.artifact_ref : undefined;
    const orderId = `ord_free_${createHash('sha256').update(randomUUID()).digest('hex').slice(0, 12)}`;
    const now = new Date().toISOString();

    let token: string | undefined;
    if (artifactRef && tokenSecret) {
      token = mintPurchaseToken(
        { order_key: orderId, artifact_ref: artifactRef, exp: Date.now() + DEFAULT_PURCHASE_TOKEN_TTL_MS },
        tokenSecret
      );
    }

    const order: OrderRecord = {
      schema: COMMERCE_ORDER_SCHEMA_VERSION,
      order_id: orderId,
      session_id: null, // free claims never touch Stripe (§5)
      product_id: productId,
      mode: 'free',
      amount_total: 0,
      currency: 'usd',
      buyer_email: email,
      created_at: now,
      fulfillment: token
        ? {
            state: 'issued',
            token_hash: purchaseTokenHash(token),
            issued_at: now,
            ...(artifactRef ? { artifact_ref: artifactRef } : {}),
            reissues: [],
          }
        : { state: 'none', token_hash: null, issued_at: null, reissues: [] },
      flags: {},
    };

    const commerce = await getCommerceBlobStore(event, binding);
    await writeOrderIfAbsent(commerce, order);

    // Same event machinery as a paid purchase (amount 0) — best-effort.
    try {
      const events = await getCommerceEventsBlobStore(event, binding);
      const emailHash = email ? hashEmail(email) : null;
      const subject = { product_id: productId, order_id: orderId, session_id: null };
      await appendCommerceEvent(
        events,
        newCommerceEvent({
          type: 'checkout_completed',
          actor: { email_hash: emailHash },
          subject,
          data: { amount_cents: 0, currency: 'usd', mode: 'free' },
        })
      );
      if (token) {
        await appendCommerceEvent(
          events,
          newCommerceEvent({ type: 'fulfillment_issued', actor: { email_hash: emailHash }, subject, data: {} })
        );
      }
    } catch (error) {
      console.error('Failed to append free-claim events.', error);
    }

    // The lead-capture tie-in (§5): optional email → the existing opt-ins
    // machinery, exactly as a form submission would record it.
    if (email) {
      try {
        const optIns = await getOptInBlobStore(event, binding);
        const record = buildRecord({ formName: 'free_product_claim', email, source: `/shop/${product.body.slug}` });
        if (record) {
          await optIns.setJSON(`opt-ins/${record.submittedAt.slice(0, 10)}/${randomUUID()}.json`, record, {
            metadata: { formName: record.formName, submittedAt: record.submittedAt },
          });
        }
      } catch (error) {
        console.error('Failed to record free-claim opt-in.', error);
      }
    }

    return reply(200, {
      ok: true,
      order_id: orderId,
      download: token
        ? {
            url: `/.netlify/functions/get-purchase?token=${encodeURIComponent(token)}`,
            filename: product.body.fulfillment.kind === 'download' ? product.body.fulfillment.filename : 'download',
          }
        : null,
    });
  } catch (error) {
    console.error('Free claim failed.', error);
    return reply(500, { error: 'The claim could not be completed. Try again shortly.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
