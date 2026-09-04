/**
 * W2 review — ruling D-D, closed.
 *
 * T2.5 built the `pdf_quality` criterion and its `resolvePdfContentCheck`
 * resolver and then wired NEITHER, because nothing persisted a verdict a
 * synchronous validation pass could read. These tests pin the store that closes
 * it: what it writes, what it refuses to write, and that a corrupted or
 * unreadable entry reads back as ABSENT (which the criterion reports as
 * nothing) rather than as a pass.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ArtifactIndexStore } from './artifact-index.js';
import type { DocumentContentCheck } from './pdf-content-inspection.js';
import { loadPdfContentChecks, pdfContentCheckKey, recordPdfContentCheck } from './pdf-content-check-store.js';

const REQUEST_ID = 'req_plugin_moisturizer_functions_20260903_01';
const SHA = 'c'.repeat(64);
const PUBLIC_PATH = `/pdf/${REQUEST_ID}/${SHA}.pdf`;

const fakeStore = (seed: Record<string, string> = {}) => {
  const blobs = new Map<string, string>(Object.entries(seed));
  const store: ArtifactIndexStore & { blobs: Map<string, string> } = {
    blobs,
    get: async (key) => blobs.get(key) ?? null,
    setJSON: async (key, value) => {
      blobs.set(key, JSON.stringify(value));
      return undefined;
    },
    list: async () => ({ blobs: [], directories: [] }) as never,
  };
  return store;
};

const FAILED: DocumentContentCheck = {
  status: 'failed',
  reason: '2 pages have no readable body text (pages 3, 4).',
  findings: [
    { code: 'BLANK_PAGE', page: 3, detail: 'no readable body text' },
    { code: 'BLANK_PAGE', page: 4, detail: 'no readable body text' },
  ],
  pageCount: 5,
};

test('a recorded verdict is readable back under the PDF public path that named it', async () => {
  const store = fakeStore();
  assert.equal(await recordPdfContentCheck(store, PUBLIC_PATH, FAILED, () => '2026-09-04T10:00:00.000Z'), true);
  assert.ok(store.blobs.has(pdfContentCheckKey(REQUEST_ID, SHA)));

  const loaded = await loadPdfContentChecks(store, [PUBLIC_PATH]);
  assert.deepEqual(loaded, { [PUBLIC_PATH]: FAILED });
});

test('the key is the ARTIFACT, so a re-render never inherits the previous PDF\'s verdict', async () => {
  const store = fakeStore();
  await recordPdfContentCheck(store, PUBLIC_PATH, FAILED);
  const rerendered = `/pdf/${REQUEST_ID}/${'e'.repeat(64)}.pdf`;
  assert.deepEqual(await loadPdfContentChecks(store, [rerendered]), {});
});

test('an absolute URL and its public path address the same verdict', async () => {
  const store = fakeStore();
  await recordPdfContentCheck(store, `https://drluriescience.netlify.app${PUBLIC_PATH}`, FAILED);
  assert.deepEqual(await loadPdfContentChecks(store, [PUBLIC_PATH]), { [PUBLIC_PATH]: FAILED });
});

test('"could not look" is never filed — an unverified check leaves no trace to mistake for one', async () => {
  const store = fakeStore();
  const recorded = await recordPdfContentCheck(store, PUBLIC_PATH, {
    status: 'unverified',
    reason: 'Content could not be inspected: the pdf-tool bridge is not configured.',
  });
  assert.equal(recorded, false);
  assert.equal(store.blobs.size, 0);
  assert.deepEqual(await loadPdfContentChecks(store, [PUBLIC_PATH]), {});
});

test('a store that will not write loses the warning, never the render (D-A)', async () => {
  const broken: ArtifactIndexStore = {
    get: async () => null,
    setJSON: async () => {
      throw new Error('blob store unavailable');
    },
    list: async () => ({ blobs: [], directories: [] }) as never,
  };
  assert.equal(await recordPdfContentCheck(broken, PUBLIC_PATH, FAILED), false);
  assert.equal(await recordPdfContentCheck(undefined, PUBLIC_PATH, FAILED), false);
});

test('a corrupt, truncated or future-shaped entry reads as ABSENT, never as a pass', async () => {
  const key = pdfContentCheckKey(REQUEST_ID, SHA);
  for (const stored of [
    'not json',
    JSON.stringify({ publicPath: PUBLIC_PATH }),
    JSON.stringify({ publicPath: PUBLIC_PATH, checkedAt: 'x', check: { status: 'ok' } }),
    JSON.stringify({ publicPath: PUBLIC_PATH, checkedAt: 'x', check: { status: 'excellent' } }),
    JSON.stringify({ publicPath: PUBLIC_PATH, checkedAt: 'x', check: { status: 'failed', reason: 'r' } }),
  ]) {
    const loaded = await loadPdfContentChecks(fakeStore({ [key]: stored }), [PUBLIC_PATH]);
    assert.deepEqual(loaded, {}, `stored ${stored} must not resolve to a verdict`);
  }
});

test('a read that throws degrades to "not verified" rather than failing the write it was validating', async () => {
  const throwing: ArtifactIndexStore = {
    get: async () => {
      throw new Error('blob store unavailable');
    },
    setJSON: async () => undefined,
    list: async () => ({ blobs: [], directories: [] }) as never,
  };
  assert.deepEqual(await loadPdfContentChecks(throwing, [PUBLIC_PATH]), {});
});

test('a path that is not a platform PDF artifact is neither written nor looked up', async () => {
  const store = fakeStore();
  assert.equal(await recordPdfContentCheck(store, '/files/report.pdf', FAILED), false);
  assert.deepEqual(await loadPdfContentChecks(store, ['/files/report.pdf', `/img/${REQUEST_ID}/${SHA}.webp`]), {});
});
