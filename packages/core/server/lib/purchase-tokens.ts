/**
 * Purchase tokens — the expiring, signed capability that gates delivery
 * (06-shop-module-plan §5): `get-purchase` streams a private artifact only
 * to a bearer of a valid token. HMAC-SHA256 over a JSON payload embedding
 * `{ order_key, artifact_ref, exp }`, signed with `PURCHASE_TOKEN_SECRET`.
 *
 * Properties, deliberate:
 * - EXPIRING (default 72h) and re-issuable (`order_reissue`, S3) — hard to
 *   share, not impossible; a determined buyer can hand the file on. Accepted
 *   for v1 digital goods; no DRM promised (§8.3).
 * - BEARER: possession is the credential. The token itself is never stored —
 *   order records keep only `sha256:` hashes as the issuance audit trail, so
 *   a store dump cannot mint working links.
 * - The signature is the proof of server issuance: verification checks
 *   signature (timing-safe) + expiry, then the caller confirms the embedded
 *   order exists. The payload is authenticated data, not a lookup hint an
 *   attacker could vary.
 *
 * Format: base64url(payload JSON) + '.' + base64url(hmac) — no external JWT
 * dependency for a two-field internal token (§7: OSS earns its place;
 * hand-rolling *webhook signature checks* is malpractice, a plain HMAC over
 * our own payload is exactly what node:crypto is for).
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

import { sha256Hex } from './crypto.js';

export const PURCHASE_TOKEN_SECRET_ENV = 'PURCHASE_TOKEN_SECRET';
export const DEFAULT_PURCHASE_TOKEN_TTL_MS = 72 * 60 * 60 * 1000; // 72h (§5)

export type PurchaseTokenPayload = {
  /** The order's idempotency key (session id / free-claim order id). */
  order_key: string;
  /** The PRIVATE artifacts-store key this token unlocks. */
  artifact_ref: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

const b64url = (input: Buffer | string): string => Buffer.from(input).toString('base64url');

const sign = (payload: string, secret: string): string =>
  createHmac('sha256', secret).update(payload).digest('base64url');

/** The secret from env; undefined when unconfigured (callers 503, never a weak fallback). */
export const purchaseTokenSecret = (env: NodeJS.ProcessEnv = process.env): string | undefined => {
  const value = (env[PURCHASE_TOKEN_SECRET_ENV] ?? '').trim();
  return value.length >= 16 ? value : undefined;
};

/**
 * T16.5: the single predicate for "is purchase-token delivery configured" —
 * both the real call path (order-reissue.ts, get-purchase.ts, stripe-webhook,
 * claim-free.ts, all via purchaseTokenSecret above) and capability-status.ts's
 * `purchase_token` family read the same purchaseTokenSecret check.
 */
export const purchaseTokenMissingEnvVars = (env: NodeJS.ProcessEnv = process.env): string[] =>
  purchaseTokenSecret(env) ? [] : [PURCHASE_TOKEN_SECRET_ENV];

export const isPurchaseTokenConfigured = (env: NodeJS.ProcessEnv = process.env): boolean =>
  purchaseTokenMissingEnvVars(env).length === 0;

export const mintPurchaseToken = (payload: PurchaseTokenPayload, secret: string): string => {
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body, secret)}`;
};

/** `sha256:<hex>` of a token — what order records store (never the token). */
export const purchaseTokenHash = (token: string): string => `sha256:${sha256Hex(token)}`;

export type VerifyPurchaseTokenResult =
  | { ok: true; payload: PurchaseTokenPayload }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export const verifyPurchaseToken = (
  token: string,
  secret: string,
  nowMs: number = Date.now()
): VerifyPurchaseTokenResult => {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'malformed' };
  const [body, signature] = parts;

  const expected = Buffer.from(sign(body, secret), 'utf8');
  const received = Buffer.from(signature, 'utf8');
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (
    !payload ||
    typeof payload !== 'object' ||
    typeof (payload as PurchaseTokenPayload).order_key !== 'string' ||
    typeof (payload as PurchaseTokenPayload).artifact_ref !== 'string' ||
    typeof (payload as PurchaseTokenPayload).exp !== 'number'
  ) {
    return { ok: false, reason: 'malformed' };
  }

  const parsed = payload as PurchaseTokenPayload;
  if (nowMs >= parsed.exp) return { ok: false, reason: 'expired' };
  return { ok: true, payload: parsed };
};
