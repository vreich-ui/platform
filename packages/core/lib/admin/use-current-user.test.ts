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
// Module scope, like everything else here, and now reachable from EVERY case
// in this file: the cases below hold a signed-in session (the persisted
// snapshot is keyed by its subject), so `readMe` offers the coalesced call on
// every refresh and leaves the shell client's own state behind it.
import { resetAdminShellClientForTests } from './admin-shell-client.js';

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

const user = (email: string): UserView => ({ email, display_name: email.split('@')[0] }) as unknown as UserView;

/**
 * An unsigned JWT-shaped token with the given `sub` — cache-keying only;
 * nothing in this module verifies it. `iat` makes two tokens for the SAME
 * subject byte-distinct strings (a refreshed token for the same person),
 * which is exactly what the subject-keyed-not-token-keyed case needs. Same
 * helper `admin-access-client.test.ts` uses, for the same key derivation.
 */
let tokenSerial = 0;
const tokenFor = (sub: string): string => {
  const b64url = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  tokenSerial += 1;
  return `${b64url({ alg: 'none' })}.${b64url({ sub, iat: tokenSerial })}.sig`;
};

/**
 * A signed-in goTrue session in a stand-in `localStorage`, the way the browser
 * holds one.
 *
 * Every case that touches the persisted cache needs one now: the snapshot is
 * keyed by the SUBJECT of the session's access token, so a tab with no
 * readable session has nothing to read or write — which is itself one of the
 * cases below.
 */
const cacheKeyFor = (sub: string) => `${getSiteIdentity().siteSlug}-current-user-cache-${sub}`;

const signInAs = (sub: string): string => {
  const token = tokenFor(sub);
  const store = new MemoryStorage() as unknown as Storage;
  store.setItem(
    `${getSiteIdentity().siteSlug}-gotrue-user`,
    JSON.stringify({
      id: sub,
      email: `${sub}@x.test`,
      token: {
        access_token: token,
        refresh_token: 'refresh',
        // Comfortably past `CURRENT_USER_CACHE_TTL_MS`, so the TTL case below
        // can shift `Date.now()` forward without also expiring the session.
        expires_at: Date.now() + 3_600_000,
        token_type: 'bearer',
      },
    })
  );
  (globalThis as { localStorage: Storage }).localStorage = store;
  return token;
};

/** Storage with no goTrue user in it — `currentUser()` answers null, so there is no subject to key by. */
const signOutSession = (): void => {
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
};

const DEFAULT_SUB = 'sub-default';

let restoreFetch: (() => void) | undefined;
let originalSessionStorage: Storage | undefined;
let originalLocalStorage: Storage | undefined;

beforeEach(() => {
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
  signInAs(DEFAULT_SUB);
  resetCurrentUserForTests();
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  resetCurrentUserForTests();
  // A signed-in session means `readMe` reaches `takeAdminShellSection` on
  // every refresh, so this file now leaves shell-client state (a sticky 404,
  // a remembered failure, an untaken handoff) behind it. Reset it here rather
  // than in one describe, or the first case that DOES care about the
  // coalesced call inherits the previous case's verdict.
  resetAdminShellClientForTests();
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
  if (originalLocalStorage === undefined) {
    delete (globalThis as { localStorage?: Storage }).localStorage;
  } else {
    (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
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
    const key = cacheKeyFor(DEFAULT_SUB);
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
    const key = cacheKeyFor(DEFAULT_SUB);
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

/**
 * The snapshot is keyed by the token's SUBJECT, the same way
 * `admin-access-client.ts` keys its own `-admin-access-cache-<sub>` entry —
 * and these are that module's cases, mirrored, because this entry holds
 * strictly more: e-mail, display name, roles, onboarding, and since T-shell
 * the whole membership policy. A site-wide key left all of it readable by, and
 * paintable for, whoever was at the keyboard in this tab next.
 */
describe('the persisted snapshot is scoped to the signed-in subject', () => {
  it('a different token with the same subject hits the same entry (subject-keyed, not token-keyed)', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser();
    assert.equal(peekCachedCurrentUser()?.state.user?.email, 'a@x.test');

    // A refreshed token for the SAME person is a different string with the
    // same `sub` — keying by the token itself would lose the entry on every
    // silent refresh, which is the whole reason the subject is the key.
    const refreshed = signInAs(DEFAULT_SUB);
    assert.notEqual(refreshed, '');
    assert.equal(peekCachedCurrentUser()?.state.user?.email, 'a@x.test');
  });

  it('a different subject never inherits another subject’s entry', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('alice@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser();
    assert.equal(peekCachedCurrentUser()?.state.user?.email, 'alice@x.test');

    // Same tab, same `sessionStorage`, different person: Alice's roles and
    // e-mail must be unreachable, and nothing may paint from them.
    signInAs('sub-bob');
    assert.equal(peekCachedCurrentUser(), null);
    resetCurrentUserForTests();
    hydrateFromCacheOnce();
    assert.equal(currentUserSnapshot().user, null, 'Bob must not paint as Alice');
    assert.equal(currentUserSnapshot().loading, true);
  });

  it('a tab with no readable session writes nothing at all', async () => {
    signOutSession();
    restoreFetch = mockFetchMe(() => ({ body: { user: user('a@x.test'), roles: ['owner'] } }));
    const result = await refreshCurrentUser();

    // The live snapshot still resolves — only the PERSISTED copy is withheld,
    // because there is no subject to scope it to and an unscoped entry is
    // exactly the one that must not exist.
    assert.equal(result.user?.email, 'a@x.test');
    assert.equal(peekCachedCurrentUser(), null);
    assert.equal((globalThis as { sessionStorage: Storage }).sessionStorage.length, 0);
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

  /**
   * The sweep case, mirrored from `clearCachedAdminAccessState`: at sign-out
   * the token is usually already gone, so there is no subject left to derive
   * and a targeted `removeItem` would remove NOTHING. Every subject this tab
   * ever wrote has to go — including the flat, un-scoped key an older deploy
   * left behind, which is the very entry this keying exists to stop writing.
   */
  it('drops every subject’s entry, even with the session already gone', async () => {
    restoreFetch = mockFetchMe(() => ({ body: { user: user('alice@x.test'), roles: ['owner'] } }));
    await refreshCurrentUser();
    // A second person on the same keyboard. Deliberately NOT via
    // `resetCurrentUserForTests` — that sweeps the persisted copy, which is
    // the very thing this case needs two of.
    signInAs('sub-bob');
    await refreshCurrentUser();

    const storage = (globalThis as { sessionStorage: Storage }).sessionStorage;
    storage.setItem(
      // The pre-T-shell key shape, written by a deploy that predates this.
      `${getSiteIdentity().siteSlug}-current-user-cache`,
      JSON.stringify({ state: { user: user('legacy@x.test'), roles: [], loading: false }, fetchedAt: Date.now() })
    );
    assert.ok(storage.length >= 3, 'two subjects plus the legacy key must be present to sweep');

    // Signed out FIRST, exactly as `cms:logout` leaves the tab.
    signOutSession();
    invalidateCurrentUser();
    assert.equal(storage.length, 0, 'no resolved identity may survive sign-out in this tab');
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

// ─── T-shell: `me` out of the coalesced `admin-shell` call ───────────────────
//
// `me` was one of three requests every `/admin/*` navigation fired.
// `Server-Timing` measured the reason that mattered: `admin-auth-state` does
// 0.02 ms of server work for 242-683 ms on the wire, so the per-click floor
// was three round trips of fixed per-invocation overhead, not three slow
// functions. This store now takes `me` out of the one shell response the gate
// and the requests index are served from — and calls `admin-users{verb:'me'}`
// itself whenever the shell cannot answer.
const SHELL_URL = '/.netlify/functions/admin-shell';
const USERS_URL = '/.netlify/functions/admin-users';

// This store resolves its own bearer through `goTrueClient`, and the shell
// client refuses to spend a request without one — so a signed-in session has
// to exist for these cases at all. The file-level `beforeEach` now installs
// one (`signInAs(DEFAULT_SUB)`), because the persisted snapshot is keyed by
// that session's subject, and the file-level `afterEach` resets the shell
// client; these cases need nothing of their own.

/** Routes by endpoint, so "the shell replaced the admin-users call" is an assertion. */
const mockShellAndUsers = (routes: Record<string, () => { status?: number; body: unknown }>) => {
  const original = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const route = routes[url];
    if (!route) return new Response('{}', { status: 404 });
    const { status = 200, body } = route();
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return {
    urls,
    countOf: (url: string) => urls.filter((seen) => seen === url).length,
    restore: () => {
      globalThis.fetch = original;
    },
  };
};

const POLICY = {
  invite_ttl_hours: 168,
  max_resends: 5,
  default_role: 'admin',
  min_owners: 1,
  require_display_name: false,
  purge_grace_days: 30,
  who_can_invite: 'owner',
  roles_admin_may_grant: [],
  default_role_for_external: 'viewer',
  delete_identity_on_remove: true,
};

const shellBody = (over: Record<string, unknown> = {}) => ({
  ok: true,
  status: 200,
  sections: {
    access: { status: 'ok', data: { authenticated: true, isAdmin: true, roles: ['owner'] } },
    requests: { status: 'ok', data: { requests: [], total: 0, seq: 1 } },
    me: { status: 'ok', data: { user: user('a@x.test'), roles: ['owner'], onboarding: null, policy: POLICY } },
    ...over,
  },
});

describe('T-shell — refreshCurrentUser through the coalesced call', () => {
  it('resolves `me` from the shell section and never calls admin-users', async () => {
    const mock = mockShellAndUsers({ [SHELL_URL]: () => ({ body: shellBody() }) });
    restoreFetch = mock.restore;

    const state = await refreshCurrentUser();
    assert.equal(state.user?.email, 'a@x.test');
    assert.deepEqual(state.roles, ['owner']);
    assert.equal(mock.countOf(USERS_URL), 0, 'the coalesced call must replace the dedicated one');
    assert.equal(mock.countOf(SHELL_URL), 1);
  });

  /**
   * The `/admin/settings/admins` three-call fix, from this end: the whole
   * membership policy rides `me`, so the members page's role picker no longer
   * spends a third `admin-users` round trip on `policy_get` for a record `me`
   * had already read.
   */
  it('carries the whole membership policy through to the snapshot', async () => {
    restoreFetch = mockShellAndUsers({ [SHELL_URL]: () => ({ body: shellBody() }) }).restore;
    const state = await refreshCurrentUser();
    assert.equal(state.policy?.who_can_invite, 'owner');
    assert.deepEqual(state.policy?.roles_admin_may_grant, []);
    // The one field this state already exposed keeps its own shape.
    assert.equal(state.requireDisplayName, false);
    // …and it is persisted with the rest, so the next page paints from it.
    assert.equal(peekCachedCurrentUser()?.state.policy?.who_can_invite, 'owner');
  });

  it('falls back to admin-users when the shell marks the me section errored', async () => {
    const mock = mockShellAndUsers({
      [SHELL_URL]: () => ({ body: shellBody({ me: { status: 'error', code: 'read_failed' } }) }),
      [USERS_URL]: () => ({ body: { user: user('b@x.test'), roles: ['editor'] } }),
    });
    restoreFetch = mock.restore;

    // Degradation parity: one section failing must cost only that section.
    const state = await refreshCurrentUser();
    assert.equal(state.user?.email, 'b@x.test');
    assert.deepEqual(state.roles, ['editor']);
    assert.equal(mock.countOf(USERS_URL), 1);
  });

  it('falls back to admin-users on a 404 — a client loaded against an older deploy', async () => {
    const mock = mockShellAndUsers({ [USERS_URL]: () => ({ body: { user: user('c@x.test'), roles: ['admin'] } }) });
    restoreFetch = mock.restore;

    const state = await refreshCurrentUser();
    assert.equal(state.user?.email, 'c@x.test');
    assert.deepEqual(mock.urls, [SHELL_URL, USERS_URL]);
  });
});
