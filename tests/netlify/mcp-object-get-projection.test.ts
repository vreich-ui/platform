import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';

/**
 * W6 D3 — `object_get` projections, driven through the REAL `/mcp` handler.
 *
 * The defect report said large payloads 502 through the tenant `/mcp`. Measured
 * 2026-09-01 against the live drlurie endpoint, that premise is false: `ping`
 * (a ~200-byte response) 502s too, `object_inventory` on the same article 502'd
 * and then succeeded unchanged 36 s later, and the function itself answers
 * `?health=1` in 250–650 ms on a warm instance. The 502s are transport, not
 * payload size.
 *
 * What IS real is that `object_get` had exactly one shape and two unbounded
 * parts in it: `history` (one entry per verb, never pruned — a live article is
 * at version 88) and, for an article, the whole body. This suite pins the three
 * projections that fix that, with a ≥10-node article body carrying rich text.
 *
 * The test drives `tools/call` on the real handler — no wrapper tool, no
 * separate test surface — and measures the ACTUAL serialized response bytes,
 * which is the mechanical measurement the defect asked for.
 */
for (const key of [
  'NETLIFY',
  'NETLIFY_SITE_ID',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_AUTH_TOKEN',
  'SITE_ID',
  'MCP_HTTP_AUTH_TOKEN',
]) {
  delete process.env[key];
}
process.env.PUBLISH_SECRET = 'test-publish-secret';

const LOCAL_BLOBS_ROOT = join(process.cwd(), '.netlify', 'local-blobs-test', 'mcp-object-get-projection');
setLocalBlobsRootForTesting(LOCAL_BLOBS_ROOT);
const SITE_OBJECTS_DIR = join(LOCAL_BLOBS_ROOT, 'site-objects');

const OBJECT_ID = 'req_probe_projection_20260901_01';

type ToolCallResult = {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

/** Returns the tool result AND the exact bytes the handler put on the wire. */
const callTool = async (name: string, args: Record<string, unknown>) => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  assert.equal(response.statusCode, 200);
  const parsed = JSON.parse(response.body) as { result: ToolCallResult };
  return { result: parsed.result, wireBytes: Buffer.byteLength(response.body) };
};

/**
 * A ≥10-node article with rich_text bodies — the payload shape the defect
 * report was filed against. Reader-visible strings stay reader-safe (the
 * strategy vocabulary lives in `private`, which is exactly the split Q is
 * about); the annotation layer is present on every node so the projections
 * are exercised against a realistic record.
 */
const paragraph = (lead: string) =>
  `<p>${lead} The point of this paragraph is to carry enough prose that the serialized body is a realistic size ` +
  `rather than a toy, because the assertion at the end of this suite is about bytes on the wire and a fixture ` +
  `made of three-word nodes would not measure anything worth measuring.</p>` +
  `<p>A second paragraph, for the same reason: real article nodes are several hundred bytes each, and ten of ` +
  `them plus an annotation layer is what a finished article actually weighs.</p>`;

const NODES = [
  { id: 'n_01', title: undefined, lead: 'A new product can feel unfamiliar on the skin for a few minutes.' },
  { id: 'n_02', title: 'What people notice first', lead: 'The sensation usually arrives quickly and fades.' },
  { id: 'n_03', title: 'What the research says', lead: 'Test responses vary widely between individuals.' },
  { id: 'n_04', title: 'What it is not', lead: 'A brief sensation is not by itself evidence of damage.' },
  { id: 'n_05', title: 'When to stop', lead: 'Redness that persists for hours is a different signal.' },
  { id: 'n_06', title: 'Ingredients often involved', lead: 'Several common actives are associated with it.' },
  { id: 'n_07', title: 'How to introduce a product', lead: 'Slower introduction gives useful information.' },
  { id: 'n_08', title: 'What to watch over a week', lead: 'Patterns over days tell you more than one application.' },
  { id: 'n_09', title: 'Where this leaves you', lead: 'Most people can tell the two situations apart.' },
].map((node) => ({
  id: node.id,
  kind: 'content' as const,
  public: { ...(node.title ? { title: node.title } : {}), body: paragraph(node.lead) },
  private: { strategy: 'explanation', intent: 'educate' },
}));

const BODY = {
  slug: 'projection-probe-article',
  title: 'A ten-node article, for measuring reads',
  deck: 'A fixture long enough that the difference between projections is a real number.',
  description: 'A ten-node fixture article used to pin the object_get projections against the real MCP handler.',
  author: 'Dr. Lurie',
  taxonomy: { category: 'skin-health', tags: ['skincare-basics'] },
  seo: { meta_description: 'A ten-node fixture article used to pin the object_get projections.' },
  nodes: [
    ...NODES,
    {
      id: 'n_10',
      kind: 'action' as const,
      public: { title: 'Read more', body: '<p>More notes on introducing products slowly.</p>', ctaText: 'More notes' },
      private: { strategy: 'recommendation', intent: 'navigate' },
    },
  ],
};

test('object_get projections: bounded reads through the real /mcp handler', async (t) => {
  await rm(SITE_OBJECTS_DIR, { recursive: true, force: true });

  const created = await callTool('object_create', {
    object_type: 'content_item',
    site: 'site_drlurie',
    requested_id: OBJECT_ID,
    body: BODY,
  });
  assert.ok(!created.result.isError, `object_create failed: ${created.result.content?.[0]?.text}`);

  const full = await callTool('object_get', { object_type: 'content_item', object_id: OBJECT_ID });
  const nodes = await callTool('object_get', {
    object_type: 'content_item',
    object_id: OBJECT_ID,
    projection: 'nodes',
  });
  const summary = await callTool('object_get', {
    object_type: 'content_item',
    object_id: OBJECT_ID,
    projection: 'summary',
  });

  for (const [label, call] of [
    ['full', full],
    ['nodes', nodes],
    ['summary', summary],
  ] as const) {
    assert.ok(!call.result.isError, `${label} projection errored: ${call.result.content?.[0]?.text}`);
  }

  const recordOf = (call: { result: ToolCallResult }) =>
    (call.result.structuredContent as { record: Record<string, unknown> }).record;

  await t.test('the default is unchanged — full carries the whole record', () => {
    const record = recordOf(full);
    assert.ok(Array.isArray(record.history), 'full must still carry the history ledger');
    assert.equal((record.body as { nodes: unknown[] }).nodes.length, 10);
    assert.equal(
      (record.body as { nodes: { public: { body?: string } }[] }).nodes[0].public.body,
      BODY.nodes[0].public.body,
      'full must return node bodies verbatim'
    );
    assert.equal(
      full.result.structuredContent?.projection,
      undefined,
      'full must not add keys to the historical shape'
    );
  });

  await t.test('nodes projection: full body, no ledger', () => {
    const record = recordOf(nodes);
    assert.equal(record.history, undefined, 'nodes projection must omit the history ledger');
    assert.equal(record.history_length, 1, 'the ledger is replaced by its length, not silently dropped');
    assert.equal((record.body as { nodes: unknown[] }).nodes.length, 10);
    assert.equal(
      (record.body as { nodes: { public: { body?: string } }[] }).nodes[0].public.body,
      BODY.nodes[0].public.body,
      'nodes projection is the read before revising — the body must be complete'
    );
    assert.equal(nodes.result.structuredContent?.projection, 'nodes');
  });

  await t.test('summary projection: shape only, no bodies, no ledger', () => {
    const record = recordOf(summary);
    assert.equal(record.history, undefined);
    assert.equal(record.history_length, 1);

    const body = record.body as { node_count: number; nodes: Record<string, unknown>[]; title?: string };
    assert.equal(body.node_count, 10);
    assert.equal(body.nodes.length, 10);
    assert.deepEqual(Object.keys(body.nodes[0]).sort(), ['id', 'kind']);
    assert.equal(body.nodes[9].kind, 'action', 'node kinds survive so the caller can see the article’s shape');
    assert.equal(body.title, BODY.title, 'non-node body fields survive — only the node bodies are dropped');
  });

  await t.test('the annotation layer is never exposed by a projection it did not ask for', () => {
    const summaryNodes = (recordOf(summary).body as { nodes: Record<string, unknown>[] }).nodes;
    for (const node of summaryNodes) assert.equal(node.private, undefined);
  });

  await t.test('measured: summary is under half of full on the wire', () => {
    assert.ok(
      summary.wireBytes * 2 < full.wireBytes,
      `expected summary (${summary.wireBytes} B) to be under half of full (${full.wireBytes} B)`
    );
    assert.ok(
      nodes.wireBytes < full.wireBytes,
      `expected nodes (${nodes.wireBytes} B) to be smaller than full (${full.wireBytes} B)`
    );
  });

  await t.test('tool results are serialized compactly — no pretty-print padding', () => {
    const text = full.result.content?.[0]?.text ?? '';
    assert.ok(text.length > 0);
    assert.ok(!text.includes('\n  '), 'the text half of a tool result must not be indented JSON');
    assert.deepEqual(
      JSON.parse(text),
      full.result.structuredContent,
      'the text half must still parse to exactly the structured half'
    );
  });

  await rm(SITE_OBJECTS_DIR, { recursive: true, force: true });
});
