/**
 * Cross-site person seam (W18 T18.7, plan §2.2 — person_id convergence).
 *
 * `person_id` is DETERMINISTIC (`personIdForEmail`: `usr_` + base32(sha256(
 * lower-cased email))[:20], store.ts) so the SAME human resolves to the SAME
 * id in every tenant's `users` store without any shared table. That is the
 * whole seam: a future `fleet-admin` surface can list "Wolf: owner on
 * drlurie / platform / fernwell / zilberman" by reading each site's store for
 * `membership/<person_id>.json` — no cross-tenant identity service, no join
 * table, and nothing that contradicts the designed-not-built per-client
 * separation in `13-separation-plan.md` (each site's store stays its own;
 * only the KEY derivation is shared).
 *
 * This module is the minimal, pure, tested code for that seam. There is NO
 * caller yet — by design (T18.7 scope 4). Stores are passed in; this file
 * opens nothing, knows no site list, reads no env.
 */
import { getMembership, getPerson } from './read.js';
import type { Membership, MembershipStore, Person } from './store.js';

/** One site's `users` store, labelled with the site it belongs to. */
export type FleetStoreRef = { site_id: string; store: MembershipStore };

export type FleetMembership = {
  site_id: string;
  membership: Membership;
  /** The person record as THIS site holds it (display name etc. may differ per site — there is no shared person table). */
  person: Person | null;
};

export type FleetMembershipListing = {
  person_id: string;
  memberships: FleetMembership[];
  /** Sites whose store threw (unreachable / no credentials) — reported, never swallowed silently. */
  errors: Array<{ site_id: string; error: string }>;
};

/**
 * Reads `membership/<person_id>.json` (+ the person record) from every store
 * given, in order, and returns the ones that hold a membership for that
 * person. Removed memberships ARE returned (status `removed`) — a fleet view
 * that hid them could not answer "was Wolf ever on zilberman?"; callers
 * filter by status. Sites that hold no membership are simply absent.
 */
export const listMembershipsForPerson = async (
  stores: readonly FleetStoreRef[],
  personId: string
): Promise<FleetMembershipListing> => {
  const memberships: FleetMembership[] = [];
  const errors: FleetMembershipListing['errors'] = [];
  for (const { site_id, store } of stores) {
    try {
      const membership = await getMembership(store, personId);
      if (!membership) continue;
      const person = await getPerson(store, personId);
      memberships.push({ site_id, membership, person });
    } catch (error) {
      errors.push({ site_id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { person_id: personId, memberships, errors };
};
