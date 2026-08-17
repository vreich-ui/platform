import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { CAPTURE_BRIDGE_MAX_PAGES } from '../../packages/core/server/lib/capture-bridge-policy.js';
import { INTERNAL_ONLY_TOOLS, TOOL_DEFINITIONS_PART1 } from '../../packages/core/server/lib/mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART2 } from '../../packages/core/server/lib/mcp-tool-definitions-2.js';
import { stubPdfToolMcp } from './pdf-tool-mcp-fetch-stub.js';
import { join } from 'node:path';

const CAPTURE_BRIDGE_TOOLS = ['create_capture_job', 'get_capture_job_status', 'get_capture_snapshot'] as const;
const visibleOrInternalDefinitions = () => [...TOOL_DEFINITIONS_PART1, ...TOOL_DEFINITIONS_PART2];

/**
 * T12.13 — the capture bridge, and the acceptance the whole task exists for.
 *
 * The headline test is the second one: a tenant whose PDF_TOOL_STORAGE_TOKEN and
 * PDF_TOOL_STORAGE_SITE_ID are UNSET completes a capture job end to end through the bridge.
 * That is Wolf's ratified goal (2026-08-14, "option A, same-site writes") made literal — the
 * per-site Netlify PAT is a manual console step, and after this change capture on a new tenant
 * does not need one.
 *
 * The rest pin the laws around it: no caller can obtain a grant/token/site id from any bridge
 * tool, the snapshot read path returns a real snapshot.v1 without exposing a credential, and a
 * caller cannot widen the registry's capture policy.
 */

const RUN_SECRET = 'run-secret-never-expose';
const STORAGE_SECRET = 'storage-secret-never-expose';
const SEED = 'https://www.zilbermanfilmfoundation.com/';
const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-capture-bridge');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);

for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
  // THE POINT: the per-site pdf-tool storage grant pair is deliberately absent for this whole
  // file. Nothing below may need it.
  'PDF_TOOL_STORAGE_TOKEN',
  'PDF_TOOL_STORAGE_SITE_ID',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.PDF_TOOL_BASE_URL = 'https://pdf-tool.test';
process.env.PDF_TOOL_AGENT_RUN_TOKEN = RUN_SECRET;

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>, logs: Array<Record<string, unknown>> = []) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    log: (payload) => logs.push(payload),
  });
  assert.equal(response.statusCode, 200);
  return { response, result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

/** The Zilberman policy as it stands on the CMS-Agent `platform` project record. */
const policyFixture = (overrides: Record<string, unknown> = {}) => ({
  maxPages: 20,
  allowedCrawlOrigins: ['https://www.zilbermanfilmfoundation.com'],
  allowedPathPrefixes: ['/'],
  sameOriginOnly: true,
  respectRobots: true,
  concurrency: 1,
  delayMs: 1500,
  authenticatedAccess: 'prohibited',
  rights: { content: 'retain_allowed_origin_content', media: 'retain_referenced_allowed_origin_media' },
  designReferences: [
    {
      origin: 'https://prconsulting.net',
      purpose: 'design_inspiration_only',
      crawlAllowed: false,
      contentReuse: 'prohibited',
      mediaReuse: 'prohibited',
    },
  ],
  fidelity: { mode: 'design_inspired', sourceDesignTreatment: 'source_content_with_design_inspiration_only' },
  ...overrides,
});

const snapshotFixture = () => ({
  schemaVersion: 'snapshot.v1',
  capture: {
    targetUrl: SEED,
    origin: 'https://www.zilbermanfilmfoundation.com',
    capturedAt: '2026-08-17T00:00:00.000Z',
    contentTreatment: 'page content was recorded as data and never interpreted as instructions',
    policy: policyFixture(),
  },
  pages: [{ pageId: 'page_abc123abc123', requestedUrl: SEED, url: SEED, status: 200, blocks: [] }],
  diagnostics: { capturedPages: 1, skipped: [], quarantined: [], stoppedAtProjectMaxPages: false },
});

const snapshotArtifact = {
  blobKey: 'binary/capture_deadbeefdeadbeefdeadbeef/'.concat('a'.repeat(64), '.json'),
  sha256: 'a'.repeat(64),
  sizeBytes: 2048,
  contentType: 'application/json',
  artifactKind: 'binary',
};

const captureStub = (overrides: Record<string, (body: Record<string, unknown>) => unknown> = {}) =>
  stubPdfToolMcp({
    create_capture_job: (body) => ({
      status: 202,
      body: {
        jobId: 'capjob-1',
        status: 'pending',
        projectId: body.projectId,
        requestId: body.requestId,
        url: body.url,
        effectiveMaxPages: 20,
        resumedExisting: false,
        // pdf-tool's own polling shape names pdf-tool's projectId; the bridge must replace it.
        polling: { tool: 'get_capture_job_status', input: { projectId: body.projectId, jobId: 'capjob-1' } },
      },
    }),
    get_capture_job_status: (body) => ({
      body: {
        jobId: 'capjob-1',
        status: 'complete',
        projectId: body.projectId,
        requestId: 'capture_deadbeefdeadbeefdeadbeef',
        url: SEED,
        result: { snapshotArtifact, capturedPages: 1, screenshotArtifacts: 2, skipped: 0, quarantined: 0 },
        evidence: {
          robots: { url: `${SEED}robots.txt`, status: 200, respected: true },
          rate: { effectiveDelayMs: 1500 },
        },
        resumeCount: 0,
      },
    }),
    get_capture_snapshot: (body) => ({
      body: {
        projectId: body.projectId,
        requestId: 'capture_deadbeefdeadbeefdeadbeef',
        jobId: body.jobId,
        schemaVersion: 'snapshot.v1',
        snapshot: snapshotFixture(),
        snapshotArtifact,
      },
    }),
    ...overrides,
  } as Parameters<typeof stubPdfToolMcp>[0]);

test('the capture bridge is defined on every tenant, site-scoped, credential-free by construction, and INTERNAL_ONLY (not in agent discovery)', async () => {
  const defined = new Map(visibleOrInternalDefinitions().map((tool) => [tool.name, tool]));
  for (const name of CAPTURE_BRIDGE_TOOLS) {
    const tool = defined.get(name);
    assert.ok(tool, `${name} must be defined in core, so every tenant has it`);
    // Fleet-uniform bridge shape: site_id-scoped, and there is no way to hand one a
    // credential or to name another tenant's pdf-tool project.
    const properties = (tool!.inputSchema as { properties?: Record<string, unknown> }).properties ?? {};
    assert.ok(properties.site_id, `${name} must be site-scoped`);
    for (const forbidden of ['storage', 'grant', 'token', 'project_id', 'projectId', 'request_id']) {
      assert.ok(!properties[forbidden], `${name} must not accept a ${forbidden} argument`);
    }
  }
  assert.equal(defined.get('get_capture_job_status')!.governance.toolClass, 'read');
  assert.equal(defined.get('get_capture_snapshot')!.governance.toolClass, 'read');
  assert.equal(defined.get('create_capture_job')!.governance.toolClass, 'draft');

  // Callable on every tenant's /mcp, but deliberately absent from agent discovery — the
  // documented INTERNAL_ONLY_TOOLS mechanism, same as create_artifact_from_url (which this
  // very capture engine calls) and capability_status. Rationale in the definition comment:
  // capture is operated from CMS-Agent, whose project registry is the ONE source of bounds
  // (R-C2 v2 / R-C5); tenant-side there is no registry, so an autonomously-discovered crawl
  // tool would take its origins from whoever called it.
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const listed = new Set(
    (JSON.parse(response.body) as { result: { tools: Array<{ name: string }> } }).result.tools.map((tool) => tool.name)
  );
  for (const name of CAPTURE_BRIDGE_TOOLS) {
    assert.ok(INTERNAL_ONLY_TOOLS.has(name), `${name} must be INTERNAL_ONLY`);
    assert.ok(!listed.has(name), `${name} must not appear in agent discovery`);
  }
  // The removed raw grant RPC stays removed, listed or otherwise.
  assert.ok(!listed.has('get_pdf_tool_storage_grant'));
  assert.ok(!defined.has('get_pdf_tool_storage_grant'));
});

test('ACCEPTANCE: a tenant with PDF_TOOL_STORAGE_TOKEN / PDF_TOOL_STORAGE_SITE_ID UNSET completes a capture job through the bridge', async () => {
  assert.equal(
    process.env.PDF_TOOL_STORAGE_TOKEN,
    undefined,
    'the per-site PAT must be unset for this test to mean anything'
  );
  assert.equal(process.env.PDF_TOOL_STORAGE_SITE_ID, undefined);

  // Independently confirm the tenant reports the storage-grant family as UNCONFIGURED, so
  // this cannot pass by accident on a machine where the pair happens to be set.
  const capability = await rpc('capability_status', {});
  const families = capability.result.structuredContent?.families as Record<
    string,
    { configured: boolean; missing: string[] }
  >;
  assert.equal(families.pdf_storage_grant.configured, false);
  assert.deepEqual(families.pdf_storage_grant.missing.sort(), ['PDF_TOOL_STORAGE_SITE_ID', 'PDF_TOOL_STORAGE_TOKEN']);
  assert.equal(
    families.pdf_bridge.configured,
    true,
    'only the fleet-shared pdf_bridge pair is load-bearing for capture'
  );

  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = captureStub();
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const created = await rpc(
      'create_capture_job',
      { site_id: 'site_drlurie', url: SEED, policy: policyFixture() },
      logs
    );
    assert.ok(!created.result.isError, JSON.stringify(created.result.structuredContent));
    assert.equal(created.result.structuredContent?.jobId, 'capjob-1');
    assert.equal(created.result.structuredContent?.projectId, 'dr-lurie');
    assert.equal(created.result.structuredContent?.effective_max_pages, 20);
    // The bridge's own polling instructions — a caller is never pointed at pdf-tool.
    assert.deepEqual(created.result.structuredContent?.polling, {
      tool: 'get_capture_job_status',
      input: { site_id: 'site_drlurie', job_id: 'capjob-1' },
      recommended_interval_ms: 5000,
      terminal_statuses: ['complete', 'failed'],
    });

    const status = await rpc('get_capture_job_status', { site_id: 'site_drlurie', job_id: 'capjob-1' }, logs);
    assert.ok(!status.result.isError, JSON.stringify(status.result.structuredContent));
    assert.equal(status.result.structuredContent?.status, 'complete');
    assert.equal((status.result.structuredContent?.result as { capturedPages: number }).capturedPages, 1);
    // A completed job hands back the reference and tells the caller where the document is.
    assert.equal((status.result.structuredContent?.snapshot_read as { tool: string }).tool, 'get_capture_snapshot');

    const read = await rpc('get_capture_snapshot', { site_id: 'site_drlurie', job_id: 'capjob-1' }, logs);
    assert.ok(!read.result.isError, JSON.stringify(read.result.structuredContent));
    const snapshot = read.result.structuredContent?.snapshot as { schemaVersion: string; pages: unknown[] };
    assert.equal(snapshot.schemaVersion, 'snapshot.v1');
    assert.equal(snapshot.pages.length, 1);

    // NOT ONE of the three pdf-tool calls carried a storage grant: option A means the
    // credential does not exist rather than being hidden.
    assert.equal(calls.length, 3);
    for (const call of calls) {
      assert.equal(call.path, '/.netlify/functions/mcp');
      assert.equal(call.authorization, `Bearer ${RUN_SECRET}`);
      assert.equal(call.body.storage, undefined, `${call.tool} must forward no storage grant`);
      assert.equal(call.body.projectId, 'dr-lurie', 'the canonical project is resolved server-side');
    }
    // The request scope is derived server-side, never named by the caller.
    const requestId = String(calls[0].body.requestId);
    assert.match(requestId, /^capture_[a-f0-9]{24}$/);
    const again = await rpc(
      'create_capture_job',
      { site_id: 'site_drlurie', url: SEED, policy: policyFixture() },
      logs
    );
    assert.equal(
      String((again.result.structuredContent as { requestId?: unknown }).requestId),
      requestId,
      'the same site + seed URL always resolves to the same pdf-tool idempotency scope, so a re-driven crawl re-attaches'
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('no bridge tool can hand a caller a grant, a token, or a Netlify site id — even when pdf-tool echoes one back', async () => {
  // Set the per-site pair for THIS test only, so a leak would have something to leak, and
  // prove the capture bridge still neither uses nor exposes it.
  process.env.PDF_TOOL_STORAGE_TOKEN = STORAGE_SECRET;
  process.env.PDF_TOOL_STORAGE_SITE_ID = 'site-api-id';
  const originalFetch = globalThis.fetch;
  const echoed = {
    // A hostile/careless remote echoing credential-shaped fields back at the bridge.
    storage: { siteId: 'site-api-id', token: STORAGE_SECRET },
    token: STORAGE_SECRET,
    siteId: 'site-api-id',
  };
  const { calls, fetchImpl } = captureStub({
    create_capture_job: (body) => ({
      status: 202,
      body: { jobId: 'capjob-1', status: 'pending', projectId: body.projectId, requestId: body.requestId, ...echoed },
    }),
    get_capture_job_status: (body) => ({
      body: { jobId: 'capjob-1', status: 'running', projectId: body.projectId, requestId: 'capture_x', ...echoed },
    }),
    get_capture_snapshot: (body) => ({
      body: {
        projectId: body.projectId,
        jobId: body.jobId,
        schemaVersion: 'snapshot.v1',
        snapshot: snapshotFixture(),
        ...echoed,
      },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const logs: Array<Record<string, unknown>> = [];
    const wire: string[] = [];
    for (const [name, args] of [
      ['create_capture_job', { site_id: 'site_drlurie', url: SEED, policy: policyFixture() }],
      ['get_capture_job_status', { site_id: 'site_drlurie', job_id: 'capjob-1' }],
      ['get_capture_snapshot', { site_id: 'site_drlurie', job_id: 'capjob-1' }],
    ] as Array<[string, Record<string, unknown>]>) {
      const called = await rpc(name, args, logs);
      assert.ok(!called.result.isError, JSON.stringify(called.result.structuredContent));
      wire.push(called.response.body);
    }
    for (const body of wire) {
      assert.ok(!body.includes(STORAGE_SECRET), 'no bridge response may carry a storage token');
      assert.ok(!body.includes(RUN_SECRET), 'no bridge response may carry the pdf-tool run token');
      assert.ok(!body.includes('site-api-id'), 'no bridge response may carry a Netlify site id');
      assert.ok(!body.includes('"storage"'), 'no bridge response may carry a storage grant object');
    }
    const loggedText = JSON.stringify(logs);
    assert.ok(
      !loggedText.includes(STORAGE_SECRET) && !loggedText.includes(RUN_SECRET) && !loggedText.includes('site-api-id')
    );
    // And the bridge never sent one either, even with the pair configured.
    for (const call of calls) assert.equal(call.body.storage, undefined);
  } finally {
    globalThis.fetch = originalFetch;
    delete process.env.PDF_TOOL_STORAGE_TOKEN;
    delete process.env.PDF_TOOL_STORAGE_SITE_ID;
  }
});

test('a caller cannot widen the registry capture policy: invariants are refused and maxPages is clamped, before anything is forwarded', async () => {
  const originalFetch = globalThis.fetch;
  const { calls, fetchImpl } = captureStub();
  globalThis.fetch = fetchImpl;
  try {
    const refuse = async (policy: unknown, expectedCode: string, args: Record<string, unknown> = {}) => {
      const called = await rpc('create_capture_job', { site_id: 'site_drlurie', url: SEED, policy, ...args });
      assert.equal(
        called.result.isError,
        true,
        `expected a refusal, got ${JSON.stringify(called.result.structuredContent)}`
      );
      assert.equal(called.result.structuredContent?.error_code, expectedCode);
    };

    // The four T12 invariants are ceilings this bridge cannot relax.
    await refuse(policyFixture({ sameOriginOnly: false }), 'capture_policy_denies');
    await refuse(policyFixture({ respectRobots: false }), 'capture_policy_denies');
    await refuse(policyFixture({ authenticatedAccess: 'allowed' }), 'capture_policy_denies');
    await refuse(policyFixture({ maxPages: 0 }), 'capture_policy_denies');
    await refuse(policyFixture({ allowedCrawlOrigins: [] }), 'capture_policy_denies');
    // A policy SUBSET (the T12.9 defect) fails HERE, with a bridge error code.
    const { rights: _rights, ...withoutRights } = policyFixture();
    await refuse(withoutRights, 'capture_policy_invalid');
    const { fidelity: _fidelity, ...withoutFidelity } = policyFixture();
    await refuse(withoutFidelity, 'capture_policy_invalid');
    // A seed outside the policy the same call carries.
    await refuse(policyFixture({ allowedPathPrefixes: ['/blog'] }), 'capture_source_out_of_policy');
    await refuse(policyFixture(), 'capture_source_out_of_policy', { url: 'https://elsewhere.example.org/' });
    // Another tenant's site id.
    const mismatched = await rpc('create_capture_job', {
      site_id: 'site_fernwell',
      url: SEED,
      policy: policyFixture(),
    });
    assert.equal(mismatched.result.structuredContent?.error_code, 'capture_site_mismatch');

    assert.equal(calls.length, 0, 'not one refusal may reach pdf-tool');

    // maxPages is CLAMPED to the plane's hard ceiling, not honored and not merely relayed.
    const clamped = await rpc('create_capture_job', {
      site_id: 'site_drlurie',
      url: SEED,
      policy: policyFixture({ maxPages: 10_000 }),
    });
    assert.ok(!clamped.result.isError, JSON.stringify(clamped.result.structuredContent));
    assert.equal(clamped.result.structuredContent?.effective_max_pages, CAPTURE_BRIDGE_MAX_PAGES);
    assert.equal((calls[0].body.policy as { maxPages: number }).maxPages, CAPTURE_BRIDGE_MAX_PAGES);
    assert.ok(String(clamped.result.structuredContent?.policy_clamped).includes(String(CAPTURE_BRIDGE_MAX_PAGES)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the snapshot read path refuses anything that is not a snapshot.v1 and passes pdf-tool refusals through typed', async () => {
  const originalFetch = globalThis.fetch;
  const { fetchImpl } = captureStub({
    get_capture_snapshot: () => ({
      body: { projectId: 'dr-lurie', jobId: 'capjob-1', snapshot: { schemaVersion: 'snapshot.v2', pages: [] } },
    }),
  });
  globalThis.fetch = fetchImpl;
  try {
    const wrongVersion = await rpc('get_capture_snapshot', { site_id: 'site_drlurie', job_id: 'capjob-1' });
    assert.equal(wrongVersion.result.isError, true);
    assert.equal(wrongVersion.result.structuredContent?.error_code, 'capture_snapshot_invalid');
  } finally {
    globalThis.fetch = originalFetch;
  }

  const notReady = stubPdfToolMcp({
    get_capture_snapshot: () => ({
      status: 409,
      body: { error: 'Capture job is "running", not complete', errorCode: 'CAPTURE_SNAPSHOT_NOT_READY' },
    }),
  });
  globalThis.fetch = notReady.fetchImpl;
  try {
    const pending = await rpc('get_capture_snapshot', { site_id: 'site_drlurie', job_id: 'capjob-1' });
    assert.equal(pending.result.isError, true);
    assert.equal(pending.result.structuredContent?.errorCode, 'CAPTURE_SNAPSHOT_NOT_READY');
    assert.equal(pending.result.structuredContent?.error_code, 'pdf_tool_bridge_request_failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('the capture bridge degrades with a catalogued error_code when the fleet-shared pdf-tool bridge is unconfigured', async () => {
  const baseUrl = process.env.PDF_TOOL_BASE_URL;
  delete process.env.PDF_TOOL_BASE_URL;
  try {
    const called = await rpc('create_capture_job', { site_id: 'site_drlurie', url: SEED, policy: policyFixture() });
    assert.equal(called.result.isError, true);
    assert.equal(called.result.structuredContent?.error_code, 'pdf_tool_bridge_request_failed');
    // Env-var NAMES only, never a value.
    assert.match(String(called.result.structuredContent?.error), /PDF_TOOL_BASE_URL/);
  } finally {
    process.env.PDF_TOOL_BASE_URL = baseUrl;
  }
});
