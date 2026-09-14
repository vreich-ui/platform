/**
 * A8 gap 1 (Phase 2) — `document_render`, exercised through the real MCP dispatch, the real
 * object store, and pdf-tool's own network stubbed (`stubPdfToolMcp`).
 *
 * `document_render` is a thin adapter over `document-render.ts`'s `runDocumentRender`, which
 * itself delegates the create/poll/attach lifecycle to `article-pdf-render.ts`'s
 * `renderArticlePdf` — already proven end to end by `mcp-render-article-pdf.test.ts`. What
 * THIS file proves is what that coverage does not: that `callDocumentRender` binds the RIGHT
 * effects (owner record, site pdf defaults, template schema) to the real bridge; that a
 * foreign tenant is refused before any object-store or pdf-tool call; that an unsupported
 * owner type is refused by name; that each of `runDocumentRender`'s three `blocked` outcomes
 * (`no_template`, `no_mapper_for_kind`, `invalid_render_data`) is reachable through the real
 * dispatch and creates no job; and that a supported render — including a worst-case
 * multi-page one — really attaches, polling by the STORED job id.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, type LambdaEvent } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { stubPdfToolMcp, type PdfToolMcpRoute } from './pdf-tool-mcp-fetch-stub.js';

const SITE_ID = 'site_drlurie';
const REQUEST_ID = 'req_agent_document_render_20260914_01';
const STORAGE_SECRET = 'storage-secret-never-expose-document-render';
const RUN_SECRET = 'run-secret-never-expose-document-render';
const PROOF_SECRET = 'proof-never-expose-document-render';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-document-render');
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
process.env.PDF_RENDER_ARTICLE_WAIT_MS = '3000';

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, extra: Partial<LambdaEvent> = {}) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    ...extra,
  });
  assert.equal(response.statusCode, 200);
  return (JSON.parse(response.body) as { result: ToolResult }).result;
};

const DOC_BODY = {
  slug: 'document-render-fixture',
  title: 'Document Render Fixture',
  deck: 'A minimal article used to exercise the document_render bridge.',
  author: 'Test Author',
  nodes: [
    { id: 'n_lede', kind: 'content', visibility: 'public', public: { body: 'Lede paragraph text.' } },
    { id: 'n_close', kind: 'content', visibility: 'public', public: { title: 'Close', body: 'Closing paragraph.' } },
  ],
};

const seedSite = async (pdf?: Record<string, unknown>) => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', SITE_ID), {
    object_id: SITE_ID,
    object_type: 'site',
    schema_version: 'site.v1',
    site: SITE_ID,
    created_at: '2026-09-14T00:00:00.000Z',
    updated_at: '2026-09-14T00:00:00.000Z',
    status: 'active',
    body: {
      name: 'Dr. Lurié',
      brandTokens: { colors: { primary: '#2E5C42' }, fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' } },
      ...(pdf ? { pdf } : {}),
    },
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const resetAndSeed = async (pdf?: Record<string, unknown>) => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: SITE_ID,
    requested_id: REQUEST_ID,
    body: DOC_BODY,
  });
  assert.ok(!created.isError, JSON.stringify(created.structuredContent));
  await seedSite(pdf);
};

const withMockedFetch = async <T>(routes: Record<string, PdfToolMcpRoute>, run: () => Promise<T>): Promise<T> => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp(routes);
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    void calls;
  }
};

const readArticleNodes = async (): Promise<Record<string, unknown>[]> => {
  const store = createLocalBlobStore('site-objects');
  const raw = (await store.get(objectRecordKey('content_item', REQUEST_ID))) ?? '{}';
  const record = JSON.parse(raw) as { body?: { nodes?: Record<string, unknown>[] } };
  return record.body?.nodes ?? [];
};

// A permissive schema matching the default article mapper's own output shape
// (article-pdf-render.ts / pdf-render-data-mapper.ts): brand, title, sections required.
const TEMPLATE_ROUTE: PdfToolMcpRoute = (body) => ({
  body: {
    projectId: body.projectId,
    templateId: body.templateId,
    renderer: 'chromium',
    status: 'active',
    version: 1,
    renderDataSchema: {
      // `brand` is deliberately NOT required here: callDocumentRender's own documented
      // KNOWN LIMITATION (see mcp-tool-handlers.ts's callDocumentRender doc comment) is that
      // its pre-render validation runs the mapped data through this schema WITHOUT brand
      // injected (readSiteBrand is intentionally left unset) — a template that requires an
      // object brand slot would report a conservative false `blocked: invalid_render_data`
      // here, which is that documented, safe failure mode, not a bug this test should trip
      // over. `invalid_render_data` is exercised deliberately and separately below.
      type: 'object',
      required: ['title', 'sections'],
      properties: {
        brand: {},
        title: { type: 'string' },
        deck: { type: 'string' },
        sections: { type: 'array', minItems: 1, items: { type: 'object' } },
      },
    },
  },
});

const IMPOSSIBLE_SCHEMA_ROUTE: PdfToolMcpRoute = (body) => ({
  body: {
    projectId: body.projectId,
    templateId: body.templateId,
    renderer: 'chromium',
    status: 'active',
    version: 1,
    renderDataSchema: { type: 'object', required: ['impossible_field'], properties: {} },
  },
});

test('document_render: a foreign site_id is refused before any outbound pdf-tool call', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const result = await rpc('document_render', {
      site_id: 'site_someone_else',
      owner_object_type: 'content_item',
      owner_object_id: REQUEST_ID,
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'artifact_site_mismatch');
    assert.equal(fetchCalls, 0, 'a foreign site_id must never reach pdf-tool at all');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document_render: an unsupported owner_object_type is refused by name, with no object-store or pdf-tool call', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const result = await rpc('document_render', {
      site_id: SITE_ID,
      owner_object_type: 'page',
      owner_object_id: 'page_123',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'document_render_owner_type_unsupported');
    assert.match(String(JSON.stringify(result.structuredContent)), /page/);
    assert.equal(fetchCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document_render: no template_id and no site default is blocked as no_template, and creates no job', async () => {
  await resetAndSeed(); // no pdf block at all
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const result = await rpc('document_render', {
      site_id: SITE_ID,
      owner_object_type: 'content_item',
      owner_object_id: REQUEST_ID,
    });
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.outcome, 'blocked');
    assert.equal(result.structuredContent?.reason, 'no_template');
    assert.equal(fetchCalls, 0, 'a template resolution failure must never reach pdf-tool');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document_render: a kind with no registered mapper is blocked as no_mapper_for_kind, and creates no job', async () => {
  await resetAndSeed({ defaultTemplateId: 'article_brochure_v1' });

  await withMockedFetch({ get_pdf_template: TEMPLATE_ROUTE }, async () => {
    const result = await rpc('document_render', {
      site_id: SITE_ID,
      owner_object_type: 'content_item',
      owner_object_id: REQUEST_ID,
      document_kind: 'newsletter',
    });
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.outcome, 'blocked');
    assert.equal(result.structuredContent?.reason, 'no_mapper_for_kind');
    assert.match(String(result.structuredContent?.detail), /newsletter/);
  });
});

test("document_render: mapped data that fails the template's own contract is blocked as invalid_render_data, and creates no job", async () => {
  await resetAndSeed({ defaultTemplateId: 'article_brochure_v1' });

  const { calls, fetchImpl } = stubPdfToolMcp({ get_pdf_template: IMPOSSIBLE_SCHEMA_ROUTE });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    const result = await rpc('document_render', {
      site_id: SITE_ID,
      owner_object_type: 'content_item',
      owner_object_id: REQUEST_ID,
    });
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.outcome, 'blocked');
    assert.equal(result.structuredContent?.reason, 'invalid_render_data');
    assert.ok(Array.isArray(result.structuredContent?.errors));
    assert.equal(
      calls.some((call) => call.tool === 'create_agent_artifact_job'),
      false,
      'a blocked run must create no job'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('document_render: a supported render (worst-case multi-page) attaches, and polling used the STORED job id', async () => {
  await resetAndSeed({ defaultTemplateId: 'article_brochure_v1' });
  const sha = 'c'.repeat(64);
  const publicPath = `/pdf/${REQUEST_ID}/${sha}.pdf`;
  let jobBody: Record<string, unknown> | undefined;
  let statusCalls = 0;

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => {
        jobBody = body;
        return {
          status: 202,
          body: {
            jobId: 'job_document_render_1',
            status: 'pending',
            projectId: body.projectId,
            requestId: body.requestId,
          },
        };
      },
      get_agent_artifact_job_status: (body) => {
        statusCalls += 1;
        assert.equal(body.jobId, 'job_document_render_1', 'every poll must use the STORED job id');
        if (statusCalls === 1) {
          return { body: { jobId: body.jobId, status: 'pending', projectId: body.projectId, requestId: REQUEST_ID } };
        }
        return {
          body: {
            jobId: body.jobId,
            status: 'complete',
            projectId: body.projectId,
            requestId: REQUEST_ID,
            artifactKind: 'pdf',
            renderer: 'chromium',
            pageCount: 11,
            qualityGate: { passed: true, findings: [] },
            artifactReference: {
              blobKey: `pdf/${REQUEST_ID}/${sha}.pdf`,
              sha256: sha,
              sizeBytes: 900_000,
              contentType: 'application/pdf',
              artifactKind: 'pdf',
              originalFilename: 'document-render-fixture.pdf',
            },
            materializationProof: PROOF_SECRET,
          },
        };
      },
    },
    async () => {
      const result = await rpc('document_render', {
        site_id: SITE_ID,
        owner_object_type: 'content_item',
        owner_object_id: REQUEST_ID,
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  // Correct arguments reached pdf-tool: the RESOLVED site-default template, and the
  // owner's own id as the request id (the document IS the owner in this recipe).
  assert.ok(jobBody, 'a job must have been created');
  assert.equal(jobBody!.templateId, 'article_brochure_v1');
  assert.equal(jobBody!.requestId, REQUEST_ID);

  assert.equal(receipt.outcome, 'rendered');
  assert.equal(receipt.documentKind, 'article');
  assert.equal(receipt.templateId, 'article_brochure_v1');
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, true);
  assert.equal(receipt.jobId, 'job_document_render_1');
  assert.equal(receipt.pageCount, 11);
  assert.equal(receipt.public_path, publicPath);

  // The article really changed.
  const nodes = await readArticleNodes();
  const attached = nodes.find((node) => node.id === 'n_close');
  const media = (attached!.public as { media: Record<string, unknown> }).media;
  assert.equal(media.type, 'document');
  assert.equal(media.src, publicPath);

  const asText = JSON.stringify(receipt);
  assert.equal(asText.includes(STORAGE_SECRET), false);
  assert.equal(asText.includes(RUN_SECRET), false);
  assert.equal(asText.includes(PROOF_SECRET), false);
});

test('document_render: attach=false renders and leaves the article untouched', async () => {
  await resetAndSeed({ defaultTemplateId: 'article_brochure_v1' });

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: {
          jobId: 'job_document_render_dry',
          status: 'pending',
          projectId: body.projectId,
          requestId: body.requestId,
        },
      }),
      get_agent_artifact_job_status: (body) => ({
        body: {
          jobId: body.jobId,
          status: 'complete',
          projectId: body.projectId,
          requestId: REQUEST_ID,
          artifactKind: 'pdf',
          pageCount: 2,
          qualityGate: { passed: true, findings: [] },
          artifactReference: {
            blobKey: `pdf/${REQUEST_ID}/${'b'.repeat(64)}.pdf`,
            sha256: 'b'.repeat(64),
            sizeBytes: 120_000,
            contentType: 'application/pdf',
            artifactKind: 'pdf',
            originalFilename: 'document-render-fixture.pdf',
          },
          materializationProof: PROOF_SECRET,
        },
      }),
    },
    async () => {
      const result = await rpc('document_render', {
        site_id: SITE_ID,
        owner_object_type: 'content_item',
        owner_object_id: REQUEST_ID,
        attach: false,
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  assert.equal(receipt.outcome, 'rendered');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.attached, false);

  const nodes = await readArticleNodes();
  for (const node of nodes) {
    assert.equal((node.public as Record<string, unknown>).media, undefined, 'no node may have gained media');
  }
});
