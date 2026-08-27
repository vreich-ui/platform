/**
 * T5.1 (T0.2 F9, §6.4) — the object workspace's lock heartbeat, and the
 * count/shape it exists to change.
 *
 * `ObjectWorkspace.tsx` used to re-fetch the WHOLE object record every 4 s
 * while a lock was visible (`getObjectRecord`), just to read one boolean and
 * an expiry timestamp — the body tree and unbounded history dominating the
 * wire on any real article. `objectLockStatus` (server/lib/object-lock.ts)
 * already projected exactly `{action, locked, lock, version}`; it had simply
 * never been wired to an endpoint. These tests pin BOTH halves of the claim:
 * the blob-read count (unchanged — the lock lives inside the record, so a
 * `get` is unavoidable either way) and the response SHAPE (the fields that
 * are gone), following the counting-store pattern
 * `object-inventory-index.test.ts` established for T5.1 R3.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  objectLockStatus,
  checkoutObjectLock,
  type ObjectLockStore,
} from '../../packages/core/server/lib/object-lock.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');
const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };

const pageRecord = (id: string): ObjectRecord => ({
  object_id: id,
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-08-01T00:00:00.000Z',
  updated_at: '2026-08-02T00:00:00.000Z',
  status: 'active',
  body: { route: `/${id}`, title: `Page ${id}`, sections: [{ id: 's1', kind: 'hero', props: {} }] },
  publication: { published_time: null },
  history: [
    { at: '2026-08-01T00:00:00.000Z', action: 'create', actor: HUMAN, details: {} },
    { at: '2026-08-02T00:00:00.000Z', action: 'patch', actor: HUMAN, details: { note: 'body edit' } },
  ],
  version: 1,
  content_revision: 1,
});

// ═══ 1. the counting store — blob-read count is UNCHANGED, on purpose ══════
//
// The lock lives inside the ObjectRecord envelope; there is no separate lock
// document. `objectLockStatus` still has to read the whole record from the
// store to find it — 1 get, same as the old `getObjectRecord` poll. What
// changes is the WIRE, asserted separately below (§2).

const countingStore = () => {
  const blobs = new Map<string, string>();
  const counts = { get: 0, set: 0 };
  const store: ObjectLockStore = {
    get: async (key: string) => {
      counts.get += 1;
      return blobs.get(key) ?? null;
    },
    setJSON: async (key: string, value: unknown) => {
      counts.set += 1;
      blobs.set(key, JSON.stringify(value));
    },
  };
  return { store, counts, blobs };
};

test('BEFORE/AFTER: the lock projection reads exactly one blob — the same one the old full-record poll read', async () => {
  const { store, counts, blobs } = countingStore();
  const key = objectRecordKey('page', 'page_lock_test');
  blobs.set(key, JSON.stringify(pageRecord('page_lock_test')));

  await checkoutObjectLock(store, key, { actor: HUMAN, nowMs: NOW });
  counts.get = 0;
  counts.set = 0;

  const result = await objectLockStatus(store, key, { nowMs: NOW });
  assert.equal(result.status, 200);
  // Unchanged: 1 BR either way — the lock is not a separate document.
  assert.equal(counts.get, 1, 'objectLockStatus reads exactly one blob, same as the old poll');
  assert.equal(counts.set, 0, 'a status read must never write');
});

// ═══ 2. the wire shape — this is where F9's actual win is ═════════════

test('the lock projection carries none of the full envelope — no body, no history', async () => {
  const { store, blobs } = countingStore();
  const key = objectRecordKey('page', 'page_lock_shape');
  blobs.set(key, JSON.stringify(pageRecord('page_lock_shape')));
  await checkoutObjectLock(store, key, { actor: HUMAN, nowMs: NOW });

  const result = await objectLockStatus(store, key, { nowMs: NOW });
  assert.equal(result.status, 200);
  assert.deepEqual(Object.keys(result.body).sort(), ['action', 'lock', 'locked', 'version']);
  assert.equal(result.body.locked, true);
  assert.ok(result.body.lock, 'a held lock is reported');
  // The security-sensitive bit: sanitizeObjectLock strips the raw token.
  assert.equal((result.body.lock as Record<string, unknown>).token, undefined);
  assert.equal((result.body.lock as Record<string, unknown>).owner_label, 'wolf@example.com');
});

test('an object with no lock reports locked:false and an undefined lock, still with no envelope fields', async () => {
  const { store, blobs } = countingStore();
  const key = objectRecordKey('page', 'page_unlocked');
  blobs.set(key, JSON.stringify(pageRecord('page_unlocked')));

  const result = await objectLockStatus(store, key, { nowMs: NOW });
  assert.equal(result.status, 200);
  assert.equal(result.body.locked, false);
  assert.equal(result.body.lock, undefined);
  // `lock` is present as an own key with value `undefined` in the in-memory
  // object (sanitizeObjectLock's ternary), but `JSON.stringify` — what
  // actually crosses the wire — drops undefined-valued keys, so the ACTUAL
  // envelope reduction is checked against the serialised form.
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(result.body))).sort(), ['action', 'locked', 'version']);
});

test('a missing object 404s rather than throwing', async () => {
  const { store } = countingStore();
  const result = await objectLockStatus(store, objectRecordKey('page', 'nope'), { nowMs: NOW });
  assert.equal(result.status, 404);
});

// ═══ 3. the HTTP handler — auth, method, ETag/304, and the same shape ═════

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-content-view');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const reset = () => rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

process.env.ADMIN_EMAILS = 'wolf@example.com';
delete process.env.NETLIFY_BLOBS_TOKEN;
delete process.env.NETLIFY_AUTH_TOKEN;

const { handler } = await import('../../netlify/functions/admin-content-view.js');
const { getSiteObjectsBlobStore } = await import('../../packages/core/server/lib/blob-store.js');

const OWNER_CTX = { clientContext: { user: { sub: 'id-wolf', email: 'wolf@example.com' } } };
const STRANGER_CTX = { clientContext: { user: { sub: 'id-nobody', email: 'nobody@example.com' } } };

const call = async (body: Record<string, unknown>, context: unknown, headers: Record<string, string> = {}) =>
  handler({ httpMethod: 'POST', body: JSON.stringify(body), headers }, context as never);

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

test('admin-content-view: GET is refused, POST is required', async () => {
  await reset();
  const res = await handler({ httpMethod: 'GET', headers: {} } as never, OWNER_CTX as never);
  assert.equal(res.statusCode, 405);
});

test('admin-content-view: a caller outside the admin wall is refused', async () => {
  await reset();
  const res = await call({ object_type: 'page', object_id: 'page_x' }, STRANGER_CTX);
  assert.equal(res.statusCode, 403);
});

test('admin-content-view: end to end — locked record, ETag issued, unchanged tick comes back 304', async () => {
  await reset();
  const store = (await getSiteObjectsBlobStore({})) as unknown as ObjectLockStore;
  const key = objectRecordKey('page', 'page_e2e');
  await store.setJSON(key, pageRecord('page_e2e'));
  // No `nowMs` here — the handler itself checks the lock against the REAL
  // clock (`objectLockStatus` defaults to `Date.now()`), so the checkout must
  // use the same clock rather than the fixed `NOW` the counting-store tests
  // above use for their own internal consistency.
  await checkoutObjectLock(store, key, { actor: HUMAN });

  const first = await call({ object_type: 'page', object_id: 'page_e2e' }, OWNER_CTX);
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = parse(first);
  assert.equal(firstBody.locked, true);
  assert.deepEqual(Object.keys(firstBody).sort(), ['action', 'lock', 'locked', 'ok', 'status', 'version']);
  const etag = (first.headers as Record<string, string>).ETag;
  assert.ok(etag, 'an ETag must be issued');

  const second = await call({ object_type: 'page', object_id: 'page_e2e' }, OWNER_CTX, { 'if-none-match': etag });
  assert.equal(second.statusCode, 304, 'an unmoved lock must come back bodyless');
  assert.equal(second.body, '');
});

test('admin-content-view: an unknown object 404s', async () => {
  await reset();
  const res = await call({ object_type: 'page', object_id: 'does_not_exist' }, OWNER_CTX);
  assert.equal(res.statusCode, 404);
});

test('admin-content-view: rejects a malformed object_type at the schema', async () => {
  await reset();
  const res = await call({ object_type: 'not_a_real_type', object_id: 'x' }, OWNER_CTX);
  assert.equal(res.statusCode, 400);
});
