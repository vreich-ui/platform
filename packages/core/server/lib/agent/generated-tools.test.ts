/**
 * T9.13/PF5 — the GENERATED half of the chat tool registry (generated-tools.ts)
 * and its json-schema-lite validator.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import test from 'node:test';

import { TOOL_DEFINITIONS_PART1, INTERNAL_ONLY_TOOLS } from '../mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART2 } from '../mcp-tool-definitions-2.js';
import type { ToolDefinition } from '../../functions/mcp.js';
import { compileSchema } from './json-schema-lite.js';
import {
  GENERATED_CHAT_TOOLS,
  canonicalToolName,
  generatedChatToolByName,
  resolveGeneratedAutonomy,
} from './generated-tools.js';
import { isMembershipTool, TOOL_DEFINITIONS_MEMBERSHIP } from '../mcp-tool-definitions-membership.js';
import { fitToolsToCmsAgentBound } from './engine.js';
import { PRESENT_CANDIDATES_TOOL_NAME } from './candidates.js';
import type { ToolContext } from './tools.js';

const ALL_DEFINITIONS: readonly ToolDefinition[] = [
  ...TOOL_DEFINITIONS_PART1,
  ...TOOL_DEFINITIONS_PART2,
  ...TOOL_DEFINITIONS_MEMBERSHIP,
];

// A minimal stub ToolContext; individual tests override only what they use.
const stubCtx = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  roles: [],
  verb: async () => ({ status: 200, body: {} }),
  contract: () => ({}),
  validateNewObject: async () => ({ dry_run: true }),
  listArtifacts: async () => ({ artifacts: [] }),
  agentAuthoredOps: () => new Set<string>(),
  ...overrides,
});

// ─── registry shape ──────────────────────────────────────────────────────

test('the registry has exactly the expected 76 names: every visible TOOL_DEFINITION (57 + 16 membership, W18) plus the 3 workspace tools, no INTERNAL_ONLY member', () => {
  const expectedVisible = new Set(
    ALL_DEFINITIONS.filter((def) => !INTERNAL_ONLY_TOOLS.has(def.name)).map((def) => def.name)
  );
  assert.equal(expectedVisible.size, 73);

  const registryNames = GENERATED_CHAT_TOOLS.map((tool) => tool.name);
  assert.equal(registryNames.length, 76);
  assert.equal(new Set(registryNames).size, 76, 'no duplicate names');

  const workspaceNames = ['list_workspace_nodes', 'run_workspace_workflow', 'get_workspace_run'];
  for (const name of workspaceNames) {
    assert.ok(registryNames.includes(name), `expected workspace tool ${name} in the registry`);
  }
  for (const name of expectedVisible) {
    assert.ok(registryNames.includes(name), `expected visible definition ${name} in the registry`);
  }
  for (const name of registryNames) {
    if (workspaceNames.includes(name)) continue;
    assert.ok(expectedVisible.has(name), `unexpected extra registry member ${name}`);
  }
  for (const internalName of INTERNAL_ONLY_TOOLS) {
    assert.ok(!registryNames.includes(internalName), `${internalName} is INTERNAL_ONLY and must not be chat-visible`);
  }
});

test('wire-tool budget: the non-membership registry (60) + present_candidates <= 64; the membership family (16, W18 T18.6b) is trimmed by the CMS-Agent engine when the wire exceeds the bound; serialized registry under the 200_000 char budget', () => {
  const nonMembership = GENERATED_CHAT_TOOLS.filter((tool) => !isMembershipTool(tool.name));
  assert.equal(nonMembership.length, 60);
  assert.ok(nonMembership.length + 1 <= 64, 'core registry + present_candidates must fit the wire-tool budget');
  const wire = GENERATED_CHAT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
  assert.equal(
    fitToolsToCmsAgentBound(wire).length,
    60,
    'over the bound → the membership family is dropped, nothing else'
  );
  assert.equal(fitToolsToCmsAgentBound(wire.slice(0, 64)).length, 64, 'within the bound → untouched');
  assert.equal(PRESENT_CANDIDATES_TOOL_NAME, 'present_candidates');

  const serialized = JSON.stringify(
    GENERATED_CHAT_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.input_schema,
    }))
  );
  assert.ok(serialized.length <= 200_000, `serialized registry is ${serialized.length} chars, budget is 200000`);
});

// ─── canonicalToolName / resolveGeneratedAutonomy ────────────────────────

test('canonicalToolName: legacy alias resolves, exact registry match wins over alias', () => {
  assert.equal(canonicalToolName('patch'), 'object_patch');
  // search_artifacts is BOTH a legacy chat-tool alias (-> list_artifacts_for_request)
  // AND its own distinct MCP tool name — the exact registry match must win.
  assert.equal(canonicalToolName('search_artifacts'), 'search_artifacts');
  assert.ok(generatedChatToolByName('search_artifacts'));
  assert.equal(generatedChatToolByName('search_artifacts')!.name, 'search_artifacts');
});

test('resolveGeneratedAutonomy: a legacy stored key ({patch: "off"}) disables the canonical tool; an exact canonical key in the same map beats a legacy-alias key', () => {
  const legacyOnly = resolveGeneratedAutonomy({ patch: 'off' }, undefined);
  assert.equal(legacyOnly.object_patch, 'off');

  const canonicalBeatsLegacy = resolveGeneratedAutonomy({ patch: 'off', object_patch: 'auto' }, undefined);
  // object_patch is toolClass 'draft' (no floor) — default 'ask', but the
  // exact canonical override wins over the legacy alias in the SAME map.
  assert.equal(canonicalBeatsLegacy.object_patch, 'auto');
});

test('floors: {release_to_production: "auto"} resolves to "ask"; "off" still works', () => {
  const byGovernance = resolveGeneratedAutonomy({ release_to_production: 'auto' }, undefined);
  assert.equal(byGovernance.release_to_production, 'ask');
  const byProfile = resolveGeneratedAutonomy(undefined, { release_to_production: 'auto' });
  assert.equal(byProfile.release_to_production, 'ask');
  const disabled = resolveGeneratedAutonomy({ release_to_production: 'off' }, undefined);
  assert.equal(disabled.release_to_production, 'off');
});

test('defaults: read -> auto, draft/creation/publication/privileged -> ask, chatDefaultOff -> off', () => {
  const defaults = resolveGeneratedAutonomy(undefined, undefined);
  assert.equal(defaults.object_get, 'auto');
  assert.equal(defaults.ping, 'auto');
  assert.equal(defaults.object_patch, 'ask');
  assert.equal(defaults.object_create, 'ask');
  assert.equal(defaults.object_submit_review, 'ask');
  assert.equal(defaults.set_image_search_policy, 'off');
  assert.equal(defaults.set_image_model_policy, 'off');
  assert.equal(defaults.delete_pdf_template, 'off');
});

// ─── object_patch.parse: schema check, then agent-authored-ops check ─────

test('object_patch.parse: schema-invalid args are rejected with an informative, path-qualified message', () => {
  const tool = generatedChatToolByName('object_patch')!;
  const ctx = stubCtx({ agentAuthoredOps: () => new Set(['set_fields']) });
  const result = tool.parse({ object_type: 'page' }, ctx); // missing object_id/lock_token/expected_record_version/ops
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /Invalid arguments:/);
    assert.match(result.error, /object_id/);
  }
});

test('object_patch.parse: an op outside agentAuthoredOps is rejected with the permitted-ops list', () => {
  const tool = generatedChatToolByName('object_patch')!;
  const ctx = stubCtx({ agentAuthoredOps: () => new Set(['set_fields']) });
  const result = tool.parse(
    {
      object_type: 'page',
      object_id: 'page_home',
      lock_token: 'lock_1',
      expected_record_version: 1,
      ops: [{ op: 'evil_op' }],
    },
    ctx
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.error, /evil_op/);
    assert.match(result.error, /not a permitted agent-authored op/);
    assert.match(result.error, /set_fields/);
  }
});

test('object_patch.parse: valid args with a permitted op pass', () => {
  const tool = generatedChatToolByName('object_patch')!;
  const ctx = stubCtx({ agentAuthoredOps: () => new Set(['set_fields']) });
  const result = tool.parse(
    {
      object_type: 'page',
      object_id: 'page_home',
      lock_token: 'lock_1',
      expected_record_version: 1,
      ops: [{ op: 'set_fields', fields: { title: 'Hi' } }],
    },
    ctx
  );
  assert.equal(result.ok, true);
});

// ─── dryRun ────────────────────────────────────────────────────────────────

test('object_create.dryRun calls ctx.validateNewObject', async () => {
  const tool = generatedChatToolByName('object_create')!;
  const calls: unknown[] = [];
  const ctx = stubCtx({
    validateNewObject: async (objectType, body, requestedId) => {
      calls.push({ objectType, body, requestedId });
      return { dry_run: true, object_id_preview: 'page_x' };
    },
  });
  const preview = await tool.dryRun!(ctx, { object_type: 'page', site: 'site_acme', body: { title: 'x' } });
  assert.equal(calls.length, 1);
  assert.deepEqual(preview, { dry_run: true, object_id_preview: 'page_x' });
});

test('object_create_variant.dryRun sends dry_run: true through ctx.verb', async () => {
  const tool = generatedChatToolByName('object_create_variant')!;
  const calls: Record<string, unknown>[] = [];
  const ctx = stubCtx({
    verb: async (request) => {
      calls.push(request);
      return { status: 200, body: { preview: true } };
    },
  });
  const preview = await tool.dryRun!(ctx, { source_object_id: 'req_1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'create_variant');
  assert.equal(calls[0].object_type, 'content_item');
  assert.equal(calls[0].dry_run, true);
  assert.deepEqual(preview, { preview: true });
});

test('release_to_production.dryRun is an input echo (no server call)', async () => {
  const tool = generatedChatToolByName('release_to_production')!;
  const ctx = stubCtx();
  const args = { commit: 'abc123' };
  const preview = await tool.dryRun!(ctx, args);
  assert.deepEqual(preview, {
    dry_run: true,
    action: 'release_to_production',
    args_echo: args,
    note: 'Preview is an echo of the exact arguments that will be sent on approval.',
  });
});

// ─── owner gates ────────────────────────────────────────────────────────────

test('site_apply_theme.execute refuses without the owner role, proceeds with it', async () => {
  const tool = generatedChatToolByName('site_apply_theme')!;
  const noOwner = stubCtx({ roles: ['admin'] });
  const refused = await tool.execute(noOwner, { theme_id: 'thm_x', site_id: 'site_acme' });
  assert.equal(refused.is_error, true);
  assert.match(refused.content, /Owner role/);

  const calls: Record<string, unknown>[] = [];
  const asOwner = stubCtx({
    roles: ['owner'],
    verb: async (request) => {
      calls.push(request);
      return { status: 200, body: { ok: true } };
    },
  });
  const applied = await tool.execute(asOwner, { theme_id: 'thm_x', site_id: 'site_acme' });
  assert.equal(applied.is_error, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'apply_theme');
});

test('release_to_production.execute refuses without the owner role, proceeds with it (via the operational bridge)', async () => {
  const tool = generatedChatToolByName('release_to_production')!;
  const noOwner = stubCtx({ roles: ['admin'] });
  const refused = await tool.execute(noOwner, { commit: 'abc' });
  assert.equal(refused.is_error, true);
  assert.match(refused.content, /Owner role/);

  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const asOwner = stubCtx({
    roles: ['owner'],
    operational: {
      call: async (name, args) => {
        calls.push({ name, args });
        return { content: JSON.stringify({ released: true }), is_error: false };
      },
    },
  });
  const released = await tool.execute(asOwner, { commit: 'abc' });
  assert.equal(released.is_error, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'release_to_production');
});

test('an operational tool answers with a clear error when no operational bridge is configured', async () => {
  const tool = generatedChatToolByName('deploy_status')!;
  const ctx = stubCtx({ roles: ['owner'] }); // no `operational`
  const result = await tool.execute(ctx, {});
  assert.equal(result.is_error, true);
  assert.match(result.content, /operational tool bridge is not configured/);
});

// ─── json-schema-lite ───────────────────────────────────────────────────────

test('compileSchema throws at compile time on an unsupported keyword', () => {
  assert.throws(
    () => compileSchema({ type: 'string', minItems: 1 } as unknown as Record<string, unknown>),
    /unsupported keyword/
  );
  assert.throws(
    () =>
      compileSchema({
        type: 'object',
        properties: { x: { type: 'string', patternProperties: {} } },
      } as unknown as Record<string, unknown>),
    /unsupported keyword/
  );
});

test('every one of the 86 TOOL_DEFINITIONS inputSchemas compiles without throwing', () => {
  assert.equal(ALL_DEFINITIONS.length, 86);
  for (const def of ALL_DEFINITIONS) {
    assert.doesNotThrow(() => compileSchema(def.inputSchema), `${def.name}'s inputSchema failed to compile`);
  }
});

// ─── describe() overrides ───────────────────────────────────────────────────

test('object_patch.describe matches the old chat "patch" tool phrasing', () => {
  const tool = generatedChatToolByName('object_patch')!;
  const described = tool.describe({
    object_type: 'page',
    object_id: 'page_home',
    ops: [{ op: 'set_fields' }, { op: 'set_fields' }],
  });
  assert.equal(described, 'Patch page page_home: 2 op(s)');
});

test('describe() falls back to "<name> <object_id>" for tools without a curated phrasing', () => {
  const tool = generatedChatToolByName('object_retire')!;
  assert.equal(tool.describe({ object_type: 'page', object_id: 'page_home' }), 'object_retire page_home');
});
