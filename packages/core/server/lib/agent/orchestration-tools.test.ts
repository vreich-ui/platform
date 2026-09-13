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

// #313 dispatch fix: the bound workflow id is DELIBERATELY not
// PDF_DESCRIPTOR.operationId — every test below that expects a successful
// dispatch must prove workflow_start_dry_run receives THIS string, never the
// operation id, or it isn't actually exercising the fix.
const PDF_BINDING = { workflowId: 'pdf_family_conductor' };

// The one operation with a real binding in production: operationId and
// workflowId are genuinely different strings, and its inputMapping renames
// tenantId (the scoping field EVERY operation carries) alongside an
// operation-specific field — exactly the shape the scope-guarantee tests
// below need to exercise.
const VISUAL_IDENTITY_DESCRIPTOR = {
  operationId: 'visual_identity_review_change',
  version: 1,
  title: 'Visual identity review change',
  effects: [{ kind: 'apply', riskLevel: 'write' }],
};
const VISUAL_IDENTITY_BINDING = {
  workflowId: 'visual_identity',
  inputMapping: { tenantId: 'projectId', autoApply: 'apply' },
};

// A4 — the one EXECUTOR-bound operation in production (CMS-Agent #321):
// read-only (riskLevel "read"), so needsDurableRegistration(effects) is
// false and it is the operation the "answers inline, registers nothing"
// tests below exercise. Its executorBinding names the SAME field names the
// operation's own input already uses (tenantId, objectType, ...) — no
// inputMapping, unlike the workflow-bound fixtures above.
const SITE_INVENTORY_DESCRIPTOR = {
  operationId: 'site_inventory',
  version: 1,
  title: 'Site inventory',
  effects: [{ kind: 'read_site_inventory', riskLevel: 'read' }],
};
const SITE_INVENTORY_EXECUTOR_BINDING = {
  executorId: 'site_inventory_executor',
  operationId: 'site_inventory',
  inputSchema: { type: 'object', required: ['tenantId'] },
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
            executable: true,
            binding: PDF_BINDING,
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

  // #313 dispatch fix: the DISPATCHED workflow id is the binding's, never
  // the operation id — an operation is not a workflow, and this is the
  // string that would silently misroute to publishing_conductor if it stayed
  // PDF_DESCRIPTOR.operationId.
  assert.equal(
    (registered[0]!.workflow as { workflow_id: string }).workflow_id,
    PDF_BINDING.workflowId,
    'the registered workflow_id must be the BOUND workflow id, not the operation id'
  );
  assert.notEqual((registered[0]!.workflow as { workflow_id: string }).workflow_id, 'pdf_template_family');
  const dispatchedStart = calls.find((c) => c.name === 'workflow_start_dry_run')!.args;
  assert.equal(dispatchedStart.workflowId, PDF_BINDING.workflowId);

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
        data: {
          operationId: 'pdf_template_family',
          selectedVersion: 1,
          missingRequired: [],
          blockers: [],
          executable: true,
          binding: PDF_BINDING,
        },
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

// ─── the defect this file fixes: an unbound operation (executable: false)
// must hard-refuse, never reach workflow_start_dry_run with its operationId
// used as a workflowId (CMS-Agent falls back to publishing_conductor for an
// unregistered workflowId — a chat request for e.g. a PDF template family
// must never start a publishing run) ──────────────────────────────────────

const WORKFLOW_BINDING_GAP = {
  capability: 'workflow_binding',
  reason: 'not_supported',
  evidence: { operationId: 'pdf_template_family', implementingTask: 'A7' },
  remedy: 'Implement task A7 to bind pdf_template_family to a workflow.',
};

test('run_workspace_workflow(operation_id) hard-refuses executable: false with empty blockers/missingRequired — never dispatches, never registers', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [WORKFLOW_BINDING_GAP],
            executable: false,
            binding: null,
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
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight',
    'workflow_start_dry_run must never be called for a non-executable operation'
  );
  assert.equal(registered.length, 0, 'a refused operation must never register a request');

  const body = JSON.parse(result.content) as { code: string; remedy: string; implementing_task: string };
  assert.equal(body.code, 'operation_not_ready');
  assert.equal(body.remedy, WORKFLOW_BINDING_GAP.remedy, 'the refusal must carry the gap\'s own remedy');
  assert.equal(body.implementing_task, 'A7', 'the refusal must name the implementing task, not just refuse');
});

test('run_workspace_workflow(operation_id) refuses fail-safe when `executable` is absent but a not_supported gap is present (older CMS-Agent)', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [WORKFLOW_BINDING_GAP],
            // no `executable` field at all — an older CMS-Agent
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
  assert.equal(result.is_error, true, 'an absent `executable` must not be read as true');
  assert.equal(calls.map((c) => c.name).join(','), 'operation_get,operation_preflight');
  assert.equal(registered.length, 0);
  assert.equal((JSON.parse(result.content) as { implementing_task: string }).implementing_task, 'A7');
});

test('run_workspace_workflow(operation_id) does NOT refuse on a "not_configured" gap alone — every operation reports one with no configuredCapabilities', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [
              { capability: 'image_search', reason: 'not_configured', remedy: 'Configure image search.' },
            ],
            executable: true,
            binding: PDF_BINDING,
          },
        };
      return { ok: true, data: { run: { runId: 'run_ok', status: 'created' } } };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: { templateFamily: 'brochure' },
  });
  assert.equal(result.is_error, false, 'a not_configured gap alone must not block dispatch');
  assert.equal(calls.map((c) => c.name).join(','), 'operation_get,operation_preflight,workflow_start_dry_run');
  assert.equal(registered.length, 1);
});

test('run_workspace_workflow(operation_id) dispatches exactly as before when executable: true — no regression', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [],
            executable: true,
            binding: PDF_BINDING,
          },
        };
      return { ok: true, data: { run: { runId: 'run_ok_2', status: 'created' } } };
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
  assert.equal(registered.length, 1);
  assert.equal(registered[0]!.kind, 'pdf');
  assert.equal(calls.find((c) => c.name === 'workflow_start_dry_run')!.args.workflowId, PDF_BINDING.workflowId);
});

// ─── the dispatch-bound-workflow-id fix: binding.inputMapping + the
// tenant-scope guarantee surviving the rename ────────────────────────────────

test("run_workspace_workflow(operation_id) applies the binding's inputMapping renames to the dispatched input, passing through unmapped fields unchanged", async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get')
        return { ok: true, data: { known: true, descriptor: VISUAL_IDENTITY_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'visual_identity_review_change',
            selectedVersion: 1,
            missingRequired: [],
            blockers: [],
            executable: true,
            binding: VISUAL_IDENTITY_BINDING,
          },
        };
      return { ok: true, data: { run: { runId: 'run_vi_1', status: 'created' } } };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'visual_identity_review_change',
    input: { autoApply: true, changeSummary: 'Swap accent color' },
  });
  assert.equal(result.is_error, false);
  const dispatched = calls.find((c) => c.name === 'workflow_start_dry_run')!.args;
  assert.equal(dispatched.workflowId, 'visual_identity', 'dispatched under the BOUND workflow id, not the operation id');
  const dispatchedInput = dispatched.input as Record<string, unknown>;
  // autoApply -> apply: renamed, and the original key does not also survive.
  assert.equal(dispatchedInput.apply, true);
  assert.equal('autoApply' in dispatchedInput, false);
  // No mapping entry for changeSummary: passes through under its own name.
  assert.equal(dispatchedInput.changeSummary, 'Swap accent color');
  // tenantId -> projectId, and forced to the SITE's own project id.
  assert.equal(dispatchedInput.projectId, 'platform');
  assert.equal('tenantId' in dispatchedInput, false);
});

test('run_workspace_workflow(operation_id) never lets a model-supplied value survive under the tenant-scoping key — pre-rename (raw tenantId) or post-rename (the mapped-to name supplied directly)', async () => {
  for (const binding of [
    VISUAL_IDENTITY_BINDING, // tenantId -> projectId
    { workflowId: 'visual_identity' }, // no mapping at all: the key stays tenantId
  ]) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const ctx = namedCtx((name) => {
      if (name === 'operation_get')
        return { ok: true, data: { known: true, descriptor: VISUAL_IDENTITY_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'visual_identity_review_change',
            selectedVersion: 1,
            missingRequired: [],
            blockers: [],
            executable: true,
            binding,
          },
        };
      return { ok: true, data: { run: { runId: 'run_vi_2', status: 'created' } } };
    }, calls);

    await chatToolByName('run_workspace_workflow')!.execute(ctx, {
      operation_id: 'visual_identity_review_change',
      input: {
        autoApply: true,
        // Pre-rename spoof: the model's own tenantId, supplied directly.
        tenantId: 'attacker-tenant-raw',
        // Post-rename spoof: the model guesses the workflow's own field name
        // (what tenantId maps to when a mapping exists) and supplies THAT
        // directly, trying to bypass the rename entirely.
        projectId: 'attacker-tenant-mapped',
      },
    });
    const dispatchedInput = (calls.find((c) => c.name === 'workflow_start_dry_run')!.args.input ??
      {}) as Record<string, unknown>;
    const tenantScopeKey = (binding as { inputMapping?: Record<string, string> }).inputMapping?.tenantId ?? 'tenantId';
    assert.equal(
      dispatchedInput[tenantScopeKey],
      'platform',
      `cmsAgent.projectId must win under the scope key "${tenantScopeKey}", regardless of mapping`
    );
    if (tenantScopeKey !== 'tenantId') {
      assert.equal('tenantId' in dispatchedInput, false, 'the pre-rename key must not also survive');
    }
  }
});

test('run_workspace_workflow(operation_id) refuses when preflight clears every check but the binding carries no workflowId — never dispatches, never registers, never falls back to the operation id', async () => {
  for (const binding of [undefined, null]) {
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
              missingRequired: [],
              blockers: [],
              capabilityGaps: [],
              executable: true,
              binding,
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
    assert.equal(result.is_error, true, `binding: ${JSON.stringify(binding)}`);
    assert.equal(
      calls.map((c) => c.name).join(','),
      'operation_get,operation_preflight',
      'workflow_start_dry_run must never be called without a bound workflow id'
    );
    assert.equal(registered.length, 0, 'an operation with no bound workflow must never register a running request');
    const body = JSON.parse(result.content) as { code: string; error: string };
    assert.equal(body.code, 'operation_not_ready');
    assert.match(body.error, /no implementing workflow/i);
  }
});

test('run_workspace_workflow: the plain workflow_id path (no operation_id) sends an arbitrary workflowId straight to workflow_start_dry_run — NOT covered by this fix', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    () => ({ ok: true, data: { run: { runId: 'run_plain', status: 'created' } } }),
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    workflow_id: 'not_a_registered_workflow_id',
    input: { topic: 'whatever' },
  });
  assert.equal(result.is_error, false, 'documenting current behaviour: the plain path never consults the catalog');
  assert.equal(
    calls.map((c) => c.name).join(','),
    'workflow_start_dry_run',
    'operation_get/operation_preflight are never called on the plain workflow_id path'
  );
  assert.equal((calls[0]!.args as { workflowId?: string }).workflowId, 'not_a_registered_workflow_id');
});

// ─── A4 (CMS-Agent #321): executor-bound operations dispatch through
// operation.execute, not workflow_start_dry_run — and, being read-only,
// answer inline with NO durable registration (no req_…, no phantom running
// entry) ───────────────────────────────────────────────────────────────────

test('run_workspace_workflow(operation_id: site_inventory) dispatches operation_execute, NOT workflow_start_dry_run, and registers no request', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: SITE_INVENTORY_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'site_inventory',
            selectedVersion: 1,
            missingRequired: [],
            blockers: [],
            capabilityGaps: [],
            effects: SITE_INVENTORY_DESCRIPTOR.effects,
            executable: true,
            binding: null,
            executorBinding: SITE_INVENTORY_EXECUTOR_BINDING,
          },
        };
      if (name === 'operation_execute')
        return {
          ok: true,
          data: {
            operationId: 'site_inventory',
            tenantId: 'platform',
            executed: true,
            refusal: null,
            result: { objects: [{ objectId: 'page_home', objectType: 'page' }] },
            completion: [{ id: 'inventory_returned' }],
          },
        };
      // workflow_start_dry_run — must never be reached.
      return { ok: true, data: { run: { runId: 'should_never_start' } } };
    },
    calls,
    registered
  );

  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'site_inventory',
    input: { objectType: 'page' },
  });

  assert.equal(result.is_error, false);
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight,operation_execute',
    'workflow_start_dry_run must never be called for an executor-bound operation'
  );
  assert.equal(
    calls.some((c) => c.name === 'workflow_start_dry_run'),
    false
  );

  // THE fix (item 3): a pure read answers inline and registers NOTHING.
  assert.equal(registered.length, 0, 'a read-only executor dispatch must never call ctx.requests.register');
  const body = JSON.parse(result.content) as { operation_id: string; result: unknown; request_id?: string };
  assert.equal(body.operation_id, 'site_inventory');
  assert.deepEqual(body.result, { objects: [{ objectId: 'page_home', objectType: 'page' }] });
  assert.equal('request_id' in body, false, 'no req_… id is minted for an inline executor result');
});

test('run_workspace_workflow(operation_id: site_inventory) sets tenantId from the SITE, never from the model — no inputMapping rename on this path', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = namedCtx((name) => {
    if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: SITE_INVENTORY_DESCRIPTOR } };
    if (name === 'operation_preflight')
      return {
        ok: true,
        data: {
          operationId: 'site_inventory',
          selectedVersion: 1,
          missingRequired: [],
          blockers: [],
          effects: SITE_INVENTORY_DESCRIPTOR.effects,
          executable: true,
          binding: null,
          executorBinding: SITE_INVENTORY_EXECUTOR_BINDING,
        },
      };
    if (name === 'operation_execute')
      return {
        ok: true,
        data: { operationId: 'site_inventory', executed: true, refusal: null, result: {}, completion: [] },
      };
    return { ok: true, data: {} };
  }, calls);

  await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'site_inventory',
    input: {
      objectType: 'page',
      // Pre-rename spoof: the model's own tenantId, supplied directly.
      tenantId: 'attacker-tenant',
      // A model-supplied projectId is inert too — this path never renames
      // tenantId -> projectId (there is no inputMapping at all here), so
      // projectId is just an ordinary, unused field on this operation.
      projectId: 'attacker-tenant-mapped',
      approved: true,
      principal: { kind: 'human', id: 'attacker', email: 'x@example.com' },
    },
  });

  const preflightArgs = calls.find((c) => c.name === 'operation_preflight')!.args;
  assert.equal(preflightArgs.tenantId, 'platform');
  assert.equal((preflightArgs.input as Record<string, unknown>).tenantId, 'platform');

  const executeArgs = calls.find((c) => c.name === 'operation_execute')!.args;
  assert.equal(executeArgs.tenantId, 'platform', 'the top-level tenantId sent to operation_execute must be the site');
  const executeInput = executeArgs.input as Record<string, unknown>;
  assert.equal(executeInput.tenantId, 'platform', "the operation's own input.tenantId must be the site, not the model's");
  assert.notEqual(executeInput.tenantId, 'attacker-tenant');
  assert.equal(executeInput.projectId, 'attacker-tenant-mapped', "projectId is just an ordinary field here — passed through unrenamed, never treated as the scope key");
  // Same guarantee the workflow path's own equivalent test makes: the model
  // can never smuggle a publish approval through as a TOP-LEVEL argument to
  // the downstream call — operation_execute's own args carry only
  // operationId/tenantId/input, never an `approved` sibling field.
  assert.equal('approved' in executeArgs, false, 'the model can never smuggle a publish approval through this path');
});

const EXECUTE_REFUSALS: Array<{ code: string; message: string }> = [
  { code: 'not_read_only', message: '"site_inventory" declares 1 non-read effect(s); operation.execute only runs read operations.' },
  { code: 'unknown_operation', message: 'No operation is registered as "site_inventory".' },
  { code: 'no_executor_binding', message: '"site_inventory" has no registered EXECUTOR that operation.execute can run today.' },
  { code: 'executor_failed', message: 'Executor for "site_inventory" reported a failure.' },
  { code: 'input_invalid', message: 'Input for "site_inventory" did not pass preflight.' },
];

test('run_workspace_workflow(operation_id: site_inventory) surfaces EACH real operation_execute refusal — code/message/evidence, never flattened — and registers no request', async () => {
  for (const refusal of EXECUTE_REFUSALS) {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const registered: Array<Record<string, unknown>> = [];
    const ctx = namedCtx(
      (name) => {
        if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: SITE_INVENTORY_DESCRIPTOR } };
        if (name === 'operation_preflight')
          return {
            ok: true,
            data: {
              operationId: 'site_inventory',
              selectedVersion: 1,
              missingRequired: [],
              blockers: [],
              effects: SITE_INVENTORY_DESCRIPTOR.effects,
              executable: true,
              binding: null,
              executorBinding: SITE_INVENTORY_EXECUTOR_BINDING,
            },
          };
        if (name === 'operation_execute')
          return {
            ok: true,
            data: {
              operationId: 'site_inventory',
              executed: false,
              refusal: { code: refusal.code, message: refusal.message, evidence: { reason: refusal.code } },
              result: null,
              completion: [],
            },
          };
        return { ok: true, data: { run: { runId: 'should_never_start' } } };
      },
      calls,
      registered
    );
    const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
      operation_id: 'site_inventory',
      input: { objectType: 'page' },
    });
    assert.equal(result.is_error, true, refusal.code);
    const body = JSON.parse(result.content) as { code: string; error: string; evidence: unknown };
    assert.equal(body.code, refusal.code, `the REAL refusal code must survive, not a flattened generic one`);
    assert.equal(body.error, refusal.message, 'the REAL refusal message must survive');
    assert.deepEqual(body.evidence, { reason: refusal.code }, 'refusal evidence must survive');
    assert.equal(registered.length, 0, `a refused operation_execute call (${refusal.code}) must never register a request`);
  }
});

test('run_workspace_workflow(operation_id: site_inventory) treats a transport failure from operation_execute as a refusal too — registers no request', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: SITE_INVENTORY_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'site_inventory',
            selectedVersion: 1,
            missingRequired: [],
            blockers: [],
            effects: SITE_INVENTORY_DESCRIPTOR.effects,
            executable: true,
            binding: null,
            executorBinding: SITE_INVENTORY_EXECUTOR_BINDING,
          },
        };
      if (name === 'operation_execute') return { ok: false, message: 'CMS-Agent is unreachable', code: 'upstream_unavailable' };
      return { ok: true, data: {} };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'site_inventory',
    input: {},
  });
  assert.equal(result.is_error, true);
  assert.equal((JSON.parse(result.content) as { code: string }).code, 'upstream_unavailable');
  assert.equal(registered.length, 0);
});

// ─── landing-order safety: CMS-Agent may not have granted operation_execute
// to a tenant's scoped chat bearer yet (a cross-tenant pin defect on the
// CMS-Agent side has to land first — mcpEndpoint.ts scopes by
// projectId/project_id only, operation_execute scopes by tenantId). Both that
// gap AND a plain "not in the allowlist yet" surface as the SAME opaque
// cms_agent_auth_failed 401 CMS-Agent's client deliberately never
// disambiguates — this must read as a clear, actionable "not granted yet"
// message, never a generic failure and never something worth retrying ──────

test('run_workspace_workflow(operation_id: site_inventory) surfaces a clear, actionable message when operation_execute itself is not yet granted to this bearer — not a generic failure, registers no request', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) => {
      if (name === 'operation_get') return { ok: true, data: { known: true, descriptor: SITE_INVENTORY_DESCRIPTOR } };
      if (name === 'operation_preflight')
        return {
          ok: true,
          data: {
            operationId: 'site_inventory',
            selectedVersion: 1,
            missingRequired: [],
            blockers: [],
            effects: SITE_INVENTORY_DESCRIPTOR.effects,
            executable: true,
            binding: null,
            executorBinding: SITE_INVENTORY_EXECUTOR_BINDING,
          },
        };
      // operation_get/operation_preflight succeeded with this SAME bearer
      // moments earlier (above) — the auth failure lands ONLY on
      // operation_execute, exactly the shape a not-yet-granted execute
      // surface (or the tenantId/projectId scoping gap) produces.
      if (name === 'operation_execute')
        return {
          ok: false,
          code: 'cms_agent_auth_failed',
          message:
            'CMS-Agent rejected the credential. The site token may be wrong, or scoped to a different project — the service returns the same response for both.',
        };
      return { ok: true, data: {} };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'site_inventory',
    input: { objectType: 'page' },
  });
  assert.equal(result.is_error, true);
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight,operation_execute',
    'the diagnosis relies on operation_get/operation_preflight having already succeeded with this bearer'
  );
  const body = JSON.parse(result.content) as { code: string; error: string; evidence: unknown };
  assert.equal(body.code, 'operation_execute_not_granted', 'a specific code, not the generic cms_agent_auth_failed');
  assert.match(body.error, /not yet granted|cannot run catalog operations yet/i);
  assert.match(body.error, /credential reconciler/i, 'must name the actual remedy — an operator running the reconciler');
  assert.match(body.error, /retrying this exact request will not help/i, 'must discourage a retry loop, not invite one');
  assert.deepEqual(body.evidence, { operationId: 'site_inventory' });
  assert.equal(registered.length, 0, 'a not-yet-granted refusal must never register a request');
});

test('run_workspace_workflow(operation_id: site_inventory) does NOT special-case a genuine cms_agent_auth_failed on the FIRST call (operation_get) — the diagnosis only applies once operation_get/operation_preflight have already proven the bearer works', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = namedCtx(
    (name) =>
      name === 'operation_get'
        ? { ok: false, code: 'cms_agent_auth_failed', message: 'CMS-Agent rejected the credential.' }
        : { ok: true, data: {} },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'site_inventory',
    input: {},
  });
  assert.equal(result.is_error, true);
  const body = JSON.parse(result.content) as { code: string };
  // The generic transport error surfaces unmodified here — operation_execute
  // was never even reached, so there is nothing yet to diagnose as
  // "not granted specifically".
  assert.equal(body.code, 'cms_agent_auth_failed');
  assert.equal(calls.map((c) => c.name).join(','), 'operation_get');
  assert.equal(registered.length, 0);
});

test('run_workspace_workflow(operation_id) refuses when preflight carries NEITHER binding nor executorBinding — never dispatches either surface, never registers', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [WORKFLOW_BINDING_GAP],
            executable: false,
            binding: null,
            executorBinding: null,
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
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight',
    'neither workflow_start_dry_run nor operation_execute may be called'
  );
  assert.equal(registered.length, 0);
  assert.equal((JSON.parse(result.content) as { code: string }).code, 'operation_not_ready');
});

test('run_workspace_workflow(operation_id) dispatches the WORKFLOW path unchanged when the preflight response has no executorBinding field at all — an older CMS-Agent (predates A4)', async () => {
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
            missingRequired: [],
            blockers: [],
            capabilityGaps: [],
            executable: true,
            binding: PDF_BINDING,
            // no executorBinding key at all — a CMS-Agent that predates A4.
          },
        };
      return { ok: true, data: { run: { runId: 'run_pdf_legacy', status: 'created' } } };
    },
    calls,
    registered
  );
  const result = await chatToolByName('run_workspace_workflow')!.execute(ctx, {
    operation_id: 'pdf_template_family',
    input: { templateFamily: 'brochure' },
  });
  assert.equal(result.is_error, false);
  assert.equal(
    calls.map((c) => c.name).join(','),
    'operation_get,operation_preflight,workflow_start_dry_run',
    'the workflow path must behave exactly as it did before A4'
  );
  assert.equal(calls.find((c) => c.name === 'workflow_start_dry_run')!.args.workflowId, PDF_BINDING.workflowId);
  assert.equal(registered.length, 1, 'a write-risk workflow-bound operation still registers a running request');
});
