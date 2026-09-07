import { describe, it } from 'node:test';
import assert from 'node:assert';

import { bulkDeleteArtifacts, bulkRetagArtifacts, type DeleteArtifactFn, type RetagArtifactFn } from './bulk-artifact-ops.js';

describe('bulkDeleteArtifacts', () => {
  it('deletes every id, all succeeding', async () => {
    const calls: string[] = [];
    const deleteFn: DeleteArtifactFn = async (id) => {
      calls.push(id);
      return { id, deleted: true };
    };
    const summary = await bulkDeleteArtifacts(['a1', 'a2', 'a3'], deleteFn);
    assert.deepStrictEqual(summary.ok.sort(), ['a1', 'a2', 'a3']);
    assert.deepStrictEqual(summary.failed, []);
    assert.deepStrictEqual(calls.sort(), ['a1', 'a2', 'a3']);
  });

  it('aggregates a partial failure into `failed` with a reason, rather than throwing', async () => {
    const deleteFn: DeleteArtifactFn = async (id) => {
      if (id === 'a2') throw new Error('Still referenced by page:home.');
      return { id, deleted: true };
    };
    const summary = await bulkDeleteArtifacts(['a1', 'a2', 'a3'], deleteFn);
    assert.deepStrictEqual(summary.ok.sort(), ['a1', 'a3']);
    assert.strictEqual(summary.failed.length, 1);
    assert.strictEqual(summary.failed[0]!.id, 'a2');
    assert.match(summary.failed[0]!.reason!, /referenced/i);
  });

  it('falls back to a generic reason when the failure is not an Error', async () => {
    const deleteFn: DeleteArtifactFn = async (id) => {
      if (id === 'a1') throw 'nope';
      return { id, deleted: true };
    };
    const summary = await bulkDeleteArtifacts(['a1'], deleteFn);
    assert.strictEqual(summary.failed.length, 1);
    assert.strictEqual(summary.failed[0]!.reason, 'nope');
  });

  it('is a no-op on an empty selection: no calls, empty summary, resolves immediately', async () => {
    let called = false;
    const deleteFn: DeleteArtifactFn = async (id) => {
      called = true;
      return { id, deleted: true };
    };
    const summary = await bulkDeleteArtifacts([], deleteFn);
    assert.deepStrictEqual(summary, { ok: [], failed: [] });
    assert.strictEqual(called, false);
  });

  it('respects a concurrency cap (never more than N calls unresolved at once)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ids = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const deleteFn: DeleteArtifactFn = async (id) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { id, deleted: true };
    };
    const summary = await bulkDeleteArtifacts(ids, deleteFn, { concurrency: 2 });
    assert.ok(maxInFlight <= 2, `expected max 2 in flight, saw ${maxInFlight}`);
    assert.strictEqual(summary.ok.length, 9);
  });

  it('defaults to the standard pool bound (3) when concurrency is not specified', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ids = Array.from({ length: 12 }, (_, i) => `a${i}`);
    const deleteFn: DeleteArtifactFn = async (id) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { id, deleted: true };
    };
    await bulkDeleteArtifacts(ids, deleteFn);
    assert.ok(maxInFlight <= 3, `expected max 3 in flight, saw ${maxInFlight}`);
    assert.ok(maxInFlight > 0);
  });
});

describe('bulkRetagArtifacts', () => {
  it('applies the same add/remove delta to every id, all succeeding', async () => {
    const calls: Array<{ id: string; add: string[]; remove: string[] }> = [];
    const retagFn: RetagArtifactFn = async (id, add, remove) => {
      calls.push({ id, add, remove });
      return { id, tags: add };
    };
    const summary = await bulkRetagArtifacts(['a1', 'a2'], ['featured'], ['draft'], retagFn);
    assert.deepStrictEqual(summary.ok.sort(), ['a1', 'a2']);
    assert.deepStrictEqual(summary.failed, []);
    assert.strictEqual(calls.length, 2);
    for (const call of calls) {
      assert.deepStrictEqual(call.add, ['featured']);
      assert.deepStrictEqual(call.remove, ['draft']);
    }
  });

  it('aggregates a partial failure into `failed` with a reason, rather than throwing', async () => {
    const retagFn: RetagArtifactFn = async (id) => {
      if (id === 'a2') throw new Error('Artifact not found.');
      return { id, tags: [] };
    };
    const summary = await bulkRetagArtifacts(['a1', 'a2', 'a3'], ['x'], [], retagFn);
    assert.deepStrictEqual(summary.ok.sort(), ['a1', 'a3']);
    assert.strictEqual(summary.failed.length, 1);
    assert.strictEqual(summary.failed[0]!.id, 'a2');
    assert.match(summary.failed[0]!.reason!, /not found/i);
  });

  it('is a no-op on an empty selection: no calls, empty summary', async () => {
    let called = false;
    const retagFn: RetagArtifactFn = async (id) => {
      called = true;
      return { id, tags: [] };
    };
    const summary = await bulkRetagArtifacts([], ['x'], [], retagFn);
    assert.deepStrictEqual(summary, { ok: [], failed: [] });
    assert.strictEqual(called, false);
  });

  it('respects a concurrency cap (never more than N calls unresolved at once)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const ids = Array.from({ length: 9 }, (_, i) => `a${i}`);
    const retagFn: RetagArtifactFn = async (id) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 1));
      inFlight -= 1;
      return { id, tags: [] };
    };
    await bulkRetagArtifacts(ids, ['x'], [], retagFn, { concurrency: 2 });
    assert.ok(maxInFlight <= 2, `expected max 2 in flight, saw ${maxInFlight}`);
  });
});
