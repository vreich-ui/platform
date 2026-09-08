/**
 * Does a tag applied through `retag-artifact` survive the store and come back
 * out where the inventory search looks for it?
 *
 * This test exists because of a live acceptance failure: the owner bulk-tagged
 * two artifacts with `t9-acceptance`, the page reported success, and an
 * immediate search for that tag returned "Artifacts 0". Four causes were
 * plausible on paper and only one of them can be settled by reading the code:
 *
 *   1. `writeArtifactReferenceIndexes` writes the by-tag / by-request pointers
 *      but leaves the CANONICAL `request-artifacts/<requestId>/<sha>.json`
 *      body on its old value;
 *   2. the search's sweep reads a projection that drops `tags`;
 *   3. `getArtifactReferenceIssue` strips or rejects `tags` on write or read;
 *   4. the bulk path sends a different wire shape than the single path.
 *
 * So this drives the REAL write path and the REAL read path against a real
 * (file-backed) store, with a production-shaped reference, and follows the
 * artifact through the exact sequence `server/functions/admin-inventory.ts`
 * runs: sweep the index the way `readArtifactReferences` does, normalize the
 * row, take the hit id the CLIENT would send back, parse it, apply the tag
 * arithmetic, write, and sweep again. If any of causes 1–3 were real, one of
 * these assertions fails.
 *
 * It is a regression fence, not a reproduction: it passes, which is the
 * evidence that the tag is not lost in the write or the read. What was
 * actually wrong is that NOTHING checked — see `handleRetagArtifact`'s
 * read-back and `lib/admin/artifact-retag-verification.ts`.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createLocalBlobStore, setLocalBlobsRootForTesting } from './local-blobs.js';
import {
  artifactTagPointerKeys,
  listArtifactIndexKeys,
  readArtifactReferenceResult,
  requestArtifactReferenceKey,
  writeArtifactReferenceIndexes,
  type ArtifactIndexStore,
} from './artifact-index.js';
import type { ArtifactReference } from './artifacts.js';
import {
  applyArtifactTagChanges,
  artifactMatchFields,
  matchesInventoryQuery,
  normalizeArtifactHit,
  normalizeInventoryQuery,
  parseArtifactHitId,
} from '../../lib/admin/inventory-server-logic.js';

const REQUEST_ID = 'req_agent_skin_barrier_damage_20260906_01';
const SHA = '9811d7d00c860d2a60b5e98423f71a5113e7712fdb45eecf5ef81a0a0e7470c6';

/**
 * A reference shaped like the ones production actually holds: pdf-tool's
 * `filename` alongside `originalFilename`, an EMPTY `tags` array (the shape
 * the image pipeline writes, not the absent-key shape `createArtifactReference`
 * writes), and an opaque nested `metadata` bag.
 */
const productionShapedReference = (): ArtifactReference =>
  ({
    blobKey: `image/${REQUEST_ID}/${SHA}.png`,
    sizeBytes: 1005827,
    sha256: SHA,
    contentType: 'image/png',
    createdAtISO: '2026-09-06T15:41:21.852Z',
    artifactKind: 'image',
    originalFilename: 'skin-barrier-anatomy.png',
    filename: 'skin-barrier-anatomy.png',
    label: 'Skin barrier anatomy diagram',
    tags: [],
    metadata: { import: { sourceUrl: 'https://example.test/x.png', license: { class: 'unknown' } } },
  }) as unknown as ArtifactReference;

/** Byte-for-byte the sweep `admin-inventory.ts`'s `readArtifactReferences` performs. */
const sweepArtifactIndex = async (store: ArtifactIndexStore) => {
  const keys = await listArtifactIndexKeys(store, 'request-artifacts/');
  const references: Array<ArtifactReference & { requestId: string }> = [];
  const dropped: string[] = [];

  for (const key of keys) {
    const match = key.match(/^request-artifacts\/([^/]+)\/([a-f0-9]{64})\.json$/i);
    if (!match) {
      dropped.push(`${key}: key shape`);
      continue;
    }
    const requestId = decodeURIComponent(match[1] ?? '');
    const sha256 = (match[2] ?? '').toLowerCase();
    const read = await readArtifactReferenceResult(store, requestId, sha256);
    if (read.status !== 'ok') {
      dropped.push(`${key}: ${read.status === 'rejected' ? read.issue : 'absent'}`);
      continue;
    }
    references.push({ ...read.reference, requestId });
  }

  return { references, dropped };
};

const withStore = async (run: (store: ArtifactIndexStore) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), 'artifact-index-tag-'));
  setLocalBlobsRootForTesting(root);
  try {
    await run(createLocalBlobStore('artifact-index') as unknown as ArtifactIndexStore);
  } finally {
    setLocalBlobsRootForTesting(undefined);
    await rm(root, { recursive: true, force: true });
  }
};

describe('artifact index: a tag applied through the retag path is findable again', () => {
  it('persists the tag on the CANONICAL reference, not only on the by-tag pointer', async () => {
    await withStore(async (store) => {
      await writeArtifactReferenceIndexes(store, REQUEST_ID, productionShapedReference());

      const before = await sweepArtifactIndex(store);
      assert.deepStrictEqual(before.dropped, []);
      assert.strictEqual(before.references.length, 1);

      // The id the CLIENT holds, and the only thing it sends back on a retag.
      const hitId = normalizeArtifactHit(before.references[0]!).id;
      const parsed = parseArtifactHitId(hitId);
      assert.ok(parsed, 'the hit id the search emits must parse back into requestId + sha256');

      // ── exactly what `handleRetagArtifact` does ──────────────────────────
      const read = await readArtifactReferenceResult(store, parsed.requestId, parsed.sha256);
      assert.strictEqual(read.status, 'ok');
      if (read.status !== 'ok') return;

      const change = applyArtifactTagChanges(read.reference.tags, ['t9-acceptance'], []);
      assert.deepStrictEqual(change.rejected, []);
      assert.deepStrictEqual(change.tags, ['t9-acceptance']);

      const updated: ArtifactReference = { ...read.reference, ...(change.tags.length ? { tags: change.tags } : {}) };
      await writeArtifactReferenceIndexes(store, parsed.requestId, updated);

      // The canonical record — the one the sweep reads — carries the tag.
      const canonical = await store.get(requestArtifactReferenceKey(parsed.requestId, parsed.sha256));
      assert.ok(canonical);
      assert.deepStrictEqual((JSON.parse(canonical) as ArtifactReference).tags, ['t9-acceptance']);

      // …and so does the by-tag pointer the MCP browse tools resolve through.
      const pointerKeys = await listArtifactIndexKeys(store, 'by-tag/t9-acceptance/');
      assert.deepStrictEqual(pointerKeys, artifactTagPointerKeys(updated));
    });
  });

  it('re-reads the tag through the search sweep and matches it with the search query', async () => {
    await withStore(async (store) => {
      const reference = productionShapedReference();
      await writeArtifactReferenceIndexes(store, REQUEST_ID, reference);
      await writeArtifactReferenceIndexes(store, REQUEST_ID, { ...reference, tags: ['t9-acceptance'] });

      const after = await sweepArtifactIndex(store);
      // A reference the parse step rejected would be dropped SILENTLY by the
      // sweep — name them rather than only counting what survived.
      assert.deepStrictEqual(after.dropped, []);
      assert.strictEqual(after.references.length, 1);

      const found = after.references[0]!;
      assert.deepStrictEqual(found.tags, ['t9-acceptance']);
      assert.ok(artifactMatchFields(found).includes('t9-acceptance'));

      const matched = after.references.filter((entry) =>
        matchesInventoryQuery(normalizeInventoryQuery('t9-acceptance'), artifactMatchFields(entry))
      );
      assert.strictEqual(matched.length, 1);
    });
  });

  it('drops the by-tag pointer set when the last tag is removed, and the search stops matching', async () => {
    await withStore(async (store) => {
      const reference = productionShapedReference();
      await writeArtifactReferenceIndexes(store, REQUEST_ID, { ...reference, tags: ['t9-acceptance'] });

      const read = await readArtifactReferenceResult(store, REQUEST_ID, SHA);
      assert.strictEqual(read.status, 'ok');
      if (read.status !== 'ok') return;

      const change = applyArtifactTagChanges(read.reference.tags, [], ['t9-acceptance']);
      assert.deepStrictEqual(change.tags, []);
      assert.deepStrictEqual(change.removed, ['t9-acceptance']);

      const updated: ArtifactReference = { ...read.reference };
      delete updated.tags;
      await writeArtifactReferenceIndexes(store, REQUEST_ID, updated);

      assert.deepStrictEqual(artifactTagPointerKeys(updated), []);

      const after = await sweepArtifactIndex(store);
      assert.deepStrictEqual(after.dropped, []);
      const matched = after.references.filter((entry) =>
        matchesInventoryQuery(normalizeInventoryQuery('t9-acceptance'), artifactMatchFields(entry))
      );
      assert.strictEqual(matched.length, 0);
    });
  });
});
