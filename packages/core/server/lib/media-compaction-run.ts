/**
 * Media compaction (W4) — the artifact plane's housekeeping pass, run by EVERY
 * tenant on its own stores.
 *
 * This is the WORK. It is invoked by `functions/media-compaction-sweep-background.ts`,
 * which the daily scheduled tick (`functions/media-compaction-sweep.ts`) dispatches —
 * see that dispatcher's header for why a scheduled function cannot do this itself.
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
import type { SiteBinding } from './site-binding.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  getSiteObjectsBlobStore,
} from './blob-store.js';
import type { ArtifactIndexStore } from './artifact-index.js';
import type { ArtifactByteStore } from './artifact-soft-delete.js';
import {
  collectSweepReferences,
  dedupeArtifactsBySha,
  sweepOrphanArtifacts,
  type ArtifactSweepListStore,
  type DanglingReference,
} from './artifact-dedupe-sweep.js';
import { listArtifactIndexKeys } from './artifact-index.js';
import {
  readMediaCompactionHeartbeat,
  writeMediaCompactionHeartbeat,
  type MediaCompactionResume,
} from './media-compaction-heartbeat.js';

/** A reference younger than this is never an orphan — see GRACE WINDOW above. */
export const ORPHAN_GRACE_MS = 24 * 60 * 60 * 1000;

/** Who a scheduled soft-delete is attributed to in the reference's `deletedBy`. */
export const COMPACTION_ACTOR = 'media-compaction-sweep';

/** Page size per library call, and the hard stop that keeps a run finite. */
const PAGE_LIMIT = 100;
const MAX_PAGES = 500;

/**
 * How long a run may spend paging before it checkpoints and stops.
 *
 * Netlify kills a SCHEDULED function at 30 s (background functions are the
 * 15-minute door, and a function cannot be both). A run that hits that wall is
 * killed mid-page: nothing is reported, and — because the old code recomputed
 * the whole reference set on EVERY page — a large tenant could burn the entire
 * budget without ever reaching the dedupe pass, which is exactly the shape of
 * "the store is untouched and the log is empty". So the run watches the clock
 * itself, writes its cursors, and finishes the cycle on the next invocation.
 */
export const SWEEP_BUDGET_MS = 20_000;

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
  /** True when the clock, not the store, ended the run — the rest resumes next run. */
  stopped_early: boolean;
  /** Where this run started paging (non-zero when it resumed a stopped cycle). */
  resumed_from: MediaCompactionResume;
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
  binding?: SiteBinding,
  options: { budgetMs?: number; remainingMs?: () => number } = {}
): Promise<MediaCompactionSweepResult> => {
  const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
  const objectsStore = (await getSiteObjectsBlobStore(event, binding)) as unknown as ArtifactSweepListStore;
  const artifactStore = (await getArtifactBlobStore(event, binding)) as unknown as ArtifactByteStore;

  const startedMs = Date.now();
  const budgetMs = options.budgetMs ?? SWEEP_BUDGET_MS;
  // Stop on whichever comes first: our own budget, or 5 s before the platform
  // would kill us (the platform kill leaves no receipt and no log line).
  const outOfTime = () => {
    if (Date.now() - startedMs >= budgetMs) return true;
    const remaining = options.remainingMs?.();
    return typeof remaining === 'number' && remaining < 5_000;
  };

  // Resume a cycle a previous run checkpointed; a finished cycle starts over.
  const prior = await readMediaCompactionHeartbeat(indexStore);
  const priorCycleDone = !prior || (prior.resume.orphanCursor === null && prior.resume.dedupeCursor === null);
  const resumedFrom: MediaCompactionResume = priorCycleDone
    ? { orphanCursor: 0, dedupeCursor: 0 }
    : prior.resume;

  await writeMediaCompactionHeartbeat(indexStore, {
    schema: 'media_compaction_heartbeat.v1',
    startedAtISO: now,
    finishedAtISO: null,
    ok: null,
    error: null,
    resume: resumedFrom,
    totals: prior?.totals ?? null,
  });

  // ONCE PER RUN, not once per page: both of these walk the whole store and
  // neither depends on which page is being swept.
  const references = await collectSweepReferences(indexStore, objectsStore);
  const referenceKeys = await listArtifactIndexKeys(indexStore, 'request-artifacts/');

  let orphansSoftDeleted = 0;
  let skippedRecent = 0;
  let scanned = 0;
  const dangling: DanglingReference[] = [];

  let stoppedEarly = false;

  // 1. Orphan sweep — apply, with the grace window.
  let cursor: number | null = resumedFrom.orphanCursor;
  for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
    const result = await sweepOrphanArtifacts(indexStore, objectsStore, {
      dryRun: false,
      minAgeMs: ORPHAN_GRACE_MS,
      now,
      deletedBy: COMPACTION_ACTOR,
      limit: PAGE_LIMIT,
      cursor,
      references,
      referenceKeys,
    });

    orphansSoftDeleted += result.softDeleted;
    skippedRecent += result.skippedRecent.length;
    scanned += result.scanned;
    dangling.push(...result.dangling);

    cursor = result.checkpoint.nextCursor === null ? null : Number(result.checkpoint.nextCursor);
    if (result.scanned === 0) cursor = null;
    if (cursor !== null && outOfTime()) {
      stoppedEarly = true;
      break;
    }
  }
  const orphanResume = cursor;

  // 2. By-sha dedupe — apply, on the post-sweep set of LIVE references only.
  let dedupeGroups = 0;
  let blobsDeleted = 0;
  let bytesFreed = 0;

  // Only once the orphan pass has finished its cycle: dedupe must see the
  // post-sweep set, so a half-swept index is not a set it may act on.
  cursor = orphanResume === null && !stoppedEarly ? resumedFrom.dedupeCursor : null;
  const dedupeStarted = cursor;
  for (let page = 0; cursor !== null && page < MAX_PAGES; page += 1) {
    const result = await dedupeArtifactsBySha(indexStore, artifactStore, {
      dryRun: false,
      limit: PAGE_LIMIT,
      cursor,
      referenceKeys,
    });

    dedupeGroups += result.details.filter((group) => !group.skippedReason).length;
    blobsDeleted += result.blobsDeleted;
    bytesFreed += result.bytesFreed;

    cursor = result.checkpoint.nextCursor === null ? null : Number(result.checkpoint.nextCursor);
    if (result.scanned === 0) cursor = null;
    if (cursor !== null && outOfTime()) {
      stoppedEarly = true;
      break;
    }
  }
  const dedupeResume = dedupeStarted === null && orphanResume !== null ? resumedFrom.dedupeCursor : cursor;

  const result: MediaCompactionSweepResult = {
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
    stopped_early: stoppedEarly,
    resumed_from: resumedFrom,
  };

  await writeMediaCompactionHeartbeat(indexStore, {
    schema: 'media_compaction_heartbeat.v1',
    startedAtISO: now,
    finishedAtISO: new Date().toISOString(),
    ok: true,
    error: null,
    resume: { orphanCursor: orphanResume, dedupeCursor: dedupeResume },
    totals: { ...result },
  });

  return result;
};
