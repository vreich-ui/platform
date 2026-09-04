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
  CHAT_ARTICLE_CREATE_REFUSAL,
  GENERATED_CHAT_TOOLS,
  canonicalToolName,
  generatedChatToolByName,
  resolveGeneratedAutonomy,
} from './generated-tools.js';
import { isMembershipTool, TOOL_DEFINITIONS_MEMBERSHIP } from '../mcp-tool-definitions-membership.js';
import { CMS_AGENT_BOUNDS } from './cms-agent-client.js';
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

// ─── registry shape ────────────────────────────────────────────────────────

test('the registry has exactly the expected 88 names: every visible TOOL_DEFINITION (60 + 16 membership, W18, + site_apply_brand_imagery, P3, + brand_imagery_propose, P5, + whoami, W7.2) plus the 6 workspace tools and the 5 editorial-request tools (W19 T19.8/T19.8c), no INTERNAL_ONLY member', () => {
  const expectedVisible = new Set(
    ALL_DEFINITIONS.filter((def) => !INTERNAL_ONLY_TOOLS.has(def.name)).map((def) => def.name)
  );
  assert.equal(expectedVisible.size, 77);

  const registryNames = GENERATED_CHAT_TOOLS.map((tool) => tool.name);
  assert.equal(registryNames.length, 88);
  assert.equal(new Set(registryNames).size, 88, 'no duplicate names');

  const workspaceNames = [
    'list_workspace_nodes',
    'run_workspace_workflow',
    'get_workspace_run',
    'check_workspace_run_readiness',
    'publish_workspace_run',
    'release_workspace_run',
    // W19 T19.8/T19.8c — reused from tools.ts for the same reason: they ride
    // the editorial-request store, not the object verbs.
    'list_requests',
    'get_request',
    'get_request_activity',
    'retry_request',
    'archive_request',
  ];
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

test('wire-tool budget: the non-membership registry (72) + present_candidates <= 96; the membership family (16, W18 T18.6b) is trimmed by the CMS-Agent engine when the wire exceeds the bound; serialized registry under the 200_000 char budget', () => {
  const nonMembership = GENERATED_CHAT_TOOLS.filter((tool) => !isMembershipTool(tool.name));
  assert.equal(nonMembership.length, 72);
  // W19 T19.8: the old ceiling was 64 and the registry sat at exactly 63 + the
  // learning-mode tool — no headroom at all, so one more tool would have been
  // silently sliced off the wire. The bound moved to 96 on both sides.
  assert.ok(
    nonMembership.length + 1 <= CMS_AGENT_BOUNDS.maxTools,
    'core registry + present_candidates must fit the wire-tool budget'
  );
  const wire = GENERATED_CHAT_TOOLS.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.input_schema,
  }));
  // The automatic fallback path: at the LEGACY bound both trimmable families
  // go WHOLE — membership, then the editorial-request tools — rather than a
  // positional slice leaving half a family on the wire.
  assert.equal(fitToolsToCmsAgentBound(wire, 64).length, 64);
  assert.ok(
    !fitToolsToCmsAgentBound(wire, 64).some((tool) => tool.name === 'get_request'),
    'the request family is dropped together, never half of it'
  );
  assert.equal(fitToolsToCmsAgentBound(wire).length, wire.length, 'within the raised bound → untouched');
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
});

/**
 * Reported defect (brand-imagery wave): `delete_pdf_template` carried
 * `chatDefaultOff`, so it resolved to `off` and the admin chat agent could not
 * remove a PDF template at all. Asked to, it reached for `object_checkout` on
 * the template ids instead — PDF templates are pdf-tool records, not platform
 * objects — collected "Object record not found" repeatedly, and told the user
 * templates are hard-deleted after a 30-day grace period, which is false.
 *
 * The new posture: default `'ask'` (an approval card EVERY time) and never
 * `'auto'` — proportionate for a soft, reversible, idempotent deactivation
 * that preserves the stored bytes. The membership tools and the two image
 * policy setters are untouched, which the set assertion below pins.
 */
test('delete_pdf_template defaults to ask — an approval card every time, and never auto', () => {
  const defaults = resolveGeneratedAutonomy(undefined, undefined);
  assert.equal(defaults.delete_pdf_template, 'ask');

  // The privileged floor still makes 'auto' unreachable from either layer.
  assert.equal(resolveGeneratedAutonomy({ delete_pdf_template: 'auto' }, undefined).delete_pdf_template, 'ask');
  assert.equal(resolveGeneratedAutonomy(undefined, { delete_pdf_template: 'auto' }).delete_pdf_template, 'ask');
  // An operator who wants it off again still can.
  assert.equal(resolveGeneratedAutonomy({ delete_pdf_template: 'off' }, undefined).delete_pdf_template, 'off');
});

test('the default-OFF set is EXACTLY the two image-policy setters plus the thirteen restricted membership tools — delete_pdf_template is not among them, and every membership tool that was off stays off', () => {
  const defaults = resolveGeneratedAutonomy(undefined, undefined);
  const off = new Set(
    Object.entries(defaults)
      .filter(([, mode]) => mode === 'off')
      .map(([name]) => name)
  );

  const membershipOff = [
    'member_invite',
    'invitation_resend',
    'invitation_revoke',
    'member_set_role',
    'member_suspend',
    'member_reinstate',
    'member_remove',
    'member_purge',
    'ownership_transfer',
    'membership_policy_set',
  ];
  assert.deepEqual(off, new Set([...membershipOff, 'set_image_search_policy', 'set_image_model_policy']));
  for (const name of membershipOff) assert.equal(defaults[name], 'off', `${name} must stay default-off`);
  assert.ok(!off.has('delete_pdf_template'));
});

/**
 * Pinned as-is, NOT endorsed: `defaultAutonomyForGenerated` returns 'auto' for
 * every `toolClass: 'read'` tool BEFORE it consults `CHAT_DEFAULT_OFF_NAMES`,
 * so the three membership READS that carry `chatDefaultOff`
 * (mcp-tool-definitions-membership.ts) resolve to 'auto' in chat regardless.
 * That is pre-existing behaviour, untouched by the delete_pdf_template change
 * above; this test exists so the next person to change either side sees it.
 */
test('chatDefaultOff on a read-class tool does not take effect in the generated registry (existing behaviour, pinned)', () => {
  const defaults = resolveGeneratedAutonomy(undefined, undefined);
  for (const name of ['member_audit', 'membership_policy_get', 'member_export']) {
    const definition = TOOL_DEFINITIONS_MEMBERSHIP.find((def) => def.name === name);
    assert.equal(definition?.governance.chatDefaultOff, true, `${name} is declared chatDefaultOff`);
    assert.equal(definition?.governance.toolClass, 'read');
    assert.equal(defaults[name], 'auto', `${name} resolves to auto because read wins over chatDefaultOff`);
  }
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

// ─── ART-1: articles have ONE production path from chat ────────────────────

test('ART-1: object_create refuses content_item in chat and names the workflow, while every other governed type still creates', () => {
  const tool = generatedChatToolByName('object_create')!;
  const ctx = stubCtx();

  const refused = tool.parse(
    { object_type: 'content_item', site: 'site_acme', body: { slug: 'x', title: 'X', nodes: [] } },
    ctx
  );
  assert.equal(refused.ok, false, 'a direct article create must not reach the verb');
  assert.equal(refused.ok === false && refused.error, CHAT_ARTICLE_CREATE_REFUSAL);
  // The refusal has to be actionable: it names the governed entry point and the
  // revise-an-existing-article escape hatch, or the model just retries.
  assert.match(refused.ok === false ? refused.error : '', /run_workspace_workflow/);
  assert.match(refused.ok === false ? refused.error : '', /object_patch/);

  // Not a blanket ban on creation — the guard is type-scoped.
  const page = tool.parse({ object_type: 'page', site: 'site_acme', body: { route: '/x', title: 'X' } }, ctx);
  assert.equal(page.ok, true, 'other governed types must still be creatable from chat');

  // Schema errors still win over the type guard, so a malformed call reads as malformed.
  const malformed = tool.parse({ object_type: 'content_item' }, ctx);
  assert.equal(malformed.ok, false);
  assert.match(malformed.ok === false ? malformed.error : '', /Invalid arguments/);

  // Deriving a variant from an article that ALREADY carries the record stays open.
  const variant = generatedChatToolByName('object_create_variant')!.parse({ source_object_id: 'req_1' }, ctx);
  assert.equal(variant.ok, true, 'object_create_variant must stay available for judge/score/A-B work');
});

test('ART-3: object_create and object_publish carry an ask floor, so a frozen or owner-set auto cannot run them un-asked', () => {
  for (const name of ['object_create', 'object_publish']) {
    assert.equal(generatedChatToolByName(name)!.autonomyFloor, 'ask', `${name} must be floored`);
    assert.equal(
      resolveGeneratedAutonomy(undefined, { [name]: 'auto' })[name],
      'ask',
      `${name}: an explicit 'auto' override must be re-clamped to 'ask'`
    );
    // A floored tool may still be turned OFF entirely — the floor is one-directional.
    assert.equal(resolveGeneratedAutonomy(undefined, { [name]: 'off' })[name], 'off');
  }
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

// ─── owner gates ─────────────────────────────────────────────────────────────

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

test('site_apply_brand_imagery.execute refuses without the owner role, proceeds with it', async () => {
  const tool = generatedChatToolByName('site_apply_brand_imagery')!;
  const noOwner = stubCtx({ roles: ['admin'] });
  const refused = await tool.execute(noOwner, { visual_standard_id: 'vis_acme', site_id: 'site_acme' });
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
  const applied = await tool.execute(asOwner, { visual_standard_id: 'vis_acme', site_id: 'site_acme' });
  assert.equal(applied.is_error, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].action, 'apply_brand_imagery');
  assert.equal(calls[0].visual_standard_id, 'vis_acme');
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

// ─── T7 (2026-08-25): object_review_decide on a still-running workspace run ────

test('object_review_decide on a missing object routes to the run gate instead of surfacing the raw 404, when a workflow-backed request with that same id exists and has not produced an object yet', async () => {
  const tool = generatedChatToolByName('object_review_decide')!;
  const ctx = stubCtx({
    verb: async () => ({ status: 404, body: { error: 'Object record not found', not_found: true } }),
    requests: {
      register: async () => {},
      get: async (requestId) => {
        assert.equal(requestId, 'req_agent_retinol_basics_20260825_01');
        return {
          request_id: requestId,
          kind: 'article',
          status: 'running',
          workflow: { run_id: 'run_abc123', workflow_id: 'publishing_conductor', project_id: 'platform' },
          // no `object` yet — the workflow has not produced the content_item.
        };
      },
    },
  });
  const result = await tool.execute(ctx, {
    object_type: 'content_item',
    object_id: 'req_agent_retinol_basics_20260825_01',
    decision: 'approve',
  });
  assert.equal(result.is_error, true);
  assert.doesNotMatch(result.content, /Object record not found/);
  const body = JSON.parse(result.content) as { error: string; code: string; run_id: string; request_id: string };
  assert.equal(body.code, 'still_in_workspace_run');
  assert.equal(body.run_id, 'run_abc123');
  assert.match(body.error, /check_workspace_run_readiness/);
  assert.match(body.error, /publish_workspace_run/);
});

test('object_review_decide on a missing object with NO matching request surfaces the raw verb 404 unchanged (no misrouting a real deletion)', async () => {
  const tool = generatedChatToolByName('object_review_decide')!;
  const ctx = stubCtx({
    verb: async () => ({ status: 404, body: { error: 'Object record not found', not_found: true } }),
    requests: { register: async () => {}, get: async () => undefined },
  });
  const result = await tool.execute(ctx, {
    object_type: 'content_item',
    object_id: 'content_item_orphaned',
    decision: 'approve',
  });
  assert.equal(result.is_error, true);
  assert.match(result.content, /Object record not found/);
});

test('object_review_decide does not misroute a request whose object has ALREADY been produced (a real 404 means something else)', async () => {
  const tool = generatedChatToolByName('object_review_decide')!;
  const ctx = stubCtx({
    verb: async () => ({ status: 404, body: { error: 'Object record not found', not_found: true } }),
    requests: {
      register: async () => {},
      get: async () => ({
        request_id: 'req_agent_retinol_basics_20260825_01',
        workflow: { run_id: 'run_abc123', workflow_id: 'publishing_conductor', project_id: 'platform' },
        object: { object_type: 'content_item', object_id: 'req_agent_retinol_basics_20260825_01' },
      }),
    },
  });
  const result = await tool.execute(ctx, {
    object_type: 'content_item',
    object_id: 'req_agent_retinol_basics_20260825_01',
    decision: 'approve',
  });
  assert.match(result.content, /Object record not found/);
});

test('object_review_decide on a real 200 result is unaffected by the routing guard', async () => {
  const tool = generatedChatToolByName('object_review_decide')!;
  const calls: Record<string, unknown>[] = [];
  const ctx = stubCtx({
    verb: async (request) => {
      calls.push(request);
      return { status: 200, body: { review_state: 'approved' } };
    },
    requests: { register: async () => {}, get: async () => undefined },
  });
  const result = await tool.execute(ctx, {
    object_type: 'content_item',
    object_id: 'content_item_x',
    decision: 'approve',
  });
  assert.equal(result.is_error, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.action, 'review_decide');
});

// ─── json-schema-lite ─────────────────────────────────────────────────────────

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

test('every one of the 91 TOOL_DEFINITIONS inputSchemas compiles without throwing', () => {
  assert.equal(ALL_DEFINITIONS.length, 91);
  for (const def of ALL_DEFINITIONS) {
    assert.doesNotThrow(() => compileSchema(def.inputSchema), `${def.name}'s inputSchema failed to compile`);
  }
});

// ─── describe() overrides ─────────────────────────────────────────────────────

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
