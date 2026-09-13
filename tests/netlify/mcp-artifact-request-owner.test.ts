/**
 * `resolveArtifactBridgeScope` after W1: an artifact request id may be owned
 * by ANY allowlisted CMS object, not only by a content_item.
 *
 * WHY THIS EXISTS. The resolver had exactly one lookup —
 * `object_get(content_item, request_id)` — so the request id and the article
 * id were the same fact. Everything that mints a request id without being an
 * article hit `artifact_request_not_found` on every media op no matter how
 * legitimate it was: a captured page's imagery (`req_capture_*`), a
 * visual_standard's example images (`req_visimg_*`). The fix is a registered
 * owner pointer, and these tests pin the five outcomes that matter:
 *
 *   1. content_item owner            -> unchanged, still passes
 *   2. registered ACTIVE page owner  -> passes
 *   3. registered but ARCHIVED owner -> artifact_request_not_found
 *   4. owner on ANOTHER site         -> artifact_request_scope_mismatch (NOT
 *                                       not_found: the request is real and
 *                                       its owner is known, the caller is on
 *                                       the wrong deployment)
 *   5. no owner at all               -> artifact_request_not_found, with a
 *                                       message that tells an operator what
 *                                       to DO about it
 *
 * "Passes" is asserted the way the sibling mismatch test asserts "refused":
 * by whether pdf-tool was reached at all. A scope refusal never reaches the
 * network, so reaching pdf-tool IS the resolver saying yes.
 *
 * Count the JOB create, not every upstream fetch: an image-generation job also
 * reads this project's image-model routing policy (`get_image_model_policy`)
 * before it creates anything, so a passing call makes two upstream requests,
 * not one. A refusal still makes zero — the scope wall precedes both.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import {
  OBJECT_STORE_MARKER_VALUE,
  objectRecordKey,
  objectStatusIndexKey,
} from '../../packages/core/server/lib/object-store-keys.js';
import {
  readRequestOwner,
  requestOwnerKey,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from '../../packages/core/server/lib/artifact-index.js';
import type { ArtifactReference } from '../../packages/core/server/lib/artifacts.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const CONTENT_ITEM_REQUEST_ID = 'req_agent_owner_content_item_20260910_01';
const CAPTURE_REQUEST_ID = 'req_capture_drlurie_20260910_01';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-artifact-request-owner');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-expose';
process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'run-secret-never-expose';

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  return (JSON.parse(response.body) as { result: ToolResult }).result;
};

const resetStores = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });
};

/**
 * Written straight into the object store rather than through object_create:
 * the resolver only ever does a `get`, which never validates the body, and a
 * real page body would drag in route/reference-integrity requirements that
 * have nothing to do with the ownership question under test.
 */
const seedObject = async (
  objectType: Parameters<typeof objectRecordKey>[0],
  objectId: string,
  site: string,
  status: string
) => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey(objectType, objectId), {
    object_id: objectId,
    object_type: objectType,
    schema_version: `${objectType}.v1`,
    site,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    status,
    body: { route: '/', sections: [] },
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const seedRequestOwner = async (requestId: string, owner: Record<string, unknown>) => {
  const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
  await store.setJSON(requestOwnerKey(requestId), {
    registered_at: '2026-09-10T00:00:00.000Z',
    registered_by: 'test',
    ...owner,
  });
};

const seedContentItem = async () => {
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: CONTENT_ITEM_REQUEST_ID,
    body: {
      slug: 'owner-content-item',
      title: 'An article that owns its own request',
      nodes: [
        {
          id: 'n_start',
          kind: 'content',
          public: { title: 'Owned', body: 'The content_item path, unchanged.' },
          visibility: 'public',
        },
      ],
    },
  });
  assert.ok(!created.isError, JSON.stringify(created.structuredContent));
};


/**
 * Self-healing ownership: the resolver derives an owner from the tenant's own
 * live objects when no pointer exists. These helpers stage the two halves of
 * that evidence — an artifact stored under the request, and an active object
 * whose body cites it.
 */
const ADOPT_SHA = 'c'.repeat(64);
const adoptBlobKey = (requestId: string) => `image/${requestId}/${ADOPT_SHA}.webp`;

const seedArtifactForRequest = async (requestId: string) => {
  const store = createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore;
  const reference: ArtifactReference = {
    blobKey: adoptBlobKey(requestId),
    sizeBytes: 1234,
    sha256: ADOPT_SHA,
    contentType: 'image/webp',
    createdAtISO: '2026-09-10T00:00:00.000Z',
    artifactKind: 'image' as ArtifactReference['artifactKind'],
  };
  await writeArtifactReferenceIndexes(store, requestId, reference);
};

const seedCitingPage = async (objectId: string, requestId: string, site = 'site_drlurie') => {
  const store = createLocalBlobStore('site-objects');
  // The evidence scan (collectReferencedArtifactKeys) walks
  // `objects/<type>/index/by-status/active/` and only THEN reads the record,
  // so a fixture that writes the record alone is invisible to it — which is
  // exactly what the first run of these tests proved.
  await store.set(objectStatusIndexKey('page', 'active', objectId), OBJECT_STORE_MARKER_VALUE);
  await store.setJSON(objectRecordKey('page', objectId), {
    object_id: objectId,
    object_type: 'page',
    schema_version: 'page.v1',
    site,
    created_at: '2026-09-10T00:00:00.000Z',
    updated_at: '2026-09-10T00:00:00.000Z',
    status: 'active',
    body: {
      route: `/${objectId}`,
      sections: [{ id: 's1', type: 'hero', image: { src: `/img/${requestId}/${ADOPT_SHA}.webp` } }],
    },
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const storedOwner = async (requestId: string) =>
  readRequestOwner(createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore, requestId);

const SCOPE_ERROR_CODES = new Set([
  'artifact_scope_required',
  'artifact_site_mismatch',
  'artifact_request_not_found',
  'artifact_request_scope_mismatch',
]);

/** The scope verdict carried on a refusal, or undefined when the wall passed. */
const scopeErrorCode = (result: ToolResult) => {
  const code = result.structuredContent?.error_code;
  return typeof code === 'string' && SCOPE_ERROR_CODES.has(code) ? code : undefined;
};

/** Runs one create_agent_artifact_job against a counting pdf-tool stub. */
const callBridge = async (requestId: string) => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: (body) => ({
      status: 202,
      body: {
        jobId: 'job-owner',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        artifactKind: body.artifactKind,
        polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const result = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: requestId,
      artifact_kind: 'image',
      operation: 'generate',
      prompt: 'A quiet editorial still life',
      filename: 'owner.webp',
      wait: false,
    });
    return {
      result,
      upstreamCalls: calls.length,
      jobCalls: calls.filter((call) => call.tool === 'create_agent_artifact_job').length,
    };
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('a content_item that owns its request id still resolves, with no owner pointer anywhere', async () => {
  await resetStores();
  await seedContentItem();

  const { result, jobCalls } = await callBridge(CONTENT_ITEM_REQUEST_ID);

  // The resolver's verdict is "was pdf-tool reached", not "did the whole job
  // succeed": a scope refusal never reaches the network at all.
  assert.equal(jobCalls, 1, 'the resolver passed and pdf-tool was reached');
  assert.equal(scopeErrorCode(result), undefined);
});

test('a registered ACTIVE page owner resolves a request no content_item answers for', async () => {
  await resetStores();
  await seedObject('page', 'page_home', 'site_drlurie', 'active');
  await seedRequestOwner(CAPTURE_REQUEST_ID, {
    object_type: 'page',
    object_id: 'page_home',
    site: 'site_drlurie',
  });

  const { result, jobCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(jobCalls, 1, 'the page owner passed the wall');
  assert.equal(scopeErrorCode(result), undefined);
});

test('an ARCHIVED owner does not resolve: a retired page cannot keep accepting new bytes', async () => {
  await resetStores();
  await seedObject('page', 'page_home', 'site_drlurie', 'archived');
  await seedRequestOwner(CAPTURE_REQUEST_ID, {
    object_type: 'page',
    object_id: 'page_home',
    site: 'site_drlurie',
  });

  const { result, upstreamCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  assert.equal(upstreamCalls, 0, 'refused before pdf-tool is called');
});

test('an owner on ANOTHER site is a scope mismatch, never a missing request', async () => {
  await resetStores();
  await seedObject('page', 'page_home', 'site_other', 'active');
  await seedRequestOwner(CAPTURE_REQUEST_ID, {
    object_type: 'page',
    object_id: 'page_home',
    site: 'site_other',
  });

  const { result, upstreamCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error_code, 'artifact_request_scope_mismatch');
  assert.equal(upstreamCalls, 0);
});

test('a registered owner that does not exist yet falls through to not_found', async () => {
  await resetStores();
  await seedRequestOwner(CAPTURE_REQUEST_ID, {
    object_type: 'page',
    object_id: 'page_never_created',
    site: 'site_drlurie',
  });

  const { result, upstreamCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  assert.equal(upstreamCalls, 0);
});

test('no owner at all: not_found, and the message says what to do about it', async () => {
  await resetStores();

  const { result, upstreamCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  const message = String(result.structuredContent?.error ?? '');
  assert.match(message, /No content object owns request/);
  assert.match(message, new RegExp(CAPTURE_REQUEST_ID));
  assert.match(message, /site_drlurie/);
  assert.match(message, /Register an owner/);
  assert.equal(upstreamCalls, 0);
});


test('ADOPTION: a legacy capture request with exactly one citing page resolves, and the pointer is written once', async () => {
  await resetStores();
  await seedArtifactForRequest(CAPTURE_REQUEST_ID);
  await seedCitingPage('page_adopted', CAPTURE_REQUEST_ID);

  assert.equal(await storedOwner(CAPTURE_REQUEST_ID), undefined, 'precondition: nothing owns it yet');

  const { result, jobCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(scopeErrorCode(result), undefined, JSON.stringify(result.structuredContent));
  assert.equal(jobCalls, 1, 'the bridge reached pdf-tool, so the wall let it through');

  // The derivation is PERSISTED, so the scan is paid once and never again.
  const owner = await storedOwner(CAPTURE_REQUEST_ID);
  assert.equal(owner?.object_type, 'page');
  assert.equal(owner?.object_id, 'page_adopted');
  assert.equal(owner?.site, 'site_drlurie');
});

test('ADOPTION refuses to guess: two citing objects stay not_found, with the shortlist on the error', async () => {
  await resetStores();
  await seedArtifactForRequest(CAPTURE_REQUEST_ID);
  await seedCitingPage('page_one', CAPTURE_REQUEST_ID);
  await seedCitingPage('page_two', CAPTURE_REQUEST_ID);

  const { result, upstreamCalls } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  assert.equal(result.structuredContent?.adoption_blocker, 'ambiguous_evidence');
  assert.equal((result.structuredContent?.adoption_candidates as unknown[])?.length, 2);
  assert.equal(upstreamCalls, 0);
  assert.equal(await storedOwner(CAPTURE_REQUEST_ID), undefined, 'an ambiguous request is never adopted');
});

test('ADOPTION says so when nothing cites the media: no_recorded_evidence, not a silent miss', async () => {
  await resetStores();
  await seedArtifactForRequest(CAPTURE_REQUEST_ID);

  const { result } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  assert.equal(result.structuredContent?.adoption_blocker, 'no_recorded_evidence');
  assert.equal(await storedOwner(CAPTURE_REQUEST_ID), undefined);
});

test('ADOPTION never re-points an existing owner: an ARCHIVED pointer is left exactly as registered', async () => {
  await resetStores();
  await seedArtifactForRequest(CAPTURE_REQUEST_ID);
  await seedCitingPage('page_adopted', CAPTURE_REQUEST_ID);
  await seedObject('page', 'page_retired', 'site_drlurie', 'archived');
  await seedRequestOwner(CAPTURE_REQUEST_ID, { object_type: 'page', object_id: 'page_retired', site: 'site_drlurie' });

  const { result } = await callBridge(CAPTURE_REQUEST_ID);

  assert.equal(result.structuredContent?.error_code, 'artifact_request_not_found');
  assert.equal(result.structuredContent?.adoption_blocker, undefined, 'adoption is not even attempted');

  const owner = await storedOwner(CAPTURE_REQUEST_ID);
  assert.equal(owner?.object_id, 'page_retired', 'the curated pointer survives, live evidence notwithstanding');
});
