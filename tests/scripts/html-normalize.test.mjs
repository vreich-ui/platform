import assert from 'node:assert/strict';
import { test } from 'node:test';

import { normalizeAssetHashes, normalizeCssChunkStems, normalizeHtml } from '../../scripts/lib/html-normalize.mjs';

test('asset hashes collapse to HASH (single and double segment)', () => {
  assert.equal(
    normalizeAssetHashes('<link href="/_astro/about.CJx0uzRc.css" rel="stylesheet">'),
    '<link href="/_astro/about.HASH.css" rel="stylesheet">'
  );
  assert.equal(
    normalizeAssetHashes('<img src="/_astro/hero.CbOUtso8_jjwzL.webp">'),
    '<img src="/_astro/hero.HASH.webp">'
  );
});

test('two builds differing only in asset hashes normalize identically', () => {
  const a = '<script src="/_astro/page.B1a2C3d4.js"></script>';
  const b = '<script src="/_astro/page.Zz9Yy8Xx.js"></script>';
  assert.equal(normalizeHtml(a), normalizeHtml(b));
});

test('attribute order is normalized', () => {
  assert.equal(
    normalizeHtml('<a href="/x" class="btn" id="y">go</a>'),
    normalizeHtml('<a id="y" class="btn" href="/x">go</a>')
  );
});

test('whitespace runs collapse outside script/style', () => {
  assert.equal(normalizeHtml('<p>hello\n   world</p>'), normalizeHtml('<p>hello world</p>'));
});

test('a one-character text change survives normalization (is caught)', () => {
  assert.notEqual(
    normalizeHtml('<p>Five simple places to begin.</p>'),
    normalizeHtml('<p>Five simple places to begin!</p>')
  );
});

test('attribute VALUES are content — a changed href is caught', () => {
  assert.notEqual(normalizeHtml('<a href="/about">x</a>'), normalizeHtml('<a href="/about-us">x</a>'));
});

test('taxonomy term identity is a non-visual tracking annotation, not a reader-content diff', () => {
  const without = '<section class="term">content</section>';
  const withTermIdentity = '<section class="term" data-cms-term-id="t_stable_original">content</section>';
  assert.equal(normalizeHtml(without), normalizeHtml(withTermIdentity));
});

test('term-id normalization does not hide other changes on the same wrapper', () => {
  const before = '<section class="term">content</section>';
  const changed = '<section class="term changed" data-cms-term-id="t_stable_original">content</section>';
  assert.notEqual(normalizeHtml(before), normalizeHtml(changed));
});

test('shared CSS chunk stems collapse to CHUNK (a rename is not a page change)', () => {
  assert.equal(
    normalizeCssChunkStems('<link href="/_astro/privacy.HASH.css">'),
    '<link href="/_astro/CHUNK.HASH.css">'
  );
  assert.equal(
    normalizeHtml('<link href="/_astro/privacy.HASH.css" rel="stylesheet">'),
    normalizeHtml('<link href="/_astro/index.HASH.css" rel="stylesheet">')
  );
});

test('CSS stem collapse is scoped to .css — image stems still discriminate content', () => {
  // Two different images have different stems (and hashes); the stem must remain
  // a discriminator (the hash is collapsed to HASH by rule 1).
  assert.notEqual(
    normalizeHtml('<img src="/_astro/hero.HASH.webp">'),
    normalizeHtml('<img src="/_astro/bio.HASH.webp">')
  );
});

test('class-attribute VALUE order is dropped (astro-compress frequency sort)', () => {
  assert.equal(
    normalizeHtml('<div class="mx-auto max-w-4xl px-4 py-16"></div>'),
    normalizeHtml('<div class="px-4 mx-auto py-16 max-w-4xl"></div>')
  );
});

test('the class SET is still content — a changed/added/removed class is caught', () => {
  assert.notEqual(normalizeHtml('<div class="a b"></div>'), normalizeHtml('<div class="a c"></div>'));
  assert.notEqual(normalizeHtml('<div class="a b"></div>'), normalizeHtml('<div class="a b c"></div>'));
});

test('script bodies are opaque: inner HTML-in-template-literals is preserved verbatim', () => {
  const html = '<script>el.innerHTML = `<div  class="py-8">  ${x}\n</div>`;</script>';
  assert.ok(normalizeHtml(html).includes('`<div  class="py-8">  ${x}\n</div>`'));
});

test('script bodies still get asset-hash normalization', () => {
  const a = '<script>fetch("/_astro/data.Aa1Bb2Cc.js")</script>';
  const b = '<script>fetch("/_astro/data.Dd4Ee5Ff.js")</script>';
  assert.equal(normalizeHtml(a), normalizeHtml(b));
});

test('element order is content — swapped siblings are caught', () => {
  assert.notEqual(normalizeHtml('<ul><li>a</li><li>b</li></ul>'), normalizeHtml('<ul><li>b</li><li>a</li></ul>'));
});

test('comments and doctype pass through untouched', () => {
  const html = '<!DOCTYPE html><!-- keep --><div>x</div>';
  const normalized = normalizeHtml(html);
  assert.ok(normalized.includes('<!DOCTYPE html>'));
  assert.ok(normalized.includes('<!-- keep -->'));
});

test('astro-island uid values collapse (path-derived hash, W11): moves are not content changes', () => {
  const a =
    '<astro-island component-export="default" props="{}" renderer-url="/_astro/client.Aa1Bb2Cc.js" ssr uid="Z1374CN"><div>x</div></astro-island>';
  const b =
    '<astro-island component-export="default" props="{}" renderer-url="/_astro/client.Aa1Bb2Cc.js" ssr uid="ZiIM8B"><div>x</div></astro-island>';
  assert.equal(normalizeHtml(a), normalizeHtml(b));
});

test('astro-island uid normalization does NOT mask real island differences', () => {
  const a = '<astro-island ssr uid="Zaaa"><div>x</div></astro-island>';
  const changedProps = '<astro-island props=\'{"k":1}\' ssr uid="Zbbb"><div>x</div></astro-island>';
  const removed = '<div>x</div>';
  assert.notEqual(normalizeHtml(a), normalizeHtml(changedProps));
  assert.notEqual(normalizeHtml(a), normalizeHtml(removed));
  // uid on any other element is untouched (scoped to astro-island only)
  assert.notEqual(normalizeHtml('<div uid="Zaaa"></div>'), normalizeHtml('<div uid="Zbbb"></div>'));
});
