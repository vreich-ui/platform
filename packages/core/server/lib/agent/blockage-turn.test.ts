import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { blockageFromToolResult } from './blockage-turn.js';

// W3.3 — until this existed, only a PAGE button could put a wall in a chat
// transcript: a chat-driven run that stopped on a budget left the human the
// error text and nothing to press. A tool result is a JSON STRING, so this is
// the one place that parses rather than reads a field.

const BLOCKAGE = {
  blockage_id: 'blk_1',
  contract: 'blockage.v1',
  code: 'budget_exceeded',
  kind: 'budget',
  message: 'stopped on budget',
  remedies: [{ id: 'raise_budget_run', type: 'raise_node_budget', args: { scope: 'run', budgetUsd: 4.5 }, default: true }],
  scope: { node_id: 'article_body', run_id: 'run_9' },
};

describe('blockageFromToolResult', () => {
  it('reads a blockage off a FAILED call’s error envelope', () => {
    const content = JSON.stringify({ ok: false, error: { code: 'budget_exceeded', message: 'x', blockage: BLOCKAGE } });
    assert.deepEqual(blockageFromToolResult(content, true), BLOCKAGE);
  });

  it('ignores that same envelope when the call did NOT fail', () => {
    // A successful read that happens to quote an error should not raise a wall
    // in the conversation.
    const content = JSON.stringify({ ok: true, error: { blockage: BLOCKAGE } });
    assert.equal(blockageFromToolResult(content, false), undefined);
  });

  it('reads the first pending wall off a run record a successful read returned', () => {
    const content = JSON.stringify({ ok: true, data: { run: { runId: 'run_9', blockages: [BLOCKAGE] } } });
    assert.deepEqual(blockageFromToolResult(content, false), BLOCKAGE);
  });

  it('costs nothing for the overwhelming majority of results', () => {
    assert.equal(blockageFromToolResult('', false), undefined);
    assert.equal(blockageFromToolResult('not json at all', false), undefined);
    assert.equal(blockageFromToolResult('"a string"', false), undefined);
    assert.equal(blockageFromToolResult(JSON.stringify({ ok: true, data: { objects: [] } }), false), undefined);
    assert.equal(blockageFromToolResult(JSON.stringify({ ok: true, data: { run: { blockages: [] } } }), false), undefined);
  });

  it('drops a malformed or hostile blockage rather than rendering a dead button', () => {
    const content = JSON.stringify({ error: { blockage: { code: 'budget_exceeded', remedies: [{ id: 'x', type: 'wire_money' }] } } });
    assert.equal(blockageFromToolResult(content, true), undefined);
  });

  it('does not parse an absurdly large result', () => {
    assert.equal(blockageFromToolResult(JSON.stringify({ pad: 'x'.repeat(300_000) }), true), undefined);
  });
});
