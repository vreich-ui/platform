/**
 * W18 T18.2 — invitations: the full state machine (pending → accepted /
 * revoked / expired), idempotent create (409 invite_pending_exists), resend
 * cap, revoke → membership removed, lazy expiry + sweep, accept copies the
 * invitation role and stamps accepted, policy domain/role checks, unmanaged
 * identities with/without the admin token, exact error codes. Also carries
 * the T18.0a GoTrue-endpoint tests ported from user-invite.test.ts (that file
 * and user-invite.ts were removed by T18.2): POST /invite with the bearer +
 * informational data; 422 already-registered → already_invited; best-effort
 * on failure; no token → record created, not sent; first login activates.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-users.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import {
  InvitationError,
  acceptInvitation,
  activateOnLogin,
  assertMayInvite,
  createInvitation,
  expireAll,
  getOpenInvitationByEmail,
  listInvitations,
  listUnmanagedIdentities,
  previewInvitationByToken,
  resendInvitation,
  revokeInvitation,
  sendGoTrueInvite,
} from '../../packages/core/server/lib/membership/invitations.js';
import { getMembershipByEmail } from '../../packages/core/server/lib/membership/read.js';
import { setPolicy } from '../../packages/core/server/lib/membership/write.js';
import { KEYS, PREFIXES, personIdForEmail } from '../../packages/core/server/lib/membership/store.js';
import {
  getUserRecord,
  listUserRecords,
  putUserRecord,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import { DEFAULT_MEMBERSHIP_POLICY } from '../../packages/core/lib/membership-policy.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

const AT = '2026-08-17T12:00:00.000Z';
const LATER = '2026-08-18T12:00:00.000Z';
const WEEK_LATER = '2026-08-25T12:00:01.000Z';
const IDENTITY = { url: 'https://site/.netlify/identity', token: 'admin-token' };
const ACTOR = { kind: 'human' as const, id: 'boss-id', email: 'boss@x.com' };
const BOSS = { person_id: personIdForEmail('boss@x.com'), email: 'boss@x.com' };
const handler = createHandler(drlurieSiteBinding);
const ROLE_ENV_KEYS = ['ADMIN_EMAILS', 'ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR'] as const;

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
    async delete(key) {
      map.delete(key);
    },
  };
};

type Call = { url: string; init?: { method?: string; headers?: Record<string, string>; body?: string } };
const recordingFetch = (ok: boolean, status = ok ? 200 : 500, bodyText?: string, jsonBody?: unknown) => {
  const calls: Call[] = [];
  const fn = async (url: string, init?: Call['init']) => {
    calls.push({ url, init });
    return {
      ok,
      status,
      ...(bodyText === undefined ? {} : { text: async () => bodyText }),
      ...(jsonBody === undefined ? {} : { json: async () => jsonBody }),
    };
  };
  return { fn, calls };
};

const auditActions = (store: ReturnType<typeof memStore>) =>
  [...store.map.keys()]
    .filter((k) => k.startsWith(PREFIXES.audit))
    .map((k) => JSON.parse(store.map.get(k)!).action as string);

const rejectsWith = async (code: string, fn: () => Promise<unknown>) => {
  await assert.rejects(fn, (e: unknown) => e instanceof InvitationError && e.code === code);
};

// ─── T18.0a ported: the GoTrue endpoint fact ─────────────────────────────────

test('sendGoTrueInvite POSTs {identity}/invite with the admin bearer and informational data', async () => {
  const { fn, calls } = recordingFetch(true);
  const r = await sendGoTrueInvite({
    email: 'New@Example.com',
    data: { invited_by: 'boss@x.com', role: 'admin' },
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.equal(r.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://site/.netlify/identity/invite');
  assert.equal(calls[0].init?.method, 'POST');
  assert.equal(calls[0].init?.headers?.Authorization, 'Bearer admin-token');
  const body = JSON.parse(calls[0].init!.body!) as { email: string; data: { invited_by: string; role: string } };
  assert.equal(body.email, 'new@example.com');
  assert.equal(body.data.invited_by, 'boss@x.com');
  assert.equal(body.data.role, 'admin');
});

test('sendGoTrueInvite: 422 already registered → already_invited; other non-2xx → error; no token → not sent', async () => {
  const dup = recordingFetch(false, 422, '{"msg":"A user with this email address has already been registered"}');
  assert.deepEqual(await sendGoTrueInvite({ email: 'a@x.com', data: {}, identity: IDENTITY, fetchImpl: dup.fn }), {
    sent: false,
    error: 'already_invited',
  });
  const bad = recordingFetch(false, 500);
  assert.match(
    (await sendGoTrueInvite({ email: 'a@x.com', data: {}, identity: IDENTITY, fetchImpl: bad.fn })).error ?? '',
    /500/
  );
  assert.match((await sendGoTrueInvite({ email: 'a@x.com', data: {} })).error ?? '', /token unavailable/);
});

// ─── create ───────────────────────────────────────────────────────────────────

test('createInvitation: Invitation{pending} + Person + Membership{invited}, pointer, audit, GoTrue fired, token returned once (hash stored)', async () => {
  const store = memStore();
  const { fn, calls } = recordingFetch(true);
  const r = await createInvitation(store, {
    email: 'Jane@Example.com',
    role: 'editor',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
    message: 'welcome',
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.match(r.invitation.invite_id, /^inv_[0-9a-hjkmnp-tv-z]{26}$/);
  assert.equal(r.invitation.status, 'pending');
  assert.equal(r.invitation.email, 'jane@example.com');
  assert.equal(r.invitation.role, 'editor');
  assert.equal(r.invitation.expires_at, '2026-08-24T12:00:00.000Z'); // 168h
  assert.equal(r.invitation.gotrue.send_count, 1);
  assert.equal(r.invitation.gotrue.invited, true);
  assert.equal(r.invitation.message, 'welcome');
  assert.match(r.accept_token, /^inv_[0-9a-f]{64}$/);
  assert.equal(JSON.stringify([...store.map.values()]).includes(r.accept_token), false, 'raw token never stored');
  assert.equal(r.invite.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(JSON.parse(calls[0].init!.body!).data.invite_id, r.invitation.invite_id);
  // membership + person
  const member = await getMembershipByEmail(store, 'jane@example.com');
  assert.equal(member?.membership.status, 'invited');
  assert.equal(member?.membership.role, 'editor');
  assert.equal(member?.membership.source, 'invitation');
  assert.equal(member?.membership.invitation_id, r.invitation.invite_id);
  assert.equal(member?.person.display_name, 'Jane');
  assert.equal(r.user.status, 'invited');
  // pointer
  assert.deepEqual(JSON.parse(store.map.get(KEYS.invitationByEmail('jane@example.com'))!), {
    invite_id: r.invitation.invite_id,
  });
  assert.equal((await getOpenInvitationByEmail(store, 'JANE@example.com', AT))?.invite_id, r.invitation.invite_id);
  assert.ok(auditActions(store).includes('invitation.create'));
});

test('createInvitation is idempotent-by-conflict: a second pending invite is 409 invite_pending_exists with existing_invite_id', async () => {
  const store = memStore();
  const { fn } = recordingFetch(true);
  const first = await createInvitation(store, {
    email: 'dup@x.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  await assert.rejects(
    () =>
      createInvitation(store, {
        email: 'DUP@x.com',
        role: 'owner',
        invitedBy: BOSS,
        actor: ACTOR,
        at: LATER,
        identity: IDENTITY,
        fetchImpl: fn,
      }),
    (e: InvitationError) =>
      e.code === 'invite_pending_exists' &&
      e.status === 409 &&
      e.extra.existing_invite_id === first.invitation.invite_id
  );
  assert.equal((await listUserRecords(store)).length, 1);
});

test('createInvitation: active member → 409 member_active; suspended/removed member is re-invited (F6) with a new invitation', async () => {
  const store = memStore();
  const { fn } = recordingFetch(true);
  await putUserRecord(store, {
    schema_version: 1,
    email: 'act@x.com',
    display_name: 'Act',
    role: 'admin',
    status: 'active',
    invited_by: 'boss@x.com',
    created_at: AT,
    updated_at: AT,
    audit: [],
  });
  await rejectsWith('member_active', () =>
    createInvitation(store, {
      email: 'act@x.com',
      role: 'admin',
      invitedBy: BOSS,
      actor: ACTOR,
      at: AT,
      identity: IDENTITY,
      fetchImpl: fn,
    })
  );
  await putUserRecord(store, {
    schema_version: 1,
    email: 'gone@x.com',
    display_name: 'Gone',
    role: 'admin',
    status: 'disabled',
    invited_by: 'boss@x.com',
    created_at: AT,
    updated_at: AT,
    audit: [],
  });
  const r = await createInvitation(store, {
    email: 'gone@x.com',
    role: 'viewer',
    invitedBy: BOSS,
    actor: ACTOR,
    at: LATER,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  const member = await getMembershipByEmail(store, 'gone@x.com');
  assert.equal(member?.membership.status, 'invited');
  assert.equal(member?.membership.role, 'viewer');
  assert.equal(member?.membership.suspended, undefined);
  assert.equal(member?.membership.invitation_id, r.invitation.invite_id);
  assert.equal(member?.person.display_name, 'Gone', 'display name preserved on re-invite');
  const reinvite = member?.membership.audit.find((a) => a.action === 'reinvite');
  assert.match(reinvite?.detail ?? '', /suspended → invited/);
});

test('createInvitation: GoTrue failure is best-effort (record created, gotrue.error recorded); no identity token → not sent', async () => {
  const store = memStore();
  const bad = recordingFetch(false, 500);
  const r = await createInvitation(store, {
    email: 'x@y.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
    identity: IDENTITY,
    fetchImpl: bad.fn,
  });
  assert.equal(r.invite.sent, false);
  assert.match(r.invitation.gotrue.error ?? '', /500/);
  assert.equal(r.invitation.gotrue.send_count, 0);
  assert.equal((await getUserRecord(store, 'x@y.com'))?.status, 'invited');
  const r2 = await createInvitation(store, { email: 'z@y.com', role: 'admin', invitedBy: BOSS, actor: ACTOR, at: AT });
  assert.equal(r2.invite.sent, false);
  assert.match(r2.invite.error ?? '', /token unavailable/);
});

test('policy: allowed_email_domains → 422 domain_not_allowed; who_can_invite / roles_admin_may_grant enforce who may invite whom', async () => {
  const store = memStore();
  await setPolicy(store, { allowed_email_domains: ['example.com'] });
  await rejectsWith('domain_not_allowed', () =>
    createInvitation(store, { email: 'out@other.com', role: 'admin', invitedBy: BOSS, actor: ACTOR, at: AT })
  );
  await createInvitation(store, { email: 'in@EXAMPLE.com', role: 'admin', invitedBy: BOSS, actor: ACTOR, at: AT });

  const policy = DEFAULT_MEMBERSHIP_POLICY; // owner_admin; admins may grant editor/viewer
  assertMayInvite({ actorRoles: ['owner', 'admin', 'publisher'], role: 'owner', policy });
  assertMayInvite({ actorRoles: ['admin'], role: 'editor', policy });
  assertMayInvite({ actorRoles: ['admin'], role: 'viewer', policy });
  assert.throws(
    () => assertMayInvite({ actorRoles: ['admin'], role: 'admin', policy }),
    (e: InvitationError) => e.code === 'role_not_grantable'
  );
  assert.throws(
    () => assertMayInvite({ actorRoles: ['admin'], role: 'owner', policy }),
    (e: InvitationError) => e.code === 'role_not_grantable'
  );
  assert.throws(
    () => assertMayInvite({ actorRoles: ['editor'], role: 'viewer', policy }),
    (e: InvitationError) => e.code === 'invite_forbidden'
  );
  assert.throws(
    () => assertMayInvite({ actorRoles: ['admin'], role: 'viewer', policy: { ...policy, who_can_invite: 'owner' } }),
    (e: InvitationError) => e.code === 'invite_forbidden'
  );
});

// ─── resend ───────────────────────────────────────────────────────────────────

test('resend re-fires GoTrue, bumps send_count/last_sent_at, rotates our token, extends TTL, audits; capped at policy.max_resends', async () => {
  const store = memStore();
  const { fn, calls } = recordingFetch(true);
  const created = await createInvitation(store, {
    email: 're@x.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  const r = await resendInvitation(store, {
    email: 're@x.com',
    actor: ACTOR,
    actorEmail: 'boss@x.com',
    at: LATER,
    identity: IDENTITY,
    fetchImpl: fn,
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url, 'https://site/.netlify/identity/invite');
  assert.equal(r.invitation.gotrue.send_count, 2);
  assert.equal(r.invitation.gotrue.last_sent_at, LATER);
  assert.equal(r.invitation.expires_at, '2026-08-25T12:00:00.000Z');
  assert.notEqual(r.accept_token, created.accept_token);
  assert.equal(await previewInvitationByToken(store, created.accept_token, LATER), null, 'old token stops working');
  assert.equal((await previewInvitationByToken(store, r.accept_token, LATER))?.email, 're@x.com');
  assert.ok(
    (await getMembershipByEmail(store, 're@x.com'))?.membership.audit.some((a) => a.action === 'reinvite_email')
  );
  assert.ok(auditActions(store).includes('invitation.resend'));

  await setPolicy(store, { max_resends: 2 });
  await assert.rejects(
    () =>
      resendInvitation(store, {
        invite_id: created.invitation.invite_id,
        actor: ACTOR,
        actorEmail: 'boss@x.com',
        at: LATER,
        identity: IDENTITY,
        fetchImpl: fn,
      }),
    (e: InvitationError) => e.code === 'resend_cap' && e.status === 429 && e.extra.send_count === 2
  );
  assert.equal(calls.length, 2, 'cap blocks before the network');
  await rejectsWith('invite_not_found', () =>
    resendInvitation(store, { email: 'nobody@x.com', actor: ACTOR, actorEmail: 'boss@x.com', at: LATER })
  );
});

// ─── revoke ───────────────────────────────────────────────────────────────────

test('revoke: pending → revoked (pointer cleared), a never-activated membership → removed{purge_after}, roles []; revoking again is 409 invite_revoked', async () => {
  const store = memStore();
  const created = await createInvitation(store, {
    email: 'rv@x.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
  });
  const r = await revokeInvitation(store, {
    invite_id: created.invitation.invite_id,
    actor: ACTOR,
    actorEmail: 'boss@x.com',
    at: LATER,
    reason: 'wrong address',
  });
  assert.equal(r.invitation.status, 'revoked');
  assert.equal(r.invitation.revoked?.by, 'boss@x.com');
  assert.equal(r.membership?.status, 'removed');
  assert.equal(r.membership?.removed?.purge_after, '2026-09-17T12:00:00.000Z'); // 30 days
  assert.equal(await getOpenInvitationByEmail(store, 'rv@x.com', LATER), null);
  assert.equal((await getUserRecord(store, 'rv@x.com'))?.status, 'disabled');
  assert.equal((await getUserRecord(store, 'rv@x.com'))?.membership_status, 'removed');
  await rejectsWith('invite_revoked', () =>
    revokeInvitation(store, {
      invite_id: created.invitation.invite_id,
      actor: ACTOR,
      actorEmail: 'boss@x.com',
      at: LATER,
    })
  );
  await rejectsWith('invite_revoked', () =>
    resendInvitation(store, {
      invite_id: created.invitation.invite_id,
      actor: ACTOR,
      actorEmail: 'boss@x.com',
      at: LATER,
    })
  );
  assert.ok(auditActions(store).includes('invitation.revoke'));
  // a fresh invite for the same address is allowed afterwards (new invitation, membership back to invited)
  const again = await createInvitation(store, {
    email: 'rv@x.com',
    role: 'viewer',
    invitedBy: BOSS,
    actor: ACTOR,
    at: LATER,
  });
  assert.notEqual(again.invitation.invite_id, created.invitation.invite_id);
  assert.equal((await getMembershipByEmail(store, 'rv@x.com'))?.membership.status, 'invited');
});

// ─── expiry ───────────────────────────────────────────────────────────────────

test('expiry: lazy on read (getOpen/resend/preview) and via expireAll sweep; audits invitation.expire once', async () => {
  const store = memStore();
  const a = await createInvitation(store, { email: 'a@x.com', role: 'admin', invitedBy: BOSS, actor: ACTOR, at: AT });
  const b = await createInvitation(store, {
    email: 'b@x.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: LATER,
  });
  // a expires at AT+168h (Aug 24 12:00); BETWEEN is past that, b's TTL (LATER+168h = Aug 25 12:00) is not
  const BETWEEN = '2026-08-24T13:00:00.000Z';
  assert.equal(await getOpenInvitationByEmail(store, 'a@x.com', BETWEEN), null);
  assert.equal((await getOpenInvitationByEmail(store, 'b@x.com', BETWEEN))?.invite_id, b.invitation.invite_id);
  await rejectsWith('invite_expired', () =>
    resendInvitation(store, { invite_id: a.invitation.invite_id, actor: ACTOR, actorEmail: 'boss@x.com', at: BETWEEN })
  );
  assert.equal((await previewInvitationByToken(store, a.accept_token, BETWEEN))?.expired, true);
  assert.equal(
    auditActions(store).filter((x) => x === 'invitation.expire').length,
    1,
    'expired once, not on every read'
  );
  // sweep: nothing more to expire now; move time forward and b goes too
  assert.deepEqual(await expireAll(store, BETWEEN), []);
  const swept = await expireAll(store, '2026-09-01T00:00:00.000Z');
  assert.deepEqual(swept, [b.invitation.invite_id]);
  const all = await listInvitations(store, { now: '2026-09-01T00:00:00.000Z' });
  assert.deepEqual(
    all.map((i) => i.status),
    ['expired', 'expired']
  );
  // an expired invite lets a NEW one be created (resend creates a new invite in the UI)
  const fresh = await createInvitation(store, {
    email: 'a@x.com',
    role: 'admin',
    invitedBy: BOSS,
    actor: ACTOR,
    at: '2026-09-01T00:00:00.000Z',
  });
  assert.equal(fresh.invitation.status, 'pending');
  assert.equal((await listInvitations(store, { status: 'pending', now: '2026-09-01T00:00:00.000Z' })).length, 1);
});

// ─── accept ───────────────────────────────────────────────────────────────────

test('accept: membership invited → active with the typed name, invitation → accepted (role copied, pointer cleared), identity stamped, idempotent', async () => {
  const store = memStore();
  const created = await createInvitation(store, {
    email: 'acc@x.com',
    role: 'editor',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
  });
  // an Owner bumps the invitation role by revoking+reinviting is the model; but a stale membership role must follow the invitation:
  const first = await acceptInvitation(store, 'ACC@x.com', 'gotrue-acc', 'Accepted Person', LATER);
  assert.equal(first?.status, 'active');
  assert.equal(first?.role, 'editor');
  assert.equal(first?.display_name, 'Accepted Person');
  assert.equal(first?.user_id, 'gotrue-acc');
  const member = await getMembershipByEmail(store, 'acc@x.com');
  assert.ok(member?.person.onboarding.steps.password);
  assert.ok(member?.person.onboarding.steps.name);
  assert.ok(store.map.has(KEYS.byIdentity('gotrue-acc')));
  const inv = JSON.parse(store.map.get(KEYS.invitation(created.invitation.invite_id))!);
  assert.equal(inv.status, 'accepted');
  assert.equal(inv.accepted.person_id, personIdForEmail('acc@x.com'));
  assert.equal(await getOpenInvitationByEmail(store, 'acc@x.com', LATER), null);
  assert.ok(auditActions(store).includes('invitation.accept'));
  const second = await acceptInvitation(store, 'acc@x.com', 'gotrue-acc', 'Someone Else', WEEK_LATER);
  assert.equal(second?.display_name, 'Accepted Person');
  assert.equal(second?.audit.filter((a) => a.action === 'accept').length, 1);
  assert.equal(auditActions(store).filter((x) => x === 'invitation.accept').length, 1);
  assert.equal(await acceptInvitation(store, 'nobody@x.com', 'u', 'N', AT), null);
});

test('activateOnLogin (first login without the accept page) activates and closes the pending invitation too; later logins only stamp last_seen', async () => {
  const store = memStore();
  const created = await createInvitation(store, {
    email: 'login@x.com',
    role: 'publisher',
    invitedBy: BOSS,
    actor: ACTOR,
    at: AT,
  });
  const activated = await activateOnLogin(store, 'login@x.com', 'gotrue-login', LATER);
  assert.equal(activated?.status, 'active');
  assert.equal(activated?.role, 'publisher');
  assert.equal(activated?.user_id, 'gotrue-login');
  assert.ok(activated?.audit.some((a) => a.action === 'activate'));
  assert.equal(JSON.parse(store.map.get(KEYS.invitation(created.invitation.invite_id))!).status, 'accepted');
  const seen = await activateOnLogin(store, 'login@x.com', 'gotrue-login', WEEK_LATER);
  assert.equal(seen?.last_seen_at, WEEK_LATER);
  assert.equal(seen?.audit.filter((a) => a.action === 'activate').length, 1);
  assert.equal(await activateOnLogin(store, 'nobody@x.com', 'u', AT), null);
});

// ─── unmanaged identities ─────────────────────────────────────────────────────

test('listUnmanagedIdentities: GoTrue identities without a membership; degrades to [] + identity_admin_unavailable without a token or on failure', async () => {
  const store = memStore();
  await putUserRecord(store, {
    schema_version: 1,
    email: 'known@x.com',
    display_name: 'Known',
    role: 'admin',
    status: 'active',
    invited_by: 'boss@x.com',
    created_at: AT,
    updated_at: AT,
    audit: [],
  });
  const gotrue = recordingFetch(true, 200, undefined, {
    users: [
      { id: 'id-1', email: 'Known@x.com', confirmed_at: AT },
      { id: 'id-2', email: 'stranger@x.com', invited_at: AT, created_at: AT },
      { id: 'id-3', email: 'confirmed@x.com', confirmed_at: AT, last_sign_in_at: LATER },
      { id: '', email: 'broken@x.com' },
    ],
  });
  const r = await listUnmanagedIdentities({ store, identity: IDENTITY, fetchImpl: gotrue.fn });
  assert.equal(gotrue.calls[0].url, 'https://site/.netlify/identity/admin/users?per_page=1000');
  assert.equal(gotrue.calls[0].init?.headers?.Authorization, 'Bearer admin-token');
  assert.equal(r.error_code, undefined);
  assert.deepEqual(
    r.identities.map((i) => `${i.email}:${i.confirmed}`),
    ['confirmed@x.com:true', 'stranger@x.com:false']
  );
  const none = await listUnmanagedIdentities({ store });
  assert.deepEqual(none.identities, []);
  assert.equal(none.error_code, 'identity_admin_unavailable');
  const failing = recordingFetch(false, 403);
  const failed = await listUnmanagedIdentities({ store, identity: IDENTITY, fetchImpl: failing.fn });
  assert.equal(failed.error_code, 'identity_admin_unavailable');
  assert.deepEqual(failed.identities, []);
});

// ─── through the handler ──────────────────────────────────────────────────────

const withHandlerStore = async (
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
const contextFor = (email: string, sub = 'user-1') => ({ clientContext: { user: { sub, email } } });
const post = (verb: string, fields: Record<string, unknown> = {}) => ({
  httpMethod: 'POST',
  body: JSON.stringify({ verb, ...fields }),
});

test('handler: invite → 200 with invitation + accept_token; duplicate → 409 invite_pending_exists; admin may invite editor only; resend/revoke/list_invitations Owner-only; unmanaged_identities degrades', async () => {
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com' }, async (store) => {
    const inv = await handler(
      post('invite', { email: 'new@example.com', role: 'admin', message: 'hi' }),
      contextFor('boot@example.com')
    );
    assert.equal(inv.statusCode, 200);
    const body = JSON.parse(inv.body);
    assert.equal(body.invitation.status, 'pending');
    assert.equal(body.user.status, 'invited');
    assert.match(body.accept_token, /^inv_/);
    assert.equal(body.invite.sent, false, 'no identity context in the test → not sent, but the record exists');

    const dup = await handler(
      post('invite', { email: 'new@example.com', role: 'owner' }),
      contextFor('boot@example.com')
    );
    assert.equal(dup.statusCode, 409);
    assert.equal(JSON.parse(dup.body).error_code, 'invite_pending_exists');
    assert.equal(JSON.parse(dup.body).existing_invite_id, body.invitation.invite_id);

    // an admin (stored) may invite editor/viewer under the default policy, not admin/owner
    await putUserRecord(store, {
      schema_version: 1,
      email: 'adm@example.com',
      display_name: 'Adm',
      role: 'admin',
      status: 'active',
      invited_by: 'boot@example.com',
      created_at: AT,
      updated_at: AT,
      audit: [],
    });
    assert.equal(
      (await handler(post('invite', { email: 'ed@example.com', role: 'editor' }), contextFor('adm@example.com')))
        .statusCode,
      200
    );
    const noAdmin = await handler(
      post('invite', { email: 'ad2@example.com', role: 'admin' }),
      contextFor('adm@example.com')
    );
    assert.equal(noAdmin.statusCode, 403);
    assert.equal(JSON.parse(noAdmin.body).error_code, 'role_not_grantable');
    // env-managed target
    const envT = await handler(
      post('invite', { email: 'boot@example.com', role: 'admin' }),
      contextFor('boot@example.com')
    );
    assert.equal(envT.statusCode, 409);
    assert.equal(JSON.parse(envT.body).error_code, 'env_managed_member');

    // Owner-only verbs
    assert.equal((await handler(post('list_invitations'), contextFor('adm@example.com'))).statusCode, 403);
    const list = await handler(post('list_invitations', { status: 'pending' }), contextFor('boot@example.com'));
    assert.equal(list.statusCode, 200);
    assert.deepEqual(
      JSON.parse(list.body)
        .invitations.map((i: { email: string }) => i.email)
        .sort(),
      ['ed@example.com', 'new@example.com']
    );

    const resend = await handler(post('resend', { email: 'new@example.com' }), contextFor('boot@example.com'));
    assert.equal(resend.statusCode, 200);
    assert.notEqual(JSON.parse(resend.body).accept_token, body.accept_token);

    const revoke = await handler(
      post('revoke', { invite_id: body.invitation.invite_id, reason: 'typo' }),
      contextFor('boot@example.com')
    );
    assert.equal(revoke.statusCode, 200);
    assert.equal(JSON.parse(revoke.body).invitation.status, 'revoked');
    assert.equal(JSON.parse(revoke.body).membership.status, 'removed');
    const gone = await handler(
      post('resend', { invite_id: body.invitation.invite_id }),
      contextFor('boot@example.com')
    );
    assert.equal(gone.statusCode, 409);
    assert.equal(JSON.parse(gone.body).error_code, 'invite_revoked');

    const unmanaged = await handler(post('unmanaged_identities'), contextFor('boot@example.com'));
    assert.equal(unmanaged.statusCode, 200);
    assert.deepEqual(JSON.parse(unmanaged.body).identities, []);
    assert.equal(JSON.parse(unmanaged.body).error_code, 'identity_admin_unavailable');

    // grant: an unmanaged identity gets an active membership at the given role (source netlify_ui)
    const grant = await handler(
      post('grant', { email: 'ui@example.com', role: 'viewer', user_id: 'gotrue-ui' }),
      contextFor('boot@example.com')
    );
    assert.equal(grant.statusCode, 200);
    const granted = JSON.parse(grant.body).user;
    assert.equal(granted.status, 'active');
    assert.equal(granted.role, 'viewer');
    assert.equal(granted.membership_source, 'netlify_ui');
    assert.equal(granted.user_id, 'gotrue-ui');
    assert.equal(
      JSON.parse(
        (await handler(post('grant', { email: 'ui@example.com', role: 'admin' }), contextFor('boot@example.com'))).body
      ).error_code,
      'member_exists'
    );
    // the removed (revoked) member CAN be granted again
    assert.equal(
      (await handler(post('grant', { email: 'new@example.com', role: 'editor' }), contextFor('boot@example.com')))
        .statusCode,
      200
    );

    // accept through the handler closes the invitation and copies its role
    const ed = await handler(post('accept', { display_name: 'Ed Itor' }), contextFor('ed@example.com', 'gotrue-ed'));
    assert.equal(ed.statusCode, 200);
    assert.equal(JSON.parse(ed.body).user.role, 'editor');
    assert.equal(JSON.parse(ed.body).user.status, 'active');
    const invs = JSON.parse(
      (await handler(post('list_invitations', { status: 'accepted' }), contextFor('boot@example.com'))).body
    ).invitations;
    assert.equal(invs.length, 1);
    assert.equal(invs[0].email, 'ed@example.com');

    // invite_preview with our token (path 2) previews the invitation; without it, no invitation block
    const fresh = JSON.parse(
      (await handler(post('invite', { email: 'prev@example.com', role: 'viewer' }), contextFor('boot@example.com')))
        .body
    );
    const preview = JSON.parse((await handler(post('invite_preview', { inv: fresh.accept_token }))).body);
    assert.equal(preview.invitation.email, 'prev@example.com');
    assert.equal(preview.invitation.role, 'viewer');
    assert.equal(preview.invitation.invited_by, 'boot@example.com');
    assert.equal(JSON.parse((await handler(post('invite_preview', { inv: 'inv_bogus' }))).body).invitation, undefined);
  });
});
