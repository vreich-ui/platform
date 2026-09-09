/**
 * Client-side commerce event capture (06-shop-module-plan §6) — the
 * `sendBeacon` sibling of save-opt-in.ts. Best-effort and lossy by design:
 * failures return errors but nothing retries, and nothing downstream trusts
 * these events for money.
 *
 * Security posture, deliberate:
 * - ONLY the client-authored types (`product_viewed`, `checkout_started`)
 *   are accepted — the authoritative types (checkout_completed,
 *   fulfillment_issued, …) are written server-side by the webhook/delivery
 *   functions (S1c) and cannot be forged through this public endpoint.
 * - NO email field is accepted here, hashed or raw — the beacon carries at
 *   most an anonymous id. Raw email exists only in order records; hashes are
 *   computed server-side from data Stripe returned (§6 PII rules).
 * - The data payload is allowlisted (amount_cents/currency/mode), never a
 *   passthrough — an append-only immutable store must not accept arbitrary
 *   user-controlled blobs.
 * - sendBeacon can't always set content-type, so JSON is parsed regardless
 *   of the header (unlike save-opt-in, which is form-aware).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getCommerceEventsBlobStore } from '../lib/blob-store.js';
import { appendCommerceEvent, isClientCommerceEventType, newCommerceEvent } from '../lib/commerce-events.js';
import { getHeader } from '../lib/opt-in-record.js';
import { isObjectIdForType } from '../../lib/object-ids.js';

type LambdaEvent = {
  blobs?: string;
  body?: string | null;
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const reply = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: JSON.stringify(body),
});

const asTrimmedString = (value: unknown, maxLength: number): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength) return undefined;
  return trimmed;
};

/** The §6 data allowlist — anything else in `data` is silently dropped. */
const sanitizeData = (value: unknown): Record<string, string | number> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const input = value as Record<string, unknown>;
  const data: Record<string, string | number> = {};
  if (typeof input.amount_cents === 'number' && Number.isInteger(input.amount_cents) && input.amount_cents >= 0) {
    data.amount_cents = input.amount_cents;
  }
  const currency = asTrimmedString(input.currency, 3);
  if (currency && /^[a-z]{3}$/.test(currency)) data.currency = currency;
  const mode = asTrimmedString(input.mode, 8);
  if (mode && ['fixed', 'pwyw', 'free'].includes(mode)) data.mode = mode;
  return data;
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent) => {
  if (event.httpMethod !== 'POST') {
    return reply(405, { error: 'Method not allowed' });
  }

  if (!event.body) return reply(400, { error: 'A JSON body is required.' });
  const rawBody = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;

  let input: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return reply(400, { error: 'The body must be a JSON object.' });
    }
    input = parsed as Record<string, unknown>;
  } catch {
    return reply(400, { error: 'Invalid JSON body.' });
  }

  const type = asTrimmedString(input.type, 32);
  if (!type || !isClientCommerceEventType(type)) {
    return reply(400, {
      error: 'type must be a client-authored commerce event type (product_viewed | checkout_started).',
    });
  }

  const productId = asTrimmedString(input.product_id, 128);
  if (!productId || !isObjectIdForType('product', productId)) {
    return reply(400, { error: 'product_id must be a prod_… object id.' });
  }

  try {
    const commerceEvent = newCommerceEvent({
      type,
      actor: { anon_id: asTrimmedString(input.anon_id, 128) ?? null },
      subject: {
        product_id: productId,
        session_id: asTrimmedString(input.session_id, 256) ?? null,
      },
      context: {
        path: asTrimmedString(input.path, 512) ?? null,
        referrer: asTrimmedString(input.referrer, 1024) ?? null,
        ua: asTrimmedString(getHeader(event.headers, 'user-agent'), 512) ?? null,
      },
      data: sanitizeData(input.data),
    });

    const store = await getCommerceEventsBlobStore(event, binding);
    const { key } = await appendCommerceEvent(store, commerceEvent);

    return reply(202, { ok: true, key });
  } catch (error) {
    console.error('Failed to append commerce event.', error);
    return reply(500, { error: 'Commerce event could not be saved.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
