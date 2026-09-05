/**
 * A5 — `admin-visual-identity-render-sample`: the PDF templates tab's
 * "Render sample" button as a deterministic endpoint instead of the
 * `create_agent_artifact_job` chat instruction (`buildRenderSampleIntent`,
 * visual-identity-pdf.ts), with pdf-tool stubbed at its MCP boundary
 * (pdf-tool-mcp-fetch-stub.ts). `PDF_JOB_INLINE_WAIT_MS=0` skips
 * `create_agent_artifact_job`'s own inline poll loop, so these tests pin the
 * CREATE call's payload without simulating a full pdf-tool render.
 *
 * What these pin:
 *   1. the endpoint reads the template's OWN sampleData with `get_pdf_template`
 *      and forwards exactly that as `data` to `create_agent_artifact_job`,
 *      with a server-minted `request_id` (never one the browser could send —
 *      there is no owning content_item for a template sample) and an
 *      explicit `pdf` artifact_kind + filename;
 *   2. a template with no sampleData is refused before any job is created;
 *   3. the ordinary role gate and a 404 on an unknown template id.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-visual-identity-render-sample.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp, type PdfToolMcpCall } from './pdf-tool-mcp-fetch-stub.js';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-visual-identity-render-sample');
setLocalBlobsRootForTesting(ROOT);

const EDITOR = { sub: 'editor-1', email: 'editor@example.com' };
const VIEWER = { sub: 'viewer-1', email: 'viewer@example.com' };

const prepareEnv = () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.ROLE_EMAILS_EDITOR = 'editor@example.com';
  process.env.ROLE_EMAILS_PUBLISHER = '';
  process.env.ROLE_EMAILS_ADMIN = '';
  process.env.PUBLISH_SECRET = 'test-publish-secret';
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-return';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'private-storage-site';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'bridge-secret-never-return';
  // Skip create_agent_artifact_job's own inline poll loop entirely — these
  // tests pin the CREATE call's payload, not a full pdf-tool render.
  process.env.PDF_JOB_INLINE_WAIT_MS = '0';
};

const post = (body: Record<string, unknown>, user = EDITOR) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { clientContext: { user } });

type RenderResponseBody = {
  error?: string;
  error_code?: string;
  template_id?: string;
  request_id?: string;
  jobId?: string;
  polling?: unknown;
  [key: string]: unknown;
};

const SAMPLE_DATA = { title: 'A Sample Article', body: 'Sample body copy.' };

const withStub = async (
  routes: Parameters<typeof stubPdfToolMcp>[0],
  run: (calls: PdfToolMcpCall[]) => Promise<void>
) => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp(routes);
  globalThis.fetch = fetchImpl;
  try {
    await run(calls);
  } finally {
    globalThis.fetch = originalFetch;
  }
};

test('renders a sample from the template\'s OWN sampleData under a server-minted request id', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await withStub(
    {
      get_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, version: 3, sampleData: SAMPLE_DATA },
      }),
      create_agent_artifact_job: (body) => ({
        status: 202,
        body: {
          jobId: 'job-render-sample-1',
          status: 'pending',
          projectId: body.projectId,
          requestId: body.requestId,
          polling: { tool: 'get_agent_artifact_job_status', input: { jobId: 'job-render-sample-1' } },
        },
      }),
    },
    async (calls) => {
      // The browser sends its OWN (wrong) data — the endpoint must ignore it.
      const response = await post({ templateId: 'tpl_article', data: { title: 'BROWSER SUPPLIED — must be ignored' } });
      const body = JSON.parse(response.body) as RenderResponseBody;

      // W5 F7: the stub answers `pending` with no artifact — the inline wait
      // did not produce a sample — so this is a 202, not a flat 200 the panel
      // would announce as "rendered".
      assert.equal(response.statusCode, 202, JSON.stringify(body));
      assert.equal(body.ok, true, '202 is "accepted", not an error');
      assert.equal(body.template_id, 'tpl_article');
      assert.match(String(body.request_id), /^req_pdfsmp_tpl_article_\d{8}_\d{2}$/);
      assert.equal(body.jobId, 'job-render-sample-1');

      // get_pdf_template is called twice: once by this endpoint (to read
      // sampleData) and once inside create_agent_artifact_job itself (D-3's
      // brand-slot classification, unconditional whenever template_id is set).
      assert.deepEqual(
        calls.map((call) => call.tool),
        ['get_pdf_template', 'get_pdf_template', 'create_agent_artifact_job']
      );
      const created = calls[2]?.body;
      assert.equal(created?.artifactKind, 'pdf');
      assert.equal(created?.templateId, 'tpl_article');
      assert.deepEqual(created?.data, SAMPLE_DATA);
      assert.equal(created?.requestId, body.request_id);
      assert.equal(created?.filename, 'tpl-article-sample.pdf');
      assert.doesNotMatch(JSON.stringify(body), /storage-secret-never-return|bridge-secret-never-return/);
    }
  );
});

test('a template with no sampleData is refused before any job is created', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await withStub(
    {
      get_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, version: 1 },
      }),
    },
    async (calls) => {
      const response = await post({ templateId: 'tpl_bare' });
      const body = JSON.parse(response.body) as RenderResponseBody;
      assert.equal(response.statusCode, 422, JSON.stringify(body));
      assert.equal(body.error_code, 'template_sample_data_missing');
      assert.deepEqual(
        calls.map((call) => call.tool),
        ['get_pdf_template']
      );
    }
  );
});

test('an unknown template is refused as 404', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await withStub(
    {
      get_pdf_template: () => ({
        status: 404,
        body: { error: 'no such template', error_code: 'template_not_found' },
      }),
    },
    async () => {
      const response = await post({ templateId: 'tpl_missing' });
      const body = JSON.parse(response.body) as RenderResponseBody;
      assert.equal(response.statusCode, 404, JSON.stringify(body));
    }
  );
});

test('a viewer cannot render a sample', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  const response = await post({ templateId: 'tpl_article' }, VIEWER);
  const body = JSON.parse(response.body) as RenderResponseBody;
  assert.equal(response.statusCode, 403, JSON.stringify(body));
  assert.match(String(body.error), /no editing role/i);
});

// ─── W5 review fixes ─────────────────────────────────────────────────────────

test('W5 F7: a job that DID produce an artifact inside the inline wait is a plain 200', async () => {
  await rm(ROOT, { recursive: true, force: true });
  prepareEnv();
  await withStub(
    {
      get_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, version: 3, sampleData: SAMPLE_DATA },
      }),
      create_agent_artifact_job: (body) => ({
        body: {
          jobId: 'job-render-sample-done',
          status: 'complete',
          projectId: body.projectId,
          requestId: body.requestId,
          artifactReference: {
            blobKey: `pdf/${body.requestId}/${'c'.repeat(64)}.pdf`,
            sha256: 'c'.repeat(64),
            sizeBytes: 2048,
            contentType: 'application/pdf',
          },
          materializationProof: 'proof-1',
        },
      }),
      verify_agent_artifact: (body) => ({
        body: {
          verified: true,
          projectId: body.projectId,
          requestId: body.requestId,
          artifactReference: body.artifactReference,
          materializationProof: 'proof-rotated',
        },
      }),
    },
    async () => {
      const response = await post({ templateId: 'tpl_article' });
      const body = JSON.parse(response.body) as RenderResponseBody;
      assert.equal(response.statusCode, 200, JSON.stringify(body));
      assert.ok(body.artifactReference, 'a 200 means there is something to show');
    }
  );
});

test('W5 F11: two samples of one template on one day never share a request id', async () => {
  const { mintPdfSampleRequestId, pdfSampleRequestId } = await import(
    '../../packages/core/server/functions/admin-visual-identity-render-sample.js'
  );
  const nowMs = Date.parse('2026-09-05T12:00:00.000Z');

  const first = pdfSampleRequestId('tpl_article', nowMs, 1);
  assert.match(first, /^req_pdfsmp_tpl_article_20260905_01$/);

  // The clock-derived `nn` this replaced collided about one time in a hundred:
  // two different samples landing in ONE artifact-index request bucket.
  const taken = new Set([first]);
  const second = await mintPdfSampleRequestId({
    templateId: 'tpl_article',
    nowMs,
    isTaken: async (candidate) => taken.has(candidate),
  });
  assert.equal(second, 'req_pdfsmp_tpl_article_20260905_02');

  taken.add(second);
  const third = await mintPdfSampleRequestId({
    templateId: 'tpl_article',
    nowMs,
    isTaken: async (candidate) => taken.has(candidate),
  });
  assert.equal(third, 'req_pdfsmp_tpl_article_20260905_03');
  assert.equal(new Set([first, second, third]).size, 3);
});
