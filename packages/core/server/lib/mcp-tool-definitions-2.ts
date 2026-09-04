/**
 * TOOL_DEFINITIONS, part 2 of 2. See mcp-tool-definitions.ts's header for why
 * this is split from mcp.ts and how the two parts recombine.
 */
import { pageTypeIds } from '../../schema/bodies/page-v1.js';

import {
  anyObjectSchema,
  arraySchema,
  idempotencyKeyJsonSchema,
  intSchema,
  nullableStringSchema,
  objectSchema,
  objectTypeEnumSchema,
  patchOpsSchema,
  publishActionInputSchema,
  stringSchema,
} from './mcp-tool-definitions.js';
import type { ToolDefinition } from '../functions/mcp.js';

export const TOOL_DEFINITIONS_PART2: ToolDefinition[] = [
  {
    name: 'ping',
    description: 'Diagnostic tool that confirms the MCP server is reachable.',
    inputSchema: objectSchema({}),
    governance: { toolClass: 'read' },
  },
  {
    // W7.2. `ping` proves the SERVER is reachable; this proves the INSTALL is
    // correct — which human this credential is bound to, what they may do
    // here, which chat surface the tenant thinks you are, whether the tool
    // schema your client cached is still current, and the two rules (ceiling,
    // approval posture) that decide whether anything you write can publish.
    name: 'whoami',
    description:
      'Report who this connection is and what it may do, before writing anything. Returns the tenant member ' +
      'this credential is bound to and their role, the chat surface the tenant attributes your calls to, ' +
      'whether you may write at all (and why not, if not), the promoted plugin manifest version and its tool ' +
      'charter, a digest of the live tool surface to compare against the schema your client cached, this ' +
      "site's aggression ceiling, and its publish-approval posture. Call it at the start of every session: " +
      'every value it returns is one an install can get silently wrong, and none of them is visible from ' +
      'inside a chat app. If `can_write` is false, stop and tell the human what `refuse_reason` says instead ' +
      'of attempting a write that the gate will refuse at the end of a long session. If `tools_digest_matches` ' +
      'is false, the connector was added against an older tool surface — tell the human to re-add it.',
    inputSchema: objectSchema({}),
    governance: { toolClass: 'read' },
  },

  // ── Object verbs (T0.9): the generic CMS object store. Each proxies to
  //    netlify/functions/object-store.ts with the publish key injected
  //    server-side (the A§1.8 pattern). Purely additive — the article tools
  //    above are unchanged. Submit/publish/review arrive in P1. ──
  {
    name: 'object_get',
    description:
      'Fetch a CMS object record (current draft state) by type and id from the site-objects store. ' +
      'A record has two unbounded parts — the `history` ledger (one entry per verb, never pruned) and, ' +
      'for an article, `body.nodes` — so ask for what you need: projection "summary" (envelope + one ' +
      '{id, kind, visibility} line per node + node_count + history_length: what article is this and how ' +
      'is it shaped), "nodes" (envelope + the full body, ledger replaced by history_length: the read you ' +
      'want before revising an article), or "full" (everything, including the ledger — the default, and ' +
      'the only one you need when you are auditing what happened to an object).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema('The object id, e.g. page_home.'),
        projection: {
          type: 'string',
          enum: ['summary', 'nodes', 'full'],
          description:
            'How much of the record to return. Defaults to "full" (unchanged historical shape). Prefer ' +
            '"nodes" to read an article you are about to revise, and "summary" to inspect shape without the body.',
        },
      },
      ['object_type', 'object_id']
    ),
    governance: { toolClass: 'read' },
  },
  {
    name: 'object_list',
    description: 'List CMS object summaries for a type, optionally filtered by status (active | archived).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        status: { type: 'string', enum: ['active', 'archived'], description: 'Optional status filter.' },
      },
      ['object_type']
    ),
    governance: { toolClass: 'read' },
  },
  {
    name: 'object_create',
    description:
      'Create a CMS object from object_type, site, and the per-type body. requested_id is optional — omit it to have a valid id minted server-side. For recipe types (template / section_template / theme): REUSE FIRST — object_inventory lists existing recipes with self-describing summaries; create only when none fits, and include description/whenToUse/scope (required to publish). Creation may be restricted per type by the committed creation policy — check object_contract(<type>).creation_policy; a denial is a 403 with code creation_restricted. content_item (articles) is NOT created here from admin chat (ART-1) — a new article is produced by the publishing workflow (run_workspace_workflow → check_workspace_run_readiness → publish_workspace_run → release_workspace_run), which is what builds the sourcing/claim/compliance record ART-2 requires to publish and applies the aggression ceiling. The chat registry refuses object_create for content_item and tells you this; to revise an article that already exists use object_checkout + object_patch. Committed legacy posts stay on the old article tools. tracking_config (W13) is the per-site tracker-registry SINGLETON: creation is human/seed-only and a second active registry is refused (409) — read object_contract("tracking_config") and edit the existing trk_* object instead. If this call itself times out or 502s (ambiguous whether the object was created), retry with the SAME idempotency_key to get back the original created object instead of creating a duplicate — this matters most when requested_id is omitted, since a fresh id is minted on every genuinely new call.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        site: stringSchema('Owning site object id, e.g. site_acme.'),
        body: anyObjectSchema('The per-type object body; validated server-side against the T0.2 schema.'),
        requested_id: stringSchema('Optional explicit object id; a valid id is minted from the body when omitted.'),
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
        idempotency_key: idempotencyKeyJsonSchema,
      },
      ['object_type', 'site', 'body']
    ),
    // ART-3: floored like its two instantiate_* siblings. Without a floor a
    // frozen or owner-set 'auto' survives `autonomyForCall`'s re-clamp, so a
    // creation write could run un-asked in chat.
    governance: { toolClass: 'creation', autonomyFloor: 'ask', preview: { kind: 'validate_new_object' } },
  },
  {
    name: 'object_instantiate_template',
    description:
      "Create a new page FROM a template recipe (design rule 5: templates are recipes; PageTypes are law). Deep-copies the template's slot blueprints into a fresh page body in slot order (a required slot without a blueprint falls back to the registry defaultData of its first allowed type; an optional slot without one is skipped), stamps page.template provenance ({ref, instantiated_at} — pages never live-inherit from templates), and routes the result through the SAME create validation as object_create (route uniqueness, PageType law, reference integrity). The template must exist (draft is fine); page_type defaults to the template's first appliesTo entry. Pass dry_run: true to preview the built body, the would-be object id, id availability, and full validation without persisting anything.",
    inputSchema: objectSchema(
      {
        template_id: stringSchema('The template object id, e.g. tpl_interior.'),
        site: stringSchema('Owning site object id, e.g. site_acme.'),
        route: stringSchema("The new page's route, e.g. /pricing — must be unique across pages."),
        title: stringSchema("The new page's reader-facing title."),
        page_type: {
          type: 'string',
          enum: [...pageTypeIds],
          description: "Optional PageType for the new page; defaults to the template's first appliesTo entry.",
        },
        seo: anyObjectSchema('Optional seo object ({title?, description?, ogImage?, robots?}); defaults to {}.'),
        requested_id: stringSchema('Optional explicit page id; a valid id is minted from the route when omitted.'),
        dry_run: {
          type: 'boolean',
          description: 'true → return the built body, would-be id, id availability, and validation; persist nothing.',
        },
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['template_id', 'site', 'route', 'title']
    ),
    governance: { toolClass: 'creation', autonomyFloor: 'ask', preview: { kind: 'verb_dry_run' } },
  },
  {
    name: 'object_instantiate_section_template',
    description:
      'Stamp a section-template recipe (W8): deep-copies the recipe\'s blueprint with a freshly minted s_* section id into an existing page — as ONE upsert_section through the standard patch path, so PageType law, the leaf rule, and reference integrity all gate it — or mints a standalone shared sec_* object through the standard create path. Page mode requires YOUR current page checkout (lock_token + expected_record_version; the verb never auto-checkouts). Stamped sections never live-inherit from the recipe (editing the recipe changes future stamps only). Pass dry_run: true to preview the exact op (page mode) or the would-be object (standalone mode) plus full validation without persisting; page-mode dry_run needs neither lock_token nor expected_record_version. The stamped section id is deterministic in (recipe, page, expected_record_version) — after a lost response / 409, dry_run with your ORIGINAL expected_record_version and object_get the page: if that section_id is already present, the first stamp landed. Read object_contract("section_template") first.',
    inputSchema: objectSchema(
      {
        section_template_id: stringSchema('The section-template object id, e.g. stpl_hero_landing.'),
        target: anyObjectSchema(
          'Where to stamp: {kind:"page", page_id, position?, lock_token, expected_record_version} (insert into a page you hold the checkout for; position clamped, appended when omitted) OR {kind:"standalone", requested_id?} (mint a new shared sec_* object; a valid id is minted from the recipe name when omitted).'
        ),
        dry_run: {
          type: 'boolean',
          description: 'true → return the built op/body, ids, and validation; persist nothing (no lock needed).',
        },
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['section_template_id', 'target']
    ),
    governance: { toolClass: 'creation', autonomyFloor: 'ask', preview: { kind: 'verb_dry_run' } },
  },
  {
    name: 'site_apply_theme',
    description:
      'Apply a theme preset\'s brandTokens to the site singleton (W8.3): computes ONE exact-replace set_site_brand_tokens op (the privileged palette writer — brandTokens is not patchable via set_site_fields) — every color key the site carries but the theme lacks is explicitly unset, so no stale palette survives. The theme must be TOTAL (every renderer-consumed color key present) or the apply is rejected with the missing keys — an incomplete theme would delete keys from the site. Applies through the standard patch path under YOUR site checkout (lock_token + expected_record_version from object_checkout on the site object; the verb never auto-checkouts). One op = one atomic content_revision; history records applied_theme; the exact inverse makes reverting a standard discard. The site COPIES the tokens (nothing live-binds to the theme), and going live still requires the separate object_publish + release_to_production steps. Pass dry_run: true to preview the computed op + full validation without persisting — dry_run needs neither lock_token nor expected_record_version. Read object_contract("theme") first.',
    inputSchema: objectSchema(
      {
        theme_id: stringSchema('The theme object id, e.g. thm_acme_default.'),
        site_id: stringSchema('The site singleton object id, e.g. site_acme.'),
        lock_token: stringSchema('Your held site lock (from object_checkout on the site object); dry_run needs none.'),
        expected_record_version: intSchema('The record_version your checkout returned; dry_run needs none.'),
        dry_run: {
          type: 'boolean',
          description: 'true → return the computed set_site_brand_tokens op and validation; persist nothing (no lock).',
        },
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['theme_id', 'site_id']
    ),
    governance: { toolClass: 'privileged', autonomyFloor: 'ask', preview: { kind: 'verb_dry_run' } },
  },
  {
    name: 'site_apply_brand_imagery',
    description:
      "Apply a visual_standard's (or a theme's) brandImagery to the site singleton (brand-imagery wave §3.3): computes ONE exact-replace set_site_brand_imagery op (the privileged imagery writer — brandImagery is not patchable via set_site_fields). Whole-block replace: after the apply, site.brandImagery EQUALS the source's brandImagery — no stale sub-field survives, and (unlike site_apply_theme) there is no totality check to satisfy, since visual_standard.brandImagery is always a fully-populated schema-required object. Pass EXACTLY ONE of visual_standard_id (house OR template — promoting a template look to the live site is a normal use) or theme_id (a theme MAY carry a brandImagery preset alongside its brandTokens; a theme with none is refused with a clear error naming it); both or neither is a 400. Applies through the standard patch path under YOUR site checkout (lock_token + expected_record_version from object_checkout on the site object; the verb never auto-checkouts). One op = one atomic content_revision; history records the source; the exact inverse makes reverting a standard discard. The site COPIES the imagery (nothing live-binds to the source), and going live still requires the separate object_publish + release_to_production steps. Pass dry_run: true to preview {before, after, changedFields} plus the computed op and full validation without persisting — dry_run needs neither lock_token nor expected_record_version. Read object_contract(\"visual_standard\") first.",
    inputSchema: objectSchema(
      {
        visual_standard_id: stringSchema(
          'The visual_standard object id (house vis_<site> or template vis_<site>_<slug>); exactly one of this or theme_id.'
        ),
        theme_id: stringSchema(
          'The theme object id whose brandImagery preset to apply; exactly one of this or visual_standard_id.'
        ),
        site_id: stringSchema('The site singleton object id, e.g. site_acme.'),
        lock_token: stringSchema('Your held site lock (from object_checkout on the site object); dry_run needs none.'),
        expected_record_version: intSchema('The record_version your checkout returned; dry_run needs none.'),
        dry_run: {
          type: 'boolean',
          description:
            'true → return {before, after, changedFields}, the computed op, and validation; persist nothing (no lock).',
        },
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['site_id']
    ),
    governance: { toolClass: 'privileged', autonomyFloor: 'ask', preview: { kind: 'verb_dry_run' } },
  },
  {
    name: 'brand_imagery_propose',
    description:
      "Propose a brandImagery contract from a mood board and/or a brief (brand-imagery wave §3.5). A THIN proxy: Platform makes NO model call itself — it forwards to CMS-Agent's vision-capable `brand_imagery_writer` node and returns the proposal for review; nothing is written anywhere (not the site, not a visual_standard). Pass mode:'house' to propose the site's single house standard, or 'template' (with template_slug) for a named alternate look; pass visual_standard_id to revise an existing standard rather than start fresh. references[] is the mood board (max 8 — the node runner's image cap): each item needs a blob_key (an existing image artifact) or a url, an optional 0..1 region {x,y,w,h} to crop to just the swatch that matters (\"the palette, not the subject\"), an optional note, and an optional weight (0..1, default 1, a Midjourney --sw analogue). Provide brief when there is no mood board yet, or alongside references to steer the reading of them. Returns brand_imagery_proposal.v1: {brandImagery, rationale, sampleSubjects, confidence, label, whenToUse?}. To apply a proposal: run visual_standard_materializer (creates/patches the visual_standard) then site_apply_brand_imagery (or object_create for a brand-new template) — never write brandImagery directly.",
    inputSchema: objectSchema(
      {
        mode: {
          type: 'string',
          enum: ['house', 'template'],
          description: "'house' for the site's one standard; 'template' for a named alternate look.",
        },
        visual_standard_id: stringSchema(
          'Revise this existing visual_standard (house or template) instead of proposing from scratch.'
        ),
        references: arraySchema(
          {
            type: 'object',
            properties: {
              blob_key: stringSchema('An existing image artifact key (e.g. from import_image_from_url).'),
              url: stringSchema('A directly fetchable image URL, when there is no blob_key.'),
              region: {
                type: 'object',
                description:
                  '0..1 fractions of the source image to crop to — "the palette, not the subject". Omit for the whole image.',
                properties: {
                  x: { type: 'number', minimum: 0, maximum: 1 },
                  y: { type: 'number', minimum: 0, maximum: 1 },
                  w: { type: 'number', minimum: 0, maximum: 1 },
                  h: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: ['x', 'y', 'w', 'h'],
                additionalProperties: false,
              },
              note: stringSchema('What this reference is FOR, e.g. "the palette, not the subject" (<=200 chars).'),
              weight: {
                type: 'number',
                minimum: 0,
                maximum: 1,
                description: 'Influence weight, default 1 (a Midjourney --sw analogue).',
              },
            },
            required: [],
            additionalProperties: false,
          },
          'The mood board — at most 8 references; at least one of references or brief is required.'
        ),
        brief: stringSchema('A free-text style brief, used alone or to steer the reading of references.'),
        existing_brand_imagery: anyObjectSchema(
          'The current brandImagery contract, when refining one that already exists.'
        ),
        template_slug: stringSchema(
          "Required with mode:'template' when visual_standard_id is omitted — names the new template standard."
        ),
        agent_name: stringSchema('Optional self-declared agent name recorded on usage telemetry (attribution only).'),
      },
      ['mode']
    ),
    governance: { toolClass: 'read' },
  },
  {
    name: 'object_create_variant',
    description:
      'Clone a content_item (article) object as a DRAFT variant for judge/score/A-B work (W7.3): node ids are re-minted (annotations that reference them — claims/compliance node_ids — are re-pointed), lineage.parent_content_id is set to the source, scores reset, and the clone flows through the standard create validation. Variants need their own slug (defaults to "<source-slug>-variant"; pass slug when creating a second variant). Serving/traffic-splitting is out of scope — publishing a winner is an ordinary object_publish.',
    inputSchema: objectSchema(
      {
        source_object_id: stringSchema('The source article object id (req_*).'),
        slug: stringSchema('Optional slug for the variant; defaults to "<source-slug>-variant".'),
        requested_id: stringSchema('Optional explicit object id; a dated req_* id is minted when omitted.'),
        dry_run: {
          type: 'boolean',
          description: 'true → return the built variant body, would-be id, and validation; persist nothing.',
        },
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['source_object_id']
    ),
    governance: { toolClass: 'creation', preview: { kind: 'verb_dry_run' } },
  },
  {
    name: 'object_checkout',
    description:
      'Acquire the record lease before patching. Returns lockToken and record_version (use it as expected_record_version). GOVERNED CMS OBJECTS ONLY — the object_type enum is the complete list of what this addresses. Records owned by a bridged tool are NOT objects and have no lease here: a pdf-tool PDF TEMPLATE id in particular returns "Object record not found" every time, no matter how it is retried — read it with get_pdf_template and change it with create_pdf_template / publish_pdf_template / delete_pdf_template instead.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lease_seconds: intSchema('Optional lease seconds (default 900, max 3600).'),
        agent_name: stringSchema(
          'Optional self-declared agent name recorded as the lock owner (attribution only; falls back to "unattributed-agent" when omitted).'
        ),
      },
      ['object_type', 'object_id']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'object_refresh_lock',
    description: 'Extend a held record lease; requires the matching lock_token (wrong/expired → 423).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema(),
        lease_seconds: intSchema('Optional lease seconds (default 900, max 3600).'),
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['object_type', 'object_id', 'lock_token']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'object_checkin',
    description: 'Release a held record lease; requires the matching lock_token.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema(),
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['object_type', 'object_id', 'lock_token']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'object_patch',
    description:
      'Apply typed patch ops under a held lock. Requires lock_token and expected_record_version (stale version → 409; missing/expired/wrong lock → 423). Omitted ids on add_term/upsert_* ops are minted server-side. A resulting body that fails validation rejects the op (422) without persisting. Palette governance: site.brandTokens is NOT patchable here — a set_site_fields carrying brandTokens is refused; the palette changes only through the site_apply_theme tool (theme-only, Wolf 2026-07-15). set_site_brand_tokens is tool-authored (do not hand-author it). Same governance for site.brandImagery (W16 C1, the visual-identity contract for AI image generation/search) via the privileged set_site_brand_imagery op — the agent-facing writer is the site_apply_brand_imagery tool (brand-imagery wave §3.3), not object_patch.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema(),
        expected_record_version: intSchema('The record version you last read (optimistic concurrency check).'),
        ops: patchOpsSchema('Array of typed patch ops (the C§2.0 grammar).'),
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['object_type', 'object_id', 'lock_token', 'expected_record_version', 'ops']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'object_validate',
    description:
      'Dry-run validation. Read-only: no lock, no write, no record created. Two mutually exclusive modes: ' +
      '(1) object_id [+ candidate_patch] — validate an EXISTING object, optionally dry-running proposed patch ops ' +
      'through the real engine before applying them (candidate_patch requires object_id). ' +
      '(2) object_type + body [+ requested_id], with NO object_id — validate a CANDIDATE body that has no object ' +
      'yet, running the IDENTICAL checks object_create would run (id pattern/availability, singleton conflict for ' +
      'singleton types, body schema, id discipline, reference integrity, PageType law and route/slug/taxonomy ' +
      'uniqueness where applicable) without persisting anything. This is how you learn whether a body is valid ' +
      'BEFORE creating it — the previous alternative was attempting a real object_create just to learn a body was ' +
      'invalid. Returns the built object_id (minted or your requested_id), id_available, and the same validation/' +
      'summary shape as mode (1). Call this before object_create (see object_contract workflow.sequence).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema('The object id, for mode (1): validate an existing object. Omit for mode (2).'),
        candidate_patch: patchOpsSchema(
          'Mode (1) only: optional ops to dry-run through the engine before validating the result. Requires object_id.'
        ),
        body: anyObjectSchema(
          'Mode (2) only: the candidate object body to validate as if it were about to be created. Omit object_id and candidate_patch when using this.'
        ),
        requested_id: stringSchema(
          'Mode (2) only: optional explicit id for the candidate; a valid id is minted from the body when omitted (same minting object_create uses).'
        ),
        site: stringSchema(
          'Mode (2) only: the site object id (site_<slug>, as object_inventory reports it) this candidate belongs to. Needed ONLY for the types whose id is a per-site convention rather than something derived from the body — visual_standard (vis_<site> for the house, vis_<site>_<slug> for a template), editorial_voice (voice_<site>) and tracking_config (trk_<site>). Resolved automatically from the store when omitted; pass it explicitly if the dry-run reports that it could not mint an id.'
        ),
      },
      ['object_type']
    ),
    governance: { toolClass: 'read' },
  },
  {
    name: 'validate_content_item',
    description:
      'Dry-run readiness check for one article (content_item), standalone — is this article publishable, and what ' +
      'would it warn about, without attempting a publish. Equivalent to object_validate {object_type: "content_item", ' +
      'object_id} (mode 1), exposed under its own name because object_validate is otherwise reachable only as a side ' +
      'effect of another verb. Returns the same grouped validation report and summary object_publish would compute ' +
      'from the identical context, INCLUDING pdf_quality (T2.5, ruling D-D) — a warn-only signal on an attached ' +
      'PDF\'s content quality (blank pages, unresolved images, unrendered template tokens) when a prior check result ' +
      'is available; absent one, this reports nothing rather than a fabricated pass. pdf_quality, like every warning ' +
      'here, NEVER blocks eligibility — check summary.blockers for what actually would.',
    inputSchema: objectSchema(
      {
        object_id: stringSchema('The content_item object id to validate, e.g. article_2026-09-01-moisturizers.'),
      },
      ['object_id']
    ),
    governance: { toolClass: 'read' },
  },

  // ── Review + publish verbs (P1): the same submit_review / review_decide /
  //    discard / publish_by_time actions the admin UI (admin-object.ts) drives,
  //    exposed here so an agent can take an object edit → (review) → published
  //    through one MCP surface. Every one proxies to object-store.ts with the
  //    publish key injected server-side; the shared object-verbs.ts core is the
  //    single authority for locks, the approval-policy publish gate, and the
  //    review-decision rule (now agentic — see object_review_decide) — this
  //    layer adds no new logic. ──
  {
    name: 'object_submit_review',
    description:
      'Open a review on a CMS object (review_state → "open"). Requires a held lock_token. For an approval-gated object type, pass requested_publish_action to pin the exact action the review requests ({ published_time: ISO | null | "immediate" }); an approval only authorizes agent-executed publish of the action it pinned (M-6). Review bookkeeping bumps version, never content_revision. Same path as the admin UI submit-for-review.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema('Lock token from object_checkout; required to submit for review.'),
        note: stringSchema('Optional note recorded on the submit_review history entry.'),
        requested_publish_action: publishActionInputSchema(
          'Optional M-6 pin of the publish action being requested, e.g. { published_time: "immediate" }.'
        ),
      },
      ['object_type', 'object_id', 'lock_token']
    ),
    governance: { toolClass: 'publication' },
  },
  {
    name: 'object_review_decide',
    description:
      "Approve or request changes on an open review. Fully agentic: a detached approval agent may decide over the shared MCP publish key, so an object can go edit → approve → publish with no human; a human decides through the admin UI with a configured role. Same shared logic, one path. On approve, publish_action pins the authorized action (M-6) that an agent-executed publish must then match exactly (publish-gate.ts), so an agentic approval is still explicit and pinned; publish_action is ignored for request_changes. For a live-publish approval you may additionally pass approval_pin to bind agent execution to the exact content-item/request id, artifact set, and release/build behavior reviewed. Bumps version, never content_revision. NOTE (W11 T11.10): a verified-agent-token mechanism now exists (packages/core/server/lib/agent-keys.ts) and could back a future dedicated approval/editor-agent credential, but this verb's own authorization is deliberately UNCHANGED here — it still rides the shared MCP publish key, and M-6 approvals stay human-only (no agent-approves-agent review) per T11.10's own non-goals. Wiring a verified identity into approval authority is a capability change, not an attribution one, and is out of scope until a future task explicitly ratifies it.",
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        decision: { type: 'string', enum: ['approve', 'request_changes'], description: 'The review decision.' },
        note: stringSchema('Optional note recorded on the decision.'),
        publish_action: publishActionInputSchema(
          'Optional M-6 pin for an approval, e.g. { published_time: "immediate" }; ignored for request_changes.'
        ),
        approval_pin: {
          type: 'object',
          additionalProperties: false,
          description:
            'Optional extended live-publish pin for an approval: binds an agent-executed publish to the exact content-item/request id, artifact set, and release/build behavior reviewed. Ignored for request_changes.',
          properties: {
            request_id: stringSchema('Exact content-item / workflow request id the approval covers.'),
            artifact_set: {
              type: 'array',
              items: stringSchema('Approved artifact identifier (blobKey or sha256).'),
              description: 'The exact set of artifacts approved; an agent-executed publish must use exactly this set.',
            },
            release_build: {
              type: 'string',
              enum: ['defer', 'release'],
              description: 'Whether the approval authorizes a deferred (default) or an immediate release/build.',
            },
          },
        },
      },
      ['object_type', 'object_id', 'decision']
    ),
    governance: { toolClass: 'publication', autonomyFloor: 'ask', preview: { kind: 'input_echo' } },
  },
  // ── Marginalia (W15 S4, MVP): canvas commenting/annotation threads on ANY
  //    of the twelve governed object types, persisted in a DEDICATED blob
  //    store independent of the object's own lock/version/patch lifecycle —
  //    none of these four require a held lock_token. ──
  {
    name: 'marginalia_create',
    description:
      'Open a new comment thread on a CMS object (any of the twelve governed types), with its first comment. No lock required — comments are a side channel, not a body write. Optionally scope the thread to a page section (section_id) or an article node (node_id) — the same anchor tuple edit-mode targets use; omit both to comment on the object as a whole. Returns the created thread with its one comment.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        section_id: stringSchema('Optional: scope the thread to this page section instance id.'),
        node_id: stringSchema('Optional: scope the thread to this article (content_item) node id.'),
        field: stringSchema('Reserved for a future field-level anchor; omit for now.'),
        selected_text: stringSchema('Reserved for a future selected-text span anchor; omit for now.'),
        body: stringSchema('The comment text.'),
      },
      ['object_type', 'object_id', 'body']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'marginalia_reply',
    description:
      'Add a comment to an existing Marginalia thread. No lock required. parent_comment_id is accepted and stored but this MVP client renders a flat list (reply-threading UI is a documented follow-up).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        thread_id: stringSchema('The thread id from marginalia_create / marginalia_list.'),
        body: stringSchema('The comment text.'),
        parent_comment_id: stringSchema('Optional: the comment this one replies to.'),
      },
      ['object_type', 'object_id', 'thread_id', 'body']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'marginalia_list',
    description: 'List every Marginalia thread (each with its full comment list, oldest first) for one CMS object.',
    inputSchema: objectSchema({ object_type: objectTypeEnumSchema(), object_id: stringSchema() }, [
      'object_type',
      'object_id',
    ]),
    governance: { toolClass: 'read' },
  },
  {
    name: 'marginalia_resolve',
    description:
      'Set a Marginalia thread\'s status: "resolved" | "dismissed" | "open" (re-opens). One status flag per thread, not per comment. No lock required.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        thread_id: stringSchema('The thread id from marginalia_create / marginalia_list.'),
        status: { type: 'string', enum: ['open', 'resolved', 'dismissed'], description: 'The new thread status.' },
      },
      ['object_type', 'object_id', 'thread_id', 'status']
    ),
    governance: { toolClass: 'draft' },
  },
  {
    name: 'object_discard',
    description:
      'Discard rejected draft ops via compensating inverse writes (C§2.4). Requires a held lock_token and the rejected ops exactly as their history entries stored them ({ op, capture }); inverses are applied newest-first as one atomic batch attributed to the caller. This IS a body write: it bumps content_revision and invalidates any approval pinned to the prior revision. A blind revert over intervening accepted ops is refused (409).',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema('Lock token from object_checkout; required to write the inverse ops.'),
        entries: arraySchema(
          objectSchema(
            {
              op: { description: 'The rejected patch op, exactly as stored in the record history entry.' },
              capture: { description: "The op's history capture, exactly as stored alongside it." },
            },
            ['op', 'capture']
          ),
          'Rejected ops to invert, exactly as their history entries store them (details.op / details.capture).'
        ),
      },
      ['object_type', 'object_id', 'lock_token', 'entries']
    ),
    governance: { toolClass: 'publication' },
  },
  {
    name: 'object_retire',
    description:
      'RETIRE an object: the governed way to remove one (W14 F6) — a governed CMS OBJECT, of the object_type enum, and nothing else: a pdf-tool PDF TEMPLATE is not an object and is not retired here (it fails with "Object record not found"); deactivate one with delete_pdf_template, which is soft, reversible, and has NO grace period and no hard delete. Archives the record (reversible — history is preserved, and a separate purge hard-deletes only after a 30-day grace period; that grace period is THIS object purge, and applies to nothing outside it), REMOVES its committed export in the same commit, and — for a page — writes a 301 redirect from the retired route so no reader is dropped on a 404. Requires a held lock_token, exactly like patch and publish. REFUSED (409) when anything still references the object (the referrers are named — repoint or retire those first), when a review is open, or for the site singleton. The retirement commits to main with [skip netlify]: the live site keeps serving the old build until an explicit release_to_production, which is when the page actually disappears. Idempotent — retiring an already-archived object reports success.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema('Lock token from object_checkout; required to retire.'),
        redirect_to: stringSchema(
          'Where readers of the retired route should land. Defaults to "/" — a retired page never 404s.'
        ),
        reason: stringSchema('Optional note recorded in the retirement history entry.'),
      },
      ['object_type', 'object_id', 'lock_token']
    ),
    governance: { toolClass: 'publication', autonomyFloor: 'ask', preview: { kind: 'input_echo' } },
  },
  {
    name: 'object_publish',
    description:
      'Publish a governed CMS object through the generic publish operation: run the approval-policy publish gate, then validate → materialize → commit the export to git → stamp the record, in that order (the record is never stamped before the export commits). Requires a held lock_token. Omit published_time to publish now; null (unpublish) and future timestamps are rejected in this phase. Pass producer only when real run/node/prompt/model context is available; it is recorded in publish history and the derived export. The gate is identical to the admin UI: autonomous object types publish directly with no human; approval-gated types require a current human approval pinned (M-6) to the exact action being attempted. content_item (article objects) publishes here too since W7.3 — Tier 1 stays autonomous under the committed policy. The export commit carries [skip netlify], so a successful publish does NOT deploy — the change commits to main and goes live only on an explicit release (release_to_production); the response "production" block spells this out. Publish deliberately KEEPS your lock (it re-stamps under the live lease so concurrent body drift is caught, not silently overwritten) — it is NOT terminal for the lock. Call object_checkin when you are done, or the object stays locked to everyone else for the rest of the 15-minute lease. If this call itself times out or 502s (ambiguous whether the publish landed), retry with the SAME idempotency_key to get back the original publish receipt instead of re-running the commit/stamp.',
    inputSchema: objectSchema(
      {
        object_type: objectTypeEnumSchema(),
        object_id: stringSchema(),
        lock_token: stringSchema('Lock token from object_checkout; required to publish.'),
        published_time: nullableStringSchema(
          'Optional ISO instant. Omit to publish now. null (unpublish) and future timestamps are rejected in this phase.'
        ),
        artifact_set: {
          type: 'array',
          items: stringSchema('Artifact identifier (blobKey or sha256) this publish uses.'),
          description:
            'Optional. Declare the artifact set this publish uses so an approval that pins an artifact_set can be satisfied — the gate confirms they match exactly. Only needed for approval-gated types whose current approval pins one.',
        },
        release_build: {
          type: 'string',
          enum: ['defer', 'release'],
          description:
            'Optional. The release/build behavior this publish uses, so an approval that pins release_build can be satisfied. Object publishes always defer the deploy (release is the separate release_to_production step); this declares the approved intent for the gate.',
        },
        producer: objectSchema(
          {
            run_id: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'CMS-Agent run id that produced this revision.',
            },
            node_id: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'CMS-Agent workflow node id that produced this revision.',
            },
            prompt_version: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'Prompt/version identifier used by the producer.',
            },
            model: {
              type: 'string',
              minLength: 1,
              maxLength: 128,
              description: 'Model identifier used by the producer.',
            },
          },
          ['run_id', 'node_id', 'prompt_version', 'model']
        ),
        idempotency_key: idempotencyKeyJsonSchema,
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['object_type', 'object_id', 'lock_token']
    ),
    // ART-3: object_retire and object_review_decide are floored but going
    // LIVE to readers was not. The floor is a chat-approval rule only — it
    // does not touch the publish gate, so an `all-autonomous` posture still
    // publishes without approval over /mcp and through the workflow's own
    // publish_workspace_run; it only means a human in a chat sees the card.
    governance: { toolClass: 'publication', autonomyFloor: 'ask' },
  },
  {
    name: 'object_inventory',
    description:
      'Read-only inventory of CMS objects: per object — id, type, status, requires_approval (whether the configured approval policy gates publishing this type behind a human approval), lock state (held/free, holder, expiry), review state, version, content_revision, last-published time, and an unpublished_changes flag (current content_revision vs the publish receipt). Recipe rows (template / section_template / theme) additionally carry a `recipe` summary — name, scope ("evergreen" = standing recipe, "one_off" = single-project), description, when_to_use, plus blueprint_type (section_template) or applies_to + slot_count (template) — so ONE cheap call answers "what recipes exist and which fits" without fetching bodies. REUSE FIRST: consult this before creating any new recipe. Omit object_type to sweep every type; pass object_type + object_id for a single-object detail view (adds site, timestamps, full review decisions, publish receipt, history length). Filters: status, requires_approval, review_state (none | open | changes_requested | approved), pending_changes.',
    inputSchema: objectSchema({
      object_type: objectTypeEnumSchema(),
      object_id: stringSchema('With object_type: return the single-object detail view instead of a list.'),
      status: { type: 'string', enum: ['active', 'archived'], description: 'Optional status filter.' },
      requires_approval: {
        type: 'boolean',
        description: 'Optional filter: true → only approval-gated types; false → only autonomous ones.',
      },
      review_state: {
        type: 'string',
        enum: ['none', 'open', 'changes_requested', 'approved'],
        description: 'Optional review-state filter (none = no review has ever been opened).',
      },
      pending_changes: {
        type: 'boolean',
        description: 'Optional: true → only objects the live site has not seen; false → only fully published ones.',
      },
    }),
    governance: { toolClass: 'read' },
  },
  {
    name: 'object_contract',
    description:
      'The complete, machine-readable contract for creating and editing one CMS object type — READ THIS FIRST, before object_create/object_patch, so you never guess. Returns, all derived from the enforcing code (so it cannot drift): body_schema (the exact JSON-schema of a valid body); section_types (for page/section: every placeable section variant, its data JSON-schema, whether it has a bound component, and editor hints); patch_ops (exactly the ops allowed for this type, each with an argument JSON-schema and which id field is server-minted so you may omit it); constraints (the structural boundaries with severity and whether each is enforced live); publish_policy (whether publishing needs approval — computed from the live policy — plus the M-6 pin rules and denial codes); creation_policy (who may CREATE this type: humans always; agents open or allowlisted per the committed creation policy — a denial is a 403 creation_restricted); workflow (the checkout→validate→patch→publish→release sequence — for recipe types it STARTS with a REUSE-FIRST step, the 423/409 lock/version discipline, and the patch error-code catalog); and auxiliary_inputs (side-data a move needs, e.g. artifact uploads for image fields). Live per-object state (version/lock/review) is in object_inventory; a dry run of a specific patch is object_validate.',
    inputSchema: objectSchema({ object_type: objectTypeEnumSchema('The CMS object type to describe.') }, [
      'object_type',
    ]),
    governance: { toolClass: 'read' },
  },
  {
    name: 'product_set_price',
    description:
      'THE only price-edit path for a product (§3 canonicality): creates a NEW Stripe Price (prices are immutable) for the running STRIPE_MODE, archives the old one, and writes price_id + the display cache into the product record in ONE governed set_product_price patch (checkout → patch → checkin; audited; inverse = re-point to the archived price). A product with no Stripe linkage yet gets a Stripe Product created from its title. The change is an UNPUBLISHED revision — publishing stays review-required (§0.4): submit_review → a human approves → object_publish. Never edit commerce.price/stripe via set_product_fields; that op refuses those keys.',
    inputSchema: objectSchema(
      {
        product_id: stringSchema('The product object id (prod_…).'),
        amount_cents: { type: 'number', description: 'The new price in integer cents (positive).' },
        currency: stringSchema("Lowercase ISO currency code; default 'usd'."),
        agent_name: stringSchema('Optional self-declared agent name recorded on history (attribution only).'),
      },
      ['product_id', 'amount_cents']
    ),
    governance: { toolClass: 'privileged', autonomyFloor: 'ask', preview: { kind: 'input_echo' } },
  },
  {
    name: 'order_reissue',
    description:
      'Regenerate a purchase download link from the stored ORDER record (§5 — fulfillment is a pure function of the order; no Stripe round trip). The support case this exists for: "customer lost the email / the link expired" (§8.4 — launch-critical, there are no customer accounts). Appends an audited reissue entry {at, token_hash, by} to the order plus a fulfillment_reissued event; old tokens are not revoked (they expire on their own). order_key is the Checkout session id (cs_…) for paid orders, or the ord_free_… id for free claims.',
    inputSchema: objectSchema(
      {
        order_key: stringSchema('The order idempotency key: Checkout session id, or ord_… for free claims.'),
        ttl_hours: { type: 'number', description: 'Link lifetime in hours (1–336); default 72.' },
        agent_name: stringSchema('Optional self-declared agent name recorded on the reissue entry.'),
      },
      ['order_key']
    ),
    governance: { toolClass: 'privileged', autonomyFloor: 'ask', preview: { kind: 'input_echo' } },
  },
  {
    name: 'commerce_orders',
    description:
      'Read-only order administration over the commerce store (support lookups — the front half of order_reissue). Without order_key: a bounded list, newest first (limit default 20, cap 100), filterable by buyer email (exact, case-insensitive) and/or product_id — "customer X lost their email" starts here. With order_key: the full order record (raw buyer email lives in orders by design, §6; the event log carries only hashes). NOT a reporting surface: Blobs is not a queryable database (§8.6) — aggregation waits for the external consumer.',
    inputSchema: objectSchema({
      order_key: stringSchema(
        'Return ONE full order by its idempotency key (cs_… session id, or ord_… for free claims).'
      ),
      email: stringSchema('List filter: exact buyer email (case-insensitive).'),
      product_id: stringSchema('List filter: only orders for this product object id (prod_…).'),
      limit: { type: 'number', description: 'List cap, newest first (default 20, max 100).' },
    }),
    governance: { toolClass: 'read' },
  },
  {
    name: 'registry_get',
    description:
      "Read a code registry. registry: 'page_type' returns the PageType definitions (route pattern, allowed/required sections, review policy) plus a JSON-schema rendering of the definition shape; 'component' returns every section type with its data JSON-schema, editor hints, and whether a component is bound. For the full per-object-type contract (body schema + patch ops + constraints + publish policy), use object_contract instead.",
    inputSchema: objectSchema({
      registry: { type: 'string', enum: ['component', 'page_type'], description: 'Optional registry name.' },
    }),
    governance: { toolClass: 'read' },
  },
];
