import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import '../../../../sites/drlurie/config/policy-bindings.js';
import { getAccessToken, handleOAuthCallback, resetOAuthCallbackStateForTests } from './goTrueClient.js';

class MemoryStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const originalFetch = globalThis.fetch;
const originalWindow = (globalThis as { window?: Window }).window;
const originalHistory = (globalThis as { history?: History }).history;
const originalLocalStorage = (globalThis as { localStorage?: Storage }).localStorage;

beforeEach(() => {
  resetOAuthCallbackStateForTests();
  (globalThis as { localStorage: Storage }).localStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  resetOAuthCallbackStateForTests();
  if (originalWindow === undefined) delete (globalThis as { window?: Window }).window;
  else (globalThis as { window: Window }).window = originalWindow;
  if (originalHistory === undefined) delete (globalThis as { history?: History }).history;
  else (globalThis as { history: History }).history = originalHistory;
  if (originalLocalStorage === undefined) delete (globalThis as { localStorage?: Storage }).localStorage;
  else (globalThis as { localStorage: Storage }).localStorage = originalLocalStorage;
});

describe('OAuth callback readiness', () => {
  it('processes a concurrent callback once and gates token reads on it', async () => {
    const location = {
      hash: '#access_token=callback-token&refresh_token=refresh-token&expires_in=3600',
      pathname: '/admin/content',
      search: '',
    };
    (globalThis as { window: Window }).window = { location } as unknown as Window;
    (globalThis as { history: History }).history = {
      replaceState: () => {
        location.hash = '';
      },
    } as unknown as History;

    let userInfoCalls = 0;
    globalThis.fetch = (async () => {
      userInfoCalls += 1;
      await Promise.resolve();
      return new Response(JSON.stringify({ id: 'user-1', email: 'editor@example.com' }), { status: 200 });
    }) as typeof fetch;

    const [first, second, token] = await Promise.all([handleOAuthCallback(), handleOAuthCallback(), getAccessToken()]);

    assert.equal(userInfoCalls, 1);
    assert.equal(first?.email, 'editor@example.com');
    assert.equal(second?.email, 'editor@example.com');
    assert.equal(token, 'callback-token');
  });
});

// ── T18.0b: Identity mail-token consumption ─────────────────────────────────

import {
  acceptInvite,
  acceptRouteFor,
  detectIdentityToken,
  exchangeRecoveryToken,
  handleRecoveryCallback,
  shouldRouteToAccept,
  currentUser,
} from './goTrueClient.js';

describe('detectIdentityToken', () => {
  it('reads each of the four GoTrue mail hashes and nothing else', () => {
    assert.deepEqual(detectIdentityToken('#invite_token=abc'), { kind: 'invite', token: 'abc' });
    assert.deepEqual(detectIdentityToken('#confirmation_token=c1'), { kind: 'confirmation', token: 'c1' });
    assert.deepEqual(detectIdentityToken('#recovery_token=r1'), { kind: 'recovery', token: 'r1' });
    assert.deepEqual(detectIdentityToken('#email_change_token=e1'), { kind: 'email_change', token: 'e1' });
    assert.equal(detectIdentityToken(''), null);
    assert.equal(detectIdentityToken('#'), null);
    assert.equal(detectIdentityToken('#access_token=x&refresh_token=y'), null);
    assert.equal(detectIdentityToken('#access_token=x&type=recovery'), null);
    assert.equal(detectIdentityToken('#invite_token='), null);
  });
});

describe('shouldRouteToAccept (the site-wide router predicate)', () => {
  it('routes any non-accept page carrying a token, and leaves everything else alone', () => {
    assert.equal(shouldRouteToAccept('/', '#invite_token=abc'), true);
    assert.equal(shouldRouteToAccept('/blog/post', '#recovery_token=abc'), true);
    assert.equal(shouldRouteToAccept('/admin', '#confirmation_token=abc'), true);
    assert.equal(shouldRouteToAccept('/admin/accept', '#invite_token=abc'), false);
    assert.equal(shouldRouteToAccept('/admin/accept/', '#invite_token=abc'), false);
    assert.equal(shouldRouteToAccept('/', '#access_token=x'), false);
    assert.equal(shouldRouteToAccept('/', ''), false);
    assert.equal(acceptRouteFor('#invite_token=abc'), '/admin/accept#invite_token=abc');
  });
});

describe('acceptInvite / exchangeRecoveryToken', () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fakeGoTrue = () => {
    calls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/verify')) {
        return new Response(
          JSON.stringify({
            access_token: 'sess-token',
            refresh_token: 'sess-refresh',
            expires_in: 3600,
            token_type: 'bearer',
          }),
          { status: 200 }
        );
      }
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 'u-1', email: 'jane@example.com' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    }) as typeof fetch;
  };

  it('acceptInvite posts type:signup with the password and writes the SESSION (never the token) to storage', async () => {
    fakeGoTrue();
    const user = await acceptInvite('invite-tok', 'correct horse');
    const verify = calls.find((c) => c.url.endsWith('/verify'));
    assert.ok(verify);
    assert.equal(verify?.init?.method, 'POST');
    assert.deepEqual(JSON.parse(String(verify?.init?.body)), {
      type: 'signup',
      token: 'invite-tok',
      password: 'correct horse',
    });
    assert.equal(user.email, 'jane@example.com');
    assert.equal(user.token.access_token, 'sess-token');
    const stored = currentUser();
    assert.equal(stored?.token.access_token, 'sess-token');
    assert.equal(JSON.stringify(stored).includes('invite-tok'), false);
  });

  it('acceptInvite refuses a short password before touching the network', async () => {
    fakeGoTrue();
    await assert.rejects(() => acceptInvite('t', 'short'), /at least 8/);
    assert.equal(calls.length, 0);
  });

  it('exchangeRecoveryToken posts type:recovery without a password', async () => {
    fakeGoTrue();
    const user = await exchangeRecoveryToken('rec-tok');
    const verify = calls.find((c) => c.url.endsWith('/verify'));
    assert.deepEqual(JSON.parse(String(verify?.init?.body)), { type: 'recovery', token: 'rec-tok' });
    assert.equal(user.token.access_token, 'sess-token');
  });

  it('a GoTrue 4xx on /verify surfaces as a status-carrying error', async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ msg: 'Invalid token' }), { status: 404 })) as typeof fetch;
    await assert.rejects(
      () => acceptInvite('bad', 'correct horse'),
      (err: Error & { status?: number }) => err.status === 404 && /Invalid token/.test(err.message)
    );
  });
});

describe('handleRecoveryCallback (both hash shapes)', () => {
  it('returns the access token for the customised type=recovery shape and clears the hash', async () => {
    const location = { hash: '#access_token=rt&type=recovery', pathname: '/', search: '' };
    (globalThis as { window: Window }).window = { location } as unknown as Window;
    (globalThis as { history: History }).history = {
      replaceState: () => {
        location.hash = '';
      },
    } as unknown as History;
    const res = await handleRecoveryCallback();
    assert.deepEqual(res, { recoveryToken: 'rt' });
    assert.equal(location.hash, '');
  });

  it('exchanges the default #recovery_token= shape for a session token', async () => {
    const location = { hash: '#recovery_token=rec-tok', pathname: '/', search: '' };
    (globalThis as { window: Window }).window = { location } as unknown as Window;
    (globalThis as { history: History }).history = {
      replaceState: () => {
        location.hash = '';
      },
    } as unknown as History;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/verify')) {
        return new Response(
          JSON.stringify({ access_token: 'sess-token', refresh_token: 'r', expires_in: 3600, token_type: 'bearer' }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ id: 'u-1', email: 'jane@example.com' }), { status: 200 });
    }) as typeof fetch;
    const res = await handleRecoveryCallback();
    assert.deepEqual(res, { recoveryToken: 'sess-token' });
    assert.equal(location.hash, '');
  });

  it('ignores invite/confirmation/email_change hashes (they belong to /admin/accept)', async () => {
    const location = { hash: '#invite_token=abc', pathname: '/', search: '' };
    (globalThis as { window: Window }).window = { location } as unknown as Window;
    assert.equal(await handleRecoveryCallback(), null);
    assert.equal(location.hash, '#invite_token=abc');
  });
});

describe('OAuth callback ignores Identity mail tokens', () => {
  it('returns null and leaves the hash intact for every token kind', async () => {
    for (const hash of ['#invite_token=a', '#confirmation_token=b', '#recovery_token=c', '#email_change_token=d']) {
      resetOAuthCallbackStateForTests();
      const location = { hash, pathname: '/', search: '' };
      (globalThis as { window: Window }).window = { location } as unknown as Window;
      let fetched = 0;
      globalThis.fetch = (async () => {
        fetched += 1;
        return new Response('{}', { status: 200 });
      }) as typeof fetch;
      assert.equal(await handleOAuthCallback(), null);
      assert.equal(location.hash, hash);
      assert.equal(fetched, 0);
    }
  });
});
