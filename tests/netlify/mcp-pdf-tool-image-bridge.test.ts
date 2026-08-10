import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const REQUEST_ID = 'req_agent_image_search_bridge_hero_shot_20260810_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-pdf-tool-image-bridge');
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
process.env.PDF_TOOL_STORAGE_TOKEN = STORAGE_SECRET;
process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = RUN_SECRET;

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, logs: Array<Record<string, unknown>> = []) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    log: (payload) => logs.push(payload),
  });
  assert.equal(response.statusCode, 200);
  return { response, result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

const assertGrantNeverExposed = (visibleJson: string) => {
  assert.ok(!visibleJson.includes(STORAGE_SECRET));
  assert.ok(!visibleJson.includes(RUN_SECRET));
};

test('tools/list exposes all ten image-search and image-model bridge tools', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (JSON.parse(response.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
  const names = new Set(tools.map((tool) => tool.name));
  assert.ok(names.has('search_images'));
  assert.ok(names.has('import_image_from_url'));
  assert.ok(names.has('import_images_from_url'));
  assert.ok(names.has('get_image_search_policy'));
  assert.ok(names.has('set_image_search_policy'));
  assert.ok(names.has('get_image_search_bank'));
  assert.ok(names.has('update_image_search_candidate'));
  assert.ok(names.has('get_image_search_job_status'));
  assert.ok(names.has('get_image_model_policy'));
  assert.ok(names.has('set_image_model_policy'));
});

test('search_images starts a job through the bridge and never exposes the grant', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    search_images: (body) => ({
      status: 202,
      body: {
        jobId: 'job-image-search-1',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        query: body.query,
        polling: { tool: 'get_image_search_job_status', input: { projectId: body.projectId, jobId: 'job-image-search-1' } },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const searched = await rpc('search_images', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      query: 'a warm, natural-light hero shot of skincare bottles on a linen towel',
      count: 3,
      tags: ['hero', 'skincare'],
    });
    assert.ok(!searched.result.isError, JSON.stringify(searched.result.structuredContent));
    assert.equal(searched.result.structuredContent?.jobId, 'job-image-search-1');
    assert.equal(searched.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    const call = calls[0];
    assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
    assert.equal(call.body.projectId, 'dr-lurie');
    assert.equal(call.body.requestId, REQUEST_ID);
    assert.equal(call.body.query, 'a warm, natural-light hero shot of skincare bottles on a linen towel');
    assert.equal(call.body.count, 3);
    assert.deepEqual(call.body.tags, ['hero', 'skincare']);
    assert.equal((call.body.storage as { token: string }).token, STORAGE_SECRET);

    assertGrantNeverExposed(JSON.stringify(searched.response.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('get_image_search_job_status polls a search job through the bridge', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    get_image_search_job_status: (body) => ({
      body: {
        jobId: body.jobId,
        projectId: body.projectId,
        status: 'complete',
        result: { candidateCount: 3 },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const status = await rpc('get_image_search_job_status', { site_id: 'site_drlurie', job_id: 'job-image-search-1' });
    assert.ok(!status.result.isError, JSON.stringify(status.result.structuredContent));
    assert.equal(status.result.structuredContent?.status, 'complete');
    assert.equal(status.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.jobId, 'job-image-search-1');
    assertGrantNeverExposed(JSON.stringify(status.response.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('get_image_search_bank reads banked candidates through the bridge', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    get_image_search_bank: (body) => ({
      body: {
        projectId: body.projectId,
        bank: {
          requestId: body.requestId,
          candidates: [{ candidateId: 'cand_1', state: 'pending_review', score: 0.9 }],
        },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const bank = await rpc('get_image_search_bank', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      limit: 10,
      cursor: '0',
    });
    assert.ok(!bank.result.isError, JSON.stringify(bank.result.structuredContent));
    const bankBody = bank.result.structuredContent?.bank as { candidates: Array<{ candidateId: string }> };
    assert.equal(bankBody.candidates[0]?.candidateId, 'cand_1');
    assert.equal(bank.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.requestId, REQUEST_ID);
    assert.equal(calls[0].body.limit, 10);
    assert.equal(calls[0].body.cursor, '0');
    assertGrantNeverExposed(JSON.stringify(bank.response.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('update_image_search_candidate updates a candidate state through the bridge and logs it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    update_image_search_candidate: (body) => ({
      body: {
        projectId: body.projectId,
        candidate: { candidateId: body.candidateId, state: body.state },
        artifactDeleted: false,
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const updated = await rpc(
      'update_image_search_candidate',
      { site_id: 'site_drlurie', request_id: REQUEST_ID, candidate_id: 'cand_1', state: 'selected' },
      logs
    );
    assert.ok(!updated.result.isError, JSON.stringify(updated.result.structuredContent));
    const candidate = updated.result.structuredContent?.candidate as { state: string };
    assert.equal(candidate.state, 'selected');
    assert.equal(updated.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.candidateId, 'cand_1');
    assert.equal(calls[0].body.state, 'selected');
    assert.ok(logs.some((log) => log.event === 'image_search_bridge_candidate_updated'));
    assertGrantNeverExposed(JSON.stringify({ logs, updated: updated.response.body }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('import_image_from_url imports and banks a single image through the bridge and logs it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    import_image_from_url: (body) => ({
      body: {
        projectId: body.projectId,
        requestId: body.requestId,
        artifactReference: { blobKey: `image/${body.requestId}/${'a'.repeat(64)}.webp`, sha256: 'a'.repeat(64) },
        candidateId: 'cand_url_1',
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const imported = await rpc(
      'import_image_from_url',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        url: 'https://example.com/hero.jpg',
        label: 'Hero shot',
        license: { class: 'permissive', name: 'CC-BY', commercialUse: true },
      },
      logs
    );
    assert.ok(!imported.result.isError, JSON.stringify(imported.result.structuredContent));
    assert.equal(imported.result.structuredContent?.candidateId, 'cand_url_1');
    assert.equal(imported.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.equal(calls[0].body.url, 'https://example.com/hero.jpg');
    assert.deepEqual(calls[0].body.license, { class: 'permissive', name: 'CC-BY', commercialUse: true });
    assert.ok(logs.some((log) => log.event === 'image_search_bridge_url_import'));
    assertGrantNeverExposed(JSON.stringify({ logs, imported: imported.response.body }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('import_images_from_url starts a batch import job through the bridge and logs it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    import_images_from_url: (body) => ({
      status: 202,
      body: {
        jobId: 'job-url-import-1',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        urls: body.urls,
        polling: { tool: 'get_image_search_job_status', input: { projectId: body.projectId, jobId: 'job-url-import-1' } },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const urls = ['https://example.com/a.jpg', 'https://example.com/b.jpg'];
    const imported = await rpc(
      'import_images_from_url',
      { site_id: 'site_drlurie', request_id: REQUEST_ID, urls },
      logs
    );
    assert.ok(!imported.result.isError, JSON.stringify(imported.result.structuredContent));
    assert.equal(imported.result.structuredContent?.jobId, 'job-url-import-1');
    assert.equal(imported.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.urls, urls);
    assert.ok(logs.some((log) => log.event === 'image_search_bridge_url_import_batch'));
    assertGrantNeverExposed(JSON.stringify({ logs, imported: imported.response.body }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('get_image_search_policy reads the project policy through the bridge', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    get_image_search_policy: (body) => ({
      body: { projectId: body.projectId, policy: { candidateTarget: 5, providers: ['library', 'stock'] } },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const policy = await rpc('get_image_search_policy', { site_id: 'site_drlurie' });
    assert.ok(!policy.result.isError, JSON.stringify(policy.result.structuredContent));
    const policyBody = policy.result.structuredContent?.policy as { candidateTarget: number };
    assert.equal(policyBody.candidateTarget, 5);
    assert.equal(policy.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assertGrantNeverExposed(JSON.stringify(policy.response.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('set_image_search_policy writes the project policy through the bridge and logs it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    set_image_search_policy: (body) => ({
      body: { projectId: body.projectId, policy: body.policy },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const policyPatch = { candidateTarget: 3, quotas: { maxUrlImportsPerBatch: 10 } };
    const saved = await rpc('set_image_search_policy', { site_id: 'site_drlurie', policy: policyPatch }, logs);
    assert.ok(!saved.result.isError, JSON.stringify(saved.result.structuredContent));
    assert.deepEqual(saved.result.structuredContent?.policy, policyPatch);
    assert.equal(saved.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.policy, policyPatch);
    assert.ok(logs.some((log) => log.event === 'image_search_bridge_policy_set'));
    assertGrantNeverExposed(JSON.stringify({ logs, saved: saved.response.body }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('get_image_model_policy reads the project model routing policy through the bridge', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    get_image_model_policy: (body) => ({
      body: { projectId: body.projectId, policy: { byUsageContext: { article_header: { model: 'flux-2' } } } },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const policy = await rpc('get_image_model_policy', { site_id: 'site_drlurie' });
    assert.ok(!policy.result.isError, JSON.stringify(policy.result.structuredContent));
    const policyBody = policy.result.structuredContent?.policy as { byUsageContext: Record<string, unknown> };
    assert.deepEqual(policyBody.byUsageContext, { article_header: { model: 'flux-2' } });
    assert.equal(policy.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assertGrantNeverExposed(JSON.stringify(policy.response.body));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('set_image_model_policy writes the project model routing policy through the bridge and logs it', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    set_image_model_policy: (body) => ({
      body: { projectId: body.projectId, policy: body.policy },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const policyPatch = { byUsageContext: { article_header: { model: 'flux-2' } } };
    const saved = await rpc('set_image_model_policy', { site_id: 'site_drlurie', policy: policyPatch }, logs);
    assert.ok(!saved.result.isError, JSON.stringify(saved.result.structuredContent));
    assert.deepEqual(saved.result.structuredContent?.policy, policyPatch);
    assert.equal(saved.result.structuredContent?.siteId, 'site_drlurie');

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].body.policy, policyPatch);
    assert.ok(logs.some((log) => log.event === 'image_model_bridge_policy_set'));
    assertGrantNeverExposed(JSON.stringify({ logs, saved: saved.response.body }));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('set_image_search_policy surfaces an upstream 400 invalid-policy error unchanged', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    Response.json(
      { error: 'candidateTarget must be between 1 and 5.', errorCode: 'IMAGE_POLICY_INVALID' },
      { status: 400 }
    )) as typeof fetch;
  try {
    const saved = await rpc('set_image_search_policy', {
      site_id: 'site_drlurie',
      policy: { candidateTarget: 99 },
    });
    assert.equal(saved.result.isError, true);
    assert.equal(saved.result.structuredContent?.statusCode, 400);
    assert.equal(saved.result.structuredContent?.errorCode, 'IMAGE_POLICY_INVALID');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('rejects calls missing required arguments across the image bridge tools without any outbound fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const missingQuery = await rpc('search_images', { site_id: 'site_drlurie', request_id: REQUEST_ID });
    assert.equal(missingQuery.result.isError, true);

    const missingJobId = await rpc('get_image_search_job_status', { site_id: 'site_drlurie' });
    assert.equal(missingJobId.result.isError, true);

    const missingRequestId = await rpc('get_image_search_bank', { site_id: 'site_drlurie' });
    assert.equal(missingRequestId.result.isError, true);

    const badState = await rpc('update_image_search_candidate', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      candidate_id: 'cand_1',
      state: 'not_a_real_state',
    });
    assert.equal(badState.result.isError, true);

    const missingUrl = await rpc('import_image_from_url', { site_id: 'site_drlurie', request_id: REQUEST_ID });
    assert.equal(missingUrl.result.isError, true);

    const missingUrls = await rpc('import_images_from_url', { site_id: 'site_drlurie', request_id: REQUEST_ID });
    assert.equal(missingUrls.result.isError, true);

    const missingPolicy = await rpc('set_image_search_policy', { site_id: 'site_drlurie' });
    assert.equal(missingPolicy.result.isError, true);

    const missingModelPolicy = await rpc('set_image_model_policy', { site_id: 'site_drlurie' });
    assert.equal(missingModelPolicy.result.isError, true);

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('foreign site_id fails every image bridge tool with template_site_mismatch and makes zero outbound fetches', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalls = 0;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const search = await rpc('search_images', { site_id: 'site_other', request_id: REQUEST_ID, query: 'x' });
    assert.equal(search.result.isError, true);
    assert.equal(search.result.structuredContent?.error_code, 'template_site_mismatch');

    const getPolicy = await rpc('get_image_search_policy', { site_id: 'site_other' });
    assert.equal(getPolicy.result.isError, true);
    assert.equal(getPolicy.result.structuredContent?.error_code, 'template_site_mismatch');

    const getModelPolicy = await rpc('get_image_model_policy', { site_id: 'site_other' });
    assert.equal(getModelPolicy.result.isError, true);
    assert.equal(getModelPolicy.result.structuredContent?.error_code, 'template_site_mismatch');

    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
