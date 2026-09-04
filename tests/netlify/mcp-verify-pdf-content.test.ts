/**
 * T2.4, deliverable 2 — the standalone `verify_pdf_content` MCP tool, exercised through the
 * real `tools/call` dispatch (`netlify/functions/mcp.ts` -> `packages/core/server/functions/mcp.ts`
 * -> `callVerifyPdfContent`), the same round trip an agent or the admin PDF card would make.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID', 'MCP_HTTP_AUTH_TOKEN']) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';

const STORAGE_SECRET = 'storage-secret-never-expose-verify-pdf-content';
const RUN_SECRET = 'run-secret-never-expose-verify-pdf-content';
const SITE_ID = 'site_drlurie';
const REQUEST_ID = 'req_agent_pdf_content_check_20260904_02';
const PDF_SHA = 'f'.repeat(64);
const PUBLIC_PATH = `/pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;
const BLOB_KEY = `pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;

const configureBridgeEnv = () => {
  process.env.PDF_TOOL_STORAGE_TOKEN = STORAGE_SECRET;
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = RUN_SECRET;
};
const clearBridgeEnv = () => {
  delete process.env.PDF_TOOL_STORAGE_TOKEN;
  delete process.env.PDF_TOOL_STORAGE_SITE_ID;
  delete process.env.PDF_TOOL_BASE_URL;
  delete process.env.PDF_TOOL_AGENT_RUN_TOKEN;
};

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

const healthyInspection = { pageCount: 6, sizeBytes: 430_000, pages: [], qualityGate: { passed: true, findings: [] } };
const brokenInspection = {
  pageCount: 5,
  sizeBytes: 812_000,
  pages: [],
  qualityGate: {
    passed: false,
    findings: [
      { code: 'BLANK_PAGE', page: 2, detail: 'Page 2 has 6 characters of extracted text.' },
      { code: 'BLANK_PAGE', page: 3, detail: 'Page 3 has 0 characters of extracted text.' },
    ],
  },
};

test('verify_pdf_content: requires site_id', async () => {
  const result = await rpc('verify_pdf_content', { url: PUBLIC_PATH });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /site_id is required/);
});

test('verify_pdf_content: rejects a site_id that does not match this deployment', async () => {
  const result = await rpc('verify_pdf_content', { site_id: 'site_someone_else', url: PUBLIC_PATH });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /scope mismatch/i);
});

test('verify_pdf_content: requires either url or artifactReference', async () => {
  const result = await rpc('verify_pdf_content', { site_id: SITE_ID });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /Provide either url or artifactReference/);
});

test('verify_pdf_content: passes a healthy PDF given as a url, and never echoes a blobKey', async () => {
  configureBridgeEnv();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({ inspect_pdf_artifact: () => ({ body: healthyInspection }) });
  globalThis.fetch = fetchImpl;

  try {
    const result = await rpc('verify_pdf_content', { site_id: SITE_ID, url: PUBLIC_PATH });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.status, 'ok');
    assert.equal(result.structuredContent?.verified, true);
    assert.equal(result.structuredContent?.pageCount, 6);
    assert.equal(calls[0]?.body.requestId, REQUEST_ID);
    assert.deepEqual((calls[0]?.body.artifactReference as Record<string, unknown>)?.blobKey, BLOB_KEY);
    assert.doesNotMatch(JSON.stringify(result.structuredContent), /blobKey/);
  } finally {
    globalThis.fetch = originalFetch;
    clearBridgeEnv();
  }
});

test('verify_pdf_content: fails the broken shape with a reason, given as an artifactReference', async () => {
  configureBridgeEnv();
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({ inspect_pdf_artifact: () => ({ body: brokenInspection }) });
  globalThis.fetch = fetchImpl;

  try {
    const result = await rpc('verify_pdf_content', {
      site_id: SITE_ID,
      artifactReference: { blobKey: BLOB_KEY, sha256: PDF_SHA },
    });
    assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
    assert.equal(result.structuredContent?.status, 'failed');
    assert.equal(result.structuredContent?.verified, false);
    assert.match(String(result.structuredContent?.reason), /no readable body text/i);
  } finally {
    globalThis.fetch = originalFetch;
    clearBridgeEnv();
  }
});

test('verify_pdf_content: an unrecognized artifactReference.blobKey is a clean input error, not a crash', async () => {
  const result = await rpc('verify_pdf_content', {
    site_id: SITE_ID,
    artifactReference: { blobKey: 'image/req_x/abc.webp' },
  });
  assert.equal(result.isError, true);
  assert.match(JSON.stringify(result.structuredContent), /must be a PDF artifact reference/);
});

test('verify_pdf_content: reports unverified (never ok:true) when the bridge is not configured', async () => {
  clearBridgeEnv();
  const result = await rpc('verify_pdf_content', { site_id: SITE_ID, url: PUBLIC_PATH });
  assert.equal(result.isError, undefined);
  assert.equal(result.structuredContent?.status, 'unverified');
  assert.equal(result.structuredContent?.verified, false);
  assert.ok(result.structuredContent?.reason);
});

test.after(() => {
  clearBridgeEnv();
});
