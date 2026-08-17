/**
 * T9.5 — invite + first-login activation. The GoTrue admin call is injected so
 * these run offline: invite success/failure/idempotency, and the invited →
 * active flip on first login.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { inviteUser, activateOnLogin } from '../../packages/core/server/lib/user-invite.js';
import { getUserRecord, putUserRecord, listUserRecords, type UsersBlobStore } from '../../packages/core/server/lib/users-store.js';

const AT = '2026-07-17T12:00:00.000Z';
const IDENTITY = { url: 'https://site/.netlify/identity', token: 'admin-token' };

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
      return { blobs: [...map.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const recordingFetch = (ok: boolean, status = ok ? 200 : 500, bodyText?: string) => {
  const calls: Array<{ url: string; init: { method: string; headers: Record<string, string>; body: string } }> = [];
  const fn = async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
    calls.push({ url, init });
    return bodyText === undefined ? { ok, status } : { ok, status, text: async () => bodyText };
  };
  return { fn, calls };
};

test('invite creates an invited record and fires the GoTrue /invite (the mail-sending endpoint)', async () => {
  const store = memStore();
  const { fn, calls } = recordingFetch(true);
  const result = await inviteUser({
    store,
    email: 'New@Example.com',
    role: 'admin',
    invitedBy: 'boss@x.com',
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });

  assert.equal(result.record.status, 'invited');
  assert.equal(result.record.email, 'new@example.com');
  assert.equal(result.record.role, 'admin');
  assert.equal(result.record.invited_by, 'boss@x.com');
  assert.equal(result.invite.sent, true);
  // GoTrue call: /invite (NOT /admin/users, which needs a password and sends
  // no mail — plan §1 F2), bearer token, email + informational data in body
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://site/.netlify/identity/invite');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer admin-token');
  const body = JSON.parse(calls[0].init.body) as { email: string; data: { invited_by: string; role: string } };
  assert.equal(body.email, 'new@example.com');
  assert.equal(body.data.invited_by, 'boss@x.com');
  assert.equal(body.data.role, 'admin');
  // persisted
  assert.equal((await getUserRecord(store, 'new@example.com'))?.status, 'invited');
});

test('GoTrue 422 "already registered" is reported as already_invited, not a failure', async () => {
  const store = memStore();
  const { fn } = recordingFetch(false, 422, '{"code":422,"msg":"A user with this email address has already been registered"}');
  const result = await inviteUser({
    store,
    email: 'dup@x.com',
    role: 'admin',
    invitedBy: 'boss@x.com',
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.equal(result.invite.sent, false);
  assert.equal(result.invite.error, 'already_invited');
  assert.equal((await getUserRecord(store, 'dup@x.com'))?.status, 'invited');
});

test('resendIfExisting re-fires the GoTrue invite for an invited record and audits reinvite_email', async () => {
  const store = memStore();
  const { fn, calls } = recordingFetch(true);
  await inviteUser({ store, email: 're@x.com', role: 'admin', invitedBy: 'boss@x.com', at: AT, identity: IDENTITY, fetchImpl: fn });
  assert.equal(calls.length, 1);

  // Plain re-invite: role update only, no second e-mail.
  const plain = await inviteUser({
    store,
    email: 're@x.com',
    role: 'owner',
    invitedBy: 'boss@x.com',
    at: '2026-07-18T00:00:00.000Z',
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.equal(calls.length, 1);
  assert.equal(plain.invite.sent, false);
  assert.equal(plain.record.role, 'owner');

  const resent = await inviteUser({
    store,
    email: 're@x.com',
    role: 'owner',
    invitedBy: 'boss@x.com',
    at: '2026-07-19T00:00:00.000Z',
    identity: IDENTITY,
    fetchImpl: fn,
    resendIfExisting: true,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://site/.netlify/identity/invite');
  assert.equal(resent.invite.sent, true);
  assert.equal(resent.record.status, 'invited');
  assert.ok(resent.record.audit.some((a) => a.action === 'reinvite_email'));
  assert.equal((await listUserRecords(store)).length, 1);
});

test('re-inviting a disabled member flips disabled → invited (F6) and audits it', async () => {
  const store = memStore();
  await putUserRecord(store, {
    schema_version: 1,
    email: 'gone@x.com',
    display_name: 'Gone',
    role: 'admin',
    status: 'disabled',
    invited_by: 'boss',
    created_at: AT,
    updated_at: AT,
    audit: [],
  });
  const { fn, calls } = recordingFetch(true);
  const result = await inviteUser({
    store,
    email: 'gone@x.com',
    role: 'admin',
    invitedBy: 'boss@x.com',
    at: '2026-07-18T00:00:00.000Z',
    identity: IDENTITY,
    fetchImpl: fn,
    resendIfExisting: true,
  });
  assert.equal(result.record.status, 'invited');
  assert.equal(result.record.display_name, 'Gone');
  const reinvite = result.record.audit.find((a) => a.action === 'reinvite');
  assert.match(reinvite?.detail ?? '', /disabled → invited/);
  // reactivated + resend requested → the e-mail fires again
  assert.equal(calls.length, 1);
  assert.equal((await getUserRecord(store, 'gone@x.com'))?.status, 'invited');
});

test('invite still creates the record when the GoTrue call fails (best-effort email)', async () => {
  const store = memStore();
  const { fn } = recordingFetch(false, 500);
  const result = await inviteUser({
    store,
    email: 'x@y.com',
    role: 'admin',
    invitedBy: 'boss@x.com',
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.equal(result.invite.sent, false);
  assert.match(result.invite.error ?? '', /500/);
  assert.equal((await getUserRecord(store, 'x@y.com'))?.status, 'invited');
});

test('invite is idempotent — re-inviting updates the role and audits it, never duplicates', async () => {
  const store = memStore();
  const { fn } = recordingFetch(true);
  await inviteUser({
    store,
    email: 'dup@x.com',
    role: 'admin',
    invitedBy: 'boss@x.com',
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  await inviteUser({
    store,
    email: 'dup@x.com',
    role: 'owner',
    invitedBy: 'boss@x.com',
    at: '2026-07-18T00:00:00.000Z',
    identity: IDENTITY,
    fetchImpl: fn,
  });

  const all = await listUserRecords(store);
  assert.equal(all.length, 1);
  assert.equal(all[0].role, 'owner');
  assert.ok(all[0].audit.some((a) => a.action === 'reinvite'));
});

test('invite without an identity token still creates the record but does not send', async () => {
  const store = memStore();
  const result = await inviteUser({ store, email: 'z@x.com', role: 'admin', invitedBy: 'boss@x.com', at: AT });
  assert.equal(result.invite.sent, false);
  assert.match(result.invite.error ?? '', /token unavailable/);
  assert.equal((await getUserRecord(store, 'z@x.com'))?.status, 'invited');
});

test('first login flips invited → active and stamps user_id', async () => {
  const store = memStore();
  await inviteUser({ store, email: 'joiner@x.com', role: 'admin', invitedBy: 'boss@x.com', at: AT });
  const activated = await activateOnLogin(store, 'joiner@x.com', 'gotrue-uid-123', '2026-07-18T09:00:00.000Z');
  assert.equal(activated?.status, 'active');
  assert.equal(activated?.user_id, 'gotrue-uid-123');
  assert.ok(activated?.audit.some((a) => a.action === 'activate'));
});

test('activateOnLogin on an active member only stamps last_seen; missing → null', async () => {
  const store = memStore();
  await putUserRecord(store, {
    schema_version: 1,
    email: 'active@x.com',
    display_name: 'Active',
    role: 'admin',
    status: 'active',
    invited_by: 'boss',
    created_at: AT,
    updated_at: AT,
    audit: [],
  });
  const seen = await activateOnLogin(store, 'active@x.com', 'uid', '2026-07-18T09:00:00.000Z');
  assert.equal(seen?.status, 'active');
  assert.equal(seen?.last_seen_at, '2026-07-18T09:00:00.000Z');
  assert.equal(await activateOnLogin(store, 'nobody@x.com', 'uid', AT), null);
});
