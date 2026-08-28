import assert from 'node:assert/strict';
import test from 'node:test';

import { sha256Hex } from '../../packages/core/server/lib/crypto.js';
import { enqueueMemberLink } from '../../packages/core/server/lib/member-link.js';
import { computeVisitorHashes } from '../../packages/core/server/lib/tracking-events.js';

const NOW = Date.parse('2026-08-28T12:34:56.000Z');
const EMAIL = '  Reader@Example.COM  ';
const IP = '203.0.113.7';
const UA = 'member-link-test-agent';
const ENV = {
  TRACKING_SINK_URL: 'https://sink.example/base/',
  TRACKING_SINK_TOKEN: 'test-bearer',
  TRACKING_SALT: 'test-salt',
  TRACKING_PROJECT_ID: 'drlurie',
};

test('member link posts only project_id plus 64-hex session/member hashes', () => {
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const fetchImpl: typeof fetch = (input, init) => {
    calls.push({ input, init });
    return Promise.resolve(new Response(null, { status: 202 }));
  };

  assert.equal(
    enqueueMemberLink({ headers: { 'x-nf-client-connection-ip': IP, 'user-agent': UA } }, EMAIL, {
      env: ENV,
      fetchImpl,
      nowMs: () => NOW,
    }),
    true
  );
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), 'https://sink.example/base/link');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, {
    'Content-Type': 'application/json',
    Authorization: 'Bearer test-bearer',
  });

  const payload = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
  assert.deepEqual(Object.keys(payload).sort(), ['member_hash', 'project_id', 'shash']);
  assert.equal(payload.project_id, 'drlurie');
  assert.match(String(payload.shash), /^[0-9a-f]{64}$/);
  assert.match(String(payload.member_hash), /^[0-9a-f]{64}$/);
  assert.equal(payload.member_hash, sha256Hex('reader@example.com'));
  assert.equal(
    payload.shash,
    computeVisitorHashes({
      salt: 'test-salt',
      utcDate: '2026-08-28',
      ip: IP,
      ua: UA,
      projectId: 'drlurie',
      nowMs: NOW,
    }).shash
  );

  const outbound = JSON.stringify({ url: calls[0].input, body: calls[0].init?.body });
  for (const forbidden of ['Reader@Example.COM', 'reader@example.com', IP, UA, 'test-salt']) {
    assert.equal(outbound.includes(forbidden), false, `outbound request leaked ${forbidden}`);
  }
});

test('member link is a no-op unless all server-side tracking env is present', () => {
  let calls = 0;
  const fetchImpl: typeof fetch = () => {
    calls += 1;
    return Promise.resolve(new Response(null, { status: 202 }));
  };

  for (const missing of Object.keys(ENV)) {
    const env = { ...ENV, [missing]: '' };
    assert.equal(enqueueMemberLink({}, EMAIL, { env, fetchImpl, nowMs: () => NOW }), false);
  }
  assert.equal(enqueueMemberLink({}, null, { env: ENV, fetchImpl, nowMs: () => NOW }), false);
  assert.equal(calls, 0);
});

test('member link transport failures are swallowed synchronously and asynchronously', async () => {
  const rejectedFetch: typeof fetch = () => Promise.reject(new Error('sink unavailable'));
  assert.doesNotThrow(() => enqueueMemberLink({}, EMAIL, { env: ENV, fetchImpl: rejectedFetch, nowMs: () => NOW }));

  const throwingFetch: typeof fetch = () => {
    throw new Error('synchronous transport failure');
  };
  assert.doesNotThrow(() => enqueueMemberLink({}, EMAIL, { env: ENV, fetchImpl: throwingFetch, nowMs: () => NOW }));

  await new Promise((resolve) => setImmediate(resolve));
});
