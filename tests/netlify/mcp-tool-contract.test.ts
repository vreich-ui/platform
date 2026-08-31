/**
 * Descriptive contract of the MCP tool surface — the parts of a tool's
 * description and input schema that agents actually plan against.
 *
 * The `save_json_blob_*` half of this file was deleted on 2026-07-29 with the
 * legacy article pipeline (ruling OQ-W11-6). That surface's absence is pinned
 * in `mcp-legacy-tool-surface.test.ts`; what remains here are the artifact
 * tools, which are live on the object path.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler } from '../../netlify/functions/mcp.js';

type ToolDefinition = {
  name: string;
  description: string;
  inputSchema: {
    required?: string[];
    properties?: Record<string, unknown>;
  };
};

const listTools = async (): Promise<ToolDefinition[]> => {
  const response = await handler({
    httpMethod: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  const body = JSON.parse(response.body) as { result: { tools: ToolDefinition[] } };

  assert.equal(response.statusCode, 200);
  return body.result.tools;
};

const getTool = (tools: ToolDefinition[], name: string) => {
  const tool = tools.find((candidate) => candidate.name === name);
  assert.ok(tool, `expected tools/list to include ${name}`);
  return tool;
};

test('agent discovery omits artifact upload, deletion, and maintenance actions', async () => {
  const tools = await listTools();
  const names = new Set(tools.map((tool) => tool.name));

  for (const name of [
    'trigger_netlify_build',
    'get_pdf_tool_storage_grant',
    'create_artifact_upload_intent',
    'create_artifact_from_url',
    'save_artifact',
    'soft_delete_artifact',
    'restore_artifact',
    'migrate_artifact_indexes',
    'wipe_blob_stores',
    'reconcile_artifact_indexes',
  ]) {
    assert.equal(names.has(name), false, `${name} must stay out of agent discovery`);
  }

  for (const name of ['list_artifacts_for_request', 'get_artifact_metadata', 'object_get', 'object_patch']) {
    assert.equal(names.has(name), true, `${name} information exchange must remain visible`);
  }
});

test('artifact metadata tool descriptions document soft-delete visibility', async () => {
  const tools = await listTools();

  assert.match(getTool(tools, 'list_artifacts_for_request').description, /soft-deleted artifacts are excluded/i);
  assert.match(getTool(tools, 'get_artifact_metadata').description, /deletedAtISO/);
});

test('verify_article_images advertises the expectedDocuments sibling without widening its name or required set', async () => {
  const tools = await listTools();
  const tool = getTool(tools, 'verify_article_images');
  assert.deepEqual(tool.inputSchema.required, ['url', 'expectedImages']);
  const documents = tool.inputSchema.properties?.expectedDocuments as { type: string; description: string } | undefined;
  assert.ok(documents, 'expectedDocuments must be in the input schema');
  assert.equal(documents.type, 'array');
  assert.match(documents.description, /application\/pdf/);
  assert.match(tool.description, /expectedDocuments/);
  assert.match(tool.description, /\/pdf\/\{id\}\/\{sha256\}\.pdf/);
  assert.equal(
    tools.some((candidate) => candidate.name === 'verify_article_media'),
    false,
    'no sibling tool name'
  );
});
