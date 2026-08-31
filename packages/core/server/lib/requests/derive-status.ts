/**
 * T19.3 — `deriveRequestStatus`: the ONE pure function that maps CMS-Agent
 * run state (plus the attached chat's own state machine) onto the
 * editor-facing status of an editorial request. Plan §5.1's mapping table
 * (`docs/cms-architecture/19-editorial-requests-plan.md`) is the
 * specification; §5.2 governs `stalled`.
 *
 * Contract:
 * - Pure: no I/O, no clock of its own — `now` is an input.
 * - Fed REAL wire data: both the raw `workflow_get_run` row and
 *   `agent/tools.ts`'s bounded `projectWorkspaceRun` projection
 *   (`run_id`/`stalled`/`nodes[{id,status}]`), so every field is optional and
 *   unknown enum values are tolerated. It must NEVER throw. A shape it cannot
 *   understand yields `running` with a status_reason saying the state could
 *   not be read — never a fabricated `failed`. An unreachable bridge is not a
 *   failed article.
 * - Only the sweeper uses it to WRITE a request's status (plan §3.4);
 *   anything else may call it for display.
 */

import { isAdvisoryApproval } from './publication-evidence.js';

// ─── the derived status union ────────────────────────────────────────────────

/**
 * The editor-facing statuses the sweeper can DERIVE, in presentation order.
 * `archived` also exists in the stored `editorial-request.v1` schema but is
 * deliberately absent here: archiving is a human act (plan §8), performed
 * only by the Owner-gated archive verb — it is never derived from run state,
 * and this module must not be able to produce it.
 */
export const DERIVED_REQUEST_STATUSES = Object.freeze([
  'queued',
  'running',
  'needs_you',
  'stalled',
  'failed',
  'done',
  'cancelled',
] as const);

export type DerivedRequestStatus = (typeof DERIVED_REQUEST_STATUSES)[number];

// ─── config (plan §9 D2, taken by default under R8) ──────────────────────────

/**
 * D2: `STALL_AFTER_MS` 10 minutes, `MAX_NUDGES` 3. The §5.2 rationale:
 * `stalled` must mean *nothing is happening*, not *this is slow* — a false
 * stall is worse than no signal, because it trains the desk to ignore the one
 * indicator that exists for a dead driver. Ten minutes clears the slowest
 * node observed in a real production run (`capture_emit_live`, 129 s;
 * `brief_architect`, 66 s) by more than four times, and a stall is only
 * declared when BOTH the dispatch heartbeat and the run-doc transitions have
 * been silent for the whole window (see `isNotAdvancing`).
 *
 * NOT the same concept as `STALE_RUN_MS` (15 min, `agent/chat-store.ts`):
 * that constant governs when a stuck agent-CHAT run doc becomes takeover-able
 * by another writer; this one governs when an editor is told a WORKFLOW run
 * has stopped moving. Different owner, different consequence — do not reuse
 * one for the other.
 */
export const STALL_AFTER_MS = 10 * 60_000;

/**
 * D2's write-side bound (§5.3): a run derived `stalled` gets at most this
 * many `workflow_run_all` nudges from the sweeper before it is left alone
 * with an honest human-readable `stalled`. Exported here with the stall
 * window because they are one decision; the counter itself lives on the
 * request doc and the cap is enforced by the sweeper, not by derivation.
 */
export const MAX_NUDGES = 3;

export interface DeriveConfig {
  /** Override `STALL_AFTER_MS` for this derivation (tests, per-site tuning). */
  stallAfterMs?: number;
  /** Override `MAX_NUDGES` for the sweeper reading this config; unused by derivation itself. */
  maxNudges?: number;
}

// ─── input snapshots (narrow, tolerant — real wire data lands here) ──────────

export interface RunNodeDispatchSnapshot {
  dispatchedAt?: string | null;
  driver?: string | null;
  projectEndpointConfigured?: boolean | null;
}

export interface RunNodeSnapshot {
  /** Raw rows carry `nodeId`; `projectWorkspaceRun` renames it `id`. */
  nodeId?: string | null;
  id?: string | null;
  /** At least queued|running|completed|failed|skipped|blocked; unknown values tolerated. */
  status?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  durationMs?: number | null;
  /** e.g. ['model_error', 'Invalid output type: …'] — code first, copy after. */
  errors?: unknown;
  warnings?: unknown;
  skip?: { reason?: string | null } | null;
  lastDispatch?: RunNodeDispatchSnapshot | null;
}

export interface RunApprovalSnapshot {
  nodeId?: string | null;
  type?: string | null;
  /** Editor copy from CMS-Agent — used VERBATIM when present. */
  reason?: string | null;
  requestedAt?: string | null;
  /**
   * `"policy_autonomous"` marks an AUDIT record of a publish-risk node that
   * proceeded under the project's autonomous policy — nothing is held. A
   * genuine hold carries no `source` on the wire. See `publication-evidence.ts`.
   */
  source?: string | null;
}

export interface RunSnapshot {
  runId?: string | null;
  /** `projectWorkspaceRun`'s spelling. */
  run_id?: string | null;
  id?: string | null;
  workflowId?: string | null;
  projectId?: string | null;
  /** queued|running|paused|completed|failed|blocked|cancelled|skipped; unknown values tolerated. */
  status?: string | null;
  currentNodeId?: string | null;
  startedAt?: string | null;
  updatedAt?: string | null;
  /** Stored-doc spelling, accepted for symmetry. */
  updated_at?: string | null;
  nodes?: RunNodeSnapshot[] | null;
  nodeCount?: number | null;
  artifactCount?: number | null;
  /** Run-level '<node>:<code>' strings, verbatim from CMS-Agent. */
  errors?: unknown;
  approvalsRequired?: RunApprovalSnapshot[] | null;
  /** Absent, a bare boolean, or `{ stalled: boolean }` — all three occur on the wire. */
  stall?: boolean | { stalled?: boolean | null } | null;
  /** `projectWorkspaceRun`'s already-normalised boolean form. */
  stalled?: boolean | null;
}

/** The attached agent-chat doc's own state machine (`agent/chat-store.ts`). */
export interface ChatSnapshot {
  /** idle|queued|running|awaiting_approval|awaiting_candidate|error|cancelled; unknown values tolerated. */
  status?: string | null;
  updated_at?: string | null;
}

export interface DeriveInput {
  run?: RunSnapshot | null;
  chat?: ChatSnapshot | null;
  /** The sweeper's clock, in epoch ms — derivation has no clock of its own. */
  now: number;
  config?: DeriveConfig;
}

// ─── output ──────────────────────────────────────────────────────────────────

export interface RequestProgress {
  done: number;
  total: number;
  failed: number;
  current_node?: string;
}

/** Machine detail for the UI/blocker list; codes live HERE, never in status_reason. */
export interface RequestBlocker {
  node_id?: string;
  code: string;
  message: string;
  at?: string;
}

export interface DerivedRequestState {
  status: DerivedRequestStatus;
  /** One editor-language sentence; always populated for needs_you/stalled/failed/cancelled. */
  status_reason?: string;
  progress?: RequestProgress;
  blockers: RequestBlocker[];
  /** True only when derived `stalled` AND the run is not on a human gate (§5.3 rule 5). */
  nudgeable: boolean;
}

// ─── tolerant readers ────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.length > 0 ? value : undefined;

const parseMs = (value: unknown): number | undefined => {
  const text = asString(value);
  if (!text) return undefined;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : undefined;
};

const runNodes = (run: RunSnapshot): RunNodeSnapshot[] =>
  Array.isArray(run.nodes) ? run.nodes.filter((node): node is RunNodeSnapshot => isRecord(node)) : [];

const nodeIdOf = (node: RunNodeSnapshot): string | undefined => asString(node.nodeId) ?? asString(node.id);

/** 'reader_simulation' → 'reader simulation' — the node named in words for editor sentences. */
const nodeWords = (id: string): string => id.replace(/[_-]+/g, ' ').trim();

/**
 * GENUINE holds only. CMS-Agent's advisory `policy_autonomous` records share
 * the array with real approvals; counting them here derived `needs_you` for a
 * run that had already published, and the request sat "waiting" for ever
 * (found live 2026-08-31).
 */
const runApprovals = (run: RunSnapshot): RunApprovalSnapshot[] =>
  Array.isArray(run.approvalsRequired)
    ? run.approvalsRequired.filter(
        (entry): entry is RunApprovalSnapshot => isRecord(entry) && !isAdvisoryApproval(entry)
      )
    : [];

/** All three wire forms of `stall`, plus the projection's top-level `stalled`. */
const normalizedStallFlag = (run: RunSnapshot): boolean | undefined => {
  const stall: unknown = run.stall;
  if (typeof stall === 'boolean') return stall;
  if (isRecord(stall) && typeof stall.stalled === 'boolean') return stall.stalled;
  if (typeof run.stalled === 'boolean') return run.stalled;
  return undefined;
};

const newestDispatchMs = (nodes: RunNodeSnapshot[]): number | undefined => {
  let newest: number | undefined;
  for (const node of nodes) {
    const at = isRecord(node.lastDispatch) ? parseMs(node.lastDispatch.dispatchedAt) : undefined;
    if (at !== undefined && (newest === undefined || at > newest)) newest = at;
  }
  return newest;
};

/**
 * §5.2, honestly: a run is "not advancing" only when BOTH liveness signals
 * are dead for the whole stall window —
 *   1. no live dispatch heartbeat: CMS-Agent's own `stall` block does not say
 *      `stalled: false`, and the newest `lastDispatch.dispatchedAt` across the
 *      nodes is not within `stallAfterMs` of `now`;
 *   2. no node transition: the run doc's `updatedAt` is not within
 *      `stallAfterMs` of `now`.
 * A merely SLOW node keeps `updatedAt` (and usually a dispatch heartbeat)
 * inside the window, so it can never read as stalled. With no time evidence
 * at all and no stall flag, we refuse to fabricate a stall.
 */
const isNotAdvancing = (run: RunSnapshot, nodes: RunNodeSnapshot[], now: number, stallAfterMs: number): boolean => {
  if (!Number.isFinite(now)) return false;
  const stallFlag = normalizedStallFlag(run);
  const dispatchMs = newestDispatchMs(nodes);
  const updatedMs = parseMs(run.updatedAt) ?? parseMs(run.updated_at);
  if (stallFlag === undefined && dispatchMs === undefined && updatedMs === undefined) return false;
  const heartbeatAlive = stallFlag === false || (dispatchMs !== undefined && now - dispatchMs < stallAfterMs);
  const transitionRecent = updatedMs !== undefined && now - updatedMs < stallAfterMs;
  return !heartbeatAlive && !transitionRecent;
};

const buildProgress = (run: RunSnapshot, nodes: RunNodeSnapshot[]): RequestProgress | undefined => {
  if (!Array.isArray(run.nodes)) return undefined;
  let done = 0;
  let failed = 0;
  for (const node of nodes) {
    const status = asString(node.status);
    // A skipped node is settled work, not a failure — it counts as done.
    if (status === 'completed' || status === 'skipped') done += 1;
    else if (status === 'failed') failed += 1;
  }
  const declared = typeof run.nodeCount === 'number' && Number.isFinite(run.nodeCount) ? run.nodeCount : 0;
  const total = Math.max(nodes.length, declared);
  const runningNode = nodes.find((node) => asString(node.status) === 'running');
  const current = asString(run.currentNodeId) ?? (runningNode ? nodeIdOf(runningNode) : undefined);
  return { done, total, failed, ...(current ? { current_node: current } : {}) };
};

// ─── blocker builders (machine detail; editor copy verbatim where supplied) ──

const approvalBlockers = (approvals: RunApprovalSnapshot[]): RequestBlocker[] =>
  approvals.map((entry) => {
    const nodeId = asString(entry.nodeId);
    const at = asString(entry.requestedAt);
    return {
      ...(nodeId ? { node_id: nodeId } : {}),
      code: asString(entry.type) ?? 'approval_required',
      // CMS-Agent's reason is editor copy — verbatim, never paraphrased.
      message: asString(entry.reason) ?? 'This step needs your explicit approval before the job can continue.',
      ...(at ? { at } : {}),
    };
  });

const failedNodeBlockers = (run: RunSnapshot, nodes: RunNodeSnapshot[]): RequestBlocker[] => {
  const blockers: RequestBlocker[] = [];
  for (const node of nodes) {
    if (asString(node.status) !== 'failed') continue;
    const errors = Array.isArray(node.errors) ? node.errors.filter((e): e is string => typeof e === 'string') : [];
    const nodeId = nodeIdOf(node);
    const at = asString(node.completedAt);
    blockers.push({
      ...(nodeId ? { node_id: nodeId } : {}),
      // CMS-Agent's convention: the machine code first, human copy after.
      code: errors[0] ?? 'node_failed',
      message: errors.slice(1).join('; ') || errors[0] || 'The step failed without an error message.',
      ...(at ? { at } : {}),
    });
  }
  if (blockers.length === 0) {
    // Fall back to the run-level '<node>:<code>' strings, kept verbatim in message.
    const runErrors = Array.isArray(run.errors) ? run.errors.filter((e): e is string => typeof e === 'string') : [];
    for (const raw of runErrors) {
      const sep = raw.indexOf(':');
      blockers.push(
        sep > 0 ? { node_id: raw.slice(0, sep), code: raw.slice(sep + 1), message: raw } : { code: raw, message: raw }
      );
    }
  }
  return blockers;
};

/** A publish-decision ('publication_controller'-class) node not yet settled (completed or skipped). */
const outstandingPublishNode = (nodes: RunNodeSnapshot[]): RunNodeSnapshot | undefined =>
  nodes.find((node) => {
    const id = nodeIdOf(node);
    if (!id || !id.includes('publication_controller')) return false;
    const status = asString(node.status);
    return status !== 'completed' && status !== 'skipped';
  });

// ─── derivation ──────────────────────────────────────────────────────────────

const UNREADABLE_REASON = "The job's current state could not be read; treating it as still running.";

export const deriveRequestStatus = (input: DeriveInput): DerivedRequestState => {
  // This function is fed live wire data and must never throw: any defect in
  // the derivation itself degrades to the honest "could not read" running
  // state rather than taking the sweeper (or a render) down with it.
  try {
    return derive(input);
  } catch {
    return {
      status: 'running',
      status_reason: UNREADABLE_REASON,
      blockers: [{ code: 'derive_error', message: 'Status derivation failed on this run snapshot.' }],
      nudgeable: false,
    };
  }
};

const derive = ({ run, chat, now, config }: DeriveInput): DerivedRequestState => {
  const stallAfterMs =
    typeof config?.stallAfterMs === 'number' && config.stallAfterMs > 0 ? config.stallAfterMs : STALL_AFTER_MS;

  const runReadable = isRecord(run);
  const nodes = runReadable ? runNodes(run) : [];
  const progress = runReadable ? buildProgress(run, nodes) : undefined;
  const approvals = runReadable ? runApprovals(run) : [];

  const result = (
    status: DerivedRequestStatus,
    reason?: string,
    blockers: RequestBlocker[] = []
  ): DerivedRequestState => ({
    status,
    ...(reason ? { status_reason: reason } : {}),
    ...(progress ? { progress } : {}),
    blockers,
    // §5.3 rule 5: nudging is only for a stall — never a human gate. The
    // precedence below already maps every human gate to needs_you before any
    // stall reasoning, so `stalled` implies no gate; this stays derived from
    // the final status so the invariant cannot drift.
    nudgeable: status === 'stalled',
  });

  // §5.1 precedence rule 1: a chat waiting on the human outranks the run
  // state — it is the nearer gate.
  const chatStatus = asString(chat?.status);
  if (chatStatus === 'awaiting_approval' || chatStatus === 'awaiting_candidate') {
    const gateBlockers = approvalBlockers(approvals);
    const chatAt = asString(chat?.updated_at);
    const fallbackReason =
      chatStatus === 'awaiting_approval'
        ? 'The assistant is waiting for your approval in the chat before the job can continue.'
        : 'The assistant is waiting for you to choose a candidate in the chat.';
    return result(
      'needs_you',
      // Where CMS-Agent already wrote the editor copy (an approval reason),
      // use it verbatim; otherwise say what the chat is waiting for.
      gateBlockers[0]?.message ?? fallbackReason,
      [
        {
          code: chatStatus === 'awaiting_approval' ? 'chat_awaiting_approval' : 'chat_awaiting_candidate',
          message: fallbackReason,
          ...(chatAt ? { at: chatAt } : {}),
        },
        ...gateBlockers,
      ]
    );
  }

  // §5.1 row 1 (second half): created and not yet dispatched.
  if (run === undefined || run === null) return result('queued');
  if (!runReadable) return result('running', UNREADABLE_REASON, unreadableBlocker(run));

  const status = asString(run.status);

  if (status === 'cancelled') return result('cancelled', 'This job was cancelled.');

  if (status === 'failed') return failedResult(run, nodes, result);

  // §5.1: run blocked, or approvalsRequired non-empty → needs_you. Checked
  // before ANY stall reasoning: a human gate is never `stalled` (precedence
  // rule 2), and a `completed` run with an approval still outstanding is
  // needs_you, not done.
  if (approvals.length > 0) {
    const blockers = approvalBlockers(approvals);
    return result('needs_you', blockers[0].message, blockers);
  }
  if (status === 'blocked') {
    return result('needs_you', 'The job is blocked and needs a decision from you before it can continue.', [
      { code: 'blocked', message: 'CMS-Agent reports the run as blocked.' },
    ]);
  }
  if (status === 'paused') {
    return result('needs_you', 'The job is paused and will wait until someone resumes it.', [
      { code: 'paused', message: 'CMS-Agent reports the run as paused.' },
    ]);
  }

  if (status === 'completed') {
    const outstanding = outstandingPublishNode(nodes);
    if (outstanding) {
      const outstandingId = nodeIdOf(outstanding);
      return result('needs_you', 'The draft is ready and waiting for your publish decision.', [
        {
          ...(outstandingId ? { node_id: outstandingId } : {}),
          code: 'publish_decision_outstanding',
          message: `The ${outstandingId ? nodeWords(outstandingId) : 'publish'} step has not been decided.`,
        },
      ]);
    }
    return result('done');
  }

  if (status === 'queued') return result('queued');

  // Not a §5.1 row: a run CMS-Agent skipped outright ended without producing
  // anything and will never move again — `cancelled` is the honest editor
  // read ('running' would be a lie that never corrects, 'done' promises an
  // article, and a fabricated 'failed' is forbidden). If the current node
  // carries CMS-Agent's own skip reason, that editor copy is used verbatim.
  if (status === 'skipped') {
    const currentId = asString(run.currentNodeId);
    const currentNode = currentId ? nodes.find((node) => nodeIdOf(node) === currentId) : undefined;
    const skipReason = currentNode && isRecord(currentNode.skip) ? asString(currentNode.skip.reason) : undefined;
    return result('cancelled', skipReason ?? 'The job ended without running.', [
      {
        ...(currentId ? { node_id: currentId } : {}),
        code: 'run_skipped',
        message: skipReason ?? 'CMS-Agent reports the run as skipped.',
      },
    ]);
  }

  if (status === 'running') {
    if (isNotAdvancing(run, nodes, now, stallAfterMs)) {
      // §5.1: any node failed with the run not advancing → failed, not stalled.
      if (nodes.some((node) => asString(node.status) === 'failed')) return failedResult(run, nodes, result);
      return result('stalled', stalledReason(run, stallAfterMs), stalledBlockers(run, stallAfterMs));
    }
    return result('running');
  }

  // Unknown or missing run status: never fabricate a failure — say the state
  // could not be read and keep the request visibly alive.
  return result('running', UNREADABLE_REASON, unreadableBlocker(run));
};

const unreadableBlocker = (run: unknown): RequestBlocker[] => [
  {
    code: 'unreadable_run_state',
    message: `Unrecognised run status: ${String(isRecord(run) ? run.status : run)}`,
  },
];

const failedResult = (
  run: RunSnapshot,
  nodes: RunNodeSnapshot[],
  result: (status: DerivedRequestStatus, reason?: string, blockers?: RequestBlocker[]) => DerivedRequestState
): DerivedRequestState => {
  const blockers = failedNodeBlockers(run, nodes);
  const currentId = asString(run.currentNodeId);
  const failedNode =
    nodes.find((node) => asString(node.status) === 'failed' && nodeIdOf(node) === currentId) ??
    nodes.find((node) => asString(node.status) === 'failed');
  const failedId = failedNode ? nodeIdOf(failedNode) : blockers.find((b) => b.node_id)?.node_id;
  // The node named in words; the machine code stays in the blocker, not here.
  const reason = failedId
    ? `The ${nodeWords(failedId)} step failed, so the job has stopped.`
    : 'The job failed before it could finish.';
  return result('failed', reason, blockers);
};

const stalledReason = (run: RunSnapshot, stallAfterMs: number): string => {
  const minutes = Math.max(1, Math.round(stallAfterMs / 60_000));
  const currentId = asString(run.currentNodeId);
  return `Nothing has happened on this job for over ${minutes} minute${minutes === 1 ? '' : 's'}${
    currentId ? `, at the ${nodeWords(currentId)} step` : ''
  } — it looks stuck.`;
};

const stalledBlockers = (run: RunSnapshot, stallAfterMs: number): RequestBlocker[] => {
  const currentId = asString(run.currentNodeId);
  const at = asString(run.updatedAt) ?? asString(run.updated_at);
  return [
    {
      ...(currentId ? { node_id: currentId } : {}),
      code: 'stalled',
      message: `No dispatch heartbeat and no node transition within ${stallAfterMs}ms.`,
      ...(at ? { at } : {}),
    },
  ];
};
