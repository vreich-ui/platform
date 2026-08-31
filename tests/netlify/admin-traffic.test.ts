import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-traffic.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('admin-traffic is read-only', async () => {
  const response = await handler({ httpMethod: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-traffic requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

test('T21.2b: admin-traffic?source=own sits behind the SAME admin auth wall', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { source: 'own' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});
