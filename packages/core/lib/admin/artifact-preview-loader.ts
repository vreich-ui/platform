/**
 * Loader plumbing behind `ArtifactStagePreview` (W-mood-board-perf fix).
 *
 * A mood board holds up to `MOOD_BOARD_MAX_REFERENCES` (24) references, each
 * rendered by its own `ArtifactStagePreview` instance. Before this module
 * existed, every card ran its own bare `fetch` — one shot, no timeout, no
 * shared limit, no cache — so 24 cards meant 24 simultaneous authenticated
 * function calls, any one of which landed permanently in the error state on
 * a single transient failure. This module is the pure, DOM-free fix: bounded
 * retry with backoff+jitter, an abort-based timeout, a small shared
 * concurrency queue, and a page-lifetime object-URL cache with exactly-once
 * revocation. `packages/core/admin/ArtifactStagePreview.tsx` is a thin caller
 * — every decision here is unit-tested with `node:test` (`.tsx` is excluded
 * from `tsconfig.test.json`; this file is the only place these decisions may
 * live).
 *
 * Every timer and the fetch function are injected so tests drive time and
 * network deterministically — no real timers, no sleeps, no live network.
 */

// ─── clock ───────────────────────────────────────────────────────────────

/** The subset of the timer API this module needs, injectable for tests. */
export interface Clock {
  setTimeout: (callback: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
}

export const realClock: Clock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

const sleep = (ms: number, clock: Clock): Promise<void> =>
  new Promise((resolve) => {
    clock.setTimeout(resolve, ms);
  });

// ─── retry + timeout policy ──────────────────────────────────────────────

export interface RetryPolicy {
  /** Total attempts, including the first — not the retry count. */
  maxAttempts: number;
  /** Backoff before attempt N+1: min(maxDelayMs, baseDelayMs * 2^(N-1)), then full-jittered. */
  baseDelayMs: number;
  maxDelayMs: number;
  /** Each attempt is aborted (and counted as a failed, retryable attempt) past this. */
  timeoutMs: number;
}

/**
 * 3 attempts, ~400ms/800ms full-jittered backoff capped at 4s, 8s
 * per-attempt timeout. A cold blob read or a dropped connection clears in
 * well under 8s; three attempts absorbs a single transient failure (the
 * observed defect) without turning a genuinely dead endpoint into a
 * multi-second stall on every one of 24 cards.
 */
export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 400,
  maxDelayMs: 4000,
  timeoutMs: 8000,
};

/**
 * Cards mount together — up to 24 on a full mood board — and each preview is
 * its own authenticated function call. 4 in flight keeps the board painting
 * steadily (6 waves instead of 1 stampede of 24) without serializing so hard
 * that the last card waits behind 23 others.
 */
export const DEFAULT_CONCURRENCY_LIMIT = 4;

const fullJitter = (attempt: number, policy: RetryPolicy, random: () => number): number => {
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(policy.maxDelayMs, exponential);
  return Math.round(random() * capped);
};

/** True for a Response whose status means "try again", not "this is broken". */
const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

export class ArtifactPreviewFetchError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ArtifactPreviewFetchError';
    this.status = status;
  }
}

/**
 * T1.1: combines any number of signals into one that aborts the instant any
 * INPUT does — `undefined` entries are skipped. Manual (not `AbortSignal.any`)
 * so this stays consistent with the rest of this file's dependency-free,
 * fully-injectable style. Used to let an attempt's own timeout controller
 * (`fetchOnce`) and a caller-supplied cancel signal (`init?.signal`, see
 * `createArtifactPreviewLoader`) both abort the same underlying fetch.
 */
function anySignal(signals: ReadonlyArray<AbortSignal | undefined>): AbortSignal {
  const controller = new AbortController();
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort();
      break;
    }
    signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller.signal;
}

const fetchOnce = async (
  fetchFn: typeof fetch,
  url: string,
  init: RequestInit | undefined,
  timeoutMs: number,
  clock: Clock
): Promise<Response> => {
  const controller = new AbortController();
  const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
  // `init?.signal` (when set) is the caller's own cancel signal — carried
  // through unchanged everywhere else in this module, but here it must be
  // COMBINED with the per-attempt timeout controller rather than overwritten
  // by it (a bare `{...init, signal: controller.signal}` would silently drop
  // whatever signal the caller passed).
  const signal = init?.signal ? anySignal([init.signal, controller.signal]) : controller.signal;
  try {
    return await fetchFn(url, { ...init, signal });
  } finally {
    clock.clearTimeout(timer);
  }
};

export interface FetchWithRetryOptions {
  fetchFn: typeof fetch;
  clock?: Clock;
  random?: () => number;
  policy?: RetryPolicy;
}

/**
 * Fetches `url` with a bounded number of attempts. Each attempt gets its own
 * abort-based timeout (a hung request fails fast enough to retry instead of
 * spinning forever); a timeout, a network rejection, or a retryable HTTP
 * status all count as one failed attempt and are followed by a jittered
 * backoff before the next try. A non-retryable HTTP status (4xx other than
 * 408/429) fails immediately without spending remaining attempts — retrying
 * a 403 or 404 cannot make it succeed.
 */
export async function fetchWithRetry(
  url: string,
  init: RequestInit | undefined,
  options: FetchWithRetryOptions
): Promise<Response> {
  const { fetchFn, clock = realClock, random = Math.random, policy = DEFAULT_RETRY_POLICY } = options;
  let lastError: unknown;

  for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
    try {
      const response = await fetchOnce(fetchFn, url, init, policy.timeoutMs, clock);
      if (response.ok) return response;
      if (!isRetryableStatus(response.status)) {
        throw new ArtifactPreviewFetchError(`preview fetch failed with status ${response.status}`, response.status);
      }
      lastError = new ArtifactPreviewFetchError(`preview fetch failed with status ${response.status}`, response.status);
    } catch (error) {
      if (error instanceof ArtifactPreviewFetchError && error.status !== undefined && !isRetryableStatus(error.status)) {
        throw error;
      }
      // T1.1: the CALLER's own signal aborting (as opposed to this attempt's
      // per-attempt timeout, which IS worth retrying) means nobody wants
      // this fetch anymore — spending the backoff delay on a request already
      // dead would only slow down reporting that it is gone.
      if (init?.signal?.aborted) throw error;
      lastError = error;
    }

    if (attempt >= policy.maxAttempts) break;
    await sleep(fullJitter(attempt, policy, random), clock);
  }

  throw lastError instanceof Error ? lastError : new Error('preview fetch failed');
}

// ─── concurrency queue ───────────────────────────────────────────────────

export interface ConcurrencyQueue {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** A small FIFO queue that never runs more than `limit` tasks at once. */
export function createConcurrencyQueue(limit: number): ConcurrencyQueue {
  const bound = Math.max(1, limit);
  let active = 0;
  const pending: Array<() => void> = [];

  const releaseSlot = () => {
    active -= 1;
    const dispatch = pending.shift();
    if (dispatch) {
      active += 1;
      dispatch();
    }
  };

  return {
    run<T>(task: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const attempt = () => {
          task().then(
            (value) => {
              releaseSlot();
              resolve(value);
            },
            (error: unknown) => {
              releaseSlot();
              reject(error);
            }
          );
        };
        if (active < bound) {
          active += 1;
          attempt();
        } else {
          pending.push(attempt);
        }
      });
    },
  };
}

// ─── object-URL cache ────────────────────────────────────────────────────

export interface ObjectUrlCache {
  get(key: string): string | undefined;
  /** Revokes and replaces any existing entry at `key` before storing `url`. */
  set(key: string, url: string): void;
  /** Revokes and removes the entry at `key`, if any. Safe to call twice — the second call is a no-op. */
  delete(key: string): void;
  /** Revokes every cached URL exactly once and empties the cache. */
  clear(): void;
}

/**
 * Object URLs are only ever revoked here, from the map — never in a
 * component's unmount effect — so a card that remounts (a filter change, a
 * key-based remount on the selected standard) finds its bytes still cached
 * instead of re-fetching, and nothing is revoked more than once: revoking
 * happens exactly where an entry leaves the map, which happens exactly once
 * per entry.
 */
export function createObjectUrlCache(revokeObjectUrl: (url: string) => void): ObjectUrlCache {
  const entries = new Map<string, string>();

  return {
    get: (key) => entries.get(key),
    set(key, url) {
      const previous = entries.get(key);
      entries.set(key, url);
      if (previous !== undefined && previous !== url) revokeObjectUrl(previous);
    },
    delete(key) {
      const previous = entries.get(key);
      if (previous === undefined) return;
      entries.delete(key);
      revokeObjectUrl(previous);
    },
    clear() {
      for (const url of entries.values()) revokeObjectUrl(url);
      entries.clear();
    },
  };
}

// ─── the composed loader ─────────────────────────────────────────────────

export interface ArtifactPreviewLoaderOptions {
  fetchFn?: typeof fetch;
  clock?: Clock;
  random?: () => number;
  policy?: RetryPolicy;
  /** A pre-built queue (tests / call sites that want their own bound); otherwise `concurrency` builds one. */
  queue?: ConcurrencyQueue;
  concurrency?: number;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
}

export interface ArtifactPreviewLoader {
  /**
   * Resolves an object URL for `url`, cached by `key` for the loader's
   * lifetime. Concurrent callers for the same `key` share one in-flight
   * fetch. A failed load is never cached, so the next call (an automatic
   * remount or the user's "Try again") starts a fresh retry cycle.
   *
   * T1.1: `signal`, when given, marks THIS caller as no longer interested if
   * it aborts (a card unmounting on navigation). Because the underlying
   * fetch is shared and de-duped across every caller of the same `key`
   * (mood-board cards rarely collide, but the library picker and a mood
   * board CAN want the same artifact at once), the real network request is
   * only actually cancelled once EVERY caller currently waiting on this key
   * has aborted — one card leaving early must never cancel a still-wanted
   * fetch out from under a sibling card or the next page's own mount.
   */
  load(key: string, url: string, init?: RequestInit, signal?: AbortSignal): Promise<string>;
  /** Revokes every cached object URL exactly once. Call on full teardown (mainly for tests — the .tsx keeps one page-lifetime singleton). */
  dispose(): void;
}

/**
 * Composes the cache, the shared concurrency queue, and bounded retry+timeout
 * into the one call `ArtifactStagePreview` needs. `fetchFn` and `clock` are
 * threaded through so a caller (or a test) can fully control network and time.
 */
export function createArtifactPreviewLoader(options: ArtifactPreviewLoaderOptions = {}): ArtifactPreviewLoader {
  const {
    fetchFn = fetch,
    clock = realClock,
    random = Math.random,
    policy = DEFAULT_RETRY_POLICY,
    createObjectUrl = (blob: Blob) => URL.createObjectURL(blob),
    revokeObjectUrl = (url: string) => URL.revokeObjectURL(url),
  } = options;
  const queue = options.queue ?? createConcurrencyQueue(options.concurrency ?? DEFAULT_CONCURRENCY_LIMIT);
  const cache = createObjectUrlCache(revokeObjectUrl);
  const inFlight = new Map<string, Promise<string>>();
  /** How many still-interested callers are waiting on each in-flight key — the underlying fetch is cancelled only when this reaches 0. */
  const waiters = new Map<string, number>();
  /** One cancel controller per in-flight key, combined into the actual fetch via `fetchOnce`'s `anySignal`. */
  const cancelControllers = new Map<string, AbortController>();

  const load = (key: string, url: string, init?: RequestInit, signal?: AbortSignal): Promise<string> => {
    const cached = cache.get(key);
    if (cached !== undefined) return Promise.resolve(cached);

    let task = inFlight.get(key);
    if (!task) {
      const freshController = new AbortController();
      cancelControllers.set(key, freshController);
      waiters.set(key, 0);
      task = queue
        .run(() => fetchWithRetry(url, { ...init, signal: freshController.signal }, { fetchFn, clock, random, policy }))
        .then(async (response) => {
          const blob = await response.blob();
          const objectUrl = createObjectUrl(blob);
          cache.set(key, objectUrl);
          return objectUrl;
        })
        .finally(() => {
          inFlight.delete(key);
          waiters.delete(key);
          cancelControllers.delete(key);
        });
      inFlight.set(key, task);
    }

    // Every caller counts, signaled or not — an unsignaled caller has no way
    // to say "I'm gone" and so must never be treated as having left; only a
    // caller that PASSED a signal can ever decrement this below the count of
    // still-implicitly-interested unsignaled callers.
    waiters.set(key, (waiters.get(key) ?? 0) + 1);

    if (signal) {
      // The controller for the task THIS caller just joined. An `AbortSignal`
      // outlives the fetch it cancelled (the page-generation signal is shared
      // by every card on the page and fires long after a fast load settled),
      // so without this identity check a listener left over from a SETTLED
      // task would fire later and decrement — or resurrect a deleted entry
      // in — the bookkeeping of whatever task holds the key by then. Two
      // real consequences that closes: a `waiters` map that grows a dead
      // entry per key per navigation, and (worse) a stale listener driving a
      // live task's count to 0 and cancelling a fetch an unsignaled caller —
      // `downloadHit` in InventoryPage.tsx — is still waiting on.
      const joined = cancelControllers.get(key);
      const onAbort = () => {
        if (!joined || cancelControllers.get(key) !== joined) return;
        const remaining = (waiters.get(key) ?? 1) - 1;
        waiters.set(key, remaining);
        // Only the LAST interested caller leaving actually cancels the
        // network request — a sibling card (or the next page, if it happens
        // to want the same artifact) may still be waiting on it.
        if (remaining <= 0) joined.abort();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    return task;
  };

  return {
    load,
    dispose: () => cache.clear(),
  };
}
