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

// ─── T-shell: the access check through the COALESCED `admin-shell` call ──────
//
// `Server-Timing` measured `admin-auth-state` doing 0.02 ms of server work for
// 242-683 ms on the wire, so the shell's per-click floor was three round trips
// of fixed per-invocation overhead, not three slow functions. The gate now
// takes its answer out of one `admin-shell` response that also carries the
// requests index and `me` — and falls back to `admin-auth-state`, verbatim,
// whenever that cannot answer.
//
// The coalescing lives in `admin-shell-client.ts` rather than in this module
// on purpose: this module is also loaded by `HeaderAuthButton.astro` on every
// PUBLIC reader page, and the shell client reaches `page-generation.ts`, which
// imports React. Pointing the import edge the other way would have shipped
// React to readers to serve an admin-only optimisation.
import {
  fetchAdminAccessStateViaShell,
  isAdminShellUnavailable,
  resetAdminShellClientForTests,
  takeAdminShellSection,
} from './admin-shell-client.js';
// A 401 from the shell raises the session-expiry flag, which is module scope
// for the same ClientRouter reason everything else here is — so a case that
// exercises one must put it back.
import { resetAuthExpiryForTests } from './auth-expiry.js';

/** Records every URL fetched, so "one call, not two" is an assertion and not a hope. */
const mockShellFetch = (reply: (url: string) => { status: number; body: unknown }) => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const { status, body } = reply(url);
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
  return {
    urls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const OWNER_ACCESS = { authenticated: true, isAdmin: true, tier: 'owner', roles: ['owner', 'admin'] };

const shellBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  sections: {
    access: { status: 'ok', data: OWNER_ACCESS },
    requests: { status: 'ok', data: { requests: [], total: 0, seq: 1, muted: [], last_notified: {} } },
    me: { status: 'ok', data: { user: { email: 'boss@example.test' }, roles: ['owner'] } },
    ...over,
  },
});

describe('fetchAdminAccessStateViaShell — one call for three answers', () => {
  beforeEach(() => resetAdminShellClientForTests());
  afterEach(() => resetAdminShellClientForTests());

  it('answers from the shell’s access section and never calls admin-auth-state', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch(() => ({ status: 200, body: shellBody() }));
    restoreFetch = mock.restore;

    const state = await fetchAdminAccessStateViaShell(token);
    assert.equal(state.isAdmin, true);
    assert.deepEqual(state.roles, ['owner', 'admin']);
    assert.deepEqual(mock.urls, ['/.netlify/functions/admin-shell']);
  });

  it('seeds the same instant-paint cache the direct call seeds', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockShellFetch(() => ({ status: 200, body: shellBody() })).restore;
    await fetchAdminAccessStateViaShell(token);
    // The coalescing would have bought a round trip back if the next
    // navigation had nothing to paint from.
    assert.deepEqual(peekCachedAdminAccessState(token)?.roles, ['owner', 'admin']);
  });

  it('three consumers waking together share ONE shell request', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch(() => ({ status: 200, body: shellBody() }));
    restoreFetch = mock.restore;

    const [access, requests, me] = await Promise.all([
      fetchAdminAccessStateViaShell(token),
      takeAdminShellSection<{ seq: number }>(token, 'requests'),
      takeAdminShellSection<{ roles: string[] }>(token, 'me'),
    ]);
    assert.equal(access.isAdmin, true);
    assert.equal(requests?.seq, 1);
    assert.deepEqual(me?.roles, ['owner']);
    assert.equal(mock.urls.length, 1, `expected one request, got ${mock.urls.join(', ')}`);
  });

  it('hands each section over ONCE, so a later poll goes to its own endpoint', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockShellFetch(() => ({ status: 200, body: shellBody() })).restore;
    assert.notEqual(await takeAdminShellSection(token, 'requests'), null);
    // The shell serves the navigation burst; the store's own 5-30s cadence
    // must not keep asking through it, or every poll would re-read the users
    // store and re-resolve the tier for data nobody asked for.
    assert.equal(await takeAdminShellSection(token, 'requests'), null);
  });
});

describe('fetchAdminAccessStateViaShell — the one fallback path', () => {
  beforeEach(() => resetAdminShellClientForTests());
  afterEach(() => resetAdminShellClientForTests());

  it('falls back to admin-auth-state on a 404 (a client loaded against an older deploy)', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch((url) =>
      url.endsWith('admin-shell')
        ? { status: 404, body: {} }
        : { status: 200, body: { authenticated: true, isAdmin: true, roles: ['admin'] } }
    );
    restoreFetch = mock.restore;

    const state = await fetchAdminAccessStateViaShell(token);
    assert.deepEqual(state.roles, ['admin']);
    assert.deepEqual(mock.urls, ['/.netlify/functions/admin-shell', '/.netlify/functions/admin-auth-state']);
  });

  it('a 404 is sticky — nothing re-probes admin-shell for the rest of the page', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch((url) =>
      url.endsWith('admin-shell')
        ? { status: 404, body: {} }
        : { status: 200, body: { authenticated: true, isAdmin: true, roles: ['admin'] } }
    );
    restoreFetch = mock.restore;

    await fetchAdminAccessStateViaShell(token);
    assert.equal(isAdminShellUnavailable(), true);
    await fetchAdminAccessStateViaShell(token);
    assert.equal(await takeAdminShellSection(token, 'me'), null);
    assert.equal(mock.urls.filter((url) => url.endsWith('admin-shell')).length, 1);
  });

  it('a section the server marked errored falls back alone — the others keep their answers', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch((url) =>
      url.endsWith('admin-shell')
        ? { status: 200, body: shellBody({ requests: { status: 'error', code: 'read_failed' } }) }
        : { status: 200, body: {} }
    );
    restoreFetch = mock.restore;

    // Degradation parity: with three separate calls, one failing left the
    // other two answers intact, and the coalesced call must be no worse.
    assert.equal((await fetchAdminAccessStateViaShell(token)).isAdmin, true);
    assert.notEqual(await takeAdminShellSection(token, 'me'), null);
    assert.equal(await takeAdminShellSection(token, 'requests'), null);
    assert.equal(isAdminShellUnavailable(), false, 'one bad section must not retire the coalesced path');
  });

  it('a skipped section (caller has no admin tier) also falls back to null, not to an error', async () => {
    const token = tokenFor('user-1');
    restoreFetch = mockShellFetch(() => ({
      status: 200,
      body: shellBody({
        access: { status: 'ok', data: { authenticated: true, isAdmin: false, roles: ['viewer'] } },
        requests: { status: 'skipped', code: 'admin_required' },
        me: { status: 'skipped', code: 'admin_required' },
      }),
    })).restore;

    const state = await fetchAdminAccessStateViaShell(token);
    assert.equal(state.isAdmin, false);
    assert.deepEqual(state.roles, ['viewer']);
    assert.equal(await takeAdminShellSection(token, 'me'), null);
  });

  it('a signed-out caller never reaches the network at all', async () => {
    const mock = mockShellFetch(() => ({ status: 200, body: shellBody() }));
    restoreFetch = mock.restore;
    const state = await fetchAdminAccessStateViaShell(null);
    assert.deepEqual(state, { authenticated: false, isAdmin: false });
    assert.deepEqual(mock.urls, []);
  });

  /**
   * A shell that FAILS must cost one attempt, not one per consumer.
   *
   * The three consumers do not wake in the same tick in production — the gate
   * runs in `AdminLayout`'s inline script and the two stores run when their
   * React islands mount — so a failed attempt has already settled by the time
   * the second and third ask. Without a remembered failure each of them starts
   * its OWN shell fetch and then makes its own fallback call anyway: six
   * requests, where this module's contract is "worst case, the old three".
   *
   * A 401 is the live case (an expired session, where every endpoint 401s), so
   * it is the one pinned here; the same window covers a 500, a network error
   * and an unreadable body.
   */
  it('remembers a failed load for one window, so a failing shell is not re-probed per consumer', async () => {
    const token = tokenFor('user-1');
    const mock = mockShellFetch((url) =>
      url.endsWith('admin-shell')
        ? { status: 401, body: { error: 'Unauthorized' } }
        : { status: 200, body: { authenticated: false, isAdmin: false } }
    );
    restoreFetch = mock.restore;

    // Sequentially, exactly as the three consumers actually arrive.
    await fetchAdminAccessStateViaShell(token);
    assert.equal(await takeAdminShellSection(token, 'requests'), null);
    assert.equal(await takeAdminShellSection(token, 'me'), null);

    assert.equal(
      mock.urls.filter((url) => url.endsWith('admin-shell')).length,
      1,
      `one failed attempt per window, got: ${mock.urls.join(', ')}`
    );
    // A failure is NOT the sticky 404: the next window may try again.
    assert.equal(isAdminShellUnavailable(), false);
    resetAuthExpiryForTests();
  });
});
