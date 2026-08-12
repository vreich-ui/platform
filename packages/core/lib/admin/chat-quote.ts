/**
 * Highlight-to-reference (admin chat transcripts): pure helpers for turning a
 * raw text selection into a markdown blockquote the composer can insert.
 * Kept separate from chat-logic.ts (event grouping / tool labels) since this
 * is a distinct, small concern — see the T9.14 chat.tsx ChatThread selection
 * handling for where these are used.
 */

/** Hard cap on quoted-text length before an ellipsis is appended. */
export const QUOTE_MAX_CHARS = 500;

/** Collapse all runs of whitespace (including newlines) to a single space and trim the ends. */
export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** Cap `text` at `max` characters, appending an ellipsis when it was truncated. */
export function capWithEllipsis(text: string, max: number = QUOTE_MAX_CHARS): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

/** Trim + collapse whitespace + cap a raw selection, in that order. */
export function normalizeQuoteText(rawSelection: string, max: number = QUOTE_MAX_CHARS): string {
  return capWithEllipsis(collapseWhitespace(rawSelection), max);
}

/** Format a raw selection as a single-line markdown blockquote (`> text`). */
export function formatQuoteBlock(rawSelection: string, max: number = QUOTE_MAX_CHARS): string {
  return `> ${normalizeQuoteText(rawSelection, max)}`;
}

export interface QuoteInsertion {
  /** The full composer text after inserting the quote. */
  text: string;
  /** Where to place the cursor afterwards (always the end of `text`). */
  cursor: number;
}

/**
 * Insert a formatted quote block into the composer draft: appended below any
 * existing content (separated by a blank line), or on its own with a
 * trailing blank line when the composer was empty. Cursor always lands after
 * the inserted block.
 */
export function insertQuoteIntoDraft(
  currentDraft: string,
  rawSelection: string,
  max: number = QUOTE_MAX_CHARS
): QuoteInsertion {
  const block = `${formatQuoteBlock(rawSelection, max)}\n\n`;
  const existing = currentDraft.replace(/\s+$/, '');
  const text = existing ? `${existing}\n\n${block}` : block;
  return { text, cursor: text.length };
}

/**
 * True when a (non-collapsed) DOM Selection lies entirely inside `container`
 * — i.e. both the anchor and focus nodes are descendants of it. Takes the
 * minimal shape needed so it's testable without a full DOM.
 */
export function selectionWithinContainer(
  selection: { isCollapsed: boolean; anchorNode: Node | null; focusNode: Node | null } | null | undefined,
  container: Node | null | undefined
): boolean {
  if (!selection || !container || selection.isCollapsed) return false;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return false;
  return container.contains(anchorNode) && container.contains(focusNode);
}
