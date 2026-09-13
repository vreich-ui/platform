import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleCaptureRunInputs,
  blockScreenshotPaths,
  fetchGitBlob,
  fetchSourceScreenshots,
  resolveWithinRoot,
} from '../../scripts/ci/capture-preview-inputs.mjs';
import {
  assertPreviewPublishedNothing,
  renderRunSummary,
  summarizeFidelity,
} from '../../scripts/ci/capture-preview-report.mjs';

/**
 * W2.1/G6-T1 — the capture-fidelity CI job's two scripts.
 *
 * The job itself cannot be unit-tested (it needs a runner, a browser and a live pdf-tool), so what
 * is pinned here is everything that decides whether the job produces a real score or a page of
 * `unavailable`:
 *
 *   - PATH FIDELITY. A source screenshot must land at EXACTLY its snapshot `path` under the run
 *     root, because that is what `score.mjs`'s `evidencePath` resolves against. This is the single
 *     highest-risk property in the whole task: get it wrong and every pair reads `unavailable`,
 *     which is indistinguishable from the defect being fixed.
 *   - INTEGRITY. Bytes whose digest does not match what pdf-tool recorded are a hard failure, not a
 *     warning — a score computed over the wrong pixels is worse than no score.
 *   - COMPLETENESS. A path pdf-tool neither returns nor defers is an error, never a silent
 *     omission. Silent omission is exactly how "0 scored / 34 unavailable" survived a whole
 *     acceptance cycle.
 *   - THE NO-PUBLISH PROPERTY, asserted against the committed preview fixture and against every
 *     way a manifest could stop stating it.
 */

const FIXTURE_RUN = path.resolve(
  fileURLToPath(new URL('../../packages/core/cli/capture/fixtures/preview-fixture/run/', import.meta.url))
);
const readFixture = async (name) => JSON.parse(await readFile(path.join(FIXTURE_RUN, name), 'utf8'));

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const PNG_SHA = createHash('sha256').update(PNG).digest('hex');

const shot = (path_, over = {}) => ({
  path: path_,
  filename: path_.replace(/^pages\//, '').replaceAll('/', '-'),
  sha256: PNG_SHA,
  sizeBytes: PNG.byteLength,
  contentType: 'image/png',
  bytesBase64: PNG.toString('base64'),
  ...over,
});

const jsonResponse = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

async function withTempRoot(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'capture-preview-ci-'));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ── the source screenshot set ────────────────────────────────────────────────────────────────

test('blockScreenshotPaths takes captured BLOCK shots only, deduped, in snapshot order', () => {
  const snapshot = {
    pages: [
      {
        blocks: [
          {
            screenshots: [
              { path: 'pages/p1/desktop/full-page.png', kind: 'full-page', captured: true },
              { path: 'pages/p1/desktop/blocks/b1.png', kind: 'block', captured: true },
              { path: 'pages/p1/mobile/blocks/b1.png', kind: 'block', captured: true },
              { path: 'pages/p1/desktop/blocks/b2.png', kind: 'block', captured: false },
            ],
          },
          { screenshots: [{ path: 'pages/p1/desktop/blocks/b1.png', kind: 'block', captured: true }] },
        ],
      },
    ],
  };
  // `scoreVisuals` compares block shots and nothing else, so a full-page shot would be bytes over
  // the wire no comparison reads. `captured: false` is an already-enumerated gap, not a fetch.
  assert.deepEqual(blockScreenshotPaths(snapshot), ['pages/p1/desktop/blocks/b1.png', 'pages/p1/mobile/blocks/b1.png']);
  assert.deepEqual(blockScreenshotPaths({}), []);
});

test('a screenshot path can never be written outside the run root', () => {
  assert.equal(resolveWithinRoot('/run', 'pages/a/desktop/blocks/b.png'), path.resolve('/run/pages/a/desktop/blocks/b.png'));
  for (const bad of ['../escape.png', '/etc/passwd', 'pages/../../escape.png', '', null]) {
    assert.throws(() => resolveWithinRoot('/run', bad), /not a relative path|escapes the run root/);
  }
});

// ── the stage documents (git blob transport) ─────────────────────────────────────────────────

test('git blobs are read raw, refused when malformed, and named clearly when gone', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, arrayBuffer: async () => Buffer.from('{"ok":true}') };
  };
  const sha = 'a'.repeat(40);
  const bytes = await fetchGitBlob({ repository: 'vreich-ui/platform', sha, token: 'tkn', fetchImpl });
  assert.equal(bytes.toString('utf8'), '{"ok":true}');
  assert.equal(calls[0].url, `https://api.github.com/repos/vreich-ui/platform/git/blobs/${sha}`);
  // Raw, not the base64 envelope — a 187 KB snapshot is one request either way, but raw is what
  // the caller writes straight to disk.
  assert.equal(calls[0].init.headers.accept, 'application/vnd.github.raw');
  assert.equal(calls[0].init.headers.authorization, 'Bearer tkn');

  await assert.rejects(() => fetchGitBlob({ repository: 'r/r', sha: 'not-a-sha', token: 't', fetchImpl }), /not a 40-character git blob sha/);
  await assert.rejects(
    () => fetchGitBlob({ repository: 'r/r', sha, token: 't', fetchImpl: async () => ({ ok: false, status: 404, arrayBuffer: async () => Buffer.alloc(0) }) }),
    /unreferenced/
  );
});

// ── the screenshot fetch ─────────────────────────────────────────────────────────────────────

test('source screenshots land at their snapshot paths, verbatim, and pdf-tool\'s paging is followed', async () => {
  await withTempRoot(async (root) => {
    const paths = ['pages/p1/desktop/blocks/b1.png', 'pages/p1/mobile/blocks/b1.png', 'pages/p2/desktop/blocks/b9.png'];
    const bodies = [
      { screenshots: [shot(paths[0])], missing: [], truncated: true, remainingPaths: [paths[1], paths[2]] },
      { screenshots: [shot(paths[1])], missing: [{ path: paths[2], reason: 'screenshot_not_indexed_for_this_request' }], truncated: false, remainingPaths: [] },
    ];
    let call = 0;
    const fetchImpl = async () => jsonResponse(bodies[call++]);
    const result = await fetchSourceScreenshots({
      baseUrl: 'https://pdf.example.com/',
      token: 'tkn',
      projectId: 'site_zilberman',
      jobId: 'job-1',
      paths,
      runRoot: root,
      fetchImpl,
    });
    assert.equal(call, 2, 'the deferred paths were re-requested');
    assert.equal(result.written.length, 2);
    assert.deepEqual(result.missing, [{ path: paths[2], reason: 'screenshot_not_indexed_for_this_request', detail: undefined }]);
    // THE property: byte-identical, at the exact path score.mjs will resolve.
    for (const written of [paths[0], paths[1]]) {
      assert.deepEqual(await readFile(path.join(root, written)), PNG);
    }
  });
});

test('a screenshot whose digest does not match is a hard failure, never a scored comparison', async () => {
  await withTempRoot(async (root) => {
    const fetchImpl = async () =>
      jsonResponse({ screenshots: [shot('pages/p1/desktop/blocks/b1.png', { sha256: 'f'.repeat(64) })], missing: [], remainingPaths: [] });
    await assert.rejects(
      () => fetchSourceScreenshots({ baseUrl: 'https://pdf.example.com', token: 't', projectId: 'p', jobId: 'j', paths: ['pages/p1/desktop/blocks/b1.png'], runRoot: root, fetchImpl }),
      /failed its digest check/
    );
  });
});

test('a path pdf-tool neither answers nor defers is an error, not a silent omission', async () => {
  await withTempRoot(async (root) => {
    const fetchImpl = async () => jsonResponse({ screenshots: [], missing: [], remainingPaths: [] });
    await assert.rejects(
      () => fetchSourceScreenshots({ baseUrl: 'https://pdf.example.com', token: 't', projectId: 'p', jobId: 'j', paths: ['pages/p1/desktop/blocks/b1.png'], runRoot: root, fetchImpl }),
      /answered neither with bytes nor a reason/
    );
  });
});

test('a refusal from pdf-tool names its own error code rather than becoming an empty run', async () => {
  await withTempRoot(async (root) => {
    const fetchImpl = async () => jsonResponse({ error: 'Capture job not found', errorCode: 'CAPTURE_JOB_NOT_FOUND' }, 404);
    await assert.rejects(
      () => fetchSourceScreenshots({ baseUrl: 'https://pdf.example.com', token: 't', projectId: 'p', jobId: 'j', paths: ['pages/p1/desktop/blocks/b1.png'], runRoot: root, fetchImpl }),
      /CAPTURE_JOB_NOT_FOUND/
    );
  });
});

// ── assembly ─────────────────────────────────────────────────────────────────────────────────

test('assembly writes the four stage documents and every source shot into ONE run root', async () => {
  await withTempRoot(async (root) => {
    const snapshot = {
      pages: [{ blocks: [{ screenshots: [{ path: 'pages/p1/desktop/blocks/b1.png', kind: 'block', captured: true }] }] }],
    };
    const documents = {
      ['a'.repeat(40)]: snapshot,
      ['b'.repeat(40)]: { pages: [] },
      ['c'.repeat(40)]: { operations: [] },
      ['d'.repeat(40)]: { tokens: {} },
    };
    const fetchImpl = async (url, init) => {
      if (url.includes('/git/blobs/')) {
        const sha = url.split('/').pop();
        return { ok: true, status: 200, arrayBuffer: async () => Buffer.from(JSON.stringify(documents[sha])) };
      }
      const requested = JSON.parse(init.body).paths;
      return jsonResponse({ screenshots: requested.map((candidate) => shot(candidate)), missing: [], remainingPaths: [] });
    };
    const summary = await assembleCaptureRunInputs({
      runRoot: root,
      repository: 'vreich-ui/platform',
      githubToken: 'gh',
      blobs: { snapshot: 'a'.repeat(40), mapping: 'b'.repeat(40), plan: 'c'.repeat(40), theme: 'd'.repeat(40) },
      pdfTool: { baseUrl: 'https://pdf.example.com', token: 'pdf', projectId: 'site_zilberman', jobId: 'job-1' },
      fetchImpl,
    });
    // The filenames the workflow passes to preview.mjs / score.mjs verbatim.
    for (const name of ['snapshot.v1.json', 'capture-map.v1.json', 'capture-emission-plan.v1.json', 'theme.v1.json']) {
      await readFile(path.join(root, name), 'utf8');
    }
    assert.equal(summary.screenshots.declared, 1);
    assert.equal(summary.screenshots.written, 1);
    assert.deepEqual(summary.screenshots.missing, []);
    assert.deepEqual(await readFile(path.join(root, 'pages/p1/desktop/blocks/b1.png')), PNG);
  });
});

test('a snapshot with no captured block screenshots refuses instead of producing an empty score', async () => {
  await withTempRoot(async (root) => {
    const fetchImpl = async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('{"pages":[]}') });
    await assert.rejects(
      () =>
        assembleCaptureRunInputs({
          runRoot: root,
          repository: 'r/r',
          githubToken: 'gh',
          blobs: { snapshot: 'a'.repeat(40), mapping: 'b'.repeat(40), plan: 'c'.repeat(40), theme: 'd'.repeat(40) },
          pdfTool: { baseUrl: 'https://pdf.example.com', token: 'p', projectId: 'p', jobId: 'j' },
          fetchImpl,
        }),
      /nothing for the scorer to compare against/
    );
  });
});

// ── the no-publish property, and the outcome document ────────────────────────────────────────

test('the committed preview fixture proves the no-publish property, and every way of losing it fails', async () => {
  const manifest = await readFixture('capture-preview.v1.json');
  assert.equal(assertPreviewPublishedNothing(manifest), true);

  for (const outcome of ['published', 'released', 'deployed']) {
    assert.throws(
      () => assertPreviewPublishedNothing({ ...manifest, preview: { ...manifest.preview, [outcome]: true } }),
      new RegExp(`preview\\.${outcome}`)
    );
    // Absent is a failure too: a manifest that stopped STATING the property stopped proving it.
    const without = { ...manifest.preview };
    delete without[outcome];
    assert.throws(() => assertPreviewPublishedNothing({ ...manifest, preview: without }), new RegExp(`preview\\.${outcome}`));
  }
  assert.throws(
    () => assertPreviewPublishedNothing({ ...manifest, preview: { ...manifest.preview, refusedVerbs: ['deploy'] } }),
    /does not record "object_publish"/
  );
  assert.throws(() => assertPreviewPublishedNothing({ pages: [] }), /carries no `preview` block/);
});

test('the outcome document reduces a real fidelity report to what a human and cms-agent both need', async () => {
  const [report, manifest] = await Promise.all([readFixture('fidelity-report.v1.json'), readFixture('capture-preview.v1.json')]);
  const outcome = summarizeFidelity({ report, manifest, inputs: { screenshots: { declared: 16, written: 16, missing: [] } } });

  // The fixture is a REAL run: 12 scored, 4 unavailable — proof the pipeline scores above zero,
  // which is the whole acceptance criterion, and proof the outcome reports the residue honestly.
  assert.equal(outcome.visual.scoredCount, 12);
  assert.ok(outcome.visual.scoredCount > 0, 'the fixture scores real comparisons');
  assert.equal(outcome.visual.unavailableCount, 4);
  assert.equal(outcome.visual.evidenceComplete, false);
  assert.equal(outcome.visual.aggregateScore, report.visual.aggregateScore);
  assert.equal(outcome.verdict, report.rubric.verdict);
  assert.equal(outcome.preview.published, false);
  assert.equal(outcome.preview.pages, manifest.pages.length);
  assert.ok(outcome.visual.reasons.length > 0, 'unavailable comparisons are explained, never just counted');
  assert.equal(
    outcome.visual.reasons.reduce((total, entry) => total + entry.count, 0),
    report.visual.defectCount
  );

  const summary = renderRunSummary(outcome);
  assert.match(summary, /Visual comparisons scored \| 12/);
  assert.match(summary, /Evidence complete \| NO/);
  assert.match(summary, /nothing \(refused\)/);
});
