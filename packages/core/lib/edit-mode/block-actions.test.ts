/**
 * The block drawer's action registry (T17.14b) — which rows a block gets, in
 * which order, and the composer selection strip's truncation.
 *
 * The load-bearing property: **nothing the retired hover chip could do became
 * unreachable.** Each case below is one of `renderChip`'s output rows in
 * docs/design/marginalia-affordance-model.md §3, checked against the block
 * kinds that used to show it.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blockHasImage,
  drawerRowsFor,
  IMAGE_SECTION_TYPES,
  SELECTION_STRIP_MAX,
  selectionStripLabel,
  type BlockActionInput,
} from './block-actions.js';

const block = (overrides: Partial<BlockActionInput> = {}): BlockActionInput => ({
  isNav: false,
  isNode: false,
  hasRelated: false,
  objectType: 'page',
  ...overrides,
});

const kindsOf = (input: BlockActionInput): string[] => drawerRowsFor(input).map((row) => row.kind);

describe('the drawer’s rows per block kind (§2, R5)', () => {
  it('gives an article CONTENT node every tool the chip gave it', () => {
    const rows = kindsOf(block({ isNode: true, nodeKind: 'content', objectType: 'content_item' }));
    assert.deepEqual(rows, ['image', 'role', 'meta', 'ai', 'delete']);
  });

  it('drops Image on an article node that carries none', () => {
    const rows = kindsOf(block({ isNode: true, nodeKind: 'heading', objectType: 'content_item' }));
    assert.deepEqual(rows, ['role', 'meta', 'ai', 'delete']);
  });

  it('gives an image-bearing section its Image row and no article-only rows', () => {
    for (const sectionType of IMAGE_SECTION_TYPES) {
      assert.deepEqual(kindsOf(block({ sectionType })), ['image', 'ai', 'delete'], sectionType);
    }
  });

  it('gives a plain section only Ask AI and Delete', () => {
    assert.deepEqual(kindsOf(block({ sectionType: 'hero' })), ['ai', 'delete']);
  });

  it('gives a content_grid its Related articles group, before the hairline', () => {
    const rows = drawerRowsFor(block({ sectionType: 'content_grid', hasRelated: true }));
    assert.deepEqual(
      rows.map((row) => row.kind),
      ['ai', 'related', 'delete']
    );
    assert.equal(rows[1].label, 'Related articles');
    assert.equal(rows[2].separatorBefore, true, 'destruction is set apart from everything else');
    assert.equal(rows[0].separatorBefore, undefined);
  });

  it('gives a navigation object NO drawer at all — chrome is not a block', () => {
    assert.deepEqual(kindsOf(block({ isNav: true, objectType: 'navigation' })), []);
    assert.deepEqual(kindsOf(block({ isNav: true, hasRelated: true, sectionType: 'bio' })), []);
    assert.equal(blockHasImage(block({ isNav: true, sectionType: 'bio' })), false);
  });

  it('offers Article settings on article blocks only — reachable in one gesture for the first time', () => {
    assert.ok(kindsOf(block({ isNode: true, objectType: 'content_item' })).includes('meta'));
    assert.ok(!kindsOf(block({ sectionType: 'hero' })).includes('meta'));
  });

  it('marks Ask AI as interim, because T17.7’s composer modes delete it', () => {
    const ai = drawerRowsFor(block({ sectionType: 'hero' })).find((row) => row.kind === 'ai');
    assert.equal(ai?.interim, true);
    assert.equal(ai?.panelMode, 'ai');
  });

  it('routes every panel row to the panel mode the chip’s button routed to', () => {
    const rows = drawerRowsFor(block({ isNode: true, nodeKind: 'content', objectType: 'content_item' }));
    assert.deepEqual(
      rows.filter((row) => row.panelMode).map((row) => [row.kind, row.panelMode]),
      [
        ['image', 'image'],
        ['role', 'role'],
        ['meta', 'meta'],
        ['ai', 'ai'],
      ]
    );
    assert.equal(
      rows.find((row) => row.kind === 'delete')?.panelMode,
      undefined,
      'delete is not a panel — it is the confirm modal'
    );
  });

  it('labels every row, never an icon alone', () => {
    for (const input of [
      block({ isNode: true, nodeKind: 'content', objectType: 'content_item' }),
      block({ sectionType: 'bio' }),
      block({ sectionType: 'content_grid', hasRelated: true }),
    ]) {
      for (const row of drawerRowsFor(input)) assert.ok(row.label.length > 0, `${row.kind} has no label`);
    }
  });
});

describe('the composer’s selection strip (§2, R3)', () => {
  it('shows a short selection whole', () => {
    assert.equal(selectionStripLabel('soften the graveyard line'), 'soften the graveyard line');
  });

  it('collapses whitespace, so a multi-line selection stays one line', () => {
    assert.equal(selectionStripLabel('  soften\n  the   line \t'), 'soften the line');
  });

  it('never exceeds the cap, ellipsis included', () => {
    const long = 'a'.repeat(200);
    const label = selectionStripLabel(long);
    assert.equal(label.length, SELECTION_STRIP_MAX);
    assert.equal(SELECTION_STRIP_MAX, 60);
    assert.ok(label.endsWith('…'));
  });

  it('does not leave a dangling space before the ellipsis', () => {
    const text = `${'word '.repeat(11)}tail`;
    const label = selectionStripLabel(text, 12);
    assert.ok(!label.includes(' …'), label);
    assert.ok(label.length <= 12);
  });

  it('is empty for an empty selection, so the strip can hide on falsiness', () => {
    assert.equal(selectionStripLabel('   \n  '), '');
  });
});
