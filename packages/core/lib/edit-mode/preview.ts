/**
 * Edit-mode canvas — conservative in-place preview.
 *
 * After Ask-AI proposes a change, the canvas shows it IN the page by swapping
 * the old value for the new one inside the annotated region — visibly draft
 * (amber frame), never persisted by this module. The swap is deliberately
 * conservative: a field is previewed only when its current value can be
 * located in the region unambiguously; anything else stays visually unchanged
 * and the panel's field-diff remains the truthful record. Restoring is a
 * whole-region innerHTML snapshot, so Discard is always exact.
 *
 * Rich-text matching reuses the REAL splitters (src/lib/richtext/paragraphs)
 * so block boundaries here can never drift from what the build renders —
 * the same never-a-reimplementation rule the validator follows.
 *
 * Sanitizing: previewed HTML passes the same 10-tag allowlist the admin
 * editor and validator enforce. This guards only the admin's own viewport —
 * the server-side validator at patch time is the real gate.
 */
import { splitRichTextBlocks, splitRichTextParagraphs, type RichTextBlock } from '../../lib/richtext/paragraphs.js';

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h2', 'h3']);

/** Strip tags from a rich-text block to its comparable text. Pure. */
export const blockText = (html: string): string =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Split a rich-text field into blocks, tolerating paragraph-only fields. Pure. */
export const richTextToBlocks = (richText: string): RichTextBlock[] | undefined => {
  try {
    return splitRichTextBlocks(richText);
  } catch {
    try {
      return splitRichTextParagraphs(richText).map((html) => ({ tag: 'p' as const, html }));
    } catch {
      return undefined;
    }
  }
};

const sanitizeInto = (source: ParentNode, destination: Element | DocumentFragment): void => {
  for (const child of Array.from(source.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      destination.append(document.createTextNode(child.textContent ?? ''));
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) continue;
    const element = child as Element;
    const tag = element.tagName.toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) {
      sanitizeInto(element, destination); // unwrap unknown tags, keep their text
      continue;
    }
    const out = document.createElement(tag);
    if (tag === 'a') {
      const href = element.getAttribute('href') ?? '';
      if (/^https?:\/\//i.test(href) || href.startsWith('/')) out.setAttribute('href', href);
      out.setAttribute('rel', 'noopener');
    }
    sanitizeInto(element, out);
    destination.append(out);
  }
};

/** Sanitize a rich-text HTML string to the allowlist; returns a fragment. */
export const sanitizeRichTextFragment = (html: string): DocumentFragment => {
  const template = document.createElement('template');
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();
  sanitizeInto(template.content, fragment);
  return fragment;
};

export type RegionSnapshot = { region: HTMLElement; html: string };

export const snapshotRegion = (region: HTMLElement): RegionSnapshot => ({ region, html: region.innerHTML });

export const restoreRegion = (snapshot: RegionSnapshot): void => {
  snapshot.region.innerHTML = snapshot.html;
};

const normalizeText = (value: string): string => value.replace(/\s+/g, ' ').trim();

/**
 * The deepest element whose text content equals `text` (normalized), or
 * undefined. Shared with the inline editor (T17.8 fix 2), which mounts its
 * surface over exactly the element this finds — there is one lookup for
 * "which element renders this value", never two that can drift.
 */
export const findElementByText = (region: HTMLElement, text: string): HTMLElement | undefined => {
  const wanted = normalizeText(text);
  if (!wanted) return undefined;
  let match: HTMLElement | undefined;
  const walker = document.createTreeWalker(region, NodeFilter.SHOW_ELEMENT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const element = node as HTMLElement;
    if (normalizeText(element.textContent ?? '') === wanted) match = element; // keep walking: deepest wins
  }
  return match;
};

/**
 * The elements rendering each of `texts`, in order — or undefined when any is
 * missing or two texts resolve to the same element (an ambiguous match is not
 * a match). The one multi-block locator: the rich-text preview below and the
 * inline editor's mount both go through it.
 */
export const findBlockElements = (region: HTMLElement, texts: string[]): HTMLElement[] | undefined => {
  if (texts.length === 0) return undefined;
  const found: HTMLElement[] = [];
  for (const text of texts) {
    const element = findElementByText(region, text);
    if (!element || found.includes(element)) return undefined;
    found.push(element);
  }
  return found;
};

/** Preview a plain-string change: swap the element whose text is exactly `before`. */
const previewStringChange = (region: HTMLElement, before: string, after: string): boolean => {
  const element = findElementByText(region, before);
  if (!element) return false;
  element.textContent = after;
  return true;
};

/**
 * Preview a rich-text change: locate the elements rendering each CURRENT
 * block (matched by text, in order) and replace their contents with the
 * proposed blocks. Only previews when old and new block counts match and
 * every old block is found — structural rewrites fall back to the panel diff.
 */
const previewRichTextChange = (region: HTMLElement, before: string, after: string): boolean => {
  const beforeBlocks = richTextToBlocks(before);
  const afterBlocks = richTextToBlocks(after);
  if (!beforeBlocks || !afterBlocks || beforeBlocks.length === 0) return false;
  if (beforeBlocks.length !== afterBlocks.length) return false;

  const targets = findBlockElements(
    region,
    beforeBlocks.map((block) => blockText(block.html))
  );
  if (!targets) return false;
  targets.forEach((element, index) => {
    element.replaceChildren(sanitizeRichTextFragment(afterBlocks[index].html));
  });
  return true;
};

/**
 * Apply one field's proposed change to the region. Returns true when the
 * change is now visible in place; false means "not previewable here" (the
 * panel diff still shows it, and Accept still patches it).
 */
export const previewFieldChange = (
  region: HTMLElement,
  kind: 'html' | 'string' | 'json',
  before: unknown,
  after: unknown
): boolean => {
  if (typeof before !== 'string' || typeof after !== 'string') return false;
  if (kind === 'string') return previewStringChange(region, before, after);
  if (kind === 'html') return previewRichTextChange(region, before, after);
  return false;
};
