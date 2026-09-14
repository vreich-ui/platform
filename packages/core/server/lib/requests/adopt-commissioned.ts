/**
 * Track C (Wolf, 2026-09-14) — adopting runs NOBODY asked for.
 *
 * THE PROBLEM THIS SOLVES. Every request row in `/admin/requests` exists
 * because a chat tool created it: `run_workspace_workflow` registers the row in
 * the same breath it starts the run. `editorial_planner` starts runs from the
 * OTHER plane — inside CMS-Agent, at 06:00, with no chat and no human — so it
 * can register nothing here, and its work would be invisible on the one screen
 * an operator opens to find out what this site is doing.
 *
 * WHY ADOPTION AND NOT A NEW WRITE VERB. The obvious fix is a new tenant `/mcp`
 * verb the planner calls after starting a run. That means a new write surface
 * on every site, a new credential scope to grant per tenant, and a second place
 * that can half-create a request when the network drops between the two calls.
 * The sweep already polls CMS-Agent every pass with the site's own client and
 * already owns the lifecycle of a request row. Letting it ALSO notice runs that
 * have no row yet costs one extra list call per pass, needs no new permission
 * anywhere, and is self-healing: a run the planner started while this site was
 * down is adopted on the next pass instead of being lost.
 *
 * WHAT MAKES A RUN ADOPTABLE — all four, or it is left alone:
 *  1. it carries `commissionedBy` (the engine only stamps that when the planner
 *     started it, so a human-started run can never be adopted by accident);
 *  2. it names a `requestId` that matches this tenant's request-id grammar;
 *  3. no request row with that id exists yet;
 *  4. it belongs to this site's project.
 *
 * The row is created in the state the run is actually in; the ordinary sweep
 * takes it from there, so adoption adds no second status writer (sweep rule 1).
 */
import { REQUEST_ID_PATTERN, type RequestKind } from './store.js';

/** The compact run shape `workflow_list_runs` returns, narrowed to what adoption reads. */
export interface CommissionedRunSnapshot {
  run_id?: unknown;
  runId?: unknown;
  request_id?: unknown;
  requestId?: unknown;
  workflow_id?: unknown;
  workflowId?: unknown;
  project_id?: unknown;
  projectId?: unknown;
  status?: unknown;
  commissionedBy?: unknown;
  commissioned_by?: unknown;
  commissioningRationale?: unknown;
  commissioning_rationale?: unknown;
  title?: unknown;
  /** The engine's bounded copy of the run's brief — `summarizeRunForList` sends it only for commissioned runs. */
  commissionedBrief?: unknown;
  instructions?: unknown;
  /** The engine's list row spells this `nodeCount`; the other two are accepted in case it ever does not. */
  nodeCount?: unknown;
  node_total?: unknown;
  nodeTotal?: unknown;
}

export interface AdoptableRun {
  request_id: string;
  run_id: string;
  workflow_id: string;
  project_id: string;
  kind: RequestKind;
  title: string;
  brief_excerpt?: string;
  commissioned_by: string;
  commissioning_rationale?: string;
  node_total?: number;
}

/** Reads a field under either its camelCase or snake_case spelling — the two planes disagree, and adoption must not. */
const str = (...values: unknown[]): string | undefined => {
  for (const value of values) {
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return undefined;
};

const num = (...values: unknown[]): number | undefined => {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  }
  return undefined;
};

/**
 * A commissioned run's title. The planner writes one sentence of instructions
 * and no title, so the first line of the brief IS the title an operator reads —
 * the same thing `requestTitleFrom` does for a chat-started run. Falls back to
 * the request id rather than to an empty string: a row labelled "" is a row
 * nobody can find again.
 */
export const commissionedTitle = (run: CommissionedRunSnapshot): string => {
  const explicit = str(run.title);
  if (explicit) return explicit.slice(0, 120);
  const brief = str(run.commissionedBrief, run.instructions);
  if (brief) {
    const firstLine = brief.split('\n')[0]!.trim();
    return (firstLine.length > 120 ? `${firstLine.slice(0, 117)}…` : firstLine) || str(run.request_id, run.requestId)!;
  }
  return str(run.request_id, run.requestId) ?? 'Commissioned run';
};

/**
 * THE PURE SELECTOR. Given the runs CMS-Agent reports and the request ids this
 * site already knows, answer which runs need a row — and nothing else. No I/O,
 * so the rule above is testable without a store, a bridge or a clock.
 */
export const adoptableCommissionedRuns = (
  runs: readonly CommissionedRunSnapshot[],
  knownRequestIds: ReadonlySet<string>,
  projectId: string | undefined
): AdoptableRun[] => {
  const adoptable: AdoptableRun[] = [];
  const seen = new Set<string>();
  for (const run of runs) {
    const commissionedBy = str(run.commissionedBy, run.commissioned_by);
    if (!commissionedBy) continue;

    const requestId = str(run.request_id, run.requestId);
    // A run with no request id, or one that does not match the grammar, cannot
    // become a row: `editorialRequestSchema` refuses the id outright, so
    // adopting it would throw inside the sweep instead of failing quietly here.
    if (!requestId || !REQUEST_ID_PATTERN.test(requestId)) continue;
    if (knownRequestIds.has(requestId) || seen.has(requestId)) continue;

    const runId = str(run.run_id, run.runId);
    if (!runId) continue;

    // A run from ANOTHER project reaching this site's list is a bug on the
    // other side, but adopting it would put a foreign article in this tenant's
    // inbox — so it is dropped here too, rather than trusted.
    const runProject = str(run.project_id, run.projectId);
    if (projectId && runProject && runProject !== projectId) continue;

    const rationale = str(run.commissioningRationale, run.commissioning_rationale);
    const brief = str(run.commissionedBrief, run.instructions);
    seen.add(requestId);
    adoptable.push({
      request_id: requestId,
      run_id: runId,
      workflow_id: str(run.workflow_id, run.workflowId) ?? 'publishing_conductor',
      project_id: runProject ?? projectId ?? '',
      // Every commissioned run is an article run today; `reconcileRequestKind`
      // corrects the stamp from the request id itself if that ever stops being true.
      kind: 'article',
      title: commissionedTitle(run),
      ...(brief ? { brief_excerpt: brief.slice(0, 240) } : {}),
      commissioned_by: commissionedBy,
      ...(rationale ? { commissioning_rationale: rationale } : {}),
      ...(num(run.nodeCount, run.node_total, run.nodeTotal) !== undefined ? { node_total: num(run.nodeCount, run.node_total, run.nodeTotal)! } : {}),
    });
  }
  return adoptable;
};
