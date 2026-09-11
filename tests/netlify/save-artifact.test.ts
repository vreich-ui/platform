import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import sharp from 'sharp';

import { handler } from '../../netlify/functions/save-artifact.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  setNetlifyBlobsModuleForTesting,
} from '../../packages/core/server/lib/blob-store.js';

const publishSecret = 'artifact-test-secret';
const validJpegBytes = Buffer.from(
  '/9j/2wBDAAYEBQYFBAYGBQYHBwYIChAKCgkJChQODwwQFxQYGBcUFhYaHSUfGhsjHBYWICwgIyYnKSopGR8tMC0oMCUoKSj/2wBDAQcHBwoIChMKChMoGhYaKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCgoKCj/wAARCAACAAIDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAf/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFAEBAAAAAAAAAAAAAAAAAAAABP/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/AIIAeC//2Q==',
  'base64'
);
const validJpegSha256 = createHash('sha256').update(validJpegBytes).digest('hex');

/**
 * A 2x2 solid image. `seed` varies the pixel colour, and therefore the bytes and
 * their sha256.
 *
 * W2 T2.4: this suite shares ONE real local blob store across its tests (see
 * `uniqueRequestId` below), and dedupe is now keyed on content — identical bytes
 * are stored once no matter which request id carries them. A fixture shared by
 * two tests therefore makes the second upload a 200 dedupe of the first test's
 * blob instead of the 201 create it is asserting. Give every test that expects a
 * create its own seed; pass the SAME seed twice only where dedupe is the point.
 */
const createImageBytes = (format: 'jpeg' | 'png' | 'webp', seed = 0) => {
  const image = sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: { r: (80 + seed * 37) % 256, g: (100 + seed * 53) % 256, b: (120 + seed * 71) % 256 },
    },
  });

  if (format === 'jpeg') return image.jpeg().toBuffer();
  if (format === 'webp') return image.webp().toBuffer();
  return image.png().toBuffer();
};

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const postArtifact = async (body: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'x-publish-key': publishSecret, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  return {
    ...response,
    json: JSON.parse(response.body) as Record<string, unknown>,
  };
};

/**
 * A valid, unique-per-call req_<flow>_<topic>_<yyyymmdd>_<nn> id. This suite
 * exercises the real local blob store (no in-memory fake, no per-test reset),
 * so ids must both pass validateRequestId AND stay distinct across runs —
 * matching the free-form `${label}-request-${Date.now()}-${random}` ids these
 * fixtures used before the req_* format was strictly enforced end-to-end.
 */
const uniqueRequestId = (label: string): string => {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const seq = String(Math.floor(Math.random() * 100)).padStart(2, '0');
  const topic = label.toLowerCase().replace(/[^a-z0-9]+/g, '') || 'case';
  return `req_test_${topic}_${date}_${seq}`;
};

const makeBaseInput = (requestId: string) => ({
  requestId,
  artifactKind: 'image',
  contentType: 'image/png',
  filename: 'hero.png',
});

test('save-artifact retries stale final artifact readback before saving request index', async () => {
  type FakeStoreValue = Buffer | string;
  const previousPublishSecret = process.env.NETLIFY_PUBLISH_SECRET;
  const previousFallbackSecret = process.env.PUBLISH_SECRET;
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const artifactValues = new Map<string, FakeStoreValue>();
  const indexValues = new Map<string, FakeStoreValue>();
  const hiddenFinalArtifactReads = new Set<string>();
  const finalArtifactArrayBufferReads = new Map<string, number>();
  const deletedFinalArtifactKeys: string[] = [];
  const createFakeStore = (values: Map<string, FakeStoreValue>, hideFirstFinalRead: boolean) => ({
    async set(key: string, value: string | Buffer | Uint8Array | ArrayBuffer) {
      values.set(
        key,
        typeof value === 'string' ? value : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value)
      );
      if (hideFirstFinalRead && key.startsWith('image/')) hiddenFinalArtifactReads.add(key);
    },
    async setJSON(key: string, value: unknown) {
      values.set(key, JSON.stringify(value));
    },
    async get(key: string, options?: { type?: 'arrayBuffer' | 'buffer' | 'text' }) {
      const value = values.get(key);
      if (value === undefined) return null;

      if (hideFirstFinalRead && key.startsWith('image/') && options?.type === 'arrayBuffer') {
        finalArtifactArrayBufferReads.set(key, (finalArtifactArrayBufferReads.get(key) ?? 0) + 1);
        if (hiddenFinalArtifactReads.has(key)) {
          hiddenFinalArtifactReads.delete(key);
          return null;
        }
      }

      if (options?.type === 'arrayBuffer') {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;

        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }

      if (options?.type === 'buffer') return typeof value === 'string' ? Buffer.from(value) : value;

      return typeof value === 'string' ? value : value.toString('utf8');
    },
    async del(key: string) {
      if (hideFirstFinalRead && key.startsWith('image/')) deletedFinalArtifactKeys.push(key);
      values.delete(key);
    },
    async list() {
      return { blobs: [...values.keys()].map((key) => ({ key, etag: '' })), directories: [] };
    },
  });
  const artifactStore = createFakeStore(artifactValues, true);
  const indexStore = createFakeStore(indexValues, false);

  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input) {
      const storeName = typeof input === 'string' ? input : input.name;

      if (storeName === 'artifacts')
        return artifactStore as ReturnType<typeof getArtifactBlobStore> extends Promise<infer Store> ? Store : never;
      if (storeName === 'artifact-index')
        return indexStore as ReturnType<typeof getArtifactIndexBlobStore> extends Promise<infer Store> ? Store : never;
      throw new Error(`Unexpected blob store: ${storeName}`);
    },
  });

  try {
    const requestId = uniqueRequestId('stalefinal');
    const payloadBytes = await createImageBytes('png');
    const response = await postArtifact({
      ...makeBaseInput(requestId),
      encoding: 'base64',
      payload: payloadBytes.toString('base64'),
    });

    assert.equal(response.statusCode, 201);
    assert.equal(response.json.complete, true);
    assert.equal(response.json.deduped, false);

    const artifact = response.json.artifact as { blobKey: string; sha256: string };
    assert.equal(finalArtifactArrayBufferReads.get(artifact.blobKey), 2);

    const indexedReferenceText = indexValues.get(`request-artifacts/${requestId}/${artifact.sha256}.json`);
    assert.deepEqual(deletedFinalArtifactKeys, []);
    assert.equal(typeof indexedReferenceText, 'string');
    assert.deepEqual(JSON.parse(indexedReferenceText as string), response.json.artifact);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);

    if (previousPublishSecret === undefined) delete process.env.NETLIFY_PUBLISH_SECRET;
    else process.env.NETLIFY_PUBLISH_SECRET = previousPublishSecret;

    if (previousFallbackSecret === undefined) delete process.env.PUBLISH_SECRET;
    else process.env.PUBLISH_SECRET = previousFallbackSecret;

    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;

    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
});

test('save-artifact deletes final artifact blob when readback retries are exhausted', async () => {
  type FakeStoreValue = Buffer | string;
  const previousPublishSecret = process.env.NETLIFY_PUBLISH_SECRET;
  const previousFallbackSecret = process.env.PUBLISH_SECRET;
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const artifactValues = new Map<string, FakeStoreValue>();
  const indexValues = new Map<string, FakeStoreValue>();
  const deletedArtifactKeys: string[] = [];
  const artifactStore = {
    async set(key: string, value: string | Buffer | Uint8Array | ArrayBuffer) {
      artifactValues.set(
        key,
        typeof value === 'string' ? value : value instanceof ArrayBuffer ? Buffer.from(value) : Buffer.from(value)
      );
    },
    async setJSON(key: string, value: unknown) {
      artifactValues.set(key, JSON.stringify(value));
    },
    async get(key: string, options?: { type?: 'arrayBuffer' | 'buffer' | 'text' }) {
      const value = artifactValues.get(key);
      if (value === undefined) return null;
      if (key.startsWith('image/') && options?.type === 'arrayBuffer') return null;
      if (options?.type === 'arrayBuffer') {
        const bytes = typeof value === 'string' ? Buffer.from(value) : value;

        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      }
      if (options?.type === 'buffer') return typeof value === 'string' ? Buffer.from(value) : value;

      return typeof value === 'string' ? value : value.toString('utf8');
    },
    async del(key: string) {
      deletedArtifactKeys.push(key);
      artifactValues.delete(key);
    },
    async list() {
      return { blobs: [...artifactValues.keys()].map((key) => ({ key, etag: '' })), directories: [] };
    },
  };
  const indexStore = {
    async set() {},
    async setJSON(key: string, value: unknown) {
      indexValues.set(key, JSON.stringify(value));
    },
    async get(key: string) {
      return (indexValues.get(key) as string | undefined) ?? null;
    },
    async del(key: string) {
      indexValues.delete(key);
    },
    async list() {
      return { blobs: [...indexValues.keys()].map((key) => ({ key, etag: '' })), directories: [] };
    },
  };

  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input) {
      const storeName = typeof input === 'string' ? input : input.name;

      if (storeName === 'artifacts')
        return artifactStore as ReturnType<typeof getArtifactBlobStore> extends Promise<infer Store> ? Store : never;
      if (storeName === 'artifact-index')
        return indexStore as ReturnType<typeof getArtifactIndexBlobStore> extends Promise<infer Store> ? Store : never;
      throw new Error(`Unexpected blob store: ${storeName}`);
    },
  });

  try {
    const requestId = uniqueRequestId('unreadablefinal');
    const payloadBytes = await createImageBytes('png');
    const expectedSha256 = sha256(payloadBytes);
    const expectedBlobKey = `image/${requestId}/${expectedSha256}.png`;
    const response = await postArtifact({
      ...makeBaseInput(requestId),
      encoding: 'base64',
      payload: payloadBytes.toString('base64'),
    });

    assert.equal(response.statusCode, 500);
    assert.deepEqual(response.json, { error: 'Artifact blob write failed: stored bytes could not be read back.' });
    assert.deepEqual(deletedArtifactKeys, [expectedBlobKey]);
    assert.equal(artifactValues.has(expectedBlobKey), false);
    assert.equal(indexValues.size, 0);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);

    if (previousPublishSecret === undefined) delete process.env.NETLIFY_PUBLISH_SECRET;
    else process.env.NETLIFY_PUBLISH_SECRET = previousPublishSecret;

    if (previousFallbackSecret === undefined) delete process.env.PUBLISH_SECRET;
    else process.env.PUBLISH_SECRET = previousFallbackSecret;

    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;

    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
});

test('save-artifact single-shot uploads dedupe by checksum', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('artifact');
  const baseInput = makeBaseInput(requestId);
  const payload = (await createImageBytes('png', 1)).toString('base64');
  const first = await postArtifact({ ...baseInput, encoding: 'base64', payload });

  assert.equal(first.statusCode, 201);
  assert.equal(first.json.complete, true);
  assert.equal(first.json.deduped, false);

  const firstArtifact = first.json.artifact as { blobKey: string; sha256: string };
  const second = await postArtifact({ ...baseInput, encoding: 'base64', payload });

  assert.equal(second.statusCode, 200);
  assert.equal(second.json.complete, true);
  assert.equal(second.json.deduped, true);
  assert.deepEqual(second.json.artifact, first.json.artifact);

  const artifactStore = await getArtifactBlobStore({});
  const artifactList = await artifactStore.list({ prefix: `image/${requestId}/` });

  assert.deepEqual(
    artifactList.blobs.map((blob) => blob.key),
    [firstArtifact.blobKey]
  );

  const indexStore = await getArtifactIndexBlobStore({});
  const indexedReferenceText = await indexStore.get(`request-artifacts/${requestId}/${firstArtifact.sha256}.json`);
  const indexedReference = indexedReferenceText ? (JSON.parse(indexedReferenceText) as unknown) : null;

  assert.deepEqual(indexedReference, first.json.artifact);
});

test('save-artifact dedupes identical bytes ACROSS request ids, keeping each request its own path', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  // W2 T2.4 parity for the direct-upload endpoint: saveArtifactBytes was not the
  // only byte writer. This path used to store a fresh blob for bytes that already
  // existed under another request, and never registered a by-sha entry either.
  const payload = (await createImageBytes('png', 2)).toString('base64');

  const requestA = uniqueRequestId('artifact-xreq-a');
  const first = await postArtifact({ ...makeBaseInput(requestA), encoding: 'base64', payload });

  assert.equal(first.statusCode, 201);
  assert.equal(first.json.deduped, false);

  const firstArtifact = first.json.artifact as { blobKey: string; sha256: string; storageKey?: string };
  assert.equal(firstArtifact.storageKey, undefined, 'the first request owns its bytes; no redirect');

  const requestB = uniqueRequestId('artifact-xreq-b');
  const second = await postArtifact({ ...makeBaseInput(requestB), encoding: 'base64', payload });

  assert.equal(second.statusCode, 200);
  assert.equal(second.json.deduped, true);
  assert.equal(second.json.dedupedFrom, requestA);

  const secondArtifact = second.json.artifact as { blobKey: string; sha256: string; storageKey?: string };

  // blobKey is IDENTITY: request B keeps its own key and therefore its own
  // /img/<requestB>/<sha>.png public path. Only the read side is redirected.
  assert.ok(secondArtifact.blobKey.includes(requestB));
  assert.notEqual(secondArtifact.blobKey, firstArtifact.blobKey);
  assert.equal(secondArtifact.storageKey, firstArtifact.blobKey);
  assert.equal(secondArtifact.sha256, firstArtifact.sha256);

  const artifactStore = await getArtifactBlobStore({});

  assert.deepEqual(
    (await artifactStore.list({ prefix: `image/${requestB}/` })).blobs.map((blob) => blob.key),
    [],
    'no second copy of the bytes was written'
  );
  assert.deepEqual(
    (await artifactStore.list({ prefix: `image/${requestA}/` })).blobs.map((blob) => blob.key),
    [firstArtifact.blobKey]
  );

  const indexStore = await getArtifactIndexBlobStore({});
  const shaEntryText = await indexStore.get(`by-sha/image/${firstArtifact.sha256}.json`);
  const shaEntry = shaEntryText ? (JSON.parse(shaEntryText) as { storageKey: string; firstRequestId: string }) : null;

  assert.equal(shaEntry?.storageKey, firstArtifact.blobKey);
  assert.equal(shaEntry?.firstRequestId, requestA);
});

test('save-artifact accepts a valid JPEG upload with matching expected size and sha256', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpegvalid');
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    encoding: 'base64',
    expectedSizeBytes: validJpegBytes.byteLength,
    expectedSha256: validJpegSha256,
    payload: validJpegBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.json.complete, true);
  assert.equal(response.json.deduped, false);

  const artifact = response.json.artifact as { blobKey: string; sha256: string; sizeBytes: number };

  assert.equal(artifact.sizeBytes, validJpegBytes.byteLength);
  assert.equal(artifact.sha256, validJpegSha256);

  const artifactStore = await getArtifactBlobStore({});
  const retrievedBytes = await (
    artifactStore as typeof artifactStore & {
      get: (key: string, options: { type: 'buffer' }) => Promise<Buffer | null>;
    }
  ).get(artifact.blobKey, { type: 'buffer' });

  assert.ok(Buffer.isBuffer(retrievedBytes));
  assert.equal(createHash('sha256').update(retrievedBytes).digest('hex'), validJpegSha256);
});

test('save-artifact accepts valid PNG and WebP uploads', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const pngBytes = await createImageBytes('png', 3);
  const webpBytes = await createImageBytes('webp', 4);
  const pngRequestId = uniqueRequestId('pngvalid');
  const webpRequestId = uniqueRequestId('webpvalid');

  const pngResponse = await postArtifact({
    ...makeBaseInput(pngRequestId),
    contentType: 'image/png',
    filename: 'hero.png',
    encoding: 'base64',
    expectedSizeBytes: pngBytes.byteLength,
    expectedSha256: sha256(pngBytes),
    payload: pngBytes.toString('base64'),
  });
  const webpResponse = await postArtifact({
    ...makeBaseInput(webpRequestId),
    contentType: 'image/webp',
    filename: 'hero.webp',
    encoding: 'base64',
    expectedSizeBytes: webpBytes.byteLength,
    expectedSha256: sha256(webpBytes),
    payload: webpBytes.toString('base64'),
  });

  assert.equal(pngResponse.statusCode, 201, pngResponse.body);
  assert.equal(webpResponse.statusCode, 201, webpResponse.body);

  const pngArtifact = pngResponse.json.artifact as { blobKey: string; sha256: string; sizeBytes: number };
  const webpArtifact = webpResponse.json.artifact as { blobKey: string; sha256: string; sizeBytes: number };

  assert.equal(pngArtifact.blobKey.endsWith('.png'), true);
  assert.equal(pngArtifact.sizeBytes, pngBytes.byteLength);
  assert.equal(pngArtifact.sha256, sha256(pngBytes));
  assert.equal(webpArtifact.blobKey.endsWith('.webp'), true);
  assert.equal(webpArtifact.sizeBytes, webpBytes.byteLength);
  assert.equal(webpArtifact.sha256, sha256(webpBytes));
});

test('save-artifact accepts localSizeBytes and localSha256 as integrity aliases', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpeglocalalias');
  // Its own bytes, not the shared `validJpegBytes`: those are already stored by
  // the matching-integrity test above, and content dedupe would answer 200 here.
  const jpegBytes = await createImageBytes('jpeg', 6);
  const jpegSha256 = sha256(jpegBytes);
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    encoding: 'base64',
    localSizeBytes: jpegBytes.byteLength,
    localSha256: jpegSha256,
    payload: jpegBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 201, response.body);
  const artifact = response.json.artifact as { sha256: string; sizeBytes: number };

  assert.equal(artifact.sizeBytes, jpegBytes.byteLength);
  assert.equal(artifact.sha256, jpegSha256);
});

test('save-artifact rejects a truncated JPEG without writing final artifact or index records', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpegtruncated');
  const truncatedJpegBytes = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]);
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    encoding: 'base64',
    expectedSizeBytes: truncatedJpegBytes.byteLength,
    expectedSha256: createHash('sha256').update(truncatedJpegBytes).digest('hex'),
    payload: truncatedJpegBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 400);

  const artifactStore = await getArtifactBlobStore({});
  const indexStore = await getArtifactIndexBlobStore({});

  assert.deepEqual((await artifactStore.list({ prefix: `image/${requestId}/` })).blobs, []);
  assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${requestId}/` })).blobs, []);
});

test('save-artifact rejects corrupt PNG and WebP uploads before final persistence', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const cases = [
    { contentType: 'image/png', filename: 'hero.png', requestId: uniqueRequestId('pngcorrupt') },
    { contentType: 'image/webp', filename: 'hero.webp', requestId: uniqueRequestId('webpcorrupt') },
  ];

  for (const testCase of cases) {
    const bytes = Buffer.from(`not a ${testCase.contentType} image`);
    const response = await postArtifact({
      ...makeBaseInput(testCase.requestId),
      contentType: testCase.contentType,
      filename: testCase.filename,
      encoding: 'base64',
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: sha256(bytes),
      payload: bytes.toString('base64'),
    });

    assert.equal(response.statusCode, 400);
    assert.match(String(response.json.error), /could not be decoded as a valid (PNG|WebP)/);

    const artifactStore = await getArtifactBlobStore({});
    const indexStore = await getArtifactIndexBlobStore({});

    assert.deepEqual((await artifactStore.list({ prefix: `image/${testCase.requestId}/` })).blobs, []);
    assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${testCase.requestId}/` })).blobs, []);
  }
});

test('save-artifact rejects image content type and filename extension mismatches', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const pngBytes = await createImageBytes('png');
  const webpBytes = await createImageBytes('webp');
  const requestId = uniqueRequestId('imagemismatch');
  const contentTypeRequestId = uniqueRequestId('imagemismatchcontenttype');

  const extensionMismatch = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/png',
    filename: 'hero.jpg',
    encoding: 'base64',
    expectedSizeBytes: pngBytes.byteLength,
    expectedSha256: sha256(pngBytes),
    payload: pngBytes.toString('base64'),
  });
  const contentTypeMismatch = await postArtifact({
    ...makeBaseInput(contentTypeRequestId),
    contentType: 'image/png',
    filename: 'hero.png',
    encoding: 'base64',
    expectedSizeBytes: webpBytes.byteLength,
    expectedSha256: sha256(webpBytes),
    payload: webpBytes.toString('base64'),
  });

  assert.equal(extensionMismatch.statusCode, 400);
  assert.match(String(extensionMismatch.json.error), /could not be decoded as a valid JPEG/);
  assert.equal(contentTypeMismatch.statusCode, 400);
  assert.match(String(contentTypeMismatch.json.error), /could not be decoded as a valid PNG/);
});

test('save-artifact rejects unsupported image content types', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const pngBytes = await createImageBytes('png');
  const response = await postArtifact({
    ...makeBaseInput(uniqueRequestId('unsupportedimage')),
    contentType: 'image/gif',
    filename: 'hero.gif',
    encoding: 'base64',
    expectedSizeBytes: pngBytes.byteLength,
    expectedSha256: sha256(pngBytes),
    payload: pngBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(response.json.error), /declared unsupported content type image\/gif/);
});

test('save-artifact rejects a valid JPEG when expectedSha256 is a valid but wrong digest', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpegshamismatch');
  const wrongSha256 = '0'.repeat(64);
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    encoding: 'base64',
    expectedSizeBytes: validJpegBytes.byteLength,
    expectedSha256: wrongSha256,
    payload: validJpegBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 400);

  const artifactStore = await getArtifactBlobStore({});
  const indexStore = await getArtifactIndexBlobStore({});

  assert.deepEqual((await artifactStore.list({ prefix: `image/${requestId}/` })).blobs, []);
  assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${requestId}/` })).blobs, []);
});

test('save-artifact rejects JPEG aliases without required SOI and EOI markers before final persistence', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpegmarker');
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpg',
    filename: 'photo.jpg',
    encoding: 'base64',
    payload: Buffer.from('not a jpeg').toString('base64'),
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(response.json.error), /could not be decoded as a valid JPEG/);

  const artifactStore = await getArtifactBlobStore({});
  const indexStore = await getArtifactIndexBlobStore({});

  assert.deepEqual((await artifactStore.list({ prefix: `image/${requestId}/` })).blobs, []);
  assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${requestId}/` })).blobs, []);
});

test('save-artifact rejects JPEG bytes that have markers but cannot be decoded before final persistence', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('jpegdecode');
  const invalidJpegBytes = Buffer.from([0xff, 0xd8, 0x00, 0x00, 0xff, 0xd9]);
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    contentType: 'image/jpeg',
    filename: 'photo.jpg',
    encoding: 'base64',
    payload: invalidJpegBytes.toString('base64'),
  });

  assert.equal(response.statusCode, 400);
  assert.match(String(response.json.error), /could not be decoded as a valid JPEG/);

  const artifactStore = await getArtifactBlobStore({});
  const indexStore = await getArtifactIndexBlobStore({});

  assert.deepEqual((await artifactStore.list({ prefix: `image/${requestId}/` })).blobs, []);
  assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${requestId}/` })).blobs, []);
});

test('save-artifact saves safe ArtifactReference display fields and rejects unsafe upload fields', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('schemareject');
  const bytes = await createImageBytes('png', 5);
  const validResponse = await postArtifact({
    ...makeBaseInput(requestId),
    filename: 'hero safe.png',
    label: 'Hero Safe Upload',
    tags: ['hero', 'safe'],
    encoding: 'base64',
    payload: bytes.toString('base64'),
  });

  assert.equal(validResponse.statusCode, 201);
  const artifact = validResponse.json.artifact as {
    originalFilename: string;
    label: string;
    tags: string[];
    sha256: string;
  };
  assert.equal(artifact.originalFilename, 'hero safe.png');
  assert.equal(artifact.label, 'Hero Safe Upload');
  assert.deepEqual(artifact.tags, ['hero', 'safe']);

  const indexStore = await getArtifactIndexBlobStore({});
  const expectedPointer = { requestId, sha256: artifact.sha256, artifactKind: 'image' };
  assert.deepEqual(
    JSON.parse((await indexStore.get(`by-kind/image/${artifact.sha256}.json`)) || '{}'),
    expectedPointer
  );
  assert.deepEqual(
    JSON.parse(
      (await indexStore.get(`by-request/${encodeURIComponent(requestId)}/image/${artifact.sha256}.json`)) || '{}'
    ),
    expectedPointer
  );
  assert.deepEqual(JSON.parse((await indexStore.get(`by-tag/hero/${artifact.sha256}.json`)) || '{}'), expectedPointer);
  assert.deepEqual(JSON.parse((await indexStore.get(`by-tag/safe/${artifact.sha256}.json`)) || '{}'), expectedPointer);

  const blobKeyResponse = await postArtifact({
    ...makeBaseInput(requestId),
    blobKey: `image/${requestId}/${'a'.repeat(64)}.png`,
    encoding: 'base64',
    payload: bytes.toString('base64'),
  });

  assert.equal(blobKeyResponse.statusCode, 400);
  assert.equal(blobKeyResponse.json.error, 'Invalid artifact upload input');
  assert.match(JSON.stringify(blobKeyResponse.json.issues), /Unrecognized key/);

  const artifactKindResponse = await postArtifact({
    ...makeBaseInput(requestId),
    artifactKind: 'markdown',
    encoding: 'base64',
    payload: bytes.toString('base64'),
  });

  assert.equal(artifactKindResponse.statusCode, 400);
  assert.equal(artifactKindResponse.json.error, 'Invalid artifact upload input');
  assert.match(JSON.stringify(artifactKindResponse.json.issues), /artifactKind/);

  const unsafeFieldResponse = await postArtifact({
    ...makeBaseInput(requestId),
    label: '<unsafe>',
    tags: ['x'.repeat(41)],
    encoding: 'base64',
    payload: bytes.toString('base64'),
  });

  assert.equal(unsafeFieldResponse.statusCode, 400);
  assert.equal(unsafeFieldResponse.json.error, 'Invalid artifact upload input');
  assert.match(JSON.stringify(unsafeFieldResponse.json.issues), /label|tags/);
});

test('save-artifact rejects a single-shot upload when expected size does not match decoded bytes', async () => {
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';

  const requestId = uniqueRequestId('sizemismatch');
  const bytes = Buffer.from('size checked bytes');
  const response = await postArtifact({
    ...makeBaseInput(requestId),
    encoding: 'base64',
    expectedSizeBytes: bytes.byteLength + 1,
    payload: bytes.toString('base64'),
  });

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.json, {
    error: `Artifact size mismatch: expected ${bytes.byteLength + 1} bytes, received ${bytes.byteLength} bytes.`,
  });

  const artifactStore = await getArtifactBlobStore({});
  const indexStore = await getArtifactIndexBlobStore({});

  assert.deepEqual((await artifactStore.list({ prefix: `image/${requestId}/` })).blobs, []);
  assert.deepEqual((await indexStore.list({ prefix: `request-artifacts/${requestId}/` })).blobs, []);
});
