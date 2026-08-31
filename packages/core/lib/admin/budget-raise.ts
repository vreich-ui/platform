/**
 * Bug B (budget-raise-card) — turns a `budget_exceeded` node failure into the
 * one number the two raise-and-retry buttons need: what to raise the ceiling
 * to. Pure and isomorphic (no server import), so `RequestActivity.tsx` can
 * call it directly and it can be tested without a fetch or a React tree —
 * same posture as `cms-agent-error-copy.ts`, which this sits next to.
 *
 * CMS-Agent (post the `budget-override-and-ui-save` patch) answers a
 * `budget_exceeded` failure with `output.error.details.suggestedBudgetUsd`
 * already computed — used verbatim when present. An older CMS-Agent (what
 * production is still running as of 2026-08-31 — see the live fixture in
 * `budget-raise.test.ts`) sends `details` with no `suggestedBudgetUsd` at
 * all, or no `details` object whatsoever; either way the two dollar figures
 * CMS-Agent's own operator-facing sentence already states ("estimated spend
 * $X plus ~$Y for the upcoming turn") are parsed back out of `message` and
 * the same formula applied. When neither the field nor the message parses,
 * this returns `undefined` — the caller shows the operatorAction text alone,
 * never a guessed number.
 */

export interface BudgetExceededDetails {
  nodeId?: string;
  budgetUsd?: number;
  spentUsd?: number;
  nextTurnEstimateUsd?: number;
  suggestedBudgetUsd?: number;
}

export interface BudgetRaiseSuggestion {
  /** What to raise the ceiling to — always a multiple of $0.50. */
  budgetUsd: number;
  /** Whether this is CMS-Agent's own number, or one this function computed. */
  source: 'cms_agent' | 'parsed';
}

/** Round up to the nearest 50 cents — never round DOWN a number meant to clear a ceiling. */
const roundUpToHalfDollar = (usd: number): number => Math.ceil(usd * 2) / 2;

/**
 * CMS-Agent's own sentence shape: "estimated spend $<spent> plus ~$<next>
 * for the upcoming turn exceeds the $<ceiling> ceiling." The first two
 * dollar figures in the message are spent and next-turn-estimate, in that
 * order; a third (the ceiling itself) is ignored. Generic on purpose — this
 * must keep working even if CMS-Agent's exact wording around the numbers
 * drifts, since the numbers are the only part this fallback actually needs.
 */
const MONEY = /\$([0-9]+(?:\.[0-9]+)?)/g;

const parseFirstTwoAmounts = (message: string): [number, number] | undefined => {
  const amounts = [...message.matchAll(MONEY)].map((match) => Number(match[1]));
  if (amounts.length < 2) return undefined;
  const [spent, next] = amounts;
  if (!Number.isFinite(spent) || !Number.isFinite(next) || spent! < 0 || next! < 0) return undefined;
  return [spent!, next!];
};

/**
 * `undefined` when the failure is not `budget_exceeded`, or when nothing —
 * neither CMS-Agent's own suggestion nor two parseable dollar figures — is
 * available to compute one from.
 */
export function suggestedBudgetRaise(
  code: string,
  message: string,
  details: BudgetExceededDetails | undefined
): BudgetRaiseSuggestion | undefined {
  if (code !== 'budget_exceeded') return undefined;

  if (typeof details?.suggestedBudgetUsd === 'number' && Number.isFinite(details.suggestedBudgetUsd) && details.suggestedBudgetUsd > 0) {
    return { budgetUsd: details.suggestedBudgetUsd, source: 'cms_agent' };
  }

  const spent = typeof details?.spentUsd === 'number' && Number.isFinite(details.spentUsd) ? details.spentUsd : undefined;
  const next =
    typeof details?.nextTurnEstimateUsd === 'number' && Number.isFinite(details.nextTurnEstimateUsd)
      ? details.nextTurnEstimateUsd
      : undefined;
  if (spent !== undefined && next !== undefined) {
    return { budgetUsd: roundUpToHalfDollar((spent + next) * 1.5), source: 'parsed' };
  }

  const parsed = parseFirstTwoAmounts(message);
  if (!parsed) return undefined;
  const [parsedSpent, parsedNext] = parsed;
  return { budgetUsd: roundUpToHalfDollar((parsedSpent + parsedNext) * 1.5), source: 'parsed' };
}

/** "$5", "$4.50" — a suggested ceiling is always a whole or half dollar; never `.toFixed(2)`'s "$5.00". */
export function formatBudgetUsd(usd: number): string {
  return Number.isInteger(usd) ? `$${usd}` : `$${usd.toFixed(2)}`;
}

export interface BudgetRaiseButton {
  label: string;
  scope: 'for_run' | 'default';
  budgetUsd: number;
}

/**
 * What `RequestActivity.tsx`'s recovery card actually renders for a
 * `budget_exceeded` node failure — pulled out as a pure function (rather than
 * left inline in the component) so "the right two buttons, with the right
 * amounts, Owner-only" is provable without a rendered React tree, which this
 * repo has no harness for.
 *
 * Both Owner-only (`isOwner`, resolved the same way `AgentRail`'s
 * `canUseTestMode`/this component's other Owner gate already are) — a
 * non-Owner, or a failure with nothing to compute a number from, gets no
 * buttons at all: the plain `operatorAction` sentence is all the card shows.
 */
export function budgetRaiseButtons(
  failure: { code: string; message: string; details?: BudgetExceededDetails } | undefined,
  isOwner: boolean
): BudgetRaiseButton[] {
  if (!isOwner || !failure) return [];
  const suggestion = suggestedBudgetRaise(failure.code, failure.message, failure.details);
  if (!suggestion) return [];
  const amount = formatBudgetUsd(suggestion.budgetUsd);
  return [
    { label: `Raise to ${amount} for this run`, scope: 'for_run', budgetUsd: suggestion.budgetUsd },
    { label: `Raise default to ${amount}`, scope: 'default', budgetUsd: suggestion.budgetUsd },
  ];
}
