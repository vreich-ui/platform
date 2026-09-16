/**
 * M0.1 — `putObjectRecord()`, the ONE place a site-objects record is written.
 *
 * ## Why this module exists, and why it is not `blob-store.ts`
 *
 * `objects/index-store.ts`'s header states the problem in full: `objects/index.json`
 * could only ever be a VERIFIED projection — `13 x store.list()` per read, every
 * cached row re-proved against the listing's etag — because object records had
 * five (in fact six) writer modules and "an index maintained by writers is only as
 * correct as the least careful writer". The cure is not a more careful writer. It
 * is one writer.
 *
 * The plan said `blob-store.ts`. That file is a set of store FACTORIES: it knows
 * how to open `site-objects` for a tenant and nothing whatever about
 * `ObjectRecord`, `objectRecordKey`, status markers or inventory rows. Putting a
 * record-shaped write there would make every store factory depend on the object
 * schema, and would put the choke point in a file that `object-lock.ts`,
 * `object-publish.ts` and the rest do not otherwise import. So the choke point is
 * here, next to the projection it maintains: `objects/index-store.ts` owns the two
 * PROJECTION docs, this module owns the RECORD and its status marker, and the verb
 * modules own the record's CONTENT and nothing else. Each of the three imports
 * only downward.
 *
 * ## The write, in order, and what a crash between steps leaves behind
 *
 * A write is four blob operations and they are ordered so that every interruption
 * is either invisible or self-repairing:
 *
 *   1. **Arm the drift alarm** — `objects/version.seq = index.seq + 1`
 *      (`armObjectIndexWrite`). Nothing has changed yet; the store now merely
 *      says "an index write is owed".
 *   2. **The record blob.** Durable BEFORE anything claims it exists.
 *   3. **The status-index marker** (`objects/<type>/index/by-status/<status>/<id>`),
 *      and, when the status moved, the removal of the marker it moved from.
 *   4. **The derived index row**, compare-and-swapped into `objects/index.json` at
 *      the seq step 1 armed — which is exactly what disarms the alarm.
 *
 * Crash after 1: the alarm is up and no record changed. The next inventory read
 * sees `version.seq > index.seq`, refuses to trust the index, runs the verified
 * sweep, finds nothing has changed, rewrites the pair in step. One wasted sweep.
 *
 * Crash after 2: the record is live and the index does not mention it. The alarm
 * is still up, so the next read sweeps and projects the new record from the
 * listing. This is THE case the ordering exists for, and it is why the alarm is
 * armed first rather than stamped last: stamped last, `version.seq` and
 * `index.seq` would still agree here and the reader would serve an index that is
 * missing a live record.
 *
 * Crash after 3: as above, plus a marker that the sweep and the purge both read as
 * the truth they already expect. Harmless.
 *
 * Crash after 4: nothing is owed. The pair agrees and the row is current.
 *
 * A concurrent second writer loses a compare-and-swap — at step 1 if the other
 * writer armed first, at step 4 if both armed off the same index — writes no row,
 * and stamps `objects/version.armed = true` on its way out, so a lost update is
 * never mistaken for a current index; it is merely one rebuild. (REVIEW
 * 2026-09-16: before that stamp existed this paragraph was wrong and the
 * failure was silent — see `objects/index-doc.ts`'s schema note, which states
 * the defect, the fix, and why `seq` alone could not carry it on a runtime
 * whose reads are silently eventual.)
 *
 * A store that cannot report an etag for `objects/index.json` or for
 * `objects/version` (the local file-backed shim; every hand-rolled test fake)
 * never commits at all and simply leaves the alarm up for the sweep, which is
 * precisely the behaviour this repo had before M0.
 *
 * ## What this module deliberately does NOT own
 *
 * Record CONTENT. Every guard that decides whether a record may change — locks,
 * validation, review state, approval gates, creation policy — stays in
 * `object-verbs.ts` and friends. This function takes an already-decided
 * `ObjectRecord` and makes it durable. It is a write choke point, not a second
 * policy engine, and it must never grow a rule that a caller could route around.
 *
 * Other docs in the same store. `site/redirects.json` (retire) and the search
 * index are not records and do not belong to the inventory projection; their
 * writers stay where they are.
 */
import {
  OBJECT_STORE_MARKER_VALUE,
  objectRecordKey,
  objectStatusIndexKey,
  type ObjectRecordStatus,
} from '../object-store-keys.js';
import {
  armObjectIndexWrite,
  commitObjectIndexEntries,
  disarmRefused,
  projectIndexEntry,
  type ObjectIndexDocStore,
} from './index-doc.js';
import type { ObjectRecord, ObjectType } from '../../../schema/object-record-v1.js';

/**
 * The store shape the choke point needs. No `list`: this module never sweeps.
 * `delete`/`del` are optional and probed at runtime because the fleet's store
 * handles spell it both ways (`@netlify/blobs` uses `delete`, the local shim `del`).
 */
export type ObjectRecordWriteStore = ObjectIndexDocStore & {
  delete?(key: string): Promise<unknown>;
  del?(key: string): Promise<unknown>;
};

const deleteKey = async (store: ObjectRecordWriteStore, key: string): Promise<void> => {
  const remove = typeof store.delete === 'function' ? store.delete.bind(store) : store.del?.bind(store);
  if (!remove) return;
  await remove(key);
};

export type PutObjectRecordResult = {
  /** The record's blob key, so a caller that used to build it itself still has it. */
  key: string;
  /** The etag the store reported for the record blob; `''` when it reported none. */
  etag: string;
  /**
   * True when the index row landed AND the drift alarm came back down — i.e. the
   * next inventory read will be two blob reads. False is not an error: it means
   * the next read pays one verified sweep and repairs.
   */
  index_committed: boolean;
};

/**
 * Write one object record and everything derived from it.
 *
 * `previous_status` is how a status TRANSITION (retire, restore) tells the choke
 * point which marker to retire; omit it for an ordinary edit, where the marker is
 * simply re-asserted at the status the record already carries.
 */
export const putObjectRecord = async (
  store: ObjectRecordWriteStore,
  input: { record: ObjectRecord; previous_status?: ObjectRecordStatus; nowMs?: number }
): Promise<PutObjectRecordResult> => {
  const nowMs = input.nowMs ?? Date.now();
  const record = input.record;
  const key = objectRecordKey(record.object_type, record.object_id);
  const status: ObjectRecordStatus = record.status;

  // 1 — arm.
  const lease = await armObjectIndexWrite(store, nowMs);

  // 2 — the record, durable before anything claims it exists.
  const written = (await store.setJSON(key, record)) as void | { etag?: string };
  const etag = written && typeof written === 'object' && typeof written.etag === 'string' ? written.etag : '';

  // 3 — the status marker, and the one it moved away from.
  await store.setJSON(objectStatusIndexKey(record.object_type, status, record.object_id), OBJECT_STORE_MARKER_VALUE);
  if (input.previous_status && input.previous_status !== status) {
    await deleteKey(store, objectStatusIndexKey(record.object_type, input.previous_status, record.object_id));
  }

  // 4 — the derived row, compare-and-swapped, which disarms the alarm.
  //
  // Without an etag for the record blob the row could not be VERIFIED by a later
  // sweep (`index-store.ts` only reuses a row whose etag the listing confirms), so
  // writing one would trade a cheap rebuild for a row that can never be re-proved.
  // Leave the alarm up instead.
  //
  // REVIEW: the no-etag path used to return `false` without telling the alarm.
  // Leaving only `version.seq > index.seq` behind is safe on its own, but it is
  // the SAME shape a concurrent writer can put back in step, so this path takes
  // the same explicit retreat every other refusal now takes.
  let index_committed = false;
  if (etag.length > 0) {
    index_committed = await commitObjectIndexEntries(store, lease, {
      upserts: [projectIndexEntry(key, etag, record, nowMs)],
      nowMs,
    });
  } else if (lease.armed) {
    await disarmRefused(store, lease, nowMs);
  }

  return { key, etag, index_committed };
};

export type ObjectRecordRef = {
  object_type: ObjectType;
  object_id: string;
  /** Which status markers to remove with the record. Defaults to both. */
  statuses?: readonly ObjectRecordStatus[];
};

/**
 * Hard-delete records and their markers, and drop their rows from the index.
 *
 * Batched on purpose: the only caller is `object-purge.ts`, a sweep that can
 * retire dozens of records in one pass, and arming the alarm plus rewriting the
 * whole index doc once per record would turn an O(n) sweep into O(n) full-index
 * writes. One arm, n deletes, one commit.
 *
 * Same ordering law as `putObjectRecord`, read backwards: the alarm goes up
 * first, the blobs go away, and the index row is dropped last. A crash in the
 * middle leaves the index claiming a record that is gone — which the verified
 * sweep already handles (it projects from the LISTING, so a key that is not
 * listed simply is not a row).
 */
export const deleteObjectRecords = async (
  store: ObjectRecordWriteStore,
  refs: readonly ObjectRecordRef[],
  options: { nowMs?: number } = {}
): Promise<{ deleted: number; index_committed: boolean }> => {
  if (refs.length === 0) return { deleted: 0, index_committed: false };
  const nowMs = options.nowMs ?? Date.now();

  const lease = await armObjectIndexWrite(store, nowMs);

  const removals: string[] = [];
  for (const ref of refs) {
    const key = objectRecordKey(ref.object_type, ref.object_id);
    removals.push(key);
    await deleteKey(store, key);
    for (const status of ref.statuses ?? (['active', 'archived'] as const)) {
      await deleteKey(store, objectStatusIndexKey(ref.object_type, status, ref.object_id));
    }
  }

  const index_committed = await commitObjectIndexEntries(store, lease, { removals, nowMs });
  return { deleted: refs.length, index_committed };
};

/** One-record convenience over `deleteObjectRecords`. */
export const deleteObjectRecord = async (
  store: ObjectRecordWriteStore,
  ref: ObjectRecordRef,
  options: { nowMs?: number } = {}
): Promise<{ deleted: number; index_committed: boolean }> => deleteObjectRecords(store, [ref], options);

/**
 * Archive a record: the retire verb's spelling of `putObjectRecord`.
 *
 * It exists as its own name because a retire is the one write that MOVES a
 * record between status markers, and a caller that forgot `previous_status`
 * would leave the old marker behind for `object-purge.ts` to trip over. Naming
 * the transition makes that impossible to forget.
 */
export const retireObjectRecord = async (
  store: ObjectRecordWriteStore,
  input: { record: ObjectRecord; previous_status?: ObjectRecordStatus; nowMs?: number }
): Promise<PutObjectRecordResult> =>
  putObjectRecord(store, {
    record: input.record,
    previous_status: input.previous_status ?? 'active',
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
