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
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { requestOwnerKey, type ArtifactIndexStore } from '../../packages/core/server/lib/artifact-index.js';
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
