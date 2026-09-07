import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Blockage } from '../../../lib/admin/blockage.js';
import {
  applyRemedy,
  createBlobRemedyLedger,
  MAX_SYNC_REMEDY_BUDGET_USD,
  mergeRemedyArgs,
  planSyncToolRemedy,
  remedyLedgerKey,
  type RemedyLedger,
  type RemedyRecord,
} from './remedy.js';

type Call = { tool: string; args: Record<string, unknown> };

const bridgeWith = (failures: Record<string, { code: string; message: string }> = {}) => {
  const calls: Call[] = [];
  return {
    calls,
    bridge: {
      async callTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>) {
        calls.push({ tool, args });
        const failure = failures[tool];
        return failure ? ({ ok: false as const, ...failure }) : ({ ok: true as const, data: {} as T });
      },
    },
  };
};

const memoryLedger = () => {
  const records = new Map<string, RemedyRecord>();
  const ledger: RemedyLedger = {
    async get(id) { return records.get(id); },
    async put(id, record) { records.set(id, record); },
    async remove(id) { records.delete(id); },
  };
  return { ledger, records };
};

/**
 * D8 is enforced INSIDE applyRemedy now (a disabled button defends nothing), so
 * every test that is not about the role gate has to say who is asking. Owner is
 * the interesting default: it is the caller for whom the remedies actually run.
 */
const OWNER = { isOwner: true, email: 'wolf@example.com' };

const blockage = (overrides: Partial<Blockage> = {}): Blockage => ({
  blockage_id: 'blk_abc',
  code: 'budget_exceeded',
  kind: 'budget',
  message: 'stopped on budget',
  remedies: [
    { id: 'raise_budget_attempt', type: 'raise_node_budget', args: { scope: 'attempt', budgetUsd: 1.5 }, default: true },
    { id: 'raise_budget_run', type: 'raise_node_budget', args: { scope: 'run', budgetUsd: 1.5 } },
    { id: 'raise_budget_default', type: 'raise_node_budget', args: { scope: 'default', budgetUsd: 1.5 } },
    { id: 'cancel', type: 'cancel' },
  ],
  scope: { node_id: 'brand_imagery_writer', run_id: 'run_9' },
  ...overrides,
});

describe('applyRemedy — budget', () => {
  it('writes the per-run override, THEN retries — never the other way round', async () => {
    const { bridge, calls } = bridgeWith();
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' }, undefined, undefined, OWNER);

    assert.equal(outcome.status, 'applied');
    assert.deepEqual(calls.map((call) => call.tool), ['workflow_set_node_budget_override', 'workflow_retry_node']);
    assert.deepEqual(calls[0]!.args, { runId: 'run_9', nodeId: 'brand_imagery_writer', budgetUsd: 1.5 });
  });

  it('writes the node default for a default-scoped raise', async () => {
    const { bridge, calls } = bridgeWith();
    await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_default' }, undefined, undefined, OWNER);
    assert.equal(calls[0]!.tool, 'workspace_update_node_model_config');
    assert.deepEqual(calls[0]!.args, { id: 'brand_imagery_writer', patch: { modelConfig: { budgetUsd: 1.5 } } });
  });

  it('does not retry a default raise when there is no run — a sync-tool blockage has none', async () => {
    const { bridge, calls } = bridgeWith();
    const outcome = await applyRemedy(bridge, blockage({ scope: { node_id: 'brand_imagery_writer' } }), { remedy_id: 'raise_budget_default' }, undefined, undefined, OWNER);
    assert.equal(outcome.status, 'applied');
    assert.deepEqual(calls.map((call) => call.tool), ['workspace_update_node_model_config']);
  });

  it('hands an attempt-scoped raise BACK to the caller — and does NOT report it as done', async () => {
    // The `ok: false` is the whole point. This branch used to return `ok: true`
    // with nothing applied, and the chat handler — which only checked `ok` —
    // cleared the pending blockage and told the human it was resolved. No
    // raise, no re-run, and the card gone from the one surface showing it.
    const { bridge, calls } = bridgeWith();
    const { ledger, records } = memoryLedger();
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_attempt' }, ledger, undefined, OWNER);
    assert.equal(outcome.status, 'caller_action');
    assert.equal(outcome.ok, false);
    assert.equal(outcome.code, 'rerun_required');
    assert.deepEqual(outcome.rerunWith, { budgetUsd: 1.5 });
    assert.deepEqual(calls, []);
    assert.equal(records.size, 0, 'nothing happened, so nothing is ledgered');
  });

  it('stops after a failed write and never retries under the old ceiling', async () => {
    const { bridge, calls } = bridgeWith({ workflow_set_node_budget_override: { code: 'forbidden', message: 'nope' } });
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' }, undefined, undefined, OWNER);
    assert.equal(outcome.status, 'failed');
    assert.equal(outcome.failedTool, 'workflow_set_node_budget_override');
    assert.deepEqual(calls.map((call) => call.tool), ['workflow_set_node_budget_override']);
  });

  it('refuses a raise with no amount rather than calling with NaN', async () => {
    const { bridge, calls } = bridgeWith();
    const noAmount = blockage({ remedies: [{ id: 'raise', type: 'raise_node_budget', args: { scope: 'run' } }] });
    const outcome = await applyRemedy(bridge, noAmount, { remedy_id: 'raise' }, undefined, undefined, OWNER);
    assert.equal(outcome.code, 'invalid_budget');
    assert.deepEqual(calls, []);
  });
});

describe('applyRemedy — D4 idempotency', () => {
  it('applies once; the second post of the same blockage_id spends nothing', async () => {
    const { bridge, calls } = bridgeWith();
    const { ledger } = memoryLedger();

    const first = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run', by: 'wolf@example.com' }, ledger, undefined, OWNER);
    const second = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' }, ledger, undefined, OWNER);

    assert.equal(first.status, 'applied');
    assert.equal(second.status, 'already_resolved');
    assert.equal(second.ok, true, 'a second click is not an error — the wall really is resolved');
    assert.equal(calls.length, 2, 'the bridge saw exactly one write + one retry');
    assert.equal(second.record?.by, 'wolf@example.com');
  });

  it('blocks a DIFFERENT remedy on the same wall too — two remedies are still two spends', async () => {
    const { bridge, calls } = bridgeWith();
    const { ledger } = memoryLedger();
    await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' }, ledger, undefined, OWNER);
    const second = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_default' }, ledger, undefined, OWNER);
    assert.equal(second.status, 'already_resolved');
    assert.equal(calls.length, 2);
  });

  it('releases its claim when the write fails — the operator must be able to try again', async () => {
    // The claim is written BEFORE the calls (that is what makes a concurrent
    // second click find it), so a failed call has to clear it or the wall is
    // permanently unresolvable from every surface.
    const { bridge } = bridgeWith({ workflow_set_node_budget_override: { code: 'forbidden', message: 'nope' } });
    const { ledger } = memoryLedger();
    await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' }, ledger, undefined, OWNER);
    assert.equal(await ledger.get('blk_abc'), undefined, 'the released claim reads as absent');
  });

  it('claims BEFORE it calls, so a concurrent second request finds the claim', async () => {
    const { bridge, calls } = bridgeWith();
    const { ledger } = memoryLedger();
    let observedDuringCall: unknown;
    const watching = {
      async callTool<T = Record<string, unknown>>(tool: string, args: Record<string, unknown>) {
        observedDuringCall = await ledger.get('blk_abc');
        return bridge.callTool<T>(tool, args);
      },
    };
    await applyRemedy(watching, blockage(), { remedy_id: 'raise_budget_run' }, ledger, undefined, OWNER);
    assert.ok(observedDuringCall, 'the claim was already in the ledger while the first tool call ran');
    assert.equal(calls.length, 2);
  });

  it('does not ledger a dismissal — dismissing is "later", not "done"', async () => {
    const { bridge } = bridgeWith();
    const { ledger, records } = memoryLedger();
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'cancel' }, ledger, undefined, OWNER);
    assert.equal(outcome.status, 'caller_action');
    assert.equal(outcome.ok, false, 'a dismissal did not resolve anything');
    assert.equal(records.size, 0);
  });
});

describe('applyRemedy — the rest of the table', () => {
  const gate = blockage({
    code: 'approval_required', kind: 'approval',
    remedies: [{ id: 'approve', type: 'approve_gate', default: true }, { id: 'decline', type: 'decline_gate' }],
    scope: { node_id: 'publish_executor', run_id: 'run_9', gate_id: 'editorial.publish' },
  });

  it('approves and then advances the run', async () => {
    const { bridge, calls } = bridgeWith();
    const outcome = await applyRemedy(bridge, gate, { remedy_id: 'approve' }, undefined, undefined, OWNER);
    assert.equal(outcome.status, 'applied');
    assert.deepEqual(calls.map((call) => call.tool), ['workflow_set_operator_publish_decision', 'workflow_run_all']);
    assert.deepEqual(calls[0]!.args, { runId: 'run_9', decision: 'approved' });
  });

  it('declines WITHOUT advancing — advancing a withheld run is the opposite of the button', async () => {
    const { bridge, calls } = bridgeWith();
    await applyRemedy(bridge, gate, { remedy_id: 'decline' }, undefined, undefined, OWNER);
    assert.deepEqual(calls.map((call) => call.tool), ['workflow_set_operator_publish_decision']);
    assert.equal(calls[0]!.args.decision, 'withheld');
  });

  it('treats a failed advance as applied-with-a-note: the approval itself is durable', async () => {
    const { bridge } = bridgeWith({ workflow_run_all: { code: 'driver_busy', message: 'try later' } });
    const outcome = await applyRemedy(bridge, gate, { remedy_id: 'approve' }, undefined, undefined, OWNER);
    assert.equal(outcome.status, 'applied');
    assert.equal(outcome.code, 'driver_busy');
  });

  it('raises a named limit and retries', async () => {
    const { bridge, calls } = bridgeWith();
    const limit = blockage({ code: 'max_turns_exceeded', kind: 'limit', remedies: [{ id: 'raise_max_turns', type: 'raise_limit', args: { field: 'maxTurns', value: 12 } }] });
    await applyRemedy(bridge, limit, { remedy_id: 'raise_max_turns' }, undefined, undefined, OWNER);
    assert.deepEqual(calls[0]!.args, { id: 'brand_imagery_writer', patch: { modelConfig: { maxTurns: 12 } } });
    assert.equal(calls[1]!.tool, 'workflow_retry_node');
  });

  it('refuses a limit field that is not one of the three', async () => {
    const { bridge, calls } = bridgeWith();
    const limit = blockage({ remedies: [{ id: 'raise', type: 'raise_limit', args: { field: 'temperature', value: 2 } }] });
    assert.equal((await applyRemedy(bridge, limit, { remedy_id: 'raise' }, undefined, undefined, OWNER)).code, 'invalid_limit');
    assert.deepEqual(calls, []);
  });

  it('retries and resumes through their own tools', async () => {
    const { bridge, calls } = bridgeWith();
    await applyRemedy(bridge, blockage({ remedies: [{ id: 'retry', type: 'retry' }] }), { remedy_id: 'retry' }, undefined, undefined, OWNER);
    await applyRemedy(bridge, blockage({ remedies: [{ id: 'resume', type: 'resume' }] }), { remedy_id: 'resume' }, undefined, undefined, OWNER);
    assert.deepEqual(calls.map((call) => call.tool), ['workflow_retry_node', 'workflow_resume_run']);
  });

  it('says plainly that a run-budget raise has no setter, rather than pretending it worked', async () => {
    const { bridge, calls } = bridgeWith();
    const runBudget = blockage({ remedies: [{ id: 'raise_run_budget', type: 'raise_run_budget', args: { budgetUsd: 5 } }] });
    const outcome = await applyRemedy(bridge, runBudget, { remedy_id: 'raise_run_budget' }, undefined, undefined, OWNER);
    assert.equal(outcome.status, 'unsupported');
    assert.equal(outcome.ok, false);
    assert.deepEqual(calls, []);
  });

  it('refuses a remedy_id this blockage never offered', async () => {
    const { bridge, calls } = bridgeWith();
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'delete_everything' }, undefined, undefined, OWNER);
    assert.equal(outcome.code, 'unknown_remedy');
    assert.deepEqual(calls, []);
  });
});

describe('mergeRemedyArgs — what a human may override', () => {
  it('takes a typed amount', () => {
    const remedy = { id: 'r', type: 'raise_node_budget' as const, args: { scope: 'attempt', budgetUsd: 1.5 } };
    assert.deepEqual(mergeRemedyArgs(remedy, { budgetUsd: 2 }), { scope: 'attempt', budgetUsd: 2 });
  });

  it('ignores every field that would re-target the remedy', () => {
    // "raise it to $2" must not be able to become a permanent default raise on
    // another node in another run.
    const remedy = { id: 'r', type: 'raise_node_budget' as const, args: { scope: 'attempt', budgetUsd: 1.5, nodeId: 'a', runId: 'r1' } };
    assert.deepEqual(
      mergeRemedyArgs(remedy, { budgetUsd: 2, scope: 'default', nodeId: 'other', runId: 'r2' }),
      { scope: 'attempt', budgetUsd: 2, nodeId: 'a', runId: 'r1' }
    );
  });

  it('ignores a non-numeric amount', () => {
    const remedy = { id: 'r', type: 'raise_node_budget' as const, args: { budgetUsd: 1.5 } };
    assert.deepEqual(mergeRemedyArgs(remedy, { budgetUsd: 'lots' }), { budgetUsd: 1.5 });
  });
});

describe('the blob-backed ledger', () => {
  const record: RemedyRecord = { blockage_id: 'blk_abc', remedy_id: 'r', remedy_type: 'retry', resolved_at: '2026-09-07T10:00:00.000Z', calls: [] };

  it('round-trips a fresh record', async () => {
    const store = new Map<string, unknown>();
    const ledger = createBlobRemedyLedger(
      { async get(key) { return store.get(key) ?? null; }, async setJSON(key, value) { store.set(key, value); return undefined; } },
      () => new Date('2026-09-07T11:00:00.000Z')
    );
    await ledger.put('blk_abc', record);
    assert.equal(store.has(remedyLedgerKey('blk_abc')), true);
    assert.deepEqual(await ledger.get('blk_abc'), record);
  });

  it('treats a record older than the TTL as absent', async () => {
    const ledger = createBlobRemedyLedger(
      { async get() { return record; }, async setJSON() { return undefined; } },
      () => new Date('2026-09-09T11:00:00.000Z')
    );
    assert.equal(await ledger.get('blk_abc'), undefined);
  });

  it('never blocks a resolution because the store threw', async () => {
    const ledger = createBlobRemedyLedger({
      async get() { throw new Error('blobs down'); },
      async setJSON() { throw new Error('blobs down'); },
    });
    assert.equal(await ledger.get('blk_abc'), undefined);
    await ledger.put('blk_abc', record);
  });
});

describe('planSyncToolRemedy — D8 role gating on the synchronous path', () => {
  const attempt = { blockage_id: 'blk_a', remedy_id: 'raise_budget_attempt', scope: 'attempt' as const, budget_usd: 1.5 };
  const asDefault = { ...attempt, remedy_id: 'raise_budget_default', scope: 'default' as const };

  it('lets an EDITOR raise for one attempt — it spends one call and stores nothing', () => {
    const plan = planSyncToolRemedy(attempt, 'brand_imagery_writer', { isOwner: false });
    assert.deepEqual(plan, { ok: true, modelConfigOverride: { budgetUsd: 1.5 } });
  });

  it('refuses an editor the DEFAULT raise, and says what they can do instead', () => {
    const plan = planSyncToolRemedy(asDefault, 'brand_imagery_writer', { isOwner: false });
    assert.equal(plan?.ok, false);
    assert.equal(plan!.ok === false && plan!.status, 403);
    assert.match(plan!.ok === false ? plan!.error : '', /for this attempt instead/);
  });

  it('writes the node default BEFORE the re-propose when an Owner asks for it', () => {
    const plan = planSyncToolRemedy(asDefault, 'brand_imagery_writer', { isOwner: true });
    assert.equal(plan!.ok, true);
    assert.deepEqual(plan!.ok === true ? plan!.configWrite : undefined, {
      tool: 'workspace_update_node_model_config',
      args: { id: 'brand_imagery_writer', patch: { modelConfig: { budgetUsd: 1.5 } } },
    });
    // …and the re-propose still carries the one-shot ceiling: the workspace
    // write may not be visible to the node resolver within this same request.
    assert.deepEqual(plan!.ok === true ? plan!.modelConfigOverride : undefined, { budgetUsd: 1.5 });
  });

  it('refuses an amount outside the range the tool schema accepts', () => {
    for (const amount of [0, -1, Number.NaN, MAX_SYNC_REMEDY_BUDGET_USD + 1]) {
      const plan = planSyncToolRemedy({ ...attempt, budget_usd: amount }, 'n', { isOwner: true });
      assert.equal(plan?.ok, false, `expected ${amount} to be refused`);
      assert.equal(plan!.ok === false && plan!.status, 400);
    }
  });

  it('is undefined for an ordinary propose, so the normal path is untouched', () => {
    assert.equal(planSyncToolRemedy(undefined, 'n', { isOwner: true }), undefined);
  });
});


describe('applyRemedy — D8 is enforced at the WRITE, not at the button', () => {
  // `remedyButtons`'s OWNER_ONLY set greys a button out. That is a rendering
  // decision and defends nothing: every caller of applyRemedy is an endpoint a
  // human can POST to directly.
  const NON_OWNER = { isOwner: false, email: 'editor@example.com' };

  it('refuses an editor the raises and limits that change stored config', async () => {
    const { bridge, calls } = bridgeWith();
    for (const remedyId of ['raise_budget_run', 'raise_budget_default']) {
      const outcome = await applyRemedy(bridge, blockage(), { remedy_id: remedyId }, undefined, undefined, NON_OWNER);
      assert.equal(outcome.code, 'owner_required', remedyId);
      assert.equal(outcome.ok, false);
    }
    const limit = blockage({ remedies: [{ id: 'raise', type: 'raise_limit', args: { field: 'maxTurns', value: 12 } }] });
    assert.equal((await applyRemedy(bridge, limit, { remedy_id: 'raise' }, undefined, undefined, NON_OWNER)).code, 'owner_required');
    assert.deepEqual(calls, [], 'nothing reached the bridge');
  });

  it('still lets an editor approve a gate, retry and resume — none of those change config', async () => {
    const { bridge } = bridgeWith();
    const gate = blockage({ remedies: [{ id: 'approve', type: 'approve_gate' }], scope: { node_id: 'publish_executor', run_id: 'run_9' } });
    assert.equal((await applyRemedy(bridge, gate, { remedy_id: 'approve' }, undefined, undefined, NON_OWNER)).ok, true);
    const retry = blockage({ remedies: [{ id: 'retry', type: 'retry' }] });
    assert.equal((await applyRemedy(bridge, retry, { remedy_id: 'retry' }, undefined, undefined, NON_OWNER)).ok, true);
  });

  it('defaults to NOT an owner, so a caller that forgets to say gets the safe answer', async () => {
    const { bridge } = bridgeWith();
    assert.equal((await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_run' })).code, 'owner_required');
  });
});

describe('applyRemedy — a typed amount is bounded as well as re-targeted', () => {
  it('refuses an absurd amount even from an Owner', async () => {
    // `mergeRemedyArgs` stops a typed number changing the node/run/scope; this
    // stops it being $100,000 written into a node's stored default.
    const { bridge, calls } = bridgeWith();
    const outcome = await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_default', args: { budgetUsd: 100_000 } }, undefined, undefined, OWNER);
    assert.equal(outcome.code, 'invalid_budget');
    assert.deepEqual(calls, []);
  });

  it('accepts an ordinary deliberate raise', async () => {
    const { bridge, calls } = bridgeWith();
    await applyRemedy(bridge, blockage(), { remedy_id: 'raise_budget_default', args: { budgetUsd: 20 } }, undefined, undefined, OWNER);
    assert.deepEqual(calls[0]!.args, { id: 'brand_imagery_writer', patch: { modelConfig: { budgetUsd: 20 } } });
  });

  it('bounds a limit value the same way', async () => {
    const { bridge, calls } = bridgeWith();
    const limit = blockage({ remedies: [{ id: 'raise', type: 'raise_limit', args: { field: 'maxOutputTokens', value: 4000 } }] });
    assert.equal((await applyRemedy(bridge, limit, { remedy_id: 'raise', args: { value: 10_000_000 } }, undefined, undefined, OWNER)).code, 'invalid_limit');
    assert.deepEqual(calls, []);
  });
});
