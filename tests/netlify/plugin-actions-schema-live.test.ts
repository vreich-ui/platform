import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler as actions } from '../../netlify/functions/plugin-actions.js';
import { handler as manifest } from '../../netlify/functions/admin-plugin-manifest.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

/**
 * /api/plugin/openapi.json WITH a promoted manifest — the branch that 502'd.
 *
 * The façade's handler tests all stop at a refusal: 404 unknown path, 405 wrong
 * method, 409 nothing promoted, 400 no origin. The document tests call
 * `buildOpenApiDocument` directly and never touch the handler. So the success
 * branch — the only one that calls `visibleToolDefinitions()` — had no handler
 * coverage at all, and shipped a crash that fired the moment drlurie promoted
 * its first manifest on 2026-09-03.
 *
 * This drives the real handlers end to end: render and promote through
 * admin-plugin-manifest, then fetch the schema through plugin-actions, exactly
 * as ChatGPT does when it imports the Actions schema.
 */
for (const key of ['NETLIFY', 'NETLIFY_SITE_ID', 'NETLIFY_BLOBS_TOKEN', 'NETLIFY_AUTH_TOKEN', 'SITE_ID']) {
  delete process.env[key];
}
process.env.ADMIN_EMAILS = 'owner@example.com';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-actions-schema-live');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

const ADMIN = { clientContext: { user: { sub: 'usr_owner', email: 'owner@example.com' } } };
const HEADERS = { host: 'drluriescience.netlify.app', 'x-forwarded-proto': 'https' };
const SCHEMA_EVENT = { httpMethod: 'GET', headers: HEADERS, path: '/api/plugin/openapi.json' };

test('the Actions schema route serves a document once a manifest is promoted', async (t) => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });

  await t.test('before promotion it refuses cleanly, and that refusal is what hid the crash', async () => {
    const response = await actions(SCHEMA_EVENT);
    assert.equal(response.statusCode, 409);
    assert.equal((JSON.parse(response.body) as { ok: boolean }).ok, false);
  });

  const rendered = await manifest(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'render' }) },
    ADMIN
  );
  assert.equal(rendered.statusCode, 200, rendered.body);
  const promoted = await manifest(
    { httpMethod: 'POST', headers: HEADERS, body: JSON.stringify({ action: 'promote' }) },
    ADMIN
  );
  assert.equal(promoted.statusCode, 200, promoted.body);
  const version = (JSON.parse(promoted.body) as { active: { manifest_version: string } }).active.manifest_version;

  const response = await actions(SCHEMA_EVENT);

  await t.test('it is a 200 carrying JSON, not a 502 carrying a stack', () => {
    assert.equal(
      response.statusCode,
      200,
      `expected 200, got ${response.statusCode}: ${String(response.body).slice(0, 400)}`
    );
    assert.match(response.headers['Content-Type'], /application\/json/);
    assert.ok(
      !/errorType|\/var\/task|at Runtime\.handler/.test(String(response.body)),
      'no stack may reach this endpoint'
    );
  });

  await t.test('the document is the shape ChatGPT imports', () => {
    const document = JSON.parse(response.body) as {
      openapi: string;
      paths: Record<string, unknown>;
      servers?: { url: string }[];
    };
    assert.match(document.openapi, /^3\.1/);
    assert.ok(
      Object.keys(document.paths).length >= 20,
      `the charter should expose 20+ operations, got ${Object.keys(document.paths).length}`
    );
    assert.equal(response.headers['X-Plugin-Manifest-Version'], version);
  });

  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
});

test('an unexpected failure is a clean JSON refusal, never a raw Netlify 502', async () => {
  // A public endpoint that dies hands Netlify's own envelope to the caller —
  // errorType, errorMessage and a stack naming /var/task paths. That is what
  // happened here. Pointing the blobs root inside a regular file makes the
  // store read throw for real.
  const blocked = join(process.cwd(), '.netlify', 'local-blobs-test', 'plugin-actions-blocked');
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir(join(blocked, '..'), { recursive: true });
  await writeFile(blocked, 'not a directory');
  setLocalBlobsRootForTesting(join(blocked, 'root'));

  try {
    const response = await actions(SCHEMA_EVENT);
    assert.ok(response.statusCode >= 400, 'a failure is still a failure');
    const body = JSON.parse(response.body) as { ok: boolean; error: string };
    assert.equal(body.ok, false);
    assert.ok(!/\/var\/task|errorType|at Runtime/.test(response.body), 'no internal detail on the wire');
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'the caller gets a readable reason');
  } finally {
    setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
  }
});
