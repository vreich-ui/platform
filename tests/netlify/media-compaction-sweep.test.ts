/**
 * W4 — the scheduled media compaction sweep, driven end to end against fixture
 * stores. This is the function that makes `artifact_orphan_sweep` and
 * `artifact_dedupe_by_sha` actually happen on every tenant instead of waiting
 * for an operator who never runs them (Wolf, 2026-09-13: fix the mechanism, not
 * the tenant), so the assertions here are about what an UNATTENDED run is
 * allowed to do:
 *
 *   - it retires only what nothing cites, and only once it is old enough that a
 *     still-running capture cannot be the reason nothing cites it yet,
 *   - it never deletes the bytes behind a reference it soft-deleted (restore),
 *   - it never moves a public `/img|/pdf` path when it collapses duplicates,
 *   - it REPORTS a dangling reference and repairs nothing,
 *   - and a second run the same day changes nothing at all.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers
import assert from 'node:assert/strict';
import test from 'node:test';

import { runMediaCompactionSweep, ORPHAN_GRACE_MS } from '../../packages/core/server/lib/media-compaction-run.js';
import { requestArtifactReferenceKey } from '../../packages/core/server/lib/artifact-index.js';
import { MEDIA_COMPACTION_HEARTBEAT_KEY } from '../../packages/core/server/lib/media-compaction-heartbeat.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import type { ArtifactReference } from '../../packages/core/server/lib/artifacts.js';

type FakeValue = Buffer | string;

const createFakeStore = (values = new Map<string, FakeValue>()) => ({
  values,
  store: {
    async set(key: string, value: string | Buffer | Uint8Array, options?: { onlyIfNew?: boolean }) {
      if (options?.onlyIfNew && values.has(key)) return { modified: false };
      values.set(key, typeof value === 'string' ? value : Buffer.from(value));
      return { modified: true };
    },
    async setJSON(key: string, value: unknown) {
      values.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async get(key: string, options?: { type?: 'arrayBuffer' }) {
      const value = values.get(key);
      if (value === undefined) return null;
      if (options?.type === 'arrayBuffer') {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      }
      return typeof value === 'string' ? value : value.toString('utf8');
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
  },
});

const withStores = async (
  fn: (stores: {
    artifactValues: Map<string, FakeValue>;
    indexValues: Map<string, FakeValue>;
    objectValues: Map<string, FakeValue>;
  }) => Promise<void>
) => {
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const artifacts = createFakeStore();
  const index = createFakeStore();
  const objects = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input: string | { name: string }) {
      const name = typeof input === 'string' ? input : input.name;
      if (name === 'artifacts') return artifacts.store as never;
      if (name === 'artifact-index') return index.store as never;
      if (name === 'site-objects') return objects.store as never;
      throw new Error(`Unexpected blob store: ${name}`);
    },
  } as never);

  try {
    await fn({ artifactValues: artifacts.values, indexValues: index.values, objectValues: objects.values });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
};

const NOW = '2026-09-13T03:41:00.000Z';
const LONG_AGO = '2026-08-23T00:00:00.000Z';
const JUST_NOW = new Date(Date.parse(NOW) - ORPHAN_GRACE_MS / 2).toISOString();

const SHA_ORPHAN = 'a'.repeat(64);
const SHA_FRESH = 'b'.repeat(64);
const SHA_SHARED = 'c'.repeat(64);
const SHA_MISSING = 'd'.repeat(64);

const reference = (requestId: string, sha256: string, createdAtISO: string): ArtifactReference => ({
  blobKey: `image/${requestId}/${sha256}.png`,
  sizeBytes: 9,
  sha256,
  contentType: 'image/png',
  createdAtISO,
  artifactKind: 'image',
});

const seed = (stores: {
  artifactValues: Map<string, FakeValue>;
  indexValues: Map<string, FakeValue>;
  objectValues: Map<string, FakeValue>;
}) => {
  const put = (ref: ArtifactReference, requestId: string) => {
    stores.indexValues.set(requestArtifactReferenceKey(requestId, ref.sha256), JSON.stringify(ref));
    stores.artifactValues.set(ref.blobKey, Buffer.from('nine byte'));
    return ref;
  };

  // An Aug-23 orphan: nothing cites it, old enough to judge.
  const orphan = put(reference('req_capture_zilberman_20260823_05', SHA_ORPHAN, LONG_AGO), 'req_capture_zilberman_20260823_05');

  // A capture that uploaded its artifact minutes ago and has not written its page yet.
  const fresh = put(reference('req_capture_zilberman_20260913_01', SHA_FRESH, JUST_NOW), 'req_capture_zilberman_20260913_01');

  // Two live references, same bytes, two blobs — both cited by a live page.
  const older = put(reference('req_capture_zilberman_20260910_01', SHA_SHARED, '2026-09-10T10:00:00.000Z'), 'req_capture_zilberman_20260910_01');
  const newer = put(reference('req_capture_zilberman_20260910_05', SHA_SHARED, '2026-09-10T12:00:00.000Z'), 'req_capture_zilberman_20260910_05');

  // The page that cites both shared images, plus one src whose reference does not exist.
  const danglingKey = `image/req_capture_zilberman_20260910_01/${SHA_MISSING}.png`;
  stores.objectValues.set('objects/page/index/by-status/active/page_home', '');
  stores.objectValues.set(
    'objects/page/by-id/page_home.json',
    JSON.stringify({
      object_id: 'page_home',
      body: [
        { type: 'image', src: `/img/req_capture_zilberman_20260910_01/${SHA_SHARED}.png` },
        { type: 'image', src: `/img/req_capture_zilberman_20260910_05/${SHA_SHARED}.png` },
        { type: 'image', src: `/img/req_capture_zilberman_20260910_01/${SHA_MISSING}.png` },
      ],
    })
  );

  return { orphan, fresh, older, newer, danglingKey };
};

test('the scheduled sweep retires an aged orphan, holds back a fresh one, and reports it', async () => {
  await withStores(async (stores) => {
    const { orphan, fresh } = seed(stores);

    const result = await runMediaCompactionSweep({}, NOW);

    assert.equal(result.orphans_soft_deleted, 1);
    assert.equal(result.skipped_recent, 1, 'the artifact uploaded inside the grace window is held back');

    const orphanRef = JSON.parse(
      stores.indexValues.get(requestArtifactReferenceKey('req_capture_zilberman_20260823_05', SHA_ORPHAN)) as string
    );
    assert.equal(orphanRef.deletedAtISO, NOW);
    assert.equal(orphanRef.deletedBy, 'media-compaction-sweep');

    // Soft delete: the BYTES stay, so restore_artifact still works.
    assert.equal(stores.artifactValues.has(orphan.blobKey), true, 'a soft delete must not remove bytes');

    // The fresh capture is untouched in every way.
    const freshRef = JSON.parse(
      stores.indexValues.get(requestArtifactReferenceKey('req_capture_zilberman_20260913_01', SHA_FRESH)) as string
    );
    assert.equal(freshRef.deletedAtISO, undefined);
    assert.equal(stores.artifactValues.has(fresh.blobKey), true);
  });
});

test('the scheduled sweep collapses a byte-duplicate without moving either public path', async () => {
  await withStores(async (stores) => {
    const { older, newer } = seed(stores);

    const result = await runMediaCompactionSweep({}, NOW);

    assert.equal(result.dedupe_groups, 1);
    assert.equal(result.blobs_deleted, 1);
    assert.equal(result.bytes_freed, 9);

    assert.equal(stores.artifactValues.has(older.blobKey), true, 'the oldest blob is the keeper');
    assert.equal(stores.artifactValues.has(newer.blobKey), false, 'the duplicate bytes are gone');

    // blobKey is IDENTITY: the newer reference keeps its own public path and gains
    // only a read-side redirect, so /img/<its request>/<sha>.png still resolves.
    const rewritten = JSON.parse(
      stores.indexValues.get(requestArtifactReferenceKey('req_capture_zilberman_20260910_05', SHA_SHARED)) as string
    );
    assert.equal(rewritten.blobKey, newer.blobKey);
    assert.equal(rewritten.storageKey, older.blobKey);
    assert.equal(rewritten.deletedAtISO, undefined, 'a cited artifact is never swept');
  });
});

test('the scheduled sweep reports a dangling reference and repairs nothing', async () => {
  await withStores(async (stores) => {
    const { danglingKey } = seed(stores);
    const pageBefore = stores.objectValues.get('objects/page/by-id/page_home.json');

    const result = await runMediaCompactionSweep({}, NOW);

    assert.equal(result.dangling, 1);
    assert.deepEqual(result.dangling_keys, [danglingKey]);
    assert.equal(
      stores.objectValues.get('objects/page/by-id/page_home.json'),
      pageBefore,
      'the sweep never rewrites a governed object — that is what would flip a page to unpublished_changes'
    );
  });
});

test('a second run the same day is a no-op', async () => {
  await withStores(async (stores) => {
    seed(stores);

    // The run receipt (`maintenance/…`) is excluded on purpose: it is the one
    // thing every run rewrites, and it is not an artifact reference.
    const referenceState = () =>
      JSON.stringify(
        [...stores.indexValues.entries()].filter(([key]) => key !== MEDIA_COMPACTION_HEARTBEAT_KEY).sort()
      );

    await runMediaCompactionSweep({}, NOW);
    const artifactsAfterFirst = [...stores.artifactValues.keys()].sort();
    const indexAfterFirst = referenceState();

    const again = await runMediaCompactionSweep({}, NOW);

    assert.equal(again.orphans_soft_deleted, 0);
    assert.equal(again.blobs_deleted, 0);
    assert.equal(again.bytes_freed, 0);
    assert.equal(again.dedupe_groups, 0, 'every remaining sha group is already deduped');
    assert.deepEqual([...stores.artifactValues.keys()].sort(), artifactsAfterFirst);
    assert.equal(referenceState(), indexAfterFirst);
  });
});

test('an artifact cited ONLY by the history ledger is an orphan', async () => {
  await withStores(async (stores) => {
    // The exact shape `applyPatchOps` writes: one entry per verb, never pruned,
    // carrying the forward op AND the before-capture the inverse needs. Both
    // halves name an artifact — the one the page shows now, and the one it
    // showed before. Walking them made every artifact a page had EVER cited
    // immortal, so the orphan pass could not retire a superseded capture on any
    // object that had been patched even once (page_home is at v212 on
    // zilberman) and the whole sweep reported zeros while looking healthy.
    const SHA_SUPERSEDED = 'e'.repeat(64);
    const SHA_CURRENT = 'f'.repeat(64);

    const superseded = reference('req_capture_zilberman_20260823_05', SHA_SUPERSEDED, LONG_AGO);
    const current = reference('req_capture_zilberman_20260910_01', SHA_CURRENT, LONG_AGO);

    for (const [requestId, ref] of [
      ['req_capture_zilberman_20260823_05', superseded],
      ['req_capture_zilberman_20260910_01', current],
    ] as const) {
      stores.indexValues.set(requestArtifactReferenceKey(requestId, ref.sha256), JSON.stringify(ref));
      stores.artifactValues.set(ref.blobKey, Buffer.from('nine byte'));
    }

    stores.objectValues.set('objects/page/index/by-status/active/page_home', '');
    stores.objectValues.set(
      'objects/page/by-id/page_home.json',
      JSON.stringify({
        object_id: 'page_home',
        version: 212,
        body: [{ type: 'image', src: `/img/req_capture_zilberman_20260910_01/${SHA_CURRENT}.png` }],
        history: [
          {
            at: '2026-09-10T10:00:00.000Z',
            action: 'replace_block',
            actor: { kind: 'agent' },
            details: {
              op: {
                op: 'replace_block',
                fields: { src: `/img/req_capture_zilberman_20260910_01/${SHA_CURRENT}.png` },
              },
              capture: {
                kind: 'block',
                before: { src: `/img/req_capture_zilberman_20260823_05/${SHA_SUPERSEDED}.png` },
              },
            },
          },
        ],
      })
    );

    const result = await runMediaCompactionSweep({}, NOW);

    assert.equal(result.orphans_soft_deleted, 1, 'the superseded capture is retired');
    const supersededRef = JSON.parse(
      stores.indexValues.get(requestArtifactReferenceKey('req_capture_zilberman_20260823_05', SHA_SUPERSEDED)) as string
    );
    assert.equal(supersededRef.deletedAtISO, NOW);
    assert.equal(stores.artifactValues.has(superseded.blobKey), true, 'a soft delete keeps the bytes');

    // The image the page actually shows is untouched — the ledger fix must not
    // turn into "walk less and delete live media".
    const currentRef = JSON.parse(
      stores.indexValues.get(requestArtifactReferenceKey('req_capture_zilberman_20260910_01', SHA_CURRENT)) as string
    );
    assert.equal(currentRef.deletedAtISO, undefined);
    assert.equal(result.dangling, 0);
  });
});

test('the object store is walked ONCE per run, not once per page of references', async () => {
  await withStores(async (stores) => {
    seed(stores);

    // 250 more references: three pages at PAGE_LIMIT = 100, where the old code
    // re-walked every active object's full record on each page.
    for (let index = 0; index < 250; index += 1) {
      const sha = index.toString(16).padStart(64, '0');
      const ref = reference('req_capture_zilberman_20260823_05', sha, LONG_AGO);
      stores.indexValues.set(requestArtifactReferenceKey('req_capture_zilberman_20260823_05', sha), JSON.stringify(ref));
      stores.artifactValues.set(ref.blobKey, Buffer.from('nine byte'));
    }

    let recordReads = 0;
    const objects = stores.objectValues;
    const originalGet = Map.prototype.get;
    // Count only the full-projection record reads the reference walk makes.
    const countingGet = function (this: Map<string, FakeValue>, key: string) {
      if (this === objects && key === 'objects/page/by-id/page_home.json') recordReads += 1;
      return originalGet.call(this, key) as FakeValue | undefined;
    };
    (Map.prototype as unknown as { get: unknown }).get = countingGet;

    let result: Awaited<ReturnType<typeof runMediaCompactionSweep>>;
    try {
      result = await runMediaCompactionSweep({}, NOW);
    } finally {
      (Map.prototype as unknown as { get: unknown }).get = originalGet;
    }

    assert.ok(result.scanned > 200, 'the run really did page over the whole index');
    assert.equal(recordReads, 1, 'one reference walk per run, however many pages it sweeps');
  });
});

test('a run writes a receipt that says it started and that it finished', async () => {
  await withStores(async (stores) => {
    seed(stores);

    const result = await runMediaCompactionSweep({}, NOW);

    const receipt = JSON.parse(stores.indexValues.get(MEDIA_COMPACTION_HEARTBEAT_KEY) as string);
    assert.equal(receipt.schema, 'media_compaction_heartbeat.v1');
    assert.equal(receipt.startedAtISO, NOW);
    assert.equal(typeof receipt.finishedAtISO, 'string', 'a finished run says so IN THE STORE, not only in a log');
    assert.equal(receipt.ok, true);
    assert.deepEqual(receipt.resume, { orphanCursor: null, dedupeCursor: null }, 'the cycle completed');
    assert.equal(receipt.totals.orphans_soft_deleted, result.orphans_soft_deleted);
    assert.equal(result.stopped_early, false);

    // The receipt lives outside every prefix the sweep walks, so it can never
    // be mistaken for a reference by the pass that writes it.
    assert.equal(MEDIA_COMPACTION_HEARTBEAT_KEY.startsWith('maintenance/'), true);
  });
});

test('a run that stops on the clock checkpoints, and the next run resumes there', async () => {
  await withStores(async (stores) => {
    seed(stores);
    for (let index = 0; index < 250; index += 1) {
      const sha = index.toString(16).padStart(64, '0');
      const ref = reference('req_capture_zilberman_20260823_05', sha, LONG_AGO);
      stores.indexValues.set(requestArtifactReferenceKey('req_capture_zilberman_20260823_05', sha), JSON.stringify(ref));
      stores.artifactValues.set(ref.blobKey, Buffer.from('nine byte'));
    }

    // budgetMs 0: the clock is already out after the first page.
    const first = await runMediaCompactionSweep({}, NOW, undefined, { budgetMs: 0 });
    assert.equal(first.stopped_early, true);
    assert.equal(first.dedupe_groups, 0, 'dedupe never runs on a half-swept index');

    const checkpoint = JSON.parse(stores.indexValues.get(MEDIA_COMPACTION_HEARTBEAT_KEY) as string);
    assert.equal(typeof checkpoint.resume.orphanCursor, 'number');
    assert.ok(checkpoint.resume.orphanCursor > 0);

    const second = await runMediaCompactionSweep({}, NOW, undefined, { budgetMs: 0 });
    assert.deepEqual(second.resumed_from.orphanCursor, checkpoint.resume.orphanCursor, 'it picks up where it stopped');
    assert.ok(second.scanned > 0);
  });
});
