import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Registers the site-identity config provider (drlurie) — `getSiteIdentity()`
// throws without it. Same pattern studio-client.test.ts uses.
import '../../../../sites/drlurie/config/policy-bindings.js';

import {
  ADMIN_ACCESS_CACHE_TTL_MS,
  clearCachedAdminAccessState,
  fetchAdminAccessState,
  peekCachedAdminAccessState,
  type AdminAccessState,
} from './admin-access-client.js';

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

/** An unsigned JWT-shaped token with the given `sub` — cache-keying only, `fetchAdminAccessState` never verifies it. */
// `iat` makes two tokens for the SAME subject byte-distinct strings (a
// refreshed token for the same person), which is exactly the case the
// subject-keyed-not-token-keyed test below needs to exercise.
let tokenSerial = 0;
const tokenFor = (sub: string): string => {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  tokenSerial += 1;
  return `${b64url({ alg: 'none' })}.${b64url({ sub, iat: tokenSerial })}.sig`;
};

let restoreFetch: (() => void) | undefined;
let originalSessionStorage: Storage | undefined;

beforeEach(() => {
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
});

const mockFetch = (state: AdminAccessState, status = 200) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify(state), { status })) as typeof fetch;
  return () => {
    globalThis.fetch = originalFetch;
  };
};

describe('fetchAdminAccessState — sessionStorage cache', () => {
  it('has nothing to peek before the first fetch', () => {
    assert.equal(peekCachedAdminAccessState(tokenFor('user-1')), null);
  });

  it('caches a genuine answer, keyed by the token subject, and peekCachedAdminAccessState finds it', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, roles: ['owner'] });
    const fetched = await fetchAdminAccessState(token);
    assert.equal(fetched.isAdmin, true);

    const cached = peekCachedAdminAccessState(token);
    assert.deepEqual(cached, { authenticated: true, isAdmin: true, roles: ['owner'] });
  });

  it('a different token with the same subject hits the same cache entry (subject-keyed, not token-keyed)', async () => {
    const firstToken = tokenFor('user-1');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, roles: ['owner'] });
    await fetchAdminAccessState(firstToken);

    // A refreshed token for the same person is a different string but the
    // same `sub` — the whole reason this is keyed by subject, not by token.
    const refreshedToken = tokenFor('user-1');
    assert.notEqual(refreshedToken, firstToken);
    assert.deepEqual(peekCachedAdminAccessState(refreshedToken)?.roles, ['owner']);
  });

  it('a different subject never sees another subject’s cached entry', async () => {
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, roles: ['owner'] });
    await fetchAdminAccessState(tokenFor('user-1'));
    assert.equal(peekCachedAdminAccessState(tokenFor('user-2')), null);
  });

  it('never caches a checkFailed (transient) answer', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: false, checkFailed: true, error: 'boom' }, 500);
    const fetched = await fetchAdminAccessState(token);
    assert.equal(fetched.checkFailed, true);
    assert.equal(peekCachedAdminAccessState(token), null);
  });

  it('a network failure is not cached either', async () => {
    const token = tokenFor('user-1');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error('offline');
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };
    const fetched = await fetchAdminAccessState(token);
    assert.equal(fetched.checkFailed, true);
    assert.equal(peekCachedAdminAccessState(token), null);
  });

  it('an entry older than the TTL is treated as a miss', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, roles: ['owner'] });
    await fetchAdminAccessState(token);
    assert.notEqual(peekCachedAdminAccessState(token), null);

    const realNow = Date.now;
    Date.now = () => realNow() + ADMIN_ACCESS_CACHE_TTL_MS + 1;
    try {
      assert.equal(peekCachedAdminAccessState(token), null);
    } finally {
      Date.now = realNow;
    }
  });

  it('an undecodable token peeks as a miss instead of throwing', () => {
    assert.equal(peekCachedAdminAccessState('not-a-jwt'), null);
  });

  it('a missing/null token peeks as a miss', () => {
    assert.equal(peekCachedAdminAccessState(null), null);
    assert.equal(peekCachedAdminAccessState(undefined), null);
  });

  it('degrades gracefully when sessionStorage throws (private browsing) — fetch still resolves', async () => {
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
    const token = tokenFor('user-1');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, roles: ['owner'] });
    const fetched = await fetchAdminAccessState(token);
    assert.equal(fetched.isAdmin, true);
    assert.equal(peekCachedAdminAccessState(token), null);
  });
});

describe('clearCachedAdminAccessState (sign-out)', () => {
  it('drops every cached subject, so a signed-out tab retains no roles or e-mail', async () => {
    const alice = tokenFor('sub-alice');
    const bob = tokenFor('sub-bob');
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, email: 'alice@example.test', roles: ['owner'] });
    await fetchAdminAccessState(alice);
    restoreFetch();
    restoreFetch = mockFetch({ authenticated: true, isAdmin: true, email: 'bob@example.test', roles: ['admin'] });
    await fetchAdminAccessState(bob);

    assert.notEqual(peekCachedAdminAccessState(alice), null);
    assert.notEqual(peekCachedAdminAccessState(bob), null);

    clearCachedAdminAccessState();

    assert.equal(peekCachedAdminAccessState(alice), null);
    assert.equal(peekCachedAdminAccessState(bob), null);
    assert.equal(sessionStorage.length, 0);
  });

  it('never throws when storage is unavailable', () => {
    const saved = (globalThis as { sessionStorage?: Storage }).sessionStorage;
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
    assert.doesNotThrow(() => clearCachedAdminAccessState());
    (globalThis as { sessionStorage?: Storage }).sessionStorage = saved;
  });
});
