import assert from 'node:assert/strict';
import test from 'node:test';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import { handler } from '../../netlify/functions/admin-analytics.js';
import { handler as compatHandler } from '../../netlify/functions/admin-traffic.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'admin-analytics');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

test.after(async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});

test('admin-analytics is read-only', async () => {
  const response = await handler({ httpMethod: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-analytics requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.2b: admin-analytics?source=own sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'own' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

// ─── R11.5 (T21.36): the Insights tab sits behind the SAME admin auth wall ──

test('T21.36: admin-analytics?source=insights sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'insights' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.6b: admin-analytics?source=arm_metrics sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'arm_metrics' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.36: admin-analytics?source=insights is read-only — no POST/PUT path is wired for it', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { source: 'insights' } });
  assert.equal(response.statusCode, 405);
});

// ─── R11.2 (T21.28): the raw export proxy sits behind the same auth wall ────

test('admin-analytics?resource=raw_export requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'raw_export', kind: 'events', from: '2026-08-01', to: '2026-08-31' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('admin-analytics?resource=raw_export is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'raw_export' } });
  assert.equal(response.statusCode, 405);
});

// ─── R11.3 (T21.29): annotations + notes sit behind the same auth wall ──────

test('admin-analytics?resource=annotations requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'annotations', from: '2026-08-01', to: '2026-08-31' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
});

test('admin-analytics?resource=annotations is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'annotations' } });
  assert.equal(response.statusCode, 405);
});

// T2.3 — this resource previously returned unconditionally with no
// validator (T0.2's "zero ETags anywhere in server/functions/" finding).
test('admin-analytics?resource=annotations returns an ETag and 304s on a matching If-None-Match', async () => {
  const originalNetlify = process.env.NETLIFY;
  const originalSiteId = process.env.NETLIFY_SITE_ID;
  const originalAdminEmails = process.env.ADMIN_EMAILS;
  process.env.NETLIFY = 'false';
  process.env.NETLIFY_SITE_ID = '';
  process.env.ADMIN_EMAILS = 'owner@example.com';
  try {
    const context = { clientContext: { user: { sub: 'owner-1', email: 'owner@example.com' } } };
    const query = { resource: 'annotations', from: '2026-08-01T00:00:00.000Z', to: '2026-08-31T00:00:00.000Z' };

    const first = await handler({ httpMethod: 'GET', queryStringParameters: query, headers: {} }, context);
    assert.equal(first.statusCode, 200);
    const firstHeaders = first.headers as Record<string, string> | undefined;
    const etag = firstHeaders?.['ETag'];
    assert.ok(etag, 'ETag must be present');
    assert.equal(firstHeaders?.['Cache-Control'], 'private, no-cache');

    const second = await handler(
      { httpMethod: 'GET', queryStringParameters: query, headers: { 'if-none-match': etag } },
      context
    );
    assert.equal(second.statusCode, 304);
    assert.equal(second.body, '');
    assert.equal((second.headers as Record<string, string> | undefined)?.['ETag'], etag);
  } finally {
    if (originalNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = originalNetlify;
    if (originalSiteId === undefined) delete process.env.NETLIFY_SITE_ID;
    else process.env.NETLIFY_SITE_ID = originalSiteId;
    if (originalAdminEmails === undefined) delete process.env.ADMIN_EMAILS;
    else process.env.ADMIN_EMAILS = originalAdminEmails;
  }
});

// T0.1 — Server-Timing must be present even on a 401.
test('admin-analytics carries a Server-Timing header on a 401', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.headers?.['Server-Timing'], 'Server-Timing header must be present');
  assert.match(response.headers['Server-Timing'], /cold;dur=\d.*auth;dur=[\d.]+.*work;dur=[\d.]+.*serialize;dur=[\d.]+/);
});

test('admin-analytics?resource=notes requires an authenticated admin, for every method', async () => {
  for (const httpMethod of ['GET', 'POST', 'DELETE']) {
    const response = await handler({ httpMethod, queryStringParameters: { resource: 'notes' } });
    assert.ok(response.statusCode === 401 || response.statusCode === 403, `${httpMethod} must sit behind the wall`);
  }
});

// ─── R11.4 (T21.30): the object drill-down's identity resource sits behind the same auth wall ──

test('admin-analytics?resource=object_identity requires an authenticated admin', async () => {
  const response = await handler({
    httpMethod: 'GET',
    queryStringParameters: { resource: 'object_identity', id: 'art_skincare_101' },
  });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
});

test('admin-analytics?resource=object_identity is GET-only', async () => {
  const response = await handler({ httpMethod: 'POST', queryStringParameters: { resource: 'object_identity' } });
  assert.equal(response.statusCode, 405);
});

// ─── T21.9b: the old `/.netlify/functions/admin-traffic` URL stays alive ────

test('the admin-traffic compat shim is the SAME handler as admin-analytics, for one wave', () => {
  assert.equal(compatHandler, handler, 'admin-traffic.ts must re-export admin-analytics.ts unchanged, not fork it');
});
