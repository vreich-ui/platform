import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-editorial-view.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('admin-editorial-view is read-only', async () => {
  const response = await handler({ httpMethod: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-editorial-view requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

// T0.1 — Server-Timing must be present even on a 401.
test('admin-editorial-view carries a Server-Timing header on a 401', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.headers?.['Server-Timing'], 'Server-Timing header must be present');
  assert.match(response.headers['Server-Timing'], /cold;dur=\d.*auth;dur=[\d.]+.*work;dur=[\d.]+.*serialize;dur=[\d.]+/);
});
