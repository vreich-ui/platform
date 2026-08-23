/**
 * T9.13/PF5 — the GENERATED half of the chat tool registry: every governed
 * `TOOL_DEFINITION` (mcp-tool-definitions.ts / -2.ts) that isn't
 * INTERNAL_ONLY, wrapped as a `ChatTool` (tools.ts), plus the three
 * workspace-orchestration tools that already live in tools.ts (reused via
 * `chatToolByName` — this module imports from tools.ts, it never
 * reimplements or duplicates a CHAT_TOOLS entry).
 *
 * Execution bindings (verified against object-verbs.ts / mcp.ts's dispatch
 * switch, not assumed):
 *  - `object_*` + `site_apply_theme`  → `ctx.verb(...)`, same HUMAN-principal
 *    path tools.ts's own object tools already ride. Payloads are built field-
 *    for-field the way mcp.ts's callTool switch builds them.
 *  - `object_contract`                → `ctx.contract(...)`.
 *  - `list_artifacts_for_request`     → `ctx.listArtifacts(...)`.
 *  - everything else (artifact reads/search, marginalia_*, registry_get,
 *    deploy_status, verify_article_images, release_to_production,
 *    commerce_orders, product_set_price, order_reissue, the pdf-tool family,
 *    the image family, ping, health) → `ctx.operational.call(name, args)`,
 *    a new optional ToolContext member (tools.ts) wired in agent/context.ts.
 *    Absent operational bridge → a clear is_error result, never a crash.
 *
 * `site_apply_theme` and `release_to_production` are Owner-gated AT
 * EXECUTION, mirroring tools.ts's `apply_theme` — the gate is independent of
 * autonomy, so a misconfigured 'auto' still cannot bypass it.
 */
import { INTERNAL_ONLY_TOOLS, CHAT_TOOL_ALIASES } from '../mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART1 } from '../mcp-tool-definitions.js';
import { TOOL_DEFINITIONS_PART2 } from '../mcp-tool-definitions-2.js';
import {
  MEMBERSHIP_TOOL_VERBS,
  TOOL_DEFINITIONS_MEMBERSHIP,
  isMembershipTool,
} from '../mcp-tool-definitions-membership.js';
import type { ToolDefinition } from '../../functions/mcp.js';
import { compileSchema, type CompiledSchema } from './json-schema-lite.js';
import { chatToolByName, type ChatTool, type ToolContext, type ToolAutonomy } from './tools.js';
import type { ObjectType } from '../../../schema/object-record-v1.js';

const json = (body: unknown) => JSON.stringify(body);

const verbResult = async (ctx: ToolContext, request: Record<string, unknown>) => {
  const result = await ctx.verb(request);
  return { content: json(result.body), is_error: result.status !== 200 };
};

const OPERATIONAL_UNAVAILABLE = {
  content: json({ error: 'The operational tool bridge is not configured for this chat session.' }),
  is_error: true,
};

const ownerRequired = (name: string) => ({
  content: json({ error: `${name} requires the Owner role.` }),
  is_error: true,
});

// ─── every TOOL_DEFINITION visible to chat (INTERNAL_ONLY excluded) ─────────

const VISIBLE_DEFINITIONS: readonly ToolDefinition[] = [
  ...TOOL_DEFINITIONS_PART1,
  ...TOOL_DEFINITIONS_PART2,
  // W18 T18.6b: the membership family — routed to ToolContext.membership
  // (the T18.6a core with the run's captured HUMAN principal), never the verb
  // or operational bridges.
  ...TOOL_DEFINITIONS_MEMBERSHIP,
].filter((def) => !INTERNAL_ONLY_TOOLS.has(def.name));

const MEMBERSHIP_UNAVAILABLE = {
  content: json({
    error: 'Membership tools are not wired for this chat session.',
    error_code: 'membership_unavailable',
  }),
  is_error: true,
};

/** Human copy for the membership approval cards (plan §7). */
const describeMembership = (name: string, args: Record<string, unknown>): string => {
  const email = typeof args.email === 'string' ? args.email : '';
  const role = typeof args.role === 'string' ? args.role : '';
  const tier = role ? role.charAt(0).toUpperCase() + role.slice(1) : '';
  switch (name) {
    case 'member_invite':
      return `Invite **${email}** as **${tier}** — an e-mail is sent by Netlify Identity`;
    case 'invitation_resend':
      return `Re-send the invitation to **${email || args.invite_id}**`;
    case 'invitation_revoke':
      return `Revoke the invitation for **${email || args.invite_id}**${args.reason ? ` — ${args.reason}` : ''}`;
    case 'member_set_role':
      return `Change **${email}** to **${tier}**`;
    case 'member_suspend':
      return `Suspend **${email}** — no access from now on; MCP grants revoked, locks released${args.reason ? ` — ${args.reason}` : ''}`;
    case 'member_reinstate':
      return `Reinstate **${email}**`;
    case 'member_remove':
      return `Remove **${email}** — keeps history, purges after the grace period${args.delete_identity === false ? ', keeps their login' : ', deletes their login'}`;
    case 'member_purge':
      return `PURGE **${email}** — irreversible: personal data scrubbed now`;
    case 'ownership_transfer':
      return `Transfer ownership to **${args.to_email}**${args.from_email ? ` from **${args.from_email}**` : ''} (${args.demote_to ?? 'admin'} afterwards)`;
    case 'membership_policy_set':
      return `Change the membership policy: ${Object.keys((args.policy as Record<string, unknown>) ?? {}).join(', ') || '(no fields)'}`;
    default:
      return `${name}${email ? ` ${email}` : ''}`;
  }
};

const CHAT_DEFAULT_OFF_NAMES = new Set<string>(
  VISIBLE_DEFINITIONS.filter((def) => def.governance.chatDefaultOff).map((def) => def.name)
);

// ─── object_* + site_apply_theme: verb payload builders (§3), mirroring
//     mcp.ts's callTool switch field-for-field ──────────────────────────────

type VerbPayloadBuilder = (args: Record<string, unknown>) => Record<string, unknown>;

const VERB_PAYLOAD_BUILDERS: Record<string, VerbPayloadBuilder> = {
  object_get: (args) => ({ action: 'get', object_type: args.object_type, object_id: args.object_id }),
  object_list: (args) => ({ action: 'list', object_type: args.object_type, status: args.status }),
  object_create: (args) => ({
    action: 'create',
    object_type: args.object_type,
    site: args.site,
    body: args.body,
    requested_id: args.requested_id,
    agent_name: args.agent_name,
  }),
  object_create_variant: (args) => ({
    action: 'create_variant',
    object_type: 'content_item',
    source_object_id: args.source_object_id,
    slug: args.slug,
    requested_id: args.requested_id,
    dry_run: args.dry_run,
    agent_name: args.agent_name,
  }),
  object_instantiate_template: (args) => ({
    action: 'instantiate',
    template_id: args.template_id,
    site: args.site,
    route: args.route,
    title: args.title,
    page_type: args.page_type,
    seo: args.seo,
    requested_id: args.requested_id,
    dry_run: args.dry_run,
    agent_name: args.agent_name,
  }),
  object_instantiate_section_template: (args) => ({
    action: 'instantiate_section',
    section_template_id: args.section_template_id,
    target: args.target,
    dry_run: args.dry_run,
    agent_name: args.agent_name,
  }),
  site_apply_theme: (args) => ({
    action: 'apply_theme',
    theme_id: args.theme_id,
    site_id: args.site_id,
    lock_token: args.lock_token,
    expected_record_version: args.expected_record_version,
    dry_run: args.dry_run,
    agent_name: args.agent_name,
  }),
  object_checkout: (args) => ({
    action: 'checkout',
    object_type: args.object_type,
    object_id: args.object_id,
    lease_seconds: args.lease_seconds,
  }),
  object_refresh_lock: (args) => ({
    action: 'refresh_lock',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    lease_seconds: args.lease_seconds,
  }),
  object_checkin: (args) => ({
    action: 'checkin',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
  }),
  object_patch: (args) => ({
    action: 'patch',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    expected_record_version: args.expected_record_version,
    ops: args.ops,
  }),
  object_validate: (args) => ({
    action: 'validate',
    object_type: args.object_type,
    object_id: args.object_id,
    candidate_patch: args.candidate_patch,
    body: args.body,
    requested_id: args.requested_id,
  }),
  object_inventory: (args) => ({
    action: 'inventory',
    object_type: args.object_type,
    object_id: args.object_id,
    status: args.status,
    requires_approval: args.requires_approval,
    review_state: args.review_state,
    pending_changes: args.pending_changes,
  }),
  object_submit_review: (args) => ({
    action: 'submit_review',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    note: args.note,
    requested_publish_action: args.requested_publish_action,
  }),
  object_review_decide: (args) => ({
    action: 'review_decide',
    object_type: args.object_type,
    object_id: args.object_id,
    decision: args.decision,
    note: args.note,
    publish_action: args.publish_action,
    approval_pin: args.approval_pin,
  }),
  object_discard: (args) => ({
    action: 'discard',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    entries: args.entries,
  }),
  object_retire: (args) => ({
    action: 'retire',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    redirect_to: args.redirect_to,
    reason: args.reason,
  }),
  object_publish: (args) => ({
    action: 'publish_by_time',
    object_type: args.object_type,
    object_id: args.object_id,
    lock_token: args.lock_token,
    published_time: args.published_time,
    artifact_set: args.artifact_set,
    release_build: args.release_build,
  }),
};

// ─── describe() overrides — curated phrasings ported from tools.ts, keyed by
//     CANONICAL (mcp) tool name; arg field names adapted where the generated
//     definition's schema names them differently than the old chat tool did
//     (e.g. list_artifacts_for_request's `requestId` vs the old
//     `search_artifacts` chat tool's `request_id`) ──────────────────────────

const DESCRIBE_OVERRIDES: Record<string, (args: Record<string, unknown>) => string> = {
  object_get: (args) => `Read ${args.object_type} ${args.object_id}`,
  object_contract: (args) => `Read the ${args.object_type} contract`,
  object_list: (args) => `List ${args.object_type} objects`,
  object_inventory: () => 'Browse the object inventory',
  // Adapted from tools.ts's `validate` (which always required object_id):
  // object_validate has a second, object_id-less candidate-body mode.
  object_validate: (args) => `Validate ${args.object_type}${args.object_id ? ` ${args.object_id}` : ''}`,
  list_artifacts_for_request: (args) => `List artifacts for ${args.requestId}`,
  object_checkout: (args) => `Check out ${args.object_type} ${args.object_id} for editing`,
  object_patch: (args) =>
    `Patch ${args.object_type} ${args.object_id}: ${Array.isArray(args.ops) ? args.ops.length : '?'} op(s)`,
  object_checkin: (args) => `Check in ${args.object_type} ${args.object_id}`,
  object_refresh_lock: (args) => `Refresh the lock on ${args.object_type} ${args.object_id}`,
  object_create: (args) => `Create a new ${args.object_type}`,
  object_create_variant: (args) => `Create a variant of ${args.source_object_id}`,
  object_instantiate_template: (args) => `Create a page at ${args.route} from ${args.template_id}`,
  object_instantiate_section_template: (args) => {
    const target = args.target as { kind?: string; page_id?: string } | undefined;
    return target?.kind === 'page'
      ? `Stamp ${args.section_template_id} into ${target.page_id}`
      : `Mint a shared section from ${args.section_template_id}`;
  },
  object_submit_review: (args) => `Submit ${args.object_type} ${args.object_id} for review`,
  object_publish: (args) => `Publish ${args.object_type} ${args.object_id}`,
  object_discard: (args) => `Discard drafted changes on ${args.object_type} ${args.object_id}`,
  site_apply_theme: (args) => `Apply theme ${args.theme_id} to ${args.site_id}`,
};

const describeGenerated = (name: string, args: Record<string, unknown>): string => {
  if (isMembershipTool(name)) return describeMembership(name, args);
  const override = DESCRIBE_OVERRIDES[name];
  if (override) return override(args);
  return `${name}${args.object_id ? ` ${args.object_id}` : ''}`;
};

// ─── parse(): compiled json-schema-lite validator, plus object_patch's
//     agent-authored-ops hook (ported verbatim from tools.ts's patch.parse —
//     schema check first, then ops check) ───────────────────────────────────

/**
 * ART-1 — articles have ONE production path from admin chat.
 *
 * `content_item` carries the judge/score substrate the publishing workflow
 * exists to produce (claims / sources / compliance / scores, the per-node
 * private.strategy+intent annotations, and the aggression ceiling, which is
 * enforced ONLY in CMS-Agent's publish readiness — Platform never checks it).
 * A direct `object_create` from chat produces a schema-valid article with
 * NONE of it, and on an `all-autonomous` tenant that article can then be
 * published without an approval, a pin, or a review.
 *
 * So the chat registry refuses the direct create and names the governed
 * entry point instead. This is a CHAT-registry rule only: the verb itself is
 * untouched, so /mcp operators, tests and the workspace publisher keep it.
 * Editing an EXISTING article from chat (object_patch) is unaffected — only
 * minting a new one is redirected.
 */
export const CHAT_ARTICLE_CREATE_REFUSAL =
  'Articles are not created directly. An article carries the sourcing, claim and compliance record that only the ' +
  'publishing workflow produces, so start production with run_workspace_workflow (pass the editor’s brief verbatim ' +
  'as input.instructions) and follow it with check_workspace_run_readiness → publish_workspace_run → ' +
  'release_workspace_run. To revise an article that already exists, use object_checkout + object_patch instead.';

const buildParse = (name: string, validator: CompiledSchema): ChatTool['parse'] => {
  if (name === 'object_patch') {
    return (args, ctx) => {
      const schemaResult = validator(args);
      if (!schemaResult.ok) return { ok: false, error: `Invalid arguments: ${schemaResult.error}` };
      const objectType = args.object_type as ObjectType;
      const ops = Array.isArray(args.ops) ? (args.ops as Record<string, unknown>[]) : [];
      const allowed = ctx.agentAuthoredOps(objectType);
      for (const op of ops) {
        const opName = op && typeof op === 'object' && typeof op.op === 'string' ? op.op : undefined;
        if (!opName || !allowed.has(opName)) {
          return {
            ok: false,
            error:
              `Op "${opName ?? '(missing op name)'}" is not a permitted agent-authored op for ${objectType}. ` +
              `Permitted: ${[...allowed].join(', ')}.`,
          };
        }
      }
      return { ok: true, value: args };
    };
  }
  if (name === 'object_create') {
    return (args) => {
      const schemaResult = validator(args);
      if (!schemaResult.ok) return { ok: false, error: `Invalid arguments: ${schemaResult.error}` };
      if ((args.object_type as ObjectType) === 'content_item') {
        return { ok: false, error: CHAT_ARTICLE_CREATE_REFUSAL };
      }
      return { ok: true, value: args };
    };
  }
  return (args) => {
    const result = validator(args);
    return result.ok ? { ok: true, value: args } : { ok: false, error: `Invalid arguments: ${result.error}` };
  };
};

// ─── execute(): per §3's binding map ────────────────────────────────────────────────────

const buildExecute = (name: string, verbPayload: VerbPayloadBuilder | undefined): ChatTool['execute'] => {
  if (isMembershipTool(name)) {
    // The role wall is in the core (T18.6a): the run's captured human is
    // re-resolved per call; agents and non-Owners are refused there.
    return async (ctx, args) => {
      if (!ctx.membership) return MEMBERSHIP_UNAVAILABLE;
      const { idempotency_key: _idem, ...rest } = args;
      const result = await ctx.membership.call(MEMBERSHIP_TOOL_VERBS[name], rest);
      return { content: json(result.body), is_error: result.status !== 200 };
    };
  }
  if (name === 'object_contract') {
    return async (ctx, args) => ({ content: json(ctx.contract(args.object_type as ObjectType)), is_error: false });
  }
  if (name === 'list_artifacts_for_request') {
    return async (ctx, args) => ({ content: json(await ctx.listArtifacts(args.requestId as string)), is_error: false });
  }
  if (verbPayload) {
    if (name === 'site_apply_theme') {
      return async (ctx, args) => {
        // The role wall is here, at execution — independent of autonomy
        // config, mirroring tools.ts's applyTheme.
        if (!ctx.roles.includes('owner')) return ownerRequired(name);
        return verbResult(ctx, verbPayload(args));
      };
    }
    return async (ctx, args) => verbResult(ctx, verbPayload(args));
  }
  // Everything else rides the operational bridge.
  return async (ctx, args) => {
    if (name === 'release_to_production' && !ctx.roles.includes('owner')) return ownerRequired(name);
    if (!ctx.operational) return OPERATIONAL_UNAVAILABLE;
    return ctx.operational.call(name, args);
  };
};

// ─── dryRun(): per governance.preview ───────────────────────────────────────────────────

const buildDryRun = (
  def: ToolDefinition,
  verbPayload: VerbPayloadBuilder | undefined
): ChatTool['dryRun'] | undefined => {
  const preview = def.governance.preview;
  if (!preview) return undefined;

  if (preview.kind === 'input_echo') {
    return async (_ctx, args) => ({
      dry_run: true,
      action: def.name,
      args_echo: args,
      note: 'Preview is an echo of the exact arguments that will be sent on approval.',
    });
  }

  if (preview.kind === 'validate_new_object') {
    return async (ctx, args) =>
      ctx.validateNewObject(args.object_type as ObjectType, args.body, args.requested_id as string | undefined);
  }

  if (preview.kind === 'verb_dry_run' && isMembershipTool(def.name)) {
    return async (ctx, args) => {
      if (!ctx.membership) return { error: 'Membership tools are not wired for this chat session.' };
      const { idempotency_key: _idem, ...rest } = args;
      return (await ctx.membership.call(MEMBERSHIP_TOOL_VERBS[def.name], { ...rest, dry_run: true })).body;
    };
  }

  // 'verb_dry_run': run the SAME verb payload with dry_run: true, return .body
  // — mirrors how tools.ts does it for create_variant/instantiate/apply_theme.
  if (!verbPayload) {
    throw new Error(`generated-tools: "${def.name}" declares a verb_dry_run preview but has no verb payload builder.`);
  }
  const builder = verbPayload;
  return async (ctx, args) => (await ctx.verb({ ...builder(args), dry_run: true })).body;
};

// ─── assembly ───────────────────────────────────────────────────────────────

const buildGeneratedTool = (def: ToolDefinition): ChatTool => {
  const validator = compileSchema(def.inputSchema);
  const verbPayload = VERB_PAYLOAD_BUILDERS[def.name];
  const dryRun = buildDryRun(def, verbPayload);

  return {
    name: def.name,
    toolClass: def.governance.toolClass,
    ...(def.governance.autonomyFloor ? { autonomyFloor: def.governance.autonomyFloor } : {}),
    description: def.description,
    input_schema: def.inputSchema,
    parse: buildParse(def.name, validator),
    execute: buildExecute(def.name, verbPayload),
    ...(dryRun ? { dryRun } : {}),
    describe: (args) => describeGenerated(def.name, args),
  };
};

const WORKSPACE_TOOL_NAMES = [
  'list_workspace_nodes',
  'run_workspace_workflow',
  'get_workspace_run',
  // D2a (2026-08-17): readiness / publish / release from chat.
  'check_workspace_run_readiness',
  'publish_workspace_run',
  'release_workspace_run',
  // W19 T19.8: the editorial request registry. Reused for the same reason as
  // the workspace tools — these ride a blob store, not the object verbs the
  // generated definitions are built from.
  'list_requests',
  'get_request',
  'get_request_activity',
  'retry_request',
  'archive_request',
] as const;

// Reused, not rebuilt — tools.ts stays the single source of truth for these
// (workspace orchestration and the request registry ride their own stores and
// bridges, not the object verbs).
const workspaceTools: ChatTool[] = WORKSPACE_TOOL_NAMES.map((name) => {
  const tool = chatToolByName(name);
  if (!tool) {
    throw new Error(`generated-tools: expected tools.ts's CHAT_TOOLS to still export "${name}".`);
  }
  return tool;
});

/** One registry: every visible generated tool, plus the reused workspace + request tools. */
export const GENERATED_CHAT_TOOLS: readonly ChatTool[] = [
  ...VISIBLE_DEFINITIONS.map(buildGeneratedTool),
  ...workspaceTools,
];

const registryByName = new Map<string, ChatTool>(GENERATED_CHAT_TOOLS.map((tool) => [tool.name, tool]));

/** Exact registry name wins; else the legacy-alias table; else unchanged. Never applied to wire tool names. */
export const canonicalToolName = (name: string): string => {
  if (registryByName.has(name)) return name;
  return CHAT_TOOL_ALIASES[name] ?? name;
};

export const generatedChatToolByName = (name: string): ChatTool | undefined =>
  registryByName.get(canonicalToolName(name));

const defaultAutonomyForGenerated = (tool: ChatTool): ToolAutonomy => {
  if (tool.toolClass === 'read') return 'auto';
  return CHAT_DEFAULT_OFF_NAMES.has(tool.name) ? 'off' : 'ask';
};

/** Resolve `map`'s value for `canonical`: an exact key wins; else the first stored key that CANONICALIZES to it. */
const resolveFromMap = (map: Record<string, ToolAutonomy> | undefined, canonical: string): ToolAutonomy | undefined => {
  if (!map) return undefined;
  if (Object.prototype.hasOwnProperty.call(map, canonical)) return map[canonical];
  for (const key of Object.keys(map)) {
    if (key !== canonical && canonicalToolName(key) === canonical) return map[key];
  }
  return undefined;
};

/**
 * Same layering as tools.ts's `resolveAutonomy`, over the generated registry:
 * defaults (read → auto, chatDefaultOff → off, else ask) ← governance
 * chat_tools ← profile overrides (most specific wins). Stored keys
 * canonicalize via `canonicalToolName` before lookup — a legacy alias key
 * (e.g. `patch`) still applies to its canonical tool (`object_patch`), but an
 * exact canonical key in the SAME map beats a legacy-alias key for the same
 * tool. The PF4 hard floor is identical to tools.ts: a floored tool can
 * resolve to 'off' but never 'auto'.
 */
/**
 * Task 3 §6 — canonicalize a stored autonomy map's keys through
 * CHAT_TOOL_ALIASES, unconditionally: `search_artifacts` migrates to
 * `list_artifacts_for_request` even though the identically-named GENERATED
 * tool means something else — pre-migration docs can only have meant the
 * legacy chat tool (request-scoped artifact listing), so that's the only
 * correct reading. Post-migration writes are canonical and skip this
 * function entirely (the `chat_tools_migrated` / `keys_migrated` stamps).
 *
 * Collision rule: if the map ALREADY has an entry under the canonical key,
 * that entry wins and the legacy-aliased entry is dropped — regardless of
 * object key iteration order (two passes: canonical-already keys first).
 * `changed` is true whenever any key was renamed OR dropped.
 */
export const migrateAutonomyKeys = (
  map: Record<string, ToolAutonomy> | undefined
): { map: Record<string, ToolAutonomy> | undefined; changed: boolean } => {
  if (!map) return { map, changed: false };
  let changed = false;
  const result: Record<string, ToolAutonomy> = {};
  // Pass 1: keys that are not a legacy-alias source are already canonical —
  // these seed the result and win any later collision.
  for (const [key, value] of Object.entries(map)) {
    if (!(key in CHAT_TOOL_ALIASES)) result[key] = value;
  }
  // Pass 2: legacy-alias keys map to their canonical name; an existing
  // canonical entry from pass 1 wins (the legacy entry is dropped).
  for (const [key, value] of Object.entries(map)) {
    const canonical = CHAT_TOOL_ALIASES[key];
    if (canonical === undefined) continue;
    changed = true;
    if (Object.prototype.hasOwnProperty.call(result, canonical)) continue;
    result[canonical] = value;
  }
  return { map: result, changed };
};

export const resolveGeneratedAutonomy = (
  governanceChatTools: Record<string, ToolAutonomy> | undefined,
  profileOverrides: Record<string, ToolAutonomy> | undefined
): Record<string, ToolAutonomy> => {
  const autonomy: Record<string, ToolAutonomy> = {};
  for (const tool of GENERATED_CHAT_TOOLS) {
    const resolved =
      resolveFromMap(profileOverrides, tool.name) ??
      resolveFromMap(governanceChatTools, tool.name) ??
      defaultAutonomyForGenerated(tool);
    autonomy[tool.name] = tool.autonomyFloor === 'ask' && resolved === 'auto' ? 'ask' : resolved;
  }
  return autonomy;
};
