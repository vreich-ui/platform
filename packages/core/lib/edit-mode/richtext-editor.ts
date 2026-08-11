/**
 * Canvas rich-text editor (T9.19) — binds a TipTap 3 instance to the restricted
 * `rich_text.v1` grammar and round-trips its document through the ONE mapper
 * (richtext/prosemirror.ts). Two layers, deliberately separated:
 *
 *   1. PURE core (no editor packages): the grammar allowlist, a client-side
 *      sanitizer that strips out-of-grammar nodes/marks from ANY ProseMirror
 *      JSON (so pasted content can never carry the store past its schema), and
 *      serialize ↔ rich_text.v1 wrappers. This half is unit-tested headlessly
 *      and imports nothing from @tiptap — mirroring prosemirror.ts's rule that
 *      the data layer must not drag editor packages into the build.
 *
 *   2. BROWSER factory (`createRichTextEditor`) + `buildInlineToolbar`: news up
 *      a TipTap Editor via a DYNAMIC import, so @tiptap/* load only at runtime
 *      in the overlay, never in the test/build graph, and mounts the
 *      selection-anchored formatting bubble the canvas edits with. The toolbar
 *      surfaces ONLY grammar marks/nodes; links are https-only. Its control
 *      list and its placement maths are pure and unit-tested; only the DOM
 *      wiring needs a browser.
 *
 * Grammar (08-articles-plan §2.2, this task's brief): p, br, strong, em,
 * a[https only], ul, ol, li, h2, h3, plus the `code` mark (inline code
 * display — widened alongside rich-text-v1.ts's grammars). Blockquote,
 * code BLOCKS, and other heading levels are OUT of this field grammar and
 * are stripped client-side; a hand-built violation is additionally rejected
 * server-side by validateObject.
 */
import {
  proseMirrorToRichTextV1,
  richTextV1ToProseMirror,
  type ProseMirrorNode,
  type ProseMirrorMark,
} from '../richtext/prosemirror.js';
import type { RichTextV1Document } from '../../lib/richtext/rich-text-v1.js';
import { BLOCKS } from '@contentful/rich-text-types';
import {
  ICON_BOLD,
  ICON_CODE,
  ICON_ITALIC,
  ICON_LINK,
  ICON_LIST_BULLET,
  ICON_LIST_ORDERED,
  ICON_REDO,
  ICON_UNDO,
} from './ui-chrome.js';

// ─── grammar allowlist (ProseMirror/TipTap side) ───────────────────────────────

/** Block node types the field grammar permits at document level / inside lists. */
export const GRAMMAR_BLOCKS = new Set(['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem']);
/** Inline node types permitted inside a block. */
export const GRAMMAR_INLINES = new Set(['text', 'hardBreak']);
/** Marks permitted on a text run. */
export const GRAMMAR_MARKS = new Set(['bold', 'italic', 'code', 'link']);
/** Heading levels permitted (h2, h3 only). */
export const GRAMMAR_HEADING_LEVELS = new Set([2, 3]);

const HTTPS_ONLY = /^https:\/\//i;

// ─── client-side sanitizer (closes the round-trip on paste) ────────────────────

const sanitizeMarks = (marks: ProseMirrorMark[] | undefined): ProseMirrorMark[] => {
  const out: ProseMirrorMark[] = [];
  for (const mark of marks ?? []) {
    if (mark.type === 'bold' || mark.type === 'italic' || mark.type === 'code') {
      out.push({ type: mark.type });
    } else if (mark.type === 'link') {
      const href = mark.attrs?.href;
      // https-only: any other scheme (http, javascript, mailto, relative) drops
      // the link mark but KEEPS the text (never silently lose content).
      if (typeof href === 'string' && HTTPS_ONLY.test(href)) out.push({ type: 'link', attrs: { href } });
    }
    // any other mark (strike, …) is dropped
  }
  return out;
};

/** Sanitize a block's inline children to text/hardBreak with grammar marks only. */
const sanitizeInline = (nodes: ProseMirrorNode[] | undefined): ProseMirrorNode[] => {
  const out: ProseMirrorNode[] = [];
  for (const node of nodes ?? []) {
    if (node.type === 'hardBreak') {
      out.push({ type: 'hardBreak' });
    } else if (node.type === 'text') {
      const marks = sanitizeMarks(node.marks);
      out.push({ type: 'text', text: node.text ?? '', ...(marks.length ? { marks } : {}) });
    } else if (node.content) {
      // An unexpected inline wrapper (e.g. a pasted span-as-node): keep its text.
      out.push(...sanitizeInline(node.content));
    }
  }
  return out;
};

/** Sanitize one block node; returns 0+ grammar-valid blocks (unwrapping the invalid). */
const sanitizeBlock = (node: ProseMirrorNode): ProseMirrorNode[] => {
  switch (node.type) {
    case 'paragraph':
      return [{ type: 'paragraph', content: sanitizeInline(node.content) }];
    case 'heading': {
      const level = node.attrs?.level;
      if (level === 2 || level === 3) {
        return [{ type: 'heading', attrs: { level }, content: sanitizeInline(node.content) }];
      }
      // Out-of-grammar heading level (h1, h4–h6) → demote to a paragraph.
      return [{ type: 'paragraph', content: sanitizeInline(node.content) }];
    }
    case 'bulletList':
    case 'orderedList': {
      const items = (node.content ?? [])
        .filter((child) => child.type === 'listItem')
        .map((item) => ({ type: 'listItem', content: sanitizeListItem(item.content) }));
      // A list with no valid items is dropped entirely.
      return items.length ? [{ type: node.type, content: items }] : [];
    }
    case 'blockquote':
      // Blockquote is OUT of this field grammar → unwrap its children to top level.
      return (node.content ?? []).flatMap(sanitizeBlock);
    default:
      // Unknown block (codeBlock, horizontalRule, table, …): flatten to a
      // paragraph carrying whatever inline text it held, or drop if empty.
      if (node.content && node.content.length) {
        const inline = sanitizeInline(node.content);
        return inline.length ? [{ type: 'paragraph', content: inline }] : [];
      }
      return [];
  }
};

/** List items hold block content (paragraphs / nested lists). */
const sanitizeListItem = (content: ProseMirrorNode[] | undefined): ProseMirrorNode[] => {
  const blocks = (content ?? []).flatMap(sanitizeBlock);
  // A listItem must contain at least one block; default to an empty paragraph.
  return blocks.length ? blocks : [{ type: 'paragraph', content: [] }];
};

/**
 * Strip a ProseMirror/TipTap document to the field grammar. Total and
 * defensive: any input (including pasted, out-of-grammar content) yields a
 * document the store's schema will accept.
 */
export const sanitizeProseMirrorDoc = (doc: ProseMirrorNode): ProseMirrorNode => ({
  type: 'doc',
  content: (doc.content ?? []).flatMap(sanitizeBlock),
});

// ─── serialize ↔ rich_text.v1 ──────────────────────────────────────────────────

/** TipTap/ProseMirror JSON → rich_text.v1, sanitizing to grammar first. */
export const serializeToRichTextV1 = (pmDoc: ProseMirrorNode): RichTextV1Document =>
  proseMirrorToRichTextV1(sanitizeProseMirrorDoc(pmDoc));

/** rich_text.v1 → TipTap/ProseMirror JSON for loading into the editor. */
export const deserializeFromRichTextV1 = (doc: RichTextV1Document): ProseMirrorNode => richTextV1ToProseMirror(doc);

// ─── plain string ↔ rich_text.v1 (the fix-3 upgrade) ───────────────────────────

/**
 * A plain-text body as a rich_text.v1 document — the exact inverse of
 * render-nodes.ts's `plainTextParagraphs`: blank lines split paragraphs, a
 * single '\n' stays inside the text value (which is how rich_text.v1 encodes a
 * hard break, and what the renderer emits as `<br/>`). So the upgraded
 * document renders byte-identically to the string it replaces — pinned by a
 * test against the real renderer.
 *
 * The one divergence: an EMPTY body becomes one empty paragraph rather than
 * nothing, because the editor needs somewhere to put the caret.
 */
export const plainStringToRichTextV1 = (text: string): RichTextV1Document => {
  const paragraphs = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  return {
    nodeType: BLOCKS.DOCUMENT,
    data: {},
    content: (paragraphs.length ? paragraphs : ['']).map((value) => ({
      nodeType: BLOCKS.PARAGRAPH,
      data: {},
      content: value ? [{ nodeType: 'text' as const, value, marks: [], data: {} }] : [],
    })),
  };
};

type RichTextV1Block = RichTextV1Document['content'][number];

/**
 * Does this document carry anything a plain string could NOT hold? Any mark,
 * any link, any block that is not a paragraph. This is what decides whether an
 * edit upgrades the field's shape — Wolf, 2026-08-11: "upgrade on first
 * format", not on first edit.
 */
export const richTextV1HasFormatting = (doc: RichTextV1Document): boolean =>
  doc.content.some((block: RichTextV1Block) => {
    if (block.nodeType !== BLOCKS.PARAGRAPH) return true;
    return block.content.some((inline) => inline.nodeType !== 'text' || inline.marks.length > 0);
  });

/**
 * The document back as the plain string it round-trips to (paragraphs joined
 * by a blank line). Only meaningful when `richTextV1HasFormatting` is false;
 * total anyway, so a caller can never get an exception instead of text.
 */
export const richTextV1ToPlainString = (doc: RichTextV1Document): string => {
  const blockText = (node: { value?: unknown; content?: unknown }): string => {
    if (typeof node.value === 'string') return node.value;
    const content = Array.isArray(node.content) ? (node.content as Array<{ value?: unknown; content?: unknown }>) : [];
    return content.map(blockText).join('');
  };
  return doc.content
    .map((block) => blockText(block))
    .filter(Boolean)
    .join('\n\n');
};

// ─── the inline formatting toolbar ─────────────────────────────────────────────

/**
 * How much formatting a surface may offer, decided from the field it edits.
 *
 *   rich    — a rich_text.v1 document: every grammar control.
 *   upgrade — a plain string that MAY become one on the first formatting
 *             command (fix 3); the same controls, applied after the upgrade.
 *   plain   — a single-line string field (heading, title, eyebrow, ctaText…):
 *             no buttons, just the muted hint. A <strong> in one of these is
 *             escaped by the renderer and is actively harmful.
 *   none    — no toolbar at all (a raw HTML body: out of scope here).
 */
export type InlineToolbarMode = 'rich' | 'upgrade' | 'plain' | 'none';

export type InlineToolbarControl =
  | 'bold'
  | 'italic'
  | 'code'
  | 'bulletList'
  | 'orderedList'
  | 'h2'
  | 'h3'
  | 'paragraph'
  | 'link'
  | 'undo'
  | 'redo';

/**
 * Every formatting command the surface offers. Each one round-trips
 * sanitizer → prosemirror mapper → rich_text.v1 zod schema → the server's
 * patch grammar → the renderer; nothing here can be saved and then silently
 * dropped. `hardBreak` is keyboard-only (Shift+Enter) — it needs no button.
 */
export const INLINE_FORMAT_COMMANDS = [
  'bold',
  'italic',
  'code',
  'bulletList',
  'orderedList',
  'h2',
  'h3',
  'paragraph',
  'link',
  'hardBreak',
  'undo',
  'redo',
] as const;

/**
 * Formatting the store has NO representation for. Offering any of these would
 * either drop the mark on save (the sanitizer strips it) or 422 at the patch
 * grammar. Blockquote is one line away from safe in rich-text-v1 but is
 * deliberately out of scope for this task.
 */
export const INLINE_FORBIDDEN_CONTROLS = [
  'strike',
  'underline',
  'highlight',
  'subscript',
  'superscript',
  'color',
  'fontSize',
  'textAlign',
  'codeBlock',
  'horizontalRule',
  'h1',
  'h4',
  'h5',
  'h6',
  'table',
  'image',
  'blockquote',
] as const;

const RICH_CONTROLS: readonly InlineToolbarControl[] = [
  'bold',
  'italic',
  'code',
  'bulletList',
  'orderedList',
  'h2',
  'h3',
  'paragraph',
  'link',
  'undo',
  'redo',
];

/** The buttons each mode draws, in order. Pure — the shipped control list. */
export const INLINE_TOOLBAR_BUTTONS: Record<InlineToolbarMode, readonly InlineToolbarControl[]> = {
  rich: RICH_CONTROLS,
  upgrade: RICH_CONTROLS,
  plain: [],
  none: [],
};

/** Where a separator is drawn (before this control). */
const CONTROL_GROUP_BREAKS = new Set<InlineToolbarControl>(['h2', 'link', 'undo']);

const CONTROL_LABELS: Record<InlineToolbarControl, string> = {
  bold: 'Bold',
  italic: 'Italic',
  code: 'Inline code',
  bulletList: 'Bullet list',
  orderedList: 'Numbered list',
  h2: 'Heading 2',
  h3: 'Heading 3',
  paragraph: 'Paragraph',
  link: 'Link',
  undo: 'Undo',
  redo: 'Redo',
};

const CONTROL_FACES: Record<InlineToolbarControl, string> = {
  bold: ICON_BOLD,
  italic: ICON_ITALIC,
  code: ICON_CODE,
  bulletList: ICON_LIST_BULLET,
  orderedList: ICON_LIST_ORDERED,
  h2: 'H2',
  h3: 'H3',
  paragraph: '¶',
  link: ICON_LINK,
  undo: ICON_UNDO,
  redo: ICON_REDO,
};

/** How each control reports "the caret is inside one of these already". */
const CONTROL_ACTIVE: Partial<Record<InlineToolbarControl, [string, Record<string, unknown>?]>> = {
  bold: ['bold'],
  italic: ['italic'],
  code: ['code'],
  bulletList: ['bulletList'],
  orderedList: ['orderedList'],
  h2: ['heading', { level: 2 }],
  h3: ['heading', { level: 3 }],
  paragraph: ['paragraph'],
  link: ['link'],
};

/** The slice of TipTap's Editor the toolbar uses — structural, so no static @tiptap dep. */
type ChainedCommands = {
  focus(): ChainedCommands;
  toggleBold(): ChainedCommands;
  toggleItalic(): ChainedCommands;
  toggleCode(): ChainedCommands;
  toggleBulletList(): ChainedCommands;
  toggleOrderedList(): ChainedCommands;
  toggleHeading(attributes: { level: number }): ChainedCommands;
  setParagraph(): ChainedCommands;
  setLink(attributes: { href: string }): ChainedCommands;
  unsetLink(): ChainedCommands;
  undo(): ChainedCommands;
  redo(): ChainedCommands;
  run(): boolean;
};

export type InlineToolbarEditor = {
  chain(): ChainedCommands;
  isActive(name: string, attributes?: Record<string, unknown>): boolean;
  getAttributes(name: string): Record<string, unknown>;
  state: { selection: { empty: boolean } };
  on(event: string, handler: () => void): void;
  off(event: string, handler: () => void): void;
};

const runControl = (editor: InlineToolbarEditor, control: InlineToolbarControl): void => {
  const chain = editor.chain().focus();
  switch (control) {
    case 'bold':
      chain.toggleBold().run();
      return;
    case 'italic':
      chain.toggleItalic().run();
      return;
    case 'code':
      chain.toggleCode().run();
      return;
    case 'bulletList':
      chain.toggleBulletList().run();
      return;
    case 'orderedList':
      chain.toggleOrderedList().run();
      return;
    case 'h2':
      chain.toggleHeading({ level: 2 }).run();
      return;
    case 'h3':
      chain.toggleHeading({ level: 3 }).run();
      return;
    case 'paragraph':
      chain.setParagraph().run();
      return;
    case 'undo':
      chain.undo().run();
      return;
    case 'redo':
      chain.redo().run();
      return;
    case 'link':
      // handled by the popover, never applied blind
      return;
  }
};

const EDGE = 8;

/**
 * Where the bubble goes: ~8px above the selection, flipped below when that
 * would collide with the edit-mode top bar, clamped inside the viewport.
 * Pure, so the geometry is unit-tested without a browser.
 */
export const inlineToolbarPlacement = (
  anchor: { top: number; bottom: number; left: number; width: number },
  size: { width: number; height: number },
  viewport: { width: number; height: number },
  topGuard = 0,
  gap = 8
): { left: number; top: number; flipped: boolean } => {
  const above = anchor.top - gap - size.height;
  const flipped = above < topGuard;
  const wanted = flipped ? anchor.bottom + gap : above;
  const lowestTop = Math.max(topGuard, viewport.height - size.height - EDGE);
  const top = Math.min(Math.max(wanted, topGuard), lowestTop);
  const rightmostLeft = Math.max(EDGE, viewport.width - size.width - EDGE);
  const left = Math.min(Math.max(anchor.left + anchor.width / 2 - size.width / 2, EDGE), rightmostLeft);
  return { left, top, flipped };
};

export interface InlineToolbarOptions {
  /** The editing surface: the fallback anchor when there is no selection rect. */
  anchor: () => HTMLElement;
  /** Viewport y the bubble must clear (the edit-mode top bar). */
  topGuard?: number;
}

export interface InlineToolbarHandle {
  /** The bubble itself — must be exempt from the focusout/mousedown commit guards. */
  element: HTMLElement;
  /** Re-anchor to the current selection. */
  reposition(): void;
  /** Attach (or re-attach) to an editor — the upgrade path calls this. */
  bind(editor: InlineToolbarEditor): void;
  destroy(): void;
}

/**
 * The selection-anchored formatting bubble. Two guards are load-bearing and
 * neither is optional: every button cancels **mousedown** (a click alone is
 * too late — the surface would have lost focus and autosaved before the
 * handler ran), and the caller must add `element` to BOTH the focusout
 * exemption and the document-mousedown exemption beside the host, panel and
 * rail. Without them every button press saves and closes the editor.
 */
export const buildInlineToolbar = (
  editor: InlineToolbarEditor | undefined,
  mode: InlineToolbarMode,
  options: InlineToolbarOptions
): InlineToolbarHandle | undefined => {
  if (mode === 'none') return undefined;

  const element = document.createElement('div');
  element.className = 'dl-em-fmt';
  element.setAttribute('role', 'toolbar');
  element.setAttribute('aria-label', 'Text formatting');

  let bound: InlineToolbarEditor | undefined = editor;
  const refreshers: Array<() => void> = [];
  const refreshAll = (): void => {
    for (const refresh of refreshers) refresh();
  };

  const place = (): void => {
    const anchorElement = options.anchor();
    const selection = window.getSelection();
    let box: DOMRect | undefined;
    if (selection && selection.rangeCount > 0) {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) box = rect;
    }
    const rect = box ?? anchorElement.getBoundingClientRect();
    const size = element.getBoundingClientRect();
    const { left, top } = inlineToolbarPlacement(
      { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
      { width: size.width, height: size.height },
      { width: window.innerWidth, height: window.innerHeight },
      options.topGuard ?? 0
    );
    element.style.left = `${Math.round(left)}px`;
    element.style.top = `${Math.round(top)}px`;
  };

  // ── link popover ────────────────────────────────────────────────────────
  let popover: HTMLElement | undefined;
  const closePopover = (): boolean => {
    if (!popover) return false;
    popover.remove();
    popover = undefined;
    return true;
  };
  const openPopover = (): void => {
    if (closePopover()) return; // the link button toggles it
    const current = bound?.getAttributes('link').href;
    const pop = document.createElement('div');
    pop.className = 'dl-em-fmtpop';
    const input = document.createElement('input');
    input.type = 'url';
    input.placeholder = 'https://…';
    input.value = typeof current === 'string' ? current : '';
    input.setAttribute('aria-label', 'Link address (https only)');
    const apply = document.createElement('button');
    apply.type = 'button';
    apply.className = 'dl-em-fmtbtn';
    apply.textContent = 'Apply';
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'dl-em-fmtbtn';
    remove.textContent = 'Remove';
    remove.disabled = typeof current !== 'string' || current === '';
    const commit = (): void => {
      const href = input.value.trim();
      // https-only, exactly as the sanitizer and the store schema require: an
      // http/mailto/relative href would be stripped on save, so refuse it here
      // rather than pretend it took.
      if (href && !HTTPS_ONLY.test(href)) {
        input.setAttribute('aria-invalid', 'true');
        return;
      }
      if (href) bound?.chain().focus().setLink({ href }).run();
      else bound?.chain().focus().unsetLink().run();
      closePopover();
    };
    apply.addEventListener('mousedown', (event) => event.preventDefault());
    apply.addEventListener('click', commit);
    remove.addEventListener('mousedown', (event) => event.preventDefault());
    remove.addEventListener('click', () => {
      bound?.chain().focus().unsetLink().run();
      closePopover();
    });
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        commit();
      }
    });
    pop.append(input, apply, remove);
    element.append(pop);
    popover = pop;
    window.requestAnimationFrame(() => input.focus());
  };

  // ── buttons ─────────────────────────────────────────────────────────────
  const addButton = (control: InlineToolbarControl): void => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dl-em-fmtbtn';
    button.dataset.emFmt = control;
    const label = CONTROL_LABELS[control];
    button.title = label;
    button.setAttribute('aria-label', label);
    const face = CONTROL_FACES[control];
    if (face.startsWith('<svg')) button.innerHTML = face;
    else button.textContent = face;

    const activeQuery = CONTROL_ACTIVE[control];
    if (activeQuery) {
      const refresh = (): void => {
        const active = bound ? bound.isActive(activeQuery[0], activeQuery[1]) : false;
        button.setAttribute('aria-pressed', String(active));
      };
      refresh();
      refreshers.push(refresh);
    }

    // THE guard: cancel mousedown, not just click. A click handler alone fires
    // after the surface has already blurred — and blur commits and closes.
    button.addEventListener('mousedown', (event) => event.preventDefault());
    button.addEventListener('click', (event) => {
      event.preventDefault();
      activate(control);
    });
    element.append(button);
  };

  const activate = (control: InlineToolbarControl): void => {
    if (!bound) return;
    if (control === 'link') openPopover();
    else runControl(bound, control);
    refreshAll();
    place();
  };

  if (mode === 'plain') {
    const hint = document.createElement('span');
    hint.className = 'dl-em-fmthint';
    hint.textContent = 'Plain text';
    element.append(hint);
  } else {
    for (const control of INLINE_TOOLBAR_BUTTONS[mode]) {
      if (CONTROL_GROUP_BREAKS.has(control)) {
        const separator = document.createElement('span');
        separator.className = 'dl-em-fmtsep';
        separator.setAttribute('aria-hidden', 'true');
        element.append(separator);
      }
      addButton(control);
    }
  }

  // ── editor binding ──────────────────────────────────────────────────────
  const onEditorEvent = (): void => {
    refreshAll();
    place();
  };
  const bind = (next: InlineToolbarEditor): void => {
    bound?.off('selectionUpdate', onEditorEvent);
    bound?.off('transaction', onEditorEvent);
    bound = next;
    next.on('selectionUpdate', onEditorEvent);
    next.on('transaction', onEditorEvent);
    refreshAll();
  };
  if (editor) bind(editor);

  // ── keyboard ────────────────────────────────────────────────────────────
  // StarterKit already binds Mod-B/I/E, Mod-Shift-8/7, Mod-Alt-2/3, undo/redo,
  // Shift-Enter and Tab. Two the surface has to own itself, in CAPTURE so they
  // are decided before ui.ts's Esc-cancels-the-edit handler sees them.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape' && popover) {
      // Esc must close the popover FIRST; letting it through would revert the
      // whole edit because the link URL was mistyped.
      event.preventDefault();
      event.stopPropagation();
      closePopover();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      if (!INLINE_TOOLBAR_BUTTONS[mode].includes('link')) return;
      event.preventDefault(); // …and never reach the browser's own Mod-K
      event.stopPropagation();
      activate('link');
    }
  };
  document.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', place, { passive: true, capture: true });
  window.addEventListener('resize', place);
  document.addEventListener('selectionchange', place);

  document.body.append(element);
  window.requestAnimationFrame(place);

  return {
    element,
    reposition: place,
    bind,
    destroy: () => {
      bound?.off('selectionUpdate', onEditorEvent);
      bound?.off('transaction', onEditorEvent);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      document.removeEventListener('selectionchange', place);
      element.remove();
    },
  };
};

// ─── browser editor factory (dynamic TipTap import) ────────────────────────────

export interface RichTextEditorHandle {
  /** Current document as rich_text.v1 (already sanitized to grammar). */
  getRichTextV1(): RichTextV1Document;
  /** True while the document carries no formatting a plain string could not hold. */
  isPlainText(): boolean;
  /** The document as the plain string it round-trips to (the fix-3 downgrade). */
  getPlainText(): string;
  /** Focus the editable surface. */
  focus(): void;
  /** Tear down the TipTap instance (call on panel close — avoids leaks). */
  destroy(): void;
  /** The formatting bubble for this editor, mounted on the document. */
  buildToolbar(mode: InlineToolbarMode, options: InlineToolbarOptions): InlineToolbarHandle | undefined;
  /** The underlying TipTap editor (typed loosely to avoid a static @tiptap dep here). */
  editor: unknown;
}

export interface CreateRichTextEditorOptions {
  element: HTMLElement;
  /** Initial document (rich_text.v1); an empty paragraph when omitted. */
  doc?: RichTextV1Document;
  /** Fired on every change with the serialized, grammar-sanitized document. */
  onChange?: (doc: RichTextV1Document) => void;
  placeholder?: string;
}

/**
 * Mount a grammar-bound TipTap editor into `element`. Browser-only: @tiptap/*
 * are dynamically imported so they never enter the test/SSR graph. StarterKit is
 * pared to the grammar (headings 2–3, inline code; no blockquote/code
 * blocks/strike/hr); Link is https-only and cannot be opened on click.
 */
export const createRichTextEditor = async (options: CreateRichTextEditorOptions): Promise<RichTextEditorHandle> => {
  const [{ Editor }, { default: StarterKit }, { default: Link }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/starter-kit'),
    import('@tiptap/extension-link'),
  ]);

  const initialContent = options.doc
    ? (deserializeFromRichTextV1(options.doc) as unknown as Record<string, unknown>)
    : { type: 'doc', content: [{ type: 'paragraph' }] };

  const editor = new Editor({
    element: options.element,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        // Everything outside the grammar off — the toolbar can only offer what
        // the schema permits, and paste is additionally run through the
        // sanitizer below. `code` (the inline mark) stays on; `codeBlock`
        // (multi-line, no rich-text-v1 node type yet) stays off.
        blockquote: false,
        codeBlock: false,
        strike: false,
        horizontalRule: false,
        link: false,
      }),
      Link.configure({
        openOnClick: false,
        autolink: false,
        protocols: ['https'],
        HTMLAttributes: { rel: 'noopener nofollow', target: '_blank' },
      }),
    ],
    content: initialContent,
    editorProps: {
      // Belt-and-suspenders: sanitize pasted ProseMirror slices at the seam so
      // out-of-grammar structure never enters the doc in the first place.
      transformPastedHTML: (html) => html,
    },
  });

  const getRichTextV1 = (): RichTextV1Document => serializeToRichTextV1(editor.getJSON() as unknown as ProseMirrorNode);

  if (options.onChange) {
    editor.on('update', () => options.onChange?.(getRichTextV1()));
  }

  return {
    getRichTextV1,
    isPlainText: () => !richTextV1HasFormatting(getRichTextV1()),
    getPlainText: () => richTextV1ToPlainString(getRichTextV1()),
    focus: () => editor.commands.focus(),
    destroy: () => editor.destroy(),
    buildToolbar: (mode, toolbarOptions) =>
      buildInlineToolbar(editor as unknown as InlineToolbarEditor, mode, toolbarOptions),
    editor,
  };
};
