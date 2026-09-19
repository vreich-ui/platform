/**
 * P1 — the record-write choke point's conditional-write guarantee, exercised
 * against a REAL conditional store (`local-blobs.ts`'s file-backed shim,
 * fixed by this same wave to genuinely honour `onlyIfNew`/`onlyIfMatch` and
 * to report real content-hash etags — see that file's P1 comment), never a
 * hand-rolled Map fake that always reports success. `object-lock.ts` and
 * `object-verbs.ts`'s own test suites cover the HTTP-shaped behaviour around
 * each verb; this file is the one place the storage-level guarantee itself —
 * create-if-absent, compare-and-swap, and what a losing writer may and may
 * not leave behind — is pinned directly.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { setLocalBlobsRootForTesting, createLocalBlobStore } from '../../packages/core/server/lib/local-blobs.js';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'record-writer-conditional-write');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
// P1's `{kind:'create'}` precondition means a leftover on-disk blob from a
// PRIOR run of this file now genuinely refuses a "fresh" create (the whole
// point) — so, matching `object-lifecycle.e2e.test.ts`'s convention for the
// same local-blobs shim, start every run of this file from a clean directory
// rather than a fresh-per-process store-name counter that still landed on
// stale files.
await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

const { putObjectRecord, retireObjectRecord, loadRecordWithEtag, RecordWriteConflictError } = await import(
  '../../packages/core/server/lib/objects/record-writer.js'
);
const { objectRecordKey } = await import('../../packages/core/server/lib/object-store-keys.js');
const { readObjectStoreVersion } = await import('../../packages/core/server/lib/objects/index-doc.js');
const { readVisualIdentitySnapshot } = await import('../../packages/core/server/lib/visual-identity/snapshot-store.js');
const { checkoutObjectLock, checkinObjectLock } = await import('../../packages/core/server/lib/object-lock.js');
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';
import type { ObjectRecordWriteStore } from '../../packages/core/server/lib/objects/record-writer.js';
import type { VisualIdentitySnapshotStore } from '../../packages/core/server/lib/visual-identity/snapshot-store.js';

const AGENT: Principal = { kind: 'agent', agent_name: 'test-agent', auth: 'publish_key' };

const baseRecord = (objectType: ObjectRecord['object_type'], objectId: string, at: string): ObjectRecord =>
  ({
    object_id: objectId,
    object_type: objectType,
    schema_version: `${objectType}.v1`,
    site: 'drlurie',
    created_at: at,
    updated_at: at,
    status: 'active',
    body: { title: 'v1' },
    publication: { published_time: null },
    history: [{ at, action: 'create', actor: AGENT }],
    version: 1,
    content_revision: 1,
  }) as ObjectRecord;

let storeCounter = 0;
const freshStore = (): ObjectRecordWriteStore =>
  createLocalBlobStore(`site-objects-p1-${storeCounter++}`) as unknown as ObjectRecordWriteStore;

test('two concurrent creates of the same identity: exactly one wins, the loser never overwrites it', async () => {
  const store = freshStore();
  const key = objectRecordKey('content_item', 'req_p1_concurrent_create');
  const at = '2026-09-18T00:00:00.000Z';
  const first = baseRecord('content_item', 'req_p1_concurrent_create', at);
  const second = {
    ...baseRecord('content_item', 'req_p1_concurrent_create', at),
    body: { title: 'a different writer' },
  };

  // Both writers believe the identity is free — that is the whole point of
  // `{kind:'create'}`: the guarantee does not depend on either of them
  // having checked first.
  await putObjectRecord(store, { record: first, nowMs: 0, precondition: { kind: 'create' } });
  await assert.rejects(
    () => putObjectRecord(store, { record: second, nowMs: 1, precondition: { kind: 'create' } }),
    RecordWriteConflictError
  );

  const stored = JSON.parse((await store.get(key)) as string) as ObjectRecord;
  assert.deepEqual(stored.body, { title: 'v1' }, 'the loser must never have overwritten the winner');
});

test('two concurrent updates based on the same read token: exactly one wins, the loser never overwrites it', async () => {
  const store = freshStore();
  const key = objectRecordKey('content_item', 'req_p1_concurrent_update');
  const at = '2026-09-18T00:00:00.000Z';
  const created = baseRecord('content_item', 'req_p1_concurrent_update', at);
  await putObjectRecord(store, { record: created, nowMs: 0, precondition: { kind: 'create' } });

  // Two writers both read the SAME version and both derive a next record from it.
  const readA = await loadRecordWithEtag(store, key);
  const readB = await loadRecordWithEtag(store, key);
  assert.ok(readA?.etag && readB?.etag, 'the local shim must report a usable etag');
  assert.equal(readA.etag, readB.etag);

  const nextA: ObjectRecord = { ...readA.record, body: { title: 'writer A' }, version: readA.record.version + 1 };
  const nextB: ObjectRecord = { ...readB.record, body: { title: 'writer B' }, version: readB.record.version + 1 };

  await putObjectRecord(store, { record: nextA, nowMs: 1, precondition: { kind: 'match', etag: readA.etag! } });
  await assert.rejects(
    () => putObjectRecord(store, { record: nextB, nowMs: 2, precondition: { kind: 'match', etag: readB.etag! } }),
    RecordWriteConflictError
  );

  const stored = JSON.parse((await store.get(key)) as string) as ObjectRecord;
  assert.deepEqual(stored.body, { title: 'writer A' }, 'the loser must never have overwritten the winner');
  assert.equal(stored.version, 2);
});

test('a stale lock/publish-stamp writer cannot overwrite a record that changed underneath it', async () => {
  const store = freshStore();
  const key = objectRecordKey('content_item', 'req_p1_stale_stamp');
  const at = '2026-09-18T00:00:00.000Z';
  const created = baseRecord('content_item', 'req_p1_stale_stamp', at);
  await putObjectRecord(store, { record: created, nowMs: 0, precondition: { kind: 'create' } });

  // A "restamp" writer (lock/publish-shaped: reads, then writes back derived
  // metadata) takes its read...
  const staleRead = await loadRecordWithEtag(store, key);
  assert.ok(staleRead?.etag);

  // ...and BEFORE it writes, a second, independent writer lands a real
  // content change (what a concurrent patch, or another admin, would do).
  const concurrent: ObjectRecord = {
    ...staleRead!.record,
    body: { title: 'concurrent edit landed first' },
    content_revision: staleRead!.record.content_revision + 1,
    version: staleRead!.record.version + 1,
  };
  await putObjectRecord(store, {
    record: concurrent,
    nowMs: 1,
    precondition: { kind: 'match', etag: staleRead!.etag! },
  });

  // The stale writer now attempts its restamp against the token it read
  // BEFORE the concurrent edit — this must be refused, never silently
  // applied on top of (and hiding) the edit that already landed.
  const staleStamp: ObjectRecord = { ...staleRead!.record, lock: undefined, version: staleRead!.record.version + 1 };
  await assert.rejects(
    () =>
      putObjectRecord(store, { record: staleStamp, nowMs: 2, precondition: { kind: 'match', etag: staleRead!.etag! } }),
    RecordWriteConflictError
  );

  const stored = JSON.parse((await store.get(key)) as string) as ObjectRecord;
  assert.deepEqual(stored.body, { title: 'concurrent edit landed first' }, 'the stale stamp must never win');
  assert.equal(stored.content_revision, 2);
});

test('a losing write on a visual-identity type never publishes its candidate into the snapshot, and does not force an unnecessary rebuild', async () => {
  const store = freshStore();
  const key = objectRecordKey('theme', 'thm_p1_losing_candidate');
  const at = '2026-09-18T00:00:00.000Z';
  const created = { ...baseRecord('theme', 'thm_p1_losing_candidate', at), body: { name: 'accepted' } };
  await putObjectRecord(store, { record: created, nowMs: 0, precondition: { kind: 'create' } });

  // The visual-identity snapshot is amendment-only after a REBUILD (an
  // amendment must never CREATE the guarded document — see
  // `guarded-doc.ts`'s `armGuardedDoc`), so establish a trusted baseline the
  // same way a real page read would: `readVisualIdentitySnapshot`, which
  // rebuilds from the live records the first time the doc is cold.
  const before = await readVisualIdentitySnapshot(store as unknown as VisualIdentitySnapshotStore, { nowMs: 0 });
  assert.equal(before.stats.trusted || before.stats.wrote, true);
  const beforeEntries = before.entries.length;

  const staleRead = await loadRecordWithEtag(store, key);
  assert.ok(staleRead?.etag);
  // A winning, unrelated write moves the record on first (any write works —
  // using the SAME theme keeps this test to one record).
  const winner: ObjectRecord = {
    ...staleRead!.record,
    body: { name: 'winner' },
    version: staleRead!.record.version + 1,
  };
  await putObjectRecord(store, { record: winner, nowMs: 1, precondition: { kind: 'match', etag: staleRead!.etag! } });

  // The loser's candidate — must never reach the snapshot.
  const loser: ObjectRecord = {
    ...staleRead!.record,
    body: { name: 'LOSER — must never be visible' },
    version: staleRead!.record.version + 1,
  };
  await assert.rejects(
    () => putObjectRecord(store, { record: loser, nowMs: 2, precondition: { kind: 'match', etag: staleRead!.etag! } }),
    RecordWriteConflictError
  );

  const after = await readVisualIdentitySnapshot(store as unknown as VisualIdentitySnapshotStore, { nowMs: 3 });
  assert.equal(
    after.stats.trusted,
    true,
    'a conflict must disarm the snapshot back to trusted (one blob read), not leave it stuck armed forcing a rebuild'
  );
  assert.equal(after.entries.length, beforeEntries, 'the conflict must not have changed the entry count');
  const serialized = JSON.stringify(after.entries);
  assert.ok(!serialized.includes('LOSER'), 'the losing candidate must never appear in the snapshot');
  assert.ok(serialized.includes('winner'), 'the actual winner must still be the one reflected');
});

test('a durable record write survives an index-projection conflict, and reports it truthfully rather than swallowing it', async () => {
  const store = freshStore();
  const key = objectRecordKey('content_item', 'req_p1_index_conflict');
  const at = '2026-09-18T00:00:00.000Z';

  // Arrange a race on the SHARED index doc: something else commits an
  // unrelated record to the index between this write's arm and its own
  // commit, so this write's index CAS is guaranteed to lose — while the
  // record write itself has no reason to.
  const other = { ...baseRecord('content_item', 'req_p1_other', at), object_id: 'req_p1_other' };
  const record = baseRecord('content_item', 'req_p1_index_conflict', at);

  const originalSetJSON = store.setJSON.bind(store);
  let armed = false;
  (store as { setJSON: typeof store.setJSON }).setJSON = async (k: string, v: unknown, options?: unknown) => {
    const result = await originalSetJSON(k, v, options as never);
    // The moment THIS write arms `objects/version`, sneak in a whole
    // unrelated record write that reaches the index first.
    if (k === 'objects/version' && !armed) {
      armed = true;
      await putObjectRecord(store, { record: other, nowMs: 0 });
    }
    return result;
  };

  const result = await putObjectRecord(store, { record, nowMs: 1 });

  assert.equal(result.index_committed, false, 'the index race must be reported, not hidden as success');
  const stored = JSON.parse((await store.get(key)) as string) as ObjectRecord;
  assert.deepEqual(stored.body, { title: 'v1' }, 'the record itself must be durable regardless of the index race');

  const version = await readObjectStoreVersion(store);
  assert.equal(version?.armed, true, 'the drift alarm must stay armed so the next read repairs the index');
});

test('unchanged behaviour: version and content_revision counters, and validation-independent bookkeeping, are untouched by P1', async () => {
  const store = freshStore();
  const record = baseRecord('content_item', 'req_p1_counters', '2026-09-18T00:00:00.000Z');
  const created = await putObjectRecord(store, { record, nowMs: 0, precondition: { kind: 'create' } });
  assert.equal(created.etag.length > 0, true);

  const read = await loadRecordWithEtag(store, objectRecordKey('content_item', 'req_p1_counters'));
  assert.equal(read?.record.version, 1);
  assert.equal(read?.record.content_revision, 1);

  const retired = await retireObjectRecord(store, {
    record: { ...read!.record, status: 'archived', version: read!.record.version + 1 },
    previous_status: 'active',
    nowMs: 1,
    precondition: { kind: 'match', etag: read!.etag! },
  });
  assert.equal(retired.etag.length > 0, true);
  const afterRetire = JSON.parse(
    (await store.get(objectRecordKey('content_item', 'req_p1_counters'))) as string
  ) as ObjectRecord;
  assert.equal(afterRetire.version, 2);
  assert.equal(afterRetire.content_revision, 1, 'a status transition must never bump content_revision');
});

test('a legacy record — written before P1, with no precondition ever used — remains fully readable and writable', async () => {
  const store = freshStore();
  const key = objectRecordKey('content_item', 'req_p1_legacy');
  const legacy = baseRecord('content_item', 'req_p1_legacy', '2026-01-01T00:00:00.000Z');

  // The pre-P1 shape: a bare, unconditional setJSON, exactly what every
  // record in this store looked like before this wave — no etag was ever
  // recorded anywhere for it.
  await store.setJSON(key, legacy);

  const read = await loadRecordWithEtag(store, key);
  assert.ok(read, 'a legacy record must still be readable through the new read path');
  assert.equal(read!.record.object_id, 'req_p1_legacy');
  assert.ok(read!.etag, 'an etag is derivable from a legacy record on first read, with no migration or rewrite');

  // A real caller (object-lock.ts) must work against it unchanged.
  const checkout = await checkoutObjectLock(store, key, { actor: AGENT, nowMs: 10 });
  assert.equal(checkout.status, 200);
  const checkin = await checkinObjectLock(store, key, {
    actor: AGENT,
    lockToken: checkout.body.lockToken as string,
    nowMs: 20,
  });
  assert.equal(checkin.status, 200);
});
