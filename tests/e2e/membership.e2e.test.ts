/**
 * W18 T18.9 Part A — the membership E2E harness: the REAL functions
 * (`admin-users`, `membership-sweep`, `/mcp` + `/oauth`) driven end to end
 * against the in-process GoTrue mock (`./gotrue-mock.mjs`), memory blob
 * stores, and the test playing "the invitee's browser" and "the inbox".
 *
 * Flows (brief §Part A.2):
 *   1. bootstrap Owner `me` → welcome (name + tour) → invite editor → mail →
 *      /verify → `accept` with name → welcome step → set_role publisher →
 *      suspend (OAuth grant revoked, lock released, session no longer admin)
 *      → reinstate → remove (identity deleted, GoTrue session dead) → purge
 *      sweep → audit survives.
 *   2. Netlify-UI path: identity invited from "the console", accepts, `me` →
 *      needs_grant → Owner sees it under unmanaged identities → grant viewer.
 *   3. MCP path: OAuth-bound Owner invites (real, not dry-run); the shared
 *      token can neither list nor call the membership tools.
 *   4. Recovery + e-mail change through the mock's token shapes.
 *
 * Runs inside `npm test` (well under a second — no network beyond loopback).
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-users.js';
import { runMembershipSweep } from '../../packages/core/server/functions/membership-sweep.js';
import { handler as oauthHandler } from '../../netlify/functions/mcp-oauth.js';
import { handler as mcpHandler } from '../../netlify/functions/mcp.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { putAccessTokenRecord, getAccessTokenRecord } from '../../packages/core/server/lib/oauth-store.js';
import { objectRecordKey, objectStatusIndexKey } from '../../packages/core/server/lib/object-store-keys.js';
import { KEYS, PREFIXES, personIdForEmail } from '../../packages/core/server/lib/membership/store.js';
import { resolveRolesForPrincipalAsync } from '../../packages/core/server/lib/roles.js';
import { getUserRecord } from '../../packages/core/server/lib/users-store.js';
import type { Principal } from '../../packages/core/schema/object-record-v1.js';
import { startGoTrueMock, decodeFakeJwt } from './gotrue-mock.mjs';

const SITE_URL = 'https://tenant.example';
const HOST = 'tenant.example';
const OWNER = 'boot@example.com';
const AT = '2026-08-17T12:00:00.000Z';
/**
 * The sweep instant, used once (step 9). It CANNOT be a fixed date.
 *
 * `member_remove` runs through the real handler, which stamps `at` from the
 * real clock (`verbs.ts`: `input.deps.now ?? (() => new Date().toISOString())`)
 * — the test has no seam to inject one. `removeMembership` then writes
 * `purge_after = at + purge_grace_days`, so the purge deadline moves with the
 * calendar while a hardcoded sweep date does not. A fixed `2026-10-01T12:00Z`
 * worked until the wall clock reached 2026-09-01, at which point
 * `purge_after` (real now + 30 d) landed AFTER the sweep and step 9 started
 * failing every run, on every branch, for reasons no diff explains.
 *
 * Derived from the removal's own deadline instead: read `purge_after` off the
 * membership record the handler just wrote and sweep one second past it. That
 * asserts the real contract — the sweep purges once the grace period has
 * elapsed, and not before — without depending on what day it is.
 */
const sweepInstantPast = (purgeAfter: string) => new Date(Date.parse(purgeAfter) + 1000).toISOString();
const REDIRECT_URI = 'https://claude.ai/api/mcp/auth_callback';

const handler = createHandler(drlurieSiteBinding);

// ── memory blob stores, one per store name ────────────────────────────────
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
    async set(key: string, value: string) {
      map.set(key, value);
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

const ENV_KEYS = [
  'ADMIN_EMAILS',
  'ROLE_EMAILS_ADMIN',
  'ROLE_EMAILS_PUBLISHER',
  'ROLE_EMAILS_EDITOR',
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'IDENTITY_URL',
  'URL',
  'MCP_HTTP_AUTH_TOKEN',
  'LAMBDA_TASK_ROOT',
] as const;

const withWorld = async (
  fn: (w: { mock: Awaited<ReturnType<typeof startGoTrueMock>>; stores: Map<string, Mem> }) => Promise<void>
) => {
  const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
  const mock = await startGoTrueMock({ siteUrl: SITE_URL });
  const stores = new Map<string, Mem>();
  const storeFor = (name: string) => {
    if (!stores.has(name)) stores.set(name, memStore());
    return stores.get(name)!;
  };
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.ADMIN_EMAILS = OWNER;
  process.env.NETLIFY = 'true';
  process.env.IDENTITY_URL = mock.url;
  process.env.MCP_HTTP_AUTH_TOKEN = 'the-shared-secret';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(opts: unknown) {
      const name = typeof opts === 'string' ? opts : ((opts as { name?: string })?.name ?? 'default');
      return storeFor(name) as never;
    },
  });
  try {
    await fn({ mock, stores });
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    await mock.close();
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ── request helpers ────────────────────────────────────────────────────────
type Resp = { statusCode: number; body: string };
const post = (verb: string, fields: Record<string, unknown> = {}, headers: Record<string, string> = {}) => ({
  httpMethod: 'POST',
  headers: { 'content-type': 'application/json', ...headers },
  body: JSON.stringify({ verb, ...fields }),
});
/** The Owner as Netlify's runtime presents them: decoded JWT user + the injected GoTrue admin token. */
const ownerCtx = (mock: { url: string; adminToken: string }, withIdentity = true) => ({
  clientContext: {
    user: { sub: 'gotrue-boot', email: OWNER },
    ...(withIdentity ? { identity: { url: mock.url, token: mock.adminToken } } : {}),
  },
});
/** The invitee's browser: a bare bearer (the session GoTrue just issued) — admin-auth verifies it against IDENTITY_URL/user. */
const asSession = (accessToken: string) => ({ authorization: `Bearer ${accessToken}` });
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- E2E: bodies are asserted field by field
type Loose = any;
const call = async (event: ReturnType<typeof post>, context?: unknown): Promise<{ status: number; body: Loose }> => {
  const res = (await handler(event as never, context as never)) as Resp;
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null };
};
const hashToken = (link: string) => new URL(link).hash.replace(/^#/, '');
const tokenFrom = (link: string, kind: string) => new URLSearchParams(hashToken(link)).get(`${kind}_token`) ?? '';

const gotrue = async (
  base: string,
  path: string,
  init: { method?: string; token?: string; body?: unknown; form?: boolean } = {}
) => {
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'POST',
    headers: {
      ...(init.token ? { Authorization: `Bearer ${init.token}` } : {}),
      'Content-Type': init.form ? 'application/x-www-form-urlencoded' : 'application/json',
    },
    ...(init.body !== undefined
      ? {
          body: init.form
            ? new URLSearchParams(init.body as Record<string, string>).toString()
            : JSON.stringify(init.body),
        }
      : {}),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};

/** What every function's role resolver would hand this principal right now (store tier, suspended → []). */
const rolesFor = (principal: Principal, users: Mem) =>
  resolveRolesForPrincipalAsync(principal, { getUserRecord: (e) => getUserRecord(users as never, e) });

const auditActions = (users: Mem) =>
  [...users.map.keys()]
    .filter((k) => k.startsWith(PREFIXES.audit))
    .map((k) => JSON.parse(users.map.get(k)!).action as string);

// ─────────────────────────────────────────────────────────────────────────────

test('E2E 1 — Owner bootstrap → invite editor → mail → /verify → accept → welcome → set_role → suspend → reinstate → remove → purge sweep → audit', async () => {
  await withWorld(async ({ mock, stores }) => {
    const ctx = ownerCtx(mock);
    const users = () => stores.get('users')!;

    // 1. bootstrap Owner first login: `me` materialises the record; welcome gate data present
    const me0 = await call(post('me'), ctx);
    assert.equal(me0.status, 200, JSON.stringify(me0.body));
    assert.equal(me0.body.bootstrap, true);
    assert.ok(me0.body.roles.includes('owner'));
    assert.equal(me0.body.policy.require_display_name, true);
    assert.deepEqual(me0.body.onboarding, { steps: {} });

    // welcome: set the name, then finish the tour
    const named = await call(post('update_me', { display_name: 'Boot Owner', onboarding_step: 'name' }), ctx);
    assert.equal(named.status, 200);
    assert.equal(named.body.user.display_name, 'Boot Owner');
    const toured = await call(post('update_me', { onboarding_step: 'tour' }), ctx);
    assert.equal(toured.status, 200);
    const me1 = await call(post('me'), ctx);
    assert.ok(me1.body.onboarding.steps.name);
    assert.ok(me1.body.onboarding.completed_at, 'tour completes onboarding');

    // 2. invite an editor from the members page — GoTrue /invite fires, a mail lands in the outbox
    const inv = await call(post('invite', { email: 'ed@example.com', role: 'editor' }), ctx);
    assert.equal(inv.status, 200, JSON.stringify(inv.body));
    assert.equal(inv.body.invite.sent, true, 'the mock accepted POST /invite');
    assert.equal(inv.body.user.membership_status, 'invited');
    const mail = mock.lastMail('ed@example.com', 'invite');
    assert.ok(mail, 'GoTrue "sent" the invitation');
    assert.match(
      mail!.link,
      new RegExp(`^${SITE_URL}/#invite_token=`),
      'the default template shape the router consumes'
    );
    assert.equal(
      mock.calls.some((c) => c.path === '/admin/users' && c.method === 'POST'),
      false,
      'never the pre-T18.0a endpoint'
    );

    // 3. the invitee opens the mail — the browser router sends #invite_token to /admin/accept, whose
    //    island does what we do here by hand: POST /verify {type:signup, token, password} → session,
    //    then PUT /user {data:{full_name}} and the platform `accept` verb on that session.
    const token = tokenFrom(mail!.link, 'invite');
    const missingPw = await gotrue(mock.url, '/verify', { body: { type: 'signup', token } });
    assert.equal(missingPw.status, 422, 'GoTrue: invited users must specify a password');
    const verified = await gotrue(mock.url, '/verify', {
      body: { type: 'signup', token, password: 'correct horse battery' },
    });
    assert.equal(verified.status, 200, JSON.stringify(verified.body));
    const edSession = verified.body.access_token as string;
    assert.equal(decodeFakeJwt(edSession).email, 'ed@example.com');
    assert.equal(
      (await gotrue(mock.url, '/user', { method: 'PUT', token: edSession, body: { data: { full_name: 'Ed Itor' } } }))
        .status,
      200
    );

    // the accept page then calls `accept` on the fresh session — authenticated by the bearer fallback (IDENTITY_URL/user)
    const accepted = await call(post('accept', { display_name: 'Ed Itor' }, asSession(edSession)));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.needs_grant, false);
    assert.equal(accepted.body.user.membership_status, 'active');
    assert.equal(accepted.body.user.role, 'editor');
    assert.equal(accepted.body.user.display_name, 'Ed Itor');
    assert.equal(accepted.body.user.user_id, decodeFakeJwt(edSession).sub, 'GoTrue user id stamped on the person');

    // 4. welcome for the invitee: name already stamped by accept, tour still owed.
    //    DEFECT D1 (found by this harness, 2026-08-17 → queued as T18.10): every admin
    //    function's sign-in gate is still `roles.includes('admin')` (pre-W18 `isAdmin`), so
    //    an editor / publisher / viewer — assignable since T18.1/T18.3a and promised
    //    "sign in to /admin, edit own profile" by plan §6 — gets 403 on `me` and cannot
    //    load the shell or finish the welcome tour. Pinned HERE as the current behaviour so
    //    the fix flips exactly this assertion; the Owner-side view is used below instead.
    const edMe = await call(post('me', {}, asSession(edSession)));
    assert.equal(edMe.status, 403, 'D1/T18.10: flip to 200 once the tier gates land');
    const edView = await call(post('get', { email: 'ed@example.com' }), ctx);
    assert.equal(edView.status, 200, JSON.stringify(edView.body));
    assert.equal(edView.body.user.role, 'editor');
    assert.equal(edView.body.user.membership_status, 'active');
    assert.ok(edView.body.user.onboarding?.steps?.name, 'accept stamped the name step');
    assert.equal(edView.body.user.onboarding?.completed_at, undefined, 'the tour is still owed');

    // the invitation object closed
    const invs = await call(post('list_invitations'), ctx);
    assert.equal(invs.status, 200);
    assert.equal(
      invs.body.invitations.find((i: { email: string }) => i.email === 'ed@example.com')?.status,
      'accepted'
    );

    // 5. Owner promotes to publisher; the resolver follows on the next call
    const promoted = await call(post('set_role', { email: 'ed@example.com', role: 'publisher' }), ctx);
    assert.equal(promoted.status, 200, JSON.stringify(promoted.body));
    assert.equal(promoted.body.user.role, 'publisher');
    const edPrincipal = { kind: 'human' as const, id: decodeFakeJwt(edSession).sub as string, email: 'ed@example.com' };
    assert.deepEqual(await rolesFor(edPrincipal, users()), ['publisher']);

    // 6. give the editor an OAuth grant and a held lock, then suspend
    const edUserId = decodeFakeJwt(edSession).sub as string;
    const governance = stores.get('governance') ?? (stores.set('governance', memStore()), stores.get('governance')!);
    await putAccessTokenRecord(governance as never, 'ed-oauth-token', {
      schema_version: 'oauth-access-token.v1',
      client_id: 'c1',
      client_name: 'Claude',
      subject_email: 'ed@example.com',
      subject_id: edUserId,
      scope: 'mcp offline_access',
      resource: `${SITE_URL}/mcp`,
      site: 'site_drlurie',
      issued_at: AT,
      expires_at: '2099-01-01T00:00:00.000Z',
    } as never);
    const objects = stores.get('site-objects') ?? (stores.set('site-objects', memStore()), stores.get('site-objects')!);
    await objects.setJSON(objectRecordKey('page', 'p1'), {
      object_id: 'p1',
      object_type: 'page',
      status: 'active',
      version: 3,
      created_at: AT,
      updated_at: AT,
      lock: {
        owner_id: edUserId,
        owner_label: 'ed@example.com',
        token: 'tok',
        acquired_at: AT,
        expires_at: '2099-01-01T00:00:00.000Z',
      },
      history: [],
      body: {},
    });
    await objects.setJSON(objectStatusIndexKey('page', 'active', 'p1'), '');

    const suspended = await call(post('suspend', { email: 'ed@example.com', reason: 'leave' }), ctx);
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.offboarding.oauth_revoked, 1);
    assert.deepEqual(suspended.body.offboarding.locks_released, [{ object_id: 'p1', object_type: 'page' }]);
    assert.equal(await getAccessTokenRecord(governance as never, 'ed-oauth-token', 'site_drlurie'), null);
    assert.equal(JSON.parse(objects.map.get(objectRecordKey('page', 'p1'))!).lock, undefined);
    // the suspended member's still-valid GoTrue session resolves to NO roles on the next call
    assert.deepEqual(await rolesFor(edPrincipal, users()), []);
    assert.equal((await call(post('me', {}, asSession(edSession)))).status, 403);

    // 7. reinstate → back
    assert.equal((await call(post('reinstate', { email: 'ed@example.com' }), ctx)).status, 200);
    assert.deepEqual(await rolesFor(edPrincipal, users()), ['publisher']);

    // 8. remove (Owner request carries the admin token) → identity deleted NOW, session dead
    const removed = await call(post('remove', { email: 'ed@example.com' }), ctx);
    assert.equal(removed.status, 200, JSON.stringify(removed.body));
    assert.equal(removed.body.offboarding.identity.outcome, 'deleted');
    assert.equal(removed.body.user.membership_status, 'removed');
    assert.equal(mock.userByEmail('ed@example.com'), null, 'DELETE /admin/users/{id} reached GoTrue');
    assert.equal((await gotrue(mock.url, '/user', { method: 'GET', token: edSession })).status, 401);
    assert.equal(
      (await call(post('me', {}, asSession(edSession)))).status,
      401,
      'bearer fallback: GoTrue no longer knows the token'
    );

    // 9. the daily sweep, after the grace period → PII scrubbed, membership + audit retained
    const removedMembership = JSON.parse(users().map.get(KEYS.membership(personIdForEmail('ed@example.com')))!);
    const purgeAfter = removedMembership.removed?.purge_after as string;
    assert.ok(purgeAfter, 'the remove stamped a purge deadline to sweep past');

    // A sweep BEFORE the deadline must purge nothing — the grace period is the
    // point of the deadline, and a sweep date that happens to sit past it by
    // accident would assert nothing.
    const early = await runMembershipSweep({}, new Date(Date.parse(purgeAfter) - 1000).toISOString());
    assert.deepEqual(early.purged_persons, [], 'nothing is purged while the grace period is still running');

    const sweep = await runMembershipSweep({}, sweepInstantPast(purgeAfter));
    assert.deepEqual(sweep.purged_persons, [personIdForEmail('ed@example.com')], JSON.stringify(sweep));
    const person = JSON.parse(users().map.get(KEYS.person(personIdForEmail('ed@example.com')))!);
    assert.equal(person.deleted, true);
    assert.equal(person.email, undefined, 'PII gone');
    assert.equal(users().map.has(KEYS.byEmail('ed@example.com')), false, 'index gone');

    // 10. the audit trail survives the purge (Owner reads it by person_id-keyed stream)
    const actions = auditActions(users());
    for (const expected of ['invitation.create', 'membership.suspend', 'membership.reinstate', 'membership.remove']) {
      assert.ok(
        actions.some((a) => a === expected || a.startsWith(expected)),
        `audit has ${expected}: ${actions.join(',')}`
      );
    }
    assert.ok(
      actions.some((a) => /purge/.test(a)),
      `audit has a purge event: ${actions.join(',')}`
    );
  });
});

test('E2E 2 — Netlify-UI path: console-invited identity accepts, `me` says needs_grant, Owner reconciles it and grants viewer', async () => {
  await withWorld(async ({ mock, stores }) => {
    const ctx = ownerCtx(mock);
    await call(post('me'), ctx);

    // "the console": Identity tab → Invite user
    await mock.consoleInvite('ui@example.com');
    const mail = mock.lastMail('ui@example.com', 'invite');
    assert.ok(mail);
    const verified = await gotrue(mock.url, '/verify', {
      body: { type: 'signup', token: tokenFrom(mail!.link, 'invite'), password: 'a strong passphrase' },
    });
    assert.equal(verified.status, 200);
    const uiSession = verified.body.access_token as string;

    // the accept page → `accept` (no platform record → creates nothing, grants nothing)
    const accepted = await call(post('accept', { display_name: 'Netlify Invitee' }, asSession(uiSession)));
    assert.equal(accepted.status, 200, JSON.stringify(accepted.body));
    assert.equal(accepted.body.user, null);
    assert.equal(accepted.body.needs_grant, true);
    // and every admin call is refused until an Owner grants a role
    assert.equal((await call(post('list', {}, asSession(uiSession)))).status, 403);

    // Owner: Identities tab lists them as unmanaged, grant viewer
    const unmanaged = await call(post('unmanaged_identities'), ctx);
    assert.equal(unmanaged.status, 200, JSON.stringify(unmanaged.body));
    const found = unmanaged.body.identities.find((i: { email: string }) => i.email === 'ui@example.com');
    assert.ok(found, JSON.stringify(unmanaged.body));
    assert.equal(found.confirmed, true);
    const granted = await call(post('grant', { email: 'ui@example.com', role: 'viewer', user_id: found.id }), ctx);
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal(granted.body.user.membership_source, 'netlify_ui');
    assert.equal(granted.body.user.membership_status, 'active');

    // the invitee is now a viewer (D1/T18.10: `me` on that session is still 403 until the tier gates land)
    const uiPrincipal = { kind: 'human' as const, id: found.id as string, email: 'ui@example.com' };
    assert.deepEqual(await rolesFor(uiPrincipal, stores.get('users')!), ['viewer']);
    assert.equal(
      (await call(post('me', {}, asSession(uiSession)))).status,
      403,
      'D1/T18.10: flip to 200 once the tier gates land'
    );
    assert.equal((await call(post('unmanaged_identities'), ctx)).body.identities.length, 0, 'reconciled');

    // an Owner cannot grant to a break-glass env address, and a viewer cannot invite
    assert.equal((await call(post('grant', { email: OWNER, role: 'viewer' }), ctx)).status, 409);
    const viewerInvite = await call(post('invite', { email: 'x@example.com', role: 'viewer' }, asSession(uiSession)));
    assert.equal(viewerInvite.status, 403);
  });
});

// ── OAuth helpers (the mcp-oauth flow, minimal) ─────────────────────────────
type OAuthResp = { statusCode: number; headers?: Record<string, string>; body: string };
const oauthCall = async (event: Record<string, unknown>, context?: unknown): Promise<OAuthResp> =>
  (await oauthHandler({ headers: { host: HOST }, ...event } as never, context as never)) as OAuthResp;
const jsonOf = (r: OAuthResp) => JSON.parse(r.body) as Record<string, string>;
const oauthTokenForOwner = async () => {
  const reg = await oauthCall({
    httpMethod: 'POST',
    path: '/oauth/register',
    headers: { host: HOST, 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'E2E', redirect_uris: [REDIRECT_URI] }),
  });
  assert.equal(reg.statusCode, 201, reg.body);
  const client = jsonOf(reg);
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = await oauthCall({
    httpMethod: 'GET',
    path: '/oauth/authorize',
    queryStringParameters: {
      response_type: 'code',
      client_id: client.client_id,
      redirect_uri: REDIRECT_URI,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 's',
    },
  });
  assert.equal(authorize.statusCode, 302, authorize.body);
  const requestId = new URL(authorize.headers?.Location ?? '', `https://${HOST}`).searchParams.get('request_id');
  const consent = await oauthCall(
    {
      httpMethod: 'POST',
      path: '/oauth/consent',
      headers: { host: HOST, 'content-type': 'application/json' },
      body: JSON.stringify({ request_id: requestId, action: 'approve' }),
    },
    { clientContext: { user: { sub: 'gotrue-boot', email: OWNER } } }
  );
  assert.equal(consent.statusCode, 200, consent.body);
  const code = new URL(jsonOf(consent).redirect_to).searchParams.get('code');
  const tok = await oauthCall({
    httpMethod: 'POST',
    path: '/oauth/token',
    headers: { host: HOST, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code: code ?? '',
      redirect_uri: REDIRECT_URI,
      client_id: client.client_id,
      code_verifier: verifier,
    }).toString(),
  });
  assert.equal(tok.statusCode, 200, tok.body);
  return jsonOf(tok).access_token;
};
const rpc = async (auth: string, method: string, params?: Record<string, unknown>) => {
  const res = (await mcpHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', host: HOST, authorization: auth },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }),
  } as never)) as OAuthResp;
  return { status: res.statusCode, body: JSON.parse(res.body) as { result?: Record<string, Loose>; error?: unknown } };
};

test('E2E 3 — MCP path: the OAuth-bound Owner invites for real; the shared token neither lists nor calls membership tools', async () => {
  await withWorld(async ({ mock }) => {
    await call(post('me'), ownerCtx(mock));
    const owner = `Bearer ${await oauthTokenForOwner()}`;

    const listed = await rpc(owner, 'tools/list');
    const names = (listed.body.result?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(names.includes('member_invite'));

    const invited = await rpc(owner, 'tools/call', {
      name: 'member_invite',
      arguments: { email: 'mcp@example.com', role: 'viewer' },
    });
    const result = invited.body.result as { isError?: boolean; structuredContent?: Loose };
    assert.equal(result.isError, undefined, JSON.stringify(invited.body).slice(0, 400));
    assert.equal(result.structuredContent.user.membership_status, 'invited');
    assert.equal(
      result.structuredContent.invite.sent,
      false,
      'no GoTrue admin token rides an MCP request — record created, mail is the Owner’s resend from the UI'
    );
    // the platform record is real: the members page sees it
    const list = await call(post('list'), ownerCtx(mock));
    assert.ok(
      list.body.users.some(
        (u: { email: string; membership_source: string }) =>
          u.email === 'mcp@example.com' && u.membership_source === 'invitation'
      )
    );
    const invs = await call(post('list_invitations'), ownerCtx(mock));
    assert.equal(
      invs.body.invitations.find((i: { email: string }) => i.email === 'mcp@example.com')?.source,
      'mcp',
      'the invitation records it came over MCP'
    );
    // and the Owner's next UI request (with the admin token) can resend the mail
    const resent = await call(post('resend', { email: 'mcp@example.com' }), ownerCtx(mock));
    assert.equal(resent.status, 200, JSON.stringify(resent.body));
    assert.ok(mock.lastMail('mcp@example.com', 'invite'));

    // shared token: hidden and refused
    const shared = 'Bearer the-shared-secret';
    const sharedList = await rpc(shared, 'tools/list');
    const sharedNames = (sharedList.body.result?.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok(!sharedNames.includes('member_invite'));
    const refused = await rpc(shared, 'tools/call', {
      name: 'member_invite',
      arguments: { email: 'z@example.com', role: 'viewer' },
    });
    assert.equal(
      (refused.body.result as { structuredContent?: { error_code?: string } }).structuredContent?.error_code,
      'membership_requires_human'
    );
  });
});

test('E2E 4 — recovery and e-mail change ride the mock’s default token shapes (#recovery_token / #email_change_token) and end in a usable session', async () => {
  await withWorld(async ({ mock }) => {
    await mock.consoleInvite('pat@example.com');
    const inv = mock.lastMail('pat@example.com', 'invite')!;
    const first = await gotrue(mock.url, '/verify', {
      body: { type: 'signup', token: tokenFrom(inv.link, 'invite'), password: 'first password!' },
    });
    assert.equal(first.status, 200);

    // forgot password → /recover → mail → /verify recovery → PUT /user {password}
    assert.equal((await gotrue(mock.url, '/recover', { body: { email: 'pat@example.com' } })).status, 200);
    const rec = mock.lastMail('pat@example.com', 'recovery')!;
    assert.match(rec.link, /#recovery_token=/, 'the default recovery shape (not #access_token&type=recovery)');
    const recovered = await gotrue(mock.url, '/verify', {
      body: { type: 'recovery', token: tokenFrom(rec.link, 'recovery') },
    });
    assert.equal(recovered.status, 200);
    const session = recovered.body.access_token as string;
    assert.equal(
      (await gotrue(mock.url, '/user', { method: 'PUT', token: session, body: { password: 'second password!' } }))
        .status,
      200
    );
    assert.equal(
      (
        await gotrue(mock.url, '/token', {
          form: true,
          body: { grant_type: 'password', username: 'pat@example.com', password: 'first password!' },
        })
      ).status,
      400
    );
    const login = await gotrue(mock.url, '/token', {
      form: true,
      body: { grant_type: 'password', username: 'pat@example.com', password: 'second password!' },
    });
    assert.equal(login.status, 200);

    // e-mail change → PUT /user {email} → mail to the NEW address → /verify email_change → session under the new e-mail
    const changed = await gotrue(mock.url, '/user', {
      method: 'PUT',
      token: login.body.access_token,
      body: { email: 'pat.new@example.com' },
    });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.new_email, 'pat.new@example.com');
    const ec = mock.lastMail('pat.new@example.com', 'email_change')!;
    assert.match(ec.link, /#email_change_token=/);
    const confirmed = await gotrue(mock.url, '/verify', {
      body: { type: 'email_change', token: tokenFrom(ec.link, 'email_change') },
    });
    assert.equal(confirmed.status, 200);
    assert.equal(decodeFakeJwt(confirmed.body.access_token).email, 'pat.new@example.com');
    assert.equal(mock.userByEmail('pat@example.com'), null);
    // a stale token gets nothing
    assert.equal((await gotrue(mock.url, '/verify', { body: { type: 'recovery', token: 'nope' } })).status, 404);
  });
});
