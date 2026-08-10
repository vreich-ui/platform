import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBinding, type SiteBindingEnvNames } from './site-binding.js';
import { createLocalBlobStore, type LocalBlobStore } from './local-blobs.js';

type BlobMetadata = Record<string, string>;
type BlobSetOptions = { metadata?: BlobMetadata; onlyIfNew?: boolean };

type BlobStoreValue = string | Buffer | Uint8Array;

type BlobStore = Omit<LocalBlobStore, 'set' | 'setJSON'> & {
  set(
    key: string,
    value: BlobStoreValue,
    options?: BlobSetOptions
  ): Promise<void | { modified: boolean; etag?: string }>;
  setJSON(key: string, value: unknown, options?: BlobSetOptions): Promise<void | { modified: boolean; etag?: string }>;
};

type NetlifyBlobStoreOptions = {
  apiURL?: string;
  consistency?: 'eventual' | 'strong';
  name: string;
  siteID?: string;
  token?: string;
};

type BlobsModule = {
  connectLambda: (event: unknown) => void;
  getStore: (input: string | NetlifyBlobStoreOptions) => BlobStore;
};

let netlifyBlobsModuleForTesting: BlobsModule | undefined;

export const setNetlifyBlobsModuleForTesting = (netlifyBlobs?: BlobsModule) => {
  netlifyBlobsModuleForTesting = netlifyBlobs;
};

type NetlifyLambdaEvent = {
  blobs?: unknown;
};

const hasNetlifyBlobContext = (event: unknown) => {
  return Boolean(event && typeof event === 'object' && 'blobs' in event && (event as NetlifyLambdaEvent).blobs);
};

const isNetlifyEnvEnabled = (value: string | undefined) => {
  if (!value) return false;

  return ['true', '1', 'yes'].includes(value.trim().toLowerCase());
};

const isNetlifyRuntime = (event: unknown) =>
  isNetlifyEnvEnabled(process.env.NETLIFY) || Boolean(process.env.NETLIFY_SITE_ID) || hasNetlifyBlobContext(event);

type BlobStoreSource = 'explicit-api-config' | 'lambda-context' | 'netlify-name-lookup' | 'local-file-backed';

export type BlobStoreSourceDiagnostics = {
  storeName: string;
  source: BlobStoreSource;
  explicitApiConfigUsed: boolean;
  lambdaBlobContextUsed: boolean;
  siteId: {
    envVar: 'NETLIFY_SITE_ID' | 'SITE_ID' | undefined;
    present: boolean;
    redacted: string;
  };
};

const getSiteIdDiagnostic = (
  envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES
): BlobStoreSourceDiagnostics['siteId'] => {
  const envVar = envNames.blobSiteId.find(
    (name) => process.env[name]
  ) as BlobStoreSourceDiagnostics['siteId']['envVar'];
  const value = envVar ? process.env[envVar] || '' : '';

  return {
    envVar,
    present: Boolean(value),
    redacted: value ? `…${value.slice(-4)}` : '',
  };
};

/**
 * T16.5: the single predicate for "is the explicit Netlify Blobs API
 * credential pair configured" — both the real call path
 * (getBlobStoreSourceDiagnostics/getApiStoreConfig below) and
 * capability-status.ts's `blob_credentials` family read this same function.
 * Absence is NOT necessarily an outage (blob-store falls back to the Lambda
 * blob context or a local file-backed store), so this reports "explicit
 * API config present", not "blobs reachable at all".
 */
export const blobCredentialsMissingEnvVars = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): string[] => {
  const siteID = readBoundEnv(envNames.blobSiteId);
  const token = readBoundEnv(envNames.blobToken);
  return [...(siteID ? [] : [envNames.blobSiteId[0]]), ...(token ? [] : [envNames.blobToken[0]])];
};

export const isBlobCredentialsConfigured = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES): boolean =>
  blobCredentialsMissingEnvVars(envNames).length === 0;

export const getBlobStoreSourceDiagnostics = (
  storeName: string,
  event: unknown,
  binding?: SiteBinding
): BlobStoreSourceDiagnostics => {
  const envNames = binding?.env ?? PLATFORM_ENV_NAMES;
  const explicitApiConfigUsed = isBlobCredentialsConfigured(envNames);
  const lambdaBlobContextUsed = !explicitApiConfigUsed && hasNetlifyBlobContext(event);
  const source = explicitApiConfigUsed
    ? 'explicit-api-config'
    : lambdaBlobContextUsed
      ? 'lambda-context'
      : isNetlifyRuntime(event)
        ? 'netlify-name-lookup'
        : 'local-file-backed';

  return {
    storeName,
    source,
    explicitApiConfigUsed,
    lambdaBlobContextUsed,
    siteId: getSiteIdDiagnostic(envNames),
  };
};

export const getCoreBlobStoreSourceDiagnostics = (event: unknown) => ({
  workflows: getBlobStoreSourceDiagnostics('workflows', event),
  siteObjects: getBlobStoreSourceDiagnostics('site-objects', event),
  artifactIndex: getBlobStoreSourceDiagnostics('artifact-index', event),
  artifacts: getBlobStoreSourceDiagnostics('artifacts', event),
});

// Build an explicit Netlify Blobs API configuration (siteID + token) for a named store.
// Returns undefined when credentials are absent, signalling that the caller should fall
// back to the Lambda-injected blob context instead.
const getApiStoreConfig = (
  name: string,
  consistency?: 'eventual' | 'strong',
  envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES
) => {
  const siteID = readBoundEnv(envNames.blobSiteId);
  const token = readBoundEnv(envNames.blobToken);

  if (!isBlobCredentialsConfigured(envNames)) return undefined;

  const apiURL = readBoundEnv(envNames.blobApiUrl);

  return {
    ...(apiURL ? { apiURL } : {}),
    ...(consistency ? { consistency } : {}),
    name,
    siteID,
    token,
  };
};

const loadNetlifyBlobs = async (event: unknown) => {
  if (!isNetlifyRuntime(event)) return undefined;

  // @netlify/blobs must be installed in production; production fallback to local filesystem is disabled.

  if (netlifyBlobsModuleForTesting) return netlifyBlobsModuleForTesting;

  return import('@netlify/blobs').then(
    (mod) => mod as unknown as BlobsModule,
    (error: unknown) => {
      if (isNetlifyRuntime(event)) {
        throw new Error(
          'Netlify Blobs is required in production. Configure npm auth/registry access for @netlify/blobs in Netlify environment variables; do not commit tokens.',
          { cause: error }
        );
      }

      return undefined;
    }
  );
};

export const getNetlifyBlobStore = async (
  storeNameOrOptions: string | NetlifyBlobStoreOptions,
  event: unknown,
  binding?: SiteBinding
): Promise<BlobStore> => {
  const netlifyBlobs = await loadNetlifyBlobs(event);
  const storeName = typeof storeNameOrOptions === 'string' ? storeNameOrOptions : storeNameOrOptions.name;
  const consistency = typeof storeNameOrOptions === 'string' ? undefined : storeNameOrOptions.consistency;

  if (netlifyBlobs) {
    const apiStoreConfig = getApiStoreConfig(storeName, consistency, binding?.env ?? PLATFORM_ENV_NAMES);

    // Prefer explicit API credentials. Otherwise connect the Lambda blob context and look the
    // store up by name: a string lookup uses that injected context, whereas an options object
    // without siteID/token does not, which previously made artifact reads/writes fail with 502.
    if (apiStoreConfig) return netlifyBlobs.getStore(apiStoreConfig);

    if (hasNetlifyBlobContext(event)) netlifyBlobs.connectLambda(event);

    // W14 T14.4, tried and REVERTED in the same session: passing
    // `{ name, consistency: 'strong' }` here fails live — "Netlify Blobs has
    // failed to perform a read using strong consistency because the
    // environment has not been configured": the lambda name-lookup context on
    // this runtime carries no uncached-edge URL, so strong reads are only
    // possible on the explicit-API path (NETLIFY_SITE_ID + a blobs-scoped
    // NETLIFY_BLOBS_TOKEN). CONSEQUENCE, stated plainly: on the name-lookup
    // path every store's requested 'strong' has ALWAYS been silently eventual
    // — for the whole fleet, Dr-Lurie included — and read-after-write can lag
    // tens of seconds. Callers that need a fresh dependent read (the genesis
    // seed drive's nav→site ordering) must wait-and-retry, or the site must
    // carry a blobs-scoped token to unlock the explicit-API path.
    return netlifyBlobs.getStore(storeName);
  }

  // W14 T14.4: FAIL CLOSED in a real function runtime. The file-backed store
  // exists for tests and local dev; in a production lambda it "works" for
  // reads (empty dir → empty list) and dies at the first write against the
  // read-only /var/task — which presented live as inventory returning [] and
  // every create 500ing, and cost a full debugging loop to attribute. The
  // trigger was runtime DETECTION failing (NETLIFY_SITE_ID unset on a freshly
  // provisioned site), and a detection failure must be loud, not a silent
  // switch to a test store.
  if (process.env.LAMBDA_TASK_ROOT || process.env.AWS_LAMBDA_FUNCTION_NAME) {
    throw new Error(
      `Netlify Blobs unavailable for store '${storeName}' in a production function runtime — ` +
        'refusing the file-backed test fallback. Set NETLIFY_SITE_ID on this site ' +
        '(create-site sets it automatically as of W14) or check the Blobs runtime context.'
    );
  }

  console.warn(`Using local file-backed ${storeName} blob store because @netlify/blobs is unavailable.`);

  return createLocalBlobStore(storeName);
};

export const getWorkflowBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'workflows', consistency: 'strong' }, event, binding);
};

export const getOptInBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore('opt-ins', event, binding);
};

/**
 * QA-W16-1: one strongly-consistent store for the idempotency-key bridge
 * (idempotency-store.ts). Keyed `idem:{tool}:{key}`, one record per
 * (tool, caller-supplied key) holding the FIRST successful result — a
 * same-key retry after a client-visible timeout/502 replays it instead of
 * re-running the write, even when the underlying write had already landed
 * server-side before the response could get back to the caller.
 */
export const getIdempotencyBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'idempotency', consistency: 'strong' }, event, binding);
};

export const getSiteObjectsBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'site-objects', consistency: 'strong' }, event, binding);
};

export const getArtifactBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'artifacts', consistency: 'strong' }, event, binding);
};

export const getArtifactIndexBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'artifact-index', consistency: 'strong' }, event, binding);
};

/**
 * Orders (06-shop-module-plan §5): orders/<idempotency-key>.json, written
 * create-if-absent by the Stripe webhook. Strong consistency — the success
 * page polls for the order the webhook just wrote, and fulfillment reissue
 * reads must see the latest reissue entries.
 */
export const getCommerceBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore({ name: 'commerce', consistency: 'strong' }, event, binding);
};

/**
 * Append-only commerce event log (06-shop-module-plan §6): one JSON per
 * event, never mutated or deleted. Eventual consistency is fine — nothing
 * reads it in v1; a future consumer ETLs the store.
 */
export const getCommerceEventsBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore('commerce-events', event, binding);
};

/** W13 (12-plan §5.3): the tracking-event mirror — replay substrate ONLY,
 *  never a reporting surface. */
export const getTrackingEventsBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore('tracking-events', event, binding);
};

/**
 * S4x (2/2): the tagged canvas Ask-AI proposal trail a save carries, one
 * record per save that followed an Ask-AI round. Write-mostly training data
 * for CMS Agent learning — never read by the object substrate, never part of
 * `history[].details`. Eventual consistency is fine; nothing reads it back live.
 */
export const getAgentLearningBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore('agent-learning', event, binding);
};

/**
 * W15 S4 (MVP): Marginalia — canvas commenting/annotation threads, anchored
 * to {objectType, objectId, sectionId?, nodeId?, field?, selectedText?}. A
 * dedicated side-channel store (the agent-learning precedent above): comments
 * must be postable by multiple people concurrently without taking the
 * content object's edit lock (object_patch's checkout/lock_token/
 * expected_record_version machinery), so threads/comments live independently
 * of the object substrate's lock/version/patch lifecycle. Eventual
 * consistency is fine — no CAS anywhere in this store; every write
 * (including resolve/dismiss) is an unconditional setJSON.
 */
export const getMarginaliaBlobStore = async (event: unknown, binding?: SiteBinding): Promise<BlobStore> => {
  return getNetlifyBlobStore('marginalia', event, binding);
};
