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
// `admin-shell` IS `admin-auth-state` plus four more sections resolved off the
// SAME auth: the `access` section is this file's subject, and the contract
// worth pinning is that adding the others changed nothing about it. M2.1 added
// `inventory` and `release`; the function KEPT ITS NAME rather than becoming
// `admin-boot` (seven shims for a word — see its header), which is why these
// tests still spell it `admin-shell`.
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
/**
 * M2.1b: the `createHandler(binding, deps)` seam is gone with the section it
 * carried, so these tests drive the DEPLOYED shim (`adminShellHandler`, which
 * is `createHandler(drlurieSiteBinding)`) for every case — including the four
 * release ones, which seed `snapshots/release.json` into the injected store
 * rather than standing in for the read with a fake loader.
 */
import {
  RELEASE_SNAPSHOT_KEY,
  RELEASE_SNAPSHOT_MAX_AGE_MS,
  RELEASE_SNAPSHOT_SCHEMA_VERSION,
} from '../../packages/core/server/lib/release/snapshot-view.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

/**
 * One in-memory blob store per store NAME, with a read counter and three
 * detonators.
 *
 *  - `broken`   — every operation on that store throws. A store that is THERE
 *                 and failing, which is what `readInventoryRows` swallows.
 *  - `rejectOpens` — `${name}#${n}` makes the Nth `getStore(name)` throw, i.e.
 *                 the store cannot be OPENED at all. M2.1b needs this because
 *                 `inventory` and `release` each open `site-objects` for
 *                 themselves, and the two failure branches of the release
 *                 join are only separable one open at a time.
 *  - `slowGets` — `${name}#${key}` delays that one read by N ms, so a test can
 *                 make the REAL release read the slow section instead of
 *                 standing in for it with a fake loader.
 */
const shellStores = () => {
  const maps = new Map<string, Map<string, string>>();
  const reads = new Map<string, number>();
  const broken = new Set<string>();
  const rejectOpens = new Set<string>();
  const slowGets = new Map<string, number>();
  const opens = new Map<string, number>();
  const storeFor = (name: string) => {
    const map = maps.get(name) ?? new Map<string, string>();
    maps.set(name, map);
    return {
      async get(key: string) {
        if (broken.has(name)) throw new Error(`store ${name} is unavailable`);
        reads.set(name, (reads.get(name) ?? 0) + 1);
        const delayMs = slowGets.get(`${name}#${key}`);
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
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
    rejectOpens,
    slowGets,
    module: {
      connectLambda() {},
      getStore(nameOrConfig: string | { name: string }) {
        const name = typeof nameOrConfig === 'string' ? nameOrConfig : nameOrConfig.name;
        const nth = (opens.get(name) ?? 0) + 1;
        opens.set(name, nth);
        if (rejectOpens.has(`${name}#${nth}`)) throw new Error(`store ${name} could not be opened`);
        return storeFor(name) as never;
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

/**
 * A governed object record, hand-built rather than minted through the verbs:
 * `object-verbs.ts` is the write dispatcher this function deliberately does
 * not import, and the inventory read path parses records with `JSON.parse`,
 * not with zod. Enough fields for `inventoryRowFromRecord`, and no more.
 */
const objectRecord = (objectId: string, overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    schema_version: 'object-record.v1',
    site: 'drlurie',
    object_type: 'content_item',
    object_id: objectId,
    status: 'active',
    version: 3,
    content_revision: 2,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-02T00:00:00.000Z',
    body: { title: `Title for ${objectId}` },
    publication: { published_time: null },
    history: [],
    ...overrides,
  });

test('admin-shell answers all five boot sections in one response', async () => {
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

    // M2.1 — `inventory` is `object_inventory{status:'active'}`'s body, off
    // M0's read path rather than off `handleObjectVerb` (which costs this
    // bundle 1.1 MB). Empty store, so: no rows, and the diagnostics the verb
    // reports so index drift stays observable on the response.
    assert.equal(body.sections.inventory.status, 'ok');
    assert.deepEqual(body.sections.inventory.data.objects, []);
    assert.match(body.sections.inventory.data.generated_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof body.sections.inventory.data.index.trusted, 'boolean');

    // M2.1b — `release` is lit, but this store has never had a snapshot
    // written to it. `skipped`, never `error`: nothing is broken, the deploy
    // facts simply do not exist yet, and the boot refuses to invent them (it
    // must not REBUILD them either — that is an external call on a page path).
    // The client asks `admin-release-state`, whose read path does rebuild.
    assert.equal(body.sections.release.status, 'skipped');
    assert.equal(body.sections.release.code, 'release_snapshot_unavailable');
    assert.equal(body.sections.release.data, undefined);
  });
});

/**
 * M2.1 — the `inventory` section answers with the LIBRARY, not with a promise
 * of one: the same rows and the same canonical order `object_inventory`
 * returns, because it calls the verb's own `compareInventoryRows`.
 *
 * REVIEW (2026-09-16): this test used to assert the opposite of what it should
 * have — that the section filters archived rows out. It does not any more, and
 * must not. The call this section replaces is
 * `callObjectVerb({ action: 'inventory' })` with NO filters
 * (`lib/admin/library-client.ts`), archived rows included; and
 * `fetchInventoryRowsViaShell` primes the SHARED `library-client` cache
 * (memory and `sessionStorage`) with whatever the boot answered, so a narrowed
 * section removed archived objects from `ContentLibrary`, `ObjectBrowser`, the
 * Cmd-K palette and `object-type-resolve.ts` for the rest of the session. The
 * `active` filter now lives where it is actually correct — the RELEASE join,
 * which must match `readReleaseRows`.
 */
test('admin-shell inventory returns the whole library, ordered like the verb, and the release join takes only the active rows', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    const objects = stores.module.getStore('site-objects') as unknown as {
      set(key: string, value: string): Promise<void>;
    };
    await objects.set('objects/content_item/by-id/req_b.json', objectRecord('req_b'));
    await objects.set('objects/content_item/by-id/req_a.json', objectRecord('req_a'));
    await objects.set('objects/content_item/by-id/req_gone.json', objectRecord('req_gone', { status: 'archived' }));

    const response = await adminShellHandler(shellPost, contextFor('boss@example.com'));
    const { inventory } = JSON.parse(response.body).sections;
    assert.equal(inventory.status, 'ok');
    assert.deepEqual(
      inventory.data.objects.map((row: { object_id: string }) => row.object_id),
      ['req_a', 'req_b', 'req_gone'],
      "the archived row is present — this is the verb's unfiltered answer, which the client's fallback also returns"
    );
    assert.equal(inventory.data.objects[0].display_name, 'Title for req_a');
    assert.equal(inventory.data.objects[0].content_revision, 2);
    assert.equal(inventory.data.objects[0].unpublished_changes, true);
  });
});

/**
 * M2.1b — the `release` section, composed rather than loaded.
 *
 * M2.1 shipped this section behind an injected `loadRelease` and proved the
 * seam with a fake. The seam is gone: there is a real default now, and it is
 * ONE blob read (`snapshots/release.json`) joined to the rows the `inventory`
 * section has already read. These tests therefore seed the snapshot into the
 * same in-memory store they seed object records into and exercise the real
 * read path — a fake loader could no longer prove the thing that matters,
 * which is that the join costs no second inventory read.
 */
const publishedRecord = (objectId: string, commit: string) =>
  objectRecord(objectId, {
    publication: {
      published_time: '2026-09-03T00:00:00.000Z',
      publish_receipt: { content_revision: 2, commit_sha: commit },
    },
  });

/** A whole, schema-valid snapshot. `asOf` is the only thing these tests vary about time. */
const releaseSnapshot = (asOf: string, deploy: Record<string, unknown> = {}) => ({
  schema_version: RELEASE_SNAPSHOT_SCHEMA_VERSION,
  as_of: asOf,
  source: 'schedule' as const,
  deploy: {
    configured: true,
    production_confirmed: true,
    live_commit: 'commit_live',
    latest: {
      id: 'dep_1',
      commit: 'commit_live',
      status: 'ready',
      started_at: '2026-09-03T00:00:00.000Z',
      finished_at: '2026-09-03T00:02:00.000Z',
      production_url: 'https://example.netlify.app',
    },
    published: {
      id: 'dep_1',
      commit: 'commit_live',
      status: 'ready',
      started_at: '2026-09-03T00:00:00.000Z',
      finished_at: '2026-09-03T00:02:00.000Z',
      production_url: 'https://example.netlify.app',
    },
    included_commits: ['commit_live'],
    ancestry_truncated: false,
    ...deploy,
  },
  // Deliberately WRONG, and deliberately not read: the blob's own `objects`
  // are its author's answer at `as_of`, and the boot re-derives from the live
  // inventory instead. If this array ever reaches the wire, the join is
  // reading the wrong half of the snapshot.
  objects: [{
    object_id: 'stale_row',
    object_type: 'content_item',
    display_name: 'Written at as_of',
    review_state: 'none',
    approval_state: 'none',
    requires_approval: false,
    state: 'draft' as const,
  }],
  waiting_count: 99,
  pending_approval_count: 99,
});

const seedSiteObjects = (stores: ReturnType<typeof shellStores>, entries: Record<string, string>) => {
  const objects = stores.module.getStore('site-objects') as unknown as {
    set(key: string, value: string): Promise<void>;
  };
  return Promise.all(Object.entries(entries).map(([key, value]) => objects.set(key, value)));
};

test('admin-shell composes the release section from one blob read plus the inventory rows it already has', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    await seedSiteObjects(stores, {
      // `req_live` was exported at the commit production is serving; `req_late`
      // at one that is not included. Only the deploy facts in the snapshot can
      // tell those two apart — which is the whole reason the section needs a
      // snapshot at all rather than deriving itself from the rows.
      'objects/content_item/by-id/req_live.json': publishedRecord('req_live', 'commit_live'),
      'objects/content_item/by-id/req_late.json': publishedRecord('req_late', 'commit_later'),
      // REVIEW: an archived record belongs in the LIBRARY and never in the
      // release queue. `readReleaseRows` filters it out for
      // `admin-release-state`, so the boot's join must too, or the two
      // surfaces disagree about `waiting_count`.
      'objects/content_item/by-id/req_gone.json': objectRecord('req_gone', {
        status: 'archived',
        publication: {
          published_time: '2026-09-03T00:00:00.000Z',
          publish_receipt: { content_revision: 2, commit_sha: 'commit_later' },
        },
      }),
      [RELEASE_SNAPSHOT_KEY]: JSON.stringify(releaseSnapshot(new Date().toISOString())),
    });

    const body = JSON.parse((await adminShellHandler(shellPost, contextFor('boss@example.com'))).body);
    const { release, inventory } = body.sections;

    assert.equal(release.status, 'ok');
    assert.equal(release.data.deploy.configured, true);
    assert.equal(release.data.deploy.state, 'ready');
    assert.equal(release.data.deploy.live_commit, 'commit_live');
    assert.deepEqual(
      release.data.objects.map((row: { object_id: string; state: string }) => [row.object_id, row.state]),
      [['req_late', 'published'], ['req_live', 'live']],
      'the deploy facts came from the snapshot and the object facts from the live inventory'
    );
    // The snapshot's OWN `objects`/counts are its author's answer at `as_of`
    // and are not what the boot serves.
    assert.equal(release.data.waiting_count, 1);
    assert.equal(release.data.pending_approval_count, 0);

    // The join, not a second read: the release rows ARE the inventory rows —
    // the ACTIVE ones, which is exactly what `readReleaseRows` selects for
    // `admin-release-state`. The archived record is in the library and not in
    // the queue.
    assert.deepEqual(
      release.data.objects.map((row: { object_id: string }) => row.object_id),
      inventory.data.objects
        .filter((row: { status: string }) => row.status === 'active')
        .map((row: { object_id: string }) => row.object_id)
    );
    assert.ok(
      inventory.data.objects.some((row: { object_id: string }) => row.object_id === 'req_gone'),
      'the archived row is still in the library section'
    );
    assert.ok(
      !release.data.objects.some((row: { object_id: string }) => row.object_id === 'req_gone'),
      'and never in the release queue'
    );
    // And no `rows` duplicate of the library on the wire — the `inventory`
    // section is carrying it already.
    assert.equal(release.data.rows, undefined);
  });
});

/**
 * The read-cost acceptance, stated as the number it is: lighting `release` up
 * costs ONE more blob read than M2.1's four sections did, not three.
 * `loadReleaseOverview` would have cost three — the snapshot plus
 * `objects/index.json` and `objects/version` for an inventory this response
 * has already read.
 */
test('admin-shell release costs exactly one blob read on top of the inventory section', async () => {
  let withRelease = 0;
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    await seedSiteObjects(stores, {
      [RELEASE_SNAPSHOT_KEY]: JSON.stringify(releaseSnapshot(new Date().toISOString())),
    });
    stores.reads.set('site-objects', 0);
    const body = JSON.parse((await adminShellHandler(shellPost, contextFor('boss@example.com'))).body);
    assert.equal(body.sections.release.status, 'ok');
    assert.equal(body.sections.inventory.status, 'ok');
    withRelease = stores.reads.get('site-objects') ?? 0;
  });

  // M0.2's warm inventory is two reads (`objects/index.json` + `objects/version`);
  // the snapshot is the third and last thing this function asks that store for.
  assert.equal(
    withRelease,
    3,
    `the boot read site-objects ${withRelease} times — inventory (2) + the release snapshot (1) is the budget`
  );
});

/**
 * A stale snapshot is SERVED, labelled, and not rebuilt. The rebuild
 * `loadReleaseOverview` would do here is the one thing on M1's read path that
 * makes external calls, and this function runs on every navigation: a
 * `release-snapshot-refresh` outage must not convert itself into a 14 s
 * compute per click. `as_of` and `stale` are how the boot stays honest instead.
 */
test('admin-shell serves a stale release snapshot, labelled, rather than rebuilding it', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    const asOf = new Date(Date.now() - RELEASE_SNAPSHOT_MAX_AGE_MS - 60_000).toISOString();
    await seedSiteObjects(stores, {
      'objects/content_item/by-id/req_live.json': publishedRecord('req_live', 'commit_live'),
      [RELEASE_SNAPSHOT_KEY]: JSON.stringify(releaseSnapshot(asOf)),
    });

    const { release } = JSON.parse((await adminShellHandler(shellPost, contextFor('boss@example.com'))).body).sections;
    assert.equal(release.status, 'ok', 'stale facts are still facts');
    assert.equal(release.data.stale, true);
    assert.equal(release.data.as_of, asOf, 'the wire says exactly how old the deploy facts are');
    // The object half is live regardless of the snapshot's age — it came from
    // the inventory this request read.
    assert.equal(release.data.objects[0].object_id, 'req_live');

    // Nothing was written back. A boot that repaired would have replaced the
    // blob with a fresh `as_of`.
    const stored = JSON.parse(
      (await (stores.module.getStore('site-objects') as unknown as {
        get(key: string): Promise<string | null>;
      }).get(RELEASE_SNAPSHOT_KEY)) ?? 'null'
    );
    assert.equal(stored.as_of, asOf, 'the boot must never rebuild or rewrite the snapshot');
  });
});

/** A snapshot written by a schema this deploy does not know is the ABSENT case, not a corrupt answer. */
test('admin-shell skips the release section for an unreadable snapshot instead of guessing', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    await seedSiteObjects(stores, {
      'objects/content_item/by-id/req_live.json': publishedRecord('req_live', 'commit_live'),
      [RELEASE_SNAPSHOT_KEY]: JSON.stringify({ ...releaseSnapshot(new Date().toISOString()), schema_version: 'release-snapshot.v0' }),
    });

    const { release, inventory } = JSON.parse(
      (await adminShellHandler(shellPost, contextFor('boss@example.com'))).body
    ).sections;
    assert.equal(release.status, 'skipped');
    assert.equal(release.code, 'release_snapshot_unavailable');
    assert.equal(release.data, undefined);
    // Deriving from the rows alone was available and was refused: it would
    // have reported `req_live` as merely `published`.
    assert.equal(inventory.status, 'ok');
    assert.equal(inventory.data.objects.length, 1);
  });
});

/**
 * Rule 3, both halves of the composed section. The two site-objects opens are
 * issued in `Promise.allSettled` order — `inventory` first, the snapshot
 * second — so failing one open at a time separates the two branches.
 */
test('admin-shell degrades the release section alone when its own read cannot open the store', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    stores.rejectOpens.add('site-objects#2');
    const body = JSON.parse((await adminShellHandler(shellPost, contextFor('boss@example.com'))).body);

    assert.equal(body.sections.release.status, 'error');
    assert.equal(body.sections.release.code, 'read_failed');
    assert.doesNotMatch(String(body.sections.release.error), /could not be opened/);
    assert.equal(body.sections.inventory.status, 'ok', 'the inventory read got its own handle and answered');
    assert.equal(body.sections.me.status, 'ok');
    assert.equal(body.sections.access.status, 'ok');
  });
});

test('admin-shell degrades the release section when the inventory it joins to fails', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    stores.rejectOpens.add('site-objects#1');
    const body = JSON.parse((await adminShellHandler(shellPost, contextFor('boss@example.com'))).body);

    // Without rows there is nothing to join the deploy facts to, so the
    // section reports `error` rather than serving an empty library as fact —
    // and the rest of the response stands.
    assert.equal(body.sections.inventory.status, 'error');
    assert.equal(body.sections.release.status, 'error');
    assert.equal(body.sections.release.code, 'read_failed');
    assert.equal(body.sections.me.status, 'ok');
    assert.equal(body.sections.requests.status, 'ok');
    assert.equal(body.sections.access.status, 'ok');
  });
});

/**
 * M2.1's acceptance, stated as the thing that actually bounds the wall clock:
 * every section STARTS before the slowest one finishes. A boot that ran five
 * sections in sequence would cost their sum; this one costs the slowest.
 *
 * M2.1 proved this by making the injected release LOADER slow. With the loader
 * gone the slow thing is the real blob read, which is better: it also proves
 * the snapshot read is issued INSIDE the `allSettled` and not serialized
 * behind the inventory it later joins to.
 */
test('admin-shell starts every section before the slowest one finishes', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    await seedSiteObjects(stores, {
      [RELEASE_SNAPSHOT_KEY]: JSON.stringify(releaseSnapshot(new Date().toISOString())),
    });
    // Long enough that a SERIAL handler would still be queueing the other
    // sections behind this read when the assertions below run.
    stores.slowGets.set(`site-objects#${RELEASE_SNAPSHOT_KEY}`, 25);

    const pending = adminShellHandler(shellPost, contextFor('boss@example.com'));
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The other sections did their blob work WHILE the release snapshot read
    // was still in flight — a serial handler would have read nothing yet.
    assert.ok((stores.reads.get('users') ?? 0) > 0, 'the users store was not read concurrently with release');
    assert.ok(
      (stores.reads.get('editorial-requests') ?? 0) > 0,
      'the requests store was not read concurrently with release'
    );

    const body = JSON.parse((await pending).body);
    for (const section of ['access', 'me', 'requests', 'inventory', 'release'] as const) {
      assert.equal(body.sections[section].status, 'ok', `${section} did not answer`);
    }
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
    // M2.1: the sections added since are held to the same rule.
    assert.equal(body.sections.inventory.status, 'ok');
  });
});

/**
 * A dead object store, and what the `inventory` section actually does about
 * it — which is NOT what the other sections do, and is worth pinning as the
 * surprise it is.
 *
 * `objects/index-store.ts` swallows store failures by design at three levels:
 * `readObjectStoreVersion` catches and returns `undefined` ("nothing may be
 * trusted"), `readObjectIndex` treats an unreadable blob as absent, and the
 * sweep catches per type — "skipping unlistable object type" — so that ONE
 * broken type degrades to zero rows from that type rather than failing the
 * whole inventory. With every type broken, those three behaviours compose
 * into a 200 carrying an EMPTY library, not an error.
 *
 * So the section cannot throw, and this test pins the two things that are
 * true instead: the other four sections are untouched, and the `index`
 * diagnostics say `trusted: false` with `listed: 0` — which is the ONLY
 * signal on the wire distinguishing "the store is unreachable" from "the
 * library is empty", and it does not distinguish them. Recorded rather than
 * fixed here: the swallowing is M0's contract and `admin-inventory` has read
 * it that way since T5.1; changing it belongs with that module, not with a
 * caller. `docs/KNOWN_ISSUES.md` carries the entry.
 */
test('admin-shell survives a dead object store — four sections intact, inventory visibly untrusted', async () => {
  await withShellStores({ ADMIN_EMAILS: 'boss@example.com' }, async (stores) => {
    stores.broken.add('site-objects');
    const response = await adminShellHandler(shellPost, contextFor('boss@example.com'));

    assert.equal(response.statusCode, 200);
    const body = JSON.parse(response.body);
    assert.equal(body.sections.inventory.status, 'ok');
    assert.deepEqual(body.sections.inventory.data.objects, []);
    assert.equal(body.sections.inventory.data.index.trusted, false);
    assert.equal(body.sections.inventory.data.index.listed, 0);

    assert.equal(body.sections.access.status, 'ok');
    assert.equal(body.sections.me.status, 'ok');
    // The requests section reaches the OBJECT store too (the C2 backfill
    // probe), but LAZILY — a page with nothing to reconcile never opens it, so
    // a dead object store must not take the inbox down with it.
    assert.equal(body.sections.requests.status, 'ok');
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

    for (const section of ['me', 'requests', 'inventory', 'release'] as const) {
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
    // M2.1: all FIVE, `release` included even while it is `skipped` — a
    // section you cannot measure is a section you cannot hold to 900 ms.
    for (const section of ['access', 'me', 'requests', 'inventory', 'release']) {
      assert.match(header, new RegExp(`sec\\.${section};dur=\\d+(\\.\\d+)?`), `missing sec.${section} in "${header}"`);
    }
  });
});
