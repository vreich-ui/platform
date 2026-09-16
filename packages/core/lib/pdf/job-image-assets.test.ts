/**
 * Merging the two sources of render-job image assets.
 *
 * The rule under test is one sentence: the MAPPER's entries win on a shared
 * id, because the mapper's own data names them, and everything else the
 * caller sent survives. Replacing in either direction is what put a PDF on
 * dr-lurie with a broken hero on a job that reported success.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { mergeJobImageAssets } from './job-image-assets.js';

const image = (assetId: string, blobKey = `blob/${assetId}`) => ({ assetId, blobKey });

test('the preferred side wins on a shared id', () => {
  const merged = mergeJobImageAssets(
    { images: [image('cover', 'blob/callers-cover')] },
    { images: [image('cover', 'blob/mappers-cover')] }
  );
  assert.deepEqual(merged, { images: [image('cover', 'blob/mappers-cover')] });
});

test("the caller's other assets survive — a template can reference one the article never mentions", () => {
  const merged = mergeJobImageAssets(
    { images: [image('logo'), image('cover', 'blob/callers-cover')] },
    { images: [image('cover', 'blob/mappers-cover')] }
  );
  assert.deepEqual(merged, { images: [image('cover', 'blob/mappers-cover'), image('logo')] });
});

test('either side alone passes through', () => {
  assert.deepEqual(mergeJobImageAssets(undefined, { images: [image('cover')] }), { images: [image('cover')] });
  assert.deepEqual(mergeJobImageAssets({ images: [image('logo')] }, undefined), { images: [image('logo')] });
});

test('nothing on either side is undefined, never an empty assets object', () => {
  assert.equal(mergeJobImageAssets(undefined, undefined), undefined);
  assert.equal(mergeJobImageAssets({ images: [] }, { images: [] }), undefined);
  assert.equal(mergeJobImageAssets({}, {}), undefined);
});

test('an id is read as assetId ?? name ?? id, the same three pdf-tool reads', () => {
  const merged = mergeJobImageAssets(
    { images: [{ name: 'cover', blobKey: 'blob/by-name' }, { id: 'logo', blobKey: 'blob/by-id' }] },
    { images: [image('cover', 'blob/mappers-cover')] }
  );
  assert.deepEqual(merged, {
    images: [image('cover', 'blob/mappers-cover'), { id: 'logo', blobKey: 'blob/by-id' }],
  });
});

test('an entry with no identity is carried, not dropped — pdf-tool validates it, this merge does not', () => {
  const merged = mergeJobImageAssets({ images: [{ blobKey: 'blob/anonymous' }] }, { images: [image('cover')] });
  assert.deepEqual(merged, { images: [image('cover'), { blobKey: 'blob/anonymous' }] });
});

test('a non-array images field on either side is treated as no images', () => {
  assert.deepEqual(
    mergeJobImageAssets({ images: 'nonsense' as unknown as unknown[] }, { images: [image('cover')] }),
    { images: [image('cover')] }
  );
});
