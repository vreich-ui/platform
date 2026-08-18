/**
 * W18 T18.1 — membership store v2: security-boundary tests. The store feeds
 * resolveRolesForPrincipalAsync → every Owner gate + publish-gate, so these
 * pin: v1 rows read as v2 views; the first write migrates them; env Owners
 * always resolve owner (empty/corrupt/v1/v2 stores); suspended/removed ⇒ [];
 * each tier expands correctly; canDecideReview excludes viewer; last_owner
 * on set_role/suspend (with and without env owners); promote_bootstrap;
 * agent principal ⇒ []; disable alias == suspend.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/admin-users.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';
import {
  getUserRecord,
  putUserRecord,
  listUserRecords,
  userRecordKey,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import {
  getMembershipByEmail,
  listMembers,
  upgradeLegacyRecord,
} from '../../packages/core/server/lib/membership/read.js';
import {
  upsertFromV1,
  getPolicy,
  setPolicy,
  saveMember,
  newMember,
} from '../../packages/core/server/lib/membership/write.js';
import { KEYS, PREFIXES, personIdForEmail, mintUlid } from '../../packages/core/server/lib/membership/store.js';
import {
  resolveRolesForPrincipalAsync,
  expandRole,
  canDecideReview,
  canExecutePublish,
} from '../../packages/core/server/lib/roles.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import type { Principal } from '../../packages/core/schema/object-record-v1.js';

const AT = '2026-08-17T10:00:00.000Z';
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
  };
};

const human = (email: string): Principal => ({ kind: 'human', id: 'u1', email });
const agent: Principal = { kind: 'agent', agent_name: 'writer', auth: 'mcp_token' };

/** A raw v1 row exactly as T9.4 wrote it (full record under by-email/). */
const v1Row = (over: Record<string, unknown> = {}) => ({
  schema_version: 1,
  email: 'legacy@example.com',
  user_id: 'gotrue-legacy',
  display_name: 'Legacy Member',
  role: 'admin',
  status: 'active',
  invited_by: 'boss@example.com',
  created_at: '2026-07-17T00:00:00.000Z',
  updated_at: '2026-07-18T00:00:00.000Z',
  last_seen_at: '2026-07-19T00:00:00.000Z',
  audit: [{ at: '2026-07-17T00:00:00.000Z', actor_email: 'boss@example.com', action: 'invite', detail: 'role admin' }],
  ...over,
});

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
const activeOwner = (email: string) => ({
  schema_version: 1 as const,
  email,
  display_name: email,
  role: 'owner' as const,
  status: 'active' as const,
  invited_by: 'boss@example.com',
  created_at: AT,
  updated_at: AT,
  audit: [],
});

// ─── ids ──────────────────────────────────────────────────────────────────────

test('person_id is deterministic from the normalized e-mail (usr_ + 20 base32 chars) — converges fleet-wide', () => {
  const a = personIdForEmail('Jane@Example.com');
  const b = personIdForEmail('  jane@example.com ');
  assert.equal(a, b);
  assert.match(a, /^usr_[0-9a-hjkmnp-tv-z]{20}$/);
  assert.notEqual(a, personIdForEmail('other@example.com'));
  assert.match(mintUlid(), /^[0-9a-hjkmnp-tv-z]{26}$/);
});

// ─── v1 → v2 read path ────────────────────────────────────────────────────────

test('a raw v1 by-email row reads as a v2 member (in memory, no write) and as the v1 view', async () => {
  const store = memStore();
  store.map.set(userRecordKey('legacy@example.com'), JSON.stringify(v1Row()));
  const before = store.map.size;

  const member = await getMembershipByEmail(store, 'LEGACY@example.com');
  assert.ok(member);
  assert.equal(member.legacy, true);
  assert.equal(member.person.person_id, personIdForEmail('legacy@example.com'));
  assert.equal(member.person.identity.user_id, 'gotrue-legacy');
  assert.equal(member.person.display_name, 'Legacy Member');
  assert.equal(member.membership.role, 'admin');
  assert.equal(member.membership.status, 'active');
  assert.equal(member.membership.source, 'legacy_v1');
  assert.deepEqual(member.membership.granted_by, { kind: 'human', email: 'boss@example.com' });
  assert.equal(member.membership.audit.length, 1);
  assert.equal(store.map.size, before, 'reading must not write');

  const view = await getUserRecord(store, 'legacy@example.com');
  assert.equal(view?.schema_version, 1);
  assert.equal(view?.role, 'admin');
  assert.equal(view?.status, 'active');
  assert.equal(view?.person_id, member.person.person_id);
  assert.equal(view?.membership_status, 'active');
  assert.equal(view?.last_seen_at, '2026-07-19T00:00:00.000Z');
});

test('v1 disabled reads as v2 suspended (view: disabled) → resolves []', async () => {
  const store = memStore();
  store.map.set(
    userRecordKey('gone@example.com'),
    JSON.stringify(v1Row({ email: 'gone@example.com', status: 'disabled' }))
  );
  const member = await getMembershipByEmail(store, 'gone@example.com');
  assert.equal(member?.membership.status, 'suspended');
  assert.equal((await getUserRecord(store, 'gone@example.com'))?.status, 'disabled');
  assert.deepEqual(
    await resolveRolesForPrincipalAsync(human('gone@example.com'), {
      env: {},
      getUserRecord: (e) => getUserRecord(store, e),
    }),
    []
  );
});

test('the first WRITE migrates: person + membership appear, by-email becomes a { person_id } pointer, view unchanged', async () => {
  const store = memStore();
  store.map.set(userRecordKey('legacy@example.com'), JSON.stringify(v1Row()));
  const before = await getUserRecord(store, 'legacy@example.com');

  await putUserRecord(store, { ...before!, last_seen_at: AT });

  const raw = JSON.parse(store.map.get(userRecordKey('legacy@example.com'))!);
  assert.deepEqual(raw, { person_id: personIdForEmail('legacy@example.com') });
  assert.ok(store.map.has(KEYS.person(personIdForEmail('legacy@example.com'))));
  assert.ok(store.map.has(KEYS.membership(personIdForEmail('legacy@example.com'))));
  assert.ok(store.map.has(KEYS.byIdentity('gotrue-legacy')));

  const after = await getMembershipByEmail(store, 'legacy@example.com');
  assert.equal(after?.legacy, false);
  const view = await getUserRecord(store, 'legacy@example.com');
  assert.equal(view?.role, before?.role);
  assert.equal(view?.status, before?.status);
  assert.equal(view?.display_name, before?.display_name);
  assert.equal(view?.user_id, before?.user_id);
  assert.equal(view?.invited_by, before?.invited_by);
  assert.deepEqual(view?.audit, before?.audit);
  assert.equal(view?.last_seen_at, AT);
});

test('upsertFromV1 migrates explicitly, audits membership.migrate_v1, and is idempotent', async () => {
  const store = memStore();
  store.map.set(userRecordKey('legacy@example.com'), JSON.stringify(v1Row()));
  const first = await upsertFromV1(store, 'legacy@example.com', AT);
  assert.equal(first?.legacy, false);
  const auditKeys = [...store.map.keys()].filter((k) => k.startsWith(PREFIXES.audit));
  assert.equal(auditKeys.length, 1);
  assert.match(auditKeys[0], /^audit\/2026-08\//);
  assert.equal(JSON.parse(store.map.get(auditKeys[0])!).action, 'membership.migrate_v1');
  const second = await upsertFromV1(store, 'legacy@example.com', AT);
  assert.equal(second?.legacy, false);
  assert.equal([...store.map.keys()].filter((k) => k.startsWith(PREFIXES.audit)).length, 1, 'no second audit');
  assert.equal(await upsertFromV1(store, 'nobody@example.com'), null);
});

test('listUserRecords / listMembers merge v2 members with unmigrated v1 rows, skipping corrupt entries', async () => {
  const store = memStore();
  store.map.set(userRecordKey('legacy@example.com'), JSON.stringify(v1Row()));
  store.map.set(userRecordKey('junk@example.com'), '{not json');
  store.map.set(userRecordKey('dangling@example.com'), JSON.stringify({ person_id: 'usr_missing' }));
  await putUserRecord(store, activeOwner('owner@example.com'));
  const rows = await listUserRecords(store);
  assert.deepEqual(
    rows.map((r) => `${r.email}:${r.role}:${r.membership_status}`),
    ['legacy@example.com:admin:active', 'owner@example.com:owner:active']
  );
  assert.equal((await listMembers(store)).length, 2);
});

test('upgradeLegacyRecord maps bootstrap rows to source bootstrap_env / granted_by system', () => {
  const m = upgradeLegacyRecord({ ...v1Row({ invited_by: 'bootstrap', role: 'owner' }), audit: [] } as never);
  assert.equal(m.membership.source, 'bootstrap_env');
  assert.deepEqual(m.membership.granted_by, { kind: 'system', reason: 'ADMIN_EMAILS' });
});

// ─── resolver precedence over v2 ──────────────────────────────────────────────

test('ADMIN_EMAILS member resolves owner over an EMPTY, CORRUPT, v1-suspended and v2-removed store alike', async () => {
  const env = { ADMIN_EMAILS: 'boss@x.com' };
  const expected = ['owner', 'admin', 'publisher'];
  const empty = memStore();
  assert.deepEqual(
    await resolveRolesForPrincipalAsync(human('boss@x.com'), { env, getUserRecord: (e) => getUserRecord(empty, e) }),
    expected
  );

  const corrupt = memStore();
  corrupt.map.set(userRecordKey('boss@x.com'), '{{{');
  assert.deepEqual(
    await resolveRolesForPrincipalAsync(human('boss@x.com'), { env, getUserRecord: (e) => getUserRecord(corrupt, e) }),
    expected
  );

  const v1 = memStore();
  v1.map.set(userRecordKey('boss@x.com'), JSON.stringify(v1Row({ email: 'boss@x.com', status: 'disabled' })));
  assert.deepEqual(
    await resolveRolesForPrincipalAsync(human('boss@x.com'), { env, getUserRecord: (e) => getUserRecord(v1, e) }),
    expected
  );

  const v2 = memStore();
  const removed = newMember({
    email: 'boss@x.com',
    display_name: 'Boss',
    role: 'viewer',
    status: 'removed',
    source: 'invitation',
    granted_by: { kind: 'human', email: 'x@x.com' },
    invited_by: 'x@x.com',
    at: AT,
  });
  await saveMember(v2, removed);
  assert.deepEqual(
    await resolveRolesForPrincipalAsync(human('BOSS@x.com'), { env, getUserRecord: (e) => getUserRecord(v2, e) }),
    expected
  );
});

test('each of the five tiers expands exactly; suspended and removed memberships resolve []', async () => {
  assert.deepEqual(expandRole('owner'), ['owner', 'admin', 'publisher']);
  assert.deepEqual(expandRole('admin'), ['admin']);
  assert.deepEqual(expandRole('publisher'), ['publisher']);
  assert.deepEqual(expandRole('editor'), ['editor']);
  assert.deepEqual(expandRole('viewer'), ['viewer']);

  const store = memStore();
  for (const role of ['owner', 'admin', 'publisher', 'editor', 'viewer'] as const) {
    await putUserRecord(store, { ...activeOwner(`${role}@x.com`), role });
    assert.deepEqual(
      await resolveRolesForPrincipalAsync(human(`${role}@x.com`), {
        env: {},
        getUserRecord: (e) => getUserRecord(store, e),
      }),
      expandRole(role),
      role
    );
  }
  for (const status of ['suspended', 'removed'] as const) {
    const m = newMember({
      email: `${status}@x.com`,
      display_name: status,
      role: 'owner',
      status,
      source: 'invitation',
      granted_by: { kind: 'human', email: 'x@x.com' },
      invited_by: 'x@x.com',
      at: AT,
    });
    await saveMember(store, m);
    assert.deepEqual(
      await resolveRolesForPrincipalAsync(human(`${status}@x.com`), {
        env: {},
        getUserRecord: (e) => getUserRecord(store, e),
      }),
      [],
      status
    );
  }
  assert.deepEqual(await resolveRolesForPrincipalAsync(agent, { env: { ADMIN_EMAILS: 'boss@x.com' } }), []);
});

test('canDecideReview: owner/admin/publisher/editor have standing, viewer and nobody do not; publish authority unchanged', () => {
  assert.equal(canDecideReview(['owner', 'admin', 'publisher']), true);
  assert.equal(canDecideReview(['admin']), true);
  assert.equal(canDecideReview(['publisher']), true);
  assert.equal(canDecideReview(['editor']), true);
  assert.equal(canDecideReview(['viewer']), false);
  assert.equal(canDecideReview([]), false);
  assert.equal(canExecutePublish(['viewer']), false);
  assert.equal(canExecutePublish(['editor']), false);
  assert.equal(canExecutePublish(['publisher']), true);
  assert.equal(canExecutePublish(['admin']), true);
});

// ─── policy ───────────────────────────────────────────────────────────────────

test('policy: committed defaults, partial override merges, corrupt override falls back', async () => {
  const store = memStore();
  const defaults = await getPolicy(store);
  assert.equal(defaults.min_owners, 1);
  assert.equal(defaults.who_can_invite, 'owner_admin');
  await setPolicy(store, { min_owners: 2 });
  const merged = await getPolicy(store);
  assert.equal(merged.min_owners, 2);
  assert.equal(merged.invite_ttl_hours, defaults.invite_ttl_hours);
  store.map.set(KEYS.policy(), '{"min_owners":"lots"}');
  assert.equal((await getPolicy(store)).min_owners, 1);
});

// ─── admin-users verbs over v2 ────────────────────────────────────────────────

test('set_role accepts all five tiers; an Owner demoting the OTHER Owner is fine (the actor remains); a demoted actor is 403', async () => {
  await withHandlerStore({}, async (store) => {
    await putUserRecord(store, activeOwner('boss@example.com'));
    await putUserRecord(store, { ...activeOwner('jane@example.com'), role: 'admin' });
    for (const role of ['viewer', 'editor', 'publisher', 'admin', 'owner'] as const) {
      const res = await handler(post('set_role', { email: 'jane@example.com', role }), contextFor('boss@example.com'));
      assert.equal(res.statusCode, 200, role);
      assert.equal(JSON.parse(res.body).user.role, role);
    }
    // two owners now; jane demotes boss → jane remains → allowed
    const demoteBoss = await handler(
      post('set_role', { email: 'boss@example.com', role: 'admin' }),
      contextFor('jane@example.com')
    );
    assert.equal(demoteBoss.statusCode, 200);
    // boss is an admin → Owner verbs are 403 for him
    assert.equal(
      (await handler(post('set_role', { email: 'jane@example.com', role: 'admin' }), contextFor('boss@example.com')))
        .statusCode,
      403
    );
    // an unknown tier is 400
    assert.equal(
      (
        await handler(
          post('set_role', { email: 'boss@example.com', role: 'superuser' }),
          contextFor('jane@example.com')
        )
      ).statusCode,
      400
    );
    const events = [...store.map.keys()]
      .filter((k) => k.startsWith(PREFIXES.audit))
      .map((k) => JSON.parse(store.map.get(k)!));
    assert.ok(
      events.some(
        (e) => e.action === 'membership.role_change' && e.detail?.from === 'owner' && e.detail?.to === 'admin'
      )
    );
  });
});

test('last_owner: suspending / demoting the last active stored Owner is 409 last_owner unless an env bootstrap Owner exists', async () => {
  // Without env owners: two stored owners; suspend one → ok; the remaining one cannot be suspended by anyone (the other is suspended, not an owner-actor)
  await withHandlerStore({}, async (store) => {
    await putUserRecord(store, activeOwner('a@example.com'));
    await putUserRecord(store, activeOwner('b@example.com'));
    assert.equal(
      (await handler(post('suspend', { email: 'b@example.com' }), contextFor('a@example.com'))).statusCode,
      200
    );
    // reinstate b, then b suspends a → ok, a is suspended; b is last active owner
    assert.equal(
      (await handler(post('reinstate', { email: 'b@example.com' }), contextFor('a@example.com'))).statusCode,
      200
    );
    assert.equal(
      (await handler(post('suspend', { email: 'a@example.com' }), contextFor('b@example.com'))).statusCode,
      200
    );
    // b is the last ACTIVE stored owner. Bring in c as owner so an actor exists, then c tries to demote b → allowed (c remains) ; then b demotes c → allowed (b remains); then c is admin and 403.
    await putUserRecord(store, activeOwner('c@example.com'));
    const demote = await handler(
      post('set_role', { email: 'b@example.com', role: 'viewer' }),
      contextFor('c@example.com')
    );
    assert.equal(demote.statusCode, 200);
    // c is now the last active owner. Reinstate a as owner? a is suspended-owner (not active) — c demoting… suspend c by a? a has no roles. Use direct guard:
    const { wouldBreachMinOwners } = await import('../../packages/core/server/lib/membership/write.js');
    assert.equal(
      await wouldBreachMinOwners(store, {
        exceptPersonId: personIdForEmail('c@example.com'),
        envOwnerCount: 0,
        minOwners: 1,
      }),
      true
    );
    assert.equal(
      await wouldBreachMinOwners(store, {
        exceptPersonId: personIdForEmail('c@example.com'),
        envOwnerCount: 1,
        minOwners: 1,
      }),
      false
    );
  });

  // With an env bootstrap owner acting: the last stored owner CAN be demoted/suspended (env owner keeps min_owners satisfied)
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com' }, async (store) => {
    await putUserRecord(store, activeOwner('only@example.com'));
    const res = await handler(
      post('suspend', { email: 'only@example.com', reason: 'left the company' }),
      contextFor('boot@example.com')
    );
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.equal(body.user.status, 'disabled');
    assert.equal(body.user.membership_status, 'suspended');
    assert.equal(body.user.audit.at(-1).action, 'suspend');
    assert.equal(body.user.audit.at(-1).detail, 'left the company');
  });

  // Direct 409 through the handler: env owner acting, but policy.min_owners raised to 2 → suspending the only stored owner breaches (1 env + 0 stored < 2)
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com' }, async (store) => {
    await putUserRecord(store, activeOwner('only@example.com'));
    await setPolicy(store, { min_owners: 2 });
    const res = await handler(
      post('set_role', { email: 'only@example.com', role: 'admin' }),
      contextFor('boot@example.com')
    );
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error_code, 'last_owner');
    assert.equal((await getUserRecord(store, 'only@example.com'))?.role, 'owner');
    const sus = await handler(post('suspend', { email: 'only@example.com' }), contextFor('boot@example.com'));
    assert.equal(sus.statusCode, 409);
    assert.equal(JSON.parse(sus.body).error_code, 'last_owner');
  });
});

test('disable is an alias of suspend; reinstate flips suspended → active; audit stream records both', async () => {
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com' }, async (store) => {
    await putUserRecord(store, { ...activeOwner('m@example.com'), role: 'editor' });
    const dis = await handler(post('disable', { email: 'm@example.com' }), contextFor('boot@example.com'));
    assert.equal(dis.statusCode, 200);
    const member = await getMembershipByEmail(store, 'm@example.com');
    assert.equal(member?.membership.status, 'suspended');
    assert.ok(member?.membership.suspended?.at);
    assert.deepEqual(
      await resolveRolesForPrincipalAsync(human('m@example.com'), {
        env: {},
        getUserRecord: (e) => getUserRecord(store, e),
      }),
      []
    );
    const re = await handler(post('reinstate', { email: 'm@example.com' }), contextFor('boot@example.com'));
    assert.equal(re.statusCode, 200);
    assert.equal(JSON.parse(re.body).user.membership_status, 'active');
    assert.equal((await getMembershipByEmail(store, 'm@example.com'))?.membership.suspended, undefined);
    assert.deepEqual(
      await resolveRolesForPrincipalAsync(human('m@example.com'), {
        env: {},
        getUserRecord: (e) => getUserRecord(store, e),
      }),
      ['editor']
    );
    const events = [...store.map.keys()]
      .filter((k) => k.startsWith(PREFIXES.audit))
      .map((k) => JSON.parse(store.map.get(k)!).action);
    assert.ok(events.includes('membership.suspend'));
    assert.ok(events.includes('membership.reinstate'));
    // reinstating an active member is a no-op 200
    assert.equal(
      (await handler(post('reinstate', { email: 'm@example.com' }), contextFor('boot@example.com'))).statusCode,
      200
    );
  });
});

test('promote_bootstrap materialises a stored Owner for an ADMIN_EMAILS member (Owner-only; env-only targets), idempotent', async () => {
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com, second@example.com' }, async (store) => {
    // a stored admin cannot call it
    await putUserRecord(store, { ...activeOwner('adm@example.com'), role: 'admin' });
    assert.equal(
      (await handler(post('promote_bootstrap', { email: 'second@example.com' }), contextFor('adm@example.com')))
        .statusCode,
      403
    );
    // non-env target → 409
    assert.equal(
      (await handler(post('promote_bootstrap', { email: 'adm@example.com' }), contextFor('boot@example.com')))
        .statusCode,
      409
    );
    // env target → stored owner
    const res = await handler(
      post('promote_bootstrap', { email: 'Second@Example.com' }),
      contextFor('boot@example.com')
    );
    assert.equal(res.statusCode, 200);
    const user = JSON.parse(res.body).user;
    assert.equal(user.role, 'owner');
    assert.equal(user.status, 'active');
    assert.equal(user.membership_source, 'bootstrap_env');
    assert.equal(user.audit.at(-1).action, 'promote_bootstrap');
    const again = await handler(
      post('promote_bootstrap', { email: 'second@example.com' }),
      contextFor('boot@example.com')
    );
    assert.equal(again.statusCode, 200);
    assert.equal((await listUserRecords(store)).filter((r) => r.email === 'second@example.com').length, 1);
    // once promoted, the stored owner counts toward min_owners even if the env row is later removed
    const { wouldBreachMinOwners } = await import('../../packages/core/server/lib/membership/write.js');
    assert.equal(
      await wouldBreachMinOwners(store, { exceptPersonId: 'usr_none', envOwnerCount: 0, minOwners: 1 }),
      false
    );
    const events = [...store.map.keys()]
      .filter((k) => k.startsWith(PREFIXES.audit))
      .map((k) => JSON.parse(store.map.get(k)!).action);
    assert.ok(events.includes('membership.promote_bootstrap'));
  });
});

test('list returns v2 rows (person_id, membership_status, membership_source) and hides removed by default', async () => {
  await withHandlerStore({ ADMIN_EMAILS: 'boot@example.com' }, async (store) => {
    await putUserRecord(store, { ...activeOwner('v@example.com'), role: 'viewer' });
    await saveMember(
      store,
      newMember({
        email: 'r@example.com',
        display_name: 'Removed',
        role: 'admin',
        status: 'removed',
        source: 'invitation',
        granted_by: { kind: 'human', email: 'boot@example.com' },
        invited_by: 'boot@example.com',
        at: AT,
      })
    );
    const res = await handler(post('list'), contextFor('boot@example.com'));
    const users = JSON.parse(res.body).users as Array<Record<string, unknown>>;
    assert.deepEqual(
      users.map((u) => u.email),
      ['boot@example.com', 'v@example.com']
    );
    const v = users.find((u) => u.email === 'v@example.com')!;
    assert.equal(v.person_id, personIdForEmail('v@example.com'));
    assert.equal(v.membership_status, 'active');
    assert.equal(v.membership_source, 'invitation');
    assert.equal(v.role, 'viewer');
    const all = JSON.parse(
      (await handler(post('list', { include_removed: true }), contextFor('boot@example.com'))).body
    ).users;
    assert.deepEqual(
      all.map((u: { email: string }) => u.email),
      ['boot@example.com', 'r@example.com', 'v@example.com']
    );
  });
});

test('me / accept / update_me stamp Person.onboarding steps', async () => {
  await withHandlerStore({}, async (store) => {
    await putUserRecord(store, { ...activeOwner('new@example.com'), role: 'admin', status: 'invited' });
    const acc = await handler(
      post('accept', { display_name: 'New Person' }),
      contextFor('new@example.com', 'gotrue-new')
    );
    assert.equal(acc.statusCode, 200);
    let member = await getMembershipByEmail(store, 'new@example.com');
    assert.ok(member?.person.onboarding.steps.password);
    assert.ok(member?.person.onboarding.steps.name);
    assert.equal(member?.person.identity.user_id, 'gotrue-new');
    assert.ok(store.map.has(KEYS.byIdentity('gotrue-new')));
    const upd = await handler(
      post('update_me', { display_name: 'Renamed' }),
      contextFor('new@example.com', 'gotrue-new')
    );
    assert.equal(upd.statusCode, 200);
    member = await getMembershipByEmail(store, 'new@example.com');
    assert.equal(member?.person.display_name, 'Renamed');
    const events = [...store.map.keys()]
      .filter((k) => k.startsWith(PREFIXES.audit))
      .map((k) => JSON.parse(store.map.get(k)!).action);
    // no Invitation object existed for this v1-style invited record → the accept is a plain activation (T18.2)
    assert.ok(events.includes('membership.activate'));
    assert.ok(events.includes('person.update_profile'));
  });
});
