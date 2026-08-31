import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import test from 'node:test';

import { handler, toolNameFromPath } from '../../netlify/functions/plugin-actions.js';
import {
  buildOpenApiDocument,
  PLUGIN_ACTION_PATH_PREFIX,
} from '../../packages/core/server/lib/plugin/build-openapi.js';
import { buildManifestBundle } from '../../packages/core/server/lib/plugin/build-manifest.js';
import { visibleToolDefinitions } from '../../netlify/functions/mcp.js';

const bundle = buildManifestBundle({
  origin: 'https://drluriescience.netlify.app',
  definitions: visibleToolDefinitions(),
  voice: null,
  platform: 'openai',
  now: () => new Date('2026-08-31T12:00:00.000Z'),
  approval: {
    master: 'all-autonomous',
    overrides: { product: 'require-approval', editorial_voice: 'require-approval' },
  },
});

const doc = buildOpenApiDocument({
  connection: bundle.connection,
  tools: bundle.tools,
  definitions: visibleToolDefinitions(),
  manifestVersion: bundle.manifest_version,
});

type JsonObject = Record<string, unknown>;
type Operation = {
  operationId: string;
  requestBody: { content: { 'application/json': { schema: { properties?: JsonObject } } } };
  'x-openai-isConsequential': boolean;
};
const paths = doc.paths as Record<string, { post: Operation }>;
const parseBody = (r: { body: string }) => JSON.parse(r.body) as Record<string, unknown>;

// ─── path routing ───────────────────────────────────────────────────────────

test('the tool name is the last path segment, however the platform presents it', () => {
  assert.equal(toolNameFromPath('/api/plugin/object_create'), 'object_create');
  assert.equal(toolNameFromPath('/api/plugin/openapi.json'), 'openapi.json');
  assert.equal(toolNameFromPath('/api/plugin/object_patch?x=1'), 'object_patch');
  assert.equal(toolNameFromPath('/.netlify/functions/plugin-actions'), null);
  assert.equal(toolNameFromPath('/api/plugin/'), null);
  assert.equal(toolNameFromPath(undefined), null);
});

// ─── W3.3: the generated OpenAPI document ───────────────────────────────────

test('the document is valid OpenAPI 3.1 with one operation per charter tool', () => {
  assert.equal(doc.openapi, '3.1.0');
  const info = doc.info as Record<string, unknown>;
  assert.equal(info.version, bundle.manifest_version);
  assert.deepEqual(doc.servers, [{ url: 'https://drluriescience.netlify.app' }]);

  const names = bundle.tools.map((t) => t.name).filter((n) => visibleToolDefinitions().some((d) => d.name === n));
  assert.equal(Object.keys(paths).length, names.length);
  for (const name of names) {
    const path = `${PLUGIN_ACTION_PATH_PREFIX}/${name}`;
    assert.ok(paths[path], `${name} has no path`);
    assert.equal(paths[path].post.operationId, name, 'operationId must equal the tool name');
  }
});

test('every operationId is unique — ChatGPT rejects a document that repeats one', () => {
  const ids = Object.values(paths).map((p) => p.post.operationId as string);
  assert.equal(new Set(ids).size, ids.length);
});

test('x-openai-isConsequential is computed from the tool class, never hand-set', () => {
  for (const tool of bundle.tools) {
    const path = paths[`${PLUGIN_ACTION_PATH_PREFIX}/${tool.name}`];
    if (!path) continue;
    assert.equal(
      path.post['x-openai-isConsequential'],
      tool.tool_class !== 'read',
      `${tool.name} has the wrong consequential flag`
    );
  }
  // Spot-check the two that matter most in either direction.
  assert.equal(paths[`${PLUGIN_ACTION_PATH_PREFIX}/object_publish`].post['x-openai-isConsequential'], true);
  assert.equal(paths[`${PLUGIN_ACTION_PATH_PREFIX}/object_contract`].post['x-openai-isConsequential'], false);
});

test('no request schema carries $schema — ChatGPT rejects the whole document if one does', () => {
  const findSchemaKey = (node: unknown): boolean => {
    if (Array.isArray(node)) return node.some(findSchemaKey);
    if (!node || typeof node !== 'object') return false;
    if ('$schema' in (node as object)) return true;
    return Object.values(node as Record<string, unknown>).some(findSchemaKey);
  };
  assert.equal(findSchemaKey(doc), false);
});

test('request schemas come from the LIVE tool definitions, not a hand-kept copy', () => {
  // The five drifts W0.3 found in the legacy hand-written schema, pinned so they
  // cannot come back.
  const props = (name: string): JsonObject =>
    paths[`${PLUGIN_ACTION_PATH_PREFIX}/${name}`].post.requestBody.content['application/json'].schema.properties ?? {};

  assert.ok('expectedDocuments' in props('verify_article_images'), 'PDFs could never be verified without this');
  assert.ok('operation' in props('create_agent_artifact_job'));
  assert.ok(paths[`${PLUGIN_ACTION_PATH_PREFIX}/object_refresh_lock`], 'the 900 s lease needs a refresh op');
  assert.ok('agent_name' in props('object_patch'), 'W1.0 attribution must reach the façade');
  assert.ok('producer' in props('object_publish'));
});

test('the OAuth block carries the real endpoints and NO invented scope', () => {
  const components = doc.components as {
    securitySchemes: { tenantOAuth: { flows: { authorizationCode: JsonObject } } };
  };
  const flow = components.securitySchemes.tenantOAuth.flows.authorizationCode;
  assert.equal(flow.authorizationUrl, 'https://drluriescience.netlify.app/oauth/authorize');
  assert.equal(flow.tokenUrl, 'https://drluriescience.netlify.app/oauth/token');
  assert.deepEqual(flow.scopes, {}, 'an invented scope reads as a bad credential — W0.3 §A.2');
});

test('a tool in the manifest that no longer exists is skipped, never guessed', () => {
  const withGhost = buildOpenApiDocument({
    connection: bundle.connection,
    tools: [
      ...bundle.tools,
      { name: 'tool_that_was_removed', tool_class: 'read', consequential: false, summary: 'gone' },
    ],
    definitions: visibleToolDefinitions(),
    manifestVersion: bundle.manifest_version,
  });
  assert.equal(
    (withGhost.paths as Record<string, unknown>)[`${PLUGIN_ACTION_PATH_PREFIX}/tool_that_was_removed`],
    undefined
  );
});

// ─── the façade's own behaviour ─────────────────────────────────────────────

test('the façade refuses a non-POST tool call and a non-GET schema fetch', async () => {
  assert.equal((await handler({ httpMethod: 'GET', path: '/api/plugin/object_create' })).statusCode, 405);
  assert.equal((await handler({ httpMethod: 'POST', path: '/api/plugin/openapi.json' })).statusCode, 405);
});

test('an unknown plugin path is a 404, not a confusing auth error', async () => {
  const response = await handler({ httpMethod: 'POST', path: '/api/plugin/' });
  assert.equal(response.statusCode, 404);
});

test('a tool call with no active manifest is refused before it can reach the CMS', async () => {
  const response = await handler({
    httpMethod: 'POST',
    path: '/api/plugin/object_publish',
    body: JSON.stringify({ object_type: 'content_item', object_id: 'req_x', lock_token: 't' }),
  });
  // No manifest has been promoted in the test store, so the charter cannot be
  // satisfied and nothing is forwarded.
  assert.ok([409, 500].includes(response.statusCode), `got ${response.statusCode}`);
  assert.equal(parseBody(response).ok, false);
});

test('the schema route reports plainly when nothing has been promoted', async () => {
  const response = await handler({
    httpMethod: 'GET',
    path: '/api/plugin/openapi.json',
    headers: { host: 'drluriescience.netlify.app' },
  });
  assert.ok([409, 500].includes(response.statusCode), `got ${response.statusCode}`);
  const body = parseBody(response);
  assert.equal(body.ok, false);
  assert.match(String(body.error), /manifest|unavailable/i);
});

test('the schema route refuses when it cannot learn its own origin', async () => {
  const response = await handler({ httpMethod: 'GET', path: '/api/plugin/openapi.json', headers: {} });
  assert.equal(response.statusCode, 400);
  assert.match(String(parseBody(response).error), /Host header/);
});

// ─── W3.3: the charter is enforcement here, not advice ──────────────────────

test('the charter excludes the tools a plugin must never reach', () => {
  const charter = new Set(bundle.tools.map((t) => t.name));
  for (const forbidden of [
    'set_voice_fields', // the voice governs every future article
    'object_review_decide', // a plugin must never approve its own work
    'site_apply_theme',
    'product_set_price',
    'trigger_netlify_build',
    'member_list',
    'wipe_blob_stores',
  ]) {
    assert.ok(!charter.has(forbidden), `${forbidden} must not be in the charter`);
    assert.equal(
      paths[`${PLUGIN_ACTION_PATH_PREFIX}/${forbidden}`],
      undefined,
      `${forbidden} must have no façade path`
    );
  }
});

test('the approval-gated types are reachable for READS but not writable by the plugin', () => {
  // drlurie pins product and editorial_voice to require-approval. The plugin
  // reads the voice at session start, so object_get must be in charter — but no
  // voice-writing verb may be.
  const charter = new Set(bundle.tools.map((t) => t.name));
  assert.ok(charter.has('object_get'));
  assert.ok(charter.has('object_contract'));
  assert.ok(!charter.has('set_voice_fields'));
});
