/**
 * W18 T18.6a — the membership verb core and ITS GATE, adversarial first:
 * an agent principal is 403 on every verb incl. list; the shared MCP token
 * with agent_name 'owner@…' is still an agent; an OAuth principal whose
 * subject is a suspended member is 403; an OAuth admin (not owner) can list
 * and invite editor only when policy allows; every audit event carries via;
 * dry_run persists nothing; contract validates against its own schemas; the
 * chat bridge refuses a run without a captured human; the admin-users
 * function behaviour for the existing UI calls is covered by the T18.0a–T18.4
 * suites (they run unchanged against the thin function).
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { z } from 'zod';

import {
  MEMBERSHIP_VERBS,
  MEMBERSHIP_VERB_SCHEMAS,
  MEMBERSHIP_VERB_MIN_TIER,
  MEMBERSHIP_ERROR_CATALOGUE,
  buildMembershipContract,
  handleMembershipVerb,
  type MembershipPrincipal,
} from '../../packages/core/server/lib/membership/verbs.js';
import {
  callerPrincipalFromMcpEvent,
  callerPrincipalFromChatRun,
} from '../../packages/core/server/lib/membership/caller-principal.js';
import { buildToolContext } from '../../packages/core/server/lib/agent/context.js';
import {
  putUserRecord,
  listUserRecords,
  getUserRecord,
  type UsersBlobStore,
} from '../../packages/core/server/lib/users-store.js';
import { setPolicy } from '../../packages/core/server/lib/membership/write.js';
import { PREFIXES } from '../../packages/core/server/lib/membership/store.js';
import { DEFAULT_MEMBERSHIP_POLICY } from '../../packages/core/lib/membership-policy.js';
import type { ObjectVerbStore } from '../../packages/core/server/lib/object-verbs.js';

const AT = '2026-08-17T12:00:00.000Z';

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

const member = (
  email: string,
  role: 'owner' | 'admin' | 'editor' | 'viewer',
  status: 'active' | 'disabled' | 'invited' = 'active'
) => ({
  schema_version: 1 as const,
  email,
  display_name: email,
  role,
  status,
  invited_by: 'boss@x.com',
  created_at: AT,
  updated_at: AT,
  audit: [],
});

const human = (
  email: string,
  via: 'admin_ui' | 'mcp' | 'chat' = 'mcp',
  extra: Record<string, unknown> = {}
): MembershipPrincipal => ({ kind: 'human', id: `id-${email}`, email, via, ...extra }) as MembershipPrincipal;
const agent = (name = 'writer', via: 'mcp' | 'chat' = 'mcp'): MembershipPrincipal => ({
  kind: 'agent',
  agent_name: name,
  auth: 'mcp_token',
  via,
});

const audits = (store: Mem) =>
  [...store.map.keys()].filter((k) => k.startsWith(PREFIXES.audit)).map((k) => JSON.parse(store.map.get(k)!));

/** Args that pass each verb's schema, so a 403 proves the GATE fired, not validation. */
const VALID_ARGS: Record<string, Record<string, unknown>> = {
  list: {},
  get: { email: 'a@x.com' },
  audit: { email: 'a@x.com' },
  contract: {},
  policy_get: {},
  policy_set: { policy: {} },
  invite: { email: 'a@x.com', role: 'viewer' },
  resend: { email: 'a@x.com' },
  revoke: { email: 'a@x.com' },
  list_invitations: {},
  unmanaged_identities: {},
  grant: { email: 'a@x.com', role: 'viewer' },
  set_role: { email: 'a@x.com', role: 'viewer' },
  suspend: { email: 'a@x.com' },
  reinstate: { email: 'a@x.com' },
  remove: { email: 'a@x.com' },
  purge: { email: 'a@x.com', confirm: 'PURGE a@x.com' },
  transfer_ownership: { to_email: 'a@x.com' },
  promote_bootstrap: { email: 'a@x.com' },
  export: { email: 'a@x.com' },
  delete_identity: { user_id: 'u', email: 'a@x.com' },
};

// ─── the gate ─────────────────────────────────────────────────────────────────

test('GATE: an agent principal is 403 membership_requires_human on EVERY verb (incl. list/contract), before any store read', async () => {
  for (const verb of MEMBERSHIP_VERBS) {
    let reads = 0;
    const store = memStore();
    const spied = {
      ...store,
      get: async (k: string) => (reads++, store.get(k)),
      list: async (o: { prefix: string }) => (reads++, store.list(o)),
    };
    for (const p of [agent('writer'), agent('owner@x.com'), agent('boss@example.com', 'chat')]) {
      const res = await handleMembershipVerb({
        verb,
        args: VALID_ARGS[verb],
        principal: p,
        deps: { store: spied, env: { ADMIN_EMAILS: 'owner@x.com, boss@example.com' } },
      });
      assert.equal(res.status, 403, `${verb} / ${p.kind === 'agent' ? p.agent_name : ''}`);
      assert.equal(res.body.error_code, 'membership_requires_human');
    }
    assert.equal(reads, 0, `${verb}: no store read before the gate`);
    assert.equal(store.map.size, 0, `${verb}: nothing written`);
  }
  // an unknown verb from an agent is STILL the gate, not unknown_verb
  const res = await handleMembershipVerb({ verb: 'nuke', args: {}, principal: agent(), deps: { store: memStore() } });
  assert.equal(res.body.error_code, 'membership_requires_human');
});

test('GATE: the MCP caller-principal builder never mints a human from the shared token or agent_name; only an OAuth-bound human does', () => {
  assert.equal(callerPrincipalFromMcpEvent({}, 'owner@x.com').kind, 'agent');
  assert.equal(callerPrincipalFromMcpEvent({ verifiedAgentName: 'boss@example.com' }, undefined).kind, 'agent');
  const oauth = callerPrincipalFromMcpEvent({
    oauthPrincipal: { subject_email: 'Owner@X.com', subject_id: 'gotrue-1', client_id: 'claude' },
    requestId: 'r1',
  });
  assert.deepEqual(oauth, {
    kind: 'human',
    id: 'gotrue-1',
    email: 'Owner@X.com',
    via: 'mcp',
    client_id: 'claude',
    request_id: 'r1',
  });
  // a malformed OAuth principal (no subject id) is not a human
  assert.equal(
    callerPrincipalFromMcpEvent({ oauthPrincipal: { subject_email: 'x@x.com', subject_id: '', client_id: 'c' } }).kind,
    'agent'
  );
  // chat: only the run's captured human
  assert.equal(callerPrincipalFromChatRun(undefined).kind, 'agent');
  assert.equal(callerPrincipalFromChatRun({ kind: 'agent', agent_name: 'w', auth: 'mcp_token' }).kind, 'agent');
  assert.deepEqual(callerPrincipalFromChatRun({ kind: 'human', id: 'h1', email: 'h@x.com' }), {
    kind: 'human',
    id: 'h1',
    email: 'h@x.com',
    via: 'chat',
  });
});

test('GATE: an OAuth human whose membership is suspended (or removed, or absent) is 403 admin_required — even for list', async () => {
  const store = memStore();
  await putUserRecord(store, member('sus@x.com', 'owner', 'disabled'));
  const sus = await handleMembershipVerb({
    verb: 'list',
    args: {},
    principal: human('sus@x.com'),
    deps: { store, env: {} },
  });
  assert.equal(sus.status, 403);
  assert.equal(sus.body.error_code, 'admin_required');
  const nobody = await handleMembershipVerb({
    verb: 'list',
    args: {},
    principal: human('nobody@x.com'),
    deps: { store, env: {} },
  });
  assert.equal(nobody.body.error_code, 'admin_required');
  await putUserRecord(store, member('view@x.com', 'viewer'));
  assert.equal(
    (await handleMembershipVerb({ verb: 'list', args: {}, principal: human('view@x.com'), deps: { store, env: {} } }))
      .body.error_code,
    'admin_required'
  );
  // an env Owner over an empty store is fine
  assert.equal(
    (
      await handleMembershipVerb({
        verb: 'list',
        args: {},
        principal: human('boot@x.com'),
        deps: { store, env: { ADMIN_EMAILS: 'boot@x.com' } },
      })
    ).status,
    200
  );
});

test('TIER: an OAuth admin (not owner) can list/get/contract/policy_get and invite editor|viewer under the default policy; every Owner verb is 403 owner_required; policy owner-only → invite_forbidden', async () => {
  const store = memStore();
  await putUserRecord(store, member('adm@x.com', 'admin'));
  await putUserRecord(store, member('e@x.com', 'editor'));
  const adm = human('adm@x.com', 'mcp', { client_id: 'claude' });
  assert.equal(
    (await handleMembershipVerb({ verb: 'list', args: {}, principal: adm, deps: { store, env: {} } })).status,
    200
  );
  assert.equal(
    (await handleMembershipVerb({ verb: 'get', args: { email: 'e@x.com' }, principal: adm, deps: { store, env: {} } }))
      .status,
    200
  );
  assert.equal(
    (await handleMembershipVerb({ verb: 'contract', args: {}, principal: adm, deps: { store, env: {} } })).status,
    200
  );
  assert.equal(
    (await handleMembershipVerb({ verb: 'policy_get', args: {}, principal: adm, deps: { store, env: {} } })).status,
    200
  );
  const inv = await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'new@x.com', role: 'editor' },
    principal: adm,
    deps: { store, env: {} },
  });
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  const noAdmin = await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'new2@x.com', role: 'admin' },
    principal: adm,
    deps: { store, env: {} },
  });
  assert.equal(noAdmin.body.error_code, 'role_not_grantable');
  for (const verb of MEMBERSHIP_VERBS.filter((v) => MEMBERSHIP_VERB_MIN_TIER[v] === 'owner')) {
    const res = await handleMembershipVerb({ verb, args: VALID_ARGS[verb], principal: adm, deps: { store, env: {} } });
    assert.equal(res.status, 403, verb);
    assert.equal(res.body.error_code, 'owner_required', verb);
  }
  await setPolicy(store, { who_can_invite: 'owner' });
  const forbidden = await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'new3@x.com', role: 'viewer' },
    principal: adm,
    deps: { store, env: {} },
  });
  assert.equal(forbidden.body.error_code, 'invite_forbidden');
  // aliases still work for the UI (disable → suspend, member_audit → audit, export_person → export) — owner-only
  await putUserRecord(store, member('own@x.com', 'owner'));
  const own = human('own@x.com', 'admin_ui');
  assert.equal(
    (
      await handleMembershipVerb({
        verb: 'disable',
        args: { email: 'e@x.com' },
        principal: own,
        deps: { store, env: {} },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await handleMembershipVerb({
        verb: 'member_audit',
        args: { email: 'e@x.com' },
        principal: own,
        deps: { store, env: {} },
      })
    ).status,
    200
  );
  assert.equal(
    (
      await handleMembershipVerb({
        verb: 'export_person',
        args: { email: 'e@x.com' },
        principal: own,
        deps: { store, env: {} },
      })
    ).status,
    200
  );
});

// ─── audit + dry run + contract ───────────────────────────────────────────────

test('every mutation lands an AuditEvent carrying via, the human actor and request_id; a chat principal writes via:chat', async () => {
  const store = memStore();
  await putUserRecord(store, member('own@x.com', 'owner'));
  await putUserRecord(store, member('e@x.com', 'editor'));
  const own = human('own@x.com', 'mcp', { client_id: 'claude', request_id: 'req-9' });
  await handleMembershipVerb({
    verb: 'set_role',
    args: { email: 'e@x.com', role: 'publisher' },
    principal: own,
    deps: { store, env: {} },
  });
  await handleMembershipVerb({
    verb: 'suspend',
    args: { email: 'e@x.com', reason: 'test' },
    principal: own,
    deps: { store, env: {} },
  });
  await handleMembershipVerb({
    verb: 'reinstate',
    args: { email: 'e@x.com' },
    principal: human('own@x.com', 'chat'),
    deps: { store, env: {} },
  });
  await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'n@x.com', role: 'viewer' },
    principal: human('own@x.com', 'admin_ui'),
    deps: { store, env: {} },
  });
  const events = audits(store);
  assert.ok(events.length >= 4);
  for (const e of events) {
    assert.ok(['admin_ui', 'mcp', 'chat', 'system'].includes(e.via), e.via);
    if (e.actor.kind === 'human') assert.equal(e.actor.email, 'own@x.com');
  }
  const roleChange = events.find((e) => e.action === 'membership.role_change');
  assert.equal(roleChange.via, 'mcp');
  assert.equal(roleChange.request_id, 'req-9');
  assert.equal(events.find((e) => e.action === 'membership.reinstate').via, 'chat');
  assert.equal(events.find((e) => e.action === 'invitation.create').via, 'admin_ui');
});

test('dry_run on invite / set_role / remove / transfer_ownership returns the would-be effect and persists NOTHING', async () => {
  const store = memStore();
  await putUserRecord(store, member('own@x.com', 'owner'));
  await putUserRecord(store, member('e@x.com', 'editor'));
  await putUserRecord(store, member('heir@x.com', 'admin'));
  const own = human('own@x.com');
  const before = new Map(store.map);
  const inv = await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'new@x.com', role: 'viewer', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.deepEqual(
    { status: inv.status, would: inv.body.would, dry: inv.body.dry_run },
    { status: 200, would: 'invite', dry: true }
  );
  const role = await handleMembershipVerb({
    verb: 'set_role',
    args: { email: 'e@x.com', role: 'admin', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.deepEqual(
    { would: role.body.would, from: role.body.from, to: role.body.to },
    { would: 'change_role', from: 'editor', to: 'admin' }
  );
  const rem = await handleMembershipVerb({
    verb: 'remove',
    args: { email: 'e@x.com', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.equal(rem.body.would, 'remove');
  assert.equal(rem.body.identity_delete_would, 'queue');
  const tr = await handleMembershipVerb({
    verb: 'transfer_ownership',
    args: { to_email: 'heir@x.com', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.equal(tr.body.would, 'transfer');
  assert.equal(tr.body.from_role_after, 'admin');
  assert.deepEqual([...store.map.entries()], [...before.entries()], 'store byte-identical after dry runs');
  assert.equal((await getUserRecord(store, 'e@x.com'))?.role, 'editor');
  assert.equal((await listUserRecords(store)).length, 3);
  // dry_run also runs the guards: last_owner blocks a dry-run demotion of the only owner
  await setPolicy(store, { min_owners: 2 });
  const guard = await handleMembershipVerb({
    verb: 'set_role',
    args: { email: 'heir@x.com', role: 'viewer', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.equal(guard.status, 200); // heir is admin, not owner → fine
  await putUserRecord(store, member('o2@x.com', 'owner'));
  const guard2 = await handleMembershipVerb({
    verb: 'set_role',
    args: { email: 'o2@x.com', role: 'viewer', dry_run: true },
    principal: own,
    deps: { store, env: {} },
  });
  assert.equal(guard2.body.error_code, 'last_owner');
});

test('contract: every verb listed with min tier + JSON-schema args that validate their own VALID_ARGS; error catalogue complete; gate stated', async () => {
  const contract = buildMembershipContract(DEFAULT_MEMBERSHIP_POLICY);
  assert.equal(contract.gate.rule, 'membership_requires_human');
  assert.deepEqual(contract.roles.tiers, ['owner', 'admin', 'publisher', 'editor', 'viewer']);
  assert.equal(contract.verbs.length, MEMBERSHIP_VERBS.length);
  for (const v of contract.verbs) {
    assert.equal(v.min_tier, MEMBERSHIP_VERB_MIN_TIER[v.verb]);
    assert.equal((v.args as { type?: string }).type, 'object', v.verb);
    // the zod schema behind the contract accepts the sample args
    const parsed = (MEMBERSHIP_VERB_SCHEMAS[v.verb] as z.ZodTypeAny).safeParse(VALID_ARGS[v.verb]);
    assert.ok(parsed.success, v.verb);
  }
  for (const code of [
    'membership_requires_human',
    'last_owner',
    'env_managed_member',
    'invite_pending_exists',
    'invite_expired',
    'invite_revoked',
    'identity_admin_unavailable',
    'resend_cap',
    'domain_not_allowed',
    'role_not_grantable',
    'invite_forbidden',
    'confirm_mismatch',
  ]) {
    assert.ok(MEMBERSHIP_ERROR_CATALOGUE[code], code);
  }
  assert.deepEqual(contract.aliases, { disable: 'suspend', member_audit: 'audit', export_person: 'export' });
  // and it is served through the verb (admin tier)
  const store = memStore();
  await putUserRecord(store, member('adm@x.com', 'admin'));
  const served = await handleMembershipVerb({
    verb: 'contract',
    args: {},
    principal: human('adm@x.com'),
    deps: { store, env: {} },
  });
  assert.equal(served.status, 200);
  assert.equal((served.body.contract as { schema_version: number }).schema_version, 1);
  // bad args → 400 invalid_args with issues, never a 500
  const bad = await handleMembershipVerb({
    verb: 'invite',
    args: { email: 'x' },
    principal: human('adm@x.com'),
    deps: { store, env: {} },
  });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error_code, 'invalid_args');
  const unknown = await handleMembershipVerb({
    verb: 'frobnicate',
    args: {},
    principal: human('adm@x.com'),
    deps: { store, env: {} },
  });
  assert.equal(unknown.body.error_code, 'unknown_verb');
});

// ─── chat bridge ──────────────────────────────────────────────────────────────

test('chat ToolContext.membership routes through the core with the run’s HUMAN principal (via:chat); a run without a captured human is refused by the gate; no membershipStore → no bridge', async () => {
  const users = memStore();
  await putUserRecord(users, member('own@x.com', 'owner'));
  const objects = memStore();
  const ctxHuman = buildToolContext({
    objectStore: objects as unknown as ObjectVerbStore,
    principal: { kind: 'human', id: 'h1', email: 'own@x.com' },
    roles: ['owner', 'admin', 'publisher'],
    membershipStore: users as unknown as UsersBlobStore,
  });
  assert.ok(ctxHuman.membership);
  const listed = await ctxHuman.membership!.call('list', {});
  assert.equal(listed.status, 200);
  const invited = await ctxHuman.membership!.call('invite', { email: 'chat@x.com', role: 'viewer' });
  assert.equal(invited.status, 200);
  assert.equal(audits(users).find((e) => e.action === 'invitation.create').via, 'chat');

  const ctxAgent = buildToolContext({
    objectStore: objects as unknown as ObjectVerbStore,
    principal: { kind: 'agent', agent_name: 'writer', auth: 'mcp_token' },
    roles: [],
    membershipStore: users as unknown as UsersBlobStore,
  });
  const refused = await ctxAgent.membership!.call('list', {});
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error_code, 'membership_requires_human');

  const ctxNone = buildToolContext({
    objectStore: objects as unknown as ObjectVerbStore,
    principal: { kind: 'human', id: 'h', email: 'own@x.com' },
    roles: [],
  });
  assert.equal(ctxNone.membership, undefined);
});
