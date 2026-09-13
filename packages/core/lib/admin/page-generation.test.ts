/**
 * T1.1 — the shared page-generation `AbortSignal`: a fresh signal per
 * generation, the outgoing one aborted (and never itself), and `isAbortError`
 * recognising exactly what `fetch` throws when a `signal` aborts and nothing
 * else.
 *
 * Plus the generation's IDENTITY (`currentPageGeneration`), which
 * `admin-shell-client.ts` keys its coalescing to. The invariants it needs are
 * exactly two: the number is stable for as long as one page generation lasts,
 * and a spent one is never reissued — a module comparing a stamped payload
 * against it must never be told "same navigation" about a different one.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  beginNewPageGeneration,
  currentPageGeneration,
  currentPageSignal,
  isAbortError,
  resetPageGenerationForTests,
} from './page-generation.js';

afterEach(() => {
  resetPageGenerationForTests();
});

describe('page-generation', () => {
  it('starts with a fresh, unaborted signal', () => {
    const signal = currentPageSignal();
    assert.equal(signal.aborted, false);
  });

  it('aborts the outgoing signal and mints a new, unaborted one', () => {
    const outgoing = currentPageSignal();
    const next = beginNewPageGeneration();
    assert.equal(outgoing.aborted, true);
    assert.equal(next.aborted, false);
    assert.notEqual(next, outgoing);
    assert.equal(currentPageSignal(), next);
  });

  it('is safe to call twice in a row — the second call aborts an already-fresh signal, not the previous page’s', () => {
    const first = beginNewPageGeneration();
    const second = beginNewPageGeneration();
    assert.equal(first.aborted, true);
    assert.equal(second.aborted, false);
    assert.notEqual(first, second);
  });

  it('a fetch aborted by the current signal rejects with the error isAbortError recognises', async () => {
    const signal = currentPageSignal();
    const fetchPromise = new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
    });
    beginNewPageGeneration();
    await assert.rejects(fetchPromise, (err: unknown) => {
      assert.equal(isAbortError(err), true);
      return true;
    });
  });

  it('holds one identity for the whole generation, and a new one only when a generation begins', () => {
    const first = currentPageGeneration();
    assert.equal(currentPageGeneration(), first, 'stable while the page is — nothing else may move it');

    beginNewPageGeneration();
    const second = currentPageGeneration();
    assert.notEqual(second, first);
    assert.equal(currentPageGeneration(), second);
  });

  it('never reissues a spent generation, not even across a test reset', () => {
    // `admin-shell-client.ts` decides "is this payload THIS navigation's?" by
    // comparing a stamped number against this one. A reissued value would
    // answer yes about a different page — the whole failure the stamp exists
    // to rule out, back with a harder-to-see cause.
    const seen = new Set<number>([currentPageGeneration()]);
    beginNewPageGeneration();
    seen.add(currentPageGeneration());
    beginNewPageGeneration();
    seen.add(currentPageGeneration());
    resetPageGenerationForTests();
    seen.add(currentPageGeneration());
    assert.equal(seen.size, 4, 'four generations, four distinct identities');
  });

  it('does not mistake an ordinary error for an abort', () => {
    assert.equal(isAbortError(new Error('boom')), false);
    assert.equal(isAbortError(new TypeError('network error')), false);
    assert.equal(isAbortError('AbortError'), false);
    assert.equal(isAbortError(null), false);
  });
});
