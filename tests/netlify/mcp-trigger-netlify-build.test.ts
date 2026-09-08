import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';

type ToolCallResult = {
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

const callTriggerNetlifyBuild = async (args: Record<string, unknown> = {}): Promise<ToolCallResult> => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'trigger_netlify_build', arguments: args },
    }),
  });
  const body = JSON.parse(response.body) as { result: ToolCallResult };

  assert.equal(response.statusCode, 200);
  return body.result;
};

const withBuildHookEnv = async (value: string | undefined, fn: () => Promise<void>) => {
  const previous = process.env.NETLIFY_BUILD_HOOK_URL;

  if (value === undefined) delete process.env.NETLIFY_BUILD_HOOK_URL;
  else process.env.NETLIFY_BUILD_HOOK_URL = value;

  try {
    await fn();
  } finally {
    if (previous === undefined) delete process.env.NETLIFY_BUILD_HOOK_URL;
    else process.env.NETLIFY_BUILD_HOOK_URL = previous;
  }
};

test('trigger_netlify_build returns netlify_build_hook_not_configured and makes no network call when the env var is missing', async () => {
  await withBuildHookEnv(undefined, async () => {
    const originalFetch = globalThis.fetch;
    let fetchCalled = false;
    globalThis.fetch = (async () => {
      fetchCalled = true;
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callTriggerNetlifyBuild({ reason: 'testing missing config' });

      assert.equal(result.isError, true);
      assert.equal(result.structuredContent?.error_code, 'netlify_build_hook_not_configured');
      assert.equal(fetchCalled, false, 'must not attempt a network call when the build hook is unconfigured');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('trigger_netlify_build reads NETLIFY_BUILD_HOOK_URL, POSTs to it, and returns triggered:true on a 2xx response', async () => {
  const hookUrl = 'https://api.netlify.com/build_hooks/test-hook-id';

  await withBuildHookEnv(hookUrl, async () => {
    const originalFetch = globalThis.fetch;
    const calls: Array<{ url: string; method?: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response('', { status: 200 });
    }) as typeof fetch;

    try {
      const result = await callTriggerNetlifyBuild({ reason: 'batched publish run' });

      assert.equal(result.isError, undefined);
      assert.equal(result.structuredContent?.triggered, true);
      assert.equal(typeof result.structuredContent?.triggeredAt, 'string');
      assert.equal(calls.length, 1, 'expected exactly one HTTP call to the build hook');
      assert.equal(calls[0].url, hookUrl);
      assert.equal(calls[0].method, 'POST');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('trigger_netlify_build reports the HTTP status on a non-2xx response without leaking the hook URL', async () => {
  const hookUrl = 'https://api.netlify.com/build_hooks/secret-hook-id-should-not-leak';

  await withBuildHookEnv(hookUrl, async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 502 })) as typeof fetch;

    try {
      const result = await callTriggerNetlifyBuild({});

      assert.equal(result.isError, true);
      assert.match(String(result.structuredContent?.error), /502/);
      assert.equal(result.structuredContent?.statusCode, 502);

      const serialized = JSON.stringify(result);
      assert.ok(!serialized.includes(hookUrl), 'error response must not leak the build hook URL');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test('trigger_netlify_build remains internal and is not advertised to agents', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = JSON.parse(response.body) as {
    result: { tools: Array<{ name: string; description: string }> };
  };
  const tool = body.result.tools.find((candidate) => candidate.name === 'trigger_netlify_build');

  assert.equal(tool, undefined);
});

const callReleaseToProduction = async (args: Record<string, unknown> = {}): Promise<ToolCallResult> => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'release_to_production', arguments: args },
    }),
  });
  const body = JSON.parse(response.body) as { result: ToolCallResult };
  assert.equal(response.statusCode, 200);
  return body.result;
};

test('release_to_production is listed and documents the deferred-deploy release model', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = JSON.parse(response.body) as {
    result: { tools: Array<{ name: string; description: string }> };
  };
  const tool = body.result.tools.find((candidate) => candidate.name === 'release_to_production');

  assert.ok(tool, 'expected tools/list to include release_to_production');
  assert.match(tool!.description, /\[skip netlify\]/i);
  // S5: the tool is asynchronous — it fires the hook and returns 202/"building".
  // The description must teach the poll AND the never-retry-a-502 ruling, since
  // an agent that retries a lost release fires a second paid production build.
  assert.match(tool!.description, /status:"building"/i);
  assert.match(tool!.description, /poll/i);
  assert.match(tool!.description, /deploy_status/);
  assert.match(tool!.description, /502[^.]*DO NOT RETRY/i);
});

test('release_to_production surfaces build_hook_not_configured as a tool error when forcing a build with no hook', async () => {
  await withBuildHookEnv(undefined, async () => {
    const result = await callReleaseToProduction({ force_build: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent?.error_code, 'build_hook_not_configured');
  });
});
