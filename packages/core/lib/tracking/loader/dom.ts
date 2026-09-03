/**
 * Own-tracker loader — click classification over a MINIMAL element
 * interface (W13, 12-plan §5.1). Pure: takes the clicked element (anything
 * with closest/getAttribute/textContent/tagName/href), returns the event
 * kind + refs — so the classification matrix is unit-testable with fake
 * elements and the browser binding stays a one-liner.
 *
 * Priority (first match wins): opt-out subtree → nav → buy → term/tag →
 * outbound anchor → section CTA. Labels leave only as bounded slugs.
 */
import { hostOf, slugify, type TrackableRef } from './core.js';

export type ElementLike = {
  closest(selector: string): ElementLike | null;
  getAttribute(name: string): string | null;
  textContent: string | null;
  tagName?: string;
};

export type ClickClassification = {
  kind: 'nav_click' | 'buy_click' | 'tag_click' | 'outbound_click' | 'cta_click';
  ref: TrackableRef | null;
  props?: Record<string, unknown>;
  extraObject?: Record<string, string>;
} | null;

export const classifyClick = (target: ElementLike, pageHost: string): ClickClassification => {
  if (target.closest('[data-cms-track="off"]')) return null;

  const anchor = target.closest('a[href]');
  const label = slugify(target.textContent ?? anchor?.textContent ?? null);

  const nav = target.closest('[data-cms-nav-object]');
  if (nav) {
    const navId = nav.getAttribute('data-cms-nav-object');
    if (navId && (anchor || target.closest('button'))) {
      return {
        kind: 'nav_click',
        ref: null,
        props: label ? { label_slug: label } : undefined,
        extraObject: { object_type: 'navigation', object_id: navId },
      };
    }
  }

  const buy = target.closest('[data-cms-buy-product]');
  if (buy) {
    const productId = buy.getAttribute('data-cms-buy-product');
    if (productId) {
      return {
        kind: 'buy_click',
        ref: null,
        props: label ? { label_slug: label } : undefined,
        extraObject: { object_type: 'product', object_id: productId },
      };
    }
  }

  const term = target.closest('[data-cms-term-id]');
  if (term) {
    const termId = term.getAttribute('data-cms-term-id');
    if (termId) {
      return {
        kind: 'tag_click',
        ref: null,
        props: label ? { label_slug: label } : undefined,
        extraObject: { object_type: 'taxonomy', term_id: termId },
      };
    }
  }

  if (anchor) {
    const href = anchor.getAttribute('href') ?? '';
    const host = hostOf(href);
    if (host && host !== pageHost) {
      return { kind: 'outbound_click', ref: null, props: { href_host: host } };
    }
  }

  const section = target.closest('[data-cms-section-id]');
  if (section && (anchor || target.closest('button'))) {
    const sectionId = section.getAttribute('data-cms-section-id');
    if (sectionId) {
      return {
        kind: 'cta_click',
        ref: {
          kind: 'section',
          section_id: sectionId,
          section_type: section.getAttribute('data-cms-section-type'),
        },
        props: label ? { label_slug: label } : undefined,
      };
    }
  }

  return null;
};

/** Trackable-element discovery refs (the observer targets). */
export const trackableRefOf = (element: ElementLike): TrackableRef | null => {
  if (element.closest('[data-cms-track="off"]')) return null;
  const sectionId = element.getAttribute('data-cms-section-id');
  if (sectionId) {
    return { kind: 'section', section_id: sectionId, section_type: element.getAttribute('data-cms-section-type') };
  }
  const nodeId = element.getAttribute('data-cms-node-id');
  if (nodeId) {
    return { kind: 'node', node_id: nodeId, node_kind: element.getAttribute('data-cms-node-kind') };
  }
  return null;
};

/**
 * Resolve a trackable ref for an OBSERVED element that may not be the marker
 * itself (T21.9): the observer watches the first box-generating descendant of
 * a `display:contents` marker, not the marker, so the callback target's own
 * attributes are meaningless. `closest` walks back up to the nearest marker
 * (correctly landing on a NODE marker nested inside a SECTION marker) and
 * `trackableRefOf` reads its identity the normal way — reuse, not a new path.
 */
export const trackableRefOfClosest = (element: ElementLike): TrackableRef | null => {
  const marker = element.closest('[data-cms-section-id],[data-cms-node-id]');
  return marker ? trackableRefOf(marker) : null;
};

/** Element shape needed to walk into a `display:contents` marker's subtree. */
export type BoxElementLike = ElementLike & {
  children?: ArrayLike<BoxElementLike>;
  getClientRects?: () => ArrayLike<unknown>;
};

/**
 * True when `element` generates at least one CSS box (`getBoundingClientRect`-
 * style geometry). `display:contents` (and `display:none`, and a detached
 * node) produce zero client rects — the honest, layout-agnostic test, unlike
 * `getComputedStyle` which a DOM stub in tests won't implement at all. When
 * the environment doesn't implement `getClientRects` (some stubs, and any
 * element that isn't a real box-model-capable Element), assume it generates a
 * box — that preserves "observe the marker itself" for every caller that
 * doesn't model layout.
 */
export const generatesBox = (element: BoxElementLike): boolean => {
  if (typeof element.getClientRects !== 'function') return true;
  try {
    return element.getClientRects().length > 0;
  } catch {
    return true;
  }
};

/**
 * Resolve the element the IntersectionObserver should actually watch for a
 * given CMS marker (T21.9): the marker itself if it generates a box
 * (unchanged behaviour for any marker that isn't `display:contents`),
 * otherwise the FIRST element child, depth-first, that generates a box —
 * descending through any boxless child in between. Returns null when nothing
 * in the marker's subtree generates a box (nothing to observe; skip it).
 * Exactly one element is ever returned per marker, so `impressed`/
 * `dwellStart`/`dwellAcc` in core.ts (keyed per ref) never double-count.
 */
export const resolveObservationTarget = (marker: BoxElementLike): BoxElementLike | null => {
  if (generatesBox(marker)) return marker;
  const children = marker.children;
  if (!children) return null;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (!child) continue;
    const resolved = resolveObservationTarget(child);
    if (resolved) return resolved;
  }
  return null;
};
