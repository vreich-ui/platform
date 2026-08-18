/**
 * This site's committed membership-policy override (W18 T18.7). The LAW and
 * the defaults live in packages/core/lib/membership-policy.ts
 * (DEFAULT_MEMBERSHIP_POLICY); this file narrows them for 'site_fernwell'.
 * Owners can further override at runtime from the members page / MCP
 * (`membership_policy_set` → the site's `users` store `policy.json`), which
 * layers on top of this. Empty = the fleet defaults (Owner+Admin may invite
 * editor|viewer, min_owners 1, 7-day invites, 30-day purge grace, delete the
 * Identity login on remove).
 */
import type { MembershipPolicyOverride } from '../../../packages/core/lib/membership-policy.js';

export const membershipPolicyConfig = {} satisfies MembershipPolicyOverride;
