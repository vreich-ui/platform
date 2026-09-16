/**
 * PCL-P1 (KNOWN_ISSUES C-20) — keep an object lock alive for exactly as long
 * as a human is actually looking at the approval card that needs it.
 *
 * The defect: a lock lease is 900 s (`DEFAULT_LEASE_SECONDS`). An editor who
 * checks out, patches, and then waits for sign-off on the approval card can
 * sit past that lease while doing nothing wrong, and `object_publish`'s
 * step-1 guard then refuses the ORIGINAL token with the same
 * `423 lock_required` a stranger would get. Nothing renewed the lease,
 * because nothing was watching the card.
 *
 * The fix is a heartbeat, and the whole design question is WHAT DRIVES IT.
 * It is deliberately NOT a server-side timer: a timer started when the card
 * is raised keeps ticking after the human closes the tab and walks away,
 * and an abandoned draft would hold its lock forever. Instead the heartbeat
 * rides the `get_chat` poll the open chat UI already makes (~1.2 s) while a
 * card is pending. No browser → no poll → no heartbeat → the lock lapses on
 * its own, which is the correct outcome, not a gap.
 *
 * What this does NOT do, on purpose:
 *   - It never creates or re-acquires a lock. `refreshObjectLock`'s
 *     `guardHeldLock` still refuses a token mismatch (423, sanitized holder)
 *     and an ALREADY-EXPIRED lock (423 `lock_expired`). A heartbeat that
 *     arrives late finds the lock gone and stays refused — mutual exclusion
 *     is untouched, and a foreign or stolen token gets nothing.
 *   - It never extends from the current expiry (`extendFrom: 'now'`), so
 *     polling ten times a second cannot walk the expiry into next week. The
 *     lock outlives the last heartbeat by at most
 *     `HEARTBEAT_WINDOW_SECONDS`.
 *   - It never SHORTENS a lease (the `max()` inside `refreshObjectLock`), so
 *     a human who explicitly refreshed for an hour keeps their hour.
 */
import { objectTypeSchema, type ObjectType, type Principal } from '../../../schema/object-record-v1.js';
import { isObjectLockActive, refreshObjectLock, type ObjectLockStore } from '../object-lock.js';
import { objectRecordKey } from '../object-store-keys.js';
import type { ObjectRecord } from '../../../schema/object-record-v1.js';

/**
 * How far ahead a heartbeat pushes the expiry. This is the MAXIMUM a lock can
 * outlive the browser that was holding it open, so it is minutes, not the
 * 900 s default lease: a card abandoned mid-decision frees the object for the
 * next editor inside five minutes.
 */
export const HEARTBEAT_WINDOW_SECONDS = 300;

/**
 * Only write when the lock is this close to lapsing. Without a floor, a 1.2 s
 * poll would mint a record write (and a history entry, and a `version` bump)
 * every 1.2 s. With it, the write cadence is
 * `HEARTBEAT_WINDOW_SECONDS - HEARTBEAT_FLOOR_SECONDS` ≈ 3 min, and the lock
 * still never gets within `HEARTBEAT_FLOOR_SECONDS` of expiry while someone
 * is watching.
 */
export const HEARTBEAT_FLOOR_SECONDS = 120;

/** The reason stamped on the history entry, so an audit can tell a heartbeat from a human refresh. */
export const HEARTBEAT_REASON = 'approval_card_pending';

export type PendingApprovalLockRef = {
  object_type: ObjectType;
  object_id: string;
  lock_token: string;
};

/**
 * The minimum a chat document has to look like for this module. Structural on
 * purpose: `ChatDoc` satisfies it, and a test does not have to build a whole
 * valid run to exercise the heartbeat.
 */
export type PendingApprovalDocView = {
  status?: string;
  run?: {
    principal?: Principal;
    pending?: { tool?: string; args?: Record<string, unknown> };
  };
};

const asRef = (objectType: unknown, objectId: unknown, lockToken: unknown): PendingApprovalLockRef | undefined => {
  const parsedType = objectTypeSchema.safeParse(objectType);
  if (!parsedType.success) return undefined;
  if (typeof objectId !== 'string' || objectId.length === 0) return undefined;
  if (typeof lockToken !== 'string' || lockToken.length === 0) return undefined;
  return { object_type: parsedType.data, object_id: objectId, lock_token: lockToken };
};

/**
 * Which locks the pending approval card is holding open, read off the paused
 * call's own arguments — the only place the held token exists on the server.
 *
 * Two arg shapes carry a lock: the flat `{object_type, object_id,
 * lock_token}` every object verb tool uses (`object_patch`, `object_publish`,
 * …), and `instantiate_section_template`'s `target: {kind: 'page', page_id,
 * lock_token}`. Anything else yields nothing and the poll does no work.
 */
export const pendingApprovalLockRefs = (doc: PendingApprovalDocView): PendingApprovalLockRef[] => {
  if (doc.status !== 'awaiting_approval') return [];
  const args = doc.run?.pending?.args;
  if (!args) return [];

  const refs: PendingApprovalLockRef[] = [];
  const flat = asRef(args.object_type, args.object_id, args.lock_token);
  if (flat) refs.push(flat);

  const target = args.target as Record<string, unknown> | undefined;
  if (target && typeof target === 'object' && target.kind === 'page') {
    const nested = asRef('page', target.page_id, target.lock_token);
    if (nested) refs.push(nested);
  }

  return refs;
};

export type HeartbeatOutcome = {
  ref: PendingApprovalLockRef;
  /** 'refreshed' — expiry moved out; 'not_due' — still comfortably live; 'not_held' — no live lock with this token. */
  result: 'refreshed' | 'not_due' | 'not_held';
  expires_at?: string;
};

export type HeartbeatDeps = {
  nowMs?: number;
  /** Test seam / tuning; defaults to HEARTBEAT_WINDOW_SECONDS. */
  windowSeconds?: number;
  /** Test seam / tuning; defaults to HEARTBEAT_FLOOR_SECONDS. */
  floorSeconds?: number;
};

const loadRecord = async (store: ObjectLockStore, key: string): Promise<ObjectRecord | undefined> => {
  const raw = await store.get(key);
  return raw ? (JSON.parse(raw) as ObjectRecord) : undefined;
};

/**
 * Heartbeat every lock the pending card holds open. Best effort by contract:
 * the caller is a read poll and must never fail because of this, so a store
 * error on one ref is swallowed and reported as `not_held` rather than thrown.
 *
 * A ref whose lock is missing, held by someone else, or ALREADY EXPIRED comes
 * back `not_held` and nothing is written. That is the load-bearing line: this
 * function can extend a lock the caller demonstrably still holds and can do
 * nothing else.
 */
export const heartbeatPendingApprovalLocks = async (
  store: ObjectLockStore,
  doc: PendingApprovalDocView,
  deps: HeartbeatDeps = {}
): Promise<HeartbeatOutcome[]> => {
  const refs = pendingApprovalLockRefs(doc);
  if (refs.length === 0) return [];

  const nowMs = deps.nowMs ?? Date.now();
  const windowSeconds = deps.windowSeconds ?? HEARTBEAT_WINDOW_SECONDS;
  const floorSeconds = deps.floorSeconds ?? HEARTBEAT_FLOOR_SECONDS;
  // The lock's owner is the run that took it; its principal is the honest
  // actor for the history entry. A doc with a pending call always carries one
  // (it is stamped server-side at send time); without it there is nobody to
  // attribute the write to, so nothing is written.
  const actor: Principal | undefined = doc.run?.principal;
  if (!actor) return [];

  const outcomes: HeartbeatOutcome[] = [];
  for (const ref of refs) {
    const key = objectRecordKey(ref.object_type, ref.object_id);
    try {
      const record = await loadRecord(store, key);
      // Cheap pre-checks so the common poll costs one read and no write.
      // `refreshObjectLock` re-checks all three authoritatively.
      if (!record?.lock || record.lock.token !== ref.lock_token || !isObjectLockActive(record.lock, nowMs)) {
        outcomes.push({ ref, result: 'not_held' });
        continue;
      }
      if (Date.parse(record.lock.expires_at) - nowMs > floorSeconds * 1000) {
        outcomes.push({ ref, result: 'not_due', expires_at: record.lock.expires_at });
        continue;
      }
      const refreshed = await refreshObjectLock(store, key, {
        actor,
        lockToken: ref.lock_token,
        leaseSeconds: windowSeconds,
        nowMs,
        extendFrom: 'now',
        reason: HEARTBEAT_REASON,
      });
      if (!refreshed.ok) {
        outcomes.push({ ref, result: 'not_held' });
        continue;
      }
      outcomes.push({ ref, result: 'refreshed', expires_at: refreshed.record?.lock?.expires_at });
    } catch {
      // A poll never fails because a heartbeat could not be written.
      outcomes.push({ ref, result: 'not_held' });
    }
  }
  return outcomes;
};
