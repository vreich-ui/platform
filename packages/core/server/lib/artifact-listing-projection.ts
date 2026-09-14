/**
 * The editorial-assets listing projection — `projections/editorial-assets.v1.json`
 * in the per-tenant artifact-index store.
 *
 * ## The problem it removes
 *
 * `admin-editorial-assets` answers "the newest 100 live images and the newest
 * 100 live PDFs". Before this module that cost, per load and per kind, one
 * `by-kind/<kind>/` listing plus one READ of every pointer under it, plus a
 * full-record read for every row returned and for every pointer that had not
 * been read-repaired yet. On drluriescience that measured `sec.artifacts_image
 * = 2406ms` — on a surface the asset picker re-fetches on every navigation
 * into it.
 *
 * The pointers were only ever a way to learn `createdAtISO` without opening a
 * record. This module skips them entirely: it lists the RECORDS
 * (`request-artifacts/<requestId>/<sha>.json`, already exactly one per
 * request+sha) and keeps a projection of the handful of fields the listing
 * shows, verified per key against the etag `list()` reports at no extra cost.
 *
 * Steady state: `1 list + 1 get`, zero record reads, zero writes. One artifact
 * uploaded or deleted since the last load: `+1 record get + 1 write`. Cold, or
 * against a store whose listing carries no etags: exactly the old cost of
 * reading every record, plus one write.
 *
 * ## Why a verified projection and not a writer-maintained index
 *
 * Same reasoning as `objects/index-store.ts` (T5.1 R3), and the same
 * mechanism. Artifact records are written from `artifact-upload.ts`,
 * `artifact-soft-delete.ts`, `artifact-legacy-adopt.ts`, `admin-inventory.ts`
 * and the dedupe sweep; an index maintained by writers is only as correct as
 * the least careful one. Here a cached row is reused ONLY when the listing
 * reports the same etag the row was projected from. A new key, a changed etag,
 * a missing entry or an unverifiable (empty) etag all fall through to reading
 * that one record. Nothing anywhere has to know this file exists, and no
 * writer changes: this module reads records and writes ONE key that no other
 * code path reads or lists.
 *
 * That is also why the shared-pointer hazard (#746) does not apply to this
 * listing any more: `by-kind/` pointers are not consulted at all.
 *
 * ## Torn state
 *
 * The projection is a cache. A lost write costs the next reader one extra
 * sweep. A stale row is never SERVED, because its etag no longer matches the
 * listing. A record that vanishes from the listing simply stops being served.
 * The one lag that remains — a listing served from the cached edge on the
 * Lambda name-lookup path (`blob-store.ts`) — is the same lag the pointer
 * sweep already had.
 *
 * ## Cold-start budget
 *
 * A cold or wholly-invalidated projection would read every record in one
 * invocation. `PROJECTION_READ_BUDGET` caps that: the sweep reads at most the
 * budget's worth of uncached records, persists what it projected, and reports
 * `complete: false` so the caller can answer this ONE response the old way.
 * A tenant with 2,500 artifacts converges in three loads instead of risking a
 * function timeout on the first.
 *
 * The budget is applied only when the listing carries usable etags. A store
 * that reports `etag: ''` (the local file-backed shim) can cache nothing, so
 * budgeting it would make every single load partial and never converge —
 * there it reads everything, exactly as the sweep it replaces did.
 */
import { z } from 'zod';

import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from './blob-list.js';
import { isArtifactReference, type ArtifactReference } from './artifacts.js';
import type { ArtifactIndexStore } from './artifact-index.js';
import { projectEditorialArtifact, type EditorialArtifact } from '../../lib/admin/editorial-assets.js';

/**
 * A bump is a hard break, handled the same way `objects/index.json` handles
 * one: `z.literal`, so an older blob is detected on the first read after
 * deploy and rebuilt in place by the same read-repair path that handles a
 * corrupt or absent projection. No script, no per-tenant remediation.
 */
export const EDITORIAL_PROJECTION_SCHEMA_VERSION = 'editorial-assets-projection.v1';

/**
 * Deliberately under a prefix nothing else lists. Every other reader of this
 * store lists `by-kind/`, `by-tag/`, `by-request/`, `by-sha/`, `by-slot/`,
 * `request-artifacts/` or `request-owner/`, so this key cannot appear in
 * anyone's sweep — including this module's own `request-artifacts/` listing.
 */
export const EDITORIAL_PROJECTION_KEY = 'projections/editorial-assets.v1.json';

/** The prefix the sweep lists: one record per (request, sha). */
export const ARTIFACT_RECORD_PREFIX = 'request-artifacts/';

/** Rows returned per kind — the same limit the pointer sweep applied. */
export const RESULT_LIMIT = 100;

/**
 * Uncached records read in ONE invocation. 1,000 keeps a cold sweep well
 * inside a 10s function budget at `STORE_READ_CONCURRENCY = 8`, and a tenant
 * converges in ⌈A/1000⌉ loads.
 */
export const PROJECTION_READ_BUDGET = 1000;

/**
 * The listable half of an entry: `projectEditorialArtifact`'s output plus the
 * four fields the sweep itself sorts, splits and dedupes on. They are stored
 * rather than re-derived from `artifact` so a change to the wire shape of
 * `EditorialArtifact` can never quietly change which rows are chosen.
 */
const projectedRowSchema = z.object({
  sha256: z.string(),
  requestId: z.string(),
  kind: z.enum(['image', 'pdf']),
  createdAtISO: z.string(),
  /** Loose on purpose: this is a cache, and a future row-shape change must degrade to a re-read, never to a parse failure. */
  artifact: z.record(z.string(), z.unknown()),
});

const projectionEntrySchema = z.object({
  /** The record's blob key — the identity `store.list()` reports. */
  key: z.string(),
  /** The etag `list()` reported when this entry was projected. Never trusted when empty. */
  etag: z.string(),
  /**
   * "Contributes no row to this listing, and that is a fact about the RECORD."
   * Two things land here — a soft-deleted reference, and a kind the editorial
   * picker does not show (audio, video, …). Both must be REMEMBERED, or every
   * sweep re-reads them forever, and both are safe to remember because only a
   * rewrite of the record (which moves its etag) can change either verdict.
   *
   * A record this build cannot READ, and one its `isArtifactReference` REJECTS,
   * deliberately do NOT land here — see `projectEntry`.
   */
  deleted: z.literal(true).optional(),
  row: projectedRowSchema.optional(),
});
export type EditorialProjectionEntry = z.infer<typeof projectionEntrySchema>;

export const editorialProjectionSchema = z.object({
  schema_version: z.literal(EDITORIAL_PROJECTION_SCHEMA_VERSION),
  /** Monotonic write counter, bumped by every write including partial ones. */
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  entries: z.array(projectionEntrySchema),
});
export type EditorialProjection = z.infer<typeof editorialProjectionSchema>;

/** An etag is usable only when the store actually reported one (`local-blobs.ts` reports `''`). */
const usableEtag = (etag: string | undefined): etag is string => typeof etag === 'string' && etag.length > 0;

const entryIsCurrent = (
  entry: EditorialProjectionEntry | undefined,
  item: BlobListItem
): entry is EditorialProjectionEntry =>
  Boolean(entry) && usableEtag(item.etag) && usableEtag(entry?.etag) && entry?.etag === item.etag;

/**
 * The projection, plus WHY it is missing when it is. `superseded` means a blob
 * was there and could not be used — unparseable, or a schema version this
 * build no longer reads; that is a REBUILD, and an absent key is merely a cold
 * store. `unreadable` is neither: the `get` itself failed, so what is in the
 * bucket is unknown and may well be complete.
 */
const readProjection = async (
  store: ArtifactIndexStore
): Promise<{ projection: EditorialProjection | undefined; superseded: boolean; unreadable: boolean }> => {
  let raw: string | null;
  try {
    raw = await store.get(EDITORIAL_PROJECTION_KEY);
  } catch {
    return { projection: undefined, superseded: false, unreadable: true };
  }
  if (!raw) return { projection: undefined, superseded: false, unreadable: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { projection: undefined, superseded: true, unreadable: false };
  }
  const result = editorialProjectionSchema.safeParse(parsed);
  return result.success
    ? { projection: result.data, superseded: false, unreadable: false }
    : { projection: undefined, superseded: true, unreadable: false };
};

/**
 * The one place an entry is derived from a record, so a cached row can never
 * drift from a live one.
 *
 * `undefined` means "contributes nothing, and that verdict must NOT be
 * remembered". Exactly one thing answers that way: a record this build's
 * `isArtifactReference` rejects. That is not a fact about the record — the
 * allow-list in `getArtifactReferenceIssue` rejects a reference outright for
 * carrying a top-level key it has not been taught, and the doc comment on
 * `ArtifactReference.filename` (artifacts.ts) is the record of the last time a
 * newer writer's field did exactly that to an older reader — pdf-tool wrote
 * `filename` for five weeks before platform's allow-list learned it. Across a
 * rolling deploy or a rollback the same bytes are
 * therefore invalid to one build and live to the next; caching the rejecting
 * build's verdict against the etag would hide a LIVE artifact from the picker
 * permanently, because nothing short of rewriting the record ever moves that
 * etag again. Left unprojected it costs one read per sweep — the same price,
 * and for the same reason, as the record the sweep could not read at all.
 */
export const projectEntry = (key: string, etag: string, record: unknown): EditorialProjectionEntry | undefined => {
  if (!isArtifactReference(record)) return undefined;
  if (record.deletedAtISO) return { key, etag, deleted: true };
  const artifact = projectEditorialArtifact(record as ArtifactReference);
  if (!artifact) return { key, etag, deleted: true };
  return {
    key,
    etag,
    row: {
      sha256: record.sha256,
      requestId: requestIdFromRecordKey(key),
      kind: artifact.kind,
      createdAtISO: record.createdAtISO,
      artifact: artifact as unknown as Record<string, unknown>,
    },
  };
};

/** `request-artifacts/<encoded requestId>/<sha>.json` — the record key IS the request id, so nothing has to be read to learn it. */
const requestIdFromRecordKey = (key: string): string => {
  const segments = key.split('/');
  if (segments.length < 3) return '';
  try {
    return decodeURIComponent(segments[1] as string);
  } catch {
    return segments[1] as string;
  }
};

export type EditorialSweepResult = {
  /** Newest-first, deduped by sha, capped at `RESULT_LIMIT` — per kind, exactly as the pointer sweep answered. */
  byKind: { image: EditorialArtifact[]; pdf: EditorialArtifact[] };
  /**
   * False when the read budget stopped this sweep short: the rows above are a
   * SUBSET and the caller must answer this one response another way. The
   * projection written by a partial sweep is valid — the next load resumes.
   */
  complete: boolean;
  stats: {
    /** Record keys the listing returned. */
    listed: number;
    /** Rows served from the projection without reading the record. */
    cached: number;
    /** Records read this sweep (new, changed, missing from the projection, or unverifiable). */
    read: number;
    /** Uncached records the budget deferred to a later load. */
    deferred: number;
    /** True when the projection was (re)written this call. */
    wrote: boolean;
    /** True when a stored projection was found and DISCARDED (old version, or unparseable). A cold store is not a rebuild. */
    rebuilt: boolean;
  };
};

const emptyResult = (rebuilt: boolean): EditorialSweepResult => ({
  byKind: { image: [], pdf: [] },
  complete: true,
  stats: { listed: 0, cached: 0, read: 0, deferred: 0, wrote: false, rebuilt },
});

/**
 * Newest first, then sha ascending. The tiebreak is not cosmetic: the pointer
 * sweep this replaces produced its ties in `by-kind/<kind>/<sha>.json` key
 * order (sorted, therefore sha ascending) through a stable sort, and P3 pins
 * that the two paths answer with the same rows in the same order.
 *
 * `requestId` last makes the order TOTAL. Two records CAN agree on both of the
 * first two keys — one digest written under two request ids at the same
 * instant is one artifact with two records — and they are not interchangeable:
 * they carry different `request_id` and `preview_url`. `rows` is concatenated
 * cached-first, so without this key a stable sort hands the dedupe a different
 * winner the moment one of the pair is re-read, and the response (and its
 * ETag, which is what makes this surface's 304 branch worth having) flips for
 * no reason a reader can see.
 */
type SortKeys = { createdAtISO: string; sha256: string; requestId: string };

const byNewest = (a: SortKeys, b: SortKeys) =>
  b.createdAtISO.localeCompare(a.createdAtISO) ||
  a.sha256.localeCompare(b.sha256) ||
  a.requestId.localeCompare(b.requestId);

/**
 * List the records once, serve every row whose etag still matches the
 * projection, read only the rest, and persist the projection when it changed.
 *
 * Never throws for a store-level failure it can degrade around: an unreadable
 * record costs that ONE row, and a projection that cannot be written costs the
 * next call a re-read. A listing that fails is the caller's problem — it has
 * no rows to serve either way.
 */
export const sweepEditorialArtifacts = async (
  store: ArtifactIndexStore,
  options: { budget?: number } = {}
): Promise<EditorialSweepResult> => {
  const budget = Math.max(1, options.budget ?? PROJECTION_READ_BUDGET);

  const listResult = await store.list({ prefix: ARTIFACT_RECORD_PREFIX, directories: false, paginate: true });
  const items = (await collectBlobListItems(listResult as Parameters<typeof collectBlobListItems>[0]))
    .filter((item) => item.key.endsWith('.json'))
    // Deterministic, so a budgeted sweep resumes where the last one stopped
    // instead of re-rolling the dice on which records it happens to read.
    .sort((a, b) => a.key.localeCompare(b.key));

  const { projection, superseded, unreadable } = await readProjection(store);
  if (items.length === 0) return emptyResult(superseded);

  const byKey = new Map<string, EditorialProjectionEntry>((projection?.entries ?? []).map((entry) => [entry.key, entry]));

  const cachedEntries: EditorialProjectionEntry[] = [];
  const stale: BlobListItem[] = [];

  for (const item of items) {
    const entry = byKey.get(item.key);
    if (entryIsCurrent(entry, item)) cachedEntries.push(entry);
    else stale.push(item);
  }

  /**
   * Budget only where caching can actually converge. On a store whose listing
   * reports no usable etags nothing is ever cached, so a budget would truncate
   * every load forever; there the sweep pays the old full cost, which is what
   * that store's callers already paid.
   */
  const canCache = items.some((item) => usableEtag(item.etag));
  const toRead = canCache && stale.length > budget ? stale.slice(0, budget) : stale;
  const deferred = stale.length - toRead.length;

  const loaded = await mapWithConcurrency(toRead, STORE_READ_CONCURRENCY, async (item) => {
    try {
      const raw = await store.get(item.key);
      if (!raw) return undefined;
      return JSON.parse(raw) as unknown;
    } catch (error) {
      console.warn(`editorial-projection: skipping unreadable artifact record at "${item.key}".`, error);
      return undefined;
    }
  });

  const freshEntries: EditorialProjectionEntry[] = [];
  loaded.forEach((record, i) => {
    const item = toRead[i] as BlobListItem;
    // A record that is absent or unreadable RIGHT NOW is not projected as
    // "contributes nothing" — that would cache a transient failure until the
    // blob's etag changed. It is simply left out, and read again next sweep.
    if (record === undefined) return;
    const entry = projectEntry(item.key, item.etag ?? '', record);
    if (entry) freshEntries.push(entry);
  });

  // Only a verifiable entry may be STORED; every entry projected this call is
  // SERVED, verifiable or not.
  const nextEntries = [...cachedEntries, ...freshEntries.filter((entry) => usableEtag(entry.etag))];

  const complete = deferred === 0;
  const wrote = await writeProjectionIfChanged(store, projection, nextEntries, {
    // Nothing verifiable to store: writing would truncate a good projection —
    // one written by a real deployment against the same bucket — to nothing.
    //
    // Same reasoning for the second clause. A PARTIAL sweep may only replace a
    // projection it actually read: one whose `get` failed transiently is very
    // likely complete, and overwriting it with this sweep's budget-sized slice
    // discards entries this call never even looked at. The cost is paid twice
    // by every later reader — a re-read AND the `listKind` fallback that the
    // resulting incompleteness forces — for a failure that touched nothing but
    // one blob read. A sweep that deferred nothing is a complete replacement
    // and writes as usual.
    skip: nextEntries.length === 0 || (unreadable && deferred > 0),
  });

  const rows = [...cachedEntries, ...freshEntries]
    .map((entry) => entry.row)
    .filter((row): row is NonNullable<EditorialProjectionEntry['row']> => row !== undefined)
    .sort(byNewest);

  const byKind: EditorialSweepResult['byKind'] = { image: [], pdf: [] };
  const seen: Record<'image' | 'pdf', Set<string>> = { image: new Set(), pdf: new Set() };
  for (const row of rows) {
    const bucket = byKind[row.kind];
    if (bucket.length >= RESULT_LIMIT || seen[row.kind].has(row.sha256)) continue;
    seen[row.kind].add(row.sha256);
    bucket.push(row.artifact as unknown as EditorialArtifact);
  }

  return {
    byKind,
    complete,
    stats: {
      listed: items.length,
      cached: cachedEntries.length,
      read: toRead.length,
      deferred,
      wrote,
      rebuilt: superseded,
    },
  };
};

/**
 * Persist only when the projection would actually change, so a steady state
 * costs zero writes. Last write wins, which is safe for the same reason it is
 * in `objects/index-store.ts`: this is a regenerable cache, so a lost write
 * costs the next reader one extra sweep and nothing else.
 *
 * A partial (budgeted) sweep persists exactly what it verified or read. Keys
 * it deferred have no entry — they were not current, or not present — so the
 * next load reads them and the projection grows by one budget per load.
 */
const writeProjectionIfChanged = async (
  store: ArtifactIndexStore,
  existing: EditorialProjection | undefined,
  entries: readonly EditorialProjectionEntry[],
  scope: { skip: boolean }
): Promise<boolean> => {
  if (scope.skip) return false;
  const merged = [...entries].sort((a, b) => a.key.localeCompare(b.key));

  const before = (existing?.entries ?? []).map((entry) => `${entry.key} ${entry.etag}`).sort();
  const after = merged.map((entry) => `${entry.key} ${entry.etag}`).sort();
  if (existing && before.length === after.length && before.every((value, i) => value === after[i])) return false;
  if (!existing && merged.length === 0) return false;

  const next: EditorialProjection = {
    schema_version: EDITORIAL_PROJECTION_SCHEMA_VERSION,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: new Date().toISOString(),
    entries: merged,
  };
  try {
    await store.setJSON(EDITORIAL_PROJECTION_KEY, editorialProjectionSchema.parse(next));
    return true;
  } catch (error) {
    console.warn('editorial-projection: could not persist projections/editorial-assets.v1.json.', error);
    return false;
  }
};
