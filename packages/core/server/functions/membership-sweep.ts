/**
 * Function name: Membership_Sweep (W18 T18.4) — scheduled, daily.
 *
 * Three housekeeping passes over the site's `users` store:
 *   1. expire stale invitations (`expireAll`, T18.2 — the same lazy expiry every
 *      read applies, run once so the Invitations tab is right even when nobody
 *      opened it),
 *   2. purge `removed` memberships past `purge_after` (`purgeExpiredMemberships`
 *      — PII scrubbed, audit kept),
 *   3. report the identity-delete queue. A scheduled invocation carries NO
 *      Identity JWT, so Netlify injects NO admin token, so GoTrue deletes
 *      cannot run here — they are queued by remove/purge and drained by the
 *      next Owner request that has a token (`drainIdentityDeleteQueue` in
 *      admin-users). This function only logs how many are waiting.
 *
 * Idempotent: a second run the same day does nothing. Declared per site in
 * netlify.toml (`[functions."membership-sweep"] schedule = "17 3 * * *"`) — a
 * scheduled function only runs if its schedule is DECLARED (P1: every
 * `sites/<client>/netlify.toml` carries the block; the parity audit checks).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getMembershipStore } from '../lib/membership/store.js';
import { expireAll } from '../lib/membership/invitations.js';
import { purgeExpiredMemberships } from '../lib/membership/offboarding.js';

export const runMembershipSweep = async (event: unknown, now = new Date().toISOString()) => {
  const store = await getMembershipStore(event);
  const expired = await expireAll(store, now);
  const purged = await purgeExpiredMemberships(store, { now });
  const queued = await store
    .list({ prefix: 'identity-delete-queue/', directories: false, paginate: true })
    .then((r) => (r.blobs ?? []).length)
    .catch(() => 0);
  return { ok: true, at: now, expired_invitations: expired, purged_persons: purged, identity_deletes_queued: queued };
};

const buildHandlerImpl = (_binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runMembershipSweep(event);
    console.log(JSON.stringify({ ts: result.at, event: 'membership_sweep', ...result }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Membership sweep failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
