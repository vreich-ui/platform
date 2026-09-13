import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent, type AdminAccessState } from '../lib/request-roles.js';
import { environmentRoleForEmail, isOwner } from '../lib/roles.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import { ensureDefaultMembershipOnLogin } from '../lib/membership/invitations.js';
import { timeAuth, timeSerialize, withServerTiming } from '../lib/server-timing.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
};

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
};

const jsonResponse = (statusCode: number, body: Record<string, unknown>) => ({
  statusCode,
  headers: jsonHeaders,
  body: timeSerialize(() => JSON.stringify(body)),
});

/** The display payload this endpoint answers with — and `admin-shell.ts`'s `access` section, byte for byte. */
export interface AdminAccessStatePayload {
  authenticated: boolean;
  isAdmin: boolean;
  tier: 'owner' | 'admin' | null;
  email?: string;
  userId?: string;
  error?: string;
  roles: string[];
}

/**
 * Resolve the caller's access ONCE and return both the wire payload and the
 * resolved state behind it.
 *
 * The second half of that pair is the whole point: `admin-shell.ts` gates its
 * requests and `me` sections on the SAME `AdminAccessState` this produced, so
 * a coalesced navigation resolves auth once instead of three times. Measured
 * 2026-09-13: this endpoint does 0.02 ms of work and costs 242-683 ms on the
 * wire, so three resolutions were never three auth costs — they were three
 * round trips. Sharing the state is what removes two of them.
 *
 * Exported rather than inlined so the defaulting below (a WRITE on some
 * logins) lives in exactly one place and cannot drift between the two
 * callers.
 */
export const resolveAdminAccessSection = async (
  event: LambdaEvent,
  context: LambdaContext | undefined,
  binding: SiteBinding
): Promise<{ payload: AdminAccessStatePayload; adminState: AdminAccessState }> => {
  // T9.4/S1: resolve the full workspace tier via the shared admin-access
  // resolver (users store + ADMIN_EMAILS bootstrap owners) — the SAME
  // resolver every admin function now gates on (request-roles.ts), so this
  // display endpoint can never disagree with what the functions underneath
  // it actually enforce. Still read-only display info; publish-gate.ts is
  // the sole enforcement point for publishing.
  let adminState = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));

  // Wolf 2026-08-18: a signed-in human who resolves to NO role from any
  // source (not a bootstrap Owner, not on a ROLE_EMAILS_* allowlist, no
  // stored membership) used to sit here forever — nothing ever created their
  // record, so the /admin gate showed a dead end with no way out (F9). Give
  // every such login a real, visible tier the first time it's checked here:
  // default them to policy.default_role_for_external (today 'viewer' —
  // read-only; `isAdmin` below is `roles.includes('admin')`, which 'viewer'
  // never satisfies, so this alone never opens the workspace). The env check
  // guards bootstrap Owners and ROLE_EMAILS_* principals, who must never be
  // shadowed by a stored 'viewer' record — see ensureDefaultMembershipOnLogin.
  if (
    adminState.authenticated &&
    adminState.email &&
    adminState.roles.length === 0 &&
    !environmentRoleForEmail(adminState.email)
  ) {
    const store = await getUsersBlobStore(event, binding);
    const defaulted = await ensureDefaultMembershipOnLogin(
      store,
      adminState.email,
      adminState.userId,
      new Date().toISOString()
    ).catch(() => null);
    if (defaulted) {
      adminState = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    }
  }

  const tier = isOwner(adminState.roles) ? 'owner' : adminState.roles.includes('admin') ? 'admin' : null;

  return {
    payload: {
      authenticated: adminState.authenticated,
      isAdmin: adminState.isAdmin,
      tier,
      email: adminState.email,
      userId: adminState.userId,
      error: adminState.error,
      roles: adminState.roles,
    },
    adminState,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }
  const { payload } = await resolveAdminAccessSection(event, context, binding);
  return jsonResponse(200, { ...payload });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding.
 *  T0.1: Server-Timing wrap — this is one of the shell trio investigated for
 *  the 445 ms -> 5164 ms cold-start-vs-contention question. */
export const createHandler = (binding: SiteBinding) => withServerTiming('admin-auth-state', buildHandlerImpl(binding));
