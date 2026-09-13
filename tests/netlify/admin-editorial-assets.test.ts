import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-editorial-assets.js';
import { getArtifactIndexBlobStore } from '../../packages/core/server/lib/blob-store.js';
import { writeArtifactReferenceIndexes } from '../../packages/core/server/lib/artifact-index.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';

const ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-editorial-assets');
setLocalBlobsRootForTesting(ROOT);

test('admin editorial assets returns sanitized PDF templates and indexed media', async () => {
  await rm(ROOT, { recursive: true, force: true });
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  process.env.PDF_TOOL_STORAGE_TOKEN = 'storage-secret-never-return';
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'private-storage-site';
  process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
  process.env.PDF_TOOL_AGENT_RUN_TOKEN = 'bridge-secret-never-return';

  const sha = 'c'.repeat(64);
  const index = await getArtifactIndexBlobStore({});
  await writeArtifactReferenceIndexes(index, 'req_editorial_asset_20260807_01', {
    blobKey: `pdf/req_editorial_asset_20260807_01/${sha}.pdf`,
    sha256: sha,
    sizeBytes: 1800,
    contentType: 'application/pdf',
    createdAtISO: '2026-08-07T10:00:00.000Z',
    artifactKind: 'pdf',
    originalFilename: 'evidence-guide.pdf',
    label: 'Evidence guide',
    metadata: {
      templateId: 'tpl_evidence_guide',
      pageCount: 2,
      renderDataRef: { storeName: 'pdf-render-data', blobKey: 'private-render-input' },
    },
  });

  // D4 fix (task A5): tpl_evidence_guide carries the FULL new field set —
  // kind/thumbnailKey/thumbnailError/renderDataSchema — proving the bridge
  // forwards all of them end to end; tpl_legacy_no_thumbnail (right below)
  // carries NONE of them, proving an older-shaped pdf-tool row still comes
  // through with has_render_data_schema: false and no crash.
  const renderDataSchema = { type: 'object', properties: { headline: { type: 'string' } }, required: ['headline'] };
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = stubPdfToolMcp({
    list_pdf_templates: () => ({
      body: {
        templates: [
          {
            templateId: 'tpl_evidence_guide',
            latestVersion: 2,
            latestActiveVersion: 1,
            status: 'active',
            renderer: 'pdfme',
            kind: 'guide',
            thumbnailKey: 'image/tpl_evidence_guide/thumb.png',
            thumbnailError: 'thumbnail render timed out',
            renderDataSchema,
            storage: { token: 'upstream-secret' },
          },
          {
            templateId: 'tpl_legacy_no_thumbnail',
            latestVersion: 1,
            status: 'draft',
            renderer: 'pdfme',
          },
        ],
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const authContext = { clientContext: { user: { sub: 'owner-1', email: 'owner@example.com' } } };
    const response = await handler({ httpMethod: 'GET', headers: {} }, authContext);
    assert.equal(response.statusCode, 200);

    // T2.3 — ETag + `Cache-Control: private, no-cache`, honoring `If-None-Match` with a 304.
    const responseHeaders = response.headers as Record<string, string> | undefined;
    const etag = responseHeaders?.['ETag'];
    assert.ok(etag, 'ETag must be present');
    assert.equal(responseHeaders?.['Cache-Control'], 'private, no-cache');
    const revalidated = await handler({ httpMethod: 'GET', headers: { 'if-none-match': etag } }, authContext);
    assert.equal(revalidated.statusCode, 304);
    assert.equal(revalidated.body, '');

    // T0.1 — Server-Timing on the same success response.
    const serverTiming = responseHeaders?.['Server-Timing'];
    assert.ok(serverTiming, 'Server-Timing header must be present');
    assert.match(serverTiming, /cold;dur=\d.*auth;dur=[\d.]+.*work;dur=[\d.]+.*serialize;dur=[\d.]+/);
    // T-perf — `work` is now split by QUESTION ASKED: the two `by-kind`
    // sweeps and the cross-site pdf-tool template listing all run inside one
    // Promise.all, so their `sec.*` durations overlap and the biggest one is
    // what this call actually costs.
    for (const section of ['sec.artifacts_image', 'sec.artifacts_pdf', 'sec.pdf_templates']) {
      assert.ok(serverTiming.includes(section), `Server-Timing must carry ${section}; got: ${serverTiming}`);
    }
    const body = JSON.parse(response.body) as {
      pdf_templates: Array<Record<string, unknown>>;
      artifacts: Array<Record<string, unknown>>;
      pdf_templates_available: boolean;
    };
    assert.equal(body.pdf_templates_available, true);
    const evidenceGuide = body.pdf_templates.find((template) => template.id === 'tpl_evidence_guide');
    assert.equal(evidenceGuide?.kind, 'guide');
    assert.equal(evidenceGuide?.thumbnail_key, 'image/tpl_evidence_guide/thumb.png');
    assert.equal(evidenceGuide?.thumbnail_error, 'thumbnail render timed out');
    assert.deepEqual(evidenceGuide?.render_data_schema, renderDataSchema);
    assert.equal(evidenceGuide?.has_render_data_schema, true);

    // The fixture without any D4/§3.6 fields must still project cleanly:
    // has_render_data_schema defaults to false, and none of the optional
    // fields are fabricated.
    const legacy = body.pdf_templates.find((template) => template.id === 'tpl_legacy_no_thumbnail');
    assert.equal(legacy?.has_render_data_schema, false);
    assert.equal(legacy?.kind, undefined);
    assert.equal(legacy?.thumbnail_key, undefined);
    assert.equal(legacy?.thumbnail_error, undefined);
    assert.equal(legacy?.render_data_schema, undefined);

    assert.equal(body.artifacts[0]?.label, 'Evidence guide');
    assert.match(String(body.artifacts[0]?.preview_url), /admin-get-blob-pdf/);
    const visible = JSON.stringify(body);
    assert.doesNotMatch(visible, /storage-secret-never-return|bridge-secret-never-return|upstream-secret/);
    assert.doesNotMatch(visible, /pdf-render-data|private-render-input|private-storage-site/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('admin editorial assets rejects unauthenticated requests', async () => {
  const response = await handler({ httpMethod: 'GET', headers: {} });
  assert.equal(response.statusCode, 401);
});

/**
 * T-perf: the cost of this surface is "blob reads per listed artifact", and
 * the wire response cannot show it. These tests pin it against a counting
 * store.
 *
 * What the reads ARE, per key under `by-kind/<kind>/`:
 *   1. the pointer itself — its only payload here is the `requestId`;
 *   2. the full reference at `request-artifacts/<requestId>/<sha>.json`.
 * Two reads per artifact, and — this is the part the cap exists for — the
 * function returns at most 100 rows however many it read. The sort key
 * (`createdAtISO`) and the liveness flag (`deletedAtISO`) live ONLY on the
 * full reference, so nothing cheaper than reading it can decide which 100
 * are the newest; shrinking THAT needs those two fields on the pointer (an
 * artifact-index schema bump). Until then this test is the fence: anything
 * that adds a THIRD read per artifact, or reads the same record twice, fails
 * here.
 */
const countingIndexStore = (entries: Map<string, string>) => {
  const reads: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    reads,
    peak: () => peakInFlight,
    async get(key: string) {
      inFlight += 1;
      peakInFlight = Math.max(peakInFlight, inFlight);
      try {
        // A real store read is never synchronous; yield so overlapping reads
        // are actually observable as overlapping.
        await new Promise((resolve) => setTimeout(resolve, 0));
        reads.push(key);
        return entries.get(key) ?? null;
      } finally {
        inFlight -= 1;
      }
    },
    async setJSON() {
      throw new Error('listKind must never write');
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return { blobs: [...entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: '' })) };
    },
  };
};

const seedArtifacts = (count: number, kind: 'image' | 'pdf', options: { deleteEvery?: number } = {}) => {
  const entries = new Map<string, string>();
  for (let i = 0; i < count; i += 1) {
    const sha = String(i).padStart(64, 'a');
    const requestId = `req_perf_${kind}${i}_20260901_01`;
    const deleted = options.deleteEvery ? i % options.deleteEvery === 0 : false;
    entries.set(`by-kind/${kind}/${sha}.json`, JSON.stringify({ requestId, sha256: sha, artifactKind: kind }));
    entries.set(
      `request-artifacts/${encodeURIComponent(requestId)}/${sha}.json`,
      JSON.stringify({
        blobKey: `${kind}/${requestId}/${sha}.${kind === 'pdf' ? 'pdf' : 'png'}`,
        sha256: sha,
        sizeBytes: 100 + i,
        contentType: kind === 'pdf' ? 'application/pdf' : 'image/png',
        // Ascending with i, so the newest artifacts are the HIGHEST i.
        createdAtISO: `2026-09-01T00:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}.000Z`,
        artifactKind: kind,
        ...(deleted ? { deletedAtISO: '2026-09-02T00:00:00.000Z' } : {}),
      })
    );
  }
  return entries;
};

test('listKind reads exactly one pointer + one reference per indexed artifact, and no more', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');
  const { STORE_READ_CONCURRENCY } = await import('../../packages/core/server/lib/blob-list.js');

  const ARTIFACTS = 120;
  const store = countingIndexStore(seedArtifacts(ARTIFACTS, 'image'));
  const references = await listKind(store as never, 'image');

  const pointerReads = store.reads.filter((key) => key.startsWith('by-kind/'));
  const recordReads = store.reads.filter((key) => key.startsWith('request-artifacts/'));

  assert.equal(pointerReads.length, ARTIFACTS, 'exactly one pointer read per by-kind key');
  assert.equal(recordReads.length, ARTIFACTS, 'exactly one FULL-RECORD read per by-kind key');
  assert.equal(store.reads.length, ARTIFACTS * 2, 'no read beyond those two per artifact');
  assert.equal(new Set(store.reads).size, store.reads.length, 'no key is read twice in one sweep');

  // The 100-row cap is applied AFTER the reads — this is the O(A)-read-for-
  // 100-rows ceiling that only an index carrying createdAtISO can remove.
  assert.equal(references.length, 100);
  assert.ok(
    recordReads.length > references.length,
    'documents the ceiling: more records are read than rows are returned'
  );

  // Ordering and slicing are unchanged: newest first, top 100.
  const created = references.map((reference) => reference.createdAtISO);
  assert.deepEqual(
    created,
    [...created].sort((a, b) => b.localeCompare(a)),
    'newest first'
  );
  assert.equal(references[0]?.sha256, String(ARTIFACTS - 1).padStart(64, 'a'), 'the newest artifact leads');

  // Bounded fan-out: the whole point of routing this through
  // mapWithConcurrency instead of one unbounded Promise.all over every key.
  assert.ok(
    store.peak() <= STORE_READ_CONCURRENCY,
    `peak in-flight reads ${store.peak()} exceeded STORE_READ_CONCURRENCY ${STORE_READ_CONCURRENCY}`
  );
});

test('listKind still drops soft-deleted references and keeps the rest in order', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  const store = countingIndexStore(seedArtifacts(20, 'pdf', { deleteEvery: 2 }));
  const references = await listKind(store as never, 'pdf');

  assert.equal(references.length, 10, 'every second fixture row is soft-deleted');
  assert.ok(
    references.every((reference) => reference.deletedAtISO === undefined),
    'a soft-deleted reference is never returned'
  );
  assert.equal(store.reads.length, 40, 'a soft-deleted artifact still costs its two reads — it is only known after');
});

/**
 * The media sweep and the pdf-tool template listing answer INDEPENDENT
 * questions, and the template listing is a cross-site HTTP POST with no
 * timeout of its own. Running them in series put a remote cold start on top
 * of the blob sweep on every load. Source-level assertion (this repo's
 * established pattern for wiring that cannot be observed from the response —
 * see packages/core/server/functions/admin-governance.test.ts) plus the
 * Server-Timing sections that make the split measurable in production.
 */
test('the artifact sweep and the pdf-tool template listing are issued concurrently', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname } = await import('node:path');
  // Under the ci-test harness this file runs COMPILED from .tmp/ci-test, so
  // walk to the REAL repo root rather than trusting process.cwd() — the same
  // resolution tests/netlify/function-bundle-budget.test.ts uses.
  let root = dirname(fileURLToPath(import.meta.url));
  while (root !== dirname(root)) {
    if (existsSync(join(root, 'netlify.toml')) && existsSync(join(root, 'packages/core/admin'))) break;
    root = dirname(root);
  }
  const source = readFileSync(join(root, 'packages/core/server/functions/admin-editorial-assets.ts'), 'utf8');

  assert.match(
    source,
    /const \[images, pdfs, listed\] = await Promise\.all\(\[[\s\S]{0,600}listPlatformPdfTemplates\(/,
    'listPlatformPdfTemplates must be started inside the SAME Promise.all as the two listKind sweeps'
  );
  assert.doesNotMatch(
    source,
    /const artifacts = [\s\S]{0,400}await listPlatformPdfTemplates\(/,
    'the template listing must not be awaited after the artifact projection again'
  );
  for (const section of ['artifacts_image', 'artifacts_pdf', 'pdf_templates']) {
    assert.ok(
      source.includes(`timeSection('${section}'`),
      `work must be attributable per section — missing timeSection('${section}')`
    );
  }
});
