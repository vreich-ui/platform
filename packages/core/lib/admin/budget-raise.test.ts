import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { budgetRaiseButtons, formatBudgetUsd, suggestedBudgetRaise } from './budget-raise.js';

/** The real production message (2026-08-31, run_1788165644777_zuu2o1, node artifact_plan). */
const REAL_MESSAGE =
  'Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after.';

describe('suggestedBudgetRaise', () => {
  it('is undefined for any code other than budget_exceeded, even with parseable numbers', () => {
    assert.equal(suggestedBudgetRaise('model_error', REAL_MESSAGE, undefined), undefined);
  });

  it('uses CMS-Agent\'s own suggestedBudgetUsd verbatim when present (post budget-override-and-ui-save)', () => {
    const suggestion = suggestedBudgetRaise('budget_exceeded', REAL_MESSAGE, {
      nodeId: 'artifact_plan',
      budgetUsd: 3,
      spentUsd: 2.70755,
      nextTurnEstimateUsd: 0.32781,
      suggestedBudgetUsd: 4.5,
    });
    assert.deepEqual(suggestion, { budgetUsd: 4.5, source: 'cms_agent' });
  });

  it('computes ceil((spent+next)*1.5*2)/2 from details.spentUsd/nextTurnEstimateUsd when suggestedBudgetUsd is absent', () => {
    const suggestion = suggestedBudgetRaise('budget_exceeded', REAL_MESSAGE, {
      spentUsd: 2.70755,
      nextTurnEstimateUsd: 0.32781,
    });
    // ceil((2.70755 + 0.32781) * 1.5 * 2) / 2 = ceil(9.10608) / 2 = 10 / 2 = 5
    assert.deepEqual(suggestion, { budgetUsd: 5, source: 'parsed' });
  });

  it('falls back to parsing the two dollar figures out of the message when details is entirely absent (the older CMS-Agent live in production 2026-08-31)', () => {
    const suggestion = suggestedBudgetRaise('budget_exceeded', REAL_MESSAGE, undefined);
    assert.deepEqual(suggestion, { budgetUsd: 5, source: 'parsed' });
  });

  it('same message-parse fallback when details exists but carries neither spentUsd/nextTurnEstimateUsd nor suggestedBudgetUsd', () => {
    const suggestion = suggestedBudgetRaise('budget_exceeded', REAL_MESSAGE, { nodeId: 'artifact_plan', budgetUsd: 3 });
    assert.deepEqual(suggestion, { budgetUsd: 5, source: 'parsed' });
  });

  it('is undefined when neither details nor the message carries two parseable dollar figures', () => {
    assert.equal(
      suggestedBudgetRaise('budget_exceeded', 'The node budget was exceeded. Contact the owner.', undefined),
      undefined
    );
  });

  it('is undefined with only one dollar figure in the message', () => {
    assert.equal(suggestedBudgetRaise('budget_exceeded', 'Spend reached $3, the ceiling.', undefined), undefined);
  });

  it('ignores a non-positive or non-finite suggestedBudgetUsd and falls through to the message parse', () => {
    const suggestion = suggestedBudgetRaise('budget_exceeded', REAL_MESSAGE, { suggestedBudgetUsd: 0 });
    assert.deepEqual(suggestion, { budgetUsd: 5, source: 'parsed' });
  });
});

describe('formatBudgetUsd', () => {
  it('renders a whole dollar amount with no decimals', () => {
    assert.equal(formatBudgetUsd(5), '$5');
  });

  it('renders a half-dollar amount with two decimals', () => {
    assert.equal(formatBudgetUsd(4.5), '$4.50');
  });
});

// ─── budgetRaiseButtons — what RequestActivity.tsx's recovery card renders ─

const REAL_FAILURE = {
  code: 'budget_exceeded',
  message: REAL_MESSAGE,
  details: {
    nodeId: 'artifact_plan',
    budgetUsd: 3,
    spentUsd: 2.70755,
    nextTurnEstimateUsd: 0.32781,
    suggestedBudgetUsd: 5,
  },
};

describe('budgetRaiseButtons', () => {
  it('an Owner gets exactly the two buttons, in order, with the right amounts', () => {
    const buttons = budgetRaiseButtons(REAL_FAILURE, true);
    assert.deepEqual(buttons, [
      { label: 'Raise to $5 for this run', scope: 'for_run', budgetUsd: 5 },
      { label: 'Raise default to $5', scope: 'default', budgetUsd: 5 },
    ]);
  });

  it('a non-Owner sees no buttons at all — the operatorAction text is the whole card', () => {
    assert.deepEqual(budgetRaiseButtons(REAL_FAILURE, false), []);
  });

  it('an Owner still sees no buttons for a non-budget_exceeded failure', () => {
    assert.deepEqual(budgetRaiseButtons({ code: 'model_error', message: 'Invalid output type' }, true), []);
  });

  it('an Owner sees no buttons when nothing is parseable — the caller falls back to the plain operatorAction text', () => {
    assert.deepEqual(budgetRaiseButtons({ code: 'budget_exceeded', message: 'Contact the owner.' }, true), []);
  });

  it('no failure at all (a node with no recovery detail) never renders buttons', () => {
    assert.deepEqual(budgetRaiseButtons(undefined, true), []);
  });

  it('the older CMS-Agent shape (no details.suggestedBudgetUsd, no details at all) still gets buttons via the message parse', () => {
    const buttons = budgetRaiseButtons({ code: 'budget_exceeded', message: REAL_MESSAGE }, true);
    assert.deepEqual(buttons, [
      { label: 'Raise to $5 for this run', scope: 'for_run', budgetUsd: 5 },
      { label: 'Raise default to $5', scope: 'default', budgetUsd: 5 },
    ]);
  });
});
