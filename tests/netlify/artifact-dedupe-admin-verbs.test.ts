/**
 * W2 T2.6 / T2.7 / soft-delete refcount — the admin maintenance passes, driven
 * against fixture stores.
 *
 * These verbs are the only things in the fleet allowed to delete artifact BYTES,
 * so every test here is really one assertion: a blob that something still points
 * at is never removed, and a public path never changes.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectArtifactRefsFromValue,
  dedupeArtifactsBySha,
  sweepOrphanArtifacts,
} from '../../packages/core/server/lib/artifact-dedupe-sweep.js';
import {
  countLiveReferencesForStorageKey,
  removeArtifactBytesIfUnreferenced,
} from '../../packages/core/server/lib/artifact-soft-delete.js';
import { requestArtifactReferenceKey } from '../../packages/core/server/lib/artifact-index.js';
import type { ArtifactReference } from '../../packages/core/server/lib/artifacts.js';

const SHA = 'a'.repeat(64);
const OTHER_SHA = 'b'.repeat(64);

/**
 * One fixture store stands in for BOTH shapes the verbs ask for: the index
 * store (`get(key): Promise<string | null>`) and the byte store
 * (`get(key, { type: 'arrayBuffer' })`). A single inferred method returns the
 * UNION of the two, which satisfies neither parameter type — so the shape is
 * declared as an overloaded `get`, and the implementation is cast to it once
 * here rather than at each of the nine call sites.
 */
type FixtureStore = {
  get(key: string): Promise<string | null>;
  get(key: string, options: { type: 'arrayBuffer' }): Promise<ArrayBuffer | null>;
  setJSON(key: string, value: unknown, options?: { metadata?: Record<string, string> }): Promise<unknown>;
  set(key: string, value: string | Buffer): Promise<unknown>;
  del(key: string): Promise<void>;
  list(options?: {
    prefix?: string;
    directories?: boolean;
    paginate?: boolean;
  }): Promise<{ blobs: { key: string; etag: string }[]; directories: string[] }>;
};

const createStore = (values = new Map<string, string | Buffer>()) => ({
  values,
  store: {
    async get(key: string, options?: { type?: 'arrayBuffer' }) {
      const value = values.get(key);
      if (value === undefined) return null;
      if (options?.type === 'arrayBuffer') {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
      return typeof value === 'string' ? value : value.toString('utf8');
    },
    async setJSON(key: string, value: unknown) {
      values.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async set(key: string, value: string | Buffer) {
      values.set(key, value);
      return { modified: true };
    },
    async del(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      return {
        blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: '' })),
        directories: [],
      };
    },
  } as unknown as FixtureStore,
});

const reference = (overrides: Partial<ArtifactReference> & { requestId: string }): ArtifactReference => {
  const { requestId, ...rest } = overrides;
  const sha256 = rest.sha256 ?? SHA;

  return {
    blobKey: `image/${requestId}/${sha256}.png`,
    sizeBytes: 9,
    sha256,
    contentType: 'image/png',
    createdAtISO: '2026-01-01T00:00:00.000Z',
    artifactKind: 'image',
    ...rest,
  };
};

const seedReference = (indexValues: Map<string, string | Buffer>, requestId: string, ref: ArtifactReference) => {
  indexValues.set(requestArtifactReferenceKey(requestId, ref.sha256), JSON.stringify(ref));
};

// ─── T2.6 ────────────────────────────────────────────────────────────────────

const seedTwoDuplicateBlobs = () => {
  const index = createStore();
  const artifacts = createStore();

  const older = reference({ requestId: 'req_w2_old_20260101_01', createdAtISO: '2026-01-01T00:00:00.000Z' });
  const newer = reference({ requestId: 'req_w2_new_20260201_01', createdAtISO: '2026-02-01T00:00:00.000Z' });

  seedReference(index.values, 'req_w2_old_20260101_01', older);
  seedReference(index.values, 'req_w2_new_20260201_01', newer);
  artifacts.values.set(older.blobKey, Buffer.from('nine byte'));
  artifacts.values.set(newer.blobKey, Buffer.from('nine byte'));

  return { index, artifacts, older, newer };
};

test('artifact_dedupe_by_sha dry run reports the compaction and changes nothing', async () => {
  const { index, artifacts, older, newer } = seedTwoDuplicateBlobs();

  const result = await dedupeArtifactsBySha(index.store, artifacts.store, {
    dryRun: true,
    limit: 50,
    cursor: 0,
  });

  assert.equal(result.dryRun, true);
  assert.equal(result.groups, 1);
  assert.equal(result.blobsDeleted, 1);
  assert.equal(result.bytesFreed, 9);
  assert.deepEqual(result.details[0].blobsDeleted, [newer.blobKey]);
  assert.equal(result.details[0].keptStorageKey, older.blobKey);
  assert.equal(result.details[0].referencesRepointed, 1);

  // Nothing moved.
  assert.equal(artifacts.values.has(older.blobKey), true);
  assert.equal(artifacts.values.has(newer.blobKey), true);
  assert.equal(
    JSON.parse(index.values.get(requestArtifactReferenceKey('req_w2_new_20260201_01', SHA)) as string).storageKey,
    undefined
  );
});

test('artifact_dedupe_by_sha apply keeps the oldest blob, repoints storageKey, and is idempotent', async () => {
  const { index, artifacts, older, newer } = seedTwoDuplicateBlobs();

  const applied = await dedupeArtifactsBySha(index.store, artifacts.store, {
    dryRun: false,
    limit: 50,
    cursor: 0,
  });

  assert.equal(applied.blobsDeleted, 1);
  assert.equal(applied.bytesFreed, 9);
  assert.equal(artifacts.values.has(older.blobKey), true, 'the oldest blob is the keeper');
  assert.equal(artifacts.values.has(newer.blobKey), false, 'the duplicate blob is gone');

  // The reference keeps its OWN blobKey — the public path must not move.
  const rewritten = JSON.parse(index.values.get(requestArtifactReferenceKey('req_w2_new_20260201_01', SHA)) as string);
  assert.equal(rewritten.blobKey, newer.blobKey);
  assert.equal(rewritten.storageKey, older.blobKey);

  // The by-sha index now names the keeper.
  assert.equal(JSON.parse(index.values.get(`by-sha/image/${SHA}.json`) as string).storageKey, older.blobKey);

  // Idempotent: a second apply finds one storage key and does nothing.
  const again = await dedupeArtifactsBySha(index.store, artifacts.store, { dryRun: false, limit: 50, cursor: 0 });
  assert.equal(again.blobsDeleted, 0);
  assert.equal(again.bytesFreed, 0);
  assert.equal(again.details[0].skippedReason, 'already-deduped');
});

test('artifact_dedupe_by_sha leaves a group alone when the keeper bytes do not verify', async () => {
  const { index, artifacts, older, newer } = seedTwoDuplicateBlobs();
  artifacts.values.delete(older.blobKey);

  const result = await dedupeArtifactsBySha(index.store, artifacts.store, { dryRun: false, limit: 50, cursor: 0 });

  assert.equal(result.details[0].skippedReason, 'keeper-bytes-unverified');
  assert.equal(result.blobsDeleted, 0);
  assert.equal(artifacts.values.has(newer.blobKey), true);
});

// ─── T2.7 ────────────────────────────────────────────────────────────────────

test('orphan sweep never touches a referenced artifact and reports dangling refs instead of fixing them', async () => {
  const index = createStore();
  const objects = createStore();

  const used = reference({ requestId: 'req_w2_used_20260301_01' });
  const unused = reference({ requestId: 'req_w2_unused_20260301_01', sha256: OTHER_SHA });
  seedReference(index.values, 'req_w2_used_20260301_01', used);
  seedReference(index.values, 'req_w2_unused_20260301_01', unused);

  const missingKey = 'image/req_w2_used_20260301_01/' + 'c'.repeat(64) + '.png';

  objects.values.set('objects/page/index/by-status/active/page-home', '');
  objects.values.set(
    'objects/page/by-id/page-home.json',
    JSON.stringify({
      object_id: 'page-home',
      body: {
        // The public path form, deep inside the record — the sweep must see it.
        sections: [{ props: { src: `/img/req_w2_used_20260301_01/${SHA}.png` } }],
        // An object citing an artifact that has no live reference: DANGLING.
        ogImage: `/img/req_w2_used_20260301_01/${'c'.repeat(64)}.png`,
      },
    })
  );

  const dry = await sweepOrphanArtifacts(index.store, objects.store, {
    dryRun: true,
    deletedBy: 'tester',
    limit: 50,
    cursor: 0,
  });

  assert.equal(dry.orphans, 1);
  assert.equal(dry.softDeleted, 0);
  assert.deepEqual(
    dry.byRequest.map((group) => group.requestId),
    ['req_w2_unused_20260301_01']
  );
  assert.deepEqual(
    dry.dangling.map((entry) => entry.blobKey),
    [missingKey]
  );
  assert.deepEqual(dry.dangling[0].citedBy, [{ objectType: 'page', objectId: 'page-home' }]);

  const applied = await sweepOrphanArtifacts(index.store, objects.store, {
    dryRun: false,
    deletedBy: 'tester',
    limit: 50,
    cursor: 0,
  });

  assert.equal(applied.softDeleted, 1);

  // The referenced artifact is untouched...
  const keptReference = JSON.parse(
    index.values.get(requestArtifactReferenceKey('req_w2_used_20260301_01', SHA)) as string
  );
  assert.equal(keptReference.deletedAtISO, undefined);

  // ...the orphan is soft-deleted, and the object body was NOT edited.
  const sweptReference = JSON.parse(
    index.values.get(requestArtifactReferenceKey('req_w2_unused_20260301_01', OTHER_SHA)) as string
  );
  assert.equal(typeof sweptReference.deletedAtISO, 'string');
  assert.equal(sweptReference.deletedBy, 'tester');
  assert.match(objects.values.get('objects/page/by-id/page-home.json') as string, /c{64}/);
});

test('the reference collector reads both the public path and the raw Major Key form', () => {
  const found = collectArtifactRefsFromValue({
    a: `/img/req_a/${SHA}.png`,
    b: [{ heroAssetRef: `image/req_b/${OTHER_SHA}.webp` }],
    c: `/pdf/req_c/${SHA}.pdf`,
    ignored: 'https://example.test/not-an-artifact.png',
  });

  assert.deepEqual(
    [...found].sort(),
    [`image/req_a/${SHA}.png`, `image/req_b/${OTHER_SHA}.webp`, `pdf/req_c/${SHA}.pdf`].sort()
  );
});

// ─── soft-delete refcount ────────────────────────────────────────────────────

test('soft delete with a shared storageKey keeps the bytes', async () => {
  const index = createStore();
  const artifacts = createStore();

  const owner = reference({ requestId: 'req_w2_owner_20260301_01' });
  const sharer = reference({ requestId: 'req_w2_sharer_20260301_01', storageKey: owner.blobKey });
  seedReference(index.values, 'req_w2_owner_20260301_01', owner);
  seedReference(index.values, 'req_w2_sharer_20260301_01', sharer);
  artifacts.values.set(owner.blobKey, Buffer.from('nine byte'));

  const refcount = await countLiveReferencesForStorageKey(index.store, owner.blobKey, SHA, {
    excludeRequestId: 'req_w2_owner_20260301_01',
  });
  assert.equal(refcount.liveReferences, 1);
  assert.deepEqual(refcount.requestIds, ['req_w2_sharer_20260301_01']);

  const blocked = await removeArtifactBytesIfUnreferenced(index.store, artifacts.store, owner, {
    excludeRequestId: 'req_w2_owner_20260301_01',
  });
  assert.deepEqual(blocked, {
    removed: false,
    storageKey: owner.blobKey,
    reason: 'shared',
    sizeBytes: 0,
    sharedWith: ['req_w2_sharer_20260301_01'],
  });
  assert.equal(artifacts.values.has(owner.blobKey), true, 'bytes another reference points at must survive');

  // Once the sharer is gone too, the same call removes them.
  index.values.set(
    requestArtifactReferenceKey('req_w2_sharer_20260301_01', SHA),
    JSON.stringify({ ...sharer, deletedAtISO: '2026-03-01T00:00:00.000Z', deletedBy: 'tester' })
  );

  const removed = await removeArtifactBytesIfUnreferenced(index.store, artifacts.store, owner, {
    excludeRequestId: 'req_w2_owner_20260301_01',
  });
  assert.equal(removed.removed, true);
  assert.equal(removed.reason, 'removed');
  assert.equal(removed.sizeBytes, 9);
  assert.equal(artifacts.values.has(owner.blobKey), false);
});
