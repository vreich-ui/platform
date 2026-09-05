import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-analytics.js';
import { handler as compatHandler } from '../../netlify/functions/admin-traffic.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

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

// ─── T21.9b: the old `/.netlify/functions/admin-traffic` URL stays alive ────

test('the admin-traffic compat shim is the SAME handler as admin-analytics, for one wave', () => {
  assert.equal(compatHandler, handler, 'admin-traffic.ts must re-export admin-analytics.ts unchanged, not fork it');
});
