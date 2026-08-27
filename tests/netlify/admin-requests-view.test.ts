/**
 * T5.1 (T0.2 F13, §6.1) — the request detail page's live watch, read-only.
 *
 * `RequestActivity.tsx` polled `admin-request-activity` every 3 s while a run
 * was live. Every tick re-read the request doc just to re-learn a `run_id`
 * that can never change, and re-transferred the whole node tree even when
 * nothing had moved — R8 (`ETag`/`304`) had landed on `admin-requests` and
 * `admin-release-state` but never on this endpoint. `admin-requests-view` is
 * the fix: cache `run_id` client-side and the request-doc read drops out
 * entirely from the second tick on; `ETag` + `If-None-Match` covers the rest.
 *
 * Read-only by construction and by schema (`.strict()` — W19: only the
 * sweeper writes a running request's status, and a view must never become a
 * second writer). The approve/withhold decision stays on
 * `admin-request-activity`, unmodified; these tests never send `action` and
 * pin that the schema refuses it outright if something tried.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

process.env.ADMIN_EMAILS = 'wolf@example.com';
process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = 'test-token';
delete process.env.NETLIFY_BLOBS_TOKEN;
delete process.env.NETLIFY_AUTH_TOKEN;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-requests-view');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const reset = () => rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

/**
 * The bridge client captures `globalThis.fetch` AT CONSTRUCTION (module load)
 * — the stub must be installed before the handler module is imported. Same
 * rig as `request-activity-approve.test.ts`.
 */
let dispatch: (name: string, args: Record<string, unknown>) => unknown = () => ({ ok: true, data: {} });
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body ?? '{}')) as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (payload.method === 'initialize') {
    return jsonRes({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 's1' });
  }
  if (payload.method === 'notifications/initialized') return jsonRes({});
  const name = payload.params?.name ?? '';
  const args = payload.params?.arguments ?? {};
  calls.push({ name, args });
  return jsonRes({ jsonrpc: '2.0', id: 2, result: dispatch(name, args) });
}) as typeof fetch;

const { handler } = await import('../../netlify/functions/admin-requests-view.js');
const { getEditorialRequestsBlobStore } = await import('../../packages/core/server/lib/blob-store.js');
const { createRequest } = await import('../../packages/core/server/lib/requests/store.js');

const OWNER_CTX = { clientContext: { user: { sub: 'id-wolf', email: 'wolf@example.com' } } };
const STRANGER_CTX = { clientContext: { user: { sub: 'id-nobody', email: 'nobody@example.com' } } };

const RUN_ID = 'run_test_view_1';

const stubBridge = () => {
  calls = [];
  dispatch = (name) =>
    name === 'workflow_get_run'
      ? {
          ok: true,
          data: {
            run: { runId: RUN_ID, status: 'running', nodes: [{ nodeId: 'article_body', status: 'completed' }] },
            mode: null,
            stall: null,
          },
        }
      : { ok: true, data: { run: { runId: RUN_ID } } };
};

const call = async (body: Record<string, unknown>, context: unknown, headers: Record<string, string> = {}) =>
  handler({ httpMethod: 'POST', body: JSON.stringify(body), headers }, context as never);

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

test('admin-requests-view: GET is refused', async () => {
  const res = await handler({ httpMethod: 'GET', headers: {} } as never, OWNER_CTX as never);
  assert.equal(res.statusCode, 405);
});

test('admin-requests-view: a caller outside the admin wall is refused, and CMS-Agent is never reached', async () => {
  stubBridge();
  const res = await call({ run_id: RUN_ID }, STRANGER_CTX);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('admin-requests-view: requires request_id or run_id', async () => {
  const res = await call({}, OWNER_CTX);
  assert.equal(res.statusCode, 400);
});

// ─── W19: this endpoint can never become a second writer ────────────────────

test("admin-requests-view: an 'action' field is rejected at the schema, not silently dropped — this endpoint has no decision path", async () => {
  stubBridge();
  const res = await call({ run_id: RUN_ID, action: 'approve' }, OWNER_CTX);
  assert.equal(res.statusCode, 400, res.body);
  assert.equal(calls.length, 0, 'a request the schema refuses must never reach CMS-Agent');
});

// ─── the read path, and the ETag/304 win (F13) ───────────────────────────────

test('admin-requests-view: run_id alone reads the run, echoes run_id back, and issues an ETag', async () => {
  stubBridge();
  const res = await call({ run_id: RUN_ID }, OWNER_CTX);
  assert.equal(res.statusCode, 200, res.body);
  const body = parse(res);
  assert.equal(body.run_id, RUN_ID);
  assert.equal((body.activity as Record<string, unknown> | null)?.status, 'running');
  assert.equal(body.can_approve, true);
  assert.ok((res.headers as Record<string, string>).ETag, 'an ETag must be issued');
  assert.deepEqual(
    calls.map((c) => c.name).filter((n) => n !== 'workflow_get_run_cost'),
    ['workflow_get_run'],
    'a read must not decide anything'
  );
});

test('admin-requests-view: an unmoved run comes back a bodyless 304 on the second tick', async () => {
  stubBridge();
  const first = await call({ run_id: RUN_ID }, OWNER_CTX);
  const etag = (first.headers as Record<string, string>).ETag;
  assert.ok(etag);

  const second = await call({ run_id: RUN_ID }, OWNER_CTX, { 'if-none-match': etag });
  assert.equal(second.statusCode, 304);
  assert.equal(second.body, '');
});

test('admin-requests-view: a moved run (different node status) does NOT 304, even with a stale If-None-Match', async () => {
  stubBridge();
  const first = await call({ run_id: RUN_ID }, OWNER_CTX);
  const etag = (first.headers as Record<string, string>).ETag;

  dispatch = (name) =>
    name === 'workflow_get_run'
      ? {
          ok: true,
          data: {
            run: { runId: RUN_ID, status: 'running', nodes: [{ nodeId: 'article_body', status: 'running' }] },
            mode: null,
            stall: null,
          },
        }
      : { ok: true, data: { run: { runId: RUN_ID } } };

  const second = await call({ run_id: RUN_ID }, OWNER_CTX, { 'if-none-match': etag });
  assert.equal(second.statusCode, 200, 'a genuinely changed run must not 304');
});

test('admin-requests-view: CMS-Agent unavailable reports the reason without an ETag (no cacheable "unavailable" state)', async () => {
  delete process.env.CMS_AGENT_MCP_ENDPOINT;
  try {
    const res = await call({ run_id: RUN_ID }, OWNER_CTX);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).reason, 'cms_agent_unavailable');
    assert.equal((res.headers as Record<string, string>).ETag, undefined);
  } finally {
    process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
  }
});

// ─── the request_id path — the read the run_id cache exists to skip ────────

test('admin-requests-view: request_id resolves run_id from the request doc, and a request with no run reports no_workflow_run', async () => {
  await reset();
  const store = await getEditorialRequestsBlobStore({});
  await createRequest(store, {
    request_id: 'req_view_test_20260826_01',
    kind: 'article',
    title: 'A test article',
    created_by: 'wolf@example.com',
  });

  stubBridge();
  const res = await call({ request_id: 'req_view_test_20260826_01' }, OWNER_CTX);
  assert.equal(res.statusCode, 200, res.body);
  const body = parse(res);
  assert.equal(body.activity, null);
  assert.equal(body.reason, 'no_workflow_run');
  assert.equal(body.retry_ms, 10_000, 'a queued request may still start a run');
  assert.equal(calls.length, 0, 'no run means nothing to read from CMS-Agent');
});

test('admin-requests-view: request_id resolves a real run_id, which the client then caches and replays', async () => {
  await reset();
  const store = await getEditorialRequestsBlobStore({});
  await createRequest(store, {
    request_id: 'req_view_test_20260826_02',
    kind: 'article',
    title: 'A test article with a run',
    created_by: 'wolf@example.com',
    workflow: { run_id: RUN_ID, workflow_id: 'wf_article', project_id: 'proj_1' },
  });

  stubBridge();
  const first = await call({ request_id: 'req_view_test_20260826_02' }, OWNER_CTX);
  assert.equal(first.statusCode, 200, first.body);
  const firstBody = parse(first);
  assert.equal(firstBody.run_id, RUN_ID, 'the resolved run_id is handed back for the client to cache');

  // The caching win itself: reusing the run_id the first response returned
  // reads the SAME run, with no request_id in the follow-up call at all — the
  // request store is not touched a second time (there is nothing in this
  // request body that could even reach `loadRequest`).
  const second = await call({ run_id: firstBody.run_id as string }, OWNER_CTX);
  assert.equal(second.statusCode, 200, second.body);
  assert.equal(parse(second).run_id, RUN_ID);
});

test('admin-requests-view: an unknown request_id 404s', async () => {
  await reset();
  const res = await call({ request_id: 'req_does_not_exist_20260826_01' }, OWNER_CTX);
  assert.equal(res.statusCode, 404);
});
