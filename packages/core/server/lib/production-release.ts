/**
 * Production release + verification (Gap 2).
 *
 * Deploy model: object-export publishes commit to main with `[skip netlify]`
 * (see object-publish.ts), so pushing them does NOT build or deploy — the
 * exports accumulate on main, dark, until an explicit release. This module IS
 * that release: it fires the production build hook once (producing a single
 * deploy that includes every accumulated skipped commit) and then — when the
 * caller asked to wait (`awaitDeploy`, default true for this shared core) —
 * blocks until it can prove the live production deploy reflects a specific
 * commit. This is what separates object export from production deploy.
 *
 * S5: both shipped entry points now pass `awaitDeploy:false` by default and
 * answer `status:'building'` the moment the hook has fired. The post-hook
 * awaits below (a deploy-receipt poll that sleeps a full 5 s interval, an
 * unbounded published-deploy lookup, an unbounded GitHub ancestry compare)
 * routinely outran the 10 s Netlify function ceiling, so the caller saw a CDN
 * 502 for a release that HAD already fired the hook. Verification is the
 * caller's `deploy_status` poll, which a 30-120 s build required anyway.
 *
 * The build hook is the only thing here that can start a production build (the
 * project invariant, and the whole point of the deferral): forceBuild POSTs
 * `NETLIFY_BUILD_HOOK_URL` through the existing triggerNetlifyBuild — there is
 * deliberately no second env var and no other trigger path. Everything else is
 * read-only: resolve the target commit (the content-branch HEAD via the GitHub
 * ref API, the same GITHUB_CONTENT_TOKEN/GITHUB_REPOSITORY/GITHUB_BRANCH
 * contract the object committer uses — HEAD is exactly the accumulation point),
 * then poll Netlify deploy receipts until the deploy for that commit is
 * terminal, and report whether production actually reflects it.
 *
 * Operational note (not enforceable here): the build hook only helps if the
 * site's Netlify builds are active and "Auto Publishing" is unlocked. Under a
 * locked deploy, Netlify still builds but does not publish to the main site —
 * a released:false / not-confirmed-live result can mean exactly that.
 *
 * Shared by BOTH surfaces so there is one release path, never two: the
 * `release_to_production` MCP tool (agents) and the admin dashboard
 * "Release to Production" button (humans) both call this function.
 */
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from './site-binding.js';
import {
  getPublishedProductionDeploy,
  isNetlifyBuildHookConfigured,
  isNetlifyDeployLookupConfigured,
  pollDeployReceipt,
  triggerNetlifyBuild,
  type DeployReceipt,
} from './netlify-deploys.js';
import { getSiteIdentity } from '../../lib/site-identity.js';

const GITHUB_API_ROOT = 'https://api.github.com';
const USER_AGENT = `${getSiteIdentity().siteSlug}-production-release`;

export type ReleaseToProductionOptions = {
  /** Commit the live deploy must reflect. Defaults to the content branch HEAD. */
  commit?: string;
  /** POST the build hook to force a fresh production build first. Default true. */
  forceBuild?: boolean;
  /**
   * S5. When false, RETURN AS SOON AS THE HOOK HAS FIRED and the commit is
   * known (`status: 'building'`), skipping every post-hook await: the
   * deploy-receipt poll, the published-deploy lookup and the GitHub ancestry
   * call. Those three are what made the first release call outlive the
   * serverless invocation and answer a CDN 502 with the build already
   * triggered — see release-async.ts's header. The caller polls
   * `deploy_status {commit}` instead, which is what it had to do anyway
   * (a 30-120 s build never fits an in-call wait budget).
   *
   * Defaults to true so this shared core keeps its old blocking contract for
   * any caller that has not opted in; both shipped entry points
   * (`release_to_production` and `admin-release`) now pass false by default.
   */
  awaitDeploy?: boolean;
  timeoutSeconds?: number;
  intervalSeconds?: number;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Bound env-var names (SiteBinding.env). Defaults to the platform names. */
  envNames?: SiteBindingEnvNames;
};

export type ReleaseToProductionResult = {
  /** True only when production is confirmed (or, without site lookup, best-effort ready) on the target commit. */
  released: boolean;
  /** Machine-readable outcome for callers that branch on it. */
  status:
    | 'released'
    /** S5: the hook fired and the commit is known; verification is the caller's poll. */
    | 'building'
    | 'build_not_confirmed_live'
    | 'build_ready_not_published'
    | 'commit_unresolved'
    | 'build_hook_not_configured'
    | 'deploy_lookup_not_configured';
  reason: string;
  targetCommit: string;
  buildTriggered: boolean;
  triggeredAt?: string;
  /** Whether the ready deploy's commit matches the resolved target commit. */
  productionReflectsCommit: boolean;
  /**
   * True only when the site's published_deploy (what production actually
   * serves) reflects the target commit. False either means production serves
   * something else OR the published-deploy lookup was unavailable — a false
   * here with released:true means "ready-by-commit only, not independently
   * confirmed live".
   */
  productionConfirmed: boolean;
  deploy?: DeployReceipt;
  /** The deploy production currently serves, when the site lookup resolves it. */
  publishedDeploy?: DeployReceipt;
  productionUrl?: string;
};

const resolveGitHubConfig = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES) => {
  const token = readBoundEnv(envNames.gitContentToken);
  const repo = readBoundEnv(envNames.gitRepository);
  const branch = readBoundEnv(envNames.gitBranch) ?? 'main';
  return { token, repo, branch };
};

/**
 * The content branch HEAD sha via the GitHub ref API — the same repo/branch
 * the object committer PATCHes, so "latest commit" here is exactly what a
 * publish just pushed. Returns undefined when GitHub is not configured or the
 * ref cannot be read (the caller degrades to "commit unresolved").
 */
export const resolveBranchHeadCommit = async (
  fetchImpl: typeof fetch = fetch,
  envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES
): Promise<string | undefined> => {
  const { token, repo, branch } = resolveGitHubConfig(envNames);
  if (!token || !repo) return undefined;

  try {
    const response = await fetchImpl(`${GITHUB_API_ROOT}/repos/${repo}/git/ref/heads/${branch}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'User-Agent': USER_AGENT,
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    if (!response.ok) return undefined;
    const body = (await response.json()) as { object?: { sha?: unknown } };
    const sha = body.object?.sha;
    return typeof sha === 'string' && sha.trim() ? sha.trim() : undefined;
  } catch {
    return undefined;
  }
};

/**
 * QA-W16-4: object exports accumulate on main behind `[skip netlify]` (see
 * object-publish.ts's header) and a SINGLE release build deploys every
 * accumulated commit at once. That means the deploy production actually
 * publishes is very often AHEAD of any one individual export's commit, not
 * equal to it — the export's content is live (it's an ancestor of what got
 * built), but a strict `deploy.commit === targetCommit` check reports
 * "queued"/"not confirmed" forever for that older commit even while
 * production visibly serves its content. That is exactly what the QA
 * session hit: 5+ polls of deploy_status reporting `queued` /
 * `productionConfirmed:false` with `publishedDeploy` pointing at a LATER
 * commit than the one being checked, while the live article URL proved the
 * checked commit's content was already being served.
 *
 * Fix: when the exact-match check fails but a published deploy exists,
 * ask GitHub directly (the same repo/token/branch triple
 * resolveBranchHeadCommit already uses) whether `targetCommit` is an
 * ancestor of (or equal to) `publishedCommit` via the compare API. `base`
 * behind `head` (or identical) means target's changes are already included
 * in what is live — reconcile the result to "confirmed" rather than
 * "queued". Returns undefined (unknown, never "not live") when GitHub is not
 * configured or the compare call fails, so a caller degrades exactly like
 * the existing "lookup unavailable" paths already do.
 */
/**
 * T5.1 R2 (T0.2 F3): a PERMANENT per-instance memo of the ancestry answer.
 *
 * `admin-release-state` asks this question once per distinct
 * `publish_commit` across the whole object store, on EVERY request, and
 * every miss is a GitHub `/compare` REST call — so a page view cost K
 * outbound calls and K × ~150-300 ms, growing monotonically with publish
 * history, and burned GitHub API quota per admin page view.
 *
 * The memo never expires and never needs invalidating, because what it
 * caches is IMMUTABLE: whether commit A is an ancestor of commit B is a fact
 * about two fixed points in the commit graph. A rewritten history would
 * produce different SHAs, hence different keys. Only definite answers are
 * memoized — `undefined` means "could not verify" (GitHub unconfigured, a
 * non-2xx, a network error), which is a transient condition and must stay
 * retryable.
 *
 * Scope is the warm function instance, matching `content-item-index.ts`'s
 * in-repo precedent. `fetchImpl` is part of the key's contract only in the
 * sense that tests inject their own: `resetCommitAncestryMemoForTesting`
 * clears it between cases.
 */
const commitAncestryMemo = new Map<string, boolean>();

export const resetCommitAncestryMemoForTesting = (): void => {
  commitAncestryMemo.clear();
};

export const isCommitAncestorOrEqual = async (
  targetCommit: string,
  publishedCommit: string,
  fetchImpl: typeof fetch = fetch,
  envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES
): Promise<boolean | undefined> => {
  if (!targetCommit || !publishedCommit) return undefined;
  if (targetCommit === publishedCommit) return true;

  const memoKey = `${targetCommit}...${publishedCommit}`;
  const memoized = commitAncestryMemo.get(memoKey);
  if (memoized !== undefined) return memoized;

  const { token, repo } = resolveGitHubConfig(envNames);
  if (!token || !repo) return undefined;

  try {
    const response = await fetchImpl(
      `${GITHUB_API_ROOT}/repos/${repo}/compare/${encodeURIComponent(targetCommit)}...${encodeURIComponent(publishedCommit)}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'User-Agent': USER_AGENT,
          'X-GitHub-Api-Version': '2022-11-28',
        },
      }
    );
    if (!response.ok) return undefined;
    const body = (await response.json()) as { status?: unknown };
    // 'ahead': publishedCommit is a descendant of targetCommit (targetCommit's
    // changes are included). 'identical': same commit (already handled above,
    // but GitHub can also report it this way for annotated/merge edge cases).
    const answer = body.status === 'ahead' || body.status === 'identical';
    commitAncestryMemo.set(memoKey, answer);
    return answer;
  } catch {
    return undefined;
  }
};

export const releaseToProduction = async (
  options: ReleaseToProductionOptions = {}
): Promise<ReleaseToProductionResult> => {
  const fetchImpl = options.fetchImpl ?? fetch;
  const forceBuild = options.forceBuild ?? true;
  const awaitDeploy = options.awaitDeploy ?? true;
  const envNames = options.envNames ?? PLATFORM_ENV_NAMES;

  // The build hook is the ONLY sanctioned production-build trigger. If a
  // forced build is requested but no hook is configured, refuse rather than
  // silently skipping it and reporting a stale deploy as "released".
  if (forceBuild && !isNetlifyBuildHookConfigured(envNames)) {
    return {
      released: false,
      status: 'build_hook_not_configured',
      reason:
        'Cannot force a production build: NETLIFY_BUILD_HOOK_URL is not configured. The build hook is the only allowed production-build trigger (operator-level setup).',
      targetCommit: '',
      buildTriggered: false,
      productionReflectsCommit: false,
      productionConfirmed: false,
    };
  }

  const targetCommit = options.commit?.trim() || (await resolveBranchHeadCommit(fetchImpl, envNames));
  if (!targetCommit) {
    return {
      released: false,
      status: 'commit_unresolved',
      reason:
        'Could not resolve the target commit: pass an explicit commit, or configure GITHUB_CONTENT_TOKEN and GITHUB_REPOSITORY so the branch HEAD can be read.',
      targetCommit: '',
      buildTriggered: false,
      productionReflectsCommit: false,
      productionConfirmed: false,
    };
  }

  let buildTriggered = false;
  let triggeredAt: string | undefined;
  if (forceBuild) {
    const trigger = await triggerNetlifyBuild(envNames);
    buildTriggered = true;
    triggeredAt = trigger.triggeredAt;
  }

  // S5 — the release is DONE being irreversible right here: the hook has
  // fired and the commit is resolved. Everything below is verification the
  // caller can (and, for a 30-120 s build, must anyway) do with
  // `deploy_status`. Returning now is what keeps the response inside the
  // serverless invocation instead of dying as a CDN 502 with a build already
  // running. Nothing is skipped silently: `status: 'building'` says exactly
  // what is true and what to poll.
  if (!awaitDeploy) {
    // Not a blocker for a 202 (the hook has already fired), but the caller is
    // being told to poll deploy_status — so say up front when that poll cannot
    // answer, rather than letting them poll a tool that is unconfigured.
    const lookupCaveat = isNetlifyDeployLookupConfigured()
      ? ''
      : ' NOTE: Netlify deploy lookup (NETLIFY_SITE_ID + token) is not configured on this deployment, so deploy_status cannot confirm go-live — this is an operator-level setup gap.';
    return {
      released: false,
      status: 'building',
      reason:
        (buildTriggered
          ? `The production build hook fired for commit ${targetCommit}; the build is running. Poll deploy_status {commit: "${targetCommit}"} until deployStatus is "ready" AND productionConfirmed is true. Do NOT call release again for this commit.`
          : `No build was forced (force_build:false); reporting the target commit only. Poll deploy_status {commit: "${targetCommit}"} for the deploy this commit's push produced.`) +
        lookupCaveat,
      targetCommit,
      buildTriggered,
      ...(triggeredAt ? { triggeredAt } : {}),
      productionReflectsCommit: false,
      productionConfirmed: false,
    };
  }

  // Verification needs the Netlify deploy API. Without it we can at most report
  // that a build was triggered — never that production is confirmed live.
  if (!isNetlifyDeployLookupConfigured(envNames)) {
    return {
      released: false,
      status: 'deploy_lookup_not_configured',
      reason:
        'A production build was triggered but go-live cannot be verified: Netlify deploy lookup (NETLIFY_SITE_ID + token) is not configured.',
      targetCommit,
      buildTriggered,
      triggeredAt,
      productionReflectsCommit: false,
      productionConfirmed: false,
    };
  }

  const deploy = await pollDeployReceipt({
    commit: targetCommit,
    timeoutSeconds: options.timeoutSeconds,
    intervalSeconds: options.intervalSeconds,
    envNames,
  });
  const productionReflectsCommit = deploy.deployStatus === 'ready' && deploy.commit === targetCommit;

  // "Ready" is necessary but not sufficient: under locked Auto Publishing a
  // deploy builds to ready without production ever serving it. The site's
  // published_deploy is the authoritative live signal, so consult it and only
  // fall back to ready-by-commit when the site lookup is unavailable.
  const publishedDeploy = await getPublishedProductionDeploy(envNames);
  const shared = {
    targetCommit,
    buildTriggered,
    triggeredAt,
    productionReflectsCommit,
    deploy,
    ...(publishedDeploy ? { publishedDeploy } : {}),
    productionUrl: publishedDeploy?.productionUrl || deploy.productionUrl || undefined,
  };

  if (publishedDeploy?.commit === targetCommit) {
    return {
      released: true,
      status: 'released',
      reason: `Production is live on commit ${targetCommit} (published deploy ${publishedDeploy.deployId || 'unknown'}).`,
      productionConfirmed: true,
      ...shared,
    };
  }

  // QA-W16-4: exports accumulate behind [skip netlify] and one release
  // deploys every accumulated commit at once, so the site's published
  // deploy is very often AHEAD of targetCommit rather than equal to it, even
  // though targetCommit's changes are already live. Reconcile via ancestry
  // before reporting "not confirmed" for a commit production has already
  // moved past.
  if (publishedDeploy && publishedDeploy.commit) {
    const targetIsAncestor = await isCommitAncestorOrEqual(targetCommit, publishedDeploy.commit, fetchImpl, envNames);
    if (targetIsAncestor) {
      return {
        released: true,
        status: 'released',
        reason: `Production is live on commit ${publishedDeploy.commit}, which already includes commit ${targetCommit} (published deploy ${publishedDeploy.deployId || 'unknown'}).`,
        productionConfirmed: true,
        ...shared,
      };
    }
  }

  if (publishedDeploy && productionReflectsCommit) {
    return {
      released: false,
      status: 'build_ready_not_published',
      reason: `The build for commit ${targetCommit} is ready, but production still serves ${publishedDeploy.commit || 'a different commit'} — Netlify "Auto Publishing" is likely locked. Unlock it (or publish the deploy manually in the Netlify UI), then re-check deploy_status.`,
      productionConfirmed: false,
      ...shared,
    };
  }

  return {
    released: !publishedDeploy && productionReflectsCommit,
    status: !publishedDeploy && productionReflectsCommit ? 'released' : 'build_not_confirmed_live',
    reason:
      !publishedDeploy && productionReflectsCommit
        ? `Production deploy for commit ${targetCommit} is ready (published-deploy lookup unavailable — confirmed ready-by-commit only).`
        : `The production deploy for commit ${targetCommit} did not reach a ready state within the wait budget (deploy status: ${deploy.deployStatus}). Re-check deploy_status; the build may still be in progress.`,
    productionConfirmed: false,
    ...shared,
  };
};
