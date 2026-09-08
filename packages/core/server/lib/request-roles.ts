/**
 * Resolve the acting human's roles for a request (T9.4). Wires the async
 * resolver to the users store for a given Lambda event so callers don't repeat
 * the plumbing. A store read that throws degrades to the env fallback inside
 * the resolver (never denies a bootstrap owner).
 */
import { getAdminStateFromEvent, type LambdaContext, type LambdaEventWithHeaders } from './admin-auth.js';
import { resolveRolesForPrincipalAsync, type Role } from './roles.js';
import { getUsersBlobStore, getUserRecord } from './users-store.js';
import type { Principal } from '../../schema/object-record-v1.js';
import type { SiteBinding } from './site-binding.js';

export const resolveRolesFromEvent = async (
  event: unknown,
  principal: Principal,
  binding?: SiteBinding
): Promise<Role[]> =>
  resolveRolesForPrincipalAsync(principal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event, binding), email),
  });

/**
 * S1 auth-dedupe fix (W15): the single admin-access resolver every admin
 * function should call instead of gating on `getAdminStateFromEvent`'s own
 * `isAdmin` field directly.
 *
 * `getAdminStateFromEvent` (admin-auth.ts) is the OLDER, ADMIN_EMAILS-only
 * check — its `isAdmin` field does not know about the `users` blob store, so
 * a human granted the admin/owner tier ONLY through a store invite (not
 * present in the `ADMIN_EMAILS` env allowlist) was correctly shown the signed-in
 * admin workspace shell by `admin-auth-state.ts` (which already layered the
 * full resolver) but got 403'd by every actual admin function underneath it —
 * a dozen-plus call sites had quietly re-implemented the shallow check instead
 * of sharing one. This wraps `getAdminStateFromEvent` and overwrites `isAdmin`
 * with the resolved role set (env bootstrap owners ∪ store tier), and also
 * returns the full `roles` array so callers that need a finer (e.g. Owner-only)
 * gate don't have to re-resolve it a second time.
 */
export type AdminAccessState = {
  authenticated: boolean;
  isAdmin: boolean;
  email?: string;
  userId?: string;
  error?: string;
  roles: Role[];
};

export const resolveAdminAccessFromEvent = async (
  event: LambdaEventWithHeaders,
  context?: LambdaContext,
  binding?: SiteBinding
): Promise<AdminAccessState> => {
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated || !adminState.email) {
    return { ...adminState, isAdmin: false, roles: [] };
  }

  const roles = await resolveRolesFromEvent(
    event,
    {
      kind: 'human',
      id: adminState.userId ?? '',
      email: adminState.email,
    },
    binding
  );

  return { ...adminState, isAdmin: roles.includes('admin'), roles };
};
