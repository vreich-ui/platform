import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { matchBlockageAnswer } from './blockage-answer-matcher.js';
import type { Blockage } from './blockage.js';

const budget: Blockage = {
  blockage_id: 'blk_1',
  code: 'budget_exceeded',
  kind: 'budget',
  message: 'stopped on budget',
  remedies: [
    { id: 'raise_budget_attempt', type: 'raise_node_budget', args: { scope: 'attempt', budgetUsd: 1.5 }, default: true },
    { id: 'raise_budget_default', type: 'raise_node_budget', args: { scope: 'default', budgetUsd: 1.5 } },
    { id: 'cancel', type: 'cancel' },
  ],
  scope: { node_id: 'brand_imagery_writer' },
};

const gate: Blockage = {
  blockage_id: 'blk_2',
  code: 'approval_required',
  kind: 'approval',
  message: 'publish gate',
  remedies: [
    { id: 'approve', type: 'approve_gate', default: true },
    { id: 'decline', type: 'decline_gate' },
  ],
  scope: { node_id: 'publish_executor', run_id: 'run_9' },
};

const limit: Blockage = {
  blockage_id: 'blk_3',
  code: 'max_turns_exceeded',
  kind: 'limit',
  message: 'out of turns',
  remedies: [
    { id: 'raise_max_turns', type: 'raise_limit', args: { field: 'maxTurns', value: 12 }, default: true },
    { id: 'cancel', type: 'cancel' },
  ],
  scope: { node_id: 'article_body' },
};

const match = (text: string, blockage: Blockage = budget) => matchBlockageAnswer(text, blockage);

describe('matchBlockageAnswer — the 90% case, at zero model cost', () => {
  it('does NOT take a bare number — no surface numbers the buttons', () => {
    // The plan asked for "1"/"2" to select a remedy. Nothing renders numbered
    // options, so a bare digit typed for any other reason would have indexed
    // remedies[0] — a raise, on a budget wall.
    assert.equal(match('1'), null);
    assert.equal(match('2'), null);
  });

  it('takes yes as the flagged default — the cheap, reversible remedy', () => {
    for (const yes of ['yes', 'Yes', 'yep', 'ok', 'sure', 'go ahead', 'do it', 'proceed']) {
      assert.deepEqual(match(yes), { remedy_id: 'raise_budget_attempt' }, yes);
    }
    assert.deepEqual(match('כן'), { remedy_id: 'raise_budget_attempt' }, 'Hebrew yes');
    assert.deepEqual(match('אשר'), { remedy_id: 'raise_budget_attempt' });
  });

  it('takes no as a dismissal', () => {
    for (const no of ['no', 'nope', 'cancel', 'skip', 'stop', 'not now']) {
      assert.deepEqual(match(no), { remedy_id: 'cancel' }, no);
    }
    assert.deepEqual(match('לא'), { remedy_id: 'cancel' }, 'Hebrew no');
    assert.deepEqual(match('בטל'), { remedy_id: 'cancel' });
  });

  it('takes an amount, in the several ways people write one', () => {
    for (const text of ['$2', '2 dollars', '2$', 'make it $2', 'raise it to 2 dollars']) {
      assert.deepEqual(match(text), { remedy_id: 'raise_budget_attempt', args: { budgetUsd: 2 } }, text);
    }
    assert.deepEqual(match('$1.50'), { remedy_id: 'raise_budget_attempt', args: { budgetUsd: 1.5 } });
  });

  it('routes an amount to the DEFAULT scope when the human says so', () => {
    assert.deepEqual(match('make $3 the default'), { remedy_id: 'raise_budget_default', args: { budgetUsd: 3 } });
    assert.deepEqual(match('always use $3'), { remedy_id: 'raise_budget_default', args: { budgetUsd: 3 } });
    // …and to the attempt when they say the opposite, even alongside "default".
    assert.deepEqual(match('$3 just this once'), { remedy_id: 'raise_budget_attempt', args: { budgetUsd: 3 } });
  });

  it('takes an unambiguous button name', () => {
    assert.deepEqual(match('approve', gate), { remedy_id: 'approve' });
    assert.deepEqual(match('decline', gate), { remedy_id: 'decline' });
    assert.deepEqual(match('retry', { ...budget, remedies: [{ id: 'retry', type: 'retry' }, { id: 'cancel', type: 'cancel' }] }), { remedy_id: 'retry' });
  });

  it('resolves an ambiguous button name by the scope word', () => {
    // Both budget remedies match "raise"; "default" picks one.
    assert.deepEqual(match('raise the default'), { remedy_id: 'raise_budget_default' });
    assert.deepEqual(match('raise it just this once'), { remedy_id: 'raise_budget_attempt' });
  });
});

describe('matchBlockageAnswer — refusing, which is most of the job', () => {
  it('does not answer a QUESTION about the blockage', () => {
    assert.equal(match('why did that happen?'), null);
    assert.equal(match('what would raising the budget cost me?'), null);
    assert.equal(match('should I raise the budget or wait for the cheaper model?'), null);
  });

  it('does not read a yes out of a sentence that qualifies it', () => {
    assert.equal(match('yes but not as the default'), null);
    assert.equal(match('no idea, what do you think?'), null);
  });

  it('does not answer an ambiguous "raise it" when two raises are offered', () => {
    assert.equal(match('raise it'), null);
  });

  it('hands a long instruction to the model, whatever words it contains', () => {
    assert.equal(
      match('raise it to $2 but only if that is still under what we agreed for this project, otherwise leave it alone'),
      null
    );
  });

  it('never maps a bare number onto a budget remedy that is not there', () => {
    // "12" on a turn-limit blockage is a turn count, not $12.
    assert.equal(matchBlockageAnswer('$12', limit), null);
  });

  it('is null for no blockage, no remedies, or an empty message', () => {
    assert.equal(matchBlockageAnswer('yes', undefined), null);
    assert.equal(matchBlockageAnswer('yes', { ...budget, remedies: [] }), null);
    assert.equal(match('   '), null);
  });

  it('never invents an amount from a non-numeric answer', () => {
    assert.equal(match('raise it a lot'), null);
  });

  it('does not spend an amount the human merely MENTIONED', () => {
    // Both contain a usable figure and neither is an instruction to spend it.
    assert.equal(match('keep it under $2'), null);
    assert.equal(match('we already spent $3 on this'), null);
    assert.equal(match('the ceiling is $0.25 right now'), null);
  });

  it('does not treat a bare "yes" as anything when only a dismissal is on offer', () => {
    // "yes" against a card whose only control is Dismiss is genuinely unclear —
    // yes to what? The model can ask; guessing "dismiss" would throw the wall
    // away on a word that probably meant the opposite.
    const noDefault: Blockage = { ...budget, remedies: [{ id: 'cancel', type: 'cancel' }] };
    assert.equal(matchBlockageAnswer('yes', noDefault), null);
  });

  it('takes "no" on an approval gate as a decline, which is the refusal there', () => {
    assert.deepEqual(matchBlockageAnswer('no', gate), { remedy_id: 'decline' });
  });
});
