/**
 * `handleMembershipVerb` (W18 T18.6a, plan §7, F4) — ONE membership verb core
 * behind three front doors: the `admin-users` function (UI, `via:'admin_ui'`),
 * the `/mcp` tools (`via:'mcp'`, T18.6b) and the admin-chat tools
 * (`via:'chat'`, T18.6b). Mirrors `handleObjectVerb`: typed verb + args in,
 * principal in, `{ status, body }` out; the function/tool layers only
 * authenticate, build the principal, and serialise.
 *
 * ── THE GATE (brief T18.6a; the same class of boundary as publish-gate) ──
 * The FIRST line of the function refuses every non-human principal with
 * `403 membership_requires_human` — before any store read, before argument
 * parsing. The shared `MCP_HTTP_AUTH_TOKEN`, a self-declared or verified
 * `agent_name`, a chat run without a captured human: all `kind:'agent'`, all
 * refused, for `list` as much as for `purge`. Only a verified human — an admin
 * Identity JWT, or an OAuth principal bound to a Netlify Identity human — may
 * call anything here, and their tier is then re-resolved from the store on
 * every call (`resolveRolesForPrincipalAsync`: ADMIN_EMAILS → owner, stored
 * membership, suspended/removed → []). Every mutation lands an AuditEvent
 * carrying `via`, the actor, and `request_id` when the caller has one.
 *
 * Tier rule (plan §6/§7): `owner` for everything except `list`/`get`/
 * `audit`/`contract`/`policy_get` (admin) and `invite` (admin may invite the
 * roles `policy.roles_admin_may_grant` when `policy.who_can_invite ===
 * 'owner_admin'`). `dry_run:true` on invite / set_role / remove /
 * transfer_ownership returns the would-be effect and persists nothing.
 *
 * `me` / `update_me` / `accept` / `invite_preview` are SESSION verbs and stay
 * in `functions/admin-users.ts` — they act on the caller's own record with
 * different auth shapes (public / not-role-gated) and are not part of the
 * tool surface.
 */
import { z } from 'zod';

import type { Principal } from '../../../schema/object-record-v1.js';
import { friendlyNameFromEmail } from '../../../lib/admin/display-name.js';
import type { MembershipPolicy } from '../../../lib/membership-policy.js';
import {
  environmentRoleEntries,
  environmentRoleForEmail,
  isOwner,
  resolveRolesForPrincipalAsync,
  type Role,
  type RoleEnv,
} from '../roles.js';
import {
  getUserRecord,
  listUserRecords,
  normalizeUserEmail,
  putUserRecord,
  userRoleSchema,
  memberToUserRecord,
  type UserRecord,
  type UsersBlobStore,
} from '../users-store.js';
import type { OAuthBlobStore } from '../oauth-store.js';
import {
  InvitationError,
  assertMayInvite,
  createInvitation,
  listInvitations,
  listUnmanagedIdentities,
  resendInvitation,
  revokeInvitation,
  type FetchLike,
  type GoTrueIdentity,
} from './invitations.js';
import {
  OffboardingError,
  deleteIdentity,
  deleteOrQueueIdentity,
  drainIdentityDeleteQueue,
  exportPerson,
  purgeConfirmMatches,
  releaseLocksHeldBy,
  revokeOAuthGrantsForSubject,
  scrubPerson,
  transferOwnership,
  type ObjectLockSweepStore,
} from './offboarding.js';
import { getMembershipByEmail } from './read.js';
import {
  auditActorFromPrincipal,
  membershipPolicyOverrideSchema,
  membershipRoleSchema,
  personIdForEmail,
  type AuditActor,
  type MembershipStore,
} from './store.js';
import {
  appendAudit,
  getPolicy,
  listAuditForEmail,
  newMember,
  removeMembership,
  saveMember,
  setPolicy,
  wouldBreachMinOwners,
} from './write.js';

// ── principal / io types ────────────────────────────────────────────────────

export type MembershipVia = 'admin_ui' | 'mcp' | 'chat';

/** The caller as the three front doors build it. `via` is required — every audit line names the door. */
export type MembershipPrincipal =
  | { kind: 'human'; id: string; email: string; via: MembershipVia; client_id?: string; request_id?: string }
  | { kind: 'agent'; agent_name: string; auth: 'publish_key' | 'mcp_token'; via: MembershipVia; request_id?: string };

export interface MembershipVerbDeps {
  store: MembershipStore;
  /** GoTrue admin identity Netlify injects into Identity-JWT requests (absent on MCP/chat/scheduled). */
  identity?: GoTrueIdentity;
  fetchImpl?: FetchLike;
  /** Offboarding side-effect stores (opened lazily; absent = the effect is skipped and reported). */
  oauthStore?: () => Promise<OAuthBlobStore>;
  objectStore?: () => Promise<ObjectLockSweepStore>;
  softDeleteAvatar?: (ref: string) => Promise<void>;
  env?: RoleEnv;
  now?: () => string;
}

export interface MembershipVerbResult {
  status: number;
  body: Record<string, unknown>;
}

// ── verb + args schemas (single source for parsing AND `contract`) ──────────

const email = z.string().min(3);
const dryRun = z.boolean().optional();

export const MEMBERSHIP_VERB_SCHEMAS = {
  list: z.object({ include_removed: z.boolean().optional() }),
  get: z.object({ email }),
  audit: z.object({ email, limit: z.number().int().min(1).max(500).optional() }),
  contract: z.object({}),
  policy_get: z.object({}),
  policy_set: z.object({ policy: membershipPolicyOverrideSchema }),
  invite: z.object({ email, role: userRoleSchema, message: z.string().max(1000).optional(), dry_run: dryRun }),
  resend: z.object({ invite_id: z.string().min(1).optional(), email: email.optional() }),
  revoke: z.object({
    invite_id: z.string().min(1).optional(),
    email: email.optional(),
    reason: z.string().max(500).optional(),
  }),
  list_invitations: z.object({ status: z.enum(['pending', 'accepted', 'expired', 'revoked']).optional() }),
  unmanaged_identities: z.object({}),
  grant: z.object({ email, role: userRoleSchema, user_id: z.string().optional() }),
  set_role: z.object({ email, role: userRoleSchema, dry_run: dryRun }),
  suspend: z.object({ email, reason: z.string().max(500).optional() }),
  reinstate: z.object({ email }),
  remove: z.object({
    email,
    reason: z.string().max(500).optional(),
    delete_identity: z.boolean().optional(),
    dry_run: dryRun,
  }),
  purge: z.object({ email, confirm: z.string() }),
  transfer_ownership: z.object({
    to_email: email,
    from_email: email.optional(),
    demote_to: z.enum(['admin', 'publisher', 'editor', 'viewer', 'keep']).optional(),
    dry_run: dryRun,
  }),
  promote_bootstrap: z.object({ email }),
  export: z.object({ email }),
  delete_identity: z.object({ user_id: z.string().min(1), email }),
} as const;

export type MembershipVerb = keyof typeof MEMBERSHIP_VERB_SCHEMAS;
export const MEMBERSHIP_VERBS = Object.keys(MEMBERSHIP_VERB_SCHEMAS) as MembershipVerb[];

/** Aliases the pre-T18.6a `admin-users` surface exposed (kept for one release; T18.8 removes). */
export const MEMBERSHIP_VERB_ALIASES: Record<string, MembershipVerb> = {
  disable: 'suspend',
  member_audit: 'audit',
  export_person: 'export',
};

/** Which tier each verb needs (plan §6/§7). `invite` is policy-dependent (see gate). */
export const MEMBERSHIP_VERB_MIN_TIER: Record<MembershipVerb, 'admin' | 'owner'> = {
  list: 'admin',
  get: 'admin',
  audit: 'owner',
  contract: 'admin',
  policy_get: 'admin',
  policy_set: 'owner',
  invite: 'admin', // + policy check
  resend: 'owner',
  revoke: 'owner',
  list_invitations: 'owner',
  unmanaged_identities: 'owner',
  grant: 'owner',
  set_role: 'owner',
  suspend: 'owner',
  reinstate: 'owner',
  remove: 'owner',
  purge: 'owner',
  transfer_ownership: 'owner',
  promote_bootstrap: 'owner',
  export: 'owner',
  delete_identity: 'owner',
};

const MUTATING_VERBS: ReadonlySet<MembershipVerb> = new Set<MembershipVerb>([
  'policy_set',
  'invite',
  'resend',
  'revoke',
  'grant',
  'set_role',
  'suspend',
  'reinstate',
  'remove',
  'purge',
  'transfer_ownership',
  'promote_bootstrap',
  'delete_identity',
]);

/** The error catalogue (plan §7) — every `error_code` this core can return. */
export const MEMBERSHIP_ERROR_CATALOGUE: Record<string, { status: number; meaning: string }> = {
  membership_requires_human: {
    status: 403,
    meaning: 'the caller is an agent principal (shared MCP token, agent_name, chat run without a captured human)',
  },
  admin_required: { status: 403, meaning: 'the human has no admin tier on this site (viewer/editor/publisher/none)' },
  owner_required: { status: 403, meaning: 'the verb needs an Owner' },
  invite_forbidden: { status: 403, meaning: 'policy.who_can_invite does not let this tier invite' },
  role_not_grantable: { status: 403, meaning: 'an Admin invited a role outside policy.roles_admin_may_grant' },
  invalid_args: { status: 400, meaning: 'arguments failed the verb schema (issues returned)' },
  unknown_verb: { status: 400, meaning: 'not a membership verb' },
  invite_pending_exists: { status: 409, meaning: 'an open invitation exists (existing_invite_id returned)' },
  member_active: { status: 409, meaning: 'already an active member — set_role instead' },
  member_exists: { status: 409, meaning: 'grant/delete_identity on an address that has a membership' },
  env_managed_member: { status: 409, meaning: 'target is an ADMIN_EMAILS / ROLE_EMAILS_* principal' },
  self_change: { status: 409, meaning: 'you cannot change your own role/status or remove/purge yourself' },
  last_owner: {
    status: 409,
    meaning: 'would leave fewer than policy.min_owners owners (stored active + env bootstrap)',
  },
  member_not_found: { status: 404, meaning: 'no such member' },
  invite_not_found: { status: 404, meaning: 'no such invite_id / no open invitation for the e-mail' },
  invite_not_pending: { status: 409, meaning: 'invitation already accepted' },
  invite_expired: { status: 409, meaning: 'TTL passed — send a new invitation' },
  invite_revoked: { status: 409, meaning: 'invitation revoked' },
  resend_cap: { status: 429, meaning: 'gotrue.send_count ≥ policy.max_resends' },
  domain_not_allowed: { status: 422, meaning: 'policy.allowed_email_domains excludes the address' },
  not_removed: { status: 409, meaning: 'purge applies to removed members only' },
  confirm_mismatch: { status: 400, meaning: 'purge needs confirm = "PURGE <email>"' },
  not_bootstrap: { status: 409, meaning: 'promote_bootstrap target is not an ADMIN_EMAILS member' },
  same_person: { status: 409, meaning: 'transfer_ownership to yourself' },
  not_active: { status: 409, meaning: 'transfer_ownership needs two active members' },
  identity_admin_unavailable: {
    status: 503,
    meaning: 'no GoTrue admin token on this request (MCP/chat/scheduled); degraded read or refused delete',
  },
  gotrue_delete_failed: { status: 502, meaning: 'GoTrue refused the identity delete' },
};

// ── helpers ─────────────────────────────────────────────────────────────────

const ok = (body: Record<string, unknown>): MembershipVerbResult => ({ status: 200, body });
const err = (
  status: number,
  error: string,
  error_code: string,
  extra: Record<string, unknown> = {}
): MembershipVerbResult => ({
  status,
  body: { error, error_code, ...extra },
});

const ENV_MANAGED = 'This member is configured in site environment variables and cannot be changed here.';

/** A read-only view for an env Owner with no stored record yet (promote_bootstrap materialises it). */
const synthesizedRecord = (emailAddr: string, owner: boolean, ts: string): UserRecord => ({
  schema_version: 1,
  email: emailAddr,
  display_name: friendlyNameFromEmail(emailAddr),
  role: owner ? 'owner' : 'admin',
  status: 'active',
  invited_by: 'bootstrap',
  created_at: ts,
  updated_at: ts,
  audit: [],
});

export interface ListedUser extends Omit<UserRecord, 'role'> {
  role: Role;
  source: 'stored' | 'environment';
}

/** Merge every real access principal into the Owner-visible list without exposing env metadata (moved from admin-users, T9.4). */
export const listUsersWithEnvironment = async (
  store: UsersBlobStore,
  env: RoleEnv = process.env as RoleEnv,
  now = new Date().toISOString()
): Promise<ListedUser[]> => {
  const rows = new Map<string, ListedUser>();
  for (const record of await listUserRecords(store)) {
    rows.set(normalizeUserEmail(record.email), { ...record, source: 'stored' });
  }
  for (const [emailAddr, environmentRole] of environmentRoleEntries(env)) {
    const stored = rows.get(emailAddr);
    if (stored) {
      rows.set(emailAddr, {
        ...stored,
        // ADMIN_EMAILS is the one environment grant that deliberately beats
        // the store. Other environment roles retain the stored-role precedence.
        role: environmentRole === 'owner' ? 'owner' : stored.role,
        source: 'environment',
      });
      continue;
    }
    const record = synthesizedRecord(emailAddr, environmentRole === 'owner', now);
    rows.set(emailAddr, { ...record, role: environmentRole, invited_by: 'environment', source: 'environment' });
  }
  return [...rows.values()].sort((a, b) => a.email.localeCompare(b.email));
};

// ── the core ────────────────────────────────────────────────────────────────

export interface MembershipVerbInput {
  verb: string;
  args: Record<string, unknown>;
  principal: MembershipPrincipal;
  deps: MembershipVerbDeps;
}

export const handleMembershipVerb = async (input: MembershipVerbInput): Promise<MembershipVerbResult> => {
  // ── THE GATE: no agent principal, ever, before anything else. ──
  if (input.principal.kind !== 'human') {
    return err(403, 'Membership verbs require a verified human principal.', 'membership_requires_human');
  }
  const principal = input.principal;
  const { store } = input.deps;
  const env = input.deps.env ?? (process.env as RoleEnv);
  const now = input.deps.now ?? (() => new Date().toISOString());
  const actorEmail = normalizeUserEmail(principal.email);
  if (!actorEmail) return err(403, 'A verified email is required.', 'membership_requires_human');
  const via = principal.via;
  const corePrincipal: Principal = { kind: 'human', id: principal.id, email: actorEmail };
  const actor: AuditActor = auditActorFromPrincipal(corePrincipal);
  const audit = (event: Omit<Parameters<typeof appendAudit>[1], 'via' | 'actor' | 'request_id'>) =>
    appendAudit(store, {
      ...event,
      actor,
      via,
      ...(principal.request_id ? { request_id: principal.request_id } : {}),
    }).catch(() => undefined);

  const verbName = (MEMBERSHIP_VERB_ALIASES[input.verb] ?? input.verb) as MembershipVerb;
  const schema = MEMBERSHIP_VERB_SCHEMAS[verbName];
  if (!schema) return err(400, `Unknown membership verb "${input.verb}".`, 'unknown_verb', { verbs: MEMBERSHIP_VERBS });
  const parsed = schema.safeParse(input.args ?? {});
  if (!parsed.success) return err(400, 'Invalid request fields.', 'invalid_args', { issues: parsed.error.issues });
  const args = parsed.data as Record<string, unknown> & z.infer<typeof schema>;

  // Tier — re-resolved from the store on every call; a suspended/removed human is [] and refused.
  const roles = await resolveRolesForPrincipalAsync(corePrincipal, {
    env,
    getUserRecord: (e) => getUserRecord(store, e),
  });
  if (!roles.includes('admin')) return err(403, 'Admin access required', 'admin_required');
  const owner = isOwner(roles);
  if (MEMBERSHIP_VERB_MIN_TIER[verbName] === 'owner' && !owner)
    return err(403, 'Owner access required', 'owner_required');

  const identity = input.deps.identity;
  const fetchImpl = input.deps.fetchImpl;
  const at = now();
  const policy = await getPolicy(store);

  // Owner requests carrying an admin token drain queued identity deletes (T18.4).
  if (owner && identity && fetchImpl) {
    await drainIdentityDeleteQueue(store, { identity, fetchImpl, at, actor }).catch(() => undefined);
  }

  /** suspend/remove side effects: OAuth grants gone, locks handed off (T18.4). */
  const cutAccess = async (target: UserRecord, reason: 'suspend' | 'remove') => {
    const [grants, locks] = await Promise.all([
      input.deps.oauthStore
        ? input.deps
            .oauthStore()
            .then((s) => revokeOAuthGrantsForSubject(s, target.email))
            .catch((e: unknown) => ({ revoked: 0, error: e instanceof Error ? e.message : 'oauth store unavailable' }))
        : Promise.resolve({ revoked: 0, error: 'oauth store not wired' }),
      input.deps.objectStore
        ? input.deps
            .objectStore()
            .then((s) =>
              releaseLocksHeldBy(s, {
                person: {
                  email: target.email,
                  person_id: target.person_id ?? personIdForEmail(target.email),
                  user_id: target.user_id,
                },
                actor: corePrincipal,
                at,
                reason,
              })
            )
            .catch(() => [] as Array<{ object_id: string; object_type: string }>)
        : Promise.resolve([] as Array<{ object_id: string; object_type: string }>),
    ]);
    return {
      oauth_revoked: grants.revoked,
      oauth_error: 'error' in grants ? grants.error : undefined,
      locks_released: locks,
    };
  };

  const lastOwnerBreach = async (stored: UserRecord) => {
    if (!(stored.role === 'owner' && stored.status === 'active')) return false;
    const envOwners = environmentRoleEntries(env).filter(([, role]) => role === 'owner').length;
    return wouldBreachMinOwners(store, {
      exceptPersonId: stored.person_id ?? personIdForEmail(stored.email),
      envOwnerCount: envOwners,
      minOwners: policy.min_owners,
    });
  };

  try {
    switch (verbName) {
      case 'contract':
        return ok({ contract: buildMembershipContract(policy) });

      case 'policy_get':
        return ok({ policy });

      case 'policy_set': {
        const next = await setPolicy(store, (args as { policy: unknown }).policy);
        await audit({
          at,
          action: 'membership.role_change',
          target: { email: actorEmail },
          detail: { policy_set: (args as { policy: unknown }).policy },
        });
        return ok({ policy: next });
      }

      case 'list': {
        const users = await listUsersWithEnvironment(store, env, at);
        return ok({
          users: (args as { include_removed?: boolean }).include_removed
            ? users
            : users.filter((u) => u.membership_status !== 'removed'),
        });
      }

      case 'get': {
        const target = normalizeUserEmail((args as { email: string }).email);
        const stored = await getUserRecord(store, target);
        const envRole = environmentRoleForEmail(target, env);
        if (!stored && !envRole) return err(404, 'No such member.', 'member_not_found');
        const user: ListedUser = stored
          ? { ...stored, role: envRole === 'owner' ? 'owner' : stored.role, source: envRole ? 'environment' : 'stored' }
          : {
              ...synthesizedRecord(target, envRole === 'owner', at),
              role: envRole as Role,
              invited_by: 'environment',
              source: 'environment',
            };
        return ok({ user });
      }

      case 'audit': {
        const target = normalizeUserEmail((args as { email: string }).email);
        const stored = await getUserRecord(store, target);
        return ok({
          email: target,
          events: await listAuditForEmail(store, target, (args as { limit?: number }).limit ?? 100),
          legacy_audit: stored?.audit ?? [],
        });
      }

      case 'invite': {
        const a = args as { email: string; role: Role; message?: string; dry_run?: boolean };
        assertMayInvite({ actorRoles: roles, role: a.role as never, policy });
        if (environmentRoleForEmail(a.email, env)) return err(409, ENV_MANAGED, 'env_managed_member');
        if (a.dry_run) {
          const target = normalizeUserEmail(a.email);
          const existing = await getMembershipByEmail(store, target);
          return ok({
            dry_run: true,
            would: existing?.membership.status === 'active' ? 'refuse:member_active' : existing ? 'reinvite' : 'invite',
            email: target,
            role: a.role,
            gotrue_email: Boolean(identity && fetchImpl),
            expires_in_hours: policy.invite_ttl_hours,
          });
        }
        const result = await createInvitation(store, {
          email: a.email,
          role: a.role as never,
          invitedBy: { person_id: personIdForEmail(actorEmail), email: actorEmail },
          actor,
          at,
          ...(a.message ? { message: a.message } : {}),
          via,
          // T18.9 (found by the E2E harness): record WHERE the invitation came from
          // (plan §2.1 `source: platform|mcp|chat`) — the audit had `via`, the object did not.
          source: via === 'admin_ui' ? 'platform' : via,
          identity,
          fetchImpl,
        });
        return ok({
          user: result.user,
          invite: result.invite,
          invitation: result.invitation,
          accept_token: result.accept_token,
        });
      }

      case 'resend': {
        const a = args as { invite_id?: string; email?: string };
        const result = await resendInvitation(store, {
          invite_id: a.invite_id,
          email: a.email,
          actor,
          actorEmail,
          at,
          via,
          identity,
          fetchImpl,
        });
        return ok({ invitation: result.invitation, invite: result.invite, accept_token: result.accept_token });
      }

      case 'revoke': {
        const a = args as { invite_id?: string; email?: string; reason?: string };
        const result = await revokeInvitation(store, {
          invite_id: a.invite_id,
          email: a.email,
          actor,
          actorEmail,
          at,
          reason: a.reason,
          via,
        });
        return ok({ invitation: result.invitation, membership: result.membership });
      }

      case 'list_invitations':
        return ok({
          invitations: await listInvitations(store, { status: (args as { status?: never }).status, now: at }),
        });

      case 'unmanaged_identities': {
        const result = await listUnmanagedIdentities({ store, identity, fetchImpl });
        return ok({ ...result, capabilities: { delete_identity: Boolean(identity) } });
      }

      case 'grant': {
        const a = args as { email: string; role: Role; user_id?: string };
        const target = normalizeUserEmail(a.email);
        if (environmentRoleForEmail(target, env)) return err(409, ENV_MANAGED, 'env_managed_member');
        const existing = await getUserRecord(store, target);
        if (existing && existing.membership_status !== 'removed') {
          return err(409, 'This person already has a membership. Change their role instead.', 'member_exists');
        }
        const granted = newMember({
          email: target,
          display_name: existing?.display_name ?? friendlyNameFromEmail(target),
          role: a.role as never,
          status: 'active',
          source: via === 'admin_ui' ? 'netlify_ui' : 'mcp',
          granted_by: { kind: 'human', person_id: personIdForEmail(actorEmail), email: actorEmail },
          invited_by: actorEmail,
          at,
          user_id: a.user_id,
          audit: [
            ...(existing?.audit ?? []),
            { at, actor_email: actorEmail, action: 'grant', detail: `role ${a.role}` },
          ],
        });
        await saveMember(store, granted);
        await audit({
          at,
          action: 'membership.grant',
          target: { person_id: granted.person.person_id, email: target },
          detail: { role: a.role, source: granted.membership.source },
        });
        return ok({ user: await getUserRecord(store, target) });
      }

      case 'promote_bootstrap': {
        const target = normalizeUserEmail((args as { email: string }).email);
        if (environmentRoleForEmail(target, env) !== 'owner') {
          return err(
            409,
            'Only an ADMIN_EMAILS (bootstrap) member can be promoted to a stored Owner.',
            'not_bootstrap'
          );
        }
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
                  actor_email: actorEmail,
                  action: 'promote_bootstrap',
                  detail: `${stored.role}/${stored.status} → owner/active`,
                },
              ],
            }
          : {
              ...synthesizedRecord(target, true, at),
              audit: [{ at, actor_email: actorEmail, action: 'promote_bootstrap', detail: 'env → stored owner' }],
            };
        await putUserRecord(store, promoted);
        await audit({
          at,
          action: 'membership.promote_bootstrap',
          target: { person_id: personIdForEmail(target), email: target },
        });
        return ok({ user: await getUserRecord(store, target) });
      }

      case 'set_role':
      case 'suspend':
      case 'reinstate': {
        const a = args as { email: string; role?: Role; reason?: string; dry_run?: boolean };
        const target = normalizeUserEmail(a.email);
        if (target === actorEmail) return err(409, 'You cannot change your own role or status.', 'self_change');
        if (environmentRoleForEmail(target, env)) return err(409, ENV_MANAGED, 'env_managed_member');
        const stored = await getUserRecord(store, target);
        if (!stored) return err(404, 'No such member. Invite them first.', 'member_not_found');
        const wouldLoseOwner = (verbName === 'set_role' && a.role !== 'owner') || verbName === 'suspend';
        if (wouldLoseOwner && (await lastOwnerBreach(stored))) {
          return err(409, 'This is the last Owner. Promote another member to Owner first.', 'last_owner');
        }
        if (verbName === 'set_role' && a.dry_run) {
          return ok({
            dry_run: true,
            would: stored.role === a.role ? 'no_change' : 'change_role',
            email: target,
            from: stored.role,
            to: a.role,
          });
        }
        let updated: UserRecord;
        let action: 'membership.role_change' | 'membership.suspend' | 'membership.reinstate';
        if (verbName === 'set_role') {
          updated = {
            ...stored,
            role: a.role as never,
            updated_at: at,
            audit: [
              ...stored.audit,
              { at, actor_email: actorEmail, action: 'set_role', detail: `${stored.role} → ${a.role}` },
            ],
          };
          action = 'membership.role_change';
        } else if (verbName === 'suspend') {
          updated = {
            ...stored,
            status: 'disabled',
            updated_at: at,
            audit: [
              ...stored.audit,
              { at, actor_email: actorEmail, action: 'suspend', ...(a.reason ? { detail: a.reason } : {}) },
            ],
          };
          action = 'membership.suspend';
        } else {
          if (stored.membership_status === 'removed')
            return err(409, 'This member was removed. Re-invite them instead.', 'member_not_found');
          if (stored.status !== 'disabled') return ok({ user: stored });
          updated = {
            ...stored,
            status: 'active',
            updated_at: at,
            audit: [...stored.audit, { at, actor_email: actorEmail, action: 'reinstate' }],
          };
          action = 'membership.reinstate';
        }
        await putUserRecord(store, updated);
        const cut = verbName === 'suspend' ? await cutAccess(stored, 'suspend') : undefined;
        await audit({
          at,
          action,
          target: { person_id: stored.person_id ?? personIdForEmail(target), email: target },
          ...(verbName === 'set_role' ? { detail: { from: stored.role, to: a.role } } : {}),
          ...(cut ? { detail: { oauth_revoked: cut.oauth_revoked, locks_released: cut.locks_released.length } } : {}),
        });
        return ok({ user: await getUserRecord(store, target), ...(cut ? { offboarding: cut } : {}) });
      }

      case 'remove': {
        const a = args as { email: string; reason?: string; delete_identity?: boolean; dry_run?: boolean };
        const target = normalizeUserEmail(a.email);
        if (target === actorEmail) return err(409, 'You cannot remove yourself.', 'self_change');
        if (environmentRoleForEmail(target, env)) return err(409, ENV_MANAGED, 'env_managed_member');
        const stored = await getUserRecord(store, target);
        if (!stored) return err(404, 'No such member.', 'member_not_found');
        if (await lastOwnerBreach(stored))
          return err(409, 'This is the last Owner. Promote another member to Owner first.', 'last_owner');
        const wantDelete = a.delete_identity ?? policy.delete_identity_on_remove;
        if (a.dry_run) {
          return ok({
            dry_run: true,
            would: 'remove',
            email: target,
            role: stored.role,
            status: stored.membership_status ?? stored.status,
            purge_after_days: policy.purge_grace_days,
            delete_identity: wantDelete,
            identity_delete_would: wantDelete ? (identity ? 'delete_now' : 'queue') : 'keep',
          });
        }
        try {
          await revokeInvitation(store, {
            email: target,
            actor,
            actorEmail,
            at,
            reason: a.reason ?? 'member removed',
            via,
          });
        } catch {
          // no open invitation — fine
        }
        await removeMembership(store, {
          email: target,
          actorEmail,
          at,
          reason: a.reason,
          purgeGraceDays: policy.purge_grace_days,
        });
        const cut = await cutAccess(stored, 'remove');
        const identityOutcome = wantDelete
          ? await deleteOrQueueIdentity(store, {
              person: {
                person_id: stored.person_id ?? personIdForEmail(target),
                email: target,
                user_id: stored.user_id,
              },
              identity,
              fetchImpl,
              at,
              reason: a.reason ?? 'member removed',
            })
          : { outcome: 'kept' as const };
        await audit({
          at,
          action: 'membership.remove',
          target: { person_id: stored.person_id ?? personIdForEmail(target), email: target },
          detail: {
            ...(a.reason ? { reason: a.reason } : {}),
            oauth_revoked: cut.oauth_revoked,
            locks_released: cut.locks_released.length,
            identity: identityOutcome.outcome,
          },
        });
        return ok({ user: await getUserRecord(store, target), offboarding: { ...cut, identity: identityOutcome } });
      }

      case 'purge': {
        const a = args as { email: string; confirm: string };
        const target = normalizeUserEmail(a.email);
        if (target === actorEmail) return err(409, 'You cannot purge yourself.', 'self_change');
        if (!purgeConfirmMatches(a.confirm, target))
          return err(400, `Type "PURGE ${target}" to confirm.`, 'confirm_mismatch');
        const member = await getMembershipByEmail(store, target);
        if (!member) return err(404, 'No such member.', 'member_not_found');
        if (member.membership.status !== 'removed')
          return err(409, 'Remove the member first; purge only applies to removed members.', 'not_removed');
        const view = memberToUserRecord(member);
        const cut = await cutAccess(view, 'remove');
        const identityOutcome = await deleteOrQueueIdentity(store, {
          person: { person_id: member.person.person_id, email: target, user_id: member.person.identity.user_id },
          identity,
          fetchImpl,
          at,
          reason: 'purge',
        });
        await scrubPerson(store, {
          person: member.person,
          membership: member.membership,
          at,
          softDeleteAvatar: input.deps.softDeleteAvatar,
        });
        await audit({
          at,
          action: 'membership.purge',
          target: { person_id: member.person.person_id, email: target },
          detail: { oauth_revoked: cut.oauth_revoked, identity: identityOutcome.outcome },
        });
        return ok({
          purged: true,
          person_id: member.person.person_id,
          offboarding: { ...cut, identity: identityOutcome },
        });
      }

      case 'transfer_ownership': {
        const a = args as {
          to_email: string;
          from_email?: string;
          demote_to?: 'admin' | 'publisher' | 'editor' | 'viewer' | 'keep';
          dry_run?: boolean;
        };
        const from = normalizeUserEmail(a.from_email ?? actorEmail);
        const to = normalizeUserEmail(a.to_email);
        if (environmentRoleForEmail(from, env) || environmentRoleForEmail(to, env)) {
          return err(
            409,
            'Environment-configured members cannot take part in an ownership transfer; promote the stored Owner first.',
            'env_managed_member'
          );
        }
        if (a.dry_run) {
          const [f, t] = await Promise.all([getMembershipByEmail(store, from), getMembershipByEmail(store, to)]);
          return ok({
            dry_run: true,
            would:
              !f || !t
                ? 'refuse:not_found'
                : f.membership.status !== 'active' || t.membership.status !== 'active'
                  ? 'refuse:not_active'
                  : from === to
                    ? 'refuse:same_person'
                    : 'transfer',
            from,
            to,
            from_role_after: a.demote_to === 'keep' ? f?.membership.role : (a.demote_to ?? 'admin'),
          });
        }
        const result = await transferOwnership(store, { from, to, actor, actorEmail, at, demoteTo: a.demote_to });
        return ok({
          from: await getUserRecord(store, result.from.person.email),
          to: await getUserRecord(store, result.to.person.email),
        });
      }

      case 'export': {
        const target = normalizeUserEmail((args as { email: string }).email);
        const bundle = await exportPerson(store, {
          email: target,
          at,
          objectStore: input.deps.objectStore ? await input.deps.objectStore().catch(() => undefined) : undefined,
        });
        if (!bundle) return err(404, 'No such member.', 'member_not_found');
        return ok({ export: bundle });
      }

      case 'delete_identity': {
        const a = args as { user_id: string; email: string };
        const target = normalizeUserEmail(a.email);
        if (target === actorEmail) return err(409, 'You cannot delete your own identity.', 'self_change');
        if (await getUserRecord(store, target))
          return err(409, 'This identity has a membership — remove the member instead.', 'member_exists');
        if (!identity || !fetchImpl) return err(503, 'Identity admin token unavailable.', 'identity_admin_unavailable');
        const res = await deleteIdentity({ identity, fetchImpl, gotrue_user_id: a.user_id });
        if (!res.deleted) return err(502, res.error ?? 'GoTrue delete failed.', 'gotrue_delete_failed');
        await audit({
          at,
          action: 'person.sessions_revoked',
          target: { email: target },
          detail: { identity_deleted: true, gotrue_user_id: a.user_id, unmanaged: true },
        });
        return ok({ deleted: true, user_id: a.user_id });
      }
    }
  } catch (error) {
    if (error instanceof InvitationError) return err(error.status, error.message, error.code, error.extra);
    if (error instanceof OffboardingError) return err(error.status, error.message, error.code);
    throw error;
  }
  return err(400, `Unknown membership verb "${input.verb}".`, 'unknown_verb');
};

// ── contract (derived from the enforcing tables above, like object_contract) ─

const jsonSchemaFor = (schema: z.ZodTypeAny): Record<string, unknown> => {
  try {
    return z.toJSONSchema(schema, { unrepresentable: 'any', io: 'input' }) as Record<string, unknown>;
  } catch {
    return { type: 'object' };
  }
};

export const buildMembershipContract = (policy: MembershipPolicy) => ({
  schema_version: 1,
  gate: {
    rule: 'membership_requires_human',
    description:
      'Every membership verb requires a verified HUMAN principal (admin Identity JWT, or an OAuth principal bound to a Netlify Identity human). Agent principals — the shared MCP token, a verified or self-declared agent_name, a chat run without a captured human — are refused with 403 membership_requires_human before any read.',
  },
  roles: {
    tiers: membershipRoleSchema.options,
    expand: {
      owner: ['owner', 'admin', 'publisher'],
      admin: ['admin'],
      publisher: ['publisher'],
      editor: ['editor'],
      viewer: ['viewer'],
    },
    precedence: [
      'agent → []',
      'ADMIN_EMAILS → owner (always)',
      'stored membership tier (suspended|removed → [])',
      'env allowlists',
    ],
  },
  verbs: MEMBERSHIP_VERBS.map((verb) => ({
    verb,
    min_tier: MEMBERSHIP_VERB_MIN_TIER[verb],
    ...(verb === 'invite'
      ? { policy: 'who_can_invite / roles_admin_may_grant may open invite to Admins for editor|viewer' }
      : {}),
    mutates: MUTATING_VERBS.has(verb),
    dry_run: ['invite', 'set_role', 'remove', 'transfer_ownership'].includes(verb),
    args: jsonSchemaFor(MEMBERSHIP_VERB_SCHEMAS[verb]),
  })),
  aliases: MEMBERSHIP_VERB_ALIASES,
  policy,
  errors: MEMBERSHIP_ERROR_CATALOGUE,
});
