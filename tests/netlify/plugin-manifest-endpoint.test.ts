import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-plugin-manifest.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('admin-plugin-manifest refuses methods other than GET and POST', async () => {
  const response = await handler({ httpMethod: 'DELETE' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-plugin-manifest requires an authenticated admin to read', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403, `got ${response.statusCode}`);
  assert.equal(parseBody(response).ok, false);
});

test('admin-plugin-manifest requires an authenticated admin to render', async () => {
  const response = await handler({ httpMethod: 'POST', body: JSON.stringify({ action: 'render' }) });
  assert.ok(response.statusCode === 401 || response.statusCode === 403, `got ${response.statusCode}`);
  assert.equal(parseBody(response).ok, false);
});
