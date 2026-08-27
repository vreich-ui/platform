/**
 * T5.1 R2 / R8 — the client-side round-trip COUNTS.
 *
 * T0.2's acceptance criterion is a before/after measurement, and the honest
 * measurable unit here is "how many times does the browser hit the network".
 * These tests pin that number for the two mechanisms this task added on the
 * client:
 *
 *  - `release-client`'s module TTL + in-flight dedupe. `admin-release-state`
 *    was T0.2's single most expensive read (a full store sweep, two Netlify
 *    API calls and one GitHub `/compare` per publish commit), and it had SEVEN
 *    call sites, several firing on the same page load.
 *  - `listRequestsIfChanged`'s conditional protocol against the busiest
 *    endpoint in the admin.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import '../../../../sites/drlurie/config/policy-bindings.js';

import {
  fetchReleaseOverview,
  invalidateReleaseOverview,
  RELEASE_OVERVIEW_TTL_MS,
  type ReleaseOverview,
} from './release-client.js';
import { listRequestsIfChanged } from './requests-client.js';
import type { GetToken } from '../edit-mode/verbs-client.js';

const getToken: GetToken = async () => 'test-token';

const overview = (): ReleaseOverview => ({
  deploy: {
    configured: true,
    state: 'ready',
    production_confirmed: true,
    live_commit: 'abc123',
    latest: null,
    published: null,
  },
  objects: [],
  waiting_count: 0,
  pending_approval_count: 0,
});

type Recorded = { headers: Record<string, string>; body: unknown };

const mockFetch = (respond: (call: number) => Response) => {
  const calls: Recorded[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      headers: { ...((init?.headers as Record<string, string> | undefined) ?? {}) },
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return respond(calls.length);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = originalFetch;
    },
  };
};

const json = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers });

describe('release-client: one request where there were several (T5.1 R2, T0.2 F2)', () => {
  afterEach(() => invalidateReleaseOverview());

  it('FOUR concurrent callers — the shape of one page load — make ONE request', async () => {
    const mock = mockFetch(() => json(overview()));
    try {
      // `/admin/content/<id>` fired this twice on its own; the objects plane
      // has two effects that both want it; the shell surfaces add more.
      const results = await Promise.all([
        fetchReleaseOverview(getToken),
        fetchReleaseOverview(getToken),
        fetchReleaseOverview(getToken),
        fetchReleaseOverview(getToken),
      ]);
      assert.equal(mock.calls.length, 1, 'four call sites, one store sweep (was four)');
      assert.equal(results[0]?.deploy.live_commit, 'abc123');
      assert.deepEqual(results[1], results[0]);
    } finally {
      mock.restore();
    }
  });

  it('a later caller inside the TTL is served from module scope with no request at all', async () => {
    const mock = mockFetch(() => json(overview()));
    try {
      await fetchReleaseOverview(getToken);
      await fetchReleaseOverview(getToken);
      assert.equal(mock.calls.length, 1, 'the second navigation costs nothing');
      assert.ok(RELEASE_OVERVIEW_TTL_MS <= 15_000, 'T0.2 R2 caps the staleness window at 15s');
    } finally {
      mock.restore();
    }
  });

  it('`force` and `invalidateReleaseOverview` both defeat the cache, so an editor never waits out the TTL for their own change', async () => {
    const mock = mockFetch(() => json(overview()));
    try {
      await fetchReleaseOverview(getToken);
      await fetchReleaseOverview(getToken, { force: true });
      assert.equal(mock.calls.length, 2);
      invalidateReleaseOverview();
      await fetchReleaseOverview(getToken);
      assert.equal(mock.calls.length, 3);
    } finally {
      mock.restore();
    }
  });

  it('a failed fetch is not cached and does not poison the next caller', async () => {
    const mock = mockFetch((call) =>
      call === 1 ? new Response(JSON.stringify({ error: 'nope' }), { status: 500 }) : json(overview())
    );
    try {
      await assert.rejects(() => fetchReleaseOverview(getToken), /nope/);
      const second = await fetchReleaseOverview(getToken);
      assert.equal(second.deploy.state, 'ready');
      assert.equal(mock.calls.length, 2);
    } finally {
      mock.restore();
    }
  });
});

describe('listRequestsIfChanged: conditional polling (T5.1 R8, T0.2 F12)', () => {
  const listBody = { requests: [], total: 0, seq: 1, muted: [], last_notified: {}, email_mode: 'immediate' };

  it('sends no If-None-Match on the first poll and returns the etag it was given', async () => {
    const mock = mockFetch(() => json(listBody, { ETag: '"v1"' }));
    try {
      const result = await listRequestsIfChanged(getToken, { limit: 200 }, undefined);
      assert.equal(mock.calls[0]?.headers['If-None-Match'], undefined);
      assert.equal(result.unchanged, false);
      assert.equal(result.etag, '"v1"');
    } finally {
      mock.restore();
    }
  });

  it('replays the etag and reports `unchanged` on a 304 — no body crosses the wire', async () => {
    const mock = mockFetch(() => new Response(null, { status: 304, headers: { ETag: '"v1"' } }));
    try {
      const result = await listRequestsIfChanged(getToken, { limit: 200 }, '"v1"');
      assert.equal(mock.calls[0]?.headers['If-None-Match'], '"v1"');
      assert.equal(result.unchanged, true);
      assert.equal(result.etag, '"v1"');
    } finally {
      mock.restore();
    }
  });

  it('a server that emits no etag degrades to the unconditional behaviour', async () => {
    const mock = mockFetch(() => json(listBody));
    try {
      const result = await listRequestsIfChanged(getToken, { limit: 200 }, undefined);
      assert.equal(result.unchanged, false);
      assert.equal(result.etag, undefined, 'no etag means every poll stays a full response, exactly as before');
    } finally {
      mock.restore();
    }
  });

  it('an error status still throws rather than being mistaken for "unchanged"', async () => {
    const mock = mockFetch(() => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }));
    try {
      await assert.rejects(() => listRequestsIfChanged(getToken, {}, '"v1"'), /boom/);
    } finally {
      mock.restore();
    }
  });
});
