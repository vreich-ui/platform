/**
 * W19 T19.3 — the sweep, as testable logic.
 *
 * One pass over the non-terminal requests: read the run from CMS-Agent, derive
 * the editor-facing status (`derive-status.ts`, the pure core), write through
 * T19.1's writers, append a progress line to the attached chats, and nudge a
 * genuinely dead driver at most `MAX_NUDGES` times.
 *
 * THREE RULES THAT MUST NOT EROD E:
 *  1. Only this module writes a running request's status. No surface, tool or
 *     chat path may set `running`/`stalled`/`failed`/`done` by hand.
 *  2. An unreachable or unconfigured CMS-Agent is NOT a failed article. When
 *     the bridge cannot answer, the sweep leaves the status untouched and says
 *     so in the log — it never invents `failed`.
 *  3. A human gate is never nudged. `nudgeable` comes from the derivation and
 *     is already false for every approval/paused/blocked state.
 */
import {
  MAX_NUDGES,
  deriveRequestStatus,
  type DeriveConfig,
  type DerivedRequestState,
  type RunSnapshot,
} from './derive-status.js';
import {
  ackMailed,
  alreadyMailed,
  emailModeFor,
  isMuted,
  loadMailedLedger,
  loadNotifyState,
  shouldMailNow,
} from './notify-state.js';
import {
  NON_TERMINAL_REQUEST_STATUSES,
  TERMINAL_REQUEST_STATUSES,
  cancelRequest,
  loadIndex,
  loadRequest,
  rebuildIndex,
  recordObject,
  recordProgress,
  repairIndexRow,
  setStatus,
  type EditorialRequest,
  type EditorialRequestStore,
  type RequestProgressPatch,
  type RequestStatus,
  type RequestWorkflow,
  type SweeperRequestStatus,
} from './store.js';

/** Statuses a sweep pass considers. Terminal rows are never polled again (plan §5.3). */
export const SWEEPABLE_STATUSES: readonly RequestStatus[] = NON_TERMINAL_REQUEST_STATUSES.filter(
  (status) => status !== 'failed'
);

/** Hard cap on how many requests one pass touches, so a backlog cannot outrun the invocation. */
export const SWEEP_BATCH_MAX = 40;

export interface SweepBridge {
  /** `workflow_get_run` through the site's CmsAgentClient. */
  getRun(
    runId: string
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }>;
  /** `workflow_run_all` — the bounded nudge. */
  advance(
    runId: string,
    budgetMs: number
  ): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }>;
}

export interface SweepChatSink {
  /** Append one `request_progress` event to a chat. Best-effort: a missing chat is not an error. */
  appendProgress(chatId: string, detail: Record<string, unknown>): Promise<void>;
  /** The chat's own status, so a chat-side approval can outrank the run state (plan §5.1). */
  chatStatus(chatId: string): Promise<string | undefined>;
}

/** T19.7: the mail channel, injected so the sweep logic stays testable and provider-free. */
export interface SweepMailer {
  notify(input: {
    to: string;
    requestId: string;
    title: string;
    status: string;
    statusReason?: string;
  }): Promise<{ ok: boolean; code?: string }>;
}

export interface SweepDeps {
  store: EditorialRequestStore;
  mailer?: SweepMailer;
  bridge?: SweepBridge;
  chats?: SweepChatSink;
  now?: () => number;
  nowIso?: () => string;
  config?: DeriveConfig;
  /** Budget handed to a nudge — deliberately small; the point is to wake the driver, not to drive the run. */
  nudgeBudgetMs?: number;
  /** Remaining invocation budget; the pass stops cleanly rather than being killed mid-write. */
  remainingMs?: () => number;
}

export interface SweepOutcome {
  request_id: string;
  from: RequestStatus;
  to: RequestStatus;
  changed: boolean;
  nudged: boolean;
  /** Set when the bridge could not answer — the status was deliberately left alone. */
  unreachable?: string;
  /** Set when a stale index row was reconciled against its authoritative doc. */
  repaired?: boolean;
}

/** Below this, stop starting new per-request work: a partial pass is fine, a half-written doc is not. */
export const MIN_REMAINING_MS = 5_000;

export const DEFAULT_NUDGE_BUDGET_MS = 20_000;

/** Selects the requests a pass should poll, newest-updated first, bounded. */
export const selectSweepable = (
  rows: readonly { request_id: string; status: RequestStatus; updated_at: string }[],
  max: number = SWEEP_BATCH_MAX
): string[] =>
  rows
    .filter((row) => SWEEPABLE_STATUSES.includes(row.status))
    .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
    .slice(0, max)
    .map((row) => row.request_id);

/** The editor-facing progress line appended to a chat when something actually moved. */
export const progressDetail = (doc: EditorialRequest, derived: DerivedRequestState) => ({
  request_id: doc.request_id,
  status: derived.status,
  ...(derived.status_reason ? { summary: derived.status_reason } : {}),
  ...(derived.progress
    ? {
        done: derived.progress.done,
        total: derived.progress.total,
        ...(derived.progress.current_node ? { node: derived.progress.current_node } : {}),
      }
    : {}),
  ...(derived.blockers.length ? { blockers: derived.blockers.slice(0, 5) } : {}),
});

/**
 * Approval blockers, in the workflow record's own shape.
 *
 * REVIEW FIX (W19): `requested_at` is taken from CMS-Agent where it has one
 * and otherwise from the value ALREADY STORED for that node — never stamped
 * fresh each pass. Stamping it re-wrote the doc, bumped `updated_at`, burned a
 * history slot and re-announced the same approval in the chat every five
 * minutes for as long as the human took to answer.
 */
const approvalsFrom = (derived: DerivedRequestState, existing: RequestWorkflow | undefined, nowIso: () => string) => {
  const approvals = derived.blockers
    .filter((blocker) => blocker.code === 'approval_required')
    .map((blocker) => {
      const nodeId = blocker.node_id ?? '';
      const known = existing?.approvals_required?.find((approval) => approval.node_id === nodeId);
      return {
        node_id: nodeId,
        reason: blocker.message,
        requested_at: blocker.at ?? known?.requested_at ?? nowIso(),
      };
    });
  return approvals.length ? approvals : undefined;
};

/**
 * True once the node that builds the client-shaped article has completed. The
 * request id doubles as the `content_item` id (see the call site), so this is
 * the moment the object it names is real.
 */
const articleBodyCompleted = (run: RunSnapshot | undefined): boolean => {
  const nodes = Array.isArray(run?.nodes) ? run.nodes : [];
  // `content_item_shell_failed` means the object was never created, even
  // though the run carried on. Claiming it anyway would put a permanent link
  // to a 404 in the Requests list — `recordObject` never overwrites.
  const shellFailed = nodes.some((node) =>
    (Array.isArray((node as { warnings?: unknown })?.warnings) ? (node as { warnings: unknown[] }).warnings : []).some(
      (warning) => typeof warning === 'string' && warning.startsWith('content_item_shell_failed')
    )
  );
  if (shellFailed) return false;
  return nodes.some(
    (node) =>
      node !== null &&
      typeof node === 'object' &&
      ((node as { nodeId?: string }).nodeId === 'article_body' || (node as { id?: string }).id === 'article_body') &&
      (node as { status?: string }).status === 'completed'
  );
};

/** The transitions that earn an interruption (plan §6). Everything else is visible on the surface. */
export const NOTIFYING_STATUSES: readonly RequestStatus[] = ['needs_you', 'stalled', 'failed', 'done'];

/**
 * One mail, to the person who asked for the job, if their preference says so
 * and they have not muted it and they have not already been told.
 */
const notifyByMail = async (deps: SweepDeps, doc: EditorialRequest, status: RequestStatus): Promise<void> => {
  if (!deps.mailer) return;
  const recipient = doc.created_by?.trim();
  if (!recipient || !recipient.includes('@')) return;

  const state = await loadNotifyState(deps.store, recipient).catch(() => undefined);
  if (isMuted(state, doc.request_id)) return;
  if (!shouldMailNow(emailModeFor(state), status)) return;
  // The mail ledger is its own document, written only here — read it last, so
  // the window between "have I already sent this" and sending is as small as
  // this function can make it.
  const mailed = await loadMailedLedger(deps.store, recipient, state).catch(() => ({}));
  if (alreadyMailed(mailed, doc.request_id, status)) return;

  const result = await deps.mailer.notify({
    to: recipient,
    requestId: doc.request_id,
    title: doc.title,
    status,
    ...(doc.status_reason ? { statusReason: doc.status_reason } : {}),
  });

  if (result.ok) {
    // The MAIL ledger only. The browser has its own, so an e-mail never
    // silences the toast the editor would otherwise have seen.
    await ackMailed(deps.store, recipient, { [doc.request_id]: status }).catch(() => undefined);
  } else {
    console.warn('editorial request mail not sent', { request_id: doc.request_id, code: result.code });
  }
};

const isTerminal = (status: RequestStatus): boolean =>
  (TERMINAL_REQUEST_STATUSES as readonly RequestStatus[]).includes(status);

/** `<node>:<code>` verbatim, exactly as CMS-Agent reports it. */
const errorsFrom = (derived: DerivedRequestState): string[] =>
  derived.blockers
    .filter((blocker) => blocker.code !== 'approval_required')
    .map((blocker) => (blocker.node_id ? `${blocker.node_id}:${blocker.code}` : blocker.code));

/**
 * One request. Returns what happened, and never throws for anything the
 * bridge does — a sweep that dies on one bad run stops reporting on all the
 * others, which is strictly worse than one stale row.
 */
export const sweepRequest = async (deps: SweepDeps, requestId: string): Promise<SweepOutcome | undefined> => {
  const now = deps.now ?? (() => Date.now());
  const nowIso = deps.nowIso ?? (() => new Date().toISOString());
  const doc = await loadRequest(deps.store, requestId);
  if (!doc) return undefined;
  const from = doc.status;

  // REVIEW FIX (W19): being handed a closed request means the index row that
  // selected it is stale — the human's archive/cancel lost its index write to
  // a concurrent commit. Repair the row and stop: a terminal request is never
  // polled again, so nothing else would ever fix it.
  if (isTerminal(from)) {
    const repaired = await repairIndexRow(deps.store, doc).catch(() => false);
    return { request_id: requestId, from, to: from, changed: false, nudged: false, repaired };
  }

  let run: RunSnapshot | undefined;
  let unreachable: string | undefined;
  if (doc.workflow?.run_id) {
    if (!deps.bridge) unreachable = 'cms_agent_unavailable';
    else {
      try {
        const result = await deps.bridge.getRun(doc.workflow.run_id);
        if (result.ok) run = result.data as RunSnapshot;
        else unreachable = result.code || 'run_read_failed';
      } catch (error) {
        unreachable = error instanceof Error ? error.message.slice(0, 120) : 'run_read_threw';
      }
    }
  }

  // Rule 2: a bridge that cannot answer leaves the record exactly as it was.
  if (unreachable) {
    return { request_id: requestId, from, to: from, changed: false, nudged: false, unreachable };
  }

  const lastChat = doc.chats[doc.chats.length - 1];
  const chatStatus =
    lastChat && deps.chats ? await deps.chats.chatStatus(lastChat.chat_id).catch(() => undefined) : undefined;

  const derived = deriveRequestStatus({
    ...(run ? { run } : {}),
    ...(chatStatus ? { chat: { status: chatStatus } } : {}),
    now: now(),
    ...(deps.config ? { config: deps.config } : {}),
  });

  const approvals = doc.workflow ? approvalsFrom(derived, doc.workflow, nowIso) : undefined;
  const errors = errorsFrom(derived);
  // A run that moved forward has earned its nudge budget back (T19.3 scope
  // item 4). Without this, a long job that stalls once, is revived, and stalls
  // again hours later is left dead with its lifetime budget already spent.
  const advanced = Boolean(doc.workflow && (derived.progress?.done ?? 0) > doc.workflow.node_done);
  const workflowPatch: RequestProgressPatch | undefined = doc.workflow
    ? {
        node_total: derived.progress?.total ?? doc.workflow.node_total,
        node_done: derived.progress?.done ?? doc.workflow.node_done,
        node_failed: derived.progress?.failed ?? doc.workflow.node_failed,
        stalled: derived.status === 'stalled',
        ...(derived.progress?.current_node ? { current_node: derived.progress.current_node } : {}),
        ...(approvals ? { approvals_required: approvals } : {}),
        ...(errors.length ? { errors } : {}),
        ...(advanced ? { nudges: 0 } : {}),
      }
    : undefined;

  const statusChanged = derived.status !== doc.status;
  const updated = statusChanged
    ? derived.status === 'cancelled'
      ? // REVIEW FIX (W19): a run CMS-Agent cancelled (or skipped) derives
        // `cancelled`, which `setStatus` refuses by design — cancellation has
        // its own writer (plan §3.4). Routing it there instead of casting it
        // through `setStatus` is what stops a cancelled run reading `running`
        // forever and being polled every five minutes for ever after.
        await cancelRequest(
          deps.store,
          requestId,
          { by: 'workflow', ...(derived.status_reason ? { reason: derived.status_reason } : {}) },
          nowIso()
        )
      : await setStatus(
          deps.store,
          requestId,
          {
            status: derived.status as SweeperRequestStatus,
            ...(derived.status_reason ? { status_reason: derived.status_reason } : {}),
            ...(workflowPatch ? { workflow: workflowPatch } : {}),
          },
          nowIso()
        )
    : workflowPatch
      ? await recordProgress(deps.store, requestId, workflowPatch, nowIso())
      : doc;

  const to = updated?.status ?? from;
  // REVIEW FIX (W19): "the writer refused" is not "something moved". A human
  // archiving during the CMS-Agent read leaves `to !== from` (queued →
  // archived) even though this pass wrote nothing — which used to publish a
  // `request_progress` line, carrying the DERIVED status, into the chat of a
  // request the human had just closed.
  const refused = updated !== undefined && updated.status !== derived.status && isTerminal(updated.status);
  const changed = !refused && (to !== from || (updated?.updated_at ?? doc.updated_at) !== doc.updated_at);

  if (refused && updated) {
    // The index row that made us poll a closed request is the thing to fix.
    await repairIndexRow(deps.store, updated, nowIso()).catch(() => false);
    return { request_id: requestId, from, to, changed: false, nudged: false, repaired: true };
  }

  // W19: the article the run produced. By construction the request id IS the
  // `content_item` id — `mintWorkspaceRequestId` bumps until no content_item
  // holds it, then hands it to CMS-Agent as the run's requestId, and the shell
  // is created under exactly that id. Recorded only once `article_body` has
  // actually completed, so a run whose shell creation failed does not claim an
  // object that is not there.
  if (updated && !updated.object && articleBodyCompleted(run)) {
    await recordObject(deps.store, requestId, { object_type: 'content_item', object_id: requestId }, nowIso()).catch(
      () => undefined
    );
  }

  if (changed && lastChat && deps.chats && updated) {
    await deps.chats.appendProgress(lastChat.chat_id, progressDetail(updated, derived)).catch(() => undefined);
  }

  // T19.7: mail, on the four transitions that earn it and nowhere else. Every
  // failure mode here is swallowed and recorded — a provider outage must never
  // stall a sweep, because the record is worth more than the notification, and
  // the in-app channel already delivered it.
  if (changed && updated && deps.mailer && NOTIFYING_STATUSES.includes(to)) {
    await notifyByMail(deps, updated, to).catch(() => undefined);
  }

  // Rule 3: nudge only a genuinely dead driver, at most MAX_NUDGES times.
  //
  // REVIEW FIX (W19): the counter is re-read from the store immediately before
  // the nudge, not taken from the snapshot this pass has been holding across a
  // CMS-Agent round-trip. Together with the one-shot sweep token (only one
  // pass can be live) and the sequential pass below, that is what keeps
  // `MAX_NUDGES` an actual cap on real model spend rather than a suggestion.
  let nudged = false;
  const maxNudges = deps.config?.maxNudges ?? MAX_NUDGES;
  const fresh = derived.nudgeable ? await loadRequest(deps.store, requestId) : undefined;
  if (
    derived.nudgeable &&
    deps.bridge &&
    fresh?.workflow?.run_id &&
    (fresh.workflow.nudges ?? 0) < maxNudges &&
    fresh.status === 'stalled' &&
    updated?.workflow?.run_id
  ) {
    try {
      await deps.bridge.advance(updated.workflow.run_id, deps.nudgeBudgetMs ?? DEFAULT_NUDGE_BUDGET_MS);
      nudged = true;
      await recordProgress(
        deps.store,
        requestId,
        {
          node_total: updated.workflow.node_total,
          node_done: updated.workflow.node_done,
          node_failed: updated.workflow.node_failed,
          stalled: updated.workflow.stalled,
          ...(updated.workflow.current_node ? { current_node: updated.workflow.current_node } : {}),
          ...(updated.workflow.approvals_required ? { approvals_required: updated.workflow.approvals_required } : {}),
          ...(updated.workflow.errors ? { errors: updated.workflow.errors } : {}),
          nudges: (fresh.workflow.nudges ?? 0) + 1,
        },
        nowIso()
      );
    } catch {
      // A failed nudge is a fact about the bridge, not about the article.
      nudged = false;
    }
  }

  return { request_id: requestId, from, to, changed, nudged, ...(unreachable ? { unreachable } : {}) };
};

/** One pass. Bounded by `SWEEP_BATCH_MAX` and by whatever invocation time is left. */
export const runSweep = async (deps: SweepDeps): Promise<{ considered: number; outcomes: SweepOutcome[] }> => {
  const index = (await loadIndex(deps.store)) ?? (await rebuildIndex(deps.store));
  const ids = selectSweepable(index.rows);
  const outcomes: SweepOutcome[] = [];
  for (const id of ids) {
    if (deps.remainingMs && deps.remainingMs() < MIN_REMAINING_MS) break;
    const outcome = await sweepRequest(deps, id);
    if (outcome) outcomes.push(outcome);
  }
  return { considered: ids.length, outcomes };
};
