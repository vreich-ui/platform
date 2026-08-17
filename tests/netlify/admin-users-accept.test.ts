/**
 * T18.0a — the accept page's two verbs on the admin-users handler:
 * `invite_preview` (public, no auth, no user data) and `accept` (the fresh
 * JWT after GoTrue /verify; flips invited → active with the typed name;
 * idempotent; no record → needs_grant:true and the store is untouched).
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-users.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import {
  getUserRecord,
  listUserRecords,
  putUserRecord,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

const handler = createHandler(drlurieSiteBinding);
const ROLE_ENV_KEYS = ['ADMIN_EMAILS', 'ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR'] as const;
const AT = '2026-08-17T10:00:00.000Z';

const memStore = (): UsersBlobStore & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    async get(key) {
      return map.get(key) ?? null;
    },
    async setJSON(key, value) {
      map.set(key, JSON.stringify(value));
    },
    async list({ prefix }) {
      return { blobs: [...map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const withUsersStore = async (
  env: Partial<Record<(typeof ROLE_ENV_KEYS)[number], string>>,
  fn: (store: ReturnType<typeof memStore>) => Promise<void>
) => {
  const savedEnv = [...ROLE_ENV_KEYS, 'NETLIFY', 'NETLIFY_SITE_ID'].map((key) => [key, process.env[key]] as const);
  const store = memStore();
  for (const key of ROLE_ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return store as never;
    },
  });
  try {
    await fn(store);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const contextFor = (email: string, sub = 'gotrue-new-1') => ({ clientContext: { user: { sub, email } } });
const post = (verb: string, fields: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  body: JSON.stringify({ verb, ...fields }),
});

const invitedRecord = (email: string) => ({
  schema_version: 1 as const,
  email,
  display_name: 'Jane',
  role: 'admin' as const,
  status: 'invited' as const,
  invited_by: 'boss@example.com',
  created_at: AT,
  updated_at: AT,
  audit: [{ at: AT, actor_email: 'boss@example.com', action: 'invite', detail: 'role admin' }],
});

test('accept flips invited → active with the typed display name, stamps user_id, audits accept', async () => {
  await withUsersStore({}, async (store) => {
    await putUserRecord(store, invitedRecord('jane@example.com'));
    const res = await handler(
      post('accept', { display_name: 'Jane Doe' }),
      contextFor('Jane@Example.com', 'gotrue-jane')
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.needs_grant, false);
    assert.equal(body.user.status, 'active');
    assert.equal(body.user.display_name, 'Jane Doe');
    assert.equal(body.user.user_id, 'gotrue-jane');
    assert.equal(body.user.role, 'admin');
    assert.equal(body.user.audit.filter((a: { action: string }) => a.action === 'accept').length, 1);
    const persisted = await getUserRecord(store, 'jane@example.com');
    assert.equal(persisted?.status, 'active');
    assert.equal(persisted?.display_name, 'Jane Doe');
  });
});

test('accept twice is idempotent — same active record, one accept audit entry, name not re-written', async () => {
  await withUsersStore({}, async (store) => {
    await putUserRecord(store, invitedRecord('jane@example.com'));
    const first = await handler(post('accept', { display_name: 'Jane Doe' }), contextFor('jane@example.com'));
    const second = await handler(post('accept', { display_name: 'Someone Else' }), contextFor('jane@example.com'));
    assert.equal(first.statusCode, 200);
    assert.equal(second.statusCode, 200);
    const b1 = JSON.parse(first.body);
    const b2 = JSON.parse(second.body);
    assert.equal(b2.user.status, 'active');
    assert.equal(b2.user.display_name, 'Jane Doe');
    assert.equal(b2.user.audit.length, b1.user.audit.length);
    assert.equal(b2.needs_grant, false);
    assert.equal((await listUserRecords(store)).length, 1); // T18.1: one member, however many v2 blobs
  });
});

test('accept with no store record grants nothing — 200 needs_grant:true and the store is untouched', async () => {
  await withUsersStore({}, async (store) => {
    const res = await handler(post('accept', { display_name: 'Netlify Invitee' }), contextFor('nobody@example.com'));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.user, null);
    assert.equal(body.needs_grant, true);
    assert.equal(store.map.size, 0);
  });
});

test('accept requires a session (401) and a display_name (400)', async () => {
  await withUsersStore({}, async () => {
    const noAuth = await handler(post('accept', { display_name: 'X' }));
    assert.equal(noAuth.statusCode, 401);
    const noName = await handler(post('accept'), contextFor('jane@example.com'));
    assert.equal(noName.statusCode, 400);
  });
});

test('accept for a bootstrap ADMIN_EMAILS owner materializes the owner record (the me path) with the name', async () => {
  await withUsersStore({ ADMIN_EMAILS: 'boss@example.com' }, async (store) => {
    const res = await handler(
      post('accept', { display_name: 'The Boss' }),
      contextFor('boss@example.com', 'gotrue-boss')
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.bootstrap, true);
    assert.equal(body.user.role, 'owner');
    assert.equal(body.user.display_name, 'The Boss');
    assert.equal((await getUserRecord(store, 'boss@example.com'))?.role, 'owner');
  });
});

test('invite_preview needs no auth and returns only the site name/slug + password policy', async () => {
  await withUsersStore({}, async (store) => {
    const res = await handler(post('invite_preview', { token: 'whatever' }));
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(typeof body.site.name, 'string');
    assert.ok(body.site.name.length > 0);
    assert.equal(typeof body.site.slug, 'string');
    assert.equal(body.policy.min_password, 8);
    assert.equal(body.user, undefined);
    assert.equal(body.email, undefined);
    assert.equal(store.map.size, 0);
    // without a token is fine too — the token is not validated server-side
    assert.equal((await handler(post('invite_preview'))).statusCode, 200);
  });
});

test('existing verbs are unchanged: an invited caller still cannot list, an anonymous me is 401', async () => {
  await withUsersStore({}, async (store) => {
    await putUserRecord(store, invitedRecord('jane@example.com'));
    const list = await handler(post('list'), contextFor('jane@example.com'));
    assert.equal(list.statusCode, 403);
    const me = await handler(post('me'));
    assert.equal(me.statusCode, 401);
  });
});
