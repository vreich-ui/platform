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
 *   1. the pointer itself — ALWAYS, one per key;
 *   2. the full reference at `request-artifacts/<requestId>/<sha>.json` — only
 *      when the pointer cannot answer on its own.
 *
 * W3 T1 moved `createdAtISO`/`deletedAtISO` onto `ArtifactPointer`, so (2) is
 * now paid for the ~100 rows the function RETURNS rather than for every
 * artifact in the store. The three tests below are the fence around that:
 * repaired pointers must cost ~100 record reads no matter how large the store
 * is, unrepaired pointers must cost exactly what they always did (plus the
 * repair write that makes it the last time), and a half-repaired store must
 * return the same rows as a fully repaired one.
 */
const countingIndexStore = (entries: Map<string, string>) => {
  const reads: string[] = [];
  const writes: string[] = [];
  let inFlight = 0;
  let peakInFlight = 0;
  return {
    entries,
    reads,
    // W3 T1: the sweep is no longer read-only. It REPAIRS a pointer that has no
    // createdAtISO, which is the whole self-healing mechanism — nobody runs a
    // backfill — so the store records writes instead of refusing them.
    writes,
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
    async setJSON(key: string, value: unknown) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      writes.push(key);
      entries.set(key, JSON.stringify(value));
    },
    async list({ prefix = '' }: { prefix?: string } = {}) {
      return { blobs: [...entries.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: '' })) };
    },
  };
};

/**
 * `repaired` decides which pointers carry the W3 fields:
 *   'none'  — every pointer is the OLD three-field shape. This is a real
 *             tenant on the morning of the deploy, and the sweep must behave
 *             exactly as it did before.
 *   'all'   — every pointer has been repaired (or was written after W3).
 *   'even'  — a mix, which is every tenant in between.
 */
const seedArtifacts = (
  count: number,
  kind: 'image' | 'pdf',
  options: { deleteEvery?: number; repaired?: 'none' | 'all' | 'even' } = {}
) => {
  const entries = new Map<string, string>();
  const repaired = options.repaired ?? 'none';

  for (let i = 0; i < count; i += 1) {
    const sha = String(i).padStart(64, 'a');
    const requestId = `req_perf_${kind}${i}_20260901_01`;
    const deleted = options.deleteEvery ? i % options.deleteEvery === 0 : false;
    // Ascending with i, so the newest artifacts are the HIGHEST i.
    const createdAtISO = `2026-09-01T00:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}.000Z`;
    const pointerRepaired = repaired === 'all' || (repaired === 'even' && i % 2 === 0);

    entries.set(
      `by-kind/${kind}/${sha}.json`,
      JSON.stringify({
        requestId,
        sha256: sha,
        artifactKind: kind,
        // A repaired pointer mirrors BOTH fields, exactly as a post-W3 write
        // path leaves them: the sort key always, the liveness flag only when
        // the reference carries one.
        ...(pointerRepaired ? { createdAtISO } : {}),
        ...(pointerRepaired && deleted ? { deletedAtISO: '2026-09-02T00:00:00.000Z' } : {}),
      })
    );
    entries.set(
      `request-artifacts/${encodeURIComponent(requestId)}/${sha}.json`,
      JSON.stringify({
        blobKey: `${kind}/${requestId}/${sha}.${kind === 'pdf' ? 'pdf' : 'png'}`,
        sha256: sha,
        sizeBytes: 100 + i,
        contentType: kind === 'pdf' ? 'application/pdf' : 'image/png',
        createdAtISO,
        artifactKind: kind,
        ...(deleted ? { deletedAtISO: '2026-09-02T00:00:00.000Z' } : {}),
      })
    );
  }
  return entries;
};

test('listKind on UNREPAIRED pointers costs exactly what it always did, and repairs them as it goes', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');
  const { STORE_READ_CONCURRENCY } = await import('../../packages/core/server/lib/blob-list.js');

  const ARTIFACTS = 120;
  const store = countingIndexStore(seedArtifacts(ARTIFACTS, 'image', { repaired: 'none' }));
  const references = await listKind(store as never, 'image');

  const pointerReads = store.reads.filter((key) => key.startsWith('by-kind/'));
  const recordReads = store.reads.filter((key) => key.startsWith('request-artifacts/'));

  // Identical to the pre-W3 numbers: a pointer with no createdAtISO cannot be
  // placed in the sort at all, so its record still has to be opened.
  assert.equal(pointerReads.length, ARTIFACTS, 'exactly one pointer read per by-kind key');
  assert.equal(recordReads.length, ARTIFACTS, 'an unrepaired pointer still costs its full-record read');
  assert.equal(store.reads.length, ARTIFACTS * 2, 'no read beyond those two per artifact');
  assert.equal(new Set(store.reads).size, store.reads.length, 'no key is read twice in one sweep');

  // ...plus the repair. This is the self-healing mechanism: nothing anywhere
  // runs a backfill, the read path that pays the cost is the one that removes
  // it.
  assert.equal(store.writes.length, ARTIFACTS, 'every unrepaired pointer is repaired exactly once');
  assert.ok(
    store.writes.every((key) => key.startsWith('by-kind/')),
    'a repair writes the pointer it read and nothing else'
  );

  assert.equal(references.length, 100);

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

  // The repair is idempotent AND it is what buys the win: run the same sweep
  // again over the store the first one left behind and the full-record reads
  // collapse to the rows returned.
  const second = countingIndexStore(store.entries);
  const secondReferences = await listKind(second as never, 'image');

  assert.deepEqual(
    secondReferences.map((reference) => reference.sha256),
    references.map((reference) => reference.sha256),
    'repairing a pointer changes cost, never rows'
  );
  assert.equal(second.reads.filter((key) => key.startsWith('request-artifacts/')).length, 100);
  assert.equal(second.writes.length, 0, 'a repaired pointer is never repaired again');
});

test('listKind on REPAIRED pointers reads ~100 records however large the store is', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  for (const ARTIFACTS of [120, 600]) {
    const store = countingIndexStore(seedArtifacts(ARTIFACTS, 'image', { repaired: 'all' }));
    const references = await listKind(store as never, 'image');

    const pointerReads = store.reads.filter((key) => key.startsWith('by-kind/'));
    const recordReads = store.reads.filter((key) => key.startsWith('request-artifacts/'));

    assert.equal(pointerReads.length, ARTIFACTS, 'the pointer sweep is still one read per by-kind key');
    assert.equal(
      recordReads.length,
      100,
      `full-record reads must equal the rows returned, not the store size (${ARTIFACTS} artifacts)`
    );
    assert.equal(store.writes.length, 0, 'nothing to repair, nothing written');
    assert.equal(references.length, 100);
    assert.equal(references[0]?.sha256, String(ARTIFACTS - 1).padStart(64, 'a'), 'the newest artifact leads');

    const created = references.map((reference) => reference.createdAtISO);
    assert.deepEqual(
      created,
      [...created].sort((a, b) => b.localeCompare(a)),
      'newest first'
    );
  }
});

test('listKind returns the SAME rows on a half-repaired store as on a fully repaired one', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  const ARTIFACTS = 300;
  const allRepaired = countingIndexStore(seedArtifacts(ARTIFACTS, 'image', { repaired: 'all' }));
  const mixed = countingIndexStore(seedArtifacts(ARTIFACTS, 'image', { repaired: 'even' }));
  const noneRepaired = countingIndexStore(seedArtifacts(ARTIFACTS, 'image', { repaired: 'none' }));

  const expected = (await listKind(allRepaired as never, 'image')).map((reference) => reference.sha256);
  const fromMixed = (await listKind(mixed as never, 'image')).map((reference) => reference.sha256);
  const fromNone = (await listKind(noneRepaired as never, 'image')).map((reference) => reference.sha256);

  // The failure this pins: sorting only the pointers that happen to carry a
  // createdAtISO would answer "the newest 100 of the REPAIRED ones". Here the
  // unrepaired half is interleaved with the repaired half across the whole
  // date range, so that bug cannot produce this list.
  assert.equal(expected.length, 100);
  assert.deepEqual(fromMixed, expected, 'a half-repaired store answers exactly like a fully repaired one');
  assert.deepEqual(fromNone, expected, 'an unrepaired store answers exactly like a fully repaired one');

  // Cost on the mix sits between the two extremes: the unrepaired half must be
  // read to be placed at all, the repaired half only if it makes the cut.
  const mixedRecordReads = mixed.reads.filter((key) => key.startsWith('request-artifacts/')).length;
  assert.ok(
    mixedRecordReads > 100 && mixedRecordReads < ARTIFACTS,
    `a mixed store should read more than the rows returned and fewer than the whole store; read ${mixedRecordReads}`
  );
  assert.equal(mixed.writes.length, ARTIFACTS / 2, 'exactly the unrepaired half is repaired');
});

test('listKind still drops soft-deleted references and keeps the rest in order', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  const store = countingIndexStore(seedArtifacts(20, 'pdf', { deleteEvery: 2, repaired: 'none' }));
  const references = await listKind(store as never, 'pdf');

  assert.equal(references.length, 10, 'every second fixture row is soft-deleted');
  assert.ok(
    references.every((reference) => reference.deletedAtISO === undefined),
    'a soft-deleted reference is never returned'
  );
  assert.equal(store.reads.length, 40, 'a soft-deleted artifact still costs its two reads — it is only known after');
});

test('a repaired pointer that says "deleted" skips its record; one that lies is caught by the record', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  const entries = seedArtifacts(20, 'pdf', { deleteEvery: 2, repaired: 'all' });
  const store = countingIndexStore(entries);
  const references = await listKind(store as never, 'pdf');

  assert.equal(references.length, 10, 'every second fixture row is soft-deleted');
  assert.equal(
    store.reads.filter((key) => key.startsWith('request-artifacts/')).length,
    10,
    'a pointer that already knows the row is deleted saves the record read entirely'
  );

  /**
   * The dangerous direction, and why liveness is still decided by the RECORD:
   * a pointer can be stale-LIVE (a torn write, or a delete that raced this
   * sweep). Rolling every pointer back to "live" while the records still say
   * deleted must change nothing about the rows — it may only cost reads.
   */
  const stale = new Map(entries);
  for (const [key, value] of entries) {
    if (!key.startsWith('by-kind/')) continue;
    const pointer = JSON.parse(value) as Record<string, unknown>;
    delete pointer.deletedAtISO;
    stale.set(key, JSON.stringify(pointer));
  }

  const staleStore = countingIndexStore(stale);
  const fromStale = await listKind(staleStore as never, 'pdf');

  assert.deepEqual(
    fromStale.map((reference) => reference.sha256),
    references.map((reference) => reference.sha256),
    'a pointer that wrongly claims a deleted artifact is live never puts it in the result'
  );
  assert.equal(
    staleStore.reads.filter((key) => key.startsWith('request-artifacts/')).length,
    20,
    'it costs the reads it saved, and nothing else'
  );
});

/**
 * The read-repair is a WRITE issued from a read path, against a store other
 * writers are using at the same time. Two rules keep that safe, and both are
 * pinned here because neither is visible in the rows the sweep returns:
 *
 *   - it MERGES onto the stored pointer, so a field it does not know about
 *     survives — a repair that re-derived the pointer would silently drop
 *     whatever a newer writer had put there;
 *   - it writes `createdAtISO` and NOTHING else. `createdAtISO` is immutable
 *     for a reference, so writing it can never be stale. `deletedAtISO` is
 *     not: a repair that stamped liveness from a record it read moments ago
 *     could land after a concurrent restore and hide a live artifact for good,
 *     so liveness stays the exclusive property of the delete/restore paths.
 */
test('the read-repair adds the sort key, keeps every other field, and never writes liveness', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  const entries = seedArtifacts(4, 'image', { deleteEvery: 2, repaired: 'none' });
  const extraKey = `by-kind/image/${String(1).padStart(64, 'a')}.json`;
  entries.set(extraKey, JSON.stringify({ ...JSON.parse(entries.get(extraKey) as string), someFutureField: 'keep me' }));

  const store = countingIndexStore(entries);
  await listKind(store as never, 'image');

  const repairedLive = JSON.parse(entries.get(extraKey) as string) as Record<string, unknown>;
  assert.equal(repairedLive.someFutureField, 'keep me', 'the repair must not drop a field it does not know about');
  assert.equal(repairedLive.createdAtISO, '2026-09-01T00:01:00.000Z', 'the repair adds the sort key');
  assert.equal(repairedLive.deletedAtISO, undefined);
  assert.equal(repairedLive.requestId, 'req_perf_image1_20260901_01', 'identity is untouched');

  // i=0 is soft-deleted in the fixture (deleteEvery: 2). Its pointer is
  // repaired for the sort key, and deliberately NOT stamped as deleted.
  const deletedKey = `by-kind/image/${String(0).padStart(64, 'a')}.json`;
  const repairedDeleted = JSON.parse(entries.get(deletedKey) as string) as Record<string, unknown>;
  assert.equal(repairedDeleted.createdAtISO, '2026-09-01T00:00:00.000Z');
  assert.equal(
    repairedDeleted.deletedAtISO,
    undefined,
    'a read path must never stamp liveness onto a pointer; only the delete path may'
  );
});

test('listKind refills past rows whose record turns out to be unusable, rather than returning short', async () => {
  const { listKind } = await import('../../packages/core/server/functions/admin-editorial-assets.js');

  // 120 repaired pointers; the 40 NEWEST have records that are gone. A plain
  // `slice(0, 100)` over the pointers would return 60 rows. The pre-W3 sweep
  // returned 80 (it read everything, then sliced), and so must this one.
  const entries = seedArtifacts(120, 'image', { repaired: 'all' });
  for (let i = 80; i < 120; i += 1) {
    const sha = String(i).padStart(64, 'a');
    entries.delete(`request-artifacts/${encodeURIComponent(`req_perf_image${i}_20260901_01`)}/${sha}.json`);
  }

  const store = countingIndexStore(entries);
  const references = await listKind(store as never, 'image');

  assert.equal(references.length, 80, 'the 80 artifacts whose records still exist are all returned');
  assert.deepEqual(
    references.map((reference) => reference.sha256).sort(),
    Array.from({ length: 80 }, (_, i) => String(i).padStart(64, 'a')).sort(),
    'exactly the surviving artifacts, none of the ones whose record is gone'
  );
  const createdAt = references.map((reference) => reference.createdAtISO);
  assert.deepEqual(
    createdAt,
    [...createdAt].sort((a, b) => b.localeCompare(a)),
    'still newest first after a refill'
  );
  assert.equal(
    new Set(store.reads.filter((key) => key.startsWith('request-artifacts/'))).size,
    120,
    'refilling reads each record at most once'
  );
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
