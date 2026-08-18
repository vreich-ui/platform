/**
 * membership_status (W18 T18.7) — one INTERNAL-ONLY MCP read that lets the
 * fleet capability probe (`scripts/fleet-capability-probe.mjs`, `membership`
 * family) prove, per tenant, that the site's `users` store is reachable and
 * which membership policy is in force — without going through the
 * human-gated membership verbs (a bearer-token probe is an agent principal
 * and `membership_requires_human` refuses it by design, T18.6a).
 *
 * Hard rule (same as capability_status): NON-SECRET by construction. It
 * reports reachability, policy provenance, the NAMES of overridden fields and
 * the effective non-secret policy numbers — never a member, an email, a token
 * or a store value.
 *
 * Kept out of `capability-status.ts` on purpose: that report is documented as
 * pure/synchronous/no-I/O, and this one has to read the store.
 */
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { DEFAULT_MEMBERSHIP_POLICY, activeMembershipPolicyBase } from '../../../lib/membership-policy.js';
import { getPolicy } from './write.js';
import { KEYS, getMembershipStore, membershipPolicyOverrideSchema } from './store.js';

export type MembershipStatusReport = {
  site_id: string;
  /** Whether the site's `users` blob store answered a read at all. */
  users_store: 'reachable' | 'unreachable';
  policy: {
    /** Where the effective policy comes from, most specific layer that is non-empty. */
    source: 'default' | 'committed_override' | 'store_override';
    /** Field NAMES the site's committed `config/membership-policy.ts` overrides (values are committed, non-secret). */
    committed_override_keys: string[];
    /** Field NAMES the store's `policy.json` (Owner-set at runtime) overrides. */
    store_override_keys: string[];
    /** The effective non-secret numbers/flags a fleet operator compares across tenants. */
    effective: {
      min_owners: number;
      invite_ttl_hours: number;
      max_resends: number;
      purge_grace_days: number;
      who_can_invite: 'owner' | 'owner_admin';
      require_display_name: boolean;
      delete_identity_on_remove: boolean;
    };
  };
};

const committedOverrideKeys = (): string[] => {
  const base = activeMembershipPolicyBase();
  return (Object.keys(base) as Array<keyof typeof base>)
    .filter((k) => JSON.stringify(base[k]) !== JSON.stringify(DEFAULT_MEMBERSHIP_POLICY[k]))
    .map(String)
    .sort();
};

export const getMembershipStatus = async (event: unknown): Promise<MembershipStatusReport> => {
  const site_id = getSiteIdentity().siteId;
  const committed = committedOverrideKeys();

  let usersStore: MembershipStatusReport['users_store'] = 'unreachable';
  let storeKeys: string[] = [];
  let effective = activeMembershipPolicyBase();
  try {
    const store = await getMembershipStore(event);
    const raw = await store.get(KEYS.policy());
    usersStore = 'reachable';
    if (raw) {
      const parsed = membershipPolicyOverrideSchema.safeParse(JSON.parse(raw));
      if (parsed.success) {
        storeKeys = Object.entries(parsed.data)
          .filter(([, v]) => v !== undefined)
          .map(([k]) => k)
          .sort();
      }
    }
    effective = await getPolicy(store);
  } catch {
    // unreachable: fall through with the committed/default view
  }

  return {
    site_id,
    users_store: usersStore,
    policy: {
      source: storeKeys.length ? 'store_override' : committed.length ? 'committed_override' : 'default',
      committed_override_keys: committed,
      store_override_keys: storeKeys,
      effective: {
        min_owners: effective.min_owners,
        invite_ttl_hours: effective.invite_ttl_hours,
        max_resends: effective.max_resends,
        purge_grace_days: effective.purge_grace_days,
        who_can_invite: effective.who_can_invite,
        require_display_name: effective.require_display_name,
        delete_identity_on_remove: effective.delete_identity_on_remove,
      },
    },
  };
};
