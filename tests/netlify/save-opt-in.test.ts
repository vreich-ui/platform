import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { createHandler } from '../../packages/core/server/functions/save-opt-in.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { buildRecord, isParseBodyFailure, parseBody } from '../../packages/core/server/lib/opt-in-record.js';
import { drlurieSiteBinding } from '../../sites/drlurie/config/site-binding.js';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'save-opt-in-link');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

test('URL-encoded Netlify form-name payload builds a valid opt-in record', () => {
  const input = parseBody({
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      'form-name': 'free-guide',
      email: 'reader@example.com',
      name: 'Reader',
      pathname: '/free-guide',
      consentText: 'I agree to receive updates.',
    }).toString(),
  });

  assert.ok(input);

  if (isParseBodyFailure(input)) {
    assert.fail('Expected a parsed URL-encoded input object.');
  }

  assert.deepEqual(input['form-name'], 'free-guide');

  const record = buildRecord(input, 'node-test-agent');

  assert.ok(record);
  assert.equal(record.formName, 'free-guide');
  assert.equal(record.email, 'reader@example.com');
  assert.equal(record.name, 'Reader');
  assert.equal(record.source, '/free-guide');
  assert.equal(record.consent, 'I agree to receive updates.');
  assert.equal(record.userAgent, 'node-test-agent');
  assert.match(record.submittedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('JSON formName payload remains the preferred contract', () => {
  const input = parseBody({
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      formName: 'newsletter',
      'form-name': 'free-guide',
      email: 'json@example.com',
    }),
  });

  assert.ok(input);

  if (isParseBodyFailure(input)) {
    assert.fail('Expected a parsed JSON input object.');
  }

  const record = buildRecord(input);

  assert.ok(record);
  assert.equal(record.formName, 'newsletter');
  assert.equal(record.email, 'json@example.com');
});

test('malformed JSON returns a typed parse failure without throwing', () => {
  const input = parseBody({
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });

  assert.deepEqual(input, { ok: false, reason: 'malformed-json' });
  assert.equal(isParseBodyFailure(input), true);
});

test('a saved opt-in with email enqueues one leak-safe member link', async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  const calls: Array<{ input: string | URL | Request; init?: RequestInit }> = [];
  const handler = createHandler(drlurieSiteBinding, {
    env: {
      TRACKING_SINK_URL: 'https://sink.example/ingest',
      TRACKING_SINK_TOKEN: 'test-bearer',
      TRACKING_SALT: 'test-salt',
      TRACKING_PROJECT_ID: 'drlurie',
    },
    fetchImpl: (input, init) => {
      calls.push({ input, init });
      return Promise.resolve(new Response(null, { status: 202 }));
    },
    nowMs: () => Date.parse('2026-08-28T12:34:56.000Z'),
  });

  const response = await handler({
    httpMethod: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-nf-client-connection-ip': '203.0.113.7',
      'user-agent': 'opt-in-test-agent',
    },
    body: JSON.stringify({ formName: 'newsletter', email: 'Reader@Example.com' }),
  });

  assert.equal(response.statusCode, 202);
  assert.equal(calls.length, 1);
  assert.equal(String(calls[0].input), 'https://sink.example/ingest/link');
  const body = String(calls[0].init?.body);
  assert.equal(body.includes('Reader@Example.com'), false);
  assert.match(body, /"shash":"[0-9a-f]{64}"/);
  assert.match(body, /"member_hash":"[0-9a-f]{64}"/);
});
