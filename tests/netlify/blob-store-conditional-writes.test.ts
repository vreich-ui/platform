/**
 * P1 — regression test for a real @netlify/blobs bug, not a Platform one.
 *
 * `@netlify/blobs@10.7.0` (the version this repo was pinned to before P1)
 * silently drops `onlyIfNew`/`onlyIfMatch` on `Store.setJSON()`: the option
 * is spread into the wrong shape before it reaches the HTTP client, so no
 * `if-match`/`if-none-match` header is ever sent and the server always
 * performs an unconditional PUT — while the SDK still reports
 * `{ modified: true }` as if the condition had been honoured. `Store.set()`
 * (bytes, not JSON) was unaffected; only the JSON convenience method was
 * broken. Fixed upstream in 10.7.12 (this repo now pins >=10.7.13, P1).
 *
 * A type-level test cannot catch this class of bug — the TypeScript types
 * for `SetOptions` were correct the whole time; the bug was in what the
 * runtime did with a value of that type. So this test talks to the REAL
 * `@netlify/blobs` package (not `blob-store.ts`'s swappable test double) and
 * inspects the actual `fetch` call it makes, the only place this bug is
 * observable at all.
 *
 * If this test ever fails again after a future dependency bump, it means
 * every conditional write in this repo — this choke point's record CAS,
 * `objects/index-doc.ts`'s arm/disarm, `idempotency-store.ts`,
 * `commerce-orders.ts`, `commerce-events.ts`, `tracking-events.ts`,
 * `artifact-upload.ts`, `membership/store.ts`, `agent/chat-store.ts`,
 * `snapshots/guarded-doc.ts` — is silently back to last-write-wins in
 * production. Do not weaken this test to make a downgrade pass.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { getStore } from '@netlify/blobs';

type CapturedRequest = { url: string; init: RequestInit & { headers?: HeadersInit } };

/**
 * A store that never leaves the process: `fetch` is stubbed, no network
 * reaches it. The real SDK's non-edge ("API") path is TWO requests per
 * write — a negotiation request that asks for a one-time signed upload URL
 * (`accept: application/json;type=signed-url`), then the actual conditional
 * PUT against that signed URL, which is the only one of the two that ever
 * carries `if-match`/`if-none-match`. Only that second request is what this
 * regression cares about, so it is the only one captured into `calls`; the
 * first is answered generically so the SDK's own negotiation step succeeds.
 */
const headerValue = (init: RequestInit, name: string): string | undefined => {
  const headers = init.headers;
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  if (Array.isArray(headers)) return headers.find(([k]) => k.toLowerCase() === name.toLowerCase())?.[1];
  return (headers as Record<string, string>)[name] ?? (headers as Record<string, string>)[name.toLowerCase()];
};

const SIGNED_URL_TARGET = 'https://signed.example.test/upload-target';

const storeWithStubFetch = (
  respond: (req: CapturedRequest) => Response
): { store: ReturnType<typeof getStore>; calls: CapturedRequest[] } => {
  const calls: CapturedRequest[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const acceptHeader = headerValue(init ?? {}, 'accept');
    if (acceptHeader?.includes('signed-url')) {
      return new Response(JSON.stringify({ url: SIGNED_URL_TARGET }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const req = { url, init: init ?? {} };
    calls.push(req);
    return respond(req);
  }) as typeof fetch;

  const store = getStore({
    name: 'p1-conditional-write-regression',
    siteID: 'test-site',
    token: 'test-token',
    fetch: fetchStub,
  });
  return { store, calls };
};

test('Store.setJSON sends an if-match header for an onlyIfMatch condition', async () => {
  const { store, calls } = storeWithStubFetch(
    () => new Response(null, { status: 200, headers: { etag: '"new-etag"' } })
  );

  const result = await store.setJSON('some-key', { hello: 'world' }, { onlyIfMatch: '"expected-etag"' });

  assert.equal(calls.length, 1, 'setJSON must issue exactly one request');
  assert.equal(
    headerValue(calls[0].init, 'if-match'),
    '"expected-etag"',
    'the condition must reach the wire as if-match — this is the exact header the 10.7.0 bug dropped'
  );
  assert.equal(result.modified, true);
});

test('Store.setJSON sends an if-none-match: * header for an onlyIfNew condition', async () => {
  const { store, calls } = storeWithStubFetch(
    () => new Response(null, { status: 200, headers: { etag: '"created-etag"' } })
  );

  await store.setJSON('some-key', { hello: 'world' }, { onlyIfNew: true });

  assert.equal(calls.length, 1);
  assert.equal(
    headerValue(calls[0].init, 'if-none-match'),
    '*',
    'onlyIfNew must reach the wire as if-none-match: * — the header the 10.7.0 bug dropped'
  );
});

test('Store.setJSON reports modified:false when the server actually rejects the condition (412)', async () => {
  const { store } = storeWithStubFetch(() => new Response(null, { status: 412 }));

  const result = await store.setJSON('some-key', { hello: 'world' }, { onlyIfMatch: '"stale-etag"' });

  assert.equal(
    result.modified,
    false,
    'a 412 from the server must surface as modified:false, never as a silent success'
  );
});

test('Store.set (non-JSON) also sends if-match — the sibling method the 10.7.0 bug did NOT break', async () => {
  const { store, calls } = storeWithStubFetch(
    () => new Response(null, { status: 200, headers: { etag: '"new-etag"' } })
  );

  await store.set('some-key', 'raw bytes', { onlyIfMatch: '"expected-etag"' });

  assert.equal(headerValue(calls[0].init, 'if-match'), '"expected-etag"');
});
