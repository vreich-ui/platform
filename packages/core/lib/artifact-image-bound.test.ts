import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { boundArtifactImageDimensions, isRasterImageArtifact } from './artifact-image-bound.js';

const makeJpeg = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 3, background: { r: 12, g: 40, b: 200 } } }).jpeg().toBuffer();

const makePng = (width: number, height: number) =>
  sharp({ create: { width, height, channels: 4, background: { r: 250, g: 10, b: 90, alpha: 1 } } }).png().toBuffer();

test('isRasterImageArtifact matches artifact-upload.ts\'s downstream image check', () => {
  assert.equal(isRasterImageArtifact('image', 'application/octet-stream'), true);
  assert.equal(isRasterImageArtifact('data', 'image/jpeg'), true);
  assert.equal(isRasterImageArtifact('data', 'image/jpeg; charset=binary'), true);
  assert.equal(isRasterImageArtifact('pdf', 'application/pdf'), false);
  assert.equal(isRasterImageArtifact('data', 'application/octet-stream'), false);
});

test('boundArtifactImageDimensions shrinks an oversized image to the longest-edge bound without cropping', async () => {
  const bytes = await makeJpeg(3000, 1500);

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/jpeg',
    maxDimensionPx: 2048,
  });

  assert.equal(result.resized, true);
  assert.deepEqual(result.dimensions?.original, { width: 3000, height: 1500 });
  // Longest edge lands exactly on the bound; aspect ratio (2:1) is preserved
  // exactly since 3000/1500 divides evenly, proving this is a bound, not a crop.
  assert.deepEqual(result.dimensions?.stored, { width: 2048, height: 1024 });
  assert.equal(Math.max(result.dimensions!.stored.width, result.dimensions!.stored.height), 2048);

  const storedMetadata = await sharp(result.bytes).metadata();
  assert.equal(storedMetadata.width, 2048);
  assert.equal(storedMetadata.height, 1024);
  assert.equal(storedMetadata.format, 'jpeg'); // format preserved, never converted

  assert.notEqual(Buffer.compare(result.bytes, bytes), 0);
  assert.ok(result.bytes.byteLength < bytes.byteLength);
});

test('boundArtifactImageDimensions preserves a portrait aspect ratio when bounding', async () => {
  const bytes = await makePng(1200, 6000);

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/png',
    maxDimensionPx: 2048,
  });

  assert.equal(result.resized, true);
  assert.deepEqual(result.dimensions?.stored, { width: 410, height: 2048 }); // 1200*2048/6000 = 409.6 -> 410
  assert.equal(Math.max(result.dimensions!.stored.width, result.dimensions!.stored.height), 2048);

  const storedMetadata = await sharp(result.bytes).metadata();
  assert.equal(storedMetadata.format, 'png');
});

test('boundArtifactImageDimensions passes a small image through byte-identical (no sharp round-trip)', async () => {
  const bytes = await makeJpeg(800, 600);

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/jpeg',
    maxDimensionPx: 2048,
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes); // exact same buffer reference, not merely equal bytes
  assert.deepEqual(result.dimensions, {
    original: { width: 800, height: 600 },
    stored: { width: 800, height: 600 },
  });
});

test('boundArtifactImageDimensions never upscales an image already under the bound', async () => {
  const bytes = await makePng(400, 300);

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/png',
    maxDimensionPx: 2048,
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes);
});

test('boundArtifactImageDimensions passes a PDF through byte-identical without touching sharp', async () => {
  const bytes = Buffer.from('%PDF-1.7\nnot actually a real pdf body, just bytes');

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'pdf',
    contentType: 'application/pdf',
    maxDimensionPx: 2048,
    loadSharpOverride: async () => {
      throw new Error('sharp must never be loaded for a non-image artifact');
    },
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes);
  assert.equal(result.dimensions, undefined);
});

test('boundArtifactImageDimensions passes a generic data artifact through byte-identical', async () => {
  const bytes = Buffer.from('arbitrary opaque bytes, not an image');

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'data',
    contentType: 'application/octet-stream',
    maxDimensionPx: 2048,
    loadSharpOverride: async () => {
      throw new Error('sharp must never be loaded for a non-image artifact');
    },
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes);
});

test('boundArtifactImageDimensions passes undecodable "image" bytes through unchanged without throwing', async () => {
  const bytes = Buffer.from('this looks nothing like a jpeg to sharp');

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/jpeg',
    maxDimensionPx: 2048,
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes);
  assert.equal(result.dimensions, undefined);
});

test('boundArtifactImageDimensions falls back to byte-identical passthrough when the sharp loader itself fails', async () => {
  const bytes = await makeJpeg(4000, 4000);

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/jpeg',
    maxDimensionPx: 2048,
    loadSharpOverride: async () => {
      throw new Error('simulated: sharp native binding unavailable on this platform');
    },
  });

  assert.equal(result.resized, false);
  assert.equal(result.bytes, bytes);
});

test('boundArtifactImageDimensions calls sharp.resize with fit "inside" and withoutEnlargement, never cropping', async () => {
  const resizeCalls: unknown[] = [];
  const bytes = Buffer.from('fake-large-image-bytes');
  const resizedBytes = Buffer.from('fake-resized-bytes');

  const fakeSharp = (input: Buffer) => {
    const isResizedInput = Buffer.compare(input, bytes) === 0;
    return {
      metadata: async () => (isResizedInput ? { width: 4000, height: 2000, format: 'jpeg' } : { width: 2048, height: 1024, format: 'jpeg' }),
      resize: (width: number, height: number, options: unknown) => {
        resizeCalls.push([width, height, options]);
        return {
          toBuffer: async () => resizedBytes,
        };
      },
    };
  };

  const result = await boundArtifactImageDimensions({
    bytes,
    artifactKind: 'image',
    contentType: 'image/jpeg',
    maxDimensionPx: 2048,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    loadSharpOverride: async () => fakeSharp as any,
  });

  assert.equal(result.resized, true);
  assert.equal(result.bytes, resizedBytes);
  assert.deepEqual(resizeCalls, [[2048, 2048, { fit: 'inside', withoutEnlargement: true }]]);
});
