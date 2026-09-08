import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import sharp from 'sharp';

import {
  classifyAdminBlobImageKey,
  handler,
  readAdminBlobImage,
  readAdminTemplateThumbnail,
} from '../../netlify/functions/admin-get-blob-image.js';
import {
  getArtifactBlobStore,
  getArtifactIndexBlobStore,
  getPdfTemplateBlobStore,
} from '../../packages/core/server/lib/blob-store.js';

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


// ─── D1: PDF template thumbnails (`thumbnails/<templateId>/v<n>.png`) ───────
//
// A second, narrow allow shape whose bytes live in the `pdf-templates` store,
// not `artifacts`. The tests below deliberately weigh what this REFUSES at
// least as heavily as what it now serves: the key shape is what picks the
// store, so a hole in the shape is a hole in the store boundary.

const setThumbnailBytes = async (blobKey: string, bytes: Buffer) => {
  const templateStore = await getPdfTemplateBlobStore({});

  await templateStore.set(blobKey, bytes);
};

const pngBytes = (width: number, height: number, tint: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: tint, g: tint, b: tint } } })
    .png()
    .toBuffer();

test('D1: a template thumbnail key is classified to the templates store, and an artifact key still to artifacts', () => {
  assert.equal(classifyAdminBlobImageKey(`image/req_a/${'a'.repeat(64)}.png`), 'artifact');
  assert.equal(classifyAdminBlobImageKey(`image/req_a/${'a'.repeat(64)}`), 'artifact');
  assert.equal(classifyAdminBlobImageKey('thumbnails/tpl_article/v1.png'), 'template-thumbnail');
  assert.equal(classifyAdminBlobImageKey('thumbnails/article_brochure_v1/v12.png'), 'template-thumbnail');
});

test('D1: the thumbnail shape refuses traversal, wrong extension, non-numeric version, nesting and every near miss', () => {
  const refused = [
    // Traversal, in every spelling the key could carry it.
    'thumbnails/../../secret.png',
    'thumbnails/../v1.png',
    'thumbnails/../secret/v1.png',
    'thumbnails/..%2F..%2Fsecret/v1.png',
    'thumbnails/./v1.png',
    '../thumbnails/tpl/v1.png',
    // Wrong extension — only PNG is ever written here.
    'thumbnails/tpl/v1.svg',
    'thumbnails/tpl/v1.jpg',
    'thumbnails/tpl/v1.png.svg',
    'thumbnails/tpl/v1',
    // Non-numeric or malformed version segment.
    'thumbnails/tpl/vlatest.png',
    'thumbnails/tpl/v.png',
    'thumbnails/tpl/v-1.png',
    'thumbnails/tpl/1.png',
    'thumbnails/tpl/v1234567890123.png',
    // Nested / extra path segments, and a missing one.
    'thumbnails/tpl/nested/v1.png',
    'thumbnails/v1.png',
    'thumbnails//v1.png',
    'thumbnails/tpl/v1.png/x',
    // Not this prefix at all, or only prefixed by it.
    'pdfme/tpl/v1.png',
    'xthumbnails/tpl/v1.png',
    'thumbnailsx/tpl/v1.png',
    ' thumbnails/tpl/v1.png',
    // Id-segment charset: dots are deliberately outside the shape, and a
    // leading dash/underscore is refused so no segment can start like a flag.
    'thumbnails/tpl.article/v1.png',
    'thumbnails/-tpl/v1.png',
    'thumbnails/_tpl/v1.png',
    `thumbnails/${'a'.repeat(129)}/v1.png`,
    // An artifact-shaped key must never be reclassified as a thumbnail.
    'thumbnails/tpl/v1.png\nimage/req/x',
  ];

  for (const key of refused) {
    assert.equal(classifyAdminBlobImageKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
  }
});

test('D1: readAdminTemplateThumbnail serves PNG bytes out of the pdf-templates store', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const templateId = `tpl_serve_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const blobKey = `thumbnails/${templateId}/v3.png`;
  const bytes = await pngBytes(800, 600, 120);
  await setThumbnailBytes(blobKey, bytes);

  const response = await readAdminTemplateThumbnail({ queryStringParameters: {} }, blobKey);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'image/png');
  assert.equal(Buffer.from(response.body, 'base64').length, bytes.length, 'no `w` serves the original bytes');
});

test('D1: the thumbnail path honours the same width-bounded rendition as the artifact path', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const templateId = `tpl_rendition_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const blobKey = `thumbnails/${templateId}/v1.png`;
  const bytes = await pngBytes(1600, 900, 90);
  await setThumbnailBytes(blobKey, bytes);

  const response = await readAdminTemplateThumbnail({ queryStringParameters: { w: '256' } }, blobKey);

  assert.equal(response.statusCode, 200);
  const renditionBytes = Buffer.from(response.body, 'base64');
  assert.ok(renditionBytes.length < bytes.length, 'the rendition must be materially smaller');
  const metadata = await sharp(renditionBytes).metadata();
  assert.ok(metadata.width! <= 256 && metadata.height! <= 256);
});

test('D1: a thumbnail key with no bytes behind it reports its own distinct 404 reason', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const blobKey = `thumbnails/tpl_absent_${Date.now()}/v9.png`;

  const response = await readAdminTemplateThumbnail({ queryStringParameters: {} }, blobKey);
  const body = JSON.parse(response.body) as { reason?: string; store?: string };

  assert.equal(response.statusCode, 404);
  assert.equal(body.reason, 'missing-template-thumbnail-bytes');
  assert.equal(body.store, 'pdf-templates');
});

test('D1: thumbnail bytes that are not a decodable PNG are refused, not served', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const blobKey = `thumbnails/tpl_corrupt_${Date.now()}/v1.png`;
  await setThumbnailBytes(blobKey, Buffer.from('<svg onload=alert(1)></svg>'));

  const response = await readAdminTemplateThumbnail({ queryStringParameters: {} }, blobKey);
  const body = JSON.parse(response.body) as { reason?: string; store?: string };

  assert.equal(response.statusCode, 422);
  assert.equal(body.reason, 'invalid-image-bytes');
  assert.equal(body.store, 'pdf-templates');
});

test('D1: the two stores stay separate — neither reader can reach the other store\'s bytes', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const stamp = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const bytes = await pngBytes(64, 64, 200);

  // An artifact-shaped key whose bytes were (only) written into the TEMPLATES
  // store must not become readable: the artifact reader never opens that store.
  const requestId = `admin-image-crossstore-${stamp}`;
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setThumbnailBytes(reference.blobKey, bytes);

  const artifactResponse = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png' } },
    reference.blobKey
  );
  assert.equal(artifactResponse.statusCode, 404, 'artifact keys are read from `artifacts` only');
  assert.equal(
    (JSON.parse(artifactResponse.body) as { reason?: string }).reason,
    'missing-artifact-bytes'
  );

  // …and the mirror image: a thumbnail-shaped key whose bytes were written
  // into the ARTIFACTS store is not readable through the thumbnail path.
  const thumbKey = `thumbnails/tpl_crossstore_${stamp}/v1.png`;
  const artifactStore = await getArtifactBlobStore({});
  await artifactStore.set(thumbKey, bytes);

  const thumbnailResponse = await readAdminTemplateThumbnail({ queryStringParameters: {} }, thumbKey);
  assert.equal(thumbnailResponse.statusCode, 404, 'thumbnail keys are read from `pdf-templates` only');
  assert.equal(
    (JSON.parse(thumbnailResponse.body) as { reason?: string }).reason,
    'missing-template-thumbnail-bytes'
  );
});

// ─── D1: the handler gate applies identically to both shapes ───────────────

const adminContext = (email: string) => ({ clientContext: { user: { sub: 'user_admin', email } } });

test('D1: the admin gate is enforced on the thumbnail path exactly as on the artifact path', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const templateId = `tpl_gate_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const blobKey = `thumbnails/${templateId}/v1.png`;
  await setThumbnailBytes(blobKey, await pngBytes(120, 120, 40));

  const get = { httpMethod: 'GET', queryStringParameters: { blobKey } };

  // No identity at all — same 401 both shapes get.
  assert.equal((await handler(get)).statusCode, 401);
  assert.equal(
    (await handler({ httpMethod: 'GET', queryStringParameters: { blobKey: `image/r/${'a'.repeat(64)}.png` } }))
      .statusCode,
    401
  );

  // Authenticated but not an admin — 403, not a read.
  const previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'owner@example.com';
  try {
    assert.equal((await handler(get, adminContext('stranger@example.com'))).statusCode, 403);

    // An admin gets the bytes — this is the whole point of D1.
    const allowed = await handler(get, adminContext('owner@example.com'));
    assert.equal(allowed.statusCode, 200);
    assert.equal(allowed.headers['Content-Type'], 'image/png');

    // A refused shape never reaches a store, even for that same admin.
    const refused = await handler(
      { httpMethod: 'GET', queryStringParameters: { blobKey: 'thumbnails/../../secret.png' } },
      adminContext('owner@example.com')
    );
    assert.equal(refused.statusCode, 400);
  } finally {
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});
