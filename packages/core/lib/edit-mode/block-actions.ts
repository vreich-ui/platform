/**
 * The block drawer's action registry (T17.14b) — the pure half.
 *
 * R5 of the margin bubble: everything else the block can do, behind the footer
 * chevron. These are the four tools and the `content_grid` configuration the
 * retired W7 hover chip carried (affordance-model §3), re-expressed as
 * **labelled text rows with a leading glyph** rather than an icon strip —
 * which is the difference between "native in the bubble" (Wolf, 2026-08-11)
 * and "the chip, relocated".
 *
 * Which rows a block gets is a function of the block, so it is decided here
 * and unit-tested headlessly; ui.ts turns the plan into DOM and wires each row
 * to the handler it already had. Same discipline as rail-layout.ts /
 * attention.ts / affordance-state.ts in this directory.
 *
 * Spec: docs/design/marginalia-affordance-model.md §2 (R5), §3, §10 rows
 * 24–25 and 28.
 */

/** Section types whose data carries an image the image tool should offer. */
export const IMAGE_SECTION_TYPES = new Set(['bio', 'content_split']);

/** What the panel would open on; `related` and `delete` are not panel modes. */
export type BlockActionPanelMode = 'ai' | 'edit' | 'image' | 'role' | 'meta';

export type BlockActionKind = 'image' | 'role' | 'meta' | 'ai' | 'related' | 'delete';

export type DrawerRow = {
  kind: BlockActionKind;
  /** The row's visible text. Labelled, never an icon alone. */
  label: string;
  /** The docked panel section this row opens, when it opens one. */
  panelMode?: BlockActionPanelMode;
  /** A hairline above the row — destruction is set apart from everything else. */
  separatorBefore?: boolean;
  /** Interim until T17.7's composer modes replace it (affordance-model §9). */
  interim?: boolean;
};

export type BlockActionInput = {
  /** A navigation object — chrome, not content: no image, role, AI or delete. */
  isNav: boolean;
  /** An article node (`data-cms-node-id`). */
  isNode: boolean;
  /** `data-cms-node-kind` for an article node. */
  nodeKind?: string;
  /** The section's type for a section region. */
  sectionType?: string;
  /** `data-cms-related-algorithm` is present, i.e. this is a `content_grid`. */
  hasRelated: boolean;
  objectType: string;
};

/**
 * The exact `hasImage` predicate `renderChip` used, preserved verbatim so the
 * Image tool appears on precisely the blocks it appeared on before the fold.
 */
export const blockHasImage = (input: BlockActionInput): boolean => {
  if (input.isNav) return false;
  if (input.isNode) return input.nodeKind === 'content';
  return IMAGE_SECTION_TYPES.has(input.sectionType ?? '');
};

/**
 * R5's rows for one block, in the spec's order, omitting what does not apply.
 *
 * `Article settings` is reachable in ONE gesture here for the first time:
 * before the fold `'meta'` had no chip button at all and could only be reached
 * by opening the panel with some other tool and then clicking its accordion
 * head. That is a fix, not a regression.
 */
export const drawerRowsFor = (input: BlockActionInput): DrawerRow[] => {
  const rows: DrawerRow[] = [];
  if (blockHasImage(input)) rows.push({ kind: 'image', label: 'Image…', panelMode: 'image' });
  if (input.isNode && !input.isNav) rows.push({ kind: 'role', label: 'Role & intent…', panelMode: 'role' });
  if (input.objectType === 'content_item' && !input.isNav) {
    rows.push({ kind: 'meta', label: 'Article settings…', panelMode: 'meta' });
  }
  // The bridge until T17.7: its composer's "Ask for a change" / "Ask a
  // question" modes become the canvas's way to put a request to the agent,
  // and T17.7 deletes this row. No capability is lost for a single day.
  if (!input.isNav) rows.push({ kind: 'ai', label: 'Ask AI…', panelMode: 'ai', interim: true });
  if (input.hasRelated && !input.isNav) rows.push({ kind: 'related', label: 'Related articles' });
  // Destruction last, below a hairline, in the destructive token.
  if (!input.isNav) rows.push({ kind: 'delete', label: 'Delete block', separatorBefore: true });
  return rows;
};

/**
 * The composer's selection strip (affordance-model §2, R3): `“…” ✕` above the
 * field when a text selection is armed inside this bubble's block. It replaces
 * the chip's `.dl-em-ask.dl-em-sel` highlight, which was the only indication a
 * selection was armed at all.
 *
 * Designed once, here: T17.4 reuses this strip as the span anchor's surface
 * and must not invent a second one.
 */
export const SELECTION_STRIP_MAX = 60;

export const selectionStripLabel = (text: string, max = SELECTION_STRIP_MAX): string => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) return normalized;
  // The ellipsis replaces content, so the strip never exceeds `max` glyphs —
  // a strip that grew with the selection would push the composer off the card.
  return `${normalized.slice(0, max - 1).trimEnd()}…`;
};
