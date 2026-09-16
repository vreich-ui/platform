/**
 * M3.3 — the READ of `snapshots/visual-identity.json`, and the rebuild that
 * repairs it.
 *
 * `snapshot-doc.ts` owns the two documents and every write to them; this file
 * owns the only thing that LISTS. The split is a cold-start boundary, not a
 * tidiness one — see that file's header for which function pays for it.
 *
 * ## The cost
 *
 * Warm and trusted: `1 BR`, no listing, and the caller hands the entries
 * straight to the wire. Cold, superseded, or after any interrupted or lost
 * write: `4 BL + 2 BR + n BR + 1 BW` — the same four
 * listings and n record reads the seventeen `admin-object` calls used to make,
 * run once, on the server, and written back so the next read is two blobs
 * again. That rebuild IS the repair: there is no migration script, and a
 * tenant that has never seen this code self-heals on its first page view.
 *
 * ## The rebuild's write, and what it is safe against
 *
 * The rebuild's write is unconditional (`writeRebuiltDoc`) and it is the only
 * thing entitled to put a sticky alarm down, because it is the only thing that
 * re-derived every entry from the live listing. A choke-point write racing it
 * loses its compare-and-swap, re-arms, and costs one more rebuild.
 *
 * INTEGRATION (wave 2): this milestone shipped a second blob,
 * `snapshots/visual-identity.version`, to carry the alarm, and a rebuild that
 * stamped the seq it read BEFORE listing, so that a writer committing
 * underneath a slow rebuild left a detectable seq mismatch. Converging on
 * `snapshots/guarded-doc.ts` — one document, one read, the alarm inside it —
 * gives that up: there is no second seq left to disagree with. The race it
 * opens is the one `objects/index-store.ts` has carried since M0 and the one
 * chats and members carry too, so it is recorded once for all four as
 * `KNOWN_ISSUES.md` #74 rather than solved differently here. See
 * `snapshot-doc.ts`'s header for the full trade.
 *
 * ## SIZE — the one risk this design carries, measured
 *
 * This blob holds BODIES, not the fifteen scalars `objects/index.json` holds,
 * so the way it degrades is by getting fat, and a fat blob on a page path is
 * just a slower page. Measured against the committed exports of the fleet's
 * three largest tenants, with a realistic envelope per record and two
 * `visual_standard`s (a genesis house standard and a worked-on template with a
 * twelve-image mood board and eight rendered examples):
 *
 *   drlurie   13 records → 21.1 KB      (the 13 the seventeen calls fetched)
 *   platform  15 records → 23.7 KB
 *   zilberman 15 records → 23.3 KB
 *
 * At TEN TIMES that — a tenant with ~130 recipes — the blob is ~210-240 KB.
 * One read of 240 KB is still one round trip (the ~150-250 ms floor dominates;
 * the bytes add tens of milliseconds) and ~50 KB gzipped to the browser, so the
 * page path holds. What grows linearly and is worth watching is the WRITE: the
 * choke point rewrites the whole blob per edit of one of the four types, so a
 * template edit on a 10x tenant is a 240 KB write. That is still one write, on
 * a path a human triggers, against seventeen page-path round trips saved.
 *
 * The split to make when it does not hold — around 1 MB, i.e. ~50x, where the
 * browser payload stops being free — is per-type blobs read in parallel:
 * `snapshots/visual-identity/<type>.json` under ONE alarm, four reads issued
 * together, and a write that rewrites only its own type's blob. The entry
 * shape and the alarm below are unchanged by that split, which is why it is
 * stated here rather than built now.
 *
 * What makes those numbers what they are is the ledger drop
 * (`projectVisualIdentityEntry`): the same eleven drlurie records with a
 * forty-entry `history` each are 133 KB, against 21.6 KB without it, and that
 * 111 KB is a function of EDIT COUNT, not of content — it has no bound at all.
 * `stats.bytes` reports the live number on every read so this stays a number
 * somebody can watch rather than a page that quietly slows down.
 */
import {
  VISUAL_IDENTITY_OBJECT_TYPES,
  VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
  projectVisualIdentityEntry,
  readVisualIdentitySnapshotDoc,
  writeRebuiltVisualIdentitySnapshot,
  type VisualIdentitySnapshotDocStore,
  type VisualIdentitySnapshotEntry,
  type VisualIdentitySnapshotRead,
} from './snapshot-doc.js';
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY, type BlobListItem } from '../blob-list.js';
import type { ObjectRecord } from '../../../schema/object-record-v1.js';

/**
 * The document layer is re-exported wholesale so a caller that wants both
 * halves keeps one import — the `release/snapshot-store.ts` idiom. The two
 * spellings mean the same thing; only `snapshot-doc.js` is on the diet.
 */
export * from './snapshot-doc.js';

/** What the REBUILD needs on top of the document store: the listings that name the live key set. */
export interface VisualIdentitySnapshotStore extends VisualIdentitySnapshotDocStore {
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<unknown>;
}

export type VisualIdentitySnapshotStats = {
  /** True when the whole answer came from the one document and nothing was listed. */
  trusted: boolean;
  /** True when a stored snapshot was found and DISCARDED (unparseable, or a schema version this build no longer reads). */
  superseded: boolean;
  /** Keys the four listings returned. `0` on a trusted read, which lists nothing. */
  listed: number;
  /** Records read from the store. `0` on a trusted read. */
  read: number;
  /** True when the snapshot was (re)written this call. */
  wrote: boolean;
  /** The stored blob's size in bytes — the number the "does this still fit in one blob" question is answered with. */
  bytes: number;
};

export type VisualIdentitySnapshotResult = {
  entries: readonly VisualIdentitySnapshotEntry[];
  /** When the served facts were gathered. Stated on the wire; never guessed. */
  as_of: string;
  stats: VisualIdentitySnapshotStats;
};

/** Every record of the four types, from the listings. An unlistable type degrades to zero rows, never to a failed read. */
const sweepVisualIdentityRecords = async (
  store: VisualIdentitySnapshotStore
): Promise<{ entries: VisualIdentitySnapshotEntry[]; listed: number }> => {
  const perType = await Promise.all(
    VISUAL_IDENTITY_OBJECT_TYPES.map(async (objectType) => {
      try {
        const listResult = await store.list({
          prefix: `objects/${objectType}/by-id/`,
          directories: false,
          paginate: true,
        });
        return await collectBlobListItems(listResult as Parameters<typeof collectBlobListItems>[0]);
      } catch (error) {
        console.warn(`visual-identity: skipping unlistable object type "${objectType}".`, error);
        return [] as BlobListItem[];
      }
    })
  );
  const items = perType.flat();

  const loaded = await mapWithConcurrency(items, STORE_READ_CONCURRENCY, async (item) => {
    // An unreadable or unparseable key degrades that ONE entry, never the
    // whole snapshot — the same contract the inventory sweep keeps.
    try {
      const raw = await store.get(item.key);
      if (!raw) return undefined;
      return JSON.parse(raw) as ObjectRecord;
    } catch (error) {
      console.warn(`visual-identity: skipping unreadable object record at "${item.key}".`, error);
      return undefined;
    }
  });

  const entries: VisualIdentitySnapshotEntry[] = [];
  loaded.forEach((record, index) => {
    if (!record) return;
    const item = items[index] as BlobListItem;
    entries.push(projectVisualIdentityEntry(item.key, record));
  });
  entries.sort((a, b) => a.key.localeCompare(b.key));
  return { entries, listed: items.length };
};

const sameEntries = (
  a: readonly VisualIdentitySnapshotEntry[],
  b: readonly VisualIdentitySnapshotEntry[]
): boolean => {
  if (a.length !== b.length) return false;
  return a.every((entry, index) => {
    const other = b[index] as VisualIdentitySnapshotEntry;
    return entry.key === other.key && JSON.stringify(entry.record) === JSON.stringify(other.record);
  });
};

/**
 * Re-derive the snapshot from records and write it back. The self-healing
 * repair: the same four listings and n reads the surface used to make itself,
 * run once here instead of seventeen times over the wire.
 */
export const rebuildVisualIdentitySnapshot = async (
  store: VisualIdentitySnapshotStore,
  options: { nowMs: number; preread?: VisualIdentitySnapshotRead }
): Promise<VisualIdentitySnapshotResult> => {
  const read = options.preread ?? (await readVisualIdentitySnapshotDoc(store));
  const { entries, listed } = await sweepVisualIdentityRecords(store);
  const asOf = new Date(options.nowMs).toISOString();

  /**
   * Nothing to write only when the stored document is already TRUSTED and
   * already says this. An armed document always gets the write, because
   * putting the sticky flag down is the whole point of a rebuild.
   */
  const alreadyCurrent = read.trusted && sameEntries(read.doc?.entries ?? [], entries);
  const wrote = alreadyCurrent ? false : await writeRebuiltVisualIdentitySnapshot(store, entries, options.nowMs);

  return {
    entries,
    as_of: alreadyCurrent ? (read.doc?.as_of ?? asOf) : asOf,
    stats: {
      trusted: false,
      superseded: read.superseded,
      listed,
      read: listed,
      wrote,
      bytes: wrote
        ? Buffer.byteLength(
            JSON.stringify({
              schema_version: VISUAL_IDENTITY_SNAPSHOT_SCHEMA_VERSION,
              seq: (read.doc?.seq ?? 0) + 1,
              as_of: asOf,
              source: 'rebuild',
              entries,
            })
          )
        : read.bytes,
    },
  };
};

/**
 * THE read. ONE blob read and no listing when the snapshot may be trusted;
 * otherwise the rebuild above, which repairs in place.
 *
 * `undefined` is never an answer: a caller that asked for the visual-identity
 * bodies gets them, and `stats` says what they cost.
 */
export const readVisualIdentitySnapshot = async (
  store: VisualIdentitySnapshotStore,
  options: { nowMs: number }
): Promise<VisualIdentitySnapshotResult> => {
  const read = await readVisualIdentitySnapshotDoc(store);
  if (read.trusted && read.doc) {
    return {
      entries: read.doc.entries,
      as_of: read.doc.as_of,
      stats: {
        trusted: true,
        superseded: false,
        listed: 0,
        read: 0,
        wrote: false,
        bytes: read.bytes,
      },
    };
  }
  return rebuildVisualIdentitySnapshot(store, { nowMs: options.nowMs, preread: read });
};
