/**
 * The publication-state overview, served by `admin-release-state` and
 * `admin-editorial-view`.
 *
 * ## What this file used to be, and why it is not that any more
 *
 * It COMPUTED the overview on every page view: an inventory sweep, two Netlify
 * deploys-API calls, and one GitHub `/compare` per distinct `publish_commit` in
 * one unbounded `Promise.all`. Measured cold: 14-16 s. It carried a 10 s
 * in-memory memo to make `admin-release-state` and `admin-editorial-view` share
 * one computation per page load — and that memo protected nobody. Netlify runs
 * many function instances; `cold=1` showed on three of four calls of a
 * rarely-hit function, so in practice each endpoint paid the full cost, every
 * time, and the two "shared" the memo only in the sandbox.
 *
 * M1 moved the expensive half off the page path into `snapshots/release.json`
 * (`release/snapshot-store.ts`), written by `object_publish`, by
 * `release_to_production`, and by the `release-snapshot-refresh` scheduled
 * function every two minutes. The memo is GONE — not shortened, gone. A
 * per-instance cache of a value that is now one blob read away buys nothing and
 * costs an unexplainable staleness window on top of the one `as_of` already
 * states honestly.
 *
 * ## What a warm read costs now
 *
 * Three blob reads, issued in parallel, and nothing else:
 *
 *   1. `snapshots/release.json` — the deploy facts;
 *   2. `objects/index.json`  ┐ M0.2's trusted inventory: two reads, no
 *   3. `objects/version`     ┘ `list()`, no record `get()`.
 *
 * Zero external API calls. Zero listings. `sec.snapshot` and `sec.inventory`
 * on the `Server-Timing` header say which of the three cost what.
 *
 * Reads 2 and 3 are not optional and the snapshot cannot replace them. The
 * endpoints above drive publish and approval AFFORDANCES: `review_state`,
 * `approval_state`, `requires_approval` and the lock state change on patches,
 * review decisions, checkouts and policy edits, none of which write the
 * snapshot. Serving those from a blob written only by publish and release would
 * show an editor their own approval up to two minutes late — the exact defect
 * `invalidateReleaseOverview` exists to prevent. So the DEPLOY facts come from
 * the snapshot and the OBJECT facts come from the trusted index, and
 * `deriveReleaseObjects` joins them. A caller that can live with `as_of` and
 * wants literally one blob read calls `readReleaseSnapshot` instead. M2.1b
 * took exactly that route for `admin-shell`'s `release` section, with one
 * refinement this file cannot make: the boot has ALREADY read the trusted
 * inventory for its own `inventory` section, so it re-derives from those rows
 * rather than from the snapshot's stored `objects`, and pays one blob read in
 * total. See `functions/admin-shell.ts`.
 *
 * ## The repair
 *
 * Missing, unparseable, wrong-schema or older than
 * `RELEASE_SNAPSHOT_MAX_AGE_MS`: the read rebuilds the snapshot in place with
 * the same `buildReleaseSnapshot` the schedule runs, under the interactive
 * ancestry budget, and writes it. That is the old compute path, kept, and it is
 * the only thing on this file's path that can make an external call. Self-
 * healing, no migration script — the idiom `objects/index-store.ts` already
 * uses for a version bump.
 *
 * It stays HERE and not on the boot path, deliberately. `admin-release-state`
 * and `admin-editorial-view` are two surfaces someone navigates TO;
 * `admin-shell` runs on every `/admin/*` click, and a repair there would turn
 * a `release-snapshot-refresh` outage into a multi-second compute on every
 * navigation. So the boot serves a stale snapshot labelled with its `as_of`,
 * answers `skipped` when there is none, and the client's fallback to this
 * endpoint IS the repair — once, on the surface that wants the data.
 */
import { getSiteObjectsBlobStore } from './blob-store.js';
import type { InventoryRow } from './object-inventory.js';
import type { SiteBinding } from './site-binding.js';
import { timeSection } from './server-timing.js';
import {
  buildReleaseSnapshot,
  deriveReleaseObjects,
  isReleaseSnapshotFresh,
  readReleaseRows,
  readReleaseSnapshot,
  releaseCounts,
  releaseDeployFacts,
  releaseDeployView,
  writeReleaseSnapshot,
  RELEASE_ANCESTRY_INTERACTIVE_BUDGET_MS,
  type ReleaseDeployView,
  type ReleaseObjectView,
  type ReleaseSnapshot,
  type ReleaseSnapshotStore,
} from './release/snapshot-store.js';

export type { ReleaseDeployView, ReleaseObjectView };

export type ReleaseOverview = {
  /** The full inventory the overview was derived from — reused by callers that need the rows themselves. */
  rows: InventoryRow[];
  deploy: ReleaseDeployView;
  objects: ReleaseObjectView[];
  waiting_count: number;
  pending_approval_count: number;
  /** When the DEPLOY facts were gathered. The object facts are live as of this request. */
  as_of: string;
  /** True when this request had to rebuild the snapshot (missing, corrupt, or stale). */
  rebuilt: boolean;
};

export class ReleaseOverviewUnavailableError extends Error {}

export type ReleaseOverviewCaller = {
  userId?: string | undefined;
  email: string;
  roles?: readonly string[] | undefined;
};

/**
 * Read the publication-state overview.
 *
 * `caller` is retained because both endpoints already resolve access and pass
 * it, and because a future role-filtered inventory would need it — nothing here
 * filters on it today, exactly as nothing did before (the `inventory` verb was
 * never role-filtered either).
 *
 * Throws `ReleaseOverviewUnavailableError` when the inventory itself cannot be
 * read — the caller decides the status code. A missing snapshot is NOT that
 * error: it is a rebuild.
 */
export const loadReleaseOverview = async (
  event: unknown,
  _caller: ReleaseOverviewCaller,
  binding?: SiteBinding
): Promise<ReleaseOverview> => {
  const nowMs = Date.now();
  const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ReleaseSnapshotStore;

  // THE reads. In parallel: neither answers a question the other asked.
  const [stored, rows] = await Promise.all([
    timeSection('snapshot', () => readReleaseSnapshot(store)),
    timeSection('inventory', async () => {
      try {
        return await readReleaseRows(store, nowMs);
      } catch (error) {
        throw new ReleaseOverviewUnavailableError(
          error instanceof Error ? error.message : 'Publication state could not be loaded.'
        );
      }
    }),
  ]);

  let snapshot: ReleaseSnapshot | undefined = stored && isReleaseSnapshotFresh(stored, nowMs) ? stored : undefined;
  const rebuilt = snapshot === undefined;
  if (!snapshot) {
    // The repair: the old compute path, bounded, writing what it found so the
    // next reader (and every other instance) is back to three blob reads.
    snapshot = await timeSection('snapshot_rebuild', () =>
      buildReleaseSnapshot(store, {
        nowMs,
        source: 'repair',
        rows,
        budgetMs: RELEASE_ANCESTRY_INTERACTIVE_BUDGET_MS,
        ...(binding?.env ? { envNames: binding.env } : {}),
        ...(stored ? { previous: stored } : {}),
      })
    );
    await writeReleaseSnapshot(store, snapshot);
  }

  // Deploy facts from the snapshot; object facts live from the trusted index.
  const objects = deriveReleaseObjects(rows, releaseDeployFacts(snapshot));

  return {
    rows,
    deploy: releaseDeployView(snapshot, nowMs),
    objects,
    ...releaseCounts(objects),
    as_of: snapshot.as_of,
    rebuilt,
  };
};
