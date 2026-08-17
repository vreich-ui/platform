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
import { inviteUser, activateOnLogin, acceptInvitation, type GoTrueIdentity } from '../lib/user-invite.js';
import { appendAudit, getPolicy, stampOnboarding, wouldBreachMinOwners } from '../lib/membership/write.js';
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
  z.object({ verb: z.literal('invite'), email: z.string().min(3), role: userRoleSchema }),
  z.object({ verb: z.literal('set_role'), email: z.string().min(3), role: userRoleSchema }),
  // T18.1: `suspend` is the verb; `disable` stays as an alias for one release (T18.8 removes it).
  z.object({ verb: z.literal('suspend'), email: z.string().min(3), reason: z.string().max(500).optional() }),
  z.object({ verb: z.literal('disable'), email: z.string().min(3), reason: z.string().max(500).optional() }),
  z.object({ verb: z.literal('reinstate'), email: z.string().min(3) }),
  // T18.1: materialise a stored Owner membership for an ADMIN_EMAILS member so
  // the env row can later be emptied (plan §4.3 / F10).
  z.object({ verb: z.literal('promote_bootstrap'), email: z.string().min(3) }),
  // T18.0a — the accept page's two verbs. `token` is accepted but NOT
  // validated: only GoTrue can validate an invite token, and an unauthenticated
  // request has no admin token to ask with. See the verb handler comment.
  z.object({ verb: z.literal('invite_preview'), token: z.string().optional() }),
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
      return jsonResponse(200, {
        site: { name: identity.brandName, slug: identity.siteSlug },
        policy: { min_password: ACCEPT_MIN_PASSWORD },
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
        // T18.1: the accept page collected a password (GoTrue) and a name — stamp both onboarding steps.
        await stampOnboarding(store, email, { steps: { password: at, name: at }, at }).catch(() => undefined);
        await appendAudit(store, {
          at,
          actor: auditActorFromPrincipal(principal),
          action: 'invitation.accept',
          target: { person_id: accepted.person_id ?? personIdForEmail(email), email },
          via: 'admin_ui',
        }).catch(() => undefined);
        return jsonResponse(200, { user: (await getUserRecord(store, email)) ?? accepted, needs_grant: false });
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

      case 'invite': {
        if (!owner) return jsonResponse(403, { error: 'Owner access required' });
        if (environmentRoleForEmail(req.email)) {
          return jsonResponse(409, {
            error: 'This member is configured in site environment variables and cannot be changed here.',
          });
        }
        const identity = (context as { clientContext?: { identity?: GoTrueIdentity } } | undefined)?.clientContext
          ?.identity;
        const result = await inviteUser({
          store,
          email: req.email,
          role: req.role,
          invitedBy: email,
          at: nowIso(),
          identity,
          fetchImpl: (url, init) => fetch(url, init),
        });
        return jsonResponse(200, { user: result.record, invite: result.invite });
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
