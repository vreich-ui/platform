/**
 * Analytics annotations (T21.29; runner R11.3) — I/O only. Gathers the three
 * raw inputs `lib/admin/analytics-annotations-logic.ts`'s pure builders turn
 * into one merged, range-scoped marker list: recent Netlify deploy receipts
 * (release markers), `publish` entries off any `content_item`/`page`
 * record's `history[]` (publish markers), and operator notes from the same
 * `analytics-views` Blobs store R11.1 introduced (note markers — this is a
 * dashboard annotation, not a second changelog page).
 *
 * Every source degrades independently and never throws past this module —
 * an unconfigured/failing deploy lookup, an unreadable object store, or a
 * corrupt notes doc each fold to "zero markers from that source", matching
 * this file's neighbors' best-effort posture (`admin-analytics.ts`'s R6.2
 * additions, `analytics-object-directory.ts`).
 *
 * ## W3.3 — why the publish half stopped reading whole records
 *
 * This path used to call `listAllObjectRecords(store, {status:'active'})`:
 * one `list()` per governed object type followed by a WHOLE `ObjectRecord`
 * envelope — both body trees plus an unbounded `history` — for every object
 * in the store, to end up with a handful of `publish` timestamps inside a
 * 7-to-30-day window. It was the measured offender behind `/admin/analytics`'s
 * ~3 s of server `work`.
 *
 * The index-backed sweep (`objects/index-store.ts`) is what the rest of this
 * codebase uses for exactly this, so this path now joins it. The one thing it
 * cannot supply is the markers themselves: an `InventoryRow` carries no
 * `history[]`, by design (it exists to be a bounded projection), so the
 * publish entries must still come off the record. What the index DOES supply
 * is the proof that almost every record cannot contain one:
 *
 *  - `object_type` — only `content_item`/`page` are annotated at all;
 *  - `status` — the `{status:'active'}` filter this path always applied;
 *  - `published_time === null` — never published, so there is no `publish`
 *    history entry anywhere in the record;
 *  - `updated_at < from` — the record has not been WRITTEN since the window
 *    opened. A publish entry is stamped by `object-publish.ts` in the same
 *    write that sets `updated_at` to that entry's own `at`, and `updated_at`
 *    only moves forward, so `max(history.at) <= updated_at`. An untouched
 *    record cannot hold an entry inside the window.
 *
 * So the sweep names the candidates and only they are read in full. On a
 * realistic library that is single digits instead of N, and in the steady
 * state the sweep itself reads ONE blob (the index) rather than N.
 *
 * Deliberately NOT done here: adding a publish digest to `InventoryRow` so
 * even those candidates could be served from the index. That field lives in
 * `object-inventory.ts` — out of scope for this change, and worth sequencing
 * on its own because it changes the index schema version.
 */
import { fetchRecentDeploys, netlifyDeployLookupMissingEnvVars } from './netlify-deploys.js';
import { mapWithConcurrency, STORE_READ_CONCURRENCY } from './blob-list.js';
import { compareInventoryRows, type InventoryRow } from './object-inventory.js';
import { objectRecordKey } from './object-store-keys.js';
import { readInventoryRows } from './objects/index-store.js';
import type { ObjectVerbStore } from './object-verbs.js';
import { listAnalyticsNotes, type AnalyticsViewsStore } from './analytics-views-store.js';
import {
  markersInRange,
  mergeAnnotationMarkers,
  noteMarkersFromNotes,
  publishMarkersFromRecords,
  releaseMarkersFromDeploys,
  type AnnotatableObjectRecordLike,
  type AnnotationMarker,
} from '../../lib/admin/analytics-annotations-logic.js';
import { objectTypes, type ObjectRecord, type ObjectType } from '../../schema/object-record-v1.js';

const adminObjectHref = (objectId: string): string => `/admin/content/${encodeURIComponent(objectId)}`;

/**
 * The object types worth sweeping for publish markers. This MUST stay in step
 * with `PUBLISHABLE_OBJECT_TYPES` in `analytics-annotations-logic.ts`, which
 * stays the authority — `publishMarkersFromRecords` re-applies it, so a drift
 * here can only cost a wasted read, never a wrong marker. Exported so the
 * suite can pin the two lists against each other rather than trusting this
 * comment.
 */
export const ANNOTATED_OBJECT_TYPES: readonly ObjectType[] = ['content_item', 'page'];

async function fetchReleaseMarkers(): Promise<AnnotationMarker[]> {
  if (netlifyDeployLookupMissingEnvVars().length > 0) return [];
  try {
    return releaseMarkersFromDeploys(await fetchRecentDeploys());
  } catch (error) {
    console.error('Failed to load recent deploys for analytics annotations.', error);
    return [];
  }
}

function titleOf(record: ObjectRecord): string | undefined {
  const body = record.body as { title?: unknown } | undefined;
  return typeof body?.title === 'string' && body.title ? body.title : undefined;
}

/**
 * Can this row possibly carry a `publish` history entry in `[from, …]`? See
 * the file header for why each clause is sound. Every clause is a field the
 * index already carries, so answering "no" costs no record read at all.
 */
const couldCarryPublishInWindow = (row: InventoryRow, fromIso: string): boolean => {
  // The `{status:'active'}` filter `listAllObjectRecords` applied for us.
  if (row.status !== 'active') return false;
  // Never published: `object-publish.ts` is the only writer of a `publish`
  // entry and it stamps `published_time` in the same write, so a null here
  // means there is no such entry to find. (`undefined` is possible on a
  // half-healed record — `object-inventory.ts` guards it the same way.)
  if (row.published_time === null || row.published_time === undefined) return false;
  // Not written since the window opened, so `max(history.at) < from`.
  return row.updated_at >= fromIso;
};

/** One candidate record, read whole — the only place this path still pays for an envelope. */
const readCandidateRecord = async (store: ObjectVerbStore, row: InventoryRow): Promise<ObjectRecord | undefined> => {
  const key = objectRecordKey(row.object_type, row.object_id);
  try {
    const raw = await store.get(key);
    if (!raw) return undefined;
    return JSON.parse(raw) as ObjectRecord;
  } catch (error) {
    // Same contract as the sweep this replaces: one bad key degrades that ONE
    // row's markers, never the whole annotation list.
    console.warn(`Analytics annotations: skipping unreadable object record at "${key}".`, error);
    return undefined;
  }
};

async function fetchPublishMarkers(
  store: ObjectVerbStore,
  fromIso: string,
  toIso: string
): Promise<AnnotationMarker[]> {
  let rows: InventoryRow[];
  try {
    // Sequential, not parallel: both sweeps read and rewrite the ONE
    // `objects/index.json`, and a partial sweep preserves the entries of the
    // types it did not list. Run concurrently they would race on that write
    // and one type's entries would be dropped — harmless (the projection is
    // regenerable) but it would cost the next reader a rebuild for nothing.
    rows = [];
    for (const objectType of ANNOTATED_OBJECT_TYPES) {
      const sweep = await readInventoryRows(store, { nowMs: Date.now(), objectType });
      rows.push(...sweep.rows);
    }
  } catch (error) {
    console.error('Failed to sweep the object index for analytics annotations.', error);
    return [];
  }

  const candidates = rows.filter((row) => couldCarryPublishInWindow(row, fromIso));
  // Canonical object_type-then-object_id order, which is what the flattened
  // per-type listing this replaces produced. It only shows through on markers
  // that share an `at` to the millisecond (`mergeAnnotationMarkers`' sort is
  // stable), but the wire order is a contract either way.
  candidates.sort(compareInventoryRows(objectTypes));

  const records = await mapWithConcurrency(candidates, STORE_READ_CONCURRENCY, (row) =>
    readCandidateRecord(store, row)
  );

  const likeRecords: AnnotatableObjectRecordLike[] = [];
  for (const record of records) {
    if (!record) continue;
    likeRecords.push({
      objectId: record.object_id,
      objectType: record.object_type,
      title: titleOf(record),
      adminHref: adminObjectHref(record.object_id),
      history: record.history ?? [],
    });
  }
  return publishMarkersFromRecords(likeRecords, fromIso, toIso);
}

/**
 * The memo hook `admin-analytics.ts` hands in — see this module's `fetchShippedMarkers`.
 * Deliberately an interface over the caller's cache rather than a Map here:
 * the TTL, the key and the eviction policy are that function's (it already
 * runs a module-scope memo for every other resource on the file), and this
 * module stays I/O-only.
 */
export interface ShippedMarkerCache {
  /** The memoized "what shipped" half, or undefined when cold/expired. */
  read(): AnnotationMarker[] | undefined;
  write(markers: readonly AnnotationMarker[]): void;
}

/**
 * The two "what shipped" sources — releases and publishes. Split out from
 * notes because these two, and only these two, are safe to memoize: see
 * `fetchAnnotationMarkers`.
 */
async function fetchShippedMarkers(
  store: ObjectVerbStore,
  fromIso: string,
  toIso: string
): Promise<AnnotationMarker[]> {
  const [releases, publishes] = await Promise.all([fetchReleaseMarkers(), fetchPublishMarkers(store, fromIso, toIso)]);
  return mergeAnnotationMarkers(releases, publishes);
}

export interface FetchAnnotationMarkersOptions {
  store: ObjectVerbStore;
  viewsStore: AnalyticsViewsStore;
  /** ISO window bounds — same convention as `own-tracker-stats.ts`. */
  from: string;
  to: string;
  /** Optional memo over the release+publish half; notes are never served from it. */
  shippedCache?: ShippedMarkerCache;
}

/**
 * W3.3 — the memo join, and the exact line it is drawn on.
 *
 * `admin-analytics.ts` has run a module-scope TTL memo since R6.2 and this
 * resource was the one branch that never touched it. The reason is written
 * down in that file (T2.3) and it is a real one: an operator adds a note and
 * re-reads the marker list in the same session, so a 5-minute memo over the
 * WHOLE body would hide their own write.
 *
 * That argument covers the notes source and nothing else. Releases are
 * finished Netlify deploys and publishes are `publish` history entries —
 * neither is written by this page, and both are already served under the
 * file's ordinary staleness budget everywhere else on the dashboard. So the
 * memo is joined for those two and notes are read live on every call. The
 * ETag the caller sends is still computed off the MERGED body, so it varies
 * with a freshly-added note exactly as it did before.
 */
export async function fetchAnnotationMarkers(options: FetchAnnotationMarkersOptions): Promise<AnnotationMarker[]> {
  const cached = options.shippedCache?.read();
  const [shipped, notes] = await Promise.all([
    cached ? Promise.resolve(cached) : fetchShippedMarkers(options.store, options.from, options.to),
    listAnalyticsNotes(options.viewsStore, { from: options.from, to: options.to }).catch(() => []),
  ]);
  if (!cached) options.shippedCache?.write(shipped);

  const merged = mergeAnnotationMarkers(shipped, noteMarkersFromNotes(notes));
  // Releases aren't pre-scoped to the window (fetchRecentDeploys is a flat
  // "most recent N", not a ranged query) — one final filter keeps every
  // source honest to the same [from, to] the caller asked for.
  return markersInRange(merged, options.from, options.to);
}
