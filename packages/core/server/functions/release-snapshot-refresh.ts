/**
 * Function name: Release_Snapshot_Refresh (M1) — scheduled, every two minutes.
 *
 * The reason `snapshots/release.json` can be trusted at all.
 *
 * M1 moved the release overview off the page path: `admin-release-state` and
 * `admin-editorial-view` now read deploy facts out of one blob instead of
 * making two Netlify deploys-API calls and one GitHub `/compare` per distinct
 * publish commit on every page view. Two of the three writers are write-path
 * hooks — `object_publish` and `release_to_production` — and between them they
 * cover everything a person in this system DOES.
 *
 * They do not cover what happens TO it. A build finishes. Netlify publishes the
 * deploy. An operator rolls production back, or unlocks Auto Publishing, or
 * cancels a build. Every one of those changes which commit production serves,
 * and no write path in this repo observes any of them — the old page-time
 * compute saw them only because it asked Netlify on every request. So the
 * snapshot needs a clock, and this is it.
 *
 * Two minutes, not five: the dashboard polls every six seconds while a deploy
 * is `queued`/`building`, and a release that finished should not read as
 * "building" for the length of a coffee break. Two minutes is also what
 * `RELEASE_SNAPSHOT_MAX_AGE_MS` (ten minutes, three missed passes) is
 * calibrated against — past that bound a READ rebuilds the snapshot itself, so
 * an outage of this function degrades to the old compute cost rather than to
 * wrong answers.
 *
 * Deliberately NOT a new mechanism: it calls `refreshReleaseSnapshot`, the same
 * builder the read-path repair calls, through the same single writer. The
 * self-healing law (AGENTS.md: self-healing over migrations) says the repair
 * path and the scheduled path must be the same code, and they are — this
 * function is a schedule wrapped around a write.
 *
 * Cost per pass, per tenant: two blob reads for the trusted inventory, one for
 * the previous snapshot, two Netlify API calls, at most
 * `RELEASE_ANCESTRY_BUDGET_MS` of GitHub `/compare` at concurrency four, one
 * blob write. The ancestry answers are memoised permanently per instance
 * (`isCommitAncestorOrEqual`), so a warm instance re-asks GitHub only about
 * commits published since its last pass.
 *
 * Declared per site in netlify.toml (`[functions."release-snapshot-refresh"]
 * schedule = "*\/2 * * * *"`) — a scheduled function only runs if its schedule
 * is DECLARED (P1: every `sites/<client>/netlify.toml` carries the block, and
 * so does the `create-site.mjs` scaffold).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { refreshReleaseSnapshot, type ReleaseSnapshotStore } from '../lib/release/snapshot-store.js';

export const runReleaseSnapshotRefresh = async (event: unknown, nowMs = Date.now(), binding?: SiteBinding) => {
  const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ReleaseSnapshotStore;
  const { snapshot, written } = await refreshReleaseSnapshot(store, {
    nowMs,
    source: 'schedule',
    ...(binding?.env ? { envNames: binding.env } : {}),
  });
  return {
    ok: true,
    at: snapshot.as_of,
    written,
    deploy_configured: snapshot.deploy.configured,
    deploy_state: snapshot.deploy.latest?.status ?? null,
    live_commit: snapshot.deploy.live_commit,
    included_commits: snapshot.deploy.included_commits.length,
    /**
     * The number the operator should watch. Persistently true means the GitHub
     * fan-out is not finishing inside its budget — the overview still degrades
     * safely (an object reads `published` rather than `live`), but the site has
     * outgrown one pass and the budget or the schedule wants revisiting.
     */
    ancestry_truncated: snapshot.deploy.ancestry_truncated,
    objects: snapshot.objects.length,
    waiting: snapshot.waiting_count,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runReleaseSnapshotRefresh(event, Date.now(), binding);
    console.log(JSON.stringify({ ts: result.at, event: 'release_snapshot_refresh', ...result }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Release snapshot refresh failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding (the `membership-sweep` pattern). */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
