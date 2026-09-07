/**
 * `objects/search-index.json` — the content-search projection.
 *
 * ## Why an index at all
 *
 * The requirement `content_search` was written against is explicit: "this
 * should use indexed lookup rather than enumerating every content_item;
 * enumeration should only occur as a fallback." Resolving a slug by reading
 * every article record is exactly the N+1 sweep the tool exists to spare
 * agents — doing it inside the tool instead of in the agent's loop would just
 * move the cost, not remove it.
 *
 * ## Why it is read-repaired rather than writer-maintained
 *
 * Same reasoning as `index-store.ts`, and deliberately the same mechanism:
 * object records are written from `object-verbs.ts` (several sites),
 * `object-publish.ts`, `object-retire.ts`, `object-purge.ts` and
 * `membership/offboarding.ts`. An index maintained by writers is only as
 * correct as the least careful writer, and a stale search row here means an
 * agent patches the WRONG ARTICLE — a worse failure than a stale row in an
 * admin list.
 *
 * So this index is verified, never trusted. `store.list()` already returns a
 * per-blob `etag` at no extra cost and the listing has to happen anyway; a
 * cached doc is reused only when the listing reports the same etag it was
 * projected from. Anything else — new key, changed etag, missing entry, or an
 * etag the store won't vouch for — falls through to reading that one record.
 * No writer needs to know this file exists.
 *
 * Steady state for the default two-type scope: `2 BL + 1 BR`, and zero record
 * reads. One article edited since the last search: `+1 BR +1 BW`. Cold, or on
 * a store whose listing carries no etags: exactly the naive enumeration, plus
 * one write — which is the "enumeration as fallback" the requirement asks for.
 *
 * ## W19
 *
 * One key, `objects/search-index.json`, holding a pure projection of records
 * this module just read. It never writes an object record, a request doc or a
 * request status, so it is not a second writer of anything the writer-
 * assignment law governs.
 */
import { z } from 'zod';

import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from '../blob-list.js';
import { projectSearchDoc } from '../../../lib/search/search-doc.js';
import type { SearchDoc } from '../../../lib/search/content-search.js';
import type { ObjectRecord, ObjectType } from '../../../schema/object-record-v1.js';

export const SEARCH_INDEX_SCHEMA_VERSION = 'content-search-index.v1';
export const SEARCH_INDEX_KEY = 'objects/search-index.json';

const searchEntrySchema = z.object({
  /** The record's blob key — the identity `store.list()` reports. */
  key: z.string(),
  /** The etag `list()` reported when `doc` was projected. Never trusted when empty. */
  etag: z.string(),
  /**
   * The projected `SearchDoc`, kept as a loose record on purpose: this is a
   * cache, and a future doc-shape change must degrade to a re-read, never to a
   * parse failure that breaks every lookup on the site.
   */
  doc: z.record(z.string(), z.unknown()),
});
export type SearchIndexEntry = z.infer<typeof searchEntrySchema>;

export const searchIndexSchema = z.object({
  schema_version: z.literal(SEARCH_INDEX_SCHEMA_VERSION),
  /** Monotonic write counter, bumped by every index write including repairs. */
  seq: z.number().int().nonnegative(),
  updated_at: z.string(),
  entries: z.array(searchEntrySchema),
});
export type SearchIndex = z.infer<typeof searchIndexSchema>;

/** The minimal store shape this module needs; `ObjectVerbStore` satisfies it. */
export interface SearchIndexStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<unknown>;
}

/** An etag is usable only when the store actually reported one (`local-blobs.ts` reports `''`). */
const usableEtag = (etag: string | undefined): etag is string => typeof etag === 'string' && etag.length > 0;

/** `undefined` when absent, unreadable, unparseable, or written by a different schema version — the caller then rebuilds. */
export const loadSearchIndex = async (store: SearchIndexStore): Promise<SearchIndex | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(SEARCH_INDEX_KEY);
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
  const result = searchIndexSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
};

/** A cached entry is usable only when the listing proves the blob has not changed since it was projected. */
const entryIsCurrent = (entry: SearchIndexEntry | undefined, item: BlobListItem): entry is SearchIndexEntry =>
  Boolean(entry) && usableEtag(item.etag) && usableEtag(entry?.etag) && entry?.etag === item.etag;

export type SearchSweepResult = {
  docs: SearchDoc[];
  /** Diagnostics, surfaced on the response so index drift is observable rather than silent. */
  stats: {
    /** Keys the listing returned. */
    listed: number;
    /** Docs served from the index without reading the record. */
    cached: number;
    /** Records that had to be read (new, changed, missing from the index, or unverifiable). */
    read: number;
    /** True when the index was (re)written this call. */
    wrote: boolean;
  };
};

/**
 * The sweep. Lists only the requested object types (two by default, not the
 * full thirteen — a content lookup has no business listing themes), serves
 * each key from the index when its etag still matches, and reads only the
 * rest. One unlistable type degrades to "0 docs from that type" rather than
 * failing the whole call, matching every other sweep in this codebase.
 *
 * `docs` come back UNSCORED and UNFILTERED — ranking belongs to the pure
 * module, which is where it can be tested without a store.
 */
export const sweepSearchDocs = async (
  store: SearchIndexStore,
  options: { objectTypes: readonly ObjectType[] }
): Promise<SearchSweepResult> => {
  const types = options.objectTypes;

  const perTypeItems = await Promise.all(
    types.map(async (objectType) => {
      // Await the list result BEFORE chaining: with `{paginate:true}` it can be
      // a plain AsyncIterable whose `.then()` throws synchronously, before a
      // `.catch()` could ever attach (the 2026-08-06 hotfix, same as inventory).
      try {
        const listResult = await store.list({
          prefix: `objects/${objectType}/by-id/`,
          directories: false,
          paginate: true,
        });
        return await collectBlobListItems(listResult as Parameters<typeof collectBlobListItems>[0]);
      } catch (error) {
        console.warn(`content_search: skipping unlistable object type "${objectType}".`, error);
        return [] as BlobListItem[];
      }
    })
  );
  const items = perTypeItems.flat();

  const index = await loadSearchIndex(store);
  const byKey = new Map<string, SearchIndexEntry>((index?.entries ?? []).map((entry) => [entry.key, entry]));

  const stale: BlobListItem[] = [];
  const docs: SearchDoc[] = [];
  const nextEntries: SearchIndexEntry[] = [];

  for (const item of items) {
    const entry = byKey.get(item.key);
    if (entryIsCurrent(entry, item)) {
      docs.push(entry.doc as unknown as SearchDoc);
      nextEntries.push(entry);
    } else {
      stale.push(item);
    }
  }

  const loaded = await mapWithConcurrency(stale, STORE_READ_CONCURRENCY, async (item) => {
    // An unreadable or unparseable key degrades that ONE doc, never the whole
    // response — the same contract every sweep in this store makes.
    try {
      const raw = await store.get(item.key);
      if (!raw) return undefined;
      return JSON.parse(raw) as ObjectRecord;
    } catch (error) {
      console.warn(`content_search: skipping unreadable object record at "${item.key}".`, error);
      return undefined;
    }
  });

  loaded.forEach((record, i) => {
    if (!record) return;
    const item = stale[i] as BlobListItem;
    let doc: SearchDoc;
    try {
      doc = projectSearchDoc(record);
    } catch (error) {
      console.warn(`content_search: skipping unprojectable object record at "${item.key}".`, error);
      return;
    }
    docs.push(doc);
    if (usableEtag(item.etag)) {
      nextEntries.push({ key: item.key, etag: item.etag, doc: doc as unknown as Record<string, unknown> });
    }
  });

  /**
   * A store whose listing carries no usable etags (the local file-backed shim
   * reports `etag: ''`) can project NOTHING. Writing then would truncate a good
   * index — written by a real deployment against the same bucket — down to
   * nothing, so the projection is simply not persisted and the sweep behaves
   * exactly as a plain enumeration would.
   */
  const projectedNothing = items.length > 0 && nextEntries.length === 0;
  const wrote = projectedNothing
    ? false
    : await writeIndexIfChanged(store, index, nextEntries, { listedKeys: new Set(items.map((item) => item.key)) });

  return {
    docs,
    stats: { listed: items.length, cached: items.length - stale.length, read: stale.length, wrote },
  };
};

/**
 * Persist the projection, but only when it would actually change — so a search
 * against an unedited library costs zero writes.
 *
 * Every sweep is partial by construction (it lists only the types this lookup
 * needed), so entries for keys OUTSIDE this sweep's listing are always kept.
 * Truncating them would make every search that names an object_type throw away
 * the rest of the site's index and pay a cold rebuild on the next default search.
 *
 * Concurrency: last write wins, which is safe because this is a regenerable
 * projection — a lost write costs the next reader one extra record read.
 */
const writeIndexIfChanged = async (
  store: SearchIndexStore,
  existing: SearchIndex | undefined,
  sweptEntries: readonly SearchIndexEntry[],
  scope: { listedKeys: Set<string> }
): Promise<boolean> => {
  const merged = [
    ...(existing?.entries ?? []).filter((entry) => !scope.listedKeys.has(entry.key)),
    ...sweptEntries,
  ];
  merged.sort((a, b) => a.key.localeCompare(b.key));

  const before = (existing?.entries ?? []).map((entry) => `${entry.key} ${entry.etag}`).sort();
  const after = merged.map((entry) => `${entry.key} ${entry.etag}`).sort();
  if (existing && before.length === after.length && before.every((value, i) => value === after[i])) return false;
  if (!existing && merged.length === 0) return false;

  const index: SearchIndex = {
    schema_version: SEARCH_INDEX_SCHEMA_VERSION,
    seq: (existing?.seq ?? 0) + 1,
    updated_at: new Date().toISOString(),
    entries: merged,
  };
  try {
    await store.setJSON(SEARCH_INDEX_KEY, searchIndexSchema.parse(index));
    return true;
  } catch (error) {
    // The index is a cache. Failing to persist it costs the next call a full
    // enumeration; it must never fail the call that noticed.
    console.warn('content_search: could not persist objects/search-index.json.', error);
    return false;
  }
};
