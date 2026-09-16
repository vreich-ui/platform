/**
 * The two pure, READ-ONLY facts about a record lock, as a leaf.
 *
 * `object-lock.ts` is a WRITE library — it imports `objects/record-writer.ts`,
 * the M0.1 record-write choke point — so importing it for `isObjectLockActive`
 * put 21 KB of lock-mutation and record-write machinery into every function
 * that merely LISTS objects, via `object-inventory.ts`. Measured on
 * `admin-shell`: 493 KB with that edge, 473 KB without it, against a 500 KB
 * cap. Same cut as M0.1's `lib/review-approval.ts`.
 *
 * `object-lock.ts` re-exports both names; no importer moved.
 */
import type { ObjectRecord } from '../../schema/object-record-v1.js';

/** A lease that has not expired at `atMs`. A lock expiring exactly now is inactive. */
export const isObjectLockActive = (lock: ObjectRecord['lock'], atMs = Date.now()): boolean =>
  Boolean(lock && Date.parse(lock.expires_at) > atMs);

/** The holder facts a non-holder may see. The lock TOKEN is never among them. */
export const sanitizeObjectLock = (lock: ObjectRecord['lock']) =>
  lock
    ? {
        owner_id: lock.owner_id,
        owner_label: lock.owner_label,
        acquired_at: lock.acquired_at,
        expires_at: lock.expires_at,
      }
    : undefined;
