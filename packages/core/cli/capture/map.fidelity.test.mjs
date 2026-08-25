// T14.2 — image fidelity: the URL a thumbnail hides, and the slot it may not be stretched into.
//
// The evidence these tests are built from is a real capture of the Zilberman filmography
// (run_1787497206104_nckgkv), where every asset URL baked `w_146,h_194` into its path, the engine
// downloaded exactly that, and the section rendered it 980–1440px wide.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  ASSET_SLOT,
  UPSCALE_MATERIAL_MIN_RATIO,
  UPSCALE_OK_MAX_RATIO,
  assetFidelity,
  canonicalizeAssetUrl,
  mapSnapshot,
} from './map.mjs';

const ORIGIN = 'https://example.test';

// ─── A. canonicalizeAssetUrl ─────────────────────────────────────────────────

test('a Wix transform URL proposes the untransformed original and reports the delivered size', () => {
  const { canonical, original, transform } = canonicalizeAssetUrl(
    'https://static.wixstatic.com/media/944663_fdac~mv2.jpg/v1/fill/w_146,h_194,q_75,enc_avif,quality_auto/944663_fdac~mv2.jpg'
  );
  assert.equal(canonical, 'https://static.wixstatic.com/media/944663_fdac~mv2.jpg');
  assert.ok(original.includes('/v1/fill/w_146'), 'the captured URL is returned intact as the fallback');
  assert.equal(transform.family, 'wix');
  // 146×194 is what the CDN actually delivered — a real intrinsic measurement, not an estimate.
  assert.deepEqual({ width: transform.width, height: transform.height }, { width: 146, height: 194 });
});

test('a chained Wix crop+fill reports the size the LAST transform delivered', () => {
  // `/v1/crop/x_0,y_2,w_450,h_490/fill/w_460,h_501,…/Misha.jpg` — the crop is taken from something
  // larger, which is the page's own proof that an original exists behind the thumbnail. What
  // arrived in the browser is nonetheless the 460×501 fill.
  const { transform } = canonicalizeAssetUrl(
    'https://static.wixstatic.com/media/944663_f7ac~mv2.jpg/v1/crop/x_0,y_2,w_450,h_490/fill/w_460,h_501,al_c,lg_1,q_80,enc_avif/Misha.jpg'
  );
  assert.deepEqual({ width: transform.width, height: transform.height }, { width: 460, height: 501 });
});

test('a Wix URL that is already the original is returned unchanged', () => {
  const url = 'https://static.wixstatic.com/media/944663_fdac~mv2.jpg';
  assert.deepEqual(canonicalizeAssetUrl(url), { canonical: url, original: url, transform: null });
});

test('a Cloudinary transform segment is stripped while the version and public id survive', () => {
  const { canonical, transform } = canonicalizeAssetUrl(
    'https://res.cloudinary.com/demo/image/upload/w_400,h_300,c_fill,q_auto/v1699999999/folder/poster.jpg'
  );
  assert.equal(canonical, 'https://res.cloudinary.com/demo/image/upload/v1699999999/folder/poster.jpg');
  assert.equal(transform.family, 'cloudinary');
  assert.deepEqual({ width: transform.width, height: transform.height }, { width: 400, height: 300 });
});

test('a Cloudinary URL with no transform segment is left alone', () => {
  const url = 'https://res.cloudinary.com/demo/image/upload/v1699999999/folder/poster.jpg';
  assert.equal(canonicalizeAssetUrl(url).transform, null);
});

test('query-sized CDNs lose their sizing parameters and keep everything else', () => {
  const imgix = canonicalizeAssetUrl('https://acme.imgix.net/poster.jpg?w=146&h=194&auto=format&fit=crop');
  // `auto=format` and `fit=crop` describe the asset rather than shrinking it; removing them would
  // change what comes back for reasons that have nothing to do with fidelity.
  assert.equal(imgix.canonical, 'https://acme.imgix.net/poster.jpg?auto=format&fit=crop');
  assert.deepEqual(
    { ...imgix.transform, removed: undefined },
    { family: 'imgix', kind: 'query', width: 146, height: 194, removed: undefined }
  );

  const shopify = canonicalizeAssetUrl('https://cdn.shopify.com/s/files/1/0/poster.jpg?v=1699999999&width=200');
  assert.equal(shopify.canonical, 'https://cdn.shopify.com/s/files/1/0/poster.jpg?v=1699999999');
  assert.equal(shopify.transform.width, 200);

  // Squarespace states the width inside `format`.
  const squarespace = canonicalizeAssetUrl('https://images.squarespace-cdn.com/content/abc/poster.jpg?format=750w');
  assert.equal(squarespace.canonical, 'https://images.squarespace-cdn.com/content/abc/poster.jpg');
  assert.equal(squarespace.transform.width, 750);
});

test('an unrecognised host is never rewritten, however transform-shaped its URL looks', () => {
  // The same `/image/upload/w_400,h_300/` path on a host that is not Cloudinary. Matching on shape
  // rather than host would rewrite a URL that was already the original and lose the asset.
  for (const url of [
    'https://cdn.acme.example/demo/image/upload/w_400,h_300/poster.jpg',
    'https://acme.example/media/x/v1/fill/w_146,h_194/poster.jpg',
    'https://acme.example/poster.jpg?w=146&h=194',
  ]) {
    assert.deepEqual(canonicalizeAssetUrl(url), { canonical: url, original: url, transform: null }, url);
  }
});

test('a malformed, relative, or non-http input is returned untouched rather than guessed at', () => {
  for (const value of ['', 'not a url', '/relative/poster.jpg', 'data:image/png;base64,AAAA', null, undefined, 42]) {
    assert.deepEqual(canonicalizeAssetUrl(value), { canonical: value, original: value, transform: null });
  }
});

// ─── B. assetFidelity ────────────────────────────────────────────────────────

test('the upscale verdicts sit exactly on their named thresholds', () => {
  assert.equal(assetFidelity({ width: 1000, height: 1000 }, { width: 1000 }), 'ok');
  assert.equal(assetFidelity({ width: 1000, height: 1000 }, { width: 1000 * UPSCALE_OK_MAX_RATIO }), 'ok');
  assert.equal(assetFidelity({ width: 1000, height: 1000 }, { width: 1200 }), 'upscale_minor');
  assert.equal(
    assetFidelity({ width: 1000, height: 1000 }, { width: 1000 * UPSCALE_MATERIAL_MIN_RATIO }),
    'upscale_material'
  );
  // The defect itself: 146px into a 980px slot.
  assert.equal(assetFidelity({ width: 146, height: 194 }, { width: 980 }), 'upscale_material');
});

test('an asset larger than its slot is never a defect, and height counts as well as width', () => {
  assert.equal(assetFidelity({ width: 4000, height: 3000 }, { width: 1440 }), 'ok');
  // A slot that is wide enough but far too tall still stretches the picture.
  assert.equal(assetFidelity({ width: 1000, height: 100 }, { width: 1000, height: 400 }), 'upscale_material');
});

test('an unknown intrinsic or an unmeasured slot is `ok`, not a fabricated defect', () => {
  // Every pre-T14.2 snapshot records no intrinsic at all; inventing an upscale for those would gap
  // perfectly good blocks on no evidence whatsoever.
  assert.equal(assetFidelity(null, { width: 1440 }), 'ok');
  assert.equal(assetFidelity({ width: 146, height: 194 }, null), 'ok');
  assert.equal(assetFidelity({}, {}), 'ok');
});

// ─── B (end to end). The mapper acts on the verdict ──────────────────────────

/** One page: an intro block, then a gallery block of `images` in a measured slot. */
const snapshotWith = (images, { blockWidth = 1440, text = 'Stills', structure } = {}) => ({
  schemaVersion: 'snapshot.v1',
  capture: {
    targetUrl: `${ORIGIN}/gallery`,
    origin: ORIGIN,
    capturedAt: '2026-08-24T10:00:00.000Z',
    policy: { rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' } },
  },
  pages: [
    {
      pageId: 'page_1',
      requestedUrl: `${ORIGIN}/gallery`,
      url: `${ORIGIN}/gallery`,
      path: '/gallery',
      status: 200,
      title: 'Gallery',
      outline: [{ tag: 'h1', level: 1, text: 'Stills', selector: '#h1' }],
      blocks: [
        {
          id: 'block_intro',
          ordinal: 0,
          tag: 'section',
          selector: '#intro',
          text: { value: 'Stills A short introduction to the gallery below.', length: 48, truncated: false },
          links: [],
          boundingBoxes: {},
          computedStyles: {},
          screenshots: [],
          assetUrls: [],
        },
        {
          id: 'block_gallery',
          ordinal: 1,
          tag: 'section',
          selector: '#gallery',
          text: { value: text, length: text.length, truncated: false },
          links: [],
          boundingBoxes: {
            mobile: { width: Math.min(blockWidth, 980), height: 800 },
            desktop: { width: blockWidth, height: 800 },
          },
          computedStyles: {},
          screenshots: [],
          assetUrls: images.map((image) => image.url),
          ...(structure ? { structure } : {}),
        },
      ],
      assets: images,
      navigation: [],
      discoveredLinks: [],
      screenshots: [],
    },
  ],
  diagnostics: {},
});

const galleryImage = (index, { intrinsic, host = ORIGIN } = {}) => ({
  url: `${host}/img-${index}.jpg`,
  kind: 'image',
  alt: `Still number ${index}`,
  ...(intrinsic ? { intrinsic } : {}),
});

const galleryOf = (snapshot) => {
  const page = mapSnapshot(snapshot).pages[0];
  return { page, parts: page.candidates.filter((c) => c.sourceBlockIds.includes('block_gallery')) };
};

test('a thumbnail with no larger original addressable is refused, not stretched', () => {
  // 146×194 assets on a host with no transform vocabulary: this IS the best fidelity obtainable,
  // and even a grid cell (1440/3 = 480px) is a 3.3× upscale.
  const images = [1, 2, 3].map((n) => galleryImage(n, { intrinsic: { width: 146, height: 194, source: 'natural' } }));
  const { page, parts } = galleryOf(snapshotWith(images));

  assert.equal(parts.length, 0, 'no section was built out of images it would have to stretch');
  const gap = page.gaps.find((entry) => entry.blockRef === 'block_gallery');
  assert.equal(gap.why, 'asset_resolution_below_section_slot');
  // The numbers travel with the gap: nobody has to take the refusal on trust.
  assert.match(gap.missingCapability, /146×194 into a 480px slot \(3\.29× upscale\)/);
  // And the block is still accounted — refused is not the same as forgotten.
  assert.equal(page.blockAccounting.find((entry) => entry.blockRef === 'block_gallery').status, 'gap');
});

test('the SAME thumbnail is planned, not refused, when a larger original can be proposed', () => {
  // Identical pixels, a Wix URL. `canonicalizeAssetUrl` proposes the untransformed original, so
  // the map-time intrinsic describes a derivative and the verdict belongs to emission, which can
  // fetch and verify one. Refusing here would gap every image on the page this task exists for.
  const images = [1, 2, 3].map((n) => ({
    url: `https://static.wixstatic.com/media/944663_${n}~mv2.jpg/v1/fill/w_146,h_194,q_75,enc_avif/poster.jpg`,
    kind: 'image',
    alt: `Still number ${n}`,
  }));
  const { page, parts } = galleryOf(snapshotWith(images));

  assert.equal(parts.length, 1);
  assert.equal(
    page.gaps.some((gap) => gap.why === 'asset_resolution_below_section_slot'),
    false
  );
  // The intrinsic came off the URL's own transform, and every entry says its verdict is pending.
  assert.deepEqual(parts[0].assetPlan.entries[0].intrinsic, { width: 146, height: 194, source: 'transform' });
  assert.ok(parts[0].assetPlan.entries.every((entry) => entry.fidelity === 'pending_source_upgrade'));
});

test('the media layout steps down to a slot the images can actually fill', () => {
  // Three 280px images in a 900px block. Their count proposes a `grid`, whose two-up cell is 450px
  // (1.61×, material); a `strip` figure is a third of that block (300px, 1.07× — honest). Choosing
  // the strip IS "a section type whose slot the asset can fill"; the alternative was a stretch.
  const images = [1, 2, 3].map((n) => galleryImage(n, { intrinsic: { width: 280, height: 280, source: 'natural' } }));
  const { parts } = galleryOf(snapshotWith(images, { blockWidth: 900 }));

  assert.equal(parts[0].sectionType, 'media');
  assert.equal(parts[0].data.layout, 'strip');
  assert.equal(parts[0].assetPlan.slotWidth, Math.round(900 * ASSET_SLOT['items:strip'].widthFraction));
  assert.match(parts[0].mappingReason, /a grid slot is wider than these source images can fill/);
});

test('images large enough for their natural layout keep it', () => {
  const images = [1, 2, 3].map((n) => galleryImage(n, { intrinsic: { width: 1200, height: 800, source: 'natural' } }));
  const { parts } = galleryOf(snapshotWith(images, { blockWidth: 900 }));
  assert.equal(parts[0].data.layout, 'grid');
  assert.equal(
    parts[0].assetPlan.entries.some((entry) => 'fidelity' in entry),
    false,
    "'ok' stays silent"
  );
});

test('a block with copy keeps its copy when its images are refused, and says why', () => {
  // A composition would put each image in a section-wide block. These cannot fill one, and every
  // narrower type carries no body — so the copy is mapped, the images are not bound, and the gap
  // names the resolution rather than the symptom.
  const images = [1, 2].map((n) => galleryImage(n, { intrinsic: { width: 120, height: 120, source: 'natural' } }));
  const body = 'Stills The foundation has restored eleven films since 2016, each scanned from the original negative.';
  const { page, parts } = galleryOf(snapshotWith(images, { text: body }));

  assert.equal(parts.length, 1);
  assert.equal(parts[0].assetPlan, undefined, 'no asset field was bound');
  assert.ok(JSON.stringify(parts[0].data).includes('restored eleven films'), 'the extracted copy survived');
  const gap = page.gaps.find((entry) => entry.blockRef === 'block_gallery');
  assert.equal(gap.why, 'asset_resolution_below_section_slot');
  assert.equal(page.blockAccounting.find((entry) => entry.blockRef === 'block_gallery').status, 'mapped_with_gap');
});

test('a block with no measured box is planned as before — no measurement, no verdict', () => {
  const images = [1, 2, 3].map((n) => galleryImage(n, { intrinsic: { width: 60, height: 60, source: 'natural' } }));
  const snapshot = snapshotWith(images);
  snapshot.pages[0].blocks[1].boundingBoxes = {};
  const { parts } = galleryOf(snapshot);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].assetPlan.slotWidth, undefined);
});

test('a picture refused by more than one placement is counted once', () => {
  // The planner, the bio-portrait upgrade and the composition upgrade all judge the same block. A
  // ledger that counted one refusal three times would overstate the very defect it reports.
  const images = [1, 2].map((n) => galleryImage(n, { intrinsic: { width: 100, height: 100, source: 'natural' } }));
  const body = 'Stills In memory of our founder, whose biography the trustees asked us to publish here in full.';
  const { page } = galleryOf(snapshotWith(images, { text: body }));
  const gap = page.gaps.find((entry) => entry.blockRef === 'block_gallery');
  assert.match(gap.missingCapability, /^a source image large enough[^]*?2 source image\(s\)/);
});

test('the slot table still mirrors the renderers it claims to have been read off', () => {
  // `ASSET_SLOT` states what one image gets, and it was read off these components by inspection —
  // there is no exported layout metric to import. So the load-bearing classes are pinned here: a
  // renderer that changes its columns fails loudly instead of drifting these numbers into fiction.
  const componentText = (name) => readFileSync(new URL(`../../components/sections/${name}`, import.meta.url), 'utf8');

  const media = componentText('Media.astro');
  assert.match(media, /sm:grid-cols-2/, 'media grid is two-up, so one item gets half the section');
  assert.equal(ASSET_SLOT['items:grid'].widthFraction, 1 / 2);
  assert.match(media, /w-72 flex-none/, 'a strip figure is a FIXED 288px in a horizontal scroller');
  // A third of a measured block over-estimates 288px at any block ≥ 864px, which is the safe
  // direction: the rule flags rather than excuses.
  assert.equal(ASSET_SLOT['items:strip'].widthFraction, 1 / 3);
  assert.match(media, /space-y-8/, 'a single is one full-width figure per row');
  assert.equal(ASSET_SLOT['items:single'].widthFraction, 1);

  assert.match(componentText('ContentSplit.astro'), /grid gap-3 sm:grid-cols-2/, 'images subdivide their column');
  assert.match(componentText('BrandRow.astro'), /class="h-8 w-auto"/, 'a logo strip is height-constrained');
  assert.equal(ASSET_SLOT.logos.heightPx, 32);
  assert.match(componentText('Composition.astro'), /class="h-auto w-full"/, 'a composition image spans the section');
  assert.equal(ASSET_SLOT.composition.widthFraction, 1);
});

test('Shopify’s `_400x300` FILENAME suffix is deliberately left alone', () => {
  // Declined, not missed. Every transform this strips lives in a documented grammar that cannot be
  // part of an asset's identity; a filename is the identity. `poster.jpg` and `poster_400x300.jpg`
  // can be two unrelated uploads, and verification compares SIZE, not identity — so a wrong guess
  // would resolve to a real, larger, entirely different picture and pass every check on the way to
  // the page. The query form (`?width=`) covers the transform case without that risk.
  const suffixed = 'https://cdn.shopify.com/s/files/1/0/poster_400x300.jpg?v=1699999999';
  assert.deepEqual(canonicalizeAssetUrl(suffixed), {
    canonical: suffixed,
    original: suffixed,
    transform: null,
  });

  // A filename that merely CONTAINS dimensions is untouched on any host — it is just its name.
  for (const url of [
    'https://cdn.shopify.com/s/files/1/0/sales_100x100.png',
    'https://acme.example/downloads/wallpaper_1920x1080.jpg',
  ]) {
    assert.equal(canonicalizeAssetUrl(url).transform, null, url);
  }

  // The query form still works, and still leaves the filename exactly as it found it.
  const query = canonicalizeAssetUrl('https://cdn.shopify.com/s/files/1/0/poster_400x300.jpg?width=200');
  assert.equal(query.canonical, 'https://cdn.shopify.com/s/files/1/0/poster_400x300.jpg');
  assert.equal(query.transform.width, 200);
});
