/**
 * T1 (site-binding threading): every store/config seam in `lib/` now accepts a
 * binding (or its env-var names) and forwards it, so a REBOUND name set reaches
 * `readBoundEnv` instead of the hardcoded PLATFORM chain. These are the tiny
 * per-seam assertions; the end-to-end proof that a handler's binding reaches
 * the Netlify Blobs call lives in `functions/site-binding-threading.test.ts`.
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — agent/profiles.js reaches getSiteIdentity() at module load

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';

import { PLATFORM_ENV_NAMES, type SiteBinding, type SiteBindingEnvNames } from './site-binding.js';
import { getCoreBlobStoreSourceDiagnostics, setNetlifyBlobsModuleForTesting } from './blob-store.js';
import { getGovernanceBlobStore } from './governance-store.js';
import { getUsersBlobStore } from './users-store.js';
import { getMembershipStore } from './membership/store.js';
import { getAgentProfilesBlobStore } from './agent/profiles.js';
import { getAgentChatBlobStore } from './agent/chat-store.js';
import {
  getManagedBlobStore,
  listManagedBlobStores,
  setBlobAdminModuleForTesting,
  resetBlobAdminLambdaContextForTesting,
} from './blob-admin.js';
import { netlifyDeployLookupMissingEnvVars, netlifyBuildHookMissingEnvVars } from './netlify-deploys.js';

const BOUND_ENV: SiteBindingEnvNames = {
  ...PLATFORM_ENV_NAMES,
  blobSiteId: ['TEST_SEAM_SITE_ID'],
  blobToken: ['TEST_SEAM_TOKEN'],
  blobApiUrl: ['TEST_SEAM_API_URL'],
  buildHookUrl: ['TEST_SEAM_BUILD_HOOK'],
  deployLookupToken: ['TEST_SEAM_DEPLOY_TOKEN'],
};

const BINDING: SiteBinding = { siteId: 'site_seam_test', dataRoot: 'tmp/seam', env: BOUND_ENV };

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
  'NETLIFY_BUILD_HOOK_URL',
];

const savedEnv: Record<string, string | undefined> = {};
let calls: unknown[] = [];

const fakeStore = {
  get: async () => null,
  getMetadata: async () => null,
  set: async () => undefined,
  setJSON: async () => undefined,
  delete: async () => undefined,
  list: async () => ({ blobs: [] }),
};

before(() => {
  for (const name of [...PLATFORM_VARS, 'TEST_SEAM_SITE_ID', 'TEST_SEAM_TOKEN', 'TEST_SEAM_BUILD_HOOK', 'TEST_SEAM_DEPLOY_TOKEN']) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.NETLIFY = 'true';
  process.env.TEST_SEAM_SITE_ID = 'seam_site_id';
  process.env.TEST_SEAM_TOKEN = 'seam_token';

  setNetlifyBlobsModuleForTesting({
    connectLambda: () => {},
    getStore: (input) => {
      calls.push(input);
      return fakeStore as never;
    },
  });
  setBlobAdminModuleForTesting({
    connectLambda: () => {},
    getStore: ((input: unknown) => {
      calls.push(input);
      return fakeStore as never;
    }) as never,
    listStores: (async (input: unknown) => {
      calls.push(input);
      return { stores: [] };
    }) as never,
  });
});

after(() => {
  setNetlifyBlobsModuleForTesting(undefined);
  setBlobAdminModuleForTesting(undefined);
  resetBlobAdminLambdaContextForTesting();
  delete process.env.NETLIFY;
  delete process.env.TEST_SEAM_SITE_ID;
  delete process.env.TEST_SEAM_TOKEN;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  calls = [];
});

const boundSiteIds = () =>
  calls.filter((call): call is { siteID?: string } => typeof call === 'object' && call !== null).map((call) => call.siteID);

describe('lib store seams accept a SiteBinding and forward its env names', () => {
  const cases: [string, (event: unknown) => Promise<unknown>][] = [
    ['governance-store', (event) => getGovernanceBlobStore(event, BINDING)],
    ['users-store', (event) => getUsersBlobStore(event, BINDING)],
    ['membership/store', (event) => getMembershipStore(event, BINDING)],
    ['agent/profiles', (event) => getAgentProfilesBlobStore(event, BINDING)],
    ['agent/chat-store', (event) => getAgentChatBlobStore(event, BINDING)],
  ];

  for (const [name, call] of cases) {
    it(`${name}: the rebound blobSiteId reaches the store config`, async () => {
      await call({});
      assert.deepStrictEqual(boundSiteIds(), ['seam_site_id'], `${name} discarded the binding`);
    });
  }

  it('blob-store.getCoreBlobStoreSourceDiagnostics reads the rebound name', () => {
    const diagnostics = getCoreBlobStoreSourceDiagnostics({}, BINDING);
    assert.strictEqual(diagnostics.artifacts.source, 'explicit-api-config');
    assert.strictEqual(diagnostics.artifacts.siteId.envVar, 'TEST_SEAM_SITE_ID' as never);
  });

  it('blob-admin.getManagedBlobStore / listManagedBlobStores read the rebound names', async () => {
    getManagedBlobStore('governance', {}, BINDING);
    await listManagedBlobStores({}, BINDING);
    assert.deepStrictEqual(boundSiteIds(), ['seam_site_id', 'seam_site_id']);
  });
});

describe('lib config seams accept rebound env names', () => {
  it('netlify-deploys reports the REBOUND variable names as missing, not the platform ones', () => {
    assert.deepStrictEqual(netlifyBuildHookMissingEnvVars(BOUND_ENV), ['TEST_SEAM_BUILD_HOOK']);
    assert.deepStrictEqual(netlifyDeployLookupMissingEnvVars(BOUND_ENV), ['TEST_SEAM_DEPLOY_TOKEN']);
  });
});
