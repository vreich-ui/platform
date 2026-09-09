/**
 * Token-gated purchase delivery (06-shop-module-plan §5) — the sibling of
 * get-public-pdf.ts for the PRIVATE artifacts store.
 *
 * GET ?token=… → streams the purchased blob with Content-Disposition.
 *
 * Authorization = the token itself: an HMAC signature (proof the server
 * minted it) + expiry + the embedded order existing in the commerce store.
 * Order records store token HASHES as the issuance audit trail, not an
 * allowlist — a fresh status-page token (checkout-session-status.ts) is as
 * valid as the originally-issued one because the signature is the proof.
 * Expired links are a support case → `order_reissue` (S3), not a dead end.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import {
  getArtifactBlobStore,
  getCommerceBlobStore,
  getCommerceEventsBlobStore,
  getSiteObjectsBlobStore,
} from '../lib/blob-store.js';
import { appendCommerceEvent, hashEmail, newCommerceEvent } from '../lib/commerce-events.js';
import { readOrder } from '../lib/commerce-orders.js';
import { loadPublishedProduct } from '../lib/commerce-products.js';
import { purchaseTokenSecret, verifyPurchaseToken } from '../lib/purchase-tokens.js';
import { sanitizeFilename } from '../lib/artifact-filename.js';

type LambdaEvent = {
  blobs?: string;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const reply = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'GET') return reply(405, { error: 'Method not allowed' });

  const secret = purchaseTokenSecret();
  if (!secret) return reply(503, { error: 'Purchase delivery is not configured.' });

  const token = (event.queryStringParameters?.token ?? '').trim();
  if (!token) return reply(400, { error: 'A token is required.' });

  const verified = verifyPurchaseToken(token, secret);
  if (!verified.ok) {
    if (verified.reason === 'expired') {
      return reply(410, {
        error: 'This download link has expired. Reply to your receipt email and we will reissue it.',
      });
    }
    return reply(401, { error: 'Invalid download token.' });
  }

  try {
    const commerce = await getCommerceBlobStore(event, binding);
    const order = await readOrder(commerce, verified.payload.order_key);
    if (!order) return reply(404, { error: 'No order found for this token.' });

    const artifacts = await getArtifactBlobStore(event, binding);
    const blob = (await (
      artifacts as { get: (key: string, options: { type: 'arrayBuffer' }) => Promise<ArrayBuffer | null> }
    ).get(verified.payload.artifact_ref, { type: 'arrayBuffer' })) as ArrayBuffer | null;
    if (!blob) return reply(404, { error: 'The purchased file is no longer available. Contact support.' });

    // Filename from the product's CURRENT fulfillment; falls back to the ref's basename.
    let filename = verified.payload.artifact_ref.split('/').pop() || 'download';
    try {
      const siteObjects = await getSiteObjectsBlobStore(event, binding);
      const product = await loadPublishedProduct(siteObjects, order.product_id);
      if (product?.body.fulfillment.kind === 'download') filename = product.body.fulfillment.filename;
    } catch {
      // Best-effort nicety only.
    }

    // Authoritative but best-effort: delivery never fails on event append.
    try {
      const events = await getCommerceEventsBlobStore(event, binding);
      await appendCommerceEvent(
        events,
        newCommerceEvent({
          type: 'download_succeeded',
          actor: { email_hash: order.buyer_email ? hashEmail(order.buyer_email) : null },
          subject: { product_id: order.product_id, order_id: order.order_id, session_id: order.session_id },
          data: {},
        })
      );
    } catch (error) {
      console.error('Failed to append download_succeeded event.', error);
    }

    const extension = (verified.payload.artifact_ref.split('.').pop() ?? '').toLowerCase();
    return {
      statusCode: 200,
      headers: {
        'Content-Type': CONTENT_TYPES[extension] ?? 'application/octet-stream',
        'Cache-Control': 'no-store', // token-gated — never cache
        'Content-Disposition': `attachment; filename="${sanitizeFilename(filename)}"`,
      },
      body: Buffer.from(blob).toString('base64'),
      isBase64Encoded: true,
    };
  } catch (error) {
    console.error('Failed to deliver purchase.', error);
    return reply(500, { error: 'The download could not be prepared. Try again shortly.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
