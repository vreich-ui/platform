/**
 * D5 — "answer or click, preferably both."
 *
 * A blockage card gives an editor buttons. This gives them the other half: they
 * type "raise it to 2 dollars and try again", or "yes", or "1", and it resolves
 * without a model turn.
 *
 * WHY DETERMINISTIC FIRST, MODEL SECOND. The model path works — `loop.ts` puts
 * the pending blockage in the turn's context and exposes a `resolve_blockage`
 * tool — but it costs a provider turn (and a budget) to answer a question whose
 * whole answer space is four buttons. In the 90% case the human says one of
 * four things, and matching those here costs nothing. An unmatched answer still
 * reaches the model, so nothing is lost by trying: this function REFUSES rather
 * than guesses, and every refusal is just the normal chat turn.
 *
 * Pure and isomorphic, so the whole table is provable with `node --test` — and
 * so the composer could, later, show what a typed answer would do before it is
 * sent. It never calls anything and never decides a role: the amount it returns
 * is a REQUEST, bounded again server-side by `mergeRemedyArgs` (which is what
 * stops a typed amount re-targeting the remedy) and by `planSyncToolRemedy`.
 */

import { defaultRemedy, type Blockage, type Remedy } from './blockage.js';

export interface BlockageAnswer {
  remedy_id: string;
  /** Only ever the numbers a human may override — never a scope, node or run. */
  args?: Record<string, number>;
}

const normalize = (text: string): string =>
  text
    .toLowerCase()
    // Strip the punctuation people end sentences with, but NOT '.' inside a
    // number ("$1.50") and not '$' — both carry meaning here.
    .replace(/[!?,;:"'“”]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * English and Hebrew, because Wolf works in both and a Hebrew "כן" reaching a
 * model turn instead of a button would be the exact cost this exists to avoid.
 * Deliberately short lists: a long one starts matching sentences that only
 * CONTAIN a yes ("yes but not from the default budget"), which must go to the
 * model, not to the primary button.
 */
const AFFIRMATIVE = new Set([
  'y', 'yes', 'yep', 'yeah', 'ok', 'okay', 'k', 'sure', 'do it', 'go', 'go ahead',
  'please', 'yes please', 'proceed', 'confirm', 'approve', 'approved', 'accept',
  'כן', 'אישור', 'אשר', 'בסדר', 'קדימה', 'תאשר',
]);

const NEGATIVE = new Set([
  'n', 'no', 'nope', 'cancel', 'stop', 'skip', 'dismiss', 'never mind', 'nevermind',
  'leave it', 'not now', 'decline', 'reject',
  'לא', 'בטל', 'ביטול', 'עצור', 'דלג', 'לא עכשיו',
]);

/** "$2", "$1.50", "2 dollars", "2$", "1.5 dollar". The '$' may lead or trail. */
const AMOUNT = /(?:\$\s*([0-9]+(?:\.[0-9]+)?)|([0-9]+(?:\.[0-9]+)?)\s*(?:\$|dollars?|usd))/i;

/** Words that mean "and make it stick", i.e. the stored default rather than one attempt. */
const DEFAULT_SCOPE_WORDS = /\b(default|always|permanent(?:ly)?|from now on|every time|for good)\b/i;

/** Words that mean the opposite — this once. Checked first, so "just this once, as the default" is ambiguous → model. */
const ATTEMPT_SCOPE_WORDS = /\b(just this once|this time|this attempt|one off|one-off|only now)\b/i;

const remedyMatchesScope = (remedy: Remedy, scope: 'attempt' | 'default' | 'run'): boolean =>
  remedy.type === 'raise_node_budget' && (remedy.args?.scope === scope || (scope !== 'default' && remedy.args?.scope !== 'default'));

/** The word a label leads with, lowercased, for a loose "did they say the button" match. */
const labelWords = (remedy: Remedy): string[] => {
  switch (remedy.type) {
    case 'raise_node_budget':
    case 'raise_run_budget':
      return ['raise', 'budget', 'increase'];
    case 'raise_limit':
      return ['raise', 'limit', 'increase', 'more turns'];
    case 'retry':
      return ['retry', 'try again', 'again'];
    case 'resume':
      return ['resume', 'continue'];
    case 'approve_gate':
      return ['approve', 'publish it'];
    case 'decline_gate':
      return ['decline', 'withhold', 'hold'];
    case 'open_settings':
      return ['settings', 'credentials'];
    case 'set_project_field':
      return ['endpoint', 'configure'];
    case 'cancel':
      return ['cancel', 'dismiss', 'skip'];
    default:
      return [];
  }
};

/**
 * `null` means "this is not an answer to the blockage" — hand it to the model.
 * That is the honest majority outcome for anything conversational, and the
 * caller MUST treat it as such rather than falling back to the default remedy:
 * "actually, why did that happen?" is a question, not a $2 raise.
 */
export function matchBlockageAnswer(text: string, blockage: Blockage | undefined): BlockageAnswer | null {
  if (!blockage || blockage.remedies.length === 0) return null;
  const normalized = normalize(text);
  if (!normalized) return null;
  // Anything long is a sentence with intent of its own; matching a keyword out
  // of a paragraph is how "don't raise the budget, explain it to me first"
  // becomes a raise.
  if (normalized.length > 120) return null;
  // A CONDITION or a qualification is a question, however short. "raise it to
  // $2 but only if that is under what we agreed" contains a perfectly good
  // amount and means the opposite of an instruction to spend it. These belong
  // to the model, which can ask; this function can only act.
  if (/\b(but|if|unless|otherwise|instead|except|rather than|first|before)\b/.test(normalized)) return null;

  const cancel = blockage.remedies.find((remedy) => remedy.type === 'cancel');
  const preferred = defaultRemedy(blockage);

  // 1. An amount — the single most common real answer ("make it $2").
  //
  // NO BARE OPTION NUMBER. The plan called for "1"/"2" to select a remedy, and
  // it was implemented, and it was wrong: no surface actually numbers the
  // buttons. `BlockageCard` renders labels. So a "1" typed for any other reason
  // — answering the agent's own question, a stray keystroke — would index
  // `remedies[0]`, which for a budget wall is a raise. An affordance nobody was
  // offered is not an affordance; it is a trap.
  const amountMatch = AMOUNT.exec(normalized);
  const amount = amountMatch ? Number(amountMatch[1] ?? amountMatch[2]) : undefined;
  // The amount has to be OFFERED, not merely mentioned. "keep it under $2" and
  // "we already spent $3" both contain a perfectly good number and neither is
  // an instruction to spend it. Either the message is essentially just the
  // amount, or it carries a verb that means "make it so".
  // A CONSTRAINT is the opposite of an instruction, and says so in words the
  // amount branch would otherwise happily spend: "keep it under $2", "no more
  // than $5", "at most $1". Checked first, so nothing below can override it.
  const isConstraint = /\b(under|below|at most|no more than|less than|max|maximum|cap|limit it to|within)\b/.test(normalized);
  const isRaiseInstruction =
    !isConstraint &&
    (/\b(raise|increase|bump|make it|make|set it to|set|use|up it|give it|allow|go to)\b/.test(normalized) ||
      // Naming a SCOPE for the amount ("$3 as the default", "always $3") is an
      // instruction as surely as a verb is.
      DEFAULT_SCOPE_WORDS.test(normalized) ||
      ATTEMPT_SCOPE_WORDS.test(normalized) ||
      // …or the message is essentially just the amount.
      normalized.replace(AMOUNT, '').replace(/\b(to|it|the|budget|please|and try again|try again|again)\b/g, '').trim().length === 0);
  if (amount !== undefined && Number.isFinite(amount) && amount > 0 && isRaiseInstruction) {
    const wantsDefault = DEFAULT_SCOPE_WORDS.test(normalized) && !ATTEMPT_SCOPE_WORDS.test(normalized);
    // A limit blockage has no dollars in it; a bare number there is a turn
    // count, and mapping it onto a budget remedy that does not exist would
    // silently do the wrong thing.
    const budgetRemedies = blockage.remedies.filter((remedy) => remedy.type === 'raise_node_budget' || remedy.type === 'raise_run_budget');
    if (budgetRemedies.length === 0) return null;
    const chosen =
      budgetRemedies.find((remedy) => remedyMatchesScope(remedy, wantsDefault ? 'default' : 'attempt')) ??
      budgetRemedies.find((remedy) => remedy.args?.scope !== 'default') ??
      budgetRemedies[0]!;
    return { remedy_id: chosen.id, args: { budgetUsd: amount } };
  }

  // 3. Yes / no, as the whole answer. `defaultRemedy` is what "yes" means, and
  //    the engine flags exactly one — the cheap, reversible one.
  if (AFFIRMATIVE.has(normalized)) return preferred ? { remedy_id: preferred.id } : null;
  if (NEGATIVE.has(normalized)) {
    // "no" on an approval gate has no `cancel` to fall back to — declining IS
    // the refusal there, and answering null would send a clear decision to a
    // model turn.
    const refusal = cancel ?? blockage.remedies.find((remedy) => remedy.type === 'decline_gate');
    return refusal ? { remedy_id: refusal.id } : null;
  }

  // 4. The button, by name. Requires the answer to be SHORT and to be about one
  //    remedy only — "raise the budget" is an instruction; "should I raise the
  //    budget or wait?" is a question and must not match.
  if (normalized.split(' ').length <= 6) {
    const matches = blockage.remedies.filter((remedy) =>
      labelWords(remedy).some((word) => normalized.includes(word))
    );
    // Exactly one, or the ambiguity is real: "raise it" against a blockage
    // offering both an attempt and a default raise is a genuine question.
    if (matches.length === 1) return { remedy_id: matches[0]!.id };
    if (matches.length > 1) {
      // ONLY with an explicit scope word. "raise it" against a blockage
      // offering both a one-off and a permanent raise is a real ambiguity, and
      // quietly picking the cheaper one would be a guess dressed as an answer —
      // the model can ask which, at the cost of one turn, and be right.
      const scopeWord = DEFAULT_SCOPE_WORDS.test(normalized)
        ? 'default'
        : ATTEMPT_SCOPE_WORDS.test(normalized)
          ? 'attempt'
          : undefined;
      if (!scopeWord) return null;
      const scoped = matches.filter((remedy) =>
        scopeWord === 'default' ? remedy.args?.scope === 'default' : remedy.args?.scope !== 'default'
      );
      if (scoped.length === 1) return { remedy_id: scoped[0]!.id };
    }
  }

  return null;
}

/**
 * The one-line prompt the transcript shows under a blockage card, listing what
 * a typed answer can be. Built from the SAME remedies the buttons come from, so
 * it can never offer an option the card does not have.
 */
export const blockageAnswerHint = (blockage: Blockage | undefined): string | undefined => {
  if (!blockage || blockage.remedies.length === 0) return undefined;
  const preferred = defaultRemedy(blockage);
  return preferred
    ? `You can also just say “yes”, or name an amount — “make it $2”.`
    : undefined;
};
