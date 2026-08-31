/**
 * Bug B (budget-raise-card) — the two-call sequence behind both raise-and-
 * retry buttons on the failure card: write the new ceiling, then retry the
 * node that stopped on the old one. Pulled out of `admin-request-activity.ts`
 * as its own pure(ish) function, `bridge`-injected the same way `sweep.ts`
 * injects `SweepBridge` — so "the handler calls the two CMS-Agent tools in
 * the right order, and stops after the first failure" is provable with a
 * fake bridge and no live MCP session, the same posture `sweep.test.ts`
 * already established for the sweeper's own CMS-Agent calls.
 */

export interface BudgetOverrideBridge {
  callTool<T = Record<string, unknown>>(
    tool: string,
    args: Record<string, unknown>
  ): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }>;
}

export type BudgetRaiseScope = 'for_run' | 'default';

export interface BudgetRaiseOutcome {
  ok: boolean;
  /** The CMS-Agent tool names actually called, in order — the second is absent when the first fails. */
  calls: readonly string[];
  /** Which of the two calls failed, when `ok` is false. */
  failedTool?: string;
  code?: string;
  message?: string;
}

/**
 * `scope: 'for_run'` writes `workflow.set_node_budget_override` (a per-run
 * ceiling); `'default'` writes `workspace.update_node_model_config` (the
 * node's standing default for every future run). Either way `workflow.
 * retry_node` runs SECOND and only when the write above succeeded — the
 * write is durable even if the retry does not land (the next sweep, or a
 * manual retry, picks the node up with the new ceiling already in place), but
 * retrying with the OLD ceiling still in force would only fail the same way
 * again.
 */
export const raiseNodeBudgetAndRetry = async (
  bridge: BudgetOverrideBridge,
  scope: BudgetRaiseScope,
  runId: string,
  nodeId: string,
  budgetUsd: number
): Promise<BudgetRaiseOutcome> => {
  const writeTool = scope === 'for_run' ? 'workflow_set_node_budget_override' : 'workspace_update_node_model_config';
  const writeArgs =
    scope === 'for_run'
      ? { runId, nodeId, budgetUsd }
      : { id: nodeId, patch: { modelConfig: { budgetUsd } } };

  const calls: string[] = [writeTool];
  const write = await bridge.callTool(writeTool, writeArgs);
  if (!write.ok) return { ok: false, calls, failedTool: writeTool, code: write.code, message: write.message };

  calls.push('workflow_retry_node');
  const retried = await bridge.callTool('workflow_retry_node', { runId, nodeId });
  if (!retried.ok) {
    return { ok: false, calls, failedTool: 'workflow_retry_node', code: retried.code, message: retried.message };
  }

  return { ok: true, calls };
};
