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
import { chatToolByName, resolveAutonomy, type ToolContext } from './tools.js';

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

// ─── D2: the risk floor and the safe-run exclusion ──────────────────────────

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

test('run_workspace_workflow is excluded from the client-side safe-run allow-list', () => {
  assert.equal(isRunSafeApproval('run_workspace_workflow'), false);
});

// ─── bounded, editor-safe projections ───────────────────────────────────────

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
        { nodeId: 'draft_writer', status: 'completed', output: huge },
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
  assert.deepEqual(payload.nodes, [
    { id: 'draft_writer', status: 'completed' },
    { id: 'article_body', status: 'pending' },
  ]);
});

// ─── run_workspace_workflow: start/advance, no `approved`, input-echo dry-run ─

test('run_workspace_workflow start mode sends projectId + input to workflow_start_dry_run and NEVER `approved`', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({ runId: 'run_new', status: 'created' }), calls);
  const tool = chatToolByName('run_workspace_workflow')!;

  const parsed = tool.parse({ input: { topic: 'retinol basics' }, budget_usd: 2 }, ctx);
  assert.equal(parsed.ok, true);
  const result = await tool.execute(ctx, { input: { topic: 'retinol basics' }, budget_usd: 2 });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_start_dry_run');
  assert.deepEqual(calls[0]!.args, { projectId: 'platform', input: { topic: 'retinol basics' }, budgetUsd: 2 });
  assert.equal('approved' in calls[0]!.args, false);
  assert.equal((JSON.parse(result.content) as { run_id: string }).run_id, 'run_new');
});

test('run_workspace_workflow advance mode calls workflow_run_all WITHOUT approved — the CMS-Agent publish gate stays armed', async () => {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const ctx = bridgeCtx(() => ({ runId: 'run_1', status: 'running', driverNote: 'stopped before publish-risk' }), calls);
  const tool = chatToolByName('run_workspace_workflow')!;
  const result = await tool.execute(ctx, { run_id: 'run_1' });
  assert.equal(result.is_error, false);
  assert.equal(calls[0]!.name, 'workflow_run_all');
  assert.deepEqual(calls[0]!.args, { runId: 'run_1' });
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
    const args = name === 'get_workspace_run' ? { run_id: 'r' } : name === 'run_workspace_workflow' ? { run_id: 'r' } : {};
    const result = await tool.execute(ctx, args);
    assert.equal(result.is_error, true, name);
    assert.match(result.content, /not configured/i);
  }
});
