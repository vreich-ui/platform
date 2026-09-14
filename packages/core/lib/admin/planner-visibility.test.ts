/**
 * Track C — what an operator SEES about a run nobody asked for.
 *
 * Two facts and two buttons. The facts matter because a commissioned run with
 * an "Asked by" line quietly claims a human requested it; the buttons matter
 * because `planner_halted` is the one blockage whose fix is "go and change the
 * strategy", which is not a phrase any existing remedy label produces.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requestFacts } from './request-logic.js';
import { STRATEGY_COMMISSIONING_FIELD, parseBlockage, remedyButtons } from './blockage.js';

const row = (over: Record<string, unknown> = {}) => ({
  request_id: 'req_planner_ceramide_20260914_01',
  kind: 'article',
  status: 'running' as const,
  created_by: 'editorial_planner',
  updated_at: '2026-09-14T06:02:00.000Z',
  ...over,
});

const NOW = Date.parse('2026-09-14T06:30:00.000Z');

describe('a commissioned request in the runs inbox', () => {
  it('says who commissioned it and why — never "Asked by"', () => {
    const facts = requestFacts(
      row({ commissioned_by: 'editorial_planner', commissioning_rationale: 'Recognition is the thinnest reader state.' }),
      NOW
    );
    const labels = facts.map((fact) => fact.label);
    assert.ok(labels.includes('Commissioned by'));
    assert.ok(labels.includes('Why'));
    assert.ok(!labels.includes('Asked by'), 'nobody asked — an "Asked by" line would be a false claim');
    assert.equal(facts.find((fact) => fact.label === 'Commissioned by')?.value, 'editorial_planner');
  });

  it('still says "Asked by" for a run a human actually asked for', () => {
    const facts = requestFacts(row({ created_by: 'wolf@kugelbrands.com' }), NOW);
    assert.equal(facts.find((fact) => fact.label === 'Asked by')?.value, 'wolf@kugelbrands.com');
    assert.ok(!facts.some((fact) => fact.label === 'Commissioned by'));
  });

  it('omits the rationale rather than rendering an empty row', () => {
    const facts = requestFacts(row({ commissioned_by: 'editorial_planner' }), NOW);
    assert.ok(!facts.some((fact) => fact.label === 'Why'));
  });
});

describe('planner_halted renders as an actionable wall', () => {
  const halted = parseBlockage({
    blockage_id: 'blk_planner_halted_dr_lurie',
    contract: 'blockage.v1',
    code: 'planner_halted',
    kind: 'limit',
    message: 'Commissioning stopped after 2 consecutive failed runs.',
    operator_action: 'Revise the strategy, or resume to try again.',
    remedies: [
      { id: 'revise', type: 'set_project_field', args: { field: STRATEGY_COMMISSIONING_FIELD }, default: true },
      { id: 'resume', type: 'resume', args: { scope: 'planner' } },
    ],
    scope: { node_id: 'editorial_planner', run_id: 'planner' },
  });

  it('parses as a blockage.v1', () => {
    assert.ok(halted, 'a planner halt must be a well-formed blockage or no card renders at all');
  });

  it('gives an owner the two buttons, in the operator’s own words', () => {
    const buttons = remedyButtons(halted, { isOwner: true });
    assert.deepEqual(
      buttons.map((button) => button.label),
      ['Revise the strategy', 'Resume commissioning']
    );
    assert.equal(buttons[0]!.primary, true);
    assert.equal(buttons[0]!.disabledReason, undefined);
  });

  it('shows a non-owner the revise button disabled, and resume live', () => {
    const buttons = remedyButtons(halted, { isOwner: false });
    assert.ok(buttons[0]!.disabledReason, 'only an Owner may write project config');
    assert.equal(buttons[1]!.disabledReason, undefined);
  });
});
