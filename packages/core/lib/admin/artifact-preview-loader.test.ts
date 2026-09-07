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
