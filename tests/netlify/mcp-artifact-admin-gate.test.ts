/**
 * KNOWN_ISSUES #2 / QA-W16-3, Option B (Wolf's 2026-08-10 ruling): the four
 * destructive/index-migration artifact tools stay ADMIN-ONLY, and their shared
 * gate (`requireAdminToolAccess` in packages/core/server/lib/mcp-artifact-admin.ts)
 * must fail CLOSED and say why.
 *
 * The gate never failed open — it failed WRONG: it resolved authority only
 * from a Netlify Identity/GoTrue browser session, which no MCP caller ever
 * carries, so every MCP call burned a round trip to `${IDENTITY_URL}/user`
 * and came back with "Authentication token could not be verified." — i.e.
 * "your MCP credentials are invalid" for a caller whose credentials were
 * perfectly valid and merely not admin.
 *
 * These tests pin both halves: a valid-but-non-admin MCP caller is rejected
 * with the catalogued `admin_required` error and a message that names the
 * real reason, and a legitimate admin (publish secret, or a Netlify Identity
 * admin session) still gets through to the tool body.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler as mcpHandler } from '../../netlify/functions/mcp.js';
import { setNetlifyBlobsModuleForTesting } from '../../packages/core/server/lib/blob-store.js';
import { restoreArtifact, softDeleteArtifact } from '../../packages/core/server/lib/mcp-artifact-admin.js';

const DESTRUCTIVE_ADMIN_TOOLS = [
  'soft_delete_artifact',
  'restore_artifact',
  'migrate_artifact_indexes',
  'reconcile_artifact_indexes',
] as const;

const IDENTITY_BASE = 'https://identity.test.invalid/.netlify/identity';
const MCP_TOKEN = 'test-mcp-token';
const PUBLISH_SECRET = 'test-publish-secret';

type ToolCallResult = {
  isError?: boolean;
  structuredContent?: { error?: string; error_code?: string };
};

/** A store that answers "nothing here" for every key, for every store name. */
const createEmptyBlobStore = () => ({
  async set() {
    return { modified: true };
  },
  async setJSON() {
    return { modified: true };
  },
  async get() {
    return null;
  },
  async del() {},
  async list() {
    return { blobs: [] as { key: string; etag: string }[], directories: [] as string[] };
  },
});

const ENV_KEYS = [
  'ADMIN_EMAILS',
  'IDENTITY_URL',
  'MCP_HTTP_AUTH_TOKEN',
  'NETLIFY',
  'NETLIFY_PUBLISH_SECRET',
  'NETLIFY_SITE_ID',
  'PUBLISH_SECRET',
  'ROLE_EMAILS_ADMIN',
  'URL',
] as const;

type FetchCall = { url: string };

const withGateEnv = async (
  fn: (state: {
    fetchCalls: FetchCall[];
    setIdentityUser: (user: { id: string; email: string } | null) => void;
  }) => Promise<void>
) => {
  const previousEnv = new Map(ENV_KEYS.map((key) => [key, process.env[key]] as const));
  const previousFetch = globalThis.fetch;

  process.env.NETLIFY = 'true';
  process.env.NETLIFY_SITE_ID = '';
  process.env.MCP_HTTP_AUTH_TOKEN = MCP_TOKEN;
  process.env.NETLIFY_PUBLISH_SECRET = PUBLISH_SECRET;
  delete process.env.PUBLISH_SECRET;
  process.env.IDENTITY_URL = IDENTITY_BASE;
  process.env.URL = 'https://site.test.invalid';
  process.env.ADMIN_EMAILS = '';
  process.env.ROLE_EMAILS_ADMIN = '';

  const emptyStore = createEmptyBlobStore();
  setNetlifyBlobsModuleForTesting({
    connectLambda() {},
    getStore() {
      return emptyStore as never;
    },
  });

  const fetchCalls: FetchCall[] = [];
  let identityUser: { id: string; email: string } | null = null;

  globalThis.fetch = (async (input: unknown) => {
    const url = typeof input === 'string' ? input : String((input as { url?: string })?.url ?? input);
    fetchCalls.push({ url });

    if (url.startsWith(IDENTITY_BASE) && identityUser) {
      return new Response(JSON.stringify(identityUser), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }

    return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;

  try {
    await fn({
      fetchCalls,
      setIdentityUser: (user) => {
        identityUser = user;
      },
    });
  } finally {
    globalThis.fetch = previousFetch;
    setNetlifyBlobsModuleForTesting(undefined);
    for (const [key, value] of previousEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const callTool = async (name: string, args: Record<string, unknown>, headers: Record<string, string>) => {
  const response = await mcpHandler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });

  const body = JSON.parse(response.body) as { result?: ToolCallResult; error?: { message?: string } };
  assert.equal(body.error, undefined, `unexpected JSON-RPC error for ${name}: ${body.error?.message}`);

  return body.result as ToolCallResult;
};

test('a valid-but-non-admin MCP caller is refused by all four destructive artifact tools', async () => {
  await withGateEnv(async ({ fetchCalls }) => {
    for (const name of DESTRUCTIVE_ADMIN_TOOLS) {
      const result = await callTool(
        name,
        { requestId: 'req_gate_test_20260810_01', sha256: 'a'.repeat(64) },
        { authorization: `Bearer ${MCP_TOKEN}` }
      );

      assert.equal(result.isError, true, `${name} must refuse a non-admin MCP caller`);
      assert.equal(result.structuredContent?.error_code, 'admin_required', `${name} must use the catalogued code`);
      assert.match(result.structuredContent?.error ?? '', /admin-only/i, `${name} must say why it refused`);
      // The whole QA-W16-3 defect: a valid MCP credential reported as unverifiable.
      assert.doesNotMatch(result.structuredContent?.error ?? '', /could not be verified/i);
    }

    // No doomed Netlify Identity round trip is attempted for an MCP caller.
    assert.deepEqual(
      fetchCalls.filter((call) => call.url.startsWith(IDENTITY_BASE)),
      []
    );
  });
});

test('the server publish secret still admits a caller past the destructive-tool gate', async () => {
  await withGateEnv(async () => {
    for (const name of ['soft_delete_artifact', 'restore_artifact'] as const) {
      const result = await callTool(
        name,
        {},
        { authorization: `Bearer ${MCP_TOKEN}`, 'x-publish-key': PUBLISH_SECRET }
      );

      // Past the gate: the failure is now the tool's own argument validation,
      // not an authorization refusal.
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.error_code, undefined);
      assert.match(result.structuredContent?.error ?? '', /requestId is required/i);
    }
  });
});

test('a Netlify Identity admin session still admits, and a non-admin session is refused', async () => {
  await withGateEnv(async ({ setIdentityUser }) => {
    process.env.ADMIN_EMAILS = 'owner@example.test';
    // No mcpGateAuthenticated: this is the browser-session path, not an MCP call.
    const identityEvent = { headers: { authorization: 'Bearer identity-session-token' } };

    setIdentityUser({ id: 'user-owner', email: 'owner@example.test' });
    const admitted = (await restoreArtifact(identityEvent, {})) as ToolCallResult;
    assert.equal(admitted.isError, true);
    assert.equal(admitted.structuredContent?.error_code, undefined);
    assert.match(admitted.structuredContent?.error ?? '', /requestId is required/i);

    setIdentityUser({ id: 'user-editor', email: 'editor@example.test' });
    const refused = (await softDeleteArtifact(identityEvent, {})) as ToolCallResult;
    assert.equal(refused.isError, true);
    assert.equal(refused.structuredContent?.error_code, 'admin_required');
    assert.match(refused.structuredContent?.error ?? '', /not authorized to administer artifacts/i);
  });
});
