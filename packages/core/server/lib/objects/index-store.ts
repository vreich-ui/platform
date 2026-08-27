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
 */
import { z } from 'zod';

import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from '../blob-list.js';
import { inventoryLockState, inventoryRowFromRecord, type InventoryRow } from '../object-inventory.js';
import {
  activeApprovalPolicy,
  isGovernedObjectType,
  publishRequiresApproval,
  type ApprovalPolicy,
} from '../../../lib/approval-policy.js';
import { objectTypes, type ObjectRecord, type ObjectType } from '../../../schema/object-record-v1.js';

export const OBJECT_INDEX_SCHEMA_VERSION = 'object-inventory-index.v1';
export const OBJECT_INDEX_KEY = 'objects/index.json';

/**
 * The row as STORED. `lock` and `requires_approval` are stripped from the
 * cached projection because they are re-derived per read (see the header); the
 * raw lease is kept so `lock` can be re-derived at any `atMs`.
 */
const indexEntrySchema = z.object({
  /** The record's blob key — the identity `store.list()` reports. */
  key: z.string(),
  /** The etag `list()` reported when `row` was projected. Never trusted when empty. */
  etag: z.string(),
  /**
   * `InventoryRow` minus the two re-derived fields. Kept as a loose record on
   * purpose: this is a cache, and a future row-shape change must degrade to a
   * re-read, never to a parse failure that breaks the library.
   */
  row: z.record(z.string(), z.unknown()),
  /** Raw `record.lock`, absent when the record held none. */
  lock: z.unknown().optional(),
});
export type ObjectIndexEntry = z.infer<typeof indexEntrySchema>;

export const objectIndexSchema = z.object({
  schema_version: z.literal(OBJECT_INDEX_SCHEMA_VERSION),
  /** Monotonic write counter, bumped by every index write including repairs. */
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  entries: z.array(indexEntrySchema),
});
export type ObjectIndex = z.infer<typeof objectIndexSchema>;

/** The minimal store shape this module needs; `ObjectVerbStore` satisfies it. */
export interface ObjectIndexStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<unknown>;
}

/** An etag is usable only when the store actually reported one (`local-blobs.ts` reports `''`). */
const usableEtag = (etag: string | undefined): etag is string => typeof etag === 'string' && etag.length > 0;

/** `undefined` when absent, unreadable, unparseable, or written by a different schema version — the caller then rebuilds. */
export const loadObjectIndex = async (store: ObjectIndexStore): Promise<ObjectIndex | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(OBJECT_INDEX_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const result = objectIndexSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

/** The one place an entry is derived from a record, so a cached row can never drift from the live projection's shape. */
export const projectIndexEntry = (key: string, etag: string, record: ObjectRecord, atMs: number): ObjectIndexEntry => {
  // `atMs` reaches only the two fields stripped below; every retained field is
  // a pure function of the record.
  const { lock: _lock, requires_approval: _requiresApproval, ...rest } = inventoryRowFromRecord(record, atMs);
  return {
    key,
    etag,
    row: rest as unknown as Record<string, unknown>,
    ...(record.lock ? { lock: record.lock } : {}),
  };
};

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
  options: { nowMs: number; approvalPolicy?: ApprovalPolicy; objectType?: ObjectType }
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

  const index = await loadObjectIndex(store);
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
      });

  return {
    rows,
    stats: { listed: items.length, cached: items.length - stale.length, read: stale.length, wrote },
  };
};

/**
 * Persist the projection, but only when it would actually change — so a steady
 * state where nothing was edited costs zero writes. A partial sweep (one
 * `objectType`) must never truncate the index to that type, so it keeps every
 * entry outside the keys it listed.
 *
 * Concurrency: last write wins, which is safe here for the same reason it is
 * safe in `requests/store.ts` — this is a regenerable projection, so a lost
 * write costs the next reader one extra sweep and nothing else.
 */
const writeIndexIfChanged = async (
  store: ObjectIndexStore,
  existing: ObjectIndex | undefined,
  sweptEntries: readonly ObjectIndexEntry[],
  scope: { partial: boolean; listedKeys: Set<string> }
): Promise<boolean> => {
  const merged = scope.partial
    ? [...(existing?.entries ?? []).filter((entry) => !scope.listedKeys.has(entry.key)), ...sweptEntries]
    : [...sweptEntries];
  merged.sort((a, b) => a.key.localeCompare(b.key));

  const before = (existing?.entries ?? []).map((entry) => `${entry.key} ${entry.etag}`).sort();
  const after = merged.map((entry) => `${entry.key} ${entry.etag}`).sort();
  if (existing && before.length === after.length && before.every((value, i) => value === after[i])) return false;
  if (!existing && merged.length === 0) return false;

  const index: ObjectIndex = {
    schema_version: OBJECT_INDEX_SCHEMA_VERSION,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: new Date().toISOString(),
    entries: merged,
  };
  try {
    await store.setJSON(OBJECT_INDEX_KEY, objectIndexSchema.parse(index));
    return true;
  } catch (error) {
    // The index is a cache. Failing to persist it costs the next call a full
    // sweep; it must never fail the call that noticed.
    console.warn('inventory: could not persist objects/index.json.', error);
    return false;
  }
};
