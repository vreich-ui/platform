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
} from './artifact-preview.js';

const SHA = 'b'.repeat(64);

test('the artifact shape is unchanged — it still admits exactly what it always did', () => {
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${SHA}.png`), 'artifact');
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${SHA}`), 'artifact');
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${SHA}.webp`), 'artifact');
  assert.ok(ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(`image/req_1/${SHA}.png`));

  // …and still refuses what it always refused.
  assert.equal(classifyAdminPreviewableBlobKey('pdf/not-an-image-key'), undefined);
  assert.equal(classifyAdminPreviewableBlobKey(`image/req_1/${'b'.repeat(63)}.png`), undefined);
  assert.equal(classifyAdminPreviewableBlobKey(`image/a/b/${SHA}.png`), undefined);
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

test('D1: the thumbnail shape refuses traversal, wrong extensions, bad versions and nesting', () => {
  for (const key of [
    'thumbnails/../../secret.png',
    'thumbnails/../v1.png',
    'thumbnails/./v1.png',
    '../thumbnails/tpl/v1.png',
    'thumbnails/tpl/v1.svg',
    'thumbnails/tpl/v1.png.svg',
    'thumbnails/tpl/v1',
    'thumbnails/tpl/vlatest.png',
    'thumbnails/tpl/v.png',
    'thumbnails/tpl/1.png',
    'thumbnails/tpl/nested/v1.png',
    'thumbnails/v1.png',
    'thumbnails//v1.png',
    'thumbnails/tpl.article/v1.png',
    'thumbnails/-tpl/v1.png',
    `thumbnails/${'a'.repeat(129)}/v1.png`,
    'thumbnailsx/tpl/v1.png',
  ]) {
    assert.equal(classifyAdminPreviewableBlobKey(key), undefined, `must refuse ${JSON.stringify(key)}`);
    assert.equal(getAdminBlobImageEndpoint(key), undefined, `must build no endpoint for ${JSON.stringify(key)}`);
  }
});

test('widening for thumbnails did not widen the artifact shape: neither pattern matches the other shape', () => {
  assert.ok(!ADMIN_PREVIEWABLE_IMAGE_REF_RE.test('thumbnails/tpl_article/v1.png'));
  assert.ok(!ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test(`image/req_1/${SHA}.png`));
});
