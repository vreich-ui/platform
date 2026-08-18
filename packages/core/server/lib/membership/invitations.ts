/**
 * Invitations (W18 T18.2, plan §2.1 Invitation, §3.1, §4.1/§4.2, F9) — the
 * first-class invitation object and its state machine:
 *
 *   pending ──accept──▶ accepted   (terminal; membership invited → active)
 *   pending ──revoke──▶ revoked    (terminal; a never-activated membership → removed)
 *   pending ──ttl─────▶ expired    (lazy on read + `expireAll` sweep; resend creates a NEW invite)
 *
 * One `pending` per e-mail per site (`invitation-by-email/<email>` pointer;
 * 409 `invite_pending_exists` with `existing_invite_id`). The GoTrue side
 * effect (`POST {identity}/invite`, T18.0a's endpoint fact) is best-effort and
 * recorded on `invitation.gotrue`; the store record is the source of truth.
 *
 * TWO ACCEPT PATHS (documented per the brief):
 *   1. GoTrue's own mail — the only token it carries is `{{ .Token }}` (its
 *      invite token). `/admin/accept` (T18.0b) exchanges it for a session,
 *      then calls the `accept` verb, which matches the invitation BY E-MAIL +
 *      pending status. This is the default path; nothing of ours travels in
 *      the mail (GoTrue's `data` is informational only).
 *   2. Our opaque accept token (`inv_` + 32 random bytes; only its sha256 is
 *      stored as `token_hash`) is returned ONCE from `createInvitation` /
 *      `resendInvitation` so the Owner can copy an "invitation link"
 *      (`/admin/accept?inv=<token>#invite_token=…` is not constructible by us —
 *      the GoTrue half is in GoTrue's mail) from the UI (T18.3b) and share it
 *      manually; `previewInvitationByToken` lets the accept page show inviter /
 *      role / site BEFORE GoTrue accepts. Optional sugar; never required.
 *
 * `activateOnLogin` (first-login activation, T9.5) and `acceptInvitation`
 * (T18.0a's `accept` verb transition) moved here from `user-invite.ts`, which
 * this task removed.
 */
import { createHash, randomBytes } from 'node:crypto';

import type { MembershipPolicy } from '../../../lib/membership-policy.js';
import { friendlyNameFromEmail } from '../../../lib/admin/display-name.js';
import { getMembershipByEmail, listMembers, type Member } from './read.js';
import {
  KEYS,
  PREFIXES,
  invitationSchema,
  invitePointerSchema,
  mintUlid,
  normalizeEmail,
  personIdForEmail,
  type AuditActor,
  type Invitation,
  type Membership,
  type MembershipRole,
  type MembershipStore,
} from './store.js';
import { appendAudit, getPolicy, newMember, saveMember, stampOnboarding } from './write.js';
import { memberToUserRecord, type UserRecord } from '../users-store.js';
import { collectBlobListItems } from '../blob-list.js';

// ── GoTrue seam ─────────────────────────────────────────────────────────────

export interface GoTrueIdentity {
  url: string;
  token: string;
}

/** Injectable fetch: the admin-users function passes the platform `fetch`; tests record calls. */
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string>; json?: () => Promise<unknown> }>;

export interface InviteSendResult {
  sent: boolean;
  error?: string;
}

/** GoTrue's 422 body when the address already has a (confirmed or invited) user. */
const ALREADY_INVITED_RE = /already\s+(been\s+)?(registered|invited)/i;

/**
 * `POST {identity}/invite { email, data }` — creates the (unconfirmed) GoTrue
 * user AND sends the Netlify Identity invitation e-mail (re-POST re-sends for
 * an unconfirmed user). 422 "already registered/invited" → `already_invited`,
 * not a failure. `data` is informational only; roles never live in GoTrue.
 */
export const sendGoTrueInvite = async (opts: {
  email: string;
  data: Record<string, unknown>;
  identity?: GoTrueIdentity;
  fetchImpl?: FetchLike;
}): Promise<InviteSendResult> => {
  if (!opts.identity || !opts.fetchImpl) {
    return { sent: false, error: 'Identity admin token unavailable; store record created, invite email not sent.' };
  }
  try {
    const res = await opts.fetchImpl(`${opts.identity.url}/invite`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${opts.identity.token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: normalizeEmail(opts.email), data: opts.data }),
    });
    if (res.ok) return { sent: true };
    let bodyText = '';
    if (res.status === 422 && typeof res.text === 'function') {
      try {
        bodyText = await res.text();
      } catch {
        bodyText = '';
      }
    }
    if (res.status === 422 && (typeof res.text !== 'function' || ALREADY_INVITED_RE.test(bodyText))) {
      return { sent: false, error: 'already_invited' };
    }
    return { sent: false, error: `GoTrue invite failed (${res.status}).` };
  } catch (e) {
    return { sent: false, error: e instanceof Error ? e.message : 'GoTrue invite failed.' };
  }
};

// ── error catalogue (plan §7) ───────────────────────────────────────────────

export type InvitationErrorCode =
  | 'invite_pending_exists'
  | 'invite_not_found'
  | 'invite_not_pending'
  | 'invite_expired'
  | 'invite_revoked'
  | 'resend_cap'
  | 'domain_not_allowed'
  | 'role_not_grantable'
  | 'invite_forbidden'
  | 'env_managed_member'
  | 'member_active'
  | 'identity_admin_unavailable'
  | 'gotrue_invite_failed';

export class InvitationError extends Error {
  readonly code: InvitationErrorCode;
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(code: InvitationErrorCode, status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

const parseJson = (raw: string | null): unknown => {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
};

const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const mintAcceptToken = (): string => `inv_${randomBytes(32).toString('hex')}`;
const mintInviteId = (nowMs?: number): string => `inv_${mintUlid(nowMs)}`;

const addHours = (iso: string, hours: number): string => new Date(Date.parse(iso) + hours * 3600_000).toISOString();
const addDays = (iso: string, days: number): string => addHours(iso, days * 24);

const emailDomainAllowed = (email: string, policy: MembershipPolicy): boolean => {
  const allowed = policy.allowed_email_domains?.map((d) => d.trim().toLowerCase()).filter(Boolean) ?? [];
  if (allowed.length === 0) return true;
  const domain = normalizeEmail(email).split('@')[1] ?? '';
  return allowed.includes(domain);
};

export const getInvitation = async (store: MembershipStore, inviteId: string): Promise<Invitation | null> => {
  const parsed = invitationSchema.safeParse(parseJson(await store.get(KEYS.invitation(inviteId))));
  return parsed.success ? parsed.data : null;
};

const putInvitation = async (store: MembershipStore, invitation: Invitation): Promise<Invitation> => {
  const validated = invitationSchema.parse(invitation);
  await store.setJSON(KEYS.invitation(validated.invite_id), validated);
  return validated;
};

const setPointer = async (store: MembershipStore, email: string, inviteId: string | null): Promise<void> => {
  const key = KEYS.invitationByEmail(email);
  if (inviteId) {
    await store.setJSON(key, { invite_id: inviteId });
    return;
  }
  if (typeof store.delete === 'function') {
    await store.delete(key);
    return;
  }
  // stores without delete (tests' memStore, some adapters): tombstone the pointer
  await store.setJSON(key, { invite_id: '' });
};

/** Lazy expiry: a pending invitation past `expires_at` is written as expired (audited) and returned as such. */
const expireIfStale = async (store: MembershipStore, invitation: Invitation, now: string): Promise<Invitation> => {
  if (invitation.status !== 'pending' || invitation.expires_at > now) return invitation;
  const expired = await putInvitation(store, { ...invitation, status: 'expired', updated_at: now });
  await setPointer(store, expired.email, null);
  await appendAudit(store, {
    at: now,
    actor: { kind: 'system' },
    action: 'invitation.expire',
    target: { person_id: personIdForEmail(expired.email), email: expired.email, invite_id: expired.invite_id },
    via: 'system',
  }).catch(() => undefined);
  return expired;
};

/** The one OPEN (pending, unexpired) invitation for an address, or null. Applies lazy expiry. */
export const getOpenInvitationByEmail = async (
  store: MembershipStore,
  email: string,
  now = new Date().toISOString()
): Promise<Invitation | null> => {
  const pointer = invitePointerSchema.safeParse(parseJson(await store.get(KEYS.invitationByEmail(email))));
  if (!pointer.success || !pointer.data.invite_id) return null;
  const invitation = await getInvitation(store, pointer.data.invite_id);
  if (!invitation) return null;
  const current = await expireIfStale(store, invitation, now);
  return current.status === 'pending' ? current : null;
};

const resolveInvitation = async (
  store: MembershipStore,
  ref: { invite_id?: string; email?: string },
  now: string
): Promise<Invitation> => {
  let invitation: Invitation | null = null;
  if (ref.invite_id) invitation = await getInvitation(store, ref.invite_id);
  else if (ref.email) invitation = await getOpenInvitationByEmail(store, ref.email, now);
  if (!invitation) throw new InvitationError('invite_not_found', 404, 'No such invitation.');
  return expireIfStale(store, invitation, now);
};

const assertPending = (invitation: Invitation): void => {
  if (invitation.status === 'pending') return;
  if (invitation.status === 'expired') {
    throw new InvitationError('invite_expired', 409, 'This invitation has expired. Send a new one.', {
      invite_id: invitation.invite_id,
    });
  }
  if (invitation.status === 'revoked') {
    throw new InvitationError('invite_revoked', 409, 'This invitation was revoked.', {
      invite_id: invitation.invite_id,
    });
  }
  throw new InvitationError('invite_not_pending', 409, `This invitation is ${invitation.status}.`, {
    invite_id: invitation.invite_id,
  });
};

// ── policy: who may invite whom ─────────────────────────────────────────────

/** Throws `invite_forbidden` / `role_not_grantable` per `policy.who_can_invite` + `roles_admin_may_grant`. */
export const assertMayInvite = (input: {
  actorRoles: readonly string[];
  role: MembershipRole;
  policy: MembershipPolicy;
}): void => {
  if (input.actorRoles.includes('owner')) return;
  if (input.policy.who_can_invite === 'owner_admin' && input.actorRoles.includes('admin')) {
    if ((input.policy.roles_admin_may_grant as readonly string[]).includes(input.role)) return;
    throw new InvitationError(
      'role_not_grantable',
      403,
      `Admins may invite ${input.policy.roles_admin_may_grant.join('/')} only; an Owner must invite a ${input.role}.`
    );
  }
  throw new InvitationError('invite_forbidden', 403, 'Owner access required to invite.');
};

// ── create / resend / revoke ────────────────────────────────────────────────

export interface CreateInvitationInput {
  email: string;
  role: MembershipRole;
  invitedBy: { person_id?: string; email: string };
  actor: AuditActor;
  at: string;
  message?: string;
  source?: Invitation['source'];
  via?: 'admin_ui' | 'mcp' | 'chat' | 'system';
  identity?: GoTrueIdentity;
  fetchImpl?: FetchLike;
  /** Skip the GoTrue call (dry runs / import). */
  skipGoTrue?: boolean;
}

export interface CreateInvitationResult {
  invitation: Invitation;
  member: Member;
  /** The v1-shaped view the existing UI reads. */
  user: UserRecord;
  invite: InviteSendResult;
  /** Our opaque accept token — returned ONCE, never stored in clear. */
  accept_token: string;
}

export const createInvitation = async (
  store: MembershipStore,
  input: CreateInvitationInput
): Promise<CreateInvitationResult> => {
  const email = normalizeEmail(input.email);
  const policy = await getPolicy(store);
  if (!emailDomainAllowed(email, policy)) {
    throw new InvitationError('domain_not_allowed', 422, 'This e-mail domain is not allowed by the site policy.', {
      allowed_email_domains: policy.allowed_email_domains,
    });
  }
  const open = await getOpenInvitationByEmail(store, email, input.at);
  if (open) {
    throw new InvitationError('invite_pending_exists', 409, 'An invitation is already pending for this address.', {
      existing_invite_id: open.invite_id,
    });
  }
  const existing = await getMembershipByEmail(store, email);
  if (existing && existing.membership.status === 'active') {
    throw new InvitationError(
      'member_active',
      409,
      'This person is already an active member. Change their role instead.',
      {
        person_id: existing.person.person_id,
      }
    );
  }

  const inviteId = mintInviteId(Date.parse(input.at));
  const acceptToken = mintAcceptToken();
  const invite = input.skipGoTrue
    ? { sent: false, error: 'skipped' }
    : await sendGoTrueInvite({
        email,
        data: { invited_by: input.invitedBy.email, role: input.role, invite_id: inviteId },
        identity: input.identity,
        fetchImpl: input.fetchImpl,
      });

  const invitation = await putInvitation(store, {
    schema_version: 1,
    invite_id: inviteId,
    email,
    role: input.role,
    status: 'pending',
    token_hash: hashToken(acceptToken),
    gotrue: {
      invited: invite.sent || invite.error === 'already_invited',
      ...(invite.error && invite.error !== 'already_invited' ? { error: invite.error } : {}),
      ...(invite.sent ? { last_sent_at: input.at } : {}),
      send_count: invite.sent ? 1 : 0,
    },
    invited_by: input.invitedBy,
    ...(input.message ? { message: input.message } : {}),
    source: input.source ?? 'platform',
    expires_at: addHours(input.at, policy.invite_ttl_hours),
    created_at: input.at,
    updated_at: input.at,
  });
  await setPointer(store, email, inviteId);

  // Person + Membership{invited}. An existing person (suspended / removed /
  // invited-before) is re-invited: status → invited, new invitation id (F6).
  const auditEntry = {
    at: input.at,
    actor_email: input.invitedBy.email,
    action: existing ? 'reinvite' : 'invite',
    detail: existing ? `${existing.membership.status} → invited; role → ${input.role}` : `role ${input.role}`,
  };
  const memberInput = existing
    ? {
        person: { ...existing.person, updated_at: input.at },
        membership: {
          ...existing.membership,
          role: input.role,
          status: 'invited' as const,
          source: 'invitation' as const,
          invitation_id: inviteId,
          granted_by: {
            kind: 'human' as const,
            ...(input.invitedBy.person_id ? { person_id: input.invitedBy.person_id } : {}),
            email: input.invitedBy.email,
          },
          invited_by: input.invitedBy.email,
          audit: [...existing.membership.audit, auditEntry],
          updated_at: input.at,
        },
      }
    : newMember({
        email,
        display_name: friendlyNameFromEmail(email),
        role: input.role,
        status: 'invited',
        source: 'invitation',
        granted_by: {
          kind: 'human',
          ...(input.invitedBy.person_id ? { person_id: input.invitedBy.person_id } : {}),
          email: input.invitedBy.email,
        },
        invited_by: input.invitedBy.email,
        at: input.at,
        invitation_id: inviteId,
        audit: [auditEntry],
      });
  if (existing) {
    delete (memberInput.membership as { suspended?: unknown }).suspended;
    delete (memberInput.membership as { removed?: unknown }).removed;
  }
  const member = await saveMember(store, memberInput);

  await appendAudit(store, {
    at: input.at,
    actor: input.actor,
    action: 'invitation.create',
    target: { person_id: member.person.person_id, email, invite_id: inviteId },
    detail: { role: input.role, gotrue_sent: invite.sent, ...(invite.error ? { gotrue_error: invite.error } : {}) },
    via: input.via ?? 'admin_ui',
  }).catch(() => undefined);

  return { invitation, member, user: memberToUserRecord(member), invite, accept_token: acceptToken };
};

export const resendInvitation = async (
  store: MembershipStore,
  input: {
    invite_id?: string;
    email?: string;
    actor: AuditActor;
    actorEmail: string;
    at: string;
    via?: 'admin_ui' | 'mcp' | 'chat' | 'system';
    identity?: GoTrueIdentity;
    fetchImpl?: FetchLike;
  }
): Promise<{ invitation: Invitation; invite: InviteSendResult; accept_token: string }> => {
  const policy = await getPolicy(store);
  const invitation = await resolveInvitation(store, input, input.at);
  assertPending(invitation);
  if (invitation.gotrue.send_count >= policy.max_resends) {
    throw new InvitationError(
      'resend_cap',
      429,
      `This invitation has been sent ${invitation.gotrue.send_count} times (max ${policy.max_resends}). Revoke it and invite again.`,
      {
        invite_id: invitation.invite_id,
        send_count: invitation.gotrue.send_count,
        max_resends: policy.max_resends,
      }
    );
  }
  const invite = await sendGoTrueInvite({
    email: invitation.email,
    data: { invited_by: invitation.invited_by.email, role: invitation.role, invite_id: invitation.invite_id },
    identity: input.identity,
    fetchImpl: input.fetchImpl,
  });
  // A resend rotates OUR accept token (the old one stops working) and extends the TTL.
  const acceptToken = mintAcceptToken();
  const updated = await putInvitation(store, {
    ...invitation,
    token_hash: hashToken(acceptToken),
    gotrue: {
      ...invitation.gotrue,
      invited: invitation.gotrue.invited || invite.sent || invite.error === 'already_invited',
      ...(invite.error && invite.error !== 'already_invited' ? { error: invite.error } : {}),
      ...(invite.sent ? { last_sent_at: input.at } : {}),
      send_count: invitation.gotrue.send_count + (invite.sent ? 1 : 0),
    },
    expires_at: addHours(input.at, policy.invite_ttl_hours),
    updated_at: input.at,
  });
  const member = await getMembershipByEmail(store, invitation.email);
  if (member) {
    await saveMember(store, {
      person: member.person,
      membership: {
        ...member.membership,
        audit: [...member.membership.audit, { at: input.at, actor_email: input.actorEmail, action: 'reinvite_email' }],
        updated_at: input.at,
      },
    });
  }
  await appendAudit(store, {
    at: input.at,
    actor: input.actor,
    action: 'invitation.resend',
    target: { person_id: personIdForEmail(invitation.email), email: invitation.email, invite_id: invitation.invite_id },
    detail: {
      send_count: updated.gotrue.send_count,
      gotrue_sent: invite.sent,
      ...(invite.error ? { gotrue_error: invite.error } : {}),
    },
    via: input.via ?? 'admin_ui',
  }).catch(() => undefined);
  return { invitation: updated, invite, accept_token: acceptToken };
};

export const revokeInvitation = async (
  store: MembershipStore,
  input: {
    invite_id?: string;
    email?: string;
    actor: AuditActor;
    actorEmail: string;
    at: string;
    reason?: string;
    via?: 'admin_ui' | 'mcp' | 'chat' | 'system';
  }
): Promise<{ invitation: Invitation; membership: Membership | null }> => {
  const invitation = await resolveInvitation(store, input, input.at);
  assertPending(invitation);
  const policy = await getPolicy(store);
  const revoked = await putInvitation(store, {
    ...invitation,
    status: 'revoked',
    revoked: { at: input.at, by: input.actorEmail, ...(input.reason ? { reason: input.reason } : {}) },
    updated_at: input.at,
  });
  await setPointer(store, invitation.email, null);

  // A membership that never activated is removed (kept for audit; purge after grace).
  let membership: Membership | null = null;
  const member = await getMembershipByEmail(store, invitation.email);
  if (member && member.membership.status === 'invited') {
    const saved = await saveMember(store, {
      person: member.person,
      membership: {
        ...member.membership,
        status: 'removed',
        removed: {
          at: input.at,
          by: input.actorEmail,
          reason: input.reason ?? 'invitation revoked',
          purge_after: addDays(input.at, policy.purge_grace_days),
        },
        audit: [
          ...member.membership.audit,
          {
            at: input.at,
            actor_email: input.actorEmail,
            action: 'revoke_invite',
            ...(input.reason ? { detail: input.reason } : {}),
          },
        ],
        updated_at: input.at,
      },
    });
    membership = saved.membership;
  }
  await appendAudit(store, {
    at: input.at,
    actor: input.actor,
    action: 'invitation.revoke',
    target: { person_id: personIdForEmail(invitation.email), email: invitation.email, invite_id: invitation.invite_id },
    ...(input.reason ? { detail: { reason: input.reason } } : {}),
    via: input.via ?? 'admin_ui',
  }).catch(() => undefined);
  return { invitation: revoked, membership };
};

// ── accept / activate ───────────────────────────────────────────────────────

/**
 * The `accept` verb's store transition (T18.0a contract, now invitation-aware):
 * an invited membership becomes active with the display name the person
 * typed; the pending invitation (matched BY E-MAIL) becomes `accepted` and
 * its `role` is copied onto the membership; identity user_id is stamped.
 * Idempotent (a second call returns the same active record, no second
 * audit). Returns null when no member exists — the caller answers
 * `needs_grant:true`; nothing is created or granted.
 */
export const acceptInvitation = async (
  store: MembershipStore,
  email: string,
  userId: string | undefined,
  displayName: string,
  at: string
): Promise<UserRecord | null> => {
  const normalized = normalizeEmail(email);
  const member = await getMembershipByEmail(store, normalized);
  if (!member) return null;
  const invitation = await getOpenInvitationByEmail(store, normalized, at);

  if (member.membership.status !== 'invited') {
    // Already active (idempotent re-accept) or suspended/removed — the accept
    // page never re-opens a closed membership; only stamp last_seen / identity.
    const saved = await saveMember(store, {
      person: {
        ...member.person,
        identity: {
          ...member.person.identity,
          ...(userId && !member.person.identity.user_id ? { user_id: userId } : {}),
        },
        last_seen_at: at,
      },
      membership: member.membership,
    });
    if (invitation) await closeInvitationAsAccepted(store, invitation, member.person.person_id, at);
    return memberToUserRecord(saved);
  }

  const role = invitation?.role ?? member.membership.role;
  const saved = await saveMember(store, {
    person: {
      ...member.person,
      display_name: displayName,
      identity: { ...member.person.identity, ...(userId ? { user_id: member.person.identity.user_id ?? userId } : {}) },
      updated_at: at,
      last_seen_at: at,
    },
    membership: {
      ...member.membership,
      role,
      status: 'active',
      ...(invitation ? { invitation_id: invitation.invite_id, source: 'invitation' as const } : {}),
      audit: [
        ...member.membership.audit,
        { at, actor_email: normalized, action: 'accept', detail: `display_name ${displayName}` },
      ],
      updated_at: at,
    },
  });
  await stampOnboarding(store, normalized, { steps: { password: at, name: at }, at }).catch(() => undefined);
  if (invitation) await closeInvitationAsAccepted(store, invitation, saved.person.person_id, at);
  await appendAudit(store, {
    at,
    actor: { kind: 'human', id: userId, email: normalized },
    action: invitation ? 'invitation.accept' : 'membership.activate',
    target: {
      person_id: saved.person.person_id,
      email: normalized,
      ...(invitation ? { invite_id: invitation.invite_id } : {}),
    },
    via: 'admin_ui',
  }).catch(() => undefined);
  const fresh = await getMembershipByEmail(store, normalized);
  return memberToUserRecord(fresh ?? saved);
};

const closeInvitationAsAccepted = async (
  store: MembershipStore,
  invitation: Invitation,
  personId: string,
  at: string
) => {
  await putInvitation(store, {
    ...invitation,
    status: 'accepted',
    accepted: { at, person_id: personId },
    updated_at: at,
  });
  await setPointer(store, invitation.email, null);
};

/**
 * First-login activation (T9.5): flip an `invited` membership to `active` and
 * stamp the GoTrue user_id + last_seen (closing a pending invitation the same
 * way `accept` does). Active/suspended memberships only get last_seen; no
 * member → null (bootstrap owners have no stored record).
 */
export const activateOnLogin = async (
  store: MembershipStore,
  email: string,
  userId: string | undefined,
  at: string
): Promise<UserRecord | null> => {
  const normalized = normalizeEmail(email);
  const member = await getMembershipByEmail(store, normalized);
  if (!member) return null;
  if (member.membership.status === 'invited') {
    const invitation = await getOpenInvitationByEmail(store, normalized, at);
    const saved = await saveMember(store, {
      person: {
        ...member.person,
        identity: {
          ...member.person.identity,
          ...(userId ? { user_id: member.person.identity.user_id ?? userId } : {}),
        },
        updated_at: at,
        last_seen_at: at,
      },
      membership: {
        ...member.membership,
        role: invitation?.role ?? member.membership.role,
        status: 'active',
        audit: [...member.membership.audit, { at, actor_email: normalized, action: 'activate' }],
        updated_at: at,
      },
    });
    if (invitation) await closeInvitationAsAccepted(store, invitation, saved.person.person_id, at);
    return memberToUserRecord(saved);
  }
  const saved = await saveMember(store, {
    person: { ...member.person, last_seen_at: at },
    membership: member.membership,
  });
  return memberToUserRecord(saved);
};

// ── preview (our token) / list / sweep ──────────────────────────────────────

/** Path 2 sugar: an Owner-shared link carrying OUR accept token previews the invitation before GoTrue accepts. */
export const previewInvitationByToken = async (
  store: MembershipStore,
  token: string,
  now = new Date().toISOString()
): Promise<{
  email: string;
  role: MembershipRole;
  invited_by: string;
  expires_at: string;
  expired: boolean;
} | null> => {
  const hash = hashToken(token);
  const items = await collectBlobListItems(
    await store.list({ prefix: PREFIXES.invitation, directories: false, paginate: true })
  );
  for (const blob of items) {
    const parsed = invitationSchema.safeParse(parseJson(await store.get(blob.key)));
    if (!parsed.success || parsed.data.token_hash !== hash) continue;
    const invitation = await expireIfStale(store, parsed.data, now);
    return {
      email: invitation.email,
      role: invitation.role,
      invited_by: invitation.invited_by.email,
      expires_at: invitation.expires_at,
      expired: invitation.status !== 'pending',
    };
  }
  return null;
};

export const listInvitations = async (
  store: MembershipStore,
  opts: { status?: Invitation['status']; now?: string } = {}
): Promise<Invitation[]> => {
  const now = opts.now ?? new Date().toISOString();
  const items = await collectBlobListItems(
    await store.list({ prefix: PREFIXES.invitation, directories: false, paginate: true })
  );
  const out: Invitation[] = [];
  for (const blob of items) {
    const parsed = invitationSchema.safeParse(parseJson(await store.get(blob.key)));
    if (!parsed.success) continue;
    const current = await expireIfStale(store, parsed.data, now);
    if (opts.status && current.status !== opts.status) continue;
    out.push(current);
  }
  return out.sort((a, b) => b.created_at.localeCompare(a.created_at));
};

/** Sweep: expire every stale pending invitation (T18.4 wires the scheduled function). Returns the ids expired. */
export const expireAll = async (store: MembershipStore, now = new Date().toISOString()): Promise<string[]> => {
  const items = await collectBlobListItems(
    await store.list({ prefix: PREFIXES.invitation, directories: false, paginate: true })
  );
  const expired: string[] = [];
  for (const blob of items) {
    const parsed = invitationSchema.safeParse(parseJson(await store.get(blob.key)));
    if (!parsed.success || parsed.data.status !== 'pending') continue;
    const current = await expireIfStale(store, parsed.data, now);
    if (current.status === 'expired') expired.push(current.invite_id);
  }
  return expired;
};

// ── reconcile against GoTrue's identity list (plan §4.2) ────────────────────

export interface UnmanagedIdentity {
  id: string;
  email: string;
  confirmed: boolean;
  invited_at?: string;
  created_at?: string;
  last_sign_in_at?: string;
}

/**
 * GoTrue identities with NO membership on this site — people invited from the
 * Netlify UI (or leftovers). Needs the injected admin token; without it (or
 * on any failure) degrades to `[]` + `error_code:'identity_admin_unavailable'`.
 */
export const listUnmanagedIdentities = async (input: {
  store: MembershipStore;
  identity?: GoTrueIdentity;
  fetchImpl?: FetchLike;
  perPage?: number;
}): Promise<{ identities: UnmanagedIdentity[]; error_code?: 'identity_admin_unavailable'; error?: string }> => {
  if (!input.identity || !input.fetchImpl) {
    return { identities: [], error_code: 'identity_admin_unavailable', error: 'Identity admin token unavailable.' };
  }
  try {
    const res = await input.fetchImpl(`${input.identity.url}/admin/users?per_page=${input.perPage ?? 1000}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${input.identity.token}` },
    });
    if (!res.ok || typeof res.json !== 'function') {
      return {
        identities: [],
        error_code: 'identity_admin_unavailable',
        error: `GoTrue admin list failed (${res.status}).`,
      };
    }
    const body = (await res.json()) as { users?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const users = Array.isArray(body) ? body : (body.users ?? []);
    const members = await listMembers(input.store);
    const known = new Set(members.map((m) => m.person.email));
    const identities: UnmanagedIdentity[] = [];
    for (const u of users) {
      const email = typeof u.email === 'string' ? normalizeEmail(u.email) : '';
      const id = typeof u.id === 'string' ? u.id : '';
      if (!email || !id || known.has(email)) continue;
      identities.push({
        id,
        email,
        confirmed: Boolean(u.confirmed_at),
        ...(typeof u.invited_at === 'string' ? { invited_at: u.invited_at } : {}),
        ...(typeof u.created_at === 'string' ? { created_at: u.created_at } : {}),
        ...(typeof u.last_sign_in_at === 'string' ? { last_sign_in_at: u.last_sign_in_at } : {}),
      });
    }
    return { identities: identities.sort((a, b) => a.email.localeCompare(b.email)) };
  } catch (e) {
    return {
      identities: [],
      error_code: 'identity_admin_unavailable',
      error: e instanceof Error ? e.message : 'GoTrue admin list failed.',
    };
  }
};
