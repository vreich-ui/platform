// T14.2 — the gallery grouping rule, tested without a browser.
//
// `groupGalleryItems` is the judgement half of the crawl's repeated-figure extraction: the in-page
// shell only walks the DOM and reports one plain descriptor per image, and every decision about
// those descriptors is made here. That split exists so this file can exist — the repo has no DOM
// harness (no browser binary, no jsdom, and adding one is not worth a dependency), so a rule left
// inside `page.evaluate` would ship untested, and this is the most novel rule in the change.
//
// IT IMPORTS `./gallery-items.mjs`, NOT `./browser.mjs`, AND THAT IS LOAD-BEARING. The rule was
// briefly re-exported from browser.mjs, whose first import is playwright-core — which meant this
// file only ran where a browser engine was installed, the very dependency the extraction exists to
// escape. `gallery-items.mjs` imports nothing at all, so this suite passes in a tree with no
// node_modules. Keep it that way: reaching for browser.mjs here silently un-does the separation.
//
// EVERY DESCRIPTOR BELOW IS REAL WALK OUTPUT. Each case names the DOM shape it came from, and the
// `containerPath`/`parentPath` values are the ones the shell's own `selectorFor` produces for that
// shape — not invented paths that happen to make an assertion pass.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { GALLERY_MAX_ITEMS, GALLERY_MIN_ITEMS, groupGalleryItems } from './gallery-items.mjs';

const PARENT = 'html > section > div';
/** One descriptor, with the shape-independent fields defaulted. */
const node = (overrides) => ({
  src: null,
  alt: null,
  text: '',
  figcaption: null,
  href: null,
  intrinsic: null,
  containerPath: null,
  parentPath: PARENT,
  ...overrides,
});

test('figure + figcaption: the author’s own caption wins and says so', () => {
  // <div><figure><img alt><figcaption>Film 1</figcaption></figure> ×2 </div>
  // Note `text` equals the figcaption here — a figure's own text CONTAINS its caption, which is
  // exactly why the precedence has to be stated rather than left to whichever field is non-empty.
  const grouped = groupGalleryItems(
    [1, 2].map((i) =>
      node({
        src: `https://site.test/p${i}.jpg`,
        alt: `Poster ${i}`,
        text: `Film ${i}`,
        figcaption: `Film ${i}`,
        intrinsic: { width: 146, height: 194, source: 'natural' },
        containerPath: `${PARENT} > figure:nth-of-type(${i})`,
      })
    )
  );

  assert.equal(grouped.captions, 'per_item');
  assert.equal(grouped.sourceCount, 2);
  assert.deepEqual(
    grouped.items.map((item) => [item.src, item.caption, item.captionSource]),
    [
      ['https://site.test/p1.jpg', 'Film 1', 'figcaption'],
      ['https://site.test/p2.jpg', 'Film 2', 'figcaption'],
    ]
  );
  assert.deepEqual(grouped.items[0].intrinsic, { width: 146, height: 194, source: 'natural' });
});

test('a <figcaption> outranks the container’s loose text when they differ', () => {
  const grouped = groupGalleryItems(
    [1, 2].map((i) =>
      node({
        src: `https://site.test/p${i}.jpg`,
        // The card also carries a price or a byline; the author NAMED the figure, so that name wins.
        text: `Film ${i} £12.00 In stock`,
        figcaption: `Film ${i}`,
        containerPath: `${PARENT} > figure:nth-of-type(${i})`,
      })
    )
  );
  assert.deepEqual(
    grouped.items.map((item) => item.caption),
    ['Film 1', 'Film 2']
  );
  assert.ok(grouped.items.every((item) => item.captionSource === 'figcaption'));
});

test('Wix-style nested anchor cards: caption from the item’s own text, href from its anchor', () => {
  // <div><a href="/film-1"><div><div><img alt></div></div><span>Mio mein Mio 1</span></a> ×2 </div>
  // No <figure> and no <figcaption> anywhere — the shape the reference site actually serves.
  const grouped = groupGalleryItems(
    [1, 2].map((i) =>
      node({
        src: `https://site.test/w${i}.jpg`,
        alt: `Alt ${i}`,
        text: `Mio mein Mio ${i}`,
        href: `https://site.test/film-${i}`,
        intrinsic: { width: 146, height: 194, source: 'natural' },
        containerPath: `${PARENT} > a:nth-of-type(${i})`,
      })
    )
  );

  assert.equal(grouped.captions, 'per_item');
  assert.deepEqual(
    grouped.items.map((item) => [item.caption, item.captionSource, item.href]),
    [
      ['Mio mein Mio 1', 'item_text', 'https://site.test/film-1'],
      ['Mio mein Mio 2', 'item_text', 'https://site.test/film-2'],
    ]
  );
});

test('bare images with no text in reach: items, but NO captions, and the reason travels with them', () => {
  // <section><img alt="X"><img alt="Y"></section> — the walk stops at each image, so there is no
  // per-item text at all. The pictures are still usable; the captions simply do not exist.
  const grouped = groupGalleryItems(
    ['x', 'y'].map((id, index) =>
      node({
        src: `https://site.test/${id}.jpg`,
        alt: id.toUpperCase(),
        intrinsic: { width: 800, height: 600, source: 'natural' },
        containerPath: `${PARENT} > img:nth-of-type(${index + 1})`,
      })
    )
  );

  assert.equal(grouped.items.length, 2);
  assert.equal(grouped.captions, 'unavailable');
  assert.equal(grouped.reason, 'no_per_item_caption_text_in_dom');
  assert.equal(
    grouped.items.some((item) => 'caption' in item || 'captionSource' in item),
    false
  );
});

test('ragged nesting is REFUSED outright rather than partly recovered', () => {
  // <div><img><img></div> beside <div><figure><img><figcaption></figure></div>: the paired images
  // stop at themselves (parent = the first div) while the solo one grows to its figure (parent =
  // the outer div). Two parents, so this is not one repeat. Keeping the larger group would silently
  // drop the rest — the exact failure the whole feature exists to prevent.
  const grouped = groupGalleryItems([
    node({
      src: 'https://site.test/m.jpg',
      alt: 'M',
      containerPath: 'html > section > div:nth-of-type(1) > img:nth-of-type(1)',
      parentPath: 'html > section > div:nth-of-type(1)',
    }),
    node({
      src: 'https://site.test/n.jpg',
      alt: 'N',
      containerPath: 'html > section > div:nth-of-type(1) > img:nth-of-type(2)',
      parentPath: 'html > section > div:nth-of-type(1)',
    }),
    node({
      src: 'https://site.test/o.jpg',
      alt: 'O',
      text: 'Cap O',
      figcaption: 'Cap O',
      containerPath: 'html > section > div:nth-of-type(2)',
      parentPath: 'html > section',
    }),
  ]);

  assert.deepEqual(grouped.items, []);
  assert.equal(grouped.captions, 'unavailable');
  assert.equal(grouped.reason, 'item_containers_do_not_share_one_parent');
  // The count is still reported: a refusal says how much evidence it refused.
  assert.equal(grouped.sourceCount, 3);
});

test('two images inside ONE caption container refuse rather than share the caption', () => {
  // <div><figure><img A><img B><figcaption>One caption</figcaption></figure><figure><img C>…</div>
  // Real walk output for this shape: A and B stop at themselves (their parent holds two images) so
  // their parent is the figure, while C grows to its own figure whose parent is the div. The
  // grouping refuses on that difference — which is the outcome that matters, because the tempting
  // alternative is to hand "One caption" to both A and B, and one caption cannot describe two
  // pictures. The shape does not occur on the reference page (its 40 URLs are <img>+<source> pairs,
  // so the walk sees 20 images) but it is a real shape and it fails safe.
  const grouped = groupGalleryItems([
    node({
      src: 'https://site.test/a.jpg',
      alt: 'A',
      containerPath: `${PARENT} > figure:nth-of-type(1) > img:nth-of-type(1)`,
      parentPath: `${PARENT} > figure:nth-of-type(1)`,
    }),
    node({
      src: 'https://site.test/b.jpg',
      alt: 'B',
      containerPath: `${PARENT} > figure:nth-of-type(1) > img:nth-of-type(2)`,
      parentPath: `${PARENT} > figure:nth-of-type(1)`,
    }),
    node({
      src: 'https://site.test/c.jpg',
      alt: 'C',
      text: 'Cap C',
      figcaption: 'Cap C',
      containerPath: `${PARENT} > figure:nth-of-type(2)`,
      parentPath: PARENT,
    }),
  ]);

  assert.equal(grouped.captions, 'unavailable');
  assert.equal(grouped.reason, 'item_containers_do_not_share_one_parent');
  assert.equal(JSON.stringify(grouped).includes('One caption'), false, 'no caption was shared out');
});

test('a single image is not a gallery', () => {
  assert.equal(groupGalleryItems([node({ src: 'https://site.test/z.jpg', alt: 'Z' })]), null);
  assert.equal(groupGalleryItems([]), null);
  assert.equal(groupGalleryItems(null), null);
  // A descriptor with no `src` is not a picture, so it cannot make up the repeat threshold.
  assert.equal(
    groupGalleryItems([node({ src: 'https://site.test/z.jpg' }), node({ src: null, text: 'Caption' })]),
    null
  );
  assert.equal(GALLERY_MIN_ITEMS, 2);
});

test('descriptors reporting the SAME container are refused as indistinguishable', () => {
  // Defensive, and unreachable through today's walk: an ancestor holding exactly one image cannot
  // be the container of two. If it ever became reachable, whatever text that container holds would
  // describe both images or neither, and choosing between them is inventing — so it refuses.
  const grouped = groupGalleryItems([
    node({ src: 'https://site.test/a.jpg', text: 'Shared', containerPath: `${PARENT} > figure` }),
    node({ src: 'https://site.test/b.jpg', text: 'Shared', containerPath: `${PARENT} > figure` }),
  ]);
  assert.deepEqual(grouped.items, []);
  assert.equal(grouped.reason, 'item_containers_are_not_distinct');
});

test('some items captioned and some not is reported as partial, never back-filled', () => {
  const grouped = groupGalleryItems(
    [1, 2, 3].map((i) =>
      node({
        src: `https://site.test/p${i}.jpg`,
        ...(i === 2 ? { text: 'Only the middle one is named' } : {}),
        containerPath: `${PARENT} > figure:nth-of-type(${i})`,
      })
    )
  );
  assert.equal(grouped.captions, 'partial');
  assert.deepEqual(
    grouped.items.map((item) => item.caption ?? null),
    [null, 'Only the middle one is named', null]
  );
});

test('the item cap truncates and SAYS it truncated; a refusal never claims truncation', () => {
  const many = Array.from({ length: GALLERY_MAX_ITEMS + 6 }, (_, i) =>
    node({
      src: `https://site.test/p${i}.jpg`,
      text: `Film ${i}`,
      containerPath: `${PARENT} > figure:nth-of-type(${i + 1})`,
    })
  );
  const grouped = groupGalleryItems(many);
  assert.equal(grouped.items.length, GALLERY_MAX_ITEMS);
  assert.equal(grouped.sourceCount, GALLERY_MAX_ITEMS + 6);
  assert.equal(grouped.truncated, true);

  // `sourceCount` also carries the shell's own transport bound: when the walk capped its descriptor
  // list, the true image count is still what gets reported.
  const capped = groupGalleryItems(many.slice(0, 4), { sourceCount: 300 });
  assert.equal(capped.sourceCount, 300);
  assert.equal(capped.truncated, true);

  // A refused shape reports no items, so it cannot honestly claim a cap was the reason.
  const refused = groupGalleryItems([
    node({ src: 'https://site.test/a.jpg', containerPath: 'a', parentPath: 'p1' }),
    node({ src: 'https://site.test/b.jpg', containerPath: 'b', parentPath: 'p2' }),
  ]);
  assert.equal('truncated' in refused, false);
});

test('caption text is clipped to the same bound the rest of `structure` uses', () => {
  const grouped = groupGalleryItems(
    [1, 2].map((i) =>
      node({
        src: `https://site.test/p${i}.jpg`,
        text: 'x'.repeat(900),
        containerPath: `${PARENT} > figure:nth-of-type(${i})`,
      })
    ),
    { maxTextLength: 400 }
  );
  assert.equal(grouped.items[0].caption.length, 400);
});

test('whitespace is normalised, never trusted as content', () => {
  const grouped = groupGalleryItems(
    [1, 2].map((i) =>
      node({
        src: `  https://site.test/p${i}.jpg  `,
        alt: '   ',
        text: `\n\n   Film   ${i}\t\n`,
        containerPath: `${PARENT} > figure:nth-of-type(${i})`,
      })
    )
  );
  assert.equal(grouped.items[0].src, 'https://site.test/p1.jpg');
  assert.equal(grouped.items[0].alt, null, 'an all-whitespace alt is no alt');
  assert.equal(grouped.items[0].caption, 'Film 1');
});

test('the rule module still imports NOTHING', () => {
  // The property this whole file depends on, asserted rather than trusted. An import added to
  // gallery-items.mjs — a DOM shim, a helper from browser.mjs, anything at all — would re-couple
  // the judgement to whatever that pulls in, and this suite would stop being runnable in a tree
  // with no node_modules. Failing here is much louder than discovering it on a fresh clone.
  const source = readFileSync(new URL('./gallery-items.mjs', import.meta.url), 'utf8');
  assert.equal(/^\s*(?:import|export)\s.*\bfrom\b/m.test(source), false, 'gallery-items.mjs must import nothing');
  assert.equal(/\brequire\s*\(/.test(source), false);
  assert.equal(/\bimport\s*\(/.test(source), false, 'no dynamic import either');
});
