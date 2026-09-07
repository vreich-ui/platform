/**
 * `blockage.v1` on the platform side — the ONE place a remedy becomes a button.
 *
 * CMS-Agent mints a blockage (its `src/agent/execution/blockage.ts`) carrying
 * what stopped and what would fix it, in semantic terms only: `raise_node_budget
 * {scope:'attempt', budgetUsd:1.5}`. It carries no label, no colour and no
 * permission — deliberately, because those are product decisions that change
 * without the engine changing. This module is where they are made, and it is
 * pure and isomorphic (no server import, no React) for the same reason
 * `budget-raise.ts` was: "the right buttons, with the right amounts, Owner-only"
 * has to be provable with `node --test` and no rendered tree.
 *
 * It ABSORBS `budget-raise.ts`. That module solved exactly this problem for
 * exactly one code (`budget_exceeded`) on exactly one surface (RequestActivity),
 * by parsing dollar figures back out of CMS-Agent's English sentence. Its regex
 * is still here — as `blockageFromLegacyMessage` — because of D9: CMS-Agent and
 * platform are two repos with two deploys, so for the window between them every
 * failure still arrives as prose. A surface that has no blockage falls back to
 * synthesizing one, gets the same buttons it gets today, and needs no second
 * code path of its own.
 */

// ─── the contract, as it arrives ─────────────────────────────────────────────

export type BlockageKind = 'budget' | 'approval' | 'limit' | 'config' | 'auth' | 'validation' | 'other';

export type RemedyType =
  | 'raise_node_budget'
  | 'raise_run_budget'
  | 'raise_limit'
  | 'retry'
  | 'resume'
  | 'approve_gate'
  | 'decline_gate'
  | 'set_project_field'
  | 'open_settings'
  | 'cancel';

export interface Remedy {
  id: string;
  type: RemedyType;
  args?: Record<string, unknown>;
  default?: boolean;
}

export interface BlockageScope {
  run_id?: string;
  execution_id?: string;
  node_id: string;
  gate_id?: string;
  tool?: string;
}

export interface Blockage {
  blockage_id: string;
  contract?: string;
  code: string;
  kind: BlockageKind;
  message: string;
  details?: Record<string, unknown>;
  operator_action?: string;
  remedies: Remedy[];
  scope: BlockageScope;
}

const isBag = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const REMEDY_TYPES = new Set<string>([
  'raise_node_budget', 'raise_run_budget', 'raise_limit', 'retry', 'resume',
  'approve_gate', 'decline_gate', 'set_project_field', 'open_settings', 'cancel',
]);
const BLOCKAGE_KINDS = new Set<string>(['budget', 'approval', 'limit', 'config', 'auth', 'validation', 'other']);

/**
 * Parse an untrusted `blockage` off a wire payload. Everything that reaches a
 * button is validated: an unknown remedy TYPE is dropped rather than rendered
 * as a button whose handler would fall through to nothing. A blockage left with
 * no remedies at all still renders — as an explanation, which is the honest
 * outcome and the one D7's "Blocked" count keys on.
 */
export function parseBlockage(value: unknown): Blockage | undefined {
  if (!isBag(value)) return undefined;
  const { blockage_id: id, code, kind, message, scope } = value;
  if (typeof id !== 'string' || !id) return undefined;
  if (typeof code !== 'string' || !code) return undefined;
  if (typeof message !== 'string') return undefined;
  if (!isBag(scope) || typeof scope.node_id !== 'string') return undefined;

  const remedies: Remedy[] = (Array.isArray(value.remedies) ? value.remedies : [])
    .filter(isBag)
    .filter((entry) => typeof entry.id === 'string' && typeof entry.type === 'string' && REMEDY_TYPES.has(entry.type))
    .map((entry) => ({
      id: entry.id as string,
      type: entry.type as RemedyType,
      ...(isBag(entry.args) ? { args: entry.args } : {}),
      ...(entry.default === true ? { default: true as const } : {}),
    }));

  return {
    blockage_id: id,
    ...(typeof value.contract === 'string' ? { contract: value.contract } : {}),
    code,
    kind: typeof kind === 'string' && BLOCKAGE_KINDS.has(kind) ? (kind as BlockageKind) : 'other',
    message,
    ...(isBag(value.details) ? { details: value.details } : {}),
    ...(typeof value.operator_action === 'string' ? { operator_action: value.operator_action } : {}),
    remedies,
    scope: {
      node_id: scope.node_id,
      ...(typeof scope.run_id === 'string' ? { run_id: scope.run_id } : {}),
      ...(typeof scope.execution_id === 'string' ? { execution_id: scope.execution_id } : {}),
      ...(typeof scope.gate_id === 'string' ? { gate_id: scope.gate_id } : {}),
      ...(typeof scope.tool === 'string' ? { tool: scope.tool } : {}),
    },
  };
}

// ─── remedy -> button ────────────────────────────────────────────────────────

/** "$5", "$4.50" — a suggested ceiling is a whole or half dollar; never "$5.00". */
export function formatBudgetUsd(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

export interface RemedyButton {
  remedy_id: string;
  label: string;
  type: RemedyType;
  /** The primary button — the one a bare "yes" in chat means. At most one. */
  primary?: boolean;
  /**
   * Set when the button must be shown but not pressed, carrying the honest
   * reason. Shown rather than hidden on purpose: an editor who cannot see the
   * remedy exists cannot ask an Owner for it — the same reasoning
   * `run-card-view.ts` already applies to its own Owner-gated actions.
   */
  disabledReason?: string;
}

/** Remedies that change money, stored config, or a project record. Owner only. */
const OWNER_ONLY: ReadonlySet<RemedyType> = new Set([
  'raise_node_budget', 'raise_run_budget', 'raise_limit', 'set_project_field',
]);

/**
 * Remedies with no engine setter behind them yet. Rendered, disabled, with the
 * reason stated — rather than dropped, which would leave a blocked run showing
 * no card at all and no explanation of why nothing can be done from here.
 */
const NOT_YET_WIRED: ReadonlyMap<RemedyType, string> = new Map([
  ['raise_run_budget', 'Raising a run-wide ceiling needs a CMS-Agent setter that does not exist yet — reset the run with a higher budget instead.'],
]);

const scopeWord = (scope: unknown): string => {
  if (scope === 'attempt') return 'for this attempt';
  if (scope === 'run') return 'for this run';
  if (scope === 'default') return 'as the default';
  return '';
};

const LIMIT_FIELD_LABELS: Record<string, string> = {
  maxTurns: 'turn limit',
  toolCallLimit: 'tool-call limit',
  maxOutputTokens: 'output limit',
};

/**
 * The label table. One switch, no branching per surface — the Imagery card, the
 * Requests card and the chat transcript all render THIS, which is what stops the
 * three of them from drifting into three different vocabularies for one action.
 */
function labelFor(remedy: Remedy): string {
  const args = remedy.args ?? {};
  switch (remedy.type) {
    case 'raise_node_budget': {
      const budgetUsd = num(args.budgetUsd);
      const where = scopeWord(args.scope);
      if (budgetUsd === undefined) return 'Raise the budget';
      return args.scope === 'default'
        ? `Raise default to ${formatBudgetUsd(budgetUsd)}`
        : `Raise to ${formatBudgetUsd(budgetUsd)} ${where}`.trim();
    }
    case 'raise_run_budget': {
      const budgetUsd = num(args.budgetUsd);
      return budgetUsd === undefined ? 'Raise the run budget' : `Raise the run budget to ${formatBudgetUsd(budgetUsd)}`;
    }
    case 'raise_limit': {
      const field = typeof args.field === 'string' ? args.field : '';
      const value = num(args.value);
      const name = LIMIT_FIELD_LABELS[field] ?? field ?? 'limit';
      return value === undefined ? `Raise the ${name}` : `Raise the ${name} to ${value}`;
    }
    case 'retry': return 'Try again';
    case 'resume': return 'Resume';
    case 'approve_gate': return 'Approve';
    case 'decline_gate': return 'Decline';
    case 'set_project_field':
      return args.field === 'mcpEndpoint' ? 'Set the CMS-Agent endpoint' : `Set ${String(args.field ?? 'the missing field')}`;
    case 'open_settings':
      return args.path === 'credentials' ? 'Open credentials' : 'Open settings';
    case 'cancel': return 'Dismiss';
    default: return 'Resolve';
  }
}

/**
 * What a surface renders. `isOwner` gates the writes; everything else is shown
 * to everyone. A remedy this platform has no handler for is dropped entirely
 * rather than shown broken — see `NOT_YET_WIRED` for the deliberate exception.
 */
export function remedyButtons(
  blockage: Blockage | undefined,
  viewer: { isOwner: boolean }
): RemedyButton[] {
  if (!blockage) return [];
  return blockage.remedies.map((remedy) => {
    const notWired = NOT_YET_WIRED.get(remedy.type);
    const ownerBlocked = OWNER_ONLY.has(remedy.type) && !viewer.isOwner;
    return {
      remedy_id: remedy.id,
      type: remedy.type,
      label: labelFor(remedy),
      ...(remedy.default ? { primary: true as const } : {}),
      ...(notWired
        ? { disabledReason: notWired }
        : ownerBlocked
          ? { disabledReason: 'Only an Owner can change a budget or limit. Ask an Owner to approve this raise.' }
          : {}),
    };
  });
}

/** D7 — a wall with something a human can actually do is "Needs you", not "Blocked". */
export function isResolvableBlockage(blockage: Blockage | undefined, viewer: { isOwner: boolean }): boolean {
  return remedyButtons(blockage, viewer).some((button) => button.type !== 'cancel' && !button.disabledReason);
}

/** Present on a blockage regardless of who is looking — for header counts, which are not per-viewer. */
export function hasActionableRemedy(blockage: Blockage | undefined): boolean {
  return (blockage?.remedies ?? []).some((remedy) => remedy.type !== 'cancel');
}

export const defaultRemedy = (blockage: Blockage | undefined): Remedy | undefined =>
  blockage?.remedies.find((remedy) => remedy.default) ?? blockage?.remedies.find((remedy) => remedy.type !== 'cancel');

// ─── D9: the old engine, still in production until cms-agent deploys ─────────

/** Round up to the nearest 50 cents — never round DOWN a number meant to clear a ceiling. */
const roundUpToHalfDollar = (usd: number): number => Math.ceil(usd * 2) / 2;

/**
 * CMS-Agent's own sentence: "estimated spend $<spent> plus ~$<next> for the
 * upcoming turn exceeds the $<ceiling> ceiling." The first two dollar figures
 * are spent and next-turn estimate, in that order; a third (the ceiling) is
 * ignored. Generic on purpose — the wording may drift, the numbers are what
 * this needs. Moved verbatim from `budget-raise.ts`.
 */
const MONEY = /\$([0-9]+(?:\.[0-9]+)?)/g;

const parseFirstTwoAmounts = (message: string): [number, number] | undefined => {
  const amounts = [...message.matchAll(MONEY)].map((match) => Number(match[1]));
  if (amounts.length < 2) return undefined;
  const [spent, next] = amounts;
  if (!Number.isFinite(spent!) || !Number.isFinite(next!) || spent! < 0 || next! < 0) return undefined;
  return [spent!, next!];
};

export interface LegacyFailure {
  code: string;
  message: string;
  details?: { nodeId?: string; budgetUsd?: number; spentUsd?: number; nextTurnEstimateUsd?: number; suggestedBudgetUsd?: number };
  operatorAction?: string;
  runId?: string;
  nodeId?: string;
}

/**
 * Synthesize a `blockage.v1` from what an OLD CMS-Agent sends, so every surface
 * has exactly one shape to render for the whole two-deploy window (D9). Only
 * `budget_exceeded` is reconstructed: it is the one code whose remedy this
 * platform could already derive on its own, and inventing remedies for codes
 * whose details never travelled would be guessing.
 *
 * `blockage_id` here is NOT the engine's (there is no attempt number to hash and
 * no shared secret), so it is namespaced `blk_legacy_` — a resolution posted
 * against it can never collide with a real engine-minted id in the ledger.
 */
export function blockageFromLegacyMessage(
  failure: LegacyFailure | undefined,
  /**
   * WHICH RAISES THIS SURFACE CAN HONOUR — the same distinction the engine draws
   * with `BlockageContext.surface`, which a reconstruction has no way to know.
   *
   * Without it this function only ever emitted the RUN-scoped raise, and only
   * when a runId was present. The Imagery tab has neither: its propose runs as a
   * synthetic `independent_node`, so for the whole two-deploy window the card
   * there offered "Raise default to $X" (Owner-only, permanent, for every
   * tenant) and "Dismiss" — never the cheap, reversible, editor-usable attempt
   * raise the whole D3/D8 design is built around.
   */
  surface: 'run' | 'sync' = 'run'
): Blockage | undefined {
  if (!failure || failure.code !== 'budget_exceeded') return undefined;

  const details = failure.details;
  // `> 0`, not merely "a number" — the guard `budget-raise.ts` had. An engine
  // sending `suggestedBudgetUsd: 0` used to fall through to the computation
  // below and produce a usable figure; short-circuiting on it renders a "Raise
  // to $0" button that does nothing.
  const suggested = num(details?.suggestedBudgetUsd);
  let budgetUsd = suggested !== undefined && suggested > 0 ? suggested : undefined;
  if (budgetUsd === undefined) {
    const spent = num(details?.spentUsd);
    const next = num(details?.nextTurnEstimateUsd);
    if (spent !== undefined && next !== undefined) budgetUsd = roundUpToHalfDollar((spent + next) * 1.5);
  }
  if (budgetUsd === undefined) {
    const parsed = parseFirstTwoAmounts(failure.message);
    if (parsed) budgetUsd = roundUpToHalfDollar((parsed[0] + parsed[1]) * 1.5);
  }
  // Nothing to compute a number from: the caller shows operatorAction alone,
  // never a guessed figure. Same refusal `suggestedBudgetRaise` always made.
  if (budgetUsd === undefined) return undefined;

  const nodeId = failure.nodeId ?? details?.nodeId ?? 'unknown';
  const runId = failure.runId;
  return {
    blockage_id: `blk_legacy_${runId ?? 'norun'}_${nodeId}_budget_exceeded`,
    contract: 'blockage.v1',
    code: 'budget_exceeded',
    kind: 'budget',
    message: failure.message,
    ...(failure.operatorAction ? { operator_action: failure.operatorAction } : {}),
    ...(details ? { details: { ...details } } : {}),
    remedies: [
      // On a run surface: exactly the two buttons `budgetRaiseButtons` rendered,
      // in the same order, with the same amount — a legacy card must not look
      // different. On a sync surface: the attempt raise, which is the only one
      // that path can honour (D3) and the one an editor may press.
      ...(surface === 'sync'
        ? [{ id: 'raise_budget_attempt', type: 'raise_node_budget' as const, args: { scope: 'attempt', budgetUsd }, default: true as const }]
        : runId
          ? [{ id: 'raise_budget_run', type: 'raise_node_budget' as const, args: { scope: 'run', budgetUsd, runId, nodeId }, default: true as const }]
          : []),
      { id: 'raise_budget_default', type: 'raise_node_budget' as const, args: { scope: 'default', budgetUsd, nodeId } },
      { id: 'cancel', type: 'cancel' as const },
    ],
    scope: { node_id: nodeId, ...(runId ? { run_id: runId } : {}) },
  };
}

/** The blockage a surface should render: the engine's when it sent one, else the reconstruction. */
export const resolveBlockage = (
  blockage: Blockage | undefined,
  legacy: LegacyFailure | undefined,
  surface: 'run' | 'sync' = 'run'
): Blockage | undefined => blockage ?? blockageFromLegacyMessage(legacy, surface);
