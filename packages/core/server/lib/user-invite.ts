/**
 * Invite + first-login activation (T9.5). Extracted from the admin-users
 * function so the GoTrue call is injectable and the store transitions are
 * unit-tested. The store record is the source of truth; the GoTrue invite
 * (which sends the Netlify Identity invitation email) is best-effort — a
 * failure there does not lose the invited record.
 *
 * GoTrue endpoint fact (T18.0a, plan §1 F2): the mail-sending endpoint is
 * `POST {identity}/invite { email, data }` with the admin bearer. It creates
 * the (unconfirmed) user AND sends the invitation e-mail; the invitee accepts
 * with `POST {identity}/verify { type:'signup', token, password }`.
 * `POST {identity}/admin/users` — what this file called before T18.0a —
 * creates a user, REQUIRES a password (422 without one) and sends nothing.
 * `data` is informational only (GoTrue `user_metadata`); the store stays the
 * source of truth for roles — nothing reads roles back out of GoTrue.
 *
 * No new secrets: the caller passes the short-lived admin identity Netlify
 * injects at `context.clientContext.identity` ({ url, token }).
 */
import {
  getUserRecord,
  putUserRecord,
  normalizeUserEmail,
  type UserRecord,
  type UserRole,
  type UsersBlobStore,
} from './users-store.js';
import { friendlyNameFromEmail } from '../../lib/admin/display-name.js';

export interface GoTrueIdentity {
  url: string;
  token: string;
}

type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; status: number; text?: () => Promise<string> }>;

export interface InviteResult {
  record: UserRecord;
  invite: { sent: boolean; error?: string };
}

/** GoTrue's 422 body when the address already has a (confirmed or invited) user. */
const ALREADY_INVITED_RE = /already\s+(been\s+)?(registered|invited)/i;

export const inviteUser = async (opts: {
  store: UsersBlobStore;
  email: string;
  role: UserRole;
  invitedBy: string;
  at: string;
  identity?: GoTrueIdentity;
  fetchImpl?: FetchLike;
  /**
   * T18.0a: when true and the record already exists with `status:'invited'`
   * (including a `disabled` record this call just reactivated), fire the
   * GoTrue invite again (GoTrue re-sends for an unconfirmed user) and audit
   * `reinvite_email`. Default false: an existing record only gets its role
   * (and, F6, its status) updated — no e-mail.
   */
  resendIfExisting?: boolean;
}): Promise<InviteResult> => {
  const email = normalizeUserEmail(opts.email);
  const existing = await getUserRecord(opts.store, email);

  // Idempotent: re-inviting an existing member updates the role and audits it,
  // never duplicates the record; a first invite creates an `invited` record.
  let record: UserRecord;
  let fireGoTrue: boolean;
  if (existing) {
    // F6 fix (minimal, pre-v2): re-inviting a disabled member reactivates
    // them as `invited` — the UI copy promises exactly this.
    const reactivate = existing.status === 'disabled';
    const status = reactivate ? 'invited' : existing.status;
    const resend = opts.resendIfExisting === true && status === 'invited';
    record = {
      ...existing,
      role: opts.role,
      status,
      updated_at: opts.at,
      audit: [
        ...existing.audit,
        {
          at: opts.at,
          actor_email: opts.invitedBy,
          action: 'reinvite',
          detail: reactivate ? `disabled → invited; role → ${opts.role}` : `role → ${opts.role}`,
        },
        ...(resend ? [{ at: opts.at, actor_email: opts.invitedBy, action: 'reinvite_email' }] : []),
      ],
    };
    fireGoTrue = resend;
  } else {
    record = {
      schema_version: 1,
      email,
      // D3 (2026-08-06): a friendly default, not the raw email — the
      // `existing` branch above is taken whenever a record (with whatever
      // display_name it carries) already exists, so this only ever runs on
      // a genuinely NEW invite and never overwrites one a user set.
      display_name: friendlyNameFromEmail(email),
      role: opts.role,
      status: 'invited',
      invited_by: opts.invitedBy,
      created_at: opts.at,
      updated_at: opts.at,
      audit: [{ at: opts.at, actor_email: opts.invitedBy, action: 'invite', detail: `role ${opts.role}` }],
    };
    fireGoTrue = true;
  }
  await putUserRecord(opts.store, record);

  if (!fireGoTrue) {
    return {
      record,
      invite: { sent: false, error: 'Existing member updated; no invite e-mail sent (resendIfExisting re-sends).' },
    };
  }

  let sent = false;
  let error: string | undefined;
  if (opts.identity && opts.fetchImpl) {
    try {
      const res = await opts.fetchImpl(`${opts.identity.url}/invite`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.identity.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, data: { invited_by: opts.invitedBy, role: opts.role } }),
      });
      sent = res.ok;
      if (!res.ok) {
        let bodyText = '';
        if (res.status === 422 && typeof res.text === 'function') {
          try {
            bodyText = await res.text();
          } catch {
            bodyText = '';
          }
        }
        // 422 "already registered" / "already been invited": GoTrue has the
        // user already — not a failure of ours, and not a throw.
        if (res.status === 422 && (typeof res.text !== 'function' || ALREADY_INVITED_RE.test(bodyText))) {
          error = 'already_invited';
        } else {
          error = `GoTrue invite failed (${res.status}).`;
        }
      }
    } catch (e) {
      error = e instanceof Error ? e.message : 'GoTrue invite failed.';
    }
  } else {
    error = 'Identity admin token unavailable; store record created, invite email not sent.';
  }

  return { record, invite: { sent, ...(error ? { error } : {}) } };
};

/**
 * First-login activation: flip an `invited` record to `active` and stamp the
 * GoTrue user_id + last_seen. Active/disabled records only get last_seen; a
 * non-existent record returns null (bootstrap owners have no stored record).
 */
export const activateOnLogin = async (
  store: UsersBlobStore,
  email: string,
  userId: string | undefined,
  at: string
): Promise<UserRecord | null> => {
  const record = await getUserRecord(store, normalizeUserEmail(email));
  if (!record) return null;
  if (record.status === 'invited') {
    const activated: UserRecord = {
      ...record,
      status: 'active',
      user_id: record.user_id ?? userId,
      updated_at: at,
      last_seen_at: at,
      audit: [...record.audit, { at, actor_email: record.email, action: 'activate' }],
    };
    await putUserRecord(store, activated);
    return activated;
  }
  const seen: UserRecord = { ...record, last_seen_at: at };
  await putUserRecord(store, seen);
  return seen;
};

/**
 * T18.0a — the `accept` verb's store transition: an invited record becomes
 * active with the display name the person typed on the accept page; a second
 * call is idempotent (returns the same active record, no second `accept`
 * audit). Returns null when no record exists — the caller decides what that
 * means (admin-users answers `needs_grant:true`; nothing is created/granted).
 */
export const acceptInvitation = async (
  store: UsersBlobStore,
  email: string,
  userId: string | undefined,
  displayName: string,
  at: string
): Promise<UserRecord | null> => {
  const record = await getUserRecord(store, normalizeUserEmail(email));
  if (!record) return null;
  if (record.status !== 'invited') {
    // Already active (idempotent re-accept) or disabled — the accept page
    // never re-opens a disabled membership; only stamp last_seen.
    const seen: UserRecord = { ...record, last_seen_at: at };
    await putUserRecord(store, seen);
    return seen;
  }
  const accepted: UserRecord = {
    ...record,
    status: 'active',
    display_name: displayName,
    user_id: record.user_id ?? userId,
    updated_at: at,
    last_seen_at: at,
    audit: [
      ...record.audit,
      { at, actor_email: record.email, action: 'accept', detail: `display_name ${displayName}` },
    ],
  };
  await putUserRecord(store, accepted);
  return accepted;
};
