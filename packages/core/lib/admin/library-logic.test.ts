import { describe, it } from 'node:test';
import assert from 'node:assert';

import { rowStatus, readinessDot, filterRows, typeCounts, type LibraryRow } from './library-logic.js';

const row = (over: Partial<LibraryRow> = {}): LibraryRow => ({
  object_id: 'page_x',
  object_type: 'page',
  display_name: 'A page',
  updated_at: '2026-07-10T00:00:00.000Z',
  status: 'active',
  review_state: 'none',
  published_time: null,
  unpublished_changes: true,
  ...over,
});

describe('rowStatus', () => {
  it('prioritizes review, then publish, then draft', () => {
    assert.deepStrictEqual(rowStatus(row({ review_state: 'open' })), { label: 'In review', tone: 'info' });
    assert.deepStrictEqual(rowStatus(row({ review_state: 'changes_requested' })), {
      label: 'Changes requested',
      tone: 'warning',
    });
    // T0.3 Table C / T6.1: matches EDITORIAL_STATE_PRESENTATION.published
    // (info/blue) — the published/live color race fix. rowStatus() now
    // derives this from that same table rather than a second literal.
    assert.deepStrictEqual(rowStatus(row({ published_time: '2026-07-01T00:00:00.000Z', unpublished_changes: false })), {
      label: 'Published',
      tone: 'info',
    });
    assert.deepStrictEqual(rowStatus(row()), { label: 'Draft', tone: 'neutral' });
    assert.deepStrictEqual(rowStatus(row({ status: 'archived' })), { label: 'Archived', tone: 'neutral' });
  });
});

describe('readinessDot', () => {
  it('flags review/unpublished as attention, clean-published as ready, else idle', () => {
    assert.strictEqual(readinessDot(row({ review_state: 'open' })), 'attention');
    assert.strictEqual(
      readinessDot(row({ published_time: '2026-07-01T00:00:00.000Z', unpublished_changes: true })),
      'attention'
    );
    assert.strictEqual(
      readinessDot(row({ published_time: '2026-07-01T00:00:00.000Z', unpublished_changes: false })),
      'ready'
    );
    assert.strictEqual(readinessDot(row()), 'idle');
  });
});

describe('filterRows', () => {
  const rows: LibraryRow[] = [
    row({ object_id: 'a', object_type: 'page', display_name: 'Start Here', updated_at: '2026-07-01T00:00:00.000Z' }),
    row({
      object_id: 'b',
      object_type: 'content_item',
      display_name: 'Barrier guide',
      updated_at: '2026-07-15T00:00:00.000Z',
    }),
    row({ object_id: 'c', object_type: 'page', display_name: 'Pricing', updated_at: '2026-07-10T00:00:00.000Z' }),
  ];

  it('sorts newest-updated first', () => {
    assert.deepStrictEqual(
      filterRows(rows, {}).map((r) => r.object_id),
      ['b', 'c', 'a']
    );
  });

  it('filters by type', () => {
    assert.deepStrictEqual(
      filterRows(rows, { type: 'page' }).map((r) => r.object_id),
      ['c', 'a']
    );
  });

  it('matches query on display name (case-insensitive)', () => {
    assert.deepStrictEqual(
      filterRows(rows, { query: 'barrier' }).map((r) => r.object_id),
      ['b']
    );
  });

  it('matches query on the human type label', () => {
    assert.deepStrictEqual(
      filterRows(rows, { query: 'article' }).map((r) => r.object_id),
      ['b']
    );
  });
});

describe('typeCounts', () => {
  it('counts rows per type', () => {
    const counts = typeCounts([
      row({ object_type: 'page' }),
      row({ object_type: 'page' }),
      row({ object_type: 'theme' }),
    ]);
    assert.deepStrictEqual(counts, { page: 2, theme: 1 });
  });
});
