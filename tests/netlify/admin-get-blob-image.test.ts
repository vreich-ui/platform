import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import sharp from 'sharp';

import { readAdminBlobImage } from '../../netlify/functions/admin-get-blob-image.js';
import { getArtifactBlobStore, getArtifactIndexBlobStore } from '../../packages/core/server/lib/blob-store.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const makeReference = (requestId: string, bytes: Buffer, filename = 'hero.png') => ({
  blobKey: `image/${requestId}/${sha256(bytes)}.png`,
  sizeBytes: bytes.byteLength,
  sha256: sha256(bytes),
  contentType: 'image/png',
  createdAtISO: new Date().toISOString(),
  artifactKind: 'image',
  originalFilename: filename,
  label: filename,
});

const setReference = async (requestId: string, reference: ReturnType<typeof makeReference>) => {
  const indexStore = await getArtifactIndexBlobStore({});

  await indexStore.setJSON(`request-artifacts/${encodeURIComponent(requestId)}/${reference.sha256}.json`, reference, {
    metadata: {
      requestId,
      sha256: reference.sha256,
      contentType: reference.contentType,
    },
  });
};

const setArtifactBytes = async (
  reference: ReturnType<typeof makeReference>,
  bytes: Buffer,
  blobKey = reference.blobKey
) => {
  const artifactStore = await getArtifactBlobStore({});

  await artifactStore.set(blobKey, bytes, {
    metadata: {
      contentType: reference.contentType,
      sha256: reference.sha256,
      sizeBytes: String(reference.sizeBytes),
      createdAtISO: reference.createdAtISO,
    },
  });
};

test('admin-get-blob-image reports missing artifact bytes distinctly', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = Buffer.from('missing image bytes');
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);

  const response = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);
  const body = JSON.parse(response.body) as { reason?: string; diagnostics?: { exactFilenameExists?: boolean } };

  assert.equal(response.statusCode, 404);
  assert.equal(body.reason, 'missing-artifact-bytes');
  assert.equal(body.diagnostics?.exactFilenameExists, false);
});

test('admin-get-blob-image reports ambiguous artifact bytes distinctly', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-ambiguous-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = Buffer.from(`ambiguous image bytes ${requestId}`);
  const reference = makeReference(requestId, bytes);
  const artifactStore = await getArtifactBlobStore({});
  await setReference(requestId, reference);
  await artifactStore.del(reference.blobKey);
  await setArtifactBytes(reference, bytes, `image/${requestId}-one/${reference.sha256}.png`);
  await setArtifactBytes(reference, bytes, `image/${requestId}-two/${reference.sha256}.png`);

  const response = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);
  const body = JSON.parse(response.body) as { reason?: string; diagnostics?: { matchingKeys?: string[] } };

  assert.equal(response.statusCode, 409);
  assert.equal(body.reason, 'ambiguous-artifact-bytes');
  assert.equal(body.diagnostics?.matchingKeys?.length, 2);
});

test('admin-get-blob-image validates present but corrupt artifact bytes', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = Buffer.from('not a png image');
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  const response = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);
  const body = JSON.parse(response.body) as { reason?: string; validationReason?: string; error?: string };

  assert.equal(response.statusCode, 422);
  assert.equal(body.reason, 'invalid-image-bytes');
  assert.match(body.validationReason ?? '', /could not be decoded as a valid PNG/);
  assert.match(body.error ?? '', /Invalid image artifact/);
});


// ─── D-preview-rendition: the optional `w` query param ─────────────────────

test('admin-get-blob-image serves a width-bounded rendition when `w` is present, and leaves the original untouched when it is absent', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-rendition-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = await sharp({
    create: { width: 2000, height: 1000, channels: 3, background: { r: 10, g: 20, b: 200 } },
  })
    .png()
    .toBuffer();
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  const originalResponse = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png' } },
    reference.blobKey
  );
  assert.equal(originalResponse.statusCode, 200);
  const originalBytes = Buffer.from(originalResponse.body, 'base64');
  assert.equal(originalBytes.length, bytes.length, 'no `w` must serve the original bytes unchanged');

  const renditionResponse = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png', w: '512' } },
    reference.blobKey
  );
  assert.equal(renditionResponse.statusCode, 200);
  assert.equal(renditionResponse.headers['Content-Type'], 'image/png');
  const renditionBytes = Buffer.from(renditionResponse.body, 'base64');
  assert.ok(renditionBytes.length < originalBytes.length, 'the rendition must be materially smaller than the original');

  const renditionMetadata = await sharp(renditionBytes).metadata();
  assert.ok(renditionMetadata.width, 'bounded on the longest edge (width, for this 2:1 image)');
  assert.ok(renditionMetadata.width! <= 512);
  assert.ok(renditionMetadata.height! <= 512);
});

test('admin-get-blob-image falls back to the original bytes when a rendition cannot be produced (width out of range)', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-rendition-oob-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = await sharp({
    create: { width: 40, height: 40, channels: 3, background: { r: 5, g: 5, b: 5 } },
  })
    .png()
    .toBuffer();
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  // Not a positive integer — `w` is ignored, not rejected, and the request still succeeds with the original.
  const response = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png', w: 'not-a-number' } },
    reference.blobKey
  );
  assert.equal(response.statusCode, 200);
  const responseBytes = Buffer.from(response.body, 'base64');
  assert.equal(responseBytes.length, bytes.length);
});
