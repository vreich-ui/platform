import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  emptySelection,
  toggleSelection,
  selectAll,
  clearSelection,
  pruneSelection,
  selectionCount,
  isSelected,
  isAllSelected,
  isSomeSelected,
  toggleSelectAll,
} from './bulk-selection.js';

describe('toggleSelection', () => {
  it('adds then removes', () => {
    let state = emptySelection();
    state = toggleSelection(state, 'a');
    assert.strictEqual(isSelected(state, 'a'), true);
    state = toggleSelection(state, 'a');
    assert.strictEqual(isSelected(state, 'a'), false);
  });
});

describe('selectAll / clearSelection', () => {
  it('selectAll replaces rather than merges', () => {
    let state = toggleSelection(emptySelection(), 'z');
    state = selectAll(['a', 'b']);
    assert.deepStrictEqual([...state.selected].sort(), ['a', 'b']);
  });

  it('clearSelection empties', () => {
    const state = clearSelection();
    assert.strictEqual(selectionCount(state), 0);
  });
});

describe('pruneSelection', () => {
  it('drops ids no longer in the visible set', () => {
    const state = selectAll(['a', 'b', 'c']);
    const pruned = pruneSelection(state, ['b', 'c', 'd']);
    assert.deepStrictEqual([...pruned.selected].sort(), ['b', 'c']);
  });

  it('is a no-op (same object identity concern aside) when nothing changes', () => {
    const state = selectAll(['a', 'b']);
    const pruned = pruneSelection(state, ['a', 'b', 'c']);
    assert.deepStrictEqual([...pruned.selected].sort(), ['a', 'b']);
  });
});

describe('isAllSelected / isSomeSelected', () => {
  it('all vs. some vs. none, including the empty-list edge case', () => {
    const ids = ['a', 'b', 'c'];
    assert.strictEqual(isAllSelected(selectAll(ids), ids), true);
    assert.strictEqual(isAllSelected(selectAll(['a']), ids), false);
    assert.strictEqual(isSomeSelected(selectAll(['a']), ids), true);
    assert.strictEqual(isSomeSelected(selectAll(ids), ids), false);
    assert.strictEqual(isSomeSelected(emptySelection(), ids), false);
    assert.strictEqual(isAllSelected(emptySelection(), []), false);
    assert.strictEqual(isSomeSelected(emptySelection(), []), false);
  });
});

describe('toggleSelectAll', () => {
  it('selects all when not all selected, clears when all are', () => {
    const ids = ['a', 'b'];
    let state = emptySelection();
    state = toggleSelectAll(state, ids);
    assert.strictEqual(isAllSelected(state, ids), true);
    state = toggleSelectAll(state, ids);
    assert.strictEqual(selectionCount(state), 0);
  });
});
