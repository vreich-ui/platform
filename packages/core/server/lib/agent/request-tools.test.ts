/**
 * W19 T19.8 — the four request tools the client manager gained.
 *
 * Proves: the archive role wall (autonomy `ask` says a human approved, not
 * WHICH human); retry reports a refusal as a refusal rather than claiming it
 * pushed something; both privileged tools sit at the `ask` floor; and every
 * one of the four degrades with a clear sentence when the registry is not
 * wired into the session rather than throwing at the model.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import test from 'node:test';

import { chatToolByName, resolveAutonomy, type ToolContext } from './tools.js';

const REQUEST_ID = 'req_agent_retinol_20260822_01';

type RequestsCtx = NonNullable<ToolContext['requests']>;

const ctxWith = (roles: string[], requests: Partial<RequestsCtx> = {}): ToolContext =>
  ({ roles, requests: { register: async () => undefined, ...requests } }) as unknown as ToolContext;

const bridgeCtx = (
  respond: (name: string, args: Record<string, unknown>) => unknown,
  requests: Partial<RequestsCtx> = {},
  calls: Array<{ name: string; args: Record<string, unknown> }> = []
): ToolContext =>
  ({
    roles: ['editor'],
    requests: { register: async () => undefined, ...requests },
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { ok: true, data: respond(name, args) };
      },
    },
  }) as unknown as ToolContext;

const body = (result: { content: string }) => JSON.parse(result.content) as Record<string, unknown>;

const tool = (name: string) => {
  const found = chatToolByName(name);
  assert.ok(found, `${name} is not registered`);
  return found;
};

// ─── the role wall ───────────────────────────────────────────────────────────

test('archive_request refuses an editor — approval says a human clicked, not WHICH human', async () => {
  let archived = false;
  const ctx = ctxWith(['editor'], {
    archive: async () => {
      archived = true;
      return { request_id: REQUEST_ID };
    },
  });
  const result = await tool('archive_request').execute(ctx, { request_id: REQUEST_ID });
  assert.equal(result.is_error, true);
  assert.match(String(body(result).error), /Owner or publisher/i);
  assert.equal(archived, false, 'the wall has to stop the write, not just annotate it');
});

test('archive_request lets an Owner and a publisher through', async () => {
  for (const role of ['owner', 'publisher']) {
    const ctx = ctxWith([role], { archive: async () => ({ request_id: REQUEST_ID, status: 'archived' }) });
    const result = await tool('archive_request').execute(ctx, { request_id: REQUEST_ID });
    assert.equal(result.is_error, false, `${role} should be able to archive`);
    assert.equal(body(result).status, 'archived');
  }
});

test('archive_request says so plainly when the request does not exist', async () => {
  const ctx = ctxWith(['owner'], { archive: async () => undefined });
  const result = await tool('archive_request').execute(ctx, { request_id: REQUEST_ID });
  assert.equal(result.is_error, true);
  assert.match(String(body(result).error), /No request/);
});

// ─── retry ───────────────────────────────────────────────────────────────────

test('retry_request passes a refusal through verbatim instead of claiming a push', async () => {
  const ctx = ctxWith(['editor'], {
    retry: async () => ({ refused: true, reason: 'This request is waiting for a human decision', status: 'needs_you' }),
  });
  const result = await tool('retry_request').execute(ctx, { request_id: REQUEST_ID });
  const payload = body(result);
  assert.equal(payload.refused, true);
  assert.equal(payload.status, 'needs_you');
  assert.equal(payload.retried, undefined, 'the model must not be able to report this as retried');
});

test('retry_request reports the status it left behind, so the reply can be specific', async () => {
  const ctx = ctxWith(['editor'], {
    retry: async (requestId: string) => ({ retried: true, request_id: requestId, status: 'queued' }),
  });
  const payload = body(await tool('retry_request').execute(ctx, { request_id: REQUEST_ID }));
  assert.equal(payload.retried, true);
  assert.equal(payload.status, 'queued');
});

test("retry_request's dry run reads the CURRENT status rather than echoing the argument", async () => {
  const ctx = ctxWith(['editor'], {
    get: async () => ({ status: 'stalled', title: 'Retinol after 40' }),
    retry: async () => ({ retried: true }),
  });
  const preview = (await tool('retry_request').dryRun!(ctx, { request_id: REQUEST_ID })) as Record<string, unknown>;
  assert.equal(preview.current_status, 'stalled');
  assert.equal(preview.title, 'Retinol after 40');
});

// ─── the autonomy floor ──────────────────────────────────────────────────────

test('the two writing request tools can never resolve to auto; the two reads are auto', () => {
  const forced = resolveAutonomy(
    { retry_request: 'auto', archive_request: 'auto' },
    { retry_request: 'auto', archive_request: 'auto' }
  );
  assert.equal(forced.retry_request, 'ask');
  assert.equal(forced.archive_request, 'ask');
  const defaults = resolveAutonomy(undefined, undefined);
  assert.equal(defaults.list_requests, 'auto');
  assert.equal(defaults.get_request, 'auto');
});

// ─── no registry in the session ──────────────────────────────────────────────

test('all four degrade with one clear sentence when the registry is not wired in', async () => {
  const ctx = { roles: ['owner'] } as unknown as ToolContext;
  for (const name of ['list_requests', 'get_request', 'retry_request', 'archive_request']) {
    const result = await tool(name).execute(ctx, { request_id: REQUEST_ID });
    assert.equal(result.is_error, true, `${name} should report the gap`);
    assert.match(String(body(result).error), /not available in this session/);
  }
});

// ─── list ────────────────────────────────────────────────────────────────────

test('list_requests hands the filters straight to the registry — one filter, one meaning', async () => {
  let seen: Record<string, unknown> | undefined;
  const ctx = ctxWith(['editor'], {
    list: async (filters: Record<string, unknown>) => {
      seen = filters;
      return { requests: [], total: 0 };
    },
  });
  await tool('list_requests').execute(ctx, { status: ['running', 'needs_you'], mine: true });
  assert.deepEqual(seen, { status: ['running', 'needs_you'], mine: true });
});

// ─── T19.8c: the tool that answers "where is it?" ────────────────────────────

const RUN = {
  runId: 'run_123',
  status: 'running',
  nodeCount: 3,
  nodes: [
    { nodeId: 'topic_researcher', status: 'completed', durationMs: 120_000, produces: ['research_brief'] },
    { nodeId: 'article_body', status: 'running', startedAt: '2026-08-22T11:58:00.000Z' },
    { nodeId: 'publication_controller', status: 'pending' },
  ],
};

test('get_request_activity resolves the run from the REQUEST and reports every step', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(
    (name) => (name === 'workflow_get_run' ? RUN : { ledger: { stages: [] }, plan: {} }),
    { get: async () => ({ title: 'Retinol after 40', workflow: { run_id: 'run_123' } }) },
    calls
  );
  const payload = body(await tool('get_request_activity').execute(ctx, { request_id: REQUEST_ID }));
  assert.equal(payload.title, 'Retinol after 40');
  assert.equal(payload.run_id, 'run_123');
  assert.equal((payload.steps as unknown[]).length, 3);
  assert.deepEqual(calls.map((call) => call.name).sort(), ['workflow_get_run', 'workflow_get_run_cost']);
  assert.deepEqual(calls[0]!.args, { runId: 'run_123' });
});

test('get_request_activity still answers when the cost ledger is unavailable — it costs the estimate, not the answer', async () => {
  const ctx = {
    roles: ['editor'],
    requests: { register: async () => undefined, get: async () => ({ workflow: { run_id: 'run_123' } }) },
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string) {
        if (name === 'workflow_get_run_cost') throw new Error('ledger down');
        return { ok: true, data: RUN };
      },
    },
  } as unknown as ToolContext;
  const payload = body(await tool('get_request_activity').execute(ctx, { request_id: REQUEST_ID }));
  assert.equal((payload.steps as unknown[]).length, 3);
  assert.equal(payload.remaining, undefined);
});

test('get_request_activity separates "no run YET" from "no run EVER", and says which', async () => {
  const starting = bridgeCtx(() => RUN, { get: async () => ({ title: 'Just asked', status: 'queued' }) }, []);
  const startingBody = body(await tool('get_request_activity').execute(starting, { request_id: REQUEST_ID }));
  assert.equal(startingBody.activity, null);
  assert.equal(startingBody.reason, 'no_workflow_run');
  assert.match(String(startingBody.note), /still starting/i);

  const never = bridgeCtx(() => RUN, { get: async () => ({ title: 'A theme change', status: 'done' }) }, []);
  const neverBody = body(await tool('get_request_activity').execute(never, { request_id: REQUEST_ID }));
  assert.match(String(neverBody.note), /no workflow behind it/i);
});

test('get_request_activity takes a bare run_id, for a run with no request behind it', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx((name) => (name === 'workflow_get_run' ? RUN : {}), {}, calls);
  const payload = body(await tool('get_request_activity').execute(ctx, { run_id: 'run_123' }));
  assert.equal(payload.run_id, 'run_123');
  assert.equal(calls[0]!.args.runId, 'run_123');
});

test('get_request_activity is a READ — it can never advance or publish a run', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx((name) => (name === 'workflow_get_run' ? RUN : {}), {}, calls);
  await tool('get_request_activity').execute(ctx, { run_id: 'run_123' });
  for (const call of calls) {
    assert.match(call.name, /^workflow_get_run/, `${call.name} is not a read`);
  }
  assert.equal(tool('get_request_activity').toolClass, 'read');
  assert.equal(resolveAutonomy(undefined, undefined).get_request_activity, 'auto');
});

test('get_request_activity refuses without a request_id or a run_id rather than guessing', () => {
  const ctx = ctxWith(['editor']);
  assert.equal(tool('get_request_activity').parse({}, ctx).ok, false);
  assert.equal(tool('get_request_activity').parse({ run_id: 'run_123' }, ctx).ok, true);
});
