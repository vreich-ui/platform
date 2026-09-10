import assert from 'node:assert/strict';
import test from 'node:test';

import { describeArtifactPreviewError } from './artifact-preview-error.js';
import {
  createArtifactPreviewLoader,
  createConcurrencyQueue,
  createObjectUrlCache,
  fetchWithRetry,
  type Clock,
} from './artifact-preview-loader.js';

// ─── a fake clock: no real timers anywhere in this file ────────────────────

function createFakeClock() {
  let nextId = 1;
  const timers = new Map<number, () => void>();
  const clock: Clock = {
    setTimeout: (callback) => {
      const id = nextId++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout: (handle) => {
      timers.delete(handle as number);
    },
  };
  return { clock, timers };
}

/**
 * Drives `operation()` to completion against a fake clock: repeatedly fires
 * every currently-pending timer, then lets microtasks settle, until the
 * returned promise resolves/rejects (or `maxRounds` is exhausted — a bug
 * that leaves the promise hanging fails loudly instead of hanging forever).
 */
async function drive<T>(operation: () => Promise<T>, timers: Map<number, () => void>, maxRounds = 50): Promise<T> {
  const result = operation();
  let settled = false;
  result.then(
    () => (settled = true),
    () => (settled = true)
  );
  for (let round = 0; round < maxRounds && !settled; round += 1) {
    if (timers.size > 0) {
      const due = [...timers.values()];
      timers.clear();
      for (const callback of due) callback();
    }
    await Promise.resolve();
    await Promise.resolve();
  }
  return result;
}

const okResponse = (body = 'bytes') => new Response(new Blob([body]), { status: 200 });

// ─── retry + timeout ─────────────────────────────────────────────────────

test('fetchWithRetry succeeds on the first try', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return okResponse();
  }) as typeof fetch;

  const response = await drive(
    () => fetchWithRetry('https://example.test/preview', undefined, { fetchFn, clock, random: () => 0 }),
    timers
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 1);
});

test('fetchWithRetry succeeds on a later try after transient failures', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    if (calls < 3) return new Response('server error', { status: 503 });
    return okResponse();
  }) as typeof fetch;

  const response = await drive(
    () =>
      fetchWithRetry('https://example.test/preview', undefined, {
        fetchFn,
        clock,
        random: () => 0.5,
        policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 1000 },
      }),
    timers
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 3);
});

test('fetchWithRetry gives up after the bound and reports the failure', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response('server error', { status: 503 });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      drive(
        () =>
          fetchWithRetry('https://example.test/preview', undefined, {
            fetchFn,
            clock,
            random: () => 0.5,
            policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 1000 },
          }),
        timers
      ),
    /503/
  );
  assert.equal(calls, 3, 'spent every attempt before giving up');
});

test('a non-retryable status fails immediately without spending remaining attempts', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response('forbidden', { status: 403 });
  }) as typeof fetch;

  await assert.rejects(
    () =>
      drive(
        () =>
          fetchWithRetry('https://example.test/preview', undefined, {
            fetchFn,
            clock,
            random: () => 0.5,
            policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 1000 },
          }),
        timers
      ),
    /403/
  );
  assert.equal(calls, 1, 'a 403 cannot be retried into success, so only one attempt is spent');
});

/**
 * The JOIN the error copy got wrong (2026-09-07). `ArtifactStagePreview` used
 * to render one hardcoded message — "could not be loaded — even after
 * automatic retries. Try again, or check your connection." — for every
 * failure. For the case it was most often shown for (a 404: a mood-board
 * reference whose bytes were never stored) that was false twice over: no
 * retry was attempted, and no retry could ever succeed.
 *
 * `describeArtifactPreviewError` now decides the copy and whether a retry
 * control renders at all. Its own file pins the wording; this pins the thing
 * only THIS file can prove — that `canRetry` matches what `fetchWithRetry`
 * actually does with each status, so the two can never drift back apart.
 */
test('describeArtifactPreviewError.canRetry agrees with the attempts fetchWithRetry really spends', async () => {
  const policy = { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 1000 };

  const attemptsFor = async (status: number): Promise<number> => {
    const { clock, timers } = createFakeClock();
    let calls = 0;
    const fetchFn = (async () => {
      calls += 1;
      return new Response('', { status });
    }) as typeof fetch;
    await assert.rejects(() =>
      drive(
        () => fetchWithRetry('https://example.test/preview', undefined, { fetchFn, clock, random: () => 0.5, policy }),
        timers
      )
    );
    return calls;
  };

  // Permanent: one attempt spent, so the copy must not claim retries ran and
  // must not offer another.
  for (const status of [401, 403, 404, 409, 422]) {
    assert.equal(await attemptsFor(status), 1, `HTTP ${status} spends exactly one attempt`);
    assert.equal(describeArtifactPreviewError(status).canRetry, false, `HTTP ${status} must not offer a retry`);
    assert.doesNotMatch(
      describeArtifactPreviewError(status).message,
      /after automatic retries/i,
      `HTTP ${status} must not claim retries that never happened`
    );
  }

  // Retryable: every attempt really is spent, so the copy may honestly say so
  // and offer another.
  for (const status of [408, 429, 503]) {
    assert.equal(await attemptsFor(status), policy.maxAttempts, `HTTP ${status} spends every attempt`);
    assert.equal(describeArtifactPreviewError(status).canRetry, true, `HTTP ${status} may offer a retry`);
  }
});

test('fetchWithRetry: a hung request times out via the injected clock, and the timeout counts as a retryable failure', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = ((_url: string, init?: RequestInit) => {
    calls += 1;
    const attempt = calls;
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      if (attempt === 1) {
        // Never settles on its own — only the injected clock's abort can end it.
        signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')));
      } else {
        resolve(okResponse());
      }
    });
  }) as typeof fetch;

  const response = await drive(
    () =>
      fetchWithRetry('https://example.test/preview', undefined, {
        fetchFn,
        clock,
        random: () => 0,
        policy: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, timeoutMs: 50 },
      }),
    timers
  );

  assert.equal(response.status, 200);
  assert.equal(calls, 2, 'the first (timed-out) attempt plus one successful retry');
});

// ─── concurrency queue ───────────────────────────────────────────────────

test('createConcurrencyQueue never runs more than the bound at once, with many queued tasks', async () => {
  const limit = 4;
  const queue = createConcurrencyQueue(limit);
  const total = 12;
  let active = 0;
  let peak = 0;
  const started: number[] = [];
  const releasers: Array<() => void> = [];

  const results = Array.from({ length: total }, (_, index) =>
    queue.run(() => {
      active += 1;
      peak = Math.max(peak, active);
      started.push(index);
      return new Promise<number>((resolve) => {
        releasers.push(() => {
          active -= 1;
          resolve(index);
        });
      });
    })
  );

  // Scheduling is synchronous up to each task's own await point, so exactly
  // `limit` tasks have started the instant every `run` call has returned.
  assert.equal(started.length, limit);
  assert.equal(peak, limit);

  let resolved = 0;
  while (resolved < total) {
    const release = releasers.shift();
    assert.ok(release, 'expected a pending task to release');
    release();
    resolved += 1;
    // Let the queue's `.then` chain dispatch the next task (if any) and the
    // outer `results[index]` settle before checking the invariant again.
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(peak <= limit, `peak concurrency ${peak} exceeded the bound ${limit}`);
  }
  assert.equal(releasers.length, 0);
  assert.equal(active, 0);

  const values = await Promise.all(results);
  assert.deepEqual(
    [...values].sort((a, b) => a - b),
    Array.from({ length: total }, (_, index) => index)
  );
  assert.equal(started.length, total);
  assert.ok(peak <= limit);
});

// ─── object-URL cache: revoked exactly once ─────────────────────────────

test('createObjectUrlCache revokes a replaced or deleted URL exactly once, never on a repeat delete', () => {
  const revoked: string[] = [];
  const cache = createObjectUrlCache((url) => revoked.push(url));

  cache.set('blobA', 'blob:a1');
  assert.deepEqual(revoked, []);

  cache.set('blobA', 'blob:a2'); // replaced — the old one is revoked exactly once
  assert.deepEqual(revoked, ['blob:a1']);

  cache.delete('blobA');
  assert.deepEqual(revoked, ['blob:a1', 'blob:a2']);

  cache.delete('blobA'); // already gone — must not revoke again
  assert.deepEqual(revoked, ['blob:a1', 'blob:a2']);

  cache.set('blobB', 'blob:b1');
  cache.set('blobC', 'blob:c1');
  cache.clear();
  assert.deepEqual(revoked, ['blob:a1', 'blob:a2', 'blob:b1', 'blob:c1']);

  cache.clear(); // nothing left — must not revoke again
  assert.deepEqual(revoked, ['blob:a1', 'blob:a2', 'blob:b1', 'blob:c1']);
});

// ─── the composed loader: caching by key, no second fetch ───────────────

test('createArtifactPreviewLoader serves a second load for the same key without a second fetch, and a different key does fetch', async () => {
  let calls = 0;
  const fetchFn = (async (url: string) => {
    calls += 1;
    return okResponse(`bytes-for-${url}`);
  }) as typeof fetch;
  let objectUrlCounter = 0;
  const loader = createArtifactPreviewLoader({
    fetchFn,
    createObjectUrl: () => `blob:fake-${(objectUrlCounter += 1)}`,
    revokeObjectUrl: () => {},
  });

  const first = await loader.load('blobKeyA', 'https://example.test/a');
  const second = await loader.load('blobKeyA', 'https://example.test/a');
  assert.equal(calls, 1, 'the same blobKey must not be fetched twice');
  assert.equal(first, second);

  const third = await loader.load('blobKeyB', 'https://example.test/b');
  assert.equal(calls, 2, 'a different blobKey must fetch');
  assert.notEqual(third, first);
});

test('createArtifactPreviewLoader.dispose revokes every cached object URL exactly once', async () => {
  const revoked: string[] = [];
  let objectUrlCounter = 0;
  const fetchFn = (async () => okResponse()) as typeof fetch;
  const loader = createArtifactPreviewLoader({
    fetchFn,
    createObjectUrl: () => `blob:fake-${(objectUrlCounter += 1)}`,
    revokeObjectUrl: (url) => revoked.push(url),
  });

  await loader.load('blobKeyA', 'https://example.test/a');
  await loader.load('blobKeyB', 'https://example.test/b');

  loader.dispose();
  assert.equal(revoked.length, 2);
  assert.deepEqual(new Set(revoked), new Set(['blob:fake-1', 'blob:fake-2']));

  loader.dispose(); // already empty — must not revoke again
  assert.equal(revoked.length, 2);
});

test('createArtifactPreviewLoader never caches a failed load, so the next call retries fresh', async () => {
  const { clock, timers } = createFakeClock();
  let calls = 0;
  const fetchFn = (async () => {
    calls += 1;
    return new Response('server error', { status: 503 });
  }) as typeof fetch;
  const loader = createArtifactPreviewLoader({
    fetchFn,
    clock,
    random: () => 0,
    policy: { maxAttempts: 2, baseDelayMs: 5, maxDelayMs: 20, timeoutMs: 100 },
    createObjectUrl: () => 'blob:unused',
    revokeObjectUrl: () => {},
  });

  await assert.rejects(() => drive(() => loader.load('blobKeyA', 'https://example.test/a'), timers));
  assert.equal(calls, 2);

  await assert.rejects(() => drive(() => loader.load('blobKeyA', 'https://example.test/a'), timers));
  assert.equal(calls, 4, 'a fresh call after a failure retries from scratch rather than reusing a cached failure');
});

// ─── T1.1: per-caller cancellation via `signal`, reference-counted ─────────

/** A fetch that never resolves on its own — only ever settles via the request's own `signal` aborting. */
function makeAbortTrackingFetch() {
  const counts = { aborts: 0, calls: 0 };
  const fetchFn = ((_url: string, init?: RequestInit) => {
    counts.calls += 1;
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      const onAbort = () => {
        counts.aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  return { fetchFn, counts };
}

/** A fetch that settles only when the test explicitly calls `resolve()` — lets a test prove a fetch stayed ALIVE across an abort. */
function makeControllableFetch() {
  const counts = { aborts: 0, calls: 0 };
  let settle: ((response: Response) => void) | undefined;
  const fetchFn = ((_url: string, init?: RequestInit) => {
    counts.calls += 1;
    return new Promise<Response>((resolve, reject) => {
      settle = resolve;
      const signal = init?.signal;
      const onAbort = () => {
        counts.aborts += 1;
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }) as typeof fetch;
  return { fetchFn, counts, resolve: () => settle?.(okResponse()) };
}

test('createArtifactPreviewLoader.load cancels the underlying fetch when its sole caller aborts', async () => {
  const { fetchFn, counts } = makeAbortTrackingFetch();
  const loader = createArtifactPreviewLoader({ fetchFn, createObjectUrl: () => 'blob:unused', revokeObjectUrl: () => {} });
  const controller = new AbortController();

  const promise = loader.load('key', 'https://example.test/a', undefined, controller.signal);
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();

  await assert.rejects(promise);
  assert.equal(counts.aborts, 1);
});

test('an already-aborted signal passed to load() cancels immediately, without a wasted retry cycle', async () => {
  const { fetchFn, counts } = makeAbortTrackingFetch();
  const loader = createArtifactPreviewLoader({ fetchFn, createObjectUrl: () => 'blob:unused', revokeObjectUrl: () => {} });
  const controller = new AbortController();
  controller.abort();

  const promise = loader.load('key', 'https://example.test/a', undefined, controller.signal);
  await assert.rejects(promise);
  assert.equal(counts.calls, 1, 'one attempt, not the full retry budget');
});

test('one of two callers aborting does not cancel a fetch a sibling still wants — they share one in-flight promise', async () => {
  const { fetchFn, counts, resolve } = makeControllableFetch();
  const loader = createArtifactPreviewLoader({ fetchFn, createObjectUrl: () => 'blob:shared', revokeObjectUrl: () => {} });
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  const first = loader.load('key', 'https://example.test/shared', undefined, controllerA.signal);
  const second = loader.load('key', 'https://example.test/shared', undefined, controllerB.signal);
  assert.equal(first, second, 'both callers share the same in-flight promise');

  await Promise.resolve();
  controllerA.abort();
  await Promise.resolve();
  assert.equal(counts.aborts, 0, 'a sibling still waiting must keep the fetch alive');

  resolve();
  assert.equal(await first, 'blob:shared');
});

test('createArtifactPreviewLoader cancels the underlying fetch once the LAST interested caller aborts', async () => {
  const { fetchFn, counts } = makeAbortTrackingFetch();
  const loader = createArtifactPreviewLoader({ fetchFn, createObjectUrl: () => 'blob:unused', revokeObjectUrl: () => {} });
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  const shared = loader.load('key', 'https://example.test/last', undefined, controllerA.signal);
  loader.load('key', 'https://example.test/last', undefined, controllerB.signal);
  await Promise.resolve();

  controllerA.abort();
  await Promise.resolve();
  assert.equal(counts.aborts, 0, 'controllerB is still interested');

  controllerB.abort();
  await assert.rejects(shared);
  assert.equal(counts.aborts, 1, 'cancelled exactly once, only once nobody is left waiting');
});

test('an unsignaled caller keeps a shared fetch alive even if every signaled caller aborts', async () => {
  const { fetchFn, counts, resolve } = makeControllableFetch();
  const loader = createArtifactPreviewLoader({ fetchFn, createObjectUrl: () => 'blob:mixed', revokeObjectUrl: () => {} });
  const controllerA = new AbortController();

  // No signal at all — an existing call site that has not been converted yet.
  const unsignaled = loader.load('key', 'https://example.test/mixed');
  loader.load('key', 'https://example.test/mixed', undefined, controllerA.signal);
  await Promise.resolve();

  controllerA.abort();
  await Promise.resolve();
  assert.equal(counts.aborts, 0, 'an unsignaled caller has no way to say it left, so the fetch must survive');

  resolve();
  assert.equal(await unsignaled, 'blob:mixed');
});

test('an abort listener left over from a SETTLED load never cancels the next load of the same key', async () => {
  // The page-generation signal outlives any single fetch: every card on the
  // page shares one, and it fires on navigation — long after a load that
  // already settled. The listener that load registered must be inert by then,
  // or it decrements (and can zero out) the waiter count of whatever task
  // holds the key next — cancelling a fetch an unsignaled caller still wants.
  let call = 0;
  let settleSecond: ((response: Response) => void) | undefined;
  const counts = { aborts: 0 };
  const fetchFn = ((_url: string, init?: RequestInit) => {
    call += 1;
    if (call === 1) return Promise.resolve(new Response('nope', { status: 404 }));
    return new Promise<Response>((resolve, reject) => {
      settleSecond = resolve;
      init?.signal?.addEventListener(
        'abort',
        () => {
          counts.aborts += 1;
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        },
        { once: true }
      );
    });
  }) as typeof fetch;

  const loader = createArtifactPreviewLoader({
    fetchFn,
    createObjectUrl: () => 'blob:second',
    revokeObjectUrl: () => {},
  });
  const pageSignal = new AbortController();

  // First load, signaled, fails non-retryably and is cleaned up.
  await assert.rejects(loader.load('key', 'https://example.test/a', undefined, pageSignal.signal));

  // Second load of the SAME key, with no signal of its own (the download
  // path in InventoryPage.tsx) — nothing may cancel it but itself.
  const unsignaled = loader.load('key', 'https://example.test/a');
  await Promise.resolve();

  pageSignal.abort();
  await Promise.resolve();
  assert.equal(counts.aborts, 0, 'the settled first load’s listener must not touch the second load');

  settleSecond?.(okResponse());
  assert.equal(await unsignaled, 'blob:second');
});
