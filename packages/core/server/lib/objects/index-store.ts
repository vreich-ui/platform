/**
 * T5.1 R3 — `objects/index.json`, the object-store inventory projection.
 *
 * ## The problem it removes
 *
 * T0.2 §4 cause #3 (F10): every inventory read was `13 x store.list()` (one
 * per governed object type) followed by `N x store.get()` — and each of those
 * `get`s pulled a WHOLE `ObjectRecord` envelope, both body trees plus an
 * unbounded `history` array, to derive about fifteen scalars. At N=200 that is
 * ~213 blob operations per sweep, and T0.2 counted two-to-four sweeps per
 * admin page load (`/admin` runs one for `inventory` and a second inside
 * `admin-release-state`; `/admin/content/<id>` ran four).
 *
 * ## Why this is a read-repaired projection, not a writer-maintained index
 *
 * The prescription (T0.2 R3) was "a writer-maintained index, the pattern
 * `admin-requests.ts:157` already uses". The requests registry can do that
 * because it has exactly ONE writer module (`requests/store.ts`, whose header
 * says so at length). The object store does not: records are written from
 * `object-verbs.ts` (five sites), `object-publish.ts`, `object-retire.ts`,
 * `object-purge.ts` and `membership/offboarding.ts`. An index maintained by
 * writers is only as correct as the least careful writer, and T0.2 rated that
 * risk "medium-high" precisely because on this product a stale row is a stale
 * APPROVAL state.
 *
 * So the index is verified rather than trusted. `store.list()` already returns
 * an `etag` per blob (`@netlify/blobs`' `ListResultBlob`) at no extra cost, and
 * the listing has to happen anyway. A cached row is reused only when the
 * listing reports the SAME etag it was projected from; anything else — a new
 * key, a changed etag, a missing entry, an unverifiable (empty) etag — falls
 * through to reading that one record. Correctness therefore does not depend on
 * any writer knowing this file exists. A writer that bypasses the index is
 * detected on the next read and repaired, at the cost of one blob read.
 *
 * Steady state: `13 BL + 1 BR`. One object edited since the last sweep:
 * `13 BL + 1 BR + 1 BR + 1 BW`. Cold, or against a store whose listing carries
 * no etags: exactly the old cost, plus one write.
 *
 * ## W19
 *
 * This module writes ONE key, `objects/index.json`, and it is a pure
 * projection of records it just read. It never writes an object record, a
 * request doc or a request status, so it does not become a second writer of
 * anything the W19 writer-assignment law governs.
 *
 * ## Time- and policy-dependent fields
 *
 * Two `InventoryRow` fields are not functions of the record alone: `lock`
 * depends on the current time (a lease expires) and `requires_approval`
 * depends on the active approval policy. Caching either would be wrong, so the
 * entry stores the RAW `record.lock` and both fields are re-derived on every
 * read from the caller's `atMs` and policy. Everything else in the row is a
 * pure function of the record and is safe to cache against its etag.
 *
 * ## M0.2 — the index became TRUSTED, and what had to be true first
 *
 * Everything above is still the REPAIR path. What changed in M0 is that it is
 * no longer the ONLY path: `readInventoryRows` first tries to serve the whole
 * inventory from two blob reads and no `list()` at all.
 *
 * The objection the header opens with — "an index maintained by writers is
 * only as correct as the least careful writer" — was answered by removing the
 * writers, not by trusting them. M0.1 put every site-objects record write
 * behind ONE choke point (`objects/record-writer.ts`), and
 * `tests/netlify/object-inventory-index.test.ts` fails the build if a
 * `.set`/`.setJSON` against a record key appears anywhere else. The five (in
 * fact six) writer modules the paragraph above names are now callers of that
 * one function.
 *
 * That still leaves three ways an index could go stale, and each has an
 * answer rather than a hope:
 *
 *  1. **An interrupted write.** `objects/version` is a two-field doc whose
 *     `seq` is the drift ALARM. The choke point ARMS it — writes
 *     `seq = index.seq + 1` — BEFORE it touches the record, and the index
 *     write that follows is what disarms it (the index is written carrying
 *     that same `seq`). `readInventoryRows` trusts the index only while
 *     `version.seq === index.seq`. So a crash anywhere between arming and the
 *     index write leaves `version.seq > index.seq`, and the next read falls
 *     into the verified sweep below and repairs both docs. This is the one
 *     place the M0 task description was inverted deliberately: the task said
 *     to stamp the version LAST, which detects a lost INDEX write but not a
 *     crash between the record write and the index write — the window in
 *     which a record exists that the index does not mention. Arming first
 *     detects every interruption, at the cost of one spurious rebuild when
 *     the interruption happened before the record was written at all.
 *  2. **Two overlapping writes.** Netlify Blobs has no transaction but it
 *     does have compare-and-swap (`onlyIfMatch`), so BOTH the arm and the
 *     index write are conditional on the etag the writer read. The loser of a
 *     race does not retry and does not write a row: it stamps
 *     `objects/version.armed = true` and leaves, and the next read rebuilds.
 *     (REVIEW 2026-09-16 — that sentence used to end at "leaves the alarm
 *     armed" and was not true; `index-doc.ts`'s schema note states what it
 *     took to make it true and why `seq` alone could not.) A store that cannot
 *     report an etag for either doc (the local file-backed shim, and every
 *     hand-rolled test fake) never disarms the alarm at all — which degrades
 *     to exactly the verified sweep this module shipped with, the same way an
 *     etag-less LISTING already degrades it.
 *  3. **A writer that bypasses the choke point.** Nothing at read time can
 *     see that. Two things outside this module answer it: the writer-pinning
 *     test, and `functions/object-index-rebuild.ts` — a nightly scheduled
 *     full verified sweep per tenant, which is the same self-healing code
 *     path an ordinary read takes, run when nobody is looking.
 *
 * Cost, warm and unchanged: `2 BR` (`objects/index.json` + `objects/version`,
 * read in PARALLEL) and no listing. Cold, or after any of the three cases
 * above: the verified sweep, `13 BL + 1 BR + n BR + 2 BW`.
 *
 * The version doc is NOT a schema bump for the index. A store deployed before
 * M0 has no `objects/version` blob at all, so the very first read finds no
 * version, cannot trust, sweeps, and writes both docs. The entry shape did not
 * change, so `object-inventory-index.v2` still describes it and no fleet-wide
 * rebuild is forced.
 */
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from '../blob-list.js';
import { inventoryLockState, type InventoryRow } from '../object-inventory.js';
import {
  activeApprovalPolicy,
  isGovernedObjectType,
  publishRequiresApproval,
  type ApprovalPolicy,
} from '../../../lib/approval-policy.js';
import { inventoryRowFromRecord } from '../object-inventory.js';
import { objectTypes, type ObjectRecord, type ObjectType } from '../../../schema/object-record-v1.js';
import {
  emptyIndex,
  persistIndex,
  projectIndexEntry,
  readObjectIndex,
  readObjectStoreVersion,
  usableEtag,
  writeObjectStoreVersion,
  type ObjectIndex,
  type ObjectIndexDocStore,
  type ObjectIndexEntry,
  type ObjectStoreVersion,
} from './index-doc.js';

/**
 * The document layer is re-exported wholesale so that every existing importer
 * of `index-store.js` keeps its import: the split is a bundle boundary, not a
 * new public surface.
 */
export * from './index-doc.js';

/** What the SWEEP needs on top of the document store: the listings that name the live key set. `ObjectVerbStore` satisfies it. */
export interface ObjectIndexStore extends ObjectIndexDocStore {
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<unknown>;
}

/** Re-attach the two per-read fields to a stored projection. */
const rowFromEntry = (entry: ObjectIndexEntry, atMs: number, policy: ApprovalPolicy): InventoryRow => {
  const objectType = entry.row.object_type as ObjectType;
  return {
    ...(entry.row as unknown as Omit<InventoryRow, 'lock' | 'requires_approval'>),
    requires_approval: isGovernedObjectType(objectType) ? publishRequiresApproval(objectType, policy) : false,
    lock: inventoryLockState(entry.lock as ObjectRecord['lock'], atMs),
  };
};

/** A cached entry is usable only when the listing proves the blob has not changed since it was projected. */
const entryIsCurrent = (entry: ObjectIndexEntry | undefined, item: BlobListItem): entry is ObjectIndexEntry =>
  Boolean(entry) && usableEtag(item.etag) && usableEtag(entry?.etag) && entry?.etag === item.etag;

export type InventorySweepResult = {
  rows: InventoryRow[];
  /** Diagnostics, surfaced on the response so drift is observable rather than silent. */
  stats: {
    /** Keys the listing returned. */
    listed: number;
    /** Rows served from the index without reading the record. */
    cached: number;
    /** Records that had to be read (new, changed, missing from the index, or unverifiable). */
    read: number;
    /** True when the index was (re)written this call. */
    wrote: boolean;
    /** True when a stored index was found and DISCARDED (old schema version, or unparseable) and rebuilt from records. A cold store is not a rebuild. */
    rebuilt: boolean;
    /**
     * M0.2 — true when the whole answer came from `objects/index.json` +
     * `objects/version` and NOTHING was listed. This is the metric the M0
     * acceptance is stated in: a warm, unchanged store must report
     * `trusted: true`, `listed === cached`, `read: 0`, `wrote: false`.
     */
    trusted: boolean;
  };
};

/**
 * The sweep. Lists every governed type (unchanged: in parallel, and one
 * unlistable type degrades to "0 rows from that type" rather than failing the
 * whole call), then serves each key from the index when its etag still matches
 * and reads only the rest.
 *
 * `rows` come back UNSORTED and UNFILTERED — the caller owns both, exactly as
 * it did when it drove the sweep itself.
 */
export const sweepInventoryRows = async (
  store: ObjectIndexStore,
  options: {
    nowMs: number;
    approvalPolicy?: ApprovalPolicy;
    objectType?: ObjectType;
    /**
     * The two projection docs, when the caller has already read them.
     * `readInventoryRows` always has — it read them to decide whether it could
     * trust them — and re-reading would make the repair path cost two blob
     * reads more than the path it replaced.
     */
    preread?: { index: ObjectIndex | undefined; superseded: boolean; version: ObjectStoreVersion | undefined };
  }
): Promise<InventorySweepResult> => {
  const policy = options.approvalPolicy ?? activeApprovalPolicy();
  const types: readonly ObjectType[] = options.objectType ? [options.objectType] : objectTypes;

  const perTypeItems = await Promise.all(
    types.map(async (objectType) => {
      // Unchanged from the sweep this replaces (2026-08-06 hotfix): await the
      // list result BEFORE chaining, because `{paginate:true}` can return a
      // plain AsyncIterable whose `.then()` throws synchronously, before a
      // `.catch()` could ever attach.
      try {
        const listResult = await store.list({
          prefix: `objects/${objectType}/by-id/`,
          directories: false,
          paginate: true,
        });
        return await collectBlobListItems(listResult as Parameters<typeof collectBlobListItems>[0]);
      } catch (error) {
        console.warn(`inventory: skipping unlistable object type "${objectType}".`, error);
        return [] as BlobListItem[];
      }
    })
  );
  const items = perTypeItems.flat();

  const { index, superseded, version } = options.preread ?? {
    ...(await readObjectIndex(store)),
    version: await readObjectStoreVersion(store),
  };
  const byKey = new Map<string, ObjectIndexEntry>((index?.entries ?? []).map((entry) => [entry.key, entry]));

  const stale: BlobListItem[] = [];
  const rows: InventoryRow[] = [];
  const nextEntries: ObjectIndexEntry[] = [];

  for (const item of items) {
    const entry = byKey.get(item.key);
    if (entryIsCurrent(entry, item)) {
      rows.push(rowFromEntry(entry, options.nowMs, policy));
      nextEntries.push(entry);
    } else {
      stale.push(item);
    }
  }

  const loaded = await mapWithConcurrency(stale, STORE_READ_CONCURRENCY, async (item) => {
    // Same contract as the sweep this replaces: an unreadable or unparseable
    // key degrades that ONE row, never the whole response.
    try {
      const raw = await store.get(item.key);
      if (!raw) return undefined;
      return JSON.parse(raw) as ObjectRecord;
    } catch (error) {
      console.warn(`inventory: skipping unreadable object record at "${item.key}".`, error);
      return undefined;
    }
  });

  loaded.forEach((record, i) => {
    if (!record) return;
    const item = stale[i] as BlobListItem;
    rows.push(inventoryRowFromRecord(record, options.nowMs, policy));
    if (usableEtag(item.etag)) nextEntries.push(projectIndexEntry(item.key, item.etag, record, options.nowMs));
  });

  /**
   * A store whose listing carries no usable etags (the local file-backed shim
   * reports `etag: ''`) can project NOTHING. Writing in that case would
   * truncate a good index — written by a real deployment against the same
   * bucket — down to nothing, so the projection is simply not persisted and
   * the sweep behaves exactly as it did before this module existed.
   */
  const projectedNothing = items.length > 0 && nextEntries.length === 0;
  const wrote = projectedNothing
    ? false
    : await writeIndexIfChanged(store, index, nextEntries, {
        partial: Boolean(options.objectType),
        listedKeys: new Set(items.map((item) => item.key)),
        version,
        nowMs: options.nowMs,
      });

  return {
    rows,
    stats: {
      listed: items.length,
      cached: items.length - stale.length,
      read: stale.length,
      wrote,
      rebuilt: superseded,
      trusted: false,
    },
  };
};

/**
 * Persist the projection, and — on a FULL sweep — put the drift alarm back in
 * step with it, which is what makes the next read a two-blob read.
 *
 * A steady state where nothing was edited AND the alarm already agrees costs
 * zero writes. A partial sweep (one `objectType`) must never truncate the
 * index to that type, so it keeps every entry outside the keys it listed.
 *
 * ## Why a PARTIAL sweep may never disarm the alarm (M0.2)
 *
 * A partial sweep verified ONE type against the live listing and carried every
 * other type's entries over untouched. Before M0 that was harmless: the index
 * was re-verified on every read. Now `version.seq === index.seq` is a promise
 * that the WHOLE index is current, and a partial sweep cannot make that
 * promise — the armed alarm it would be disarming may well have been armed by
 * an interrupted write to one of the types it did not look at. So a partial
 * sweep refreshes CONTENT at the existing `seq` and leaves the alarm exactly
 * as it found it; the next full read repairs and re-trusts.
 *
 * Concurrency: last write wins here, which is still safe, because a sweep
 * writes a COMPLETE projection it verified against the listing rather than a
 * read-modify-write of somebody else's state. The loss it can suffer is a
 * sweep landing after a choke-point write and reverting that row — and that
 * cannot be served as current, because the sweep stamps the `seq` it read
 * BEFORE listing while the writer moved the alarm past it. Mismatch, rebuild.
 * (The CHOKE POINT's index write is the read-modify-write, and that one is
 * compare-and-swapped — see `commitObjectIndexEntries`.)
 */
const writeIndexIfChanged = async (
  store: ObjectIndexDocStore,
  existing: ObjectIndex | undefined,
  sweptEntries: readonly ObjectIndexEntry[],
  scope: {
    partial: boolean;
    listedKeys: Set<string>;
    version: ObjectStoreVersion | undefined;
    nowMs: number;
  }
): Promise<boolean> => {
  const merged = scope.partial
    ? [...(existing?.entries ?? []).filter((entry) => !scope.listedKeys.has(entry.key)), ...sweptEntries]
    : [...sweptEntries];
  merged.sort((a, b) => a.key.localeCompare(b.key));

  const before = (existing?.entries ?? []).map((entry) => `${entry.key}\u0000${entry.etag}`).sort();
  const after = merged.map((entry) => `${entry.key}\u0000${entry.etag}`).sort();
  const sameEntries = Boolean(existing) && before.length === after.length && before.every((v, i) => v === after[i]);

  // A partial sweep only ever refreshes content, at the seq it found.
  if (scope.partial) {
    if (sameEntries) return false;
    return persistIndex(store, { ...(existing ?? emptyIndex()), entries: merged }, scope.nowMs);
  }

  // A full sweep must leave the pair AGREEING, so the next read is two blobs.
  // Nothing to do only when the entries already match AND the alarm is down.
  const alarmDown =
    Boolean(existing) && scope.version?.seq === existing?.seq && scope.version?.armed !== true;
  if (sameEntries && alarmDown) return false;
  if (!existing && merged.length === 0 && !scope.version) {
    // A genuinely empty, never-written store still deserves the pair: without
    // it every read of an empty site pays 13 listings forever.
    const seq = 1;
    const wroteEmpty = await persistIndex(store, { ...emptyIndex(), seq, entries: [] }, scope.nowMs);
    if (wroteEmpty) await writeObjectStoreVersion(store, seq, new Date(scope.nowMs).toISOString()).catch(() => undefined);
    return wroteEmpty;
  }

  const seq = Math.max(existing?.seq ?? 0, scope.version?.seq ?? 0) + 1;
  const wrote = await persistIndex(store, { ...emptyIndex(), seq, entries: merged }, scope.nowMs);
  if (!wrote) return false;
  // Index FIRST, alarm second: a crash between them leaves `version.seq` BELOW
  // `index.seq`, which is a mismatch, which is another rebuild. The opposite
  // order would leave them equal with the index half-written.
  try {
    await writeObjectStoreVersion(store, seq, new Date(scope.nowMs).toISOString());
  } catch (error) {
    console.warn('inventory: could not persist objects/version.', error);
  }
  return true;
};



// ═══ M0.2 — the trusted read ═══════════════════════════════════════════════

/**
 * Two blob reads, in parallel, and no listing. `undefined` means "not
 * trustworthy, sweep instead" and is the answer for every doubt there is: no
 * index, no alarm doc, an alarm that disagrees with the index, a corrupt or
 * superseded index.
 *
 * `objectType` narrows the ANSWER, not the evidence: the whole index was
 * vouched for by one `seq` comparison, so serving one type out of it is a
 * filter, not a second decision.
 */
const readTrustedInventory = (
  options: { nowMs: number; approvalPolicy?: ApprovalPolicy; objectType?: ObjectType },
  read: { index: ObjectIndex | undefined; version: ObjectStoreVersion | undefined }
): InventorySweepResult | undefined => {
  const { index, version } = read;
  if (!index || !version) return undefined;
  if (version.seq !== index.seq) return undefined;
  /**
   * REVIEW — the second term of the trust predicate. `seq` alone could be put
   * back in step by a writer that never committed its row (see
   * `index-doc.ts`'s schema note); `armed` is the sticky flag such a writer
   * leaves behind, and only a full verified sweep clears it.
   */
  if (version.armed === true) return undefined;

  const policy = options.approvalPolicy ?? activeApprovalPolicy();
  const entries = options.objectType
    ? index.entries.filter((entry) => entry.row.object_type === options.objectType)
    : index.entries;

  return {
    // `lock` and `requires_approval` are re-derived HERE, per read, from the
    // caller's `atMs` and the active policy — see the header. A lease expires
    // with nothing written, so serving a cached `held: true` would be a silent
    // correctness bug, trusted index or not.
    rows: entries.map((entry) => rowFromEntry(entry, options.nowMs, policy)),
    stats: {
      listed: entries.length,
      cached: entries.length,
      read: 0,
      wrote: false,
      rebuilt: false,
      trusted: true,
    },
  };
};

/**
 * The inventory read path. Tries the trusted index first (2 blob reads, no
 * listing); falls through to the verified sweep, which is also the repair.
 *
 * Every caller that wants inventory rows should use THIS, not
 * `sweepInventoryRows` — the sweep is the repair path and the nightly job.
 */
export const readInventoryRows = async (
  store: ObjectIndexStore,
  options: { nowMs: number; approvalPolicy?: ApprovalPolicy; objectType?: ObjectType }
): Promise<InventorySweepResult> => {
  // THE two reads. In parallel, because neither answers a question the other
  // asked: together they are the whole warm-path cost.
  const [indexRead, version] = await Promise.all([readObjectIndex(store), readObjectStoreVersion(store)]);
  const trusted = readTrustedInventory(options, { index: indexRead.index, version });
  if (trusted) return trusted;
  // The repair path inherits what was just read rather than reading it again.
  return sweepInventoryRows(store, {
    ...options,
    preread: { index: indexRead.index, superseded: indexRead.superseded, version },
  });
};

