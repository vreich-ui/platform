/**
 * Function name: Media_Compaction_Sweep (W4) — scheduled, daily.
 *
 * The artifact plane's housekeeping pass, run by EVERY tenant on its own stores.
 * Two libraries already did this work; until this function existed they were only
 * reachable as admin MCP verbs (`artifact_orphan_sweep`, `artifact_dedupe_by_sha`)
 * that nobody ever ran, so every site's artifact store grew forever and a
 * byte-duplicate stayed duplicated. Wolf, 2026-09-13: fix the MECHANISM, not the
 * tenant — compaction is a scheduled function the platform carries, and any dirty
 * store is simply the first one it cleans.
 *
 * Per run, on this site's own stores, in this order:
 *   1. `sweepOrphanArtifacts` (apply) — soft-delete every live reference no active
 *      object and no slot pointer cites. BYTES ARE KEPT: this is a soft delete and
 *      `restore_artifact` must stay possible. Dangling references (an object citing
 *      an artifact that is not there) are REPORTED, never repaired — same contract
 *      as the verb, because that report is evidence of a real defect.
 *   2. `dedupeArtifactsBySha` (apply) — collapse each group of live references that
 *      share a sha onto the OLDEST blob. `blobKey` is identity and is never
 *      rewritten, so no public `/img|/pdf` path moves; only `storageKey` (a
 *      read-side redirect) and the bytes behind it change.
 *   3. One structured JSON log line, which is the operator's whole interface here.
 *
 * Two safeguards, both load-bearing:
 *
 *   GRACE WINDOW — capture creates artifacts BEFORE it creates/patches the pages
 *   that cite them (`capture/emit.mjs` runs its artifact loop first), so a fresh
 *   upload is legitimately cited by nothing for a while. A reference younger than
 *   `ORPHAN_GRACE_MS` (24 h) is never treated as an orphan; it is counted as
 *   `skipped_recent` and looked at again tomorrow.
 *
 *   ORDER — dedupe runs AFTER the sweep, on the post-sweep set, and only ever sees
 *   LIVE references. So one artifact is never pushed in both directions in one run:
 *   anything the sweep just soft-deleted is invisible to the dedupe pass.
 *
 * Idempotent: a second run the same day finds no new orphans and reports every
 * remaining sha group `already-deduped`. Neither pass writes a governed object, so
 * nothing here can flip a page to `unpublished_changes`.
 *
 * Declared per site in netlify.toml (`[functions."media-compaction-sweep"]
 * schedule = "41 3 * * *"`, after membership-sweep at 17 3) — a scheduled function
 * only runs if its schedule is DECLARED (every `sites/<client>/netlify.toml`
 * carries the block; `admin-parity.mjs` checks it, `create-site.mjs` writes it into
 * every new tenant). No env vars and no per-tenant switch: a kill switch, if one is
 * ever wanted, belongs on the `site` object, not in Netlify env.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  getSiteObjectsBlobStore,
} from '../lib/blob-store.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import type { ArtifactByteStore } from '../lib/artifact-soft-delete.js';
import {
  dedupeArtifactsBySha,
  sweepOrphanArtifacts,
  type ArtifactSweepListStore,
  type DanglingReference,
} from '../lib/artifact-dedupe-sweep.js';

/** A reference younger than this is never an orphan — see GRACE WINDOW above. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Who a scheduled soft-delete is attributed to in the reference's `deletedBy`. */
export const COMPACTION_ACTOR = 'media-compaction-sweep';

/** Page size per library call, and the hard stop that keeps a run finite. */
const PAGE_LIMIT = 100;
const MAX_PAGES = 500;

export type MediaCompactionSweepResult = {
  ok: true;
  at: string;
  orphans_soft_deleted: number;
  dangling: number;
  dangling_keys: string[];
  dedupe_groups: number;
  blobs_deleted: number;
  bytes_freed: number;
  skipped_recent: number;
  scanned: number;
};

/**
 * Both libraries are cursor-paged and page over a SORTED key list, so a run walks
 * every page rather than compacting only the first 100 references. `MAX_PAGES` is a
 * stop, not a budget: a store big enough to hit it gets the rest tomorrow, and the
 * log line says so by reporting what this run actually scanned.
 */
export const runMediaCompactionSweep = async (
  event: unknown,
  now = new Date().toISOString(),
  binding?: SiteBinding
): Promise<MediaCompactionSweepResult> => {
  const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
  const objectsStore = (await getSiteObjectsBlobStore(event, binding)) as unknown as ArtifactSweepListStore;
  const artifactStore = (await getArtifactBlobStore(event, binding)) as unknown as ArtifactByteStore;

  let orphansSoftDeleted = 0;
  let skippedRecent = 0;
  let scanned = 0;
  const dangling: DanglingReference[] = [];

  // 1. Orphan sweep — apply, with the grace window.
  let cursor: number | null = 0;
  for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
    const result = await sweepOrphanArtifacts(indexStore, objectsStore, {
      dryRun: false,
      minAgeMs: ORPHAN_GRACE_MS,
      now,
      deletedBy: COMPACTION_ACTOR,
      limit: PAGE_LIMIT,
      cursor,
    });

    orphansSoftDeleted += result.softDeleted;
    skippedRecent += result.skippedRecent.length;
    scanned += result.scanned;
    dangling.push(...result.dangling);

    cursor = result.checkpoint.nextCursor === null ? null : Number(result.checkpoint.nextCursor);
    if (result.scanned === 0) break;
  }

  // 2. By-sha dedupe — apply, on the post-sweep set of LIVE references only.
  let dedupeGroups = 0;
  let blobsDeleted = 0;
  let bytesFreed = 0;

  cursor = 0;
  for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
    const result = await dedupeArtifactsBySha(indexStore, artifactStore, {
      dryRun: false,
      limit: PAGE_LIMIT,
      cursor,
    });

    dedupeGroups += result.details.filter((group) => !group.skippedReason).length;
    blobsDeleted += result.blobsDeleted;
    bytesFreed += result.bytesFreed;

    cursor = result.checkpoint.nextCursor === null ? null : Number(result.checkpoint.nextCursor);
    if (result.scanned === 0) break;
  }

  return {
    ok: true,
    at: now,
    orphans_soft_deleted: orphansSoftDeleted,
    dangling: dangling.length,
    dangling_keys: [...new Set(dangling.map((entry) => entry.blobKey))].sort(),
    dedupe_groups: dedupeGroups,
    blobs_deleted: blobsDeleted,
    bytes_freed: bytesFreed,
    skipped_recent: skippedRecent,
    scanned,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runMediaCompactionSweep(event, undefined, binding);
    console.log(
      JSON.stringify({ ts: result.at, event: 'media_compaction_sweep', site: binding.siteId, ...result })
    );
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Media compaction sweep failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
