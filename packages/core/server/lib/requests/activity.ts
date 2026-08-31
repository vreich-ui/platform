/**
 * W19 — the activity projection: what an editor watching a run actually sees.
 *
 * CMS-Agent already records far more than the chat has ever shown. This module
 * turns two of its reads — `workflow_get_run` and `workflow_get_run_cost` —
 * into ONE bounded payload the browser can poll every few seconds:
 *
 *   • per node: status, how long it took, how long it USUALLY takes, the tools
 *     it called, its warnings in editor language, what it produced, its cost;
 *   • a real ETA, from `plan.nodeTimingAggregates` (p50/p95 measured across
 *     this workflow's own history) — never a spinner with no number;
 *   • the running cost, so an expensive node is visible while it is still
 *     running rather than at the invoice;
 *   • the recovery sentence CMS-Agent already writes for a failed run
 *     ("14 completed stages intact… nothing completed is recomputed"), which
 *     until now nothing displayed.
 *
 * Severity throughout is `lib/admin/activity-severity.ts`: red only for a step
 * that died. Bounded by construction — node count is capped, tool lists are
 * capped, and no node input/output ever crosses this boundary.
 */
import {
  classifyNode,
  classifyToolCall,
  classifyWarning,
  worstSeverity,
  type ClassifiedWarning,
  type Severity,
} from '../../../lib/admin/activity-severity.js';
import { nodeLabel } from '../../../lib/admin/request-logic.js';
import {
  derivePublication,
  isAdvisoryApproval,
  type PublicationEvidence,
  type PublicationState,
} from './publication-evidence.js';

/** Hard caps: this payload is polled every few seconds and rides a JSON response. */
export const ACTIVITY_NODE_MAX = 64;
export const ACTIVITY_TOOLS_PER_NODE_MAX = 12;

export interface ActivityToolCall {
  id: string;
  status: string;
  severity: Severity;
  duration_ms?: number;
  error_code?: string;
}

export interface ActivityNode {
  id: string;
  /** Editor words ("drafting"), falling back to the raw id rather than hiding an unknown node. */
  label: string;
  status: string;
  severity: Severity;
  started_at?: string;
  completed_at?: string;
  duration_ms?: number;
  /** p50 for this node across this workflow's history — the honest "usually". */
  typical_ms?: number;
  /** True when a RUNNING node has already passed its own p95. */
  overrunning?: boolean;
  produces?: string;
  skip_reason?: string;
  warnings: ClassifiedWarning[];
  errors: string[];
  /**
   * Task B (provider-error-details) — CMS-Agent's own structured detail for
   * this node's failure (executor.ts's `state.output.error`), when present.
   * `operatorAction`/`providerStatus`/`providerMessage` exist only for a
   * classified provider HTTP error (provider_quota/provider_rate_limit) or
   * CMS-Agent's own budget guard (budget_exceeded) — absent for every other
   * failure code, exactly like `errors` above already is for a node that
   * never failed.
   */
  failure?: {
    code: string;
    message: string;
    operatorAction?: string;
    providerStatus?: number;
    providerMessage?: string;
    /**
     * Bug B (budget-raise-card) — CMS-Agent's own numbers for a
     * `budget_exceeded` failure (post `budget-override-and-ui-save`),
     * verbatim from `output.error.details`. Absent for every other failure
     * code, and for an older CMS-Agent that has not yet started sending it —
     * `suggestedBudgetRaise` (`lib/admin/budget-raise.ts`) falls back to
     * parsing the two dollar figures out of `message` when this is missing.
     */
    details?: { nodeId?: string; budgetUsd?: number; spentUsd?: number; nextTurnEstimateUsd?: number; suggestedBudgetUsd?: number };
  };
  tools: ActivityToolCall[];
  cost?: { tokens: number; usd: number };
}

export interface ActivityView {
  run_id: string;
  status: string;
  /** Narrowed on purpose: the UI's placeholder badge compares against 'mock'. */
  execution_mode?: 'mock' | 'openai';
  live_output?: boolean;
  severity: Severity;
  /** One editor sentence for the collapsed line. */
  headline: string;
  /** `done` counts settled nodes — `skipped` is broken out so "18 done" is not read as "18 ran". */
  progress: { done: number; total: number; failed: number; running: number; skipped: number };
  /** Absent when the workflow has no timing history yet — better nothing than a made-up number. */
  eta?: { p50_ms: number; p95_ms: number; based_on_runs: number };
  cost?: { input_tokens: number; output_tokens: number; usd: number; most_expensive_node?: string };
  /** CMS-Agent's own recovery advice for a stopped run, verbatim. */
  recovery?: {
    strategy: string;
    node_id?: string;
    sentence: string;
    reusable_stages: number;
    /**
     * Task B, item 4: present only when the node `node_id` names failed with
     * a classified provider error or CMS-Agent's own budget guard. A "Retry
     * this step" affordance must not be offered when this is set — the
     * operator action IS the next step (top up credit, wait, raise the
     * budget), and offering "retry" next to it invites clicking the one that
     * will only fail the same way again.
     */
    operator_action?: string;
  };
  /**
   * GENUINE holds only — entries a human must act on. An `approvalsRequired`
   * entry CMS-Agent wrote as an audit record of a node that proceeded under
   * the project's autonomous policy (`source: "policy_autonomous"`, "Advisory
   * only — nothing is held") is NOT here; it is in `policy_records`. This is
   * the list the approve/reject card, the headline and the severity are built
   * from, so an advisory record can never grow buttons.
   */
  approvals: Array<{ node_id: string; reason: string; requested_at?: string }>;
  /** Advisory records: publish-risk nodes that proceeded autonomously. Informational; nothing waits. */
  policy_records: Array<{ node_id: string; reason: string; requested_at?: string; source?: string }>;
  /** What the publish/release tail did, from the executors' own evidence. Absent until a publish is committed. */
  publication?: PublicationEvidence;
  nodes: ActivityNode[];
}

/**
 * Executor outputs the caller fetched separately (`node_get_latest_output`
 * for `publish_executor` / `release_executor`), keyed by node id. The compact
 * `workflow_get_run` view carries no node output, and the full view is ~1MB
 * — too much for a poll. Optional: without them the projection still reads
 * the compact warnings and never claims more than they prove.
 */
export interface ProjectActivityOptions {
  nodeOutputs?: Readonly<Record<string, unknown>>;
}

// ─── tolerant readers (this is live wire data; it must never throw) ──────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value ? value : undefined);
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const strings = (value: unknown): string[] => arr(value).filter((item): item is string => typeof item === 'string');

const SETTLED = new Set(['completed', 'skipped']);

const projectTools = (raw: unknown): ActivityToolCall[] =>
  arr(raw)
    // Filter BEFORE slicing: malformed entries used to eat the tool budget and
    // silently hide the real calls behind them.
    .filter(isRecord)
    .slice(0, ACTIVITY_TOOLS_PER_NODE_MAX)
    .map((call) => {
      const status = str(call.status) ?? 'unknown';
      return {
        id: str(call.toolId) ?? 'tool',
        status,
        severity: classifyToolCall({ status, ...(str(call.errorCode) ? { errorCode: str(call.errorCode)! } : {}) }),
        ...(num(call.durationMs) !== undefined ? { duration_ms: num(call.durationMs)! } : {}),
        ...(str(call.errorCode) ? { error_code: str(call.errorCode)! } : {}),
      };
    });

/**
 * The one editor sentence for the collapsed line. Ordered by what the editor
 * needs to know first: something is waiting on you > something died > what it
 * is doing right now.
 */
export const activityHeadline = (input: {
  status: string;
  severity: Severity;
  runningLabel?: string;
  failedLabel?: string;
  /** Genuine holds only — never the advisory policy records. */
  approvals: number;
  /** From the executors' own evidence; outranks a bare "Finished". */
  publication?: PublicationState;
}): string => {
  if (input.approvals > 0) return 'Waiting for your approval';
  if (input.status === 'blocked' || input.status === 'paused') return 'Paused — needs a decision from you';
  if (input.severity === 'failure') return input.failedLabel ? `Stopped at ${input.failedLabel}` : 'Stopped';
  if (input.publication === 'live') return 'Live';
  if (input.publication === 'published_pending_release') return 'Published — awaiting release confirmation';
  if (input.status === 'completed') return 'Finished';
  if (input.status === 'cancelled') return 'Cancelled';
  if (input.runningLabel) return input.runningLabel.charAt(0).toUpperCase() + input.runningLabel.slice(1);
  if (input.status === 'queued') return 'Starting';
  return 'Working';
};

/**
 * Remaining time from measured history: p50 of every node not yet settled,
 * less whatever the running node has already spent. `based_on_runs` is the
 * smallest sample behind the estimate, so the UI can be honest about a thin one.
 */
export const estimateRemaining = (
  nodes: readonly { id: string; status: string; started_at?: string }[],
  timings: Record<string, { p50DurationMs?: number; p95DurationMs?: number; count?: number }>,
  nowMs: number
): ActivityView['eta'] => {
  let p50 = 0;
  let p95 = 0;
  let samples = Number.POSITIVE_INFINITY;
  let sawTiming = false;
  for (const node of nodes) {
    if (SETTLED.has(node.status)) continue;
    const timing = timings[node.id];
    if (!timing) continue;
    sawTiming = true;
    const typical = timing.p50DurationMs ?? 0;
    const worst = timing.p95DurationMs ?? typical;
    // A NaN from an unparseable timestamp used to flow through Math.max and
    // serialize the whole estimate as null — the ETA silently vanished.
    const startedMs = node.status === 'running' && node.started_at ? Date.parse(node.started_at) : Number.NaN;
    const elapsed = Number.isFinite(startedMs) && Number.isFinite(nowMs) ? Math.max(0, nowMs - startedMs) : 0;
    p50 += Math.max(0, typical - elapsed);
    p95 += Math.max(0, worst - elapsed);
    samples = Math.min(samples, timing.count ?? 0);
  }
  if (!sawTiming) return undefined;
  return { p50_ms: Math.round(p50), p95_ms: Math.round(p95), based_on_runs: Number.isFinite(samples) ? samples : 0 };
};

/** `run` is workflow_get_run's data; `cost` is workflow_get_run_cost's (optional — the view degrades without it). */
export const projectActivity = (
  payload: unknown,
  cost: unknown,
  nowMs: number = Date.now(),
  options: ProjectActivityOptions = {}
): ActivityView | undefined => {
  if (!isRecord(payload)) return undefined;
  // CMS-Agent answers `workflow_get_run` with `ok({ run, mode, stall })`, and the
  // client unwraps only the `{ok,data}` envelope — so what arrives here is that
  // object, not the run row. Reading `runId` off it yielded undefined and this
  // whole projection returned `undefined`, which is why both activity surfaces
  // (the chat tool and /admin/requests) could only ever answer "run_not_readable".
  // Tolerant: an already-unwrapped row passes through.
  const run = isRecord(payload.run) ? payload.run : payload;
  const runId = str(run.runId) ?? str(run.id);
  if (!runId) return undefined;

  const status = str(run.status) ?? 'running';
  const costRecord = isRecord(cost) ? cost : {};
  const ledger = isRecord(costRecord.ledger) ? costRecord.ledger : {};
  const plan = isRecord(costRecord.plan) ? costRecord.plan : {};
  const stageCost = new Map<string, { tokens: number; usd: number }>();
  for (const stage of arr(ledger.stages).filter(isRecord)) {
    const id = str(stage.nodeId);
    if (!id) continue;
    // ACCUMULATE, never overwrite: a node that failed expensively and was
    // retried cheaply appears twice in the ledger, and last-wins showed only
    // the cheap attempt — hiding exactly the spend this view exists to expose.
    const running = stageCost.get(id) ?? { tokens: 0, usd: 0 };
    stageCost.set(id, {
      tokens: running.tokens + (num(stage.totalTokens) ?? 0),
      usd: running.usd + (num(stage.costUsdEstimate) ?? 0),
    });
  }

  // The split that matters most on this card: a hold a human must answer
  // versus CMS-Agent's audit record of a node that already went ahead under
  // the project's autonomous policy. Same wire array, two very different
  // meanings — see `publication-evidence.ts` for the wire facts.
  const approvalEntries = arr(run.approvalsRequired).filter(isRecord);
  const projectApproval = (approval: Record<string, unknown>) => ({
    node_id: str(approval.nodeId) ?? '',
    reason: str(approval.reason) ?? 'Approval required.',
    ...(str(approval.requestedAt) ? { requested_at: str(approval.requestedAt)! } : {}),
  });
  const approvals = approvalEntries.filter((approval) => !isAdvisoryApproval(approval)).map(projectApproval);
  const policyRecords = approvalEntries.filter(isAdvisoryApproval).map((approval) => ({
    ...projectApproval(approval),
    ...(str(approval.source) ? { source: str(approval.source)! } : {}),
  }));

  const timings = isRecord(plan.nodeTimingAggregates)
    ? (plan.nodeTimingAggregates as Record<string, { p50DurationMs?: number; p95DurationMs?: number; count?: number }>)
    : {};

  const nodes: ActivityNode[] = arr(run.nodes)
    .slice(0, ACTIVITY_NODE_MAX)
    .filter(isRecord)
    .map((node) => {
      const id = str(node.nodeId) ?? str(node.id) ?? 'node';
      const nodeStatus = str(node.status) ?? 'queued';
      const warnings = strings(node.warnings).map(classifyWarning);
      const skip = isRecord(node.skip) ? node.skip : undefined;
      const timing = timings[id];
      const startedAt = str(node.startedAt);
      const durationMs = num(node.durationMs);
      const elapsed = nodeStatus === 'running' && startedAt ? nowMs - Date.parse(startedAt) : undefined;
      const money = stageCost.get(id);
      // Task B: executor.ts persists `state.output = { error: { code, message,
      // operatorAction?, providerStatus?, providerMessage? } }` on a failed
      // node. Tolerant by construction, like everything else in this
      // projection — a node with no `output.error` (every prior fixture,
      // every non-failed node) simply gets no `failure`.
      const output = isRecord(node.output) ? node.output : undefined;
      const rawFailure = output && isRecord(output.error) ? output.error : undefined;
      const failureCode = rawFailure ? str(rawFailure.code) : undefined;
      const failureMessage = rawFailure ? str(rawFailure.message) : undefined;
      // Bug B: `details` rides alongside `operatorAction` on the same
      // `output.error` for a `budget_exceeded` failure — CMS-Agent's own
      // numbers, read the same tolerant way as everything else here. Any
      // other failure code simply has no `details` object at all.
      const rawDetails = rawFailure && isRecord(rawFailure.details) ? rawFailure.details : undefined;
      const failureDetails = rawDetails
        ? {
            ...(str(rawDetails.nodeId) ? { nodeId: str(rawDetails.nodeId)! } : {}),
            ...(num(rawDetails.budgetUsd) !== undefined ? { budgetUsd: num(rawDetails.budgetUsd)! } : {}),
            ...(num(rawDetails.spentUsd) !== undefined ? { spentUsd: num(rawDetails.spentUsd)! } : {}),
            ...(num(rawDetails.nextTurnEstimateUsd) !== undefined
              ? { nextTurnEstimateUsd: num(rawDetails.nextTurnEstimateUsd)! }
              : {}),
            ...(num(rawDetails.suggestedBudgetUsd) !== undefined
              ? { suggestedBudgetUsd: num(rawDetails.suggestedBudgetUsd)! }
              : {}),
          }
        : undefined;
      const failure =
        failureCode && failureMessage
          ? {
              code: failureCode,
              message: failureMessage,
              ...(str(rawFailure!.operatorAction) ? { operatorAction: str(rawFailure!.operatorAction)! } : {}),
              ...(num(rawFailure!.providerStatus) !== undefined ? { providerStatus: num(rawFailure!.providerStatus)! } : {}),
              ...(str(rawFailure!.providerMessage) ? { providerMessage: str(rawFailure!.providerMessage)! } : {}),
              ...(failureDetails && Object.keys(failureDetails).length > 0 ? { details: failureDetails } : {}),
            }
          : undefined;
      return {
        id,
        label: nodeLabel(id) ?? id,
        status: nodeStatus,
        severity: classifyNode({
          status: nodeStatus,
          errors: strings(node.errors),
          warnings: strings(node.warnings),
          ...(skip ? { skip: { ...(str(skip.reason) ? { reason: str(skip.reason)! } : {}) } } : {}),
        }),
        ...(startedAt ? { started_at: startedAt } : {}),
        ...(str(node.completedAt) ? { completed_at: str(node.completedAt)! } : {}),
        ...(durationMs !== undefined ? { duration_ms: durationMs } : {}),
        ...(timing?.p50DurationMs !== undefined ? { typical_ms: timing.p50DurationMs } : {}),
        ...(elapsed !== undefined && timing?.p95DurationMs !== undefined && elapsed > timing.p95DurationMs
          ? { overrunning: true }
          : {}),
        ...(strings(node.produces)[0] ? { produces: strings(node.produces)[0]! } : {}),
        ...(skip && str(skip.reason) ? { skip_reason: str(skip.reason)! } : {}),
        warnings,
        errors: strings(node.errors),
        ...(failure ? { failure } : {}),
        tools: projectTools(node.toolCalls),
        ...(money && money.tokens > 0 ? { cost: money } : {}),
      };
    });

  const running = nodes.find((node) => node.status === 'running');
  const failed = nodes.find((node) => node.status === 'failed');
  const publication = derivePublication(
    arr(run.nodes)
      .filter(isRecord)
      .map((node) => ({
        nodeId: str(node.nodeId) ?? str(node.id),
        status: str(node.status),
        warnings: node.warnings,
        output: node.output,
      })),
    options.nodeOutputs ?? {}
  );
  const severity = worstSeverity([
    ...nodes.map((node) => node.severity),
    status === 'failed' ? ('failure' as Severity) : ('ok' as Severity),
    approvals.length ? ('attention' as Severity) : ('ok' as Severity),
  ]);

  const strategy = str(plan.strategy);
  const reason = str(plan.reason);

  return {
    run_id: runId,
    status,
    ...(str(run.executionMode) === 'mock' || str(run.executionMode) === 'openai'
      ? { execution_mode: str(run.executionMode) as 'mock' | 'openai' }
      : {}),
    ...(isRecord(run.mode) && typeof run.mode.live === 'boolean' ? { live_output: run.mode.live } : {}),
    severity,
    headline: activityHeadline({
      status,
      severity,
      ...(running ? { runningLabel: running.label } : {}),
      ...(failed ? { failedLabel: failed.label } : {}),
      approvals: approvals.length,
      ...(publication ? { publication: publication.state } : {}),
    }),
    progress: {
      done: nodes.filter((node) => SETTLED.has(node.status)).length,
      // `nodeCount` is the run's real size, but `nodes` is capped at
      // ACTIVITY_NODE_MAX — reporting the uncapped total against a capped
      // `done` left the bar stuck below 100% forever on a large workflow.
      total: Math.min(num(run.nodeCount) ?? nodes.length, Math.max(nodes.length, ACTIVITY_NODE_MAX)),
      failed: nodes.filter((node) => node.status === 'failed').length,
      running: nodes.filter((node) => node.status === 'running').length,
      skipped: nodes.filter((node) => node.status === 'skipped').length,
    },
    // An estimate only means something for a run that is still moving. A
    // failed, blocked or finished run showing "~6m left" — counting the dead
    // node and every node that will now never run — is worse than no number.
    ...(() => {
      if (status !== 'running' && status !== 'queued') return {};
      const eta = estimateRemaining(nodes, timings, nowMs);
      return eta ? { eta } : {};
    })(),
    ...(num(ledger.totalTokens) !== undefined
      ? {
          cost: {
            input_tokens: num(ledger.totalInputTokens) ?? 0,
            output_tokens: num(ledger.totalOutputTokens) ?? 0,
            usd: num(ledger.totalCostUsdEstimate) ?? 0,
            ...(str(ledger.mostExpensiveNodeId) ? { most_expensive_node: str(ledger.mostExpensiveNodeId)! } : {}),
          },
        }
      : {}),
    ...(strategy && reason
      ? {
          recovery: (() => {
            // `retryNodeId` is absent exactly when a run failed in an unusual
            // way — i.e. when a retry button matters most. The node that
            // actually failed is the honest fallback.
            const recoveryNodeId = str(plan.retryNodeId) ?? failed?.id;
            const recoveryNode = recoveryNodeId ? nodes.find((node) => node.id === recoveryNodeId) : undefined;
            return {
              strategy,
              ...(recoveryNodeId ? { node_id: recoveryNodeId } : {}),
              sentence: reason,
              reusable_stages: arr(plan.reusableStages).length,
              ...(recoveryNode?.failure?.operatorAction ? { operator_action: recoveryNode.failure.operatorAction } : {}),
            };
          })(),
        }
      : {}),
    approvals,
    policy_records: policyRecords,
    ...(publication ? { publication } : {}),
    nodes,
  };
};
