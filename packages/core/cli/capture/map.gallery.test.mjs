// T12.30 — an oversized source gallery becomes several sections, not a truncation plus a gap.
import assert from 'node:assert/strict';
import test from 'node:test';

import { MEDIA_MAX_ITEMS, mapSnapshot } from './map.mjs';

const ORIGIN = 'https://example.test';

/** A page whose second block carries `count` captioned images — a gallery. */
const gallerySnapshot = (count, { path = '/gallery' } = {}) => {
  const urls = Array.from({ length: count }, (_, i) => `${ORIGIN}/img-${i + 1}.jpg`);
  return {
    schemaVersion: 'snapshot.v1',
    capture: {
      targetUrl: `${ORIGIN}${path}`,
      origin: ORIGIN,
      capturedAt: '2026-08-22T10:00:00.000Z',
      policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } }
    },
    pages: [
      {
        pageId: 'page_1',
        requestedUrl: `${ORIGIN}${path}`,
        url: `${ORIGIN}${path}`,
        path,
        status: 200,
        title: 'Gallery',
        outline: [{ tag: 'h1', level: 1, text: 'Stills', selector: '#h1' }],
        blocks: [
          {
            id: 'block_intro', ordinal: 0, tag: 'section', selector: '#intro',
            text: { value: 'Stills A short introduction to the gallery below.', length: 48, truncated: false },
            links: [], boundingBoxes: {}, computedStyles: {}, screenshots: [], assetUrls: []
          },
          {
            id: 'block_gallery', ordinal: 1, tag: 'section', selector: '#gallery',
            text: { value: 'Stills', length: 6, truncated: false },
            links: [], boundingBoxes: {}, computedStyles: {}, screenshots: [], assetUrls: urls
          }
        ],
        assets: urls.map((url, i) => ({ url, kind: 'image', alt: `Still number ${i + 1}` })),
        navigation: [], discoveredLinks: [], screenshots: []
      }
    ],
    diagnostics: {}
  };
};

const galleryParts = (count) => {
  const page = mapSnapshot(gallerySnapshot(count)).pages[0];
  return {
    page,
    parts: (page.candidates ?? []).filter((candidate) => (candidate.sourceBlockIds ?? []).includes('block_gallery'))
  };
};

test(`a gallery within capacity (${MEDIA_MAX_ITEMS}) stays ONE section`, () => {
  const { parts } = galleryParts(MEDIA_MAX_ITEMS);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].assetPlan.entries.length, MEDIA_MAX_ITEMS);
});

test('a gallery over capacity is divided into sections instead of truncated', () => {
  const total = MEDIA_MAX_ITEMS * 2 + 3; // 19 at a cap of 8
  const { page, parts } = galleryParts(total);

  assert.ok(parts.length > 1, 'the gallery was divided');
  // EVERY source image survives. Before T12.30 the overflow was dropped and reported as a gap.
  assert.equal(parts.reduce((sum, part) => sum + part.assetPlan.entries.length, 0), total);
  assert.ok(parts.every((part) => part.assetPlan.entries.length <= MEDIA_MAX_ITEMS), 'every part is within capacity');
  assert.equal(page.gaps.some((gap) => gap.why === 'media_gallery_exceeds_section_capacity'), false);

  // Distinct ids, or the parts collide and only one survives emission.
  assert.equal(new Set(parts.map((part) => part.section.id)).size, parts.length);
  assert.equal(new Set(parts.map((part) => part.candidateId)).size, parts.length);

  // No image is duplicated or lost across the division.
  const refs = parts.flatMap((part) => part.assetPlan.entries.map((entry) => entry.manifestRef));
  assert.equal(new Set(refs).size, total);
});

test('parts are divided EVENLY — never a trailing section holding one picture', () => {
  // Greedy chunking of 9 at a cap of 8 gives 8 + 1: a second "gallery" containing a single image,
  // which reads as a mistake on the page and is outright invalid for a logo strip (floor of 2).
  const { parts } = galleryParts(MEDIA_MAX_ITEMS + 1);
  assert.equal(parts.length, 2);
  assert.deepEqual(parts.map((part) => part.assetPlan.entries.length), [5, 4]);
});

test('the heading belongs to the gallery, not to each of its parts', () => {
  const { parts } = galleryParts(MEDIA_MAX_ITEMS * 2);
  assert.ok(parts.length > 1);
  // Repeating it would read as several different galleries that happen to share a title.
  assert.equal(parts.slice(1).some((part) => 'heading' in part.data), false);
});

test('layout describes each part’s own item count, not the original total', () => {
  // A block needs two or more assets to be read as media at all, so 'single' is unreachable by this
  // path — 'strip' (exactly two) is the smallest shape a gallery block can take.
  assert.equal(galleryParts(2).parts[0].data.layout, 'strip');
  // 9 divides to 5 + 4, so both parts are grids — and neither claims the original nine.
  const { parts } = galleryParts(MEDIA_MAX_ITEMS + 1);
  assert.ok(parts.every((part) => part.data.layout === 'grid'));
});
