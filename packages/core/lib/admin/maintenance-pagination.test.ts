import { describe, it } from 'node:test';
import assert from 'node:assert';

import { paginateMaintenanceRows } from './maintenance-pagination.js';

describe('paginateMaintenanceRows', () => {
  it('limits a large blob result to the requested page and reports its range', () => {
    const rows = Array.from({ length: 185 }, (_, index) => `blob-${index + 1}`);

    const result = paginateMaintenanceRows(rows, 4, 50);

    assert.deepStrictEqual(result, {
      page: 4,
      pageCount: 4,
      startIndex: 150,
      endIndex: 185,
      rows: rows.slice(150),
    });
  });

  it('clamps a stale page after a search, store change, or refresh reduces the result set', () => {
    const result = paginateMaintenanceRows(['a', 'b'], 4, 50);

    assert.deepStrictEqual(result, {
      page: 1,
      pageCount: 1,
      startIndex: 0,
      endIndex: 2,
      rows: ['a', 'b'],
    });
  });

  it('provides a stable empty window', () => {
    assert.deepStrictEqual(paginateMaintenanceRows([], 3, 50), {
      page: 1,
      pageCount: 0,
      startIndex: 0,
      endIndex: 0,
      rows: [],
    });
  });
});
