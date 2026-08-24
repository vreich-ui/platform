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

test('run_workspace_workflow REGISTERS the request with the run_id from CMS-Agent\'s {run:…} envelope', async () => {
  // The W19 regression this file previously could not catch. `callTool` unwraps
  // only the `{ok,data}` envelope, so `data` is `{ run, continued }` — reading
  // `data.runId` gave `undefined`, the tool registered the request with NO
  // workflow block, and the sweeper then had nothing to poll: the request sat
  // at `queued` for ever while its run failed unseen. Assert the LINK, not just
  // the echoed run_id.
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const registered: Array<Record<string, unknown>> = [];
  const ctx = bridgeCtx(
    () => ({ run: { runId: 'run_env', status: 'created', nodes: [{ nodeId: 'a' }, { nodeId: 'b' }] }, continued: true }),
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
  const workflow = registered[0]!.workflow as { run_id: string; workflow_id: string; project_id: string; node_total?: number } | undefined;
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
