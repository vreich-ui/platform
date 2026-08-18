import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { handler } from '../../netlify/functions/admin-auth-state.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

// Isolated on-disk fallback store (mcp-agent-keys-auth.test.ts pattern) — the
// 2026-08-18 default-membership follow-up makes this file WRITE to the users
// store for the first time (ensureDefaultMembershipOnLogin), so it can no
// longer share the process-default local-blobs root with any other test file.
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-auth-state');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

test.after(async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});

const ENV_KEYS = ['ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR', 'ADMIN_EMAILS'] as const;
const withRoleEnv = async (env: Partial<Record<(typeof ENV_KEYS)[number], string>>, fn: () => Promise<void>) => {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const contextFor = (email: string) => ({ clientContext: { user: { sub: 'user-1', email } } });

test('admin-auth-state reports the resolved roles for an authenticated identity (T1.4/T1.5)', async () => {
  await withRoleEnv({ ROLE_EMAILS_ADMIN: 'admin@example.com', ROLE_EMAILS_EDITOR: 'admin@example.com' }, async () => {
    const response = await handler({ httpMethod: 'GET' }, contextFor('admin@example.com'));
    const body = JSON.parse(response.body);
    assert.equal(body.authenticated, true);
    assert.deepEqual(body.roles, ['admin', 'editor']);
  });
});

// Wolf 2026-08-18: a signed-in identity nobody configured anywhere used to
// resolve to `roles: []` forever (F9's "becomes… nothing") and sit on the
// /admin gate's dead-end "Access restricted" panel with no way out.
// admin-auth-state.ts now defaults exactly this case to
// policy.default_role_for_external ('viewer' — read-only) the first time
// it's checked, so the person gets a real, visible tier. `isAdmin` must stay
// false: 'viewer' can never bypass the gate on its own.
test('admin-auth-state defaults a truly unassigned identity to a viewer membership, once', async () => {
  await withRoleEnv({ ADMIN_EMAILS: 'someone-else@example.com' }, async () => {
    const first = JSON.parse((await handler({ httpMethod: 'GET' }, contextFor('stranger@example.com'))).body);
    assert.equal(first.authenticated, true);
    assert.deepEqual(first.roles, ['viewer']);
    assert.equal(first.isAdmin, false);
    assert.equal(first.tier, null);

    // Idempotent: the second check finds the now-stored membership and must
    // not create a second one, escalate the role, or otherwise change it.
    const second = JSON.parse((await handler({ httpMethod: 'GET' }, contextFor('stranger@example.com'))).body);
    assert.deepEqual(second.roles, ['viewer']);
    assert.equal(second.isAdmin, false);
  });
});

// Regression guard for the defaulting logic above: it must never fire for
// (and so never shadow) a bootstrap Owner or a ROLE_EMAILS_* principal — both
// already resolve a non-empty role from env alone, with no stored record,
// by design (F10/F7). A stored 'viewer' row for either would be read on
// every future request ahead of nothing (bootstrap Owner) or would never be
// reached (store precedence beats env for a genuinely stored record), so
// this asserts the roles these principals resolve to are untouched.
test('admin-auth-state never defaults a bootstrap Owner or an env-role principal to viewer', async () => {
  await withRoleEnv({ ADMIN_EMAILS: 'owner@example.com', ROLE_EMAILS_PUBLISHER: 'pub@example.com' }, async () => {
    const owner = JSON.parse((await handler({ httpMethod: 'GET' }, contextFor('owner@example.com'))).body);
    assert.deepEqual(owner.roles, ['owner', 'admin', 'publisher']);
    assert.equal(owner.isAdmin, true);

    const publisher = JSON.parse((await handler({ httpMethod: 'GET' }, contextFor('pub@example.com'))).body);
    assert.deepEqual(publisher.roles, ['publisher']);
    assert.equal(publisher.isAdmin, false);
  });
});

test('admin-auth-state reports no roles when unauthenticated', async () => {
  const response = await handler({ httpMethod: 'GET' });
  const body = JSON.parse(response.body);
  assert.equal(body.authenticated, false);
  assert.deepEqual(body.roles, []);
});
