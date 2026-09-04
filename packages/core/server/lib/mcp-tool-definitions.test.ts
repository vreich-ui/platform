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
  it('has exactly 97 definitions (70 + the 16 membership tools, W18 T18.6b, + membership_status, T18.7, + resume_agent_artifact_job + site_apply_brand_imagery, P3, + whoami, W7.2, + brand_imagery_propose, P5, + build_pdf_render_data, W2 T2.1, + verify_pdf_content, W2 T2.4, + render_article_pdf / validate_pdf_render_data / get_pdf_render_brand, W2 T2.3)', () => {
    assert.strictEqual(TOOL_DEFINITIONS.length, 97, `Expected 97 tools, got ${TOOL_DEFINITIONS.length}`);
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

  // ART-3 added object_create and object_publish. Both were unfloored while
  // their neighbours were not: the two instantiate_* verbs create and are
  // floored, object_retire takes a page DOWN and is floored — but minting a
  // governed object, and pushing one LIVE to readers, were both overridable
  // to 'auto'. Without a floor `autonomyForCall`'s re-clamp has nothing to
  // clamp against, so a frozen or owner-set 'auto' runs the write un-asked.
  //
  // The floor is a CHAT-approval rule only. It does not touch the publish
  // gate, so an `all-autonomous` approval posture still publishes without a
  // human approval over /mcp and through the workflow's own publish verbs —
  // it only means a human sitting in a chat sees the card first.
  it('exactly these tools have floor "ask": object_create, object_publish, object_instantiate_template, object_instantiate_section_template, object_retire, object_review_decide, all privileged tools, and every membership write', () => {
    const expectedFloorAsk = new Set([
      // ART-3: creating a governed object, and taking one live.
      'object_create',
      'object_publish',
      'object_instantiate_template',
      'object_instantiate_section_template',
      'object_retire',
      'object_review_decide',
      // All privileged tools
      'trigger_netlify_build',
      'release_to_production',
      'site_apply_theme',
      'site_apply_brand_imagery',
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

  /**
   * Reported defect (brand-imagery wave): `delete_pdf_template` carried
   * `chatDefaultOff`, so admin chat could not remove a PDF template at all and
   * the agent reached for `object_checkout` on template ids instead. It is now
   * `'ask'`-by-default (an approval card every time; the privileged floor
   * above still forbids `'auto'`), which is proportionate for a soft,
   * reversible, idempotent deactivation that preserves the stored bytes.
   *
   * The membership family and the two image-policy setters are UNCHANGED —
   * this set is what proves it.
   */
  it('exactly these tools are chatDefaultOff: the two image-policy setters and the thirteen restricted membership tools — NOT delete_pdf_template', () => {
    const expectedDefaultOff = new Set([
      'set_image_search_policy',
      'set_image_model_policy',
      // W18 T18.6b: every membership write, plus the three restricted reads.
      'member_audit',
      'membership_policy_get',
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
      'member_export',
    ]);

    const defaultOff = new Set(TOOL_DEFINITIONS.filter((t) => t.governance.chatDefaultOff).map((t) => t.name));

    assert.deepStrictEqual(defaultOff, expectedDefaultOff, 'chatDefaultOff set does not match expected list');
    assert.ok(!defaultOff.has('delete_pdf_template'), 'delete_pdf_template must default to ask, not off');

    // It stays privileged and ask-floored — the change removes the block, not the approval card.
    const del = TOOL_DEFINITIONS.find((t) => t.name === 'delete_pdf_template');
    assert.strictEqual(del?.governance.toolClass, 'privileged');
    assert.strictEqual(del?.governance.autonomyFloor, 'ask');
  });

  /**
   * The agent's second wrong turn: it tried `object_checkout` on PDF template
   * ids, and then invented a 30-day hard-delete grace period for templates
   * (that is the membership purge model). Both descriptions now say so
   * explicitly, in both directions.
   */
  it('the pdf-template tools say they are NOT platform objects, and object_checkout/object_retire say the converse', () => {
    const describe_ = (name: string) => TOOL_DEFINITIONS.find((t) => t.name === name)?.description ?? '';

    for (const name of ['delete_pdf_template', 'get_pdf_template', 'list_pdf_templates']) {
      const text = describe_(name);
      assert.match(text, /NOT (a |)platform (CMS )?object|NOT PLATFORM OBJECTS/i, `${name} must deny object-hood`);
      assert.match(text, /object_checkout/, `${name} must name object_checkout as inapplicable`);
      assert.match(text, /object_retire|object_patch/, `${name} must name the other object verbs as inapplicable`);
    }

    const del = describe_('delete_pdf_template');
    assert.match(del, /soft/i);
    assert.match(del, /reversible/i);
    assert.match(del, /NO grace period/i);
    assert.match(del, /idempotent/i);

    for (const name of ['object_checkout', 'object_retire']) {
      assert.match(describe_(name), /pdf-tool PDF TEMPLATE/i, `${name} must say templates are not addressed here`);
    }
    assert.match(describe_('object_retire'), /delete_pdf_template/, 'object_retire must point at the right tool');
  });

  /**
   * W2 T2.1: the deterministic mapper's read-only face. It creates nothing and
   * costs no render, so it must be a `read` tool (that is what makes
   * annotationsFor emit readOnlyHint and stop a client confirming every
   * preview), and it must be honest about the one slot it deliberately does
   * not fill.
   */
  it('build_pdf_render_data is a read tool that names its unfilled contract and leaves brand to the bridge', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'build_pdf_render_data');
    assert.ok(tool, 'build_pdf_render_data must be registered');
    assert.strictEqual(tool!.governance.toolClass, 'read');
    assert.strictEqual(tool!.governance.autonomyFloor, undefined, 'a read preview needs no approval floor');
    const properties = (tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] }).properties;
    assert.ok(properties && 'site_id' in properties && 'content_item_id' in properties && 'template_id' in properties);
    assert.deepStrictEqual((tool!.inputSchema as { required?: string[] }).required, ['site_id', 'content_item_id']);
    assert.match(tool!.description, /WITHOUT creating a job/i);
    assert.match(tool!.description, /unfilled/);
    assert.match(tool!.description, /brand/);
  });

  /**
   * W2 T2.8 — the cross-cutting pass. T2.1 pinned `build_pdf_render_data`
   * above when it landed; T2.3/T2.4/T2.5 registered their five tools with
   * governance but never pinned the classification with a dedicated
   * assertion, which is exactly the kind of gap that lets a tier drift
   * silently on a later merge. This locks in all five by name, in one place.
   *
   * `render_article_pdf` is the one that matters most: it WRITES — it
   * attaches a rendered PDF to the article as a `document` media node — so it
   * must carry `creation`, the same class as `create_agent_artifact_job` and
   * `create_pdf_template`, never `read`. The other four only inspect or
   * dry-check state and cost no render/write, so they are `read`, exactly
   * like `build_pdf_render_data` and `object_validate`.
   */
  it('the five remaining W2 PDF-pipeline tools carry the exact toolClass their neighbours do', () => {
    const expectedToolClass: Record<string, ToolDefinition['governance']['toolClass']> = {
      verify_pdf_content: 'read',
      // The one WRITE in the wave — classed like create_agent_artifact_job /
      // create_pdf_template, never like a read.
      render_article_pdf: 'creation',
      validate_pdf_render_data: 'read',
      get_pdf_render_brand: 'read',
      validate_content_item: 'read',
    };
    for (const [name, expectedClass] of Object.entries(expectedToolClass)) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name);
      assert.ok(tool, `${name} must be registered`);
      assert.strictEqual(
        tool!.governance.toolClass,
        expectedClass,
        `${name} should carry toolClass "${expectedClass}", got "${tool!.governance.toolClass}"`
      );
    }
    // render_article_pdf mutates the article — same shape as its creation
    // neighbours (an approval-card preview, no privileged floor).
    const renderArticlePdf = TOOL_DEFINITIONS.find((t) => t.name === 'render_article_pdf')!;
    assert.strictEqual(renderArticlePdf.governance.preview?.kind, 'input_echo');
    assert.strictEqual(renderArticlePdf.governance.autonomyFloor, undefined);
    // None of the four reads carry a floor or a preview binding — reads never do.
    for (const name of ['verify_pdf_content', 'validate_pdf_render_data', 'get_pdf_render_brand', 'validate_content_item']) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      assert.strictEqual(tool.governance.autonomyFloor, undefined, `${name} is a read; it needs no autonomy floor`);
      assert.strictEqual(tool.governance.preview, undefined, `${name} is a read; it needs no approval preview`);
    }
  });

  /**
   * W2 REVIEW. `callCreateAgentArtifactJob` reads `input.kind` to route
   * D-1's `site.pdf.byKind[kind]` template lookup and to gate D-4's
   * article-shaped `requirements` default — but `kind` was never in the
   * published inputSchema, so no agent could route to `byKind.sales_brochure`
   * and no agent could opt out of the A4/min-2-pages floor that `kind`
   * defaulting to 'article' applies to EVERY pdf job. A handler argument that
   * is not in the schema is an argument that does not exist.
   *
   * `filename` left `required` in the same pass: D-4 makes it optional for a
   * pdf job (article slug + .pdf), and a schema demanding it made that
   * fallback unreachable.
   */
  it('create_agent_artifact_job publishes every argument its handler actually reads', () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === 'create_agent_artifact_job');
    assert.ok(tool, 'create_agent_artifact_job must be registered');
    const schema = tool!.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
    assert.ok(schema.properties?.kind, 'kind routes site.pdf.byKind and gates the D-4 requirements default');
    assert.match(
      (schema.properties!.kind as { description: string }).description,
      /byKind/,
      "kind's description must say what it routes"
    );
    assert.deepEqual(schema.required, ['site_id', 'request_id', 'artifact_kind']);
    assert.match(
      (schema.properties!.filename as { description: string }).description,
      /slug/i,
      'filename must document the pdf-job slug fallback that took it out of required'
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

  it('verb_dry_run previews appear only on: object_create_variant, object_instantiate_template, object_instantiate_section_template, site_apply_theme, site_apply_brand_imagery, and the four dry-runnable membership writes', () => {
    const expectedVerbDryRun = new Set([
      'object_create_variant',
      'object_instantiate_template',
      'object_instantiate_section_template',
      'site_apply_theme',
      'site_apply_brand_imagery',
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
