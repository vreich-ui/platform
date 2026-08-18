import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import { environmentRoleForEmail, isOwner } from '../lib/roles.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import { ensureDefaultMembershipOnLogin } from '../lib/membership/invitations.js';

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
  body: JSON.stringify(body),
});

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET' && event.httpMethod !== 'POST') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // T9.4/S1: resolve the full workspace tier via the shared admin-access
  // resolver (users store + ADMIN_EMAILS bootstrap owners) — the SAME
  // resolver every admin function now gates on (request-roles.ts), so this
  // display endpoint can never disagree with what the functions underneath
  // it actually enforce. Still read-only display info; publish-gate.ts is
  // the sole enforcement point for publishing.
  let adminState = await resolveAdminAccessFromEvent(event, context);

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
    const store = await getUsersBlobStore(event);
    const defaulted = await ensureDefaultMembershipOnLogin(
      store,
      adminState.email,
      adminState.userId,
      new Date().toISOString()
    ).catch(() => null);
    if (defaulted) {
      adminState = await resolveAdminAccessFromEvent(event, context);
    }
  }

  const tier = isOwner(adminState.roles) ? 'owner' : adminState.roles.includes('admin') ? 'admin' : null;

  return jsonResponse(200, {
    authenticated: adminState.authenticated,
    isAdmin: adminState.isAdmin,
    tier,
    email: adminState.email,
    userId: adminState.userId,
    error: adminState.error,
    roles: adminState.roles,
  });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
