/**
 * M1 — `snapshots/release.json`, the ONE place release state is written, and
 * the one blob the admin reads to render it.
 *
 * ## What it replaces
 *
 * `release-overview.ts` used to COMPUTE the publication-state overview on every
 * page view: an inventory sweep, two Netlify deploys-API calls, and one GitHub
 * `/compare` per distinct `publish_commit` in a single unbounded `Promise.all`.
 * Measured cold at 14-16 s. Its 10 s in-memory memo protected nobody — Netlify
 * runs many instances and `cold=1` showed on three of four calls — so the
 * external work ran again and again on the page path.
 *
 * The wave thesis is write-time and schedule-time materialisation. This module
 * is M1's half of it: the expensive, EXTERNALLY-SOURCED half of the overview —
 * which commit production actually serves, which deploy is latest, and which
 * export commits are already included in the live build — is gathered off the
 * page path and stored in one blob per tenant, stamped `as_of`.
 *
 * ## The boundary: what is in the blob, and what is re-derived per read
 *
 * This is the decision the rest of the module follows from, so it is stated
 * once, here.
 *
 *   - **Deploy facts are STORED.** They come from two Netlify API calls and K
 *     GitHub `/compare` calls. Nothing in the object store can produce them and
 *     no page view should ever pay for them.
 *   - **`deploy.state` is DERIVED, not stored.** `getEditorialDeployStatus`
 *     turns a queued build older than fifteen minutes into `stalled`; freezing
 *     that into the blob would make a stalled deploy look queued forever. The
 *     receipts are the facts, the status is a reading of them at a moment.
 *   - **Per-object release state is stored AND re-derived, at two different
 *     freshness levels, by one function** (`deriveReleaseObjects`). The blob's
 *     copy is the cheap answer for a caller that can live with `as_of` — one
 *     blob read, no inventory at all. `loadReleaseOverview`, which backs
 *     `admin-release-state` and `admin-editorial-view`, re-derives it from the
 *     TRUSTED inventory instead, because those two endpoints drive publish and
 *     approval affordances: `review_state`, `approval_state` and
 *     `requires_approval` change on patches, review decisions and policy edits
 *     — none of which write this snapshot — and an editor who approves an
 *     object must not be shown their own decision two minutes late. Same
 *     derivation, same deploy facts, two ages; they cannot disagree about
 *     anything except time.
 *
 * M2.1b took the second of those two readings and did NOT take the blob's own
 * `objects`: `admin-shell` joins `releaseDeployFacts(snapshot)` to the
 * inventory rows its own `inventory` section already read, so its release
 * section costs ONE blob read and still answers from live object state. What
 * it does not do is REPAIR — see `admin-shell.ts`, "Why the boot never
 * rebuilds".
 *
 * ## Where the read half lives
 *
 * M2.1b split this file in two. `release/snapshot-view.ts` holds the schema,
 * the derivations, `readReleaseSnapshot` and the freshness predicate; this
 * file keeps the writer and the builder, and re-exports the view whole so
 * every caller keeps its single import. The split is a cold-start cut, not a
 * tidiness one: `buildReleaseSnapshot` is what reaches `netlify-deploys.ts`
 * and `production-release.ts`, and `admin-shell` reads this blob on every
 * `/admin/*` navigation without ever being able to call it.
 *
 * ## Who writes it
 *
 * Every write goes through `writeReleaseSnapshot` in this file, exactly as
 * every site-objects record write goes through `objects/record-writer.ts`, and
 * `tests/netlify/object-inventory-index.test.ts`'s writer-pinning scan fails
 * the build on a `.setJSON` against `RELEASE_SNAPSHOT_KEY` anywhere else.
 * Three callers:
 *
 *   1. `object-publish.ts`, after the publish stamp lands — `carryDeploy`, so
 *      it costs the trusted inventory plus one write and makes NO external
 *      call. A publish changes which objects are `published`; it cannot change
 *      which deploy is live (the export commits dark, behind `[skip netlify]`).
 *   2. `release_to_production` (`mcp-tool-handlers.ts` and
 *      `functions/admin-release.ts`), after the build hook has fired — a full
 *      refresh under a tight budget, so the dashboard shows `queued`/`building`
 *      at once instead of waiting for the next scheduled pass.
 *   3. `functions/release-snapshot-refresh.ts`, every two minutes — the full
 *      refresh, and the reason this can be trusted at all: deploy state changes
 *      without us (a build finishes, Netlify publishes it, someone rolls back),
 *      and no write path in this repo observes that.
 *
 * ## Self-healing, not migration
 *
 * A missing, unparseable, wrong-schema or too-old blob is detected on READ and
 * rebuilt by the same `buildReleaseSnapshot` the schedule runs
 * (`loadReleaseOverview`'s repair path). No per-tenant script; the first admin
 * page view on a cold tenant pays one full build, once, and says so in
 * `stats.rebuilt`.
 */
import { mapWithConcurrency } from '../blob-list.js';
import {
  compareInventoryRows,
  matchesInventoryFilters,
  type InventoryRow,
} from '../object-inventory.js';
import { readInventoryRows } from '../objects/index-store.js';
import {
  fetchRecentDeploys,
  getPublishedProductionDeploy,
  isNetlifyDeployLookupConfigured,
  type DeployReceipt,
} from '../netlify-deploys.js';
import { isCommitAncestorOrEqual } from '../production-release.js';
import type { SiteBindingEnvNames } from '../site-binding.js';
import type { EditorialDeployState } from '../../../lib/admin/editorial-state.js';
import { objectTypes } from '../../../schema/object-record-v1.js';
import {
  deriveReleaseObjects,
  readReleaseSnapshot,
  releaseCounts,
  releaseSnapshotSchema,
  RELEASE_SNAPSHOT_KEY,
  RELEASE_SNAPSHOT_SCHEMA_VERSION,
  type ReleaseDeployReceiptView,
  type ReleaseSnapshot,
  type ReleaseSnapshotSource,
  type ReleaseSnapshotStore,
} from './snapshot-view.js';

/**
 * M2.1b: the read half moved to the leaf `snapshot-view.ts` so `admin-shell`
 * can read this blob on every navigation without dragging the deploys API and
 * the GitHub compare client into its cold start. Re-exported whole — every
 * existing caller keeps its one import of this file, and the two spellings
 * mean the same thing. See that file's header for which one is on the diet.
 */
export * from './snapshot-view.js';

/**
 * The GitHub ancestry fan-out's two bounds.
 *
 * Concurrency 4 (`mapWithConcurrency`, which already backs the store sweeps)
 * replaces the unbounded `Promise.all` the page path used to issue: a site with
 * ninety distinct publish commits fired ninety simultaneous GitHub calls, which
 * is both a rate-limit incident and a way to lose the whole overview to one
 * slow response. The wall-clock budget is the other half — with a bound on
 * concurrency, K commits take K/4 round trips, which for a large enough K
 * outlives the function no matter how well-behaved each call is. When the
 * budget runs out the build stops asking, reports `ancestry_truncated`, and
 * ships what it has: `included_commits` is a LOWER BOUND, so the worst outcome
 * is an object showing `published` when it is in fact already `live` — the
 * conservative direction, and the next pass (two minutes later, with
 * `isCommitAncestorOrEqual`'s permanent memo warm on this instance) finishes
 * the job.
 */
export const RELEASE_ANCESTRY_CONCURRENCY = 4;
/** Scheduled pass: generous, it is alone in a fifteen-minute window. */
export const RELEASE_ANCESTRY_BUDGET_MS = 8_000;
/** A read-path repair or a post-release refresh: inside someone's request. */
export const RELEASE_ANCESTRY_INTERACTIVE_BUDGET_MS = 3_000;

// ═══ deploy receipts, as the blob carries them ════════════════════════════
//
// The rest of the derivation — `releaseDeployFacts`, `releaseDeployView`,
// `deriveReleaseObjects`, `releaseCounts` — is in `snapshot-view.ts` and
// re-exported above. Only this one stays, because only the builder has a
// `DeployReceipt` to narrow.

const safeDeploy = (receipt: DeployReceipt | undefined | null): ReleaseDeployReceiptView | null =>
  receipt
    ? {
        id: receipt.deployId,
        commit: receipt.commit,
        status: receipt.deployStatus,
        started_at: receipt.startedAt,
        finished_at: receipt.finishedAt,
        production_url: receipt.productionUrl,
      }
    : null;

// ═══ the write — the choke point ══════════════════════════════════════════

/**
 * THE writer. Unconditional (no compare-and-swap) on purpose, and that is a
 * deliberate difference from `objects/index.json`.
 *
 * The index is a PROJECTION OF RECORDS that is amended entry by entry: a writer
 * that read it before another writer committed would silently drop that
 * writer's entry, so the amendment has to be compare-and-swapped. This blob is
 * not amended — every write is a complete re-derivation from the store and the
 * Netlify/GitHub APIs as they stand at `as_of`. Two writers racing here both
 * write a whole, internally consistent snapshot; the loser's only cost is that
 * its facts were overwritten by facts gathered at a similar moment. A CAS would
 * buy nothing and would leave the loser with nothing written at all.
 *
 * Never throws: a snapshot write that failed costs the next read a rebuild, and
 * it must never fail the publish or the release that noticed.
 */
export const writeReleaseSnapshot = async (
  store: ReleaseSnapshotStore,
  snapshot: ReleaseSnapshot
): Promise<boolean> => {
  try {
    await store.setJSON(RELEASE_SNAPSHOT_KEY, releaseSnapshotSchema.parse(snapshot));
    return true;
  } catch (error) {
    console.warn('release: could not persist snapshots/release.json; the next read will rebuild.', error);
    return false;
  }
};

// ═══ the build ════════════════════════════════════════════════════════════

/** The inventory the overview is derived from: active rows, canonical order. Trusted read — 2 blob reads, no listing. */
export const readReleaseRows = async (store: ReleaseSnapshotStore, nowMs: number): Promise<InventoryRow[]> => {
  const sweep = await readInventoryRows(store, { nowMs });
  return sweep.rows
    .filter((row) => matchesInventoryFilters(row, { status: 'active' }))
    .sort(compareInventoryRows(objectTypes));
};

/**
 * Which of `commits` are already inside `publishedCommit`, under a concurrency
 * cap and a wall clock. `known` short-circuits a commit an earlier snapshot
 * already proved included — valid only while `publishedCommit` has not moved,
 * which the caller checks.
 */
const resolveIncludedCommits = async (
  commits: readonly string[],
  publishedCommit: string | undefined,
  options: {
    nowMs: number;
    budgetMs: number;
    concurrency: number;
    known?: ReadonlySet<string>;
    envNames?: SiteBindingEnvNames;
    fetchImpl?: typeof fetch;
  }
): Promise<{ included: string[]; truncated: boolean }> => {
  if (!publishedCommit) return { included: [], truncated: false };
  const deadline = options.nowMs + options.budgetMs;
  let truncated = false;

  const answers = await mapWithConcurrency(commits, options.concurrency, async (commit) => {
    if (commit === publishedCommit) return commit;
    if (options.known?.has(commit)) return commit;
    if (Date.now() >= deadline) {
      truncated = true;
      return undefined;
    }
    const ancestor = await isCommitAncestorOrEqual(commit, publishedCommit, options.fetchImpl, options.envNames);
    // `undefined` is "could not verify" (GitHub unconfigured, non-2xx, network
    // error) — never "not included". Reporting it as truncation is what keeps
    // the lower-bound promise honest.
    if (ancestor === undefined) truncated = true;
    return ancestor ? commit : undefined;
  });

  return { included: answers.filter((commit): commit is string => Boolean(commit)), truncated };
};

export type BuildReleaseSnapshotOptions = {
  nowMs: number;
  source: ReleaseSnapshotSource;
  envNames?: SiteBindingEnvNames;
  fetchImpl?: typeof fetch;
  /** Ancestry wall clock. Defaults to the scheduled budget. */
  budgetMs?: number;
  concurrency?: number;
  /**
   * Skip the Netlify deploy lookup and the GitHub fan-out entirely and reuse
   * `previous`'s deploy facts. This is the WRITE-PATH mode: an object publish
   * commits its export dark (`[skip netlify]`), so it changes which objects are
   * published and cannot change which deploy is live. Without a `previous` it
   * degrades to an unconfigured deploy header rather than making a call.
   */
  carryDeploy?: boolean;
  previous?: ReleaseSnapshot | undefined;
  /** Injected by the callers that already hold the rows; saves the inventory read. */
  rows?: readonly InventoryRow[];
};

/**
 * Gather everything and return the snapshot. Does not write — `refreshReleaseSnapshot` does.
 */
export const buildReleaseSnapshot = async (
  store: ReleaseSnapshotStore,
  options: BuildReleaseSnapshotOptions
): Promise<ReleaseSnapshot> => {
  const nowMs = options.nowMs;
  const rows = options.rows ?? (await readReleaseRows(store, nowMs));
  const commits = [...new Set(rows.map((row) => row.publish_commit).filter((value): value is string => Boolean(value)))];
  const previous = options.previous;

  let configured: boolean;
  let publishedDeploy: DeployReceipt | undefined;
  let latestProduction: DeployReceipt | undefined;
  let publishedCommit: string | undefined;
  let included: string[];
  let truncated: boolean;

  if (options.carryDeploy) {
    // No network. Everything about the deploy comes from the previous snapshot;
    // the only thing recomputed is which of the CURRENT rows' commits are
    // inside the live commit we already know about.
    configured = previous?.deploy.configured ?? false;
    publishedCommit = previous?.deploy.live_commit ?? undefined;
    const known = new Set(previous?.deploy.included_commits ?? []);
    included = commits.filter((commit) => commit === publishedCommit || known.has(commit));
    truncated = previous?.deploy.ancestry_truncated ?? false;
    return {
      schema_version: RELEASE_SNAPSHOT_SCHEMA_VERSION,
      as_of: new Date(nowMs).toISOString(),
      source: options.source,
      deploy: {
        configured,
        production_confirmed: previous?.deploy.production_confirmed ?? false,
        live_commit: previous?.deploy.live_commit ?? null,
        latest: previous?.deploy.latest ?? null,
        published: previous?.deploy.published ?? null,
        included_commits: included,
        ancestry_truncated: truncated,
      },
      ...objectsAndCounts(rows, {
        production_confirmed: previous?.deploy.production_confirmed ?? false,
        ...(publishedCommit ? { live_commit: publishedCommit } : {}),
        included_commits: included,
      }),
    };
  }

  configured = isNetlifyDeployLookupConfigured(options.envNames);
  if (configured) {
    const [published, recent] = await Promise.all([
      getPublishedProductionDeploy(options.envNames),
      fetchRecentDeploys(options.envNames),
    ]);
    publishedDeploy = published;
    latestProduction = recent.find((deploy) => !deploy.context || deploy.context === 'production');
  }
  publishedCommit = publishedDeploy?.commit || undefined;

  const carryForward =
    previous && previous.deploy.live_commit && previous.deploy.live_commit === publishedCommit
      ? new Set(previous.deploy.included_commits)
      : undefined;

  const ancestry = await resolveIncludedCommits(commits, publishedCommit, {
    nowMs,
    budgetMs: options.budgetMs ?? RELEASE_ANCESTRY_BUDGET_MS,
    concurrency: options.concurrency ?? RELEASE_ANCESTRY_CONCURRENCY,
    ...(carryForward ? { known: carryForward } : {}),
    ...(options.envNames ? { envNames: options.envNames } : {}),
    ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
  });
  included = ancestry.included;
  truncated = ancestry.truncated;

  const deployFacts: EditorialDeployState = {
    production_confirmed: Boolean(publishedCommit),
    ...(publishedCommit ? { live_commit: publishedCommit } : {}),
    included_commits: included,
  };

  return {
    schema_version: RELEASE_SNAPSHOT_SCHEMA_VERSION,
    as_of: new Date(nowMs).toISOString(),
    source: options.source,
    deploy: {
      configured,
      production_confirmed: Boolean(publishedCommit),
      live_commit: publishedCommit ?? null,
      latest: safeDeploy(latestProduction),
      published: safeDeploy(publishedDeploy),
      included_commits: included,
      ancestry_truncated: truncated,
    },
    ...objectsAndCounts(rows, deployFacts),
  };
};

const objectsAndCounts = (rows: readonly InventoryRow[], deploy: EditorialDeployState) => {
  const objects = deriveReleaseObjects(rows, deploy);
  return { objects, ...releaseCounts(objects) };
};

/**
 * Build and write, reading the previous snapshot first so a carry-forward has
 * something to carry. Returns the snapshot it wrote (or built, if the write
 * failed) so the caller can use it without a second read.
 */
export const refreshReleaseSnapshot = async (
  store: ReleaseSnapshotStore,
  options: Omit<BuildReleaseSnapshotOptions, 'previous'> & { previous?: ReleaseSnapshot | undefined }
): Promise<{ snapshot: ReleaseSnapshot; written: boolean }> => {
  const previous = options.previous ?? (await readReleaseSnapshot(store));
  const snapshot = await buildReleaseSnapshot(store, { ...options, previous });
  const written = await writeReleaseSnapshot(store, snapshot);
  return { snapshot, written };
};

/**
 * The write-path spelling, for `object_publish` and `release_to_production`.
 *
 * Best-effort in the strongest sense: the write it follows is already durable,
 * and nothing here may fail it or delay it materially. A throw is swallowed and
 * logged, because the worst case is a snapshot that is up to two minutes old —
 * which is the state the schedule guarantees anyway.
 */
export const refreshReleaseSnapshotAfterWrite = async (
  store: ReleaseSnapshotStore,
  options: Omit<BuildReleaseSnapshotOptions, 'previous'>
): Promise<void> => {
  try {
    await refreshReleaseSnapshot(store, options);
  } catch (error) {
    console.warn('release: post-write snapshot refresh failed; the schedule will repair it.', error);
  }
};
