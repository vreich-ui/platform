/**
 * T9.13 — the chat tool registry (plan §4): a curated wrapper over the verb
 * surface, executed server-side via `handleObjectVerb` under the signed-in
 * HUMAN's Principal. No new write paths — every mutation rides the same core
 * as forms, canvas chips, and MCP.
 *
 * Classes and default autonomy (§4 table; adjustable via governance
 * `chat_tools` + per-profile overrides, resolved at run start):
 *   read        auto   get_object, get_contract, list_objects, inventory,
 *                      validate, search_artifacts
 *   draft       ask    checkout, patch, checkin, refresh_lock
 *   creation    ask    create_object, create_variant, instantiate_template,
 *                      instantiate_section_template (dry-run first — the
 *                      preview rides the approval card)
 *   publication ask    submit_review, publish, discard
 *   privileged  ask    apply_theme (dry-run first + Owner-only at EXECUTION —
 *                      the role gate is independent of autonomy, so even a
 *                      misconfigured 'auto' cannot bypass it)
 *
 * Args are zod-validated BEFORE any pause: garbage never reaches an approval
 * card. `patch` additionally constrains each op's name to the target type's
 * agent-authored contract ops (the engine still re-validates the full
 * grammar). Tool descriptions encode the conversion-playbook trap table —
 * deep-merge patch semantics, explicit key-nulling on variant switches,
 * checkout-before-patch, version threading.
 */
import { getSiteIdentity } from '../../../lib/site-identity.js';
import { z } from 'zod';

import type { Role } from '../roles.js';
import { objectTypeSchema, type ObjectType } from '../../../schema/object-record-v1.js';

/** W18 T18.6a: `membership` tools are `ask`-class by construction (autonomyFloor 'ask'; definitions in T18.6b). */
export type ToolClass = 'read' | 'draft' | 'creation' | 'publication' | 'privileged' | 'membership';
export type ToolAutonomy = 'auto' | 'ask' | 'off';

export interface ToolResult {
  content: string;
  is_error: boolean;
}

/** The execution surface the background function wires up (verb calls carry
 *  the same store validation context as admin-object — enforced there). */
export interface ToolContext {
  verb(request: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  contract(objectType: ObjectType): Record<string, unknown>;
  /** Synthetic create preview: mint-a-candidate-id + validate, persist nothing. */
  validateNewObject(objectType: ObjectType, body: unknown, requestedId?: string): Promise<Record<string, unknown>>;
  listArtifacts(requestId: string): Promise<Record<string, unknown>>;
  /** Agent-authored patch op names for a type (from the contract). */
  agentAuthoredOps(objectType: ObjectType): Set<string>;
  roles: readonly Role[];
  /**
   * PF4: the CMS-Agent bridge for the workspace orchestration tools. Absent
   * when the site has no bridge configured — those tools then answer with a
   * clear error instead of crashing. `callTool` is the PF1 client's; the
   * scoped site token must allowlist the specific workspace/workflow tools.
   */
  cmsAgent?: {
    callTool<T = unknown>(
      name: string,
      args: Record<string, unknown>
    ): Promise<{ ok: true; data: T } | { ok: false; code: string; message: string }>;
    projectId: string;
  };
  /**
   * T9.13/PF5: the generated chat tools' bridge to the "operational" MCP
   * tools (artifact reads/search, marginalia_*, registry_get, deploy_status,
   * the pdf-tool/image families, commerce, ping/health, ...) — everything
   * that isn't an object_* verb, object_contract, or list_artifacts_for_request
   * (see agent/generated-tools.ts). Absent when the chat session has no
   * operational bridge configured; those tools then answer with a clear
   * error instead of crashing. Purely additive to this interface — every
   * existing CHAT_TOOLS tool ignores it.
   */
  operational?: {
    call(name: string, args: Record<string, unknown>): Promise<{ content: string; is_error: boolean }>;
  };
  /**
   * W18 T18.6a: the membership core, reached with the run's captured HUMAN
   * principal (`via:'chat'`). Absent when the hop has no membership store
   * wired; a run without a captured human gets `403 membership_requires_human`
   * from the core itself. Definitions land in T18.6b.
   */
  membership?: {
    call(verb: string, args: Record<string, unknown>): Promise<{ status: number; body: Record<string, unknown> }>;
  };
  /**
   * W19 T19.1: the editorial-request registry, reached by the tools that
   * START a job. `register` is deliberately failure-swallowing (see
   * context.ts): losing the RECORD of a job is bad, failing to START the job
   * because the record could not be written is worse. Absent when the hop has
   * no request store wired — the tools then simply do not register.
   */
  requests?: {
    register(input: {
      request_id: string;
      kind: 'article' | 'page' | 'section' | 'theme' | 'media' | 'capture' | 'other';
      title: string;
      brief_excerpt?: string;
      workflow?: { run_id: string; workflow_id: string; project_id: string; node_total?: number };
      object?: { object_type: string; object_id: string };
    }): Promise<void>;
  };
  /**
   * D2a (2026-08-17): the run's captured HUMAN principal — the approver a
   * chat-side publish pins into CMS-Agent's readiness `approval` block.
   * Absent for contexts without a human (a publish then refuses).
   */
  principal?: { id: string; email: string };
  /**
   * D2a: stored-idempotency seam (the same `withIdempotentToolCall` ledger the
   * MCP switch uses) for chat verbs whose downstream call is not itself
   * idempotent (`publish_workspace_run`). Absent → the call runs unguarded.
   */
  idempotent?<T extends Record<string, unknown>>(toolName: string, key: string, run: () => Promise<T>): Promise<T>;
}

export interface ChatTool {
  name: string;
  toolClass: ToolClass;
  description: string;
  input_schema: Record<string, unknown>;
  /**
   * PF4 hard floor (P3.1's rule): when set to 'ask', neither a governance
   * chat_tools override nor a profile override can resolve this tool to
   * 'auto' — resolveAutonomy clamps it. 'off' remains available.
   */
  autonomyFloor?: 'ask';
  /**
   * PF4: attach this tool's (bounded) result content to its tool_result
   * EVENT so the UI can render it in a collapsed disclosure. Only for tools
   * whose output is already a bounded, editor-safe projection.
   */
  discloseResult?: boolean;
  /** Server-side validation; runs before auto-execution AND before any pause. */
  parse(args: Record<string, unknown>, ctx: ToolContext): { ok: true; value: unknown } | { ok: false; error: string };
  execute(ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult>;
  /** Present on creation/privileged tools: the preview attached to the approval card. */
  dryRun?(ctx: ToolContext, args: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** One-line human phrase for cards/feeds ("Patch page_home: 2 ops"). */
  describe(args: Record<string, unknown>): string;
}

const json = (body: unknown) => JSON.stringify(body);
const verbResult = async (ctx: ToolContext, request: Record<string, unknown>): Promise<ToolResult> => {
  const result = await ctx.verb(request);
  return { content: json(result.body), is_error: result.status !== 200 };
};

const zodParse =
  <T>(schema: z.ZodType<T>) =>
  (args: Record<string, unknown>): { ok: true; value: T } | { ok: false; error: string } => {
    const parsed = schema.safeParse(args);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : {
          ok: false,
          error: `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
        };
  };

// Shared arg fragments.
const objectRef = { object_type: objectTypeSchema, object_id: z.string().min(1) };
const objectRefJson = {
  object_type: { type: 'string', description: 'One of the ten governed object types.' },
  object_id: { type: 'string' },
};

// ─── read tools ────────────────────────────────────────────────────────────────

const getObject: ChatTool = {
  name: 'get_object',
  toolClass: 'read',
  description:
    'Read a governed object record (body, history, lock, publication state). Use before proposing any change.',
  input_schema: {
    type: 'object',
    properties: objectRefJson,
    required: ['object_type', 'object_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object(objectRef)),
  execute: (ctx, args) => verbResult(ctx, { action: 'get', ...args }),
  describe: (args) => `Read ${args.object_type} ${args.object_id}`,
};

const getContract: ChatTool = {
  name: 'get_contract',
  toolClass: 'read',
  description:
    'The authoritative contract for an object type: body schema, permitted patch ops with arg schemas, constraints, publish/creation policy, recipe usage hints. Read it before your first write to a type.',
  input_schema: {
    type: 'object',
    properties: { object_type: objectRefJson.object_type },
    required: ['object_type'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ object_type: objectTypeSchema })),
  execute: async (ctx, args) => ({
    content: json(ctx.contract(args.object_type as ObjectType)),
    is_error: false,
  }),
  describe: (args) => `Read the ${args.object_type} contract`,
};

const listObjects: ChatTool = {
  name: 'list_objects',
  toolClass: 'read',
  description: 'List objects of a type (id, status, version, published_time).',
  input_schema: {
    type: 'object',
    properties: {
      object_type: objectRefJson.object_type,
      status: { type: 'string', enum: ['active', 'archived'] },
    },
    required: ['object_type'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ object_type: objectTypeSchema, status: z.enum(['active', 'archived']).optional() })),
  execute: (ctx, args) => verbResult(ctx, { action: 'list', ...args }),
  describe: (args) => `List ${args.object_type} objects`,
};

const inventory: ChatTool = {
  name: 'inventory',
  toolClass: 'read',
  description:
    'The live catalog: per object — tier, lock state, review state, unpublished changes, recipe summaries (REUSE FIRST: check for an existing recipe before creating anything).',
  input_schema: {
    type: 'object',
    properties: {
      object_type: objectRefJson.object_type,
      object_id: { type: 'string' },
      status: { type: 'string', enum: ['active', 'archived'] },
      review_state: { type: 'string', enum: ['none', 'open', 'changes_requested', 'approved'] },
      pending_changes: { type: 'boolean' },
    },
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      object_type: objectTypeSchema.optional(),
      object_id: z.string().min(1).optional(),
      status: z.enum(['active', 'archived']).optional(),
      review_state: z.enum(['none', 'open', 'changes_requested', 'approved']).optional(),
      pending_changes: z.boolean().optional(),
    })
  ),
  execute: (ctx, args) => verbResult(ctx, { action: 'inventory', ...args }),
  describe: () => 'Browse the object inventory',
};

const validate: ChatTool = {
  name: 'validate',
  toolClass: 'read',
  description:
    'Validate an object as it stands, or preview a candidate patch (candidate_patch) without persisting. Run before publish; blockers explain themselves.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, candidate_patch: { type: 'array', items: { type: 'object' } } },
    required: ['object_type', 'object_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ ...objectRef, candidate_patch: z.array(z.unknown()).optional() })),
  execute: (ctx, args) => verbResult(ctx, { action: 'validate', ...args }),
  describe: (args) => `Validate ${args.object_type} ${args.object_id}`,
};

const searchArtifacts: ChatTool = {
  name: 'search_artifacts',
  toolClass: 'read',
  description:
    'List the artifact references (images/PDFs with public paths) indexed for a request id — how you find media to reference from content.',
  input_schema: {
    type: 'object',
    properties: { request_id: { type: 'string' } },
    required: ['request_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ request_id: z.string().min(1) })),
  execute: async (ctx, args) => ({
    content: json(await ctx.listArtifacts(args.request_id as string)),
    is_error: false,
  }),
  describe: (args) => `List artifacts for ${args.request_id}`,
};

// ─── draft-write tools ─────────────────────────────────────────────────────────────

const checkout: ChatTool = {
  name: 'checkout',
  toolClass: 'draft',
  description:
    'Take the edit lock on an object. Returns lockToken + record_version — thread BOTH into every patch. One lock per object; check in when done.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, lease_seconds: { type: 'integer', minimum: 1 } },
    required: ['object_type', 'object_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ ...objectRef, lease_seconds: z.number().int().positive().optional() })),
  execute: (ctx, args) => verbResult(ctx, { action: 'checkout', ...args }),
  describe: (args) => `Check out ${args.object_type} ${args.object_id} for editing`,
};

const patchArgsSchema = z.object({
  ...objectRef,
  lock_token: z.string().min(1),
  expected_record_version: z.number().int().nonnegative(),
  ops: z.array(z.record(z.string(), z.unknown())).min(1),
});
const patch: ChatTool = {
  name: 'patch',
  toolClass: 'draft',
  description:
    "Apply contract patch ops under YOUR checkout. TRAPS: `fields` DEEP-MERGES — set a key to null to remove it; switching a section variant requires nulling the old variant's keys explicitly. expected_record_version comes from checkout (and bumps on every write — re-read on 409). Ops must be ops the type's contract permits (get_contract).",
  input_schema: {
    type: 'object',
    properties: {
      ...objectRefJson,
      lock_token: { type: 'string' },
      expected_record_version: { type: 'integer' },
      ops: { type: 'array', items: { type: 'object' }, minItems: 1 },
    },
    required: ['object_type', 'object_id', 'lock_token', 'expected_record_version', 'ops'],
    additionalProperties: false,
  },
  parse: (args, ctx) => {
    const parsed = patchArgsSchema.safeParse(args);
    if (!parsed.success) {
      return { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
    }
    // Contract constraint: each op's name must be agent-authored for this type.
    const allowed = ctx.agentAuthoredOps(parsed.data.object_type);
    for (const op of parsed.data.ops) {
      const opName = typeof op.op === 'string' ? op.op : undefined;
      if (!opName || !allowed.has(opName)) {
        return {
          ok: false,
          error:
            `Op "${opName ?? '(missing op name)'}" is not a permitted agent-authored op for ${parsed.data.object_type}. ` +
            `Permitted: ${[...allowed].join(', ')}.`,
        };
      }
    }
    return { ok: true, value: parsed.data };
  },
  execute: (ctx, args) => verbResult(ctx, { action: 'patch', ...args }),
  describe: (args) =>
    `Patch ${args.object_type} ${args.object_id}: ${Array.isArray(args.ops) ? args.ops.length : '?'} op(s)`,
};

const checkin: ChatTool = {
  name: 'checkin',
  toolClass: 'draft',
  description: 'Release your edit lock when the editing pass is done.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, lock_token: { type: 'string' } },
    required: ['object_type', 'object_id', 'lock_token'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ ...objectRef, lock_token: z.string().min(1) })),
  execute: (ctx, args) => verbResult(ctx, { action: 'checkin', ...args }),
  describe: (args) => `Check in ${args.object_type} ${args.object_id}`,
};

const refreshLock: ChatTool = {
  name: 'refresh_lock',
  toolClass: 'draft',
  description: 'Extend your lock lease during a long editing pass.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, lock_token: { type: 'string' }, lease_seconds: { type: 'integer', minimum: 1 } },
    required: ['object_type', 'object_id', 'lock_token'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({ ...objectRef, lock_token: z.string().min(1), lease_seconds: z.number().int().positive().optional() })
  ),
  execute: (ctx, args) => verbResult(ctx, { action: 'refresh_lock', ...args }),
  describe: (args) => `Refresh the lock on ${args.object_type} ${args.object_id}`,
};

// ─── creation tools (dry-run first) ──────────────────────────────────────────────────

const createArgs = z.object({
  object_type: objectTypeSchema,
  site: z.string().min(1),
  body: z.unknown(),
  requested_id: z.string().min(1).optional(),
});
const createObject: ChatTool = {
  name: 'create_object',
  toolClass: 'creation',
  description:
    'Create a new governed object. REUSE FIRST: check inventory for an existing object or recipe before minting. The approval card shows a validation preview; invalid bodies are rejected without persisting.',
  input_schema: {
    type: 'object',
    properties: {
      object_type: objectRefJson.object_type,
      site: { type: 'string', description: `Site id, e.g. ${getSiteIdentity().siteId}.` },
      body: { type: 'object' },
      requested_id: { type: 'string' },
    },
    required: ['object_type', 'site', 'body'],
    additionalProperties: false,
  },
  parse: zodParse(createArgs),
  execute: (ctx, args) => verbResult(ctx, { action: 'create', ...args }),
  dryRun: (ctx, args) =>
    ctx.validateNewObject(args.object_type as ObjectType, args.body, args.requested_id as string | undefined),
  describe: (args) => `Create a new ${args.object_type}`,
};

const createVariant: ChatTool = {
  name: 'create_variant',
  toolClass: 'creation',
  description:
    'Clone an article (content_item) as a draft variant with lineage. Variants may not share the source slug.',
  input_schema: {
    type: 'object',
    properties: {
      source_object_id: { type: 'string' },
      slug: { type: 'string' },
      requested_id: { type: 'string' },
    },
    required: ['source_object_id'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      source_object_id: z.string().min(1),
      slug: z.string().min(1).optional(),
      requested_id: z.string().min(1).optional(),
    })
  ),
  execute: (ctx, args) => verbResult(ctx, { action: 'create_variant', object_type: 'content_item', ...args }),
  dryRun: async (ctx, args) =>
    (await ctx.verb({ action: 'create_variant', object_type: 'content_item', ...args, dry_run: true })).body,
  describe: (args) => `Create a variant of ${args.source_object_id}`,
};

const instantiateTemplate: ChatTool = {
  name: 'instantiate_template',
  toolClass: 'creation',
  description:
    'Create a PAGE from a template recipe (tpl_*). REUSE FIRST — inventory lists recipes with description/whenToUse/scope. The approval card shows the dry-run body + validation.',
  input_schema: {
    type: 'object',
    properties: {
      template_id: { type: 'string' },
      site: { type: 'string' },
      route: { type: 'string' },
      title: { type: 'string' },
      page_type: { type: 'string' },
      requested_id: { type: 'string' },
    },
    required: ['template_id', 'site', 'route', 'title'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      template_id: z.string().min(1),
      site: z.string().min(1),
      route: z.string().min(1),
      title: z.string().min(1),
      page_type: z.string().min(1).optional(),
      requested_id: z.string().min(1).optional(),
    })
  ),
  execute: (ctx, args) => verbResult(ctx, { action: 'instantiate', ...args }),
  dryRun: async (ctx, args) => (await ctx.verb({ action: 'instantiate', ...args, dry_run: true })).body,
  describe: (args) => `Create a page at ${args.route} from ${args.template_id}`,
};

const instantiateSectionTarget = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('page'),
    page_id: z.string().min(1),
    position: z.number().int().nonnegative().optional(),
    lock_token: z.string().min(1).optional(),
    expected_record_version: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('standalone'), requested_id: z.string().min(1).optional() }),
]);
const instantiateSectionTemplate: ChatTool = {
  name: 'instantiate_section_template',
  toolClass: 'creation',
  description:
    'Stamp a section from a recipe (stpl_*): into a page you hold the checkout for (target.kind=page, lock_token + expected_record_version required on execute), or as a standalone shared sec_* object.',
  input_schema: {
    type: 'object',
    properties: {
      section_template_id: { type: 'string' },
      target: {
        type: 'object',
        description:
          '{kind:"page", page_id, position?, lock_token?, expected_record_version?} or {kind:"standalone", requested_id?}',
      },
    },
    required: ['section_template_id', 'target'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ section_template_id: z.string().min(1), target: instantiateSectionTarget })),
  execute: (ctx, args) => verbResult(ctx, { action: 'instantiate_section', ...args }),
  dryRun: async (ctx, args) => (await ctx.verb({ action: 'instantiate_section', ...args, dry_run: true })).body,
  describe: (args) => {
    const target = args.target as { kind?: string; page_id?: string } | undefined;
    return target?.kind === 'page'
      ? `Stamp ${args.section_template_id} into ${target.page_id}`
      : `Mint a shared section from ${args.section_template_id}`;
  },
};

// ─── publication tools ─────────────────────────────────────────────────────────────

const submitReview: ChatTool = {
  name: 'submit_review',
  toolClass: 'publication',
  description: 'Open review on your drafted changes (approval-gated types), under your checkout.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, lock_token: { type: 'string' }, note: { type: 'string' } },
    required: ['object_type', 'object_id', 'lock_token'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ ...objectRef, lock_token: z.string().min(1), note: z.string().optional() })),
  execute: (ctx, args) => verbResult(ctx, { action: 'submit_review', ...args }),
  describe: (args) => `Submit ${args.object_type} ${args.object_id} for review`,
};

const publish: ChatTool = {
  name: 'publish',
  toolClass: 'publication',
  description:
    'Publish an object (export commit; the deploy stays deferred — release is a separate human step). published_time omitted = now; an explicit ISO timestamp backdates/forward-stamps. Unpublish is not supported.',
  input_schema: {
    type: 'object',
    properties: { ...objectRefJson, lock_token: { type: 'string' }, published_time: { type: 'string' } },
    required: ['object_type', 'object_id', 'lock_token'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ ...objectRef, lock_token: z.string().min(1), published_time: z.string().optional() })),
  execute: (ctx, args) => verbResult(ctx, { action: 'publish_by_time', ...args }),
  describe: (args) => `Publish ${args.object_type} ${args.object_id}`,
};

const discard: ChatTool = {
  name: 'discard',
  toolClass: 'publication',
  description:
    'Revert drafted-but-unpublished changes by replaying history inverses. entries = the exact {op, capture} pairs from the history entries being rejected (newest first).',
  input_schema: {
    type: 'object',
    properties: {
      ...objectRefJson,
      lock_token: { type: 'string' },
      entries: { type: 'array', items: { type: 'object' }, minItems: 1 },
    },
    required: ['object_type', 'object_id', 'lock_token', 'entries'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      ...objectRef,
      lock_token: z.string().min(1),
      entries: z.array(z.object({ op: z.unknown(), capture: z.unknown() })).min(1),
    })
  ),
  execute: (ctx, args) => verbResult(ctx, { action: 'discard', ...args }),
  describe: (args) => `Discard drafted changes on ${args.object_type} ${args.object_id}`,
};

// ─── privileged ──────────────────────────────────────────────────────────────────

const applyTheme: ChatTool = {
  name: 'apply_theme',
  toolClass: 'privileged',
  description:
    "OWNER-ONLY. Apply a theme's tokens to the site singleton (exact-replace; stale keys unset) under YOUR site checkout. The palette changes ONLY through this verb. Publish/release stay separate deliberate steps.",
  input_schema: {
    type: 'object',
    properties: {
      theme_id: { type: 'string' },
      site_id: { type: 'string' },
      lock_token: { type: 'string' },
      expected_record_version: { type: 'integer' },
    },
    required: ['theme_id', 'site_id', 'lock_token', 'expected_record_version'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      theme_id: z.string().min(1),
      site_id: z.string().min(1),
      lock_token: z.string().min(1),
      expected_record_version: z.number().int().nonnegative(),
    })
  ),
  execute: async (ctx, args) => {
    // The role wall is here, at execution — independent of autonomy config.
    if (!ctx.roles.includes('owner')) {
      return { content: json({ error: 'apply_theme requires the Owner role.' }), is_error: true };
    }
    return verbResult(ctx, { action: 'apply_theme', ...args });
  },
  dryRun: async (ctx, args) =>
    (
      await ctx.verb({
        action: 'apply_theme',
        theme_id: args.theme_id,
        site_id: args.site_id,
        dry_run: true,
      })
    ).body,
  describe: (args) => `Apply theme ${args.theme_id} to ${args.site_id}`,
};

// ─── PF4: workspace orchestration (CMS-Agent bridge; P3.1's surviving half) ──

const CMS_AGENT_UNAVAILABLE = {
  content: json({ error: 'The workspace orchestration bridge is not configured for this site.' }),
  is_error: true,
};

const truncate = (value: unknown, max: number): string => {
  const text = typeof value === 'string' ? value : '';
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/** Bounded, editor-safe node projection: NEVER prompts, schemas or model config. */
const projectWorkspaceNode = (node: Record<string, unknown>): Record<string, unknown> => ({
  id: node.id,
  name: node.name,
  kind: node.kind,
  risk_level: node.riskLevel,
  status: node.status,
  description: truncate(node.description, 240),
  ...(Array.isArray(node.dependsOn) && node.dependsOn.length > 0 ? { depends_on: node.dependsOn } : {}),
});

/** Bounded run projection — the full run record can approach ~500KB; this
 *  keeps status, per-node states and driver notes and nothing else. The
 *  `mode` block is reduced to a live/mock boolean: its raw form names the
 *  provider (executionMode: 'openai'), which editor-facing output must
 *  never carry. `stall` reduces to a boolean for the same reason. */
const projectWorkspaceRun = (run: Record<string, unknown>): Record<string, unknown> => {
  const nodes = Array.isArray(run.nodes)
    ? (run.nodes as Record<string, unknown>[]).slice(0, 64).map((node) => ({
        id: node.nodeId ?? node.id,
        status: node.status,
      }))
    : undefined;
  // `mode` is nullable on the wire, not merely absent: a compact run view omits it
  // and some records carry an explicit null. `!== undefined` admits null and then
  // dereferences it, so this reads truthiness instead.
  const mode = run.mode as { live?: boolean; executionMode?: string } | null | undefined;
  const stall = run.stall as { stalled?: boolean } | boolean | undefined;
  return {
    run_id: run.runId ?? run.id,
    status: run.status,
    ...(mode ? { live_output: mode.live === true || mode.executionMode === 'openai' } : {}),
    ...(stall !== undefined
      ? { stalled: stall === true || (typeof stall === 'object' && stall?.stalled === true) }
      : {}),
    ...(typeof run.driverNote === 'string' ? { driver_note: truncate(run.driverNote, 500) } : {}),
    ...(nodes ? { nodes } : {}),
  };
};

const listWorkspaceNodes: ChatTool = {
  name: 'list_workspace_nodes',
  toolClass: 'read',
  discloseResult: true,
  description:
    'List the publishing workspace nodes (id, kind, risk level, short description, dependencies). Use before starting or discussing a workspace workflow run.',
  input_schema: { type: 'object', properties: {}, additionalProperties: false },
  parse: zodParse(z.object({})),
  execute: async (ctx) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    const result = await ctx.cmsAgent.callTool<{ nodes?: Record<string, unknown>[] }>('workspace_get_nodes', {});
    if (!result.ok) return { content: json({ error: result.message, code: result.code }), is_error: true };
    const all = result.data.nodes ?? [];
    // Bounded even against a pathological workspace: this projection rides a
    // PERSISTED tool_result event (discloseResult), and the event-log trim is
    // count-based, not byte-based.
    const nodes = all.slice(0, 100).map(projectWorkspaceNode);
    return {
      content: json({ nodes, ...(all.length > nodes.length ? { truncated: all.length - nodes.length } : {}) }),
      is_error: false,
    };
  },
  describe: () => 'List workspace nodes',
};

const runWorkspaceWorkflow: ChatTool = {
  name: 'run_workspace_workflow',
  toolClass: 'privileged',
  autonomyFloor: 'ask',
  discloseResult: true,
  description:
    'THE way a new ARTICLE is written (ART-1). Start a workspace publishing workflow run — this is what researches, drafts and annotates a content_item, and what produces the sourcing, claim, compliance and score record an article needs before it can publish, plus the aggression-ceiling clamp that exists nowhere else. Use this whenever an editor asks for a new article, post or piece of content; object_create is refused for content_item in chat. Pass the editor’s brief VERBATIM as input.instructions (never summarised), set trafficSource and awarenessStage, and carry any media requirement into input.mediaRequest. Also advances an existing run by run_id. Long executions never block the chat — poll with get_workspace_run, then check_workspace_run_readiness → publish_workspace_run → release_workspace_run. Publishing itself always remains a separate human decision on the workspace surface.',
  input_schema: {
    type: 'object',
    properties: {
      input: { type: 'object', description: 'The publishing request envelope to start a new run with.' },
      run_id: { type: 'string', description: 'Advance THIS existing run instead of starting a new one.' },
      workflow_id: { type: 'string' },
      budget_usd: { type: 'number', minimum: 0, description: 'Optional per-run cost ceiling.' },
      execution_mode: {
        type: 'string',
        enum: ['mock', 'openai'],
        description: 'mock = cheap structural placeholders; openai (default) = real model output.',
      },
      request_id: {
        type: 'string',
        description:
          'Reuse THIS request id (req_<flow>_<topic>_<yyyymmdd>_<nn>). Omit to have one minted from slug/title.',
      },
      slug: {
        type: 'string',
        description: 'Topic slug used to mint the request id (defaults to a slugified input.title / input.topic).',
      },
    },
    additionalProperties: false,
  },
  parse: (args) => {
    const parsed = z
      .object({
        input: z.record(z.string(), z.unknown()).optional(),
        run_id: z.string().min(1).optional(),
        workflow_id: z.string().min(1).optional(),
        budget_usd: z.number().nonnegative().optional(),
        execution_mode: z.enum(['mock', 'openai']).optional(),
        request_id: z
          .string()
          .regex(REQUEST_ID_RE, 'request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn>')
          .optional(),
        slug: z.string().min(1).optional(),
      })
      .refine((value) => Boolean(value.run_id) !== Boolean(value.input), {
        message: 'Provide exactly one of: input (start a new run) or run_id (advance an existing run).',
      })
      .safeParse(args);
    return parsed.success
      ? { ok: true, value: parsed.data }
      : { ok: false, error: `Invalid arguments: ${parsed.error.issues.map((issue) => issue.message).join('; ')}` };
  },
  execute: async (ctx, args) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    if (args.run_id) {
      // Advance only — `approved` is NEVER sent: CMS-Agent's own gate keeps
      // stopping the run before publish-risk nodes (the second wall).
      const advanced = await ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_run_all', {
        runId: args.run_id,
        budgetMs: WORKSPACE_RUN_BUDGET_MS,
      });
      if (!advanced.ok) return { content: json({ error: advanced.message, code: advanced.code }), is_error: true };
      return { content: json(projectWorkspaceRun(advanced.data)), is_error: false };
    }
    // D2a: CMS-Agent's workflow_start_dry_run REQUIRES a caller request id
    // for openai runs — mint one here (req_agent_<slug>_<yyyymmdd>_<nn>,
    // bumping nn past any existing content_item) unless the caller passed one.
    const requestId = (args.request_id as string | undefined) ?? (await mintWorkspaceRequestId(ctx, args));
    const started = await ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_start_dry_run', {
      projectId: ctx.cmsAgent.projectId,
      input: args.input,
      requestId,
      ...(args.workflow_id ? { workflowId: args.workflow_id } : {}),
      ...(args.budget_usd !== undefined ? { budgetUsd: args.budget_usd } : {}),
      ...(args.execution_mode ? { executionMode: args.execution_mode } : {}),
    });
    if (!started.ok) return { content: json({ error: started.message, code: started.code }), is_error: true };
    // W19 T19.1: register the job the instant it starts, so the record exists
    // even if this chat turn ends on caps two minutes from now. Deliberately
    // scoped to THIS tool in the T19.1–T19.4 delivery: it is the only chat
    // tool that starts work an editor then waits on. Plan D7's non-workflow
    // creators (template instantiation, retheme, media jobs) complete inline
    // and have no `req_…` id of their own yet; they register when their id
    // minting is designed, alongside the T19.10 backfill.
    const startedRun = projectWorkspaceRun(started.data);
    const briefInput = (args.input ?? {}) as Record<string, unknown>;
    // A run id we did not actually get back is NOT a workflow block: a record
    // carrying `run_id: ''` would derive `queued` for ever and be polled for
    // ever. Register the request without one and let the poll say so.
    const startedRunId = typeof startedRun.run_id === 'string' ? startedRun.run_id : '';
    await ctx.requests?.register({
      request_id: requestId,
      kind: 'article',
      title: requestTitleFrom(briefInput, requestId),
      ...(typeof briefInput.instructions === 'string' ? { brief_excerpt: briefInput.instructions.slice(0, 240) } : {}),
      ...(startedRunId
        ? {
            workflow: {
              run_id: startedRunId,
              workflow_id: (args.workflow_id as string | undefined) ?? 'publishing_conductor',
              project_id: ctx.cmsAgent.projectId,
              ...(Array.isArray(startedRun.nodes) ? { node_total: startedRun.nodes.length } : {}),
            },
          }
        : {}),
    });
    return {
      content: json({
        ...startedRun,
        request_id: requestId,
        ...(started.data.continued !== undefined ? { continued: started.data.continued === true } : {}),
      }),
      is_error: false,
    };
  },
  // The approval-card preview is an INPUT ECHO by design — no server call, so
  // the human approves exactly the bytes that will be sent.
  dryRun: async (_ctx, args) => ({
    dry_run: true,
    action: args.run_id ? 'advance_existing_run' : 'start_dry_run_workflow',
    ...(args.run_id ? { run_id: args.run_id } : {}),
    ...(args.input !== undefined ? { input_echo: args.input } : {}),
    ...(args.workflow_id ? { workflow_id: args.workflow_id } : {}),
    ...(args.budget_usd !== undefined ? { budget_usd: args.budget_usd } : {}),
    ...(args.request_id ? { request_id: args.request_id } : {}),
    ...(args.slug ? { slug: args.slug } : {}),
    execution_mode: args.execution_mode ?? 'openai',
    note: 'A dry-run workflow has no publishing side effects; publishing remains a separate human decision (publish_workspace_run, ask-gated).',
  }),
  describe: (args) =>
    args.run_id ? `Advance workspace run ${args.run_id}` : 'Start a workspace publishing workflow (dry-run)',
};

const getWorkspaceRun: ChatTool = {
  name: 'get_workspace_run',
  toolClass: 'read',
  discloseResult: true,
  description:
    'Poll a workspace workflow run: status, per-node states, driver notes. Bounded summary — use the workspace surface for full details.',
  input_schema: {
    type: 'object',
    properties: { run_id: { type: 'string' } },
    required: ['run_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ run_id: z.string().min(1) })),
  execute: async (ctx, args) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    const result = await ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_get_run', { runId: args.run_id });
    if (!result.ok) return { content: json({ error: result.message, code: result.code }), is_error: true };
    return { content: json(projectWorkspaceRun(result.data)), is_error: false };
  },
  describe: (args) => `Check workspace run ${args.run_id}`,
};

// ─── D2a (2026-08-17): request ids + publish/release verbs from chat ─────────

/** CMS-Agent's bound for a caller-supplied request id (openai runs REQUIRE one). */
export const REQUEST_ID_RE = /^req_[a-z0-9_]+_\d{8}_\d{2}$/;
/** Per-call execution budget handed to workflow_start_dry_run (the run continues in the background; poll get_workspace_run). */
export const WORKSPACE_RUN_BUDGET_MS = 45_000;

const slugifyForRequestId = (value: unknown): string =>
  String(value ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_')
    .slice(0, 48);

/** The editor-facing title for a registered request: the brief's own words where it has them. */
export const requestTitleFrom = (input: Record<string, unknown>, fallback: string): string => {
  for (const key of ['title', 'topic', 'slug']) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 200);
  }
  const instructions = input.instructions;
  if (typeof instructions === 'string' && instructions.trim()) return instructions.trim().slice(0, 80);
  return fallback;
};

const yyyymmdd = (date = new Date()): string =>
  `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(date.getUTCDate()).padStart(2, '0')}`;

/**
 * Mint `req_agent_<slug>_<yyyymmdd>_<nn>`: slug from args.slug, else a
 * slugified input.title / input.topic; nn starts at 01 and bumps while a
 * content_item with that id already exists (object get ≠ 404).
 */
export const mintWorkspaceRequestId = async (
  ctx: ToolContext,
  args: Record<string, unknown>,
  now: Date = new Date()
): Promise<string> => {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const slug = slugifyForRequestId(args.slug ?? input.slug ?? input.title ?? input.topic) || 'article';
  const day = yyyymmdd(now);
  for (let nn = 1; nn <= 99; nn += 1) {
    const candidate = `req_agent_${slug}_${day}_${String(nn).padStart(2, '0')}`;
    const existing = await ctx.verb({ action: 'get', object_type: 'content_item', object_id: candidate });
    if (existing.status === 404) return candidate;
  }
  throw new Error(`Could not mint a free request id for slug "${slug}" today (01..99 all taken).`);
};

const readinessTagsSchema = z.array(z.string().min(1)).max(50).optional();

/** Both reference forms — the raw blobKey AND its public /img|/pdf path — so CMS-Agent's verifier matches either. */
const verifiedMediaRefsFor = async (ctx: ToolContext, requestId: string): Promise<string[]> => {
  const listed = await ctx.listArtifacts(requestId);
  const artifacts = Array.isArray(listed.artifacts) ? (listed.artifacts as Record<string, unknown>[]) : [];
  const refs = new Set<string>();
  for (const artifact of artifacts) {
    const blobKey = typeof artifact.blobKey === 'string' ? artifact.blobKey : undefined;
    const publicPath = typeof artifact.publicPath === 'string' ? artifact.publicPath : undefined;
    if (blobKey) {
      refs.add(blobKey);
      if (blobKey.startsWith('image/')) refs.add(`/img/${blobKey.slice('image/'.length)}`);
      else if (blobKey.startsWith('pdf/')) refs.add(`/pdf/${blobKey.slice('pdf/'.length)}`);
    }
    if (publicPath) refs.add(publicPath);
  }
  return [...refs];
};

type ReadinessInput = { runId: string; requestId?: string; tags?: string[] };

const readinessPayload = async (ctx: ToolContext, args: ReadinessInput) => ({
  releaseBehavior: 'publish_now' as const,
  taxonomy: { tags: args.tags ?? [] },
  verifiedMediaRefs: args.requestId ? await verifiedMediaRefsFor(ctx, args.requestId) : [],
});

const callReadiness = async (
  ctx: ToolContext,
  args: ReadinessInput
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; code: string; message: string }> => {
  if (!ctx.cmsAgent)
    return {
      ok: false,
      code: 'cms_agent_unavailable',
      message: 'The workspace orchestration bridge is not configured for this site.',
    };
  return ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_publish_readiness', {
    projectId: ctx.cmsAgent.projectId,
    runId: args.runId,
    readiness: await readinessPayload(ctx, args),
  });
};

/** Bounded, editor-safe readiness projection: status + checklist + blockers verbatim (they are already editor copy). */
const projectReadiness = (data: Record<string, unknown>): Record<string, unknown> => ({
  status: data.status,
  ...(Array.isArray(data.checklist) ? { checklist: (data.checklist as unknown[]).slice(0, 64) } : {}),
  ...(Array.isArray(data.blockers) ? { blockers: (data.blockers as unknown[]).slice(0, 64) } : {}),
  ...(data.requestId !== undefined ? { request_id: data.requestId } : {}),
});

const checkWorkspaceRunReadiness: ChatTool = {
  name: 'check_workspace_run_readiness',
  toolClass: 'read',
  discloseResult: true,
  description:
    "Check whether a workspace run is ready to publish: CMS-Agent evaluates its publish checklist (approval omitted — that is pinned at publish time) against this site's verified media artifacts for the request id. Returns status (go / no_go), the checklist and any blockers verbatim. Run this before publish_workspace_run.",
  input_schema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      request_id: {
        type: 'string',
        description: 'The req_* id the run was started with (media refs are looked up by it).',
      },
      tags: { type: 'array', items: { type: 'string' }, description: 'Taxonomy tags the article will carry.' },
    },
    required: ['run_id'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      run_id: z.string().min(1),
      request_id: z
        .string()
        .regex(REQUEST_ID_RE, 'request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn>')
        .optional(),
      tags: readinessTagsSchema,
    })
  ),
  execute: async (ctx, args) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    const result = await callReadiness(ctx, {
      runId: args.run_id as string,
      requestId: args.request_id as string | undefined,
      tags: args.tags as string[] | undefined,
    });
    if (!result.ok) return { content: json({ error: result.message, code: result.code }), is_error: true };
    return { content: json(projectReadiness(result.data)), is_error: false };
  },
  describe: (args) => `Check publish readiness of workspace run ${args.run_id}`,
};

const publishWorkspaceRun: ChatTool = {
  name: 'publish_workspace_run',
  toolClass: 'privileged',
  autonomyFloor: 'ask',
  discloseResult: true,
  description:
    'Publish a workspace run through CMS-Agent (workflow_publish_run) with the human approval pinned to YOU. Refused outright unless the readiness check reports status "go" (the approval card shows the readiness result). CMS-Agent\'s own gates still apply. Idempotent per run.',
  input_schema: {
    type: 'object',
    properties: {
      run_id: { type: 'string' },
      request_id: { type: 'string', description: 'The req_* id the run was started with.' },
      tags: { type: 'array', items: { type: 'string' } },
    },
    required: ['run_id', 'request_id'],
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      run_id: z.string().min(1),
      request_id: z.string().regex(REQUEST_ID_RE, 'request_id must match req_<flow>_<topic>_<yyyymmdd>_<nn>'),
      tags: readinessTagsSchema,
    })
  ),
  execute: async (ctx, args) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    if (!ctx.principal) {
      return { content: json({ error: 'publish_workspace_run requires a signed-in human approver.' }), is_error: true };
    }
    const cmsAgent = ctx.cmsAgent;
    const input: ReadinessInput = {
      runId: args.run_id as string,
      requestId: args.request_id as string,
      tags: args.tags as string[] | undefined,
    };
    // Re-check readiness at execution: the card previewed it, but the world
    // may have moved — a no_go never reaches workflow_publish_run.
    const readiness = await callReadiness(ctx, input);
    if (!readiness.ok) return { content: json({ error: readiness.message, code: readiness.code }), is_error: true };
    if (readiness.data.status !== 'go') {
      return {
        content: json({
          error: 'Run is not ready to publish (readiness is not "go").',
          readiness: projectReadiness(readiness.data),
        }),
        is_error: true,
      };
    }
    const base = await readinessPayload(ctx, input);
    const payload = {
      runId: input.runId,
      projectId: cmsAgent.projectId,
      requestId: input.requestId,
      approved: true,
      live: true,
      readiness: {
        approval: {
          approvedBy: ctx.principal.email || ctx.principal.id,
          approvedAt: new Date().toISOString(),
          pinned: true,
        },
        releaseBehavior: base.releaseBehavior,
        taxonomy: base.taxonomy,
        verifiedMediaRefs: base.verifiedMediaRefs,
      },
    };
    const run = async () => {
      const published = await cmsAgent.callTool<Record<string, unknown>>('workflow_publish_run', payload);
      return published.ok
        ? { ok: true as const, data: published.data }
        : { ok: false as const, isError: true, code: published.code, message: published.message };
    };
    const result = ctx.idempotent
      ? await ctx.idempotent('publish_workspace_run', `publish:${input.runId}`, run)
      : await run();
    if (!result.ok) return { content: json({ error: result.message, code: result.code }), is_error: true };
    const data = result.data as Record<string, unknown>;
    return {
      content: json({
        run_id: input.runId,
        request_id: input.requestId,
        published: data.published ?? data.status ?? true,
        ...(data.commit !== undefined ? { commit: data.commit } : {}),
        ...(data.receipt !== undefined ? { receipt: data.receipt } : {}),
        ...(data.publishReceipt !== undefined ? { receipt: data.publishReceipt } : {}),
        ...(data.articlePath !== undefined ? { article_path: data.articlePath } : {}),
        approved_by: payload.readiness.approval.approvedBy,
      }),
      is_error: false,
    };
  },
  // The approval card carries the readiness result: status + failing checks.
  dryRun: async (ctx, args) => {
    const readiness = await callReadiness(ctx, {
      runId: args.run_id as string,
      requestId: args.request_id as string | undefined,
      tags: args.tags as string[] | undefined,
    });
    if (!readiness.ok)
      return {
        dry_run: true,
        action: 'publish_workspace_run',
        run_id: args.run_id,
        error: readiness.message,
        code: readiness.code,
      };
    const projected = projectReadiness(readiness.data);
    const checklist = Array.isArray(projected.checklist) ? (projected.checklist as Record<string, unknown>[]) : [];
    const failing = checklist.filter(
      (check) =>
        check && typeof check === 'object' && (check.ok === false || check.pass === false || check.status === 'fail')
    );
    return {
      dry_run: true,
      action: 'publish_workspace_run',
      run_id: args.run_id,
      request_id: args.request_id,
      readiness: projected,
      ...(failing.length > 0 ? { failing_checks: failing } : {}),
      approver: ctx.principal?.email ?? null,
      note:
        projected.status === 'go'
          ? 'Approving publishes this run live via CMS-Agent with your approval pinned (publish_now).'
          : 'Readiness is not "go" — the publish will be refused even if approved.',
    };
  },
  describe: (args) => `Publish workspace run ${args.run_id}`,
};

const releaseWorkspaceRun: ChatTool = {
  name: 'release_workspace_run',
  toolClass: 'privileged',
  autonomyFloor: 'ask',
  discloseResult: true,
  description:
    'OWNER-ONLY. Release published content to production (the ONE paid Netlify build for everything published so far), then read deploy_status once. Idempotent per commit/run. Publishing is free; releasing costs money — batch first.',
  input_schema: {
    type: 'object',
    properties: {
      commit: {
        type: 'string',
        description: 'Target commit (e.g. the publish receipt commit). Omitted = branch HEAD.',
      },
      publish_receipt_from_run: {
        type: 'string',
        description: 'The workspace run id whose publish this release ships (used for the idempotency key).',
      },
    },
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({ commit: z.string().min(1).optional(), publish_receipt_from_run: z.string().min(1).optional() })
  ),
  execute: async (ctx, args) => {
    if (!ctx.roles.includes('owner')) {
      return { content: json({ error: 'release_workspace_run requires the Owner role.' }), is_error: true };
    }
    if (!ctx.operational) {
      return { content: json({ error: 'The operational bridge is not configured for this site.' }), is_error: true };
    }
    const commit = args.commit as string | undefined;
    const runRef = args.publish_receipt_from_run as string | undefined;
    const idempotencyKey = `release:${runRef ?? commit ?? 'head'}`;
    const released = await ctx.operational.call('release_to_production', {
      ...(commit ? { commit } : {}),
      idempotency_key: idempotencyKey,
    });
    if (released.is_error) return released;
    const releaseBody = parseJson(released.content);
    const targetCommit = (releaseBody.targetCommit as string | undefined) ?? commit;
    const deploy = await ctx.operational.call('deploy_status', targetCommit ? { commit: targetCommit } : {});
    const deployBody = deploy.is_error ? { error: deploy.content } : parseJson(deploy.content);
    return {
      content: json({
        released: releaseBody.released === true,
        status: releaseBody.status,
        target_commit: targetCommit ?? null,
        deploy: {
          status: deployBody.deployStatus ?? deployBody.status ?? null,
          production_confirmed: deployBody.productionConfirmed === true,
          ...(deployBody.error !== undefined ? { error: deployBody.error } : {}),
        },
      }),
      is_error: false,
    };
  },
  dryRun: async (_ctx, args) => ({
    dry_run: true,
    action: 'release_workspace_run',
    ...(args.commit ? { commit: args.commit } : { commit: 'branch HEAD' }),
    ...(args.publish_receipt_from_run ? { run_id: args.publish_receipt_from_run } : {}),
    note: 'Approving triggers ONE production build (paid) shipping every published commit up to the target, then reads deploy_status once.',
  }),
  describe: (args) => `Release to production${args.commit ? ` (commit ${String(args.commit).slice(0, 12)})` : ''}`,
};

const parseJson = (text: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

// ─── registry ────────────────────────────────────────────────────────────────────

export const CHAT_TOOLS: readonly ChatTool[] = [
  getObject,
  getContract,
  listObjects,
  inventory,
  validate,
  searchArtifacts,
  checkout,
  patch,
  checkin,
  refreshLock,
  createObject,
  createVariant,
  instantiateTemplate,
  instantiateSectionTemplate,
  submitReview,
  publish,
  discard,
  applyTheme,
  listWorkspaceNodes,
  runWorkspaceWorkflow,
  getWorkspaceRun,
  checkWorkspaceRunReadiness,
  publishWorkspaceRun,
  releaseWorkspaceRun,
];

export const chatToolByName = (name: string): ChatTool | undefined => CHAT_TOOLS.find((tool) => tool.name === name);

/** §4 defaults by class. */
export const defaultAutonomyFor = (tool: ChatTool): ToolAutonomy => (tool.toolClass === 'read' ? 'auto' : 'ask');

/**
 * Resolve the frozen per-run autonomy map: defaults ← governance chat_tools
 * (site-wide, Owner-set) ← profile overrides (most specific wins). Both
 * layers are Owner-managed; apply_theme's Owner gate is enforced at
 * execution regardless of what this resolves to.
 */
export const resolveAutonomy = (
  governanceChatTools: Record<string, ToolAutonomy> | undefined,
  profileOverrides: Record<string, ToolAutonomy> | undefined
): Record<string, ToolAutonomy> => {
  const autonomy: Record<string, ToolAutonomy> = {};
  for (const tool of CHAT_TOOLS) {
    const resolved = profileOverrides?.[tool.name] ?? governanceChatTools?.[tool.name] ?? defaultAutonomyFor(tool);
    // PF4 hard floor: an override can disable a floored tool but can never
    // promote it to 'auto' — regardless of governance settings (D2).
    autonomy[tool.name] = tool.autonomyFloor === 'ask' && resolved === 'auto' ? 'ask' : resolved;
  }
  return autonomy;
};
