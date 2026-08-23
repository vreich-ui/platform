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
