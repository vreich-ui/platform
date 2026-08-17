/**
 * Offboarding (W18 T18.4, plan §5, F5, F12) — what suspend / remove / purge
 * DO beyond flipping a status:
 *
 *   revokeOAuthGrantsForSubject   every OAuth access/refresh/code record whose
 *                                 subject is the person (via the by-subject
 *                                 index oauth-store.ts writes on mint) — a
 *                                 removed member's MCP token stops working at
 *                                 once, not when it expires
 *   releaseLocksHeldBy            force-release every object lock the person
 *                                 holds; history `lock_forced_on_offboarding`
 *                                 attributed to the acting Owner with
 *                                 `on_behalf_of` the person
 *   deleteIdentity                GoTrue `DELETE /admin/users/{id}` (idempotent
 *                                 on 404) — needs the admin token Netlify
 *                                 injects ONLY into requests carrying an
 *                                 Identity JWT; the scheduled sweep has none,
 *                                 so deletes that cannot run are QUEUED
 *                                 (`identity-delete-queue/<person_id>`) and
 *                                 drained by the next Owner request that has a
 *                                 token (`drainIdentityDeleteQueue`)
 *   scrubPerson                   PII → `{ person_id, deleted:true, deleted_at }`,
 *                                 indexes removed, avatar soft-deleted,
 *                                 membership kept as `removed`, audit kept
 *   transferOwnership             from → admin (unless told otherwise), to → owner
 *   exportPerson                  the GDPR-style bundle
 *   purgeExpiredMemberships       the sweep: `removed` past `purge_after` → scrub
 *
 * Effective lockout for suspend/remove: roles resolve per request from the
 * store (immediate) and OAuth grants are revoked here (immediate); an Identity
 * JWT already issued lives ≤ 1 h and cannot be revoked server-side (GoTrue has
 * no admin logout) — the UI copy says "within an hour", and every function
 * re-resolves roles per call, so a suspended member cannot ACT even with a
 * live JWT.
 */
import type { Principal } from '../../../schema/object-record-v1.js';
import { objectTypes, type ObjectRecord } from '../../../schema/object-record-v1.js';
import { isObjectLockActive } from '../object-lock.js';
import { objectRecordKey, objectStatusIndexPrefix } from '../object-store-keys.js';
import { subjectIndexEntrySchema, subjectIndexPrefix, type OAuthBlobStore } from '../oauth-store.js';
import { getMembershipByEmail, listMembers, type Member } from './read.js';
import { listInvitations, type FetchLike, type GoTrueIdentity } from './invitations.js';
import {
  KEYS,
  MEMBERSHIP_SCHEMA_VERSION,
  normalizeEmail,
  type AuditActor,
  type AuditEvent,
  type Invitation,
  type Membership,
  type MembershipStore,
  type Person,
} from './store.js';
import { appendAudit, getPolicy, listAuditForEmail, saveMember, putMembership } from './write.js';

// ── OAuth grants ────────────────────────────────────────────────────────────

const deleteKey = async (store: OAuthBlobStore, key: string): Promise<void> => {
  if (typeof store.delete === 'function') {
    await store.delete(key);
    return;
  }
  if (typeof store.del === 'function') await store.del(key);
};

/**
 * Delete every access / refresh / code record indexed for the subject, plus
 * the index entries. Only THIS subject's grants are touched — the index is
 * per e-mail. Returns what was revoked. A store without `list` (or a listing
 * failure) revokes nothing and says so.
 */
export const revokeOAuthGrantsForSubject = async (
  store: OAuthBlobStore,
  subjectEmail: string
): Promise<{ revoked: number; kinds: Record<'token' | 'refresh' | 'code', number>; error?: string }> => {
  const kinds = { token: 0, refresh: 0, code: 0 };
  if (typeof store.list !== 'function') {
    return { revoked: 0, kinds, error: 'oauth store cannot list; nothing revoked' };
  }
  let listed: { blobs: { key: string }[] };
  try {
    listed = await store.list({ prefix: subjectIndexPrefix(subjectEmail), directories: false, paginate: true });
  } catch (e) {
    return { revoked: 0, kinds, error: e instanceof Error ? e.message : 'oauth index list failed' };
  }
  let revoked = 0;
  for (const blob of listed.blobs ?? []) {
    let entry: { kind: 'token' | 'refresh' | 'code'; key: string } | null = null;
    try {
      const raw = await store.get(blob.key);
      const parsed = subjectIndexEntrySchema.safeParse(raw ? JSON.parse(raw) : null);
      if (parsed.success) entry = parsed.data;
    } catch {
      entry = null;
    }
    if (entry) {
      await deleteKey(store, entry.key).catch(() => undefined);
      kinds[entry.kind] += 1;
      revoked += 1;
    }
    await deleteKey(store, blob.key).catch(() => undefined);
  }
  return { revoked, kinds };
};

// ── locks ───────────────────────────────────────────────────────────────────

/** The object store surface the lock hand-off needs. */
export interface ObjectLockSweepStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<{ blobs: { key: string }[] }>;
}

const parseRecord = (raw: string | null): ObjectRecord | undefined => {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as ObjectRecord;
  } catch {
    return undefined;
  }
};

/**
 * Enumerate every active object record, force-release each lock held by the
 * person (matched by GoTrue user id OR e-mail label), and write the history
 * entry `lock_forced_on_offboarding` attributed to the acting Owner with
 * `on_behalf_of` the person. Returns the released object ids.
 */
export const releaseLocksHeldBy = async (
  store: ObjectLockSweepStore,
  input: {
    person: { email: string; person_id: string; user_id?: string };
    actor: Principal;
    at: string;
    reason: 'suspend' | 'remove';
  }
): Promise<Array<{ object_id: string; object_type: string }>> => {
  const released: Array<{ object_id: string; object_type: string }> = [];
  const nowMs = Date.parse(input.at);
  const email = normalizeEmail(input.person.email);
  for (const objectType of objectTypes) {
    let listed: { blobs: { key: string }[] };
    try {
      listed = await store.list({
        prefix: objectStatusIndexPrefix(objectType, 'active'),
        directories: false,
        paginate: true,
      });
    } catch {
      continue;
    }
    for (const blob of listed.blobs ?? []) {
      const objectId = blob.key.split('/').pop() ?? '';
      if (!objectId) continue;
      const key = objectRecordKey(objectType, objectId);
      let record: ObjectRecord | undefined;
      try {
        record = parseRecord(await store.get(key));
      } catch {
        record = undefined;
      }
      if (!record?.lock || !isObjectLockActive(record.lock, nowMs)) continue;
      const lock = record.lock;
      const held =
        (input.person.user_id && lock.owner_id === input.person.user_id) ||
        normalizeEmail(lock.owner_label ?? '') === email ||
        normalizeEmail(lock.owner_id ?? '') === email;
      if (!held) continue;
      const next: ObjectRecord = {
        ...record,
        lock: undefined,
        updated_at: input.at,
        version: record.version + 1,
        history: [
          ...record.history,
          {
            at: input.at,
            action: 'lock_forced_on_offboarding',
            actor: input.actor,
            details: {
              reason: input.reason,
              on_behalf_of: {
                email,
                person_id: input.person.person_id,
                ...(input.person.user_id ? { user_id: input.person.user_id } : {}),
              },
              previous_owner_id: lock.owner_id,
              previous_owner_label: lock.owner_label,
            },
          },
        ],
      };
      await store.setJSON(key, next);
      released.push({ object_id: record.object_id, object_type: record.object_type });
    }
  }
  return released;
};

// ── identity ────────────────────────────────────────────────────────────────

/** `DELETE {identity}/admin/users/{id}` — idempotent on 404. */
export const deleteIdentity = async (input: {
  identity: GoTrueIdentity;
  fetchImpl: FetchLike;
  gotrue_user_id: string;
}): Promise<{ deleted: boolean; status: number; error?: string }> => {
  try {
    const res = await input.fetchImpl(`${input.identity.url}/admin/users/${encodeURIComponent(input.gotrue_user_id)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${input.identity.token}` },
    });
    if (res.ok || res.status === 404) return { deleted: true, status: res.status };
    return { deleted: false, status: res.status, error: `GoTrue delete failed (${res.status}).` };
  } catch (e) {
    return { deleted: false, status: 0, error: e instanceof Error ? e.message : 'GoTrue delete failed.' };
  }
};

/** Resolve a GoTrue user id for an e-mail when the person record has none (Netlify-UI users): `GET /admin/users` filtered. */
const lookupIdentityId = async (
  identity: GoTrueIdentity,
  fetchImpl: FetchLike,
  email: string
): Promise<string | undefined> => {
  try {
    const res = await fetchImpl(`${identity.url}/admin/users?per_page=1000`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${identity.token}` },
    });
    if (!res.ok || typeof res.json !== 'function') return undefined;
    const body = (await res.json()) as { users?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
    const users = Array.isArray(body) ? body : (body.users ?? []);
    const hit = users.find((u) => typeof u.email === 'string' && normalizeEmail(u.email) === normalizeEmail(email));
    return typeof hit?.id === 'string' ? hit.id : undefined;
  } catch {
    return undefined;
  }
};

const IDENTITY_QUEUE_PREFIX = 'identity-delete-queue/';
const identityQueueKey = (personId: string) => `${IDENTITY_QUEUE_PREFIX}${personId}.json`;

/**
 * Delete the person's GoTrue identity now if an admin token is at hand;
 * otherwise queue it (the scheduled sweep has no Identity JWT and therefore
 * no admin token — see the file header). Returns what happened.
 */
export const deleteOrQueueIdentity = async (
  store: MembershipStore,
  input: {
    person: { person_id: string; email: string; user_id?: string };
    identity?: GoTrueIdentity;
    fetchImpl?: FetchLike;
    at: string;
    reason: string;
  }
): Promise<{ outcome: 'deleted' | 'queued' | 'failed'; gotrue_user_id?: string; error?: string }> => {
  if (!input.identity || !input.fetchImpl) {
    await store.setJSON(identityQueueKey(input.person.person_id), {
      person_id: input.person.person_id,
      email: input.person.email,
      ...(input.person.user_id ? { user_id: input.person.user_id } : {}),
      queued_at: input.at,
      reason: input.reason,
    });
    return { outcome: 'queued' };
  }
  const id = input.person.user_id ?? (await lookupIdentityId(input.identity, input.fetchImpl, input.person.email));
  if (!id) return { outcome: 'deleted' }; // no identity exists for this address — nothing to delete
  const res = await deleteIdentity({ identity: input.identity, fetchImpl: input.fetchImpl, gotrue_user_id: id });
  if (res.deleted) return { outcome: 'deleted', gotrue_user_id: id };
  await store.setJSON(identityQueueKey(input.person.person_id), {
    person_id: input.person.person_id,
    email: input.person.email,
    user_id: id,
    queued_at: input.at,
    reason: input.reason,
    last_error: res.error,
  });
  return { outcome: 'failed', gotrue_user_id: id, error: res.error };
};

/** Drain the queue with a token — called at the start of any Owner request that carries one. */
export const drainIdentityDeleteQueue = async (
  store: MembershipStore,
  input: { identity?: GoTrueIdentity; fetchImpl?: FetchLike; at: string; actor?: AuditActor }
): Promise<{ drained: number; remaining: number }> => {
  const listed = await store
    .list({ prefix: IDENTITY_QUEUE_PREFIX, directories: false, paginate: true })
    .catch(() => ({ blobs: [] }));
  const blobs = listed.blobs ?? [];
  if (!input.identity || !input.fetchImpl) return { drained: 0, remaining: blobs.length };
  let drained = 0;
  for (const blob of blobs) {
    let entry: { person_id: string; email: string; user_id?: string } | null = null;
    try {
      entry = JSON.parse((await store.get(blob.key)) ?? 'null');
    } catch {
      entry = null;
    }
    if (!entry) {
      await store.delete?.(blob.key);
      continue;
    }
    const id = entry.user_id ?? (await lookupIdentityId(input.identity, input.fetchImpl, entry.email));
    const res = id
      ? await deleteIdentity({ identity: input.identity, fetchImpl: input.fetchImpl, gotrue_user_id: id })
      : { deleted: true, status: 404 };
    if (res.deleted) {
      if (typeof store.delete === 'function') await store.delete(blob.key);
      else await store.setJSON(blob.key, null);
      drained += 1;
      await appendAudit(store, {
        at: input.at,
        actor: input.actor ?? { kind: 'system' },
        action: 'person.sessions_revoked',
        target: { person_id: entry.person_id, email: entry.email },
        detail: { identity_deleted: true, gotrue_user_id: id ?? null, drained_from_queue: true },
        via: input.actor ? 'admin_ui' : 'system',
      }).catch(() => undefined);
    }
  }
  return { drained, remaining: blobs.length - drained };
};

// ── purge / scrub ───────────────────────────────────────────────────────────

export const scrubPerson = async (
  store: MembershipStore,
  input: {
    person: Person;
    membership: Membership;
    at: string;
    softDeleteAvatar?: (ref: string) => Promise<void>;
  }
): Promise<void> => {
  const { person, membership } = input;
  // indexes first, so a concurrent read cannot resolve the e-mail to a scrubbed record
  if (typeof store.delete === 'function') {
    await store.delete(KEYS.byEmail(person.email)).catch(() => undefined);
    if (person.identity.user_id) await store.delete(KEYS.byIdentity(person.identity.user_id)).catch(() => undefined);
  } else {
    await store.setJSON(KEYS.byEmail(person.email), null);
    if (person.identity.user_id) await store.setJSON(KEYS.byIdentity(person.identity.user_id), null);
  }
  if (person.avatar_artifact && input.softDeleteAvatar)
    await input.softDeleteAvatar(person.avatar_artifact).catch(() => undefined);
  await store.setJSON(KEYS.person(person.person_id), {
    schema_version: MEMBERSHIP_SCHEMA_VERSION,
    person_id: person.person_id,
    deleted: true,
    deleted_at: input.at,
  });
  await putMembership(store, {
    ...membership,
    status: 'removed',
    removed: membership.removed ?? { at: input.at, by: 'system', purge_after: input.at },
    audit: [...membership.audit, { at: input.at, actor_email: 'system', action: 'purge' }],
    updated_at: input.at,
  });
};

/** Sweep: every `removed` membership past `purge_after` is scrubbed. Idempotent. Returns the person ids purged. */
export const purgeExpiredMemberships = async (
  store: MembershipStore,
  input: { now: string; softDeleteAvatar?: (ref: string) => Promise<void> }
): Promise<string[]> => {
  const purged: string[] = [];
  for (const member of await listMembers(store)) {
    const { membership, person } = member;
    if (membership.status !== 'removed' || !membership.removed) continue;
    if (membership.removed.purge_after > input.now) continue;
    if (membership.audit.some((a) => a.action === 'purge')) continue;
    await scrubPerson(store, { person, membership, at: input.now, softDeleteAvatar: input.softDeleteAvatar });
    await appendAudit(store, {
      at: input.now,
      actor: { kind: 'system' },
      action: 'membership.purge',
      target: { person_id: person.person_id, email: person.email },
      via: 'system',
    }).catch(() => undefined);
    purged.push(person.person_id);
  }
  return purged;
};

// ── ownership transfer ──────────────────────────────────────────────────────

export class OffboardingError extends Error {
  readonly code: 'not_found' | 'not_active' | 'same_person' | 'last_owner' | 'env_managed_member' | 'confirm_mismatch';
  readonly status: number;
  constructor(code: OffboardingError['code'], status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

/** `from` → `demoteTo` (default admin), `to` → owner. Both must be active stored members. Audits both. */
export const transferOwnership = async (
  store: MembershipStore,
  input: {
    from: string;
    to: string;
    actor: AuditActor;
    actorEmail: string;
    at: string;
    demoteTo?: Membership['role'] | 'keep';
  }
): Promise<{ from: Member; to: Member }> => {
  const fromEmail = normalizeEmail(input.from);
  const toEmail = normalizeEmail(input.to);
  if (fromEmail === toEmail)
    throw new OffboardingError('same_person', 409, 'Choose a different member to transfer ownership to.');
  const from = await getMembershipByEmail(store, fromEmail);
  const to = await getMembershipByEmail(store, toEmail);
  if (!from || !to) throw new OffboardingError('not_found', 404, 'Both members must exist.');
  if (from.membership.status !== 'active' || to.membership.status !== 'active') {
    throw new OffboardingError('not_active', 409, 'Both members must be active.');
  }
  const demote = input.demoteTo ?? 'admin';
  const savedTo = await saveMember(store, {
    person: to.person,
    membership: {
      ...to.membership,
      role: 'owner',
      audit: [
        ...to.membership.audit,
        { at: input.at, actor_email: input.actorEmail, action: 'transfer_ownership', detail: `from ${fromEmail}` },
      ],
      updated_at: input.at,
    },
  });
  const savedFrom = await saveMember(store, {
    person: from.person,
    membership: {
      ...from.membership,
      role: demote === 'keep' ? from.membership.role : demote,
      audit: [
        ...from.membership.audit,
        { at: input.at, actor_email: input.actorEmail, action: 'transfer_ownership', detail: `to ${toEmail}` },
      ],
      updated_at: input.at,
    },
  });
  await appendAudit(store, {
    at: input.at,
    actor: input.actor,
    action: 'membership.transfer_ownership',
    target: { person_id: from.person.person_id, email: fromEmail },
    detail: { to: toEmail, to_person_id: to.person.person_id, from_role_after: savedFrom.membership.role },
    via: 'admin_ui',
  }).catch(() => undefined);
  return { from: savedFrom, to: savedTo };
};

// ── export ──────────────────────────────────────────────────────────────────

export interface PersonExport {
  exported_at: string;
  person: Person;
  memberships: Membership[];
  invitations: Invitation[];
  audit: AuditEvent[];
  /** Object-history entries authored by the person — ids only (object_type/object_id/at/action). */
  authored_history: Array<{ object_type: string; object_id: string; at: string; action: string }>;
}

export const exportPerson = async (
  store: MembershipStore,
  input: { email: string; at: string; objectStore?: ObjectLockSweepStore }
): Promise<PersonExport | null> => {
  const member = await getMembershipByEmail(store, input.email);
  if (!member) return null;
  const email = member.person.email;
  const invitations = (await listInvitations(store, { now: input.at })).filter((i) => i.email === email);
  const audit = await listAuditForEmail(store, email, 10_000);
  const authored: PersonExport['authored_history'] = [];
  if (input.objectStore) {
    for (const objectType of objectTypes) {
      for (const status of ['active', 'archived'] as const) {
        let listed: { blobs: { key: string }[] };
        try {
          listed = await input.objectStore.list({
            prefix: objectStatusIndexPrefix(objectType, status),
            directories: false,
            paginate: true,
          });
        } catch {
          continue;
        }
        for (const blob of listed.blobs ?? []) {
          const objectId = blob.key.split('/').pop() ?? '';
          const record = parseRecord(
            await input.objectStore.get(objectRecordKey(objectType, objectId)).catch(() => null)
          );
          if (!record) continue;
          for (const h of record.history) {
            const actor = h.actor;
            if (actor.kind === 'human' && normalizeEmail(actor.email) === email) {
              authored.push({
                object_type: record.object_type,
                object_id: record.object_id,
                at: h.at,
                action: h.action,
              });
            }
          }
        }
      }
    }
  }
  return {
    exported_at: input.at,
    person: member.person,
    memberships: [member.membership],
    invitations,
    audit,
    authored_history: authored,
  };
};

/** Server-side check for the typed purge confirmation. */
export const purgeConfirmMatches = (confirm: string | undefined, email: string): boolean =>
  typeof confirm === 'string' && confirm.trim().toLowerCase() === `purge ${normalizeEmail(email)}`;

export { getPolicy };
