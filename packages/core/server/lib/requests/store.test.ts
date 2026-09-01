import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  archiveRequest,
  attachChat,
  cancelRequest,
  createRequest,
  HISTORY_MAX,
  listRequestDocs,
  loadIndex,
  loadRequest,
  NON_TERMINAL_REQUEST_STATUSES,
  projectIndexRow,
  rebuildIndex,
  reconcileObject,
  recordObject,
  recordProgress,
  recordPublication,
  requeueRequest,
  REQUEST_ID_PATTERN,
  REQUEST_INDEX_KEY,
  REQUEST_INDEX_SCHEMA_VERSION,
  requestDocKey,
  requestIndexRowSchema,
  requestIndexSchema,
  requestStatusSchema,
  editorialRequestSchema,
  setStatus,
  TERMINAL_REQUEST_STATUSES,
  unarchiveRequest,
  type EditorialRequest,
  type EditorialRequestStore,
  type RequestStatus,
} from './store.js';

// ─── fixtures ────────────────────────────────────────────────────────────────

const iso = (n: number) => new Date(Date.UTC(2026, 7, 22, 12, 0, n)).toISOString();

const ID = 'req_agent_retinol_20260822_01';
const ID_B = 'req_agent_toner_20260822_01';
const ID_C = 'req_theme_autumn_20260822_01';

/** In-memory fake typed to the module's own minimal store interface. */
class FakeStore implements EditorialRequestStore {
  readonly map = new Map<string, string>();
  /** Every setJSON key, in write order — the doc-before-index assertions read this. */
  readonly writes: string[] = [];
  /** Return a string to serve a stale snapshot for a key; undefined falls through to the map. */
  getOverride?: (key: string) => string | undefined;
  /** Awaited before a setJSON lands — the concurrency fixture parks a writer here. */
  beforeSet?: (key: string) => Promise<void>;

  async get(key: string): Promise<string | null> {
    const overridden = this.getOverride?.(key);
    if (overridden !== undefined) return overridden;
    return this.map.get(key) ?? null;
  }

  async setJSON(key: string, value: unknown): Promise<void> {
    if (this.beforeSet) await this.beforeSet(key);
    this.writes.push(key);
    this.map.set(key, JSON.stringify(value));
  }

  async list({ prefix }: { prefix: string; directories?: boolean; paginate?: boolean }) {
    return { blobs: [...this.map.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
  }
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

/** The smallest doc the schema accepts — a doc written before ANY later optional field existed. */
const MINIMUM_LEGAL_DOC = {
  schema_version: 'editorial-request.v1',
  request_id: ID,
  kind: 'article',
  title: 'Retinol after 40',
  created_by: 'editor@example.com',
  created_at: iso(0),
  updated_at: iso(0),
  status: 'queued',
  chats: [],
  history: [],
} satisfies EditorialRequest;

const FULL_DOC = {
  schema_version: 'editorial-request.v1',
  request_id: ID,
  kind: 'article',
  title: 'Retinol after 40',
  brief_excerpt: 'A practical guide to starting retinol after forty.',
  created_by: 'editor@example.com',
  created_at: iso(0),
  updated_at: iso(5),
  status: 'stalled',
  status_reason: 'article_body failed (output_validation_failed)',
  workflow: {
    run_id: 'run_123',
    workflow_id: 'wf_publishing_conductor',
    project_id: 'proj_drlurie',
    node_total: 23,
    node_done: 19,
    node_failed: 1,
    current_node: 'Drafting the article body',
    stalled: true,
    approvals_required: [{ node_id: 'publication_controller', reason: 'approval_required', requested_at: iso(4) }],
    errors: ['article_body:output_validation_failed'],
    last_polled_at: iso(5),
    nudges: 2,
  },
  chats: [{ chat_id: `obj:${ID}`, kind: 'object', attached_at: iso(0) }],
  object: { object_type: 'content_item', object_id: ID },
  artifact_count: 3,
  archived_at: iso(6),
  archived_by: 'owner@example.com',
  history: [
    { at: iso(0), status: 'queued' },
    { at: iso(5), status: 'stalled', note: 'no dispatch heartbeat' },
  ],
} satisfies EditorialRequest;

const seedWorkflowRequest = (store: FakeStore, requestId = ID, at = iso(0)) =>
  createRequest(
    store,
    {
      request_id: requestId,
      kind: 'article',
      title: 'Retinol after 40',
      brief_excerpt: 'A practical guide.',
      created_by: 'editor@example.com',
      chat: { chat_id: `obj:${requestId}`, kind: 'object' },
      workflow: {
        run_id: 'run_123',
        workflow_id: 'wf_publishing_conductor',
        project_id: 'proj_drlurie',
        node_total: 23,
      },
      object: { object_type: 'content_item', object_id: requestId },
    },
    at
  );

// ─── schema ──────────────────────────────────────────────────────────────────

describe('editorial-request.v1 schema', () => {
  it('round-trips a full doc unchanged', () => {
    assert.deepEqual(editorialRequestSchema.parse(JSON.parse(JSON.stringify(FULL_DOC))), FULL_DOC);
  });

  it('parses the minimum legal doc unchanged — every optional field is genuinely schema-additive', () => {
    // A doc persisted before brief_excerpt/status_reason/workflow/object/
    // artifact_count/archived_* existed must still parse, and parsing must not
    // inject defaults the writer never wrote.
    assert.deepEqual(editorialRequestSchema.parse(JSON.parse(JSON.stringify(MINIMUM_LEGAL_DOC))), MINIMUM_LEGAL_DOC);
  });

  it('carries the exact status union, in order — sibling tasks depend on this literal set', () => {
    assert.deepEqual(
      [...requestStatusSchema.options],
      ['queued', 'running', 'needs_you', 'stalled', 'failed', 'done', 'cancelled', 'archived']
    );
  });

  it('partitions statuses into the terminal set and the sweeper-selectable complement', () => {
    assert.deepEqual([...TERMINAL_REQUEST_STATUSES], ['done', 'cancelled', 'archived']);
    assert.deepEqual([...NON_TERMINAL_REQUEST_STATUSES], ['queued', 'running', 'needs_you', 'stalled', 'failed']);
    assert.deepEqual(
      [...NON_TERMINAL_REQUEST_STATUSES, ...TERMINAL_REQUEST_STATUSES].sort(),
      [...requestStatusSchema.options].sort()
    );
  });

  it('REQUEST_ID_PATTERN accepts the minted shape and rejects everything else', () => {
    assert.ok(REQUEST_ID_PATTERN.test('req_agent_retinol_20260822_01'));
    assert.ok(REQUEST_ID_PATTERN.test('req_theme_autumn_refresh_20260901_07'));
    assert.ok(!REQUEST_ID_PATTERN.test('req_agent_retinol_20260822'));
    assert.ok(!REQUEST_ID_PATTERN.test('req_Agent_retinol_20260822_01'));
    assert.ok(!REQUEST_ID_PATTERN.test('agent_retinol_20260822_01'));
  });

  it('escapes blob keys the chatDocKey way', () => {
    assert.equal(requestDocKey(ID), `requests/by-id/${ID}.json`);
    assert.equal(requestDocKey('obj:weird'), 'requests/by-id/obj__weird.json');
  });
});

// ─── projectIndexRow ─────────────────────────────────────────────────────────

describe('projectIndexRow', () => {
  it('emits exactly the closed row field set for a full doc — a new doc field cannot silently widen the index', () => {
    const row = projectIndexRow(FULL_DOC);
    assert.deepEqual(Object.keys(row).sort(), [
      'archived',
      'chat_id',
      'created_by',
      'current_node',
      'kind',
      'object_id',
      'object_published',
      'progress',
      'request_id',
      'status',
      'status_reason',
      'title',
      'updated_at',
    ]);
    assert.deepEqual(row.progress, { done: 19, total: 23 });
    assert.equal(row.current_node, 'Drafting the article body');
    assert.equal(row.object_id, ID);
    assert.equal(row.archived, false);
    // C1: an object with no publication evidence on it is NOT published, and
    // has no live path — the row says so rather than leaving it unknown.
    assert.equal(row.object_published, false);
    assert.equal('live_path' in row, false);
  });

  it('emits only the required fields for the minimum doc', () => {
    const row = projectIndexRow(MINIMUM_LEGAL_DOC);
    assert.deepEqual(Object.keys(row).sort(), [
      'archived',
      'created_by',
      'kind',
      // C1: `object_published` is REQUIRED on a row — a doc with no object at
      // all still answers the question, with `false`.
      'object_published',
      'request_id',
      'status',
      'title',
      'updated_at',
    ]);
    assert.equal(row.object_published, false);
  });

  it('picks the most recently attached chat and derives archived from status', () => {
    const doc: EditorialRequest = {
      ...MINIMUM_LEGAL_DOC,
      status: 'archived',
      chats: [
        { chat_id: 'chat_old', kind: 'free', attached_at: iso(1) },
        { chat_id: 'chat_new', kind: 'object', attached_at: iso(2) },
      ],
    };
    const row = projectIndexRow(doc);
    assert.equal(row.chat_id, 'chat_new');
    assert.equal(row.archived, true);
  });
});

// ─── C1: the row carries the object's publication truth ─────────────────────

/**
 * The bug C1 fixes: `rowActions` has read `object_published` since B1 and
 * NOTHING ever supplied it, so a finished, published article always took the
 * unpublished branch. These three prove the field is real, that it is only
 * ever true with evidence behind it, and that adding it did not break the
 * index blobs already in the store.
 */
describe('C1 — object_published and live_path on the index row', () => {
  const publishedDoc = (object: EditorialRequest['object']): EditorialRequest => ({
    ...MINIMUM_LEGAL_DOC,
    status: 'done',
    ...(object ? { object } : {}),
  });

  it('projects a confirmed go-live as published, with its path', () => {
    const row = projectIndexRow(
      publishedDoc({ object_type: 'content_item', object_id: ID, published: true, live_path: '/retinol-after-40' })
    );
    assert.equal(row.object_published, true);
    assert.equal(row.live_path, '/retinol-after-40');
  });

  it('a published object with no confirmed URL is published WITHOUT a live path', () => {
    const row = projectIndexRow(publishedDoc({ object_type: 'content_item', object_id: ID, published: true }));
    assert.equal(row.object_published, true);
    assert.equal('live_path' in row, false, 'a path the release never confirmed is not a live URL');
  });

  it('an object with no publication evidence is not published — never "probably" (guardrail 5)', () => {
    assert.equal(projectIndexRow(publishedDoc({ object_type: 'content_item', object_id: ID })).object_published, false);
    assert.equal(projectIndexRow(publishedDoc(undefined)).object_published, false);
  });

  it('round-trips a projected row through the row schema unchanged', () => {
    for (const doc of [
      FULL_DOC as EditorialRequest,
      MINIMUM_LEGAL_DOC as EditorialRequest,
      publishedDoc({ object_type: 'content_item', object_id: ID, published: true, live_path: '/retinol-after-40' }),
    ]) {
      const row = projectIndexRow(doc);
      assert.deepEqual(requestIndexRowSchema.parse(JSON.parse(JSON.stringify(row))), row);
    }
  });

  /**
   * The migration, stated as a test. An index blob written before C1 has no
   * `object_published` key at all; it must still PARSE, because `loadIndex`
   * answering `undefined` would make the next `commitRequest` write a fresh
   * index holding one row and silently drop every other request.
   */
  it('an index blob written before C1 still parses, and reads as not published', async () => {
    const store = new FakeStore();
    const legacyRow = {
      request_id: ID,
      kind: 'article',
      title: 'Retinol after 40',
      status: 'done',
      created_by: 'editor@example.com',
      updated_at: iso(0),
      object_id: ID,
      archived: false,
    };
    await store.setJSON(REQUEST_INDEX_KEY, {
      schema_version: REQUEST_INDEX_SCHEMA_VERSION,
      seq: 7,
      updated_at: iso(0),
      rows: [legacyRow],
    });

    const index = await loadIndex(store);
    assert.ok(index, 'a pre-C1 index must not be thrown away — see commitRequest');
    assert.equal(index.rows[0]?.object_published, false);
    assert.equal(index.seq, 7, 'no rebuild, so no seq churn');
    // …and the schema version did NOT have to move for that to hold.
    assert.equal(REQUEST_INDEX_SCHEMA_VERSION, 'editorial-request-index.v1');
    assert.equal(requestIndexSchema.safeParse(JSON.parse(store.map.get(REQUEST_INDEX_KEY)!)).success, true);
  });
});

// ─── FIX 6: two doors on `doc.object`, and they cannot both be open ─────────

/**
 * `reconcileObject` (the read path, `admin-requests.ts`) documented itself as
 * safe because `recordObject` "runs only while a request is still sweepable".
 * That was a comment, not code: `recordObject` had no guard, and `sweepRequest`
 * called it AFTER the write that made the doc `done` — so on the finishing pass
 * both writers were live on the same doc with no compare-and-set beneath them,
 * and a stale read in one could erase what the other had just recorded. The
 * guards are now mutual, and this pins the partition.
 */
describe('FIX 6 — recordObject and reconcileObject own disjoint halves of the status space', () => {
  const object = { object_type: 'content_item', object_id: ID };
  /**
   * Straight onto the blob: `cancelled`/`archived` have their own writers and
   * `setStatus` refuses them by design, and this test is about the guards, not
   * about how a status is reached.
   */
  const forceStatus = async (store: FakeStore, status: RequestStatus) => {
    const doc = JSON.parse(store.map.get(requestDocKey(ID))!) as EditorialRequest;
    await store.setJSON(requestDocKey(ID), { ...doc, status });
  };

  it('recordObject writes on every NON-terminal status and refuses every terminal one', async () => {
    for (const status of NON_TERMINAL_REQUEST_STATUSES) {
      const store = new FakeStore();
      await seedWorkflowRequest(store);
      if (status !== 'queued') await setStatus(store, ID, { status }, iso(1));
      const doc = await recordObject(store, ID, object, iso(2));
      assert.equal(doc?.object?.object_id, ID, status);
    }
    for (const status of TERMINAL_REQUEST_STATUSES) {
      const store = new FakeStore();
      await seedWorkflowRequest(store);
      await forceStatus(store, status);
      const writesBefore = store.writes.length;
      assert.equal((await recordObject(store, ID, object, iso(3)))?.object, undefined, status);
      assert.equal(store.writes.length, writesBefore, `${status}: and nothing was written`);
    }
  });

  it('reconcileObject is the exact mirror — terminal only', async () => {
    for (const status of NON_TERMINAL_REQUEST_STATUSES) {
      const store = new FakeStore();
      await seedWorkflowRequest(store);
      if (status !== 'queued') await setStatus(store, ID, { status }, iso(1));
      assert.equal((await reconcileObject(store, ID, object, iso(2)))?.object, undefined, status);
    }
    for (const status of TERMINAL_REQUEST_STATUSES) {
      const store = new FakeStore();
      await seedWorkflowRequest(store);
      await forceStatus(store, status);
      assert.equal((await reconcileObject(store, ID, object, iso(3)))?.object?.object_id, ID, status);
    }
  });

  it('so no status admits both writers — the invariant the comment used to only assert', async () => {
    for (const status of [...NON_TERMINAL_REQUEST_STATUSES, ...TERMINAL_REQUEST_STATUSES]) {
      const store = new FakeStore();
      await seedWorkflowRequest(store);
      if (status !== 'queued') await forceStatus(store, status);
      const viaRecord = (await recordObject(store, ID, object, iso(2)))?.object !== undefined;
      const store2 = new FakeStore();
      await seedWorkflowRequest(store2);
      if (status !== 'queued') await forceStatus(store2, status);
      const viaReconcile = (await reconcileObject(store2, ID, object, iso(2)))?.object !== undefined;
      assert.notEqual(viaRecord, viaReconcile, `${status}: exactly one door is open`);
    }
  });
});

describe('C1 — recordPublication', () => {
  // `createRequest`'s `object` input is never persisted (it has been a dead
  // field since T19.1 — `recordObject` is the only writer), so the object is
  // recorded the way the sweeper records it.
  const seedDone = async (store: FakeStore) => {
    await seedWorkflowRequest(store);
    await recordObject(store, ID, { object_type: 'content_item', object_id: ID }, iso(1));
    await setStatus(store, ID, { status: 'done' }, iso(2));
  };

  it('records the publish and the confirmed path, and reaches the index row', async () => {
    const store = new FakeStore();
    await seedDone(store);
    await recordPublication(store, ID, { live_path: '/retinol-after-40' }, iso(2));

    const doc = await loadRequest(store, ID);
    assert.equal(doc?.object?.published, true);
    assert.equal(doc?.object?.live_path, '/retinol-after-40');
    const row = (await loadIndex(store))!.rows.find((entry) => entry.request_id === ID);
    assert.equal(row?.object_published, true);
    assert.equal(row?.live_path, '/retinol-after-40');
  });

  it('is idempotent: a second pass with nothing new writes nothing', async () => {
    const store = new FakeStore();
    await seedDone(store);
    await recordPublication(store, ID, { live_path: '/retinol-after-40' }, iso(2));
    const before = store.writes.length;
    await recordPublication(store, ID, { live_path: '/retinol-after-40' }, iso(3));
    await recordPublication(store, ID, {}, iso(4));
    assert.equal(store.writes.length, before, 'the sweeper calls this every pass — it must not churn the blob');
  });

  it('upgrades a publish that later confirms its go-live', async () => {
    const store = new FakeStore();
    await seedDone(store);
    await recordPublication(store, ID, {}, iso(2));
    assert.equal((await loadRequest(store, ID))?.object?.published, true);
    assert.equal((await loadRequest(store, ID))?.object?.live_path, undefined);
    await recordPublication(store, ID, { live_path: '/retinol-after-40' }, iso(3));
    assert.equal((await loadRequest(store, ID))?.object?.live_path, '/retinol-after-40');
  });

  it('never claims publication for an object that was never recorded', async () => {
    const store = new FakeStore();
    await createRequest(
      store,
      { request_id: ID_B, kind: 'article', title: 'No object', created_by: 'editor@example.com' },
      iso(0)
    );
    const before = store.writes.length;
    const doc = await recordPublication(store, ID_B, { live_path: '/nope' }, iso(1));
    assert.equal(doc?.object, undefined);
    assert.equal(store.writes.length, before);
    // …and once an object IS recorded, the same call lands.
    await recordObject(store, ID_B, { object_type: 'content_item', object_id: ID_B }, iso(2));
    await recordPublication(store, ID_B, { live_path: '/nope' }, iso(3));
    assert.equal((await loadRequest(store, ID_B))?.object?.published, true);
  });
});

// ─── writers keep the index in lockstep ──────────────────────────────────────

describe('index lockstep across every writer', () => {
  it('after each of the seven writers, the index row equals projectIndexRow(doc), doc written before index, seq monotonic', async () => {
    const store = new FakeStore();
    const steps: Array<{ name: string; run: () => Promise<unknown> }> = [
      { name: 'createRequest', run: () => seedWorkflowRequest(store) },
      { name: 'attachChat', run: () => attachChat(store, ID, { chat_id: 'chat_followup', kind: 'free' }, iso(1)) },
      {
        name: 'recordProgress',
        run: () =>
          recordProgress(
            store,
            ID,
            { node_total: 23, node_done: 3, node_failed: 0, stalled: false, current_node: 'research' },
            iso(2)
          ),
      },
      { name: 'setStatus', run: () => setStatus(store, ID, { status: 'running' }, iso(3)) },
      { name: 'cancelRequest', run: () => cancelRequest(store, ID, { by: 'editor@example.com' }, iso(4)) },
      { name: 'archiveRequest', run: () => archiveRequest(store, ID, 'owner@example.com', iso(5)) },
      { name: 'unarchiveRequest', run: () => unarchiveRequest(store, ID, 'owner@example.com', iso(6)) },
    ];

    let lastSeq = 0;
    for (const step of steps) {
      const writesBefore = store.writes.length;
      await step.run();
      assert.deepEqual(
        store.writes.slice(writesBefore),
        [requestDocKey(ID), REQUEST_INDEX_KEY],
        `${step.name} must write the doc first, then the index, in the same call`
      );
      const doc = await loadRequest(store, ID);
      assert.ok(doc, `${step.name} lost the doc`);
      const index = await loadIndex(store);
      assert.ok(index, `${step.name} lost the index`);
      assert.deepEqual(
        index.rows.find((row) => row.request_id === ID),
        projectIndexRow(doc),
        `${step.name} left the index row out of lockstep with the doc`
      );
      assert.ok(index.seq > lastSeq, `${step.name} did not advance seq`);
      lastSeq = index.seq;
    }

    // The full pass ends where the transitions say it should.
    const doc = await loadRequest(store, ID);
    assert.equal(doc?.status, 'cancelled'); // unarchive restored the pre-archive status from history
    assert.equal(doc?.archived_at, undefined);
    assert.equal(doc?.archived_by, undefined);
    assert.deepEqual(
      doc?.chats.map((chat) => chat.chat_id),
      [`obj:${ID}`, 'chat_followup']
    );
  });
});

// ─── rebuildIndex ────────────────────────────────────────────────────────────

describe('rebuildIndex', () => {
  it('reproduces the incrementally-maintained rows from the per-id docs, skipping unparseable blobs', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store, ID, iso(0));
    await seedWorkflowRequest(store, ID_B, iso(1));
    await createRequest(
      store,
      { request_id: ID_C, kind: 'theme', title: 'Autumn refresh', created_by: 'owner@example.com' },
      iso(2)
    );
    await setStatus(store, ID_B, { status: 'running' }, iso(3));
    await cancelRequest(store, ID_C, { by: 'owner@example.com', reason: 'Changed our minds.' }, iso(4));

    const live = await loadIndex(store);
    assert.ok(live);

    // Hand-build the expectation straight from the docs: newest updated_at first.
    const docA = await loadRequest(store, ID);
    const docB = await loadRequest(store, ID_B);
    const docC = await loadRequest(store, ID_C);
    const expectedRows = [projectIndexRow(docC!), projectIndexRow(docB!), projectIndexRow(docA!)];
    assert.deepEqual(live.rows, expectedRows);

    // Nuke the index, plant garbage under the prefix, rebuild.
    store.map.delete(REQUEST_INDEX_KEY);
    store.map.set('requests/by-id/req_broken_20260822_01.json', 'not json at all');
    store.map.set('requests/by-id/req_wrong_20260822_01.json', JSON.stringify({ schema_version: 'other.v1' }));

    const rebuilt = await rebuildIndex(store, iso(5));
    assert.deepEqual(rebuilt.rows, expectedRows);
    assert.equal(rebuilt.seq, 1); // index was absent → the counter restarts
    assert.deepEqual(await loadIndex(store), rebuilt);

    // Idempotent over content: a second rebuild yields the same rows.
    const again = await rebuildIndex(store, iso(6));
    assert.deepEqual(again.rows, expectedRows);
    assert.equal(again.seq, 2);

    // listRequestDocs (the O(N) path rebuild uses) skipped the garbage too.
    const docs = await listRequestDocs(store);
    assert.deepEqual(
      docs.map((doc) => doc.request_id),
      [ID_C, ID_B, ID]
    );
  });

  it('loadIndex returns undefined for an absent or corrupt index — the caller decides whether to rebuild', async () => {
    const store = new FakeStore();
    assert.equal(await loadIndex(store), undefined);
    store.map.set(REQUEST_INDEX_KEY, 'not json');
    assert.equal(await loadIndex(store), undefined);
    store.map.set(REQUEST_INDEX_KEY, JSON.stringify({ schema_version: 'other.v1' }));
    assert.equal(await loadIndex(store), undefined);
  });
});

// ─── out-of-order / illegal transitions are no-ops ───────────────────────────

describe('out-of-order and illegal transitions', () => {
  const assertNoOp = async (
    store: FakeStore,
    before: EditorialRequest,
    run: () => Promise<EditorialRequest | undefined>,
    label: string
  ) => {
    const writesBefore = store.writes.length;
    const indexBefore = await loadIndex(store);
    const result = await run();
    assert.deepEqual(result, before, `${label}: must return the current doc unchanged (updated_at included)`);
    assert.deepEqual(await loadRequest(store, before.request_id), before, `${label}: must not write the doc`);
    assert.equal(store.writes.length, writesBefore, `${label}: must not write anything`);
    assert.deepEqual(await loadIndex(store), indexBefore, `${label}: must not touch the index`);
  };

  it('sweeper writes against an archived or cancelled doc change nothing', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await archiveRequest(store, ID, 'owner@example.com', iso(1));
    const archived = (await loadRequest(store, ID))!;
    await assertNoOp(
      store,
      archived,
      () => setStatus(store, ID, { status: 'running' }, iso(2)),
      'setStatus on archived'
    );
    await assertNoOp(
      store,
      archived,
      () => recordProgress(store, ID, { node_total: 23, node_done: 9, node_failed: 0, stalled: false }, iso(2)),
      'recordProgress on archived'
    );

    const storeB = new FakeStore();
    await seedWorkflowRequest(storeB);
    await cancelRequest(storeB, ID, { by: 'editor@example.com' }, iso(1));
    const cancelled = (await loadRequest(storeB, ID))!;
    await assertNoOp(
      storeB,
      cancelled,
      () => setStatus(storeB, ID, { status: 'failed', status_reason: 'model_error' }, iso(2)),
      'setStatus on cancelled'
    );
    await assertNoOp(
      storeB,
      cancelled,
      () => recordProgress(storeB, ID, { node_total: 23, node_done: 9, node_failed: 0, stalled: false }, iso(2)),
      'recordProgress on cancelled'
    );
  });

  it('setStatus cannot smuggle a human-owned status past the type guard', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    const before = (await loadRequest(store, ID))!;
    await assertNoOp(
      store,
      before,
      () => setStatus(store, ID, { status: 'cancelled' as never }, iso(1)),
      'setStatus(cancelled)'
    );
    await assertNoOp(
      store,
      before,
      () => setStatus(store, ID, { status: 'archived' as never }, iso(1)),
      'setStatus(archived)'
    );
  });

  it('setStatus that changes nothing writes nothing', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    const before = (await loadRequest(store, ID))!;
    await assertNoOp(store, before, () => setStatus(store, ID, { status: 'running' }, iso(2)), 'identical setStatus');
  });

  it('recordProgress on a doc with no workflow block is a no-op', async () => {
    const store = new FakeStore();
    await createRequest(
      store,
      { request_id: ID_C, kind: 'theme', title: 'Autumn', created_by: 'o@example.com' },
      iso(0)
    );
    const before = (await loadRequest(store, ID_C))!;
    await assertNoOp(
      store,
      before,
      () => recordProgress(store, ID_C, { node_total: 1, node_done: 0, node_failed: 0, stalled: false }, iso(1)),
      'recordProgress without workflow'
    );
  });

  it('attachChat for a chat already attached is a no-op', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    const before = (await loadRequest(store, ID))!;
    await assertNoOp(
      store,
      before,
      () => attachChat(store, ID, { chat_id: `obj:${ID}`, kind: 'object' }, iso(1)),
      'duplicate attachChat'
    );
  });

  it('archive on archived, unarchive on non-archived, cancel on any terminal doc — all no-ops', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    const active = (await loadRequest(store, ID))!;
    await assertNoOp(store, active, () => unarchiveRequest(store, ID, 'owner@example.com', iso(1)), 'unarchive active');

    await archiveRequest(store, ID, 'owner@example.com', iso(2));
    const archived = (await loadRequest(store, ID))!;
    await assertNoOp(store, archived, () => archiveRequest(store, ID, 'owner@example.com', iso(3)), 're-archive');
    await assertNoOp(
      store,
      archived,
      () => cancelRequest(store, ID, { by: 'editor@example.com' }, iso(3)),
      'cancel archived'
    );

    const storeB = new FakeStore();
    await seedWorkflowRequest(storeB);
    await setStatus(storeB, ID, { status: 'done' }, iso(1));
    const done = (await loadRequest(storeB, ID))!;
    await assertNoOp(
      storeB,
      done,
      () => cancelRequest(storeB, ID, { by: 'editor@example.com' }, iso(2)),
      'cancel done'
    );
    await cancelRequest(storeB, ID_B, { by: 'x' }, iso(2)); // absent doc → undefined, no write
    assert.equal(await loadRequest(storeB, ID_B), undefined);
  });

  it('createRequest for an existing id returns the existing doc untouched — a retried tool call never clobbers', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    const before = (await loadRequest(store, ID))!;
    await assertNoOp(
      store,
      before,
      () =>
        createRequest(
          store,
          { request_id: ID, kind: 'article', title: 'A DIFFERENT title', created_by: 'someone@else.com' },
          iso(2)
        ),
      'duplicate createRequest'
    );
  });

  it('writers against a missing doc return undefined without writing', async () => {
    const store = new FakeStore();
    assert.equal(await setStatus(store, ID, { status: 'running' }, iso(0)), undefined);
    assert.equal(
      await recordProgress(store, ID, { node_total: 1, node_done: 0, node_failed: 0, stalled: false }, iso(0)),
      undefined
    );
    assert.equal(await attachChat(store, ID, { chat_id: 'c', kind: 'free' }, iso(0)), undefined);
    assert.equal(await archiveRequest(store, ID, 'o@example.com', iso(0)), undefined);
    assert.equal(await unarchiveRequest(store, ID, 'o@example.com', iso(0)), undefined);
    assert.equal(await cancelRequest(store, ID, { by: 'o@example.com' }, iso(0)), undefined);
    assert.equal(store.writes.length, 0);
  });
});

// ─── history ─────────────────────────────────────────────────────────────────

describe('history', () => {
  it('is bounded to 50 entries, drop-oldest', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store); // history: [queued]
    const flips: RequestStatus[] = ['running', 'stalled'];
    for (let i = 0; i < 60; i += 1) {
      await setStatus(
        store,
        ID,
        { status: flips[i % 2] as 'running' | 'stalled', status_reason: `flip ${i}` },
        iso(i + 1)
      );
    }
    const doc = (await loadRequest(store, ID))!;
    assert.equal(doc.history.length, HISTORY_MAX);
    // 61 entries were appended (create + 60 flips); the oldest 11 dropped.
    assert.equal(doc.history[0]?.note, 'flip 10');
    assert.equal(doc.history[HISTORY_MAX - 1]?.note, 'flip 59');
    assert.ok(!doc.history.some((entry) => entry.status === 'queued'), 'the create entry was dropped first');
  });

  it('recordProgress appends history only when progress content changed; the heartbeat still persists last_polled_at', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    const patch = { node_total: 23, node_done: 3, node_failed: 0, stalled: false, current_node: 'research' };
    await recordProgress(store, ID, patch, iso(1));
    const afterChange = (await loadRequest(store, ID))!;
    assert.equal(afterChange.history[afterChange.history.length - 1]?.note, 'progress 3/23 · research');
    assert.equal(afterChange.updated_at, iso(1));

    // Same snapshot again: a pure poll heartbeat. The doc IS written (stall
    // detection needs last_polled_at persisted) but updated_at and history
    // must NOT move — §5.2's updated_at-based stall input depends on it.
    const writesBefore = store.writes.length;
    await recordProgress(store, ID, patch, iso(2));
    const afterHeartbeat = (await loadRequest(store, ID))!;
    assert.equal(afterHeartbeat.workflow?.last_polled_at, iso(2));
    assert.equal(afterHeartbeat.updated_at, iso(1));
    assert.deepEqual(afterHeartbeat.history, afterChange.history);
    assert.equal(store.writes.length, writesBefore + 2);
  });

  it('brief_excerpt is truncated to 240 chars at create', async () => {
    const store = new FakeStore();
    await createRequest(
      store,
      { request_id: ID, kind: 'article', title: 'T', created_by: 'e@example.com', brief_excerpt: 'x'.repeat(500) },
      iso(0)
    );
    assert.equal((await loadRequest(store, ID))?.brief_excerpt?.length, 240);
  });
});

// ─── concurrency ─────────────────────────────────────────────────────────────

describe('concurrency without compare-and-swap', () => {
  // What this design GUARANTEES and what it cannot, stated plainly:
  //
  //   GUARANTEED — a writer that reads the CURRENT doc applies the transition
  //   guards, so an out-of-order write that can see the truth (the common race:
  //   the sweeper's 5-minute pass landing after a human archive) is inert.
  //   GUARANTEED — every commit writes the doc first and derives the index row
  //   from those exact bytes, and rebuildIndex re-converges the index from the
  //   docs at any time.
  //   NOT GUARANTEED — Netlify Blobs has no compare-and-swap, so two writers
  //   whose load→write windows overlap can still lose one update (last setJSON
  //   wins), and interleaved index writes can leave the index transiently
  //   behind the docs. The §3.4 single-writer-per-transition assignment makes
  //   overlap rare and strong consistency makes the window one read-modify-
  //   write wide, but nothing at this layer can close it. Do not build
  //   anything downstream that assumes it is closed.

  it('the guarded race: a sweeper write that reads the fresh archived doc is inert', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await archiveRequest(store, ID, 'owner@example.com', iso(1));
    const archived = (await loadRequest(store, ID))!;
    const seqBefore = (await loadIndex(store))!.seq;

    const result = await setStatus(store, ID, { status: 'running' }, iso(2));
    assert.deepEqual(result, archived);
    assert.equal((await loadRequest(store, ID))!.status, 'archived');
    assert.equal((await loadIndex(store))!.seq, seqBefore);
  });

  it('the unguarded race: a stale snapshot CAN clobber, the index CAN trail — and rebuildIndex re-converges', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    const staleRaw = store.map.get(requestDocKey(ID))!; // snapshot BEFORE the archive lands

    // Park the archive between its doc write and its index write.
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let held = false;
    store.beforeSet = async (key) => {
      if (key === REQUEST_INDEX_KEY && !held) {
        held = true;
        await gate;
      }
    };
    const archivePromise = archiveRequest(store, ID, 'owner@example.com', iso(2));
    await tick(); // the archive has written the doc and is parked before its index write
    store.beforeSet = undefined;

    // A sweeper whose read raced the archive: its get() serves the pre-archive
    // snapshot, so the guard cannot see 'archived' and the write goes through.
    store.getOverride = (key) => (key === requestDocKey(ID) ? staleRaw : undefined);
    await setStatus(store, ID, { status: 'stalled', status_reason: 'No dispatch heartbeat for 10 minutes.' }, iso(3));
    store.getOverride = undefined;

    release();
    await archivePromise;

    // The honest outcome: the sweeper's doc write landed after the archive's,
    // so the archive is LOST on the doc…
    const doc = (await loadRequest(store, ID))!;
    assert.equal(doc.status, 'stalled');
    // …and the archive's parked index write landed after the sweeper's, so the
    // index trails the docs — doc↔index lockstep does NOT survive interleaving.
    const index = (await loadIndex(store))!;
    assert.equal(index.rows.find((row) => row.request_id === ID)?.status, 'archived');

    // The guarantee that DOES hold: one rebuild puts the index back in
    // lockstep with whatever the docs actually say.
    const rebuilt = await rebuildIndex(store, iso(4));
    assert.deepEqual(rebuilt.rows, [projectIndexRow(doc)]);
    assert.deepEqual((await loadIndex(store))!.rows, [projectIndexRow(doc)]);
  });
});

// ─── retry ───────────────────────────────────────────────────────────────────

describe('requeueRequest — what "Retry" actually does', () => {
  const stall = async (store: FakeStore) => {
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    await recordProgress(
      store,
      ID,
      { node_total: 23, node_done: 19, node_failed: 0, stalled: true, nudges: 3 },
      iso(2)
    );
    await setStatus(store, ID, { status: 'stalled', status_reason: 'no dispatch heartbeat' }, iso(3));
  };

  it('puts a stalled run back in the sweeper\u2019s way, and clears the nudge count with it', async () => {
    const store = new FakeStore();
    await stall(store);

    const result = await requeueRequest(store, ID, iso(4));
    assert.equal(result.ok, true);
    const doc = await loadRequest(store, ID);
    assert.equal(doc?.status, 'queued', 'a retry that leaves the row stalled is a button that lies');
    assert.equal(doc?.workflow?.nudges, 0, 'the nudge budget is what stalled it; retrying must restore it');
    assert.equal(doc?.workflow?.stalled, false);
    assert.equal(doc?.history.at(-1)?.status, 'queued');
    assert.equal((await loadIndex(store))?.rows.find((r) => r.request_id === ID)?.status, 'queued');
  });

  it('refuses a request that is already over — there is nothing left to push', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    await setStatus(store, ID, { status: 'done' }, iso(2));

    const result = await requeueRequest(store, ID, iso(3));
    assert.equal(result.ok, false);
    assert.equal((await loadRequest(store, ID))?.status, 'done', 'a finished job is not reopened by a retry');
  });

  it('refuses a request that is waiting on a HUMAN — retrying would not open that gate', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));
    await setStatus(store, ID, { status: 'needs_you', status_reason: 'Publication needs your approval.' }, iso(2));

    const result = await requeueRequest(store, ID, iso(3));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /human decision/i);
    assert.equal((await loadRequest(store, ID))?.status, 'needs_you');
  });

  it('refuses a request that is still MOVING — the sweeper owns that row', async () => {
    const store = new FakeStore();
    await seedWorkflowRequest(store);
    await setStatus(store, ID, { status: 'running' }, iso(1));

    const result = await requeueRequest(store, ID, iso(2));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /has not stopped/i);
    assert.equal((await loadRequest(store, ID))?.status, 'running', 'a human write here can lose the sweeper\u2019s');
  });

  it('refuses when there is no run behind the row at all', async () => {
    const store = new FakeStore();
    await createRequest(
      store,
      { request_id: ID_B, kind: 'article', title: 'No run', created_by: 'editor@example.com' },
      iso(0)
    );
    await setStatus(store, ID_B, { status: 'failed', status_reason: 'nothing ever dispatched' }, iso(1));
    const result = await requeueRequest(store, ID_B, iso(2));
    assert.equal(result.ok, false);
    assert.match(result.ok === false ? result.reason : '', /no workflow run/i);
  });

  it('reports a request that does not exist rather than inventing one', async () => {
    const result = await requeueRequest(new FakeStore(), ID_C, iso(0));
    assert.equal(result.ok, false);
  });
});
