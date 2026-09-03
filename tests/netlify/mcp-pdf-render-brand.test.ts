// FIX-3 (brand-imagery wave): create_agent_artifact_job fills data.brand from
// the site's brandTokens for a template-render pdf job, unless the caller
// already supplied one, and injects nothing for a site with no brandTokens.
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const REQUEST_ID = 'req_agent_pdf_render_brand_report_20260901_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-pdf-render-brand');
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

const rpc = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  return { response, result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

const resetAndSeedRequest = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: REQUEST_ID,
    body: {
      slug: 'pdf-render-brand-report',
      title: 'A PDF Report Built From a Template',
      nodes: [
        {
          id: 'n_start',
          kind: 'content',
          public: { title: 'Report', body: 'A report generated from a pdf-tool template.' },
          visibility: 'public',
        },
      ],
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
};

// Same seeding pattern as mcp-pdf-tool-bridge.test.ts's seedSiteRecord --
// writes the site.v1 record straight into the store a 'get' lookup reads
// from, bypassing object_create's reference-integrity requirements (which a
// bare 'get' lookup never validates).
const seedSiteRecord = async (body: Record<string, unknown>) => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', 'site_drlurie'), {
    object_id: 'site_drlurie',
    object_type: 'site',
    schema_version: 'site.v1',
    site: 'site_drlurie',
    created_at: '2026-08-10T00:00:00.000Z',
    updated_at: '2026-08-10T00:00:00.000Z',
    status: 'active',
    body,
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const BRAND_TOKENS = {
  colors: {
    primary: 'rgb(46 111 149)',
    accent: 'rgb(94 140 138)',
    'text-heading': 'rgb(22 26 29)',
    'text-default': 'rgb(36 41 46)',
    'text-muted': 'rgb(58 65 73 / 76%)',
    'bg-page': 'rgb(252 251 248)',
    'bg-surface': 'rgb(247 245 240)',
  },
  fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
};

const pendingArtifactJobRoute = (body: Record<string, unknown>) => ({
  status: 202,
  body: {
    jobId: 'job-pdf-render-brand',
    status: 'pending',
    projectId: body.projectId,
    requestId: body.requestId,
    artifactKind: body.artifactKind,
    polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
  },
});

test('create_agent_artifact_job injects data.brand from the site brandTokens for a template-render pdf job', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({
    name: 'Dr. Lurié',
    logo: { text: 'Dr. Lurié', imageAssetRef: 'image/site/logo-abc123.webp' },
    brandTokens: BRAND_TOKENS,
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({ create_agent_artifact_job: pendingArtifactJobRoute });
  globalThis.fetch = fetchImpl;
  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'pdf',
      filename: 'q3-report.pdf',
      template_id: 'tpl_article_brochure',
      data: { title: 'Q3 Report', total: '$4,200' },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    assert.deepEqual(jobCall!.body.data, {
      title: 'Q3 Report',
      total: '$4,200',
      // REVIEW: no `logo` — the site's imageAssetRef is a slashed platform
      // artifact key, which is not a pdf-tool assetId (see pdf-render-brand.ts).
      brand: { colors: BRAND_TOKENS.colors, fonts: BRAND_TOKENS.fonts },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('create_agent_artifact_job leaves a caller-supplied data.brand untouched', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié', brandTokens: BRAND_TOKENS });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({ create_agent_artifact_job: pendingArtifactJobRoute });
  globalThis.fetch = fetchImpl;
  try {
    const callerBrand = { colors: { primary: '#ffffff' }, fonts: { sans: 'Comic Sans', serif: 'x', heading: 'y' } };
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'pdf',
      filename: 'custom-report.pdf',
      template_id: 'tpl_article_brochure',
      data: { title: 'Custom', brand: callerBrand },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    assert.deepEqual(jobCall!.body.data, { title: 'Custom', brand: callerBrand });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('create_agent_artifact_job injects nothing when the site has no brandTokens', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié' });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({ create_agent_artifact_job: pendingArtifactJobRoute });
  globalThis.fetch = fetchImpl;
  try {
    const created = await rpc('create_agent_artifact_job', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      artifact_kind: 'pdf',
      filename: 'no-brand-report.pdf',
      template_id: 'tpl_article_brochure',
      data: { title: 'No brand yet' },
      wait: false,
    });
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    assert.deepEqual(jobCall!.body.data, { title: 'No brand yet' });
    assert.equal((jobCall!.body.data as Record<string, unknown>).brand, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
