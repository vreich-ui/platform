import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import sharp from 'sharp';

import {
  classifyAdminBlobImageKey,
  handler,
  isTraversalSafePathSegment,
  readAdminBlobImage,
  readAdminTemplateThumbnail,
} from '../../netlify/functions/admin-get-blob-image.js';
import {
  ADMIN_PREVIEWABLE_IMAGE_REF_RE,
  classifyAdminPreviewableBlobKey,
  isTraversalSafePathSegment as isTraversalSafePathSegmentOnTheClient,
} from '../../packages/core/lib/admin/artifact-preview.js';
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

// ─── T1.5: caching headers (`Cache-Control`, `ETag`, `If-None-Match` → 304) ─
//
// A day-long `max-age` only helps within a browser's own HTTP cache; the
// `ETag` is what makes a revisit (a fresh page load, a different tab) cheap
// too — so both are tested together, and specifically THAT the ETag varies
// with `w`: it is computed over the served (post-rendition) bytes, not the
// source blob, precisely so a 96px cache entry can never be handed a 304
// that actually means "still 512px".

test('admin-get-blob-image sets a day-long private Cache-Control and a stable ETag', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-etag-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = await pngBytes(200, 200, 30);
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  const response = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Cache-Control'], 'private, max-age=86400');
  assert.ok(
    (response.headers as Record<string, string>).ETag,
    'a 200 must carry an ETag for the client to revalidate with'
  );

  const again = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);
  assert.equal(
    (again.headers as Record<string, string>).ETag,
    (response.headers as Record<string, string>).ETag,
    'the same request must produce the same ETag'
  );
});

test('admin-get-blob-image returns 304 when If-None-Match matches, and never for a stale one', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-304-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = await pngBytes(200, 200, 40);
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  const first = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);
  const etag = (first.headers as Record<string, string>).ETag as string;

  const revalidated = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png' }, headers: { 'if-none-match': etag } },
    reference.blobKey
  );
  assert.equal(revalidated.statusCode, 304);
  assert.equal((revalidated.headers as Record<string, string>).ETag, etag);
  assert.equal(revalidated.headers['Cache-Control'], 'private, max-age=86400');
  assert.equal(revalidated.body, '', 'a 304 must not repeat the bytes the client already has');

  const staleEtag = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png' }, headers: { 'if-none-match': '"stale-etag"' } },
    reference.blobKey
  );
  assert.equal(staleEtag.statusCode, 200, 'a non-matching If-None-Match must still serve the bytes');
});

test("admin-get-blob-image's ETag varies with `w`, not just the source blob — a 96px cache entry must never 304 into a 512px response", async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const requestId = `admin-image-etag-width-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const bytes = await sharp({
    create: { width: 1000, height: 1000, channels: 3, background: { r: 50, g: 60, b: 70 } },
  })
    .png()
    .toBuffer();
  const reference = makeReference(requestId, bytes);
  await setReference(requestId, reference);
  await setArtifactBytes(reference, bytes);

  const small = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png', w: '96' } },
    reference.blobKey
  );
  const large = await readAdminBlobImage(
    { queryStringParameters: { contentType: 'image/png', w: '512' } },
    reference.blobKey
  );
  const original = await readAdminBlobImage({ queryStringParameters: { contentType: 'image/png' } }, reference.blobKey);

  const etags = [
    (small.headers as Record<string, string>).ETag,
    (large.headers as Record<string, string>).ETag,
    (original.headers as Record<string, string>).ETag,
  ];
  assert.equal(new Set(etags).size, 3, 'w=96, w=512 and the original must each carry a distinct ETag');

  // An `If-None-Match` carried over from the 96px request must not satisfy the 512px one.
  const crossWidth = await readAdminBlobImage(
    {
      queryStringParameters: { contentType: 'image/png', w: '512' },
      headers: { 'if-none-match': (small.headers as Record<string, string>).ETag as string },
    },
    reference.blobKey
  );
  assert.equal(crossWidth.statusCode, 200, 'a 96px ETag must never validate a 512px request');
});

test('D1: readAdminTemplateThumbnail carries the same day-long Cache-Control, ETag and 304 behavior as the artifact path', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const templateId = `tpl_etag_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const blobKey = `thumbnails/${templateId}/v1.png`;
  const bytes = await pngBytes(800, 600, 60);
  await setThumbnailBytes(blobKey, bytes);

  const first = await readAdminTemplateThumbnail({ queryStringParameters: {} }, blobKey);
  assert.equal(first.headers['Cache-Control'], 'private, max-age=86400');
  assert.ok((first.headers as Record<string, string>).ETag);

  const revalidated = await readAdminTemplateThumbnail(
    {
      queryStringParameters: {},
      headers: { 'if-none-match': (first.headers as Record<string, string>).ETag as string },
    },
    blobKey
  );
  assert.equal(revalidated.statusCode, 304);
  assert.equal(revalidated.body, '');
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

/**
 * The keys this gate MUST admit. The dotted ids are pdf-tool's real id space:
 * its writer-side `safeSegment` (pdf-tool netlify/lib/pdf-template-store.ts)
 * sanitises to `[a-zA-Z0-9._-]`, so `drlurie.article.v1` is a legal template
 * id and its thumbnail has to be servable.
 */
const ADMITTED_THUMBNAIL_KEYS = [
  'thumbnails/tpl_article/v1.png',
  'thumbnails/article_brochure_v1/v12.png',
  'thumbnails/drlurie.article.v1/v2.png',
  'thumbnails/a.b/v10.png',
  'thumbnails/tpl.article/v1.png',
  'thumbnails/0/v1.png',
  `thumbnails/${'a'.repeat(128)}/v1.png`,
];

/**
 * The refusal list this gate is defined by, kept in step with the same list in
 * packages/core/lib/admin/artifact-preview.test.ts. Both classifiers are run
 * over it below, so the browser gate and this server gate cannot drift apart
 * without a failure here.
 */
const REFUSED_THUMBNAIL_KEYS = [
  // Traversal and dot-only segments, in every spelling the key could carry
  // them — refused outright, never sanitised, before any store is opened.
  'thumbnails/../../secret.png',
  'thumbnails/../v1.png',
  'thumbnails/../secret/v1.png',
  'thumbnails/..%2F..%2Fsecret/v1.png',
  'thumbnails/./v1.png',
  'thumbnails/a..b/v1.png',
  'thumbnails/..a/v1.png',
  'thumbnails/a../v1.png',
  'thumbnails/..../v1.png',
  'thumbnails/.hidden/v1.png',
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
  // Id-segment charset: dots are now inside the shape, but the first
  // character is still letters/digits only, so no segment can start like a
  // flag or a hidden file, and the length bound is unchanged.
  'thumbnails/-tpl/v1.png',
  'thumbnails/_tpl/v1.png',
  `thumbnails/${'a'.repeat(129)}/v1.png`,
  // An artifact-shaped key must never be reclassified as a thumbnail.
  'thumbnails/tpl/v1.png\nimage/req/x',
];

const SHA64 = 'a'.repeat(64);

/** The server's artifact pattern is private; its browser mirror is the same regex. */
const artifactPatternAdmits = (key: string) => ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(key);

/**
 * Artifact keys that MUST keep working. Not every key in the `artifacts` store
 * was minted by `createArtifactBlobKey` (pdf-tool writes there through a
 * storage grant with its own `safeRequestSegment`, and older/fixture keys use
 * plain segments), so the request-id charset is deliberately not narrowed to
 * the platform's own grammar — only traversal is guarded.
 */
const ADMITTED_ARTIFACT_KEYS = [
  `image/req_a/${SHA64}.png`,
  `image/req_a/${SHA64}`,
  `image/req_agent_qa_artifact_stress_test_20260806_01/${SHA64}.png`,
  `image/req_visimg_vis_drlurie_examples_article_header_20260908_83/${SHA64}.jpg`,
  `image/guides/${SHA64}.png`,
  // A single dot stays legal — the tightening is about `..`, nothing else.
  `image/req_a.b/${SHA64}.png`,
];

/** Traversal spellings the artifact request-id segment must refuse outright. */
const REFUSED_ARTIFACT_KEYS = [
  `image/../${SHA64}.png`,
  `image/./${SHA64}.png`,
  `image/a..b/${SHA64}.png`,
  `image/..../${SHA64}.png`,
  `image/..a/${SHA64}.png`,
  `image/a../${SHA64}.png`,
  `image/../../${SHA64}.png`,
  // Still the pre-existing refusals: a short digest and a nested path.
  `image/req_a/${'a'.repeat(63)}.png`,
  `image/a/b/${SHA64}.png`,
];

test('D1: a template thumbnail key is classified to the templates store, and an artifact key still to artifacts', () => {
  for (const key of ADMITTED_ARTIFACT_KEYS) {
    assert.equal(classifyAdminBlobImageKey(key), 'artifact', `must admit ${JSON.stringify(key)}`);
  }
  for (const key of ADMITTED_THUMBNAIL_KEYS) {
    assert.equal(classifyAdminBlobImageKey(key), 'template-thumbnail', `must admit ${JSON.stringify(key)}`);
  }
  for (const key of REFUSED_ARTIFACT_KEYS) {
    assert.equal(classifyAdminBlobImageKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
  }
});

/**
 * The artifact request-id segment carries the same guard as the thumbnail id
 * segment — the pattern alone would admit `image/../<sha>.png`, and this gate
 * is what stops an authenticated admin reading an arbitrary blob.
 */
test('the artifact shape refuses traversal in its request-id segment, by guard rather than by pattern', () => {
  assert.ok(artifactPatternAdmits(`image/../${SHA64}.png`), 'the pattern alone would admit it');
  assert.ok(artifactPatternAdmits(`image/a..b/${SHA64}.png`), 'the pattern alone would admit it');
  for (const key of [
    `image/../${SHA64}.png`,
    `image/./${SHA64}.png`,
    `image/a..b/${SHA64}.png`,
    `image/..../${SHA64}.png`,
  ]) {
    assert.equal(classifyAdminBlobImageKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
  }
});

test('D1: the traversal guard is its own predicate, refusing dot-only and `..`-bearing segments', () => {
  for (const segment of ['.', '..', '...', 'a..b', '..a', 'a..', 'a.b..c']) {
    assert.equal(isTraversalSafePathSegment(segment), false, `must refuse ${JSON.stringify(segment)}`);
  }
  for (const segment of ['a', 'drlurie.article.v1', 'a.b', 'tpl_article', 'a-b.c']) {
    assert.equal(isTraversalSafePathSegment(segment), true, `must allow ${JSON.stringify(segment)}`);
  }
});

test('D1: the server gate and the browser gate agree, key for key, on both lists', () => {
  for (const key of ADMITTED_ARTIFACT_KEYS) {
    assert.equal(classifyAdminPreviewableBlobKey(key), 'artifact', `browser must admit ${JSON.stringify(key)}`);
    assert.equal(classifyAdminBlobImageKey(key), 'artifact', `server must admit ${JSON.stringify(key)}`);
  }
  for (const key of REFUSED_ARTIFACT_KEYS) {
    assert.equal(classifyAdminPreviewableBlobKey(key), undefined, `browser must refuse ${JSON.stringify(key)}`);
    assert.equal(classifyAdminBlobImageKey(key), undefined, `server must refuse ${JSON.stringify(key)}`);
  }
  for (const key of ADMITTED_THUMBNAIL_KEYS) {
    assert.equal(
      classifyAdminPreviewableBlobKey(key),
      classifyAdminBlobImageKey(key),
      `browser and server must agree on ${JSON.stringify(key)}`
    );
  }
  // Parity is over keys as each gate actually sees them — already trimmed:
  // the browser trims inside `classifyAdminPreviewableBlobKey`, the server in
  // `handlerImpl`'s `toText` before it ever calls `classifyAdminBlobImageKey`.
  // The one surrounding-whitespace entry is asserted on its own below.
  for (const key of REFUSED_THUMBNAIL_KEYS.filter((candidate) => candidate === candidate.trim())) {
    assert.equal(classifyAdminPreviewableBlobKey(key), undefined, `browser must refuse ${JSON.stringify(key)}`);
    assert.equal(classifyAdminBlobImageKey(key), undefined, `server must refuse ${JSON.stringify(key)}`);
  }
  // Surrounding whitespace: the raw server classifier refuses it outright
  // (strictly narrower), and the browser trims before classifying — so the
  // key that reaches the server is the trimmed one either way.
  assert.equal(classifyAdminBlobImageKey(' thumbnails/tpl/v1.png'), undefined);
  assert.equal(classifyAdminPreviewableBlobKey(' thumbnails/tpl/v1.png'), 'template-thumbnail');
  // The mirrored predicate is the same predicate, not a lookalike.
  for (const segment of ['.', '..', 'a..b', 'drlurie.article.v1', 'tpl_article']) {
    assert.equal(
      isTraversalSafePathSegmentOnTheClient(segment),
      isTraversalSafePathSegment(segment),
      `browser and server must agree on segment ${JSON.stringify(segment)}`
    );
  }
});

test('D1: the thumbnail shape refuses traversal, wrong extension, non-numeric version, nesting and every near miss', () => {
  for (const key of REFUSED_THUMBNAIL_KEYS) {
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

/**
 * The pattern alone would admit `thumbnails/a..b/v1.png` — the separate
 * traversal predicate is the only thing that stops it becoming a store read.
 */
test('D1: a `..` in either shape\'s id segment is stopped by the guard, and never reaches a store', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  assert.equal(classifyAdminBlobImageKey('thumbnails/a..b/v1.png'), undefined);

  const previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'owner@example.com';
  try {
    for (const blobKey of [
      'thumbnails/a..b/v1.png',
      'thumbnails/../v1.png',
      'thumbnails/./v1.png',
      // The same guard on the artifact shape: neither store is opened.
      `image/../${SHA64}.png`,
      `image/./${SHA64}.png`,
      `image/a..b/${SHA64}.png`,
    ]) {
      const response = await handler(
        { httpMethod: 'GET', queryStringParameters: { blobKey } },
        adminContext('owner@example.com')
      );
      assert.equal(response.statusCode, 400, `must refuse ${JSON.stringify(blobKey)} without opening a store`);
    }
  } finally {
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});

test('D1: a dotted pdf-tool template id serves its thumbnail bytes end to end', async () => {
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.CONTEXT = 'dev';

  const templateId = `drlurie.article.v1.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  const blobKey = `thumbnails/${templateId}/v2.png`;
  const bytes = await pngBytes(400, 300, 60);
  await setThumbnailBytes(blobKey, bytes);

  assert.equal(classifyAdminBlobImageKey(blobKey), 'template-thumbnail');

  const previousAdminEmails = process.env.ADMIN_EMAILS;
  process.env.ADMIN_EMAILS = 'owner@example.com';
  try {
    const response = await handler(
      { httpMethod: 'GET', queryStringParameters: { blobKey } },
      adminContext('owner@example.com')
    );
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['Content-Type'], 'image/png');
    assert.equal(Buffer.from(response.body, 'base64').length, bytes.length);
  } finally {
    if (previousAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = previousAdminEmails;
  }
});
