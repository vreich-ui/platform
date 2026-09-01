/**
 * W19 T19.2 — the HTTP-layer contract and the two rules that are easy to
 * regress by accident.
 *
 * The full handler needs a real Netlify Identity-authenticated event to
 * exercise end to end (no test-injection seam exists for
 * `getAdminStateFromEvent` — the admin-governance.test.ts precedent). Three
 * levels of proof instead: the request CONTRACT, the archive GATE as a pure
 * function, and a source-level assertion that `list` cannot degrade to the
 * O(N) scan this wave exists to remove.
 */
import '../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  OBJECT_BACKFILL_MAX,
  REQUEST_PAGE_SIZE,
  backfillPageObjects,
  canArchive,
  OBJECT_MISSING_TTL_MS,
  OBJECT_PROBE_MEMO_MAX,
  OBJECT_UNPUBLISHED_TTL_MS,
  objectBackfillCandidates,
  publicationFromObjectRecord,
  requestSchema,
  resetObjectBackfillMemoForTesting,
  retryRefusal,
  withLibraryFacts,
  type ObjectProbeVerdict,
  type RequestListRow,
} from './admin-requests.js';
import { REQUEST_LIST_MAX_LIMIT } from '../../lib/admin/request-list-limits.js';
import { NOT_IN_LIBRARY, NO_LIVE_PATH, rowActions } from '../../lib/admin/request-logic.js';
import {
  createRequest,
  loadIndex,
  loadRequest,
  projectIndexRow,
  recordObject,
  recordProgress,
  recordPublication,
  reconcileObject,
  requeueRequest,
  setStatus,
  type EditorialRequestStore,
  type RequestIndexRow,
} from '../lib/requests/store.js';

/** The compiled test runs from `.tmp/ci-test`, so walk up to the repo root (the admin-governance.test.ts precedent). */
const repoRoot = (): string => {
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  return root;
};
const source = readFileSync(path.join(repoRoot(), 'packages/core/server/functions/admin-requests.ts'), 'utf8');

describe('admin-requests requestSchema', () => {
  it('accepts a bare list and every filter it documents', () => {
    assert.equal(requestSchema.safeParse({ action: 'list' }).success, true);
    assert.equal(
      requestSchema.safeParse({
        action: 'list',
        status: ['needs_you', 'stalled'],
        kind: ['article'],
        mine: true,
        archived: false,
        q: 'retinol',
        cursor: '100',
        limit: 25,
      }).success,
      true
    );
  });

  it('rejects an unknown status rather than silently ignoring it', () => {
    assert.equal(requestSchema.safeParse({ action: 'list', status: ['in_progress'] }).success, false);
  });

  it('caps the page size at the server bound', () => {
    assert.equal(requestSchema.safeParse({ action: 'list', limit: REQUEST_PAGE_SIZE }).success, true);
    // The shared poll store asks for REQUEST_LIST_MAX_LIMIT rows. If that ever
    // exceeds REQUEST_PAGE_SIZE the handler 400s the call rather than
    // truncating it, and the runs inbox renders a permanent skeleton — which
    // is what shipped when the store asked for 200 against a cap of 100.
    assert.equal(REQUEST_LIST_MAX_LIMIT, REQUEST_PAGE_SIZE);
    assert.equal(requestSchema.safeParse({ action: 'list', limit: REQUEST_LIST_MAX_LIMIT }).success, true);
    assert.equal(requestSchema.safeParse({ action: 'list', limit: REQUEST_PAGE_SIZE + 1 }).success, false);
    assert.equal(requestSchema.safeParse({ action: 'list', limit: 0 }).success, false);
  });

  it('requires a request_id on every per-request action', () => {
    for (const action of ['get', 'archive', 'unarchive', 'cancel', 'mute', 'unmute', 'retry']) {
      assert.equal(requestSchema.safeParse({ action }).success, false, `${action} without an id`);
      assert.equal(
        requestSchema.safeParse({ action, request_id: 'req_agent_x_20260822_01' }).success,
        true,
        `${action} with an id`
      );
    }
  });

  it('rejects an unknown action', () => {
    assert.equal(requestSchema.safeParse({ action: 'delete', request_id: 'x' }).success, false);
  });
});

describe('the archive gate (plan §8)', () => {
  it('admits Owner and publisher, and nobody else', () => {
    assert.equal(canArchive(['owner']), true);
    assert.equal(canArchive(['publisher']), true);
    assert.equal(canArchive(['admin']), false);
    assert.equal(canArchive(['editor']), false);
    assert.equal(canArchive([]), false);
  });
});

describe('the two rules this endpoint must not regress', () => {
  it('never scans: `list` reads the index and the O(N) walk is not even imported (plan F7)', () => {
    assert.ok(!source.includes('listRequestDocs'), 'admin-requests must not import the O(N) doc walk');
    assert.ok(source.includes('loadIndex('), 'list must read the index doc');
    assert.ok(source.includes('rebuilt: true'), 'a rebuild must be reported, never silent');
  });

  it('reads team-wide: the creator-scoped chat rule is deliberately not applied (plan §8)', () => {
    assert.ok(!source.includes('visibleChatDocs'), 'requests are team-wide readable — see the module header');
    assert.ok(
      /TEAM-WIDE/.test(source),
      'the departure from chat-visibility must stay commented, so nobody "fixes" it back'
    );
  });
});


// ─── B2: Retry ───────────────────────────────────────────────────────────────

/**
 * The handler still has no auth-injection seam (see the header), so the retry
 * action is proven at the two levels that exist: the STATE transition through
 * `requeueRequest` — the writer this endpoint calls and never duplicates
 * (guardrail 1) — and the HTTP mapping through `retryRefusal`, the pure
 * function the `retry` case is written in terms of.
 */
class RetryFakeStore implements EditorialRequestStore {
  readonly map = new Map<string, string>();
  /** Every setJSON key, in write order — C2's "a second pass writes nothing" reads this. */
  readonly writes: string[] = [];

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    this.writes.push(key);
    this.map.set(key, JSON.stringify(value));
  }

  async list({ prefix }: { prefix: string; directories?: boolean; paginate?: boolean }) {
    return { blobs: [...this.map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
  }
}

const RETRY_ID = 'req_agent_retinol_20260822_01';
const at = (n: number) => new Date(Date.UTC(2026, 7, 22, 12, 0, n)).toISOString();

/** A run that died at `artifact_plan` — the node the Retry receipt names. */
const seedStoppedRun = async (store: RetryFakeStore, status: 'failed' | 'needs_you') => {
  await createRequest(
    store,
    {
      request_id: RETRY_ID,
      kind: 'article',
      title: 'Retinol after 40',
      created_by: 'editor@example.com',
      workflow: { run_id: 'run_123', workflow_id: 'wf_publishing_conductor', project_id: 'proj_drlurie', node_total: 23 },
    },
    at(0)
  );
  await setStatus(store, RETRY_ID, { status: 'running' }, at(1));
  await recordProgress(
    store,
    RETRY_ID,
    { node_total: 23, node_done: 19, node_failed: 1, stalled: false, nudges: 3, current_node: 'artifact_plan' },
    at(2)
  );
  await setStatus(store, RETRY_ID, { status, status_reason: 'the artifact plan step failed' }, at(3));
};

describe('B2 — the retry action', () => {
  it('accepts `retry` with a request_id and rejects it bare', () => {
    assert.equal(requestSchema.safeParse({ action: 'retry', request_id: RETRY_ID }).success, true);
    assert.equal(requestSchema.safeParse({ action: 'retry' }).success, false);
  });

  it('a failed request comes back queued, with the node it stopped at intact', async () => {
    const store = new RetryFakeStore();
    await seedStoppedRun(store, 'failed');

    const result = await requeueRequest(store, RETRY_ID, at(4));
    assert.equal(result.ok, true);

    const doc = await loadRequest(store, RETRY_ID);
    assert.equal(doc?.status, 'queued', 'a retry that leaves the row failed is a button that lies');
    // `recovery.node_id` is derived per-read from the RUN (activity.ts), not
    // stored on the request — what a retry must not clobber on this side is
    // the workflow's own node pointer, which is both the fallback that
    // recovery resolves to and the name the Retry receipt reads.
    assert.equal(doc?.workflow?.current_node, 'artifact_plan');
    assert.equal(doc?.workflow?.nudges, 0);
    assert.equal(doc?.workflow?.run_id, 'run_123');
  });

  it('refuses a needs_you request with 409 and the reason, and does not move it', async () => {
    const store = new RetryFakeStore();
    await seedStoppedRun(store, 'needs_you');

    const result = await requeueRequest(store, RETRY_ID, at(4));
    if (result.ok) throw new Error('a needs_you request must not be requeued');
    const refusal = retryRefusal(result);
    assert.equal(refusal.code, 409, 'retrying a request waiting on a human is a conflict, not a bad request');
    assert.match(refusal.error, /human decision/i, 'the editor must be told WHY, in the store\u2019s own words');
    assert.equal((await loadRequest(store, RETRY_ID))?.status, 'needs_you');
  });

  it('separates "no such request" (404) from "not in a state to retry" (409)', () => {
    assert.deepEqual(retryRefusal({ reason: 'No request req_nope.' }), { code: 404, error: 'Request not found.' });
    assert.equal(retryRefusal({ reason: 'This request is done; there is nothing left to retry.', status: 'done' }).code, 409);
  });

  it('routes the retry through requeueRequest rather than writing the status itself (guardrail 1)', () => {
    assert.ok(source.includes('requeueRequest(store'), 'the store owns every retry state rule');
    assert.ok(!/status\s*=\s*'queued'/.test(source), 'admin-requests must never set a request status by hand');
  });
});


// ─── C2: the object a finished run produced ──────────────────────────────────

/**
 * The reported bug: a `done` row for a published article rendered Open object
 * AND Publish disabled with "No object attached". `object_id` is written in
 * exactly one place (the sweep pass that sees `article_body` complete) and only
 * while the request is still sweepable, so a run that reached a terminal status
 * without passing through that moment never got one — and never would, because
 * a terminal request is never polled again.
 *
 * These prove the read-path repair, at the two levels this endpoint supports:
 * the bound (`objectBackfillCandidates`, so a polled list can never become N
 * object reads) and the reconciliation itself, over the real store writer.
 */
const DONE_ID = 'req_agent_bakuchiol_20260831_01';
const DONE_ID_B = 'req_agent_niacinamide_20260831_01';

const seedFinishedRun = async (store: RetryFakeStore, requestId: string, withObject = false) => {
  await createRequest(
    store,
    { request_id: requestId, kind: 'article', title: 'Retinol vs. bakuchiol', created_by: 'editor@example.com' },
    at(0)
  );
  if (withObject) await recordObject(store, requestId, { object_type: 'content_item', object_id: requestId }, at(1));
  await setStatus(store, requestId, { status: 'done' }, at(2));
};

const rowsOf = async (store: RetryFakeStore): Promise<RequestIndexRow[]> => (await loadIndex(store))!.rows;

/** A memo entry, in the two shapes the code writes. */
const seen = (until = Number.POSITIVE_INFINITY) => ({ in_library: true, until });
const absent = { in_library: false, until: Number.POSITIVE_INFINITY };

describe('FIX 8 — the probe memo is trimmed, not wiped', () => {
  const T0 = Date.parse('2025-03-02T09:00:00.000Z');
  /**
   * W21.1 made the memo a source of what the row SAYS, so `memo.clear()` at
   * the cap dropped every verdict at once and a whole page reverted to "not in
   * the library" until it re-converged five rows a poll. Oldest-out keeps the
   * bound and keeps the answers.
   */
  it('stays bounded, and keeps the most recent answers instead of losing all of them', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    const memo = new Map<string, ObjectProbeVerdict>();
    // Fill well past the cap, one verdict at a time, through the real path.
    for (let i = 0; i < OBJECT_PROBE_MEMO_MAX + 25; i += 1) {
      await backfillPageObjects(
        store,
        [
          {
            request_id: `r${i}`,
            kind: 'article',
            title: `t${i}`,
            status: 'done',
            created_by: 'e@x',
            updated_at: at(1),
            object_published: false,
            archived: false,
          },
        ],
        async () => undefined,
        memo,
        T0 + i
      );
    }
    assert.ok(memo.size <= OBJECT_PROBE_MEMO_MAX, `bounded (${memo.size})`);
    assert.ok(memo.size >= OBJECT_PROBE_MEMO_MAX - 1, 'and full, rather than emptied by the last write');
    assert.ok(memo.has(`r${OBJECT_PROBE_MEMO_MAX + 24}`), 'the newest answer is kept');
    assert.equal(memo.has('r0'), false, 'the oldest is the one that goes');
  });
});

describe('C2 — which rows earn an object read', () => {
  it('only finished rows, only ones missing an answer, and never one already looked for', () => {
    const rows = [
      { request_id: 'a', status: 'done' as const },
      { request_id: 'b', status: 'done' as const, object_id: 'b', object_published: true },
      { request_id: 'c', status: 'running' as const },
      { request_id: 'd', status: 'failed' as const },
      { request_id: 'e', status: 'done' as const },
    ];
    // FIX 1: `b` is complete and is NOT a candidate — publication entails the
    // platform record, so there is nothing left to ask the library about it.
    // W21.1 probed it anyway, which is what starved the rest of the page.
    assert.deepEqual(objectBackfillCandidates(rows, new Map()), ['a', 'e']);
    assert.deepEqual(objectBackfillCandidates(rows, new Map([['a', absent]])), ['e']);
  });

  it('C2b: a row with an object but no publication answer is still worth one read', () => {
    const rows = [{ request_id: 'a', status: 'done' as const, object_id: 'a', object_published: false }];
    assert.deepEqual(objectBackfillCandidates(rows, new Map()), ['a']);
    assert.deepEqual(objectBackfillCandidates(rows, new Map([['a', absent]])), [], 'and asked only once');
  });

  it('is bounded, so a polled list can never become an N-read scan', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ request_id: `r${i}`, status: 'done' as const }));
    assert.equal(objectBackfillCandidates(rows, new Map()).length, OBJECT_BACKFILL_MAX);
    assert.ok(OBJECT_BACKFILL_MAX < REQUEST_PAGE_SIZE, 'the cap must be well under a full page');
  });
});

describe('C2 — reconciling the object onto a finished row', () => {
  it('a done row whose object exists gets it, without pretending it just happened', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const before = await loadRequest(store, DONE_ID);
    assert.equal(before?.object, undefined, 'the row starts with the bug');

    const probed: string[] = [];
    const result = await backfillPageObjects(store, await rowsOf(store), async (id) => {
      probed.push(id);
      return { published: false };
    });

    assert.deepEqual(probed, [DONE_ID]);
    assert.equal(result.wrote, true);
    assert.equal(result.rows[0]?.object_published, false, 'an unpublished record proves nothing more');
    assert.equal(result.rows[0]?.object_id, DONE_ID, 'the response carries the fix, not just the next poll');
    const doc = await loadRequest(store, DONE_ID);
    assert.equal(doc?.object?.object_id, DONE_ID);
    assert.equal(doc?.object?.object_type, 'content_item');
    // A reconciliation, not a transition: the row must not jump to the top of
    // the inbox and the timeline must not gain a "produced X" dated today.
    assert.equal(doc?.updated_at, before?.updated_at);
    assert.deepEqual(doc?.history, before?.history);
    // …and the index row the endpoint returns is the one the index now holds,
    // plus W21.1's one response-only fact: the probe read the record, so the
    // row may say the library holds it (the stored row cannot — see
    // `RequestListRow`).
    assert.deepEqual(result.rows[0], { ...projectIndexRow(doc!), object_in_library: true });
  });

  it('a done row whose object is NOT there keeps the honest reason, and is never probed twice', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const writesBefore = store.writes.length;

    const probed: string[] = [];
    const probe = async (id: string) => {
      probed.push(id);
      return undefined;
    };
    const first = await backfillPageObjects(store, await rowsOf(store), probe);
    assert.equal(first.wrote, false);
    assert.equal(first.rows[0]?.object_id, undefined, 'an unproven object is never guessed into being');
    assert.equal(store.writes.length, writesBefore, 'nothing to record, so nothing is written');

    // The memo is what stops the miss costing an object read on every poll.
    const second = await backfillPageObjects(store, await rowsOf(store), probe);
    assert.deepEqual(probed, [DONE_ID], 'the second poll makes no read at all');
    assert.equal(second.wrote, false);
  });

  it('a probe that could not answer is not a verdict — it is retried, not memoised', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('blob store unreachable');
      return { published: false };
    };
    assert.equal((await backfillPageObjects(store, await rowsOf(store), flaky)).wrote, false);
    assert.equal((await backfillPageObjects(store, await rowsOf(store), flaky)).wrote, true);
    assert.equal((await loadRequest(store, DONE_ID))?.object?.object_id, DONE_ID);
  });

  it('a second pass over an already-filled row reads nothing and writes nothing', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    await backfillPageObjects(store, await rowsOf(store), async () => ({ published: true }));
    const writesAfterFix = store.writes.length;

    let probes = 0;
    const again = await backfillPageObjects(store, await rowsOf(store), async () => {
      probes += 1;
      return { published: true };
    });
    assert.equal(probes, 0);
    assert.equal(again.wrote, false);
    assert.equal(store.writes.length, writesAfterFix, 'the repeat case is free');
  });

  it('leaves a running request alone — the object field there is the sweeper’s', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await createRequest(
      store,
      { request_id: DONE_ID_B, kind: 'article', title: 'Niacinamide', created_by: 'editor@example.com' },
      at(0)
    );
    await setStatus(store, DONE_ID_B, { status: 'running' }, at(1));
    const writesBefore = store.writes.length;
    // Even called directly, the writer refuses anything the sweeper still owns.
    const doc = await reconcileObject(store, DONE_ID_B, { object_type: 'content_item', object_id: DONE_ID_B }, at(2));
    assert.equal(doc?.object, undefined);
    assert.equal(store.writes.length, writesBefore);
  });

  it('never overwrites an object the sweeper already recorded', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    const writesBefore = store.writes.length;
    await reconcileObject(store, DONE_ID, { object_type: 'content_item', object_id: 'something_else' }, at(3));
    assert.equal((await loadRequest(store, DONE_ID))?.object?.object_id, DONE_ID);
    assert.equal(store.writes.length, writesBefore);
  });
});


// ─── C2b: publication truth for the rows the sweeper never answered ──────────

/**
 * Every row on Wolf's live Done tab predates C1, so its doc holds no
 * publication evidence and never will — a terminal request is never swept
 * again. The object record is the fallback, and it is PROOF rather than
 * inference: `object_publish` stamps `published_time` only after the export
 * commit succeeded, and leaves that commit's receipt beside it.
 */
const objectRecord = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    object_id: DONE_ID,
    object_type: 'content_item',
    status: 'active',
    body: { slug: 'retinol-vs-bakuchiol-sensitive-skin', title: 'Retinol vs. bakuchiol' },
    publication: { published_time: null },
    ...over,
  });

const PUBLISHED_RECORD = objectRecord({
  publication: {
    published_time: '2026-08-31T07:37:26.344Z',
    publish_receipt: {
      kind: 'object_export_commit',
      branch: 'main',
      commit_sha: '61f1b1827f38766b85beaa0bdd58ccdc82539f9c',
      tree_sha: 'abc',
      no_op: false,
      attempts: 1,
      files: ['src/data/post/retinol-vs-bakuchiol-sensitive-skin.md'],
      content_revision: 4,
      exported_at: '2026-08-31T07:37:26.344Z',
    },
  },
});

describe('C2b — what the object record proves', () => {
  it('FIX 1: a stamped record with its export receipt proves PUBLISHED and no live URL', () => {
    // The receipt is the export commit's, and that commit carries
    // `[skip netlify]` — it proves the article is on the content branch, never
    // that production serves it. `live_path` means release-confirmed, so this
    // path must not mint one however complete the receipt looks.
    assert.deepEqual(publicationFromObjectRecord(PUBLISHED_RECORD), { published: true });
  });

  it('an unstamped record is not published, however old or complete it looks', () => {
    assert.deepEqual(publicationFromObjectRecord(objectRecord()), { published: false });
    assert.deepEqual(publicationFromObjectRecord(objectRecord({ publication: {} })), { published: false });
    // Never from status, age, or the mere existence of the object.
    assert.deepEqual(
      publicationFromObjectRecord(objectRecord({ status: 'active', created_at: '2020-01-01T00:00:00.000Z' })),
      { published: false }
    );
  });

  it('a stamped record with no export receipt is published just the same', () => {
    const stamped = objectRecord({ publication: { published_time: '2026-08-31T07:37:26.344Z' } });
    assert.deepEqual(publicationFromObjectRecord(stamped), { published: true });
  });

  it('a record that says nothing readable proves nothing', () => {
    assert.deepEqual(publicationFromObjectRecord('not json'), { published: false });
    assert.deepEqual(publicationFromObjectRecord('[]'), { published: false });
  });
});

describe('C2b — a legacy done row, reconciled from its object record', () => {
  const probeReturning = (raw: string | null, reads: string[] = []) => async (id: string) => {
    reads.push(id);
    return raw === null ? undefined : publicationFromObjectRecord(raw);
  };

  it('FIX 1: a record proving publication makes the row published, and View live stays disabled', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const result = await backfillPageObjects(store, await rowsOf(store), probeReturning(PUBLISHED_RECORD));

    assert.equal(result.wrote, true);
    assert.equal(result.rows[0]?.object_id, DONE_ID);
    assert.equal(result.rows[0]?.object_published, true);
    assert.equal(result.rows[0]?.live_path, undefined, 'a record cannot confirm a deploy');
    assert.equal((await loadRequest(store, DONE_ID))?.object?.live_path, undefined, 'and none is persisted');
    // …so the Done tab row draws Open object enabled — the real prize — and
    // View live visible but disabled, saying why (D3), instead of a link that
    // 404s until someone runs the release.
    const actions = rowActions({ ...result.rows[0]!, status: 'done', archived: false }, ['owner', 'admin', 'publisher']);
    // W21.3 adds the way out of exactly this state — a site release, which is
    // what would give the row the live URL the record cannot prove.
    assert.deepEqual(
      actions.filter((action) => action.enabled).map((action) => action.id).sort(),
      ['archive', 'open_object', 'release']
    );
    const viewLive = actions.find((action) => action.id === 'view_live');
    assert.equal(viewLive?.enabled, false);
    assert.equal(viewLive?.reason, NO_LIVE_PATH);
  });

  it('a record showing unpublished leaves the row false, and Publish is what it offers', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const result = await backfillPageObjects(store, await rowsOf(store), probeReturning(objectRecord()));

    assert.equal(result.rows[0]?.object_published, false);
    assert.equal(result.rows[0]?.live_path, undefined);
    assert.equal((await loadRequest(store, DONE_ID))?.object?.published, undefined, 'no claim is persisted');
    assert.deepEqual(
      rowActions({ ...result.rows[0]!, status: 'done', archived: false }, ['owner', 'admin', 'publisher'])
        .filter((action) => action.enabled)
        .map((action) => action.id)
        .sort(),
      ['archive', 'open_object', 'publish']
    );
  });

  it('the sweeper’s own evidence wins, and the record is never even read', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    // C1's writer: the run's receipts said published, go-live unconfirmed.
    await recordPublication(store, DONE_ID, {}, at(3));
    const writesBefore = store.writes.length;

    const reads: string[] = [];
    const result = await backfillPageObjects(
      store,
      await rowsOf(store),
      probeReturning(PUBLISHED_RECORD, reads)
    );

    // FIX 1: not read at all. The sweeper's publish receipt already entails
    // the platform record, so the library question is answered without a read
    // — which is why `object_in_library` below is true on zero probes.
    assert.deepEqual(reads, [], 'a row the sweeper answered is not a candidate at all');
    assert.equal(result.wrote, false);
    assert.equal(store.writes.length, writesBefore);
    assert.equal(result.rows[0]?.object_published, true);
    assert.equal(result.rows[0]?.live_path, undefined, 'the record must not talk the sweeper into a live URL');
    assert.equal(result.rows[0]?.object_in_library, true);
  });

  it('and a doc the sweeper answered is closed to this path even called directly', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    await recordPublication(store, DONE_ID, {}, at(3));
    const writesBefore = store.writes.length;
    await reconcileObject(
      store,
      DONE_ID,
      { object_type: 'content_item', object_id: DONE_ID, published: true },
      at(4)
    );
    assert.equal((await loadRequest(store, DONE_ID))?.object?.live_path, undefined);
    assert.equal(store.writes.length, writesBefore);
  });

  it('an already-reconciled published row is neither read nor written again', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    await backfillPageObjects(store, await rowsOf(store), probeReturning(PUBLISHED_RECORD));
    const writesAfterFix = store.writes.length;

    const reads: string[] = [];
    const again = await backfillPageObjects(store, await rowsOf(store), probeReturning(PUBLISHED_RECORD, reads));
    assert.deepEqual(reads, []);
    assert.equal(again.wrote, false);
    assert.equal(store.writes.length, writesAfterFix);
  });
});


// ─── C2c: the memo caches a missing object, never an unpublished one ─────────

/**
 * The bug the split fixes: publishing from an inbox row left the row saying
 * unpublished, because the probe's "not published" answer had been memoised
 * for the life of the process — so the next click was on an article that was
 * already live. A missing object is permanent and is still cached forever; an
 * unpublished one is a live fact and expires.
 */
describe('C2c — a missing object is permanent, an unpublished one is not', () => {
  const probeFor = (raw: string | null, reads: string[]) => async (id: string) => {
    reads.push(id);
    return raw === null ? undefined : publicationFromObjectRecord(raw);
  };
  const T0 = Date.UTC(2026, 7, 31, 9, 0, 0);
  const later = (ms: number) => T0 + ms;

  it('object missing: held for a window, and never re-read inside it', async () => {
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const memo = new Map<string, ObjectProbeVerdict>();
    const reads: string[] = [];

    const first = await backfillPageObjects(store, await rowsOf(store), probeFor(null, reads), memo, T0);
    assert.deepEqual(reads, [DONE_ID]);
    // FIX 2: a window, not `Infinity`. The miss is the state whose reason asks
    // the operator to publish, and publishing is what ends it — so the answer
    // has to be able to expire. See `OBJECT_MISSING_TTL_MS` for the value.
    assert.deepEqual(
      memo.get(DONE_ID),
      { in_library: false, until: T0 + OBJECT_MISSING_TTL_MS },
      'held, so a publish can be noticed'
    );
    // W21.1: and the row SAYS so, which is what disables its Open object.
    assert.equal(first.rows[0]?.object_in_library, false);

    // Inside the window there is nothing to re-read.
    await backfillPageObjects(store, await rowsOf(store), probeFor(null, reads), memo, later(OBJECT_MISSING_TTL_MS - 1));
    assert.deepEqual(reads, [DONE_ID], 'still one read');
  });

  it('object exists but unpublished: held briefly, then re-read, and it flips once the record says so', async () => {
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const memo = new Map<string, ObjectProbeVerdict>();
    const reads: string[] = [];

    const first = await backfillPageObjects(store, await rowsOf(store), probeFor(objectRecord(), reads), memo, T0);
    assert.equal(first.rows[0]?.object_published, false);
    assert.deepEqual(
      memo.get(DONE_ID),
      { in_library: true, until: T0 + OBJECT_UNPUBLISHED_TTL_MS },
      'held, not cached forever'
    );
    // W21.1: the object IS in the library even though it is not published —
    // the two facts are separate, and only this one opens the record.
    assert.equal(first.rows[0]?.object_in_library, true);

    // Inside the window the read rate stays bounded…
    await backfillPageObjects(
      store,
      await rowsOf(store),
      probeFor(objectRecord(), reads),
      memo,
      later(OBJECT_UNPUBLISHED_TTL_MS - 1)
    );
    assert.deepEqual(reads, [DONE_ID], 'one read, not one per poll');

    // …and once it lapses the row asks again — which is how a publish from
    // this very row becomes visible instead of inviting a second click.
    const after = await backfillPageObjects(
      store,
      await rowsOf(store),
      probeFor(PUBLISHED_RECORD, reads),
      memo,
      later(OBJECT_UNPUBLISHED_TTL_MS)
    );
    assert.deepEqual(reads, [DONE_ID, DONE_ID]);
    assert.equal(after.wrote, true);
    assert.equal(after.rows[0]?.object_published, true);
    assert.equal(after.rows[0]?.live_path, undefined, 'FIX 1: published, never live, from a record');
    assert.deepEqual(
      memo.get(DONE_ID),
      { in_library: true, until: Number.POSITIVE_INFINITY },
      'nothing left to ask — and W21.1 keeps the entry rather than dropping it, or the row would be probed forever'
    );
  });

  it('the TTL is the read-rate bound: never more than the cap per window', () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({ request_id: `r${i}`, status: 'done' as const }));
    const memo = new Map(rows.map((row) => [row.request_id, seen(T0 + OBJECT_UNPUBLISHED_TTL_MS)] as const));
    assert.deepEqual(objectBackfillCandidates(rows, memo, T0), [], 'a fast poll inside the window reads nothing');
    assert.equal(
      objectBackfillCandidates(rows, memo, later(OBJECT_UNPUBLISHED_TTL_MS)).length,
      OBJECT_BACKFILL_MAX,
      'and the cap still applies when it lapses'
    );
  });
});


// ─── W21.1: `object_in_library` — the only fact Open object may believe ──────

/**
 * The bug: two `done` rows offered an ENABLED Open object that landed on
 * "Couldn't open this object — not found". `sweep.ts` writes `object_id` when
 * `article_body` completes, but that draft is a CMS-Agent stage output — the
 * platform record only exists after a publish — so the field the row was gated
 * on proves the run named an object, never that the library holds one.
 *
 * The probe already reads the object store. These prove it now REPORTS what it
 * saw, in a form the row can read, and that "nobody looked" stays telling
 * apart from "looked and found none".
 */
describe('W21.1 — the probe reports library presence, and only the probe', () => {
  const probeReturning = (raw: string | null, reads: string[] = []) => async (id: string) => {
    reads.push(id);
    return raw === null ? undefined : publicationFromObjectRecord(raw);
  };
  const OWNER = ['owner', 'admin', 'publisher'];
  const T0 = Date.parse('2025-03-02T09:00:00.000Z');
  const later = (ms: number) => T0 + ms;
  const openObjectOf = (row: RequestListRow) =>
    rowActions({ ...row, status: 'done', archived: false }, OWNER).find((action) => action.id === 'open_object');

  it('a record the probe read makes the row say so, and Open object opens', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID);
    const result = await backfillPageObjects(store, await rowsOf(store), probeReturning(objectRecord()));

    assert.equal(result.rows[0]?.object_in_library, true);
    assert.equal(result.rows[0]?.object_published, false, 'in the library and not published are different facts');
    assert.equal(openObjectOf(result.rows[0]!)?.enabled, true);
  });

  it('a probe that found nothing says FALSE, and the row refuses the link', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    // The live shape of the bug: the sweeper recorded an object id, the
    // library has no record for it.
    await seedFinishedRun(store, DONE_ID, true);
    const result = await backfillPageObjects(store, await rowsOf(store), probeReturning(null));

    assert.equal(result.rows[0]?.object_id, DONE_ID, 'the run still names its draft');
    assert.equal(result.rows[0]?.object_in_library, false);
    const openObject = openObjectOf(result.rows[0]!);
    assert.equal(openObject?.enabled, false, 'the enabled link that 404s is the bug');
    assert.equal(openObject?.reason, NOT_IN_LIBRARY);
  });

  it('never probed: the field is absent, and absent is not a confirmation', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    // No probe at all — the page went out before this row got one of the
    // OBJECT_BACKFILL_MAX slots.
    const [row] = withLibraryFacts(await rowsOf(store), new Map());

    assert.equal(row?.object_in_library, undefined, 'unknown is reported as unknown, never as false or true');
    assert.equal(openObjectOf(row!)?.enabled, false, 'and unknown renders like unproven, because it is');
    assert.equal(openObjectOf(row!)?.reason, NOT_IN_LIBRARY);
  });

  /**
   * FIX 1 — the finding this suite shipped with. `OBJECT_BACKFILL_MAX` is 5
   * and `REQUEST_PAGE_SIZE` is 100, so W21.1's "probe every published row"
   * rule meant up to 95 rows a page rendering `object_in_library` absent —
   * Open object disabled, on a branch that offers no Publish, telling the
   * operator to publish something already published. Publication entails the
   * record, so the answer is derived and the false negative cannot occur.
   */
  it('a published row is confirmed with NO read at all, however big the page', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    await recordPublication(store, DONE_ID, {}, at(3));
    const rows = await rowsOf(store);
    assert.equal(rows[0]?.object_published, true, 'the run proved the publish');

    const reads: string[] = [];
    const memo = new Map<string, ObjectProbeVerdict>();
    const first = await backfillPageObjects(store, rows, probeReturning(PUBLISHED_RECORD, reads), memo);
    assert.deepEqual(reads, [], 'the publish receipt already entails the record — nothing to look up');
    assert.equal(first.rows[0]?.object_in_library, true);
    assert.equal(openObjectOf(first.rows[0]!)?.enabled, true);
  });

  it('holds for a whole page at once — no row waits its turn for one of the five slots', () => {
    // The shape of the live regression: a page far larger than the probe cap.
    const page = Array.from({ length: 100 }, (_, i) => ({
      request_id: `r${i}`,
      kind: 'article' as const,
      title: `t${i}`,
      status: 'done' as const,
      created_by: 'e@x',
      updated_at: at(1),
      object_id: `r${i}`,
      object_published: true,
      archived: false,
    }));
    assert.deepEqual(objectBackfillCandidates(page, new Map()), [], 'not one of them earns a read');
    const decorated = withLibraryFacts(page, new Map());
    assert.equal(
      decorated.filter((row) => row.object_in_library === true).length,
      100,
      'and every one of them is confirmed'
    );
    for (const row of decorated) assert.equal(openObjectOf(row)?.enabled, true);
  });

  /**
   * FIX 2 — the recovery this suite used to assert by calling
   * `reconcileOneObject` directly, which is not a path the browser can take.
   * Driven through `backfillPageObjects` here — the LIST poll, which is what
   * the row is actually sitting in when the operator publishes.
   */
  it('recovers through the LIST poll: publish, and the row stops saying it is missing', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    const memo = new Map<string, ObjectProbeVerdict>();
    const reads: string[] = [];

    // The live shape: the sweeper named an object, the library has no record.
    const missed = await backfillPageObjects(store, await rowsOf(store), probeReturning(null, reads), memo, T0);
    assert.equal(missed.rows[0]?.object_in_library, false);
    assert.equal(openObjectOf(missed.rows[0]!)?.reason, NOT_IN_LIBRARY);

    // Inside the window the list does not pay for the miss twice.
    await backfillPageObjects(
      store,
      await rowsOf(store),
      probeReturning(null, reads),
      memo,
      later(OBJECT_MISSING_TTL_MS - 1)
    );
    assert.deepEqual(reads, [DONE_ID], 'one read, not one per poll');
    assert.deepEqual(
      objectBackfillCandidates(await rowsOf(store), memo, later(OBJECT_MISSING_TTL_MS - 1)),
      [],
      'held, as the read-rate bound requires'
    );

    // The operator does exactly what the reason asked and publishes. Nothing
    // writes the request doc — `object_publish` writes the OBJECT store — so
    // recovery has to come from the row being asked again.
    const recovered = await backfillPageObjects(
      store,
      await rowsOf(store),
      probeReturning(PUBLISHED_RECORD, reads),
      memo,
      later(OBJECT_MISSING_TTL_MS)
    );
    assert.deepEqual(reads, [DONE_ID, DONE_ID], 'asked again once the window lapsed');
    assert.equal(recovered.rows[0]?.object_in_library, true);
    assert.equal(recovered.rows[0]?.object_published, true);
    assert.equal(openObjectOf(recovered.rows[0]!)?.enabled, true, 'the row recovers, in the list, on its own');

    // …and having recovered it leaves the candidate set for good (FIX 1).
    assert.deepEqual(
      objectBackfillCandidates(await rowsOf(store), memo, later(86_400_000)),
      [],
      'nothing left to ask about a published row'
    );
  });

  it('a miss the operator never acts on costs one read per window, not one per poll', async () => {
    resetObjectBackfillMemoForTesting();
    const store = new RetryFakeStore();
    await seedFinishedRun(store, DONE_ID, true);
    const memo = new Map<string, ObjectProbeVerdict>();
    const reads: string[] = [];
    for (const step of [0, 1, OBJECT_MISSING_TTL_MS - 1, OBJECT_MISSING_TTL_MS, OBJECT_MISSING_TTL_MS + 1]) {
      await backfillPageObjects(store, await rowsOf(store), probeReturning(null, reads), memo, later(step));
    }
    assert.equal(reads.length, 2, 'five polls across two windows read twice');
  });
});
