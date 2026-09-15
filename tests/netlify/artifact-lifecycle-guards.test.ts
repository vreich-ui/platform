import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { handler as saveArtifactLegacyHandler } from '../../netlify/functions/save-artifact.js';
import { saveArtifactBytes } from '../../packages/core/server/lib/artifact-upload.js';
import { listArtifactReferencesForRequest, type ArtifactIndexStore } from '../../packages/core/server/lib/artifact-index.js';
import { getArtifactIndexBlobStore, setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { ArtifactKind, type ArtifactReference } from '../../packages/core/server/lib/artifacts.js';
import {
  restoreArtifactReference,
  softDeleteArtifactReference,
} from '../../packages/core/server/lib/artifact-soft-delete.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import { createHandler as createAdminInventory } from '../../packages/core/server/functions/admin-inventory.js';

/** A bootstrap-owner identity: `roles.ts` short-circuits on ADMIN_EMAILS, so no users store is needed. */
const ADMIN_EMAIL = 'inventory-acceptance@example.test';
const adminHeaders = { authorization: 'Bearer test-token' };
const adminContext = { clientContext: { user: { sub: 'user_1', email: ADMIN_EMAIL } } };

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

// 1x1 transparent PNG — decodes with sharp.
const validPngBytes = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

type FakeStoreValue = Buffer | string;

const createFakeStore = (values = new Map<string, FakeStoreValue>()) => ({
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
      const blobs = Array.from(values.keys())
        .filter((key) => key.startsWith(prefix))
        .map((key) => ({ key, etag: '' }));
      return { blobs, directories: [] };
    },
  },
});

const withBlobStores = async (
  fn: (stores: {
    artifactValues: Map<string, FakeStoreValue>;
    indexValues: Map<string, FakeStoreValue>;
    objectValues: Map<string, FakeStoreValue>;
  }) => Promise<void>
) => {
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const previousPublishSecret = process.env.NETLIFY_PUBLISH_SECRET;
  const previousAdminEmails = process.env.ADMIN_EMAILS;

  const { values: artifactValues, store: artifactStore } = createFakeStore();
  const { values: indexValues, store: indexStore } = createFakeStore();
  // `admin-inventory`'s delete verb sweeps the OBJECT store before it will
  // mark anything (the referenced-by-an-active-object refusal), so the
  // handler-level tests below need a third store. It stays empty: "no active
  // object points at this artifact" is the case the delete path is allowed to
  // proceed from. Anything NOT named here still throws — the strictness is the
  // point, it is what proves a handler opened only the stores it should.
  const { values: objectValues, store: objectStore } = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  process.env.NETLIFY_PUBLISH_SECRET = 'test-secret';
  process.env.ADMIN_EMAILS = ADMIN_EMAIL;

  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input: string | { name: string }) {
      const storeName = typeof input === 'string' ? input : input.name;
      if (storeName === 'artifacts') return artifactStore as never;
      if (storeName === 'artifact-index') return indexStore as never;
      if (storeName === 'site-objects') return objectStore as never;
      throw new Error(`Unexpected blob store: ${storeName}`);
    },
  });

  try {
    await fn({ artifactValues, indexValues, objectValues });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
    if (previousPublishSecret === undefined) delete process.env.NETLIFY_PUBLISH_SECRET;
    else process.env.NETLIFY_PUBLISH_SECRET = previousPublishSecret;
  }
};

const callLegacySaveArtifact = async (payload: Record<string, unknown>) => {
  const response = await saveArtifactLegacyHandler({
    httpMethod: 'POST',
    headers: { 'x-publish-key': 'test-secret' },
    body: JSON.stringify(payload),
  });

  return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
};

test('legacy save_artifact validates image/* content types regardless of the declared artifactKind', async () => {
  await withBlobStores(async () => {
    const bytes = Buffer.from('this is not a decodable image');
    const result = await callLegacySaveArtifact({
      requestId: 'req_publish_lifecycle_20260703_01',
      artifactKind: 'attachment',
      contentType: 'image/png',
      payload: bytes.toString('base64'),
    });

    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.match(String(result.body.error), /Invalid image artifact/i);
  });
});

test('legacy save_artifact validates PDF bytes like the direct upload path', async () => {
  await withBlobStores(async () => {
    const bytes = Buffer.from('not a pdf at all');
    const result = await callLegacySaveArtifact({
      requestId: 'req_publish_lifecycle_20260703_02',
      artifactKind: 'pdf',
      contentType: 'application/pdf',
      payload: bytes.toString('base64'),
    });

    assert.equal(result.statusCode, 400, JSON.stringify(result.body));
    assert.match(String(result.body.error), /%PDF-/);
  });
});

test('re-uploading identical bytes restores a soft-deleted reference on the direct upload path', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const requestId = 'req_publish_lifecycle_20260703_03';
    const digest = sha256(validPngBytes);
    const upload = () =>
      saveArtifactBytes({
        requestId,
        artifactKind: ArtifactKind.Image,
        contentType: 'image/png',
        expectedSizeBytes: validPngBytes.byteLength,
        expectedSha256: digest,
        bytes: validPngBytes,
        filename: 'pixel.png',
      });

    const first = await upload();
    assert.equal(first.ok, true, JSON.stringify(first));

    // Simulate an admin soft delete of the reference JSON.
    const referenceKey = `request-artifacts/${requestId}/${digest}.json`;
    const stored = JSON.parse(String(indexValues.get(referenceKey))) as ArtifactReference;
    indexValues.set(
      referenceKey,
      JSON.stringify({ ...stored, deletedAtISO: '2026-07-01T00:00:00.000Z', deletedBy: 'admin@example.com' })
    );

    const indexStore = (await getArtifactIndexBlobStore({})) as unknown as ArtifactIndexStore;
    assert.equal((await listArtifactReferencesForRequest(indexStore, requestId)).length, 0);

    const reupload = await upload();
    assert.equal(reupload.ok, true, JSON.stringify(reupload));
    if (!reupload.ok) return;
    assert.equal(reupload.deduped, true);
    assert.equal(reupload.restored, true, 'a deduped re-upload of a soft-deleted artifact must report restored');
    assert.equal(reupload.artifact.deletedAtISO, undefined, 'the returned reference must not carry deletedAtISO');
    assert.equal(reupload.artifact.deletedBy, undefined);

    const listed = await listArtifactReferencesForRequest(indexStore, requestId);
    assert.equal(listed.length, 1, 'the restored artifact must be visible to list/trust/publish again');
    assert.equal(listed[0].sha256, digest);
  });
});

test('re-uploading identical bytes restores a soft-deleted reference on the legacy save_artifact path', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const requestId = 'req_publish_lifecycle_20260703_04';
    const digest = sha256(validPngBytes);
    const upload = () =>
      callLegacySaveArtifact({
        requestId,
        artifactKind: 'image',
        contentType: 'image/png',
        filename: 'pixel.png',
        payload: validPngBytes.toString('base64'),
      });

    const first = await upload();
    assert.equal(first.statusCode, 201, JSON.stringify(first.body));

    const referenceKey = `request-artifacts/${requestId}/${digest}.json`;
    const stored = JSON.parse(String(indexValues.get(referenceKey))) as ArtifactReference;
    indexValues.set(
      referenceKey,
      JSON.stringify({ ...stored, deletedAtISO: '2026-07-01T00:00:00.000Z', deletedBy: 'admin@example.com' })
    );

    const reupload = await upload();
    assert.equal(reupload.statusCode, 200, JSON.stringify(reupload.body));
    const artifact = reupload.body.artifact as ArtifactReference;
    assert.equal(reupload.body.restored, true);
    assert.equal(artifact.deletedAtISO, undefined, 'the returned reference must not carry deletedAtISO');

    const indexStore = (await getArtifactIndexBlobStore({})) as unknown as ArtifactIndexStore;
    const listed = await listArtifactReferencesForRequest(indexStore, requestId);
    assert.equal(listed.length, 1);
  });
});

test('listArtifactReferencesForRequest merges pointer-backed and reference-only artifacts', async () => {
  const requestId = 'req_publish_lifecycle_20260703_05';
  const { values, store } = createFakeStore();

  const makeReference = (seed: string, extension: string): ArtifactReference => {
    const digest = sha256(Buffer.from(seed));
    return {
      blobKey: `image/${requestId}/${digest}${extension}`,
      sizeBytes: seed.length,
      sha256: digest,
      contentType: 'image/png',
      createdAtISO: '2026-07-01T00:00:00.000Z',
      artifactKind: 'image',
    };
  };

  const pointerBacked = makeReference('pointer-backed', '.png');
  const referenceOnly = makeReference('reference-only', '.png');

  // Pointer-backed artifact: reference JSON + by-request pointer (the normal full write).
  values.set(`request-artifacts/${requestId}/${pointerBacked.sha256}.json`, JSON.stringify(pointerBacked));
  values.set(
    `by-request/${encodeURIComponent(requestId)}/image/${pointerBacked.sha256}.json`,
    JSON.stringify({ requestId, sha256: pointerBacked.sha256, artifactKind: 'image' })
  );

  // Reference-only artifact: its pointer write failed — only the reference JSON exists.
  values.set(`request-artifacts/${requestId}/${referenceOnly.sha256}.json`, JSON.stringify(referenceOnly));

  const listed = await listArtifactReferencesForRequest(store as unknown as ArtifactIndexStore, requestId);
  const listedShas = listed.map((reference) => reference.sha256).sort();

  assert.deepEqual(
    listedShas,
    [pointerBacked.sha256, referenceOnly.sha256].sort(),
    'artifacts must be returned from BOTH the by-request pointers and the request-artifacts references'
  );
});

// ─── soft delete ⇄ restore: the flag and the pointers ────────────────────────

/**
 * The admin verbs behind `/admin/inventory`'s Delete (soft) and Restore.
 *
 * Two properties, and the defect each one fences:
 *
 *  1. `changed` is about THIS call, not about the end state. Both primitives
 *     used to answer "success" for a call that moved nothing, which is how a
 *     Delete offered on an already-deleted row could report "succeeded" while
 *     doing nothing at all.
 *  2. A restore must rewrite the `by-kind` / `by-request` / `by-tag` pointers
 *     as well as the reference. Since W3 a pointer carries `deletedAtISO`, so
 *     one left stamped over a live reference hides the artifact from every
 *     listing that trusts the pointer (`admin-editorial-assets`, the picker).
 */
const seedArtifact = async (requestId: string) => {
  const digest = sha256(validPngBytes);
  const saved = await saveArtifactBytes({
    requestId,
    artifactKind: ArtifactKind.Image,
    contentType: 'image/png',
    expectedSizeBytes: validPngBytes.byteLength,
    expectedSha256: digest,
    bytes: validPngBytes,
    filename: 'pixel.png',
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  return digest;
};

/** Every index key that is a pointer (i.e. not the canonical reference JSON) for this sha. */
const pointerEntries = (indexValues: Map<string, FakeStoreValue>, digest: string) =>
  [...indexValues.entries()]
    .filter(([key]) => !key.startsWith('request-artifacts/') && key.includes(digest))
    .map(([key, value]) => [key, JSON.parse(String(value)) as Record<string, unknown>] as const);

test('restore clears the delete mark on the reference AND on every pointer', async () => {
  await withBlobStores(async ({ indexValues }) => {
    const requestId = 'req_publish_lifecycle_20260915_01';
    const digest = await seedArtifact(requestId);

    const deleted = await softDeleteArtifactReference(
      {},
      { requestId, sha256: digest, deletedBy: 'admin@example.test', deletedByFallback: 'admin' },
      drlurieSiteBinding
    );
    assert.equal(deleted.ok, true);
    if (!deleted.ok) return;
    assert.equal(deleted.changed, true, 'the first delete is the one that moves the state');

    const stamped = pointerEntries(indexValues, digest);
    assert.ok(stamped.length > 0, 'the fixture must actually hold pointers, or this test proves nothing');
    assert.ok(
      stamped.some(([, pointer]) => pointer.deletedAtISO !== undefined),
      'a soft delete must stamp the pointers it owns'
    );

    const restored = await restoreArtifactReference({}, { requestId, sha256: digest }, drlurieSiteBinding);
    assert.equal(restored.ok, true);
    if (!restored.ok) return;
    assert.equal(restored.changed, true);
    assert.equal(restored.artifact.deletedAtISO, undefined, 'the reference must not carry deletedAtISO');
    assert.equal(restored.artifact.deletedBy, undefined);

    const stored = JSON.parse(String(indexValues.get(`request-artifacts/${requestId}/${digest}.json`))) as Record<
      string,
      unknown
    >;
    assert.equal(stored.deletedAtISO, undefined, 'the CANONICAL reference must be rewritten, not just returned');

    for (const [key, pointer] of pointerEntries(indexValues, digest)) {
      assert.equal(pointer.deletedAtISO, undefined, `pointer ${key} still claims the artifact is deleted`);
    }

    const indexStore = (await getArtifactIndexBlobStore({})) as unknown as ArtifactIndexStore;
    assert.equal(
      (await listArtifactReferencesForRequest(indexStore, requestId)).length,
      1,
      'a restored artifact must be listable again'
    );
  });
});

test('restoring a live artifact, and deleting a deleted one, both report changed:false', async () => {
  await withBlobStores(async () => {
    const requestId = 'req_publish_lifecycle_20260915_02';
    const digest = await seedArtifact(requestId);

    const noopRestore = await restoreArtifactReference({}, { requestId, sha256: digest }, drlurieSiteBinding);
    assert.equal(noopRestore.ok, true);
    if (!noopRestore.ok) return;
    assert.equal(noopRestore.changed, false, 'restoring a live artifact changes nothing and must say so');

    const del = { requestId, sha256: digest, deletedBy: 'admin@example.test', deletedByFallback: 'admin' };
    const first = await softDeleteArtifactReference({}, del, drlurieSiteBinding);
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.equal(first.changed, true);

    const second = await softDeleteArtifactReference({}, del, drlurieSiteBinding);
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.equal(second.changed, false, 'deleting an already-deleted artifact changes nothing and must say so');
    assert.equal(
      second.artifact.deletedAtISO,
      first.artifact.deletedAtISO,
      'the original delete stamp must survive a repeat delete'
    );
  });
});

// ─── /admin/inventory: the two verbs, end to end through the handler ─────────

/**
 * The acceptance test for "a row's actions are a function of the row's true
 * state", taken through the HTTP door rather than the primitive.
 *
 * The defect being fenced: `/admin/inventory` offered Delete (soft) on a row
 * that was already deleted, the server answered 200, and the page reported
 * "succeeded" for a call that wrote nothing. `restore-artifact` did not exist
 * at all, even though `restoreArtifactReference` had since W3.
 *
 * So this asserts the two things the UI reads: `changed` (did THIS call move
 * anything) and `status`/`deletedAtISO` (the row's post-mutation state, as the
 * server wrote it — never as the client guessed it).
 */
const inventory = createAdminInventory(drlurieSiteBinding);

const postInventory = async (body: Record<string, unknown>) => {
  const response = await inventory(
    { httpMethod: 'POST', headers: adminHeaders, body: JSON.stringify(body) },
    adminContext
  );
  return { statusCode: response.statusCode, body: JSON.parse(response.body) as Record<string, unknown> };
};

test('admin-inventory: delete then restore, each reporting whether anything changed', async () => {
  await withBlobStores(async () => {
    const requestId = 'req_publish_lifecycle_20260915_03';
    const digest = await seedArtifact(requestId);
    const id = `${requestId}/${digest}`;

    const first = await postInventory({ action: 'delete-artifact', id });
    assert.equal(first.statusCode, 200, JSON.stringify(first.body));
    assert.equal(first.body.changed, true);
    assert.equal(first.body.status, 'deleted');
    assert.ok(typeof first.body.deletedAtISO === 'string' && first.body.deletedAtISO.length > 0);

    // The no-op the row menu must no longer offer — and which, when it does
    // arrive, must not be dressed up as a success.
    const again = await postInventory({ action: 'delete-artifact', id });
    assert.equal(again.statusCode, 200, JSON.stringify(again.body));
    assert.equal(again.body.changed, false, 'deleting an already-deleted artifact changed nothing');
    assert.equal(again.body.alreadyDeleted, true);
    assert.equal(again.body.deletedAtISO, first.body.deletedAtISO, 'the original delete stamp must survive');

    const restored = await postInventory({ action: 'restore-artifact', id });
    assert.equal(restored.statusCode, 200, JSON.stringify(restored.body));
    assert.equal(restored.body.restored, true);
    assert.equal(restored.body.changed, true);
    assert.equal(restored.body.status, 'active');
    assert.equal(restored.body.deletedAtISO, null, 'the row is live, and the response says so');

    const noop = await postInventory({ action: 'restore-artifact', id });
    assert.equal(noop.statusCode, 200, JSON.stringify(noop.body));
    assert.equal(noop.body.changed, false, 'restoring a live artifact changed nothing');

    // The search the page re-reads with must agree — this is the facet count
    // moving without a page reload.
    const search = await postInventory({ action: 'search', q: '', collections: ['artifacts'], limit: 50 });
    assert.equal(search.statusCode, 200, JSON.stringify(search.body));
    const hits = (search.body.hits ?? []) as Array<Record<string, unknown>>;
    const row = hits.find((hit) => hit.id === id);
    assert.ok(row, 'the restored artifact must still be listed');
    assert.equal(row.status, 'active');
  });
});

test('admin-inventory: restore answers 404 for an artifact the index does not hold, and 400 for a malformed id', async () => {
  await withBlobStores(async () => {
    const missing = await postInventory({
      action: 'restore-artifact',
      id: `req_publish_lifecycle_20260915_04/${'f'.repeat(64)}`,
    });
    assert.equal(missing.statusCode, 404, JSON.stringify(missing.body));

    const malformed = await postInventory({ action: 'restore-artifact', id: 'not-an-artifact-id' });
    assert.equal(malformed.statusCode, 400, JSON.stringify(malformed.body));
  });
});
