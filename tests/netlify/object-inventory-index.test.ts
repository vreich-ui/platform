/**
 * T5.1 R3 — the inventory projection, and the blob-operation COUNTS it exists
 * to change.
 *
 * T0.2 §4 cause #3 measured the old path as `T x list() + N x get()` per
 * inventory sweep, where T is the number of governed object types and every
 * `get` pulls a whole `ObjectRecord` envelope. The acceptance criterion for
 * this task is a before/after count, so the counts are ASSERTED here rather
 * than only written down: the fake store below tallies every `get`, `list` and
 * `setJSON`, and these tests pin what a cold sweep, a warm sweep and a sweep
 * after one edit each cost. A regression that reintroduces the per-record read
 * fails the suite instead of quietly costing production N blob reads a page
 * load again.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import {
  loadObjectIndex,
  sweepInventoryRows,
  OBJECT_INDEX_KEY,
  type ObjectIndexStore,
} from '../../packages/core/server/lib/objects/index-store.js';
import type { InventoryRow } from '../../packages/core/server/lib/object-inventory.js';
import { objectTypes, type ObjectRecord, type Principal } from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };

/** The number of `list()` calls a full sweep makes — one per governed type. */
const TYPE_COUNT = objectTypes.length;

const pageRecord = (id: string, revision = 1): ObjectRecord => ({
  object_id: id,
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  status: 'active',
  body: { route: `/${id}`, title: `Page ${id}`, sections: [] },
  publication: { published_time: null },
  history: [],
  version: revision,
  content_revision: revision,
});

/**
 * A store that counts operations and mints a fresh etag on every write — which
 * is what a real Netlify Blobs store does and what the projection's validity
 * check depends on. `etagMode: 'none'` reproduces the local file-backed shim
 * (`local-blobs.ts` reports `etag: ''`), where nothing is cacheable.
 */
const countingStore = (etagMode: 'real' | 'none' = 'real') => {
  const blobs = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  const counts = { get: 0, list: 0, set: 0 };

  const put = (key: string, value: unknown) => {
    etagSeq += 1;
    blobs.set(key, { value: JSON.stringify(value), etag: `etag-${etagSeq}` });
  };

  const store = {
    get: async (key: string) => {
      counts.get += 1;
      return blobs.get(key)?.value ?? null;
    },
    setJSON: async (key: string, value: unknown) => {
      counts.set += 1;
      put(key, value);
    },
    list: async (options?: { prefix?: string }) => {
      counts.list += 1;
      return {
        blobs: [...blobs.entries()]
          .filter(([key]) => key.startsWith(options?.prefix ?? ''))
          .map(([key, blob]) => ({ key, ...(etagMode === 'real' ? { etag: blob.etag } : { etag: '' }) })),
      };
    },
  } as unknown as ObjectVerbStore & ObjectIndexStore;

  return { store, counts, put, blobs };
};

const seedPages = (put: (key: string, value: unknown) => void, howMany: number) => {
  for (let i = 0; i < howMany; i += 1) {
    const id = `page_seed_${String(i).padStart(2, '0')}`;
    put(`objects/page/by-id/${id}.json`, pageRecord(id));
  }
};

const inventory = (store: ObjectVerbStore) =>
  handleObjectVerb(store, { action: 'inventory' } as ObjectVerbRequest, HUMAN, { nowMs: NOW });

const rowsOf = (result: { body: Record<string, unknown> }) => result.body.objects as InventoryRow[];
const statsOf = (result: { body: Record<string, unknown> }) =>
  result.body.index as { listed: number; cached: number; read: number; wrote: boolean };

// ═══ the measurement ══════════════════════════════════════════════════════

test('BEFORE/AFTER: a cold sweep reads every record; a warm sweep reads exactly one blob', async () => {
  const { store, counts, put } = countingStore();
  const N = 20;
  seedPages(put, N);

  // Cold: no index yet. This is the OLD cost, and it is what the projection
  // has to pay once — T list() + 1 index probe + N record reads.
  counts.get = 0;
  counts.list = 0;
  counts.set = 0;
  const cold = await inventory(store);
  assert.equal(cold.status, 200);
  assert.equal(rowsOf(cold).length, N);
  assert.equal(counts.list, TYPE_COUNT, 'one list() per governed object type, unchanged');
  assert.equal(counts.get, N + 1, `${N} record reads + 1 index probe — the pre-T5.1 cost`);
  assert.equal(counts.set, 1, 'the projection is persisted once');
  assert.deepEqual(statsOf(cold), { listed: N, cached: 0, read: N, wrote: true });

  // Warm: nothing changed, so nothing is read but the index itself. This is
  // the whole point of R3 — N record reads collapse to zero.
  counts.get = 0;
  counts.list = 0;
  counts.set = 0;
  const warm = await inventory(store);
  assert.equal(counts.list, TYPE_COUNT, 'the listings still happen — they name the live key set');
  assert.equal(counts.get, 1, 'ONE blob read for N objects (was N + 1)');
  assert.equal(counts.set, 0, 'an unchanged store costs zero writes');
  assert.deepEqual(statsOf(warm), { listed: N, cached: N, read: 0, wrote: false });

  // Same data, either way round.
  assert.deepEqual(rowsOf(warm), rowsOf(cold));
});

test('a record changed since the last sweep is re-read; the other N-1 are not', async () => {
  const { store, counts, put } = countingStore();
  seedPages(put, 10);
  await inventory(store);

  put('objects/page/by-id/page_seed_03.json', pageRecord('page_seed_03', 7));

  counts.get = 0;
  counts.set = 0;
  const after = await inventory(store);
  assert.equal(counts.get, 2, 'the index + exactly the one record whose etag moved');
  assert.equal(counts.set, 1, 'the projection is repaired');
  assert.deepEqual(statsOf(after), { listed: 10, cached: 9, read: 1, wrote: true });

  const changed = rowsOf(after).find((row) => row.object_id === 'page_seed_03');
  assert.equal(changed?.content_revision, 7, 'the cache must never serve the pre-edit row');
});

test('a deleted record leaves the index: it disappears from the rows and from the projection', async () => {
  const { store, put, blobs } = countingStore();
  seedPages(put, 5);
  await inventory(store);

  blobs.delete('objects/page/by-id/page_seed_02.json');
  const after = await inventory(store);

  assert.equal(rowsOf(after).length, 4);
  const index = await loadObjectIndex(store);
  assert.equal(index?.entries.length, 4, 'the projection converges on the live key set');
  assert.ok(!index?.entries.some((entry) => entry.key.includes('page_seed_02')));
});

// ═══ correctness the cache must not break ═════════════════════════════════

test('a lock is re-derived per read, never served from the projection', async () => {
  const { store, put } = countingStore();
  const held = pageRecord('page_locked');
  held.lock = {
    token: 'tok',
    owner_id: 'u1',
    owner_label: 'Wolf',
    acquired_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
  } as ObjectRecord['lock'];
  put('objects/page/by-id/page_locked.json', held);

  // First sweep: the lease is live.
  const during = await sweepInventoryRows(store, { nowMs: NOW });
  assert.deepEqual(during.rows[0]?.lock, {
    held: true,
    owner_id: 'u1',
    owner_label: 'Wolf',
    acquired_at: new Date(NOW).toISOString(),
    expires_at: new Date(NOW + 60_000).toISOString(),
  });

  // Second sweep, served entirely from the projection (nothing was written),
  // but an hour later. A lease expires WITHOUT anything being written, so a
  // cached `held: true` would be a real, silent bug.
  const later = await sweepInventoryRows(store, { nowMs: NOW + 3_600_000 });
  assert.equal(later.stats.read, 0, 'this row really did come from the projection');
  assert.deepEqual(later.rows[0]?.lock, { held: false });
});

test('a store whose listing carries no etags degrades to the old sweep and never writes the projection', async () => {
  const { store, counts, put } = countingStore('none');
  seedPages(put, 6);

  const first = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(first.rows.length, 6);
  assert.deepEqual(first.stats, { listed: 6, cached: 0, read: 6, wrote: false });

  counts.get = 0;
  counts.set = 0;
  const second = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(second.stats.read, 6, 'nothing is cacheable, so nothing is cached');
  assert.equal(counts.set, 0, 'and an unusable etag must never truncate a good index to nothing');
  assert.deepEqual(second.rows, first.rows);
});

test('an unparseable projection is ignored and rebuilt rather than throwing', async () => {
  const { store, put, blobs } = countingStore();
  seedPages(put, 3);
  blobs.set(OBJECT_INDEX_KEY, { value: '{not json', etag: 'etag-x' });

  const result = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(result.rows.length, 3);
  assert.equal(result.stats.read, 3, 'a corrupt index costs one full sweep, not an error');
  const index = await loadObjectIndex(store);
  assert.equal(index?.entries.length, 3);
});

test('an unreadable single record degrades that row only, exactly as the old sweep promised', async () => {
  const { store, put } = countingStore();
  seedPages(put, 4);
  const inner = store.get.bind(store);
  store.get = async (key: string) => {
    if (key.endsWith('page_seed_01.json')) throw new Error('transient blob failure');
    return inner(key);
  };

  const result = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(result.rows.length, 3, 'three good rows, not an exception');
});

test('a single-type sweep does not truncate the projection to that type', async () => {
  const { store, put } = countingStore();
  seedPages(put, 3);
  put('objects/theme/by-id/thm_one.json', {
    ...pageRecord('thm_one'),
    object_type: 'theme',
    schema_version: 'theme.v1',
  });
  await sweepInventoryRows(store, { nowMs: NOW });

  const pagesOnly = await sweepInventoryRows(store, { nowMs: NOW, objectType: 'page' });
  assert.equal(pagesOnly.rows.length, 3);

  const index = await loadObjectIndex(store);
  assert.equal(index?.entries.length, 4, 'the theme entry survives a page-only sweep');
});
