/**
 * W19 T19.8c — the SAME activity projection, narrowed for a chat tool result.
 *
 * The client manager could see a run's overall status and a bare list of node
 * ids, and nothing else. Asked "where is it?", the only honest answer it could
 * give was "still running, no errors reported" — which is what an editor
 * already knew from the spinner. Everything needed to answer properly was
 * already being computed for `/admin/requests`; it simply had no tool.
 *
 * Narrower than the browser's view on purpose. A chat tool result is PERSISTED
 * in the event log and re-sent to the model on every subsequent turn, so this
 * drops what a sentence does not need (per-tool timings, per-node cost splits)
 * and keeps what it does: every node, in order, with editor words, what
 * happened, how long it took, how long it USUALLY takes, and what it produced.
 *
 * Severity is `activity-severity.ts` throughout — Wolf's rule holds in chat as
 * it does in the UI: a warning is a warning, and red means a step died.
 */
import { projectActivity, type ActivityNode, type ActivityView, type ProjectActivityOptions } from './activity.js';

/** Bound on the node list in a persisted tool result. */
export const CHAT_ACTIVITY_NODE_MAX = 40;
/** Bound on the failing tool calls named per node. */
export const CHAT_ACTIVITY_TOOL_ERRORS_MAX = 3;

export interface ChatActivityNode {
  id: string;
  step: string;
  status: string;
  /** 'failure' only when the step DIED. A step that warned and continued is 'attention'. */
  severity: ActivityNode['severity'];
  took_ms?: number;
  usually_ms?: number;
  /** A running node past its own p95 — the honest "this one is slow", not a guess. */
  running_long?: true;
  produced?: string;
  skipped_because?: string;
  warnings?: string[];
  errors?: string[];
  tool_calls?: number;
  /**
   * Tool calls that errored. NOT run failures — this is exactly the case
   * Wolf's severity ruling is about: `publish_workspace_run` answering
   * `approval_required` is correct agent behaviour, the run continues, and it
   * must be reported as a thing that happened, not as a break. Read `severity`
   * for whether the STEP is in trouble.
   */
  tool_errors?: string[];
}

export interface ChatActivityView {
  run_id: string;
  status: string;
  /** The one sentence to lead with. */
  headline: string;
  severity: ActivityView['severity'];
  progress: ActivityView['progress'];
  /** Only ever present when this workflow has real timing history behind it. */
  remaining?: { p50_ms: number; p95_ms: number; based_on_runs: number };
  cost?: { input_tokens: number; output_tokens: number; usd: number; most_expensive_node?: string };
  /** What is waiting on a human, and why. GENUINE holds only. */
  approvals?: ActivityView['approvals'];
  /**
   * Publish-risk nodes that proceeded under the project's autonomous policy —
   * CMS-Agent's audit records, NOT approvals. Nothing waits on anyone here,
   * and the model must not ask the editor to approve them.
   */
  policy_records?: ActivityView['policy_records'];
  /** What the publish/release tail did, from the executors' own evidence. */
  publication?: ActivityView['publication'];
  /** CMS-Agent's own recovery advice for a stopped run, verbatim. */
  recovery?: ActivityView['recovery'];
  /** Mock output — the agent must say so rather than describe a draft nobody wrote. */
  mock_run?: true;
  steps: ChatActivityNode[];
  steps_omitted?: number;
  /**
   * What the model is expected to do with this. Tool descriptions are read
   * once at wire time and compete with 80 others; a line inside the RESULT is
   * read at the moment it matters.
   */
  how_to_answer: string;
}

const HOW_TO_ANSWER =
  'Answer with the specific step, not a summary of the status. Name what finished, what is running now and how long it usually takes, and what is left. Only describe something as failed when its severity is "failure"; a warning or a tool_errors entry means the run met something and carried on — report it as a warning, never as a break. Only "approvals" wait on the editor; "policy_records" are audit lines for steps that already proceeded autonomously — never ask the editor to approve those. If "publication" is present it is the truth about the article: state "live" means it is on the site at article_path; "published_pending_release" means it is published but go-live is not yet confirmed — offer to check again rather than rerunning anything. If mock_run is set, say the output is a rehearsal, not a real draft.';

const narrowNode = (node: ActivityNode): ChatActivityNode => {
  // Keyed off the call's own outcome, not its severity: `classifyToolCall`
  // deliberately never returns 'failure' (a tool call that errors is not a
  // step that died), so filtering on severity would hide every one of them.
  const toolErrors = node.tools
    .filter((call) => Boolean(call.error_code) || (call.status !== 'success' && call.status !== 'completed'))
    .slice(0, CHAT_ACTIVITY_TOOL_ERRORS_MAX)
    .map((call) => (call.error_code ? `${call.id} (${call.error_code})` : `${call.id} (${call.status})`));
  return {
    id: node.id,
    step: node.label,
    status: node.status,
    severity: node.severity,
    ...(node.duration_ms !== undefined ? { took_ms: node.duration_ms } : {}),
    ...(node.typical_ms !== undefined ? { usually_ms: node.typical_ms } : {}),
    ...(node.overrunning ? { running_long: true as const } : {}),
    ...(node.produces ? { produced: node.produces } : {}),
    ...(node.skip_reason ? { skipped_because: node.skip_reason } : {}),
    ...(node.warnings.length > 0 ? { warnings: node.warnings.map((warning) => warning.label) } : {}),
    ...(node.errors.length > 0 ? { errors: node.errors } : {}),
    ...(node.tools.length > 0 ? { tool_calls: node.tools.length } : {}),
    ...(toolErrors.length > 0 ? { tool_errors: toolErrors } : {}),
  };
};

/**
 * Keep the steps that carry information when the list is longer than the
 * bound: everything unsettled, everything that went wrong, and the most
 * RECENT completed ones — an editor asking "where is it" needs the front of
 * the run far more than node 3 of 40.
 */
const boundSteps = (nodes: readonly ActivityNode[]): { steps: ChatActivityNode[]; omitted: number } => {
  if (nodes.length <= CHAT_ACTIVITY_NODE_MAX) return { steps: nodes.map(narrowNode), omitted: 0 };
  const interesting = new Set<number>();
  nodes.forEach((node, index) => {
    if (node.status !== 'completed' || node.severity !== 'ok' || node.warnings.length > 0) interesting.add(index);
  });
  for (let index = nodes.length - 1; index >= 0 && interesting.size < CHAT_ACTIVITY_NODE_MAX; index -= 1) {
    interesting.add(index);
  }
  const kept = [...interesting].sort((a, b) => a - b).slice(0, CHAT_ACTIVITY_NODE_MAX);
  return { steps: kept.map((index) => narrowNode(nodes[index]!)), omitted: nodes.length - kept.length };
};

export const projectActivityForChat = (
  run: unknown,
  cost: unknown,
  nowMs: number = Date.now(),
  options: ProjectActivityOptions = {}
): ChatActivityView | undefined => {
  const view = projectActivity(run, cost, nowMs, options);
  if (!view) return undefined;
  const { steps, omitted } = boundSteps(view.nodes);
  return {
    run_id: view.run_id,
    status: view.status,
    headline: view.headline,
    severity: view.severity,
    progress: view.progress,
    ...(view.eta ? { remaining: view.eta } : {}),
    ...(view.cost ? { cost: view.cost } : {}),
    ...(view.approvals.length > 0 ? { approvals: view.approvals } : {}),
    ...(view.policy_records.length > 0 ? { policy_records: view.policy_records } : {}),
    ...(view.publication ? { publication: view.publication } : {}),
    ...(view.recovery ? { recovery: view.recovery } : {}),
    ...(view.execution_mode === 'mock' ? { mock_run: true as const } : {}),
    steps,
    ...(omitted > 0 ? { steps_omitted: omitted } : {}),
    how_to_answer: HOW_TO_ANSWER,
  };
};
