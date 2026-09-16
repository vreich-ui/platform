import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_LEASE_SECONDS,
  MAX_LEASE_SECONDS,
  checkinObjectLock,
  checkoutObjectLock,
  forceReleaseObjectLock,
  isObjectLockActive,
  lockOwnerFromPrincipal,
  objectLockStatus,
  refreshObjectLock,
  sanitizeObjectLock,
} from '../../packages/core/server/lib/object-lock.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { objectRecordSchema, type ObjectRecord, type Principal } from '../../packages/core/schema/object-record-v1.js';

// Parity spec: netlify/functions/admin-workflow-lock.ts as documented in
// docs/cms-architecture/01-audit.md §1.2, plus the D§3.1 counter rule
// ("lock writes bump version but never content_revision").

const NOW = Date.parse('2026-07-02T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

const RECORD_KEY = objectRecordKey('page', 'page_home');

const human: Principal = { kind: 'human', id: 'identity-user-1', email: 'editor@example.com' };
const agent: Principal = { kind: 'agent', agent_name: 'draft', auth: 'publish_key' };

const createMemoryStore = () => {
  const blobs = new Map<string, string>();

  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
  };
};

type Store = ReturnType<typeof createMemoryStore>;

const baseRecord = (): ObjectRecord => ({
  object_id: 'page_home',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  status: 'active',
  body: { title: 'Home' },
  publication: { published_time: null },
  history: [],
  version: 3,
  content_revision: 7,
});

const seedRecord = async (store: Store, record: ObjectRecord = baseRecord()) => {
  await store.setJSON(RECORD_KEY, record);
};

const storedRecord = (store: Store): ObjectRecord => {
  const raw = store.blobs.get(RECORD_KEY);
  assert.ok(raw, 'record must exist in the store');
  return JSON.parse(raw) as ObjectRecord;
};

const checkout = (store: Store, actor: Principal, nowMs = NOW, leaseSeconds?: number) =>
  checkoutObjectLock(store, RECORD_KEY, { actor, nowMs, ...(leaseSeconds === undefined ? {} : { leaseSeconds }) });

test('checkout acquires the lock with article defaults: 900 s lease, token, history entry, version bump', async () => {
  const store = createMemoryStore();
  await seedRecord(store);

  const result = await checkout(store, human);

  assert.equal(result.status, 200);
  assert.equal(result.ok, true);
  assert.equal(result.body.action, 'checkout');
  assert.equal(typeof result.body.lockToken, 'string');

  const record = storedRecord(store);
  assert.ok(record.lock, 'lock must be persisted');
  assert.equal(record.lock.token, result.body.lockToken);
  assert.equal(record.lock.owner_id, 'identity-user-1');
  assert.equal(record.lock.owner_label, 'editor@example.com');
  assert.equal(record.lock.acquired_at, iso(NOW));
  assert.equal(record.lock.expires_at, iso(NOW + DEFAULT_LEASE_SECONDS * 1000));

  assert.equal(record.version, 4);
  assert.equal(record.content_revision, 7);
  assert.equal(record.updated_at, iso(NOW));

  assert.equal(record.history.length, 1);
  assert.deepEqual(record.history[0], {
    at: iso(NOW),
    action: 'checkout',
    actor: human,
    details: { owner_id: 'identity-user-1', owner_label: 'editor@example.com', lease_seconds: 900 },
  });

  // The locked record still satisfies the envelope schema. M0.1: the write now
  // goes through `objects/record-writer.ts`, so the record arrives with the
  // drift alarm and its status marker — the record key is still the only one
  // the LOCK decides, but it is no longer the only one the write leaves behind.
  // (No `objects/index.json`: this fake reports no etag, so the compare-and-swap
  // the index commit needs is unavailable and the alarm is deliberately left
  // armed for the next verified sweep.)
  objectRecordSchema.parse(record);
  assert.deepEqual(
    [...store.blobs.keys()].sort(),
    ['objects/page/index/by-status/active/page_home', 'objects/version', RECORD_KEY].sort()
  );
});

test('checkout enforces the 3600 s max lease and positive-integer validation before touching the store', async () => {
  const store = createMemoryStore();
  await seedRecord(store);

  for (const leaseSeconds of [MAX_LEASE_SECONDS + 1, 0, -60, 12.5]) {
    const result = await checkout(store, human, NOW, leaseSeconds);
    assert.equal(result.status, 400, `lease ${leaseSeconds} must be rejected`);
    assert.equal(result.body.error, 'Invalid request');
    assert.ok(Array.isArray(result.body.issues));
  }
  assert.equal(storedRecord(store).version, 3, 'rejected leases must not write');

  // Invalid lease rejects before the record lookup, mirroring the endpoint's
  // zod-before-load ordering.
  const emptyStore = createMemoryStore();
  const preLoad = await checkoutObjectLock(emptyStore, RECORD_KEY, { actor: human, leaseSeconds: 9999, nowMs: NOW });
  assert.equal(preLoad.status, 400);

  const maxLease = await checkout(store, human, NOW, MAX_LEASE_SECONDS);
  assert.equal(maxLease.status, 200);
  assert.equal(storedRecord(store).lock?.expires_at, iso(NOW + MAX_LEASE_SECONDS * 1000));
});

test('checkout conflicts with 423 and sanitized holder info while a live lock is held', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const first = await checkout(store, human);

  const conflict = await checkout(store, agent, NOW + 60_000);

  assert.equal(conflict.status, 423);
  assert.equal(conflict.ok, false);
  assert.equal(conflict.body.locked, true);
  // Exactly the sanitized holder fields — never the token.
  assert.deepEqual(conflict.body.lock, {
    owner_id: 'identity-user-1',
    owner_label: 'editor@example.com',
    acquired_at: iso(NOW),
    expires_at: iso(NOW + DEFAULT_LEASE_SECONDS * 1000),
  });

  const record = storedRecord(store);
  assert.equal(record.lock?.token, first.body.lockToken, 'holder must be unchanged');
  assert.equal(record.version, 4, 'a conflicting checkout must not write');
  assert.equal(record.history.length, 1);
});

test('checkout succeeds over an expired lock', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const first = await checkout(store, human);

  const afterExpiry = NOW + (DEFAULT_LEASE_SECONDS + 1) * 1000;
  const second = await checkout(store, agent, afterExpiry);

  assert.equal(second.status, 200);
  assert.notEqual(second.body.lockToken, first.body.lockToken);

  const record = storedRecord(store);
  assert.equal(record.lock?.owner_id, 'draft');
  assert.equal(record.lock?.owner_label, 'draft');
  assert.equal(record.lock?.expires_at, iso(afterExpiry + DEFAULT_LEASE_SECONDS * 1000));
  assert.equal(record.version, 5);
});

test('checkin requires a lockToken and is idempotent without a write when no lock is held', async () => {
  const store = createMemoryStore();
  await seedRecord(store);

  const missingToken = await checkinObjectLock(store, RECORD_KEY, { actor: human, nowMs: NOW });
  assert.equal(missingToken.status, 400);
  assert.equal(missingToken.body.error, 'lockToken is required for this action');

  const idempotent = await checkinObjectLock(store, RECORD_KEY, { actor: human, lockToken: 'anything', nowMs: NOW });
  assert.equal(idempotent.status, 200);
  assert.deepEqual(idempotent.body, { action: 'checkin', idempotent: true });

  const record = storedRecord(store);
  assert.equal(record.version, 3, 'idempotent checkin must not write');
  assert.equal(record.history.length, 0);
});

test('checkin and refresh reject a mismatched token with 423 and sanitized holder info', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  await checkout(store, human);

  const sanitizedHolder = {
    owner_id: 'identity-user-1',
    owner_label: 'editor@example.com',
    acquired_at: iso(NOW),
    expires_at: iso(NOW + DEFAULT_LEASE_SECONDS * 1000),
  };

  const checkin = await checkinObjectLock(store, RECORD_KEY, { actor: agent, lockToken: 'wrong', nowMs: NOW });
  assert.equal(checkin.status, 423);
  assert.deepEqual(checkin.body, { action: 'checkin', locked: true, lock: sanitizedHolder });

  const refresh = await refreshObjectLock(store, RECORD_KEY, { actor: agent, lockToken: 'wrong', nowMs: NOW });
  assert.equal(refresh.status, 423);
  assert.deepEqual(refresh.body, { action: 'refresh', locked: true, lock: sanitizedHolder });

  // Parity quirk preserved: the mismatch branch fires before the expiry check,
  // so a wrong token against an expired lock still reports locked, not expired.
  const afterExpiry = NOW + (DEFAULT_LEASE_SECONDS + 1) * 1000;
  const staleMismatch = await checkinObjectLock(store, RECORD_KEY, {
    actor: agent,
    lockToken: 'wrong',
    nowMs: afterExpiry,
  });
  assert.equal(staleMismatch.status, 423);
  assert.equal(staleMismatch.body.locked, true);
  assert.equal(staleMismatch.body.lock_expired, undefined);

  assert.equal(storedRecord(store).version, 4, 'rejected operations must not write');
});

test('checkin and refresh return 423 lock_expired for the matching token after expiry', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const { body } = await checkout(store, human);
  const lockToken = body.lockToken as string;
  const afterExpiry = NOW + (DEFAULT_LEASE_SECONDS + 1) * 1000;

  const checkin = await checkinObjectLock(store, RECORD_KEY, { actor: human, lockToken, nowMs: afterExpiry });
  assert.equal(checkin.status, 423);
  assert.deepEqual(checkin.body, { action: 'checkin', error: 'lock_expired', lock_expired: true });

  const refresh = await refreshObjectLock(store, RECORD_KEY, { actor: human, lockToken, nowMs: afterExpiry });
  assert.equal(refresh.status, 423);
  assert.deepEqual(refresh.body, { action: 'refresh', error: 'lock_expired', lock_expired: true });

  assert.equal(storedRecord(store).version, 4, 'expired-token operations must not write');
});

test('checkin releases the lock, appends a history entry with the released owner, and bumps version', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const { body } = await checkout(store, human);

  const result = await checkinObjectLock(store, RECORD_KEY, {
    actor: human,
    lockToken: body.lockToken as string,
    nowMs: NOW + 60_000,
  });

  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { action: 'checkin', checked_in: true });

  const record = storedRecord(store);
  assert.equal('lock' in record, false, 'released lock must not survive the JSON round-trip');
  assert.equal(record.version, 5);
  assert.equal(record.content_revision, 7);
  assert.equal(record.updated_at, iso(NOW + 60_000));
  assert.deepEqual(record.history[1], {
    at: iso(NOW + 60_000),
    action: 'checkin',
    actor: human,
    details: { owner_id: 'identity-user-1', owner_label: 'editor@example.com' },
  });
});

test('refresh extends the lease from the current expiry, not from now', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const { body } = await checkout(store, human);
  const lockToken = body.lockToken as string;

  const result = await refreshObjectLock(store, RECORD_KEY, {
    actor: human,
    lockToken,
    leaseSeconds: 600,
    nowMs: NOW + 100_000,
  });

  assert.equal(result.status, 200);
  const record = storedRecord(store);
  assert.equal(
    record.lock?.expires_at,
    iso(NOW + DEFAULT_LEASE_SECONDS * 1000 + 600_000),
    'refresh must add the lease to the previous expiry, ignoring the current time'
  );
  assert.equal(record.lock?.token, lockToken, 'refresh must keep the same token');
  assert.equal(record.lock?.acquired_at, iso(NOW));
  assert.equal(record.version, 5);

  // Parity quirk preserved: refresh history details carry owner_id and
  // lease_seconds but no owner_label.
  assert.deepEqual(record.history[1], {
    at: iso(NOW + 100_000),
    action: 'refresh',
    actor: human,
    details: { owner_id: 'identity-user-1', lease_seconds: 600 },
  });

  assert.deepEqual(result.body, {
    action: 'refresh',
    lock: sanitizeObjectLock(record.lock),
  });
});

test('refresh without an explicit lease extends by the 900 s default', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const { body } = await checkout(store, human);

  await refreshObjectLock(store, RECORD_KEY, { actor: human, lockToken: body.lockToken as string, nowMs: NOW });

  assert.equal(storedRecord(store).lock?.expires_at, iso(NOW + 2 * DEFAULT_LEASE_SECONDS * 1000));
});

test('status is read-only and reports the sanitized lock and version', async () => {
  const store = createMemoryStore();
  await seedRecord(store);

  const unlocked = await objectLockStatus(store, RECORD_KEY, { nowMs: NOW });
  assert.equal(unlocked.status, 200);
  assert.deepEqual(unlocked.body, { action: 'status', locked: false, lock: undefined, version: 3 });

  await checkout(store, human);
  const locked = await objectLockStatus(store, RECORD_KEY, { nowMs: NOW + 60_000 });
  assert.equal(locked.body.locked, true);
  assert.deepEqual(locked.body.lock, {
    owner_id: 'identity-user-1',
    owner_label: 'editor@example.com',
    acquired_at: iso(NOW),
    expires_at: iso(NOW + DEFAULT_LEASE_SECONDS * 1000),
  });
  assert.equal(locked.body.version, 4);

  // An expired lock reports locked: false but still surfaces the sanitized holder.
  const expired = await objectLockStatus(store, RECORD_KEY, { nowMs: NOW + (DEFAULT_LEASE_SECONDS + 1) * 1000 });
  assert.equal(expired.body.locked, false);
  assert.ok(expired.body.lock);

  const record = storedRecord(store);
  assert.equal(record.version, 4, 'status must never write');
  assert.equal(record.history.length, 1);
});

test('force_release is idempotent without a lock and breaks any held lock with previous-owner history', async () => {
  const store = createMemoryStore();
  await seedRecord(store);

  const idempotent = await forceReleaseObjectLock(store, RECORD_KEY, { actor: agent, nowMs: NOW });
  assert.equal(idempotent.status, 200);
  assert.deepEqual(idempotent.body, { action: 'force_release', idempotent: true, message: 'No lock was held' });
  assert.equal(storedRecord(store).version, 3, 'idempotent force_release must not write');

  await checkout(store, human);
  const released = await forceReleaseObjectLock(store, RECORD_KEY, { actor: agent, nowMs: NOW + 60_000 });
  assert.equal(released.status, 200);
  assert.deepEqual(released.body, { action: 'force_release', released: true });

  const record = storedRecord(store);
  assert.equal('lock' in record, false);
  assert.equal(record.version, 5);
  assert.deepEqual(record.history[1], {
    at: iso(NOW + 60_000),
    action: 'force_release',
    actor: agent,
    details: {
      forced_by: 'draft',
      previous_owner_id: 'identity-user-1',
      previous_owner_label: 'editor@example.com',
    },
  });
});

test('every operation returns 404 not_found for a missing record', async () => {
  const store = createMemoryStore();
  const results = await Promise.all([
    checkoutObjectLock(store, RECORD_KEY, { actor: human, nowMs: NOW }),
    checkinObjectLock(store, RECORD_KEY, { actor: human, lockToken: 'token', nowMs: NOW }),
    refreshObjectLock(store, RECORD_KEY, { actor: human, lockToken: 'token', nowMs: NOW }),
    objectLockStatus(store, RECORD_KEY, { nowMs: NOW }),
    forceReleaseObjectLock(store, RECORD_KEY, { actor: human, nowMs: NOW }),
  ]);

  for (const result of results) {
    assert.equal(result.status, 404);
    assert.deepEqual(result.body, { error: 'Object record not found', not_found: true });
  }
});

test('lock writes bump version but never content_revision, and leave the rest of the envelope untouched', async () => {
  const store = createMemoryStore();
  const seeded = baseRecord();
  await seedRecord(store, seeded);

  const assertCounters = (expectedVersion: number, step: string) => {
    const record = storedRecord(store);
    assert.equal(record.version, expectedVersion, `version after ${step}`);
    assert.equal(record.content_revision, 7, `content_revision must never move (after ${step})`);
    // Lock traffic must not disturb any content-bearing field.
    assert.deepEqual(record.body, seeded.body, `body after ${step}`);
    assert.deepEqual(record.publication, seeded.publication, `publication after ${step}`);
    assert.equal(record.status, seeded.status, `status after ${step}`);
    assert.equal(record.object_id, seeded.object_id, `object_id after ${step}`);
    assert.equal(record.schema_version, seeded.schema_version, `schema_version after ${step}`);
    assert.equal(record.created_at, seeded.created_at, `created_at after ${step}`);
    return record;
  };

  const first = await checkout(store, human);
  assertCounters(4, 'checkout');

  await refreshObjectLock(store, RECORD_KEY, {
    actor: human,
    lockToken: first.body.lockToken as string,
    nowMs: NOW + 60_000,
  });
  assertCounters(5, 'refresh');

  await checkinObjectLock(store, RECORD_KEY, {
    actor: human,
    lockToken: first.body.lockToken as string,
    nowMs: NOW + 120_000,
  });
  assertCounters(6, 'checkin');

  await checkout(store, agent, NOW + 180_000);
  assertCounters(7, 'second checkout');

  await forceReleaseObjectLock(store, RECORD_KEY, { actor: human, nowMs: NOW + 240_000 });
  const final = assertCounters(8, 'force_release');

  assert.equal(final.history.length, 5, 'each lock write appends exactly one history entry');
  objectRecordSchema.parse(final);
});

test('no lock payload returned to callers ever includes the token', async () => {
  const store = createMemoryStore();
  await seedRecord(store);
  const first = await checkout(store, human);

  const surfaces = [
    first,
    await checkout(store, agent, NOW + 1000),
    await objectLockStatus(store, RECORD_KEY, { nowMs: NOW }),
    await checkinObjectLock(store, RECORD_KEY, { actor: agent, lockToken: 'wrong', nowMs: NOW }),
    await refreshObjectLock(store, RECORD_KEY, {
      actor: human,
      lockToken: first.body.lockToken as string,
      nowMs: NOW,
    }),
  ];

  for (const surface of surfaces) {
    const lock = surface.body.lock as Record<string, unknown> | undefined;
    if (lock) assert.equal('token' in lock, false, `${surface.body.action} must sanitize the lock`);
  }
});

test('lockOwnerFromPrincipal maps humans to id/email and agents to agent_name', () => {
  assert.deepEqual(lockOwnerFromPrincipal(human), {
    owner_id: 'identity-user-1',
    owner_label: 'editor@example.com',
  });
  assert.deepEqual(lockOwnerFromPrincipal(agent), { owner_id: 'draft', owner_label: 'draft' });
});

test('isObjectLockActive and sanitizeObjectLock handle the missing-lock case', () => {
  assert.equal(isObjectLockActive(undefined, NOW), false);
  assert.equal(sanitizeObjectLock(undefined), undefined);

  const lock = {
    token: 'secret',
    owner_id: 'a',
    owner_label: 'b',
    acquired_at: iso(NOW),
    expires_at: iso(NOW + 1000),
  };
  assert.equal(isObjectLockActive(lock, NOW), true);
  assert.equal(isObjectLockActive(lock, NOW + 1000), false, 'a lock expiring exactly now is inactive');
  assert.deepEqual(sanitizeObjectLock(lock), {
    owner_id: 'a',
    owner_label: 'b',
    acquired_at: iso(NOW),
    expires_at: iso(NOW + 1000),
  });
});
