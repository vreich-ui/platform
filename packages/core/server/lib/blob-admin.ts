import { connectLambda, getStore, listStores, type Store } from '@netlify/blobs';

import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBinding, type SiteBindingEnvNames } from './site-binding.js';

// Centralized access to Netlify Blobs for the admin blob-manager tooling.
//
// Credential resolution mirrors netlify/lib/blob-store.ts: prefer explicit
// siteID + token from environment variables, otherwise fall back to the
// Lambda-injected blob context (event.blobs) that production functions receive.
//
// W14 finding F8: this module deliberately keeps its own direct
// `@netlify/blobs` import (it needs `listStores`, which blob-store.ts's
// narrower module type does not expose). It is NOT merged into blob-store.ts.
// The env-var NAMES it reads come from a SiteBinding like everywhere else —
// only the module import is local.

type ExplicitBlobsCredentials = {
  siteID: string;
  token: string;
  apiURL?: string;
};

type NetlifyLambdaEvent = {
  blobs?: unknown;
};

type BlobAdminModule = {
  connectLambda: typeof connectLambda;
  getStore: typeof getStore;
  listStores: typeof listStores;
};

let blobAdminModuleForTesting: Partial<BlobAdminModule> | undefined;

/**
 * Test seam mirroring blob-store.ts's `setNetlifyBlobsModuleForTesting`, so a
 * test can record exactly which credentials (or which name-lookup fallback)
 * a managed-store call resolved — the proof that a SiteBinding reached here.
 */
export const setBlobAdminModuleForTesting = (blobAdmin?: Partial<BlobAdminModule>) => {
  blobAdminModuleForTesting = blobAdmin;
};

const blobs = (): BlobAdminModule => ({
  connectLambda: blobAdminModuleForTesting?.connectLambda ?? connectLambda,
  getStore: blobAdminModuleForTesting?.getStore ?? getStore,
  listStores: blobAdminModuleForTesting?.listStores ?? listStores,
});

const hasNetlifyBlobContext = (event: unknown): event is NetlifyLambdaEvent =>
  Boolean(event && typeof event === 'object' && 'blobs' in event && (event as NetlifyLambdaEvent).blobs);

const getExplicitCredentials = (
  envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES
): ExplicitBlobsCredentials | undefined => {
  const siteID = readBoundEnv(envNames.blobSiteId);
  const token = readBoundEnv(envNames.blobToken);

  if (!siteID || !token) return undefined;

  const apiURL = readBoundEnv(envNames.blobApiUrl);

  return {
    siteID,
    token,
    ...(apiURL ? { apiURL } : {}),
  };
};

let lambdaContextConnected = false;

const ensureLambdaContext = (event: unknown) => {
  if (lambdaContextConnected) return;
  if (!hasNetlifyBlobContext(event)) return;

  // `hasNetlifyBlobContext` already verified the `blobs` context connectLambda
  // actually consumes; the strict @netlify/blobs `LambdaEvent` also wants
  // `headers`, which the blob path never reads (blob-store.ts does the same
  // connect through its looser module type). Cast to the param type so the
  // opt-in tsconfig — which type-checks the direct @netlify/blobs import —
  // compiles instead of rotting out of CI (W14 finding F8).
  blobs().connectLambda(event as Parameters<typeof connectLambda>[0]);
  lambdaContextConnected = true;
};

/** Test-only: forget the module-scope connect latch between recorded runs. */
export const resetBlobAdminLambdaContextForTesting = () => {
  lambdaContextConnected = false;
};

// Returns a strongly-consistent store handle so management operations (delete,
// rename, wipe) are reflected immediately on subsequent reads.
export const getManagedBlobStore = (storeName: string, event: unknown, binding?: SiteBinding): Store => {
  const credentials = getExplicitCredentials(binding?.env ?? PLATFORM_ENV_NAMES);

  if (credentials) {
    return blobs().getStore({ name: storeName, consistency: 'strong', ...credentials });
  }

  ensureLambdaContext(event);

  return blobs().getStore(storeName);
};

// Lists every site-level blob store name. Used to populate the store picker and
// to drive the "wipe all" operation.
export const listManagedBlobStores = async (event: unknown, binding?: SiteBinding): Promise<string[]> => {
  const credentials = getExplicitCredentials(binding?.env ?? PLATFORM_ENV_NAMES);

  if (credentials) {
    const { stores } = await blobs().listStores(credentials);
    return stores;
  }

  ensureLambdaContext(event);

  const { stores } = await blobs().listStores();
  return stores;
};
