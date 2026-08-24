/**
 * W19 — the approval an editor can actually press.
 *
 * The activity card has always SHOWN "waiting for you"; acting on it meant
 * telling the client manager in chat. These pin the action added to the same
 * endpoint: who may press it, and — the part that matters — that `approve`
 * performs BOTH halves. A run stopped at `publication_controller` needs the
 * durable operator decision AND the advance; doing only the first leaves the
 * editor exactly where they started with no new button to press.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

process.env.ADMIN_EMAILS = 'wolf@example.com';
process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = 'test-token';

/**
 * The bridge client captures `globalThis.fetch` AT CONSTRUCTION, and it is
 * constructed at module load — so the stub must be installed BEFORE the handler
 * module is imported. Hence the permanent dispatcher here plus a dynamic import
 * below; a stub installed inside a test would be captured by nothing.
 */
let dispatch: (name: string, args: Record<string, unknown>) => unknown = () => ({ ok: true, data: {} });
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });

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

const { handler } = await import('../../netlify/functions/admin-request-activity.js');

const OWNER_CTX = { clientContext: { user: { sub: 'id-wolf', email: 'wolf@example.com' } } };
const STRANGER_CTX = { clientContext: { user: { sub: 'id-nobody', email: 'nobody@example.com' } } };

const RUN_ID = 'run_test_approve_1';

/** Reset the recorder and answer every workflow tool the handler may reach. */
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
  return () => {
    calls = [];
  };
};

const call = async (body: Record<string, unknown>, context: unknown) =>
  handler({ httpMethod: 'POST', body: JSON.stringify(body), headers: {} }, context as never);

const parse = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

test('approve records the durable operator decision AND advances — both halves, in that order', async () => {
  const restore = stubBridge();
  try {
    const res = await call({ run_id: RUN_ID, action: 'approve' }, OWNER_CTX);
    assert.equal(res.statusCode, 200, res.body);

    const names = calls.map((entry) => entry.name);
    assert.deepEqual(names.slice(0, 2), ['workflow_set_operator_publish_decision', 'workflow_run_all']);
    assert.equal(calls[0]!.args.decision, 'approved');
    assert.equal(calls[0]!.args.runId, RUN_ID);
    assert.equal(calls[1]!.args.approved, true);
    assert.equal(calls[1]!.args.runId, RUN_ID);
    // The refreshed run is read AFTER the decision, so the card moves on the click.
    assert.ok(names.includes('workflow_get_run'), 'the response must carry post-decision state');
  } finally {
    restore();
  }
});

test('withhold records the veto and does NOT advance the run', async () => {
  const restore = stubBridge();
  try {
    const res = await call({ run_id: RUN_ID, action: 'withhold' }, OWNER_CTX);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(calls[0]!.name, 'workflow_set_operator_publish_decision');
    assert.equal(calls[0]!.args.decision, 'withheld');
    assert.equal(
      calls.some((entry) => entry.name === 'workflow_run_all'),
      false,
      'a veto must never drive the run forward'
    );
  } finally {
    restore();
  }
});

test('a caller outside the admin wall cannot approve — and reaches CMS-Agent not at all', async () => {
  const restore = stubBridge();
  try {
    const res = await call({ run_id: RUN_ID, action: 'approve' }, STRANGER_CTX);
    assert.equal(res.statusCode, 403);
    assert.equal(calls.length, 0);
  } finally {
    restore();
  }
});

test('a plain read reports whether THIS caller may approve, so no surface offers a refused button', async () => {
  const restore = stubBridge();
  try {
    const res = await call({ run_id: RUN_ID }, OWNER_CTX);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(parse(res).can_approve, true);
    assert.deepEqual(
      calls.map((entry) => entry.name).filter((name) => name !== 'workflow_get_run_cost'),
      ['workflow_get_run'],
      'a read must not decide anything'
    );
  } finally {
    restore();
  }
});
