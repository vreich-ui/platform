/**
 * T-IMG — the image-annotation bridge (`annotate_image`, `analyze_image_layout`,
 * `preview_image_grid`, `check_image_text`).
 *
 * What this file proves, in the same shape mcp-pdf-tool-template-bridge.test.ts
 * proves the template bridge:
 *   - the caller never holds a grant: site_id + request_id go in, a fresh
 *     server-side grant + the canonical projectId go out to pdf-tool, and
 *     neither the storage token nor the run token appears anywhere in a
 *     response or a log line;
 *   - a caller-supplied storage / token / projectId is REFUSED, not honoured —
 *     including one smuggled inside the AnnotationSpec;
 *   - the artifact is named the Platform way (public_path or sha256) and the
 *     blobKey pdf-tool needs is resolved here, never hand-assembled by a caller;
 *   - the AnnotationSpec is forwarded VERBATIM (Platform fills in `spec.base`
 *     only when the caller omitted it) and pdf-tool's own TEMPLATE_INVALID —
 *     and every other named upstream refusal — reaches the caller unchanged
 *     rather than becoming a generic platform failure;
 *   - `renderReport` / `hints` / `textCheck` come back verbatim: the warnings
 *     are the product, and a warn-only failing textCheck is still a SUCCESSFUL
 *     call.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { createLocalBlobStore, setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const REQUEST_ID = 'req_agent_image_annotation_bridge_hero_20260907_01';
const OTHER_REQUEST_ID = 'req_agent_image_annotation_bridge_other_20260907_01';
const STORAGE_SECRET = 'storage-secret-never-expose';
const RUN_SECRET = 'run-secret-never-expose';
const SHA = 'a'.repeat(64);
const BLOB_KEY = `image/${REQUEST_ID}/${SHA}.webp`;
const PUBLIC_PATH = `/img/${REQUEST_ID}/${SHA}.webp`;
const ANNOTATED_SHA = 'b'.repeat(64);
const ANNOTATED_BLOB_KEY = `image/${REQUEST_ID}/${ANNOTATED_SHA}.png`;
const GRID_SHA = 'c'.repeat(64);
const GRID_BLOB_KEY = `image/${REQUEST_ID}/${GRID_SHA}.png`;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-image-annotation-bridge');
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

const SOURCE_REFERENCE = {
  blobKey: BLOB_KEY,
  sha256: SHA,
  contentType: 'image/webp',
  sizeBytes: 120_000,
  createdAtISO: '2026-09-07T00:00:00.000Z',
  artifactKind: 'image',
  originalFilename: 'hero.webp',
};

const RENDER_REPORT = {
  warnings: [
    { code: 'CONTRAST_LOW', elementId: 't1', detail: { ratio: 2.9, inserted: 'scrim' } },
    { code: 'MEASURED_BOX_DRIFT', elementId: 't1', detail: { predicted: { h: 0.1 }, measured: { h: 0.18 } } },
  ],
  engineWarnings: ['annotate-renderer: logo l1 skipped, no bytes'],
};

const HINTS = {
  image: { w: 2048, h: 1536 },
  grid: { cols: 6, rows: 6, cells: [{ id: 'A1', lum: 0.2, busy: 0.1, color: '#101010' }] },
  safeZones: [{ rect: { x: 0, y: 0.7, w: 0.9, h: 0.2 }, score: 0.82 }],
  faces: [],
  subject: null,
  dominant: ['#101010', '#c0c0c0'],
};

const seedRequestAndIndex = async () => {
  await rm(join(LOCAL_BLOBS_ROOT, 'site-objects'), { recursive: true, force: true });
  await rm(join(LOCAL_BLOBS_ROOT, 'artifact-index'), { recursive: true, force: true });
  const created = await rpc('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: REQUEST_ID,
    body: {
      slug: 'image-annotation-bridge-hero',
      title: 'A Hero Image Worth Annotating',
      nodes: [
        {
          id: 'n_start',
          kind: 'content',
          public: { title: 'Hero', body: 'An image generated for annotation.' },
          visibility: 'public',
        },
      ],
    },
  });
  assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));

  // pdf-tool owns these request-scoped index records in production; the test
  // writes the one the sha256 lookup path reads.
  const artifactIndex = createLocalBlobStore('artifact-index');
  await artifactIndex.setJSON(`request-artifacts/${encodeURIComponent(REQUEST_ID)}/${SHA}.json`, SOURCE_REFERENCE);
};

test('tools/list advertises the four image-annotation tools with honest MCP annotations', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (
    JSON.parse(response.body) as {
      result: { tools: Array<{ name: string; annotations: Record<string, boolean> }> };
    }
  ).result.tools;
  const byName = new Map(tools.map((tool) => [tool.name, tool]));

  for (const name of ['annotate_image', 'analyze_image_layout', 'preview_image_grid', 'check_image_text']) {
    assert.ok(byName.has(name), `${name} must be discoverable on /mcp`);
    assert.equal(byName.get(name)!.annotations.openWorldHint, false, `${name} touches only this tenant's own store`);
    assert.equal(byName.get(name)!.annotations.destructiveHint, false, `${name} destroys nothing`);
  }
  // The two that persist nothing are the two pdf-tool marks read-only.
  assert.equal(byName.get('analyze_image_layout')!.annotations.readOnlyHint, true);
  assert.equal(byName.get('check_image_text')!.annotations.readOnlyHint, true);
  // The two that write an artifact are not read-only, but ARE idempotent —
  // they declare an idempotency_key, same as every other artifact write here.
  assert.equal(byName.get('annotate_image')!.annotations.readOnlyHint, false);
  assert.equal(byName.get('annotate_image')!.annotations.idempotentHint, true);
  assert.equal(byName.get('preview_image_grid')!.annotations.readOnlyHint, false);
  assert.equal(byName.get('preview_image_grid')!.annotations.idempotentHint, true);
});

test('analyze → annotate → check runs on a public_path alone, mints the grant server-side, and never leaks it', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    analyze_image_layout: () => ({ body: { artifactReference: SOURCE_REFERENCE, hints: HINTS } }),
    annotate_image: () => ({
      body: {
        artifactReference: SOURCE_REFERENCE,
        artifact: {
          assetId: 'hero-annotated',
          blobKey: ANNOTATED_BLOB_KEY,
          sha256: ANNOTATED_SHA,
          contentType: 'image/png',
          sizeBytes: 240_000,
          widthPx: 1024,
          heightPx: 1024,
          format: 'png',
          filename: 'hero-annotated.png',
        },
        renderReport: RENDER_REPORT,
      },
    }),
    check_image_text: () => ({
      body: {
        artifactReference: SOURCE_REFERENCE,
        textCheck: {
          mode: 'expect',
          detected: ['Gentle cleanser'],
          ok: false,
          warnings: [],
          matched: [],
          missing: ['SPF 30'],
        },
      },
    }),
  });
  globalThis.fetch = fetchImpl;

  try {
    const logs: Array<Record<string, unknown>> = [];

    const analyzed = await rpc(
      'analyze_image_layout',
      { site_id: 'site_drlurie', request_id: REQUEST_ID, public_path: PUBLIC_PATH },
      logs
    );
    assert.ok(!analyzed.result.isError, JSON.stringify(analyzed.result.structuredContent));
    assert.deepEqual(analyzed.result.structuredContent?.hints, HINTS, 'hints must arrive verbatim');
    assert.equal(analyzed.result.structuredContent?.public_path, PUBLIC_PATH);
    assert.equal(analyzed.result.structuredContent?.projectId, 'dr-lurie');
    assert.equal(analyzed.result.structuredContent?.siteId, 'site_drlurie');

    const annotated = await rpc(
      'annotate_image',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        public_path: PUBLIC_PATH,
        // No spec.base: the caller holds a public_path, not a blobKey.
        spec: {
          version: 1,
          canvas: { w: 1024, h: 1024 },
          elements: [{ type: 'text', id: 't1', content: 'Gentle cleanser', at: 'B5', style: 'title' }],
        },
        format: 'png',
      },
      logs
    );
    assert.ok(!annotated.result.isError, JSON.stringify(annotated.result.structuredContent));
    // public_path names the artifact this call WROTE, the one a human opens.
    assert.equal(annotated.result.structuredContent?.public_path, `/img/${REQUEST_ID}/${ANNOTATED_SHA}.png`);
    assert.equal(annotated.result.structuredContent?.source_public_path, PUBLIC_PATH);
    assert.deepEqual(annotated.result.structuredContent?.source_artifact_reference, SOURCE_REFERENCE);
    assert.deepEqual(annotated.result.structuredContent?.renderReport, RENDER_REPORT, 'the report is the product');
    assert.equal((annotated.result.structuredContent?.artifact as { assetId: string }).assetId, 'hero-annotated');

    const checked = await rpc(
      'check_image_text',
      {
        site_id: 'site_drlurie',
        request_id: REQUEST_ID,
        public_path: `/img/${REQUEST_ID}/${ANNOTATED_SHA}.png`,
        mode: 'expect',
        expect: ['Gentle cleanser', 'SPF 30'],
      },
      logs
    );
    // Warn-only: a FAILING textCheck is still a successful call.
    assert.ok(!checked.result.isError, JSON.stringify(checked.result.structuredContent));
    assert.equal((checked.result.structuredContent?.textCheck as { ok: boolean }).ok, false);
    assert.deepEqual((checked.result.structuredContent?.textCheck as { missing: string[] }).missing, ['SPF 30']);

    // Platform resolved the blobKey; the caller never sent one.
    const annotateCall = calls.find((call) => call.tool === 'annotate_image')!;
    assert.equal(annotateCall.body.blobKey, BLOB_KEY);
    assert.equal(annotateCall.body.sha256, SHA);
    assert.equal(annotateCall.body.requestId, REQUEST_ID);
    // spec.base was filled in from the artifact this call was scoped against.
    assert.deepEqual((annotateCall.body.spec as { base: unknown }).base, {
      artifactRef: { blobKey: BLOB_KEY, sha256: SHA },
    });
    // ...and nothing else about the spec was touched.
    assert.deepEqual((annotateCall.body.spec as { elements: unknown }).elements, [
      { type: 'text', id: 't1', content: 'Gentle cleanser', at: 'B5', style: 'title' },
    ]);

    for (const call of calls) {
      assert.equal(call.path, '/.netlify/functions/mcp');
      assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
      assert.equal(call.body.projectId, 'dr-lurie');
      assert.equal((call.body.storage as { projectId: string }).projectId, 'dr-lurie');
      assert.equal((call.body.storage as { token: string }).token, STORAGE_SECRET);
    }

    const visible = JSON.stringify({
      logs,
      analyzed: analyzed.response.body,
      annotated: annotated.response.body,
      checked: checked.response.body,
    });
    assert.ok(!visible.includes(STORAGE_SECRET), 'the storage grant must never reach a caller or a log');
    assert.ok(!visible.includes(RUN_SECRET), 'the run token must never reach a caller or a log');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a sha256 resolves through this request's artifact index, and preview_image_grid returns the preview it wrote", async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    preview_image_grid: () => ({
      body: {
        artifactReference: SOURCE_REFERENCE,
        artifact: {
          assetId: 'hero-grid',
          blobKey: GRID_BLOB_KEY,
          sha256: GRID_SHA,
          contentType: 'image/png',
          sizeBytes: 90_000,
          widthPx: 1024,
          heightPx: 768,
          format: 'png',
        },
        hints: HINTS,
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const preview = await rpc('preview_image_grid', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      sha256: SHA,
    });
    assert.ok(!preview.result.isError, JSON.stringify(preview.result.structuredContent));
    assert.equal(preview.result.structuredContent?.public_path, `/img/${REQUEST_ID}/${GRID_SHA}.png`);
    assert.equal(preview.result.structuredContent?.source_public_path, PUBLIC_PATH);
    assert.deepEqual(preview.result.structuredContent?.hints, HINTS);
    assert.equal(calls[0]!.body.blobKey, BLOB_KEY, 'the index lookup supplied the blobKey');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a named upstream refusal reaches the caller unchanged, never a generic platform failure', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    annotate_image: () => ({
      status: 400,
      body: {
        error: 'spec is not a valid AnnotationSpec: elements.0.at: cell must be one of A1..F6',
        errorCode: 'TEMPLATE_INVALID',
      },
    }),
    check_image_text: () => ({
      status: 503,
      body: { error: 'tesseract is not installed in the deployed render-service image', errorCode: 'OCR_UNAVAILABLE' },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const annotated = await rpc('annotate_image', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      spec: {
        version: 1,
        canvas: { w: 1024, h: 1024 },
        elements: [{ type: 'text', id: 't1', content: 'x', at: 'Z9' }],
      },
    });
    assert.equal(annotated.result.isError, true);
    assert.equal(annotated.result.structuredContent?.errorCode, 'TEMPLATE_INVALID');
    assert.equal(annotated.result.structuredContent?.error_code, 'pdf_tool_bridge_request_failed');
    assert.equal(annotated.result.structuredContent?.statusCode, 400);
    assert.match(String(annotated.result.structuredContent?.error), /AnnotationSpec/);

    const checked = await rpc('check_image_text', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      mode: 'expect_none',
    });
    assert.equal(checked.result.isError, true);
    assert.equal(checked.result.structuredContent?.errorCode, 'OCR_UNAVAILABLE');
    assert.equal(checked.result.structuredContent?.statusCode, 503);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a caller-supplied grant is refused — as an argument, and smuggled inside the AnnotationSpec', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    annotate_image: () => ({ body: {} }),
    analyze_image_layout: () => ({ body: {} }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const withStorage = await rpc('analyze_image_layout', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      storage: { grantVersion: 1, token: 'attacker-token', siteId: 'someone-else' },
    });
    assert.equal(withStorage.result.isError, true);
    assert.equal(withStorage.result.structuredContent?.error_code, 'artifact_grant_not_accepted');

    const withProjectId = await rpc('analyze_image_layout', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      projectId: 'some-other-project',
    });
    assert.equal(withProjectId.result.isError, true);
    assert.equal(withProjectId.result.structuredContent?.error_code, 'artifact_grant_not_accepted');

    const smuggled = await rpc('annotate_image', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      spec: { version: 1, canvas: { w: 1024, h: 1024 }, elements: [], storage: { token: 'attacker-token' } },
    });
    assert.equal(smuggled.result.isError, true);
    assert.equal(smuggled.result.structuredContent?.error_code, 'artifact_grant_not_accepted');

    assert.equal(calls.length, 0, 'a refused call must never reach pdf-tool');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('scope and target refusals happen before pdf-tool is called at all', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({ analyze_image_layout: () => ({ body: { hints: HINTS } }) });
  globalThis.fetch = fetchImpl;
  try {
    const noTarget = await rpc('analyze_image_layout', { site_id: 'site_drlurie', request_id: REQUEST_ID });
    assert.equal(noTarget.result.isError, true);
    assert.equal(noTarget.result.structuredContent?.error_code, 'artifact_target_required');

    const wrongSite = await rpc('analyze_image_layout', {
      site_id: 'site_someone_else',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
    });
    assert.equal(wrongSite.result.isError, true);
    assert.equal(wrongSite.result.structuredContent?.error_code, 'artifact_site_mismatch');

    const crossRequest = await rpc('analyze_image_layout', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: `/img/${OTHER_REQUEST_ID}/${SHA}.webp`,
    });
    assert.equal(crossRequest.result.isError, true);
    assert.equal(crossRequest.result.structuredContent?.error_code, 'artifact_request_scope_mismatch');

    const unknownSha = await rpc('analyze_image_layout', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      sha256: 'd'.repeat(64),
    });
    assert.equal(unknownSha.result.isError, true);
    assert.equal(unknownSha.result.structuredContent?.error_code, 'artifact_not_in_request_index');

    assert.equal(calls.length, 0, 'none of these may reach pdf-tool');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an author-supplied spec.base is forwarded untouched so upstream can still refuse a mismatch', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = stubPdfToolMcp({
    annotate_image: () => ({
      status: 400,
      body: {
        error: 'spec.base.artifactRef names a different artifact than the one this call verified',
        errorCode: 'ANNOTATE_BASE_MISMATCH',
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const authoredBase = { artifactRef: { blobKey: `image/${OTHER_REQUEST_ID}/${SHA}.webp`, sha256: SHA } };
    const annotated = await rpc('annotate_image', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      spec: { version: 1, canvas: { w: 1024, h: 1024 }, base: authoredBase, elements: [] },
    });
    assert.deepEqual((calls[0]!.body.spec as { base: unknown }).base, authoredBase, 'never silently overwritten');
    assert.equal(annotated.result.isError, true);
    assert.equal(annotated.result.structuredContent?.errorCode, 'ANNOTATE_BASE_MISMATCH');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a success that arrives without its report is reported, never answered with a blank one', async () => {
  await seedRequestAndIndex();
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    annotate_image: () => ({
      body: {
        artifactReference: SOURCE_REFERENCE,
        artifact: { assetId: 'hero-annotated', blobKey: ANNOTATED_BLOB_KEY, sha256: ANNOTATED_SHA },
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const annotated = await rpc('annotate_image', {
      site_id: 'site_drlurie',
      request_id: REQUEST_ID,
      public_path: PUBLIC_PATH,
      spec: { version: 1, canvas: { w: 1024, h: 1024 }, elements: [] },
    });
    assert.equal(annotated.result.isError, true);
    assert.equal(annotated.result.structuredContent?.error_code, 'pdf_tool_invalid_response');
    assert.match(String(annotated.result.structuredContent?.error), /renderReport/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
