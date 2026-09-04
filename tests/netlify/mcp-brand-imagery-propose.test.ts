// P5 (brand-imagery wave, BRIEF §3.5): the thin `brand_imagery_propose`
// proxy, exercised through the real MCP dispatch (netlify/functions/mcp.ts)
// with a stubbed CmsAgentClient — proving the input shape it sends CMS-Agent,
// the >8-references 400, the invalid-proposal 502 with reason, and that the
// whole path never touches the object store (zero object writes).
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

process.env.ADMIN_EMAILS = 'wolf@example.com';
process.env.CMS_AGENT_MCP_ENDPOINT = 'https://cms-agent.test/mcp';
process.env.CMS_AGENT_MCP_TOKEN = 'test-cms-agent-token';
process.env.PUBLISH_SECRET = 'test-publish-secret';
process.env.URL = 'https://drlurie.example';
delete process.env.NETLIFY_BLOBS_TOKEN;
delete process.env.NETLIFY_AUTH_TOKEN;

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-brand-imagery-propose');

/**
 * The CmsAgentClient bridge captures `globalThis.fetch` at construction
 * (module load) — the stub must be installed before mcp.ts (which builds the
 * module-level CmsAgentClient in mcp-tool-handlers.ts) is imported. Same rig
 * as admin-requests-view.test.ts / request-activity-approve.test.ts.
 */
type DispatchOutcome =
  | { ok: true; data: unknown }
  | { ok: false; code: string; message: string }
  // D1 fix (task A2): simulates the RAW JSON-RPC error CMS-Agent's dispatcher
  // sends for a tool name it does not recognize at all (workspace/server.ts:
  // `{code:-32602, message:"Unknown tool: <name>"}`, no `data`) — distinct
  // from the `{ok:false,...}` structuredContent shape below, which is what a
  // TOOL's own thrown business error looks like once CmsAgentClient.callTool
  // has parsed a normal `result.structuredContent`. Only a real JSON-RPC
  // `error` field (not this envelope) sets `fromJsonBody` the way an actual
  // "unknown tool" failure does on the wire.
  | { jsonRpcError: { code: number; message: string } };

let dispatch: (name: string, args: Record<string, unknown>) => DispatchOutcome = () => ({ ok: true, data: {} });
let calls: Array<{ name: string; args: Record<string, unknown> }> = [];

const jsonRes = (body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', ...headers } });

globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  const payload = JSON.parse(String(init?.body ?? '{}')) as {
    method?: string;
    params?: { name?: string; arguments?: Record<string, unknown> };
  };
  if (payload.method === 'initialize') {
    return jsonRes({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18' } }, { 'mcp-session-id': 'brand-imagery-session' });
  }
  if (payload.method === 'notifications/initialized') return jsonRes({});
  const name = payload.params?.name ?? '';
  const args = payload.params?.arguments ?? {};
  calls.push({ name, args });
  const outcome = dispatch(name, args);
  if ('jsonRpcError' in outcome) {
    return jsonRes({ jsonrpc: '2.0', id: 2, error: outcome.jsonRpcError });
  }
  return jsonRes({
    jsonrpc: '2.0',
    id: 2,
    result: { structuredContent: { ok: outcome.ok, ...(outcome.ok ? { data: outcome.data } : { code: outcome.code, message: outcome.message }) } },
  });
}) as typeof fetch;

const { setLocalBlobsRootForTesting, createLocalBlobStore } = await import('../../packages/core/server/lib/local-blobs.js');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const { handler } = await import('../../netlify/functions/mcp.js');

type ToolResult = { isError?: boolean; structuredContent?: Record<string, unknown> };

const rpc = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  return { result: (JSON.parse(response.body) as { result: ToolResult }).result };
};

const listAllBlobKeys = async (): Promise<string[]> => {
  const stores = ['site-objects', 'artifacts', 'artifact-index'];
  const keys: string[] = [];
  for (const storeName of stores) {
    const { blobs } = await createLocalBlobStore(storeName).list();
    keys.push(...blobs.map((blob) => `${storeName}/${blob.key}`));
  }
  return keys.sort();
};

const reset = async () => {
  await rm(LOCAL_BLOBS_ROOT, { recursive: true, force: true });
  calls = [];
};

const VALID_BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography.',
  palette: ['#2E5C42'],
  negative: ['no stock-photo gloss'],
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
};

// A raw Major-Key artifact ref (image/<id>/<sha256>.<ext>) — the shape
// publicPathForArtifactRef actually recognizes and rewrites to /img/<...>.
const MOOD_BLOB_KEY = `image/req_mood/${'a'.repeat(64)}.jpg`;

const validProposal = (overrides: Record<string, unknown> = {}) => ({
  artifact: 'brand_imagery_proposal.v1',
  mode: 'house',
  brandImagery: VALID_BRAND_IMAGERY,
  rationale: "Matches the site's existing warm neutral palette.",
  sampleSubjects: ['a jar of moisturizer on a marble countertop'],
  confidence: 'high',
  label: 'Clinical clean',
  ...overrides,
});

/** REVIEW (brand-imagery wave): the real `node.execute` return shape —
 *  `{execution, executionId}` with the proposal as the node's OUTPUT. The
 *  end-to-end happy path asserts against THIS, not a bare proposal the wire
 *  never carries. */
const nodeExecuteResult = (proposal: unknown) => ({
  executionId: 'exec_1',
  execution: {
    runId: 'run_1',
    workflowId: 'independent_node',
    status: 'completed',
    nodes: [{ nodeId: 'brand_imagery_writer', status: 'completed', output: proposal }],
    artifacts: [{ id: 'artifact_1', nodeId: 'brand_imagery_writer', type: 'brand_imagery_proposal.v1', value: proposal }],
    stageOutputs: { brand_imagery_writer: proposal },
    errors: [],
  },
});

test('tools/list exposes brand_imagery_propose', async () => {
  await reset();
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const tools = (JSON.parse(response.body) as { result: { tools: Array<{ name: string }> } }).result.tools;
  assert.ok(tools.some((tool) => tool.name === 'brand_imagery_propose'));
});

test('brand_imagery_propose forwards the §3.5 input shape to visual_identity_propose and returns the proposal (D1 fix, task A2)', async () => {
  await reset();
  dispatch = (name) =>
    name === 'visual_identity_propose'
      ? { ok: true, data: nodeExecuteResult(validProposal()) }
      : { ok: false, code: 'unexpected', message: 'unexpected' };

  const before = await listAllBlobKeys();
  const { result } = await rpc('brand_imagery_propose', {
    mode: 'house',
    brief: 'Clinical-clean skincare, warm neutrals.',
    references: [{ blob_key: MOOD_BLOB_KEY, note: 'the palette, not the subject' }],
  });
  const after = await listAllBlobKeys();

  assert.ok(!result.isError, JSON.stringify(result.structuredContent));
  assert.deepEqual(result.structuredContent?.brandImagery, VALID_BRAND_IMAGERY);
  assert.equal(result.structuredContent?.confidence, 'high');

  const call = calls.find((c) => c.name === 'visual_identity_propose');
  assert.ok(call);
  assert.equal(calls.some((c) => c.name === 'node_execute'), false, 'must never call the retired node_execute tool');
  const writerInput = call!.args as Record<string, unknown>;
  assert.equal(writerInput.mode, 'house');
  assert.equal(writerInput.kind, 'brand_imagery');
  assert.equal(writerInput.brief, 'Clinical-clean skincare, warm neutrals.');
  assert.equal(typeof writerInput.project_id, 'string');
  assert.ok((writerInput.project_id as string).length > 0);
  assert.equal(writerInput.projectId, undefined, 'project_id must be snake_case on the wire');
  assert.deepEqual(writerInput.references, [{ blobKey: MOOD_BLOB_KEY, note: 'the palette, not the subject' }]);
  // Whole-image reference (no region) resolves to a fetchable absolute URL.
  assert.deepEqual(writerInput.imageRefs, [
    { url: `https://drlurie.example/img/req_mood/${'a'.repeat(64)}.jpg`, mediaType: 'image/jpeg', label: 'the palette, not the subject' },
  ]);

  // Zero object writes: the whole call never touched any object/artifact store.
  assert.deepEqual(after, before);
});

test('brand_imagery_propose: more than 8 references is a 400 and never calls CMS-Agent, with zero object writes', async () => {
  await reset();
  dispatch = () => ({ ok: true, data: validProposal() });

  const before = await listAllBlobKeys();
  const references = Array.from({ length: 9 }, (_, i) => ({ blob_key: `image/site/ref-${i}.jpg` }));
  const { result } = await rpc('brand_imagery_propose', { mode: 'house', references });
  const after = await listAllBlobKeys();

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.statusCode, 400);
  assert.equal(result.structuredContent?.error_code, 'brand_imagery_propose_too_many_references');
  assert.equal(calls.filter((c) => c.name === 'visual_identity_propose').length, 0);
  assert.deepEqual(after, before);
});

test('brand_imagery_propose: an invalid proposal from CMS-Agent is a 502 carrying the reason, with zero object writes', async () => {
  await reset();
  dispatch = (name) => {
    if (name !== 'visual_identity_propose') return { ok: false, code: 'unexpected', message: 'unexpected' };
    const { sampleSubjects: _drop, ...rest } = validProposal();
    return { ok: true, data: rest };
  };

  const before = await listAllBlobKeys();
  const { result } = await rpc('brand_imagery_propose', { mode: 'house', brief: 'Warm neutrals.' });
  const after = await listAllBlobKeys();

  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.statusCode, 502);
  assert.equal(result.structuredContent?.error_code, 'brand_imagery_propose_invalid_proposal');
  assert.ok(
    typeof result.structuredContent?.error === 'string' && (result.structuredContent!.error as string).includes('sampleSubjects'),
    JSON.stringify(result.structuredContent)
  );
  assert.ok(typeof result.structuredContent?.reason === 'string' && (result.structuredContent!.reason as string).length > 0);
  assert.deepEqual(after, before);
});

test('brand_imagery_propose: neither references nor brief is a 400, never calls CMS-Agent', async () => {
  await reset();
  dispatch = () => ({ ok: true, data: validProposal() });
  const { result } = await rpc('brand_imagery_propose', { mode: 'house' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.statusCode, 400);
  assert.equal(calls.filter((c) => c.name === 'visual_identity_propose').length, 0);
});

test('brand_imagery_propose: an unrecognized-tool-name CMS-Agent failure surfaces its own error_code, never a generic 502 (D1 fix, task A2)', async () => {
  await reset();
  dispatch = () => ({ jsonRpcError: { code: -32602, message: 'Unknown tool: visual_identity_propose' } });

  const { result } = await rpc('brand_imagery_propose', { mode: 'house', brief: 'Warm neutrals.' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.statusCode, 502);
  assert.equal(result.structuredContent?.error_code, 'brand_imagery_propose_tool_not_allowed');
});
