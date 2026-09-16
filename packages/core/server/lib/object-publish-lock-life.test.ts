/**
 * PCL-P0 reproduced C-20; PCL-P1 fixes it. The fix is a HEARTBEAT, not a
 * loosened guard.
 *
 * The defect C-20 named: object_publish's lock guard (object-publish.ts,
 * `!record.lock || record.lock.token !== input.lock_token ||
 * !isObjectLockActive(record.lock, ts)`) treats an EXPIRED lock exactly like
 * a MISSING or STOLEN one — 423 lock_required — even when the caller is the
 * original lock holder presenting the original lock_token. A lock's life is
 * bounded (DEFAULT_LEASE_SECONDS = 900s, object-lock.ts), and before PCL-P1
 * nothing renewed it while a human approval was pending: an editor who
 * checked out, patched, and then took longer than the lock's remaining life
 * to get sign-off could never publish that patch with the token they were
 * issued.
 *
 * PCL-P1's answer is `agent/pending-approval-lock.ts`: while the chat is
 * parked on an approval card whose call holds a lock, the open browser's own
 * `get_chat` poll heartbeats that lock. The publish guard is UNCHANGED — the
 * lock is simply still alive when the approval finally lands. That is what
 * keeps mutual exclusion intact, and it is why a closed browser still lets
 * the lock lapse (third test below).
 *
 * Everything here is deterministic: the real verb dispatcher
 * (object_checkout → object_patch via handleObjectVerb) against an in-memory
 * blob store, a FAKE clock (`nowMs`, never a real timer or sleep), and a
 * git-faithful GitHub API mock for the export commit so a SUCCESSFUL publish
 * can be asserted as a success rather than merely "not 423".
 *
 * Fixture pattern reused from object-verbs-shared-ref-stamp.test.ts /
 * tests/netlify/object-publish.test.ts.
 */
import '../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — handleObjectVerb needs them resolvable
import { describe, it } from 'node:test';
import assert from 'node:assert';
import { createHash } from 'node:crypto';

import { handleObjectVerb, type ObjectVerbStore } from './object-verbs.js';
import { publishObject } from './object-publish.js';
import { DEFAULT_LEASE_SECONDS, isObjectLockActive } from './object-lock.js';
import {
  heartbeatPendingApprovalLocks,
  HEARTBEAT_WINDOW_SECONDS,
  type PendingApprovalDocView,
} from './agent/pending-approval-lock.js';
import { objectRecordKey } from './object-store-keys.js';
import { publishReceiptSchema, type ObjectRecord, type Principal } from '../../schema/object-record-v1.js';

const makeStore = (seeds: ObjectRecord[]) => {
  const blobs = new Map<string, string>();
  for (const seed of seeds) blobs.set(objectRecordKey(seed.object_type, seed.object_id), JSON.stringify(seed));
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const HUMAN: Principal = { kind: 'human', id: 'u1', email: 'editor@example.com' };
const OTHER_HUMAN: Principal = { kind: 'human', id: 'u2', email: 'other@example.com' };

const pageBody = () => ({
  route: '/test-page',
  pageType: 'standard',
  title: 'Home',
  seo: { description: 'x' },
  sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
});

const makeUnlockedPageRecord = (): ObjectRecord => ({
  object_id: 'page_lock_life_test',
  object_type: 'page',
  schema_version: 'page.v1',
  site: 'site_drlurie',
  created_at: '2026-09-16T00:00:00.000Z',
  updated_at: '2026-09-16T00:00:00.000Z',
  status: 'active',
  body: pageBody(),
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

const KEY = objectRecordKey('page', 'page_lock_life_test');
const readRecord = async (store: { get(key: string): Promise<string | null> }): Promise<ObjectRecord> =>
  JSON.parse((await store.get(KEY)) as string) as ObjectRecord;

// ─── the pending approval card ───────────────────────────────────────────────
// The minimum of a ChatDoc the heartbeat reads: a run parked on an approval
// card whose paused call carries the object ref and the lock token. This is
// exactly the shape `loop.ts` writes into `run.pending` when autonomy is
// 'ask' and the run pauses.
const pendingApprovalDoc = (lockToken: string): PendingApprovalDocView => ({
  status: 'awaiting_approval',
  run: {
    principal: HUMAN,
    pending: {
      tool: 'object_publish',
      args: { object_type: 'page', object_id: 'page_lock_life_test', lock_token: lockToken },
    },
  },
});

/**
 * One tick of the open browser's `get_chat` poll. The real poll runs every
 * ~1.2s; ticking once a minute here is the same mechanism with a coarser fake
 * clock, and proves the heartbeat is what keeps the lock alive rather than
 * any particular cadence.
 */
const browserPoll = (
  store: Parameters<typeof heartbeatPendingApprovalLocks>[0],
  doc: PendingApprovalDocView,
  atMs: number
) => heartbeatPendingApprovalLocks(store, doc, { nowMs: atMs });

// ─── git-faithful GitHub API mock (same shape as tests/netlify/object-publish.test.ts) ──
const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
const jsonBody = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

const createGitHubApiMock = () => {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>([['tree0', new Map()]]);
  const commitTrees = new Map<string, string>([['head0', 'tree0']]);
  const commitMessages: string[] = [];
  let head = { sha: 'head0', treeSha: 'tree0' };
  let commitCounter = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;

    if (method === 'GET' && url.pathname.includes('/git/ref/heads/')) return jsonBody({ object: { sha: head.sha } });
    if (method === 'GET' && url.pathname.includes('/git/commits/')) {
      return jsonBody({ tree: { sha: commitTrees.get(url.pathname.split('/').pop() as string) } });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) {
      const sha = sha1(String(body?.content));
      blobs.set(sha, String(body?.content));
      return jsonBody({ sha });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) {
      const base = trees.get(String(body?.base_tree)) ?? new Map<string, string>();
      const next = new Map(base);
      for (const entry of body?.tree as Array<{ path: string; sha: string }>) next.set(entry.path, entry.sha);
      const sha = `tree_${sha1(JSON.stringify([...next.entries()].sort()))}`;
      trees.set(sha, next);
      const unchanged = [...next.entries()].sort().join('|') === [...base.entries()].sort().join('|');
      return jsonBody({ sha: unchanged ? String(body?.base_tree) : sha });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) {
      commitCounter += 1;
      const sha = `commit${commitCounter}`;
      commitTrees.set(sha, String(body?.tree));
      commitMessages.push(String(body?.message));
      return jsonBody({ sha });
    }
    if (method === 'PATCH' && url.pathname.includes('/git/refs/heads/')) {
      head = { sha: String(body?.sha), treeSha: commitTrees.get(String(body?.sha)) as string };
      return jsonBody({ object: { sha: head.sha } });
    }
    return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 });
  }) as typeof fetch;

  return { fetchImpl, commitMessages };
};

const ENV_KEYS = ['GITHUB_CONTENT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_BRANCH', 'BRANCH'] as const;
const withGitHubEnv = async (fn: () => Promise<void>) => {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.GITHUB_CONTENT_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'example-org/example-content';
  delete process.env.GITHUB_BRANCH;
  delete process.env.BRANCH;
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

/** checkout + patch, the editor's half of the flow, well inside the first lease. */
const checkoutAndPatch = async (store: ReturnType<typeof makeStore>, t0: number) => {
  const checkout = await handleObjectVerb(
    store as unknown as ObjectVerbStore,
    { action: 'checkout', object_type: 'page', object_id: 'page_lock_life_test' },
    HUMAN,
    { nowMs: t0 }
  );
  assert.strictEqual(checkout.status, 200, JSON.stringify(checkout.body));
  const lockToken = (checkout.body as { lockToken: string }).lockToken;
  assert.ok(lockToken, 'checkout must return the lock token the editor will publish with');

  const patch = await handleObjectVerb(
    store as unknown as ObjectVerbStore,
    {
      action: 'patch',
      object_type: 'page',
      object_id: 'page_lock_life_test',
      lock_token: lockToken,
      expected_record_version: (checkout.body as { record_version: number }).record_version,
      ops: [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'A calmer start today' } }],
    },
    HUMAN,
    { nowMs: t0 + 30_000 }
  );
  assert.strictEqual(patch.status, 200, JSON.stringify(patch.body));
  return lockToken;
};

describe('C-20: an approval slower than the lock life can never publish', () => {
  it('an approval slower than the lock life can never publish', async () => {
    await withGitHubEnv(async () => {
      const T0 = Date.parse('2026-09-16T09:00:00.000Z');
      const store = makeStore([makeUnlockedPageRecord()]);
      const github = createGitHubApiMock();

      // 1+2) The editor checks out and patches.
      const lockToken = await checkoutAndPatch(store, T0);
      const afterPatch = await readRecord(store);
      assert.strictEqual(afterPatch.lock?.token, lockToken);
      const firstExpiry = Date.parse(afterPatch.lock!.expires_at);

      // 3) The approval card goes up and the human takes their time. Their
      // browser polls throughout — ONE MINUTE PER TICK on the fake clock,
      // right through and past the original 900s lease.
      const doc = pendingApprovalDoc(lockToken);
      for (let minute = 1; minute <= 15; minute += 1) {
        await browserPoll(store, doc, T0 + minute * 60_000);
      }

      // The heartbeat kept the lock alive — and did NOT run away with it: a
      // sliding window, so the expiry is bounded by the last poll plus the
      // heartbeat window no matter how many times it ticked.
      const afterWaiting = await readRecord(store);
      assert.strictEqual(afterWaiting.lock?.token, lockToken, 'the heartbeat must never re-mint the token');
      const lastPollMs = T0 + 15 * 60_000;
      assert.ok(
        Date.parse(afterWaiting.lock!.expires_at) <= lastPollMs + HEARTBEAT_WINDOW_SECONDS * 1000,
        'a heartbeat must never push the expiry further than one window past the last poll'
      );
      assert.strictEqual(
        afterWaiting.content_revision,
        afterPatch.content_revision,
        'lock traffic never bumps content_revision'
      );

      // 4) The approval lands past the ORIGINAL lease and the editor publishes
      // with the ORIGINAL token — the one they were issued at checkout.
      const T_PUBLISH = T0 + DEFAULT_LEASE_SECONDS * 1000 + 1_000; // 901s after checkout
      assert.ok(
        T_PUBLISH > firstExpiry,
        'the publish attempt must land strictly after the ORIGINAL lease would have ended'
      );

      const publish = await publishObject(
        store,
        { object_type: 'page', object_id: 'page_lock_life_test', lock_token: lockToken, actor: HUMAN },
        {
          nowMs: T_PUBLISH,
          fetchImpl: github.fetchImpl,
          sleep: async () => {},
          exportRoot: 'sites/drlurie/data/site',
        }
      );

      // C-20 CLOSED: not merely "not 423" — an actual publish, with an actual
      // export commit behind it.
      assert.strictEqual(publish.status, 200, `expected a successful publish, got ${JSON.stringify(publish.body)}`);
      assert.strictEqual(publish.body.published_time, new Date(T_PUBLISH).toISOString());
      const receipt = publishReceiptSchema.parse(publish.body.receipt);
      assert.strictEqual(receipt.kind, 'object_export_commit');
      assert.strictEqual(receipt.no_op, false, 'the patched body must really have been exported');
      assert.ok(github.commitMessages.at(-1)?.includes('[skip netlify]'));

      const published = await readRecord(store);
      assert.strictEqual(published.publication.published_time, new Date(T_PUBLISH).toISOString());
      assert.deepStrictEqual(
        (published.body as { sections: Array<{ data: { heading: string } }> }).sections[0].data.heading,
        'A calmer start today',
        'the published record must carry the edit the human approved'
      );
    });
  });

  it('a competing checkout during the pending window still wins, and the original holder is refused', async () => {
    await withGitHubEnv(async () => {
      const T0 = Date.parse('2026-09-16T09:00:00.000Z');
      const store = makeStore([makeUnlockedPageRecord()]);
      const github = createGitHubApiMock();

      const lockToken = await checkoutAndPatch(store, T0);
      const doc = pendingApprovalDoc(lockToken);

      // The human decides slowly, but this time the tab is NOT open for the
      // whole window: they poll for five minutes and then stop (lunch). The
      // heartbeat stops with them and the lock lapses on schedule.
      for (let minute = 1; minute <= 5; minute += 1) await browserPoll(store, doc, T0 + minute * 60_000);

      // A second editor checks the object out after the lapse. This is the
      // whole point of a lease, and it must keep working.
      const T_STEAL = T0 + DEFAULT_LEASE_SECONDS * 1000 + 60_000;
      const rivalCheckout = await handleObjectVerb(
        store as unknown as ObjectVerbStore,
        { action: 'checkout', object_type: 'page', object_id: 'page_lock_life_test' },
        OTHER_HUMAN,
        { nowMs: T_STEAL }
      );
      assert.strictEqual(rivalCheckout.status, 200, JSON.stringify(rivalCheckout.body));
      const rivalToken = (rivalCheckout.body as { lockToken: string }).lockToken;
      assert.notStrictEqual(rivalToken, lockToken);

      // The abandoned card's browser comes back to life. Its heartbeat must
      // buy the ORIGINAL holder nothing at all: the token no longer matches
      // the live lock, so refreshObjectLock's guard refuses it.
      const rivalExpiryBefore = (await readRecord(store)).lock!.expires_at;
      const outcomes = await browserPoll(store, doc, T_STEAL + 60_000);
      assert.deepStrictEqual(
        outcomes.map((outcome) => outcome.result),
        ['not_held'],
        'a heartbeat for a token someone else has replaced must do nothing'
      );
      const afterStaleHeartbeat = await readRecord(store);
      assert.strictEqual(afterStaleHeartbeat.lock?.token, rivalToken, 'the rival keeps the lock');
      assert.strictEqual(afterStaleHeartbeat.lock?.expires_at, rivalExpiryBefore, "the rival's lease is untouched");

      // And the original holder's publish is REFUSED — the worst outcome of
      // this task would be publishing over the new holder's work.
      const publish = await publishObject(
        store,
        { object_type: 'page', object_id: 'page_lock_life_test', lock_token: lockToken, actor: HUMAN },
        {
          nowMs: T_STEAL + 120_000,
          fetchImpl: github.fetchImpl,
          sleep: async () => {},
          exportRoot: 'sites/drlurie/data/site',
        }
      );
      assert.strictEqual(publish.status, 423, JSON.stringify(publish.body));
      assert.strictEqual(publish.body.code, 'lock_required');
      assert.strictEqual(github.commitMessages.length, 0, 'nothing may be committed for a refused publish');
    });
  });

  it('a card abandoned without a decision lets the lock lapse normally', async () => {
    const T0 = Date.parse('2026-09-16T09:00:00.000Z');
    const store = makeStore([makeUnlockedPageRecord()]);

    const lockToken = await checkoutAndPatch(store, T0);
    const doc = pendingApprovalDoc(lockToken);

    // The human opens the card, glances at it, and closes the browser. Polls
    // stop; nothing server-side keeps ticking on their behalf.
    for (let minute = 1; minute <= 3; minute += 1) await browserPoll(store, doc, T0 + minute * 60_000);

    const lastSeen = await readRecord(store);
    const expiry = Date.parse(lastSeen.lock!.expires_at);
    assert.ok(
      expiry <= T0 + 3 * 60_000 + Math.max(HEARTBEAT_WINDOW_SECONDS, DEFAULT_LEASE_SECONDS) * 1000,
      'an abandoned lock may not outlive the last poll by more than one lease'
    );

    // Well past the lease, with no browser to heartbeat it, the lock is dead …
    const T_LATE = T0 + DEFAULT_LEASE_SECONDS * 1000 + 60_000;
    assert.ok(T_LATE > expiry);
    assert.strictEqual(isObjectLockActive(lastSeen.lock, T_LATE), false, 'the lock must lapse with the browser gone');

    // … and, critically, the object is free for the next editor.
    const nextEditor = await handleObjectVerb(
      store as unknown as ObjectVerbStore,
      { action: 'checkout', object_type: 'page', object_id: 'page_lock_life_test' },
      OTHER_HUMAN,
      { nowMs: T_LATE }
    );
    assert.strictEqual(nextEditor.status, 200, JSON.stringify(nextEditor.body));

    // A heartbeat arriving after the lapse cannot resurrect anything either:
    // refreshObjectLock refuses an expired/foreign token outright, so a
    // zombie tab can never take the object back from whoever holds it now.
    const zombie = await browserPoll(store, doc, T_LATE + 1_000);
    assert.deepStrictEqual(
      zombie.map((outcome) => outcome.result),
      ['not_held']
    );
    assert.strictEqual((await readRecord(store)).lock?.token, (nextEditor.body as { lockToken: string }).lockToken);
  });
});
