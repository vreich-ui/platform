/**
 * A5 — `admin-visual-identity-preview-sample`: the PDF templates tab's
 * "Render sample (first page only)" chip as a deterministic endpoint
 * instead of the `preview_pdf_template` chat instruction
 * (`buildPreviewSampleIntent`, visual-identity-pdf.ts, T2.6), with pdf-tool
 * stubbed at its MCP boundary (pdf-tool-mcp-fetch-stub.ts).
 *
 * What these pin:
 *   1. the endpoint reads the template's OWN sampleData with `get_pdf_template`
 *      and forwards exactly that (never anything the browser sends) to
 *      `preview_pdf_template` — a single call, no job, nothing polled;
 *   2. a template with no sampleData is refused before pdf-tool is ever called;
 *   3. the ordinary role gate and a 404 on an unknown template id.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-visual-identity-preview-sample.js';
import { stubPdfToolMcp, type PdfToolMcpCall } from './pdf-tool-mcp-fetch-stub.js';

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
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-return';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'private-storage-site';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'bridge-secret-never-return';
};

const post = (body: Record<string, unknown>, user = EDITOR) =>
  handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) }, { clientContext: { user } });

type PreviewResponseBody = {
  error?: string;
  error_code?: string;
  template_id?: string;
  preview_url?: string;
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

test('previews the template\'s OWN sampleData — never anything the browser sends', async () => {
  prepareEnv();
  await withStub(
    {
      get_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, version: 2, sampleData: SAMPLE_DATA },
      }),
      preview_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, blobKey: 'pdf/req_x/' + 'c'.repeat(64) + '.pdf' },
      }),
    },
    async (calls) => {
      // The browser sends its OWN (wrong) data — the endpoint must ignore it
      // and use the template's, exactly like it ignores any browser-supplied id.
      const response = await post({ templateId: 'tpl_article', data: { title: 'BROWSER SUPPLIED — must be ignored' } });
      const body = JSON.parse(response.body) as PreviewResponseBody;

      assert.equal(response.statusCode, 200, JSON.stringify(body));
      assert.equal(body.template_id, 'tpl_article');
      assert.equal(body.preview_url, `/pdf/req_x/${'c'.repeat(64)}.pdf`);

      assert.deepEqual(
        calls.map((call) => call.tool),
        ['get_pdf_template', 'preview_pdf_template']
      );
      assert.equal(calls[0]?.body.templateId, 'tpl_article');
      assert.deepEqual(calls[1]?.body.data, SAMPLE_DATA);
      assert.equal(calls[1]?.body.templateId, 'tpl_article');
      assert.doesNotMatch(JSON.stringify(body), /storage-secret-never-return|bridge-secret-never-return/);
    }
  );
});

test('a template with no sampleData is refused before pdf-tool is ever called to preview', async () => {
  prepareEnv();
  await withStub(
    {
      get_pdf_template: (body) => ({
        body: { projectId: body.projectId, templateId: body.templateId, version: 1 },
      }),
    },
    async (calls) => {
      const response = await post({ templateId: 'tpl_bare' });
      const body = JSON.parse(response.body) as PreviewResponseBody;
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
      const body = JSON.parse(response.body) as PreviewResponseBody;
      assert.equal(response.statusCode, 404, JSON.stringify(body));
    }
  );
});

test('a viewer cannot request a preview', async () => {
  prepareEnv();
  const response = await post({ templateId: 'tpl_article' }, VIEWER);
  const body = JSON.parse(response.body) as PreviewResponseBody;
  assert.equal(response.statusCode, 403, JSON.stringify(body));
  assert.match(String(body.error), /no editing role/i);
});
