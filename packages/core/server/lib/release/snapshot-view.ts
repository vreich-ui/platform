/**
 * M2.1b — the READ half of `snapshots/release.json`: its shape, the pure
 * derivations every release surface runs, and the one blob read that fetches
 * it. No writer, no Netlify API, no GitHub.
 *
 * ## Why this is a separate file from `snapshot-store.ts`
 *
 * Because `admin-shell` reads this blob on EVERY `/admin/*` navigation, and a
 * function's module graph is a cold-start latency number
 * (`tests/netlify/function-bundle-budget.test.ts`). `snapshot-store.ts` is the
 * WRITER: `buildReleaseSnapshot` is the thing that calls Netlify's deploys API
 * and GitHub's `/compare`, so that file statically reaches
 * `lib/netlify-deploys.ts`, `lib/production-release.ts` and `lib/blob-list.ts`
 * — 32 KB of first-party source that the boot path can never execute, because
 * the boot path never rebuilds (see `admin-shell.ts`, "Why the boot never
 * rebuilds"). This is the same leaf cut M0.1 made for `objects/index-doc.ts`
 * and M2.1 made for `object-lock-view.ts`: a reader imports the documents, not
 * the writer.
 *
 * `snapshot-store.ts` re-exports every name below, so no existing call site
 * changed and `release-overview.ts` / `object-publish.ts` /
 * `release-snapshot-refresh.ts` keep their single import. Both spellings
 * compile; only THIS one is on the diet. A server read path that wants the
 * snapshot imports `release/snapshot-view.js`.
 *
 * The decision this file encodes — which facts are STORED and which are
 * re-derived per read — is stated once, in `snapshot-store.ts`'s header, and
 * is not repeated here.
 */
import { z } from 'zod';

import type { InventoryRow } from '../object-inventory.js';
import type { ObjectIndexStore } from '../objects/index-store.js';
import {
  getEditorialDeployStatus,
  getEditorialObjectState,
  type EditorialDeployState,
  type EditorialObjectState,
} from '../../../lib/admin/editorial-state.js';

export const RELEASE_SNAPSHOT_KEY = 'snapshots/release.json';
export const RELEASE_SNAPSHOT_SCHEMA_VERSION = 'release-snapshot.v1';

/**
 * How old the blob may be before a read stops treating it as current.
 *
 * Two readers, two answers, and the bound is the same for both.
 * `loadReleaseOverview` REBUILDS past this age; `admin-shell`'s boot serves the
 * snapshot anyway and flags it `stale: true`, because a repair on a path that
 * runs on every navigation is the failure this wave exists to remove (see
 * `functions/admin-shell.ts`).
 *
 * The refresh runs every two minutes, so this is three missed passes. Chosen to
 * be forgiving rather than tight: the cost of being slightly stale is a deploy
 * badge that lags, the cost of being trigger-happy is that a scheduled function
 * outage turns every admin page view into a 14 s compute — the exact failure
 * this wave exists to remove. The bound is STATED on the wire (`as_of`) and in
 * the UI ("as of hh:mm"), so a lagging snapshot is visible rather than silent.
 */
export const RELEASE_SNAPSHOT_MAX_AGE_MS = 10 * 60_000;
// ═══ the wire/blob shapes ═════════════════════════════════════════════════

const deployViewSchema = z.object({
  id: z.string(),
  commit: z.string(),
  status: z.string(),
  started_at: z.string(),
  finished_at: z.string(),
  production_url: z.string(),
});
export type ReleaseDeployReceiptView = z.infer<typeof deployViewSchema>;

/** What `getEditorialObjectState` needs, and exactly the fields the release surfaces render. */
const releaseObjectSchema = z.object({
  object_id: z.string(),
  object_type: z.string(),
  display_name: z.string(),
  review_state: z.string(),
  approval_state: z.string(),
  requires_approval: z.boolean(),
  state: z.enum(['draft', 'approved', 'published', 'live']),
});

export type ReleaseObjectView = {
  object_id: string;
  object_type: string;
  display_name: string;
  review_state: InventoryRow['review_state'];
  approval_state: InventoryRow['approval_state'];
  requires_approval: boolean;
  state: EditorialObjectState;
};

export const releaseSnapshotSchema = z.object({
  schema_version: z.literal(RELEASE_SNAPSHOT_SCHEMA_VERSION),
  /** When the FACTS below were gathered. The whole point of the file: staleness is stated, never guessed. */
  as_of: z.string(),
  /** Which writer produced it. Diagnostic only — a store whose snapshot is only ever `publish` has a dead schedule. */
  source: z.enum(['schedule', 'release', 'publish', 'repair']),
  deploy: z.object({
    configured: z.boolean(),
    production_confirmed: z.boolean(),
    live_commit: z.string().nullable(),
    latest: deployViewSchema.nullable(),
    published: deployViewSchema.nullable(),
    /** Export commits proved to be included in `live_commit`. A LOWER BOUND — see the budget note. */
    included_commits: z.array(z.string()),
    /** True when the ancestry fan-out stopped early (budget, or an unverifiable answer). */
    ancestry_truncated: z.boolean(),
  }),
  objects: z.array(releaseObjectSchema),
  waiting_count: z.number().int().nonnegative(),
  pending_approval_count: z.number().int().nonnegative(),
});

export type ReleaseSnapshot = Omit<z.infer<typeof releaseSnapshotSchema>, 'objects'> & {
  objects: ReleaseObjectView[];
};

export type ReleaseSnapshotSource = ReleaseSnapshot['source'];

/** The store subset this module needs: the doc reads/writes plus the sweep's listings. */
export type ReleaseSnapshotStore = ObjectIndexStore;

// ═══ derivation — one function, used at both freshness levels ═════════════

/**
 * The deploy facts as `getEditorialObjectState` consumes them. Pure: no clock,
 * no network — everything here is already in the blob.
 */
export const releaseDeployFacts = (snapshot: ReleaseSnapshot): EditorialDeployState => ({
  production_confirmed: snapshot.deploy.production_confirmed,
  ...(snapshot.deploy.live_commit ? { live_commit: snapshot.deploy.live_commit } : {}),
  included_commits: snapshot.deploy.included_commits,
});

/** The deploy header as the wire carries it. `state` is read off the receipts AT `nowMs`, never stored. */
export const releaseDeployView = (snapshot: ReleaseSnapshot, nowMs: number) => ({
  configured: snapshot.deploy.configured,
  state: snapshot.deploy.configured
    ? getEditorialDeployStatus(
        snapshot.deploy.latest
          ? {
              commit: snapshot.deploy.latest.commit,
              deployStatus: snapshot.deploy.latest.status as 'queued' | 'building' | 'ready' | 'failed' | 'canceled' | 'timed_out',
              startedAt: snapshot.deploy.latest.started_at,
            }
          : undefined,
        snapshot.deploy.live_commit ?? undefined,
        nowMs
      )
    : ('unavailable' as const),
  production_confirmed: snapshot.deploy.production_confirmed,
  live_commit: snapshot.deploy.live_commit,
  latest: snapshot.deploy.latest,
  published: snapshot.deploy.published,
});

export type ReleaseDeployView = ReturnType<typeof releaseDeployView>;

/** The ONE place an inventory row becomes a release row. Pure. */
export const deriveReleaseObjects = (
  rows: readonly InventoryRow[],
  deploy: EditorialDeployState
): ReleaseObjectView[] =>
  rows.map((row) => ({
    object_id: row.object_id,
    object_type: row.object_type,
    display_name: row.display_name,
    review_state: row.review_state,
    approval_state: row.approval_state,
    requires_approval: row.requires_approval,
    state: getEditorialObjectState(row, deploy),
  }));

export const releaseCounts = (objects: readonly ReleaseObjectView[]) => ({
  waiting_count: objects.filter((object) => object.state === 'published').length,
  pending_approval_count: objects.filter((object) => object.review_state === 'open').length,
});
// ═══ the read ═════════════════════════════════════════════════════════════

/**
 * ONE blob read. `undefined` covers absent, unreadable, unparseable and
 * written-by-another-schema alike — every one of them means "rebuild", which is
 * the same answer `objects/index-doc.ts` gives for the projection docs.
 */
export const readReleaseSnapshot = async (store: ReleaseSnapshotStore): Promise<ReleaseSnapshot | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(RELEASE_SNAPSHOT_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = releaseSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data as ReleaseSnapshot) : undefined;
  } catch {
    return undefined;
  }
};

export const releaseSnapshotAgeMs = (snapshot: ReleaseSnapshot, nowMs: number): number => {
  const asOf = Date.parse(snapshot.as_of);
  return Number.isFinite(asOf) ? nowMs - asOf : Number.POSITIVE_INFINITY;
};

/** Fresh enough to serve without rebuilding. An unparseable `as_of` is never fresh. */
export const isReleaseSnapshotFresh = (snapshot: ReleaseSnapshot, nowMs: number): boolean =>
  releaseSnapshotAgeMs(snapshot, nowMs) <= RELEASE_SNAPSHOT_MAX_AGE_MS;
