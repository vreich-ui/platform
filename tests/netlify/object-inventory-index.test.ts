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
 *
 * ## M0 — the same file, one milestone later
 *
 * M0 turned the projection from VERIFIED (13 listings per read, every row
 * re-proved against the listing's etag) into TRUSTED (two blob reads, no
 * listing). That is only safe because M0.1 put every site-objects record write
 * behind ONE choke point, `packages/core/server/lib/objects/record-writer.ts`.
 * Three groups of tests were added below and they belong together:
 *
 *   - **the writer-pinning test**: a source scan that fails if a `.set` /
 *     `.setJSON` / `.delete` against a record key, a status marker,
 *     `objects/index.json` or `objects/version` appears anywhere outside the
 *     choke point. This is the test the trust rests on, so it lives with the
 *     counts it makes possible rather than in a file of its own (AGENTS.md §4:
 *     extend the existing test, never add a parallel one).
 *   - **the two-read acceptance**: a warm, unchanged store answers the whole
 *     inventory in exactly two blob reads and zero listings.
 *   - **the drift alarm**: what each interrupted or raced write leaves behind,
 *     and that the next read repairs it.
 *
 * ## M1 — the release snapshot, same law, same file
 *
 * M1 added a SECOND materialised document to this store,
 * `snapshots/release.json`, under the same discipline: one writer module
 * (`lib/release/snapshot-store.ts`), a stated staleness bound, and a read that
 * repairs rather than a script that migrates. Its writer is pinned by the SAME
 * scan below — `RELEASE_SNAPSHOT_KEY` is simply another entry in `KEY_HELPERS`
 * — because the scan is the mechanism, not the milestone, and AGENTS.md §4 says
 * extend the existing test rather than start a parallel one. The behavioural
 * cases for the snapshot live at the end of this file, next to the two-read
 * acceptance they build on: the release read's cost is the inventory's cost
 * plus one.
 *
 * ## M3 — two more snapshots, in two other stores, under the same scan
 *
 * `snapshots/chats.json` (the Agents hub) and `snapshots/members.json` (the
 * Admins list) are not in the site-objects store at all — they live in
 * `agent-chats` and `users`. They are pinned HERE anyway, by the same
 * `KEY_HELPERS` scan, because the scan walks `packages/core/server/**` rather
 * than one store, and the law it enforces — one module per materialised key —
 * is the wave's, not the store's. Their behavioural cases are at the end of
 * this file; both use the same `countingStore`, since what makes a snapshot
 * trustworthy is what the STORE can prove about a conditional write.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import {
  armObjectIndexWrite,
  commitObjectIndexEntries,
  loadObjectIndex,
  readInventoryRows,
  readObjectIndex,
  readObjectStoreVersion,
  sweepInventoryRows,
  OBJECT_INDEX_KEY,
  OBJECT_INDEX_SCHEMA_VERSION,
  OBJECT_VERSION_KEY,
  type ObjectIndexStore,
} from '../../packages/core/server/lib/objects/index-store.js';
import {
  deleteObjectRecord,
  putObjectRecord,
  retireObjectRecord,
  type ObjectRecordWriteStore,
} from '../../packages/core/server/lib/objects/record-writer.js';
import {
  buildReleaseSnapshot,
  deriveReleaseObjects,
  isReleaseSnapshotFresh,
  readReleaseRows,
  readReleaseSnapshot,
  refreshReleaseSnapshot,
  refreshReleaseSnapshotAfterWrite,
  releaseDeployFacts,
  writeReleaseSnapshot,
  RELEASE_ANCESTRY_CONCURRENCY,
  RELEASE_SNAPSHOT_KEY,
  RELEASE_SNAPSHOT_MAX_AGE_MS,
  type ReleaseSnapshot,
} from '../../packages/core/server/lib/release/snapshot-store.js';
import {
  chatDocKey,
  readChatList,
  saveChatDoc,
  type AgentChatStore,
  type ChatDoc,
} from '../../packages/core/server/lib/agent/chat-store.js';
import {
  readChatSnapshot,
  CHAT_SNAPSHOT_KEY,
} from '../../packages/core/server/lib/agent/chat-snapshot-view.js';
import {
  armChatSnapshotRow,
  chatRowNeedsCommit,
  chatSnapshotRow,
  CHAT_ROW_TOUCH_TOLERANCE_MS,
} from '../../packages/core/server/lib/agent/chat-snapshot-store.js';
import { visibleChatDocs } from '../../packages/core/server/lib/agent/chat-visibility.js';
import {
  countActiveOwners,
  listMembers,
  readMemberList,
} from '../../packages/core/server/lib/membership/read.js';
import { newMember, saveMember } from '../../packages/core/server/lib/membership/write.js';
import { scrubPerson } from '../../packages/core/server/lib/membership/offboarding.js';
import { KEYS, type MembershipStore } from '../../packages/core/server/lib/membership/store.js';
import {
  readMembersSnapshot,
  MEMBERS_SNAPSHOT_KEY,
} from '../../packages/core/server/lib/membership/snapshot-view.js';
import { armMembersSnapshot } from '../../packages/core/server/lib/membership/snapshot-store.js';
import { listUserRecords, memberToUserRecord } from '../../packages/core/server/lib/users-store.js';
import {
  readVisualIdentitySnapshot,
  readVisualIdentitySnapshotDoc,
  VISUAL_IDENTITY_OBJECT_TYPES,
  VISUAL_IDENTITY_SNAPSHOT_KEY,
  type VisualIdentitySnapshotStore,
} from '../../packages/core/server/lib/visual-identity/snapshot-store.js';
import {
  buildGovernanceSnapshot,
  cmsAgentHealthFromProbe,
  cmsAgentProbeView,
  loadGovernanceSnapshot,
  readGovernanceSnapshot,
  refreshGovernanceSnapshotAfterWrite,
  GOVERNANCE_SNAPSHOT_KEY,
  GOVERNANCE_SNAPSHOT_MAX_AGE_MS,
} from '../../packages/core/server/lib/governance/snapshot-store.js';
import { GOVERNANCE_DOC_KEY } from '../../packages/core/server/lib/governance-store.js';
import {
  analyticsSnapshotCoversWindow,
  analyticsSnapshotKey,
  analyticsWarmTargets,
  isAnalyticsSnapshotFresh,
  readAnalyticsSnapshot,
  refreshAnalyticsSnapshot,
  shouldWarmTarget,
  ANALYTICS_SNAPSHOT_MAX_AGE_MS,
  ANALYTICS_WARM_BUDGET_MS,
  ANALYTICS_WARM_RANGES,
  ANALYTICS_WARM_SOURCES,
} from '../../packages/core/server/lib/analytics/snapshot-store.js';
import { PLATFORM_ENV_NAMES } from '../../packages/core/server/lib/site-binding.js';
import { resetCommitAncestryMemoForTesting } from '../../packages/core/server/lib/production-release.js';
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
 * W4.1 — an article, since the `content` summary the variants surface reads is
 * projected from a `content_item` body and nothing else in this file has one.
 */
const articleRecord = (id: string, options: { slug: string; parent?: string }): ObjectRecord => ({
  ...pageRecord(id),
  object_id: id,
  object_type: 'content_item',
  schema_version: 'content_item.v1',
  body: {
    title: `Article ${id}`,
    slug: options.slug,
    ...(options.parent ? { lineage: { parent_content_id: options.parent } } : {}),
    scores: [
      { scored_by: 'agent:judge', at: '2026-08-10T00:00:00.000Z', framework: 'f', dimension: 'clarity', score: 3 },
      { scored_by: 'agent:judge', at: '2026-08-20T00:00:00.000Z', framework: 'f', dimension: 'clarity', score: 4 },
    ],
  },
});

/**
 * A store that counts operations and mints a fresh etag on every write — which
 * is what a real Netlify Blobs store does and what the projection's validity
 * check depends on. `etagMode: 'none'` reproduces the local file-backed shim
 * (`local-blobs.ts` reports `etag: ''`), where nothing is cacheable.
 *
 * M0 grew it three ways, each modelling something `@netlify/blobs` really
 * does and the old fake did not:
 *   - `getWithMetadata` answers the blob's etag, which is the only source of
 *     the compare-and-swap token the choke point's index write needs;
 *   - `setJSON` honours `onlyIfMatch` / `onlyIfNew` and answers
 *     `{ modified, etag }`, so a CAS refusal is a refusal here too;
 *   - `delete` exists, because purge goes through the choke point now.
 * Under `etagMode: 'none'` none of that is available — exactly the degradation
 * the local shim forces — and the writer can never disarm the drift alarm.
 */
const countingStore = (etagMode: 'real' | 'none' = 'real') => {
  const blobs = new Map<string, { value: string; etag: string }>();
  let etagSeq = 0;
  const counts = { get: 0, list: 0, set: 0, delete: 0 };

  const put = (key: string, value: unknown) => {
    etagSeq += 1;
    blobs.set(key, { value: JSON.stringify(value), etag: `etag-${etagSeq}` });
  };

  const store = {
    get: async (key: string) => {
      counts.get += 1;
      return blobs.get(key)?.value ?? null;
    },
    getWithMetadata: async (key: string) => {
      counts.get += 1;
      const blob = blobs.get(key);
      if (!blob) return null;
      return { data: blob.value, ...(etagMode === 'real' ? { etag: blob.etag } : {}) };
    },
    setJSON: async (key: string, value: unknown, options?: { onlyIfNew?: boolean; onlyIfMatch?: string }) => {
      counts.set += 1;
      const current = blobs.get(key);
      if (options?.onlyIfNew && current) return { modified: false };
      if (options?.onlyIfMatch !== undefined && current?.etag !== options.onlyIfMatch) return { modified: false };
      put(key, value);
      return { modified: true, ...(etagMode === 'real' ? { etag: blobs.get(key)?.etag } : {}) };
    },
    delete: async (key: string) => {
      counts.delete += 1;
      blobs.delete(key);
    },
    list: async (options?: { prefix?: string }) => {
      counts.list += 1;
      return {
        blobs: [...blobs.entries()]
          .filter(([key]) => key.startsWith(options?.prefix ?? ''))
          .map(([key, blob]) => ({ key, ...(etagMode === 'real' ? { etag: blob.etag } : { etag: '' }) })),
      };
    },
  } as unknown as ObjectVerbStore & ObjectIndexStore & ObjectRecordWriteStore;

  const reset = () => {
    counts.get = 0;
    counts.list = 0;
    counts.set = 0;
    counts.delete = 0;
  };

  return { store, counts, put, blobs, reset };
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
  result.body.index as {
    listed: number;
    cached: number;
    read: number;
    wrote: boolean;
    rebuilt: boolean;
    trusted: boolean;
  };

// ═══ the measurement ══════════════════════════════════════════════════════

test('M0 ACCEPTANCE: a cold read sweeps every record; a warm, unchanged read costs TWO blob reads and no listing', async () => {
  const { store, counts, put, reset } = countingStore();
  const N = 20;
  seedPages(put, N);

  // Cold: neither projection doc exists. This is the OLD cost, and it is what
  // the projection has to pay once — T list() + the two doc probes + N record
  // reads. (Pre-M0 it was N + 1: the drift alarm is the extra probe, and it is
  // read in PARALLEL with the index, so it is one round trip, not two.)
  reset();
  const cold = await inventory(store);
  assert.equal(cold.status, 200);
  assert.equal(rowsOf(cold).length, N);
  assert.equal(counts.list, TYPE_COUNT, 'one list() per governed object type, unchanged');
  assert.equal(counts.get, N + 2, `${N} record reads + objects/index.json + objects/version`);
  assert.equal(counts.set, 2, 'the projection and the alarm are persisted, in that order');
  assert.deepEqual(statsOf(cold), { listed: N, cached: 0, read: N, wrote: true, rebuilt: false, trusted: false });

  // Warm: the alarm agrees with the index, so the index IS the answer. This is
  // the M0 acceptance criterion — two blob reads for the whole inventory, and
  // not one `list()`.
  reset();
  const warm = await inventory(store);
  assert.equal(counts.get, 2, 'TWO blob reads for N objects: objects/index.json + objects/version');
  assert.equal(counts.list, 0, 'and NO listing at all — this is the whole of M0.2');
  assert.equal(counts.set, 0, 'an unchanged store costs zero writes');
  assert.deepEqual(statsOf(warm), { listed: N, cached: N, read: 0, wrote: false, rebuilt: false, trusted: true });

  // Same data, either way round.
  assert.deepEqual(rowsOf(warm), rowsOf(cold));
});

test('an edit through the choke point updates the index in place: the next read is still two blobs and shows the edit', async () => {
  const { store, counts, put, reset } = countingStore();
  seedPages(put, 10);
  await inventory(store);

  reset();
  const result = await putObjectRecord(store, { record: pageRecord('page_seed_03', 7), nowMs: NOW });
  assert.equal(result.index_committed, true, 'the row landed and the alarm came back down');

  reset();
  const after = await inventory(store);
  assert.equal(counts.get, 2, 'still two blob reads — a write does not cost the next reader a sweep');
  assert.equal(counts.list, 0);
  assert.deepEqual(statsOf(after), { listed: 10, cached: 10, read: 0, wrote: false, rebuilt: false, trusted: true });

  const changed = rowsOf(after).find((row) => row.object_id === 'page_seed_03');
  assert.equal(changed?.content_revision, 7, 'the index must never serve the pre-edit row');
});

test('a delete through the choke point drops the row; the read stays trusted', async () => {
  const { store, put } = countingStore();
  seedPages(put, 5);
  await inventory(store);

  const deleted = await deleteObjectRecord(store, { object_type: 'page', object_id: 'page_seed_02' }, { nowMs: NOW });
  assert.equal(deleted.index_committed, true);

  const after = await inventory(store);
  assert.equal(statsOf(after).trusted, true);
  assert.equal(rowsOf(after).length, 4);
  const index = await loadObjectIndex(store);
  assert.equal(index?.entries.length, 4, 'the projection converges on the live key set');
  assert.ok(!index?.entries.some((entry) => entry.key.includes('page_seed_02')));
});

test('a record changed BEHIND the choke point is invisible until the verified sweep runs — the blind spot the nightly rebuild covers', async () => {
  // `put` here is a rogue writer: it moves a record blob without arming the
  // drift alarm, which is exactly what a `.setJSON` outside
  // `objects/record-writer.ts` would do. The trusted read cannot see it — that
  // is the price of not listing — so this test states the price out loud and
  // pins the two things that pay it: the writer-pinning test below, and
  // `functions/object-index-rebuild.ts`.
  const { store, put } = countingStore();
  seedPages(put, 4);
  await inventory(store);

  put('objects/page/by-id/page_seed_01.json', pageRecord('page_seed_01', 9));

  const stale = await inventory(store);
  assert.equal(statsOf(stale).trusted, true);
  assert.equal(
    rowsOf(stale).find((row) => row.object_id === 'page_seed_01')?.content_revision,
    1,
    'the trusted read serves the row it was given; it did not list, so it cannot know'
  );

  // The nightly rebuild is the same verified sweep an untrusted read takes.
  const repaired = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(repaired.rows.find((row) => row.object_id === 'page_seed_01')?.content_revision, 9);
  const afterRebuild = await inventory(store);
  assert.equal(statsOf(afterRebuild).trusted, true, 'and the rebuild leaves the pair back in step');
  assert.equal(rowsOf(afterRebuild).find((row) => row.object_id === 'page_seed_01')?.content_revision, 9);
});

test('a record deleted behind the choke point disappears on the next verified sweep', async () => {
  const { store, put, blobs } = countingStore();
  seedPages(put, 5);
  await inventory(store);

  blobs.delete('objects/page/by-id/page_seed_02.json');
  const after = await sweepInventoryRows(store, { nowMs: NOW });

  assert.equal(after.rows.length, 4);
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
  assert.deepEqual(first.stats, { listed: 6, cached: 0, read: 6, wrote: false, rebuilt: false, trusted: false });

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

// ═══ W4.1: the schema bump heals itself ═══════════════════════════════════

test('the stored schema version is the one the row shape was bumped to', () => {
  // A row-shape change that does NOT move this string would serve rows from
  // entries projected under the old shape — the failure the bump exists to
  // stop. The literal is asserted so the bump is a deliberate act.
  assert.equal(OBJECT_INDEX_SCHEMA_VERSION, 'object-inventory-index.v2');
});

test('an index written under the OLD schema is detected on read, rebuilt in place, and matches a fresh build', async () => {
  // The reference: what a store with no index at all produces.
  const fresh = countingStore();
  seedPages(fresh.put, 5);
  fresh.put('objects/content_item/by-id/req_a.json', articleRecord('req_a', { slug: 'parent-slug' }));
  fresh.put('objects/content_item/by-id/req_b.json', articleRecord('req_b', { slug: 'clone-slug', parent: 'req_a' }));
  const expected = await sweepInventoryRows(fresh.store, { nowMs: NOW });

  // The same store, but carrying a v1 index whose entries are structurally
  // valid and whose etags MATCH the live blobs — the worst case, because
  // every row would be served from cache if the version were not checked.
  const aged = countingStore();
  seedPages(aged.put, 5);
  aged.put('objects/content_item/by-id/req_a.json', articleRecord('req_a', { slug: 'parent-slug' }));
  aged.put('objects/content_item/by-id/req_b.json', articleRecord('req_b', { slug: 'clone-slug', parent: 'req_a' }));
  await sweepInventoryRows(aged.store, { nowMs: NOW });
  const current = await loadObjectIndex(aged.store);
  assert.ok(current, 'a v2 index to age');
  aged.put(OBJECT_INDEX_KEY, {
    ...current,
    schema_version: 'object-inventory-index.v1',
    // The v1 row shape: no `content` summary on a content_item row.
    entries: current.entries.map((entry) => {
      const { content: _dropped, ...row } = entry.row as Record<string, unknown>;
      return { ...entry, row };
    }),
  });

  // Nobody runs anything: the next ordinary read repairs it.
  const healed = await sweepInventoryRows(aged.store, { nowMs: NOW });
  assert.equal(healed.stats.rebuilt, true, 'the discard is reported, never silent');
  assert.equal(healed.stats.cached, 0, 'not one row may be served from a superseded index');
  assert.equal(healed.stats.read, healed.stats.listed, 'every record is re-projected');
  assert.equal(healed.stats.wrote, true, 'and the repaired index is persisted by the same request');

  const byId = (rows: typeof healed.rows) => [...rows].sort((a, b) => a.object_id.localeCompare(b.object_id));
  assert.deepEqual(byId(healed.rows), byId(expected.rows), 'same rows as a store that never held an old index');

  const rebuilt = await loadObjectIndex(aged.store);
  assert.equal(rebuilt?.schema_version, OBJECT_INDEX_SCHEMA_VERSION);
  assert.equal(rebuilt?.entries.length, 7);

  // And the repair is once, not once per read.
  const afterHeal = await sweepInventoryRows(aged.store, { nowMs: NOW });
  assert.deepEqual(afterHeal.stats, { listed: 7, cached: 7, read: 0, wrote: false, rebuilt: false, trusted: false });
});

test('a cold store is not reported as a rebuild, but a corrupt index is', async () => {
  const cold = countingStore();
  seedPages(cold.put, 2);
  const first = await sweepInventoryRows(cold.store, { nowMs: NOW });
  assert.equal(first.stats.rebuilt, false, 'there was nothing to discard');

  const { store, put, blobs } = countingStore();
  seedPages(put, 2);
  blobs.set(OBJECT_INDEX_KEY, { value: '{not json', etag: 'etag-x' });
  const repaired = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(repaired.stats.rebuilt, true);
});

// ═══ M0.2: the drift alarm ════════════════════════════════════════════════

test('an interrupted write leaves the alarm armed, and the next read rebuilds', async () => {
  const { store, put, blobs, counts, reset } = countingStore();
  seedPages(put, 4);
  await inventory(store);
  assert.equal(statsOf(await inventory(store)).trusted, true, 'trusted to begin with');

  // Crash after step 1: the alarm is up and nothing else moved. This is the
  // shape that arming FIRST exists to catch — with the stamp written last, the
  // two docs would still agree here and a half-done write would read as done.
  const version = await readObjectStoreVersion(store);
  const index = await loadObjectIndex(store);
  assert.ok(version && index);
  blobs.set(OBJECT_VERSION_KEY, {
    value: JSON.stringify({ ...version, seq: index.seq + 1 }),
    etag: 'etag-armed',
  });

  reset();
  const after = await inventory(store);
  assert.equal(statsOf(after).trusted, false, 'an armed alarm is never trusted');
  assert.equal(counts.list, TYPE_COUNT, 'it falls through to the verified sweep');
  assert.equal(rowsOf(after).length, 4, 'and answers correctly from records');

  assert.equal(statsOf(await inventory(store)).trusted, true, 'one sweep, then trusted again');
});

test('a missing alarm doc is never trusted — which is how a pre-M0 store heals itself', async () => {
  const { store, put, blobs } = countingStore();
  seedPages(put, 3);
  await inventory(store);
  // Exactly what a store deployed before M0 looks like: a perfectly good
  // `objects/index.json` and no `objects/version` at all.
  blobs.delete(OBJECT_VERSION_KEY);

  const first = await inventory(store);
  assert.equal(statsOf(first).trusted, false, 'no alarm doc, no trust');
  assert.equal(rowsOf(first).length, 3);
  assert.equal(statsOf(await inventory(store)).trusted, true, 'and the same read wrote the pair');
});

test('the loser of a concurrent index commit writes nothing and leaves the alarm armed', async () => {
  const { store, put } = countingStore();
  seedPages(put, 3);
  await inventory(store);

  // Two writers that both read the index before either committed.
  const a = pageRecord('page_seed_00', 5);
  const b = pageRecord('page_seed_01', 6);
  const [first, second] = await Promise.all([
    putObjectRecord(store, { record: a, nowMs: NOW }),
    putObjectRecord(store, { record: b, nowMs: NOW }),
  ]);
  const committed = [first, second].filter((result) => result.index_committed);
  assert.ok(committed.length <= 1, 'compare-and-swap means at most one index write can land');

  /**
   * REVIEW (2026-09-16): this assertion used to be the other way round — "if
   * the read is trusted, exactly one commit landed" — which is satisfied by
   * the very bug it was meant to exclude. What matters is not how many writes
   * landed; it is that a TRUSTED answer is a COMPLETE one. Both records are
   * live in the store, so a trusted read must show both.
   */
  const rows = await inventory(store);
  if (statsOf(rows).trusted) {
    assert.equal(rowsOf(rows).find((row) => row.object_id === 'page_seed_00')?.content_revision, 5);
    assert.equal(rowsOf(rows).find((row) => row.object_id === 'page_seed_01')?.content_revision, 6);
  }
  // And either way the verified sweep converges on the truth.
  const repaired = await sweepInventoryRows(store, { nowMs: NOW });
  assert.equal(repaired.rows.find((row) => row.object_id === 'page_seed_00')?.content_revision, 5);
  assert.equal(repaired.rows.find((row) => row.object_id === 'page_seed_01')?.content_revision, 6);
});

/**
 * REVIEW (2026-09-16) — the two interleavings that used to produce a TRUSTED
 * index missing a live record. Both are written without `Promise.all`, because
 * the defect is not a scheduling accident: it is what the seq comparison meant
 * on its own, and a test that depends on microtask order proves nothing.
 *
 * Failure mode before the fix, in both: `readInventoryRows` answered
 * `trusted: true` and the record written by the writer that could not commit
 * was simply absent from the library — until the nightly `object-index-rebuild`.
 */
test('REVIEW: a write that starts while another is armed cannot be disarmed by that other write', async () => {
  const { store, put } = countingStore();
  seedPages(put, 3);
  await inventory(store);
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, true, 'warm baseline');

  // A arms and is now between its arm and its commit.
  const leaseA = await armObjectIndexWrite(store, NOW);
  assert.equal(leaseA.armed, true);

  // B is a whole record write that begins inside A's window. Its record lands;
  // its row cannot, because the index it can see is missing whatever A is doing.
  const b = await putObjectRecord(store, { record: pageRecord('page_seed_01', 6), nowMs: NOW });
  assert.equal(b.index_committed, false, 'B must not amend an index it knows is mid-flight');

  // A finishes. Its commit must NOT be allowed to read as a complete index.
  await commitObjectIndexEntries(store, leaseA, { upserts: [], nowMs: NOW });

  const read = await readInventoryRows(store, { nowMs: NOW });
  assert.equal(read.stats.trusted, false, "A's commit cannot vouch for a row it never saw");
  assert.equal(read.rows.find((row) => row.object_id === 'page_seed_01')?.content_revision, 6);

  // And the repair puts the pair back in step, alarm down.
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, true);
});

test('REVIEW: the loser of the index compare-and-swap re-arms, so its record is never hidden', async () => {
  const { store, put } = countingStore();
  seedPages(put, 3);
  await inventory(store);

  // Exactly what two writers held when both read the index before either
  // committed: the same entries, the same seq, the same compare-and-swap token.
  const { index, etag } = await readObjectIndex(store);
  assert.ok(index && etag);
  const lease = { entries: index.entries, indexSeq: index.seq, etag, armed: true } as const;

  assert.equal(await commitObjectIndexEntries(store, { ...lease }, { upserts: [], nowMs: NOW }), true, 'A wins');
  assert.equal(await commitObjectIndexEntries(store, { ...lease }, { upserts: [], nowMs: NOW }), false, 'B loses');

  assert.equal((await readObjectStoreVersion(store))?.armed, true, 'the loser must re-arm the alarm');
  assert.equal(
    (await readInventoryRows(store, { nowMs: NOW })).stats.trusted,
    false,
    'a refused commit leaves an index nobody may trust'
  );
  // Self-healing, not a dead end: the sweep clears the flag.
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, true);
});

test('REVIEW: the sticky alarm flag is what a trusted read checks, and only a full sweep clears it', async () => {
  const { store, put } = countingStore();
  seedPages(put, 3);
  await inventory(store);
  const index = await loadObjectIndex(store);
  assert.ok(index);

  // Seqs agreeing is no longer enough on its own.
  await store.setJSON(OBJECT_VERSION_KEY, {
    schema_version: 'object-store-version.v1',
    seq: index.seq,
    updated_at: new Date(NOW).toISOString(),
    armed: true,
  });
  // A PARTIAL read may not clear it — it can only ever verify one type, so it
  // cannot answer for the whole index the flag is about.
  assert.equal((await readInventoryRows(store, { nowMs: NOW, objectType: 'page' })).stats.trusted, false);
  assert.equal((await readObjectStoreVersion(store))?.armed, true);
  // The FULL read is the repair: it re-derives every row from the records.
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, false, 'the repairing read');
  assert.notEqual((await readObjectStoreVersion(store))?.armed, true);
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, true);
});

test('a store that cannot report an etag never disarms the alarm, and never serves a trusted index', async () => {
  // The local file-backed shim, and every fake that predates conditional
  // writes. The choke point must degrade to "the sweep repairs it", never to
  // "write the index anyway and hope".
  const { store, put } = countingStore('none');
  seedPages(put, 3);

  const written = await putObjectRecord(store, { record: pageRecord('page_seed_00', 4), nowMs: NOW });
  assert.equal(written.index_committed, false, 'no etag, no compare-and-swap, no index write');

  const result = await readInventoryRows(store, { nowMs: NOW });
  assert.equal(result.stats.trusted, false);
  assert.equal(result.rows.find((row) => row.object_id === 'page_seed_00')?.content_revision, 4);
});

test('a partial (single-type) read may serve from a trusted index, but a partial SWEEP may never disarm the alarm', async () => {
  const { store, put, counts, reset } = countingStore();
  seedPages(put, 3);
  put('objects/theme/by-id/thm_one.json', { ...pageRecord('thm_one'), object_type: 'theme', schema_version: 'theme.v1' });
  await inventory(store);

  // Trusted: one `seq` comparison vouched for the whole index, so narrowing to
  // one type is a filter over what is already proved, not a second decision.
  reset();
  const pagesOnly = await readInventoryRows(store, { nowMs: NOW, objectType: 'page' });
  assert.equal(pagesOnly.stats.trusted, true);
  assert.equal(counts.get, 2);
  assert.equal(counts.list, 0);
  assert.equal(pagesOnly.rows.length, 3);

  // Untrusted: a partial sweep verified ONE type and carried the rest over. It
  // cannot promise the whole index is current, so it must leave the alarm
  // exactly as it found it.
  const index = await loadObjectIndex(store);
  assert.ok(index);
  const armedAt = index.seq + 1;
  await store.setJSON(OBJECT_VERSION_KEY, {
    schema_version: 'object-store-version.v1',
    seq: armedAt,
    updated_at: new Date(NOW).toISOString(),
  });
  const partial = await readInventoryRows(store, { nowMs: NOW, objectType: 'page' });
  assert.equal(partial.stats.trusted, false);
  assert.equal((await readObjectStoreVersion(store))?.seq, armedAt, 'the alarm is still armed');
  assert.equal((await loadObjectIndex(store))?.seq, index.seq, 'and the index seq did not move to meet it');

  // A FULL read is what puts them back in step.
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, false, 'the repairing read');
  assert.equal((await readInventoryRows(store, { nowMs: NOW })).stats.trusted, true);
});

test('a retire moves the status marker and the index row in one call', async () => {
  const { store, put, blobs } = countingStore();
  seedPages(put, 2);
  put('objects/page/index/by-status/active/page_seed_00', '');
  await inventory(store);

  const archived = { ...pageRecord('page_seed_00'), status: 'archived' as const };
  await retireObjectRecord(store, { record: archived, previous_status: 'active', nowMs: NOW });

  assert.ok(blobs.has('objects/page/index/by-status/archived/page_seed_00'), 'the archived marker is written');
  assert.ok(!blobs.has('objects/page/index/by-status/active/page_seed_00'), 'the active marker is removed');
  const after = await inventory(store);
  assert.equal(after.status, 200);
  assert.equal(rowsOf(after).find((row) => row.object_id === 'page_seed_00')?.status, 'archived');
});

// ═══ M0.1: the writer-pinning test ════════════════════════════════════════

/**
 * The law the trusted read rests on: `objects/record-writer.ts` is the ONLY
 * module that writes a site-objects record or its status marker, and
 * `objects/index-store.ts` is the ONLY module that writes the two projection
 * docs. A `.setJSON` anywhere else would change a record without arming the
 * drift alarm — and a trusted read, which does not list, cannot see that.
 *
 * Scanned as SOURCE rather than as behaviour because behaviour cannot prove a
 * negative: no fixture can demonstrate that the eleventh writer nobody has
 * written yet routes through the choke point. Two rules:
 *
 *   1. a write or delete whose KEY names `objectRecordKey`,
 *      `objectStatusIndexKey`, `OBJECT_INDEX_KEY` or `OBJECT_VERSION_KEY`
 *      belongs to the one module that owns that key;
 *   2. inside the modules that HANDLE object records, a write or delete whose
 *      key is a bare local identifier (`key`, `recordKey` — the shape every
 *      migrated call site had) is banned outright, because rule 1 cannot see
 *      through `const key = objectRecordKey(...)` or through a `recordKey`
 *      that arrived as a function parameter, which is how `object-lock.ts`
 *      wrote records for a year.
 *
 * Limits, stated rather than hidden: comments are stripped with the usual
 * regexes, so a block-comment CLOSER inside a string literal could in principle
 * end a comment early (the same hazard
 * `tests/scripts/core-no-site-literals.test.mjs` documents at length), and a
 * write reached through an aliased store variable
 * whose key is built in another file is out of reach of any source scan. What
 * the rules DO cover is every shape that has ever existed in this repo.
 */
/**
 * `npm test` compiles this file into `.tmp/ci-test/` and runs it from there, so
 * a path relative to `import.meta.url` lands in a tree of COMPILED `.js` and
 * the scan would silently find nothing to scan. Walk up to the real repo root
 * instead, and assert it was found — a vacuous invariant test is worse than no
 * test, because it reads green.
 */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'packages', 'core', 'server', 'lib', 'objects', 'index-store.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('object-inventory-index.test: could not locate the repo root to scan.');
};
const SERVER_ROOT = join(repoRoot(), 'packages', 'core', 'server');

/** The one module allowed to write a record blob or a status marker. */
const RECORD_WRITER = 'lib/objects/record-writer.ts';
/**
 * The one module allowed to write `objects/index.json` and `objects/version`.
 * It is the DOCUMENT layer, not the sweep: `index-store.ts` reaches the two
 * blobs only through the helpers exported here, which is what lets a writer
 * import the documents without importing the listing machinery.
 */
const INDEX_WRITER = 'lib/objects/index-doc.ts';
/**
 * M1: the one module allowed to write `snapshots/release.json`. Three callers
 * write release state — `object-publish.ts` after a publish stamp,
 * `mcp-tool-handlers.ts` and `functions/admin-release.ts` after a release hook
 * fires — and a fourth (`functions/release-snapshot-refresh.ts`) on a schedule.
 * All four go through `refreshReleaseSnapshot`; a `.setJSON` against the key
 * anywhere else would put a snapshot in the store that no reader can date.
 */
const RELEASE_SNAPSHOT_WRITER = 'lib/release/snapshot-store.ts';
/**
 * M3.3: the one module allowed to write `snapshots/visual-identity.json`. Like
 * `objects/index-doc.ts` it is the DOCUMENT layer, not the rebuild:
 * `visual-identity/snapshot-store.ts` reaches the blob only through the
 * helpers exported here, which is what lets the record-write choke point amend
 * the snapshot without importing four `store.list()` calls into `admin-users`'
 * cold start. INTEGRATE: the separate `snapshots/visual-identity.version`
 * alarm blob this milestone shipped is gone — the alarm is inside the document
 * now, on `snapshots/guarded-doc.ts`, so there is one key here, not two.
 */
const VISUAL_IDENTITY_SNAPSHOT_WRITER = 'lib/visual-identity/snapshot-doc.ts';

/**
 * M3.1: the one module allowed to write `snapshots/chats.json`. Every chat
 * document write goes through `agent/chat-store.ts`'s `saveChatDoc`, which
 * arms and commits through this module; the transcript-sweep REBUILD is in
 * `chat-store.ts` and calls `writeRebuiltChatSnapshot` here rather than
 * writing the key, which is what keeps this scan meaningful.
 */
const CHAT_SNAPSHOT_WRITER = 'lib/agent/chat-snapshot-store.ts';
/**
 * M3.2: the one module allowed to write `snapshots/members.json`. Three record
 * writers amend it — `membership/write.ts`'s `saveMember` and
 * `stampOnboarding`, and `membership/offboarding.ts`'s `scrubPerson` — and
 * `membership/read.ts` rebuilds it after a sweep; all four go through here.
 */
const MEMBERS_SNAPSHOT_WRITER = 'lib/membership/snapshot-store.ts';
/**
 * M3.4: the one module allowed to write `snapshots/governance.json`. Two
 * writers of two halves is exactly the shape that breaks a blob — the
 * governance write paths know the document and not the probe, the five-minute
 * `functions/governance-probe-refresh.ts` knows the probe and not the
 * document — so neither writes a half: both call this module, which always
 * writes a whole snapshot and carries the half its caller did not bring.
 */
const GOVERNANCE_SNAPSHOT_WRITER = 'lib/governance/snapshot-store.ts';
/**
 * M4: the one module allowed to write `snapshots/analytics/<source>/<range>.json`.
 * Two callers — `functions/admin-analytics.ts` on a cold read or a background
 * revalidation, and `functions/analytics-snapshot-warm.ts` hourly — and both
 * go through `refreshAnalyticsSnapshot`. A `.setJSON` against the key helper
 * anywhere else would put a feed in the store that no reader can date, which
 * is the one thing stale-while-revalidate cannot tolerate: serving stale data
 * is fine, serving data of unknown age is not.
 */
const ANALYTICS_SNAPSHOT_WRITER = 'lib/analytics/snapshot-store.ts';

const walkTs = (dir: string, out: string[] = []): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walkTs(full, out);
    else if (name.endsWith('.ts') && !name.endsWith('.test.ts')) out.push(full);
  }
  return out;
};

const stripComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

type StoreWrite = { receiver: string; method: string; key: string };

/** Every `<receiver>.<method>(<key>` in the file, with the key argument extracted at paren depth 0. */
const storeWrites = (source: string): StoreWrite[] => {
  const found: StoreWrite[] = [];
  const call = /([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*)\s*\.\s*(set|setJSON|delete|del)\s*\(/g;
  let match: RegExpExecArray | null;
  while ((match = call.exec(source))) {
    let depth = 0;
    let i = match.index + match[0].length;
    const start = i;
    for (; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(' || ch === '[' || ch === '{') depth += 1;
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth === 0) break;
        depth -= 1;
      } else if (ch === ',' && depth === 0) break;
    }
    found.push({ receiver: match[1] as string, method: match[2] as string, key: source.slice(start, i).trim() });
  }
  return found;
};

/**
 * A blob store, as opposed to a `Map`. The distinction matters because
 * `memo.set(cacheKey, …)` and `store.set(key, bytes)` are the same five
 * characters: `.setJSON` only ever belongs to a blob store, and a bare `.set`
 * counts only when the receiver says so.
 */
const isStoreWrite = (write: StoreWrite): boolean =>
  write.method === 'setJSON' || (write.method === 'set' && /store|blobs/i.test(write.receiver));

const isStoreDelete = (write: StoreWrite): boolean =>
  (write.method === 'delete' || write.method === 'del') && /store|blobs/i.test(write.receiver);

const KEY_HELPERS: Array<{ token: string; owner: string }> = [
  { token: 'objectRecordKey', owner: RECORD_WRITER },
  { token: 'objectStatusIndexKey', owner: RECORD_WRITER },
  { token: 'OBJECT_INDEX_KEY', owner: INDEX_WRITER },
  { token: 'OBJECT_VERSION_KEY', owner: INDEX_WRITER },
  { token: 'RELEASE_SNAPSHOT_KEY', owner: RELEASE_SNAPSHOT_WRITER },
  { token: 'CHAT_SNAPSHOT_KEY', owner: CHAT_SNAPSHOT_WRITER },
  { token: 'MEMBERS_SNAPSHOT_KEY', owner: MEMBERS_SNAPSHOT_WRITER },
  { token: 'VISUAL_IDENTITY_SNAPSHOT_KEY', owner: VISUAL_IDENTITY_SNAPSHOT_WRITER },
  { token: 'GOVERNANCE_SNAPSHOT_KEY', owner: GOVERNANCE_SNAPSHOT_WRITER },
  { token: 'analyticsSnapshotKey', owner: ANALYTICS_SNAPSHOT_WRITER },
];

const BARE_IDENTIFIER = /^[a-z][A-Za-z0-9_]*$/;

test('WRITER PINNING: only the choke point writes a record key, a status marker or a projection doc', () => {
  const violations: string[] = [];
  const files = walkTs(SERVER_ROOT);
  assert.ok(files.length > 100, `the scan must actually reach the sources (found ${files.length})`);
  assert.ok(
    files.some((file) => file.endsWith(join('objects', 'record-writer.ts'))),
    'the choke point itself must be inside the scanned tree'
  );

  for (const file of files) {
    const rel = relative(SERVER_ROOT, file).split(sep).join('/');
    const source = stripComments(readFileSync(file, 'utf8'));
    const writes = storeWrites(source);

    // Rule 1 — a key named after a record/marker/projection helper.
    for (const write of writes) {
      for (const helper of KEY_HELPERS) {
        if (!write.key.includes(helper.token)) continue;
        if (rel === helper.owner) continue;
        violations.push(`${rel}: .${write.method}(${write.key}) — ${helper.token} belongs to ${helper.owner}`);
      }
    }

    // Rule 2a — inside a module that HANDLES object records, a write to a bare
    // local key. Derived, not hand-kept: any file that imports the record-key
    // helpers is in, plus `object-lock.ts`, which takes the key as an argument.
    const handlesRecords =
      /from '[^']*object-store-keys\.js'/.test(source) &&
      /object(Record|StatusIndex)Key/.test(source.split('\n').filter((line) => line.includes('import')).join('\n'));
    const objectModule = /^lib\/(object-[a-z-]+|objects\/[a-z-]+)\.ts$/.test(rel);
    if ((handlesRecords || rel === 'lib/object-lock.ts') && rel !== RECORD_WRITER) {
      for (const write of writes) {
        if (!isStoreWrite(write)) continue;
        if (!BARE_IDENTIFIER.test(write.key)) continue;
        violations.push(`${rel}: .${write.method}(${write.key}, …) — route record writes through ${RECORD_WRITER}`);
      }
    }

    // Rule 2b — the same for DELETES, but only inside `lib/object-*.ts` and
    // `lib/objects/*.ts`: elsewhere a bare-key `.delete` is routinely a Map or
    // another store entirely (`membership/offboarding.ts`'s key remover).
    if (objectModule && rel !== RECORD_WRITER) {
      for (const write of writes) {
        if (!isStoreDelete(write)) continue;
        if (!BARE_IDENTIFIER.test(write.key)) continue;
        violations.push(`${rel}: .${write.method}(${write.key}) — route record deletes through ${RECORD_WRITER}`);
      }
    }
  }

  assert.deepEqual(violations, [], `site-objects record writes outside the choke point:\n${violations.join('\n')}`);
});

test('every pinned key has a real owner module, and that module really writes', () => {
  // A `KEY_HELPERS` entry naming a file that does not exist, or one that names
  // the key and never writes anything, pins nothing while reading green. The
  // check is deliberately two-part rather than "writes THIS token": the choke
  // point spells `const key = objectRecordKey(…)` and writes `key`, which is
  // the very shape rule 2 exists to police inside that one file.
  for (const { token, owner } of KEY_HELPERS) {
    const file = join(SERVER_ROOT, ...owner.split('/'));
    assert.ok(existsSync(file), `${owner} (owner of ${token}) is not in the scanned tree`);
    const source = stripComments(readFileSync(file, 'utf8'));
    assert.ok(source.includes(token), `${owner} is pinned as the writer of ${token} but never names it`);
    assert.ok(
      storeWrites(source).some(isStoreWrite),
      `${owner} is pinned as a writer but makes no store write at all`
    );
  }
});

test('the writer-pinning scan actually fires — the shapes every migrated call site had', () => {
  // Proof that the rules above are not vacuous. Each of these is a real line
  // this wave removed, and each must be rejected by the same scanner that
  // passed over the live tree.
  const shapes = [
    "await store.setJSON(objectRecordKey(objectType, id), record);",
    "await store.setJSON(objectStatusIndexKey(objectType, 'active', id), OBJECT_STORE_MARKER_VALUE);",
    "await store.setJSON(OBJECT_INDEX_KEY, index);",
    "await store.setJSON(OBJECT_VERSION_KEY, stamp);",
    'await store.setJSON(RELEASE_SNAPSHOT_KEY, snapshot);',
    'await store.setJSON(CHAT_SNAPSHOT_KEY, doc, guard);',
    'await store.setJSON(MEMBERS_SNAPSHOT_KEY, doc);',
    'await store.setJSON(VISUAL_IDENTITY_SNAPSHOT_KEY, snapshot);',
    'await store.setJSON(GOVERNANCE_SNAPSHOT_KEY, snapshot);',
    'await store.setJSON(analyticsSnapshotKey(source, range), snapshot);',
  ];
  for (const shape of shapes) {
    const writes = storeWrites(stripComments(shape));
    assert.equal(writes.length, 1, shape);
    assert.ok(
      KEY_HELPERS.some((helper) => (writes[0] as { key: string }).key.includes(helper.token)),
      `rule 1 must reject: ${shape}`
    );
  }

  for (const shape of ['await store.setJSON(key, record);', 'await store.setJSON(recordKey, nextRecord);']) {
    const write = storeWrites(stripComments(shape))[0] as StoreWrite;
    assert.ok(isStoreWrite(write), `rule 2 must see a store write in: ${shape}`);
    assert.ok(BARE_IDENTIFIER.test(write.key), `rule 2 must reject: ${shape}`);
  }

  // …and does not fire on the writes that legitimately remain in the same
  // files: a doc key, another store's key, a member expression.
  for (const shape of [
    'await store.setJSON(SITE_REDIRECTS_DOC_KEY, table);',
    'await options.agentLearningStore.setJSON(agentLearningRecordKey(t, id, at), trail);',
    'await store.setJSON(blob.key, null);',
  ]) {
    const key = (storeWrites(stripComments(shape))[0] as StoreWrite).key;
    assert.ok(!BARE_IDENTIFIER.test(key), `rule 2 must NOT fire on: ${shape}`);
    assert.ok(!KEY_HELPERS.some((helper) => key.includes(helper.token)), `rule 1 must NOT fire on: ${shape}`);
  }

  // A `Map` is not a store. This is the discrimination that keeps the scan
  // usable: `memo.set(cacheKey, …)` lives in files that also handle records.
  for (const shape of ['memo.set(cacheKey, entry);', 'repaired.set(requestId, row);']) {
    assert.ok(!isStoreWrite(storeWrites(stripComments(shape))[0] as StoreWrite), `must not read as a store write: ${shape}`);
  }
});

// ═══ M1: the release snapshot ═════════════════════════════════════════════

/**
 * `snapshots/release.json` lives in the same store, under the same law, and its
 * cost is stated against the same baseline: a warm release read is the trusted
 * inventory's two blob reads PLUS one, and nothing else — no listing, and (the
 * point of the whole milestone) no Netlify or GitHub call.
 *
 * The fake `fetch` below is not decoration. The defect M1 removes is external
 * API calls on a page path, and the only way a test can pin that is to make any
 * outbound call an explicit failure.
 */
const publishedPage = (id: string, commit: string, revision = 1): ObjectRecord => ({
  ...pageRecord(id, revision),
  publication: {
    published_time: '2026-08-20T00:00:00.000Z',
    publish_receipt: { content_revision: revision, commit_sha: commit } as ObjectRecord['publication']['publish_receipt'],
  },
});

const withNoNetwork = async <T>(fn: () => Promise<T>): Promise<T> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    throw new Error(`M1: no outbound call is allowed here (attempted ${String(input)})`);
  }) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = realFetch;
  }
};

const snapshotOf = (blobs: Map<string, { value: string }>): ReleaseSnapshot =>
  JSON.parse(blobs.get(RELEASE_SNAPSHOT_KEY)?.value ?? 'null') as ReleaseSnapshot;

test('M1 ACCEPTANCE: a warm release read is the inventory read PLUS ONE blob — no listing, no outbound call', async () => {
  const { store, counts, put, blobs, reset } = countingStore();
  put('objects/page/by-id/page_a.json', publishedPage('page_a', 'commit_live'));
  put('objects/page/by-id/page_b.json', pageRecord('page_b'));

  // Warm the projection, then materialise the snapshot the way the schedule does.
  await inventory(store);
  await withNoNetwork(() =>
    refreshReleaseSnapshot(store, { nowMs: NOW, source: 'schedule', carryDeploy: true })
  );

  reset();
  const [snapshot, rows] = await withNoNetwork(() =>
    Promise.all([readReleaseSnapshot(store), readReleaseRows(store, NOW)])
  );

  // THE measurement: objects/index.json + objects/version + snapshots/release.json.
  assert.equal(counts.get, 3, 'a warm release read is exactly three blob reads');
  assert.equal(counts.list, 0, 'no listing may happen on the release read path');
  assert.equal(counts.set, 0, 'a read may not write');
  assert.ok(snapshot, 'the snapshot must be servable');
  assert.deepEqual(
    rows.map((row) => row.object_id),
    ['page_a', 'page_b']
  );
  // And the join the read path performs is pure — same rows, same deploy facts.
  assert.deepEqual(
    deriveReleaseObjects(rows, releaseDeployFacts(snapshot as ReleaseSnapshot)).map((object) => object.state),
    ['published', 'draft']
  );
  assert.equal(snapshotOf(blobs).objects.length, 2);
});

test('M1: a publish-path refresh carries the deploy facts forward and makes no outbound call', async () => {
  const { store, put, blobs } = countingStore();
  put('objects/page/by-id/page_a.json', publishedPage('page_a', 'commit_live'));
  await inventory(store);

  // A full snapshot as the schedule would have left it: production is live on
  // `commit_live`, and page_a's export is in it.
  await writeReleaseSnapshot(store, {
    schema_version: 'release-snapshot.v1',
    as_of: new Date(NOW - 30_000).toISOString(),
    source: 'schedule',
    deploy: {
      configured: true,
      production_confirmed: true,
      live_commit: 'commit_live',
      latest: {
        id: 'dep_1',
        commit: 'commit_live',
        status: 'ready',
        started_at: new Date(NOW - 60_000).toISOString(),
        finished_at: new Date(NOW - 45_000).toISOString(),
        production_url: 'https://example.invalid',
      },
      published: null,
      included_commits: ['commit_live'],
      ancestry_truncated: false,
    },
    objects: [],
    waiting_count: 0,
    pending_approval_count: 0,
  });

  // A second object publishes DARK — its export commit is on main behind
  // `[skip netlify]` and is NOT in the live build. Through the choke point,
  // because that is what a publish stamp does (`object-publish.ts` step 5) and
  // because a trusted read cannot see a write that skipped it.
  await putObjectRecord(store, { record: publishedPage('page_b', 'commit_dark'), nowMs: NOW });
  await withNoNetwork(() =>
    refreshReleaseSnapshotAfterWrite(store, { nowMs: NOW, source: 'publish', carryDeploy: true })
  );

  const next = snapshotOf(blobs);
  assert.equal(next.source, 'publish');
  assert.equal(next.as_of, new Date(NOW).toISOString(), 'the refresh re-stamps as_of');
  // Carried, not re-fetched.
  assert.equal(next.deploy.live_commit, 'commit_live');
  assert.equal(next.deploy.latest?.id, 'dep_1');
  assert.deepEqual(next.deploy.included_commits, ['commit_live']);
  // And the thing the publish DID change is in it: page_a is live, page_b is
  // published-and-waiting, which is exactly what "publish ≠ release" means.
  assert.deepEqual(
    Object.fromEntries(next.objects.map((object) => [object.object_id, object.state])),
    { page_a: 'live', page_b: 'published' }
  );
  assert.equal(next.waiting_count, 1);
});

test('M1: an absent, unparseable, wrong-schema or stale snapshot is never served — the read rebuilds instead', async () => {
  const { store, put } = countingStore();
  put('objects/page/by-id/page_a.json', pageRecord('page_a'));

  assert.equal(await readReleaseSnapshot(store), undefined, 'a cold store has no snapshot');

  put(RELEASE_SNAPSHOT_KEY, 'not json at all');
  assert.equal(await readReleaseSnapshot(store), undefined, 'an unparseable snapshot is not a snapshot');

  await withNoNetwork(() => refreshReleaseSnapshot(store, { nowMs: NOW, source: 'schedule', carryDeploy: true }));
  const fresh = (await readReleaseSnapshot(store)) as ReleaseSnapshot;
  assert.ok(fresh);

  // The stated bound, asserted at both edges: inside it the blob is served,
  // outside it the read rebuilds. This is the only staleness window M1 has,
  // and `as_of` puts it on the wire and in the UI.
  assert.equal(isReleaseSnapshotFresh(fresh, NOW + RELEASE_SNAPSHOT_MAX_AGE_MS - 1), true);
  assert.equal(isReleaseSnapshotFresh(fresh, NOW + RELEASE_SNAPSHOT_MAX_AGE_MS + 1), false);

  // A schema bump is detected on read, exactly as objects/index.json's is.
  put(RELEASE_SNAPSHOT_KEY, { ...fresh, schema_version: 'release-snapshot.v0' });
  assert.equal(await readReleaseSnapshot(store), undefined);
});

test('M1: the GitHub ancestry fan-out is bounded — at most four in flight, and it stops at the wall clock', async () => {
  const { store, put } = countingStore();
  // Twelve distinct publish commits: the shape that used to issue twelve
  // simultaneous GitHub calls from one unbounded Promise.all on a page view.
  for (let i = 0; i < 12; i += 1) {
    put(`objects/page/by-id/page_${i}.json`, publishedPage(`page_${i}`, `commit_${i}`));
  }
  await inventory(store);

  const previousEnv = {
    token: process.env.GITHUB_CONTENT_TOKEN,
    repo: process.env.GITHUB_REPOSITORY,
    site: process.env.NETLIFY_SITE_ID,
    auth: process.env.NETLIFY_AUTH_TOKEN,
  };
  process.env.GITHUB_CONTENT_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'example-org/example-repo';
  process.env.NETLIFY_SITE_ID = 'site-under-test';
  process.env.NETLIFY_AUTH_TOKEN = 'test-token';
  resetCommitAncestryMemoForTesting();

  let inFlight = 0;
  let peak = 0;
  let compares = 0;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes('api.netlify.com')) {
      // The site lookup answers the published deploy; the deploys list answers one build.
      const body = url.includes('/deploys')
        ? [{ id: 'dep_live', commit_ref: 'commit_0', state: 'ready', context: 'production', created_at: '2026-08-26T11:00:00.000Z' }]
        : { published_deploy: { id: 'dep_live', commit_ref: 'commit_0', state: 'ready', created_at: '2026-08-26T11:00:00.000Z' } };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }
    compares += 1;
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 5));
    inFlight -= 1;
    return { ok: true, status: 200, json: async () => ({ status: 'ahead' }) } as unknown as Response;
  }) as typeof fetch;

  try {
    const snapshot = await buildReleaseSnapshot(store, { nowMs: Date.now(), source: 'schedule' });
    assert.ok(peak <= RELEASE_ANCESTRY_CONCURRENCY, `at most ${RELEASE_ANCESTRY_CONCURRENCY} compares in flight, saw ${peak}`);
    // commit_0 IS the live commit and is never asked about; the other eleven are.
    assert.equal(compares, 11);
    assert.equal(snapshot.deploy.included_commits.length, 12);
    assert.equal(snapshot.deploy.ancestry_truncated, false);

    // …and with no budget left, the fan-out reports a LOWER BOUND rather than
    // guessing. `commit_0` still resolves — it is the live commit, which costs
    // no call at all — and nothing is wrongly marked included.
    resetCommitAncestryMemoForTesting();
    compares = 0;
    const truncated = await buildReleaseSnapshot(store, {
      nowMs: Date.now() - 60_000,
      source: 'schedule',
      budgetMs: 0,
    });
    assert.equal(compares, 0, 'an exhausted budget asks GitHub nothing');
    assert.deepEqual(truncated.deploy.included_commits, ['commit_0']);
    assert.equal(truncated.deploy.ancestry_truncated, true);
    // The conservative direction: an object reads `published`, never `live`.
    assert.equal(
      truncated.objects.filter((object) => object.state === 'live').length,
      1,
      'only the commit proved live may read as live'
    );
  } finally {
    globalThis.fetch = realFetch;
    resetCommitAncestryMemoForTesting();
    process.env.GITHUB_CONTENT_TOKEN = previousEnv.token ?? '';
    process.env.GITHUB_REPOSITORY = previousEnv.repo ?? '';
    process.env.NETLIFY_SITE_ID = previousEnv.site ?? '';
    process.env.NETLIFY_AUTH_TOKEN = previousEnv.auth ?? '';
  }
});

// ═══ M3.1: the chat list ══════════════════════════════════════════════════

/**
 * `snapshots/chats.json` is in the `agent-chats` store, not this one, but it
 * is the same mechanism and the same law, so it is pinned and measured in the
 * same file (see the header). The acceptance is a COUNT: the Agents hub cost
 * one `list()` plus one `get()` per chat — each `get` pulling a whole
 * transcript — and must now cost one blob read.
 */
const chatDoc = (chatId: string, over: Partial<ChatDoc> = {}): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: chatId,
  kind: 'free',
  title: `Chat ${chatId}`,
  created_by: 'editor@example.com',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-01T00:00:00.000Z',
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
  ...over,
});

/** A transcript heavy enough that reading one to list a title is the defect. */
const withTranscript = (doc: ChatDoc, events: number): ChatDoc => ({
  ...doc,
  seq: events,
  events: Array.from({ length: events }, (_, index) => ({
    seq: index + 1,
    at: '2026-09-01T00:00:00.000Z',
    type: 'assistant_text' as const,
    detail: { text: 'x'.repeat(200) },
  })),
});

const chatStoreWith = (etagMode: 'real' | 'none' = 'real') => {
  const fake = countingStore(etagMode);
  return { ...fake, chats: fake.store as unknown as AgentChatStore };
};

test('M3.1: a cold Agents hub sweeps once, writes the list, and is ONE blob read thereafter', async () => {
  const { chats, put, counts, reset } = chatStoreWith();
  for (const id of ['chat_a', 'chat_b', 'chat_c']) {
    put(chatDocKey(id), withTranscript(chatDoc(id), 40));
  }

  reset();
  const cold = await readChatList(chats, NOW);
  assert.equal(cold.rebuilt, true, 'a cold store rebuilds from the transcripts');
  assert.deepEqual(
    cold.rows.map((row) => row.chat_id),
    ['chat_a', 'chat_b', 'chat_c']
  );
  assert.ok(counts.list >= 1, 'the rebuild is the only thing allowed to list');
  assert.ok(counts.get >= 4, `the rebuild reads every transcript (saw ${counts.get})`);
  assert.ok(counts.set >= 1, 'the rebuild writes back what it built');

  reset();
  const warm = await readChatList(chats, NOW);
  assert.equal(warm.rebuilt, false);
  assert.equal(counts.list, 0, 'a warm list never lists');
  assert.equal(counts.get, 1, `a warm list is ONE blob read (saw ${counts.get})`);
  assert.equal(counts.set, 0);
  assert.deepEqual(warm.rows, cold.rows, 'the two paths answer the same rows');
});

test('M3.1: a chat write amends the list; an immaterial save touches only the document', async () => {
  const { chats, put, counts, reset } = chatStoreWith();
  put(chatDocKey('chat_a'), chatDoc('chat_a'));
  await readChatList(chats, NOW);

  // A brand-new chat: arm, document, commit — and no listing at all.
  reset();
  await saveChatDoc(chats, chatDoc('chat_b', { updated_at: '2026-09-02T00:00:00.000Z' }));
  assert.equal(counts.list, 0, 'a chat write never sweeps');
  assert.equal(counts.set, 3, `arm + document + commit (saw ${counts.set})`);
  reset();
  const listed = await readChatList(chats, NOW);
  assert.equal(listed.rebuilt, false, 'the amendment left the list trusted');
  assert.deepEqual(
    listed.rows.map((row) => row.chat_id),
    ['chat_b', 'chat_a'],
    'newest first'
  );

  // The run loop's shape: `updated_at` creeps, nothing else moves. One write.
  reset();
  await saveChatDoc(chats, chatDoc('chat_b', { updated_at: '2026-09-02T00:00:05.000Z' }));
  assert.equal(counts.set, 1, `an immaterial save writes the document only (saw ${counts.set})`);
  assert.equal((await readChatList(chats, NOW)).rebuilt, false, 'and leaves the list trusted');

  // A status transition is always material — this is the badge the hub draws.
  reset();
  await saveChatDoc(chats, chatDoc('chat_b', { updated_at: '2026-09-02T00:00:06.000Z', status: 'running' }));
  assert.equal(counts.set, 3, 'a status transition is amended at once');
  assert.equal((await readChatList(chats, NOW)).rows[0]?.status, 'running');

  // …and so is a touch past the tolerance, so "last active" cannot drift.
  reset();
  const later = new Date(Date.parse('2026-09-02T00:00:06.000Z') + CHAT_ROW_TOUCH_TOLERANCE_MS + 1).toISOString();
  await saveChatDoc(chats, chatDoc('chat_b', { updated_at: later, status: 'running' }));
  assert.equal(counts.set, 3, 'a touch past the tolerance is amended');
  assert.equal((await readChatList(chats, NOW)).rows[0]?.updated_at, later);
});

test('M3.1: the materiality rule is pure, and never skips something the hub renders', () => {
  const base = chatSnapshotRow(chatDoc('chat_a'));
  assert.equal(chatRowNeedsCommit(undefined, base), true, 'an unlisted chat is always material');
  assert.equal(chatRowNeedsCommit(base, base), false);
  assert.equal(chatRowNeedsCommit(base, { ...base, status: 'queued' }), true);
  assert.equal(chatRowNeedsCommit(base, { ...base, title: 'Renamed' }), true);
  assert.equal(chatRowNeedsCommit(base, { ...base, object_id: 'page_home' }), true);
  assert.equal(
    chatRowNeedsCommit(base, {
      ...base,
      last_outcome: { run_id: 'r1', started_at: 'a', finished_at: 'b', outcome: 'completed', chips: [] },
    }),
    true,
    'a finished run always lands'
  );
  const nudged = new Date(Date.parse(base.updated_at) + 5_000).toISOString();
  assert.equal(chatRowNeedsCommit(base, { ...base, updated_at: nudged }), false);
  const past = new Date(Date.parse(base.updated_at) + CHAT_ROW_TOUCH_TOLERANCE_MS).toISOString();
  assert.equal(chatRowNeedsCommit(base, { ...base, updated_at: past }), true);
  assert.equal(chatRowNeedsCommit(base, { ...base, updated_at: 'not-a-date' }), true, 'an unparseable stamp never skips');
});

test('M3.1: an interrupted amendment leaves the list armed, and the next read repairs it', async () => {
  const { chats, put, blobs, reset, counts } = chatStoreWith();
  put(chatDocKey('chat_a'), chatDoc('chat_a'));
  await readChatList(chats, NOW);

  // The crash window: armed, the document written, and the process gone before
  // the commit. Exactly what `saveChatDoc` does, minus its last line.
  const doc = chatDoc('chat_b', { updated_at: '2026-09-03T00:00:00.000Z' });
  const lease = await armChatSnapshotRow(chats, doc, NOW);
  assert.equal(lease.armed, true);
  put(chatDocKey('chat_b'), doc);

  assert.equal(await readChatSnapshot(chats), undefined, 'an armed list is never served');
  reset();
  const repaired = await readChatList(chats, NOW);
  assert.equal(repaired.rebuilt, true, 'the armed flag forces the sweep');
  assert.ok(counts.list >= 1);
  assert.deepEqual(
    repaired.rows.map((row) => row.chat_id),
    ['chat_b', 'chat_a'],
    'and the row the interrupted write never committed is there'
  );
  assert.ok(blobs.has(CHAT_SNAPSHOT_KEY));
  assert.equal((await readChatList(chats, NOW)).rebuilt, false, 'the repair put the alarm down');
});

test('M3.1: an amendment never CREATES the list — the defect that would publish one chat as forty', async () => {
  // The shape this guards: a tenant with chats already in the store, deployed
  // onto a build that has a snapshot and has never written one. If the first
  // `saveChatDoc` were allowed to create the document, it would create it with
  // exactly one row and the hub would trust it.
  const { chats, put, blobs } = chatStoreWith();
  for (const id of ['chat_a', 'chat_b', 'chat_c']) put(chatDocKey(id), chatDoc(id));
  assert.equal(blobs.has(CHAT_SNAPSHOT_KEY), false, 'no snapshot has ever been written here');

  await saveChatDoc(chats, chatDoc('chat_d', { updated_at: '2026-09-07T00:00:00.000Z' }));
  assert.equal(await readChatSnapshot(chats), undefined, 'what the amendment left is armed, not a list');

  const listed = await readChatList(chats, NOW);
  assert.equal(listed.rebuilt, true, 'the read rebuilds from the transcripts instead');
  assert.deepEqual(
    listed.rows.map((row) => row.chat_id).sort(),
    ['chat_a', 'chat_b', 'chat_c', 'chat_d'],
    'and answers every chat, not only the one that was written'
  );
});

test('M3.1: a superseded or unparseable list is rebuilt, never served', async () => {
  const { chats, put } = chatStoreWith();
  put(chatDocKey('chat_a'), chatDoc('chat_a'));

  put(CHAT_SNAPSHOT_KEY, { schema_version: 'chat-list-snapshot.v0', as_of: 'x', seq: 3, chats: [] });
  assert.equal(await readChatSnapshot(chats), undefined, 'a version this build does not read is not a list');
  assert.equal((await readChatList(chats, NOW)).rebuilt, true);
  assert.equal((await readChatList(chats, NOW)).rebuilt, false);
});

test('M3.1: a store that cannot prove a conditional write is slow, never wrong', async () => {
  // The local file-backed shim's degradation: no etag, so no arm, so no
  // amendment ever commits — and every list falls back to the sweep. What must
  // NOT happen is a list that is missing a chat.
  const { chats, put } = chatStoreWith('none');
  put(chatDocKey('chat_a'), chatDoc('chat_a'));
  assert.equal((await readChatList(chats, NOW)).rebuilt, true);

  await saveChatDoc(chats, chatDoc('chat_b', { updated_at: '2026-09-04T00:00:00.000Z' }));
  const after = await readChatList(chats, NOW);
  assert.equal(after.rebuilt, true, 'without a CAS token the amendment never lands, so the read repairs');
  assert.deepEqual(
    after.rows.map((row) => row.chat_id),
    ['chat_b', 'chat_a'],
    'and the answer is still complete'
  );
});

test('M3.1: the visibility rule scopes rows exactly as it scoped documents', async () => {
  const { chats, put } = chatStoreWith();
  put(chatDocKey('mine'), chatDoc('mine', { created_by: 'Editor@Example.com' }));
  put(chatDocKey('theirs'), chatDoc('theirs', { created_by: 'owner@example.com' }));
  const { rows } = await readChatList(chats, NOW);

  assert.deepEqual(
    visibleChatDocs(rows, 'editor@example.com', false, false).map((row) => row.chat_id),
    ['mine']
  );
  assert.equal(visibleChatDocs(rows, 'editor@example.com', true, false).length, 1, 'include_all needs an Owner');
  assert.equal(visibleChatDocs(rows, 'editor@example.com', true, true).length, 2);
});

// ═══ M3.2: the members list ═══════════════════════════════════════════════

const seedMember = (
  put: (key: string, value: unknown) => void,
  email: string,
  over: { role?: 'owner' | 'admin' | 'editor'; status?: 'invited' | 'active' | 'suspended' } = {}
) => {
  const member = newMember({
    email,
    display_name: email.split('@')[0] ?? email,
    role: over.role ?? 'admin',
    status: over.status ?? 'active',
    source: 'invitation',
    granted_by: { kind: 'human', email: 'owner@example.com' },
    invited_by: 'owner@example.com',
    at: '2026-09-01T00:00:00.000Z',
  });
  put(KEYS.person(member.person.person_id), member.person);
  put(KEYS.membership(member.person.person_id), member.membership);
  put(KEYS.byEmail(member.person.email), { person_id: member.person.person_id });
  return member;
};

const memberStore = (etagMode: 'real' | 'none' = 'real') => {
  const fake = countingStore(etagMode);
  return { ...fake, users: fake.store as unknown as MembershipStore };
};

test('M3.2: the Admins list stops being an N+1 — one sweep, then ONE blob read', async () => {
  const { users, put, counts, reset } = memberStore();
  seedMember(put, 'a@example.com');
  seedMember(put, 'b@example.com', { role: 'owner' });
  seedMember(put, 'c@example.com', { status: 'invited' });

  reset();
  const cold = await readMemberList(users, NOW);
  assert.equal(cold.rebuilt, true);
  assert.equal(cold.members.length, 3);
  assert.ok(counts.list >= 2, 'the sweep lists both prefixes');
  assert.ok(counts.get >= 6, `the sweep reads a membership AND a person per member (saw ${counts.get})`);

  reset();
  const warm = await readMemberList(users, NOW);
  assert.equal(warm.rebuilt, false);
  assert.equal(counts.list, 0, 'a warm Admins list never lists');
  assert.equal(counts.get, 1, `a warm Admins list is ONE blob read (saw ${counts.get})`);
  assert.deepEqual(
    warm.members.map((member) => member.person.email),
    ['a@example.com', 'b@example.com', 'c@example.com'],
    'in the sweep order, so no caller can tell the two paths apart'
  );
  assert.deepEqual(warm.members, cold.members);
});

test('M3.2: the v1-shaped view is projected from the snapshot, not stored a second time', async () => {
  const { users, put } = memberStore();
  seedMember(put, 'a@example.com');
  seedMember(put, 'b@example.com', { status: 'suspended' });

  const swept = (await listMembers(users)).map(memberToUserRecord);
  const listed = await listUserRecords(users);
  assert.deepEqual(listed, swept, 'the snapshot answers exactly what the sweep answered');
  // The audit array the row drawer falls back to survives the round trip.
  assert.ok(Array.isArray(listed[0]?.audit));
});

test('M3.2: a membership write amends the list; a purge removes the row', async () => {
  const { users, put, counts, reset } = memberStore();
  const existing = seedMember(put, 'a@example.com');
  await readMemberList(users, NOW);

  reset();
  await saveMember(users, {
    person: { ...existing.person, email: 'a@example.com', display_name: 'Renamed' },
    membership: { ...existing.membership, role: 'editor', updated_at: '2026-09-05T00:00:00.000Z' },
  });
  assert.equal(counts.list, 0, 'a membership write never sweeps');
  const afterSave = await readMemberList(users, NOW);
  assert.equal(afterSave.rebuilt, false, 'the amendment left the list trusted');
  assert.equal(afterSave.members[0]?.person.display_name, 'Renamed');
  assert.equal(afterSave.members[0]?.membership.role, 'editor');

  const second = seedMember(put, 'b@example.com');
  await saveMember(users, second);
  assert.equal((await readMemberList(users, NOW)).members.length, 2);

  await scrubPerson(users, { person: second.person, membership: second.membership, at: '2026-09-06T00:00:00.000Z' });
  const afterPurge = await readMemberList(users, NOW);
  assert.equal(afterPurge.rebuilt, false, 'a purge amends rather than invalidating');
  assert.deepEqual(
    afterPurge.members.map((member) => member.person.email),
    ['a@example.com'],
    'a scrubbed person leaves the list, exactly as it leaves the sweep'
  );
  assert.deepEqual(
    (await listMembers(users)).map((member) => member.person.email),
    ['a@example.com'],
    'and the sweep agrees'
  );
});

test('M3.2: an interrupted membership write leaves the list armed, and the next read repairs it', async () => {
  const { users, put, reset, counts } = memberStore();
  seedMember(put, 'a@example.com');
  await readMemberList(users, NOW);

  // Armed, records written, gone before the commit.
  const lease = await armMembersSnapshot(users, NOW);
  assert.equal(lease.armed, true);
  seedMember(put, 'b@example.com');

  assert.equal(await readMembersSnapshot(users), undefined, 'an armed list is never served');
  reset();
  const repaired = await readMemberList(users, NOW);
  assert.equal(repaired.rebuilt, true);
  assert.ok(counts.list >= 2, 'the repair is the sweep');
  assert.deepEqual(
    repaired.members.map((member) => member.person.email),
    ['a@example.com', 'b@example.com']
  );
  assert.equal((await readMemberList(users, NOW)).rebuilt, false, 'the repair put the alarm down');
});

test('M3.2: an amendment never CREATES the list — the same defect, with people in it', async () => {
  const { users, put, blobs } = memberStore();
  seedMember(put, 'a@example.com');
  seedMember(put, 'b@example.com');
  assert.equal(blobs.has(MEMBERS_SNAPSHOT_KEY), false);

  const fresh = seedMember(put, 'c@example.com');
  await saveMember(users, fresh);
  assert.equal(await readMembersSnapshot(users), undefined, 'what the amendment left is armed, not a list');

  const listed = await readMemberList(users, NOW);
  assert.equal(listed.rebuilt, true);
  assert.deepEqual(
    listed.members.map((member) => member.person.email),
    ['a@example.com', 'b@example.com', 'c@example.com'],
    'a workspace of three is not published as a workspace of one'
  );
});

test('M3.2: a superseded members list is rebuilt, and the min_owners guard never reads a cache', async () => {
  const { users, put, counts, reset } = memberStore();
  seedMember(put, 'a@example.com', { role: 'owner' });
  seedMember(put, 'b@example.com', { role: 'owner' });

  put(MEMBERS_SNAPSHOT_KEY, { schema_version: 'member-list-snapshot.v0', as_of: 'x', seq: 9, members: [] });
  assert.equal(await readMembersSnapshot(users), undefined);
  assert.equal((await readMemberList(users, NOW)).rebuilt, true);
  assert.equal((await readMemberList(users, NOW)).rebuilt, false);

  // The guard that decides whether a workspace may be left without an owner
  // reads RECORDS, deliberately — a listing, not the one-blob read above.
  reset();
  assert.equal(await countActiveOwners(users), 2);
  assert.ok(counts.list >= 2, 'countActiveOwners sweeps, on purpose');
});
// ═══ M3.3: the visual-identity snapshot ═══════════════════════════════════

/**
 * `snapshots/visual-identity.json` is the second projection the record-write
 * choke point maintains, under the same law as the first: armed before the
 * record moves, committed with a compare-and-swap, trusted only while its
 * alarm agrees, and repaired by the same code path that builds it.
 *
 * The number these cases exist to pin is SEVENTEEN — the `admin-object`
 * invocations one load of `/admin/settings/visual-identity` used to make (four
 * `list`s, thirteen `get`s on drluriescience). The server side of that becomes
 * two blob reads; the cases below assert the two, and assert that nothing
 * about the object index moved to buy them.
 */
const recipeRecord = (
  id: string,
  objectType: 'template' | 'section_template' | 'theme' | 'visual_standard',
  body: Record<string, unknown> = { name: id }
): ObjectRecord => ({
  ...pageRecord(id),
  object_id: id,
  object_type: objectType,
  schema_version: `${objectType}.v1`,
  body,
});

const seedVisualIdentity = (put: (key: string, value: unknown) => void) => {
  put('objects/template/by-id/tpl_interior.json', recipeRecord('tpl_interior', 'template', { name: 'Interior page', slots: [] }));
  put('objects/template/by-id/tpl_landing.json', recipeRecord('tpl_landing', 'template', { name: 'Landing', slots: [] }));
  put('objects/section_template/by-id/stpl_hero.json', recipeRecord('stpl_hero', 'section_template'));
  put('objects/theme/by-id/thm_default.json', recipeRecord('thm_default', 'theme', { name: 'Default', tokens: { colors: { ink: '#111' } } }));
  put('objects/visual_standard/by-id/vis_house.json', recipeRecord('vis_house', 'visual_standard', { kind: 'house', label: 'House' }));
  // Noise: a type the snapshot must never hold, and which must never cost it a
  // single blob operation on write.
  put('objects/page/by-id/page_a.json', pageRecord('page_a'));
};

const visualIdentityStore = (store: ObjectVerbStore) => store as unknown as VisualIdentitySnapshotStore;

test('M3.3 ACCEPTANCE: a warm visual-identity read is TWO blob reads and no listing — the seventeen calls are gone', async () => {
  const { store, counts, put, reset } = countingStore();
  seedVisualIdentity(put);

  // Cold: the read repairs itself. Four listings, n record reads, and the two
  // docs written — the same work the client used to drive over seventeen calls,
  // paid once, on the server, and never again.
  const cold = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(cold.stats.trusted, false);
  assert.equal(cold.stats.listed, 5, 'four listings name exactly the five records of the four types');
  assert.equal(cold.stats.wrote, true, 'a read that had to rebuild writes what it rebuilt — this is the repair');
  assert.equal(counts.list, VISUAL_IDENTITY_OBJECT_TYPES.length);

  reset();
  const warm = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });

  // THE measurement, after the alarm moved inside the document: one blob.
  assert.equal(counts.get, 1, 'a warm visual-identity read is exactly ONE blob read');
  assert.equal(counts.list, 0, 'no listing may happen on the warm read path');
  assert.equal(counts.set, 0, 'a read may not write');
  assert.equal(warm.stats.trusted, true);
  assert.equal(warm.stats.read, 0);

  // …and it is the same answer, grouped the way the page consumes it.
  const byType = Object.fromEntries(
    VISUAL_IDENTITY_OBJECT_TYPES.map((type) => [type, warm.entries.filter((entry) => entry.object_type === type).length])
  );
  assert.deepEqual(byType, { template: 2, section_template: 1, theme: 1, visual_standard: 1 });
  assert.ok(
    warm.entries.every((entry) => entry.object_type !== ('page' as unknown)),
    'the snapshot holds the four types and nothing else'
  );
});

test('M3.3: the choke point amends the snapshot in the same sequence — and a type it does not hold costs it nothing', async () => {
  const { store, counts, put, blobs, reset } = countingStore();
  seedVisualIdentity(put);
  await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  await inventory(store);

  // A write of one of the four types.
  reset();
  const written = await putObjectRecord(store, {
    record: recipeRecord('thm_default', 'theme', { name: 'Default, edited', tokens: { colors: { ink: '#222' } } }),
    nowMs: NOW,
  });
  assert.equal(written.index_committed, true, 'the object index still commits exactly as it did before M3.3');
  assert.equal(written.snapshot_committed, true, 'and the body snapshot commits in the same sequence');
  assert.equal(counts.list, 0, 'a write never lists');

  // The amended blob is current AND trusted: the next page load reads one blob.
  reset();
  const after = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(after.stats.trusted, true, 'an amended snapshot is trusted without a rebuild');
  assert.equal(counts.list, 0);
  const theme = after.entries.find((entry) => entry.object_id === 'thm_default');
  assert.equal((theme?.record.body as { name?: string } | undefined)?.name, 'Default, edited');

  // A type the snapshot does not hold: the object index still moves, and the
  // snapshot blob is not touched at all — not read, not written.
  const before = { snapshot: blobs.get(VISUAL_IDENTITY_SNAPSHOT_KEY)?.etag };
  reset();
  const unrelated = await putObjectRecord(store, { record: pageRecord('page_a', 2), nowMs: NOW });
  assert.equal(unrelated.index_committed, true);
  assert.equal(unrelated.snapshot_committed, false, 'nothing was owed');
  assert.equal(blobs.get(VISUAL_IDENTITY_SNAPSHOT_KEY)?.etag, before.snapshot, 'the snapshot blob is untouched');
  assert.equal(
    (await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted,
    true,
    'an unrelated object write must never invalidate the visual-identity snapshot'
  );
});

test('M3.3: a purge through the choke point drops the entry; a retire keeps it and moves its status', async () => {
  const { store, put } = countingStore();
  seedVisualIdentity(put);
  await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });

  await retireObjectRecord(store, {
    record: { ...recipeRecord('tpl_landing', 'template'), status: 'archived' } as ObjectRecord,
    nowMs: NOW,
  });
  const retired = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(retired.stats.trusted, true);
  assert.equal(retired.entries.find((entry) => entry.object_id === 'tpl_landing')?.status, 'archived');

  const deleted = await deleteObjectRecord(store, { object_type: 'template', object_id: 'tpl_landing' }, { nowMs: NOW });
  assert.equal(deleted.snapshot_committed, true);
  const purged = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(purged.stats.trusted, true, 'a purge leaves the pair in step, not armed');
  assert.equal(purged.entries.some((entry) => entry.object_id === 'tpl_landing'), false);
});

test('M3.3 REPAIR: missing, unparseable, wrong-schema and interrupted all fall through to the per-object reads', async () => {
  const { store, put, blobs } = countingStore();
  seedVisualIdentity(put);

  // Missing.
  assert.equal((await readVisualIdentitySnapshotDoc(visualIdentityStore(store))).doc, undefined);
  await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal((await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted, true);

  // Unparseable.
  put(VISUAL_IDENTITY_SNAPSHOT_KEY, 'not json at all');
  const fromGarbage = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(fromGarbage.stats.superseded, true, 'a blob that was there and could not be used is a REBUILD, not a cold store');
  assert.equal(fromGarbage.entries.length, 5);
  assert.equal((await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted, true);

  // Wrong schema — detected on the first read after deploy and rebuilt in
  // place, exactly as `objects/index.json`'s version bump is. No migration.
  const stored = JSON.parse(blobs.get(VISUAL_IDENTITY_SNAPSHOT_KEY)?.value ?? 'null') as Record<string, unknown>;
  put(VISUAL_IDENTITY_SNAPSHOT_KEY, { ...stored, schema_version: 'visual-identity-snapshot.v0' });
  assert.equal((await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.superseded, true);
  assert.equal((await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted, true);

  // Interrupted: the alarm is up inside the document — the shape a crash
  // between the record write and the snapshot commit leaves behind. Armed is
  // untrusted whatever the rows say, so nothing is served from it.
  const armed = JSON.parse(blobs.get(VISUAL_IDENTITY_SNAPSHOT_KEY)?.value ?? 'null') as Record<string, unknown>;
  put(VISUAL_IDENTITY_SNAPSHOT_KEY, { ...armed, armed: true });
  put('objects/theme/by-id/thm_late.json', recipeRecord('thm_late', 'theme'));
  const repaired = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(repaired.stats.trusted, false);
  assert.equal(repaired.entries.some((entry) => entry.object_id === 'thm_late'), true, 'the repair finds the record the snapshot never heard about');
  assert.equal((await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted, true);

  // Sticky: an armed flag is not cleared by a writer, only by the rebuild.
  const inStep = JSON.parse(blobs.get(VISUAL_IDENTITY_SNAPSHOT_KEY)?.value ?? 'null') as Record<string, unknown>;
  put(VISUAL_IDENTITY_SNAPSHOT_KEY, { ...inStep, armed: true });
  await putObjectRecord(store, { record: recipeRecord('thm_default', 'theme', { name: 'Edited under an armed alarm' }), nowMs: NOW });
  assert.equal(
    (await readVisualIdentitySnapshotDoc(visualIdentityStore(store))).doc?.armed,
    true,
    'a writer that finds the alarm armed retreats and leaves it armed'
  );
  const clearing = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(clearing.stats.trusted, false, 'the read that finds the flag rebuilds rather than serving');
  assert.equal(
    (await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW })).stats.trusted,
    true,
    'and only that full rebuild puts the flag down'
  );
});

test('M3.3: a store that cannot report an etag never commits and always rebuilds — the documented degradation', async () => {
  const { store, put } = countingStore('none');
  seedVisualIdentity(put);

  await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  const written = await putObjectRecord(store, { record: recipeRecord('thm_default', 'theme'), nowMs: NOW });
  assert.equal(written.snapshot_committed, false, 'no compare-and-swap token, no commit');
  const read = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  assert.equal(read.stats.trusted, false, 'so every read rebuilds — correct, and slow, exactly as before M3.3');
  assert.equal(read.entries.length, 5, 'and the answer is still right');
});

/**
 * SIZE. This snapshot holds BODIES, not the fifteen-scalar rows
 * `objects/index.json` holds, so the one way it degrades quietly is by getting
 * fat: a large blob on a page path is just a slower page.
 *
 * Two things keep it honest and both are asserted here. The ledger is dropped
 * (a template patched fifty times carries fifty history entries, and a patch
 * entry's `details.capture` can hold a whole section blueprint — that is edit
 * COUNT, not content, and no consumer on this surface reads it), and the size
 * is reported on every read as `stats.bytes` so it is a number somebody can
 * watch rather than a page that quietly slows down.
 *
 * Measured against the committed exports (drlurie 13 records → 21.1 KB,
 * platform 15 → 23.7 KB, zilberman 15 → 23.3 KB; ~210-240 KB at ten times
 * that). Without the ledger drop the same eleven drlurie records with a
 * forty-entry history each are 133 KB against 21.6 KB — and that difference is
 * a function of EDIT COUNT, not content, so it has no bound. See
 * `visual-identity/snapshot-store.ts`'s SIZE note for the split to make if it
 * ever stops fitting in one blob.
 */
test('M3.3 SIZE: the unbounded history ledger never reaches the blob, and the size is reported', async () => {
  const { store, put } = countingStore();
  const fat = recipeRecord('tpl_fat', 'template', { name: 'Fat', slots: [] });
  put('objects/template/by-id/tpl_fat.json', {
    ...fat,
    history: Array.from({ length: 200 }, () => ({
      at: '2026-08-01T00:00:00.000Z',
      action: 'patch',
      actor: HUMAN,
      details: { op: 'upsert_slot', capture: { blueprint: 'x'.repeat(400) } },
    })),
  });

  const read = await readVisualIdentitySnapshot(visualIdentityStore(store), { nowMs: NOW });
  const entry = read.entries[0];
  assert.deepEqual(entry?.record.history, [], 'the ledger is dropped');
  assert.equal(entry?.record.history_length, 200, 'and its length is kept, so nothing is silently pretended');
  assert.ok(read.stats.bytes > 0, 'the blob size is reported on every read');
  assert.ok(
    read.stats.bytes < 10_000,
    `one record whose ledger is 80 KB must not make an 80 KB snapshot (saw ${read.stats.bytes} bytes)`
  );
});

// ═══ M3.4: the governance snapshot ════════════════════════════════════════

/**
 * `snapshots/governance.json` lives under the same law as the two before it,
 * and its cost is stated against the same baseline: a warm governance read is
 * ONE blob read and nothing else — no `overrides.v1`, and (the point of the
 * milestone) no CMS-Agent probe.
 *
 * The fake store below counts reads, and the fake `fetch` is not decoration:
 * the defect M3.4 removes is a 2768 ms cross-service call on a page path, and
 * the only way a test can pin its absence is to make any outbound call an
 * explicit failure.
 */
type SnapshotBlobStore = {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<void>;
  reads: string[];
  writes: string[];
  blobs: Map<string, string>;
};

const snapshotBlobStore = (seed: Record<string, unknown> = {}): SnapshotBlobStore => {
  const blobs = new Map<string, string>(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  return {
    blobs,
    reads: [],
    writes: [],
    async get(key: string) {
      (this as SnapshotBlobStore).reads.push(key);
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      (this as SnapshotBlobStore).writes.push(key);
      blobs.set(key, JSON.stringify(value));
    },
  };
};

const withNoOutboundCall = async (run: () => Promise<void>): Promise<void> => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('a page path must make no outbound call');
  }) as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = realFetch;
  }
};

test('M3.4: a warm governance read is ONE blob read, and never probes', async () => {
  await withNoOutboundCall(async () => {
    const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
    const store = snapshotBlobStore({
      [GOVERNANCE_SNAPSHOT_KEY]: buildGovernanceSnapshot({
        doc: null,
        probe: {
          checked_at: new Date(nowMs - 60_000).toISOString(),
          reachable: true,
          latency_ms: 240,
          agent_ref: 'agt_client_manager@2',
          code: null,
          message: null,
        },
        nowMs: nowMs - 60_000,
        source: 'probe_schedule',
      }),
    });

    const { snapshot, repaired } = await loadGovernanceSnapshot(
      store as unknown as Parameters<typeof loadGovernanceSnapshot>[0],
      nowMs
    );
    assert.equal(repaired, false);
    assert.deepEqual(store.reads, [GOVERNANCE_SNAPSHOT_KEY], 'exactly one blob read, and not overrides.v1');
    assert.deepEqual(store.writes, [], 'a warm read writes nothing');

    const view = cmsAgentProbeView(snapshot.cms_agent_probe, nowMs);
    assert.equal(view.state, 'fresh');
    assert.equal(cmsAgentHealthFromProbe(snapshot.cms_agent_probe)?.ok, true);
  });
});

test('M3.4: the repair is the OLD read path — it reads overrides.v1, writes back, and does not probe', async () => {
  await withNoOutboundCall(async () => {
    const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
    const store = snapshotBlobStore({
      [GOVERNANCE_DOC_KEY]: { schema_version: 'overrides.v1', updated_by: 'wolf@example.com', updated_at: 'x', history: [], learning_mode: true },
    });

    const { snapshot, repaired } = await loadGovernanceSnapshot(
      store as unknown as Parameters<typeof loadGovernanceSnapshot>[0],
      nowMs
    );
    assert.equal(repaired, true);
    assert.deepEqual(store.reads, [GOVERNANCE_SNAPSHOT_KEY, GOVERNANCE_DOC_KEY], 'a miss costs the old read, once');
    assert.deepEqual(store.writes, [GOVERNANCE_SNAPSHOT_KEY], 'the repair writes back what it built');
    assert.equal(snapshot.source, 'repair');
    assert.equal(snapshot.doc?.learning_mode, true, 'the document half is repaired from the store');

    /**
     * THE DECISION: what a page shows when there has never been a probe.
     *
     * `never_checked`, not "unreachable". The schedule has not run on this
     * tenant; we did not ask, so we do not answer. A synthesized red would be
     * a claim about CMS-Agent made on the strength of our own cron, and it is
     * indistinguishable on screen from a real outage.
     */
    assert.equal(snapshot.cms_agent_probe, null);
    assert.deepEqual(cmsAgentProbeView(snapshot.cms_agent_probe, nowMs), { state: 'never_checked' });
    assert.equal(cmsAgentHealthFromProbe(snapshot.cms_agent_probe), undefined, 'no verdict is rendered at all');
  });
});

test('M3.4: a stale snapshot is repaired WITH its last probe — an old reading is dated, never discarded or re-taken', async () => {
  await withNoOutboundCall(async () => {
    const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
    const checkedAt = new Date(nowMs - 3 * 60 * 60_000).toISOString();
    const store = snapshotBlobStore({
      [GOVERNANCE_SNAPSHOT_KEY]: buildGovernanceSnapshot({
        doc: null,
        probe: { checked_at: checkedAt, reachable: true, latency_ms: 190, agent_ref: 'agt_x', code: null, message: null },
        nowMs: nowMs - GOVERNANCE_SNAPSHOT_MAX_AGE_MS - 60_000,
        source: 'probe_schedule',
      }),
    });

    const { snapshot, repaired } = await loadGovernanceSnapshot(
      store as unknown as Parameters<typeof loadGovernanceSnapshot>[0],
      nowMs
    );
    assert.equal(repaired, true, 'past the bound the document half is rebuilt');
    assert.equal(snapshot.cms_agent_probe?.checked_at, checkedAt, 'the probe is carried, not re-taken');

    const view = cmsAgentProbeView(snapshot.cms_agent_probe, nowMs);
    assert.equal(view.state, 'stale', 'three hours old renders as "last checked hh:mm", not as a live verdict');
    assert.equal(view.state === 'stale' ? view.checked_at : '', checkedAt, 'the bound is stated by stating the time');
  });
});

test('M3.4: a governance write carries the probe forward, so saving a guardrail never blanks the bridge status', async () => {
  await withNoOutboundCall(async () => {
    const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
    const probe = {
      checked_at: new Date(nowMs - 120_000).toISOString(),
      reachable: false,
      latency_ms: 3000,
      agent_ref: null,
      code: 'cms_agent_timeout',
      message: 'timed out',
    };
    const store = snapshotBlobStore({
      [GOVERNANCE_SNAPSHOT_KEY]: buildGovernanceSnapshot({ doc: null, probe, nowMs: nowMs - 120_000, source: 'probe_schedule' }),
    });

    const nextDoc = {
      schema_version: 'overrides.v1' as const,
      updated_by: 'wolf@example.com',
      updated_at: new Date(nowMs).toISOString(),
      history: [],
      brandImageryOverrides: 'lock' as const,
    };
    await refreshGovernanceSnapshotAfterWrite(
      store as unknown as Parameters<typeof refreshGovernanceSnapshotAfterWrite>[0],
      nextDoc,
      nowMs
    );

    const written = await readGovernanceSnapshot(store as unknown as Parameters<typeof readGovernanceSnapshot>[0]);
    assert.equal(written?.source, 'governance_write');
    assert.equal(written?.doc?.brandImageryOverrides, 'lock', "the Owner reads their own change back");
    assert.deepEqual(written?.cms_agent_probe, probe, 'a policy write says nothing about CMS-Agent and must claim nothing');
  });
});

// ═══ M4: the analytics snapshots ══════════════════════════════════════════

/**
 * `snapshots/analytics/<source>/<range>.json`, and the rule that makes it
 * worth having: SERVE THE BLOB, THEN REFRESH. The measured defect is 2151 ms
 * of Netlify Analytics on the page path per view; the acceptance is that a
 * read with a blob present costs one blob read and makes no upstream call
 * whatever the blob's age.
 *
 * `NETLIFY_ANALYTICS_*` is left unconfigured in these cases on purpose: the
 * builder then produces its catalogued `analytics_lookup_unconfigured` body
 * without calling anything, which lets the SWR mechanics be pinned without a
 * network stub pretending to be Netlify.
 */
test('M4: the key is one blob per (source, range) — never per window', () => {
  assert.equal(analyticsSnapshotKey('netlify', '30d'), 'snapshots/analytics/netlify/30d.json');
  assert.equal(analyticsSnapshotKey('own', '7d'), 'snapshots/analytics/own/7d.json');
  // The window slides with the clock; keying on it is the defect M4 removes
  // (every mount minted a key nothing had written). A range is a choice.
  assert.equal(analyticsSnapshotKey('netlify', '30d'), analyticsSnapshotKey('netlify', '30d'));
});

test('M4: a warm read serves the blob and makes no upstream call', async () => {
  await withNoOutboundCall(async () => {
    const nowMs = Date.now();
    const store = snapshotBlobStore({
      'snapshots/analytics/netlify/30d.json': {
        schema_version: 'analytics-snapshot.v1',
        as_of: new Date(nowMs - 60_000).toISOString(),
        source: 'netlify',
        range: '30d',
        window: { from: nowMs - 30 * 86_400_000, to: nowMs, resolution: 'day' },
        body: { configured: true, enabled: true, series: { totals: { visits: 42 } } },
      },
    });

    const snapshot = await readAnalyticsSnapshot(
      store as unknown as Parameters<typeof readAnalyticsSnapshot>[0],
      'netlify',
      '30d'
    );
    assert.ok(snapshot, 'the blob is readable');
    assert.equal(isAnalyticsSnapshotFresh(snapshot, nowMs), true);
    assert.deepEqual(store.reads, ['snapshots/analytics/netlify/30d.json'], 'one blob read');
    assert.equal((snapshot.body as { series?: { totals?: { visits?: number } } }).series?.totals?.visits, 42);
  });
});

test('M4: a STALE blob is still served — staleness triggers a refresh, never a wait', async () => {
  const nowMs = Date.now();
  const stale = {
    schema_version: 'analytics-snapshot.v1' as const,
    as_of: new Date(nowMs - ANALYTICS_SNAPSHOT_MAX_AGE_MS - 60_000).toISOString(),
    source: 'netlify' as const,
    range: '30d' as const,
    window: { from: nowMs - 30 * 86_400_000, to: nowMs, resolution: 'day' as const },
    body: { configured: true, enabled: true, series: { totals: { visits: 7 } } },
  };
  const store = snapshotBlobStore({ 'snapshots/analytics/netlify/30d.json': stale });
  const snapshot = await readAnalyticsSnapshot(
    store as unknown as Parameters<typeof readAnalyticsSnapshot>[0],
    'netlify',
    '30d'
  );
  assert.ok(snapshot);
  // Stale is a fact about the answer, not a reason to withhold it: the body is
  // there to serve, and `as_of` is what makes serving it honest.
  assert.equal(isAnalyticsSnapshotFresh(snapshot, nowMs), false);
  assert.equal((snapshot.body as { series?: { totals?: { visits?: number } } }).series?.totals?.visits, 7);
});

test('M4: a cold read BUILDS and stores — a spinner that resolves, never a zero from an empty cache', async () => {
  const previous = { site: process.env.NETLIFY_SITE_ID, auth: process.env.NETLIFY_AUTH_TOKEN };
  delete process.env.NETLIFY_SITE_ID;
  delete process.env.NETLIFY_AUTH_TOKEN;
  try {
    await withNoOutboundCall(async () => {
      const nowMs = Date.now();
      const store = snapshotBlobStore();
      const { snapshot, written } = await refreshAnalyticsSnapshot(
        store as unknown as Parameters<typeof refreshAnalyticsSnapshot>[0],
        {
          source: 'netlify',
          range: '30d',
          window: { from: nowMs - 30 * 86_400_000, to: nowMs, resolution: 'day' },
          nowMs,
          binding: { siteId: 'site_test', env: PLATFORM_ENV_NAMES, dataRoot: 'sites/test/data/site' },
        }
      );
      assert.equal(written, true);
      assert.deepEqual(store.writes, ['snapshots/analytics/netlify/30d.json']);
      // An unconfigured tenant is a catalogued, STORABLE body — never a throw,
      // never an empty object that a chart would render as zeros.
      assert.equal(snapshot.body.configured, false);
      assert.equal(snapshot.body.error_code, 'analytics_lookup_unconfigured');
      assert.ok(snapshot.as_of, 'every stored feed states when it was gathered');
    });
  } finally {
    if (previous.site !== undefined) process.env.NETLIFY_SITE_ID = previous.site;
    if (previous.auth !== undefined) process.env.NETLIFY_AUTH_TOKEN = previous.auth;
  }
});

test('M4: the hourly warm refreshes the default range always, and the others only once somebody has opened them', () => {
  // Derived from the client, not invented here: the three preset ranges a page
  // can open on, both feeds it fetches on mount.
  assert.deepEqual([...ANALYTICS_WARM_RANGES], ['7d', '30d', '90d']);
  assert.deepEqual([...ANALYTICS_WARM_SOURCES], ['netlify', 'own']);
  assert.ok(ANALYTICS_WARM_RANGES.every((range) => range !== 'custom'), 'a custom span is one operator’s ad-hoc window');

  const seen = {
    schema_version: 'analytics-snapshot.v1' as const,
    as_of: new Date().toISOString(),
    source: 'netlify' as const,
    range: '90d' as const,
    window: { from: 0, to: 1, resolution: 'day' as const },
    body: {},
  };
  assert.equal(shouldWarmTarget('30d', undefined), true, 'the default pair keeps a dormant tenant warm');
  assert.equal(shouldWarmTarget('90d', undefined), false, 'a range nobody has opened costs no upstream call');
  assert.equal(shouldWarmTarget('90d', seen), true, 'a blob is the proof somebody uses that range');
});

// ═══ REVIEW2: what the wave-2 adversarial pass found and fixed ═════════════

/**
 * ONE KEY, EVERY CUSTOM SPAN.
 *
 * `analyticsSnapshotKey('own', 'custom')` is `snapshots/analytics/own/custom.json`
 * for every custom window anybody has ever picked, and the design note above is
 * right that a preset range must NOT be keyed by its window — that was M4's
 * whole fix. `custom` is the case that argument does not cover: its endpoints
 * are the operator's choice, not the clock's, so two operators (or one
 * operator twice) share a blob that answers a different question. Before the
 * fix a January span written by the first reader was served to the second as
 * `fresh` for their June span; past the bound it was served stale AND the
 * background refresh rebuilt it for June, so the wrong answer was the one that
 * reached the page either way.
 */
test('REVIEW2 (M4): a custom-range blob answers only the window it was built for', () => {
  const nowMs = Date.parse('2026-09-16T12:00:00.000Z');
  const january = { from: Date.parse('2026-01-01T00:00:00.000Z'), to: Date.parse('2026-01-07T23:59:59.999Z') };
  const june = { from: Date.parse('2026-06-01T00:00:00.000Z'), to: Date.parse('2026-06-30T23:59:59.999Z') };
  const stored = {
    schema_version: 'analytics-snapshot.v1' as const,
    as_of: new Date(nowMs - 60_000).toISOString(),
    source: 'own' as const,
    range: 'custom' as const,
    window: { ...january, resolution: 'day' as const },
    body: { configured: true, enabled: true, stats: { visits: 11 } },
  };

  // The blob is FRESH by age — which is exactly why age alone could not have
  // caught this, and why the page painted January's numbers over June.
  assert.equal(isAnalyticsSnapshotFresh(stored, nowMs), true);
  assert.equal(analyticsSnapshotCoversWindow(stored, 'custom', january), true, 'the span it was built for still hits');
  assert.equal(analyticsSnapshotCoversWindow(stored, 'custom', june), false, 'another span is not stale, it is a different question');

  // A preset range must keep sliding with the clock — the endpoints move on
  // every load and a blob built a minute ago is the answer M4 exists to serve.
  const preset = { ...stored, range: '30d' as const, window: { from: nowMs - 30 * 86_400_000, to: nowMs - 60_000, resolution: 'day' as const } };
  assert.equal(analyticsSnapshotCoversWindow(preset, '30d', { from: nowMs - 30 * 86_400_000, to: nowMs }), true);
});

/**
 * THE 30 s SCHEDULED-FUNCTION WALL, which this fleet has already been bitten by
 * once (`media-compaction-run.ts:SWEEP_BUDGET_MS`; three days of kills with an
 * empty log). The warm is the GUARANTEE behind M4 — the un-awaited background
 * refresh is explicitly only an optimisation — so a silent kill here is the
 * whole mechanism quietly stopping.
 */
test('REVIEW2 (M4): the warm runs the default pair first and stops starting pairs at its budget', () => {
  const targets = analyticsWarmTargets();
  assert.equal(targets.length, ANALYTICS_WARM_RANGES.length * ANALYTICS_WARM_SOURCES.length, 'every pair still gets a turn');
  // `own/30d` is what a bare visit opens (DEFAULT_ANALYTICS_SOURCE +
  // DEFAULT_ANALYTICS_RANGE); `netlify/30d` is the pageviews the own tab's
  // capture-rate stat needs. A pass that runs out of clock must never be the
  // reason either of those is cold.
  assert.deepEqual(
    targets.slice(0, 2),
    [
      { source: 'own', range: '30d' },
      { source: 'netlify', range: '30d' },
    ],
    'the two feeds a default mount reads lead the pass'
  );
  assert.ok(
    targets.every((target) => target.range !== 'custom'),
    'a custom span is one operator’s ad-hoc window and is never warmed'
  );
  assert.ok(ANALYTICS_WARM_BUDGET_MS < 30_000, 'the budget has to leave room for the pair already in flight');
});

/**
 * THE DAMPING PREDICATE IS ABOUT VALUES, NOT KEY ORDER.
 *
 * `previous` comes back through `chatSnapshotSchema.parse`, which rebuilds
 * every object in SCHEMA order; `next` is built in memory by whatever code
 * assembled the chat document. They agree today only by coincidence of field
 * order in `agent/loop.ts`'s two `doc.runs.push({ … })` literals. If they ever
 * stopped agreeing, the predicate would call every save MATERIAL — the hub
 * would stay correct and the damping would silently evaporate into twenty arms
 * and twenty commits per run, which is the cost M3.1 exists to avoid and which
 * nothing else in this file would fail on.
 */
test('REVIEW2 (M3.1): the materiality rule ignores key order, so the damping cannot silently invert', () => {
  const base = chatSnapshotRow(
    chatDoc('chat_a', {
      runs: [{ run_id: 'r1', started_at: '2026-09-01T00:00:00.000Z', finished_at: '2026-09-01T00:01:00.000Z', outcome: 'completed', chips: ['created X'] }],
    })
  );
  // The same row with every object's keys written in a different order — what
  // a reordered literal or a reordered schema would produce on one side only.
  const reordered = JSON.parse(
    JSON.stringify({
      last_outcome: { chips: ['created X'], outcome: 'completed', finished_at: '2026-09-01T00:01:00.000Z', started_at: '2026-09-01T00:00:00.000Z', run_id: 'r1' },
      created_by: base.created_by,
      updated_at: base.updated_at,
      status: base.status,
      title: base.title,
      kind: base.kind,
      chat_id: base.chat_id,
    })
  ) as typeof base;
  assert.equal(chatRowNeedsCommit(base, reordered), false, 'the same values in another order are not a change');
  // …and a real change to the run summary still lands, which is the thing the
  // order-independence must not buy at the cost of.
  assert.equal(
    chatRowNeedsCommit(base, { ...reordered, last_outcome: { ...base.last_outcome!, outcome: 'error' } }),
    true,
    'a run that ended differently is always material'
  );
});
