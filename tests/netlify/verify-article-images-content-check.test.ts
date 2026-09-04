/**
 * T2.4 — the document verifier's content check, exercised end to end through the actual
 * `verify-article-images` handler: a document that is present/200/application-pdf is now
 * ALSO inspected for real content (pdf-tool's `inspect_pdf_artifact`, called through
 * `packages/core/server/lib/pdf-content-inspection.ts`), not just linked-and-servable.
 *
 * Mirrors verify-article-images-matching.test.ts's own convention: monkeypatch
 * `globalThis.fetch` and route by exact URL. The pdf-tool bridge call
 * (`inspectDocumentContentFromPublicPath` -> `postPdfTool`) goes through that SAME global
 * fetch (it takes no injected fetchImpl here), so a route for pdf-tool's `/mcp` endpoint
 * mocks it exactly like the page/image routes already do.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler as verifyHandler } from '../../netlify/functions/verify-article-images.js';

const publishSecret = 'verify-images-content-check-test-secret';
const PDF_TOOL_MCP_URL = 'https://pdf-tool-content-check.test/.netlify/functions/mcp';

const configureBridgeEnv = () => {
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool-content-check.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'run-secret';
};

const clearBridgeEnv = () => {
  delete process.env.PDF_TOOL_STORAGE_TOKEN;
  delete process.env.PDF_TOOL_STORAGE_SITE_ID;
  delete process.env.PDF_TOOL_BASE_URL;
  delete process.env.PDF_TOOL_AGENT_RUN_TOKEN;
};

/** A `routes` entry that plays pdf-tool's own mcp.ts wire shape for one `tools/call`. */
const pdfToolMcpRoute = (structuredContent: Record<string, unknown>, isError = false) => () =>
  Response.json({
    jsonrpc: '2.0',
    id: 1,
    result: {
      ...(isError ? { isError: true } : {}),
      content: [{ type: 'text', text: isError ? JSON.stringify(structuredContent) : 'OK' }],
      structuredContent,
    },
  });

type VerifyResponseBody = {
  verified: boolean;
  documents?: Array<{
    expected: string;
    ok: boolean;
    present?: boolean;
    status?: number;
    contentType?: string;
    content?: { status: string; reason?: string; pageCount?: number; sizeBytes?: number; findings?: unknown[] };
    error?: string;
  }>;
};

const callVerify = async (
  routes: Record<string, () => Response>,
  extra: Record<string, unknown> = {}
): Promise<VerifyResponseBody> => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    for (const [route, respond] of Object.entries(routes)) {
      if (url === route) return respond();
    }
    return new Response('not found', { status: 404 });
  }) as typeof fetch;

  try {
    const response = await verifyHandler({
      httpMethod: 'POST',
      headers: { 'x-publish-key': publishSecret, 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com/learn/my-article', expectedImages: [], ...extra }),
    });
    return JSON.parse(response.body) as VerifyResponseBody;
  } finally {
    globalThis.fetch = originalFetch;
  }
};

const PDF_SHA = 'e'.repeat(64);
const PDF_PATH = `/pdf/req_agent_pdf_content_check_20260904_01/${PDF_SHA}.pdf`;
const PDF_URL = `https://example.com${PDF_PATH}`;
const pageHtml = () =>
  `<!doctype html><html><body><a href="${PDF_PATH}" type="application/pdf">Guide</a></body></html>`;
const pdfResponse = () => new Response('%PDF-1.7 bytes', { status: 200, headers: { 'content-type': 'application/pdf' } });

const healthyInspection = {
  pageCount: 6,
  sizeBytes: 430_000,
  format: 'A4',
  orientation: 'portrait',
  pages: [],
  qualityGate: { passed: true, findings: [] },
};

// The 2026-09-03 defect (BRIEF §0), reconstructed as pdf-tool's own inspect_pdf_artifact
// would report it: 5 pages, four with no body text, three images that never resolved.
const brokenMoisturizerInspection = {
  pageCount: 5,
  sizeBytes: 812_000,
  format: 'A4',
  orientation: 'portrait',
  pages: [],
  qualityGate: {
    passed: false,
    findings: [
      { code: 'BLANK_PAGE', page: 2, detail: 'Page 2 has 6 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 3, detail: 'Page 3 has 0 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 4, detail: 'Page 4 has 6 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 5, detail: 'Page 5 has 6 characters of extracted text.' },
      { code: 'UNRESOLVED_IMAGE', page: 2, detail: 'No asset named "heroShot".' },
      { code: 'UNRESOLVED_IMAGE', page: 3, detail: 'No asset named "ingredientDiagram".' },
      { code: 'UNRESOLVED_IMAGE', page: 4, detail: 'No asset named "afterPhoto".' },
    ],
  },
};

test('content check: the broken 2026-09-03 shape fails with a reason naming what was wrong', async () => {
  configureBridgeEnv();
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
      [PDF_TOOL_MCP_URL]: pdfToolMcpRoute(brokenMoisturizerInspection),
    },
    { expectedDocuments: [PDF_PATH] }
  );

  assert.equal(body.verified, false, JSON.stringify(body));
  const doc = body.documents?.[0];
  assert.equal(doc?.ok, false, 'a present/200/application-pdf document with garbage content must not be ok:true');
  assert.equal(doc?.content?.status, 'failed');
  assert.match(String(doc?.content?.reason), /no readable body text/i);
  assert.match(String(doc?.content?.reason), /failed to resolve/i);
  assert.match(String(doc?.error), /no readable body text/i);
});

test('content check: a healthy multi-page PDF with text on every page passes', async () => {
  configureBridgeEnv();
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
      [PDF_TOOL_MCP_URL]: pdfToolMcpRoute(healthyInspection),
    },
    { expectedDocuments: [PDF_PATH] }
  );

  assert.equal(body.verified, true, JSON.stringify(body));
  const doc = body.documents?.[0];
  assert.equal(doc?.ok, true);
  assert.equal(doc?.content?.status, 'ok');
  assert.equal(doc?.content?.pageCount, 6);
});

test('content check: present/200/application-pdf but failing inspection is ok:false, not ok:true', async () => {
  configureBridgeEnv();
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
      // The 2026-09-03 defect itself: pages that render, with nothing on them
      // and a template token left in the text.
      [PDF_TOOL_MCP_URL]: pdfToolMcpRoute({
        pageCount: 5,
        sizeBytes: 812_000,
        qualityGate: {
          passed: false,
          findings: [
            { code: 'BLANK_PAGE', page: 3, detail: 'Page 3 has 0 characters of extracted text.' },
            { code: 'UNRENDERED_TOKEN', page: 1, detail: 'a template token survived' },
          ],
        },
      }),
    },
    { expectedDocuments: [PDF_PATH] }
  );

  const doc = body.documents?.[0];
  assert.equal(doc?.present, true);
  assert.equal(doc?.status, 200);
  assert.equal(doc?.contentType, 'application/pdf');
  assert.equal(doc?.ok, false, 'link/status/content-type all passed but content did not — must not be ok:true');
  assert.equal(doc?.content?.status, 'failed');
  assert.match(String(doc?.content?.reason), /no readable body text/);
  assert.match(String(doc?.content?.reason), /unrendered template token/);
});

/**
 * W2 REVIEW. This fixture — a CLEAN one-page PDF — used to be the "failing
 * inspection" case, and it failed only on a default `minPageCount: 2`. That is
 * a verifier inventing a length contract about a document somebody linked: a
 * one-page checklist or lead magnet is not a defect, and no caller passing
 * `expectedDocuments` asked for a page floor. The floor now comes from the
 * render job's own `requirements.pageCount` (which pdf-tool enforces), or from
 * an explicit `documentContentRequirements` — see the override test below.
 */
test('content check: a clean ONE-page PDF passes — a page floor is the job\'s to set, not this verifier\'s', async () => {
  configureBridgeEnv();
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
      [PDF_TOOL_MCP_URL]: pdfToolMcpRoute({
        pageCount: 1,
        sizeBytes: 50_000,
        qualityGate: { passed: true, findings: [] },
      }),
    },
    { expectedDocuments: [PDF_PATH] }
  );

  const doc = body.documents?.[0];
  assert.equal(doc?.ok, true, 'a clean one-page PDF must not be reported as a content defect');
  assert.equal(doc?.content?.status, 'ok');
  assert.equal(doc?.error, undefined);
  assert.equal(body.verified, true);
});

test('content check: content that could not be inspected reports unverified and never claims success', async () => {
  clearBridgeEnv(); // bridge not configured — the honest "could not inspect" path
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
    },
    { expectedDocuments: [PDF_PATH] }
  );

  const doc = body.documents?.[0];
  assert.equal(doc?.content?.status, 'unverified');
  assert.ok(doc?.content?.reason, 'unverified must carry a reason');
  assert.notEqual(doc?.content?.status, 'ok', 'unverified content must never be reported as ok');
});

test('content check: a documentContentRequirements override is honored end to end', async () => {
  configureBridgeEnv();
  const body = await callVerify(
    {
      'https://example.com/learn/my-article': () =>
        new Response(pageHtml(), { status: 200, headers: { 'content-type': 'text/html' } }),
      [PDF_URL]: pdfResponse,
      [PDF_TOOL_MCP_URL]: pdfToolMcpRoute(healthyInspection),
    },
    { expectedDocuments: [PDF_PATH], documentContentRequirements: { minPageCount: 10 } }
  );

  const doc = body.documents?.[0];
  assert.equal(doc?.ok, false);
  assert.equal(doc?.content?.status, 'failed');
  assert.match(String(doc?.content?.reason), /at least 10 required/);
});

test.after(() => {
  clearBridgeEnv();
});
