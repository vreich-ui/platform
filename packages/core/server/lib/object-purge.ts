/**
 * OBJECT PURGE (W14 F6, Wolf's ruling 1) — the hard delete that finishes a retire.
 *
 * "i am not sure that anything is worth saving for too long since anything can
 * be recreated again. so objects can be deleted but perhaps deleting them after
 * they were in archive for over thirty days make sense."
 *
 * So retirement is a two-stage removal: `object_retire` archives (reversible,
 * history intact, export already gone and the route already redirecting), and
 * this sweep hard-deletes what has sat archived past the grace period. The
 * thirty days are the window in which a mistake is free to undo; after it, the
 * record and its index key are genuinely gone.
 *
 * Deliberately a SWEEP, not a per-object verb: "delete this one now" would be an
 * irreversible button with no waiting period, which is exactly what the grace
 * period exists to prevent. The only way to hard-delete is to retire and wait.
 *
 * Nothing here touches git. The export was removed at retire time and the
 * redirect that replaced it is permanent — purging the record must not
 * resurrect a 404 for a route readers are still being forwarded from.
 */
import { objectRecordKey, objectStatusIndexPrefix } from './object-store-keys.js';
import { deleteObjectRecords, type ObjectRecordRef, type ObjectRecordWriteStore } from './objects/record-writer.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';
import { objectTypes, type ObjectRecord, type ObjectType } from '../../schema/object-record-v1.js';

/** Wolf's ruling: thirty days in archive, then deletion. */
export const PURGE_GRACE_DAYS = 30;
const GRACE_MS = PURGE_GRACE_DAYS * 24 * 60 * 60 * 1000;

export type PurgeStore = ObjectRecordWriteStore & {
  delete: (key: string) => Promise<unknown>;
  list: (options: { prefix: string; directories?: boolean; paginate?: boolean }) => Promise<BlobListResponse>;
};

export type PurgeArchivedInput = {
  /** Preview only: report what WOULD be purged and delete nothing. */
  dry_run?: boolean;
  /** Override the grace period (tests, and an operator who must clear space). */
  grace_days?: number;
};

export type PurgedEntry = {
  object_type: ObjectType;
  object_id: string;
  archived_at: string;
  age_days: number;
};

export type PurgeArchivedResult = {
  purged: PurgedEntry[];
  /** Archived but still inside the grace period — untouched, reported for visibility. */
  retained: PurgedEntry[];
  dry_run: boolean;
  grace_days: number;
};

/**
 * When the object entered archive. `retire` stamps a history entry, which is the
 * honest source; `updated_at` is the fallback for a record archived by some other
 * path. A record with neither is treated as age 0 — never purged on a guess.
 */
const archivedAt = (record: ObjectRecord): string | undefined => {
  const retireEntry = [...record.history].reverse().find((entry) => entry.action === 'retire');
  return retireEntry?.at ?? record.updated_at;
};

export const purgeArchivedObjects = async (
  store: PurgeStore,
  input: PurgeArchivedInput = {},
  deps: { nowMs?: number } = {}
): Promise<PurgeArchivedResult> => {
  const now = deps.nowMs ?? Date.now();
  const graceDays = input.grace_days ?? PURGE_GRACE_DAYS;
  const graceMs = graceDays === PURGE_GRACE_DAYS ? GRACE_MS : graceDays * 24 * 60 * 60 * 1000;
  const dryRun = input.dry_run ?? false;

  const purged: PurgedEntry[] = [];
  const retained: PurgedEntry[] = [];
  /**
   * M0.1: the deletes are COLLECTED and handed to the choke point once, at the
   * end, rather than issued inline. One arm of the drift alarm and one index
   * commit for the whole sweep — a per-record commit would rewrite the entire
   * `objects/index.json` document once per purged object.
   */
  const toDelete: ObjectRecordRef[] = [];

  for (const objectType of objectTypes) {
    // Walk the archived status index rather than every record: it is exactly the
    // set this sweep cares about, and it stays cheap as the store grows.
    const listed = await store.list({
      prefix: objectStatusIndexPrefix(objectType, 'archived'),
      directories: false,
      paginate: true,
    });
    for (const item of await collectBlobListItems(listed)) {
      const objectId = item.key.slice(objectStatusIndexPrefix(objectType, 'archived').length);
      if (!objectId) continue;

      const recordKey = objectRecordKey(objectType, objectId);
      const raw = await store.get(recordKey);
      if (!raw) {
        // Index entry with no record: the record is already gone, so the stale
        // pointer is swept too rather than left to accumulate.
        if (!dryRun) toDelete.push({ object_type: objectType, object_id: objectId, statuses: ['archived'] });
        continue;
      }

      const record = JSON.parse(raw) as ObjectRecord;
      // Only archived records are purgeable — a restored object must never be
      // deleted by a sweep that read a stale index entry.
      if (record.status !== 'archived') continue;

      const at = archivedAt(record);
      const ageMs = at ? now - Date.parse(at) : 0;
      const entry: PurgedEntry = {
        object_type: objectType,
        object_id: objectId,
        archived_at: at ?? '',
        age_days: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
      };

      if (!Number.isFinite(ageMs) || ageMs < graceMs) {
        retained.push(entry);
        continue;
      }

      if (!dryRun) toDelete.push({ object_type: objectType, object_id: objectId, statuses: ['archived'] });
      purged.push(entry);
    }
  }

  /**
   * P1 — narrow the TOCTOU window `deleteObjectRecords` cannot close itself
   * (`@netlify/blobs`'s `delete(key)` takes no condition at all — no
   * delete-time CAS to offer). The listing walk above can take a while over
   * a large archive, so re-read every candidate's CURRENT status right
   * before the batch commits and drop any that moved off `'archived'`
   * (restored, or already purged by a concurrent run). A mitigation, not a
   * guarantee — a record can still move in the gap between this re-check and
   * the delete; a real fix needs delete-time fencing this backend lacks.
   */
  const reverified: ObjectRecordRef[] = [];
  for (const ref of toDelete) {
    const recordKey = objectRecordKey(ref.object_type, ref.object_id);
    let raw: string | null;
    try {
      raw = await store.get(recordKey);
    } catch {
      // Unreadable now: leave it for the next sweep rather than guessing.
      continue;
    }
    if (!raw) {
      // Still gone — the stale-index-pointer case from the walk above.
      reverified.push(ref);
      continue;
    }
    let record: ObjectRecord;
    try {
      record = JSON.parse(raw) as ObjectRecord;
    } catch {
      continue;
    }
    if (record.status === 'archived') reverified.push(ref);
    // else: restored (or otherwise moved) since the walk — never delete it.
  }

  await deleteObjectRecords(store, reverified, { nowMs: now });

  // P1: the re-verification above can drop a ref the walk had already added
  // to `purged` (a genuine, if rare, race). Report only what was actually
  // handed to `deleteObjectRecords` — never claim a record was purged when
  // it was dropped and left in place. Skipped in dry-run, where nothing was
  // ever queued for deletion and `reverified` is always empty by construction.
  const confirmedKeys = new Set(reverified.map((ref) => objectRecordKey(ref.object_type, ref.object_id)));
  const confirmedPurged = dryRun
    ? purged
    : purged.filter((entry) => confirmedKeys.has(objectRecordKey(entry.object_type, entry.object_id)));

  return { purged: confirmedPurged, retained, dry_run: dryRun, grace_days: graceDays };
};
