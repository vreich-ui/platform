import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';

test('MCP handler answers DELETE (session termination) with 204 rather than 405', async () => {
  // CORS preflight advertises DELETE (jsonHeaders' Access-Control-Allow-Methods),
  // and this handler carries no durable per-session state to tear down — so
  // DELETE must not fall through to the generic non-POST 405 branch.
  const response = await handler({
    httpMethod: 'DELETE',
    headers: { 'mcp-session-id': 'test-session' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.body, '');
});

test('MCP handler reports parse errors only for request body parsing failures', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{not json',
  });
  const body = JSON.parse(response.body) as { error: { code: number; message: string } };

  assert.equal(response.statusCode, 400);
  assert.equal(body.error.code, -32700);
  assert.equal(body.error.message, 'Parse error');
});

test('MCP handler returns a server error when request handling fails after parsing', async () => {
  const previousNetlify = process.env.NETLIFY;
  const previousConsoleError = console.error;

  process.env.NETLIFY = 'true';
  console.error = () => {};
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return {
        async set() {},
        async setJSON() {},
        async get() {
          return null;
        },
        async del() {},
        async list() {
          throw new Error('simulated artifact index failure');
        },
      };
    },
  });

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_artifacts_for_request', arguments: { requestId: 'req_test_storefailure_20260605_01' } },
      }),
    });
    const body = JSON.parse(response.body) as { error: { code: number; message: string } };

    assert.equal(response.statusCode, 500);
    assert.equal(body.error.code, -32000);
    assert.equal(body.error.message, 'Internal server error');
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);
    console.error = previousConsoleError;

    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
  }
});

test('admin artifact browsing and reconciliation MCP tools require admin authentication', async () => {
  const previousClerkSecret = process.env.CLERK_SECRET_KEY;
  delete process.env.CLERK_SECRET_KEY;

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'soft_delete_artifact', arguments: { requestId: 'request', sha256: 'a'.repeat(64) } },
      }),
    });
    const body = JSON.parse(response.body) as {
      result: { isError: boolean; structuredContent: { error: string; error_code?: string } };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(body.result.isError, true);
    // QA-W16-3 / KNOWN_ISSUES #2 (Option B): still refused, but now with the
    // catalogued code and the real reason — not a bogus "your credentials
    // could not be verified" from an identity check no MCP caller can pass.
    assert.equal(body.result.structuredContent.error_code, 'admin_required');
    assert.match(body.result.structuredContent.error, /admin-only/i);
  } finally {
    if (previousClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previousClerkSecret;
  }
});

test('migrate_artifact_indexes accepts the server publish key without Clerk authentication', async () => {
  const previousClerkSecret = process.env.CLERK_SECRET_KEY;
  const previousPublishSecret = process.env.NETLIFY_PUBLISH_SECRET;
  const previousNetlify = process.env.NETLIFY;
  const publishSecret = 'mcp-migration-publish-secret';
  const sha256 = 'a'.repeat(64);
  const requestId = 'req_test_secretmigrate_20260605_01';
  const artifactKey = `request-artifacts/${requestId}/${sha256}.json`;
  const blobs = new Map<string, string>([
    [
      artifactKey,
      JSON.stringify({
        blobKey: `image/${requestId}/${sha256}.png`,
        sizeBytes: 4,
        sha256,
        contentType: 'image/png',
        createdAtISO: '2026-01-01T00:00:00.000Z',
      }),
    ],
  ]);

  delete process.env.CLERK_SECRET_KEY;
  process.env.NETLIFY_PUBLISH_SECRET = publishSecret;
  process.env.NETLIFY = 'true';
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return {
        async set(key: string, value: string | Buffer | Uint8Array) {
          blobs.set(key, Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
        },
        async setJSON(key: string, value: unknown) {
          blobs.set(key, JSON.stringify(value));
        },
        async get(key: string) {
          return blobs.get(key) ?? null;
        },
        async del(key: string) {
          blobs.delete(key);
        },
        async list(options?: { prefix?: string }) {
          const prefix = options?.prefix ?? '';
          return {
            blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key, etag: key })),
            directories: [],
          };
        },
      };
    },
  });

  try {
    const response = await handler({
      httpMethod: 'POST',
      headers: { 'content-type': 'application/json', 'x-publish-key': publishSecret },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'migrate_artifact_indexes', arguments: { limit: 1, dryRun: true } },
      }),
    });
    const body = JSON.parse(response.body) as {
      result: { isError?: boolean; structuredContent?: { migrated?: number; results?: Array<{ status: string }> } };
    };

    assert.equal(response.statusCode, 200);
    assert.equal(body.result.isError, undefined);
    assert.equal(body.result.structuredContent?.migrated, 1);
    assert.equal(body.result.structuredContent?.results?.[0]?.status, 'dry_run');
  } finally {
    setNetlifyBlobsModuleForTesting(undefined);

    if (previousClerkSecret === undefined) delete process.env.CLERK_SECRET_KEY;
    else process.env.CLERK_SECRET_KEY = previousClerkSecret;

    if (previousPublishSecret === undefined) delete process.env.NETLIFY_PUBLISH_SECRET;
    else process.env.NETLIFY_PUBLISH_SECRET = previousPublishSecret;

    if (previousNetlify === undefined) delete process.env.NETLIFY;
    else process.env.NETLIFY = previousNetlify;
  }
});
