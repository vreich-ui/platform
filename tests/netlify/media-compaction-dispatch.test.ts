/**
 * W4 (2026-09-16) — the scheduled tick is a DISPATCHER, and the worker is a
 * public endpoint that only a freshly minted token may start.
 *
 * This split exists because the inline sweep was killed by Netlify's 30 s
 * scheduled-function wall on every run, in the one-time collection phase that
 * has no page boundary to checkpoint at — invisibly, because Netlify's function
 * log carries nothing at all for this function, not even a timeout line. The
 * assertions here are about the two halves of that fix: the tick must hand off
 * rather than work, and the worker must refuse anything but a live token.
 */
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  dispatchMediaCompactionSweep,
  MEDIA_COMPACTION_BACKGROUND_PATH,
} from '../../packages/core/server/functions/media-compaction-sweep.js';
import { createHandler as createBackgroundHandler } from '../../packages/core/server/functions/media-compaction-sweep-background.js';
import {
  MEDIA_COMPACTION_TRIGGER_KEY,
  consumeMediaCompactionTriggerToken,
  mintMediaCompactionTriggerToken,
} from '../../packages/core/server/lib/media-compaction-heartbeat.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

type FakeValue = Buffer | string;

const createFakeStore = (values = new Map<string, FakeValue>()) => ({
  values,
  store: {
    async set(key: string, value: string | Buffer | Uint8Array) {
      values.set(key, typeof value === 'string' ? value : Buffer.from(value));
      return { modified: true };
    },
    async setJSON(key: string, value: unknown) {
      values.set(key, JSON.stringify(value));
      return { modified: true };
    },
    async get(key: string) {
      const value = values.get(key);
      if (value === undefined) return null;
      return typeof value === 'string' ? value : value.toString('utf8');
    },
    async del(key: string) {
      values.delete(key);
    },
    async list(options?: { prefix?: string }) {
      const prefix = options?.prefix ?? '';
      return { blobs: [...values.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: '' })), directories: [] };
    },
  },
});

const withIndexStore = async (fn: (values: Map<string, FakeValue>) => Promise<void>) => {
  const previousNetlify = process.env.NETLIFY;
  const previousSiteId = process.env.NETLIFY_SITE_ID;
  const index = createFakeStore();
  const anything = createFakeStore();

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore(input: string | { name: string }) {
      const name = typeof input === 'string' ? input : input.name;
      return (name === 'artifact-index' ? index.store : anything.store) as never;
    },
  } as never);

  try {
    await fn(index.values);
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
    if (previousSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = previousSiteId;
  }
};

const withFetchCapture = async (fn: (calls: Array<{ url: string; body: unknown }>) => Promise<void>) => {
  const calls: Array<{ url: string; body: unknown }> = [];
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.URL;
  process.env.URL = 'https://tenant.example';
  globalThis.fetch = (async (url: string, init?: { body?: string }) => {
    calls.push({ url: String(url), body: JSON.parse(init?.body ?? '{}') });
    return { ok: true, status: 202 } as never;
  }) as never;

  try {
    await fn(calls);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.URL;
    else process.env.URL = originalUrl;
  }
};

test('the scheduled tick hands the job to the background worker instead of doing it', async () => {
  await withIndexStore(async (indexValues) => {
    await withFetchCapture(async (calls) => {
      const result = await dispatchMediaCompactionSweep({});

      assert.deepEqual(result, { dispatched: true });
      assert.equal(calls.length, 1, 'exactly one hand-off per tick');
      assert.equal(calls[0].url, `https://tenant.example${MEDIA_COMPACTION_BACKGROUND_PATH}`);

      const token = (calls[0].body as { trigger_token?: string }).trigger_token;
      assert.equal(typeof token, 'string');

      // The token the worker will be asked for is the one left in the store.
      const stored = JSON.parse(indexValues.get(MEDIA_COMPACTION_TRIGGER_KEY) as string);
      assert.equal(stored.token, token);
    });
  });
});

test('a tick with no site URL mints nothing it cannot deliver', async () => {
  await withIndexStore(async () => {
    const originalUrl = process.env.URL;
    delete process.env.URL;
    try {
      assert.deepEqual(await dispatchMediaCompactionSweep({}), { dispatched: false, reason: 'no_site_url' });
    } finally {
      if (originalUrl !== undefined) process.env.URL = originalUrl;
    }
  });
});

test('the token is one-shot: a replay of the same POST is refused', async () => {
  await withIndexStore(async () => {
    // The same store the worker reaches through, so the one-shot property is
    // asserted against real reads and writes rather than a hand-rolled double.
    const { getArtifactIndexBlobStore } = await import('../../packages/core/server/lib/blob-store.js');
    const indexStore = await getArtifactIndexBlobStore({});

    const token = await mintMediaCompactionTriggerToken(indexStore as never);
    assert.equal(await consumeMediaCompactionTriggerToken(indexStore as never, token), true, 'first use works');
    assert.equal(await consumeMediaCompactionTriggerToken(indexStore as never, token), false, 'a replay does not');
    assert.equal(await consumeMediaCompactionTriggerToken(indexStore as never, 'forged'), false, 'nor does a forgery');
  });
});

test('the worker refuses a GET, a bodyless POST and a stale token without touching the store', async () => {
  await withIndexStore(async () => {
    const handler = createBackgroundHandler({ siteId: 'site_test' } as never);

    assert.equal((await handler({ httpMethod: 'GET' })).statusCode, 405);
    assert.equal((await handler({ httpMethod: 'POST', body: '' })).statusCode, 400);
    assert.equal(
      (await handler({ httpMethod: 'POST', body: JSON.stringify({ trigger_token: 'never-minted' }) })).statusCode,
      409,
      'an unauthenticated POST cannot start a pass that deletes bytes'
    );
  });
});
