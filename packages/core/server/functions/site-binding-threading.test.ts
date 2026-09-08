/**
 * T3 PROOF (site-binding threading): a handler built with `createHandler(binding)`
 * must reach the Netlify Blobs API with THAT BINDING's credentials.
 *
 * How it proves it: the binding under test rebinds `blobSiteId`/`blobToken` to
 * env-var names nothing else in the repo reads (`TEST_BOUND_*`), and the
 * platform names (NETLIFY_SITE_ID/SITE_ID/NETLIFY_BLOBS_TOKEN/NETLIFY_AUTH_TOKEN)
 * are unset for the duration. A bound call therefore lands on blob-store's
 * explicit-API path and the recorder sees an OPTIONS OBJECT carrying
 * `siteID: 'site_test_id'`. A handler that DISCARDS its binding falls through to
 * the lambda name-lookup and the recorder sees a bare STRING — which is exactly
 * the defect this file exists to keep out (see the negative control at the end).
 *
 * Companion: `lib/site-binding-seams.test.ts` (per-seam signatures).
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — several handler import chains reach getSiteIdentity()

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

import { PLATFORM_ENV_NAMES, type SiteBinding } from '../lib/site-binding.js';
import { setNetlifyBlobsModuleForTesting, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { setBlobAdminModuleForTesting, resetBlobAdminLambdaContextForTesting } from '../lib/blob-admin.js';
import { setStripeClientForTesting, resetStripeClientForTesting } from '../lib/stripe-env.js';
import { mintPurchaseToken } from '../lib/purchase-tokens.js';

import { createHandler as createGetPublicImage } from './get-public-image.js';
import { createHandler as createGetPublicPdf } from './get-public-pdf.js';
import { createHandler as createSaveCommerceEvent } from './save-commerce-event.js';
import { createHandler as createTrackIngest } from './track-ingest.js';
import { createHandler as createCheckoutSessionStatus } from './checkout-session-status.js';
import { createHandler as createClaimFree } from './claim-free.js';
import { createHandler as createGetPurchase } from './get-purchase.js';
import { createHandler as createAdminInventory } from './admin-inventory.js';
import { createHandler as createAdminAudit } from './admin-audit.js';
import { createHandler as createAdminAuthState } from './admin-auth-state.js';
import { createHandler as createAdminGetBlobImage } from './admin-get-blob-image.js';
import { createHandler as createAdminListBlobImages } from './admin-list-blob-images.js';
import { createHandler as createAdminTaxonomy } from './admin-taxonomy.js';
import { createHandler as createMcpOauth } from './mcp-oauth.js';
import { createHandler as createSaveArtifact } from './save-artifact.js';
import { createHandler as createAdminAgentChat } from './admin-agent-chat.js';
import { createHandler as createObjectStore } from './object-store.js';
import { createHandler as createDeployStatus } from './deploy-status.js';
import { handler as mcpHandler, configureMcp } from './mcp.js';

const BOUND_SITE_ID = 'site_test_id';

const binding: SiteBinding = {
  siteId: 'site_test',
  dataRoot: 'tmp',
  env: {
    ...PLATFORM_ENV_NAMES,
    blobSiteId: ['TEST_BOUND_SITE_ID'],
    blobToken: ['TEST_BOUND_TOKEN'],
    blobApiUrl: ['TEST_BOUND_BLOBS_API_URL'],
    publishSecret: ['TEST_BOUND_PUBLISH_SECRET'],
  },
};

const PLATFORM_VARS = [
  'NETLIFY_SITE_ID',
  'SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_API_URL',
];
const OWNED_VARS = [
  'NETLIFY',
  'ADMIN_EMAILS',
  'TEST_BOUND_SITE_ID',
  'TEST_BOUND_TOKEN',
  'TEST_BOUND_PUBLISH_SECRET',
  'URL',
  'IDENTITY_URL',
  'PURCHASE_TOKEN_SECRET',
  // mcp.ts's shared-secret gate: left UNSET so getAuthResult()'s
  // non-lambda-runtime fallback opens the gate for the mcp test case below —
  // owned here so before()/after() clear and restore it like everything else.
  'MCP_HTTP_AUTH_TOKEN',
];

const ADMIN_EMAIL = 'binding-proof@example.com';
const PURCHASE_TOKEN_TEST_SECRET = 'binding-proof-purchase-token-secret';
const savedEnv: Record<string, string | undefined> = {};
let calls: unknown[] = [];

const fakeStore = {
  get: async () => null,
  getMetadata: async () => null,
  getWithMetadata: async () => null,
  set: async () => undefined,
  setJSON: async () => undefined,
  delete: async () => undefined,
  // save-artifact.ts calls store.del() (not .delete()) on the failed-readback
  // path when the fake store's get() can't read back what it just "wrote" —
  // stub it so that path 5xxs cleanly instead of throwing a TypeError that
  // would abort the case before the shared assertion runs.
  del: async () => undefined,
  list: async () => ({ blobs: [], directories: [] }),
};

const record = (input: unknown) => {
  calls.push(input);
  return fakeStore as never;
};

const originalFetch = globalThis.fetch;

before(() => {
  for (const name of [...PLATFORM_VARS, ...OWNED_VARS]) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
  process.env.NETLIFY = 'true';
  process.env.TEST_BOUND_SITE_ID = BOUND_SITE_ID;
  process.env.TEST_BOUND_TOKEN = 'tok';
  process.env.TEST_BOUND_PUBLISH_SECRET = 'publish-secret-under-test';
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;
  process.env.URL = 'https://example.test';
  process.env.PURCHASE_TOKEN_SECRET = PURCHASE_TOKEN_TEST_SECRET;

  setNetlifyBlobsModuleForTesting({ connectLambda: () => {}, getStore: record });
  setBlobAdminModuleForTesting({
    connectLambda: () => {},
    getStore: record as never,
    listStores: (async (input: unknown) => {
      calls.push(input);
      return { stores: [] };
    }) as never,
  });

  // admin-taxonomy resolves admin access WITHOUT a Lambda clientContext, so it
  // authenticates through the GoTrue /user fallback. Stub that one hop.
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes('/.netlify/identity/user')) {
      return new Response(JSON.stringify({ id: 'user_1', email: ADMIN_EMAIL }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('{}', { status: 500 });
  }) as typeof fetch;
});

after(() => {
  setNetlifyBlobsModuleForTesting(undefined);
  setBlobAdminModuleForTesting(undefined);
  resetBlobAdminLambdaContextForTesting();
  globalThis.fetch = originalFetch;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

beforeEach(() => {
  calls = [];
});

const adminContext = { clientContext: { user: { sub: 'user_1', email: ADMIN_EMAIL } } };
const adminHeaders = { authorization: 'Bearer test-token' };

// admin-auth-state's only conditional store call is the users store lookup
// inside resolveRolesFromEvent — but a bootstrap ADMIN_EMAILS principal (like
// `adminContext` above) short-circuits role resolution BEFORE that store is
// ever touched (roles.ts: bootstrap owners return early). A signed-in human
// who is NOT a bootstrap owner falls through to the store-backed lookup, so
// this case needs its own identity distinct from ADMIN_EMAIL.
const NON_OWNER_EMAIL = 'binding-proof-non-owner@example.com';
const nonOwnerAdminContext = { clientContext: { user: { sub: 'user_2', email: NON_OWNER_EMAIL } } };

const ARTIFACT_PAYLOAD = Buffer.from('proof');
const ARTIFACT_PAYLOAD_SHA256 = createHash('sha256').update(ARTIFACT_PAYLOAD).digest('hex');

/**
 * Every recorded getStore call must be the explicit-API OPTIONS OBJECT built
 * from the REBOUND names. A bare string is the discarded-binding failure mode.
 */
const assertEveryCallCarriesTheBoundSiteId = (label: string) => {
  assert.ok(calls.length > 0, `${label}: no blob store was opened — the handler never reached a store`);
  for (const call of calls) {
    assert.strictEqual(
      typeof call,
      'object',
      `${label}: a store was opened by NAME LOOKUP (${JSON.stringify(call)}) — the binding was discarded`
    );
    assert.strictEqual(
      (call as { siteID?: string }).siteID,
      BOUND_SITE_ID,
      `${label}: a store was opened with the wrong siteID — the binding was discarded`
    );
  }
};

type Case = { name: string; run: () => Promise<unknown> };

const SHA = 'a'.repeat(64);

const cases: Case[] = [
  {
    name: 'get-public-image',
    run: () =>
      createGetPublicImage(binding)({
        httpMethod: 'GET',
        queryStringParameters: { blobKey: `image/req_a/${SHA}.png` },
      }),
  },
  {
    name: 'get-public-pdf',
    run: () =>
      createGetPublicPdf(binding)({ httpMethod: 'GET', queryStringParameters: { blobKey: `pdf/req_a/${SHA}.pdf` } }),
  },
  {
    // save-commerce-event.ts only accepts the client-authored event types
    // (product_viewed | checkout_started) and requires a real prod_… id
    // (isObjectIdForType) — `{ event: 'view', path: '/x' }` satisfies neither
    // and 400s at the type/product_id gate before any store is opened.
    name: 'save-commerce-event',
    run: () =>
      createSaveCommerceEvent(binding)({
        httpMethod: 'POST',
        body: JSON.stringify({ type: 'product_viewed', product_id: 'prod_1' }),
      }),
  },
  {
    // track-ingest.ts requires a real tracking_batch.v1 body (trackingBatchSchema:
    // `schema: 'tracking_batch.v1'` + events[]) with at least one event that
    // survives clientTrackingEventSchema (event_id/ts/event/url/consent) — the
    // store is only opened once >=1 event is accepted.
    name: 'track-ingest',
    run: () =>
      createTrackIngest(binding)({
        httpMethod: 'POST',
        headers: {},
        body: JSON.stringify({
          schema: 'tracking_batch.v1',
          events: [
            {
              event_id: '11111111-1111-4111-8111-111111111111',
              ts: new Date().toISOString(),
              event: 'pageview',
              url: { path: '/x' },
              consent: { analytics: true, ads: false, gpc: false },
            },
          ],
        }),
      }),
  },
  {
    // checkout-session-status.ts 503s before opening any store when
    // getStripeClient() has no key configured, then calls
    // stripe.checkout.sessions.retrieve(...) BEFORE the first store getter —
    // inject the test seam so that resolves without a real network call.
    name: 'checkout-session-status',
    run: async () => {
      setStripeClientForTesting({
        checkout: { sessions: { retrieve: async (id: string) => ({ id, payment_status: 'unpaid' }) } },
      });
      try {
        return await createCheckoutSessionStatus(binding)({
          httpMethod: 'GET',
          queryStringParameters: { session_id: 'cs_1' },
        });
      } finally {
        resetStripeClientForTesting();
      }
    },
  },
  {
    // claim-free.ts reads `product_id` (snake_case) — `productId` never
    // populates it, so the id gate 400s before getSiteObjectsBlobStore (the
    // handler's first store call, opened unconditionally once the id parses).
    name: 'claim-free',
    run: () =>
      createClaimFree(binding)({
        httpMethod: 'POST',
        body: JSON.stringify({ product_id: 'prod_1', email: 'buyer@example.com' }),
      }),
  },
  {
    // get-purchase.ts 503s when PURCHASE_TOKEN_SECRET is unset, then rejects
    // any token that doesn't verify (signature + expiry) before ever opening
    // the commerce store — mint a real token with the same secret the
    // handler reads.
    name: 'get-purchase',
    run: () => {
      const token = mintPurchaseToken(
        { order_key: 'ord_1', artifact_ref: 'artifacts/req_a/deadbeef.pdf', exp: Date.now() + 60_000 },
        PURCHASE_TOKEN_TEST_SECRET
      );
      return createGetPurchase(binding)({ httpMethod: 'GET', queryStringParameters: { token } });
    },
  },
  {
    name: 'admin-inventory',
    run: () =>
      createAdminInventory(binding)(
        { httpMethod: 'POST', headers: adminHeaders, body: JSON.stringify({ action: 'search', query: 'x' }) },
        adminContext
      ),
  },
  {
    name: 'admin-audit',
    run: () => createAdminAudit(binding)({ httpMethod: 'POST', headers: adminHeaders, body: '{}' }, adminContext),
  },
  {
    // A bootstrap-owner identity (adminContext) resolves to [owner,admin,publisher]
    // WITHOUT touching the users store (roles.ts short-circuits on ADMIN_EMAILS
    // membership), so this handler's only store call never fires for it — use a
    // signed-in identity that is NOT in ADMIN_EMAILS so role resolution falls
    // through to the store-backed lookup.
    name: 'admin-auth-state',
    run: () => createAdminAuthState(binding)({ httpMethod: 'GET', headers: adminHeaders }, nonOwnerAdminContext),
  },
  {
    name: 'admin-get-blob-image',
    run: () =>
      createAdminGetBlobImage(binding)(
        { httpMethod: 'GET', headers: adminHeaders, queryStringParameters: { blobKey: `image/req_a/${SHA}.png` } },
        adminContext
      ),
  },
  {
    name: 'admin-list-blob-images',
    run: () => createAdminListBlobImages(binding)({ httpMethod: 'GET', headers: adminHeaders }, adminContext),
  },
  {
    name: 'admin-taxonomy',
    run: () => createAdminTaxonomy(binding)({ httpMethod: 'GET', headers: adminHeaders }),
  },
  {
    name: 'mcp-oauth',
    run: () =>
      createMcpOauth(binding)(
        {
          httpMethod: 'POST',
          path: '/.netlify/functions/mcp-oauth',
          headers: {},
          queryStringParameters: { oauth_endpoint: 'register' },
          body: '{}',
        },
        undefined
      ),
  },
  {
    // uploadSchema rejects both fields the original body used: `requestId`
    // must match req_<flow>_<topic>_<yyyymmdd>_<nn> (agents-naming.ts), and
    // `artifactKind` must be one of artifactKindValues — 'text' isn't a
    // member (the list is image/pdf/video/doc/audio/data/attachment/other).
    // Either failure 400s before the artifact/index stores are opened.
    name: 'save-artifact',
    run: () =>
      createSaveArtifact(binding)({
        httpMethod: 'POST',
        headers: { 'x-publish-key': 'publish-secret-under-test' },
        body: JSON.stringify({
          requestId: 'req_binding_proof_20260908_01',
          artifactKind: 'other',
          contentType: 'text/plain',
          filename: 'proof.txt',
          encoding: 'base64',
          payload: ARTIFACT_PAYLOAD.toString('base64'),
          expectedSizeBytes: ARTIFACT_PAYLOAD.byteLength,
          expectedSha256: ARTIFACT_PAYLOAD_SHA256,
        }),
      }),
  },
  {
    // admin-agent-chat.ts opens its `agent-chat` blob store unconditionally
    // right after the POST + admin-auth gates clear (before the action
    // switch) — `list_chats` is the cheapest action body that satisfies the
    // request schema and reaches it. `adminContext` is a bootstrap-owner
    // identity (ADMIN_EMAILS), which short-circuits role resolution without
    // ever touching the users store — fine here since the chat store call is
    // unconditional and is what this case is proving.
    name: 'admin-agent-chat',
    run: () =>
      createAdminAgentChat(binding)(
        {
          httpMethod: 'POST',
          headers: adminHeaders,
          body: JSON.stringify({ action: 'list_chats' }),
        },
        adminContext
      ),
  },
  {
    // mcp.ts's `McpSiblingHandlers` now requires a `binding` field alongside
    // its three sibling handlers — build all four from the SAME test binding
    // via configureMcp(), then drive a real JSON-RPC tools/call. With
    // MCP_HTTP_AUTH_TOKEN unset and this process not looking like a Lambda
    // runtime, getAuthResult()'s dev/test fallback opens the auth gate.
    // `membership_status` is a read-class tool (skips preflightToolCall's
    // rate-limit/governance-store path entirely) that reaches the users
    // store via requireBinding() — proving the injected binding, not just
    // that SOME binding was threaded through ensureMcpSiblings elsewhere.
    name: 'mcp tool call (membership_status)',
    run: () => {
      configureMcp({
        binding,
        saveArtifactHandler: createSaveArtifact(binding),
        objectStoreHandler: createObjectStore(binding),
        deployStatusHandler: createDeployStatus(binding),
      });
      return mcpHandler({
        httpMethod: 'POST',
        headers: {},
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'membership_status', arguments: {} },
        }),
      });
    },
  },
];

describe('every handler opens its blob stores with the binding it was built from', () => {
  for (const testCase of cases) {
    it(`${testCase.name}: the rebound siteID reaches @netlify/blobs`, async () => {
      await testCase.run();
      assertEveryCallCarriesTheBoundSiteId(testCase.name);
    });
  }
});

describe('negative control', () => {
  it('a handler that DISCARDS its binding is detected (a bare string reaches getStore)', async () => {
    const discardingCreateHandler = (_binding: SiteBinding) => async (event: unknown) => {
      await getSiteObjectsBlobStore(event);
      return { statusCode: 200 };
    };

    await discardingCreateHandler(binding)({});

    assert.ok(calls.length > 0, 'the recorder saw no call at all');
    assert.ok(
      calls.some((call) => typeof call === 'string'),
      'the recorder must see a bare string name-lookup for a discarded binding — otherwise this suite cannot detect the defect'
    );
    assert.throws(
      () => assertEveryCallCarriesTheBoundSiteId('negative-control'),
      /binding was discarded/,
      'the shared assertion must reject the discarded-binding shape'
    );
  });
});

/**
 * T5 check 5 — "live sites are unchanged". Every site in the fleet binds
 * `env: PLATFORM_ENV_NAMES`, so with the PLATFORM variables set, a threaded
 * binding must resolve to exactly the same credentials the pre-threading code
 * resolved. This is the regression that would matter in production, so it is a
 * standing test rather than a one-off manual run.
 */
describe('live-site equivalence', () => {
  it('with env: PLATFORM_ENV_NAMES set, the recorded siteID is NETLIFY_SITE_ID', async () => {
    const platformBinding: SiteBinding = { siteId: 'site_platform', dataRoot: 'tmp', env: PLATFORM_ENV_NAMES };

    process.env.NETLIFY_SITE_ID = 'live_site_id';
    process.env.NETLIFY_BLOBS_TOKEN = 'live_token';
    try {
      await createGetPublicImage(platformBinding)({
        httpMethod: 'GET',
        queryStringParameters: { blobKey: `image/req_a/${SHA}.png` },
      });

      assert.ok(calls.length > 0, 'no blob store was opened');
      for (const call of calls) {
        assert.strictEqual(typeof call, 'object', 'the explicit-API path must still be taken on a platform binding');
        assert.strictEqual((call as { siteID?: string }).siteID, 'live_site_id');
        assert.strictEqual((call as { token?: string }).token, 'live_token');
      }
    } finally {
      delete process.env.NETLIFY_SITE_ID;
      delete process.env.NETLIFY_BLOBS_TOKEN;
    }
  });
});
