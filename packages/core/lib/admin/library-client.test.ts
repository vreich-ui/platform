import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Registers the site-identity config provider (drlurie) — `getSiteIdentity()`
// throws without it. Same pattern object-review-ui.test.ts uses.
import '../../../../sites/drlurie/config/policy-bindings.js';

import { getSiteIdentity } from '../site-identity.js';
import {
  fetchInventoryRows,
  freshCachedInventoryRows,
  invalidateInventoryCache,
  peekCachedInventoryRows,
  INVENTORY_CACHE_TTL_MS,
  type GetToken,
} from './library-client.js';
import type { LibraryRow } from './library-logic.js';

const getToken: GetToken = async () => 'test-token';

const row = (id: string): LibraryRow => ({
  object_id: id,
  object_type: 'page',
  display_name: id,
  updated_at: '2026-08-01T00:00:00.000Z',
  status: 'active',
  review_state: 'none',
  published_time: null,
  unpublished_changes: false,
});

const mockFetch = (respond: () => Record<string, unknown>, status = 200) => {
  const calls: unknown[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(init?.body ? JSON.parse(String(init.body)) : undefined);
    return new Response(JSON.stringify(respond()), { status });
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

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

let restoreFetch: (() => void) | undefined;
let originalSessionStorage: Storage | undefined;

beforeEach(() => {
  invalidateInventoryCache();
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  invalidateInventoryCache();
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
});

describe('fetchInventoryRows — in-flight de-dup', () => {
  it('concurrent calls share one underlying request', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    // Both calls fire in the same synchronous frame (as Promise.all's
    // arguments are evaluated left-to-right before anything awaits) — the
    // second must see the first's in-flight promise and reuse it.
    const [r1, r2] = await Promise.all([fetchInventoryRows(getToken), fetchInventoryRows(getToken)]);

    assert.equal(mock.calls.length, 1);
    assert.deepEqual(r1, [row('a')]);
    assert.deepEqual(r2, [row('a')]);
  });
});

describe('fetchInventoryRows — TTL cache', () => {
  it('a call within the TTL window returns cached rows without a network request', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    const first = await fetchInventoryRows(getToken);
    const second = await fetchInventoryRows(getToken);

    assert.equal(mock.calls.length, 1);
    assert.deepEqual(first, [row('a')]);
    assert.deepEqual(second, [row('a')]);
  });

  it('TTL expiry triggers a refetch', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    await fetchInventoryRows(getToken);
    assert.equal(mock.calls.length, 1);

    t.mock.timers.tick(INVENTORY_CACHE_TTL_MS + 1);

    await fetchInventoryRows(getToken);
    assert.equal(mock.calls.length, 2);
  });
});

describe('fetchInventoryRows — force', () => {
  it('force:true bypasses the TTL cache and always issues a fresh request', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    await fetchInventoryRows(getToken);
    await fetchInventoryRows(getToken, { force: true });
    await fetchInventoryRows(getToken, { force: true });

    assert.equal(mock.calls.length, 3);
  });

  it('force:true bypasses in-flight de-dup too — a concurrent forced call issues its own request', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    const [r1, r2] = await Promise.all([fetchInventoryRows(getToken), fetchInventoryRows(getToken, { force: true })]);

    assert.equal(mock.calls.length, 2);
    assert.deepEqual(r1, [row('a')]);
    assert.deepEqual(r2, [row('a')]);
  });
});

describe('invalidateInventoryCache', () => {
  it('clears the in-memory + in-flight state so the next call is forced to hit the network', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    await fetchInventoryRows(getToken);
    assert.equal(mock.calls.length, 1);
    // Still well within the TTL window — without invalidation this would be a cache hit.
    invalidateInventoryCache();
    await fetchInventoryRows(getToken);

    assert.equal(mock.calls.length, 2);
  });

  it('clears the persisted sessionStorage entry too', async () => {
    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;
    const key = `${getSiteIdentity().siteSlug}-inventory-cache`;

    await fetchInventoryRows(getToken);
    assert.ok((globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key));

    invalidateInventoryCache();
    assert.equal((globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key), null);
    assert.equal(peekCachedInventoryRows(), null);
  });
});

describe('sessionStorage persistence', () => {
  it('a successful fetch persists rows + a timestamp under the site-scoped key, never tokens', async () => {
    const mock = mockFetch(() => ({ objects: [row('a'), row('b')] }));
    restoreFetch = mock.restore;

    await fetchInventoryRows(getToken);

    const key = `${getSiteIdentity().siteSlug}-inventory-cache`;
    const raw = (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key);
    assert.ok(raw);
    const parsed = JSON.parse(raw as string) as { rows: LibraryRow[]; fetchedAt: number };
    assert.deepEqual(parsed.rows, [row('a'), row('b')]);
    assert.equal(typeof parsed.fetchedAt, 'number');
    assert.equal((raw as string).includes('token'), false);
  });

  it('peekCachedInventoryRows reads a persisted entry back when the in-memory cache is empty', () => {
    // Simulate a fresh page load: nothing fetched yet this "page", but a
    // prior page already wrote sessionStorage.
    const key = `${getSiteIdentity().siteSlug}-inventory-cache`;
    const entry = { rows: [row('persisted')], fetchedAt: Date.now() };
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(key, JSON.stringify(entry));

    const cached = peekCachedInventoryRows();
    assert.deepEqual(cached?.rows, [row('persisted')]);
  });

  it('freshCachedInventoryRows accepts fresh persisted rows and rejects stale rows', () => {
    const key = `${getSiteIdentity().siteSlug}-inventory-cache`;
    const now = Date.parse('2026-08-09T12:00:00.000Z');
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(
      key,
      JSON.stringify({ rows: [row('persisted')], fetchedAt: now - 1_000 })
    );

    assert.deepEqual(freshCachedInventoryRows(now), [row('persisted')]);
    assert.equal(freshCachedInventoryRows(now + 11 * 60_000), null);
  });

  it('degrades gracefully when sessionStorage throws (private browsing)', async () => {
    (globalThis as { sessionStorage: Storage }).sessionStorage = {
      getItem() {
        throw new Error('SecurityError: storage disabled');
      },
      setItem() {
        throw new Error('SecurityError: storage disabled');
      },
      removeItem() {
        throw new Error('SecurityError: storage disabled');
      },
      clear() {},
      key() {
        return null;
      },
      length: 0,
    } as unknown as Storage;

    const mock = mockFetch(() => ({ objects: [row('a')] }));
    restoreFetch = mock.restore;

    // Should not throw even though every sessionStorage call throws.
    const rows = await fetchInventoryRows(getToken);
    assert.deepEqual(rows, [row('a')]);
    assert.doesNotThrow(() => invalidateInventoryCache());
  });
});

describe('fetchInventoryRows — non-200 behavior (unchanged)', () => {
  it('throws with the server error message on a non-200 response', async () => {
    const mock = mockFetch(() => ({ error: 'nope' }), 500);
    restoreFetch = mock.restore;

    await assert.rejects(() => fetchInventoryRows(getToken), /nope/);
  });

  it('throws a generic message when the server omits an error field', async () => {
    const mock = mockFetch(() => ({}), 500);
    restoreFetch = mock.restore;

    await assert.rejects(() => fetchInventoryRows(getToken), /Inventory request failed \(500\)/);
  });
});
