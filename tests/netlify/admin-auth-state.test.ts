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

// T0.1 — this is one of the shell trio the perf investigation targets: the
// header must be present on every response shape (200 here, 401/405
// elsewhere), name all four metrics, and carry a real (non-negative,
// finite) `auth;dur=` — proving `timeAuth`'s wrap around
// `resolveAdminAccessFromEvent` actually measured something rather than
// silently no-op'ing outside a `withServerTiming`-wrapped invocation.
test('admin-auth-state carries a Server-Timing header with cold/auth/work/serialize', async () => {
  const response = await handler({ httpMethod: 'GET' }, contextFor('someone@example.com'));
  const header = response.headers['Server-Timing'];
  assert.ok(header, 'Server-Timing header must be present');
  for (const metric of ['cold', 'auth', 'work', 'serialize']) {
    assert.match(header, new RegExp(`${metric};dur=\\d+(\\.\\d+)?`), `missing ${metric} metric in "${header}"`);
  }
  const authDur = Number(header.match(/auth;dur=([\d.]+)/)?.[1]);
  assert.ok(Number.isFinite(authDur) && authDur >= 0, `auth;dur must be a real, non-negative number, got ${authDur}`);
});

test('admin-auth-state Server-Timing survives a 405 (Method Not Allowed)', async () => {
  const response = await handler({ httpMethod: 'DELETE' });
  assert.equal(response.statusCode, 405);
  assert.ok(response.headers['Server-Timing'], 'Server-Timing header must survive a non-200 response');
});

// ─── T-shell: `admin-shell`, the coalesced shell call ────────────────────────
//
// This lives here, next to the endpoint whose payload it re-serves, because
// `admin-shell` IS `admin-auth-state` plus two more sections resolved off the
// SAME auth: the `access` section is this file's subject, and the contract
// worth pinning is that adding the other two changed nothing about it.
//
// Why the coalescing exists at all, in one line: `Server-Timing` measured this
// endpoint doing 0.02 ms of server work for 242-683 ms on the wire, so the
// admin's per-click floor was three round trips' fixed per-invocation
// overhead, not three slow functions.
//
// These use the injected-blobs seam (`admin-users-cold-start.test.ts`'s
// pattern) rather than this file's on-disk local-blobs root, because two of
// the four cases are about a store FAILING, and a store that fails on demand
// is the only way to prove per-section degradation.
import { handler as adminShellHandler } from '../../netlify/functions/admin-shell.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

/** One in-memory blob store per store NAME, with a read counter and an optional detonator. */
const shellStores = () => {
  const maps = new Map<string, Map<string, string>>();
  const reads = new Map<string, number>();
  const broken = new Set<string>();
  const storeFor = (name: string) => {
    const map = maps.get(name) ?? new Map<string, string>();
    maps.set(name, map);
    return {
      async get(key: string) {
        if (broken.has(name)) throw new Error(`store ${name} is unavailable`);
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return map.get(key) ?? null;
      },
      async setJSON(key: string, value: unknown) {
        if (broken.has(name)) throw new Error(`store ${name} is unavailable`);
        map.set(key, JSON.stringify(value));
      },
      async set(key: string, value: string) {
        if (broken.has(name)) throw new Error(`store ${name} is unavailable`);
        map.set(key, value);
      },
      async list({ prefix }: { prefix: string }) {
        if (broken.has(name)) throw new Error(`store ${name} is unavailable`);
        return { blobs: [...map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
      },
      async delete(key: string) {
        map.delete(key);
      },
    };
  };
  return {
    reads,
    broken,
    module: {
      connectLambda() {},
      getStore(nameOrConfig: string | { name: string }) {
        return storeFor(typeof nameOrConfig === 'string' ? nameOrConfig : nameOrConfig.name) as never;
      },
    },
  };
};

const withShellStores = async (
  env: Partial<Record<(typeof ENV_KEYS)[number], string>>,
  fn: (stores: ReturnType<typeof shellStores>) => Promise<void>
) => {
  const stores = shellStores();
  const savedEnv = [...ENV_KEYS, 'NETLIFY', 'NETLIFY_SITE_ID'].map((key) => [key, process.env[key]] as const);
  for (const key of ENV_KEYS) delete process.env[key];
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
  process.env.NETLIFY = 'true';
  delete process.env.NETLIFY_SITE_ID;
  setNetlifyBlobsModuleForTesting(stores.module);
  try {
    await fn(stores);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [key, value] of savedEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const shellPost = { httpMethod: 'POST', body: JSON.stringify({ requests: { limit: 25 } }) };

test('admin-shell answers all three shell sections in one response', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async () => {
    const response = await adminShellHandler(shellPost, contextFor('boss@example.com'));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    // `access` is `admin-auth-state`'s payload, unchanged.
    assert.equal(body.sections.access.status, 'ok');
    assert.equal(body.sections.access.data.authenticated, true);
    assert.equal(body.sections.access.data.isAdmin, true);
    assert.equal(body.sections.access.data.tier, 'owner');
    assert.deepEqual(body.sections.access.data.roles, ['owner', 'admin', 'publisher']);

    // `requests` is `admin-requests {action:'list'}`'s body — plus the `ETag`
    // the dedicated endpoint would have put in the header, so the store's
    // conditional-poll protocol survives a coalesced first load.
    assert.equal(body.sections.requests.status, 'ok');
    assert.deepEqual(body.sections.requests.data.requests, []);
    assert.equal(typeof body.sections.requests.data.seq, 'number');
    assert.match(body.sections.requests.data.etag, /^"[0-9a-f]{40}"$/);

    // `me` is `admin-users {verb:'me'}`'s body, whole membership policy included.
    assert.equal(body.sections.me.status, 'ok');
    assert.equal(body.sections.me.data.user.email, 'boss@example.com');
    assert.equal(body.sections.me.data.user.role, 'owner');
    assert.equal(typeof body.sections.me.data.policy.require_display_name, 'boolean');
    assert.equal(body.sections.me.data.policy.who_can_invite, 'owner_admin');
  });
});

/**
 * The point of the whole function: the caller's tier is resolved ONCE and
 * shared, rather than re-resolved by each of the three endpoints.
 *
 * Asserted by counting reads of the USERS store, which is the store a tier
 * resolution goes to. `admin-auth-state` + `admin-users{me}` fired separately
 * resolve it twice (and `admin-requests` a third time, off a store this stub
 * counts under the same name); the shell must come in under their sum.
 */
test('admin-shell resolves the caller tier once and shares it across sections', async () => {
  // A ROLE_EMAILS_* principal, deliberately, not a bootstrap Owner: an
  // `ADMIN_EMAILS` caller short-circuits `resolveRolesForPrincipalAsync`
  // before it touches the store at all (roles.ts step 2, lockout-impossible),
  // so it could not tell one store-backed resolution from three.
  //
  // Each side also starts from a VIRGIN store set: a first `me` can
  // materialise a record, and measuring both paths against one store would
  // only prove that whichever ran second had less to do.
  const env = { ROLE_EMAILS_ADMIN: 'ed@example.com' } as const;
  let coalescedUserReads = 0;
  await withShellStores(env, async (stores) => {
    await adminShellHandler(shellPost, contextFor('ed@example.com'));
    coalescedUserReads = stores.reads.get('users') ?? 0;
  });
  assert.ok(coalescedUserReads > 0, 'the shell must actually read the users store');

  let separateUserReads = 0;
  await withShellStores(env, async (stores) => {
    const { handler: authStateHandler } = await import('../../netlify/functions/admin-auth-state.js');
    const { handler: usersHandler } = await import('../../netlify/functions/admin-users.js');
    await authStateHandler({ httpMethod: 'GET' }, contextFor('ed@example.com'));
    await usersHandler({ httpMethod: 'POST', body: JSON.stringify({ verb: 'me' }) }, contextFor('ed@example.com'));
    separateUserReads = stores.reads.get('users') ?? 0;
  });

  assert.ok(
    coalescedUserReads < separateUserReads,
    `one coalesced call read the users store ${coalescedUserReads} times; the two separate calls it ` +
      `replaces read it ${separateUserReads} times — the tier is not being resolved once and shared`
  );
});

/**
 * Degradation parity, the rule that made `allSettled` non-negotiable: with
 * three separate calls, one failing left the other two answers on screen. A
 * coalesced call that 500'd on one bad blob read would be strictly worse than
 * what it replaced.
 */
test('admin-shell degrades per section — a failed requests read leaves access and me intact', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    stores.broken.add('editorial-requests');
    const response = await adminShellHandler(shellPost, contextFor('boss@example.com'));

    assert.equal(response.statusCode, 200, 'one broken section must not fail the whole response');
    const body = JSON.parse(response.body);
    assert.equal(body.sections.requests.status, 'error');
    assert.equal(body.sections.requests.code, 'read_failed');
    assert.equal(body.sections.requests.data, undefined);
    // The store's internals never reach the wire — the client's only decision
    // is "ask the dedicated endpoint instead", which is what `code` is for.
    assert.doesNotMatch(String(body.sections.requests.error), /unavailable/);

    assert.equal(body.sections.access.status, 'ok');
    assert.equal(body.sections.access.data.isAdmin, true);
    assert.equal(body.sections.me.status, 'ok');
    assert.equal(body.sections.me.data.user.email, 'boss@example.com');
  });
});

/**
 * A signed-in caller with no admin tier: `access` still answers (the gate
 * panel is rendered from it) and the two admin-gated sections are `skipped` —
 * which is exactly what the dedicated endpoints' 403s meant, and is NOT an
 * error the client should retry against them.
 */
test('admin-shell resolves access and skips the admin-gated sections for a caller with no tier', async () => {
  await withShellStores({ ADMIN_EMAILS: 'someone-else@example.com' }, async () => {
    const response = await adminShellHandler(shellPost, contextFor('stranger@example.com'));
    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);

    assert.equal(body.sections.access.status, 'ok');
    assert.equal(body.sections.access.data.authenticated, true);
    assert.equal(body.sections.access.data.isAdmin, false);
    assert.deepEqual(body.sections.access.data.roles, ['viewer']);

    for (const section of ['requests', 'me'] as const) {
      assert.equal(body.sections[section].status, 'skipped');
      assert.equal(body.sections[section].code, 'admin_required');
    }
  });
});

test('admin-shell 401s an unauthenticated caller, like every endpoint it replaces', async () => {
  await withShellStores({}, async () => {
    const response = await adminShellHandler({ httpMethod: 'POST' });
    assert.equal(response.statusCode, 401);
    assert.equal(JSON.parse(response.body).sections, undefined);
  });
});

test('admin-shell Server-Timing survives a 405 (Method Not Allowed)', async () => {
  const response = await adminShellHandler({ httpMethod: 'DELETE' });
  assert.equal(response.statusCode, 405);
  assert.ok(response.headers['Server-Timing'], 'Server-Timing header must survive a non-200 response');
});

/**
 * The four phase metrics its siblings report, PLUS the per-section breakdown
 * that makes a coalesced call debuggable at all: without `sec.*`, "the shell
 * costs 400 ms" cannot be told from "the requests read costs 380 ms of it".
 */
test('admin-shell carries Server-Timing with the four phase metrics and a per-section breakdown', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async () => {
    const response = await adminShellHandler(shellPost, contextFor('boss@example.com'));
    const header = response.headers['Server-Timing'];
    assert.ok(header, 'Server-Timing header must be present');
    for (const metric of ['cold', 'auth', 'work', 'serialize']) {
      assert.match(header, new RegExp(`(^|, )${metric};dur=\\d+(\\.\\d+)?`), `missing ${metric} in "${header}"`);
    }
    for (const section of ['access', 'requests', 'me']) {
      assert.match(header, new RegExp(`sec\\.${section};dur=\\d+(\\.\\d+)?`), `missing sec.${section} in "${header}"`);
    }
  });
});
