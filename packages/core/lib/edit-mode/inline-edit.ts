/**
 * Double-click-to-edit (T17.8) — the pure half.
 *
 * The concept's cheapest interaction: double-click a block, type, done. No
 * chip, no panel, no form. ui.ts owns the editing surface and the commit;
 * everything decidable from data alone lives here so it is unit-tested without
 * a DOM — which field a block's copy actually is, whether a mouse event should
 * still arm an Ask-AI selection, and the ops a committed value becomes.
 *
 * Spec: docs/design/marginalia-interaction-model.md §5.
 */
import { blockText, richTextToBlocks } from './preview.js';
import type { InlineToolbarMode } from './richtext-editor.js';
import { suggestionToOps, type EditTarget } from './targets.js';

/**
 * Manual-edit field selection (client-side heuristic): copy fields only.
 * Media/asset/link/binding keys are excluded here for the same reason the AI
 * schema strips them — except the image tool, which edits image fields
 * DELIBERATELY through its own dedicated form. Shared with ui.ts's
 * `formFieldsFor`, which is the same rule applied to the panel's forms.
 */
export const NON_COPY_KEY_RE = /asset|image|portrait|logo|icon|src|url|href|route|anchor|formname|ogimage/i;

const LOOKS_LIKE_HTML = /<[a-z][\s\S]*>/i;

/** How a field's value is edited, which fixes both the surface and the commit shape. */
export type InlineFieldKind =
  /** A plain string: edited as text, committed as text. */
  | 'plain'
  /** A rich-text HTML string (section bodies): edited as its raw markup, as the panel's textarea does. */
  | 'html'
  /** A rich_text.v1 document: edited with the grammar-bound TipTap editor. */
  | 'doc';

export type InlineField = { key: string; kind: InlineFieldKind };

/** A rich_text.v1 document as it sits in a record body (Contentful's document node). */
export const isRichTextDocument = (value: unknown): boolean =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  (value as { nodeType?: unknown }).nodeType === 'document' &&
  Array.isArray((value as { content?: unknown }).content);

/**
 * Keys that ARE the block's copy when a block has several. Object key order in
 * a stored record is incidental, and "the first key that happens to be a
 * string" would make double-clicking a paragraph edit the block's heading.
 * Anything not listed falls back to first-eligible-in-order.
 */
const PRIMARY_KEYS = ['body', 'text', 'title', 'heading'];

const inlineKindFor = (key: string, value: unknown, objectType: string): InlineFieldKind | undefined => {
  if (isRichTextDocument(value)) return 'doc';
  if (typeof value !== 'string') return undefined;
  // Article node bodies are PLAIN TEXT (render-nodes.ts escapes them and
  // splits paragraphs on blank lines) — never markup, whatever they contain.
  if (objectType === 'content_item') return 'plain';
  return LOOKS_LIKE_HTML.test(value) || key === 'body' ? 'html' : 'plain';
};

/**
 * The one field a double-click edits, derived from the block's own data — not
 * a hardcoded per-type map. `undefined` means this block has no single primary
 * copy field (an image node, a grid, most navigation targets) and the
 * double-click falls through to the panel instead (§5.1).
 *
 * String arrays (`items`) are deliberately NOT eligible: a bullet list is not
 * one value, and inline-editing it would need the panel's multi-line form.
 */
export const derivePrimaryInlineField = (
  data: Record<string, unknown>,
  objectType: string
): InlineField | undefined => {
  const eligible: InlineField[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (NON_COPY_KEY_RE.test(key)) continue;
    const kind = inlineKindFor(key, value, objectType);
    if (kind) eligible.push({ key, kind });
  }
  if (eligible.length === 0) return undefined;
  for (const preferred of PRIMARY_KEYS) {
    const match = eligible.find((field) => field.key === preferred);
    if (match) return match;
  }
  return eligible[0];
};

/**
 * How much formatting the surface for a field may offer (Wolf, 2026-08-11:
 * "When editing something that can be edited on the spot, like text it need to
 * show rich text tools"). Derived from the field's own shape, because that is
 * what decides which of them can actually be SAVED:
 *
 *   - a rich_text.v1 document takes the full grammar;
 *   - a single-line string (heading, title, eyebrow, ctaText…) takes none —
 *     the renderer escapes it, so a <strong> would ship as literal markup;
 *   - a raw HTML section body gets no bubble at all: its surface is the markup
 *     itself, and formatting it belongs with the section rich-text work.
 *
 * The exception is an article node's `body`: `content_item` bodies already
 * accept EITHER shape (content-item-v1.ts) and render-nodes.ts renders both,
 * so a plain string there can become a document the moment formatting is
 * asked for — Wolf, 2026-08-11: "Yes — upgrade on first format."
 */
export const inlineToolbarModeFor = (field: InlineField, objectType: string): InlineToolbarMode => {
  if (field.kind === 'doc') return 'rich';
  if (field.kind === 'html') return 'none';
  return isUpgradableBody(field, objectType) ? 'upgrade' : 'plain';
};

/**
 * A plain string field whose store shape may become `rich_text.v1`. Only
 * article-node bodies qualify: they are the one field whose schema is a union
 * of both shapes, so no migration and no schema change is involved.
 */
export const isUpgradableBody = (field: InlineField, objectType: string): boolean =>
  field.kind === 'plain' && objectType === 'content_item' && field.key === 'body';

/**
 * A plain body as the renderer normalizes it: blank lines split paragraphs,
 * each paragraph trimmed, empties dropped. Two strings with the same
 * normalization render identically, so a round trip through the editor that
 * lands back here changed nothing.
 */
export const normalizePlainBody = (text: string): string =>
  text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .join('\n\n');

/**
 * What an upgradable body actually commits, given the state of the surface:
 *
 *   - the document, once it carries formatting a string could not hold — this
 *     IS the upgrade, and it is ONE `update_node` op with no schema change and
 *     no migration (one-way: nothing downgrades it again);
 *   - the ORIGINAL string, byte for byte, when nothing textual changed, so
 *     opening a block and clicking away can never rewrite its whitespace;
 *   - otherwise the edited plain string, exactly as before this task.
 */
export const upgradableCommitValue = (
  before: unknown,
  doc: unknown,
  plain: string,
  hasFormatting: boolean
): unknown => {
  if (hasFormatting) return doc;
  if (typeof before === 'string' && normalizePlainBody(before) === plain) return before;
  return plain;
};

type RichTextNode = { value?: unknown; content?: unknown };

/** A rich_text.v1 node's text, exactly as it lands in the rendered element. */
const richTextNodeText = (node: RichTextNode): string => {
  if (typeof node.value === 'string') return node.value;
  const content = Array.isArray(node.content) ? (node.content as RichTextNode[]) : [];
  return content.map(richTextNodeText).join('');
};

/**
 * The text of each top-level block a field's CURRENT value renders as, in the
 * order the renderer emits them — the key the inline editor uses to find the
 * element(s) it must mount over (fix 2). Single newlines are dropped because
 * both renderers emit them as `<br/>`, which contributes no text.
 *
 * Pure: it mirrors the renderers, so it is tested against their rules rather
 * than against a DOM.
 *   - plain  → render-nodes.ts's `plainTextParagraphs` (blank lines split);
 *   - html   → the real rich-text block splitter (preview.ts);
 *   - doc    → the rich_text.v1 document's own top-level blocks.
 */
export const inlineValueBlockTexts = (field: InlineField, value: unknown): string[] => {
  const strip = (text: string): string => text.replaceAll('\n', '');
  if (field.kind === 'doc') {
    const content = (value as { content?: unknown })?.content;
    if (!Array.isArray(content)) return [];
    return (content as RichTextNode[]).map((block) => strip(richTextNodeText(block))).filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  if (field.kind === 'html') {
    return (richTextToBlocks(value) ?? []).map((block) => blockText(block.html)).filter(Boolean);
  }
  return value
    .split(/\n{2,}/)
    .map((paragraph) => strip(paragraph.trim()))
    .filter(Boolean);
};

/**
 * §5.3 collision 1: a double-click selects a word, and the canvas's `mouseup`
 * listener would arm that as an Ask-AI scope. `event.detail` counts clicks in
 * the sequence, so anything ≥ 2 is a multi-click and must not capture.
 */
export const shouldCaptureSelection = (detail: number): boolean => detail < 2;

/**
 * The reviewable ops an inline commit becomes — the SAME `update_node` /
 * `update_section_data` shapes a panel save produces, through the same
 * function. There is deliberately no second write path (§5.2).
 */
export const inlineEditOps = (
  target: EditTarget,
  field: InlineField,
  value: unknown,
  patchSectionId?: string
): Array<Record<string, unknown>> => suggestionToOps(target, { [field.key]: value }, patchSectionId);
