/**
 * T1.2 R3 — `use-current-user.ts`'s `sessionStorage` layer.
 *
 * No renderer in this repo's test stack (no jsdom, no testing-library — see
 * the repo's own test-convention notes), so the hook itself (`useCurrentUser`)
 * is not exercised here. What IS exercised is everything the hook is built
 * on: `refreshCurrentUser` persists a genuine resolved state and skips a
 * failure; `peekCachedCurrentUser` round-trips it verbatim (it applies no
 * TTL of its own — same contract as `editorial-view-client.ts`'s
 * `peekCachedEditorialView`; the caller decides staleness tolerance);
 * `hydrateFromCacheOnce` seeds the module snapshot from it exactly once,
 * and ignores an entry older than `CURRENT_USER_CACHE_TTL_MS`; and
 * `invalidateCurrentUser` clears both the snapshot and the persisted copy.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Registers the site-identity config provider (drlurie) — `getSiteIdentity()`
// throws without it. Same pattern studio-client.test.ts uses.
import '../../../../sites/drlurie/config/policy-bindings.js';

import { getSiteIdentity } from '../site-identity.js';
import {
  currentUserSnapshot,
  CURRENT_USER_CACHE_TTL_MS,
  hydrateFromCacheOnce,
  invalidateCurrentUser,
  peekCachedCurrentUser,
  refreshCurrentUser,
  resetCurrentUserForTests,
} from './use-current-user.js';
import type { UserView } from './users-client.js';

/** Minimal in-memory Storage stand-in — Node has no global sessionStorage. */
class MemoryStorage {
  private store = new Map<string, string>();
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

const user = (email: string): UserView =>
  ({ email, display_name: email.split('@')[0] }) as unknown as UserView;

let restoreFetch: (() => void) | undefined;
let originalSessionStorage: Storage | undefined;

beforeEach(() => {
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
  resetCurrentUserForTests();
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  resetCurrentUserForTests();
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
});

const mockFetchMe = (reply: () => { status?: number; body: unknown }) => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const { status = 200, body } = reply();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
};

describe('refreshCurrentUser — persists a genuine answer, never a failure', () => {
  it('nothing to peek before the first fetch', () => {
    assert.equal(peekCachedCurrentUser(), null);
  });

  it('a successful fetch writes the resolved state to sessionStorage', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    const result = await refreshCurrentUser();
    assert.equal(result.loading, false);
    assert.equal(result.user?.email, 'a@x.test');

    const cached = peekCachedCurrentUser();
    assert.equal(cached?.state.user?.email, 'a@x.test');
    assert.deepEqual(cached?.state.roles, ['owner']);
  });

  it('a failed fetch is never persisted', async () => {
    restoreFetch = mockFetchMe(() => ({ status: 500, body: { error: 'boom' } }));
    const result = await refreshCurrentUser();
    assert.equal(result.error !== undefined, true);
    assert.equal(peekCachedCurrentUser(), null);
  });
});

describe('peekCachedCurrentUser — no TTL of its own', () => {
  it('still returns an entry older than the TTL verbatim — staleness is the caller’s call', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser();
    assert.notEqual(peekCachedCurrentUser(), null);

    const realNow = Date.now;
    Date.now = () => realNow() + CURRENT_USER_CACHE_TTL_MS + 1;
    try {
      assert.equal(peekCachedCurrentUser()?.state.user?.email, 'a@x.test');
    } finally {
      Date.now = realNow;
    }
  });
});

describe('hydrateFromCacheOnce — seeds the module snapshot exactly once', () => {
  it('a fresh, cached state seeds the snapshot as already-resolved', () => {
    // Written directly, the way a PRIOR page's `refreshCurrentUser` would
    // have left it in sessionStorage — this test's own module starts
    // un-hydrated (the `beforeEach` reset) and must pick it up cold.
    const key = `${getSiteIdentity().siteSlug}-current-user-cache`;
    const cachedState = { user: user('a@x.test'), roles: ['editor'], loading: false };
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      key,
      JSON.stringify({ state: cachedState, fetchedAt: Date.now() })
    );

    assert.equal(currentUserSnapshot().loading, true, 'still EMPTY before hydration runs');
    hydrateFromCacheOnce();
    assert.equal(currentUserSnapshot().loading, false);
    assert.equal(currentUserSnapshot().user?.email, 'a@x.test');
    assert.deepEqual(currentUserSnapshot().roles, ['editor']);
  });

  it('is a no-op the second time it is called, even if the cache changes underneath it', async () => {
    hydrateFromCacheOnce();
    assert.equal(currentUserSnapshot().user, null, 'nothing cached yet — hydration is a no-op');
    restoreFetch = mockFetchMe(() => ({ body: { user: user('b@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser(); // writes a fresh cache entry AND the live snapshot
    hydrateFromCacheOnce(); // must not clobber the live (already-correct) snapshot with a stale re-read
    assert.equal(currentUserSnapshot().user?.email, 'b@x.test');
  });

  it('an empty cache leaves the snapshot at EMPTY', () => {
    hydrateFromCacheOnce();
    assert.equal(currentUserSnapshot().loading, true);
    assert.equal(currentUserSnapshot().user, null);
  });

  it('an entry older than the TTL is ignored — the snapshot stays EMPTY, not stale', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser(); // writes a real cache entry via the module under test
    const key = `${getSiteIdentity().siteSlug}-current-user-cache`;
    const raw = (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key);
    assert.notEqual(raw, null, 'the refresh above must have persisted something to re-seed');
    const parsed = JSON.parse(raw as string) as { state: unknown; fetchedAt: number };

    // `resetCurrentUserForTests` also clears the persisted copy (it must, so
    // other tests start cold) — so the aged entry is captured above and
    // written back AFTER reset, exactly like a prior page's stale
    // sessionStorage entry this test's own module has never seen yet.
    resetCurrentUserForTests();
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      key,
      JSON.stringify({ ...parsed, fetchedAt: Date.now() - CURRENT_USER_CACHE_TTL_MS - 1 })
    );

    hydrateFromCacheOnce();
    assert.equal(currentUserSnapshot().loading, true, 'a stale entry must not seed the snapshot');
    assert.equal(currentUserSnapshot().user, null);
  });
});

describe('invalidateCurrentUser — clears both the live snapshot and the persisted copy', () => {
  it('sign-out leaves nothing behind for the next hydrate to find', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser();
    assert.notEqual(peekCachedCurrentUser(), null);

    invalidateCurrentUser();
    assert.equal(currentUserSnapshot().user, null);
    assert.equal(currentUserSnapshot().loading, true);
    assert.equal(peekCachedCurrentUser(), null);
  });
});

describe('sessionStorage degrades gracefully when it throws (private browsing)', () => {
  it('refreshCurrentUser still resolves, and peek reads as a miss instead of throwing', async () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
      clear: () => {
        throw new Error('blocked');
      },
      key: () => {
        throw new Error('blocked');
      },
      length: 0,
    } as unknown as Storage;

    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    const result = await refreshCurrentUser();
    assert.equal(result.user?.email, 'a@x.test');
    assert.equal(peekCachedCurrentUser(), null);
  });
});
