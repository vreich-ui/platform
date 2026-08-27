import { describe, it } from 'node:test';
import assert from 'node:assert';

import {
  bulkArchiveObjects,
  bulkValidateObjects,
  type BulkTargetRow,
  type VerbCaller,
  type VerbResult,
} from './bulk-object-ops.js';

const rows: BulkTargetRow[] = [
  { object_id: 'p1', object_type: 'page' },
  { object_id: 'p2', object_type: 'page' },
  { object_id: 'p3', object_type: 'page' },
];

/** Builds a fake verb caller from a map of action -> (call) => VerbResult, recording every call. */
function fakeVerbs(handlers: Record<string, (body: Record<string, unknown>) => VerbResult>): {
  callVerb: VerbCaller;
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const callVerb: VerbCaller = async (body) => {
    calls.push(body);
    const handler = handlers[body.action as string];
    if (!handler) throw new Error(`no handler for action ${String(body.action)}`);
    return handler(body);
  };
  return { callVerb, calls };
}

describe('bulkArchiveObjects', () => {
  it('checks out then retires every row, end to end, all succeeding', async () => {
    const { callVerb, calls } = fakeVerbs({
      checkout: (body) => ({ status: 200, body: { lockToken: `tok-${body.object_id}` } }),
      retire: () => ({ status: 200, body: { retired: true } }),
    });
    const summary = await bulkArchiveObjects(rows, callVerb);
    assert.deepStrictEqual(summary.succeeded.sort(), ['p1', 'p2', 'p3']);
    assert.deepStrictEqual(summary.failed, []);
    // Every row: one checkout, one retire — no stray checkin on the happy path.
    assert.strictEqual(calls.filter((c) => c.action === 'checkout').length, 3);
    assert.strictEqual(calls.filter((c) => c.action === 'retire').length, 3);
    assert.strictEqual(calls.filter((c) => c.action === 'checkin').length, 0);
    // The lock token from checkout is threaded into retire's lock_token.
    const retireCalls = calls.filter((c) => c.action === 'retire');
    for (const call of retireCalls) {
      assert.strictEqual(call.lock_token, `tok-${call.object_id}`);
    }
  });

  it('reports a locked row as failed and never calls retire for it', async () => {
    const { callVerb, calls } = fakeVerbs({
      checkout: (body) =>
        body.object_id === 'p2'
          ? { status: 423, body: { error: 'Locked', locked: true } }
          : { status: 200, body: { lockToken: `tok-${body.object_id}` } },
      retire: () => ({ status: 200, body: { retired: true } }),
    });
    const summary = await bulkArchiveObjects(rows, callVerb);
    assert.deepStrictEqual(summary.succeeded.sort(), ['p1', 'p3']);
    assert.strictEqual(summary.failed.length, 1);
    assert.strictEqual(summary.failed[0]!.object_id, 'p2');
    assert.match(summary.failed[0]!.error!, /locked/i);
    assert.strictEqual(
      calls.some((c) => c.action === 'retire' && c.object_id === 'p2'),
      false
    );
  });

  it('releases the lock when retire is blocked (still referenced / open review)', async () => {
    const { callVerb, calls } = fakeVerbs({
      checkout: (body) => ({ status: 200, body: { lockToken: `tok-${body.object_id}` } }),
      retire: (body) =>
        body.object_id === 'p1'
          ? { status: 409, body: { error: 'Still referenced by nav_footer.' } }
          : { status: 200, body: { retired: true } },
      checkin: () => ({ status: 200, body: {} }),
    });
    const summary = await bulkArchiveObjects(rows, callVerb);
    assert.deepStrictEqual(summary.succeeded.sort(), ['p2', 'p3']);
    assert.strictEqual(summary.failed.length, 1);
    assert.strictEqual(summary.failed[0]!.object_id, 'p1');
    assert.match(summary.failed[0]!.error!, /referenced/i);
    // The lock taken for the blocked row was released.
    const checkin = calls.find((c) => c.action === 'checkin');
    assert.ok(checkin);
    assert.strictEqual(checkin!.object_id, 'p1');
    assert.strictEqual(checkin!.lock_token, 'tok-p1');
  });

  it('is idempotent-friendly: an empty selection resolves with nothing to report', async () => {
    const { callVerb, calls } = fakeVerbs({});
    const summary = await bulkArchiveObjects([], callVerb);
    assert.deepStrictEqual(summary, { succeeded: [], failed: [] });
    assert.strictEqual(calls.length, 0);
  });

  it('respects a concurrency cap (never more than N calls unresolved at once)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const many: BulkTargetRow[] = Array.from({ length: 9 }, (_, i) => ({ object_id: `o${i}`, object_type: 'page' }));
    const callVerb: VerbCaller = async (body) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      if (body.action === 'checkout') return { status: 200, body: { lockToken: `tok-${body.object_id}` } };
      return { status: 200, body: { retired: true } };
    };
    await bulkArchiveObjects(many, callVerb, { concurrency: 2 });
    assert.ok(maxInFlight <= 2, `expected max 2 in flight, saw ${maxInFlight}`);
  });
});

describe('bulkValidateObjects', () => {
  it('summarizes ready/warning/blocked counts across the selection', async () => {
    const { callVerb } = fakeVerbs({
      validate: (body) => {
        if (body.object_id === 'p1')
          return { status: 200, body: { summary: { level: 'ready', eligible: true, blockers: [], warnings: [] } } };
        if (body.object_id === 'p2')
          return {
            status: 200,
            body: { summary: { level: 'warning', eligible: true, blockers: [], warnings: [{ id: 'x' }] } },
          };
        return {
          status: 200,
          body: { summary: { level: 'missing', eligible: false, blockers: [{ id: 'y' }], warnings: [] } },
        };
      },
    });
    const summary = await bulkValidateObjects(rows, callVerb);
    assert.strictEqual(summary.readyCount, 1);
    assert.strictEqual(summary.warningCount, 1);
    assert.strictEqual(summary.blockedCount, 1);
    assert.strictEqual(summary.requestFailedCount, 0);
    const p3 = summary.results.find((r) => r.object_id === 'p3')!;
    assert.strictEqual(p3.blockerCount, 1);
  });

  it('counts a request failure separately from a validation-level failure', async () => {
    const { callVerb } = fakeVerbs({
      validate: (body) =>
        body.object_id === 'p1'
          ? { status: 404, body: { error: 'Object record not found' } }
          : { status: 200, body: { summary: { level: 'ready', eligible: true, blockers: [], warnings: [] } } },
    });
    const summary = await bulkValidateObjects(rows, callVerb);
    assert.strictEqual(summary.requestFailedCount, 1);
    assert.strictEqual(summary.readyCount, 2);
  });
});
