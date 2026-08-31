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

test('the export route rejects an unknown export kind before doing any work', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { export: 'gemini-gem' } });
  // Auth is still checked first — an unauthenticated caller never learns the shape.
  assert.ok([400, 401, 403].includes(response.statusCode), `got ${response.statusCode}`);
});

test('the export route still requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET', queryStringParameters: { export: 'skill' } });
  assert.ok(response.statusCode === 401 || response.statusCode === 403, `got ${response.statusCode}`);
});
