/**
 * T1.1 — the shared page-generation `AbortSignal`: a fresh signal per
 * generation, the outgoing one aborted (and never itself), and `isAbortError`
 * recognising exactly what `fetch` throws when a `signal` aborts and nothing
 * else.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  beginNewPageGeneration,
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

  it('does not mistake an ordinary error for an abort', () => {
    assert.equal(isAbortError(new Error('boom')), false);
    assert.equal(isAbortError(new TypeError('network error')), false);
    assert.equal(isAbortError('AbortError'), false);
    assert.equal(isAbortError(null), false);
  });
});
