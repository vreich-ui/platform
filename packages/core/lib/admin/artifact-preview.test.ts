/**
 * D1: the admin previewable-key gate. Two shapes, each mapping to exactly one
 * backing store on the server, so what this REFUSES matters as much as what it
 * admits — a key that slips through here is a key admin-get-blob-image will
 * classify into a store.
 *
 * Kept in step with the server's own copies of these patterns
 * (packages/core/server/functions/admin-get-blob-image.ts, whose
 * `classifyAdminBlobImageKey` is tested over the same refusal list in
 * tests/netlify/admin-get-blob-image.test.ts).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ADMIN_PREVIEWABLE_IMAGE_REF_RE,
  ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE,
  classifyAdminPreviewableBlobKey,
  getAdminBlobImageEndpoint,
  isAdminPreviewableArtifactKey,
  isAdminPreviewableTemplateThumbnailKey,
  isTraversalSafePathSegment,
} from './artifact-preview.js';

const SHA = 'b'.repeat(64);

test('the artifact shape still admits every real request id it always did', () => {
  for (const key of [
    `image/req_1/${SHA}.png`,
    `image/req_1/${SHA}`,
    `image/req_1/${SHA}.webp`,
    // Real request ids from this repo's own stored artifact references.
    `image/req_agent_qa_artifact_stress_test_20260806_01/${SHA}.png`,
    `image/req_visimg_vis_drlurie_examples_article_header_20260908_83/${SHA}.jpg`,
    // Not every key in the artifacts store was minted by createArtifactBlobKey
    // (pdf-tool writes there under a storage grant, and fixtures use plain
    // segments), so a non-`req_` segment must keep working.
    `image/guides/${SHA}.png`,
    // A single dot is still admitted: the charset is deliberately NOT narrowed
    // to the platform's request-id grammar — only traversal is guarded.
    `image/req_a.b/${SHA}.png`,
  ]) {
    assert.equal(classifyAdminPreviewableBlobKey(key), 'artifact', `must admit ${JSON.stringify(key)}`);
    assert.equal(isAdminPreviewableArtifactKey(key), true, `must be servable: ${JSON.stringify(key)}`);
  }
  assert.ok(ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(`image/req_1/${SHA}.png`));

  // …and still refuses what it always refused.
  assert.equal(classifyAdminPreviewableBlobKey('pdf/not-an-image-key'), undefined);
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${'b'.repeat(63)}.png`), undefined);
  assert.equal(classifyAdminPreviewableBlobKey(`image/a/b/${SHA}.png`), undefined);
});

/**
 * The artifact key's `<requestId>` segment gets the SAME traversal guard as
 * the thumbnail id segment. Nothing legitimate is lost: the platform mints
 * this segment through `validateRequestId` (`[a-z0-9_]` only — a dot cannot
 * survive `normalizeMachineSafeId`), and no stored key in this repo has a dot
 * in it at all.
 */
test('the artifact shape refuses traversal in its request-id segment', () => {
  for (const key of [
    `image/../${SHA}.png`,
    `image/./${SHA}.png`,
    `image/a..b/${SHA}.png`,
    `image/..../${SHA}.png`,
    `image/..a/${SHA}.png`,
    `image/a../${SHA}.png`,
    `image/../../${SHA}.png`,
  ]) {
    assert.equal(classifyAdminPreviewableBlobKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
    assert.equal(isAdminPreviewableArtifactKey(key), false, `must not be servable: ${JSON.stringify(key)}`);
    assert.equal(getAdminBlobImageEndpoint(key), undefined, `must build no endpoint for ${JSON.stringify(key)}`);
  }

  // As with thumbnails, it is the guard and not the pattern doing this work.
  assert.ok(ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(`image/a..b/${SHA}.png`));
  assert.ok(ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(`image/../${SHA}.png`));
});

test('D1: a pdf-tool template thumbnail key is now previewable, and lands on its own shape', () => {
  assert.equal(classifyAdminPreviewableBlobKey('thumbnails/tpl_article/v1.png'), 'template-thumbnail');
  assert.equal(classifyAdminPreviewableBlobKey('thumbnails/article_brochure_v1/v12.png'), 'template-thumbnail');
  assert.ok(ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test('thumbnails/tpl_article/v1.png'));

  // The endpoint is the plain function URL with the key encoded — no store or
  // kind parameter, so a caller never gets to name the store.
  const endpoint = getAdminBlobImageEndpoint('thumbnails/tpl_article/v1.png');
  assert.equal(endpoint, '/.netlify/functions/admin-get-blob-image?blobKey=thumbnails%2Ftpl_article%2Fv1.png');
  assert.doesNotMatch(String(endpoint), /store=/);
});

/**
 * The id segment now covers pdf-tool's `safeSegment` charset, dots included,
 * so a real dotted template id previews instead of being told it cannot.
 */
test('the thumbnail id segment covers pdf-tool safeSegment ids, dots included', () => {
  for (const key of [
    'thumbnails/drlurie.article.v1/v2.png',
    'thumbnails/a.b/v10.png',
    'thumbnails/tpl.article/v1.png',
    'thumbnails/0/v1.png',
    `thumbnails/${'a'.repeat(128)}/v1.png`,
  ]) {
    assert.equal(classifyAdminPreviewableBlobKey(key), 'template-thumbnail', `must admit ${JSON.stringify(key)}`);
    assert.ok(getAdminBlobImageEndpoint(key), `must build an endpoint for ${JSON.stringify(key)}`);
  }

  assert.equal(
    getAdminBlobImageEndpoint('thumbnails/drlurie.article.v1/v2.png'),
    '/.netlify/functions/admin-get-blob-image?blobKey=thumbnails%2Fdrlurie.article.v1%2Fv2.png'
  );
});

/**
 * The traversal guard on its own, away from the pattern: this is the part a
 * reviewer must be able to check without reading a regex.
 */
test('the traversal predicate refuses dot-only and dot-traversal segments on its own, for either shape', () => {
  for (const segment of ['.', '..', '...', 'a..b', '..a', 'a..', '..', 'a.b..c']) {
    assert.equal(isTraversalSafePathSegment(segment), false, `must refuse ${JSON.stringify(segment)}`);
  }
  for (const segment of ['a', 'drlurie.article.v1', 'a.b', 'tpl_article', 'a-b.c']) {
    assert.equal(isTraversalSafePathSegment(segment), true, `must allow ${JSON.stringify(segment)}`);
  }
});

/**
 * The refusal list this gate is defined by. Kept in step with the SAME list in
 * tests/netlify/admin-get-blob-image.test.ts, which runs it through both this
 * classifier and the server's — so the two patterns cannot drift apart without
 * a test failing.
 */
test('D1: the thumbnail shape refuses traversal, wrong extensions, bad versions and nesting', () => {
  for (const key of [
    // Traversal and dot-only segments — refused outright, never sanitised.
    'thumbnails/../../secret.png',
    'thumbnails/../v1.png',
    'thumbnails/./v1.png',
    'thumbnails/a..b/v1.png',
    'thumbnails/..a/v1.png',
    'thumbnails/a../v1.png',
    'thumbnails/..../v1.png',
    'thumbnails/.hidden/v1.png',
    '../thumbnails/tpl/v1.png',
    // Wrong extension.
    'thumbnails/tpl/v1.svg',
    'thumbnails/tpl/v1.png.svg',
    'thumbnails/tpl/v1',
    // Non-numeric or malformed version.
    'thumbnails/tpl/vlatest.png',
    'thumbnails/tpl/v.png',
    'thumbnails/tpl/1.png',
    // Nested / missing path segments.
    'thumbnails/tpl/nested/v1.png',
    'thumbnails/v1.png',
    'thumbnails//v1.png',
    // Id-segment charset: the first character is still letters/digits only.
    'thumbnails/-tpl/v1.png',
    'thumbnails/_tpl/v1.png',
    `thumbnails/${'a'.repeat(129)}/v1.png`,
    'thumbnailsx/tpl/v1.png',
  ]) {
    assert.equal(classifyAdminPreviewableBlobKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
    assert.equal(isAdminPreviewableTemplateThumbnailKey(key), false, `must not be servable: ${JSON.stringify(key)}`);
    assert.equal(getAdminBlobImageEndpoint(key), undefined, `must build no endpoint for ${JSON.stringify(key)}`);
  }
});

/**
 * A key the PATTERN admits but the guard refuses is the case the guard exists
 * for: without it, `thumbnails/a..b/v1.png` would classify into a store.
 */
test('the guard, not the pattern, is what stops a `..` inside an otherwise legal id', () => {
  assert.ok(ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test('thumbnails/a..b/v1.png'));
  assert.equal(isAdminPreviewableTemplateThumbnailKey('thumbnails/a..b/v1.png'), false);
  assert.equal(classifyAdminPreviewableBlobKey('thumbnails/a..b/v1.png'), undefined);
});

test('widening for thumbnails did not widen the artifact shape: neither pattern matches the other shape', () => {
  assert.ok(!ADMIN_PREVIEWABLE_IMAGE_REF_RE.test('thumbnails/tpl_article/v1.png'));
  assert.ok(!ADMIN_PREVIEWABLE_IMAGE_REF_RE.test('thumbnails/drlurie.article.v1/v2.png'));
  assert.ok(!ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test(`image/req_1/${SHA}.png`));
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${SHA}.png`), 'artifact');
});
