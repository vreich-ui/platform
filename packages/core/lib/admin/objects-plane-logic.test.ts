import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  OBJECT_TYPE_FACETS,
  parseTypeFacetParam,
  typeFacetToParam,
  matchesTypeFacet,
  toggleTypeFacet,
  matchesSearch,
  statusFor,
  compareObjectRows,
  sortObjectRows,
  filterObjectRows,
  typeFacetCounts,
  paginateRows,
  DEFAULT_PAGE_SIZE,
} from './objects-plane-logic.js';
import { objectTypes } from '../../schema/object-record-v1.js';
import type { LibraryRow } from './library-logic.js';

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

describe('OBJECT_TYPE_FACETS', () => {
  it('is exactly the schema objectTypes list, in schema order — never a hand-maintained guess', () => {
    assert.deepStrictEqual(OBJECT_TYPE_FACETS, objectTypes);
  });
});

describe('type facet param round-trip', () => {
  it('parses a comma list into a Set, dropping unknown tokens', () => {
    const parsed = parseTypeFacetParam('page, content_item,bogus');
    assert.notStrictEqual(parsed, 'all');
    assert.deepStrictEqual([...(parsed as Set<string>)].sort(), ['content_item', 'page']);
  });

  it('empty/missing/all-unknown parses to "all"', () => {
    assert.strictEqual(parseTypeFacetParam(null), 'all');
    assert.strictEqual(parseTypeFacetParam(''), 'all');
    assert.strictEqual(parseTypeFacetParam('nonsense'), 'all');
  });

  it('typeFacetToParam is the inverse (undefined for "all")', () => {
    assert.strictEqual(typeFacetToParam('all'), undefined);
    assert.strictEqual(typeFacetToParam(new Set(['page', 'template'])), 'page,template');
  });

  it('toggleTypeFacet adds/removes and collapses an empty set back to "all"', () => {
    const withPage = toggleTypeFacet('all', 'page');
    assert.deepStrictEqual([...(withPage as Set<string>)], ['page']);
    const cleared = toggleTypeFacet(withPage, 'page');
    assert.strictEqual(cleared, 'all');
  });
});

describe('matchesTypeFacet', () => {
  it('matches everything for "all", else only the selected set', () => {
    assert.strictEqual(matchesTypeFacet(row({ object_type: 'theme' }), 'all'), true);
    assert.strictEqual(matchesTypeFacet(row({ object_type: 'theme' }), new Set(['page'])), false);
    assert.strictEqual(matchesTypeFacet(row({ object_type: 'theme' }), new Set(['theme'])), true);
  });
});

describe('matchesSearch', () => {
  it('matches id or title, case-insensitively, and is vacuously true for an empty query', () => {
    const r = row({ object_id: 'page_barrier-guide', display_name: 'Barrier Repair Guide' });
    assert.strictEqual(matchesSearch(r, 'barrier'), true);
    assert.strictEqual(matchesSearch(r, 'BARRIER'), true);
    assert.strictEqual(matchesSearch(r, 'page_barrier'), true);
    assert.strictEqual(matchesSearch(r, 'nope'), false);
    assert.strictEqual(matchesSearch(r, '   '), true);
  });
});

describe('statusFor (D4 mapping)', () => {
  it('archived is info, never a bespoke tone', () => {
    assert.deepStrictEqual(statusFor(row({ status: 'archived' })), { level: 'info', label: 'Archived' });
  });

  it('an open or held review is needs_you (a decision is pending), not error/blocked', () => {
    assert.deepStrictEqual(statusFor(row({ review_state: 'open' })), { level: 'needs_you', label: 'In review' });
    assert.deepStrictEqual(statusFor(row({ review_state: 'changes_requested' })), {
      level: 'needs_you',
      label: 'Changes requested',
    });
  });

  it('falls back to published/draft from the row alone when no release state is known', () => {
    assert.deepStrictEqual(statusFor(row({ published_time: '2026-07-01T00:00:00.000Z' })), {
      level: 'success',
      label: 'Published',
    });
    assert.deepStrictEqual(statusFor(row()), { level: 'info', label: 'Draft' });
  });

  it('prefers the release-derived editorial state when supplied', () => {
    assert.deepStrictEqual(statusFor(row(), 'live'), { level: 'success', label: 'Live' });
    assert.deepStrictEqual(statusFor(row(), 'approved'), { level: 'info', label: 'Approved' });
  });
});

describe('sort', () => {
  const rows: LibraryRow[] = [
    row({ object_id: 'b', display_name: 'Bravo', object_type: 'page', updated_at: '2026-07-02T00:00:00.000Z' }),
    row({ object_id: 'a', display_name: 'Alpha', object_type: 'theme', updated_at: '2026-07-05T00:00:00.000Z' }),
    row({
      object_id: 'c',
      display_name: 'Charlie',
      object_type: 'content_item',
      updated_at: '2026-07-01T00:00:00.000Z',
    }),
  ];

  it('sorts by updated_at desc/asc', () => {
    assert.deepStrictEqual(
      sortObjectRows(rows, 'updated_at', 'desc').map((r) => r.object_id),
      ['a', 'b', 'c']
    );
    assert.deepStrictEqual(
      sortObjectRows(rows, 'updated_at', 'asc').map((r) => r.object_id),
      ['c', 'b', 'a']
    );
  });

  it('sorts by title', () => {
    assert.deepStrictEqual(
      sortObjectRows(rows, 'title', 'asc').map((r) => r.object_id),
      ['a', 'b', 'c']
    );
  });

  it('sorts by type', () => {
    assert.deepStrictEqual(
      sortObjectRows(rows, 'type', 'asc').map((r) => r.object_id),
      ['c', 'b', 'a'] // content_item < page < theme
    );
  });

  it('sorts by status worst-first (needs_you before info/success)', () => {
    const statusRows: LibraryRow[] = [
      row({ object_id: 'draft', published_time: null }),
      row({ object_id: 'review', review_state: 'open' }),
      row({ object_id: 'published', published_time: '2026-07-01T00:00:00.000Z' }),
    ];
    assert.deepStrictEqual(compareObjectRows(statusRows[1]!, statusRows[0]!, 'status', 'asc') < 0, true);
    assert.deepStrictEqual(sortObjectRows(statusRows, 'status', 'asc').map((r) => r.object_id)[0], 'review');
  });

  it('nullish/empty values sink to the end regardless of direction', () => {
    const withBlank = [...rows, row({ object_id: 'd', display_name: '', updated_at: '' })];
    const asc = sortObjectRows(withBlank, 'updated_at', 'asc');
    const desc = sortObjectRows(withBlank, 'updated_at', 'desc');
    assert.strictEqual(asc.at(-1)!.object_id, 'd');
    assert.strictEqual(desc.at(-1)!.object_id, 'd');
  });
});

describe('filterObjectRows', () => {
  const rows: LibraryRow[] = [
    row({ object_id: 'a', object_type: 'page', display_name: 'Start Here' }),
    row({ object_id: 'b', object_type: 'content_item', display_name: 'Barrier guide' }),
    row({ object_id: 'c', object_type: 'page', display_name: 'Pricing' }),
  ];

  it('combines type facet and search', () => {
    assert.deepStrictEqual(
      filterObjectRows(rows, { type: new Set(['page']), query: '' }).map((r) => r.object_id),
      ['a', 'c']
    );
    assert.deepStrictEqual(
      filterObjectRows(rows, { type: 'all', query: 'guide' }).map((r) => r.object_id),
      ['b']
    );
    assert.deepStrictEqual(filterObjectRows(rows, { type: new Set(['theme']), query: '' }), []);
  });
});

describe('typeFacetCounts', () => {
  it('counts per type', () => {
    assert.deepStrictEqual(
      typeFacetCounts([row({ object_type: 'page' }), row({ object_type: 'page' }), row({ object_type: 'theme' })]),
      { page: 2, theme: 1 }
    );
  });
});

describe('paginateRows', () => {
  const rows = Array.from({ length: 62 }, (_, i) => i);

  it('slices by page/pageSize and reports pageCount/total', () => {
    const p1 = paginateRows(rows, 1, 25);
    assert.deepStrictEqual(p1.items, rows.slice(0, 25));
    assert.strictEqual(p1.pageCount, 3);
    assert.strictEqual(p1.total, 62);
    assert.strictEqual(p1.page, 1);

    const p3 = paginateRows(rows, 3, 25);
    assert.deepStrictEqual(p3.items, rows.slice(50, 62));
  });

  it('clamps an out-of-range page into bounds instead of returning empty', () => {
    assert.strictEqual(paginateRows(rows, 999, 25).page, 3);
    assert.strictEqual(paginateRows(rows, 0, 25).page, 1);
    assert.strictEqual(paginateRows(rows, -5, 25).page, 1);
  });

  it('an empty array is one empty page, not zero pages', () => {
    const empty = paginateRows([], 1, 25);
    assert.strictEqual(empty.pageCount, 1);
    assert.deepStrictEqual(empty.items, []);
  });

  it('defaults to DEFAULT_PAGE_SIZE', () => {
    assert.strictEqual(paginateRows(rows, 1).items.length, DEFAULT_PAGE_SIZE);
  });
});
