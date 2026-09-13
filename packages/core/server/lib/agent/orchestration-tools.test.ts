/**
 * PF4 — workspace orchestration tools (P3.1's surviving half).
 *
 * Proves: the D2 risk floor (run_workspace_workflow can never resolve to
 * 'auto', regardless of governance/profile overrides, and is excluded from
 * the client-side safe-run allow-list); bounded editor-safe projections
 * (never prompts/schemas; the ~500KB run record never passes through);
 * `approved` is never sent (the CMS-Agent second wall stays armed); the
 * input-echo dry-run; and the clear no-bridge error.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import test from 'node:test';

import { isRunSafeApproval } from '../../../lib/admin/approval-mode.js';
import { nodeLabel } from '../../../lib/admin/request-logic.js';
import { chatToolByName, REQUEST_ID_RE, resolveAutonomy, type ToolContext } from './tools.js';

const bridgeCtx = (
  respond: (name: string, args: Record<string, unknown>) => unknown,
  calls: Array<{ name: string; args: Record<string, unknown> }>
): ToolContext =>
  ({
    roles: ['admin'],
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { ok: true, data: respond(name, args) };
      },
    },
  }) as unknown as ToolContext;

const noBridgeCtx = (): ToolContext => ({ roles: ['admin'] }) as unknown as ToolContext;

// ─── D2: the risk floor and the safe-run exclusion ──────────────────────────────

test('run_workspace_workflow can NEVER resolve to auto — governance and profile overrides are clamped; off still works', () => {
  const byGovernance = resolveAutonomy({ run_workspace_workflow: 'auto' }, undefined);
  assert.equal(byGovernance.run_workspace_workflow, 'ask');
  const byProfile = resolveAutonomy(undefined, { run_workspace_workflow: 'auto' });
  assert.equal(byProfile.run_workspace_workflow, 'ask');
  const disabled = resolveAutonomy({ run_workspace_workflow: 'off' }, undefined);
  assert.equal(disabled.run_workspace_workflow, 'off');
  // The read-class orchestration tools default to auto as designed.
  const defaults = resolveAutonomy(undefined, undefined);
  assert.equal(defaults.list_workspace_nodes, 'auto');
  assert.equal(defaults.get_workspace_run, 'auto');
  assert.equal(defaults.run_workspace_workflow, 'ask');
});

test('run_workspace_workflow: the D2 risk floor (not the client-side safe-run check) is what keeps it behind a decision', () => {
  // Wolf's ruling, 2026-08-12: `isRunSafeApproval` is a browser convenience
  // that now covers every tool, including run_workspace_workflow — the
  // actual floor is `resolveAutonomy`'s clamp above (D2), enforced
  // server-side and unaffected by the client's approval-mode selection.
  assert.equal(isRunSafeApproval('run_workspace_workflow'), true);
});

// ─── bounded, editor-safe projections ───────────────────────────────────────────

test('list_workspace_nodes projects nodes WITHOUT prompts, schemas or model config', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(
    () => ({
      nodes: [
        {
          id: 'draft_writer',
          name: 'Draft Writer',
          kind: 'drafting',
          riskLevel: 'read',
          status: 'active',
          description: 'Writes the draft.',
          dependsOn: ['brief_architect'],
          prompt: 'SECRET-INTERNAL-PROMPT with private strategy',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          modelConfig: { provider: 'openai', model: 'gpt-4.1' },
        },
      ],
    }),
    calls
  );
  const tool = chatToolByName('list_workspace_nodes')!;
  const result = await tool.execute(ctx, {});
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workspace_get_nodes');
  const payload = JSON.parse(result.content) as { nodes: Record<string, unknown>[] };
  assert.equal(payload.nodes[0]!.id, 'draft_writer');
  assert.equal(payload.nodes[0]!.risk_level, 'read');
  assert.equal(result.content.includes('SECRET-INTERNAL-PROMPT'), false, 'prompts are private strategy');
  assert.equal(result.content.includes('gpt-4.1'), false, 'no model names in editor-facing output');
  assert.equal(result.content.includes('inputSchema'), false);
});

test('get_workspace_run returns a bounded projection — a huge run record never passes through', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const huge = 'x'.repeat(400_000);
  const ctx = bridgeCtx(
    () => ({
      runId: 'run_1',
      status: 'running',
      mode: { executionMode: 'openai', live: true },
      driverNote: 'advancing',
      nodes: [
        {
          nodeId: 'draft_writer',
          status: 'completed',
          output: huge,
          startedAt: '2026-08-22T10:00:00.000Z',
          completedAt: '2026-08-22T10:02:00.000Z',
        },
        { nodeId: 'article_body', status: 'pending' },
      ],
      internalLedger: huge,
    }),
    calls
  );
  const tool = chatToolByName('get_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1' });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_get_run');
  assert.deepEqual(calls[0]!.args, { runId: 'run_1' });
  assert.ok(result.content.length < 2_000, `projection must stay bounded, got ${result.content.length}`);
  const payload = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(payload.run_id, 'run_1');
  assert.equal(payload.status, 'running');
  // T19.8c: the LABEL rides along. `node_7 is running` is not an answer an
  // editor can use, and the label is the difference between a status and a
  // sentence. The node's output still never crosses this boundary.
  assert.deepEqual(payload.nodes, [
    {
      id: 'draft_writer',
      step: nodeLabel('draft_writer'),
      status: 'completed',
      started_at: '2026-08-22T10:00:00.000Z',
      completed_at: '2026-08-22T10:02:00.000Z',
    },
    { id: 'article_body', step: nodeLabel('article_body'), status: 'pending' },
  ]);
  assert.equal(result.content.includes(huge.slice(0, 100)), false, 'no node output may pass through');
  // The raw mode block names the provider — only the live/mock boolean may pass.
  assert.equal(payload.live_output, true);
  assert.equal('mode' in payload, false);
  assert.equal(result.content.includes('openai'), false, 'no provider names in editor-facing output');
});

test('get_workspace_run survives a null mode block — the projection must never crash on it', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({ runId: 'run_1', status: 'blocked', mode: null, stall: null }), calls);
  const tool = chatToolByName('get_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1' });
  assert.equal(result.is_error, false);
  const payload = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(payload.run_id, 'run_1');
  assert.equal(payload.status, 'blocked');
  // A null mode is not an unknown mode with a readable `live` field - it carries no
  // execution information at all, so live_output is omitted rather than guessed.
  assert.equal('live_output' in payload, false);
});

test('list_workspace_nodes caps the projection at 100 nodes and reports the truncation', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const many = Array.from({ length: 150 }, (_, index) => ({
    id: `node_${index}`,
    name: `Node ${index}`,
    kind: 'strategy',
    riskLevel: 'read',
    description: 'x',
  }));
  const ctx = bridgeCtx(() => ({ nodes: many }), calls);
  const tool = chatToolByName('list_workspace_nodes')!;
  const result = await tool.execute(ctx, {});
  const payload = JSON.parse(result.content) as { nodes: unknown[]; truncated?: number };
  assert.equal(payload.nodes.length, 100);
  assert.equal(payload.truncated, 50);
});

// ─── run_workspace_workflow: start/advance, no `approved`, input-echo dry-run ─

test('run_workspace_workflow start mode sends projectId + input + a minted requestId to workflow_start_dry_run and NEVER `approved`', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  // THE WIRE SHAPE, not a convenient flat one: CMS-Agent answers
  // `ok({ run: … })`, and `continued` is a SIBLING of `run`. A fake that
  // returned the run row flat is what hid the envelope defect that left every
  // registered request without a `run_id` (see runRowFrom in tools.ts).
  const ctx = bridgeCtx(() => ({ run: { runId: 'run_new', status: 'created' }, continued: true }), calls);
  // D2a: minting probes object get for content_item; none exist here.
  (ctx as { verb?: unknown }).verb = async () => ({ status: 404, body: { not_found: true } });
  const tool = chatToolByName('run_workspace_workflow')!;

  const parsed = tool.parse({ input: { topic: 'retinol basics' }, budget_usd: 2 }, ctx);
  assert.equal(parsed.ok, true);
  const result = await tool.execute(ctx, { input: { topic: 'retinol basics' }, budget_usd: 2 });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_start_dry_run');
  const sent = calls[0]!.args;
  assert.match(sent.requestId as string, /^req_agent_retinol_basics_\d{8}_01$/);
  assert.match(sent.requestId as string, REQUEST_ID_RE);
  // budgetMs is NOT sent here: workflow_start_dry_run declares budgetUsd and is
  // additionalProperties:false, so an unknown key fails the whole call. It belongs
  // to workflow_run_all (asserted in the advance-mode test below).
  assert.deepEqual(
    { ...sent, requestId: undefined },
    { projectId: 'platform', input: { topic: 'retinol basics' }, budgetUsd: 2, requestId: undefined }
  );
  assert.equal('approved' in sent, false);
  const body = JSON.parse(result.content) as { run_id: string; request_id: string; continued: boolean };
  assert.equal(body.run_id, 'run_new');
  assert.equal(body.request_id, sent.requestId);
  assert.equal(body.continued, true);
});

test("run_workspace_workflow REGISTERS the request with the run_id from CMS-Agent's {run:…} envelope", async () => {
  // The W19 regression this file previously could not catch. `callTool` unwraps
  // only the `{ok,data}` envelope, so `data` is `{ run, continued }` — reading
  // `data.runId` gave `undefined`, the tool registered the request with NO
  // workflow block, and the sweeper then had nothing to poll: the request sat
  // at `queued` for ever while its run failed unseen. Assert the LINK, not just
  // the echoed run_id.
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = bridgeCtx(
    () => ({
      run: { runId: 'run_env', status: 'created', nodes: [{ nodeId: 'a' }, { nodeId: 'b' }] },
      continued: true,
    }),
    calls
  );
  (ctx as { verb?: unknown }).verb = async () => ({ status: 404, body: { not_found: true } });
  (ctx as { requests?: unknown }).requests = {
    register: async (input: Record<string, unknown>) => {
      registered.push(input);
    },
  };

  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, { input: { topic: 'retinol basics' } });
  assert.equal(result.is_error, false);

  assert.equal(registered.length, 1);
  const workflow = registered[0]!.workflow as
    | { run_id: string; workflow_id: string; project_id: string; node_total?: number }
    | undefined;
  assert.ok(workflow, 'the request must be registered WITH a workflow block — without one it can never leave `queued`');
  assert.equal(workflow.run_id, 'run_env');
  assert.equal(workflow.workflow_id, 'publishing_conductor');
  assert.equal(workflow.project_id, 'platform');
  assert.equal(workflow.node_total, 2);

  const body = JSON.parse(result.content) as { run_id: string };
  assert.equal(body.run_id, 'run_env');
});

test('run_workspace_workflow advance mode calls workflow_run_all WITHOUT approved — the CMS-Agent publish gate stays armed', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(
    () => ({ run: { runId: 'run_1', status: 'running' }, driverNote: 'stopped before publish-risk' }),
    calls
  );
  const tool = chatToolByName('run_workspace_workflow')!;
  const result = await tool.execute(ctx, { run_id: 'run_1' });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_run_all');
  assert.deepEqual(calls[0]!.args, { runId: 'run_1', budgetMs: 45_000 });
});

test('run_workspace_workflow REFUSES the late-stage entrypoint outside test mode — the skipped nodes ARE the product', async () => {
  // The entrypoint seeds article_body and marks every ideation/research/draft
  // node complete without dispatching it. On an ordinary editorial turn those
  // nodes are exactly what ART-2 requires (sourcing, claim and compliance
  // record) plus the aggression-ceiling clamp, so reaching this without test
  // mode would publish an article that never earned its record.
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({ run: { runId: 'run_x', status: 'created' } }), calls);
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    input: { topic: 'anything' },
    entrypoint: 'article_body',
    article_body: { artifact: 'client_object.v1', body: { slug: 'zz-test' } },
  });
  assert.equal(result.is_error, true);
  assert.equal((JSON.parse(result.content) as { code: string }).code, 'test_mode_required');
  assert.equal(calls.length, 0, 'a refused entrypoint must reach CMS-Agent not at all');
});

test('run_workspace_workflow forwards entrypoint + articleBody to CMS-Agent when the RUN is in test mode', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({ run: { runId: 'run_seeded', status: 'created' } }), calls);
  // Stamped at send time by admin-agent-chat after ANDing the browser's request
  // with the caller's resolved roles — a tool never derives this itself.
  (ctx as { testMode?: boolean }).testMode = true;
  (ctx as { verb?: unknown }).verb = async () => ({ status: 404, body: { not_found: true } });
  const body = { artifact: 'client_object.v1', body: { slug: 'zz-test-article-a' } };

  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    input: { topic: 'fixture' },
    entrypoint: 'article_body',
    article_body: body,
  });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_start_dry_run');
  assert.equal(calls[0]!.args.entrypoint, 'article_body');
  assert.deepEqual(calls[0]!.args.articleBody, body);
  assert.equal('approved' in calls[0]!.args, false, 'test mode never implies publish approval');
});

test('run_workspace_workflow parse pairs entrypoint and article_body in both directions', () => {
  const tool = chatToolByName('run_workspace_workflow')!;
  const ctx = noBridgeCtx();
  assert.equal(tool.parse({ input: { topic: 'x' }, entrypoint: 'article_body' }, ctx).ok, false);
  assert.equal(tool.parse({ input: { topic: 'x' }, article_body: { a: 1 } }, ctx).ok, false);
  assert.equal(tool.parse({ input: { topic: 'x' }, entrypoint: 'article_body', article_body: { a: 1 } }, ctx).ok, true);
});

test('run_workspace_workflow parse requires exactly one of input / run_id', () => {
  const tool = chatToolByName('run_workspace_workflow')!;
  const ctx = noBridgeCtx();
  assert.equal(tool.parse({}, ctx).ok, false);
  assert.equal(tool.parse({ input: {}, run_id: 'run_1' }, ctx).ok, false);
  assert.equal(tool.parse({ input: { topic: 'x' } }, ctx).ok, true);
  assert.equal(tool.parse({ run_id: 'run_1' }, ctx).ok, true);
});

test('the approval-card dry-run is an input echo with no server call', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({}), calls);
  const tool = chatToolByName('run_workspace_workflow')!;
  const preview = await tool.dryRun!(ctx, { input: { topic: 'x' }, budget_usd: 1 });
  assert.equal(calls.length, 0, 'the preview must not touch the service');
  assert.equal(preview.dry_run, true);
  assert.equal(preview.action, 'start_dry_run_workflow');
  assert.deepEqual(preview.input_echo, { topic: 'x' });
  assert.equal(preview.execution_mode, 'openai');
});

test('all three tools answer with a clear error when the bridge is not configured', async () => {
  const ctx = noBridgeCtx();
  for (const name of ['list_workspace_nodes', 'run_workspace_workflow', 'get_workspace_run']) {
    const tool = chatToolByName(name)!;
    const args =
      name === 'get_workspace_run' ? { run_id: 'r' } : name === 'run_workspace_workflow' ? { run_id: 'r' } : {};
    const result = await tool.execute(ctx, args);
    assert.equal(result.is_error, true, name);
    assert.match(result.content, /not configured/i);
  }
});

// ─── A3: the operation catalog (operation_list/operation_get/operation_preflight) ──

const PDF_DESCRIPTOR = {
  operationId: 'pdf_template_family',
  version: 1,
  title: 'PDF template family',
  effects: [{ kind: 'render', riskLevel: 'write' }],
};

/** A per-tool-name responder, for tests that need operation_get/operation_preflight to differ from workflow_start_dry_run. */
const namedCtx = (
  respond: (
    name: string,
    args: Record<string, unknown>
  ) => { ok: true; data: unknown } | { ok: false; message: string; code?: string },
  calls: Array<{ name: string; args: Record<string, unknown> }> = [],
  registered: Array<Record<string, unknown>> = []
): ToolContext =>
  ({
    roles: ['admin'],
    requests: {
      register: async (input: Record<string, unknown>) => {
        registered.push(input);
      },
      get: async () => undefined,
    },
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        const r = respond(name, args);
        return r.ok ? { ok: true, data: r.data } : { ok: false, message: r.message, code: r.code };
      },
    },
    verb: async () => ({ status: 404, body: { not_found: true } }),
  }) as unknown as ToolContext;

test('run_workspace_workflow(operation_id: pdf_template_family) registers the request as kind "pdf" with a durable id — THE article-stamping bug, pinned', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: PDF_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'pdf_template_family',
            selectedVersion: 1,
            appliedDefaults: {},
            missingRequired: [],
            blockers: [],
          },
        };
      return {
        ok: true,
        data: { run: { runId: 'run_pdf_1', status: 'created', nodes: [{ nodeId: 'a' }] }, continued: true },
      };
    },
    calls,
    registered
  );

  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: { templateFamily: 'brochure' },
  });
  assert.equal(result.is_error, false);
  assert.equal(calls.map((c) => c.name).join(','), 'operation_get,operation_preflight,workflow_start_dry_run');

  // THE FIX: registered under the RESOLVED kind, never the old hardcoded 'article'.
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.kind, 'pdf');
  assert.notEqual(registered[0]!.kind, 'article');
  assert.equal((registered[0]!.workflow as { workflow_id: string }).workflow_id, 'pdf_template_family');

  // A durable id exists and is what the caller gets back — not merely an
  // in-memory echo — so it can be looked up again after this turn ends.
  const requestId = registered[0]!.request_id as string;
  assert.ok(requestId && requestId.length > 0, 'a durable request id must be minted');
  const body = JSON.parse(result.content) as { request_id: string };
  assert.equal(body.request_id, requestId);
});

test('run_workspace_workflow(operation_id) sets tenantId from the SITE, never from the model — approved/principal/tenantId in input are inert', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = namedCtx((name) => {
    if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: PDF_DESCRIPTOR } };
    if (name === 'operation_preflight')
      return {
        ok: true,
        data: { operationId: 'pdf_template_family', selectedVersion: 1, missingRequired: [], blockers: [] },
      };
    return { ok: true, data: { run: { runId: 'run_pdf_2', status: 'created' } } };
  }, calls);

  await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: {
      templateFamily: 'brochure',
      tenantId: 'someone-elses-tenant',
      approved: true,
      tool_name: 'object_publish',
      principal: { kind: 'human', id: 'attacker', email: 'x@example.com' },
    },
  });
  const preflightArgs = calls.find((c) => c.name === 'operation_preflight')!.args;
  assert.equal(preflightArgs.tenantId, 'platform');
  assert.equal((preflightArgs.input as Record<string, unknown>).tenantId, 'platform');
  const dispatched = calls.find((c) => c.name === 'workflow_start_dry_run')!.args;
  assert.equal((dispatched.input as Record<string, unknown>).tenantId, 'platform');
  assert.equal('approved' in dispatched, false, 'the model can never smuggle a publish approval through this path');
});

test('run_workspace_workflow(operation_id) refuses an operation the catalog does not know — never treated as a usable workflow id', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) =>
      name === 'operation_get'
        ? { ok: true, data: { known: false, registeredOperationIds: ['pdf_template_family', 'site_inventory'] } }
        : { ok: true, data: {} },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'delete_everything',
    input: {},
  });
  assert.equal(result.is_error, true);
  const payload = JSON.parse(result.content) as { code: string; registered_operation_ids: string[] };
  assert.equal(payload.code, 'operation_not_found');
  assert.deepEqual(payload.registered_operation_ids, ['pdf_template_family', 'site_inventory']);
  assert.equal(calls.map((c) => c.name).join(','), 'operation_get', 'preflight and dispatch must never be reached');
  assert.equal(registered.length, 0, 'an unknown operation must never leave a phantom running request');
});

test('run_workspace_workflow(operation_id) refuses on a preflight blocker BEFORE dispatch — no phantom running request', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: PDF_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'pdf_template_family',
            selectedVersion: 1,
            missingRequired: ['templateFamily'],
            blockers: [{ code: 'missing_capability', message: 'pdf-tool bridge not configured' }],
          },
        };
      return { ok: true, data: { run: { runId: 'should_never_start' } } };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: {},
  });
  assert.equal(result.is_error, true);
  assert.equal((JSON.parse(result.content) as { code: string }).code, 'operation_not_ready');
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight',
    'workflow_start_dry_run must never be called'
  );
  assert.equal(registered.length, 0);
});

test('run_workspace_workflow leaves NO phantom request when the backend start itself fails (operation-routed AND plain paths)', async () => {
  for (const args of [{ operation_id: 'pdf_template_family', input: {} }, { input: { topic: 'plain article' } }]) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registered: Array<Record<string, unknown>> = [];
    const ctx = namedCtx(
      (name) => {
        if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: PDF_DESCRIPTOR } };
        if (name === 'operation_preflight')
          return {
            ok: true,
            data: { operationId: 'pdf_template_family', selectedVersion: 1, missingRequired: [], blockers: [] },
          };
        if (name === 'workflow_start_dry_run')
          return { ok: false, message: 'CMS-Agent is unreachable', code: 'upstream_unavailable' };
        return { ok: true, data: {} };
      },
      calls,
      registered
    );
    const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, args);
    assert.equal(result.is_error, true);
    assert.equal(
      registered.length,
      0,
      `a failed backend start must never register a running request (args: ${JSON.stringify(args)})`
    );
  }
});

test('run_workspace_workflow(request_id ALONE) resumes the durable request — never a second registration, never workflow_start_dry_run', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    () => ({ ok: true, data: { run: { runId: 'run_existing', status: 'running' } } }),
    calls,
    registered
  );
  (ctx.requests as { get: unknown }).get = async (id: string) =>
    id === 'req_agent_pdf_20260913_01' ? { title: 'Brochure family', workflow: { run_id: 'run_existing' } } : undefined;

  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    request_id: 'req_agent_pdf_20260913_01',
  });
  assert.equal(result.is_error, false);
  assert.deepEqual(
    calls.map((c) => c.name),
    ['workflow_run_all']
  );
  assert.deepEqual(calls[0]!.args, { runId: 'run_existing', budgetMs: 45_000 });
  assert.equal(registered.length, 0, 'resuming an existing request must never create a second one');
  const body = JSON.parse(result.content) as { resumed: boolean; request_id: string };
  assert.equal(body.resumed, true);
  assert.equal(body.request_id, 'req_agent_pdf_20260913_01');
});

test('run_workspace_workflow(request_id ALONE) refuses cleanly when the request has no workflow run yet, without registering anything', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(() => ({ ok: true, data: {} }), calls, registered);
  (ctx.requests as { get: unknown }).get = async () => ({ title: 'Not started yet', status: 'queued' });
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    request_id: 'req_agent_x_20260913_01',
  });
  assert.equal(result.is_error, true);
  assert.equal((JSON.parse(result.content) as { code: string }).code, 'no_workflow_run');
  assert.equal(calls.length, 0);
  assert.equal(registered.length, 0);
});

test('run_workspace_workflow parse: operation_id and workflow_id are mutually exclusive; a bare request_id is valid', () => {
  const tool = chatToolByName('run_workspace_workflow')!;
  const ctx = noBridgeCtx();
  assert.equal(
    tool.parse({ operation_id: 'pdf_template_family', workflow_id: 'publishing_conductor', input: {} }, ctx).ok,
    false
  );
  assert.equal(tool.parse({ operation_id: 'pdf_template_family', input: {} }, ctx).ok, true);
  assert.equal(tool.parse({ request_id: 'req_agent_x_20260913_01' }, ctx).ok, true);
  assert.equal(tool.parse({ request_id: 'req_agent_x_20260913_01', input: {} }, ctx).ok, true);
});

test('list_operations / get_operation / preflight_operation are read-class, auto-autonomy, and mirror the live catalog contract', async () => {
  for (const name of ['list_operations', 'get_operation', 'preflight_operation']) {
    assert.equal(chatToolByName(name)!.toolClass, 'read');
  }
  const defaults = resolveAutonomy(undefined, undefined);
  assert.equal(defaults.list_operations, 'auto');
  assert.equal(defaults.get_operation, 'auto');
  assert.equal(defaults.preflight_operation, 'auto');

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = namedCtx(
    (name) =>
      name === 'operation_list'
        ? { ok: true, data: { operations: [PDF_DESCRIPTOR] } }
        : name === 'operation_get'
          ? { ok: true, data: { known: true, descriptor: PDF_DESCRIPTOR } }
          : {
              ok: true,
              data: {
                operationId: 'pdf_template_family',
                selectedVersion: 1,
                missingRequired: [],
                blockers: [],
                effects: PDF_DESCRIPTOR.effects,
              },
            },
    calls
  );
  const list = await chatToolByName('list_operations')!.execute(ctx, {});
  assert.equal((JSON.parse(list.content) as { operations: unknown[] }).operations.length, 1);

  const got = await chatToolByName('get_operation')!.execute(ctx, { operation_id: 'pdf_template_family' });
  assert.equal((JSON.parse(got.content) as { known: boolean }).known, true);

  const pf = await chatToolByName('preflight_operation')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: { tenantId: 'someone-elses-tenant' },
  });
  const pfBody = JSON.parse(pf.content) as { needs_durable_registration: boolean };
  assert.equal(
    pfBody.needs_durable_registration,
    true,
    'a write-risk effect must be flagged as needing durable registration'
  );
  const preflightCall = calls.find((c) => c.name === 'operation_preflight')!;
  assert.equal(preflightCall.args.tenantId, 'platform', 'preflight_operation must ignore a model-supplied tenantId');
  assert.equal((preflightCall.args.input as Record<string, unknown>).tenantId, 'platform');
});
