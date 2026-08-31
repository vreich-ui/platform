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

import { REQUEST_PAGE_SIZE, canArchive, requestSchema, retryRefusal } from './admin-requests.js';
import { REQUEST_LIST_MAX_LIMIT } from '../../lib/admin/request-list-limits.js';
import {
  createRequest,
  loadRequest,
  recordProgress,
  requeueRequest,
  setStatus,
  type EditorialRequestStore,
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

  async get(key: string): Promise<string | null> {
    return this.map.get(key) ?? null;
  }

  async setJSON(key: string, value: unknown): Promise<void> {
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
