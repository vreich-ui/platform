/**
 * HTML normalization for the build-diff harness (T2.0).
 *
 * Two builds of the "same" site are compared only after both sides pass
 * through `normalizeHtml`, which removes exactly the classes of difference
 * that carry no content meaning (04-phased-plan Part 2 point 3):
 *
 *   1. hashed asset names — `/_astro/<name>.<hash>.<ext>` (and the image
 *      service's `<hash>_<hash>` double segment) become `<name>.HASH.<ext>`,
 *      so an unrelated chunk-hash shift never reads as a page change;
 *   2. shared CSS chunk stems — `/_astro/<stem>.HASH.css` becomes
 *      `/_astro/CHUNK.HASH.css`. Astro assigns a shared CSS chunk an arbitrary
 *      page-derived NAME (e.g. `privacy` vs `index`); adding one component
 *      re-attributes that chunk and renames it site-wide though the CSS is
 *      byte-identical. The name carries no content meaning. Scoped to `.css`
 *      only — image stems (webp/png/…) stay the discriminator for content
 *      assets, since their hash is collapsed by rule 1;
 *   3. attribute order — attributes are sorted per tag;
 *   4. class-attribute VALUE order — the space-separated classes inside a
 *      `class="…"` are sorted. Class order in an HTML attribute has zero
 *      rendering effect (CSS cascade is by rule order, never attribute order),
 *      yet astro-compress reorders it by site-wide class frequency, so any new
 *      component shifts it everywhere. The class SET is still content — a
 *      changed/added/removed class fails the diff; only the order is dropped;
 *   5. whitespace — runs collapse to a single space outside <script>/<style>;
 *   6. Astro scoped-style ids — `data-astro-cid-<hash>` is derived from the
 *      component's FILE PATH (the attribute twin of rule 1's chunk hashes) and
 *      moves in lockstep with the CSS selector that matches it, so relocating a
 *      component changes it site-wide with zero rendered difference;
 *   7. taxonomy tracking identity — `data-cms-term-id` is a non-visual loader
 *      annotation. Its behavior is guarded by the tracking route/loader tests,
 *      while this harness remains a comparison of reader-visible content.
 *
 * <script> and <style> contents are treated as opaque (inline scripts on this
 * site legitimately contain `<div …>` template-literal HTML that a naive tag
 * tokenizer would mangle); only the asset rewrites (rules 1–2) apply inside them.
 *
 * Anything else — text, tag names, non-class attribute values, the class SET,
 * element order — is content and is deliberately left alone: a difference there
 * MUST fail the diff. The rules here are the ceiling of allowed variance, not a
 * place to hide inconvenient diffs; each drops a difference provably invisible
 * to a reader (a renamed chunk file, a reordered class list).
 */

// Astro emits 8-char base64url content hashes; the image service appends a
// second short segment (e.g. `hero.CbOUtso8_jjwzL.webp`). Both collapse to HASH.
const ASTRO_ASSET_RE = /(\/_astro\/[^\s"'()<>]*?)\.([A-Za-z0-9_-]{8,12}(?:_[A-Za-z0-9_-]{1,12})?)\.([A-Za-z0-9]+)/g;

export const normalizeAssetHashes = (html) =>
  html.replace(ASTRO_ASSET_RE, (_m, base, _hash, ext) => `${base}.HASH.${ext}`);

// After hashes collapse, a shared CSS chunk's arbitrary stem is the only
// remaining volatile part of its name; drop it too (css only — see rule 2).
const CSS_CHUNK_STEM_RE = /(\/_astro\/)[A-Za-z0-9_-]+(\.HASH\.css)/g;

export const normalizeCssChunkStems = (html) => html.replace(CSS_CHUNK_STEM_RE, '$1CHUNK$2');

// Astro island `uid` attributes are content hashes OF THE COMPONENT'S FILE
// PATH (the attribute-level twin of the hashed chunk filenames above): they
// pair an <astro-island> element with its hydration entry within one page and
// change whenever a component file MOVES, with zero rendered/behavioral
// difference. Collapse them so file relocations (W11 core extraction) don't
// read as content changes — a real island add/remove/reorder still differs
// structurally. Scoped to the astro-island tag; nothing else carries uid=.
const ASTRO_ISLAND_UID_RE = /(<astro-island\b[^>]*?\buid=)(["']?)[A-Za-z0-9]+\2/g;

export const normalizeIslandUids = (html) => html.replace(ASTRO_ISLAND_UID_RE, (_m, pre, q) => `${pre}${q}UID${q}`);

// Astro's scoped-style ids are the same class of path-derived hash as the
// island uids above: `data-astro-cid-<hash>` is computed from the COMPONENT'S
// FILE PATH, stamped on every element that component renders, and matched by
// the `[data-astro-cid-<hash>]` selectors in the emitted CSS. Moving a
// component file rewrites the hash on both sides in lockstep — the rendered
// result is identical to the byte. W14 T14.1 moved the whole shell into
// `packages/core/app`, which changed the id on 73 of 74 pages and nothing else.
// Collapse it so a relocation does not read as a content change.
//
// Residual risk, stated plainly and identical to the island-uid rule's: if one
// component were swapped for a DIFFERENT component emitting the same markup and
// class set but different scoped CSS, this would hide it. Structure, text, and
// the class set all still fail the diff, so that case is narrow and contrived.
const ASTRO_SCOPED_ID_RE = /\bdata-astro-cid-[A-Za-z0-9_-]+/g;

export const normalizeScopedStyleIds = (html) => html.replace(ASTRO_SCOPED_ID_RE, 'data-astro-cid-CID');

// Attribute grammar: name, optionally =value (double-, single-, or unquoted).
const ATTR_RE = /([^\s"'>/=]+)(\s*=\s*("[^"]*"|'[^']*'|[^\s>]+))?/g;

// Sort the space-separated values of a `class="…"` attribute string (rule 4).
// Order-only: the class set is preserved, so a set change still differs.
const CLASS_ATTR_RE = /^class=(["'])([\s\S]*)\1$/;
const sortClassAttribute = (attrStr) => {
  const match = attrStr.match(CLASS_ATTR_RE);
  if (!match) return attrStr;
  const [, quote, value] = match;
  const sorted = value.split(/\s+/).filter(Boolean).sort().join(' ');
  return `class=${quote}${sorted}${quote}`;
};

const sortTagAttributes = (tag) => {
  // Leave closers, comments, doctype, and CDATA alone.
  if (/^<[/!]/.test(tag)) return tag;
  const match = tag.match(/^<([a-zA-Z][^\s/>]*)([\s\S]*?)(\/?)>$/);
  if (!match) return tag;
  const [, name, rawAttrs, selfClose] = match;
  const attrs = [];
  for (const attr of rawAttrs.matchAll(ATTR_RE)) {
    if (attr[1] === 'data-cms-term-id') continue;
    attrs.push(sortClassAttribute(`${attr[1]}${attr[2] ? `=${attr[3]}` : ''}`));
  }
  attrs.sort();
  const attrText = attrs.length ? ` ${attrs.join(' ')}` : '';
  return `<${name}${attrText}${selfClose ? ' /' : ''}>`;
};

const collapseWhitespace = (text) => text.replace(/\s+/g, ' ');

// Split the document into opaque (<script>/<style> elements, comments) and
// normal segments; tags inside opaque segments are never re-tokenized.
const SEGMENT_RE = /(<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->)/gi;
// Within a normal segment: a tag token, or a text run.
const TOKEN_RE = /(<[^>]*>)|([^<]+)/g;

export const normalizeHtml = (html) => {
  const withStableAssets = normalizeScopedStyleIds(
    normalizeIslandUids(normalizeCssChunkStems(normalizeAssetHashes(html)))
  );
  const out = [];
  const segments = withStableAssets.split(SEGMENT_RE);
  for (const segment of segments) {
    if (segment === undefined || segment === '') continue;
    if (/^<script\b/i.test(segment) || /^<style\b/i.test(segment) || segment.startsWith('<!--')) {
      out.push(segment); // opaque: asset names already normalized above
      continue;
    }
    for (const token of segment.matchAll(TOKEN_RE)) {
      if (token[1]) out.push(sortTagAttributes(token[1]));
      else out.push(collapseWhitespace(token[2]));
    }
  }
  return out.join('').trim();
};
