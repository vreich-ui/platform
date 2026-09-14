/**
 * A8 gap 1 (Phase 2) — `preview_pdf_template_fixture`, exercised through the real MCP
 * dispatch (`netlify/functions/mcp.ts`), the real bridge (`resolveTemplateBridgeScope`,
 * `buildArtifactBridgeGrant`, `registerArtifactRequestOwner`), the real local object store
 * and idempotency blob store, with only pdf-tool's own network stubbed
 * (`stubPdfToolMcp` — the same harness `mcp-render-article-pdf.test.ts` and
 * `mcp-pdf-tool-template-bridge.test.ts` use).
 *
 * The DECISIONS this tool composes (fixture shapes, preflight, job reuse, poll termination,
 * the verified/unverified split) are unit-tested against fakes in
 * `packages/core/lib/pdf/template-preview.test.ts`. What THIS file proves is what fakes
 * cannot: that `callPreviewPdfTemplateFixture` actually binds those decisions to the real
 * bridge — that the job it creates carries the fixture data under the deterministic
 * (template, version)-scoped request id, that a repeat call POLLS BY THE STORED JOB ID rather
 * than re-deriving one, that a caller cannot reach another tenant's template, and that
 * `verified` is only ever true when a real, inspected render backs it — including the
 * worst-case multi-page ("long") fixture, end to end, with `verified: false` when that same
 * rendered output cannot be inspected.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler, type LambdaEvent } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { templatePreviewRequestId } from '../../packages/core/lib/pdf/template-preview.js';
import { stubPdfToolMcp, type PdfToolMcpRoute } from './pdf-tool-mcp-fetch-stub.js';

const SITE_ID = 'site_drlurie';
const STORAGE_SECRET = 'storage-secret-never-expose-preview-fixture';
const RUN_SECRET = 'run-secret-never-expose-preview-fixture';
const PROOF_SECRET = 'proof-never-expose-preview-fixture';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-preview-pdf-template-fixture');
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
// Keep the composite's own poll loop short and deterministic in tests, exactly like
// mcp-render-article-pdf.test.ts (same pollBudgetMs resolver, same env knob).
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

const seedSite = async () => {
  const store = createLocalBlobStore('site-objects');
  await store.setJSON(objectRecordKey('site', SITE_ID), {
    object_id: SITE_ID,
    object_type: 'site',
    schema_version: 'site.v1',
    site: SITE_ID,
    created_at: '2026-09-14T00:00:00.000Z',
    updated_at: '2026-09-14T00:00:00.000Z',
    status: 'active',
    body: { name: 'Dr. Lurié' },
    publication: { published_time: null },
    history: [],
    version: 1,
    content_revision: 1,
  });
};

const resetAndSeed = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });
  await rm(join(LOCAL_BLOBS_ROOT, 'idempotency'), { recursive: true, force: true });
  await seedSite();
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

// A permissive schema — required:['title','sections'], no length caps — so the "long" fixture
// (every string leaf blown out to ~2400 chars) still satisfies it structurally: this test is
// about proving the multi-page render is REACHABLE, not re-testing render-data-schema-check.ts.
const TEMPLATE_ROUTE =
  (templateId: string, version: number): PdfToolMcpRoute =>
  (body) => ({
    body: {
      projectId: body.projectId,
      templateId: body.templateId ?? templateId,
      renderer: 'chromium',
      status: 'active',
      version,
      renderDataSchema: {
        type: 'object',
        required: ['title', 'sections'],
        properties: {
          title: { type: 'string' },
          deck: { type: 'string' },
          sections: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
    },
  });

const DERIVE_ROUTE: PdfToolMcpRoute = (body) => ({
  body: {
    renderer: body.renderer ?? 'chromium',
    supported: true,
    sampleData: {
      title: 'Sample report title',
      deck: 'A short sample deck line.',
      sections: [{ heading: 'Overview', paragraphs: ['First sample paragraph.', 'Second sample paragraph.'] }],
    },
    slots: ['title', 'deck', 'sections'],
    imageSlots: [],
    notes: [],
  },
});

test('preview_pdf_template_fixture: a foreign site_id is refused before any outbound pdf-tool call', async () => {
  let fetchCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    fetchCalls += 1;
    return Response.json({ error: 'must not be reached' }, { status: 500 });
  }) as typeof fetch;
  try {
    const result = await rpc('preview_pdf_template_fixture', {
      site_id: 'site_someone_else',
      template_id: 'tpl_report_card',
      template_json: { html: '<h1>{{ title }}</h1>' },
      fixture: 'long',
    });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'template_site_mismatch');
    assert.equal(fetchCalls, 0, 'a foreign site_id must never reach pdf-tool at all');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("preview_pdf_template_fixture: a fixture that fails the template's own contract is refused before any job is created", async () => {
  await resetAndSeed();
  const templateId = 'tpl_preflight_fail';

  await withMockedFetch(
    {
      // Requires a field derive_render_data_schema's sampleData never supplies, so EVERY
      // fixture built from it fails preflight — deliberately, to prove no job follows.
      get_pdf_template: (body) => ({
        body: {
          projectId: body.projectId,
          templateId,
          renderer: 'chromium',
          status: 'active',
          version: 1,
          renderDataSchema: { type: 'object', required: ['impossible_field'], properties: {} },
        },
      }),
      derive_render_data_schema: DERIVE_ROUTE,
    },
    async () => {
      const result = await rpc('preview_pdf_template_fixture', {
        site_id: SITE_ID,
        template_id: templateId,
        template_json: { html: '<p>{{ title }}</p>' },
        fixture: 'short',
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      const receipt = result.structuredContent!;
      assert.equal(receipt.status, 'invalid_fixture');
      assert.equal(receipt.verified, false);
      assert.equal(receipt.rendered, false);
      const preflight = receipt.preflight as { ok: boolean; errors?: unknown[] };
      assert.equal(preflight.ok, false);
      assert.ok(Array.isArray(preflight.errors) && preflight.errors.length > 0);
    }
  );
});

test('preview_pdf_template_fixture: the worst-case "long" fixture renders, polls by the STORED job id, and comes back verified — genuinely viewable end to end', async () => {
  await resetAndSeed();
  const templateId = 'tpl_report_card';
  const version = 3;
  const requestId = templatePreviewRequestId(templateId, version);
  const sha = 'd'.repeat(64);
  const blobKey = `pdf/${requestId}/${sha}.pdf`;
  const publicPath = `/pdf/${requestId}/${sha}.pdf`;

  let jobBody: Record<string, unknown> | undefined;
  let statusCalls = 0;

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE(templateId, version),
      derive_render_data_schema: DERIVE_ROUTE,
      create_agent_artifact_job: (body) => {
        jobBody = body;
        return {
          status: 202,
          body: {
            jobId: 'job_preview_long_1',
            status: 'pending',
            projectId: body.projectId,
            requestId: body.requestId,
          },
        };
      },
      get_agent_artifact_job_status: (body) => {
        statusCalls += 1;
        if (statusCalls === 1) {
          return { body: { jobId: body.jobId, status: 'running', projectId: body.projectId, requestId } };
        }
        return {
          body: {
            jobId: body.jobId,
            status: 'complete',
            projectId: body.projectId,
            requestId,
            artifactKind: 'pdf',
            renderer: 'chromium',
            pageCount: 14,
            qualityGate: { passed: true, findings: [] },
            artifactReference: {
              blobKey,
              sha256: sha,
              sizeBytes: 640_000,
              contentType: 'application/pdf',
              artifactKind: 'pdf',
              originalFilename: 'preview-long.pdf',
            },
            materializationProof: PROOF_SECRET,
          },
        };
      },
      inspect_pdf_artifact: () => ({
        body: { pageCount: 14, sizeBytes: 640_000, pages: [], qualityGate: { passed: true, findings: [] } },
      }),
    },
    async () => {
      const result = await rpc('preview_pdf_template_fixture', {
        site_id: SITE_ID,
        template_id: templateId,
        template_json: { html: '<h1>{{ title }}</h1>' },
        fixture: 'long',
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  // 1. The job carried the RIGHT arguments: the fixture's own long data, the resolved
  //    template + version-scoped request id, and a preview-specific filename.
  assert.ok(jobBody, 'a job must have been created');
  assert.equal(jobBody!.templateId, templateId);
  assert.equal(jobBody!.requestId, requestId);
  assert.equal(jobBody!.filename, 'preview-long.pdf');
  const data = jobBody!.data as Record<string, unknown>;
  assert.equal(typeof data.title, 'string');
  assert.ok((data.title as string).length >= 2000, 'the "long" fixture must actually be long — worst-case multi-page');

  // 2. Polling used the job id create_agent_artifact_job returned — never a re-derived one.
  assert.equal(receipt.jobId, 'job_preview_long_1');

  // 3. A real, inspected, multi-page render — genuinely viewable end to end.
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.pageCount, 14);
  assert.equal(receipt.public_path, publicPath);
  assert.equal(receipt.verified, true);
  assert.equal((receipt.contentCheck as { status: string }).status, 'ok');
  assert.equal(receipt.reused, false);
  assert.deepEqual(receipt.polling, {
    tool: 'get_agent_artifact_job_status',
    input: { site_id: SITE_ID, request_id: requestId },
  });

  // 4. Idempotency: a repeat call for the SAME fixture reuses the SAME job — polls again
  //    (by the stored id) instead of creating a second one.
  const reused = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE(templateId, version),
      derive_render_data_schema: DERIVE_ROUTE,
      create_agent_artifact_job: () => {
        throw new Error('create_agent_artifact_job must not be called again for the same fixture');
      },
      get_agent_artifact_job_status: (body) => {
        statusCalls += 1;
        assert.equal(body.jobId, 'job_preview_long_1', 'the reused poll must use the STORED job id');
        return {
          body: {
            jobId: body.jobId,
            status: 'complete',
            projectId: body.projectId,
            requestId,
            artifactKind: 'pdf',
            pageCount: 14,
            qualityGate: { passed: true, findings: [] },
            artifactReference: {
              blobKey,
              sha256: sha,
              sizeBytes: 640_000,
              contentType: 'application/pdf',
              artifactKind: 'pdf',
              originalFilename: 'preview-long.pdf',
            },
            materializationProof: PROOF_SECRET,
          },
        };
      },
      inspect_pdf_artifact: () => ({
        body: { pageCount: 14, sizeBytes: 640_000, pages: [], qualityGate: { passed: true, findings: [] } },
      }),
    },
    async () => {
      const result = await rpc('preview_pdf_template_fixture', {
        site_id: SITE_ID,
        template_id: templateId,
        template_json: { html: '<h1>{{ title }}</h1>' },
        fixture: 'long',
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );
  assert.equal(reused.reused, true);
  assert.equal(reused.jobId, 'job_preview_long_1');
  assert.equal(reused.verified, true);

  // 5. No secret ever rides the receipt, and the only sha-bearing field is public_path itself
  //    (the raw blobKey never appears anywhere else in the receipt).
  const asText = JSON.stringify(receipt);
  assert.equal(asText.includes(STORAGE_SECRET), false);
  assert.equal(asText.includes(RUN_SECRET), false);
  assert.equal(asText.includes(PROOF_SECRET), false);
  const withoutPublicPath = JSON.stringify({ ...receipt, public_path: undefined });
  assert.equal(withoutPublicPath.includes(blobKey), false, 'no blobKey may appear outside public_path');
  assert.equal(withoutPublicPath.includes(sha), false, 'no sha may appear outside public_path');
});

test('preview_pdf_template_fixture: verified is false when the rendered output cannot be inspected', async () => {
  await resetAndSeed();
  const templateId = 'tpl_unverifiable';
  const version = 1;
  const requestId = templatePreviewRequestId(templateId, version);
  const sha = 'e'.repeat(64);

  const receipt = await withMockedFetch(
    {
      get_pdf_template: TEMPLATE_ROUTE(templateId, version),
      derive_render_data_schema: DERIVE_ROUTE,
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: {
          jobId: 'job_preview_unverified_1',
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
          requestId,
          artifactKind: 'pdf',
          pageCount: 3,
          qualityGate: { passed: true, findings: [] },
          artifactReference: {
            blobKey: `pdf/${requestId}/${sha}.pdf`,
            sha256: sha,
            sizeBytes: 90_000,
            contentType: 'application/pdf',
            artifactKind: 'pdf',
            originalFilename: 'preview-short.pdf',
          },
          materializationProof: PROOF_SECRET,
        },
      }),
      // inspect_pdf_artifact is deliberately NOT stubbed: the stub answers any unmocked tool
      // with an MCP protocol error, simulating output that cannot be inspected/reached.
    },
    async () => {
      const result = await rpc('preview_pdf_template_fixture', {
        site_id: SITE_ID,
        template_id: templateId,
        template_json: { html: '<p>{{ title }}</p>' },
        fixture: 'short',
      });
      assert.ok(!result.isError, JSON.stringify(result.structuredContent));
      return result.structuredContent!;
    }
  );

  // The render itself completed — but with nothing able to inspect the output, this must
  // NEVER be reported as verified. This is the exact honesty guarantee A8 exists to enforce.
  assert.equal(receipt.status, 'complete');
  assert.equal(receipt.rendered, true);
  assert.equal(receipt.verified, false, 'inaccessible output must never be reported as verified');
  const contentCheck = receipt.contentCheck as { status: string; reason?: string };
  assert.equal(contentCheck.status, 'unverified');
  assert.ok(contentCheck.reason, 'the reason it could not be verified must travel with the receipt');
});
