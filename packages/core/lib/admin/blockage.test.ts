import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blockageFromLegacyMessage,
  defaultRemedy,
  hasActionableRemedy,
  isResolvableBlockage,
  parseBlockage,
  remedyButtons,
  resolveBlockage,
  type Blockage,
} from './blockage.js';

/** The real production message (2026-08-31, run_1788165644777_zuu2o1, node artifact_plan). */
const REAL_MESSAGE =
  'Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after.';

const budgetBlockage = (overrides: Partial<Blockage> = {}): Blockage => ({
  blockage_id: 'blk_abc123',
  contract: 'blockage.v1',
  code: 'budget_exceeded',
  kind: 'budget',
  message: REAL_MESSAGE,
  operator_action: 'Raise brand_imagery_writer budget to $1.5 (this run or default) and retry the node.',
  remedies: [
    { id: 'raise_budget_attempt', type: 'raise_node_budget', args: { scope: 'attempt', budgetUsd: 1.5 }, default: true },
    { id: 'raise_budget_default', type: 'raise_node_budget', args: { scope: 'default', budgetUsd: 1.5, nodeId: 'brand_imagery_writer' } },
    { id: 'cancel', type: 'cancel' },
  ],
  scope: { node_id: 'brand_imagery_writer', run_id: 'node_run_1', tool: 'visual_identity_propose' },
  ...overrides,
});

describe('remedyButtons', () => {
  it('labels a budget raise with the amount the ENGINE computed, per scope', () => {
    assert.deepEqual(
      remedyButtons(budgetBlockage(), { isOwner: true }).map((button) => [button.remedy_id, button.label, button.primary ?? false]),
      [
        ['raise_budget_attempt', 'Raise to $1.50 for this attempt', true],
        ['raise_budget_default', 'Raise default to $1.50', false],
        ['cancel', 'Dismiss', false],
      ]
    );
  });

  it('shows an editor the raise, disabled, with the reason — never hides it', () => {
    // Hiding it means an editor cannot even ask an Owner for the thing they need.
    const buttons = remedyButtons(budgetBlockage(), { isOwner: false });
    assert.equal(buttons.length, 3);
    assert.match(buttons[0]!.disabledReason ?? '', /Only an Owner/);
    // Dismiss is nobody's privilege.
    assert.equal(buttons[2]!.disabledReason, undefined);
  });

  it('renders approval, limit, config and auth remedies with their own words', () => {
    const labels = (remedies: Blockage['remedies']) =>
      remedyButtons(budgetBlockage({ remedies }), { isOwner: true }).map((button) => button.label);

    assert.deepEqual(labels([{ id: 'approve', type: 'approve_gate', args: { gateId: 'editorial.publish' }, default: true }, { id: 'decline', type: 'decline_gate' }]), ['Approve', 'Decline']);
    assert.deepEqual(labels([{ id: 'raise_max_turns', type: 'raise_limit', args: { field: 'maxTurns', value: 12 } }]), ['Raise the turn limit to 12']);
    assert.deepEqual(labels([{ id: 'set_mcp_endpoint', type: 'set_project_field', args: { field: 'mcpEndpoint' } }]), ['Set the CMS-Agent endpoint']);
    assert.deepEqual(labels([{ id: 'open_credentials', type: 'open_settings', args: { path: 'credentials' } }]), ['Open credentials']);
    assert.deepEqual(labels([{ id: 'retry', type: 'retry' }, { id: 'resume', type: 'resume' }]), ['Try again', 'Resume']);
  });

  it('disables a run-budget raise with the honest reason — no engine setter exists yet', () => {
    const [button] = remedyButtons(budgetBlockage({ remedies: [{ id: 'raise_run_budget', type: 'raise_run_budget', args: { budgetUsd: 5 } }] }), { isOwner: true });
    assert.equal(button!.label, 'Raise the run budget to $5');
    assert.match(button!.disabledReason ?? '', /does not exist yet/);
  });

  it('is empty for no blockage at all', () => {
    assert.deepEqual(remedyButtons(undefined, { isOwner: true }), []);
  });
});

describe('D7 — Needs you vs Blocked', () => {
  it('counts a budget wall as resolvable and a validation wall as not', () => {
    assert.equal(isResolvableBlockage(budgetBlockage(), { isOwner: true }), true);
    const validation = budgetBlockage({ kind: 'validation', code: 'input_validation_failed', remedies: [{ id: 'cancel', type: 'cancel' }] });
    assert.equal(isResolvableBlockage(validation, { isOwner: true }), false);
    assert.equal(hasActionableRemedy(validation), false);
  });

  it('does not call a wall resolvable FOR AN EDITOR when only an Owner can clear it', () => {
    assert.equal(isResolvableBlockage(budgetBlockage(), { isOwner: false }), false);
    // …but the header count, which is not per-viewer, still says the wall is actionable.
    assert.equal(hasActionableRemedy(budgetBlockage()), true);
  });
});

describe('defaultRemedy', () => {
  it('is the flagged one, and falls back to the first non-cancel', () => {
    assert.equal(defaultRemedy(budgetBlockage())?.id, 'raise_budget_attempt');
    const noDefault = budgetBlockage({ remedies: [{ id: 'cancel', type: 'cancel' }, { id: 'retry', type: 'retry' }] });
    assert.equal(defaultRemedy(noDefault)?.id, 'retry');
  });
});

describe('parseBlockage', () => {
  it('accepts a well-formed payload and drops a remedy type it has no handler for', () => {
    const parsed = parseBlockage({
      ...budgetBlockage(),
      remedies: [...budgetBlockage().remedies, { id: 'teleport', type: 'teleport_node', args: {} }],
    });
    assert.deepEqual(parsed!.remedies.map((remedy) => remedy.id), ['raise_budget_attempt', 'raise_budget_default', 'cancel']);
  });

  it('refuses anything missing the fields a button depends on', () => {
    assert.equal(parseBlockage(undefined), undefined);
    assert.equal(parseBlockage('budget_exceeded'), undefined);
    assert.equal(parseBlockage({ code: 'x', message: 'y', scope: { node_id: 'n' } }), undefined, 'no blockage_id');
    assert.equal(parseBlockage({ blockage_id: 'b', code: 'x', message: 'y' }), undefined, 'no scope');
  });

  it('falls back to kind "other" rather than dropping a blockage whose kind it does not know', () => {
    assert.equal(parseBlockage({ ...budgetBlockage(), kind: 'wormhole' })!.kind, 'other');
  });
});

describe('D9 — the legacy engine, until cms-agent deploys', () => {
  it('reconstructs the same two buttons todays card shows, from CMS-Agents own sentence', () => {
    const blockage = blockageFromLegacyMessage({ code: 'budget_exceeded', message: REAL_MESSAGE, runId: 'run_1', nodeId: 'artifact_plan' })!;
    assert.deepEqual(
      remedyButtons(blockage, { isOwner: true }).map((button) => button.label),
      ['Raise to $5 for this run', 'Raise default to $5', 'Dismiss']
    );
  });

  it('prefers a structured suggestedBudgetUsd over parsing prose', () => {
    const blockage = blockageFromLegacyMessage({
      code: 'budget_exceeded', message: REAL_MESSAGE, runId: 'run_1', nodeId: 'artifact_plan',
      details: { spentUsd: 2.70755, nextTurnEstimateUsd: 0.32781, suggestedBudgetUsd: 4.5 },
    })!;
    assert.equal(blockage.remedies[0]!.args!.budgetUsd, 4.5);
  });

  it('computes from details when the sentence is unparseable', () => {
    const blockage = blockageFromLegacyMessage({
      code: 'budget_exceeded', message: 'stopped on budget', runId: 'run_1', nodeId: 'n',
      details: { spentUsd: 1, nextTurnEstimateUsd: 1 },
    })!;
    assert.equal(blockage.remedies[0]!.args!.budgetUsd, 3);
  });

  it('returns nothing rather than a guessed number, and nothing for a non-budget code', () => {
    assert.equal(blockageFromLegacyMessage({ code: 'budget_exceeded', message: 'stopped on budget' }), undefined);
    assert.equal(blockageFromLegacyMessage({ code: 'model_error', message: REAL_MESSAGE }), undefined);
  });

  it('offers only the default raise when there is no run to scope one to', () => {
    const blockage = blockageFromLegacyMessage({ code: 'budget_exceeded', message: REAL_MESSAGE, nodeId: 'n' })!;
    assert.deepEqual(blockage.remedies.map((remedy) => remedy.id), ['raise_budget_default', 'cancel']);
  });

  it('namespaces its id so a legacy resolution can never collide with an engine-minted one', () => {
    const blockage = blockageFromLegacyMessage({ code: 'budget_exceeded', message: REAL_MESSAGE, runId: 'run_1', nodeId: 'n' })!;
    assert.match(blockage.blockage_id, /^blk_legacy_/);
  });
});

describe('resolveBlockage', () => {
  it('prefers the engines blockage and only reconstructs when there is none', () => {
    const engine = budgetBlockage();
    const legacy = { code: 'budget_exceeded', message: REAL_MESSAGE, runId: 'run_1', nodeId: 'n' };
    assert.equal(resolveBlockage(engine, legacy), engine);
    assert.match(resolveBlockage(undefined, legacy)!.blockage_id, /^blk_legacy_/);
    assert.equal(resolveBlockage(undefined, undefined), undefined);
  });
});
