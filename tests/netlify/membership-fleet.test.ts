/**
 * W18 T18.7 — fleet parity: the committed membership-policy provider seam,
 * the cross-site person seam (`listMembershipsForPerson`), the internal-only
 * `membership_status` tool, and the probe's repo-side membership checks.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import {
  DEFAULT_MEMBERSHIP_POLICY,
  activeMembershipPolicyBase,
  setActiveMembershipPolicyProvider,
} from '../../packages/core/lib/membership-policy.js';
import { membershipPolicyConfig } from '../../sites/drlurie/config/membership-policy.js';
import { listMembershipsForPerson } from '../../packages/core/server/lib/membership/fleet.js';
import { getMembershipStatus } from '../../packages/core/server/lib/membership/status.js';
import { personIdForEmail, type MembershipStore } from '../../packages/core/server/lib/membership/store.js';
import { getPolicy, newMember, saveMember, setPolicy } from '../../packages/core/server/lib/membership/write.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { membershipRepoChecks, FLEET_SITES } from '../../scripts/fleet-capability-probe.mjs';

const AT = '2026-08-17T10:00:00.000Z';

const memStore = (): MembershipStore & { map: Map<string, string> } => {
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
  } as MembershipStore & { map: Map<string, string> };
};

const owner = (email: string) =>
  newMember({
    email,
    display_name: email,
    role: 'owner',
    status: 'active',
    source: 'invitation',
    granted_by: { kind: 'human', email: 'boss@example.com' },
    invited_by: 'boss@example.com',
    at: AT,
  });

const withMcpStore = async (store: MembershipStore, fn: () => Promise<void>) => {
  const saved = { NETLIFY: process.env.NETLIFY, NETLIFY_SITE_ID: process.env.NETLIFY_SITE_ID };
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return store as never;
    },
  });
  try {
    await fn();
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

// ── 1. the committed policy provider seam ────────────────────────────────

test('the site’s committed membership-policy override is registered by policy-bindings and layers under the store', async () => {
  // drlurie’s stub is empty → base === defaults
  assert.deepEqual(membershipPolicyConfig, {});
  assert.deepEqual(activeMembershipPolicyBase(), DEFAULT_MEMBERSHIP_POLICY);

  try {
    setActiveMembershipPolicyProvider(() => ({ min_owners: 2, invite_ttl_hours: 24 }));
    const base = activeMembershipPolicyBase();
    assert.equal(base.min_owners, 2);
    assert.equal(base.invite_ttl_hours, 24);
    assert.equal(base.max_resends, DEFAULT_MEMBERSHIP_POLICY.max_resends);

    // store override wins over the committed override, which wins over the default
    const store = memStore();
    assert.equal((await getPolicy(store)).min_owners, 2);
    await setPolicy(store, { min_owners: 3 });
    const effective = await getPolicy(store);
    assert.equal(effective.min_owners, 3);
    assert.equal(effective.invite_ttl_hours, 24);
  } finally {
    setActiveMembershipPolicyProvider(() => membershipPolicyConfig);
  }
});

// ── 2. the cross-site person seam ────────────────────────────────────────

test('listMembershipsForPerson: the deterministic person_id finds the same human across tenant stores, reports unreachable stores, skips sites without a membership', async () => {
  const wolf = 'wolf@example.com';
  const pid = personIdForEmail(wolf);

  const drlurie = memStore();
  const platform = memStore();
  const fernwell = memStore(); // no membership for wolf here
  await saveMember(drlurie, owner(wolf));
  await saveMember(platform, owner(wolf));
  await saveMember(fernwell, owner('someone-else@example.com'));

  const broken: MembershipStore = {
    async get() {
      throw new Error('blob store unreachable');
    },
    async setJSON() {},
    async list() {
      return { blobs: [] };
    },
  } as MembershipStore;

  const listing = await listMembershipsForPerson(
    [
      { site_id: 'site_drlurie', store: drlurie },
      { site_id: 'site_platform', store: platform },
      { site_id: 'site_fernwell', store: fernwell },
      { site_id: 'site_zilberman', store: broken },
    ],
    pid
  );

  assert.equal(listing.person_id, pid);
  assert.deepEqual(
    listing.memberships.map((m) => [m.site_id, m.membership.role, m.person?.email]),
    [
      ['site_drlurie', 'owner', wolf],
      ['site_platform', 'owner', wolf],
    ]
  );
  assert.deepEqual(listing.errors, [{ site_id: 'site_zilberman', error: 'blob store unreachable' }]);

  // and a stranger resolves to nothing, without error
  const nobody = await listMembershipsForPerson(
    [{ site_id: 'site_drlurie', store: drlurie }],
    personIdForEmail('nobody@x.io')
  );
  assert.deepEqual(nobody.memberships, []);
  assert.deepEqual(nobody.errors, []);
});

// ── 3. membership_status (internal-only, non-secret) ─────────────────────

test('getMembershipStatus reports reachability + policy provenance, names only', async () => {
  const store = memStore();
  await saveMember(store, owner('owner@example.com'));
  await withMcpStore(store, async () => {
    const before = await getMembershipStatus({});
    assert.equal(before.users_store, 'reachable');
    assert.equal(before.policy.source, 'default');
    assert.deepEqual(before.policy.store_override_keys, []);
    assert.equal(before.policy.effective.min_owners, 1);

    await setPolicy(store, { min_owners: 2, who_can_invite: 'owner' });
    const after = await getMembershipStatus({});
    assert.equal(after.policy.source, 'store_override');
    assert.deepEqual(after.policy.store_override_keys, ['min_owners', 'who_can_invite']);
    assert.equal(after.policy.effective.min_owners, 2);
    assert.equal(after.policy.effective.who_can_invite, 'owner');
    // nothing member-shaped leaks
    assert.ok(!JSON.stringify(after).includes('owner@example.com'));
  });
});

test('membership_status is callable over /mcp but never advertised in tools/list', async () => {
  const store = memStore();
  await withMcpStore(store, async () => {
    const list = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    const tools = (JSON.parse(list.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
    assert.ok(!tools.some((t) => t.name === 'membership_status'), 'membership_status must be INTERNAL_ONLY');

    const call = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'membership_status', arguments: {} },
      }),
    });
    const result = (
      JSON.parse(call.body) as { result: { isError?: boolean; structuredContent: Record<string, unknown> } }
    ).result;
    assert.notEqual(result.isError, true);
    assert.deepEqual(Object.keys(result.structuredContent).sort(), ['policy', 'site_id', 'users_store']);
    assert.equal(result.structuredContent.users_store, 'reachable');
  });
});

// ── 4. the probe’s repo-side membership checks, every tenant ─────────────

test('fleet-capability-probe: every FLEET_SITES tenant passes the repo-side membership checks (sweep declared, templates, committed policy override registered)', () => {
  assert.deepEqual(
    FLEET_SITES.map((s: { slug: string }) => s.slug),
    ['drlurie', 'platform', 'fernwell', 'zilberman']
  );
  for (const { slug } of FLEET_SITES as Array<{ slug: string }>) {
    const checks = membershipRepoChecks(slug) as Record<string, string>;
    for (const [name, outcome] of Object.entries(checks)) {
      assert.match(outcome, /^ok/, `${slug}: membership/${name}: ${outcome}`);
    }
  }
});
