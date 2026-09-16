/**
 * Generalized record-lock library for ObjectRecord envelopes.
 *
 * Behavioral parity contract: these operations replicate the article lock in
 * netlify/functions/admin-workflow-lock.ts (documented in
 * docs/cms-architecture/01-audit.md §1.2) point by point — 900 s default /
 * 3600 s max lease, 423 conflicts with sanitized holder info (the lock token
 * is never returned to a non-holder), append-only history entries on every
 * lock mutation, and a `version` bump per lock write — parameterized by blob
 * store + record key instead of being bound to workflows/by-id/{requestId}.json.
 * The article endpoint is deliberately not imported or modified.
 *
 * Envelope-specific invariant (docs/cms-architecture/02-architecture-and-schema.md
 * §3.1): lock writes bump `version` and NEVER `content_revision`. Review
 * approvals pin `content_revision`, and publishing requires taking the lock,
 * so lock traffic touching `content_revision` would invalidate the very
 * approval a publish is consuming.
 *
 * Two shape differences forced by the ObjectRecord envelope, not semantic drift:
 * history entries carry the envelope's required structured `actor: Principal`
 * (the article endpoint only stores loose owner strings in `details`; those
 * `details` payloads are kept field-for-field), and history action strings are
 * the plain verb names ('checkout', 'checkin', 'refresh', 'force_release')
 * rather than the article endpoint's 'admin_'-prefixed ones, since this
 * library serves human and agent principals alike.
 *
 * Store/JSON failures propagate to the caller; HTTP wrapping (auth, 405, 500)
 * is the verb endpoint's job, exactly as it is for the article lock today.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ObjectRecord, Principal, WorkflowLockRecord } from '../../schema/object-record-v1.js';

export const DEFAULT_LEASE_SECONDS = 900; // 15 min, matches the article lock default
export const MAX_LEASE_SECONDS = 3600;

const leaseSecondsSchema = z.number().int().positive().max(MAX_LEASE_SECONDS).optional();

export type ObjectLockStore = {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
};

export type ObjectLockResult = {
  ok: boolean;
  /** HTTP-parity status code (200 | 400 | 404 | 423), identical to the article endpoint. */
  status: number;
  /** Response payload, field-for-field identical to admin-workflow-lock's body. */
  body: Record<string, unknown>;
  /** The persisted record after a successful lock write; absent on read-only, idempotent, and error outcomes. */
  record?: ObjectRecord;
};

export type ObjectLockCheckoutOptions = {
  actor: Principal;
  leaseSeconds?: number;
  nowMs?: number;
};

export type ObjectLockCheckinOptions = {
  actor: Principal;
  lockToken?: string;
  nowMs?: number;
};

export type ObjectLockRefreshOptions = {
  actor: Principal;
  lockToken?: string;
  leaseSeconds?: number;
  nowMs?: number;
  /**
   * Where the extended lease is measured from.
   *
   * `'expiry'` (the default) is the article-lock parity behaviour: the new
   * expiry is `expires_at + lease`, so each call pushes the lock further out
   * than the last. That is right for a human pressing "keep working", and
   * WRONG for an automatic heartbeat: a caller ticking every second would
   * walk the expiry hours into the future, and the lock would outlive the
   * session that was holding it open (PCL-P1 / C-20).
   *
   * `'now'` makes the refresh a SLIDING WINDOW pinned to the clock:
   * `expires_at = max(now + lease, expires_at)`. However often it is called,
   * the lock never survives more than `lease` seconds past the last
   * heartbeat, which is what lets an abandoned card's lock lapse normally.
   * The `max` is deliberate — a heartbeat may never SHORTEN a lease that a
   * human explicitly extended further out.
   */
  extendFrom?: 'expiry' | 'now';
  /** Recorded on the history entry so an automatic heartbeat is legible as one in the audit trail. */
  reason?: string;
};

export type ObjectLockForceReleaseOptions = {
  actor: Principal;
  nowMs?: number;
};

const nowIso = (ms: number) => new Date(ms).toISOString();
const addSecondsIso = (fromMs: number, seconds: number) => new Date(fromMs + seconds * 1000).toISOString();

export const isObjectLockActive = (lock: ObjectRecord['lock'], atMs = Date.now()): boolean =>
  Boolean(lock && Date.parse(lock.expires_at) > atMs);

export const sanitizeObjectLock = (lock: ObjectRecord['lock']) =>
  lock
    ? {
        owner_id: lock.owner_id,
        owner_label: lock.owner_label,
        acquired_at: lock.acquired_at,
        expires_at: lock.expires_at,
      }
    : undefined;

/**
 * Derives the lock-record owner strings from a principal, mirroring how the
 * article endpoint derives them from admin auth state (userId → owner_id,
 * email → owner_label).
 */
export const lockOwnerFromPrincipal = (actor: Principal): { owner_id: string; owner_label: string } =>
  actor.kind === 'human'
    ? { owner_id: actor.id, owner_label: actor.email }
    : { owner_id: actor.agent_name, owner_label: actor.agent_name };

const result = (status: number, body: Record<string, unknown>, record?: ObjectRecord): ObjectLockResult => ({
  ok: status >= 200 && status < 300,
  status,
  body,
  record,
});

const notFound = () => result(404, { error: 'Object record not found', not_found: true });

const invalidLease = (leaseSeconds: number | undefined): ObjectLockResult | undefined => {
  const parsed = leaseSecondsSchema.safeParse(leaseSeconds);
  return parsed.success ? undefined : result(400, { error: 'Invalid request', issues: parsed.error.issues });
};

const loadRecord = async (store: ObjectLockStore, recordKey: string): Promise<ObjectRecord | undefined> => {
  const raw = await store.get(recordKey);
  return raw ? (JSON.parse(raw) as ObjectRecord) : undefined;
};

/**
 * Shared checkin/refresh guards, in the article endpoint's exact order:
 * missing token → 400; no lock → idempotent 200 (no write); token mismatch →
 * 423 with sanitized holder (even when that lock has expired); matching token
 * on an expired lock → 423 lock_expired.
 */
const guardHeldLock = (
  record: ObjectRecord,
  action: 'checkin' | 'refresh',
  lockToken: string | undefined,
  atMs: number
): { held: WorkflowLockRecord } | { early: ObjectLockResult } => {
  if (!lockToken) return { early: result(400, { error: 'lockToken is required for this action' }) };
  if (!record.lock) return { early: result(200, { action, idempotent: true }) };
  if (record.lock.token !== lockToken)
    return { early: result(423, { action, locked: true, lock: sanitizeObjectLock(record.lock) }) };
  if (!isObjectLockActive(record.lock, atMs))
    return { early: result(423, { action, error: 'lock_expired', lock_expired: true }) };
  return { held: record.lock };
};

export const checkoutObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockCheckoutOptions
): Promise<ObjectLockResult> => {
  const invalid = invalidLease(options.leaseSeconds);
  if (invalid) return invalid;

  const record = await loadRecord(store, recordKey);
  if (!record) return notFound();

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  if (isObjectLockActive(record.lock, ts)) {
    return result(423, { action: 'checkout', locked: true, lock: sanitizeObjectLock(record.lock) });
  }

  const lease = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  const owner = lockOwnerFromPrincipal(options.actor);
  const lock: WorkflowLockRecord = {
    token: randomUUID(),
    owner_id: owner.owner_id,
    owner_label: owner.owner_label,
    acquired_at: timestamp,
    expires_at: addSecondsIso(ts, lease),
  };
  const nextRecord: ObjectRecord = {
    ...record,
    updated_at: timestamp,
    lock,
    history: [
      ...record.history,
      {
        at: timestamp,
        action: 'checkout',
        actor: options.actor,
        details: { owner_id: owner.owner_id, owner_label: owner.owner_label, lease_seconds: lease },
      },
    ],
    version: record.version + 1,
  };

  await store.setJSON(recordKey, nextRecord);
  return result(200, { action: 'checkout', lockToken: lock.token, lock: sanitizeObjectLock(lock) }, nextRecord);
};

export const checkinObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockCheckinOptions
): Promise<ObjectLockResult> => {
  const record = await loadRecord(store, recordKey);
  if (!record) return notFound();

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  const guard = guardHeldLock(record, 'checkin', options.lockToken, ts);
  if ('early' in guard) return guard.early;

  const nextRecord: ObjectRecord = {
    ...record,
    updated_at: timestamp,
    lock: undefined,
    history: [
      ...record.history,
      {
        at: timestamp,
        action: 'checkin',
        actor: options.actor,
        details: { owner_id: guard.held.owner_id, owner_label: guard.held.owner_label },
      },
    ],
    version: record.version + 1,
  };

  await store.setJSON(recordKey, nextRecord);
  return result(200, { action: 'checkin', checked_in: true }, nextRecord);
};

export const refreshObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockRefreshOptions
): Promise<ObjectLockResult> => {
  const invalid = invalidLease(options.leaseSeconds);
  if (invalid) return invalid;

  const record = await loadRecord(store, recordKey);
  if (!record) return notFound();

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  const guard = guardHeldLock(record, 'refresh', options.lockToken, ts);
  if ('early' in guard) return guard.early;

  const lease = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  // Parity: the article lock extends from the current expiry, not from now.
  // `extendFrom: 'now'` opts into the bounded sliding window instead (see the
  // option's doc comment) and can only ever move the expiry later.
  const heldExpiresAtMs = Date.parse(guard.held.expires_at);
  const nextExpiresAtMs =
    options.extendFrom === 'now' ? Math.max(ts + lease * 1000, heldExpiresAtMs) : heldExpiresAtMs + lease * 1000;
  const lock: WorkflowLockRecord = {
    ...guard.held,
    expires_at: nowIso(nextExpiresAtMs),
  };
  const nextRecord: ObjectRecord = {
    ...record,
    updated_at: timestamp,
    lock,
    history: [
      ...record.history,
      {
        at: timestamp,
        action: 'refresh',
        actor: options.actor,
        details: {
          owner_id: guard.held.owner_id,
          lease_seconds: lease,
          ...(options.reason ? { reason: options.reason } : {}),
        },
      },
    ],
    version: record.version + 1,
  };

  await store.setJSON(recordKey, nextRecord);
  return result(200, { action: 'refresh', lock: sanitizeObjectLock(lock) }, nextRecord);
};

export const objectLockStatus = async (
  store: ObjectLockStore,
  recordKey: string,
  options: { nowMs?: number } = {}
): Promise<ObjectLockResult> => {
  const record = await loadRecord(store, recordKey);
  if (!record) return notFound();

  return result(200, {
    action: 'status',
    locked: isObjectLockActive(record.lock, options.nowMs ?? Date.now()),
    lock: sanitizeObjectLock(record.lock),
    version: record.version,
  });
};

export const forceReleaseObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockForceReleaseOptions
): Promise<ObjectLockResult> => {
  const record = await loadRecord(store, recordKey);
  if (!record) return notFound();

  if (!record.lock) return result(200, { action: 'force_release', idempotent: true, message: 'No lock was held' });

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);
  const owner = lockOwnerFromPrincipal(options.actor);
  const nextRecord: ObjectRecord = {
    ...record,
    updated_at: timestamp,
    lock: undefined,
    history: [
      ...record.history,
      {
        at: timestamp,
        action: 'force_release',
        actor: options.actor,
        details: {
          forced_by: owner.owner_id,
          previous_owner_id: record.lock.owner_id,
          previous_owner_label: record.lock.owner_label,
        },
      },
    ],
    version: record.version + 1,
  };

  await store.setJSON(recordKey, nextRecord);
  return result(200, { action: 'force_release', released: true }, nextRecord);
};
