import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { purgeArchivedObjects, PURGE_GRACE_DAYS } from '../../packages/core/server/lib/object-purge.js';
import type { ObjectRecord } from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-09-01T00:00:00.000Z');
const daysAgo = (n: number) => new Date(NOW - n * 24 * 60 * 60 * 1000).toISOString();

const archived = (id: string, retiredAt: string, status: 'archived' | 'active' = 'archived'): ObjectRecord =>
  ({
    object_id: id,
    object_type: 'page',
    schema_version: 'page.v1',
    site: 'site_drlurie',
    created_at: daysAgo(90),
    updated_at: retiredAt,
    status,
    body: { pageType: 'system', route: `/${id}`, title: id, seo: {}, sections: [] },
    publication: { published_time: null },
    history: [{ at: retiredAt, action: 'retire', actor: { kind: 'agent', agent_name: 't', auth: 'publish_key' } }],
    version: 2,
    content_revision: 1,
  }) as unknown as ObjectRecord;

const createStore = (records: ObjectRecord[]) => {
  const data = new Map<string, string>();
  for (const record of records) {
    data.set(`objects/page/by-id/${record.object_id}.json`, JSON.stringify(record));
    data.set(`objects/page/index/by-status/${record.status}/${record.object_id}`, '');
  }
  return {
    data,
    get: async (key: string) => data.get(key) ?? null,
    // M0.1: the sweep now hands its deletes to `objects/record-writer.ts`,
    // which also arms the drift alarm and tries to amend the index. This fake
    // reports no etag, so the index commit correctly declines and the alarm
    // stays up for the next verified sweep — but the writes still have to land
    // somewhere, so the fake grew a `setJSON`.
    setJSON: async (key: string, value: unknown) => {
      data.set(key, JSON.stringify(value));
      return undefined;
    },
    delete: async (key: string) => {
      data.delete(key);
      return undefined;
    },
    list: async ({ prefix }: { prefix: string }) => ({
      blobs: [...data.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: '' })),
    }),
  };
};

test('purges only what has been archived longer than the 30-day grace period', async () => {
  const store = createStore([archived('page_old', daysAgo(31)), archived('page_recent', daysAgo(3))]);

  const result = await purgeArchivedObjects(store, {}, { nowMs: NOW });

  assert.deepEqual(
    result.purged.map((entry) => entry.object_id),
    ['page_old']
  );
  assert.deepEqual(
    result.retained.map((entry) => entry.object_id),
    ['page_recent']
  );
  assert.equal(result.grace_days, PURGE_GRACE_DAYS);

  // The old one is genuinely gone — record AND index key.
  assert.equal(store.data.has('objects/page/by-id/page_old.json'), false);
  assert.equal(store.data.has('objects/page/index/by-status/archived/page_old'), false);
  // The recent one is untouched.
  assert.ok(store.data.has('objects/page/by-id/page_recent.json'));
});

test('dry_run reports exactly what it would purge and deletes nothing', async () => {
  const store = createStore([archived('page_old', daysAgo(60))]);

  const result = await purgeArchivedObjects(store, { dry_run: true }, { nowMs: NOW });

  assert.equal(result.dry_run, true);
  assert.deepEqual(
    result.purged.map((entry) => entry.object_id),
    ['page_old']
  );
  assert.ok(store.data.has('objects/page/by-id/page_old.json'), 'dry_run must not delete');
});

test('an object restored to active is never purged, even with a stale archived index entry', async () => {
  const store = createStore([archived('page_back', daysAgo(90), 'archived')]);
  // Simulate a restore: the record is active again but the archived index entry lingers.
  const record = JSON.parse(store.data.get('objects/page/by-id/page_back.json') as string) as ObjectRecord;
  store.data.set('objects/page/by-id/page_back.json', JSON.stringify({ ...record, status: 'active' }));

  const result = await purgeArchivedObjects(store, {}, { nowMs: NOW });

  assert.equal(result.purged.length, 0);
  assert.ok(store.data.has('objects/page/by-id/page_back.json'), 'a live object survives the sweep');
});

test('a stale index entry whose record is already gone is swept without error', async () => {
  const store = createStore([archived('page_ghost', daysAgo(40))]);
  store.data.delete('objects/page/by-id/page_ghost.json');

  const result = await purgeArchivedObjects(store, {}, { nowMs: NOW });

  assert.equal(result.purged.length, 0);
  assert.equal(store.data.has('objects/page/index/by-status/archived/page_ghost'), false);
});
