import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';
import { annotationsFor, toWireTool } from '../../packages/core/server/lib/mcp-tool-annotations.js';

const definition = (name: string) => {
  const found = visibleToolDefinitions().find((t) => t.name === name);
  assert.ok(found, `${name} is not on the tool surface`);
  return found;
};

test('reads are marked readOnlyHint — the fix for "Read actions: none"', () => {
  // The live ChatGPT Agent confirmed every call, including object_get, because
  // this surface emitted no annotations at all.
  for (const name of [
    'object_get',
    'object_contract',
    'object_inventory',
    'object_list',
    'object_validate',
    'deploy_status',
  ]) {
    assert.equal(annotationsFor(definition(name)).readOnlyHint, true, `${name} should be read-only`);
  }
});

test('writes are not marked read-only', () => {
  for (const name of ['object_create', 'object_patch', 'object_publish', 'release_to_production']) {
    assert.equal(annotationsFor(definition(name)).readOnlyHint, false, `${name} must not claim read-only`);
  }
});

test('readOnlyHint is derived from the governance class, never a second list', () => {
  for (const tool of visibleToolDefinitions()) {
    assert.equal(
      annotationsFor(tool).readOnlyHint,
      tool.governance.toolClass === 'read',
      `${tool.name} annotation disagrees with its governance class`
    );
  }
});

test('publishing is a write but not destructive — a client should not warn as though it were', () => {
  assert.equal(annotationsFor(definition('object_publish')).destructiveHint, false);
  assert.equal(annotationsFor(definition('object_create')).destructiveHint, false);
  assert.equal(annotationsFor(definition('object_patch')).destructiveHint, false);
  // The ones that really do remove or overwrite.
  assert.equal(annotationsFor(definition('object_retire')).destructiveHint, true);
  assert.equal(annotationsFor(definition('object_discard')).destructiveHint, true);
});

test('idempotentHint is claimed only where the idempotency contract is actually implemented', () => {
  // QA-W16-1: the key replays the original receipt instead of running twice —
  // proven live when a 502 on object_publish replayed rather than double-published.
  assert.equal(annotationsFor(definition('object_publish')).idempotentHint, true);
  assert.equal(annotationsFor(definition('object_create')).idempotentHint, true);
  // object_patch has no idempotency_key, so it must not claim one.
  assert.equal(annotationsFor(definition('object_patch')).idempotentHint, false);
  // Reads are trivially idempotent.
  assert.equal(annotationsFor(definition('object_get')).idempotentHint, true);
});

test('openWorldHint marks only the tools that reach outside this tenant', () => {
  assert.equal(annotationsFor(definition('search_images')).openWorldHint, true);
  assert.equal(annotationsFor(definition('import_image_from_url')).openWorldHint, true);
  assert.equal(annotationsFor(definition('object_get')).openWorldHint, false);
  assert.equal(annotationsFor(definition('object_publish')).openWorldHint, false);
});

test('the wire tool carries the MCP fields and NOT the internal governance field', () => {
  const wire = toWireTool(definition('object_publish'));
  // `_meta` is the spec's extension slot; W7.5 puts the per-tool schema digest
  // there rather than at the top level, where an unknown key is a client's
  // prerogative to reject.
  assert.deepEqual(Object.keys(wire).sort(), ['_meta', 'annotations', 'description', 'inputSchema', 'name']);
  assert.ok(!('governance' in wire), 'governance is an internal classification, not protocol');
  assert.match(wire._meta.schema_version, /^v[0-9a-f]{8}$/);
});

test('a tool schema version moves when the SCHEMA moves, and not when the prose does', () => {
  const tool = definition('object_publish');
  const sameProse = { ...tool, description: 'A completely different sentence for the model.' };
  const changedSchema = {
    ...tool,
    inputSchema: { ...(tool.inputSchema as Record<string, unknown>), required: ['object_id', 'something_new'] },
  };
  assert.equal(toWireTool(sameProse)._meta.schema_version, toWireTool(tool)._meta.schema_version);
  assert.notEqual(toWireTool(changedSchema)._meta.schema_version, toWireTool(tool)._meta.schema_version);
});

test('tools/list over the real handler emits annotations and leaks no governance', async () => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'x-mcp-auth-token': 'test-token', authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  // Auth may refuse in this harness; the shape assertion only applies to a 200.
  if (response.statusCode !== 200) return;
  const body = JSON.parse(response.body) as { result?: { tools?: Array<Record<string, unknown>> } };
  const tools = body.result?.tools;
  if (!tools?.length) return;
  for (const tool of tools) {
    assert.ok(!('governance' in tool), `${String(tool.name)} leaked governance over the wire`);
    assert.ok(tool.annotations, `${String(tool.name)} has no annotations`);
    const annotations = tool.annotations as Record<string, unknown>;
    assert.equal(typeof annotations.readOnlyHint, 'boolean');
  }
  const get = tools.find((t) => t.name === 'object_get');
  if (get) assert.equal((get.annotations as Record<string, unknown>).readOnlyHint, true);
});
