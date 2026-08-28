import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { materialize } from '../../packages/core/server/lib/materialize.js';
import { publishObject, type PublishObjectDeps } from '../../packages/core/server/lib/object-publish.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { objectVerbRequestSchema } from '../../packages/core/server/lib/object-verbs.js';
import {
  publishReceiptSchema,
  type ObjectRecord,
  type Principal,
  type ProducerContext,
} from '../../packages/core/schema/object-record-v1.js';

const NOW = Date.parse('2026-07-04T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const PUBLISHED_TIME = '2026-07-04T11:59:00.000Z';

const actor: Principal = { kind: 'human', id: 'u1', email: 'wolf@example.com' };
const producer: ProducerContext = {
  run_id: 'run_publish_article_20260828_01',
  node_id: 'node_publish',
  prompt_version: 'publisher.v7',
  model: 'gpt-5.6-sol',
};
const LOCK = {
  token: 'tok1',
  owner_id: 'u1',
  owner_label: 'wolf@example.com',
  acquired_at: iso(NOW - 60_000),
  expires_at: iso(NOW + 600_000),
};

const navRecord = (): ObjectRecord => ({
  object_id: 'nav_footer',
  object_type: 'navigation',
  schema_version: 'navigation.v1',
  site: 'site_drlurie',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  status: 'active',
  body: {
    role: 'footer',
    groups: [
      {
        id: 'g_primary',
        items: [
          { id: 'n_privacy', label: 'Privacy', target: { kind: 'external', href: 'https://drlurie.com/privacy' } },
        ],
      },
    ],
  },
  publication: { published_time: null },
  lock: { ...LOCK },
  history: [{ at: '2026-07-01T00:00:00.000Z', action: 'object_create', actor }],
  version: 5,
  content_revision: 2,
});

const expectedExport = () =>
  materialize('navigation', 'nav_footer', navRecord().body, {
    at: PUBLISHED_TIME,
    record_version: 5,
    exportRoot: 'sites/drlurie/data/site',
  });

// ─── git-faithful GitHub API mock ────────────────────────────────────────────
// Tree shas are content-addressed over the RESULTING tree (base + entries
// applied), like real git: re-applying identical content onto a head that
// already carries it yields the head's own tree sha, which is exactly the
// signal the T1.2 no-op check reads. Blob contents are retained so tests can
// assert the bytes committed at head.

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');
const jsonResponse = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

type PublishEvent = { kind: 'github'; method: string; path: string } | { kind: 'store_set'; key: string };
type RefPatchOutcome = 'ok' | { status: number; body: string };

const createGitHubApiMock = (events: PublishEvent[], options: { refPatchOutcomes?: RefPatchOutcome[] } = {}) => {
  const blobs = new Map<string, string>();
  const trees = new Map<string, Map<string, string>>([['tree0', new Map()]]);
  const commitTrees = new Map<string, string>([['head0', 'tree0']]);
  const commitMessages: string[] = [];
  let head = { sha: 'head0', treeSha: 'tree0' };
  const patchOutcomes = [...(options.refPatchOutcomes ?? [])];
  let commitCounter = 0;

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    events.push({ kind: 'github', method, path: url.pathname });

    if (method === 'GET' && url.pathname.includes('/git/ref/heads/')) {
      return jsonResponse({ object: { sha: head.sha } });
    }
    if (method === 'GET' && url.pathname.includes('/git/commits/')) {
      const sha = url.pathname.split('/').pop() as string;
      return jsonResponse({ tree: { sha: commitTrees.get(sha) } });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/blobs')) {
      const sha = sha1(String(body?.content));
      blobs.set(sha, String(body?.content));
      return jsonResponse({ sha });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/trees')) {
      const base = trees.get(String(body?.base_tree)) ?? new Map<string, string>();
      const next = new Map(base);
      for (const entry of body?.tree as Array<{ path: string; sha: string }>) next.set(entry.path, entry.sha);
      const sha = `tree_${sha1(JSON.stringify([...next.entries()].sort()))}`;
      trees.set(sha, next);
      // Real-git behavior the no-op check depends on: an unchanged tree
      // hashes to the base's sha. Preserve the base's name for equality.
      const unchanged = [...next.entries()].sort().join('|') === [...base.entries()].sort().join('|');
      return jsonResponse({ sha: unchanged ? String(body?.base_tree) : sha });
    }
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) {
      commitCounter += 1;
      const sha = `commit${commitCounter}`;
      commitTrees.set(sha, String(body?.tree));
      commitMessages.push(String(body?.message));
      return jsonResponse({ sha });
    }
    if (method === 'PATCH' && url.pathname.includes('/git/refs/heads/')) {
      const outcome = patchOutcomes.length ? (patchOutcomes.shift() as RefPatchOutcome) : 'ok';
      if (outcome === 'ok') {
        head = { sha: String(body?.sha), treeSha: commitTrees.get(String(body?.sha)) as string };
        return jsonResponse({ object: { sha: head.sha } });
      }
      return new Response(outcome.body, { status: outcome.status });
    }
    return new Response(`unexpected ${method} ${url.pathname}`, { status: 500 });
  }) as typeof fetch;

  const readFileAtHead = (filePath: string): string | undefined => {
    const blobSha = trees.get(head.treeSha)?.get(filePath);
    return blobSha === undefined ? undefined : blobs.get(blobSha);
  };

  return { fetchImpl, getHead: () => head, readFileAtHead, commitMessages };
};

const createStore = (events: PublishEvent[], options: { failSetTimes?: number } = {}) => {
  const map = new Map<string, string>();
  let failRemaining = options.failSetTimes ?? 0;
  return {
    get: async (key: string) => map.get(key) ?? null,
    setJSON: async (key: string, value: unknown) => {
      events.push({ kind: 'store_set', key });
      if (failRemaining > 0) {
        failRemaining -= 1;
        throw new Error('blob store write failed (injected)');
      }
      map.set(key, JSON.stringify(value));
    },
    seed(record: ObjectRecord) {
      map.set(objectRecordKey(record.object_type, record.object_id), JSON.stringify(record));
    },
    read(record: Pick<ObjectRecord, 'object_type' | 'object_id'>): ObjectRecord {
      return JSON.parse(map.get(objectRecordKey(record.object_type, record.object_id)) as string) as ObjectRecord;
    },
  };
};

const ENV_KEYS = ['GITHUB_CONTENT_TOKEN', 'GITHUB_REPOSITORY', 'GITHUB_BRANCH', 'BRANCH'] as const;
const withGitHubEnv = async (fn: () => Promise<void>) => {
  const saved = ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.GITHUB_CONTENT_TOKEN = 'test-token';
  process.env.GITHUB_REPOSITORY = 'vreich-ui/dr-lurie-blog';
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

const publishNav = (
  store: { get: (key: string) => Promise<string | null>; setJSON: (key: string, value: unknown) => Promise<unknown> },
  fetchImpl: typeof fetch,
  overrides: Record<string, unknown> = {},
  deps: Partial<PublishObjectDeps> = {}
) =>
  publishObject(
    store,
    {
      object_type: 'navigation',
      object_id: 'nav_footer',
      published_time: PUBLISHED_TIME,
      lock_token: 'tok1',
      actor,
      ...overrides,
    },
    { nowMs: NOW, fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site', ...deps }
  );

test('the object export commit carries [skip netlify] so the push does not deploy', async () => {
  await withGitHubEnv(async () => {
    // Default message. (Fresh mock per case: a re-publish of identical content
    // no-ops in the committer and would mint no new commit to inspect.)
    const defaultEvents: PublishEvent[] = [];
    const defaultGitHub = createGitHubApiMock(defaultEvents);
    const defaultStore = createStore(defaultEvents);
    defaultStore.seed(navRecord());
    assert.equal((await publishNav(defaultStore, defaultGitHub.fetchImpl)).status, 200);
    assert.equal(defaultGitHub.commitMessages.at(-1), 'Publish navigation: nav_footer [skip netlify]');

    // A caller-supplied commit_message still gets the deferral marker appended.
    const customEvents: PublishEvent[] = [];
    const customGitHub = createGitHubApiMock(customEvents);
    const customStore = createStore(customEvents);
    customStore.seed(navRecord());
    assert.equal(
      (await publishNav(customStore, customGitHub.fetchImpl, { commit_message: 'publish nav_footer + nav_header' }))
        .status,
      200
    );
    assert.equal(customGitHub.commitMessages.at(-1), 'publish nav_footer + nav_header [skip netlify]');
  });
});

test('happy path: validates, materializes, commits, then stamps — in that order', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);
    store.seed(navRecord());

    const result = await publishNav(store, github.fetchImpl);

    assert.equal(result.status, 200);
    assert.equal(result.body.published_time, PUBLISHED_TIME);

    // Export-first ordering: every GitHub call precedes the record write.
    const firstStoreWrite = events.findIndex((event) => event.kind === 'store_set');
    const lastGitHubCall = events.map((event) => event.kind).lastIndexOf('github');
    assert.ok(firstStoreWrite > lastGitHubCall, 'the stamp write must come after the export commit');

    // The bytes at head are exactly T1.1's output for this body.
    const expected = expectedExport();
    assert.equal(github.readFileAtHead(expected.path), expected.content);

    const stored = store.read({ object_type: 'navigation', object_id: 'nav_footer' });
    assert.equal(stored.publication.published_time, PUBLISHED_TIME);
    assert.equal(stored.version, 6);
    assert.equal(stored.content_revision, 2, 'the stamp must never bump content_revision');
    assert.deepEqual(stored.lock, { ...LOCK }, 'the stamp write must preserve the lock');
    const lastHistory = stored.history[stored.history.length - 1];
    assert.equal(lastHistory.action, 'publish');
    assert.deepEqual(lastHistory.actor, actor);

    const receipt = stored.publication.publish_receipt as Record<string, unknown>;
    assert.equal(receipt.commit_sha, github.getHead().sha);
    assert.equal(receipt.no_op, false);
    assert.deepEqual(receipt.files, [expected.path]);
    assert.equal(receipt.content_revision, 2);
    assert.equal(receipt.exported_at, PUBLISHED_TIME);

    // The written receipt must conform to the tightened publishReceiptSchema
    // (one source of truth for consumers like the object inventory).
    const parsed = publishReceiptSchema.safeParse(receipt);
    assert.ok(parsed.success, JSON.stringify(parsed.success ? undefined : parsed.error.issues));
  });
});

test('producer context is strict and bounded when supplied to publish', () => {
  const base = {
    action: 'publish_by_time' as const,
    object_type: 'navigation' as const,
    object_id: 'nav_footer',
    lock_token: 'tok1',
  };
  assert.equal(objectVerbRequestSchema.safeParse({ ...base, producer }).success, true);
  assert.equal(objectVerbRequestSchema.safeParse({ ...base, producer: { ...producer, extra: 'no' } }).success, false);
  assert.equal(
    objectVerbRequestSchema.safeParse({ ...base, producer: { ...producer, model: 'x'.repeat(129) } }).success,
    false
  );
  const { model: _model, ...missingModel } = producer;
  assert.equal(objectVerbRequestSchema.safeParse({ ...base, producer: missingModel }).success, false);
});

test('publish stores producer in history and exports it with the published record version', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);
    store.seed(navRecord());

    const result = await publishNav(store, github.fetchImpl, { producer });
    assert.equal(result.status, 200);

    const stored = store.read({ object_type: 'navigation', object_id: 'nav_footer' });
    const lastHistory = stored.history.at(-1);
    assert.equal(lastHistory?.action, 'publish');
    assert.deepEqual(lastHistory?.details?.producer, producer);

    const exportPath = expectedExport().path;
    const parsed = JSON.parse(github.readFileAtHead(exportPath) as string) as {
      __generated: { record_version: number; producer?: ProducerContext };
    };
    assert.equal(parsed.__generated.record_version, navRecord().version);
    assert.deepEqual(parsed.__generated.producer, producer);
  });
});

test('failure point A: export commit fails → record byte-identical, unpublished, marked retryable', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const nonFF = { status: 422, body: 'Update is not a fast forward' };
    const github = createGitHubApiMock(events, { refPatchOutcomes: [nonFF, nonFF] });
    const store = createStore(events);
    store.seed(navRecord());

    const result = await publishNav(store, github.fetchImpl, {}, { maxAttempts: 2 });

    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'export_commit_failed');
    assert.equal(result.body.stage, 'export_commit');
    assert.equal(result.body.committer_code, 'non_fast_forward_exhausted');
    assert.equal(result.body.retryable, true);

    assert.equal(
      events.filter((event) => event.kind === 'store_set').length,
      0,
      'no record write of any kind may happen when the commit fails'
    );
    assert.deepEqual(store.read({ object_type: 'navigation', object_id: 'nav_footer' }), navRecord());
    assert.equal(github.getHead().sha, 'head0', 'the branch must be untouched');
  });
});

test('failure point B: stamp write fails → export fully committed and valid, record under-claims, reconciliation signalled', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events, { failSetTimes: 1 });
    store.seed(navRecord());

    const result = await publishNav(store, github.fetchImpl);

    assert.equal(result.status, 500);
    assert.equal(result.body.code, 'stamp_failed_export_committed');
    assert.equal(result.body.export_committed, true);
    assert.equal(result.body.reconciliation, 'retry_publish');
    assert.ok(result.body.receipt, 'the unwritable receipt must be surfaced for diagnostics');

    // The brief's ordering proof: with the stamp stubbed out (failing), the
    // committed export is complete and valid on its own.
    const expected = expectedExport();
    const committed = github.readFileAtHead(expected.path);
    assert.equal(committed, expected.content, 'the committed export must be byte-identical to T1.1 output');
    const parsed = JSON.parse(committed as string) as Record<string, unknown>;
    assert.deepEqual(parsed.__generated, {
      from: 'objects/navigation/by-id/nav_footer.json',
      at: PUBLISHED_TIME,
      record_version: 5,
    });
    assert.equal(github.getHead().sha, (result.body.receipt as Record<string, unknown>).commit_sha);

    // The record still says unpublished — the reader-safe under-claim.
    assert.deepEqual(store.read({ object_type: 'navigation', object_id: 'nav_footer' }), navRecord());

    // ── reconciliation: retrying converges without a duplicate commit ──────
    const eventsBefore = events.length;
    const retry = await publishNav(store, github.fetchImpl);

    assert.equal(retry.status, 200);
    const retryReceipt = retry.body.receipt as Record<string, unknown>;
    assert.equal(retryReceipt.no_op, true, 'the retry must detect the content already at head');
    assert.equal(retryReceipt.commit_sha, github.getHead().sha);

    const retryEvents = events.slice(eventsBefore);
    assert.equal(
      retryEvents.filter((event) => event.kind === 'github' && event.method === 'PATCH').length,
      0,
      'a converging retry must not move the ref again'
    );
    assert.equal(
      retryEvents.filter(
        (event) => event.kind === 'github' && event.method === 'POST' && event.path.endsWith('/git/commits')
      ).length,
      0,
      'a converging retry must not mint a duplicate commit'
    );

    const stored = store.read({ object_type: 'navigation', object_id: 'nav_footer' });
    assert.equal(stored.publication.published_time, PUBLISHED_TIME);
    assert.equal(stored.version, 6);
    assert.equal(stored.content_revision, 2);
  });
});

// Fields that legitimately differ between a first-attempt success and a
// converged retry: whether the committer no-opped, its attempt count, and —
// for the after-failure-A case — the git commit object id (real git mints a
// distinct commit object per attempt; the TREE is what is provably identical).
const normalizeForEndStateComparison = (record: ObjectRecord) => {
  const clone = JSON.parse(JSON.stringify(record)) as ObjectRecord;
  const receipt = clone.publication.publish_receipt as Record<string, unknown> | undefined;
  if (receipt) {
    delete receipt.no_op;
    delete receipt.attempts;
    delete receipt.commit_sha;
  }
  for (const entry of clone.history) {
    if (entry.details) {
      delete entry.details.no_op;
      delete entry.details.commit_sha;
    }
  }
  return clone;
};

test('a retried publish (after either failure point) lands the same end state as a first-attempt success', async () => {
  await withGitHubEnv(async () => {
    // Reference run: clean first-attempt success.
    const virginEvents: PublishEvent[] = [];
    const virginGitHub = createGitHubApiMock(virginEvents);
    const virginStore = createStore(virginEvents);
    virginStore.seed(navRecord());
    assert.equal((await publishNav(virginStore, virginGitHub.fetchImpl)).status, 200);
    const virginRecord = virginStore.read({ object_type: 'navigation', object_id: 'nav_footer' });
    const expected = expectedExport();

    // Run 1: transient commit failure (lost non-fast-forward race), then retry.
    {
      const events: PublishEvent[] = [];
      const nonFF = { status: 422, body: 'Update is not a fast forward' };
      const github = createGitHubApiMock(events, { refPatchOutcomes: [nonFF, nonFF] });
      const store = createStore(events);
      store.seed(navRecord());

      assert.equal((await publishNav(store, github.fetchImpl, {}, { maxAttempts: 2 })).status, 409);
      assert.equal((await publishNav(store, github.fetchImpl)).status, 200);

      const record = store.read({ object_type: 'navigation', object_id: 'nav_footer' });
      assert.deepEqual(normalizeForEndStateComparison(record), normalizeForEndStateComparison(virginRecord));
      assert.equal(github.readFileAtHead(expected.path), virginGitHub.readFileAtHead(expected.path));
      assert.equal(
        (record.publication.publish_receipt as Record<string, unknown>).tree_sha,
        (virginRecord.publication.publish_receipt as Record<string, unknown>).tree_sha,
        'identical content must land the identical tree'
      );
    }

    // Run 2: commit succeeded but the stamp failed, then retry.
    {
      const events: PublishEvent[] = [];
      const github = createGitHubApiMock(events);
      const store = createStore(events, { failSetTimes: 1 });
      store.seed(navRecord());

      assert.equal((await publishNav(store, github.fetchImpl)).status, 500);
      assert.equal((await publishNav(store, github.fetchImpl)).status, 200);

      const record = store.read({ object_type: 'navigation', object_id: 'nav_footer' });
      assert.deepEqual(normalizeForEndStateComparison(record), normalizeForEndStateComparison(virginRecord));
      assert.equal(github.readFileAtHead(expected.path), virginGitHub.readFileAtHead(expected.path));
      assert.equal(
        (record.publication.publish_receipt as Record<string, unknown>).commit_sha,
        virginRecord.publication.publish_receipt
          ? (virginRecord.publication.publish_receipt as Record<string, unknown>).commit_sha
          : undefined,
        'the stamp-failure retry stamps the very commit the first attempt landed'
      );
    }
  });
});

test('scheduling is immediate-or-reject and unpublish is refused loudly, all before any side effect', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);
    store.seed(navRecord());

    const future = await publishNav(store, github.fetchImpl, { published_time: iso(NOW + 10 * 60_000) });
    assert.equal(future.status, 400);
    assert.equal(future.body.code, 'scheduling_not_supported');

    const unpublish = await publishNav(store, github.fetchImpl, { published_time: null });
    assert.equal(unpublish.status, 400);
    assert.equal(unpublish.body.code, 'unpublish_not_supported');

    const garbage = await publishNav(store, github.fetchImpl, { published_time: 'not-a-date' });
    assert.equal(garbage.status, 400);
    assert.equal(garbage.body.code, 'invalid_published_time');

    // content_item publishes through this path since W7.3 — a missing record
    // is an ordinary 404, no longer an unsupported-type refusal.
    const article = await publishNav(store, github.fetchImpl, {
      object_type: 'content_item',
      object_id: 'req_smoke_pdf_cta_20260630_01',
    });
    assert.equal(article.status, 404);
    assert.equal(article.body.code, 'not_found');

    assert.equal(events.length, 0, 'rejections must not touch git or the store');
    assert.deepEqual(store.read({ object_type: 'navigation', object_id: 'nav_footer' }), navRecord());
  });
});

test('missing, archived, and lock-violating records are refused with verb-parity codes', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);

    const missing = await publishNav(store, github.fetchImpl);
    assert.equal(missing.status, 404);
    assert.equal(missing.body.code, 'not_found');

    store.seed({ ...navRecord(), status: 'archived' });
    const archived = await publishNav(store, github.fetchImpl);
    assert.equal(archived.status, 409);
    assert.equal(archived.body.code, 'archived');

    store.seed({ ...navRecord(), lock: undefined });
    const unlocked = await publishNav(store, github.fetchImpl);
    assert.equal(unlocked.status, 423);
    assert.equal(unlocked.body.code, 'lock_required');

    store.seed(navRecord());
    const wrongToken = await publishNav(store, github.fetchImpl, { lock_token: 'someone-else' });
    assert.equal(wrongToken.status, 423);

    store.seed({ ...navRecord(), lock: { ...LOCK, expires_at: iso(NOW - 1000) } });
    const expired = await publishNav(store, github.fetchImpl);
    assert.equal(expired.status, 423);

    assert.equal(
      events.filter((event) => event.kind === 'github').length,
      0,
      'no rejected publish may reach the GitHub API'
    );
  });
});

test('publish-gated validation rejects before any export exists (page with no visible sections)', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);
    const page: ObjectRecord = {
      ...navRecord(),
      object_id: 'page_home',
      object_type: 'page',
      schema_version: 'page.v1',
      body: { route: '/', pageType: 'home', title: 'Home', seo: {}, sections: [] },
    };
    store.seed(page);

    const result = await publishObject(
      store,
      { object_type: 'page', object_id: 'page_home', published_time: PUBLISHED_TIME, lock_token: 'tok1', actor },
      { nowMs: NOW, fetchImpl: github.fetchImpl, sleep: async () => {} }
    );

    assert.equal(result.status, 422);
    assert.equal(result.body.code, 'validation_failed');
    assert.ok((result.body.blockers as unknown[]).length > 0);
    assert.equal(events.length, 0);
    assert.deepEqual(store.read({ object_type: 'page', object_id: 'page_home' }), page);
  });
});

test('body drift during the commit window is detected at stamp time and never stamped over', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const base = navRecord();
    const drifted: ObjectRecord = { ...navRecord(), version: 6, content_revision: 3 };
    let reads = 0;
    const store = {
      get: async () => JSON.stringify((reads += 1) === 1 ? base : drifted),
      setJSON: async (key: string) => {
        events.push({ kind: 'store_set', key } as PublishEvent);
        throw new Error('must not be reached');
      },
    };

    const result = await publishNav(store, github.fetchImpl);

    assert.equal(result.status, 409);
    assert.equal(result.body.code, 'content_changed_during_publish');
    assert.equal(result.body.export_committed, true);
    assert.equal(result.body.materialized_content_revision, 2);
    assert.equal(result.body.actual_content_revision, 3);
    assert.equal(result.body.reconciliation, 'retry_publish');
    assert.equal(
      events.filter((event) => event.kind === 'store_set').length,
      0,
      'the stale publish must not write the record'
    );
    assert.notEqual(github.getHead().sha, 'head0', 'the export commit had already landed — the residual is documented');
  });
});

test('a content_item publish returns the live article_path derived from the body slug', async () => {
  await withGitHubEnv(async () => {
    const events: PublishEvent[] = [];
    const github = createGitHubApiMock(events);
    const store = createStore(events);
    store.seed({
      ...navRecord(),
      object_id: 'req_probe_publish_20260719_01',
      object_type: 'content_item',
      schema_version: 'content_item.v1',
      body: {
        slug: 'probe-artifact-drill',
        title: 'Probe artifact drill',
        nodes: [{ id: 'n_a1', kind: 'content', public: { body: 'One paragraph.' } }],
      },
    } as never);

    const result = await publishNav(store, github.fetchImpl, {
      object_type: 'content_item',
      object_id: 'req_probe_publish_20260719_01',
    });
    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.article_path, '/probe-artifact-drill');

    // Non-article publishes carry no article_path.
    const navEvents: PublishEvent[] = [];
    const navGitHub = createGitHubApiMock(navEvents);
    const navStore = createStore(navEvents);
    navStore.seed(navRecord());
    const navResult = await publishNav(navStore, navGitHub.fetchImpl);
    assert.equal(navResult.status, 200);
    assert.equal('article_path' in navResult.body, false);
  });
});
