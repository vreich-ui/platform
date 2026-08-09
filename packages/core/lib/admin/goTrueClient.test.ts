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

    const [first, second, token] = await Promise.all([
      handleOAuthCallback(),
      handleOAuthCallback(),
      getAccessToken(),
    ]);

    assert.equal(userInfoCalls, 1);
    assert.equal(first?.email, 'editor@example.com');
    assert.equal(second?.email, 'editor@example.com');
    assert.equal(token, 'callback-token');
  });
});
