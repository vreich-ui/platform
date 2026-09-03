import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { mkdir, writeFile } from 'node:fs/promises';

import { handler } from '../../netlify/functions/admin-plugin-manifest.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

/**
 * admin-plugin-manifest, PAST the auth gate.
 *
 * Every test this endpoint had stopped at 401/403/405 — five of them, none of
 * which ever executed a line of the summary or render path. That is exactly
 * where /admin/plugins was 502ing on live drlurie: unauthenticated → 401,
 * authenticated → 502. The whole crash sat in the region the suite did not
 * cover.
 *
 * The seam is `context.clientContext.user` (admin-auth.ts) plus ADMIN_EMAILS,
 * which is how Netlify Identity reaches a function — no JWT needed.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.ADMIN_EMAILS = 'owner@example.com';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-manifest-endpoint-authed');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const ADMIN = { clientContext: { user: { sub: 'usr_owner', email: 'owner@example.com' } } };
const HEADERS = { host: 'drluriescience.netlify.app', 'x-forwarded-proto': 'https' };

const parseBody = (response: { body: string }) => JSON.parse(response.body) as Record<string, unknown>;

test('an authenticated admin GET returns a summary rather than crashing', async (t) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

  const response = await handler({ httpMethod: 'GET', headers: HEADERS }, ADMIN);
  const body = parseBody(response);

  assert.equal(response.statusCode, 200, `expected 200, got ${response.statusCode}: ${response.body}`);
  assert.equal(body.ok, true, `the summary path must not report a stage failure: ${response.body}`);

  await t.test('the summary carries the fields /admin/plugins renders', () => {
    assert.ok('active' in body, 'active (null when nothing is promoted)');
    assert.ok('draft' in body, 'draft');
    assert.ok(Array.isArray(body.stale), 'stale reasons');
    assert.ok(Array.isArray(body.history), 'history');
  });
});

test('render produces a draft, promote makes it active', async () => {
  const rendered = await handler(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'render' }) },
    ADMIN
  );
  const renderBody = parseBody(rendered);
  assert.equal(rendered.statusCode, 200, `render failed: ${rendered.body}`);
  assert.equal(renderBody.ok, true, `render reported a stage failure: ${rendered.body}`);
  const draft = renderBody.draft as { manifest_version?: string; tools?: unknown[] } | undefined;
  assert.ok(draft?.manifest_version, 'the draft carries a manifest_version');
  assert.ok(Array.isArray(draft.tools) && draft.tools.length >= 20, `expected >= 20 tools, got ${draft.tools?.length}`);

  const promoted = await handler(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'promote' }) },
    ADMIN
  );
  const promoteBody = parseBody(promoted);
  assert.equal(promoted.statusCode, 200, `promote failed: ${promoted.body}`);
  assert.equal((promoteBody.active as { manifest_version?: string })?.manifest_version, draft.manifest_version);

  const after = parseBody(await handler({ httpMethod: 'GET', headers: HEADERS }, ADMIN));
  assert.equal((after.active as { manifest_version?: string })?.manifest_version, draft.manifest_version);
  assert.ok(after.exports, 'an active bundle advertises its export routes');
});

/**
 * The other half of the rule: a domain failure must never become a 502 again.
 *
 * Forced for real rather than mocked — the blobs root is pointed INSIDE a
 * regular file, so every write under it fails with ENOTDIR. That is a faithful
 * stand-in for "the store is unavailable at write time", and it throws from a
 * different stage than the original bug did, which is the point: the wrapper
 * has to name whichever step actually failed.
 */
test('a store that cannot be written answers 200 with the failing stage, never a 502', async () => {
  const blocked = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-manifest-blocked');
  await mkdir(join(blocked, '..'), { recursive: true });
  await writeFile(blocked, 'not a directory');
  setLocalBlobsRootForTesting(join(blocked, 'root'));

  try {
    const response = await handler(
      { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'render' }) },
      ADMIN
    );
    const body = parseBody(response);

    assert.equal(response.statusCode, 200, 'a domain failure is not a transport failure');
    assert.equal(body.ok, false, 'and it is honestly reported as a failure');
    assert.equal(body.stage, 'persist', `expected the write stage to be named, got ${JSON.stringify(body.stage)}`);
    assert.match(String(body.error), /ENOTDIR|not a directory/i, 'the operator gets the real reason');
  } finally {
    setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
  }
});
