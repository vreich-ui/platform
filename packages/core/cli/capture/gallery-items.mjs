/**
 * The gallery grouping rule — the JUDGEMENT half of the crawl's repeated-figure extraction.
 *
 * THIS MODULE IMPORTS NOTHING. Not playwright, not `node:fs`, not a DOM shim — nothing. That is the
 * whole point of it existing separately from `browser.mjs`: the rule below is pure, and a pure rule
 * behind a heavy import is not actually separable. `browser.mjs`'s first line pulls in
 * playwright-core, so a test importing the rule from there could only run where a browser engine is
 * installed — the exact dependency the extraction was meant to escape. Its test runs against a tree
 * with no node_modules at all, and that is a property worth keeping: anything added here must not
 * import anything, ever.
 *
 * `browser.mjs` imports and re-exports these names; the DOM-walking shell lives there.
 */

// ─── T14.2 FAULT 3: repeated figure+caption items ────────────────────────────
//
// A gallery used to reach the mapper as a URL BAG plus one flattened string: 40 `assetUrls` and
// `"The LIttle PrincessHouse with the ghostsMio mein Mio…"` — both halves present, the pairing
// destroyed. This is the same idea as the lists/tables/quotes/q&a `extractStructure` already
// recovers (a repeated figure IS a DOM shape), and it is bounded on the same axes.
//
// THE JUDGEMENT LIVES HERE, OUT OF THE PAGE. The in-page shell only WALKS: for each image it finds
// the item container and reports a plain descriptor. Every decision — the shared-parent test, the
// caption-source precedence, the ragged-nesting refusal, the two-image threshold, the truncation
// flag — is made by the pure function below, which never touches a DOM and is therefore testable
// without a browser. This split exists because the grouping rule is the novel, load-bearing part of
// T14.2 and a repo with no DOM harness would otherwise ship it untested.

/** A repeated figure needs a repeat: one picture is a picture, not a gallery. */
export const GALLERY_MIN_ITEMS = 2;
/** Matches the other `structure` collections; a snapshot is stored, versioned and re-read. */
export const GALLERY_MAX_ITEMS = 24;
export const GALLERY_MAX_TEXT_LENGTH = 400;

const galleryClean = (value) =>
  String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Group the crawl's per-image descriptors into ordered, discrete gallery items — or refuse.
 *
 * `nodes` are plain objects produced by the DOM shell, one per image, IN DOCUMENT ORDER:
 *   `{ src, alt, text, figcaption, href, intrinsic, containerPath, parentPath }`
 * where `text` is the item container's own text, `figcaption` its `<figcaption>` (or null), and
 * `containerPath`/`parentPath` identify that container and its parent. Options: `maxItems`,
 * `minItems`, `maxTextLength`, and `sourceCount` (the true image count when the shell capped the
 * descriptor list).
 *
 * Returns `null` when there is no repeat to speak of, otherwise
 *   `{ sourceCount, items, captions: 'per_item' | 'partial' | 'unavailable', reason?, truncated? }`.
 *
 * THE PAIRING COMES FROM CONTAINMENT, NEVER FROM POSITION. An item's caption is text found INSIDE
 * that image's own subtree, so it can only ever be attached to the picture it encloses. Zipping 40
 * URLs against 20 titles by index would look right on the page that produced this defect and
 * mislabel films on the next one, so where containment yields nothing the items carry NO caption
 * and the reason travels with them.
 *
 * ALL OR NOTHING on the shape itself: descriptors spread across several parents are not one
 * recovered repeat, and keeping the largest group would silently drop the others — the exact
 * failure this function exists to prevent. Such a shape returns no items and says why.
 */
export function groupGalleryItems(nodes, options = {}) {
  const {
    maxItems = GALLERY_MAX_ITEMS,
    minItems = GALLERY_MIN_ITEMS,
    maxTextLength = GALLERY_MAX_TEXT_LENGTH,
    sourceCount,
  } = options;
  const usable = (Array.isArray(nodes) ? nodes : []).filter((node) => node && galleryClean(node.src));
  const count = Number.isInteger(sourceCount) && sourceCount > usable.length ? sourceCount : usable.length;
  if (usable.length < minItems) return null;

  const parents = new Set(usable.map((node) => node.parentPath ?? null));
  const containers = new Set(usable.map((node) => node.containerPath ?? null));
  // Two images reporting the SAME container means the walk could not separate them, so neither can
  // this: whatever text that container holds describes both or neither, and choosing is inventing.
  const reason =
    parents.size !== 1
      ? 'item_containers_do_not_share_one_parent'
      : containers.size !== usable.length
        ? 'item_containers_are_not_distinct'
        : null;
  if (reason) return { sourceCount: count, items: [], captions: 'unavailable', reason };

  const clip = (value) => galleryClean(value).slice(0, maxTextLength);
  const items = usable.slice(0, maxItems).map((node) => {
    // A <figcaption> is the author naming this figure, so it outranks the container's loose text;
    // both are inside the item, and neither is ever borrowed from a neighbour.
    const figcaption = clip(node.figcaption);
    const caption = figcaption || clip(node.text);
    return {
      src: galleryClean(node.src),
      alt: galleryClean(node.alt) || null,
      ...(caption ? { caption } : {}),
      ...(galleryClean(node.href) ? { href: galleryClean(node.href) } : {}),
      ...(node.intrinsic ? { intrinsic: node.intrinsic } : {}),
      ...(caption ? { captionSource: figcaption ? 'figcaption' : 'item_text' } : {}),
    };
  });
  const captioned = items.filter((item) => item.caption).length;
  return {
    sourceCount: count,
    items,
    // Only a genuine cap says `truncated`; a refused shape reports no items and its own reason.
    ...(count > items.length ? { truncated: true } : {}),
    ...(captioned === 0
      ? { captions: 'unavailable', reason: 'no_per_item_caption_text_in_dom' }
      : captioned < items.length
        ? { captions: 'partial' }
        : { captions: 'per_item' }),
  };
}
