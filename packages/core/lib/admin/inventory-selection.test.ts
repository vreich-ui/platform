import { describe, it } from 'node:test';
import assert from 'node:assert';

import { bulkActionsFor, type Role } from './inventory-logic.js';
import { describeInventorySelection, INVENTORY_COLLECTION_LABELS } from './inventory-selection.js';
import type { InventoryCollection, InventoryHit } from './inventory-server-logic.js';

const ADMIN: readonly Role[] = ['admin'];

const hit = (collection: InventoryCollection, id: string): InventoryHit => ({
  collection,
  id,
  label: id,
  kind: 'thing',
  status: 'active',
  updatedAt: null,
  sizeBytes: null,
  previewRef: null,
  thumbnailRef: null,
  refs: [],
  tags: [],
});

describe('describeInventorySelection', () => {
  it('reports an empty selection as spanning nothing, with no sentence and nothing to narrow', () => {
    const span = describeInventorySelection([]);
    assert.strictEqual(span.total, 0);
    assert.deepStrictEqual(span.tallies, []);
    assert.strictEqual(span.spansMultiple, false);
    assert.deepStrictEqual(span.narrowingOptions, []);
    assert.strictEqual(span.headline, null);
    assert.strictEqual(span.detail, null);
  });

  it('says nothing for a single-collection selection — there is nothing to explain or narrow', () => {
    const span = describeInventorySelection([hit('artifacts', 'a1'), hit('artifacts', 'a2')]);
    assert.strictEqual(span.spansMultiple, false);
    assert.strictEqual(span.headline, null);
    assert.strictEqual(span.detail, null);
    assert.deepStrictEqual(span.narrowingOptions, []);
    // …while still tallying, so a caller can label a uniform selection.
    assert.deepStrictEqual(span.tallies, [{ collection: 'artifacts', label: 'Artifacts', count: 2 }]);
  });

  it('counts each collection, biggest first, for a mixed selection', () => {
    const span = describeInventorySelection([
      hit('stores', 's1'),
      hit('artifacts', 'a1'),
      hit('artifacts', 'a2'),
      hit('artifacts', 'a3'),
      hit('objects', 'o1'),
      hit('objects', 'o2'),
    ]);

    assert.strictEqual(span.total, 6);
    assert.strictEqual(span.spansMultiple, true);
    assert.deepStrictEqual(span.tallies, [
      { collection: 'artifacts', label: 'Artifacts', count: 3 },
      { collection: 'objects', label: 'Objects', count: 2 },
      { collection: 'stores', label: 'System stores', count: 1 },
    ]);
  });

  it('names the counts and the collections in plain words, for a non-engineer', () => {
    const span = describeInventorySelection([hit('objects', 'o1'), hit('artifacts', 'a1'), hit('artifacts', 'a2')]);

    assert.strictEqual(span.headline, '3 items selected, from 2 different kinds of thing: Artifacts (2) and Objects (1).');
    assert.ok(span.detail && span.detail.includes('tag'), 'the sentence names the verb the owner went looking for');
    assert.ok(
      span.detail && !/intersect|empty set|verb matrix/i.test(span.detail),
      'no engineering vocabulary reaches the toolbar'
    );
  });

  it('offers one narrowing option per collection, carrying exactly that collection’s selected ids', () => {
    const span = describeInventorySelection([
      hit('objects', 'o1'),
      hit('artifacts', 'a1'),
      hit('artifacts', 'a2'),
      hit('objects', 'o2'),
    ]);

    assert.deepStrictEqual(
      span.narrowingOptions.map((option) => option.label),
      // Tie on count (2 and 2) → canonical collection order breaks it, so the
      // row never reshuffles between renders of the same selection.
      ['Keep only Objects (2)', 'Keep only Artifacts (2)']
    );
    const artifacts = span.narrowingOptions.find((option) => option.collection === 'artifacts');
    assert.deepStrictEqual(artifacts?.ids, ['a1', 'a2']);
    const objects = span.narrowingOptions.find((option) => option.collection === 'objects');
    assert.deepStrictEqual(objects?.ids, ['o1', 'o2']);
  });

  it('still explains itself when the mixed selection DOES leave a shared verb standing', () => {
    // The reported case. `bulkActionsFor` is not empty here — every collection
    // shares `send-to-chat` — so a message gated on "no verb applies" would
    // never fire, which is exactly why the toolbar was silent. The span is
    // computed from the selection, not from the surviving action set.
    const selection = [hit('objects', 'o1'), hit('artifacts', 'a1')];
    assert.deepStrictEqual(bulkActionsFor(selection, ADMIN), ['send-to-chat']);

    const span = describeInventorySelection(selection);
    assert.strictEqual(span.spansMultiple, true);
    assert.ok(span.headline);
    assert.strictEqual(span.narrowingOptions.length, 2);
  });

  it('narrowing restores the collection’s own verbs without weakening the intersection', () => {
    const selection = [hit('objects', 'o1'), hit('artifacts', 'a1'), hit('artifacts', 'a2')];
    const span = describeInventorySelection(selection);
    const keepArtifacts = span.narrowingOptions.find((option) => option.collection === 'artifacts');
    assert.ok(keepArtifacts);

    const narrowed = selection.filter((row) => keepArtifacts.ids.includes(row.id));
    const actions = bulkActionsFor(narrowed, ADMIN);
    assert.ok(actions.includes('add-tag'), 'add-tag returns once the selection is all artifacts');
    assert.ok(actions.includes('remove-tag'), 'remove-tag returns once the selection is all artifacts');
    // The rule itself is untouched: object-only verbs never appear on artifacts.
    assert.ok(!actions.includes('archive'));
    assert.ok(!actions.includes('validate'));
  });

  it('labels every collection the closed enum can produce', () => {
    assert.deepStrictEqual(Object.keys(INVENTORY_COLLECTION_LABELS).sort(), ['artifacts', 'objects', 'stores']);
  });
});
