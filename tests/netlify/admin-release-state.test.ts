import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/admin-release-state.js';

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('admin-release-state is read-only', async () => {
  const response = await handler({ httpMethod: 'POST' });
  assert.equal(response.statusCode, 405);
  assert.equal(parseBody(response).ok, false);
});

test('admin-release-state requires an authenticated admin', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.statusCode === 401 || response.statusCode === 403);
  assert.equal(parseBody(response).ok, false);
});

// T0.1 — Server-Timing must be present even on a 401 (the auth phase IS the
// entire cost of this response), and must never break a non-200 body.
test('admin-release-state carries a Server-Timing header on a 401', async () => {
  const response = await handler({ httpMethod: 'GET' });
  assert.ok(response.headers?.['Server-Timing'], 'Server-Timing header must be present');
  assert.match(response.headers['Server-Timing'], /cold;dur=\d.*auth;dur=[\d.]+.*work;dur=[\d.]+.*serialize;dur=[\d.]+/);
});

/**
 * M1 ACCEPTANCE — `work` must be under 400 ms warm AND cold, which is only true
 * while nothing on this path makes an external call or sweeps the store. A test
 * cannot time a Netlify cold start, so it pins the two things that make the
 * claim CHECKABLE on a real request instead:
 *
 *   1. the `sec.*` breakdown is emitted in the shape a reader (or the next
 *      wave's measurement) parses, and
 *   2. `loadReleaseOverview` actually declares the two sections that account
 *      for its whole cost — `sec.snapshot` (`snapshots/release.json`) and
 *      `sec.inventory` (M0.2's two-blob trusted index) — plus
 *      `sec.snapshot_rebuild`, which appears ONLY on a request that had to
 *      repair a missing or stale snapshot and is therefore the one sample where
 *      an outbound call is expected.
 *
 * Without (2) a regression that quietly reintroduced a Netlify or GitHub call
 * would show up as a large unexplained `work` with no section naming it, which
 * is exactly the blindness T0.1 wrote `timeSection` to remove.
 */
test('admin-release-state: the sec.* breakdown is emitted, and the overview declares the sections that account for its cost', async () => {
  const { timeSection, withServerTiming } = await import('../../packages/core/server/lib/server-timing.js');

  const wrapped = withServerTiming('release-state-probe', async () => {
    await timeSection('snapshot', async () => undefined);
    await timeSection('inventory', async () => undefined);
    return { statusCode: 200, headers: {}, body: '' };
  });
  const header = (await wrapped({})).headers?.['Server-Timing'] ?? '';
  assert.match(header, /sec\.snapshot;dur=[\d.]+/);
  assert.match(header, /sec\.inventory;dur=[\d.]+/);

  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { existsSync } = await import('node:fs');
  // `npm test` runs this from the COMPILED tree, so walk up to the real root.
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 10; depth += 1) {
    if (existsSync(join(dir, 'packages', 'core', 'server', 'lib', 'release-overview.ts'))) break;
    dir = dirname(dir);
  }
  const source = readFileSync(join(dir, 'packages', 'core', 'server', 'lib', 'release-overview.ts'), 'utf8');
  for (const section of ['snapshot', 'inventory', 'snapshot_rebuild']) {
    assert.ok(source.includes(`timeSection('${section}'`), `loadReleaseOverview must declare sec.${section}`);
  }
  // The read path itself must never reach the deploy API or the ancestry
  // compare — those belong to the snapshot WRITER and to the repair branch,
  // both of which it calls by name rather than importing directly.
  for (const banned of ['netlify-deploys.js', 'production-release.js', 'object-verbs.js']) {
    assert.ok(!source.includes(`from './${banned}'`), `release-overview.ts must not import ${banned} on the read path`);
  }
});
