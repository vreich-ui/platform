import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import type { ApprovalPolicy } from '../../packages/core/lib/approval-policy.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';

// Integration suite for T1.5's wiring of T1.3 (publish) / the review-state
// machine / the approval-policy publish gate into the shared verb core. The
// gate matrix and review-state machine themselves are exhaustively tested in
// publish-gate.test.ts / review-state.test.ts; this file only proves the
// endpoint wiring — auth, lock checks, persistence, policy injection — calls
// those pure functions correctly.

const NOW = Date.parse('2026-07-05T12:00:00.000Z');
const AGENT: Principal = { kind: 'agent', agent_name: 'draft-agent', auth: 'publish_key' };
const HUMAN_ADMIN: Principal = { kind: 'human', id: 'u1', email: 'admin@example.com' };
const HUMAN_EDITOR: Principal = { kind: 'human', id: 'u2', email: 'editor@example.com' };

const sha1 = (value: string) => createHash('sha1').update(value).digest('hex');

const createMemoryStore = () => {
  const blobs = new Map<string, string>();
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
type Store = ReturnType<typeof createMemoryStore>;

const call = (
  store: Store,
  request: ObjectVerbRequest,
  principal: Principal = AGENT,
  overrides: { nowMs?: number; publishDeps?: Record<string, unknown>; approvalPolicy?: ApprovalPolicy } = {}
) =>
  handleObjectVerb(store as unknown as ObjectVerbStore, request, principal, {
    nowMs: overrides.nowMs ?? NOW,
    publishDeps: overrides.publishDeps,
    approvalPolicy: overrides.approvalPolicy,
  });

// Gates navigation while everything else stays autonomous — the wiring tests
// below exercise both directions of the policy through the SAME dispatcher.
const GATE_NAVIGATION: ApprovalPolicy = { master: 'all-autonomous', overrides: { navigation: 'require-approval' } };

const stored = (store: Store, objectType: ObjectRecord['object_type'], objectId: string): ObjectRecord => {
  const raw = store.blobs.get(objectRecordKey(objectType, objectId));
  assert.ok(raw, 'record must exist');
  return JSON.parse(raw) as ObjectRecord;
};

const validNavBody = () => ({
  role: 'footer',
  groups: [
    {
      id: 'g_primary',
      items: [{ id: 'n_privacy', label: 'Privacy', target: { kind: 'external', href: 'https://drlurie.com/privacy' } }],
    },
  ],
});

const seedNav = async (store: Store) => {
  const res = await call(
    store,
    { action: 'create', object_type: 'navigation', site: 'site_drlurie', body: validNavBody() },
    AGENT
  );
  assert.equal(res.status, 200, JSON.stringify(res.body));
  const record = res.body.record as ObjectRecord;
  return record.object_id;
};

const ROLE_ENV_KEYS = ['ROLE_EMAILS_ADMIN', 'ROLE_EMAILS_PUBLISHER', 'ROLE_EMAILS_EDITOR', 'ADMIN_EMAILS'] as const;
const withRoleEnv = async (fn: () => Promise<void>) => {
  const saved = ROLE_ENV_KEYS.map((key) => [key, process.env[key]] as const);
  process.env.ROLE_EMAILS_ADMIN = HUMAN_ADMIN.kind === 'human' ? HUMAN_ADMIN.email : '';
  process.env.ROLE_EMAILS_EDITOR = HUMAN_EDITOR.kind === 'human' ? HUMAN_EDITOR.email : '';
  delete process.env.ROLE_EMAILS_PUBLISHER;
  delete process.env.ADMIN_EMAILS;
  try {
    await fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const checkoutAs = async (
  store: Store,
  objectType: ObjectRecord['object_type'],
  objectId: string,
  principal: Principal
) => {
  const res = await call(store, { action: 'checkout', object_type: objectType, object_id: objectId }, principal);
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.lockToken as string;
};

// ─── submit_review ────────────────────────────────────────────────────────────

test('submit_review requires the active lock and opens review, bumping version only', async () => {
  const store = createMemoryStore();
  const objectId = await seedNav(store);
  const before = stored(store, 'navigation', objectId);

  const wrongToken = await call(store, {
    action: 'submit_review',
    object_type: 'navigation',
    object_id: objectId,
    lock_token: 'not-a-real-token',
  });
  assert.equal(wrongToken.status, 423);

  const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
  const result = await call(store, {
    action: 'submit_review',
    object_type: 'navigation',
    object_id: objectId,
    lock_token: lockToken,
    requested_publish_action: { published_time: 'immediate' },
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.review_state, 'open');
  const record = stored(store, 'navigation', objectId);
  assert.equal(record.review?.state, 'open');
  assert.equal(record.content_revision, before.content_revision, 'submit must not bump content_revision');
  const entry = record.history[record.history.length - 1];
  assert.equal(entry.action, 'submit_review');
  assert.deepEqual(entry.details?.requested_publish_action, { published_time: 'immediate' });
});

test('submit_review 404s cleanly for a missing object', async () => {
  const store = createMemoryStore();
  const result = await call(store, {
    action: 'submit_review',
    object_type: 'navigation',
    object_id: 'nav_ghost',
    lock_token: 'x',
  });
  assert.equal(result.status, 404);
});

// ─── review_decide ────────────────────────────────────────────────────────────

test('review_decide is agentic at the wiring layer: an agent may approve without a role', async () => {
  const store = createMemoryStore();
  const objectId = await seedNav(store);
  const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
  await call(store, { action: 'submit_review', object_type: 'navigation', object_id: objectId, lock_token: lockToken });

  // The detached approval agent decides over the shared publish key — no lock,
  // no configured role — so edit → approve → publish needs no human.
  const result = await call(
    store,
    { action: 'review_decide', object_type: 'navigation', object_id: objectId, decision: 'approve' },
    AGENT
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.review_state, 'approved');
});

test('review_decide(approve) by a human pins content_revision + publish_action and does not require the lock', async () => {
  await withRoleEnv(async () => {
    const store = createMemoryStore();
    const objectId = await seedNav(store);
    const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
    await call(store, {
      action: 'submit_review',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: lockToken,
    });
    await call(
      store,
      { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
      AGENT
    );

    const beforeDecide = stored(store, 'navigation', objectId);
    const result = await call(
      store,
      {
        action: 'review_decide',
        object_type: 'navigation',
        object_id: objectId,
        decision: 'approve',
        publish_action: { published_time: 'immediate' },
      },
      HUMAN_ADMIN
    );

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.review_state, 'approved');
    const record = stored(store, 'navigation', objectId);
    const decision = record.review?.decisions[record.review.decisions.length - 1];
    assert.deepEqual(decision, {
      at: decision?.at,
      by: HUMAN_ADMIN,
      decision: 'approve',
      publish_action: { published_time: 'immediate' },
      content_revision: beforeDecide.content_revision,
    });
  });
});

// T6.2: the Reject path through the FULL endpoint wiring — `review-state.test.ts`
// already exercises `decideReview`'s `note` field as a pure function; nothing
// exercised it through `handleObjectVerb` (auth, lock checks, persistence)
// before this, and it is exactly the call the client-side façade's Reject
// button makes (`decisions.ts`: `decision === 'approve' ? 'approve' : 'request_changes'`,
// with the reviewer's typed reason forwarded as `note`).
test('review_decide(request_changes) by a human carries the typed reason through as note, end to end', async () => {
  await withRoleEnv(async () => {
    const store = createMemoryStore();
    const objectId = await seedNav(store);
    const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
    await call(store, {
      action: 'submit_review',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: lockToken,
    });
    await call(
      store,
      { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
      AGENT
    );

    const result = await call(
      store,
      {
        action: 'review_decide',
        object_type: 'navigation',
        object_id: objectId,
        decision: 'request_changes',
        note: 'needs a source for the privacy claim',
      },
      HUMAN_ADMIN
    );

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.review_state, 'changes_requested');
    const record = stored(store, 'navigation', objectId);
    const decision = record.review?.decisions[record.review.decisions.length - 1];
    assert.equal(decision?.decision, 'request_changes');
    assert.equal(decision?.note, 'needs a source for the privacy claim');
    // request_changes never pins a publish action — there is nothing to
    // execute yet, so nothing here is "ignored-by-gate" the way the same
    // field on an approve is.
    assert.equal(decision?.publish_action, undefined);
  });
});

// ─── discard ──────────────────────────────────────────────────────────────────

test('discard reverts a rejected patch under the reviewer lock and bumps content_revision', async () => {
  const store = createMemoryStore();
  const objectId = await seedNav(store);

  const agentLock = await checkoutAs(store, 'navigation', objectId, AGENT);
  const patched = await call(
    store,
    {
      action: 'patch',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: agentLock,
      expected_record_version: stored(store, 'navigation', objectId).version,
      ops: [
        { op: 'update_item', group_id: 'g_primary', item_id: 'n_privacy', fields: { label: 'Agent-proposed label' } },
      ],
    },
    AGENT
  );
  assert.equal(patched.status, 200, JSON.stringify(patched.body));
  const afterPatch = stored(store, 'navigation', objectId);
  await call(
    store,
    { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: agentLock },
    AGENT
  );

  const reviewerLock = await checkoutAs(store, 'navigation', objectId, HUMAN_EDITOR);
  const proposalEntry = afterPatch.history[afterPatch.history.length - 1].details as { op: unknown; capture: unknown };

  const noLock = await call(store, {
    action: 'discard',
    object_type: 'navigation',
    object_id: objectId,
    lock_token: 'wrong',
    entries: [proposalEntry],
  });
  assert.equal(noLock.status, 423);

  const result = await call(
    store,
    {
      action: 'discard',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: reviewerLock,
      entries: [proposalEntry],
    },
    HUMAN_EDITOR
  );
  assert.equal(result.status, 200, JSON.stringify(result.body));

  const record = stored(store, 'navigation', objectId);
  assert.deepEqual(record.body, validNavBody(), 'the body must revert to the pre-proposal state');
  assert.equal(record.content_revision, afterPatch.content_revision + 1, 'discard is a body write');
  const inverseEntry = record.history[record.history.length - 1];
  assert.deepEqual(inverseEntry.actor, HUMAN_EDITOR, 'the inverse is attributed to the reviewer');
});

// ─── publish_by_time (gate + T1.3 wiring) ────────────────────────────────────

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

const createGitHubApiMock = () => {
  const calls: string[] = [];
  let head = { sha: 'head0', treeSha: 'tree0' };
  const commitTrees = new Map<string, string>([['head0', 'tree0']]);
  let commitCounter = 0;
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push(`${method} ${url.pathname}`);
    if (method === 'GET' && url.pathname.includes('/git/ref/heads/'))
      return new Response(JSON.stringify({ object: { sha: head.sha } }));
    if (method === 'GET' && url.pathname.includes('/git/commits/')) {
      const sha = url.pathname.split('/').pop() as string;
      return new Response(JSON.stringify({ tree: { sha: commitTrees.get(sha) } }));
    }
    if (method === 'POST' && url.pathname.endsWith('/git/blobs'))
      return new Response(JSON.stringify({ sha: sha1(String(body?.content)) }));
    if (method === 'POST' && url.pathname.endsWith('/git/trees'))
      return new Response(JSON.stringify({ sha: `tree_${sha1(JSON.stringify(body))}` }));
    if (method === 'POST' && url.pathname.endsWith('/git/commits')) {
      commitCounter += 1;
      const sha = `commit${commitCounter}`;
      commitTrees.set(sha, String(body?.tree));
      return new Response(JSON.stringify({ sha }));
    }
    if (method === 'PATCH' && url.pathname.includes('/git/refs/heads/')) {
      head = { sha: String(body?.sha), treeSha: commitTrees.get(String(body?.sha)) as string };
      return new Response(JSON.stringify({ object: { sha: head.sha } }));
    }
    return new Response('unexpected', { status: 500 });
  }) as typeof fetch;
  return { fetchImpl, calls };
};

test('publish_by_time: under the default (committed) policy, an agent publishes a page directly with zero review', async () => {
  await withGitHubEnv(async () => {
    const store = createMemoryStore();
    const create = await call(
      store,
      {
        action: 'create',
        object_type: 'page',
        site: 'site_drlurie',
        body: {
          route: '/',
          pageType: 'home',
          title: 'Home',
          seo: {},
          // Required for a 'home' page to clear publish validation
          // (structure_home_footer, netlify/lib/object-validate.ts).
          navigationOverrides: { footer: 'nav_footer_home' },
          sections: [{ id: 's_hero', type: 'hero', data: { heading: 'Hi', actions: [] } }],
        },
      },
      AGENT
    );
    const objectId = (create.body.record as ObjectRecord).object_id;
    const lockToken = await checkoutAs(store, 'page', objectId, AGENT);
    const github = createGitHubApiMock();

    // No submit_review / review_decide at all — the dev-stage default
    // (src/config/approval-policy.ts: all-autonomous, no overrides) means
    // this publishes straight through when no policy is injected.
    const result = await call(
      store,
      { action: 'publish_by_time', object_type: 'page', object_id: objectId, lock_token: lockToken },
      AGENT,
      { publishDeps: { fetchImpl: github.fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site' } }
    );

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.published, true);
    assert.ok(github.calls.length > 0, 'an autonomous publish still commits the export');
    const record = stored(store, 'page', objectId);
    assert.ok(record.publication.published_time, 'the record must be stamped');
  });
});

test('publish_by_time: with navigation overridden to require-approval, an unapproved agent is denied before any commit', async () => {
  await withGitHubEnv(async () => {
    const store = createMemoryStore();
    const objectId = await seedNav(store);
    const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
    const github = createGitHubApiMock();

    const result = await call(
      store,
      { action: 'publish_by_time', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
      AGENT,
      {
        publishDeps: { fetchImpl: github.fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site' },
        approvalPolicy: GATE_NAVIGATION,
      }
    );

    assert.equal(result.status, 403);
    assert.equal(result.body.code, 'approval_required');
    assert.equal(github.calls.length, 0, 'the gate must deny before any GitHub call');
  });
});

test('publish_by_time: with navigation overridden to require-approval, an APPROVED agent executes the publish directly (no separate human-execute step)', async () => {
  await withGitHubEnv(async () => {
    const store = createMemoryStore();
    const objectId = await seedNav(store);
    const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
    await call(store, {
      action: 'submit_review',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: lockToken,
      requested_publish_action: { published_time: 'immediate' },
    });
    await call(
      store,
      { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
      AGENT
    );
    await withRoleEnv(async () => {
      await call(
        store,
        {
          action: 'review_decide',
          object_type: 'navigation',
          object_id: objectId,
          decision: 'approve',
          publish_action: { published_time: 'immediate' },
        },
        HUMAN_ADMIN
      );
    });

    const relock = await checkoutAs(store, 'navigation', objectId, AGENT);
    const github = createGitHubApiMock();
    const result = await call(
      store,
      { action: 'publish_by_time', object_type: 'navigation', object_id: objectId, lock_token: relock },
      AGENT,
      {
        publishDeps: { fetchImpl: github.fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site' },
        approvalPolicy: GATE_NAVIGATION,
      }
    );

    assert.equal(result.status, 200, JSON.stringify(result.body));
    assert.equal(result.body.published, true, 'the agent — not a human — executes the publish once approved');
    const record = stored(store, 'navigation', objectId);
    assert.ok(record.publication.published_time, 'the record must be stamped');
  });
});

test('publish_by_time: with navigation overridden to require-approval, a human admin executes an approved publish end to end', async () => {
  await withGitHubEnv(async () => {
    await withRoleEnv(async () => {
      const store = createMemoryStore();
      const objectId = await seedNav(store);
      const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
      await call(store, {
        action: 'submit_review',
        object_type: 'navigation',
        object_id: objectId,
        lock_token: lockToken,
      });
      await call(
        store,
        { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
        AGENT
      );
      await call(
        store,
        { action: 'review_decide', object_type: 'navigation', object_id: objectId, decision: 'approve' },
        HUMAN_ADMIN
      );

      const relock = await checkoutAs(store, 'navigation', objectId, HUMAN_ADMIN);
      const github = createGitHubApiMock();
      const result = await call(
        store,
        { action: 'publish_by_time', object_type: 'navigation', object_id: objectId, lock_token: relock },
        HUMAN_ADMIN,
        {
          publishDeps: { fetchImpl: github.fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site' },
          approvalPolicy: GATE_NAVIGATION,
        }
      );

      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.body.published, true);
      const record = stored(store, 'navigation', objectId);
      assert.ok(record.publication.published_time, 'the record must be stamped');
    });
  });
});

test('publish_by_time: an approval that pins artifact_set + release_build is satisfiable — the agent declares them and publishes; omitting them is denied', async () => {
  await withGitHubEnv(async () => {
    const store = createMemoryStore();
    const objectId = await seedNav(store);
    const artifactSet = [
      `image/req_pin_20260716_01/${'a'.repeat(64)}.png`,
      `pdf/req_pin_20260716_01/${'b'.repeat(64)}.pdf`,
    ];

    const lockToken = await checkoutAs(store, 'navigation', objectId, AGENT);
    await call(store, {
      action: 'submit_review',
      object_type: 'navigation',
      object_id: objectId,
      lock_token: lockToken,
      requested_publish_action: { published_time: 'immediate' },
    });
    await call(
      store,
      { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: lockToken },
      AGENT
    );
    await withRoleEnv(async () => {
      await call(
        store,
        {
          action: 'review_decide',
          object_type: 'navigation',
          object_id: objectId,
          decision: 'approve',
          publish_action: { published_time: 'immediate' },
          approval_pin: { artifact_set: artifactSet, release_build: 'defer' },
        },
        HUMAN_ADMIN
      );
    });

    const github = createGitHubApiMock();
    const deps = {
      publishDeps: { fetchImpl: github.fetchImpl, sleep: async () => {}, exportRoot: 'sites/drlurie/data/site' },
      approvalPolicy: GATE_NAVIGATION,
    };

    // The exact footgun: an approval pins an artifact_set but the publish declares
    // none — the gate cannot confirm it, so it is denied (not silently published).
    const relock1 = await checkoutAs(store, 'navigation', objectId, AGENT);
    const missing = await call(
      store,
      { action: 'publish_by_time', object_type: 'navigation', object_id: objectId, lock_token: relock1 },
      AGENT,
      deps
    );
    assert.equal(missing.status, 403, JSON.stringify(missing.body));
    assert.equal(missing.body.code, 'publish_artifact_set_required', JSON.stringify(missing.body));
    await call(
      store,
      { action: 'checkin', object_type: 'navigation', object_id: objectId, lock_token: relock1 },
      AGENT
    );

    // Declaring the pinned set (order-insensitive) + release behavior satisfies the
    // pin and the agent publishes — the live-publish approval flow is usable.
    const relock2 = await checkoutAs(store, 'navigation', objectId, AGENT);
    const ok = await call(
      store,
      {
        action: 'publish_by_time',
        object_type: 'navigation',
        object_id: objectId,
        lock_token: relock2,
        artifact_set: [artifactSet[1], artifactSet[0]],
        release_build: 'defer',
      },
      AGENT,
      deps
    );
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.published, true, 'declaring the pinned artifact_set + release_build lets the agent publish');
  });
});
