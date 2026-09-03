import { z } from 'zod';
import { workflowRecordSchema, type WorkflowLockRecord } from './schema-v1.js';
import { allowedAgentNames } from './workflow-contract.js';

export type { WorkflowLockRecord } from './schema-v1.js';

export const objectTypes = [
  'page',
  'section',
  'navigation',
  'taxonomy',
  'site',
  'template',
  'section_template',
  'theme',
  'product',
  'content_item',
  'tracking_config',
  // D1 (2026-07-28): the site's declared editorial identity as governed data —
  // one per site, read by agents through the ordinary object surface, never
  // rendered. See schema/bodies/editorial-voice-v1.ts.
  'editorial_voice',
  // Brand-imagery wave (BRIEF.md §3.1): a site's image style as a governed
  // mood-board object — `kind:'house'` singleton or `kind:'template'`
  // (unbounded). Deliberately NOT in approval-policy.ts governedObjectTypes —
  // never publishable; see schema/bodies/visual-standard-v1.ts.
  'visual_standard',
] as const;
export type ObjectType = (typeof objectTypes)[number];

export const objectTypeSchema = z.enum(objectTypes);
export const objectIdSchema = z.string();

/**
 * HOW an actor was established. Added 2026-09-03 (Wolf's ruling) after a live
 * plugin run recorded `create` as `plugin:openai-agent` and its next sixteen
 * verbs — four patches and three publishes included — as `unattributed-agent`,
 * because the model stopped passing `agent_name`. Identity now comes from the
 * token that authorized the call; this field records which derivation produced
 * the actor, so a reader can tell a proven identity from a self-declared one
 * WITHOUT having to know the code that wrote the line.
 *
 * - `oauth`                — an OAuth grant a named human approved. Strongest.
 * - `verified_agent_token` — an active per-agent key (W11 T11.10).
 * - `publish_key`          — the shared fleet secret; the caller is the fleet.
 * - `self_declared`        — a label the caller supplied. Coordination, not identity.
 * - `inherited_lock`       — LAST fallback only: attributed to the holder of the
 *                            live lease this write rode, because the call itself
 *                            carried nothing. Never inherited from the creating
 *                            actor — a create says who started an object, not who
 *                            is writing to it now.
 * Optional: every entry written before this existed has none, and absence
 * means exactly "unknown", not "self-declared".
 */
export const actorAttributionSchema = z.enum([
  'oauth',
  'verified_agent_token',
  'publish_key',
  'self_declared',
  'inherited_lock',
]);
export type ActorAttribution = z.infer<typeof actorAttributionSchema>;

export const principalSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('human'),
    id: z.string(),
    email: z.string(),
    /** The OAuth client the human approved. Server-minted; never client-asserted. */
    client_id: z.string().optional(),
    /** Which chat surface the grant belongs to (plugin:claude / plugin:openai-agent / plugin:openai-gpt). */
    surface: z.string().optional(),
    /**
     * The caller's self-declared `agent_name`, DEMOTED. It rides along as a
     * label because it is occasionally useful (which node of a workflow), and
     * it is never the identity.
     */
    label: z.string().optional(),
    attribution: actorAttributionSchema.optional(),
  }),
  z.object({
    kind: z.literal('agent'),
    agent_name: z.string(),
    auth: z.enum(['publish_key', 'mcp_token']),
    surface: z.string().optional(),
    attribution: actorAttributionSchema.optional(),
  }),
]);
export type Principal = z.infer<typeof principalSchema>;

/**
 * The execution context that produced a published object revision (T20.6a).
 * Optional on publish for backwards compatibility, but all four fields are
 * required together when present. The strict, bounded shape keeps arbitrary
 * run data out of the governed history and derived exports.
 */
export const producerContextSchema = z
  .object({
    run_id: z.string().min(1).max(128),
    node_id: z.string().min(1).max(128),
    prompt_version: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
  })
  .strict();
export type ProducerContext = z.infer<typeof producerContextSchema>;

export const reviewStateSchema = z.object({
  state: z.enum(['open', 'changes_requested', 'approved']),
  decisions: z.array(
    z.object({
      at: z.string(),
      by: principalSchema,
      decision: z.enum(['approve', 'request_changes']),
      note: z.string().optional(),
      publish_action: z
        .object({
          published_time: z.union([z.string(), z.null(), z.literal('immediate')]),
        })
        .optional(),
      /**
       * The extended live-publish pin (additive to the M-6 publish_action pin).
       * When an approval carries it, an AGENT-executed publish on a gated type
       * is authorized only for the exact request/content-item id, the exact
       * artifact set, and the exact release/build behavior the reviewer saw.
       * Absent = the pre-existing behavior (publish_action + content_revision
       * are the whole pin). Humans with publish authority are not bound by it.
       */
      approval_pin: z
        .object({
          /** The exact content-item / workflow request id the approval covers. */
          request_id: z.string().optional(),
          /** The exact set of artifact identifiers (blobKeys/sha256) approved. */
          artifact_set: z.array(z.string()).optional(),
          /** Whether the approval authorizes an immediate release/build or a deferred one. */
          release_build: z.enum(['defer', 'release']).optional(),
        })
        .optional(),
      content_revision: z.number(),
    })
  ),
});
export type ReviewState = z.infer<typeof reviewStateSchema>;

// The exact shape T1.3's buildReceipt (netlify/lib/object-publish.ts) writes —
// tightened from a loose z.record (Wolf-approved, 2026-07-06) so consumers
// like the object inventory can rely on `content_revision`. Non-strict on
// purpose: unknown extra fields from future writers parse fine (and are
// stripped only if something actually round-trips a parse, which no
// production read path does today).
export const publishReceiptSchema = z.object({
  kind: z.literal('object_export_commit'),
  branch: z.string(),
  commit_sha: z.string(),
  tree_sha: z.string(),
  no_op: z.boolean(),
  attempts: z.number().int().positive(),
  files: z.array(z.string()),
  /** The content_revision this export was materialized from. */
  content_revision: z.number(),
  /** The __generated marker's `at` — the effective published_time. */
  exported_at: z.string(),
});
export type PublishReceipt = z.infer<typeof publishReceiptSchema>;

export const publicationStateSchema = z.object({
  published_time: z.string().nullable(),
  publish_receipt: publishReceiptSchema.optional(),
});
export type PublicationState = z.infer<typeof publicationStateSchema>;

export const workflowExtensionSchema = z.object({
  workflow_status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
  current_stage: z.enum(allowedAgentNames).nullable(),
  next_agent: z.enum(allowedAgentNames).nullable(),
  completed_agents: z.array(z.enum(allowedAgentNames)),
  failed_agents: z.array(z.enum(allowedAgentNames)),
  last_error: z.string().nullable(),
  needs_review: z.boolean(),
  agent_outputs: z.record(z.string(), z.unknown()),
});
export type WorkflowExtension = z.infer<typeof workflowExtensionSchema>;

export const historyEntrySchema = z.object({
  at: z.string(),
  action: z.string(),
  actor: principalSchema,
  details: z.record(z.string(), z.unknown()).optional(),
});
export type HistoryEntry = z.infer<typeof historyEntrySchema>;

export const workflowLockRecordSchema = workflowRecordSchema.shape.lock;

export const objectRecordSchema = z.object({
  object_id: objectIdSchema,
  object_type: objectTypeSchema,
  schema_version: z.string(),
  site: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  status: z.enum(['active', 'archived']),
  body: z.unknown(),
  publication: publicationStateSchema,
  review: reviewStateSchema.optional(),
  lock: workflowLockRecordSchema.optional(),
  history: z.array(historyEntrySchema),
  version: z.number(),
  content_revision: z.number(),
  workflow: workflowExtensionSchema.optional(),
});

export type ObjectRecord<TBody = unknown> = Omit<z.infer<typeof objectRecordSchema>, 'body' | 'lock'> & {
  body: TBody;
  lock?: WorkflowLockRecord;
};
