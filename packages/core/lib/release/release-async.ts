/**
 * S5 — the release response contract, as pure data shaping.
 *
 * Three live QA sessions saw the FIRST `release_to_production` call come back
 * a Cloudflare 502 (`origin_bad_gateway`), 3 for 3, with the build hook
 * already fired every time. That is not a flake: the release handler fired
 * the hook and then kept awaiting slow work — a 6 s deploy-receipt poll
 * (netlify-deploys.ts `pollDeployReceipt`, 5 s interval so it sleeps a full
 * interval before giving up), then an UNBOUNDED `getPublishedProductionDeploy`
 * Netlify call, then an UNBOUNDED GitHub `/compare` ancestry call, then the
 * idempotency-store blob write — inside a Netlify synchronous function whose
 * platform ceiling is 10 s. The invocation is killed mid-response and the CDN
 * answers 502.
 *
 * The fix is structural, not a longer timeout: once the build hook has fired
 * and the commit is known, the interesting facts are ALL known. Everything
 * after that is polling that the caller can do itself, cheaply, through
 * `deploy_status`. So the release answers 202 / `status:"building"` right
 * there and hands back the commit to poll.
 *
 * This module holds the two shapes that decision produces, with no I/O, so
 * both entry points (the `release_to_production` MCP tool and the
 * `admin-release` browser endpoint) and the chat bridge wrapper emit exactly
 * the same vocabulary, and so the shapes are unit-testable without a network.
 *
 * STANDING RULING encoded here: a 502 from a release is NEVER retried. The
 * hook fires BEFORE the response, so a retry can double-fire a paid
 * production build (observed: two builds for one release; `idempotency_key`
 * does not suppress the second, because the first invocation died before it
 * could store its result). `buildLostReleaseResult` is the sanctioned
 * recovery: ask `deploy_status` what actually happened and report that.
 */

export const RELEASE_BUILDING_STATUS = 'building' as const;
export const RELEASE_LOST_WARNING = 'release_response_lost' as const;

/** HTTP status each release outcome maps to on the browser (admin-release) surface. */
export const releaseHttpStatusFor = (status: string): 200 | 202 | 400 => {
  if (status === 'build_hook_not_configured' || status === 'deploy_lookup_not_configured') return 400;
  return status === RELEASE_BUILDING_STATUS ? 202 : 200;
};

export type AsyncReleaseSource = {
  targetCommit: string;
  buildTriggered: boolean;
  triggeredAt?: string;
  reason?: string;
};

export type AsyncReleaseBody = {
  /** The commit to poll `deploy_status` with. Same value as targetCommit; named for the caller's ergonomics. */
  commit: string;
  targetCommit: string;
  build_hook_fired: boolean;
  status: typeof RELEASE_BUILDING_STATUS;
  released: false;
  productionConfirmed: false;
  productionReflectsCommit: false;
  buildTriggered: boolean;
  triggeredAt?: string;
  /** Mirrors the HTTP status the browser surface returns, so an MCP caller sees the same "accepted" semantics. */
  http_status: 202;
  reason: string;
  next: { tool: 'deploy_status'; arguments: { commit: string }; until: string };
};

const POLL_UNTIL = 'deployStatus is "ready" AND productionConfirmed is true';

/**
 * The 202 receipt: everything that is genuinely known the instant the hook
 * has fired. Deliberately carries no deploy receipt — there is no deploy yet
 * (Netlify takes seconds to even create the record), which is exactly why
 * waiting for one is what killed the invocation.
 */
export const buildAsyncReleaseBody = (source: AsyncReleaseSource): AsyncReleaseBody => ({
  commit: source.targetCommit,
  targetCommit: source.targetCommit,
  build_hook_fired: source.buildTriggered,
  status: RELEASE_BUILDING_STATUS,
  released: false,
  productionConfirmed: false,
  productionReflectsCommit: false,
  buildTriggered: source.buildTriggered,
  ...(source.triggeredAt ? { triggeredAt: source.triggeredAt } : {}),
  http_status: 202,
  reason:
    source.reason ??
    `The production build hook fired for commit ${source.targetCommit}; the build is running. This call returns as soon as the hook has fired (it does NOT wait for the deploy) so it can never outlive the serverless invocation. Poll deploy_status {commit: "${source.targetCommit}"} until ${POLL_UNTIL}. Do NOT call release_to_production again for this commit — that fires a second paid build.`,
  next: { tool: 'deploy_status', arguments: { commit: source.targetCommit }, until: POLL_UNTIL },
});

/**
 * Deploy states that prove a build for the commit EXISTS on Netlify — i.e.
 * the release landed, whatever the transport did with the response.
 */
const DEPLOY_IN_FLIGHT = new Set([
  'new',
  'pending_review',
  'accepted',
  'enqueued',
  'queued',
  'building',
  'uploading',
  'uploaded',
  'preparing',
  'prepared',
  'processing',
  'processed',
]);
const DEPLOY_FAILED = new Set(['failed', 'error', 'canceled', 'cancelled']);

export type LostReleaseInput = {
  /** The commit the wrapper was about to release (or had resolved). */
  commit: string | null;
  /** What the release call actually reported (the 502 / transport text). */
  releaseError: string;
  /** Parsed `deploy_status` body for that commit, or null when that read also failed. */
  deploy: Record<string, unknown> | null;
};

export type LostReleaseResult = {
  warning: typeof RELEASE_LOST_WARNING;
  /** Load-bearing: the standing ruling is that a 502 release is never re-issued. */
  release_retried: false;
  build_hook_refired: false;
  released: boolean;
  status: 'released' | 'building' | 'build_failed' | 'release_state_unknown';
  /** true when deploy_status proves a build exists for the commit; 'unknown' when it could not say. */
  release_landed: boolean | 'unknown';
  target_commit: string | null;
  release_error: string;
  deploy: { status: string | null; production_confirmed: boolean };
  reason: string;
};

const readDeployStatus = (deploy: Record<string, unknown> | null): string | null => {
  if (!deploy) return null;
  const raw = deploy.deployStatus ?? deploy.status;
  return typeof raw === 'string' && raw.trim() ? raw.trim().toLowerCase() : null;
};

/**
 * Turn "the release call came back an error we cannot trust" plus "what
 * deploy_status says" into ONE truthful answer for the caller.
 *
 * Never re-issues the release: `release_retried:false` /
 * `build_hook_refired:false` are asserted in the payload precisely so a
 * reader (human or agent) can see the ruling was honoured.
 */
export const buildLostReleaseResult = (input: LostReleaseInput): LostReleaseResult => {
  const deployStatus = readDeployStatus(input.deploy);
  const productionConfirmed = input.deploy?.productionConfirmed === true;
  const commitLabel = input.commit ?? 'the target commit';
  const base = {
    warning: RELEASE_LOST_WARNING,
    release_retried: false,
    build_hook_refired: false,
    target_commit: input.commit,
    release_error: input.releaseError,
    deploy: { status: deployStatus, production_confirmed: productionConfirmed },
  } as const;

  if (deployStatus === 'ready' && productionConfirmed) {
    return {
      ...base,
      released: true,
      status: 'released',
      release_landed: true,
      reason: `The release response was lost in transport, but it landed: production is live on ${commitLabel}. The release was NOT re-issued (the build hook fires before the response, so a retry double-fires a paid build).`,
    };
  }

  if (deployStatus && DEPLOY_FAILED.has(deployStatus)) {
    return {
      ...base,
      released: false,
      status: 'build_failed',
      release_landed: true,
      reason: `The release response was lost in transport, but the release DID land — the build for ${commitLabel} reached "${deployStatus}". Read the Netlify deploy log; do not re-release blindly. The release was NOT re-issued.`,
    };
  }

  if (deployStatus && (deployStatus === 'ready' || DEPLOY_IN_FLIGHT.has(deployStatus))) {
    return {
      ...base,
      released: false,
      status: RELEASE_BUILDING_STATUS,
      release_landed: true,
      reason: `The release response was lost in transport, but the release landed: a deploy for ${commitLabel} is "${deployStatus}". Keep polling deploy_status until deployStatus is "ready" AND productionConfirmed is true. The release was NOT re-issued.`,
    };
  }

  return {
    ...base,
    released: false,
    status: 'release_state_unknown',
    release_landed: 'unknown',
    reason: `The release response was lost in transport and deploy_status could not yet confirm a build for ${commitLabel}. Netlify takes a few seconds to create the deploy record, so poll deploy_status {commit} again before concluding anything. The release was NOT re-issued — the build hook fires before the response, so a retry can fire a second paid production build.`,
  };
};
