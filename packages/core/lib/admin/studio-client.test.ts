import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

// Registers the site-identity config provider (drlurie) — `getSiteIdentity()`
// throws without it. Same pattern library-client.test.ts uses.
import '../../../../sites/drlurie/config/policy-bindings.js';

import { getSiteIdentity } from '../site-identity.js';
import {
  fetchStudioData,
  invalidateStudioCache,
  peekCachedStudioData,
  STUDIO_CACHE_TTL_MS,
  type GetToken,
  type StudioRecord,
} from './studio-client.js';

const getToken: GetToken = async () => 'test-token';

const record = (id: string, type: 'template' | 'section_template' | 'theme' | 'visual_standard'): StudioRecord =>
  ({
    object_id: id,
    object_type: type,
    schema_version: `${type}.v1`,
    site: 'site_test',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    status: 'active',
    body: { name: id },
    publication: { published_time: null, publish_receipt: null },
    history: [],
    version: 1,
    content_revision: 1,
  }) as unknown as StudioRecord;

/**
 * Routes `list`/`get` verb calls the way the real admin-object endpoint
 * would for a small fixed catalog per type — lets a test assert exactly how
 * many requests a fetch issued (the whole point of the parallel-vs-serial
 * fix) without depending on real network or timing.
 *
 * M3.3: this mock answers `visual_identity_snapshot` with a 400, which is what
 * an endpoint that does not know the action does — so every case below now
 * exercises the FALLBACK path (one refused snapshot call, then the four lists
 * and their gets). That is deliberate: the seventeen-call path is still the
 * repair, and it still has to be right. The snapshot path has its own cases at
 * the end of this file.
 */
const mockObjectVerb = (catalog: Record<string, string[]>) => {
  const calls: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push(body);
    if (body.action === 'list') {
      const type = body.object_type as string;
      const ids = catalog[type] ?? [];
      return new Response(JSON.stringify({ objects: ids.map((id) => ({ object_id: id })) }), { status: 200 });
    }
    if (body.action === 'get') {
      const type = body.object_type as 'template' | 'section_template' | 'theme' | 'visual_standard';
      const id = body.object_id as string;
      return new Response(JSON.stringify({ record: record(id, type) }), { status: 200 });
    }
    return new Response(JSON.stringify({ error: 'unexpected action' }), { status: 400 });
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
  invalidateStudioCache();
  originalSessionStorage = (globalThis as { sessionStorage?: Storage }).sessionStorage;
  (globalThis as { sessionStorage: Storage }).sessionStorage = new MemoryStorage() as unknown as Storage;
});

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  invalidateStudioCache();
  if (originalSessionStorage === undefined) {
    delete (globalThis as { sessionStorage?: Storage }).sessionStorage;
  } else {
    (globalThis as { sessionStorage: Storage }).sessionStorage = originalSessionStorage;
  }
});

describe('fetchStudioData — parallel per-id fetching', () => {
  it('fetches every id for every type without waiting on prior ids (one list + N gets per type, all concurrent)', async () => {
    const mock = mockObjectVerb({
      template: ['tpl_a', 'tpl_b'],
      section_template: ['stpl_a'],
      theme: ['thm_a', 'thm_b', 'thm_c'],
    });
    restoreFetch = mock.restore;

    const data = await fetchStudioData(getToken);

    assert.equal(data.templates.length, 2);
    assert.equal(data.sections.length, 1);
    assert.equal(data.themes.length, 3);
    assert.deepEqual(data.standards, [], 'a catalog with no visual_standard yields an empty collection, never a failure');
    // 1 refused `visual_identity_snapshot` + 4 `list` calls + 6 `get` calls =
    // 11 total; the count itself doesn't prove parallelism, but confirms every
    // id across all four types was actually fetched, not silently dropped by
    // the switch to Promise.all.
    assert.equal(mock.calls.length, 11);
  });

  it('a slow id does not block the rest of its type from resolving (proves concurrency, not just correctness)', async () => {
    const calls: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      // M3.3: an endpoint that does not know the snapshot action, so this case
      // keeps testing what it was written to test — the per-id fallback.
      if (body.action === 'visual_identity_snapshot') {
        return new Response(JSON.stringify({ error: 'unknown action' }), { status: 400 });
      }
      if (body.action === 'list') {
        // Only the `template` type carries ids — the other three
        // list empty, so the ids and call count below stay unambiguous.
        const ids = body.object_type === 'template' ? [{ object_id: 'tpl_slow' }, { object_id: 'tpl_fast' }] : [];
        return new Response(JSON.stringify({ objects: ids }), { status: 200 });
      }
      const id = body.object_id as string;
      calls.push(id);
      if (id === 'tpl_slow') {
        // Never resolves within this test's lifetime on its own — if the
        // implementation regressed to a serial loop, `tpl_fast` would never
        // even be requested, and `calls` would stop at one entry.
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return new Response(JSON.stringify({ record: record(id, 'template') }), { status: 200 });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };

    await fetchStudioData(getToken);

    // Both ids were requested up front — the fast one didn't wait on the slow one to even start.
    assert.deepEqual(calls.sort(), ['tpl_fast', 'tpl_slow']);
  });
});

describe('fetchStudioData — TTL cache', () => {
  it('a call within the TTL window returns cached data without a network request', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    const first = await fetchStudioData(getToken);
    const callsAfterFirst = mock.calls.length;
    const second = await fetchStudioData(getToken);

    assert.equal(mock.calls.length, callsAfterFirst);
    assert.deepEqual(first, second);
  });

  it('TTL expiry triggers a refetch', async (t) => {
    t.mock.timers.enable({ apis: ['Date'] });
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    await fetchStudioData(getToken);
    const callsAfterFirst = mock.calls.length;

    t.mock.timers.tick(STUDIO_CACHE_TTL_MS + 1);

    await fetchStudioData(getToken);
    assert.equal(mock.calls.length, callsAfterFirst * 2);
  });
});

describe('fetchStudioData — in-flight de-dup', () => {
  it('concurrent calls share one underlying fetch', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    const [r1, r2] = await Promise.all([fetchStudioData(getToken), fetchStudioData(getToken)]);

    assert.deepEqual(r1, r2);
    // One refused snapshot call, one fetch listing all 4 types
    // (template/section_template/theme/visual_standard) plus one get for the
    // single templated id = 6 calls total, not 12 — the second caller reused
    // the first's in-flight promise rather than firing its own independent
    // sweep.
    assert.equal(mock.calls.length, 6);
  });
});

describe('fetchStudioData — force', () => {
  it('force:true bypasses the TTL cache and always issues a fresh request', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    await fetchStudioData(getToken);
    const callsAfterFirst = mock.calls.length;
    await fetchStudioData(getToken, { force: true });

    assert.equal(mock.calls.length, callsAfterFirst * 2);
  });
});

describe('invalidateStudioCache', () => {
  it('clears the in-memory + in-flight state so the next call is forced to hit the network', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    await fetchStudioData(getToken);
    const callsAfterFirst = mock.calls.length;
    // Still well within the TTL window — without invalidation this would be a cache hit.
    invalidateStudioCache();
    await fetchStudioData(getToken);

    assert.equal(mock.calls.length, callsAfterFirst * 2);
  });

  it('clears the persisted sessionStorage entry too', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;
    const key = `${getSiteIdentity().siteSlug}-studio-cache`;

    await fetchStudioData(getToken);
    assert.ok((globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key));

    invalidateStudioCache();
    assert.equal((globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key), null);
    assert.equal(peekCachedStudioData(), null);
  });
});

describe('sessionStorage persistence', () => {
  it('a successful fetch persists all four collections + a timestamp under the site-scoped key, never tokens', async () => {
    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: ['stpl_a'], theme: ['thm_a'] });
    restoreFetch = mock.restore;

    await fetchStudioData(getToken);

    const key = `${getSiteIdentity().siteSlug}-studio-cache`;
    const raw = (globalThis as { sessionStorage: Storage }).sessionStorage.getItem(key);
    assert.ok(raw);
    const parsed = JSON.parse(raw as string) as {
      data: { templates: unknown[]; sections: unknown[]; themes: unknown[]; standards: unknown[] };
      fetchedAt: number;
    };
    assert.equal(parsed.data.templates.length, 1);
    assert.equal(parsed.data.sections.length, 1);
    assert.equal(parsed.data.themes.length, 1);
    assert.deepEqual(parsed.data.standards, []);
    assert.equal(typeof parsed.fetchedAt, 'number');
    assert.equal((raw as string).includes('token'), false);
  });

  it('peekCachedStudioData reads a persisted entry back when the in-memory cache is empty', () => {
    // Simulate a fresh page load: nothing fetched yet this "page", but a
    // prior page already wrote sessionStorage.
    const key = `${getSiteIdentity().siteSlug}-studio-cache`;
    const entry = {
      data: { templates: [record('tpl_persisted', 'template')], sections: [], themes: [], standards: [] },
      fetchedAt: Date.now(),
    };
    (globalThis as { sessionStorage: Storage }).sessionStorage.setItem(key, JSON.stringify(entry));

    const cached = peekCachedStudioData();
    assert.equal(cached?.data.templates[0]?.object_id, 'tpl_persisted');
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

    const mock = mockObjectVerb({ template: ['tpl_a'], section_template: [], theme: [] });
    restoreFetch = mock.restore;

    // Should not throw even though every sessionStorage call throws.
    const data = await fetchStudioData(getToken);
    assert.equal(data.templates.length, 1);
    assert.doesNotThrow(() => invalidateStudioCache());
  });
});

describe('fetchStudioData — non-200 behavior', () => {
  it('throws with the server error message when a type listing fails', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      if (body.action === 'list' && body.object_type === 'theme') {
        return new Response(JSON.stringify({ error: 'nope' }), { status: 500 });
      }
      if (body.action === 'list') {
        return new Response(JSON.stringify({ objects: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 400 });
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };

    await assert.rejects(() => fetchStudioData(getToken), /nope/);
  });
});

/**
 * M3.3 — the one call that replaces seventeen.
 *
 * The page used to issue four `list`s and one `get` per id across four object
 * types: seventeen `admin-object` invocations on drluriescience, each paying
 * the same fixed per-invocation platform overhead. These cases pin the count
 * at ONE, and pin what happens when the server cannot answer it.
 */
const snapshotBody = () => ({
  action: 'visual_identity_snapshot',
  as_of: '2026-09-16T00:00:00.000Z',
  records: {
    template: [record('tpl_a', 'template'), record('tpl_b', 'template')],
    section_template: [record('stpl_a', 'section_template')],
    theme: [record('thm_a', 'theme')],
    visual_standard: [record('vis_house', 'visual_standard')],
  },
});

const mockSnapshot = (respond: (body: Record<string, unknown>) => Response) => {
  const calls: Array<Record<string, unknown>> = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    calls.push(body);
    return respond(body);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

describe('fetchStudioData — the visual-identity snapshot (M3.3)', () => {
  it('ONE call answers all four collections', async () => {
    const mock = mockSnapshot((body) =>
      body.action === 'visual_identity_snapshot'
        ? new Response(JSON.stringify(snapshotBody()), { status: 200 })
        : new Response(JSON.stringify({ error: 'the snapshot path must not fall back here' }), { status: 500 })
    );
    restoreFetch = mock.restore;

    const data = await fetchStudioData(getToken);

    assert.equal(mock.calls.length, 1, 'seventeen calls became one');
    assert.equal(mock.calls[0]?.action, 'visual_identity_snapshot');
    assert.equal(data.templates.length, 2);
    assert.equal(data.sections.length, 1);
    assert.equal(data.themes.length, 1);
    assert.equal(data.standards.length, 1);
    assert.equal(data.standards[0]?.object_id, 'vis_house');
  });

  it('a body that is not the promised shape falls back to the per-type reads rather than painting an empty studio', async () => {
    const mock = mockSnapshot((body) => {
      if (body.action === 'visual_identity_snapshot') {
        // `theme` missing entirely — the shape a partial or older answer has.
        return new Response(JSON.stringify({ records: { template: [], section_template: [] } }), { status: 200 });
      }
      if (body.action === 'list') return new Response(JSON.stringify({ objects: [] }), { status: 200 });
      return new Response(JSON.stringify({ error: 'unexpected' }), { status: 400 });
    });
    restoreFetch = mock.restore;

    const data = await fetchStudioData(getToken);
    assert.deepEqual(
      mock.calls.map((call) => call.action),
      ['visual_identity_snapshot', 'list', 'list', 'list', 'list']
    );
    assert.deepEqual(data, { templates: [], sections: [], themes: [], standards: [] });
  });

  it('a broken connection still throws — it is never answered with seventeen more requests', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      throw new Error('network down');
    }) as typeof fetch;
    restoreFetch = () => {
      globalThis.fetch = originalFetch;
    };

    await assert.rejects(() => fetchStudioData(getToken), /network down/);
    assert.equal(calls, 1);
  });
});
