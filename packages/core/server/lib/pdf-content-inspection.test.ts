import '../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { stubPdfToolMcp } from '../../../../tests/netlify/pdf-tool-mcp-fetch-stub.js';
import {
  failedContentCheckFromQualityGate,
  inspectDocumentContent,
  inspectDocumentContentFromPublicPath,
  resolvePdfArtifactRefFromPublicPath,
} from './pdf-content-inspection.js';

const PDF_SHA = 'd'.repeat(64);
const REQUEST_ID = 'req_agent_pdf_attach_20260831_01';
const BLOB_KEY = `pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;
const PUBLIC_PATH = `/pdf/${REQUEST_ID}/${PDF_SHA}.pdf`;

const configureBridgeEnv = () => {
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'run-secret';
};

const clearBridgeEnv = () => {
  delete process.env.PDF_TOOL_STORAGE_TOKEN;
  delete process.env.PDF_TOOL_STORAGE_SITE_ID;
  delete process.env.PDF_TOOL_BASE_URL;
  delete process.env.PDF_TOOL_AGENT_RUN_TOKEN;
};

const healthyBody = {
  ok: true,
  statusCode: 200,
  pageCount: 6,
  sizeBytes: 430_000,
  pages: [],
  qualityGate: { passed: true, findings: [] },
};

const brokenBody = {
  ok: true,
  statusCode: 200,
  pageCount: 5,
  sizeBytes: 812_000,
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

test('resolvePdfArtifactRefFromPublicPath recovers the blobKey and sha256 from a public path', () => {
  const resolved = resolvePdfArtifactRefFromPublicPath(PUBLIC_PATH);
  assert.deepEqual(resolved, { blobKey: BLOB_KEY, sha256: PDF_SHA, requestId: REQUEST_ID });
});

test('resolvePdfArtifactRefFromPublicPath recovers from an absolute URL too', () => {
  const resolved = resolvePdfArtifactRefFromPublicPath(`https://example.com${PUBLIC_PATH}`);
  assert.deepEqual(resolved, { blobKey: BLOB_KEY, sha256: PDF_SHA, requestId: REQUEST_ID });
});

test('resolvePdfArtifactRefFromPublicPath refuses an image path, a legacy path, and garbage', () => {
  assert.equal(resolvePdfArtifactRefFromPublicPath(`/img/${REQUEST_ID}/${PDF_SHA}.webp`), undefined);
  assert.equal(resolvePdfArtifactRefFromPublicPath('~/assets/images/uploads/my-article/guide.pdf'), undefined);
  assert.equal(resolvePdfArtifactRefFromPublicPath('not a path at all'), undefined);
});

test('inspectDocumentContentFromPublicPath reports unverified for a non-artifact URL without calling the bridge', async () => {
  clearBridgeEnv();
  let called = false;
  const check = await inspectDocumentContentFromPublicPath(
    'https://example.com/downloads/external-guide.pdf',
    undefined,
    { fetchImpl: (async () => ((called = true), new Response('{}'))) as typeof fetch }
  );
  assert.equal(check.status, 'unverified');
  assert.equal(called, false, 'the bridge must not be called for an unresolvable path');
  if (check.status === 'unverified') assert.match(check.reason, /not a recognized platform PDF artifact path/);
});

test('inspectDocumentContent reports unverified when the pdf-tool bridge is not configured', async () => {
  clearBridgeEnv();
  const check = await inspectDocumentContent({ blobKey: BLOB_KEY, sha256: PDF_SHA, requestId: REQUEST_ID });
  assert.equal(check.status, 'unverified');
  if (check.status === 'unverified') assert.match(check.reason, /not configured/);
});

test('inspectDocumentContent passes a healthy multi-page PDF with text on every page', async () => {
  configureBridgeEnv();
  const { fetchImpl } = stubPdfToolMcp({ inspect_pdf_artifact: () => ({ body: healthyBody }) });

  const check = await inspectDocumentContentFromPublicPath(PUBLIC_PATH, undefined, { fetchImpl });
  assert.deepEqual(check, { status: 'ok', pageCount: 6, sizeBytes: 430_000 });
});

test('inspectDocumentContent fails the broken 2026-09-03 shape and names what was wrong', async () => {
  configureBridgeEnv();
  const { fetchImpl } = stubPdfToolMcp({ inspect_pdf_artifact: () => ({ body: brokenBody }) });

  const check = await inspectDocumentContentFromPublicPath(PUBLIC_PATH, undefined, { fetchImpl });
  assert.equal(check.status, 'failed');
  if (check.status !== 'failed') throw new Error('unreachable');
  assert.match(check.reason, /4 page.*no readable body text/i);
  assert.match(check.reason, /3 image.*failed to resolve/i);
  assert.equal(check.findings.length, brokenBody.qualityGate.findings.length);
  assert.equal(check.pageCount, 5);
});

test('inspectDocumentContent is unverified — not ok:true — when pdf-tool cannot verify the artifact', async () => {
  configureBridgeEnv();
  const { fetchImpl } = stubPdfToolMcp({
    inspect_pdf_artifact: () => ({
      status: 403,
      body: { error: 'Artifact could not be verified for this project/request', errorCode: 'ARTIFACT_NOT_VERIFIED' },
    }),
  });

  const check = await inspectDocumentContentFromPublicPath(PUBLIC_PATH, undefined, { fetchImpl });
  assert.equal(check.status, 'unverified');
  if (check.status === 'unverified') assert.match(check.reason, /could not be verified/i);
});

test('inspectDocumentContent is unverified when pdf-tool is unreachable', async () => {
  configureBridgeEnv();
  const fetchImpl = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  const check = await inspectDocumentContentFromPublicPath(PUBLIC_PATH, undefined, { fetchImpl });
  assert.equal(check.status, 'unverified');
});

test('inspectDocumentContent honors a caller-supplied requirement', async () => {
  configureBridgeEnv();
  const { fetchImpl } = stubPdfToolMcp({ inspect_pdf_artifact: () => ({ body: healthyBody }) });

  const check = await inspectDocumentContentFromPublicPath(PUBLIC_PATH, { minPageCount: 10 }, { fetchImpl });
  assert.equal(check.status, 'failed');
  if (check.status !== 'failed') throw new Error('unreachable');
  assert.match(check.reason, /Only 6 page\(s\); at least 10 required\./);
});

test.after(() => {
  clearBridgeEnv();
});

// ─── W2 review: the render-time verdict (ruling D-D) ────────────────────────

test('a quality gate with findings becomes the same failed verdict verify_pdf_content produces', () => {
  const check = failedContentCheckFromQualityGate(
    {
      passed: false,
      findings: [
        { code: 'BLANK_PAGE', page: 3, detail: 'no readable body text' },
        { code: 'UNRENDERED_TOKEN', page: 1, detail: 'a template token survived' },
      ],
    },
    { sizeBytes: 41210 }
  );
  assert.equal(check?.status, 'failed');
  if (check?.status !== 'failed') return;
  assert.match(check.reason, /no readable body text/);
  assert.match(check.reason, /unrendered template token/);
  assert.equal(check.findings.length, 2);
  assert.equal(check.sizeBytes, 41210);
  // No page count was observed, so none is claimed.
  assert.equal(check.pageCount, undefined);
});

test('a clean gate records NOTHING — one pass over a render is not proof of a clean document', () => {
  assert.equal(failedContentCheckFromQualityGate({ passed: true, findings: [] }), undefined);
  assert.equal(failedContentCheckFromQualityGate(undefined), undefined);
  assert.equal(failedContentCheckFromQualityGate({ passed: false }), undefined);
  // A finding code this platform does not model is not a finding it can explain.
  assert.equal(failedContentCheckFromQualityGate({ passed: false, findings: [{ code: 'SOMETHING_NEW' }] }), undefined);
});

test('the page-count floor is disarmed here — pdf-tool already enforced the job\'s own requirements', () => {
  // A legitimately one-page render that completed: the gate is the only thing
  // being read, so a page-count policy must not manufacture a finding.
  const check = failedContentCheckFromQualityGate(
    { passed: false, findings: [{ code: 'UNRESOLVED_IMAGE', detail: 'asset cover did not resolve' }] },
    { pageCount: 1 }
  );
  assert.equal(check?.status, 'failed');
  if (check?.status !== 'failed') return;
  assert.equal(/page\(s\)/.test(check.reason), false, 'no invented page-count complaint');
  assert.equal(check.pageCount, 1);
});
