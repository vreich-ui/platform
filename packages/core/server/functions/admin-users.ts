/**
 * Function name: Admin_Users
 * Required method: POST
 * Auth: Netlify Identity. Verbs: me / update_me (self, any admin);
 *       list / set_role / suspend (alias: disable) / reinstate /
 *       promote_bootstrap (Owner). Invite is T9.5.
 *       T18.0a: invite_preview (PUBLIC, no auth) and accept (any
 *       authenticated Identity user — the fresh JWT GoTrue's /verify returned;
 *       no role gate, because an invitee has no roles yet).
 *       T18.1: the store behind every verb is membership v2 (person +
 *       membership + audit stream) read/written through the users-store
 *       adapter; five tiers; the `last_owner` guard (409) on set_role/suspend.
 *
 * The workspace identity surface (T9.4). Roles are resolved server-side via
 * the async resolver (users store + ADMIN_EMAILS bootstrap owners); owner-only
 * verbs 403 for a non-owner. Every mutation appends to the member's audit array.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { z } from 'zod';

import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import {
  environmentRoleEntries,
  environmentRoleForEmail,
  resolveRolesForPrincipalAsync,
  isOwner,
  type Role,
  type RoleEnv,
} from '../lib/roles.js';
import {
  getUsersBlobStore,
  getUserRecord,
  putUserRecord,
  listUserRecords,
  normalizeUserEmail,
  userRoleSchema,
  type UserRecord,
  type UsersBlobStore,
} from '../lib/users-store.js';
import { MAJOR_KEY_ARTIFACT_REF_RE } from '../lib/artifact-trust.js';
import {
  InvitationError,
  acceptInvitation,
  activateOnLogin,
  assertMayInvite,
  createInvitation,
  listInvitations,
  listUnmanagedIdentities,
  previewInvitationByToken,
  resendInvitation,
  revokeInvitation,
  type GoTrueIdentity,
} from '../lib/membership/invitations.js';
import { newMember, saveMember } from '../lib/membership/write.js';
import {
  appendAudit,
  getPolicy,
  listAuditForEmail,
  removeMembership,
  stampOnboarding,
  wouldBreachMinOwners,
} from '../lib/membership/write.js';
import { auditActorFromPrincipal, personIdForEmail } from '../lib/membership/store.js';
import type { Principal } from '../../schema/object-record-v1.js';
import { friendlyNameFromEmail } from '../../lib/admin/display-name.js';
import { getSiteIdentity } from '../../lib/site-identity.js';

/** T18.0a: the accept page's password policy (mirrors GoTrue's default minimum). */
export const ACCEPT_MIN_PASSWORD = 8;

/** An avatar must be an uploaded IMAGE artifact reference, not a URL/data URI. */
export const isTrustedAvatarRef = (ref: string): boolean =>
  ref.startsWith('image/') && MAJOR_KEY_ARTIFACT_REF_RE.test(ref);

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

const requestSchema = z.discriminatedUnion('verb', [
  z.object({ verb: z.literal('me') }),
  z.object({
    verb: z.literal('update_me'),
    display_name: z.string().min(1).max(200).optional(),
    avatar_artifact: z.string().min(1).optional(),
  }),
  z.object({ verb: z.literal('list'), include_removed: z.boolean().optional() }),
  z.object({
    verb: z.literal('invite'),
    email: z.string().min(3),
    role: userRoleSchema,
    message: z.string().max(1000).optional(),
  }),
  // T18.2 — invitations are first-class
  z.object({ verb: z.literal('resend'), invite_id: z.string().min(1).optional(), email: z.string().min(3).optional() }),
  z.object({
    verb: z.literal('revoke'),
    invite_id: z.string().min(1).optional(),
    email: z.string().min(3).optional(),
    reason: z.string().max(500).optional(),
  }),
  z.object({
    verb: z.literal('list_invitations'),
    status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional(),
  }),
  z.object({ verb: z.literal('unmanaged_identities') }),
  // Owner grants a role to a Netlify-UI identity that has no membership (plan §4.2 "Grant role").
  z.object({
    verb: z.literal('grant'),
    email: z.string().min(3),
    role: userRoleSchema,
    user_id: z.string().optional(),
  }),
  z.object({ verb: z.literal('set_role'), email: z.string().min(3), role: userRoleSchema }),
  // T18.1: `suspend` is the verb; `disable` stays as an alias for one release (T18.8 removes it).
  z.object({ verb: z.literal('suspend'), email: z.string().min(3), reason: z.string().max(500).optional() }),
  z.object({ verb: z.literal('disable'), email: z.string().min(3), reason: z.string().max(500).optional() }),
  z.object({ verb: z.literal('reinstate'), email: z.string().min(3) }),
  // T18.3a: remove (membership → removed{purge_after}; T18.4 adds identity/OAuth/lock side effects)
  z.object({ verb: z.literal('remove'), email: z.string().min(3), reason: z.string().max(500).optional() }),
  // T18.3a: the audit stream for one person (Owner-only)
  z.object({
    verb: z.literal('member_audit'),
    email: z.string().min(3),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  // T18.1: materialise a stored Owner membership for an ADMIN_EMAILS member so
  // the env row can later be emptied (plan §4.3 / F10).
  z.object({ verb: z.literal('promote_bootstrap'), email: z.string().min(3) }),
  // T18.0a — the accept page's two verbs. `token` is accepted but NOT
  // validated: only GoTrue can validate an invite token, and an unauthenticated
  // request has no admin token to ask with. See the verb handler comment.
  z.object({ verb: z.literal('invite_preview'), token: z.string().optional(), inv: z.string().optional() }),
  z.object({ verb: z.literal('accept'), display_name: z.string().min(1).max(200) }),
]);

const safeJsonParse = (event: LambdaEvent): { ok: true; value: unknown } | { ok: false } => {
  if (!event.body) return { ok: false };
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false };
  }
};

const nowIso = () => new Date().toISOString();

/** A read-only view for a caller with no stored record yet (e.g. a bootstrap owner's first login). */
const synthesizedRecord = (email: string, owner: boolean, ts = nowIso()): UserRecord => {
  return {
    schema_version: 1,
    email,
    // D3 (2026-08-06): a friendly default, not the raw email — this only
    // ever runs when NO record exists yet (first login before any
    // update_me), so it can never clobber a display name a user set
    // (getUserRecord/`existing` short-circuits this call once one exists).
    display_name: friendlyNameFromEmail(email),
    role: owner ? 'owner' : 'admin',
    status: 'active',
    invited_by: 'bootstrap',
    created_at: ts,
    updated_at: ts,
    audit: [],
  };
};

export interface ListedUser extends Omit<UserRecord, 'role'> {
  role: Role;
  source: 'stored' | 'environment';
}

/** Merge every real access principal into the Owner-visible list without exposing env metadata. */
export const listUsersWithEnvironment = async (
  store: UsersBlobStore,
  env: RoleEnv = process.env as RoleEnv
): Promise<ListedUser[]> => {
  const rows = new Map<string, ListedUser>();
  for (const record of await listUserRecords(store)) {
    rows.set(normalizeUserEmail(record.email), { ...record, source: 'stored' });
  }

  for (const [email, environmentRole] of environmentRoleEntries(env)) {
    const stored = rows.get(email);
    if (stored) {
      rows.set(email, {
        ...stored,
        // ADMIN_EMAILS is the one environment grant that deliberately beats
        // the store. Other environment roles retain the stored-role precedence.
        role: environmentRole === 'owner' ? 'owner' : stored.role,
        source: 'environment',
      });
      continue;
    }

    const record = synthesizedRecord(email, environmentRole === 'owner');
    rows.set(email, {
      ...record,
      role: environmentRole,
      invited_by: 'environment',
      source: 'environment',
    });
  }

  return [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
};

const handlerImpl = async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });

  // T18.0a: `invite_preview` is PUBLIC — the accept page calls it before the
  // invitee has any session. It is answered before auth and before the store
  // is opened, and returns nothing user-specific. Limitation, by design: the
  // GoTrue invite token cannot be validated here (only GoTrue can, and an
  // unauthenticated request carries no admin token to ask with), so `token`
  // is accepted and ignored; the page shows the e-mail AFTER GoTrue accepts,
  // from the new session's `/user`.
  const parsed = safeJsonParse(event);
  if (parsed.ok) {
    const peek = parsed.value as { verb?: unknown } | null;
    if (peek && typeof peek === 'object' && peek.verb === 'invite_preview') {
      const request = requestSchema.safeParse(parsed.value);
      if (!request.success) {
        return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });
      }
      const identity = getSiteIdentity();
      // T18.2 path 2: an Owner-shared link may carry OUR accept token (`inv`),
      // which previews inviter/role before GoTrue accepts. Optional sugar.
      let invitation: Record<string, unknown> | undefined;
      const inv = request.data.verb === 'invite_preview' ? request.data.inv : undefined;
      if (inv) {
        try {
          const preview = await previewInvitationByToken(await getUsersBlobStore(event), inv);
          if (preview) invitation = preview;
        } catch {
          invitation = undefined;
        }
      }
      return jsonResponse(200, {
        site: { name: identity.brandName, slug: identity.siteSlug },
        policy: { min_password: ACCEPT_MIN_PASSWORD },
        ...(invitation ? { invitation } : {}),
      });
    }
  }

  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const email = normalizeUserEmail(adminState.email ?? '');
  if (!email) return jsonResponse(403, { error: 'A verified email is required.' });
  const principal: Principal = { kind: 'human', id: adminState.userId ?? '', email };

  if (!parsed.ok) return jsonResponse(400, { error: 'Invalid request body.' });
  const request = requestSchema.safeParse(parsed.value);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  try {
    const store = await getUsersBlobStore(event);

    // T18.0a: `accept` runs on the fresh JWT GoTrue's /verify returned. It is
    // authenticated (verified e-mail from the token) but NOT role-gated: an
    // invitee's roles come from the very record this verb activates, and a
    // Netlify-UI invitee has no record (and no roles) at all. Uses the
    // caller's verified e-mail — never a body-supplied one.
    if (request.data.verb === 'accept') {
      const at = nowIso();
      const accepted = await acceptInvitation(store, email, adminState.userId, request.data.display_name, at);
      if (accepted) {
        if (accepted.status === 'disabled') return jsonResponse(403, { error: 'This membership is disabled.' });
        // T18.1/T18.2: acceptInvitation stamped onboarding (password + name),
        // closed the pending invitation and wrote the audit event.
        return jsonResponse(200, { user: accepted, needs_grant: false });
      }
      if (environmentRoleForEmail(email) === 'owner') {
        // Bootstrap ADMIN_EMAILS caller: the existing `me` materialization,
        // unchanged (plus the name they just typed).
        const bootstrapOwner: UserRecord = {
          ...synthesizedRecord(email, true, at),
          display_name: request.data.display_name,
          user_id: adminState.userId,
          last_seen_at: at,
          audit: [{ at, actor_email: email, action: 'bootstrap_activate' }],
        };
        await putUserRecord(store, bootstrapOwner);
        return jsonResponse(200, { user: bootstrapOwner, bootstrap: true, needs_grant: false });
      }
      // No record: invited from the Netlify UI (plan §4.2). Create nothing,
      // grant nothing — the layout shows "Ask an Owner to grant you a role"
      // (T18.0b renders it; T18.2 turns it into the unmanaged-identity flow).
      return jsonResponse(200, { user: null, needs_grant: true });
    }

    const roles = await resolveRolesForPrincipalAsync(principal, {
      getUserRecord: (e) => getUserRecord(store, e),
    });
    if (!roles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });
    const owner = isOwner(roles);

    const req = request.data;
    switch (req.verb) {
      case 'invite_preview':
        // Answered above, before auth (and `accept` is narrowed out above);
        // unreachable — kept so the switch stays exhaustive.
        return jsonResponse(400, { error: 'Invalid request fields.' });

      case 'me': {
        // T9.5/T9.6: first-login activation (invited → active + stamp user_id)
        // and last_seen on every self-read. Materialize a missing bootstrap
        // Owner deliberately so the members list reflects their real access.
        const at = nowIso();
        const activated = await activateOnLogin(store, email, adminState.userId, at);
        if (activated) {
          await appendAudit(store, {
            at,
            actor: auditActorFromPrincipal(principal),
            action:
              activated.status === 'active' && activated.audit.at(-1)?.action === 'activate'
                ? 'membership.activate'
                : 'person.login',
            target: { person_id: activated.person_id ?? personIdForEmail(email), email },
            via: 'admin_ui',
          }).catch(() => undefined);
        }
        if (!activated && environmentRoleForEmail(email) === 'owner') {
          const bootstrapOwner: UserRecord = {
            ...synthesizedRecord(email, true, at),
            user_id: adminState.userId,
            last_seen_at: at,
            audit: [{ at, actor_email: email, action: 'bootstrap_activate' }],
          };
          await putUserRecord(store, bootstrapOwner);
          return jsonResponse(200, { user: bootstrapOwner, bootstrap: true, roles });
        }
        return jsonResponse(200, {
          user: activated ?? synthesizedRecord(email, owner),
          bootstrap: !activated,
          roles,
        });
      }

      case 'update_me': {
        // T9.6: an avatar must be an uploaded image artifact reference
        // (image/<id>/<sha256>.<ext>) — never an arbitrary URL or data URI.
        if (req.avatar_artifact !== undefined && !isTrustedAvatarRef(req.avatar_artifact)) {
          return jsonResponse(400, {
            error: 'Avatar must be an uploaded image artifact reference, not a URL.',
          });
        }
        const base = (await getUserRecord(store, email)) ?? synthesizedRecord(email, owner);
        const updated: UserRecord = {
          ...base,
          display_name: req.display_name ?? base.display_name,
          avatar_artifact: req.avatar_artifact ?? base.avatar_artifact,
          updated_at: nowIso(),
          last_seen_at: nowIso(),
          audit: [...base.audit, { at: nowIso(), actor_email: email, action: 'update_profile' }],
        };
        await putUserRecord(store, updated);
        if (req.display_name) {
          await stampOnboarding(store, email, { steps: { name: nowIso() }, at: nowIso() }).catch(() => undefined);
        }
        await appendAudit(store, {
          at: nowIso(),
          actor: auditActorFromPrincipal(principal),
          action: 'person.update_profile',
          target: { person_id: updated.person_id ?? personIdForEmail(email), email },
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: (await getUserRecord(store, email)) ?? updated });
      }

      case 'list': {
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        const users = await listUsersWithEnvironment(store);
        // T18.1: `removed` memberships stay for audit/attribution but leave the
        // default members list; `include_removed:true` shows them.
        return jsonResponse(200, {
          users: req.include_removed ? users : users.filter((u) => u.membership_status !== 'removed'),
        });
      }

      case 'invite':
      case 'resend':
      case 'revoke':
      case 'list_invitations':
      case 'unmanaged_identities':
      case 'grant': {
        // T18.2: Owner-only except `invite`, which policy.who_can_invite may
        // open to Admins for the roles in policy.roles_admin_may_grant.
        const identity = (context as { clientContext?: { identity?: GoTrueIdentity } } | undefined)?.clientContext
          ?.identity;
        const fetchImpl = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) =>
          fetch(url, init);
        const at = nowIso();
        const actor = auditActorFromPrincipal(principal);
        try {
          if (req.verb === 'invite') {
            const policy = await getPolicy(store);
            assertMayInvite({ actorRoles: roles, role: req.role, policy });
            if (environmentRoleForEmail(req.email)) {
              return jsonResponse(409, {
                error: 'This member is configured in site environment variables and cannot be changed here.',
                error_code: 'env_managed_member',
              });
            }
            const result = await createInvitation(store, {
              email: req.email,
              role: req.role,
              invitedBy: { person_id: personIdForEmail(email), email },
              actor,
              at,
              ...(req.message ? { message: req.message } : {}),
              identity,
              fetchImpl,
            });
            return jsonResponse(200, {
              user: result.user,
              invite: result.invite,
              invitation: result.invitation,
              accept_token: result.accept_token,
            });
          }
          if (!owner) return jsonResponse(403, { error: 'Owner access required' });
          if (req.verb === 'resend') {
            const result = await resendInvitation(store, {
              invite_id: req.invite_id,
              email: req.email,
              actor,
              actorEmail: email,
              at,
              identity,
              fetchImpl,
            });
            return jsonResponse(200, {
              invitation: result.invitation,
              invite: result.invite,
              accept_token: result.accept_token,
            });
          }
          if (req.verb === 'revoke') {
            const result = await revokeInvitation(store, {
              invite_id: req.invite_id,
              email: req.email,
              actor,
              actorEmail: email,
              at,
              reason: req.reason,
            });
            return jsonResponse(200, { invitation: result.invitation, membership: result.membership });
          }
          if (req.verb === 'list_invitations') {
            return jsonResponse(200, { invitations: await listInvitations(store, { status: req.status, now: at }) });
          }
          if (req.verb === 'unmanaged_identities') {
            const result = await listUnmanagedIdentities({ store, identity, fetchImpl });
            return jsonResponse(200, result);
          }
          // grant: a Netlify-UI identity (no membership) gets an ACTIVE membership at the given role.
          const target = normalizeUserEmail(req.email);
          if (environmentRoleForEmail(target)) {
            return jsonResponse(409, {
              error: 'This member is configured in site environment variables and cannot be changed here.',
              error_code: 'env_managed_member',
            });
          }
          const existing = await getUserRecord(store, target);
          if (existing && existing.membership_status !== 'removed') {
            return jsonResponse(409, {
              error: 'This person already has a membership. Change their role instead.',
              error_code: 'member_exists',
            });
          }
          const granted = newMember({
            email: target,
            display_name: existing?.display_name ?? friendlyNameFromEmail(target),
            role: req.role,
            status: 'active',
            source: 'netlify_ui',
            granted_by: { kind: 'human', person_id: personIdForEmail(email), email },
            invited_by: email,
            at,
            user_id: req.user_id,
            audit: [
              ...(existing?.audit ?? []),
              { at, actor_email: email, action: 'grant', detail: `role ${req.role}` },
            ],
          });
          await saveMember(store, granted);
          await appendAudit(store, {
            at,
            actor,
            action: 'membership.grant',
            target: { person_id: granted.person.person_id, email: target },
            detail: { role: req.role, source: 'netlify_ui' },
            via: 'admin_ui',
          }).catch(() => undefined);
          return jsonResponse(200, { user: await getUserRecord(store, target) });
        } catch (error) {
          if (error instanceof InvitationError) {
            return jsonResponse(error.status, { error: error.message, error_code: error.code, ...error.extra });
          }
          throw error;
        }
      }

      case 'promote_bootstrap': {
        // T18.1 (plan §4.3, F10): give an ADMIN_EMAILS member a STORED Owner
        // membership so the env row can be emptied later. Owner-only; the
        // target must be an env Owner; idempotent when a stored owner exists.
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        const target = normalizeUserEmail(req.email);
        if (environmentRoleForEmail(target) !== 'owner') {
          return jsonResponse(409, {
            error: 'Only an ADMIN_EMAILS (bootstrap) member can be promoted to a stored Owner.',
          });
        }
        const at = nowIso();
        const stored = await getUserRecord(store, target);
        const promoted: UserRecord = stored
          ? {
              ...stored,
              role: 'owner',
              status: 'active',
              updated_at: at,
              audit: [
                ...stored.audit,
                {
                  at,
                  actor_email: email,
                  action: 'promote_bootstrap',
                  detail: `${stored.role}/${stored.status} → owner/active`,
                },
              ],
            }
          : {
              ...synthesizedRecord(target, true, at),
              audit: [{ at, actor_email: email, action: 'promote_bootstrap', detail: 'env → stored owner' }],
            };
        await putUserRecord(store, promoted);
        await appendAudit(store, {
          at,
          actor: auditActorFromPrincipal(principal),
          action: 'membership.promote_bootstrap',
          target: { person_id: personIdForEmail(target), email: target },
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: await getUserRecord(store, target) });
      }

      case 'member_audit': {
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        const target = normalizeUserEmail(req.email);
        const stored = await getUserRecord(store, target);
        return jsonResponse(200, {
          email: target,
          events: await listAuditForEmail(store, target, req.limit ?? 100),
          legacy_audit: stored?.audit ?? [],
        });
      }

      case 'remove': {
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        const target = normalizeUserEmail(req.email);
        if (target === email) return jsonResponse(409, { error: 'You cannot remove yourself.' });
        if (environmentRoleForEmail(target)) {
          return jsonResponse(409, {
            error: 'This member is configured in site environment variables and cannot be changed here.',
            error_code: 'env_managed_member',
          });
        }
        const stored = await getUserRecord(store, target);
        if (!stored) return jsonResponse(404, { error: 'No such member.' });
        const at = nowIso();
        if (stored.role === 'owner' && stored.status === 'active') {
          const policy = await getPolicy(store);
          const envOwners = environmentRoleEntries().filter(([, role]) => role === 'owner').length;
          if (
            await wouldBreachMinOwners(store, {
              exceptPersonId: stored.person_id ?? personIdForEmail(target),
              envOwnerCount: envOwners,
              minOwners: policy.min_owners,
            })
          ) {
            return jsonResponse(409, {
              error: 'This is the last Owner. Promote another member to Owner first.',
              error_code: 'last_owner',
            });
          }
        }
        const policy = await getPolicy(store);
        // a pending invitation is revoked alongside
        try {
          await revokeInvitation(store, {
            email: target,
            actor: auditActorFromPrincipal(principal),
            actorEmail: email,
            at,
            reason: req.reason ?? 'member removed',
          });
        } catch {
          // no open invitation — fine
        }
        await removeMembership(store, {
          email: target,
          actorEmail: email,
          at,
          reason: req.reason,
          purgeGraceDays: policy.purge_grace_days,
        });
        await appendAudit(store, {
          at,
          actor: auditActorFromPrincipal(principal),
          action: 'membership.remove',
          target: { person_id: stored.person_id ?? personIdForEmail(target), email: target },
          ...(req.reason ? { detail: { reason: req.reason } } : {}),
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: await getUserRecord(store, target) });
      }

      case 'set_role':
      case 'suspend':
      case 'disable':
      case 'reinstate': {
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        const target = normalizeUserEmail(req.email);
        if (target === email) {
          return jsonResponse(409, { error: 'You cannot change your own role or status.' });
        }
        if (environmentRoleForEmail(target)) {
          return jsonResponse(409, {
            error: 'This member is configured in site environment variables and cannot be changed here.',
          });
        }
        const stored = await getUserRecord(store, target);
        if (!stored) {
          return jsonResponse(404, { error: 'No such member. Invite them first.' });
        }
        const at = nowIso();
        const verb = req.verb === 'disable' ? 'suspend' : req.verb;

        // T18.1 `last_owner` guard: demoting or suspending an active stored
        // Owner must not leave fewer than policy.min_owners owners (stored
        // active + ADMIN_EMAILS bootstrap owners).
        const wouldLoseOwner =
          stored.role === 'owner' &&
          stored.status === 'active' &&
          ((verb === 'set_role' && req.verb === 'set_role' && req.role !== 'owner') || verb === 'suspend');
        if (wouldLoseOwner) {
          const policy = await getPolicy(store);
          const envOwners = environmentRoleEntries().filter(([, role]) => role === 'owner').length;
          const breach = await wouldBreachMinOwners(store, {
            exceptPersonId: stored.person_id ?? personIdForEmail(target),
            envOwnerCount: envOwners,
            minOwners: policy.min_owners,
          });
          if (breach) {
            return jsonResponse(409, {
              error: 'This is the last Owner. Promote another member to Owner first.',
              error_code: 'last_owner',
            });
          }
        }

        let updated: UserRecord;
        let auditAction: 'membership.role_change' | 'membership.suspend' | 'membership.reinstate';
        if (verb === 'set_role' && req.verb === 'set_role') {
          updated = {
            ...stored,
            role: req.role,
            updated_at: at,
            audit: [
              ...stored.audit,
              { at, actor_email: email, action: 'set_role', detail: `${stored.role} → ${req.role}` },
            ],
          };
          auditAction = 'membership.role_change';
        } else if (verb === 'suspend') {
          const reason = req.verb === 'suspend' || req.verb === 'disable' ? req.reason : undefined;
          updated = {
            ...stored,
            status: 'disabled',
            updated_at: at,
            audit: [
              ...stored.audit,
              { at, actor_email: email, action: 'suspend', ...(reason ? { detail: reason } : {}) },
            ],
          };
          auditAction = 'membership.suspend';
        } else {
          if (stored.membership_status === 'removed') {
            return jsonResponse(409, { error: 'This member was removed. Re-invite them instead.' });
          }
          if (stored.status !== 'disabled') return jsonResponse(200, { user: stored });
          updated = {
            ...stored,
            status: 'active',
            updated_at: at,
            audit: [...stored.audit, { at, actor_email: email, action: 'reinstate' }],
          };
          auditAction = 'membership.reinstate';
        }
        await putUserRecord(store, updated);
        await appendAudit(store, {
          at,
          actor: auditActorFromPrincipal(principal),
          action: auditAction,
          target: { person_id: stored.person_id ?? personIdForEmail(target), email: target },
          ...(verb === 'set_role' && req.verb === 'set_role' ? { detail: { from: stored.role, to: req.role } } : {}),
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: await getUserRecord(store, target) });
      }
    }
  } catch (error) {
    console.error('Admin_Users request failed.', error);
    return jsonResponse(500, { error: 'User request could not be processed.' });
  }
};

// Re-export for tests that exercise the store surface directly.
export type { UsersBlobStore };

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (_binding: SiteBinding) => handlerImpl;
