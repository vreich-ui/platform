import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from './site-binding.js';

export type DeployStatus = 'queued' | 'building' | 'ready' | 'failed' | 'canceled' | 'timed_out';

export type DeployReceipt = {
  deployId: string;
  deployUrl: string;
  productionUrl: string;
  commit: string;
  deployStatus: DeployStatus;
  startedAt: string;
  finishedAt: string;
  errorMessage: string;
  /** Netlify deploy context: 'production' | 'deploy-preview' | 'branch-deploy' | ''(unknown). */
  context?: string;
};

type NetlifyDeploy = Record<string, unknown>;

type PollDeployReceiptOptions = {
  commit?: string;
  deployId?: string;
  timeoutSeconds?: number;
  intervalSeconds?: number;
};

const NETLIFY_API_BASE_URL = 'https://api.netlify.com/api/v1';
const RECENT_DEPLOYS_PAGE_SIZE = 20;
const DEFAULT_POLL_TIMEOUT_SECONDS = 120;
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const TERMINAL_DEPLOY_STATUSES = new Set<DeployStatus>(['ready', 'failed', 'canceled']);

const getNetlifyDeployConfig = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES) => {
  const siteId = readBoundEnv(envNames.blobSiteId) ?? '';
  const token = readBoundEnv(envNames.deployLookupToken) ?? '';

  return { siteId, token };
};

/**
 * T16.5: the single predicate for "is deploy lookup configured" — both the
 * real call path (isNetlifyDeployLookupConfigured below) and
 * capability-status.ts's `deploy_lookup` family read this same function.
 * Reports the CANONICAL name of each missing binding (the first entry in the
 * site-binding fallback chain — the T11.7 table's documented name), not
 * every alias.
 */
export const netlifyDeployLookupMissingEnvVars = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): string[] => {
  const { siteId, token } = getNetlifyDeployConfig(envNames);
  return [...(siteId ? [] : [envNames.blobSiteId[0]]), ...(token ? [] : [envNames.deployLookupToken[0]])];
};

export const isNetlifyDeployLookupConfigured = () => netlifyDeployLookupMissingEnvVars().length === 0;

const getNetlifyBuildHookUrl = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES) =>
  readBoundEnv(envNames.buildHookUrl) ?? '';

/**
 * T16.5: the single predicate for "is the build hook configured" — both the
 * real call path (isNetlifyBuildHookConfigured below) and
 * capability-status.ts's `build_hook` family read this same function.
 */
export const netlifyBuildHookMissingEnvVars = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): string[] =>
  getNetlifyBuildHookUrl(envNames) ? [] : [envNames.buildHookUrl[0]];

export const isNetlifyBuildHookConfigured = () => netlifyBuildHookMissingEnvVars().length === 0;

export class NetlifyBuildHookTriggerError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'NetlifyBuildHookTriggerError';
    this.statusCode = statusCode;
  }
}

export const triggerNetlifyBuild = async (): Promise<{ triggeredAt: string }> => {
  const hookUrl = getNetlifyBuildHookUrl();

  if (!hookUrl) {
    throw new Error('Netlify build hook is not configured.');
  }

  const response = await fetch(hookUrl, { method: 'POST' });

  if (!response.ok) {
    throw new NetlifyBuildHookTriggerError(
      response.status,
      `Netlify build hook trigger failed with HTTP ${response.status}.`
    );
  }

  return { triggeredAt: new Date().toISOString() };
};

const toStringValue = (value: unknown) => (typeof value === 'string' ? value : '');

const firstStringValue = (...values: unknown[]) => {
  for (const value of values) {
    const stringValue = toStringValue(value);
    if (stringValue) return stringValue;
  }

  return '';
};

const normalizeDeployStatus = (deploy: NetlifyDeploy): DeployStatus => {
  const rawStatus = firstStringValue(deploy.state, deploy.status, deploy.deploy_status).toLowerCase();
  const rawErrorMessage = getDeployErrorMessage(deploy);

  if (rawStatus === 'ready') return 'ready';
  if (rawStatus === 'canceled' || rawStatus === 'cancelled') return 'canceled';
  if (rawStatus === 'error' || rawStatus === 'failed' || rawStatus === 'failure' || rawStatus === 'deploy_failed') {
    return 'failed';
  }
  if (rawErrorMessage) return 'failed';
  if (rawStatus === 'enqueued' || rawStatus === 'queued' || rawStatus === 'new' || rawStatus === 'pending')
    return 'queued';

  return 'building';
};

const getDeployErrorMessage = (deploy: NetlifyDeploy) =>
  firstStringValue(
    deploy.error_message,
    deploy.errorMessage,
    deploy.error,
    deploy.summary,
    deploy.deploy_error,
    deploy.failure_reason,
    deploy.reason
  );

const mapNetlifyDeployToReceipt = (deploy: NetlifyDeploy): DeployReceipt => {
  const deployStatus = normalizeDeployStatus(deploy);
  const finishedAt =
    deployStatus === 'ready' || deployStatus === 'failed' || deployStatus === 'canceled'
      ? firstStringValue(deploy.published_at, deploy.finished_at, deploy.done_at, deploy.updated_at, deploy.created_at)
      : '';

  return {
    deployId: firstStringValue(deploy.id, deploy.deploy_id),
    deployUrl: firstStringValue(deploy.deploy_ssl_url, deploy.deploy_url, deploy.url),
    productionUrl: firstStringValue(deploy.ssl_url),
    commit: firstStringValue(deploy.commit_ref),
    deployStatus,
    startedAt: firstStringValue(deploy.created_at, deploy.started_at, deploy.deploy_started_at, deploy.updated_at),
    finishedAt,
    errorMessage: getDeployErrorMessage(deploy),
    context: firstStringValue(deploy.context),
  };
};

const fetchNetlifyApi = async (path: string) => {
  const { siteId, token } = getNetlifyDeployConfig();

  if (!siteId || !token) {
    throw new Error('Netlify deploy lookup is not configured.');
  }

  const response = await fetch(`${NETLIFY_API_BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Netlify deploy lookup failed with HTTP ${response.status}.`);
  }

  return response.json() as Promise<unknown>;
};

export const fetchRecentDeploys = async (): Promise<DeployReceipt[]> => {
  const { siteId } = getNetlifyDeployConfig();
  const deploys = await fetchNetlifyApi(
    `/sites/${encodeURIComponent(siteId)}/deploys?per_page=${RECENT_DEPLOYS_PAGE_SIZE}&page=1`
  );

  if (!Array.isArray(deploys)) return [];

  return deploys
    .filter((deploy): deploy is NetlifyDeploy => Boolean(deploy && typeof deploy === 'object'))
    .map(mapNetlifyDeployToReceipt);
};

export const getDeployReceiptByCommit = async (commit: string): Promise<DeployReceipt | undefined> => {
  const normalizedCommit = commit.trim();
  if (!normalizedCommit) return undefined;

  const deploys = await fetchRecentDeploys();

  return deploys.find((deploy) => deploy.commit === normalizedCommit);
};

export const getDeployReceiptByDeployId = async (deployId: string): Promise<DeployReceipt | undefined> => {
  const normalizedDeployId = deployId.trim();
  if (!normalizedDeployId) return undefined;

  const deploy = await fetchNetlifyApi(`/deploys/${encodeURIComponent(normalizedDeployId)}`);

  if (deploy && typeof deploy === 'object') return mapNetlifyDeployToReceipt(deploy as NetlifyDeploy);

  return undefined;
};

/**
 * The deploy currently PUBLISHED to production (what the live site serves), via
 * the site object's `published_deploy`. This is the authoritative "what is
 * production actually serving" signal — distinct from "a build for this commit
 * is ready", which under locked Netlify Auto Publishing can be a ready-but-
 * unpublished deploy (or a deploy preview). Returns undefined when the site
 * lookup is unavailable so callers can degrade to a best-effort check.
 */
export const getPublishedProductionDeploy = async (): Promise<DeployReceipt | undefined> => {
  const { siteId } = getNetlifyDeployConfig();
  if (!siteId) return undefined;

  try {
    const site = await fetchNetlifyApi(`/sites/${encodeURIComponent(siteId)}`);
    const published = site && typeof site === 'object' ? (site as Record<string, unknown>).published_deploy : undefined;
    if (published && typeof published === 'object') return mapNetlifyDeployToReceipt(published as NetlifyDeploy);
  } catch {
    // Fall through — the caller degrades to a best-effort ready-by-commit check.
  }

  return undefined;
};

const wait = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

const getTimedOutReceipt = (receipt: DeployReceipt | undefined, commit: string, deployId: string): DeployReceipt => ({
  deployId: receipt?.deployId || deployId,
  deployUrl: receipt?.deployUrl || '',
  productionUrl: receipt?.productionUrl || '',
  commit: receipt?.commit || commit,
  deployStatus: 'timed_out',
  startedAt: receipt?.startedAt || '',
  finishedAt: receipt?.finishedAt || '',
  errorMessage: receipt?.errorMessage || '',
});

export const pollDeployReceipt = async ({
  commit = '',
  deployId = '',
  timeoutSeconds = DEFAULT_POLL_TIMEOUT_SECONDS,
  intervalSeconds = DEFAULT_POLL_INTERVAL_SECONDS,
}: PollDeployReceiptOptions): Promise<DeployReceipt> => {
  const normalizedCommit = commit.trim();
  const normalizedDeployId = deployId.trim();
  const timeoutMs = Math.max(0, timeoutSeconds) * 1000;
  const intervalMs = Math.max(1, intervalSeconds) * 1000;
  const deadline = Date.now() + timeoutMs;
  let latestReceipt: DeployReceipt | undefined;

  do {
    latestReceipt = normalizedDeployId
      ? await getDeployReceiptByDeployId(normalizedDeployId)
      : await getDeployReceiptByCommit(normalizedCommit);

    if (latestReceipt && TERMINAL_DEPLOY_STATUSES.has(latestReceipt.deployStatus)) return latestReceipt;
    if (Date.now() >= deadline) break;

    await wait(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);

  return getTimedOutReceipt(latestReceipt, normalizedCommit, normalizedDeployId);
};
