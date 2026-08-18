/**
 * W18 T18.4 — offboarding: revoke removes exactly the subject's OAuth grants
 * and nobody else's; a revoked token fails at principal resolution; force
 * release writes history with on_behalf_of; remove with/without an identity
 * token (immediate vs queued) and with the policy flag off (identity kept);
 * purge scrubs PII and keeps audit; last_owner on remove/transfer; export
 * bundle shape; sweep idempotent; the queue drains on the next Owner request.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-users.js';
import { runMembershipSweep } from '../../packages/core/server/functions/membership-sweep.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import {
  getUserRecord,
  putUserRecord,
  listUserRecords,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import { getMembershipByEmail } from '../../packages/core/server/lib/membership/read.js';
import { setPolicy, saveMember, newMember } from '../../packages/core/server/lib/membership/write.js';
import { KEYS, PREFIXES, personIdForEmail } from '../../packages/core/server/lib/membership/store.js';
import { createInvitation } from '../../packages/core/server/lib/membership/invitations.js';
import {
  revokeOAuthGrantsForSubject,
  releaseLocksHeldBy,
  deleteOrQueueIdentity,
  drainIdentityDeleteQueue,
  purgeExpiredMemberships,
  transferOwnership,
  exportPerson,
  purgeConfirmMatches,
  OffboardingError,
} from '../../packages/core/server/lib/membership/offboarding.js';
import {
  putAccessTokenRecord,
  putRefreshTokenRecord,
  getAccessTokenRecord,
  getRefreshTokenRecord,
  subjectIndexPrefix,
  type OAuthBlobStore,
} from '../../packages/core/server/lib/oauth-store.js';
import { resolveOAuthPrincipal } from '../../packages/core/server/lib/oauth-server.js';
import { objectRecordKey, objectStatusIndexKey } from '../../packages/core/server/lib/object-store-keys.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import type { ObjectRecord } from '../../packages/core/schema/object-record-v1.js';

const AT = '2026-08-17T12:00:00.000Z';
const LATER = '2026-09-20T12:00:00.000Z';
const SITE = 'site_drlurie';
const IDENTITY = { url: 'https://site/.netlify/identity', token: 'admin-token' };
const handler = createHandler(drlurieSiteBinding);
const ROLE_ENV_KEYS = ['ADMIN_EMAILS', 'ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR'] as const;

const memStore = () => {
  const map = new Map<string, string>();
  return {
    map,
    async get(key: string) {
      return map.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      map.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
    async delete(key: string) {
      map.delete(key);
    },
  };
};
type Mem = ReturnType<typeof memStore>;

const tokenRecord = (email: string, over: Record<string, unknown> = {}) => ({
  schema_version: 'oauth-access-token.v1' as const,
  client_id: 'c1',
  client_name: 'Claude',
  subject_email: email,
  subject_id: `id-${email}`,
  scope: 'mcp offline_access',
  resource: 'https://site/mcp',
  site: SITE,
  issued_at: AT,
  expires_at: '2099-01-01T00:00:00.000Z',
  ...over,
});
const refreshRecord = (email: string) => ({ ...tokenRecord(email), schema_version: 'oauth-refresh-token.v1' as const });

const activeMember = (email: string, role: 'owner' | 'admin' | 'editor' | 'viewer' = 'admin', user_id?: string) => ({
  schema_version: 1 as const,
  email,
  display_name: email.split('@')[0],
  role,
  status: 'active' as const,
  invited_by: 'boss@example.com',
  created_at: AT,
  updated_at: AT,
  audit: [],
  ...(user_id ? { user_id } : {}),
});

const objectWithLock = (id: string, owner: { owner_id: string; owner_label: string }): ObjectRecord =>
  ({
    object_id: id,
    object_type: 'page',
    status: 'active',
    version: 3,
    created_at: AT,
    updated_at: AT,
    lock: {
      owner_id: owner.owner_id,
      owner_label: owner.owner_label,
      token: 'tok',
      acquired_at: AT,
      expires_at: '2099-01-01T00:00:00.000Z',
    },
    history: [],
    body: {},
  }) as unknown as ObjectRecord;

const auditActions = (store: Mem) =>
  [...store.map.keys()]
    .filter((k) => k.startsWith(PREFIXES.audit))
    .map((k) => JSON.parse(store.map.get(k)!).action as string);

// ─── OAuth revocation ────────────────────────────────────────────────────────

test('revokeOAuthGrantsForSubject deletes exactly the subject’s access/refresh records (via the by-subject index) and nobody else’s', async () => {
  const oauth = memStore() as unknown as OAuthBlobStore & Mem;
  await putAccessTokenRecord(oauth, 'jane-token', tokenRecord('jane@x.com'));
  await putRefreshTokenRecord(oauth, 'jane-refresh', refreshRecord('jane@x.com'));
  await putAccessTokenRecord(oauth, 'bob-token', tokenRecord('bob@x.com'));
  assert.equal(oauth.map.size, 6, '3 records + 3 index entries');
  assert.equal([...oauth.map.keys()].filter((k) => k.startsWith(subjectIndexPrefix('jane@x.com'))).length, 2);

  const before = await resolveOAuthPrincipal(oauth, {
    token: 'jane-token',
    site: SITE,
    resourceUri: 'https://site/mcp',
    nowMs: Date.now(),
  });
  assert.equal(before?.subject_email, 'jane@x.com');

  const r = await revokeOAuthGrantsForSubject(oauth, 'Jane@X.com');
  assert.equal(r.revoked, 2);
  assert.deepEqual(r.kinds, { token: 1, refresh: 1, code: 0 });
  assert.equal(await getAccessTokenRecord(oauth, 'jane-token', SITE), null);
  assert.equal(await getRefreshTokenRecord(oauth, 'jane-refresh', SITE), null);
  assert.equal(
    await resolveOAuthPrincipal(oauth, {
      token: 'jane-token',
      site: SITE,
      resourceUri: 'https://site/mcp',
      nowMs: Date.now(),
    }),
    null,
    'revoked token fails principal resolution'
  );
  assert.equal((await getAccessTokenRecord(oauth, 'bob-token', SITE))?.subject_email, 'bob@x.com', 'bob untouched');
  assert.equal(
    [...oauth.map.keys()].filter((k) => k.startsWith(subjectIndexPrefix('jane@x.com'))).length,
    0,
    'index cleared'
  );
  // idempotent
  assert.equal((await revokeOAuthGrantsForSubject(oauth, 'jane@x.com')).revoked, 0);
  // a store that cannot list revokes nothing and says so
  const noList = { get: oauth.get, setJSON: oauth.setJSON } as unknown as OAuthBlobStore;
  assert.match((await revokeOAuthGrantsForSubject(noList, 'bob@x.com')).error ?? '', /cannot list/);
});

// ─── lock hand-off ───────────────────────────────────────────────────────────

test('releaseLocksHeldBy force-releases only the person’s active locks and writes lock_forced_on_offboarding with on_behalf_of', async () => {
  const objects = memStore();
  const put = async (rec: ObjectRecord) => {
    await objects.setJSON(objectRecordKey('page', rec.object_id), rec);
    await objects.setJSON(objectStatusIndexKey('page', 'active', rec.object_id), '');
  };
  await put(objectWithLock('page_a', { owner_id: 'gotrue-jane', owner_label: 'jane@x.com' }));
  await put(objectWithLock('page_b', { owner_id: 'gotrue-bob', owner_label: 'bob@x.com' }));
  await put(objectWithLock('page_c', { owner_id: 'writer', owner_label: 'Jane@x.com' })); // label match, no user id
  const released = await releaseLocksHeldBy(objects, {
    person: { email: 'jane@x.com', person_id: personIdForEmail('jane@x.com'), user_id: 'gotrue-jane' },
    actor: { kind: 'human', id: 'gotrue-boss', email: 'boss@x.com' },
    at: LATER,
    reason: 'remove',
  });
  assert.deepEqual(released.map((r) => r.object_id).sort(), ['page_a', 'page_c']);
  const a = JSON.parse(objects.map.get(objectRecordKey('page', 'page_a'))!) as ObjectRecord;
  assert.equal(a.lock, undefined);
  assert.equal(a.version, 4);
  const h = a.history.at(-1)!;
  assert.equal(h.action, 'lock_forced_on_offboarding');
  assert.deepEqual(h.actor, { kind: 'human', id: 'gotrue-boss', email: 'boss@x.com' });
  assert.deepEqual((h.details as { on_behalf_of: unknown }).on_behalf_of, {
    email: 'jane@x.com',
    person_id: personIdForEmail('jane@x.com'),
    user_id: 'gotrue-jane',
  });
  assert.equal((h.details as { previous_owner_id: string }).previous_owner_id, 'gotrue-jane');
  const b = JSON.parse(objects.map.get(objectRecordKey('page', 'page_b'))!) as ObjectRecord;
  assert.ok(b.lock, 'bob keeps his lock');
  assert.equal(b.version, 3);
});

// ─── identity delete: immediate vs queued ────────────────────────────────────

test('deleteOrQueueIdentity: with a token → DELETE /admin/users/{id} (404 idempotent); without → queued; drain runs later with a token', async () => {
  const store = memStore() as unknown as UsersBlobStore & Mem;
  const calls: Array<{ url: string; method?: string }> = [];
  const gotrue = async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method });
    if (init?.method === 'DELETE')
      return {
        ok: url.endsWith('/known') || url.endsWith('/gone') ? true : false,
        status: url.endsWith('/gone') ? 404 : 200,
      };
    return { ok: true, status: 200, json: async () => ({ users: [{ id: 'looked-up', email: 'lookup@x.com' }] }) };
  };
  const person = { person_id: 'usr_a', email: 'a@x.com', user_id: 'known' };
  const immediate = await deleteOrQueueIdentity(store, {
    person,
    identity: IDENTITY,
    fetchImpl: gotrue,
    at: AT,
    reason: 'test',
  });
  assert.equal(immediate.outcome, 'deleted');
  assert.equal(calls.at(-1)?.url, 'https://site/.netlify/identity/admin/users/known');
  assert.equal(calls.at(-1)?.method, 'DELETE');
  // 404 is idempotent success
  assert.equal(
    (
      await deleteOrQueueIdentity(store, {
        person: { ...person, user_id: 'gone' },
        identity: IDENTITY,
        fetchImpl: gotrue,
        at: AT,
        reason: 't',
      })
    ).outcome,
    'deleted'
  );
  // no user_id → look it up by e-mail
  const looked = await deleteOrQueueIdentity(store, {
    person: { person_id: 'usr_l', email: 'lookup@x.com' },
    identity: IDENTITY,
    fetchImpl: async (url, init) => (init?.method === 'DELETE' ? { ok: true, status: 200 } : gotrue(url, init)),
    at: AT,
    reason: 't',
  });
  assert.equal(looked.outcome, 'deleted');
  assert.equal(looked.gotrue_user_id, 'looked-up');
  // no token → queued
  const queued = await deleteOrQueueIdentity(store, {
    person: { person_id: 'usr_q', email: 'q@x.com', user_id: 'q-id' },
    at: AT,
    reason: 'removed',
  });
  assert.equal(queued.outcome, 'queued');
  assert.ok(store.map.has('identity-delete-queue/usr_q.json'));
  // sweep reports it, cannot drain it
  const noDrain = await drainIdentityDeleteQueue(store, { at: AT });
  assert.deepEqual(noDrain, { drained: 0, remaining: 1 });
  // an Owner request with a token drains it
  const drained = await drainIdentityDeleteQueue(store, {
    identity: IDENTITY,
    fetchImpl: async () => ({ ok: true, status: 200 }),
    at: LATER,
    actor: { kind: 'human', email: 'boss@x.com' },
  });
  assert.deepEqual(drained, { drained: 1, remaining: 0 });
  assert.equal(store.map.has('identity-delete-queue/usr_q.json'), false);
  assert.ok(auditActions(store).includes('person.sessions_revoked'));
});

// ─── purge / sweep ───────────────────────────────────────────────────────────

test('purgeExpiredMemberships scrubs PII (person → {person_id, deleted}), removes indexes, keeps membership removed + audit; idempotent; sweep wrapper reports', async () => {
  const store = memStore() as unknown as UsersBlobStore & Mem;
  const m = newMember({
    email: 'gone@x.com',
    display_name: 'Gone Person',
    role: 'admin',
    status: 'removed',
    source: 'invitation',
    granted_by: { kind: 'human', email: 'boss@x.com' },
    invited_by: 'boss@x.com',
    at: AT,
    user_id: 'gotrue-gone',
  });
  m.membership.removed = { at: AT, by: 'boss@x.com', purge_after: '2026-09-16T12:00:00.000Z' };
  m.person.avatar_artifact = 'image/req1/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';
  await saveMember(store, m);
  await putUserRecord(store, activeMember('stay@x.com'));
  const softDeleted: string[] = [];
  // before purge_after: nothing
  assert.deepEqual(await purgeExpiredMemberships(store, { now: '2026-09-01T00:00:00.000Z' }), []);
  const purged = await purgeExpiredMemberships(store, {
    now: LATER,
    softDeleteAvatar: async (ref) => void softDeleted.push(ref),
  });
  assert.deepEqual(purged, [m.person.person_id]);
  assert.deepEqual(softDeleted, [m.person.avatar_artifact]);
  const scrubbed = JSON.parse(store.map.get(KEYS.person(m.person.person_id))!);
  assert.deepEqual(Object.keys(scrubbed).sort(), ['deleted', 'deleted_at', 'person_id', 'schema_version']);
  assert.equal(scrubbed.deleted, true);
  assert.equal(store.map.has(KEYS.byEmail('gone@x.com')), false);
  assert.equal(store.map.has(KEYS.byIdentity('gotrue-gone')), false);
  assert.equal(await getMembershipByEmail(store, 'gone@x.com'), null, 'e-mail no longer resolves');
  const membership = JSON.parse(store.map.get(KEYS.membership(m.person.person_id))!);
  assert.equal(membership.status, 'removed');
  assert.ok(membership.audit.some((a: { action: string }) => a.action === 'purge'));
  assert.ok(auditActions(store).includes('membership.purge'));
  // stay@x.com untouched; sweep is idempotent
  assert.equal((await getUserRecord(store, 'stay@x.com'))?.status, 'active');
  assert.deepEqual(await purgeExpiredMemberships(store, { now: LATER }), []);
  assert.equal((await listUserRecords(store)).map((r) => r.email).join(','), 'stay@x.com');
  // the sweep function
  const savedNetlify = process.env.NETLIFY;
  process.env.NETLIFY = 'true';
  setNetlifyBlobsModuleForTesting({ connectLambda() {}, getStore: () => store as never });
  try {
    const result = await runMembershipSweep({}, LATER);
    assert.equal(result.ok, true);
    assert.deepEqual(result.purged_persons, []);
    assert.equal(result.identity_deletes_queued, 0);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (savedNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = savedNetlify;
  }
});

// ─── transfer / export / confirm ─────────────────────────────────────────────

test('transferOwnership: both active → to becomes owner, from becomes admin (or keeps); errors: same person, not found, not active', async () => {
  const store = memStore() as unknown as UsersBlobStore & Mem;
  await putUserRecord(store, activeMember('a@x.com', 'owner'));
  await putUserRecord(store, activeMember('b@x.com', 'editor'));
  const actor = { kind: 'human' as const, email: 'a@x.com' };
  const r = await transferOwnership(store, { from: 'a@x.com', to: 'B@x.com', actor, actorEmail: 'a@x.com', at: LATER });
  assert.equal(r.to.membership.role, 'owner');
  assert.equal(r.from.membership.role, 'admin');
  assert.ok(auditActions(store).includes('membership.transfer_ownership'));
  const keep = await transferOwnership(store, {
    from: 'b@x.com',
    to: 'a@x.com',
    actor,
    actorEmail: 'b@x.com',
    at: LATER,
    demoteTo: 'keep',
  });
  assert.equal(keep.from.membership.role, 'owner');
  assert.equal(keep.to.membership.role, 'owner');
  await assert.rejects(
    () => transferOwnership(store, { from: 'a@x.com', to: 'a@x.com', actor, actorEmail: 'a@x.com', at: LATER }),
    (e: OffboardingError) => e.code === 'same_person'
  );
  await assert.rejects(
    () => transferOwnership(store, { from: 'a@x.com', to: 'nobody@x.com', actor, actorEmail: 'a@x.com', at: LATER }),
    (e: OffboardingError) => e.code === 'not_found'
  );
  await putUserRecord(store, { ...activeMember('s@x.com', 'admin'), status: 'disabled' });
  await assert.rejects(
    () => transferOwnership(store, { from: 'a@x.com', to: 's@x.com', actor, actorEmail: 'a@x.com', at: LATER }),
    (e: OffboardingError) => e.code === 'not_active'
  );
});

test('exportPerson bundle: person, memberships, invitations, audit slice, authored object-history ids only; purgeConfirmMatches is exact', async () => {
  const store = memStore() as unknown as UsersBlobStore & Mem;
  const created = await createInvitation(store, {
    email: 'ex@x.com',
    role: 'editor',
    invitedBy: { email: 'boss@x.com' },
    actor: { kind: 'human', email: 'boss@x.com' },
    at: AT,
  });
  const objects = memStore();
  const rec = objectWithLock('page_x', { owner_id: 'z', owner_label: 'z' });
  rec.lock = undefined;
  rec.history = [
    { at: AT, action: 'patch', actor: { kind: 'human', id: 'gotrue-ex', email: 'EX@x.com' } },
    { at: AT, action: 'patch', actor: { kind: 'human', id: 'other', email: 'other@x.com' } },
    { at: AT, action: 'publish', actor: { kind: 'agent', agent_name: 'w', auth: 'mcp_token' } },
  ];
  await objects.setJSON(objectRecordKey('page', 'page_x'), rec);
  await objects.setJSON(objectStatusIndexKey('page', 'active', 'page_x'), '');
  const bundle = await exportPerson(store, { email: 'ex@x.com', at: LATER, objectStore: objects });
  assert.ok(bundle);
  assert.equal(bundle.person.email, 'ex@x.com');
  assert.equal(bundle.memberships.length, 1);
  assert.equal(bundle.invitations[0]?.invite_id, created.invitation.invite_id);
  assert.ok(bundle.audit.some((e) => e.action === 'invitation.create'));
  assert.deepEqual(bundle.authored_history, [{ object_type: 'page', object_id: 'page_x', at: AT, action: 'patch' }]);
  assert.equal(JSON.stringify(bundle).includes('other@x.com'), false, 'no third-party PII');
  assert.equal(await exportPerson(store, { email: 'nobody@x.com', at: LATER }), null);
  assert.equal(purgeConfirmMatches('PURGE ex@x.com', 'EX@x.com'), true);
  assert.equal(purgeConfirmMatches('purge ex@x.com ', 'ex@x.com'), true);
  assert.equal(purgeConfirmMatches('PURGE other@x.com', 'ex@x.com'), false);
  assert.equal(purgeConfirmMatches(undefined, 'ex@x.com'), false);
});

// ─── through the handler ─────────────────────────────────────────────────────

const withStores = async (
  env: Partial<Record<(typeof ROLE_ENV_KEYS)[number], string>>,
  fn: (stores: { users: UsersBlobStore & Mem; governance: OAuthBlobStore & Mem; objects: Mem }) => Promise<void>
) => {
  const savedEnv = [...ROLE_ENV_KEYS, 'NETLIFY', 'NETLIFY_SITE_ID'].map((key) => [key, process.env[key]] as const);
  const users = memStore() as unknown as UsersBlobStore & Mem;
  const governance = memStore() as unknown as OAuthBlobStore & Mem;
  const objects = memStore();
  for (const key of ROLE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(opts: unknown) {
      const name = typeof opts === 'string' ? opts : (opts as { name?: string })?.name;
      if (name === 'governance') return governance as never;
      if (name === 'site-objects') return objects as never;
      return users as never;
    },
  });
  try {
    await fn({ users, governance, objects });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};
const contextFor = (email: string, sub = 'user-1', identity?: { url: string; token: string }) => ({
  clientContext: { user: { sub, email }, ...(identity ? { identity } : {}) },
});
const post = (verb: string, fields: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  body: JSON.stringify({ verb, ...fields }),
});

test('handler: suspend revokes OAuth grants + hands off locks; remove also queues (no token) or deletes (token) the identity; policy flag off keeps it; last_owner on remove; purge needs the typed confirm; transfer_ownership; export_person', async () => {
  const savedFetch = globalThis.fetch;
  const gotrueCalls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    gotrueCalls.push(`${init?.method ?? 'GET'} ${url}`);
    if (init?.method === 'DELETE') return new Response('{}', { status: 200 });
    return new Response(JSON.stringify({ users: [] }), { status: 200 });
  }) as typeof fetch;
  try {
    await withStores({ ADMIN_EMAILS: 'boot@example.com' }, async ({ users, governance, objects }) => {
      await putUserRecord(users, activeMember('jane@example.com', 'editor', 'gotrue-jane'));
      await putUserRecord(users, activeMember('solo@example.com', 'owner', 'gotrue-solo'));
      await putAccessTokenRecord(governance, 'jane-token', tokenRecord('jane@example.com'));
      await putRefreshTokenRecord(governance, 'jane-refresh', refreshRecord('jane@example.com'));
      await putAccessTokenRecord(governance, 'boot-token', tokenRecord('boot@example.com'));
      await objects.setJSON(
        objectRecordKey('page', 'p1'),
        objectWithLock('p1', { owner_id: 'gotrue-jane', owner_label: 'jane@example.com' })
      );
      await objects.setJSON(objectStatusIndexKey('page', 'active', 'p1'), '');

      // suspend: grants gone, lock handed off
      const sus = await handler(
        post('suspend', { email: 'jane@example.com', reason: 'leave' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(sus.statusCode, 200);
      const susBody = JSON.parse(sus.body);
      assert.equal(susBody.offboarding.oauth_revoked, 2);
      assert.deepEqual(susBody.offboarding.locks_released, [{ object_id: 'p1', object_type: 'page' }]);
      assert.equal(await getAccessTokenRecord(governance, 'jane-token', SITE), null);
      assert.equal((await getAccessTokenRecord(governance, 'boot-token', SITE))?.subject_email, 'boot@example.com');
      const p1 = JSON.parse(objects.map.get(objectRecordKey('page', 'p1'))!) as ObjectRecord;
      assert.equal(p1.lock, undefined);
      assert.equal(p1.history.at(-1)?.action, 'lock_forced_on_offboarding');

      // remove WITHOUT identity token → identity queued (policy default true)
      const rem = await handler(
        post('remove', { email: 'jane@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(rem.statusCode, 200);
      assert.equal(JSON.parse(rem.body).offboarding.identity.outcome, 'queued');
      assert.equal(JSON.parse(rem.body).user.membership_status, 'removed');
      assert.ok(users.map.has(`identity-delete-queue/${personIdForEmail('jane@example.com')}.json`));

      // the next Owner request WITH a token drains the queue (DELETE fired)
      gotrueCalls.length = 0;
      await handler(post('list'), contextFor('boot@example.com', 'gotrue-boot', IDENTITY));
      assert.ok(
        gotrueCalls.some((c) => c === 'DELETE https://site/.netlify/identity/admin/users/gotrue-jane'),
        gotrueCalls.join(' | ')
      );
      assert.equal(users.map.has(`identity-delete-queue/${personIdForEmail('jane@example.com')}.json`), false);

      // remove WITH a token → immediate delete; with delete_identity:false → kept
      await putUserRecord(users, activeMember('kim@example.com', 'viewer', 'gotrue-kim'));
      gotrueCalls.length = 0;
      const remNow = await handler(
        post('remove', { email: 'kim@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
      );
      assert.equal(JSON.parse(remNow.body).offboarding.identity.outcome, 'deleted');
      assert.ok(gotrueCalls.includes('DELETE https://site/.netlify/identity/admin/users/gotrue-kim'));
      await putUserRecord(users, activeMember('lee@example.com', 'viewer', 'gotrue-lee'));
      gotrueCalls.length = 0;
      const remKeep = await handler(
        post('remove', { email: 'lee@example.com', delete_identity: false }),
        contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
      );
      assert.equal(JSON.parse(remKeep.body).offboarding.identity.outcome, 'kept');
      assert.equal(
        gotrueCalls.some((c) => c.startsWith('DELETE')),
        false
      );
      // policy flag off ⇒ kept by default
      await setPolicy(users, { delete_identity_on_remove: false });
      await putUserRecord(users, activeMember('pat@example.com', 'viewer', 'gotrue-pat'));
      const remPolicy = await handler(
        post('remove', { email: 'pat@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
      );
      assert.equal(JSON.parse(remPolicy.body).offboarding.identity.outcome, 'kept');
      await setPolicy(users, { delete_identity_on_remove: true, min_owners: 2 });

      // last_owner: env owner + 1 stored owner, min 2 → removing solo breaches
      const last = await handler(
        post('remove', { email: 'solo@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(last.statusCode, 409);
      assert.equal(JSON.parse(last.body).error_code, 'last_owner');
      await setPolicy(users, { min_owners: 1 });

      // purge: needs the exact typed confirm and a removed member
      const bad = await handler(
        post('purge', { email: 'jane@example.com', confirm: 'PURGE someone@else.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(bad.statusCode, 400);
      assert.equal(JSON.parse(bad.body).error_code, 'confirm_mismatch');
      const notRemoved = await handler(
        post('purge', { email: 'solo@example.com', confirm: 'PURGE solo@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(JSON.parse(notRemoved.body).error_code, 'not_removed');
      const purge = await handler(
        post('purge', { email: 'jane@example.com', confirm: 'PURGE jane@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
      );
      assert.equal(purge.statusCode, 200);
      assert.equal(JSON.parse(purge.body).purged, true);
      assert.equal(await getUserRecord(users, 'jane@example.com'), null);
      assert.ok(auditActions(users).includes('membership.purge'));
      assert.ok(auditActions(users).includes('membership.remove'));
      assert.ok(auditActions(users).includes('membership.suspend'));

      // transfer_ownership: solo → new owner, solo demoted
      await putUserRecord(users, activeMember('heir@example.com', 'admin', 'gotrue-heir'));
      const tr = await handler(
        post('transfer_ownership', { from_email: 'solo@example.com', to_email: 'heir@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(tr.statusCode, 200);
      assert.equal(JSON.parse(tr.body).to.role, 'owner');
      assert.equal(JSON.parse(tr.body).from.role, 'admin');
      const envT = await handler(
        post('transfer_ownership', { to_email: 'boot@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(JSON.parse(envT.body).error_code, 'env_managed_member');

      // export_person
      const ex = await handler(
        post('export_person', { email: 'heir@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot')
      );
      assert.equal(ex.statusCode, 200);
      const bundle = JSON.parse(ex.body).export;
      assert.equal(bundle.person.email, 'heir@example.com');
      assert.ok(Array.isArray(bundle.audit));
      assert.ok(Array.isArray(bundle.authored_history));

      // unmanaged_identities advertises delete_identity only with a token; delete_identity verb refuses members
      assert.equal(
        JSON.parse((await handler(post('unmanaged_identities'), contextFor('boot@example.com', 'gotrue-boot'))).body)
          .capabilities.delete_identity,
        false
      );
      assert.equal(
        JSON.parse(
          (await handler(post('unmanaged_identities'), contextFor('boot@example.com', 'gotrue-boot', IDENTITY))).body
        ).capabilities.delete_identity,
        true
      );
      assert.equal(
        JSON.parse(
          (
            await handler(
              post('delete_identity', { user_id: 'gotrue-heir', email: 'heir@example.com' }),
              contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
            )
          ).body
        ).error_code,
        'member_exists'
      );
      const delOk = await handler(
        post('delete_identity', { user_id: 'gotrue-stranger', email: 'stranger@example.com' }),
        contextFor('boot@example.com', 'gotrue-boot', IDENTITY)
      );
      assert.equal(delOk.statusCode, 200);
      assert.equal(
        (
          await handler(
            post('delete_identity', { user_id: 'x', email: 'stranger@example.com' }),
            contextFor('boot@example.com', 'gotrue-boot')
          )
        ).statusCode,
        503
      );
      // non-owner: 403 on every offboarding verb
      await putUserRecord(users, activeMember('adm@example.com', 'admin'));
      for (const v of ['purge', 'transfer_ownership', 'export_person', 'delete_identity']) {
        const res = await handler(
          post(v, { email: 'x@example.com', to_email: 'x@example.com', confirm: 'PURGE x@example.com', user_id: 'u' }),
          contextFor('adm@example.com')
        );
        assert.equal(res.statusCode, 403, v);
      }
    });
  } finally {
    globalThis.fetch = savedFetch;
  }
});
