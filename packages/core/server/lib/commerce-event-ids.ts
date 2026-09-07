/**
 * S-01 — ONE purchase id, derived the same way on both sides of the checkout.
 *
 * The browser needs the id of the purchase it is about to make BEFORE the
 * purchase exists (it stamps `commerce_event_id` on `buy_click` and on the
 * purchase `goal`), and the webhook needs the id of the same purchase AFTER
 * Stripe reports it. Two independently minted ids never match, so revenue
 * joins over the tracking sink were empty by construction.
 *
 * Deriving the id from the Checkout Session id — the one identifier both
 * sides hold — makes the two agree without either side telling the other.
 * The same seed always yields the same uuid, which is also what makes the
 * webhook's own event store idempotent under Stripe replays.
 */
import { createHash } from 'node:crypto';

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

/**
 * The purchase's id: what the browser stamps on `buy_click`/`goal` and what
 * the webhook writes as the `checkout_completed` commerce event's `event_id`.
 * Both call THIS — the seed shape is the contract, so it must not be inlined
 * at a call site where it can drift.
 */
export const checkoutCompletedEventId = (sessionId: string): string =>
  deterministicUuid(`${sessionId}:checkout_completed`);
