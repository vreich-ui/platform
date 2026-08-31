/**
 * Bug B (budget-raise-card) — proves the admin-request-activity handler's
 * two-call sequence for both raise-and-retry buttons: which CMS-Agent tool
 * each `scope` writes with, that it is called before the retry (never
 * concurrently, never after), and that a failed write never reaches the
 * retry at all.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { raiseNodeBudgetAndRetry, type BudgetOverrideBridge } from './budget-override.js';

const recordingBridge = (
  results: Record<string, { ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }>
): { bridge: BudgetOverrideBridge; calls: Array<{ tool: string; args: Record<string, unknown> }> } => {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const bridge: BudgetOverrideBridge = {
    async callTool<T>(tool: string, args: Record<string, unknown>) {
      calls.push({ tool, args });
      return (results[tool] ?? { ok: true, data: {} }) as { ok: true; data: T } | { ok: false; code: string; message: string };
    },
  };
  return { bridge, calls };
};

describe('raiseNodeBudgetAndRetry', () => {
  it("scope 'for_run' calls workflow_set_node_budget_override, THEN workflow_retry_node — in that order, with runId/nodeId/budgetUsd", async () => {
    const { bridge, calls } = recordingBridge({});
    const outcome = await raiseNodeBudgetAndRetry(bridge, 'for_run', 'run_1', 'artifact_plan', 5);
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      calls.map((c) => c.tool),
      ['workflow_set_node_budget_override', 'workflow_retry_node']
    );
    assert.deepEqual(calls[0]?.args, { runId: 'run_1', nodeId: 'artifact_plan', budgetUsd: 5 });
    assert.deepEqual(calls[1]?.args, { runId: 'run_1', nodeId: 'artifact_plan' });
  });

  it("scope 'default' calls workspace_update_node_model_config, THEN workflow_retry_node — in that order, with the modelConfig.budgetUsd patch shape", async () => {
    const { bridge, calls } = recordingBridge({});
    const outcome = await raiseNodeBudgetAndRetry(bridge, 'default', 'run_1', 'artifact_plan', 5);
    assert.equal(outcome.ok, true);
    assert.deepEqual(
      calls.map((c) => c.tool),
      ['workspace_update_node_model_config', 'workflow_retry_node']
    );
    assert.deepEqual(calls[0]?.args, { id: 'artifact_plan', patch: { modelConfig: { budgetUsd: 5 } } });
    assert.deepEqual(calls[1]?.args, { runId: 'run_1', nodeId: 'artifact_plan' });
  });

  it('a failed write never reaches the retry call at all', async () => {
    const { bridge, calls } = recordingBridge({
      workflow_set_node_budget_override: { ok: false, code: 'not_found', message: 'No such node.' },
    });
    const outcome = await raiseNodeBudgetAndRetry(bridge, 'for_run', 'run_1', 'artifact_plan', 5);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failedTool, 'workflow_set_node_budget_override');
    assert.deepEqual(calls.map((c) => c.tool), ['workflow_set_node_budget_override']);
  });

  it('a failed retry is reported distinctly from a failed write, after the write already ran', async () => {
    const { bridge, calls } = recordingBridge({
      workflow_retry_node: { ok: false, code: 'run_read_failed', message: 'CMS-Agent unreachable.' },
    });
    const outcome = await raiseNodeBudgetAndRetry(bridge, 'default', 'run_1', 'artifact_plan', 5);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.failedTool, 'workflow_retry_node');
    assert.deepEqual(calls.map((c) => c.tool), ['workspace_update_node_model_config', 'workflow_retry_node']);
  });
});
