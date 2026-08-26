/**
 * The publication-state overview, extracted from `admin-release-state.ts` so
 * more than one endpoint can serve it from ONE piece of work (T5.1 R2, T0.2
 * §4 cause #1).
 *
 * What it costs, and why it needed a memo. Building this means:
 *   - one object-store inventory sweep — since T5.1 R3 that is `T list()` plus
 *     ONE blob read against `objects/index.json`, but it used to be `T
 *     list() + N get()` of whole record envelopes;
 *   - two Netlify deploys-API calls;
 *   - one GitHub `/compare` per distinct `publish_commit` — K uncached
 *     outbound calls per request, which `isCommitAncestorOrEqual`'s permanent
 *     ancestry memo now reduces to ~0 on a warm instance.
 *
 * T0.2 found SEVEN client call sites for `admin-release-state`, several firing
 * on the SAME page load, and `/admin` additionally computed the same inventory
 * a second time for its own `inventory` call. The warm-instance memo below is
 * what makes those collapse into one computation: `admin-release-state` and
 * `admin-editorial-view` both go through here, so whichever runs first pays
 * and the other is free for `RELEASE_OVERVIEW_MEMO_TTL_MS`.
 *
 * The TTL is deliberately short (T0.2 R2 says <=15s). Staleness is bounded by
 * it, and every client path that CHANGES release state drops its own cache
 * immediately (`release-client.ts`'s `invalidateReleaseOverview`), so an
 * editor never waits on this TTL to see their own publish or approval — only
 * a change made by someone else, in another tab, can be up to TTL old.
 */
import { getSiteObjectsBlobStore } from './blob-store.js';
import { handleObjectVerb, type ObjectVerbStore } from './object-verbs.js';
import type { InventoryRow } from './object-inventory.js';
import {
  fetchRecentDeploys,
  getPublishedProductionDeploy,
  isNetlifyDeployLookupConfigured,
  type DeployReceipt,
} from './netlify-deploys.js';
import { isCommitAncestorOrEqual } from './production-release.js';
import {
  getEditorialDeployStatus,
  getEditorialObjectState,
  type EditorialObjectState,
} from '../../lib/admin/editorial-state.js';

export type ReleaseObjectView = {
  object_id: string;
  object_type: string;
  display_name: string;
  review_state: InventoryRow['review_state'];
  approval_state: InventoryRow['approval_state'];
  requires_approval: boolean;
  state: EditorialObjectState;
};

export type ReleaseDeployView = {
  configured: boolean;
  state: ReturnType<typeof getEditorialDeployStatus> | 'unavailable';
  production_confirmed: boolean;
  live_commit: string | null;
  latest: ReturnType<typeof safeDeploy> | null;
  published: ReturnType<typeof safeDeploy> | null;
};

export type ReleaseOverview = {
  /** The full inventory the overview was derived from — reused by callers that need the rows themselves. */
  rows: InventoryRow[];
  deploy: ReleaseDeployView;
  objects: ReleaseObjectView[];
  waiting_count: number;
  pending_approval_count: number;
};

export const RELEASE_OVERVIEW_MEMO_TTL_MS = 10_000;

const safeDeploy = (receipt: DeployReceipt | undefined) =>
  receipt
    ? {
        id: receipt.deployId,
        commit: receipt.commit,
        status: receipt.deployStatus,
        started_at: receipt.startedAt,
        finished_at: receipt.finishedAt,
        production_url: receipt.productionUrl,
      }
    : undefined;

type MemoEntry = { overview: ReleaseOverview; expiresAt: number };
const memo = new Map<string, MemoEntry>();

export const resetReleaseOverviewMemoForTesting = (): void => {
  memo.clear();
};

/**
 * Roles decide nothing in the overview today — `inventory` is not
 * role-filtered — but keying on them means they never CAN leak across
 * principals if that changes.
 */
const memoKeyFor = (roles: readonly string[] | undefined) => [...(roles ?? [])].sort().join(',');

export class ReleaseOverviewUnavailableError extends Error {}

export type ReleaseOverviewCaller = {
  userId?: string | undefined;
  email: string;
  roles?: readonly string[] | undefined;
};

/**
 * Build (or serve from the warm-instance memo) the publication-state overview.
 * Throws `ReleaseOverviewUnavailableError` when the inventory sweep itself
 * fails — the caller decides the status code.
 */
export const loadReleaseOverview = async (event: unknown, caller: ReleaseOverviewCaller): Promise<ReleaseOverview> => {
  const key = memoKeyFor(caller.roles);
  const hit = memo.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.overview;

  const inventory = await handleObjectVerb(
    (await getSiteObjectsBlobStore(event)) as unknown as ObjectVerbStore,
    { action: 'inventory', status: 'active' },
    { kind: 'human', id: caller.userId ?? '', email: caller.email },
    { roles: caller.roles as never }
  );
  if (inventory.status !== 200) throw new ReleaseOverviewUnavailableError('Publication state could not be loaded.');
  const rows = (inventory.body.objects ?? []) as InventoryRow[];

  const lookupConfigured = isNetlifyDeployLookupConfigured();
  const [publishedDeploy, recentDeploys] = lookupConfigured
    ? await Promise.all([getPublishedProductionDeploy(), fetchRecentDeploys()])
    : [undefined, [] as DeployReceipt[]];
  const latestProduction = recentDeploys.find((deploy) => !deploy.context || deploy.context === 'production');
  const publishedCommit = publishedDeploy?.commit || undefined;
  const commits = Array.from(
    new Set(rows.map((row) => row.publish_commit).filter((value): value is string => Boolean(value)))
  );
  const includedCommits = publishedCommit
    ? (
        await Promise.all(
          commits.map(async (commit) =>
            commit === publishedCommit || (await isCommitAncestorOrEqual(commit, publishedCommit)) ? commit : undefined
          )
        )
      ).filter((commit): commit is string => Boolean(commit))
    : [];
  const deployState = {
    production_confirmed: Boolean(publishedCommit),
    ...(publishedCommit ? { live_commit: publishedCommit } : {}),
    included_commits: includedCommits,
    status: lookupConfigured ? getEditorialDeployStatus(latestProduction, publishedCommit) : ('unavailable' as const),
  };
  const objects: ReleaseObjectView[] = rows.map((row) => ({
    object_id: row.object_id,
    object_type: row.object_type,
    display_name: row.display_name,
    review_state: row.review_state,
    approval_state: row.approval_state,
    requires_approval: row.requires_approval,
    state: getEditorialObjectState(row, deployState),
  }));

  const overview: ReleaseOverview = {
    rows,
    deploy: {
      configured: lookupConfigured,
      state: deployState.status,
      production_confirmed: deployState.production_confirmed,
      live_commit: publishedCommit ?? null,
      latest: safeDeploy(latestProduction) ?? null,
      published: safeDeploy(publishedDeploy) ?? null,
    },
    objects,
    waiting_count: objects.filter((object) => object.state === 'published').length,
    pending_approval_count: objects.filter((object) => object.review_state === 'open').length,
  };
  memo.set(key, { overview, expiresAt: Date.now() + RELEASE_OVERVIEW_MEMO_TTL_MS });
  return overview;
};
