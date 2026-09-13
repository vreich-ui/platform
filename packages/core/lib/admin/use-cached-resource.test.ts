/**
 * T5.1 — `use-cached-resource.ts`'s cache and fetch layer.
 *
 * There is no renderer in this repo's test stack (no jsdom, no
 * testing-library), so the hook itself (`useCachedResource`) is not exercised
 * here — exactly the arrangement `use-current-user.test.ts` documents for the
 * same reason. What IS exercised is every decision the hook delegates:
 * `writeCachedResource`/`readCachedResource` round-trip through
 * `sessionStorage`; `peekCachedResource` applies the caller's staleness
 * window; `fetchCachedResource` de-dupes concurrent readers, writes the cache
 * on success, and — the property the whole "a failed revalidation must not
 * blank the panel" rule rests on — leaves the last good value in place on
 * failure; `invalidateCachedResource` clears both layers; and a superseded
 * in-flight response can no longer overwrite the fresher one that replaced
 * it. Storage that throws (Safari private mode) degrades to "no cache", never
 * to an exception.
 *
 * This is a new file rather than an extension of an existing one because
 * `use-cached-resource.ts` is a new unit: no existing `lib/admin/*.test.ts`
 * covers it, and folding it into (say) `use-current-user.test.ts` would put
 * two unrelated modules behind one file name.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Registers the site-identity config provider (drlurie) — `getSiteIdentity()`
// throws without it. Same pattern `use-current-user.test.ts` uses.
import '../../../../sites/drlurie/config/policy-bindings.js';

import {
  CACHED_RESOURCE_MAX_AGE_MS,
  cachedResourceStorageKey,
  clearPersistedCachedResources,
  fetchCachedResource,
  invalidateCachedResource,
  peekCachedResource,
  readCachedResource,
  resetCachedResourcesForTests,
  writeCachedResource,
} from './use-cached-resource.js';

/** Minimal in-memory Storage stand-in — Node has no global sessionStorage. */
class MemoryStorage {
  protected store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.has(key) ? (this.store.get(key) as string) : null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  clear(): void {
    this.store.clear();
  }
  key(index: number): string | null {
    return Array.from(this.store.keys())[index] ?? null;
  }
  get length(): number {
    return this.store.size;
  }
}

/** Storage with a hard entry budget, the way a real quota refusal behaves. */
class QuotaStorage extends MemoryStorage {
  constructor(private readonly budget: number) {
    super();
  }
  setItem(key: string, value: string): void {
    if (super.getItem(key) === null && super.length >= this.budget) {
      throw new Error('QuotaExceededError');
    }
    super.setItem(key, value);
  }
}

/** Storage that throws on every access, the way Safari private mode does. */
class ThrowingStorage {
  getItem(): string | null {
    throw new Error('storage is disabled');
  }
  setItem(): void {
    throw new Error('storage is disabled');
  }
  removeItem(): void {
    throw new Error('storage is disabled');
  }
  clear(): void {
    throw new Error('storage is disabled');
  }
  key(): string | null {
    throw new Error('storage is disabled');
  }
  get length(): number {
    throw new Error('storage is disabled');
  }
}

let originalSessionStorage: Storage | undefined;

const setStorage = (storage: unknown) => {
  (globalThis as { sessionStorage: Storage }).sessionStorage = storage as Storage;
};

beforeEach(() => {
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  setStorage(new MemoryStorage());
  resetCachedResourcesForTests();
});

afterEach(() => {
  resetCachedResourcesForTests();
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    setStorage(originalSessionStorage);
  }
});

/** A deferred promise, so a test can hold a "request" open and observe what happens meanwhile. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('the cache layer — memory plus this tab’s sessionStorage', () => {
  it('nothing to read before anything is written', () => {
    assert.equal(readCachedResource('panel'), null);
    assert.equal(peekCachedResource('panel'), null);
  });

  it('a written value round-trips, and lands in sessionStorage under a site-scoped key', () => {
    writeCachedResource('panel', { rows: [1, 2, 3] });

    assert.deepEqual(readCachedResource<{ rows: number[] }>('panel')?.value, { rows: [1, 2, 3] });

    const raw = (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(cachedResourceStorageKey('panel'));
    assert.equal(typeof raw, 'string');
    assert.deepEqual(JSON.parse(raw as string).value, { rows: [1, 2, 3] });
  });

  it('a snapshot left by an earlier page load is picked up cold, with no memory entry', () => {
    // Written directly, the way a PRIOR navigation would have left it — this
    // test's module state starts empty (the `beforeEach` reset).
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      cachedResourceStorageKey('panel'),
      JSON.stringify({ value: 'from-an-earlier-page', fetchedAt: Date.now() })
    );
    assert.equal(peekCachedResource<string>('panel')?.value, 'from-an-earlier-page');
  });

  it('keys are independent of one another', () => {
    writeCachedResource('a', 1);
    writeCachedResource('b', 2);
    assert.equal(readCachedResource<number>('a')?.value, 1);
    assert.equal(readCachedResource<number>('b')?.value, 2);
  });

  it('a corrupt or foreign snapshot reads as "no cache" rather than throwing', () => {
    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    storage.setItem(cachedResourceStorageKey('panel'), 'not json at all');
    assert.equal(readCachedResource('panel'), null);

    storage.setItem(cachedResourceStorageKey('panel'), JSON.stringify({ value: 1 }));
    assert.equal(readCachedResource('panel'), null);
  });

  it('invalidate clears BOTH layers, so the next read has to go to the network', () => {
    writeCachedResource('panel', 'value');
    invalidateCachedResource('panel');

    assert.equal(readCachedResource('panel'), null);
    assert.equal(
      (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(cachedResourceStorageKey('panel')),
      null
    );
  });
});

describe('peekCachedResource — the caller’s staleness window', () => {
  it('an entry older than the window is not worth painting', () => {
    writeCachedResource('panel', 'value');
    const realNow = Date.now;
    Date.now = () => realNow() + CACHED_RESOURCE_MAX_AGE_MS + 1;
    try {
      assert.equal(peekCachedResource('panel'), null);
      // `readCachedResource` applies no window of its own — same contract as
      // `peekCachedEditorialView`: staleness is the caller's call.
      assert.equal(readCachedResource<string>('panel')?.value, 'value');
    } finally {
      Date.now = realNow;
    }
  });

  it('a caller may narrow the window to its own tolerance', () => {
    writeCachedResource('panel', 'value');
    const realNow = Date.now;
    Date.now = () => realNow() + 5_000;
    try {
      assert.equal(peekCachedResource('panel', 1_000), null);
      assert.equal(peekCachedResource<string>('panel', 30_000)?.value, 'value');
    } finally {
      Date.now = realNow;
    }
  });
});

describe('fetchCachedResource — de-duped, cache-on-success only', () => {
  it('a success writes the value to the cache', async () => {
    const value = await fetchCachedResource('panel', async () => ({ ok: true }));
    assert.deepEqual(value, { ok: true });
    assert.deepEqual(readCachedResource<{ ok: boolean }>('panel')?.value, { ok: true });
  });

  it('two readers of one key while a request is in flight share that one request', async () => {
    let calls = 0;
    const gate = deferred<string>();
    const fetcher = () => {
      calls += 1;
      return gate.promise;
    };

    const first = fetchCachedResource('panel', fetcher);
    const second = fetchCachedResource('panel', fetcher);
    gate.resolve('one answer');

    assert.deepEqual([await first, await second], ['one answer', 'one answer']);
    assert.equal(calls, 1);
  });

  it('the in-flight entry is released once it settles, so a later read fetches again', async () => {
    let calls = 0;
    await fetchCachedResource('panel', async () => {
      calls += 1;
      return calls;
    });
    await fetchCachedResource('panel', async () => {
      calls += 1;
      return calls;
    });
    assert.equal(calls, 2);
  });

  it('a failure leaves the last good value in the cache — this is what keeps a panel from blanking', async () => {
    await fetchCachedResource('panel', async () => 'good');
    await assert.rejects(
      fetchCachedResource('panel', async () => {
        throw new Error('revalidation failed');
      }),
      /revalidation failed/
    );
    assert.equal(readCachedResource<string>('panel')?.value, 'good');
  });

  it('a failure also releases the in-flight entry rather than wedging the key', async () => {
    await assert.rejects(
      fetchCachedResource('panel', async () => {
        throw new Error('boom');
      })
    );
    assert.equal(await fetchCachedResource('panel', async () => 'recovered'), 'recovered');
  });

  it('a superseded response cannot overwrite the fresher one that replaced it', async () => {
    const slow = deferred<string>();
    const stale = fetchCachedResource('panel', () => slow.promise);

    // What `refresh()` does: drop the in-flight marker, then start again.
    invalidateCachedResource('panel');
    await fetchCachedResource('panel', async () => 'fresh');

    slow.resolve('stale');
    assert.equal(await stale, 'stale');
    assert.equal(readCachedResource<string>('panel')?.value, 'fresh');
  });
});

describe('a quota refusal costs the OLD snapshots, never the current one', () => {
  it('this module\u2019s own keys are dropped and the write is retried', () => {
    setStorage(new QuotaStorage(2));

    writeCachedResource('first', 'a');
    writeCachedResource('second', 'b');
    // The third write hits the budget, clears this module's keys, retries.
    writeCachedResource('third', 'c');

    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    assert.equal(storage.getItem(cachedResourceStorageKey('first')), null);
    assert.equal(storage.getItem(cachedResourceStorageKey('second')), null);
    assert.equal(typeof storage.getItem(cachedResourceStorageKey('third')), 'string');
  });

  it('another module\u2019s sessionStorage keys are left alone', () => {
    setStorage(new QuotaStorage(2));
    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    storage.setItem('someone-elses-key', 'not ours');

    writeCachedResource('first', 'a');
    writeCachedResource('second', 'b');

    assert.equal(storage.getItem('someone-elses-key'), 'not ours');
    assert.equal(typeof storage.getItem(cachedResourceStorageKey('second')), 'string');
  });

  it('clearPersistedCachedResources drops the persisted copies but not the in-memory ones', () => {
    writeCachedResource('panel', 'value');
    clearPersistedCachedResources();

    assert.equal(
      (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(cachedResourceStorageKey('panel')),
      null
    );
    // Still readable for this page's lifetime — clearing storage is not the
    // same as invalidating the resource.
    assert.equal(readCachedResource<string>('panel')?.value, 'value');
  });
});

describe('storage that throws (Safari private mode) degrades to "no cache"', () => {
  it('reads, writes, and invalidation are all survivable', async () => {
    setStorage(new ThrowingStorage());

    assert.doesNotThrow(() => writeCachedResource('panel', 'value'));
    // The in-memory half still works for this page's lifetime.
    assert.equal(readCachedResource<string>('panel')?.value, 'value');
    assert.doesNotThrow(() => invalidateCachedResource('panel'));
    assert.equal(readCachedResource('panel'), null);
    assert.equal(await fetchCachedResource('panel', async () => 'fetched'), 'fetched');
  });
});
