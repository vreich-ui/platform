// T12.30 — an oversized source gallery becomes several sections, not a truncation plus a gap.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { MEDIA_MAX_ITEMS, bindMappingAssets, mapSnapshot } from './map.mjs';

const ORIGIN = 'https://example.test';

/** A page whose second block carries `count` captioned images — a gallery. */
const gallerySnapshot = (count, { path = '/gallery', gallery, text = 'Stills' } = {}) => {
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
            text: { value: text, length: text.length, truncated: false },
            links: [], boundingBoxes: {}, computedStyles: {}, screenshots: [], assetUrls: urls,
            ...(gallery ? { structure: { gallery: gallery(urls) } } : {})
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

// ─── T14.2 FAULT 3: captions reach their OWN image, or no image at all ────────
//
// The defect this answers: one gallery block carried 40 `assetUrls` and ONE text blob reading
// "The LIttle PrincessHouse with the ghostsMio mein MioSisters Liberty…" with no delimiters. Both
// halves were present and the pairing was gone. `structure.gallery` carries the pairing the crawl
// recovered by CONTAINMENT; these prove it survives mapping, splitting and binding — and that its
// absence produces no captions rather than 20 guesses.

const sha256Of = (value) => createHash('sha256').update(value).digest('hex');
const materializedArtifactRef = (manifestRef) => `image/req_capture_test_20260824_01/${sha256Of(manifestRef)}.jpg`;

/** Per-item captions recovered from the DOM, one per image, in source order. */
const perItemCaptions = (urls) => ({
  sourceCount: urls.length,
  captions: 'per_item',
  items: urls.map((url, index) => ({
    src: url,
    alt: `Still number ${index + 1}`,
    caption: `Film ${index + 1}`,
    captionSource: 'item_text',
  })),
});

const boundSections = (snapshot) =>
  bindMappingAssets(mapSnapshot(snapshot), materializedArtifactRef).mapping.pages[0].pageBody.sections;

test('a recovered caption reaches its own image’s `caption` field', () => {
  const sections = boundSections(gallerySnapshot(3, { gallery: perItemCaptions }));
  const media = sections.find((section) => section.type === 'media');
  // `mediaImageItemSchema.caption` already existed; what was missing was a caption to put in it.
  assert.deepEqual(
    media.data.items.map((item) => [item.alt, item.caption]),
    [
      ['Still number 1', 'Film 1'],
      ['Still number 2', 'Film 2'],
      ['Still number 3', 'Film 3'],
    ]
  );
});

test('captions stay with their own pictures when the gallery is split across sections', () => {
  // 20 items at a cap of 8 become 3 media sections (7 + 7 + 6). The split slices whole entries, so
  // an image and its caption cannot be separated by the division.
  const total = 20;
  const media = boundSections(gallerySnapshot(total, { gallery: perItemCaptions })).filter(
    (section) => section.type === 'media'
  );
  assert.equal(media.length, 3);
  const items = media.flatMap((section) => section.data.items);
  assert.equal(items.length, total);
  for (const [index, item] of items.entries()) {
    assert.equal(item.alt, `Still number ${index + 1}`);
    assert.equal(item.caption, `Film ${index + 1}`, 'each caption is still under its own poster');
  }
});

test('an image the recovered structure does not name gets NO caption from its neighbours', () => {
  const sections = boundSections(
    gallerySnapshot(3, {
      gallery: (urls) => ({
        sourceCount: urls.length,
        captions: 'partial',
        // Only the middle picture was captioned in the DOM.
        items: urls.map((url, index) => ({
          src: url,
          alt: `Still number ${index + 1}`,
          ...(index === 1 ? { caption: 'Film 2', captionSource: 'figcaption' } : {}),
        })),
      }),
    })
  );
  const media = sections.find((section) => section.type === 'media');
  assert.deepEqual(
    media.data.items.map((item) => item.caption ?? null),
    [null, 'Film 2', null]
  );
});

test('when per-item structure is NOT recoverable, no captions are emitted and the reason is recorded', () => {
  // The real shape of the defect: the titles ARE in the block's text, and nothing in the DOM says
  // which title belongs to which poster. Zipping them by index would look right on this page and
  // mislabel films on the next one, so the mapper emits none and puts the reason on the ledger.
  const titles =
    'The LIttle PrincessHouse with the ghostsMio mein MioSisters LibertyTwo Moons, Three SunsThe Last Winter';
  const snapshot = gallerySnapshot(5, {
    text: titles,
    gallery: (urls) => ({
      sourceCount: urls.length,
      captions: 'unavailable',
      reason: 'item_containers_do_not_share_one_parent',
      items: [],
    }),
  });
  const mapping = mapSnapshot(snapshot);
  const page = mapping.pages[0];
  const candidate = page.candidates.find((entry) => entry.sourceBlockIds.includes('block_gallery'));

  // Every image is still planned and still bound — only the captions are withheld. (Titles this
  // long read as body copy, so the block lands on `composition`; the point is that not one of the
  // five titles was attached to a picture on the strength of its position.)
  assert.equal(candidate.assetPlan.entries.length, 5);
  assert.equal(
    candidate.assetPlan.entries.some((entry) => 'caption' in entry),
    false
  );
  const sections = boundSections(snapshot);
  assert.equal(sections.flatMap((section) => section.data.images ?? section.data.items ?? []).length, 5);
  assert.equal(JSON.stringify(sections).includes('caption'), false, 'not one caption was invented');

  // And the block says WHY it has no captions rather than quietly having none.
  const gap = page.gaps.find((entry) => entry.blockRef === 'block_gallery');
  assert.equal(gap.why, 'gallery_item_captions_not_associable');
  assert.match(gap.missingCapability, /item_containers_do_not_share_one_parent/);
  assert.match(gap.missingCapability, /omitted rather than paired by position/);
  assert.equal(page.blockAccounting.find((entry) => entry.blockRef === 'block_gallery').status, 'mapped_with_gap');
});

test('a snapshot with no gallery structure at all still maps, and still says captions are missing', () => {
  // Pre-T14.2 snapshots record no `structure.gallery`. They keep mapping exactly as they did; the
  // only change is that the missing per-item association is now stated instead of invisible.
  const titles = 'The LIttle PrincessHouse with the ghostsMio mein MioSisters LibertyTwo Moons, Three Suns';
  const page = mapSnapshot(gallerySnapshot(5, { text: titles })).pages[0];
  const candidate = page.candidates.find((entry) => entry.sourceBlockIds.includes('block_gallery'));
  assert.equal(candidate.assetPlan.entries.length, 5);
  assert.equal(
    page.gaps
      .find((entry) => entry.blockRef === 'block_gallery')
      .missingCapability.includes('no_gallery_structure_captured'),
    true
  );
});
