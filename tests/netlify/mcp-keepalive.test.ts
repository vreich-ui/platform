import assert from 'node:assert/strict';
import test from 'node:test';

import { createHandler, runAdminKeepaliveProbe, runKeepaliveProbe } from '../../netlify/functions/mcp-keepalive.js';
import type { SiteBinding } from '../../packages/core/server/lib/site-binding.js';

type RecordedRequest = { url: string; method?: string; headers?: Record<string, string>; body?: string };

const recordingFetch = (status = 200, payload: unknown = { ok: true }) => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  return { fetchImpl, requests };
};

test('keepalive skips without probing when MCP_KEEPALIVE_DISABLED is true', async () => {
  const { fetchImpl, requests } = recordingFetch();
  const result = await runKeepaliveProbe(fetchImpl, {
    MCP_KEEPALIVE_DISABLED: 'true',
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'skipped');
  assert.equal(requests.length, 0);
});

test('keepalive reports a skip (not a crash) when no target URL is configured', async () => {
  const { fetchImpl, requests } = recordingFetch();
  const result = await runKeepaliveProbe(fetchImpl, {} as NodeJS.ProcessEnv);

  assert.equal(result.ok, false);
  assert.equal(result.mode, 'skipped');
  assert.equal(requests.length, 0);
});

test('keepalive with an auth token POSTs the ping tool through the full MCP path', async () => {
  const pingPayload = {
    jsonrpc: '2.0',
    id: 'keepalive',
    result: { structuredContent: { ok: true, instance_age_ms: 123_456 } },
  };
  const { fetchImpl, requests } = recordingFetch(200, pingPayload);
  const result = await runKeepaliveProbe(fetchImpl, {
    URL: 'https://example.netlify.app/',
    MCP_HTTP_AUTH_TOKEN: 'warm-token',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'ping_tool');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.instanceAgeMs, 123_456);
  assert.equal(result.coldStartSuspected, false);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.netlify.app/mcp');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers?.['x-mcp-auth-token'], 'warm-token');
  assert.match(requests[0].body ?? '', /"name":"ping"/);
});

test('keepalive without an auth token uses the unauthenticated GET health probe', async () => {
  const { fetchImpl, requests } = recordingFetch(200, { ok: true, instance_age_ms: 42 });
  const result = await runKeepaliveProbe(fetchImpl, {
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'health_get');
  assert.equal(result.instanceAgeMs, 42);
  assert.equal(result.coldStartSuspected, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.netlify.app/mcp?health=1');
  assert.equal(requests[0].method, 'GET');
});

test('keepalive reports a fetch failure as ok:false with the error message', async () => {
  const failingFetch = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;
  const result = await runKeepaliveProbe(failingFetch, {
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'socket hang up');
});

test('admin keepalive POSTs unauthenticated to admin-object and treats 401 as healthy', async () => {
  const { fetchImpl, requests } = recordingFetch(401, { ok: false, status: 401, error: 'Authentication is required.' });
  const result = await runAdminKeepaliveProbe('admin-object', fetchImpl, {
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.target, 'admin-object');
  assert.equal(result.mode, 'unauthenticated_probe');
  assert.equal(result.httpStatus, 401);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.netlify.app/.netlify/functions/admin-object');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].headers?.authorization, undefined);
});

test('admin keepalive POSTs unauthenticated to admin-audit and treats 401 as healthy', async () => {
  const { fetchImpl, requests } = recordingFetch(401, { ok: false, status: 401, error: 'Authentication is required.' });
  const result = await runAdminKeepaliveProbe('admin-audit', fetchImpl, {
    URL: 'https://example.netlify.app/',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.target, 'admin-audit');
  assert.equal(result.httpStatus, 401);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://example.netlify.app/.netlify/functions/admin-audit');
});

test('admin keepalive flags a non-401 response as an anomaly instead of throwing', async () => {
  const { fetchImpl } = recordingFetch(200, { ok: true });
  const result = await runAdminKeepaliveProbe('admin-object', fetchImpl, {
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, false);
  assert.equal(result.httpStatus, 200);
});

test('admin keepalive reports a fetch failure as ok:false with the error message, without throwing', async () => {
  const failingFetch = (async () => {
    throw new Error('socket hang up');
  }) as typeof fetch;
  const result = await runAdminKeepaliveProbe('admin-audit', failingFetch, {
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, false);
  assert.equal(result.error, 'socket hang up');
});

test('admin keepalive skips without probing when MCP_KEEPALIVE_DISABLED is true', async () => {
  const { fetchImpl, requests } = recordingFetch();
  const result = await runAdminKeepaliveProbe('admin-object', fetchImpl, {
    MCP_KEEPALIVE_DISABLED: 'true',
    URL: 'https://example.netlify.app',
  } as NodeJS.ProcessEnv);

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'skipped');
  assert.equal(requests.length, 0);
});

// createHandler reads process.env / global fetch by default (it has no seams
// for injecting fetchImpl/env, matching the site shim's zero-arg handler
// contract), so these two tests stub globalThis.fetch and process.env
// directly and restore them afterward.
const fakeEnvNames = {
  blobSiteId: [],
  blobToken: [],
  blobApiUrl: [],
  publishSecret: [],
  mcpAuthToken: [],
  gitContentToken: [],
  gitRepository: [],
  gitBranch: [],
  buildHookUrl: [],
  deployLookupToken: [],
  cmsAgentEndpoint: [],
  cmsAgentToken: [],
} satisfies SiteBinding['env'];

const multiTargetFetch = () => {
  const requests: RecordedRequest[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = String(url);
    requests.push({ url: urlStr, method: init?.method });
    // /mcp's unauthenticated health probe answers 200; the admin functions'
    // unauthenticated probe answers 401 — both are their own "healthy" case.
    const status = urlStr.includes('/.netlify/functions/') ? 401 : 200;
    return new Response(JSON.stringify({ ok: status < 300 }), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  return { fetchImpl, requests };
};

const withStubbedGlobals = async (
  fetchImpl: typeof fetch,
  envOverrides: Record<string, string | undefined>,
  run: () => Promise<void>
) => {
  const originalFetch = globalThis.fetch;
  const originalEnv = { ...process.env };
  globalThis.fetch = fetchImpl;
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
  }
};

test('createHandler warms admin-object and admin-audit for a binding that opts in via warmAdminKeepalive', async () => {
  const { fetchImpl, requests } = multiTargetFetch();

  await withStubbedGlobals(
    fetchImpl,
    { URL: 'https://example.netlify.app', MCP_HTTP_AUTH_TOKEN: undefined, MCP_KEEPALIVE_DISABLED: undefined },
    async () => {
      const binding: SiteBinding = {
        siteId: 'site_example',
        env: fakeEnvNames,
        dataRoot: 'sites/example/data/site',
        warmAdminKeepalive: true,
      };
      const response = await createHandler(binding)();

      assert.equal(response.statusCode, 200);
      const urls = requests.map((r) => r.url).sort();
      assert.deepEqual(urls, [
        'https://example.netlify.app/.netlify/functions/admin-audit',
        'https://example.netlify.app/.netlify/functions/admin-object',
        'https://example.netlify.app/mcp?health=1',
      ]);
    }
  );
});

test('createHandler warms only /mcp for a binding that does not set warmAdminKeepalive (no silent multi-site scope creep)', async () => {
  const { fetchImpl, requests } = multiTargetFetch();

  await withStubbedGlobals(
    fetchImpl,
    { URL: 'https://example.netlify.app', MCP_HTTP_AUTH_TOKEN: undefined, MCP_KEEPALIVE_DISABLED: undefined },
    async () => {
      const binding: SiteBinding = { siteId: 'site_example', env: fakeEnvNames, dataRoot: 'sites/example/data/site' };
      const response = await createHandler(binding)();

      assert.equal(response.statusCode, 200);
      assert.equal(requests.length, 1);
      assert.equal(requests[0].url, 'https://example.netlify.app/mcp?health=1');
    }
  );
});
