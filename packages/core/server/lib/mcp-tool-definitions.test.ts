import { describe, it } from 'node:test';
import assert from 'node:assert';
import { TOOL_DEFINITIONS_PART1, INTERNAL_ONLY_TOOLS, CHAT_TOOL_ALIASES } from './mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART2 } from './mcp-tool-definitions-2.js';
import { TOOL_DEFINITIONS_MEMBERSHIP } from './mcp-tool-definitions-membership.js';
import type { ToolDefinition } from '../functions/mcp.js';

const TOOL_DEFINITIONS: ToolDefinition[] = [
  ...TOOL_DEFINITIONS_PART1,
  ...TOOL_DEFINITIONS_PART2,
  ...TOOL_DEFINITIONS_MEMBERSHIP,
];

describe('Tool definitions', () => {
  it('has exactly 86 definitions (70 + the 16 membership tools, W18 T18.6b)', () => {
    assert.strictEqual(TOOL_DEFINITIONS.length, 86, `Expected 86 tools, got ${TOOL_DEFINITIONS.length}`);
  });

  it('all definitions have unique names', () => {
    const names = TOOL_DEFINITIONS.map((t) => t.name);
    const unique = new Set(names);
    assert.strictEqual(
      names.length,
      unique.size,
      `Expected unique names, got ${names.length} definitions with ${unique.size} unique names`
    );
  });

  it('every definition has governance with a valid toolClass', () => {
    const validToolClasses = ['read', 'draft', 'creation', 'publication', 'privileged', 'membership'] as const;
    for (const tool of TOOL_DEFINITIONS) {
      assert.ok(tool.governance, `Tool ${tool.name} missing governance block`);
      assert.ok(
        validToolClasses.includes(tool.governance.toolClass),
        `Tool ${tool.name} has invalid toolClass: ${tool.governance.toolClass}`
      );
    }
  });

  it('every privileged tool has autonomyFloor: "ask"', () => {
    const privilegedTools = TOOL_DEFINITIONS.filter((t) => t.governance.toolClass === 'privileged');
    for (const tool of privilegedTools) {
      assert.strictEqual(
        tool.governance.autonomyFloor,
        'ask',
        `Privileged tool ${tool.name} should have autonomyFloor: "ask"`
      );
    }
  });

  it('exactly these tools have floor "ask": object_instantiate_template, object_instantiate_section_template, object_retire, object_review_decide, all privileged tools, and every membership write', () => {
    const expectedFloorAsk = new Set([
      'object_instantiate_template',
      'object_instantiate_section_template',
      'object_retire',
      'object_review_decide',
      // All privileged tools
      'trigger_netlify_build',
      'release_to_production',
      'site_apply_theme',
      'set_image_search_policy',
      'set_image_model_policy',
      'delete_pdf_template',
      'soft_delete_artifact',
      'migrate_artifact_indexes',
      'reconcile_artifact_indexes',
      'wipe_blob_stores',
      'product_set_price',
      'order_reissue',
      // W18 T18.6b: every membership WRITE (class 'membership') is ask-floored
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
    ]);

    const toolsWithFloorAsk = new Set(
      TOOL_DEFINITIONS.filter((t) => t.governance.autonomyFloor === 'ask').map((t) => t.name)
    );

    assert.deepStrictEqual(
      toolsWithFloorAsk,
      expectedFloorAsk,
      `Tools with autonomyFloor: "ask" do not match expected list`
    );
  });

  it('every alias target in CHAT_TOOL_ALIASES exists as a definition name', () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const [alias, target] of Object.entries(CHAT_TOOL_ALIASES)) {
      assert.ok(
        toolNames.has(target),
        `CHAT_TOOL_ALIASES maps "${alias}" to "${target}", but "${target}" is not a tool`
      );
    }
  });

  it('verb_dry_run previews appear only on: object_create_variant, object_instantiate_template, object_instantiate_section_template, site_apply_theme, and the four dry-runnable membership writes', () => {
    const expectedVerbDryRun = new Set([
      'object_create_variant',
      'object_instantiate_template',
      'object_instantiate_section_template',
      'site_apply_theme',
      // W18 T18.6b: the membership writes the core supports dry_run on
      'member_invite',
      'member_set_role',
      'member_remove',
      'ownership_transfer',
    ]);

    const toolsWithVerbDryRun = new Set(
      TOOL_DEFINITIONS.filter((t) => t.governance.preview?.kind === 'verb_dry_run').map((t) => t.name)
    );

    assert.deepStrictEqual(
      toolsWithVerbDryRun,
      expectedVerbDryRun,
      `Tools with verb_dry_run preview do not match expected list`
    );
  });

  it('INTERNAL_ONLY_TOOLS members are all definition names', () => {
    const toolNames = new Set(TOOL_DEFINITIONS.map((t) => t.name));
    for (const internalTool of INTERNAL_ONLY_TOOLS) {
      assert.ok(toolNames.has(internalTool), `INTERNAL_ONLY_TOOLS includes "${internalTool}", which is not a tool`);
    }
  });
});
