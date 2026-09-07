import assert from 'node:assert/strict';
import test from 'node:test';

import { SEARCH_INDEX_KEY, sweepSearchDocs } from './search-index-store.js';
import type { ObjectType } from '../../../schema/object-record-v1.js';

const TYPES = ['content_item', 'page'] as const satisfies readonly ObjectType[];

const articleRecord = (id: string, slug: string, etagSuffix: string) => ({
  key: `objects/content_item/by-id/${id}.json`,
  etag: `etag-${etagSuffix}`,
  json: {
    object_id: id,
    object_type: 'content_item',
    schema_version: 'content_item.v1',
    site: 'site_drlurie',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    status: 'active',
    publication: { published_time: '2026-09-01T00:00:00.000Z' },
    history: [],
    version: 1,
    content_revision: 1,
    body: { slug, title: slug.replace(/-/g, ' '), nodes: [] },
  },
});

/**
 * A store that reports etags (unlike the local file-backed shim), so the
 * caching path this module exists for is actually exercised. Counts reads so a
 * test can assert that a repeat sweep touches no record.
 */
const fakeStore = (records: ReturnType<typeof articleRecord>[]) => {
  const blobs = new Map<string, { etag: string; body: string }>();
  for (const record of records) blobs.set(record.key, { etag: record.etag, body: JSON.stringify(record.json) });
  const reads: string[] = [];
  const writes: string[] = [];

  return {
    reads,
    writes,
    blobs,
    async get(key: string) {
      reads.push(key);
      return blobs.get(key)?.body ?? null;
    },
    async setJSON(key: string, value: unknown) {
      writes.push(key);
      blobs.set(key, { etag: `etag-index-${writes.length}`, body: JSON.stringify(value) });
      return undefined;
    },
    async list({ prefix }: { prefix: string }) {
      return {
        blobs: [...blobs.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, blob]) => ({ key, etag: blob.etag })),
      };
    },
  };
};

test('a cold sweep reads every record and persists the projection', async () => {
  const store = fakeStore([
    articleRecord('req_a', 'nac-for-skin-health', 'a1'),
    articleRecord('req_b', 'retinol-without-the-peeling', 'b1'),
  ]);

  const sweep = await sweepSearchDocs(store, { objectTypes: TYPES });

  assert.equal(sweep.docs.length, 2);
  assert.deepEqual(sweep.stats, { listed: 2, cached: 0, read: 2, wrote: true });
  assert.ok(store.writes.includes(SEARCH_INDEX_KEY));
});

test('a repeat sweep over an unedited library reads NO object records — the point of the index', async () => {
  const store = fakeStore([
    articleRecord('req_a', 'nac-for-skin-health', 'a1'),
    articleRecord('req_b', 'retinol-without-the-peeling', 'b1'),
  ]);
  await sweepSearchDocs(store, { objectTypes: TYPES });

  store.reads.length = 0;
  store.writes.length = 0;
  const second = await sweepSearchDocs(store, { objectTypes: TYPES });

  assert.equal(second.docs.length, 2);
  assert.deepEqual(second.stats, { listed: 2, cached: 2, read: 0, wrote: false });
  assert.deepEqual(store.reads, [SEARCH_INDEX_KEY], 'only the index itself should be read');
  assert.deepEqual(store.writes, [], 'an unchanged projection must not be rewritten');
});

test('a changed etag repairs exactly that one row, without a writer telling the index anything', async () => {
  const store = fakeStore([
    articleRecord('req_a', 'nac-for-skin-health', 'a1'),
    articleRecord('req_b', 'retinol-without-the-peeling', 'b1'),
  ]);
  await sweepSearchDocs(store, { objectTypes: TYPES });

  // A writer that knows nothing about this index edits the record in place.
  const edited = articleRecord('req_a', 'nac-and-glutathione', 'a2');
  store.blobs.set(edited.key, { etag: edited.etag, body: JSON.stringify(edited.json) });

  store.reads.length = 0;
  const third = await sweepSearchDocs(store, { objectTypes: TYPES });

  assert.deepEqual(third.stats, { listed: 2, cached: 1, read: 1, wrote: true });
  assert.equal(
    third.docs.find((doc) => doc.object_id === 'req_a')?.slug,
    'nac-and-glutathione',
    'the stale row must be repaired on read, not served'
  );
});

test('a narrow sweep keeps index entries for the types it did not list', async () => {
  const store = fakeStore([articleRecord('req_a', 'nac-for-skin-health', 'a1')]);
  await sweepSearchDocs(store, { objectTypes: TYPES });

  await sweepSearchDocs(store, { objectTypes: ['page'] as readonly ObjectType[] });

  const index = JSON.parse(store.blobs.get(SEARCH_INDEX_KEY)?.body ?? '{}') as { entries: { key: string }[] };
  assert.deepEqual(
    index.entries.map((entry) => entry.key),
    ['objects/content_item/by-id/req_a.json'],
    'searching one type must not force a cold rebuild of the rest'
  );
});

test('a store whose listing carries no etags degrades to enumeration and writes nothing', async () => {
  const store = fakeStore([articleRecord('req_a', 'nac-for-skin-health', '')]);
  store.blobs.set('objects/content_item/by-id/req_a.json', {
    etag: '',
    body: store.blobs.get('objects/content_item/by-id/req_a.json')?.body ?? '',
  });

  const sweep = await sweepSearchDocs(store, { objectTypes: TYPES });

  assert.equal(sweep.docs.length, 1, 'the search still works');
  assert.equal(sweep.stats.read, 1);
  assert.equal(sweep.stats.wrote, false, 'an unverifiable projection must never truncate a good index');
});

test('one unreadable record degrades that row, never the whole search', async () => {
  const store = fakeStore([
    articleRecord('req_a', 'nac-for-skin-health', 'a1'),
    articleRecord('req_b', 'retinol-without-the-peeling', 'b1'),
  ]);
  store.blobs.set('objects/content_item/by-id/req_b.json', { etag: 'b1', body: '{ not json' });

  const sweep = await sweepSearchDocs(store, { objectTypes: TYPES });

  assert.deepEqual(
    sweep.docs.map((doc) => doc.object_id),
    ['req_a']
  );
});
