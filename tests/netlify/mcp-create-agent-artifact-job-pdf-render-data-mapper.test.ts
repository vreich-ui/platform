// T2.2/D-2 wiring test (BRIEF-W2.md §3): the render-data-mapper hook inside
// callCreateAgentArtifactJob. Two halves:
//
//  - the SEAM, exercised with a hand-written fake mapper injected via
//    callCreateAgentArtifactJob's own `deps.pdfRenderDataMapper` parameter
//    (called directly, bypassing mcp.ts's dispatch, which has no way to pass
//    that argument in from outside);
//  - and, since W2 T2.3 closed JOIN A, the DEFAULT path with no fake at all:
//    T2.1's real mapper, through the real seam, all the way to the bytes
//    posted to pdf-tool. T2.2 could only assert that this path degraded
//    gracefully, because T2.1's module did not exist in its worktree and the
//    two never actually met (the loader looked for an export name the mapper
//    does not have). The test that asserted that degradation is now the test
//    that asserts the join.
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { callCreateAgentArtifactJob } from '../../packages/core/server/lib/mcp-tool-handlers.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';
import type { PdfRenderDataMapper } from '../../packages/core/lib/pdf/pdf-render-data-mapper-seam.js';

const SITE_ID = 'site_drlurie';
const REQUEST_ID = 'req_agent_pdf_render_data_mapper_report_20260901_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const LOCAL_BLOBS_ROOT = join(
  process.cwd(),
  '.netlify',
  'local-blobs-test',
  'mcp-create-agent-artifact-job-pdf-render-data-mapper'
);
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

// Only used to SEED the content_item through the real validated write path;
// the assertions below call callCreateAgentArtifactJob directly.
const rpc = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  return (JSON.parse(response.body) as { result: ToolResult }).result;
};

const CONTENT_ITEM_BODY = {
  slug: 'what-moisturizers-actually-do',
  title: 'What moisturizers actually do',
  nodes: [
    {
      id: 'n_start',
      kind: 'content',
      public: { title: 'Barrier repair', body: 'What moisturizers actually do to the skin barrier.' },
      visibility: 'public',
    },
  ],
};

const resetAndSeedRequest = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: SITE_ID,
    requested_id: REQUEST_ID,
    body: CONTENT_ITEM_BODY,
  });
  assert.ok(!created.isError, JSON.stringify(created.structuredContent));
};

const seedSiteRecord = async (body: Record<string, unknown>) => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', SITE_ID), {
    object_id: SITE_ID,
    object_type: 'site',
    schema_version: 'site.v1',
    site: SITE_ID,
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

const objectBrandTemplateRoute = (body: Record<string, unknown>) => ({
  body: {
    projectId: body.projectId,
    templateId: body.templateId,
    renderer: 'chromium',
    status: 'active',
    version: 1,
    renderDataSchema: {
      required: ['brand', 'title'],
      properties: {
        brand: { $ref: '#/$defs/brand' },
        title: { type: 'string' },
      },
      $defs: { brand: { type: 'object', properties: { colors: {}, fonts: {} } } },
    },
  },
});

const pendingArtifactJobRoute = (body: Record<string, unknown>) => ({
  status: 202,
  body: {
    jobId: 'job-render-data-mapper',
    status: 'pending',
    projectId: body.projectId,
    requestId: body.requestId,
    artifactKind: body.artifactKind,
    polling: { tool: 'get_agent_artifact_job_status', input: { projectId: body.projectId } },
  },
});

test('D-2: an omitted data with a template resolved runs the injected mapper, and its output still gets branded', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({
    name: 'Dr. Lurié',
    brandTokens: {
      colors: { primary: '#2E5C42' },
      fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
    },
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute,
    get_pdf_template: objectBrandTemplateRoute,
  });
  globalThis.fetch = fetchImpl;

  let mapperCalledWith: { contentItem: Record<string, unknown>; templateId: string } | undefined;
  const fakeMapper: PdfRenderDataMapper = async (input) => {
    mapperCalledWith = input;
    // The mapper is handed the RECORD (see the assertions below), so the
    // article's own fields are under `body` — exactly where buildRenderData
    // reads them from.
    const body = input.contentItem.body as Record<string, unknown>;
    return { ok: true, data: { title: body.title as string, deck: 'mapped by the fake' } };
  };

  try {
    const result = await callCreateAgentArtifactJob(
      {},
      {
        site_id: SITE_ID,
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        filename: 'mapped-report.pdf',
        template_id: 'tpl_article_brochure',
        wait: false,
        // data intentionally omitted -- this is exactly the D-2 trigger.
      },
      undefined,
      { pdfRenderDataMapper: fakeMapper }
    );
    assert.ok(!('isError' in result) || !result.isError, JSON.stringify(result));

    assert.ok(mapperCalledWith, 'the injected fake mapper must have been invoked');
    assert.equal(mapperCalledWith!.templateId, 'tpl_article_brochure');
    // W2 REVIEW: the whole RECORD, not just its body. `buildRenderData` accepts
    // either, but `publication.published_time` / `updated_at` — the only two
    // sources for the `date` slot — live on the record, not in the body. Handing
    // over the body alone made `date` permanently unfillable on the real render
    // path while `build_pdf_render_data`, which passes the record, filled it in
    // the preview: the tool that answers "what would this render as" disagreed
    // with what actually rendered.
    assert.equal(mapperCalledWith!.contentItem.object_id, REQUEST_ID, 'the record, not the bare body');
    assert.equal(
      (mapperCalledWith!.contentItem.body as Record<string, unknown>).slug,
      CONTENT_ITEM_BODY.slug,
      'and the article body is still reachable through it'
    );

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    assert.deepEqual(jobCall!.body.data, {
      title: 'What moisturizers actually do',
      deck: 'mapped by the fake',
      brand: { colors: { primary: '#2E5C42' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' } },
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D-2: the mapper\'s own deterministic refusal surfaces as a tool error, not a submitted job', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié' });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute,
    get_pdf_template: objectBrandTemplateRoute,
  });
  globalThis.fetch = fetchImpl;

  const refusingMapper: PdfRenderDataMapper = async () => ({
    ok: false,
    error: 'Cannot fill required slot: sections',
    errorCode: 'artifact_render_data_unfilled:sections',
  });

  try {
    const result = (await callCreateAgentArtifactJob(
      {},
      {
        site_id: SITE_ID,
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        filename: 'refused-report.pdf',
        template_id: 'tpl_article_brochure',
        wait: false,
      },
      undefined,
      { pdfRenderDataMapper: refusingMapper }
    )) as { isError?: boolean; structuredContent?: Record<string, unknown> };

    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'artifact_render_data_unfilled:sections');
    // No job was ever created -- the mapper's refusal short-circuits before
    // reaching pdf-tool.
    assert.equal(calls.some((call) => call.tool === 'create_agent_artifact_job'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('D-2: a caller-supplied data always wins -- the mapper is never invoked', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié' });

  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute,
    get_pdf_template: objectBrandTemplateRoute,
  });
  globalThis.fetch = fetchImpl;

  let mapperInvoked = false;
  const fakeMapper: PdfRenderDataMapper = async () => {
    mapperInvoked = true;
    return { ok: true, data: { title: 'should never be used' } };
  };

  try {
    const result = await callCreateAgentArtifactJob(
      {},
      {
        site_id: SITE_ID,
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        filename: 'caller-supplied-report.pdf',
        template_id: 'tpl_article_brochure',
        data: { title: 'Caller wrote this' },
        wait: false,
      },
      undefined,
      { pdfRenderDataMapper: fakeMapper }
    );
    assert.ok(!('isError' in result) || !result.isError, JSON.stringify(result));
    assert.equal(mapperInvoked, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('JOIN A: with no mapper injected, the REAL default mapper runs and its data reaches pdf-tool', async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({
    name: 'Dr. Lurié',
    brandTokens: {
      colors: { primary: '#2E5C42' },
      fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
    },
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute,
    get_pdf_template: objectBrandTemplateRoute,
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];
    const result = await callCreateAgentArtifactJob(
      { log: (payload) => logs.push(payload) },
      {
        site_id: SITE_ID,
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        filename: 'real-mapper-report.pdf',
        template_id: 'tpl_article_brochure',
        wait: false,
        // NO deps, NO fake: this is the production path.
      }
    );
    assert.ok(!('isError' in result) || !result.isError, JSON.stringify(result));

    // The defect this replaces: the default mapper was never reachable, so
    // this log line fired on every call and `data` was never mapped.
    assert.equal(
      logs.some((entry) => entry.event === 'pdf_render_data_mapper_unavailable'),
      false,
      'the default mapper must no longer be unavailable'
    );
    assert.ok(
      logs.some((entry) => entry.event === 'pdf_render_data_mapped'),
      'the default mapper must have actually run'
    );

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    // Real mapped data, shaped to THIS template's schema (which declares only
    // `brand` and `title`), with the site's brand merged in by D-3.
    assert.deepEqual(jobCall!.body.data, {
      title: 'What moisturizers actually do',
      brand: { colors: { primary: '#2E5C42' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' } },
    });

    // unfilled[] is surfaced on the response rather than dropped: this
    // template has no `sections` slot at all, and the caller is told so.
    const renderData = (result as ToolResult).structuredContent?.renderData as
      | { mapped: boolean; schemaSource: string; unfilled: string[] }
      | undefined;
    assert.ok(renderData, 'the response must carry the mapper report');
    assert.equal(renderData!.mapped, true);
    assert.equal(renderData!.schemaSource, 'template');
    assert.ok(renderData!.unfilled.includes('unsupported_slot:sections'));
    assert.ok(renderData!.unfilled.includes('missing:coverImage'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("JOIN A: the template's own renderDataSchema reaches the mapper, and the article's images become job assets", async () => {
  await resetAndSeedRequest();
  await seedSiteRecord({ name: 'Dr. Lurié' });

  // A template that declares the full article contract, with a deliberately
  // tight title limit -- proof the TEMPLATE's schema (not the generic
  // fallback) is what bound the mapping.
  const fullTemplateRoute = (body: Record<string, unknown>) => ({
    body: {
      projectId: body.projectId,
      templateId: body.templateId,
      renderer: 'chromium',
      status: 'active',
      version: 1,
      renderDataSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'sections'],
        properties: {
          title: { type: 'string', maxLength: 10 },
          coverImage: { $ref: '#/$defs/assetId' },
          sections: {
            type: 'array',
            maxItems: 24,
            items: {
              type: 'object',
              properties: {
                heading: { type: 'string' },
                paragraphs: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
        $defs: { assetId: { type: 'string', pattern: '^[a-zA-Z0-9._-]{1,128}$' } },
      },
    },
  });

  // Re-seed the article with a hero image so there is an asset to convert.
  const store = createLocalBlobStore('site-objects');
  const existing = JSON.parse(
    (await store.get(objectRecordKey('content_item', REQUEST_ID))) ?? '{}'
  ) as Record<string, unknown>;
  const heroSha = 'a'.repeat(64);
  await store.setJSON(objectRecordKey('content_item', REQUEST_ID), {
    ...existing,
    body: {
      ...(existing.body as Record<string, unknown>),
      image: { src: `/img/${REQUEST_ID}/${heroSha}.webp`, alt: 'hero' },
    },
  });

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    create_agent_artifact_job: pendingArtifactJobRoute,
    get_pdf_template: fullTemplateRoute,
  });
  globalThis.fetch = fetchImpl;

  try {
    const result = await callCreateAgentArtifactJob(
      {},
      {
        site_id: SITE_ID,
        request_id: REQUEST_ID,
        artifact_kind: 'pdf',
        filename: 'schema-bound-report.pdf',
        template_id: 'tpl_full',
        wait: false,
      }
    );
    assert.ok(!('isError' in result) || !result.isError, JSON.stringify(result));

    const jobCall = calls.find((call) => call.tool === 'create_agent_artifact_job');
    assert.ok(jobCall);
    const data = jobCall!.body.data as Record<string, unknown>;
    assert.equal((data.title as string).length <= 10, true, "cut to the TEMPLATE's own maxLength");
    assert.ok(Array.isArray(data.sections) && (data.sections as unknown[]).length > 0);

    // THE conversion the mapper exists for: /img/... became a job asset pair,
    // and the DATA slot carries the bare id, never the path.
    const assets = jobCall!.body.assets as { images: { assetId: string; blobKey: string }[] };
    assert.equal(assets.images.length, 1);
    assert.equal(assets.images[0]!.blobKey, `image/${REQUEST_ID}/${heroSha}.webp`);
    assert.equal(data.coverImage, assets.images[0]!.assetId);
    assert.equal(String(data.coverImage).includes('/'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
