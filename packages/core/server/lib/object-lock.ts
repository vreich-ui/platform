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
 *
 * P1 (2026-09-18): every mutating verb here is a RESTAMP — reads the record,
 * recomputes lock metadata as a pure function of what it read, writes back
 * with a `{kind:'match'}` precondition against that SAME read's etag. None
 * replays a body edit, so a lost condition (another writer moved the record;
 * routine here — `blob-store.ts` calls 'strong' consistency effectively
 * eventual on this runtime) is always safe to resolve by re-reading, bounded
 * by `MAX_LOCK_WRITE_ATTEMPTS`. No etag at all degrades to the pre-P1
 * unconditional write — no worse, never better.
 */
import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { ObjectRecord, Principal, WorkflowLockRecord } from '../../schema/object-record-v1.js';
import {
  loadRecordWithEtag,
  putObjectRecord,
  RecordWriteConflictError,
  type ObjectRecordWriteStore,
  type RecordWritePrecondition,
} from './objects/record-writer.js';
import { isObjectLockActive, sanitizeObjectLock } from './object-lock-view.js';

export const DEFAULT_LEASE_SECONDS = 900; // 15 min, matches the article lock default
export const MAX_LEASE_SECONDS = 3600;

/** P1 — see the module header. Bounds the re-read-and-recompute retry before a genuinely hot key gets a 409 instead of an infinite retry. */
const MAX_LOCK_WRITE_ATTEMPTS = 5;

const leaseSecondsSchema = z.number().int().positive().max(MAX_LEASE_SECONDS).optional();

/**
 * M0.1: the lock verbs write RECORDS, so their store is the choke point's store.
 * `recordKey` is still taken as a parameter (the callers build it), but it is
 * now only used to READ — the write derives its own key from the record, which
 * is what makes the index row and the key impossible to disagree.
 */
export type ObjectLockStore = ObjectRecordWriteStore;

export type ObjectLockResult = {
  ok: boolean;
  /** HTTP-parity status code (200 | 400 | 404 | 409 | 423), identical to the article endpoint plus P1's write-conflict 409. */
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

/**
 * M2.1: the two read-only lock facts moved to the leaf `object-lock-view.ts`
 * so an inventory row can reach them without reaching this file's writer
 * (`objects/record-writer.ts`). Re-exported here so every existing importer —
 * `object-verbs.ts`, `object-publish.ts`, `object-retire.ts` and this file's
 * own test — keeps the spelling it had.
 */
export { isObjectLockActive, sanitizeObjectLock } from './object-lock-view.js';

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

const tooManyConflicts = (action: string) =>
  result(409, {
    error: 'Too many concurrent writers to this record; retry the request.',
    action,
    write_conflict: true,
  });

const invalidLease = (leaseSeconds: number | undefined): ObjectLockResult | undefined => {
  const parsed = leaseSecondsSchema.safeParse(leaseSeconds);
  return parsed.success ? undefined : result(400, { error: 'Invalid request', issues: parsed.error.issues });
};

/** P1: `undefined` etag means "this store cannot condition on it" — the caller then writes unconditionally, exactly as before P1. */
const matchPrecondition = (etag: string | undefined): RecordWritePrecondition | undefined =>
  etag ? { kind: 'match', etag } : undefined;

/**
 * Attempt a restamp write and tell the caller whether to retry. `build`
 * receives the FRESH record just read and returns either an early result (no
 * write needed — not-found, a guard failure, an idempotent no-op) or the next
 * record to persist; this function owns the read/write/retry loop so every
 * verb below states only its own transition, never the concurrency handling.
 */
const restamp = async (
  store: ObjectLockStore,
  recordKey: string,
  action: string,
  build: (
    record: ObjectRecord
  ) => { early: ObjectLockResult } | { next: ObjectRecord; onSuccess: (r: ObjectRecord) => ObjectLockResult }
): Promise<ObjectLockResult> => {
  for (let attempt = 0; attempt < MAX_LOCK_WRITE_ATTEMPTS; attempt++) {
    const current = await loadRecordWithEtag(store, recordKey);
    if (!current) return notFound();
    const decision = build(current.record);
    if ('early' in decision) return decision.early;
    try {
      await putObjectRecord(store, {
        record: decision.next,
        precondition: matchPrecondition(current.etag),
      });
      return decision.onSuccess(decision.next);
    } catch (error) {
      if (!(error instanceof RecordWriteConflictError)) throw error;
      // Another writer moved this record between our read and our write.
      // Loop: re-read and let `build` re-derive from the current truth.
    }
  }
  return tooManyConflicts(action);
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

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  return restamp(store, recordKey, 'checkout', (record) => {
    if (isObjectLockActive(record.lock, ts)) {
      return { early: result(423, { action: 'checkout', locked: true, lock: sanitizeObjectLock(record.lock) }) };
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
    const next: ObjectRecord = {
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
    return {
      next,
      onSuccess: (nextRecord) =>
        result(200, { action: 'checkout', lockToken: lock.token, lock: sanitizeObjectLock(lock) }, nextRecord),
    };
  });
};

export const checkinObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockCheckinOptions
): Promise<ObjectLockResult> => {
  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  return restamp(store, recordKey, 'checkin', (record) => {
    const guard = guardHeldLock(record, 'checkin', options.lockToken, ts);
    if ('early' in guard) return { early: guard.early };

    const next: ObjectRecord = {
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
    return { next, onSuccess: () => result(200, { action: 'checkin', checked_in: true }, next) };
  });
};

export const refreshObjectLock = async (
  store: ObjectLockStore,
  recordKey: string,
  options: ObjectLockRefreshOptions
): Promise<ObjectLockResult> => {
  const invalid = invalidLease(options.leaseSeconds);
  if (invalid) return invalid;

  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  return restamp(store, recordKey, 'refresh', (record) => {
    const guard = guardHeldLock(record, 'refresh', options.lockToken, ts);
    if ('early' in guard) return { early: guard.early };

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
    const next: ObjectRecord = {
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
    return { next, onSuccess: () => result(200, { action: 'refresh', lock: sanitizeObjectLock(lock) }, next) };
  });
};

export const objectLockStatus = async (
  store: ObjectLockStore,
  recordKey: string,
  options: { nowMs?: number } = {}
): Promise<ObjectLockResult> => {
  const current = await loadRecordWithEtag(store, recordKey);
  if (!current) return notFound();
  const { record } = current;

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
  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);

  return restamp(store, recordKey, 'force_release', (record) => {
    if (!record.lock) {
      return { early: result(200, { action: 'force_release', idempotent: true, message: 'No lock was held' }) };
    }

    const owner = lockOwnerFromPrincipal(options.actor);
    const next: ObjectRecord = {
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
    return { next, onSuccess: () => result(200, { action: 'force_release', released: true }, next) };
  });
};
