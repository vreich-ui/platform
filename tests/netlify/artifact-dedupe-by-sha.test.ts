/**
 * W2 T2.4/T2.5 — identical bytes are stored ONCE per tenant store, while every
 * request still gets its own ArtifactReference and its own
 * `/img/<requestId>/<sha256>.<ext>` public path.
 *
 * The invariant these tests exist to protect is the SPLIT: `blobKey` is the
 * request-scoped identity (public path, trust index, page `src`) and is never
 * rewritten; `storageKey` is a read-side redirect to the first request's blob.
 * A regression that "helpfully" rewrites the second reference's blobKey to the
 * first request's would break every already-published page that cites the
 * second path, which is exactly what these assertions refuse.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler as getPublicImageHandler } from '../../netlify/functions/get-public-image.js';
import { ArtifactKind } from '../../packages/core/server/lib/artifacts.js';
import { saveArtifactBytes } from '../../packages/core/server/lib/artifact-upload.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  setNetlifyBlobsModuleForTesting,
} from '../../packages/core/server/lib/blob-store.js';
import { sha256Hex } from '../../packages/core/server/lib/crypto.js';

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
    async list() {
      return { blobs: Array.from(values.keys()).map((key) => ({ key, etag: '' })), directories: [] };
    },
  },
});

const withBlobStores = async (
  fn: (stores: {
    artifactValues: Map<string, FakeStoreValue>;
    indexValues: Map<string, FakeStoreValue>;
  }) => Promise<void>
) => {
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const { values: artifactValues, store: artifactStore } = createFakeStore();
  const { values: indexValues, store: indexStore } = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input) {
      const storeName = typeof input === 'string' ? input : input.name;
      if (storeName === 'artifacts') {
        return artifactStore as ReturnType<typeof getArtifactBlobStore> extends Promise<infer Store> ? Store : never;
      }
      if (storeName === 'artifact-index') {
        return indexStore as ReturnType<typeof getArtifactIndexBlobStore> extends Promise<infer Store>
          ? Store
          : never;
      }
      throw new Error(`Unexpected blob store: ${storeName}`);
    },
  });

  try {
    await fn({ artifactValues, indexValues });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
};

const PNG_BYTES = Buffer.from(
  // 1x1 transparent PNG — real bytes, so validatePublishImageBytes decodes it.
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

const uploadImage = (requestId: string, bytes: Buffer) =>
  saveArtifactBytes({
    requestId,
    artifactKind: ArtifactKind.Image,
    contentType: 'image/png',
    filename: 'hero.png',
    expectedSizeBytes: bytes.byteLength,
    expectedSha256: sha256Hex(bytes),
    bytes,
  });

test('identical bytes under two request ids store one blob, two references, two live public paths', async () => {
  await withBlobStores(async ({ artifactValues, indexValues }) => {
    const sha = sha256Hex(PNG_BYTES);
    const firstRequestId = 'req_dedupe_first_20260911_01';
    const secondRequestId = 'req_dedupe_second_20260911_01';

    const first = await uploadImage(firstRequestId, PNG_BYTES);
    assert.equal(first.ok, true);
    assert.equal(first.ok ? first.deduped : true, false);
    assert.equal(first.ok ? first.artifact.storageKey : 'set', undefined);

    const second = await uploadImage(secondRequestId, PNG_BYTES);
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.deduped : false, true);
    assert.equal(second.ok ? second.dedupedFrom : undefined, firstRequestId);

    const firstKey = `image/${firstRequestId}/${sha}.png`;
    const secondKey = `image/${secondRequestId}/${sha}.png`;

    // ONE blob.
    const imageBlobKeys = [...artifactValues.keys()].filter((key) => key.startsWith('image/'));
    assert.deepEqual(imageBlobKeys, [firstKey]);
    assert.equal(artifactValues.has(secondKey), false);

    // TWO references, each keeping its OWN request-scoped blobKey.
    assert.equal(second.ok ? second.artifact.blobKey : '', secondKey);
    assert.equal(second.ok ? second.artifact.storageKey : '', firstKey);
    assert.ok(indexValues.has(`request-artifacts/${firstRequestId}/${sha}.json`));
    assert.ok(indexValues.has(`request-artifacts/${secondRequestId}/${sha}.json`));

    // The by-sha index names the FIRST request and is not rewritten by the second upload.
    assert.deepEqual(JSON.parse(indexValues.get(`by-sha/image/${sha}.json`) as string), {
      storageKey: firstKey,
      contentType: 'image/png',
      sizeBytes: PNG_BYTES.byteLength,
      firstRequestId,
      createdAtISO: first.ok ? first.artifact.createdAtISO : '',
    });

    // BOTH public paths serve the bytes.
    for (const requestId of [firstRequestId, secondRequestId]) {
      const response = await getPublicImageHandler({
        httpMethod: 'GET',
        path: `/img/${requestId}/${sha}.png`,
        queryStringParameters: null,
      });

      assert.equal(response.statusCode, 200, `/img/${requestId}/${sha}.png must serve`);
      assert.equal(response.headers['Content-Type'], 'image/png');
      assert.equal(Buffer.from(response.body, 'base64').equals(PNG_BYTES), true);
    }
  });
});

test('a by-sha hit whose bytes are missing falls back to storing this request its own blob', async () => {
  await withBlobStores(async ({ artifactValues }) => {
    const sha = sha256Hex(PNG_BYTES);
    const firstRequestId = 'req_dedupe_stale_first_20260911_01';
    const secondRequestId = 'req_dedupe_stale_second_20260911_01';

    await uploadImage(firstRequestId, PNG_BYTES);
    // Simulate a by-sha entry that outlived its blob.
    artifactValues.delete(`image/${firstRequestId}/${sha}.png`);

    const second = await uploadImage(secondRequestId, PNG_BYTES);
    assert.equal(second.ok, true);
    assert.equal(second.ok ? second.deduped : true, false);
    assert.equal(second.ok ? second.artifact.storageKey : 'set', undefined);
    assert.equal(artifactValues.has(`image/${secondRequestId}/${sha}.png`), true);
  });
});

test('re-uploading the same bytes under the same request still returns the original reference', async () => {
  await withBlobStores(async ({ artifactValues }) => {
    const requestId = 'req_dedupe_same_request_20260911_01';

    const first = await uploadImage(requestId, PNG_BYTES);
    const again = await uploadImage(requestId, PNG_BYTES);

    assert.equal(again.ok, true);
    assert.equal(again.ok ? again.deduped : false, true);
    assert.equal(again.ok ? again.dedupedFrom : 'set', undefined);
    assert.deepEqual(again.ok ? again.artifact : undefined, first.ok ? first.artifact : undefined);
    assert.equal([...artifactValues.keys()].filter((key) => key.startsWith('image/')).length, 1);
  });
});
