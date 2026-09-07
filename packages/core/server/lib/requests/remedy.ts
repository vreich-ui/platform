/**
 * D2/D4/D6 — ONE resolver for every remedy, on every surface.
 *
 * The Imagery card, the Requests card, the chat transcript's blockage card and
 * a typed chat answer ("raise it to $2") all post back the same
 * `{blockage_id, remedy_id}` pair, and all of them land here. That is the whole
 * reason the pair exists: two surfaces offering the same raise must not be two
 * code paths, and they must not charge for it twice.
 *
 * This generalizes `budget-override.ts`'s `raiseNodeBudgetAndRetry` — which
 * solved exactly this for one remedy on one surface — and keeps its ordering
 * rule intact: the durable WRITE goes first, the retry second, and a failed
 * retry never undoes the write (the next sweep or a manual retry picks the node
 * up with the new ceiling already in place; retrying under the OLD ceiling would
 * only fail the same way again).
 *
 * `bridge`-injected the same way `sweep.ts` injects `SweepBridge`, so "the right
 * tools, in the right order, once" is provable with a fake bridge and no live
 * MCP session.
 */

import type { Blockage, Remedy, RemedyType } from '../../../lib/admin/blockage.js';
import { raiseNodeBudgetAndRetry, type BudgetOverrideBridge } from './budget-override.js';

export type RemedyBridge = BudgetOverrideBridge;

/**
 * D4's ledger. One record per `blockage_id`, written the moment a remedy is
 * applied; a second post of the same pair reads it and answers
 * `already_resolved` instead of spending again. Backed by a Netlify Blob store
 * in production (see `createBlobRemedyLedger`), injected as a Map in tests.
 *
 * DELIBERATELY KEYED ON `blockage_id` ALONE, not on (blockage, remedy): the
 * question a second click asks is "has this wall already been dealt with", and
 * two DIFFERENT remedies for the same wall are still two spends. An operator who
 * genuinely wants a second, larger raise gets a NEW blockage (the re-run fails
 * again, with a new attempt number and therefore a new id) to act on.
 */
export interface RemedyLedger {
  get(blockageId: string): Promise<RemedyRecord | undefined>;
  put(blockageId: string, record: RemedyRecord): Promise<void>;
  /**
   * Clear a claim whose calls then failed, so the wall stays resolvable.
   * Optional so a minimal test double can omit it; production always has one.
   */
  remove?(blockageId: string): Promise<void>;
}

export interface RemedyRecord {
  blockage_id: string;
  remedy_id: string;
  remedy_type: RemedyType;
  resolved_at: string;
  by?: string;
  /** The tools actually called, so an audit can answer "what did that button do". */
  calls: readonly string[];
}

export type RemedyStatus =
  /** The bridge calls were made and succeeded. */
  | 'applied'
  /** This blockage_id was already resolved — nothing was called, nothing spent. */
  | 'already_resolved'
  /** A bridge call failed; `code`/`message` say which and why. */
  | 'failed'
  /**
   * Not a server write at all: the CALLER must re-run its own synchronous tool
   * with `modelConfigOverride` (the sync-tool "attempt" raise, D3), or the
   * remedy is a client-side navigation (open_settings) or a dismissal (cancel).
   * `rerunWith` carries what to re-run with, when there is something.
   */
  | 'caller_action'
  /** A remedy this platform has no handler for — never silently treated as done. */
  | 'unsupported';

export interface ApplyRemedyOutcome {
  ok: boolean;
  status: RemedyStatus;
  /** The CMS-Agent tools called, in order. Empty for every non-bridge status. */
  calls: readonly string[];
  failedTool?: string;
  code?: string;
  message?: string;
  /** For `caller_action` on an attempt-scoped raise: the one-shot ceiling to re-call with. */
  rerunWith?: Record<string, number>;
  /** For `caller_action` on a navigation remedy: where the browser should go. */
  navigateTo?: string;
  record?: RemedyRecord;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/**
 * The remedy's own args are the engine's; `overrideArgs` is what a HUMAN typed
 * ("raise it to $2" in chat, or a custom amount on the card). The human wins on
 * the fields they named, and only on those — a typed amount must never be able
 * to change the SCOPE, the node or the run the remedy targets, which is what
 * would turn "raise this attempt to $2" into a permanent default raise nobody
 * asked for.
 */
const HUMAN_SETTABLE = new Set(['budgetUsd', 'value']);

export const mergeRemedyArgs = (
  remedy: Remedy,
  overrideArgs?: Record<string, unknown>
): Record<string, unknown> => {
  const merged: Record<string, unknown> = { ...(remedy.args ?? {}) };
  for (const [key, value] of Object.entries(overrideArgs ?? {})) {
    if (HUMAN_SETTABLE.has(key) && num(value) !== undefined) merged[key] = value;
  }
  return merged;
};

const LIMIT_FIELDS = new Set(['maxTurns', 'toolCallLimit', 'maxOutputTokens']);

/**
 * Apply one remedy. `ledger` is optional only so a caller that has no store
 * (a test, a preview) still works; production always passes one, because
 * without it D4's "the card and the chat resolve the same wall once" is a
 * promise this cannot keep.
 */
/**
 * D8, ENFORCED HERE — not in `remedyButtons`.
 *
 * That table disables a button; it is a rendering decision and defends nothing.
 * Every caller of this function is an endpoint a human can POST to directly, so
 * the role check has to live where the write happens. The set is the same one
 * the buttons grey out: anything that changes stored config or spends beyond
 * one attempt.
 */
const OWNER_ONLY_REMEDIES: ReadonlySet<RemedyType> = new Set([
  'raise_node_budget', 'raise_run_budget', 'raise_limit', 'set_project_field',
]);

/**
 * THE CEILING ON A HUMAN-SUPPLIED AMOUNT. `mergeRemedyArgs` already stops a
 * typed number re-targeting the remedy; this stops it being absurd. An Owner
 * typing "raise it to $50" is doing something deliberate and allowed; nothing
 * should be able to write $100,000 into a node's stored default, which is what
 * an unbounded merge permitted through the chat endpoint.
 *
 * Applied to the MERGED value, so the engine's own suggestion is bounded by it
 * too — if a future engine ever suggests something wild, this still holds.
 */
export const MAX_REMEDY_BUDGET_USD = 50;
export const MAX_REMEDY_LIMIT_VALUE = 200_000;

export interface RemedyViewer {
  /** Resolved server-side from the caller's own identity. Never a browser claim. */
  isOwner: boolean;
  email?: string;
}

export async function applyRemedy(
  bridge: RemedyBridge,
  blockage: Blockage,
  request: { remedy_id: string; args?: Record<string, unknown>; by?: string },
  ledger?: RemedyLedger,
  now: () => Date = () => new Date(),
  viewer: RemedyViewer = { isOwner: false }
): Promise<ApplyRemedyOutcome> {
  const remedy = blockage.remedies.find((entry) => entry.id === request.remedy_id);
  if (!remedy) {
    return { ok: false, status: 'unsupported', calls: [], code: 'unknown_remedy', message: `This blockage has no remedy "${request.remedy_id}".` };
  }
  if (OWNER_ONLY_REMEDIES.has(remedy.type) && !viewer.isOwner) {
    return {
      ok: false,
      status: 'unsupported',
      calls: [],
      code: 'owner_required',
      message: 'Only an Owner can change a budget or a limit. Ask an Owner to approve this raise.',
    };
  }

  const args = mergeRemedyArgs(remedy, request.args);
  const nodeId = str(args.nodeId) ?? blockage.scope.node_id;
  const runId = str(args.runId) ?? blockage.scope.run_id;

  // Dismissal is not a resolution and is never ledgered: an operator who
  // dismisses a card has decided to look at it later, not decided it is done.
  // `ok: false` deliberately — see `ApplyRemedyOutcome.ok`: nothing was applied,
  // and a caller that clears the wall on a truthy `ok` would throw it away.
  if (remedy.type === 'cancel') return { ok: false, status: 'caller_action', calls: [], code: 'dismissed' };
  if (remedy.type === 'open_settings' || remedy.type === 'set_project_field') {
    return { ok: false, status: 'caller_action', calls: [], code: 'navigate', navigateTo: str(args.path) ?? str(args.field) };
  }

  // D4, in two steps rather than one.
  //
  // Netlify Blobs has no compare-and-swap, so a plain read-then-write around the
  // calls leaves a window: two requests (the card in one tab, the chat card in
  // another, or a double-click across two clients that cannot see each other's
  // local claim) both read `undefined` and both spend. CLAIMING FIRST closes
  // most of it — the claim is written before any tool call, so the second
  // request usually finds it. It is not a lock and does not pretend to be: two
  // requests inside one blob round-trip can still both claim. What it costs, in
  // exchange, is that a claim written for calls that then FAIL would strand the
  // wall — so the claim is cleared on failure (`release`), and its `calls: []`
  // marks it provisional for anything reading the ledger meanwhile.
  const existing = await ledger?.get(blockage.blockage_id);
  if (existing) {
    return { ok: true, status: 'already_resolved', calls: existing.calls, record: existing };
  }
  const claim: RemedyRecord = {
    blockage_id: blockage.blockage_id,
    remedy_id: remedy.id,
    remedy_type: remedy.type,
    resolved_at: now().toISOString(),
    ...(request.by ? { by: request.by } : {}),
    calls: [],
  };
  await ledger?.put(blockage.blockage_id, claim);
  const release = async () => {
    // A failed remedy must stay retryable: an entry for a raise that never
    // landed would make the wall permanently unresolvable from every surface.
    await ledger?.remove?.(blockage.blockage_id);
  };

  const done = async (calls: readonly string[]): Promise<ApplyRemedyOutcome> => {
    const record: RemedyRecord = { ...claim, calls };
    await ledger?.put(blockage.blockage_id, record);
    return { ok: true, status: 'applied', calls, record };
  };
  const failed = async (outcome: ApplyRemedyOutcome): Promise<ApplyRemedyOutcome> => {
    await release();
    return outcome;
  };

  switch (remedy.type) {
    case 'raise_node_budget': {
      const budgetUsd = num(args.budgetUsd);
      if (budgetUsd === undefined || budgetUsd <= 0 || budgetUsd > MAX_REMEDY_BUDGET_USD) {
        return {
          ok: false,
          status: 'failed',
          calls: [],
          code: 'invalid_budget',
          message: `A budget raise has to be between $0 and $${MAX_REMEDY_BUDGET_USD}.`,
        };
      }
      // D3 — the sync-tool raise is not a bridge write at all. There is no run
      // to override and no node to retry; the caller re-invokes its own tool
      // with a one-shot ceiling. Ledgered by the CALLER once that re-run
      // actually happens, not here, so a re-run that never fired can be retried.
      if (args.scope === 'attempt') {
        // NOTHING WAS DONE HERE, and `ok: false` is what says so. This branch
        // used to return `ok: true`, and the chat handler — which only checked
        // `ok` — cleared the pending blockage, wrote a "resolved" receipt and
        // returned 200 to a UI that then removed the card. No raise, no re-run,
        // and the wall gone from the only surface that was showing it. The
        // attempt raise is a RE-CALL of a synchronous tool (D3), which only the
        // surface that owns that tool can make; `rerunWith` is the instruction,
        // and the caller must ledger it once the re-run actually happens.
        // `failed` releases the claim written above: nothing was applied here,
        // and a claim left behind would make the re-run the caller is about to
        // make read as `already_resolved`.
        return failed({
          ok: false,
          status: 'caller_action',
          calls: [],
          code: 'rerun_required',
          message: 'This raise applies to one attempt, so it has to be re-run from the page that started it.',
          rerunWith: { budgetUsd },
        });
      }
      if (args.scope === 'default' && !runId) {
        // A default raise with no run to retry: write the config and stop. The
        // next call (a re-propose, a new run) picks the new ceiling up.
        const write = await bridge.callTool('workspace_update_node_model_config', { id: nodeId, patch: { modelConfig: { budgetUsd } } });
        if (!write.ok) return failed({ ok: false, status: 'failed', calls: ['workspace_update_node_model_config'], failedTool: 'workspace_update_node_model_config', code: write.code, message: write.message });
        return done(['workspace_update_node_model_config']);
      }
      if (!runId) {
        return failed({ ok: false, status: 'failed', calls: [], code: 'no_run', message: 'This raise needs a run to apply to.' });
      }
      const outcome = await raiseNodeBudgetAndRetry(bridge, args.scope === 'default' ? 'default' : 'for_run', runId, nodeId, budgetUsd);
      if (!outcome.ok) {
        return failed({ ok: false, status: 'failed', calls: outcome.calls, failedTool: outcome.failedTool, code: outcome.code, message: outcome.message });
      }
      return done(outcome.calls);
    }

    case 'raise_limit': {
      const field = str(args.field);
      const value = num(args.value);
      if (!field || !LIMIT_FIELDS.has(field) || value === undefined || value <= 0 || value > MAX_REMEDY_LIMIT_VALUE) {
        return failed({ ok: false, status: 'failed', calls: [], code: 'invalid_limit', message: `"${field ?? 'that field'}" is not a limit this can raise.` });
      }
      const write = await bridge.callTool('workspace_update_node_model_config', { id: nodeId, patch: { modelConfig: { [field]: value } } });
      if (!write.ok) return failed({ ok: false, status: 'failed', calls: ['workspace_update_node_model_config'], failedTool: 'workspace_update_node_model_config', code: write.code, message: write.message });
      if (!runId) return done(['workspace_update_node_model_config']);
      const retried = await bridge.callTool('workflow_retry_node', { runId, nodeId });
      if (!retried.ok) {
        return failed({ ok: false, status: 'failed', calls: ['workspace_update_node_model_config', 'workflow_retry_node'], failedTool: 'workflow_retry_node', code: retried.code, message: retried.message });
      }
      return done(['workspace_update_node_model_config', 'workflow_retry_node']);
    }

    case 'approve_gate':
    case 'decline_gate': {
      if (!runId) return failed({ ok: false, status: 'failed', calls: [], code: 'no_run', message: 'That decision needs a run to act on.' });
      const decision = remedy.type === 'approve_gate' ? 'approved' : 'withheld';
      const decided = await bridge.callTool('workflow_set_operator_publish_decision', { runId, decision });
      if (!decided.ok) return failed({ ok: false, status: 'failed', calls: ['workflow_set_operator_publish_decision'], failedTool: 'workflow_set_operator_publish_decision', code: decided.code, message: decided.message });
      // A decline stops here on purpose — advancing a run the operator just
      // withheld would be the opposite of what they pressed.
      if (decision === 'withheld') return done(['workflow_set_operator_publish_decision']);
      // Bounded, and non-fatal: the approval above is DURABLE. A failed advance
      // is reported, but the scheduled tick picks the run up regardless, so it
      // must not read as "your approval did not land".
      const advanced = await bridge.callTool('workflow_run_all', { runId, budgetMs: 20_000, approved: true });
      const calls = ['workflow_set_operator_publish_decision', 'workflow_run_all'];
      if (!advanced.ok) {
        const record = await done(calls);
        return { ...record, code: advanced.code, message: advanced.message };
      }
      return done(calls);
    }

    case 'retry': {
      if (!runId) return failed({ ok: false, status: 'failed', calls: [], code: 'no_run', message: 'There is no run to retry.' });
      const retried = await bridge.callTool('workflow_retry_node', { runId, nodeId });
      if (!retried.ok) return failed({ ok: false, status: 'failed', calls: ['workflow_retry_node'], failedTool: 'workflow_retry_node', code: retried.code, message: retried.message });
      return done(['workflow_retry_node']);
    }

    case 'resume': {
      if (!runId) return failed({ ok: false, status: 'failed', calls: [], code: 'no_run', message: 'There is no run to resume.' });
      const resumed = await bridge.callTool('workflow_resume_run', { runId });
      if (!resumed.ok) return failed({ ok: false, status: 'failed', calls: ['workflow_resume_run'], failedTool: 'workflow_resume_run', code: resumed.code, message: resumed.message });
      return done(['workflow_resume_run']);
    }

    case 'raise_run_budget':
      // §4 flags this: there is no `workflow.set_run_budget` in CMS-Agent. The
      // engine still emits the remedy so the card can explain the wall; the
      // button is disabled (`blockage.ts`'s NOT_YET_WIRED) and this is the
      // second, server-side half of that same refusal.
      return failed({ ok: false, status: 'unsupported', calls: [], code: 'no_run_budget_setter', message: 'Raising a run-wide ceiling needs a CMS-Agent setter that does not exist yet. Reset the run with a higher budget instead.' });

    default:
      return failed({ ok: false, status: 'unsupported', calls: [], code: 'unsupported_remedy', message: `No handler for remedy type "${remedy.type}".` });
  }
}

// ─── the ledger, in production ───────────────────────────────────────────────

export interface RemedyLedgerStore {
  get(key: string, options: { type: 'json' }): Promise<unknown>;
  setJSON(key: string, value: unknown, options?: { metadata?: Record<string, unknown> }): Promise<unknown>;
}

/** 24h is the whole useful life of a blockage record: past that the run is long
 *  since finished or reset, and the id can never be posted again. Netlify Blobs
 *  has no TTL of its own, so the age check is on read. */
export const REMEDY_LEDGER_TTL_MS = 24 * 60 * 60 * 1000;

export const remedyLedgerKey = (blockageId: string): string => `blockage-resolutions/${blockageId}.json`;

export const createBlobRemedyLedger = (
  store: RemedyLedgerStore,
  now: () => Date = () => new Date()
): RemedyLedger => ({
  async get(blockageId) {
    try {
      const raw = (await store.get(remedyLedgerKey(blockageId), { type: 'json' })) as RemedyRecord | null;
      if (!raw || typeof raw.resolved_at !== 'string') return undefined;
      const age = now().getTime() - Date.parse(raw.resolved_at);
      if (!Number.isFinite(age) || age > REMEDY_LEDGER_TTL_MS) return undefined;
      return raw;
    } catch {
      // A ledger read that throws must NOT block a resolution: the cost of a
      // rare double-raise is one extra dollar of ceiling; the cost of refusing
      // every remedy because a blob store hiccuped is a stuck run.
      return undefined;
    }
  },
  async put(blockageId, record) {
    try {
      await store.setJSON(remedyLedgerKey(blockageId), record);
    } catch {
      // Same posture: the remedy already landed upstream, and losing the
      // receipt is not a reason to report failure to the operator.
    }
  },
  async remove(blockageId) {
    try {
      // No `delete` on the minimal store surface this module declares, so the
      // claim is expired in place: a record dated before the TTL window reads
      // as absent to `get` above. Same effect, one fewer capability to require
      // of the store.
      await store.setJSON(remedyLedgerKey(blockageId), {
        blockage_id: blockageId,
        remedy_id: 'released',
        remedy_type: 'cancel',
        resolved_at: new Date(0).toISOString(),
        calls: [],
      });
    } catch {
      // Best-effort. A claim that outlives its failed call is cleared by the
      // 24h TTL at worst, and the operator can still act from another surface.
    }
  },
});

// ─── the synchronous-tool path (D3) ──────────────────────────────────────────

/**
 * A remedy as a SURFACE posts it back for a synchronous tool (today:
 * `admin-visual-identity-propose`). Deliberately narrow rather than "the whole
 * blockage, re-sent": a client-supplied blockage would let a browser name its
 * own scope and node, which is exactly how "raise this attempt to $2" becomes a
 * permanent default raise on a node nobody was looking at. The only things that
 * cross the wire are which wall, which remedy, and how much.
 */
export interface SyncToolRemedyRequest {
  blockage_id: string;
  remedy_id: string;
  scope: 'attempt' | 'default';
  budget_usd: number;
}

export type SyncToolRemedyPlan =
  | {
      ok: true;
      /** Re-call the tool with this one-shot ceiling. */
      modelConfigOverride: { budgetUsd: number };
      /** Write the node's stored default FIRST, when the operator asked for that. */
      configWrite?: { tool: 'workspace_update_node_model_config'; args: Record<string, unknown> };
    }
  | { ok: false; status: 400 | 403; error: string };

/**
 * DELIBERATELY SMALL, and smaller than `MAX_REMEDY_BUDGET_USD`.
 *
 * On this path `blockage_id`/`remedy_id` are NOT verified against anything —
 * the propose endpoint holds no blockage store, so a caller can post a remedy
 * for a wall that never existed and get a one-shot ceiling out of it. The
 * mitigation is depth, not a check this layer cannot make: this bound, plus
 * CMS-Agent's own clamp of `modelConfigOverride` against the node's stored
 * config (`clampModelConfigOverride`, a few multiples of it), plus the Owner
 * gate on the default scope. The engine's own suggestion for the writer node is
 * ~$1.50, so $5 is generous headroom for a legitimate remedy and no longer a
 * lever worth reaching for.
 */
export const MAX_SYNC_REMEDY_BUDGET_USD = 5;

/**
 * D8 — a one-shot raise for THIS attempt is an editor action: it spends one
 * call and changes nothing stored. Raising the node's DEFAULT changes what
 * every future run of every tenant costs, so it is Owner-only. Pure, so both
 * halves of that sentence are provable without an HTTP request.
 */
export function planSyncToolRemedy(
  remedy: SyncToolRemedyRequest | undefined,
  nodeId: string,
  viewer: { isOwner: boolean }
): SyncToolRemedyPlan | undefined {
  if (!remedy) return undefined;
  const budgetUsd = remedy.budget_usd;
  if (typeof budgetUsd !== 'number' || !Number.isFinite(budgetUsd) || budgetUsd <= 0 || budgetUsd > MAX_SYNC_REMEDY_BUDGET_USD) {
    return { ok: false, status: 400, error: `A budget raise must be between $0 and $${MAX_SYNC_REMEDY_BUDGET_USD}.` };
  }
  if (remedy.scope === 'default' && !viewer.isOwner) {
    return { ok: false, status: 403, error: 'Only an Owner can raise a node’s default budget. You can raise it for this attempt instead.' };
  }
  return {
    ok: true,
    modelConfigOverride: { budgetUsd },
    ...(remedy.scope === 'default'
      ? { configWrite: { tool: 'workspace_update_node_model_config' as const, args: { id: nodeId, patch: { modelConfig: { budgetUsd } } } } }
      : {}),
  };
}
