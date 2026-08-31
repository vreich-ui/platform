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
import { projectActivityForChat } from '../requests/activity-for-chat.js';
import { fetchPublicationOutputs } from '../requests/publication-outputs.js';
import { nodeLabel } from '../../../lib/admin/request-logic.js';
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
   * Owner-only TEST MODE for this run (Wolf, 2026-08-24). Stamped at send time
   * by `admin-agent-chat.ts`, which has ALREADY ANDed the browser's request
   * with the roles it resolved from the authenticated principal — so a tool
   * reading this is reading a decision, never a claim, and must not re-derive
   * identity from it. Absent/false on every ordinary run.
   */
  testMode?: boolean;
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
    /** T19.8: the request registry's read/manage surface, for the four tools below. */
    list?(filters: {
      status?: string[];
      kind?: string[];
      mine?: boolean;
      archived?: boolean;
      q?: string;
    }): Promise<Record<string, unknown>>;
    get?(requestId: string): Promise<Record<string, unknown> | undefined>;
    retry?(requestId: string): Promise<Record<string, unknown>>;
    archive?(requestId: string): Promise<Record<string, unknown> | undefined>;
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
  /**
   * W20 (review fix, Wolf 2026-08-29) — set ONLY for the ONE `execute()` call
   * that is running because a HUMAN just clicked Approve (or Edit-and-approve)
   * on THIS call's own approval card. `loop.ts`'s pre-approved branch (the
   * `run.approved_call` marker `approvePendingTool` stamps) sets this
   * immediately before invoking `execute()` and deletes it immediately after,
   * so it never leaks onto any other call the same hop goes on to drain.
   *
   * Absent (undefined) on every other execute():
   *   - the ordinary 'auto' path — no card was EVER shown for this call,
   *     including an 'ask'-floored tool resolved to 'auto' by the project's
   *     `publishingPolicy.autonomyMode` being `'autonomous'` (`registry.ts`'s
   *     `autonomyForCall`) — that is an AGENT-initiated call, not a human one;
   *   - the pause itself (the `dryRun` call that renders the card) and any
   *     call still queued behind it.
   *
   * Do NOT infer this from `ctx.principal` alone: `chatRunSchema.principal` is
   * always `kind:'human'` — the signed-in editor who started the CHAT — and is
   * present on autonomous-mode 'auto' calls exactly as it is on approved ones.
   * It says who owns the run, never that a human just accepted a card for
   * THIS specific call. A tool that needs to know "did a human just approve
   * ME, right now" (as opposed to "who is this run's editor of record") reads
   * this field, not `ctx.principal`.
   */
  humanApprovedCall?: { call_id: string; by: string; edited: boolean };
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

/**
 * CMS-Agent answers EVERY workflow tool with `ok({ run: … })` — the run row is
 * nested under `run`, beside its siblings (`mode`, `stall`, `driverNote`,
 * `continued`). `CmsAgentClient.callTool` unwraps only the OUTER `{ok,data}`
 * envelope, so `data` is that object and never the run row itself.
 *
 * Reading `data.runId` therefore yielded `undefined` at every seam that touches
 * a run, and the consequence was not a cosmetic one: `run_workspace_workflow`
 * registered its request with NO workflow block (the guard below deliberately
 * omits one rather than store `run_id: ''`), so the sweeper had no run to poll,
 * `deriveRequestStatus` returned `queued` for ever, `retry_request` refused for
 * want of a run id, and the run's real failure was invisible to the desk. Every
 * unit test passed throughout, because the fakes returned the FLAT shape this
 * code expected instead of the shape the wire actually carries.
 *
 * Tolerant on purpose: a payload that IS already a run row passes through
 * unchanged, so a caller that has unwrapped is not broken by this.
 */
const runRowFrom = (payload: Record<string, unknown>): Record<string, unknown> => {
  const nested = payload.run;
  return typeof nested === 'object' && nested !== null && !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : payload;
};

/** Bounded run projection — the full run record can approach ~500KB; this
 *  keeps status, per-node states and driver notes and nothing else. The
 *  `mode` block is reduced to a live/mock boolean: its raw form names the
 *  provider (executionMode: 'openai'), which editor-facing output must
 *  never carry. `stall` reduces to a boolean for the same reason. */
const projectWorkspaceRun = (payload: Record<string, unknown>): Record<string, unknown> => {
  // The run row, unwrapped from CMS-Agent's `{ run, … }` envelope (runRowFrom).
  const run = runRowFrom(payload);
  // T19.8c: id + status alone was not enough to say anything an editor could
  // use — "node_7 is running" is not an answer. The LABEL and the timing cost
  // a few bytes each and turn the same call into a sentence. Anything richer
  // than this belongs in get_request_activity, which is built for it.
  const nodes = Array.isArray(run.nodes)
    ? (run.nodes as Record<string, unknown>[]).slice(0, 64).map((node) => {
        const id = String(node.nodeId ?? node.id ?? '');
        const startedAt = typeof node.startedAt === 'string' ? node.startedAt : undefined;
        const completedAt = typeof node.completedAt === 'string' ? node.completedAt : undefined;
        return {
          id,
          step: nodeLabel(id),
          status: node.status,
          ...(startedAt ? { started_at: startedAt } : {}),
          ...(completedAt ? { completed_at: completedAt } : {}),
        };
      })
    : undefined;
  // `mode` is nullable on the wire, not merely absent: a compact run view omits it
  // and some records carry an explicit null. `!== undefined` admits null and then
  // dereferences it, so this reads truthiness instead.
  // `mode`, `stall` and `driverNote` are SIBLINGS of `run` on the wire, so they
  // are read from the envelope and only then from the row (a caller that already
  // unwrapped still works).
  const mode = (payload.mode ?? run.mode) as { live?: boolean; executionMode?: string } | null | undefined;
  const stall = (payload.stall ?? run.stall) as { stalled?: boolean } | boolean | undefined;
  const driverNote = payload.driverNote ?? run.driverNote;
  return {
    run_id: run.runId ?? run.id,
    status: run.status,
    ...(mode ? { live_output: mode.live === true || mode.executionMode === 'openai' } : {}),
    ...(stall !== undefined
      ? { stalled: stall === true || (typeof stall === 'object' && stall?.stalled === true) }
      : {}),
    ...(typeof driverNote === 'string' ? { driver_note: truncate(driverNote, 500) } : {}),
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
      entrypoint: {
        type: 'string',
        enum: ['article_body'],
        description:
          'TEST MODE ONLY. Enter the run at article_body with a supplied body: the ideation, research and drafting nodes are seeded complete and never dispatched, so the run costs no model spend and finishes in seconds. Requires article_body. Refused unless this run is in test mode.',
      },
      article_body: {
        type: 'object',
        description:
          "TEST MODE ONLY. The client_object.v1 to seed as article_body's result. Validated against that node's own output schema before the run is created; a malformed body is refused with the failing fields named.",
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
        entrypoint: z.literal('article_body').optional(),
        article_body: z.record(z.string(), z.unknown()).optional(),
      })
      .refine((value) => !value.entrypoint || Boolean(value.article_body), {
        message: 'entrypoint requires article_body — the seeded output the run enters with.',
      })
      .refine((value) => !value.article_body || Boolean(value.entrypoint), {
        message: 'article_body is only meaningful with entrypoint: "article_body".',
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
    // The late-stage entrypoint skips every ideation/research/draft node, so it
    // is the one way to produce a publishable run without model spend — and for
    // exactly that reason it must never be reachable on an ordinary editorial
    // turn, where the skipped nodes ARE the product (the sourcing, claim and
    // compliance record ART-2 requires, and the aggression-ceiling clamp).
    // `ctx.testMode` was decided at send time against the caller's real roles.
    if (args.entrypoint && ctx.testMode !== true) {
      return {
        content: json({
          error:
            'entrypoint is available only in test mode. Turn on Test mode in the chat controls (owner only) and send again; an ordinary article run must go through the full workflow, which is what builds its sourcing, claim and compliance record.',
          code: 'test_mode_required',
        }),
        is_error: true,
      };
    }
    const requestId = (args.request_id as string | undefined) ?? (await mintWorkspaceRequestId(ctx, args));
    const started = await ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_start_dry_run', {
      projectId: ctx.cmsAgent.projectId,
      input: args.input,
      requestId,
      ...(args.workflow_id ? { workflowId: args.workflow_id } : {}),
      ...(args.budget_usd !== undefined ? { budgetUsd: args.budget_usd } : {}),
      ...(args.execution_mode ? { executionMode: args.execution_mode } : {}),
      ...(args.entrypoint ? { entrypoint: args.entrypoint, articleBody: args.article_body } : {}),
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
    ...(args.entrypoint ? { entrypoint: args.entrypoint, seeded_article_body: true } : {}),
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

/**
 * The readiness VERDICT, dug out of the envelope CMS-Agent actually returns.
 *
 * `cmsAgent.callTool` already unwraps the outer `{ok:true,data}`. What it hands
 * back for `workflow_publish_readiness` is then TWO more levels deep:
 *
 *   { readiness: { available, articleBodyValid, readiness: { status, checklist, blockers, ... } } }
 *
 * Reading `data.status` off that yields `undefined` — which is not "no_go", it
 * is "no answer", and every caller below treated it as a refusal. The result:
 * `publish_workspace_run` could never publish anything, on any run, whatever its
 * real readiness, and `check_workspace_run_readiness` reported a verdict of
 * `undefined` with no checklist — which reads to an editor as "the check didn't
 * return a result" and sends them looking for a problem in the run. On
 * 2026-08-28 that cost an afternoon on run_1787930929962_njffct, a run whose
 * readiness was `go` with all twelve checks passing every time it was asked.
 *
 * Unwrapped by shape rather than by a fixed path: whichever level carries a
 * `status` is the verdict, so a future flattening of the tool's envelope keeps
 * working instead of silently regressing to `undefined` again.
 */
const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

/** Did the client actually commit a publish? Strictly its own booleans — never an inferred default. */
const isPublished = (value: unknown): boolean => {
  if (!isRecord(value)) return false;
  const data = isRecord(value.publish) ? value.publish : value;
  return data.published === true || data.publishCommitted === true;
};

const readinessVerdict = (data: Record<string, unknown>): Record<string, unknown> => {
  let node: Record<string, unknown> = data;
  for (let depth = 0; depth < 4; depth += 1) {
    if (typeof node.status === 'string') return node;
    const inner = node.readiness;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)) break;
    node = inner as Record<string, unknown>;
  }
  return node;
};

/** Bounded, editor-safe readiness projection: status + checklist + blockers verbatim (they are already editor copy). */
const projectReadiness = (envelope: Record<string, unknown>): Record<string, unknown> => {
  const data = readinessVerdict(envelope);
  return {
    status: data.status,
    ...(Array.isArray(data.checklist) ? { checklist: (data.checklist as unknown[]).slice(0, 64) } : {}),
    ...(Array.isArray(data.blockers) ? { blockers: (data.blockers as unknown[]).slice(0, 64) } : {}),
    ...(data.requestId !== undefined ? { request_id: data.requestId } : {}),
  };
};

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
    // THE OPERATOR'S WITHHELD DECISION, BEFORE ANYTHING ELSE (Wolf, 2026-08-29
    // review). An operator who has withheld publish for this run must halt
    // this tool outright — before readiness is even checked, before any
    // decision is (re-)written, before workflow_publish_run is anywhere in
    // reach. Read the run's CURRENT operatorPublishDecision fresh (the
    // readiness envelope below doesn't carry it) and refuse with nothing else
    // called when it reads "withheld". `workflow_get_run` answers
    // `ok({ run, mode, stall })` — the run row is nested one key in, exactly
    // like every other workflow_get_run call site in this file (see
    // `runRowFrom`, used the same way by list_workspace_nodes et al.);
    // `callTool` unwraps only the outer {ok,data} envelope.
    const got = await cmsAgent.callTool<Record<string, unknown>>('workflow_get_run', { runId: input.runId });
    if (!got.ok) return { content: json({ error: got.message, code: got.code }), is_error: true };
    const currentRun = runRowFrom(got.data);
    if (currentRun.operatorPublishDecision === 'withheld') {
      return {
        content: json({
          error: 'Publish refused: the operator has withheld approval for this run.',
          code: 'refused',
          reason: 'operator withheld publish for this run',
        }),
        is_error: true,
      };
    }
    // Re-check readiness at execution: the card previewed it, but the world
    // may have moved — a no_go never reaches workflow_publish_run.
    const readiness = await callReadiness(ctx, input);
    if (!readiness.ok) return { content: json({ error: readiness.message, code: readiness.code }), is_error: true };
    const verdict = readinessVerdict(readiness.data);
    if (verdict.status !== 'go') {
      // Name the two apart. A no_go is the checklist speaking and the blockers
      // say what to fix; a MISSING status means nothing judged this run, and
      // sending an editor to look at a checklist that was never produced is how
      // an envelope bug spends an afternoon looking like a content problem.
      const spoke = typeof verdict.status === 'string';
      return {
        content: json({
          error: spoke
            ? 'Run is not ready to publish (readiness is not "go").'
            : 'Publish refused: no readiness verdict was returned for this run, so nothing has judged it ready. This is a system fault, not a problem with the article — report it rather than editing the run.',
          readiness: projectReadiness(readiness.data),
        }),
        is_error: true,
      };
    }
    // THE OPERATOR DECISION, BEFORE THE PUBLISH — `approved` on `workflow_publish_run`
    // is DEPRECATED. CMS-Agent's own live tool description says so directly: "approved
    // is DEPRECATED as an authority input (accepted for compatibility, no longer
    // consulted) and can never override an operator's 'withheld'." Publish authority is
    // resolved ONLY from `run.operatorPublishDecision` — written solely by
    // `workflow_set_operator_publish_decision` — or the project's `autonomyMode` policy
    // (`../../../lib/publishing-policy.js`). This tool used to send `approved: true` and
    // never write that decision, so a publish driven from admin chat could not be
    // authorised on any operator-gated project, no matter what the signed-in human
    // clicked — while the OTHER approve path, `admin-request-activity.ts`'s "approve"
    // action, called `workflow_set_operator_publish_decision` first and worked. Two
    // approve paths that disagreed, one of them silently unable to publish anything on a
    // gated site. Found live 2026-08-29.
    //
    // BUT only a HUMAN clicking Approve on THIS call's own approval card gets to WRITE
    // that "approved" (Wolf, 2026-08-29 review): `ctx.humanApprovedCall` is set ONLY by
    // loop.ts's pre-approved branch, for the one execute() it just resumed after a real
    // approval — never inferred from `ctx.principal` alone, which is present on every
    // run (autonomous included; see that field's own doc on ToolContext). A call that
    // reached here WITHOUT a human having just approved it is agent-initiated under an
    // autonomous project (this tool's `autonomyFloor:'ask'` resolved to 'auto' by
    // `publishingPolicy.autonomyMode`, `registry.ts`'s `autonomyForCall`) — writing
    // "approved" behind it would forge a human record of approval that never happened,
    // and would also be redundant: the project's own autonomyMode is what CMS-Agent's
    // `resolvePublishAuthority` already consults when no operator decision is on file.
    // So an agent-initiated call skips this write entirely and lets that policy authorise
    // the publish below, on its own.
    //
    // Deliberately OUTSIDE `ctx.idempotent` below, for the same reason
    // `admin-request-activity.ts` records this decision unconditionally on every approve
    // click rather than folding it into `workflow_run_all`'s own guard: recording
    // "approved" for a runId is idempotent on CMS-Agent's side (it just overwrites the
    // same field), so there is nothing to protect against a duplicate write, but there IS
    // something to lose by hiding it inside the publish idempotency key — a REPLAY of an
    // already-published run would then never re-assert the decision, and the human
    // approver's record of record would depend on whether this call happened to be the
    // first attempt or a retry. It should not. And if this call fails, the publish must
    // NOT proceed: same policy as the sibling path (`admin-request-activity.ts` returns
    // without ever calling its advance when the decision write fails), stayed with here
    // rather than inventing a "publish anyway" fallback for a tool that exists specifically
    // to gate publishing on operator say-so.
    if (ctx.humanApprovedCall) {
      const decided = await cmsAgent.callTool<Record<string, unknown>>('workflow_set_operator_publish_decision', {
        runId: input.runId,
        decision: 'approved',
      });
      if (!decided.ok) {
        return { content: json({ error: decided.message, code: decided.code }), is_error: true };
      }
    }
    const base = await readinessPayload(ctx, input);
    const payload = {
      runId: input.runId,
      projectId: cmsAgent.projectId,
      requestId: input.requestId,
      // NOT `approved: true`. It is accepted-but-ignored by `workflow_publish_run` (see
      // above) — sending it back would read as though IT were what authorised this
      // publish, when the operator decision just recorded above is what actually did.
      // A field that lies about what authorised the call is worse than no field.
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
      if (!published.ok) return { ok: false as const, isError: true, code: published.code, message: published.message };
      // A PUBLISH THAT DID NOT COMMIT MUST NOT ENTER THE IDEMPOTENCY LEDGER.
      //
      // The ledger's own rule is that only a successful write is safe to replay — "nothing landed
      // server-side for a toolError, so the correct behavior on retry is to try again, not to keep
      // replaying the same failure". But its notion of failure is `isError`, which is TRANSPORT-level,
      // and a refused publish arrives as a perfectly successful MCP call carrying `published: false`.
      // So the ledger stored it, keyed `publish:<runId>`, and every later publish of that run replayed
      // the stored refusal verbatim and CALLED NOTHING.
      //
      // On 2026-08-28 that made run_1787930929962_njffct permanently unretryable: two separate fixes
      // were deployed and verified live, and each subsequent publish returned the identical
      // pre-fix error — no new lock, no version bump on the client object, no call made at all. The
      // failure looked like the fixes had not worked. Marking the failure as an error here is what
      // keeps a retry a retry.
      return isPublished(published.data)
        ? { ok: true as const, data: published.data }
        : { ok: false as const, isError: true, failedPublish: true, data: published.data };
    };
    const result = ctx.idempotent
      ? await ctx.idempotent('publish_workspace_run', `publish:${input.runId}`, run)
      : await run();
    // A transport failure has no payload; a refused publish has the whole one. Both are errors, and
    // the second must still report what the client said.
    if (!result.ok && !(result as { failedPublish?: boolean }).failedPublish) {
      return { content: json({ error: result.message, code: result.code }), is_error: true };
    }
    // `workflow_publish_run` returns ok({ publish: <PublishResult> }), and callTool strips only the
    // outer {ok,data} — so the result lives one key in, exactly as the readiness verdict does.
    const outer = (result.data ?? {}) as Record<string, unknown>;
    const data = (isRecord(outer.publish) ? outer.publish : outer) as Record<string, unknown>;
    // A replay is a different fact from a fresh publish and the operator has to be able to see it:
    // "published" on a replay means it published EARLIER, and nothing ran just now.
    const replayEnvelope = (result as unknown as { structuredContent?: unknown }).structuredContent;
    const replayed = isRecord(replayEnvelope) && replayEnvelope.replayed_from_idempotency_key === true;

    // NEVER FABRICATE A PUBLISH. This read used to be
    //     published: data.published ?? data.status ?? true
    // against the WRAPPED payload, so both operands were undefined and the `?? true` reported every
    // call as a successful publish, with is_error:false. On 2026-08-28 that told an editor
    // run_1787930929962_njffct had published when the sequence had in fact stopped at its second
    // client call, leaving the object created, checked out and unpublished. A publish that did not
    // happen must never read as one: `published` is now strictly the client's own boolean, and
    // anything that is not an explicit success is an error the caller has to look at.
    const published = isPublished(data);
    const claimsFailure = data.published === false || data.publishCommitted === false;
    if (!published) {
      const blocked = isRecord(data.blocked) ? data.blocked : undefined;
      const blocker = isRecord(data.blocker) ? data.blocker : undefined;
      return {
        content: json({
          run_id: input.runId,
          request_id: input.requestId,
          published: false,
          // A shape this code cannot read is its own failure, and saying so is the whole point: the
          // previous version's silence about it is what let a blocked publish be reported as done.
          error: claimsFailure
            ? 'The publish did not complete. Nothing was published.'
            : 'The publish result could not be read, so whether anything published is unknown. Treat this as NOT published and report it — do not retry blindly.',
          ...(data.mode !== undefined ? { mode: data.mode } : {}),
          ...(data.reason !== undefined ? { reason: data.reason } : {}),
          ...(data.error !== undefined ? { client_error: data.error } : {}),
          ...(Array.isArray(data.blockers) ? { blockers: (data.blockers as unknown[]).slice(0, 32) } : {}),
          ...(blocker ? { blocker } : {}),
          ...(blocked ? { blocked } : {}),
          ...(isRecord(data.receipts) && Array.isArray((data.receipts as Record<string, unknown>).toolSequence)
            ? { tool_sequence: (data.receipts as { toolSequence: unknown[] }).toolSequence.slice(0, 16) }
            : {}),
          ...(Array.isArray(data.steps) ? { steps: (data.steps as unknown[]).slice(0, 16) } : {}),
        }),
        is_error: true,
      };
    }

    // The receipt fields live on the client's own publish result, one level in again.
    const receipt = isRecord(data.result) ? (data.result as Record<string, unknown>) : data;
    const commit =
      data.commit ?? receipt.commit ?? (isRecord(receipt.receipt) ? receipt.receipt.commit_sha : undefined);
    const articlePath = data.articlePath ?? receipt.article_path ?? receipt.articlePath;
    return {
      content: json({
        run_id: input.runId,
        request_id: input.requestId,
        published: true,
        ...(commit !== undefined ? { commit } : {}),
        ...(receipt.receipt !== undefined ? { receipt: receipt.receipt } : {}),
        ...(data.publishReceipt !== undefined ? { receipt: data.publishReceipt } : {}),
        ...(articlePath !== undefined ? { article_path: articlePath } : {}),
        approved_by: payload.readiness.approval.approvedBy,
        ...(replayed ? { replayed_from_earlier_publish: true } : {}),
        note: replayed
          ? 'REPLAYED from the idempotency ledger: this run published EARLIER and nothing ran just now. Published means committed to main with the Netlify skip marker — NOT live until an explicit release.'
          : 'Published means committed to main with the Netlify skip marker: the change is NOT live until an explicit release.',
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

// ─── W19 T19.8: the editorial request registry, from chat ────────────────────
//
// These read and manage the RECORD of a job. Advancing a job is still
// `run_workspace_workflow`; publishing is still a separate human decision.
// Wolf's original ask — "be able to inquire on all running requests" — is what
// `list_requests` exists for.

const REQUESTS_UNAVAILABLE: ToolResult = {
  content: json({ error: 'The editorial request registry is not available in this session.' }),
  is_error: true,
};

const listRequestsTool: ChatTool = {
  name: 'list_requests',
  toolClass: 'read',
  discloseResult: true,
  description:
    'List editorial requests — the RECORD of every job on this site (articles being written, and anything else registered), with status, progress and who asked. This is how you answer "what is running", "what needs me", "what stalled". It reads the record only; to ADVANCE a job use run_workspace_workflow, and publishing always remains a separate human decision. Default shows everything active; pass archived:true for the archive.',
  input_schema: {
    type: 'object',
    properties: {
      status: {
        type: 'array',
        items: { type: 'string', enum: ['queued', 'running', 'needs_you', 'stalled', 'failed', 'done', 'cancelled'] },
      },
      kind: { type: 'array', items: { type: 'string' } },
      mine: { type: 'boolean', description: "Only the requests this run's human asked for." },
      archived: { type: 'boolean' },
      q: { type: 'string', description: 'Free text over title and request id.' },
    },
    additionalProperties: false,
  },
  parse: zodParse(
    z.object({
      status: z.array(z.string()).optional(),
      kind: z.array(z.string()).optional(),
      mine: z.boolean().optional(),
      archived: z.boolean().optional(),
      q: z.string().max(200).optional(),
    })
  ),
  execute: async (ctx, args) => {
    if (!ctx.requests?.list) return REQUESTS_UNAVAILABLE;
    return {
      content: json(await ctx.requests.list(args as Parameters<NonNullable<typeof ctx.requests.list>>[0])),
      is_error: false,
    };
  },
  describe: () => 'List editorial requests',
};

const getRequestTool: ChatTool = {
  name: 'get_request',
  toolClass: 'read',
  discloseResult: true,
  description:
    'Read ONE editorial request: its status and the reason for it, workflow progress, blockers, the conversations attached to it, and the article it produced if it has one. Use it before answering a question about a specific job, and before offering to retry one.',
  input_schema: {
    type: 'object',
    properties: { request_id: { type: 'string' } },
    required: ['request_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ request_id: z.string().min(1) })),
  execute: async (ctx, args) => {
    if (!ctx.requests?.get) return REQUESTS_UNAVAILABLE;
    const doc = await ctx.requests.get(args.request_id as string);
    if (!doc) return { content: json({ error: `No request ${args.request_id}.` }), is_error: true };
    return { content: json(doc), is_error: false };
  },
  describe: (args) => `Read request ${args.request_id}`,
};

const retryRequestTool: ChatTool = {
  name: 'retry_request',
  toolClass: 'privileged',
  autonomyFloor: 'ask',
  discloseResult: true,
  description:
    'Nudge a STALLED or FAILED editorial request back into motion — one bounded attempt at the step that stopped, reusing everything already completed. Refused on a request that is waiting for a human decision: a gate is not a stall, and pushing it would not open it. Never starts a new job.',
  input_schema: {
    type: 'object',
    properties: { request_id: { type: 'string' } },
    required: ['request_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ request_id: z.string().min(1) })),
  execute: async (ctx, args) => {
    if (!ctx.requests?.retry) return REQUESTS_UNAVAILABLE;
    return { content: json(await ctx.requests.retry(args.request_id as string)), is_error: false };
  },
  dryRun: async (ctx, args) => {
    const doc = ctx.requests?.get ? await ctx.requests.get(args.request_id as string) : undefined;
    return {
      dry_run: true,
      action: 'retry_request',
      request_id: args.request_id,
      ...(doc ? { current_status: doc.status, title: doc.title } : {}),
      note: 'One more attempt at the step that stopped. Everything already completed is kept and is not recomputed.',
    };
  },
  describe: (args) => `Retry request ${args.request_id}`,
};

/**
 * T19.8c — the tool that answers "where is it?".
 *
 * `get_workspace_run` returns node ids and states, which is enough to say
 * "running" and nothing more. This returns the SAME projection the Requests
 * page draws its timeline from: every step in order, in editor words, with
 * what it produced, how long it took, how long it usually takes, its warnings
 * and its errors.
 */
const getRequestActivityTool: ChatTool = {
  name: 'get_request_activity',
  toolClass: 'read',
  discloseResult: true,
  description:
    'THE tool for "where is it up to?", "what is it doing now?", "why is this taking so long?", "what went wrong?" and any question about a job IN PROGRESS. Returns every step of the run in order — the step that is running right now, what each finished step produced, how long each took against how long it usually takes, a real time-remaining estimate, the running cost, and any warnings or failures in editor language. Always prefer this over get_workspace_run and over answering from the request status alone: the status says "running", this says which of the twenty-three steps it is on. Read-only; it never advances the run.',
  input_schema: {
    type: 'object',
    properties: {
      request_id: { type: 'string', description: 'The editorial request. Preferred — its run is resolved for you.' },
      run_id: { type: 'string', description: 'A workflow run directly, when there is no request behind it.' },
    },
    additionalProperties: false,
  },
  parse: zodParse(
    z
      .object({ request_id: z.string().min(1).optional(), run_id: z.string().min(1).optional() })
      .refine((value) => Boolean(value.request_id || value.run_id), {
        message: 'Provide request_id or run_id.',
      })
  ),
  execute: async (ctx, args) => {
    if (!ctx.cmsAgent) return CMS_AGENT_UNAVAILABLE;
    let runId = args.run_id as string | undefined;
    let title: string | undefined;
    if (args.request_id) {
      if (!ctx.requests?.get) return REQUESTS_UNAVAILABLE;
      const doc = await ctx.requests.get(args.request_id as string);
      if (!doc) return { content: json({ error: `No request ${args.request_id}.` }), is_error: true };
      title = typeof doc.title === 'string' ? doc.title : undefined;
      const workflow = doc.workflow as { run_id?: string } | undefined;
      runId = workflow?.run_id ?? runId;
      if (!runId) {
        // Not an error, and the difference matters: a job still starting will
        // have a run in a moment; a non-workflow request never will. Saying
        // "no activity" for both would have the agent report a starting job as
        // one that produces nothing.
        const status = String(doc.status ?? '');
        return {
          content: json({
            activity: null,
            reason: 'no_workflow_run',
            status,
            ...(title ? { title } : {}),
            note:
              status === 'queued' || status === 'running'
                ? 'This job has not been handed to the workflow engine yet. Say it is still starting and offer to check again.'
                : 'This request has no workflow behind it, so there are no steps to report.',
          }),
          is_error: false,
        };
      }
    }

    const [run, cost] = await Promise.all([
      ctx.cmsAgent.callTool<Record<string, unknown>>('workflow_get_run', { runId }),
      // The cost ledger carries the timing history the estimate is built from.
      // Optional: losing it costs the estimate, not the answer.
      ctx.cmsAgent
        .callTool<Record<string, unknown>>('workflow_get_run_cost', { runId })
        .catch(() => ({ ok: false as const, code: 'cost_unavailable', message: '' })),
    ]);
    if (!run.ok) return { content: json({ error: run.message, code: run.code }), is_error: true };

    // The executors' own outputs, once the run has published — the compact
    // view can say a publish was committed, not that the article is live.
    const nodeOutputs = await fetchPublicationOutputs(ctx.cmsAgent, run.data);
    const activity = projectActivityForChat(run.data, cost.ok ? cost.data : undefined, Date.now(), { nodeOutputs });
    if (!activity) {
      return {
        content: json({ activity: null, reason: 'run_not_readable', run_id: runId }),
        is_error: false,
      };
    }
    return { content: json({ ...(title ? { title } : {}), ...activity }), is_error: false };
  },
  describe: (args) => `Check progress of ${args.request_id ?? args.run_id}`,
};

const archiveRequestTool: ChatTool = {
  name: 'archive_request',
  toolClass: 'privileged',
  autonomyFloor: 'ask',
  discloseResult: true,
  description:
    'Take a finished editorial request out of the active list. Nothing is deleted — the record, its history and any article it produced all remain, and the archive filter still shows it. Owner or publisher only.',
  input_schema: {
    type: 'object',
    properties: { request_id: { type: 'string' } },
    required: ['request_id'],
    additionalProperties: false,
  },
  parse: zodParse(z.object({ request_id: z.string().min(1) })),
  execute: async (ctx, args) => {
    if (!ctx.requests?.archive) return REQUESTS_UNAVAILABLE;
    // The same wall `admin-requests` enforces (plan §8). Autonomy `ask` means
    // the human clicks approve — it says nothing about WHICH human, so without
    // this an editor- or viewer-tier principal could archive anything,
    // including a RUNNING request, which is terminal to the sweeper.
    if (!ctx.roles.includes('owner') && !ctx.roles.includes('publisher')) {
      return {
        content: json({ error: 'Archiving a request requires the Owner or publisher role.' }),
        is_error: true,
      };
    }
    const doc = await ctx.requests.archive(args.request_id as string);
    if (!doc) return { content: json({ error: `No request ${args.request_id}.` }), is_error: true };
    return { content: json(doc), is_error: false };
  },
  dryRun: async (ctx, args) => {
    const doc = ctx.requests?.get ? await ctx.requests.get(args.request_id as string) : undefined;
    return {
      dry_run: true,
      action: 'archive_request',
      request_id: args.request_id,
      ...(doc ? { title: doc.title, current_status: doc.status } : {}),
      note: 'Removes it from the active list. Nothing is deleted and it can be restored.',
    };
  },
  describe: (args) => `Archive request ${args.request_id}`,
};

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
  listRequestsTool,
  getRequestTool,
  getRequestActivityTool,
  retryRequestTool,
  archiveRequestTool,
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
