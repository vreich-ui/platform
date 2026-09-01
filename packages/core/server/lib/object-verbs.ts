/**
 * Shared object-verb core for the dual-auth endpoint pair (T0.8).
 *
 * Both entry points expose the SAME C§2.0 verb surface (minus review/publish,
 * which arrive in P1): the publish-key `object-store.ts` (agents/scripts) and
 * the Netlify-Identity `admin-object.ts` (browser admin UI). The only thing
 * that differs between them is authentication and how the acting `Principal`
 * is derived — so all action logic lives here, called with a resolved
 * principal. Keeping it in one place is also what makes "the browser path
 * never sees the publish key" structural: `admin-object.ts` neither imports
 * nor references the publish secret, and this module never reads it either.
 *
 * Conflict codes, preserved exactly as audited (A§1.2): a stale
 * `expected_record_version` → 409; a lock that is missing/expired/held by
 * someone else → 423. They are distinct and both surface here.
 *
 * ID minting is the endpoint's job, not the engine's (T0.6 requires fully-formed
 * ops). Every fresh id — taxonomy `term_id` from `{slug,label}` (C§2.5-C), and
 * likewise omitted section/nav/slot ids — is minted through the single
 * `mintId` helper (src/lib/object-ids-mint.ts) before the op reaches the engine.
 *
 * Validation runs through T0.7. Cross-object resolvers (does this page ref
 * resolve? is this taxonomy term active?) are injected there and are wired as
 * the objects/registries they need land in later phases; until then those
 * checks report `optional` and the schema / id / reader-safety / artifact-trust
 * / structural checks still run in full.
 */
import { z } from 'zod';

import {
  collectBlobListItems,
  mapWithConcurrency,
  STORE_READ_CONCURRENCY,
  type BlobListResponse,
} from './blob-list.js';
import {
  checkinObjectLock,
  checkoutObjectLock,
  forceReleaseObjectLock,
  isObjectLockActive,
  refreshObjectLock,
  sanitizeObjectLock,
  type ObjectLockStore,
} from './object-lock.js';
import type { Role } from './roles.js';
import {
  objectRecordKey,
  objectStatusIndexKey,
  objectStatusIndexPrefix,
  OBJECT_STORE_MARKER_VALUE,
} from './object-store-keys.js';
import { sweepInventoryRows } from './objects/index-store.js';
import {
  summarizeValidation,
  validateCandidatePatch,
  validateObject,
  type ObjectValidationContext,
} from './object-validate.js';
import { retireObject } from './object-retire.js';
import { purgeArchivedObjects } from './object-purge.js';
import { loadSiteRedirects } from './site-redirects.js';
import { validateObjectIdForType } from '../../lib/object-ids.js';
import { mintId, MintIdError } from '../../lib/object-ids-mint.js';
import { applyPatchOps, PatchApplyError } from '../../lib/object-patch-apply.js';
import { buildVariantBody } from '../../lib/article-object/variant.js';
import { buildPageBodyFromTemplate } from '../../lib/template-instantiate.js';
import { isStandalonePlaceableSectionType } from '../../lib/registry/components/registered-types.js';
import { contentItemBodySchema } from '../../schema/bodies/content-item-v1.js';
import { pageBodySchema, pageTypeIdSchema } from '../../schema/bodies/page-v1.js';
import { sectionTemplateBodySchema } from '../../schema/bodies/section-template-v1.js';
import type { SectionInstance } from '../../schema/bodies/section-v1.js';
import { siteBodySchema } from '../../schema/bodies/site-v1.js';
import { templateBodySchema } from '../../schema/bodies/template-v1.js';
import { themeBodySchema } from '../../schema/bodies/theme-v1.js';
import { THEME_AXIS_GROUPS, THEME_COLOR_KEYS } from '../../lib/registry/theme-tokens.js';
import {
  objectTypes,
  objectTypeSchema,
  producerContextSchema,
  type ObjectRecord,
  type ObjectType,
  type Principal,
} from '../../schema/object-record-v1.js';
import {
  compareInventoryRows,
  inventoryDetailFromRecord,
  matchesInventoryFilters,
  type InventoryFilters,
} from './object-inventory.js';
import { publishObject, type PublishObjectDeps } from './object-publish.js';
import { checkPublishGate } from './publish-gate.js';
import { canDecideReview, resolveRolesForPrincipal } from './roles.js';
import { isGovernedObjectType, type ApprovalPolicy } from '../../lib/approval-policy.js';
import {
  activeCreationPolicy,
  creationRuleFor,
  isCreationAllowed,
  type CreationPolicy,
} from '../../lib/creation-policy.js';
import { approvalPinSchema, decideReview, discardProposal, publishActionSchema, submitReview } from './review-state.js';
import { isAgentLearningTrailOp, type AgentLearningRecord } from '../../lib/admin/agent-learning-trail.js';
import {
  addMarginaliaComment,
  createMarginaliaThread,
  listMarginaliaThreads,
  setMarginaliaThreadStatus,
  type MarginaliaStore,
} from './marginalia-store.js';
import { marginaliaThreadStatusSchema } from '../../schema/marginalia-v1.js';

// ─── store shape ──────────────────────────────────────────────────────────────

export type ObjectVerbStore = ObjectLockStore & {
  list(options: { prefix: string; directories?: boolean; paginate?: boolean }): Promise<BlobListResponse>;
};

/** S4x (2/2): the minimal shape the agent-learning write needs — plain setJSON, no new abstraction. */
export type AgentLearningWriteStore = {
  setJSON(key: string, value: unknown): Promise<void | { modified: boolean; etag?: string }>;
};

// ─── request grammar (per-action) ────────────────────────────────────────────

const leaseSeconds = z.number().int().positive().optional();
const opsField = z.array(z.unknown());
const objectId = z.string().min(1);

export const objectVerbRequestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('get'),
    object_type: objectTypeSchema,
    object_id: objectId,
    /**
     * W6 D3: bounded reads. `full` (the default) is the historical shape,
     * byte-identical — nothing that omits `projection` moves. The other two
     * exist because a record grows without bound: `history` accumulates one
     * entry per verb forever (a live drlurie article is at version 88), and a
     * finished article's `body.nodes` dwarfs everything else. Reading an
     * article to revise it needs the nodes but never the ledger; deciding
     * WHICH article to open needs neither.
     */
    projection: z.enum(['summary', 'nodes', 'full']).optional(),
  }),
  z.object({
    action: z.literal('list'),
    object_type: objectTypeSchema,
    status: z.enum(['active', 'archived']).optional(),
  }),
  z.object({
    action: z.literal('inventory'),
    // All filters optional: omit object_type to sweep every type. With
    // object_id set (single-object detail), object_type is required — the
    // handler enforces that pairing since zod unions can't express it here.
    object_type: objectTypeSchema.optional(),
    object_id: objectId.optional(),
    status: z.enum(['active', 'archived']).optional(),
    requires_approval: z.boolean().optional(),
    review_state: z.enum(['none', 'open', 'changes_requested', 'approved']).optional(),
    pending_changes: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('create'),
    object_type: objectTypeSchema,
    site: z.string().min(1),
    body: z.unknown(),
    requested_id: z.string().min(1).optional(),
  }),
  // ─── W7.3: clone an article as a draft variant (08-articles-plan §2.4).
  // Node ids re-mint, node-id-referencing annotations re-point, lineage sets;
  // the built body is handed to the `create` case — one write path.
  z.object({
    action: z.literal('create_variant'),
    object_type: z.literal('content_item'),
    source_object_id: objectId,
    /** Variants may not share the source's permalink; defaults to <slug>-variant. */
    slug: z.string().min(1).optional(),
    requested_id: z.string().min(1).optional(),
    // Preview mode: build + validate the would-be variant, persist NOTHING —
    // how the round-trip driver proves the verb in production without leaving
    // probe variants behind (the instantiate dry_run pattern).
    dry_run: z.boolean().optional(),
  }),
  // ─── W2.5: create a page FROM a template recipe (design-principles rule 5).
  // Builds the body from the template's slots (src/lib/template-instantiate.ts)
  // and hands it to the `create` case — one write path, all rules apply.
  z.object({
    action: z.literal('instantiate'),
    template_id: objectId,
    site: z.string().min(1),
    route: z.string().min(1),
    title: z.string().min(1),
    page_type: pageTypeIdSchema.optional(),
    seo: pageBodySchema.shape.seo.optional(),
    requested_id: z.string().min(1).optional(),
    // Preview mode: build + validate the would-be page, persist NOTHING.
    dry_run: z.boolean().optional(),
  }),
  // ─── W8.2: stamp a section-template blueprint (09-plan §3). Page mode
  // composes ONE upsert_section through the standard patch path under the
  // CALLER'S checkout (the verb never auto-checkouts — one-lock discipline);
  // standalone mode mints a new shared sec_* object through the create path.
  z.object({
    action: z.literal('instantiate_section'),
    section_template_id: objectId,
    target: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('page'),
        page_id: objectId,
        // Insert position (clamped); appended when omitted.
        position: z.number().int().nonnegative().optional(),
        // Required for a REAL stamp (the handler 400s without them);
        // optional here so dry_run previews need no checkout at all.
        lock_token: z.string().min(1).optional(),
        expected_record_version: z.number().int().nonnegative().optional(),
      }),
      z.object({
        kind: z.literal('standalone'),
        requested_id: z.string().min(1).optional(),
      }),
    ]),
    // Preview mode: build the op / body + validate, persist NOTHING.
    dry_run: z.boolean().optional(),
  }),
  // ─── W8.3: apply a theme's tokens to the site singleton (09-plan §6.4).
  // Computes ONE exact-replace set_site_brand_tokens op (stale keys unset) and
  // routes it through the standard patch path under the CALLER'S site
  // checkout. Publish stays the separate deliberate step.
  z.object({
    action: z.literal('apply_theme'),
    theme_id: objectId,
    site_id: objectId,
    // Required for a REAL apply (the handler 400s without them); optional
    // here so dry_run previews need no checkout at all.
    lock_token: z.string().min(1).optional(),
    expected_record_version: z.number().int().nonnegative().optional(),
    // Preview mode: return the computed op + candidate validation, persist NOTHING.
    dry_run: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('checkout'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lease_seconds: leaseSeconds,
  }),
  z.object({
    action: z.literal('refresh_lock'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    lease_seconds: leaseSeconds,
  }),
  z.object({
    action: z.literal('checkin'),
    object_type: objectTypeSchema,
    object_id: objectId,
    // Optional: a normal check-in needs the lock token; an owner force
    // takeover (force:true) needs no token. The handler enforces the pairing.
    lock_token: z.string().min(1).optional(),
    force: z.boolean().optional(),
  }),
  z.object({
    action: z.literal('patch'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    expected_record_version: z.number().int().nonnegative(),
    ops: opsField,
  }),
  z.object({
    action: z.literal('validate'),
    object_type: objectTypeSchema,
    // Two mutually exclusive modes (the handler enforces the pairing — same
    // reason the zod union can't express it as the 'inventory' action above):
    // (1) object_id [+ candidate_patch] — dry-run an existing record, optionally
    //     with a proposed patch (unchanged since T0.8/T-2).
    // (2) body [+ requested_id], no object_id — dry-run a CANDIDATE that has no
    //     record yet, running the identical create-path checks object_create
    //     would run (id pattern/availability, schema, references, structural
    //     invariants) without persisting anything. Mirrors the object_instantiate_*
    //     dry_run affordance so "validate before it exists" needs no draft write.
    object_id: objectId.optional(),
    candidate_patch: opsField.optional(),
    body: z.unknown().optional(),
    requested_id: z.string().min(1).optional(),
  }),
  // ─── T1.4 review-state wiring ───────────────────────────────────────────
  z.object({
    action: z.literal('submit_review'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    note: z.string().optional(),
    // M-6: required by contract whenever an agent-executed publish of an
    // approval-gated type is intended (C§2.2); the publish gate — not this
    // schema — enforces that.
    requested_publish_action: publishActionSchema.optional(),
  }),
  z.object({
    action: z.literal('review_decide'),
    object_type: objectTypeSchema,
    object_id: objectId,
    decision: z.enum(['approve', 'request_changes']),
    note: z.string().optional(),
    publish_action: publishActionSchema.optional(),
    // Extended live-publish pin (Goal 4): bind agent execution to the exact
    // content-item/request id, artifact set, and release/build behavior.
    approval_pin: approvalPinSchema.optional(),
  }),
  z.object({
    action: z.literal('discard'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    // Exactly what each rejected op's history entry stores (T0.6, C§2.4).
    entries: z.array(z.object({ op: z.unknown(), capture: z.unknown() })).min(1),
  }),
  z.object({
    // W14 F6 ruling 1: hard delete only AFTER the 30-day archive grace period.
    // A sweep, not a per-object verb — see object-purge.ts for why.
    action: z.literal('purge_archived'),
    dry_run: z.boolean().optional(),
    grace_days: z.number().int().positive().optional(),
  }),
  z.object({
    // W14 F6: the governed removal verb. `redirect_to` exists because a retired
    // route must forward, never 404 (Wolf's ruling: this is a DTC sales and
    // publishing project — readers are not lost to a removal).
    action: z.literal('retire'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    redirect_to: z.string().min(1).optional(),
    reason: z.string().optional(),
  }),
  z.object({
    action: z.literal('publish_by_time'),
    object_type: objectTypeSchema,
    object_id: objectId,
    lock_token: z.string().min(1),
    published_time: z.union([z.string(), z.null()]).optional(),
    // Declared so an approval that pins them (Goal 4) can be satisfied: the gate
    // confirms they match the consumed approval's approval_pin. Object publishing
    // always defers the deploy (release is the separate explicit step), so
    // release_build here is the authorized intent the gate checks, not an executor.
    artifact_set: z.array(z.string().min(1)).optional(),
    release_build: z.enum(['defer', 'release']).optional(),
    producer: producerContextSchema.optional(),
  }),
  // ─── W15 S4 (MVP): Marginalia — canvas commenting/annotation threads,
  // persisted in a DEDICATED blob store (getMarginaliaBlobStore), not the
  // governed object substrate: no lock is required for any of these four.
  z.object({
    action: z.literal('marginalia_create'),
    object_type: objectTypeSchema,
    object_id: objectId,
    section_id: z.string().min(1).optional(),
    node_id: z.string().min(1).optional(),
    field: z.string().min(1).optional(),
    selected_text: z.string().min(1).optional(),
    body: z.string().min(1),
  }),
  z.object({
    action: z.literal('marginalia_reply'),
    object_type: objectTypeSchema,
    object_id: objectId,
    thread_id: z.string().min(1),
    body: z.string().min(1),
    parent_comment_id: z.string().min(1).optional(),
  }),
  z.object({
    action: z.literal('marginalia_list'),
    object_type: objectTypeSchema,
    object_id: objectId,
  }),
  z.object({
    action: z.literal('marginalia_resolve'),
    object_type: objectTypeSchema,
    object_id: objectId,
    thread_id: z.string().min(1),
    status: marginaliaThreadStatusSchema,
  }),
]);

export type ObjectVerbRequest = z.infer<typeof objectVerbRequestSchema>;
export type ObjectVerbAction = ObjectVerbRequest['action'];

/**
 * Whether `action` needs a fully-built `ObjectValidationContext` to behave
 * correctly. Building one (`buildStoreValidationContext`) means a full sweep
 * of every object across all types — expensive, and pointless for an action
 * that never reads `context`. Checked against every `case` in the switch
 * below: only branches that call `validateObject` / `validateCandidatePatch`
 * — directly, via a `dry_run` preview, or by recursing into `create`/`patch`
 * — actually consult it.
 *
 * Pure reads (`get`/`list`/`inventory`) and the lock-only verbs
 * (`checkout`/`refresh_lock`/`checkin`) obviously never validate a body.
 * Less obviously, `submit_review`/`review_decide`/`discard` (review-state.ts),
 * `retire` (object-retire.ts), `purge_archived` (object-purge.ts), and the
 * four `marginalia_*` actions (marginalia-store.ts) ALSO never read a
 * validation context today — confirmed by reading each callee, not assumed.
 *
 * Any action not explicitly matched here defaults to `true`: an unrecognized
 * future verb fails closed (slow-but-correct), never unsafe-but-fast.
 */
export const verbNeedsValidationContext = (action: ObjectVerbRequest['action']): boolean => {
  switch (action) {
    case 'get':
    case 'list':
    case 'inventory':
    case 'checkout':
    case 'refresh_lock':
    case 'checkin':
    case 'submit_review':
    case 'review_decide':
    case 'discard':
    case 'purge_archived':
    case 'retire':
    case 'marginalia_create':
    case 'marginalia_reply':
    case 'marginalia_list':
    case 'marginalia_resolve':
      return false;
    default:
      // create, create_variant, instantiate, instantiate_section,
      // apply_theme, patch, validate, publish_by_time — and anything future.
      return true;
  }
};

export type ObjectVerbResult = { status: number; body: Record<string, unknown> };

export type HandleObjectVerbOptions = {
  nowMs?: number;
  /** Injected T0.7 resolvers (references, taxonomy, pageType…). Empty until wired. */
  validationContext?: ObjectValidationContext;
  /** Forwarded to T1.3's publishObject (committer fetch/retry injection for tests). */
  publishDeps?: Omit<PublishObjectDeps, 'nowMs' | 'validationContext'>;
  /** Approval policy for the publish gate + inventory; defaults to the committed config (tests inject). */
  approvalPolicy?: ApprovalPolicy;
  /**
   * INTERNAL (not request-settable): extra history-entry details for a patch
   * this call composes on the caller's behalf — instantiate_section threads
   * its provenance ({instantiated_from: stpl_*}) through here (W8.2).
   */
  patchEntryDetails?: Record<string, unknown>;
  /**
   * INTERNAL (not request-settable): patch ops to accept beyond the type's
   * agent-facing allowlist — the privileged, non-submittable ops. site_apply_theme
   * threads ['set_site_brand_tokens'] here so ITS composed patch applies while a
   * hand-authored object_patch (which passes none) is refused (theme-only palette
   * governance, Wolf 2026-07-15).
   */
  privilegedOps?: readonly string[];
  /** Creation policy for the create gate; defaults to the committed config (tests inject). W8.3b. */
  creationPolicy?: CreationPolicy;
  /**
   * Resolved roles of the acting human (T9.4). Supplied by the caller after
   * server-side resolution; gates owner-only verb options (checkin{force}).
   * Absent ⇒ treated as no roles.
   */
  roles?: readonly Role[];
  /**
   * S4x (2/2): the per-site agent-learning blob store. A 'patch' whose `ops`
   * carries the AGENT_LEARNING_TRAIL_OP marker (edit-mode/ui.ts appends it
   * alongside the real ops for a save that followed a canvas Ask-AI round)
   * writes the tagged trail here — ONLY after the rest of the patch persists.
   * Absent (the publish-key agent path never sends the marker; admin-object.ts
   * is the only caller that supplies this): any marker present is stripped
   * from the ops array and silently dropped, never applied as a content op.
   */
  agentLearningStore?: AgentLearningWriteStore;
  /**
   * W15 S4 (MVP): the Marginalia blob store (getMarginaliaBlobStore) —
   * threaded through by both admin-object.ts and object-store.ts exactly the
   * way agentLearningStore is above. Absent: the four marginalia_* actions
   * 500 with a clear "not configured" message rather than throwing on a
   * missing store — a caller that forgets to wire it fails loudly, not
   * silently, at the one place that would otherwise NPE deep in the store.
   */
  marginaliaStore?: MarginaliaStore;
};

// ─── small helpers ────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const nowIso = (ms: number) => new Date(ms).toISOString();

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Deterministic stringify (stable key order) for seeding minted element ids. */
const stableStringify = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value))
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  return JSON.stringify(value);
};

const loadRecord = async (store: ObjectVerbStore, key: string): Promise<ObjectRecord | undefined> => {
  const raw = await store.get(key);
  return raw ? (JSON.parse(raw) as ObjectRecord) : undefined;
};

/**
 * 2026-08-06 hotfix: `loadRecord` for use inside a bulk sweep
 * (`listAllObjectRecords`, `inventory`'s list form). A single-object verb
 * (`get`, `patch`, `checkout`, …) should still let a `loadRecord` failure
 * propagate — a transient store error there is real and the caller should
 * see it, not a false 404. But a sweep over every object in the store is a
 * different contract: it already promises callers ("unreadable/unparseable
 * keys are skipped, never thrown on" — see `listAllObjectRecords`'s doc
 * comment) that one bad key degrades that ONE row, not the whole response.
 * That promise held for JSON.parse failures but not for `store.get` itself
 * rejecting — and once record loads run with real concurrency
 * (`STORE_READ_CONCURRENCY`) instead of one at a time, a single transient
 * Netlify Blobs read failure under the resulting burst load reliably turned
 * into "Object request could not be processed" for the ENTIRE content
 * library, every time it fired. This closes that gap for the sweep paths.
 */
const loadRecordForSweep = async (store: ObjectVerbStore, key: string): Promise<ObjectRecord | undefined> => {
  try {
    return await loadRecord(store, key);
  } catch (error) {
    console.warn(`Sweep: skipping unreadable object record at "${key}".`, error);
    return undefined;
  }
};

const ok = (body: Record<string, unknown>): ObjectVerbResult => ({ status: 200, body });
const err = (status: number, body: Record<string, unknown>): ObjectVerbResult => ({ status, body });

/** Pass a T0.5 lock result through as an HTTP result, surfacing record_version on success. */
const withRecordVersion = (result: {
  status: number;
  body: Record<string, unknown>;
  record?: { version: number };
}): ObjectVerbResult => ({
  status: result.status,
  body: result.record ? { ...result.body, record_version: result.record.version } : result.body,
});

// ─── ID minting into ops (the endpoint completes the op before the engine) ────

type MintedId = { index: number; field: string; id: string };

/**
 * Fill any omitted caller-supplied id on id-introducing ops, routed through
 * `mintId`. An id that is PRESENT is left untouched (the caller is referencing
 * or replacing a specific element); only a genuinely-absent id is minted.
 */
const mintOpsIds = (rawOps: readonly unknown[]): { ops: unknown[]; minted: MintedId[] } => {
  const minted: MintedId[] = [];
  const ops = rawOps.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.op !== 'string') return raw; // malformed → let the engine reject it
    const op = deepClone(raw);
    const note = (field: string, id: string) => minted.push({ index, field, id });

    if (op.op === 'add_term' && isRecord(op.term) && !op.term.term_id && typeof op.term.slug === 'string') {
      const id = mintId({ kind: 'taxonomy_term' }, op.term.slug);
      op.term.term_id = id;
      note('term.term_id', id);
    } else if (op.op === 'upsert_section' && isRecord(op.section) && !op.section.id) {
      const id = mintId({ kind: 'section_instance' }, stableStringify(op.section));
      op.section.id = id;
      note('section.id', id);
    } else if (op.op === 'upsert_item' && isRecord(op.item) && !op.item.id) {
      const id = mintId({ kind: 'nav_item' }, stableStringify(op.item));
      op.item.id = id;
      note('item.id', id);
    } else if (op.op === 'upsert_group' && isRecord(op.group) && !op.group.id) {
      const id = mintId({ kind: 'nav_group' }, stableStringify(op.group));
      op.group.id = id;
      note('group.id', id);
    } else if (op.op === 'upsert_slot' && isRecord(op.slot) && !op.slot.slotId) {
      const id = mintId({ kind: 'template_slot' }, stableStringify(op.slot));
      op.slot.slotId = id;
      note('slot.slotId', id);
    } else if (op.op === 'upsert_node' && isRecord(op.node) && !op.node.id) {
      // The contract has always advertised minted_id_field node.id — this
      // branch was missing (the W7.9 drill's probe carried an explicit id, so
      // the gap never fired until the canvas palette omitted the id).
      const id = mintId({ kind: 'article_node' }, stableStringify(op.node));
      op.node.id = id;
      note('node.id', id);
    } else if (op.op === 'replace_blueprint' && isRecord(op.blueprint) && !op.blueprint.id) {
      // A section-template blueprint id is a placeholder anyway (re-minted at
      // instantiation, W8) — mint it like any section instance id.
      const id = mintId({ kind: 'section_instance' }, stableStringify(op.blueprint));
      op.blueprint.id = id;
      note('blueprint.id', id);
    }
    return op;
  });
  return { ops, minted };
};

// ─── D3-sharedref: denormalize a shared_ref's target display name ─────────────

type JsonRecord = Record<string, unknown>;

const isSharedRefSection = (section: unknown): section is JsonRecord & { data: JsonRecord } =>
  isRecord(section) && section.type === 'shared_ref' && isRecord(section.data);

/**
 * Stamp `data.sectionName` on any `upsert_section` / `update_section_data` op
 * that creates or touches a `shared_ref`-typed section, resolving the
 * target's current display name through `context.resolveSharedSectionName`
 * (object-validate.ts). That resolver is backed by the SAME preloaded object
 * snapshot validation itself already builds for this write
 * (object-validation-context.ts) — so this adds no extra store read, it
 * piggybacks on one that has to happen anyway to check the ref resolves at
 * all. ObjectPreview.tsx then renders the stamped copy directly, so reads
 * stay free and synchronous instead of dereferencing the target at
 * render/preview time (see section-v1.ts's shared_ref field comment for the
 * staleness tradeoff this denormalization accepts — the stamped name is only
 * as fresh as the last write that touched THIS ref; renaming the target does
 * not retroactively update every page that shared_refs it, and nothing in
 * this codebase does that for any other denormalized display field either,
 * e.g. object-impact.ts recomputes "what points at this" on demand rather
 * than maintaining a live back-index).
 *
 * A target that doesn't resolve — a dangling ref (the target section was
 * deleted, or never existed) or simply no resolver being wired for this call
 * (e.g. a harness with no validationContext) — leaves `sectionName` UNSET
 * rather than throwing (and rather than stamping `null`: object-patch-
 * apply.ts's engine reserves `null` as its fields-unset marker and refuses
 * it outright inside a whole-value `upsert_section` payload — see section-
 * v1.ts's shared_ref field comment for why "couldn't resolve" and "never
 * attempted" are consequently the SAME absent-key state, not a null-vs-
 * undefined distinction). Reference-integrity enforcement (does this id
 * resolve at all?) is validateObject's job (object-validate.ts's
 * requireObject), not this step's; this step only ever adds a display
 * label, never blocks a write.
 *
 * `update_section_data` merges `fields` into an existing section's `data`
 * and never touches `type`, so whether an op is "about" a shared_ref has to
 * be read off the CURRENT record — the section `section_id` addresses,
 * before this patch applies. The effective target id is `fields.section`
 * when the op is changing it, else the section's existing target (an
 * `update_section_data` on a shared_ref that omits `section` from `fields`
 * is re-affirming the same target, e.g. touching `visibility` via a
 * different op in the same batch — still worth re-stamping in case the
 * target was renamed since the ref was last written). When the target can't
 * be resolved, `fields.sectionName` is likewise left unset — NOT set to
 * `null`, which under this op's merge semantics would actively DELETE any
 * name already stamped there; an unresolved re-stamp attempt should leave a
 * previously-good name in place rather than blanking it.
 */
const stampSharedRefSectionNames = (
  ops: readonly unknown[],
  currentBody: unknown,
  context: ObjectValidationContext
): unknown[] => {
  const currentSections: unknown[] =
    isRecord(currentBody) && Array.isArray(currentBody.sections) ? currentBody.sections : [];
  const nameFor = (targetId: string): string | undefined => context.resolveSharedSectionName?.(targetId);

  return ops.map((raw) => {
    if (!isRecord(raw) || typeof raw.op !== 'string') return raw; // malformed → let the engine reject it

    if (
      raw.op === 'upsert_section' &&
      isSharedRefSection(raw.section) &&
      typeof raw.section.data.section === 'string'
    ) {
      const name = nameFor(raw.section.data.section);
      if (name === undefined) return raw; // unresolved — leave the payload exactly as sent
      const op = deepClone(raw) as JsonRecord;
      const data = (op.section as JsonRecord).data as JsonRecord;
      data.sectionName = name;
      return op;
    }

    if (raw.op === 'update_section_data' && typeof raw.section_id === 'string' && isRecord(raw.fields)) {
      const current = currentSections.find((section) => isRecord(section) && section.id === raw.section_id);
      if (isSharedRefSection(current)) {
        const targetId = typeof raw.fields.section === 'string' ? raw.fields.section : current.data.section;
        const name = typeof targetId === 'string' ? nameFor(targetId) : undefined;
        if (name !== undefined) {
          const op = deepClone(raw) as JsonRecord;
          (op.fields as JsonRecord).sectionName = name;
          return op;
        }
      }
    }

    return raw;
  });
};

/** `learning/<yyyy-mm-dd>/<compact-ts>-<object_type>-<object_id>.json` — the commerce-events date-directory idiom. */
const agentLearningRecordKey = (objectType: ObjectType, objectId: string, at: string): string => {
  const date = at.slice(0, 10);
  const compactTs = at.replace(/\D/g, '');
  return `learning/${date}/${compactTs}-${objectType}-${objectId}.json`;
};

// A patch the engine refuses maps to an HTTP code by kind: a malformed op is a
// bad request (400); a state conflict (duplicate / blind-revert) is 409; the
// rest are unprocessable (422). None of these are ever swallowed.
const patchErrorStatus = (code: PatchApplyError['code']): number => {
  if (code === 'invalid_op') return 400;
  if (code === 'duplicate_target' || code === 'blind_revert_refused') return 409;
  return 422; // op_not_applicable | invalid_body | target_not_found | alias_required | alias_conflict
};

const seedForCreate = (objectType: ObjectType, body: unknown): string => {
  if (isRecord(body)) {
    if (objectType === 'page' && typeof body.route === 'string') return body.route;
    if (objectType === 'page' && typeof body.title === 'string') return body.title;
    if (objectType === 'navigation' && typeof body.role === 'string') return body.role;
    if (objectType === 'site' && typeof body.name === 'string') return body.name;
    if (objectType === 'template' && typeof body.name === 'string') return body.name;
    if (objectType === 'section_template' && typeof body.name === 'string') return body.name;
    if (objectType === 'theme' && typeof body.name === 'string') return body.name;
    if (objectType === 'product' && typeof body.slug === 'string') return body.slug;
    if (objectType === 'content_item' && typeof body.slug === 'string') return body.slug;
    if (objectType === 'content_item' && typeof body.title === 'string') return body.title;
    if (objectType === 'taxonomy') return 'registry';
    if (objectType === 'section' && isRecord(body.section) && typeof body.section.type === 'string')
      return `shared_${body.section.type}`;
  }
  return stableStringify(body);
};

// W13 (12-plan §3): tracking_config is a per-site SINGLETON (the
// site/taxonomy convention, but engine-enforced): creating a second active
// registry is refused regardless of its id — edit the existing one via
// set_tracking_config_fields instead.
// D1 (2026-07-28): editorial_voice is the same shape of singleton — one
// declared voice per site, edited via set_voice_fields. A second voice would
// make "the site's voice" ambiguous at exactly the moment an agent needs an
// unambiguous answer.
// Module-scoped (not local to `create`) so the object_validate candidate-body
// dry-run can report the same conflict a real object_create would hit.
const SINGLETON_TYPES: Partial<Record<ObjectType, { label: string; editOp: string; noun: string }>> = {
  tracking_config: { label: 'tracking_config', editOp: 'set_tracking_config_fields', noun: 'tracker registry' },
  editorial_voice: { label: 'editorial_voice', editOp: 'set_voice_fields', noun: 'declared editorial voice' },
};

/**
 * The W8.3b creation gate. Humans always create; agents resolve through the
 * committed creation policy (src/config/creation-policy.ts — default open).
 * Keys on the type BEING CREATED. Returns the 403 to serve, or undefined
 * when creation is allowed. ⚠️ agent_name is self-declared until OQ-3: a
 * coordination seam, not a security boundary.
 */
const creationDenied = (
  objectType: ObjectType,
  principal: Principal,
  policy: CreationPolicy
): ObjectVerbResult | undefined => {
  if (isCreationAllowed(objectType, principal, policy)) return undefined;
  const rule = isGovernedObjectType(objectType) ? creationRuleFor(objectType, policy) : 'open';
  return err(403, {
    error:
      `Creating ${objectType} objects is restricted by the creation policy (src/config/creation-policy.ts): ` +
      `agent "${principal.kind === 'agent' ? principal.agent_name : ''}" is not on the allowlist (humans may ` +
      `always create). REUSE FIRST: object_inventory({object_type: "${objectType}"}) lists what already exists — ` +
      `recipes carry self-describing summaries — or ask for the allowlist to be widened.`,
    code: 'creation_restricted',
    object_type: objectType,
    allowed_agents: rule === 'open' ? [] : rule.agents,
  });
};

/**
 * W15 S4 (MVP) commenting gate: same posture as canDecideReview — any human
 * with at least one configured role, OR any agent principal, may comment/
 * reply/resolve. An email with no configured role has no standing (matches
 * decideReview's human check in review-state.ts exactly); agents are always
 * allowed, the same allowance decideReview grants the detached approval
 * agent. Returns the 403 to serve, or undefined when commenting is allowed.
 */
const marginaliaDenied = (principal: Principal, roles: readonly Role[] | undefined): ObjectVerbResult | undefined => {
  if (principal.kind === 'agent') return undefined;
  if (canDecideReview(roles ?? [])) return undefined;
  return err(403, { error: 'Commenting requires a configured role.' });
};

// ─── bounded reads (W6 D3) ────────────────────────────────────────────────────

/**
 * W6 D3. `object_get` used to have exactly one shape: the whole record.
 * That shape has two unbounded parts. `history` grows by one entry per verb
 * and is never pruned — a live drlurie article sits at version 88, and its
 * `patch` entries embed the ops they applied, so the ledger can outweigh the
 * article it describes. `body.nodes` is the article itself.
 *
 * Neither is wrong to return; returning them when the caller did not ask is.
 * A plugin revising an article needs the nodes and never the ledger; a plugin
 * deciding WHICH article to open needs neither. So:
 *
 *   full     — unchanged, and the DEFAULT. No existing caller moves.
 *   nodes    — envelope + body, ledger replaced by `history_length`.
 *   summary  — nodes replaced by `{id, kind, visibility}` per node plus
 *              `node_count`; ledger replaced by `history_length`.
 *
 * The projection is a VIEW: nothing is dropped from the stored record, and a
 * projected read is never a basis for a write (patches carry ops, not bodies).
 */
const projectNode = (node: unknown): Record<string, unknown> => {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return {};
  const source = node as Record<string, unknown>;
  return {
    ...(typeof source.id === 'string' ? { id: source.id } : {}),
    ...(typeof source.kind === 'string' ? { kind: source.kind } : {}),
    ...(typeof source.visibility === 'string' ? { visibility: source.visibility } : {}),
  };
};

export const projectRecord = (record: ObjectRecord, projection: 'summary' | 'nodes'): Record<string, unknown> => {
  const { history, body, ...envelope } = record;
  const base: Record<string, unknown> = { ...envelope, history_length: Array.isArray(history) ? history.length : 0 };

  if (projection === 'nodes') return { ...base, body };

  const bodyRecord =
    body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : undefined;
  if (!bodyRecord) return { ...base, body };

  const { nodes, ...restOfBody } = bodyRecord;
  if (!Array.isArray(nodes)) return { ...base, body: bodyRecord };

  return { ...base, body: { ...restOfBody, node_count: nodes.length, nodes: nodes.map(projectNode) } };
};

// ─── read-only bulk enumeration (T9.11) ───────────────────────────────────────

/**
 * Load every object record across all types — the read-only sweep the audit
 * feed / attention inbox aggregate over. Reuses the same list + loadRecord path
 * as the `inventory` verb; no writes, no gating (callers authorize at the
 * function edge). Unloadable keys are skipped, never thrown on.
 */
export const listAllObjectRecords = async (
  store: ObjectVerbStore,
  options: { status?: 'active' | 'archived' } = {}
): Promise<ObjectRecord[]> => {
  // The 13 per-type listings are independent — issue them together instead of
  // one at a time (no ordering constraint on `list` itself). A transient
  // failure listing one type degrades to "0 items from that type this
  // sweep" rather than failing the whole request — matches the per-record
  // resilience below (2026-08-06 hotfix).
  const perTypeItems = await Promise.all(
    objectTypes.map(async (objectType) => {
      // 2026-08-06 hotfix follow-up: `store.list(..., { paginate: true })` can
      // return a plain AsyncIterable (not a Promise) rather than resolving to
      // one — chaining `.then()` directly off its return value throws
      // SYNCHRONOUSLY ("...list(...).then is not a function") the instant
      // this runs, before `.catch()` can ever attach, which aborted this
      // sweep 100% of the time regardless of data (the bug the `.catch()`
      // above was meant to guard against, but never actually could). `await`
      // works for both a Promise and a plain value, so awaiting first is
      // what actually makes the try/catch below effective.
      try {
        return await collectBlobListItems(
          await store.list({ prefix: `objects/${objectType}/by-id/`, directories: false, paginate: true })
        );
      } catch (error) {
        console.warn(`listAllObjectRecords: skipping unlistable object type "${objectType}".`, error);
        return [];
      }
    })
  );
  // Flatten in objectTypes order (unchanged from the old nested loop) so the
  // record order downstream — and any tie-breaking a stable sort over it
  // relies on (audit-feed.ts) — is identical to before; only the per-record
  // loads below run concurrently.
  const items = perTypeItems.flat();
  const loaded = await mapWithConcurrency(items, STORE_READ_CONCURRENCY, (item) => loadRecordForSweep(store, item.key));

  const records: ObjectRecord[] = [];
  for (const record of loaded) {
    if (!record) continue;
    if (options.status && record.status !== options.status) continue;
    records.push(record);
  }
  return records;
};

// ─── the dispatcher ───────────────────────────────────────────────────────────

export const handleObjectVerb = async (
  store: ObjectVerbStore,
  request: ObjectVerbRequest,
  principal: Principal,
  options: HandleObjectVerbOptions = {}
): Promise<ObjectVerbResult> => {
  const ts = options.nowMs ?? Date.now();
  const timestamp = nowIso(ts);
  const context = options.validationContext ?? {};
  const creationPolicy = options.creationPolicy ?? activeCreationPolicy();

  switch (request.action) {
    case 'get': {
      const record = await loadRecord(store, objectRecordKey(request.object_type, request.object_id));
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      const projection = request.projection ?? 'full';
      if (projection === 'full') return ok({ record });

      return ok({ record: projectRecord(record, projection), projection });
    }

    case 'list': {
      const prefix = `objects/${request.object_type}/by-id/`;
      const listResult = await store.list({ prefix, directories: false, paginate: true });
      const items = await collectBlobListItems(listResult);
      const objects: Record<string, unknown>[] = [];
      for (const item of items) {
        const record = await loadRecord(store, item.key);
        if (!record) continue;
        if (request.status && record.status !== request.status) continue;
        objects.push({
          object_id: record.object_id,
          object_type: record.object_type,
          status: record.status,
          version: record.version,
          content_revision: record.content_revision,
          published_time: record.publication.published_time,
        });
      }
      return ok({ objects });
    }

    case 'inventory': {
      // Single-object detail view.
      if (request.object_id) {
        if (!request.object_type) {
          return err(400, { error: 'inventory with object_id requires object_type.' });
        }
        const record = await loadRecord(store, objectRecordKey(request.object_type, request.object_id));
        if (!record) return err(404, { error: 'Object record not found', not_found: true });
        return ok({ object: inventoryDetailFromRecord(record, ts, options.approvalPolicy), generated_at: timestamp });
      }

      const filters: InventoryFilters = {
        status: request.status,
        requires_approval: request.requires_approval,
        review_state: request.review_state,
        pending_changes: request.pending_changes,
      };
      /**
       * T5.1 R3 (T0.2 F10, §4 cause #3). This used to be `13 x store.list()`
       * followed by `N x store.get()` of whole record envelopes — body trees
       * and unbounded history — to derive fifteen scalars per row, on a path
       * that runs two-to-four times per admin page load. The listings still
       * happen (they are cheap, parallel, and name the live key set), but each
       * key now serves its row from `objects/index.json` when the listing's
       * etag proves the record has not changed since that row was projected.
       * Only genuinely changed records are read. See `objects/index-store.ts`
       * for why this is verified against the listing rather than maintained by
       * writers.
       *
       * `sweep.stats` is reported on the response so drift is observable — a
       * `read` that stays high call after call means etags are not reaching
       * this code (an unusual store, or the local file-backed shim) and the
       * cost has silently reverted to the old sweep.
       */
      const sweep = await sweepInventoryRows(store, {
        nowMs: ts,
        ...(options.approvalPolicy ? { approvalPolicy: options.approvalPolicy } : {}),
        ...(request.object_type ? { objectType: request.object_type } : {}),
      });
      const rows = sweep.rows.filter((row) => matchesInventoryFilters(row, filters));
      rows.sort(compareInventoryRows(objectTypes));
      return ok({ objects: rows, generated_at: timestamp, index: sweep.stats });
    }

    case 'create': {
      const objectType = request.object_type;

      // The authoritative creation gate (W8.3b) — BEFORE minting/existence
      // probing, so a restricted caller learns nothing about id availability.
      // create_variant/instantiate/instantiate_section-standalone recurse
      // into this case, so no create path can bypass it.
      const denied = creationDenied(objectType, principal, creationPolicy);
      if (denied) return denied;

      let objectIdValue: string;
      if (request.requested_id) {
        const check = validateObjectIdForType(objectType, request.requested_id);
        if (!check.ok) return err(400, { error: 'Invalid requested_id', detail: check.error });
        objectIdValue = request.requested_id;
      } else {
        try {
          // content_item ids keep the article req_* shape (W7.3), which
          // carries a date segment — minted from the request timestamp.
          objectIdValue =
            objectType === 'content_item'
              ? mintId(
                  { kind: 'content_item', yyyymmdd: timestamp.slice(0, 10).replaceAll('-', '') },
                  seedForCreate(objectType, request.body)
                )
              : mintId({ kind: 'object', objectType }, seedForCreate(objectType, request.body));
        } catch (error) {
          if (error instanceof MintIdError)
            return err(400, { error: 'Could not mint an object id', detail: error.message });
          throw error;
        }
      }

      const key = objectRecordKey(objectType, objectIdValue);
      if (await store.get(key)) return err(409, { error: 'Object already exists', object_id: objectIdValue });

      const singleton = SINGLETON_TYPES[objectType];
      if (singleton) {
        const existing = await collectBlobListItems(
          await store.list({ prefix: objectStatusIndexPrefix(objectType, 'active') })
        );
        if (existing.length > 0) {
          const existingId = existing[0]!.key.split('/').at(-1);
          return err(409, {
            error: `A ${singleton.label} singleton already exists (${existingId}) — edit it via ${singleton.editOp}; a site has exactly one ${singleton.noun}.`,
            object_id: existingId,
            singleton: true,
          });
        }
      }

      const groups = validateObject({ objectType, objectId: objectIdValue, body: request.body }, context);
      const summary = summarizeValidation(groups);
      if (!summary.eligible) {
        return err(422, {
          error: 'Validation failed',
          object_id: objectIdValue,
          validation: groups,
          blockers: summary.blockers,
        });
      }

      const record: ObjectRecord = {
        object_id: objectIdValue,
        object_type: objectType,
        schema_version: `${objectType}.v1`,
        site: request.site,
        created_at: timestamp,
        updated_at: timestamp,
        status: 'active',
        body: request.body,
        publication: { published_time: null },
        history: [{ at: timestamp, action: 'create', actor: principal }],
        version: 1,
        content_revision: 1,
      };
      await store.setJSON(key, record);
      await store.setJSON(objectStatusIndexKey(objectType, 'active', objectIdValue), OBJECT_STORE_MARKER_VALUE);
      return ok({ record });
    }

    case 'create_variant': {
      // W7.3 (§2.4): clone an article as a draft variant. The source must
      // exist and parse as content_item.v1; the built body flows through the
      // standard `create` path so every rule (slug uniqueness, taxonomy,
      // renderability, deploy safety) applies to variants too.
      // Pre-check the creation gate (the `create` recursion is authoritative;
      // this keeps dry_run honest and the error early).
      const variantDenied = creationDenied('content_item', principal, creationPolicy);
      if (variantDenied) return variantDenied;
      const sourceKey = objectRecordKey('content_item', request.source_object_id);
      const sourceRecord = await loadRecord(store, sourceKey);
      if (!sourceRecord) {
        return err(404, { error: 'Source article not found', not_found: true, object_id: request.source_object_id });
      }
      const parsedSource = contentItemBodySchema.safeParse(sourceRecord.body);
      if (!parsedSource.success) {
        return err(422, {
          error: 'Source article body does not parse as content_item.v1 — heal it before creating variants.',
          object_id: request.source_object_id,
          issues: parsedSource.error.issues,
        });
      }

      let objectIdValue: string;
      if (request.requested_id) {
        const check = validateObjectIdForType('content_item', request.requested_id);
        if (!check.ok) return err(400, { error: 'Invalid requested_id', detail: check.error });
        objectIdValue = request.requested_id;
      } else {
        try {
          objectIdValue = mintId(
            { kind: 'content_item', yyyymmdd: timestamp.slice(0, 10).replaceAll('-', '') },
            `${request.slug ?? `${parsedSource.data.slug} variant`}`
          );
        } catch (error) {
          if (error instanceof MintIdError)
            return err(400, { error: 'Could not mint an object id', detail: error.message });
          throw error;
        }
      }

      const variantBody = buildVariantBody(parsedSource.data, {
        sourceObjectId: request.source_object_id,
        newObjectId: objectIdValue,
        ...(request.slug ? { slug: request.slug } : {}),
      });

      if (request.dry_run) {
        const groups = validateObject(
          { objectType: 'content_item', objectId: objectIdValue, body: variantBody },
          context
        );
        const summary = summarizeValidation(groups);
        const idTaken = Boolean(await store.get(objectRecordKey('content_item', objectIdValue)));
        return ok({
          dry_run: true,
          variant_of: request.source_object_id,
          object_id: objectIdValue,
          id_available: !idTaken,
          body: variantBody,
          validation: groups,
          summary,
        });
      }

      const result = await handleObjectVerb(
        store,
        {
          action: 'create',
          object_type: 'content_item',
          site: sourceRecord.site,
          body: variantBody,
          requested_id: objectIdValue,
        },
        principal,
        options
      );
      if (result.status !== 200) return result;
      return ok({ ...result.body, variant_of: request.source_object_id });
    }

    case 'instantiate': {
      // The policy keys on the CREATED type: instantiating makes a PAGE
      // (restricting `template` restricts who mints recipes, not who uses
      // them). Pre-check for dry_run honesty; the create recursion is
      // authoritative.
      const instantiateDenied = creationDenied('page', principal, creationPolicy);
      if (instantiateDenied) return instantiateDenied;
      // The template must EXIST (draft is fine — the same existence semantics
      // as a shared_ref target); its body must parse as template.v1.
      const templateRecord = await loadRecord(store, objectRecordKey('template', request.template_id));
      if (!templateRecord) {
        return err(404, { error: 'Template not found', not_found: true, template_id: request.template_id });
      }
      const parsedTemplate = templateBodySchema.safeParse(templateRecord.body);
      if (!parsedTemplate.success) {
        return err(422, {
          error: 'Template body does not parse as template.v1 — fix the template before instantiating.',
          template_id: request.template_id,
          issues: parsedTemplate.error.issues,
        });
      }

      // Pre-resolve every slot blueprintRef (W8.2) so the builder stays pure:
      // each referenced section_template must exist and parse; its blueprint
      // enters the map the builder deep-copies from. Deref happens HERE, at
      // instantiation, only — recipes are never live-bound.
      const refs = [
        ...new Set(
          parsedTemplate.data.slots
            .map((slot) => slot.blueprintRef)
            .filter((ref): ref is string => typeof ref === 'string')
        ),
      ];
      const resolvedBlueprints: Record<string, SectionInstance> = {};
      for (const ref of refs) {
        const stplRecord = await loadRecord(store, objectRecordKey('section_template', ref));
        if (!stplRecord) {
          return err(422, {
            error: `Slot blueprintRef "${ref}" does not resolve to a section_template object.`,
            template_id: request.template_id,
          });
        }
        const parsedStpl = sectionTemplateBodySchema.safeParse(stplRecord.body);
        if (!parsedStpl.success) {
          return err(422, {
            error: `Section template "${ref}" does not parse as section_template.v1 — fix it before instantiating.`,
            template_id: request.template_id,
            issues: parsedStpl.error.issues,
          });
        }
        resolvedBlueprints[ref] = parsedStpl.data.blueprint;
      }
      // Re-check type-in-allowed at the LIVE instantiation point: the recipe
      // may have been re-blueprinted since the template was created/validated
      // (template_blueprint_refs is checked on template writes, not recipe
      // writes — the recipe doesn't know who references it).
      for (const slot of parsedTemplate.data.slots) {
        if (!slot.blueprintRef || slot.allowed.length === 0) continue;
        const refType = resolvedBlueprints[slot.blueprintRef]?.type;
        if (refType && (!isStandalonePlaceableSectionType(refType) || !slot.allowed.includes(refType))) {
          return err(422, {
            error: `Slot "${slot.slotId}": referenced blueprint type "${refType}" (${slot.blueprintRef}) is no longer in the slot's allowed set — the recipe changed since this template was written.`,
            template_id: request.template_id,
          });
        }
      }

      const built = buildPageBodyFromTemplate(parsedTemplate.data, {
        route: request.route,
        title: request.title,
        pageType: request.page_type,
        seo: request.seo,
        templateRef: templateRecord.object_id,
        instantiatedAt: timestamp,
        resolvedBlueprints,
      });
      if (!built.ok) {
        return err(422, { error: built.error, template_id: request.template_id });
      }

      if (request.dry_run) {
        // Preview: the exact body a real instantiate would create, its minted
        // (or requested) id, id availability, and full validation — nothing
        // persisted. This is also how the round-trip driver proves the verb
        // against production without leaving probe pages behind.
        let objectIdValue: string;
        if (request.requested_id) {
          const check = validateObjectIdForType('page', request.requested_id);
          if (!check.ok) return err(400, { error: 'Invalid requested_id', detail: check.error });
          objectIdValue = request.requested_id;
        } else {
          try {
            objectIdValue = mintId({ kind: 'object', objectType: 'page' }, seedForCreate('page', built.body));
          } catch (error) {
            if (error instanceof MintIdError)
              return err(400, { error: 'Could not mint an object id', detail: error.message });
            throw error;
          }
        }
        const groups = validateObject({ objectType: 'page', objectId: objectIdValue, body: built.body }, context);
        const summary = summarizeValidation(groups);
        const idTaken = Boolean(await store.get(objectRecordKey('page', objectIdValue)));
        return ok({
          dry_run: true,
          instantiated_from: templateRecord.object_id,
          object_id: objectIdValue,
          id_available: !idTaken,
          body: built.body,
          validation: groups,
          summary,
        });
      }

      const result = await handleObjectVerb(
        store,
        {
          action: 'create',
          object_type: 'page',
          site: request.site,
          body: built.body,
          ...(request.requested_id ? { requested_id: request.requested_id } : {}),
        },
        principal,
        options
      );
      if (result.status !== 200) return result;
      return ok({ ...result.body, instantiated_from: templateRecord.object_id });
    }

    case 'instantiate_section': {
      // The recipe must EXIST (draft is fine — the `instantiate` existence
      // semantics); its body must parse as section_template.v1.
      const stplRecord = await loadRecord(store, objectRecordKey('section_template', request.section_template_id));
      if (!stplRecord) {
        return err(404, {
          error: 'Section template not found',
          not_found: true,
          section_template_id: request.section_template_id,
        });
      }
      const parsedStpl = sectionTemplateBodySchema.safeParse(stplRecord.body);
      if (!parsedStpl.success) {
        return err(422, {
          error: 'Section template body does not parse as section_template.v1 — fix it before instantiating.',
          section_template_id: request.section_template_id,
          issues: parsedStpl.error.issues,
        });
      }

      if (request.target.kind === 'page') {
        const target = request.target;
        // The section id is DETERMINISTIC in (recipe, page, record version):
        // re-issuing the same stamp against the same version re-mints the
        // same id (an upsert replaces in place — no duplicate), and after a
        // lost response an agent can recover by dry-running with the
        // ORIGINAL expected_record_version and checking whether the returned
        // section_id already sits on the page. A deliberate second stamp
        // happens after the version moved, so it gets a fresh id and inserts.
        const mintStampId = (versionSeed: number) =>
          mintId({ kind: 'section_instance' }, `${stplRecord.object_id}/${target.page_id}/${versionSeed}`);
        const buildOp = (sectionId: string) => ({
          op: 'upsert_section',
          section: { ...deepClone(parsedStpl.data.blueprint), id: sectionId },
          ...(target.position !== undefined ? { position: target.position } : {}),
        });

        if (request.dry_run) {
          // Preview: the exact op a real stamp would apply + candidate-patch
          // validation (apply on a clone, full pipeline) — nothing persisted,
          // NO lock or version needed (the current record version seeds the
          // id when expected_record_version is omitted). This is how the
          // W8.4 credentialed run proves page mode without probe mutations.
          const pageRecord = await loadRecord(store, objectRecordKey('page', target.page_id));
          if (!pageRecord) {
            return err(404, { error: 'Page not found', not_found: true, object_id: target.page_id });
          }
          const sectionId = mintStampId(target.expected_record_version ?? pageRecord.version);
          const op = buildOp(sectionId);
          const validation = validateCandidatePatch(pageRecord, [op], context);
          return ok({
            dry_run: true,
            instantiated_from: stplRecord.object_id,
            page_id: target.page_id,
            section_id: sectionId,
            op,
            eligible: validation.eligible,
            validation: validation.groups,
            apply_error: validation.applyError,
          });
        }

        // A REAL stamp needs the caller's checkout (schema-optional only so
        // dry_run can omit them).
        if (target.lock_token === undefined || target.expected_record_version === undefined) {
          return err(400, {
            error:
              'Page-mode stamping requires lock_token and expected_record_version from YOUR page checkout (only dry_run: true works without them).',
          });
        }

        // ONE upsert_section through the standard patch path under the
        // caller's lock — full PageType law, leaf rule, reference integrity;
        // the history entry carries the recipe provenance; the inverse
        // (remove_section) comes free from the capture.
        const sectionId = mintStampId(target.expected_record_version);
        const result = await handleObjectVerb(
          store,
          {
            action: 'patch',
            object_type: 'page',
            object_id: target.page_id,
            lock_token: target.lock_token,
            expected_record_version: target.expected_record_version,
            ops: [buildOp(sectionId)],
          },
          principal,
          { ...options, patchEntryDetails: { instantiated_from: stplRecord.object_id } }
        );
        // On conflict (409 after a lost response), surface the id this
        // version WOULD have minted so the agent can check whether the first
        // write actually landed before re-stamping at the new version.
        if (result.status !== 200) {
          return { status: result.status, body: { ...result.body, section_id_for_expected_version: sectionId } };
        }
        return ok({ ...result.body, instantiated_from: stplRecord.object_id, section_id: sectionId });
      }

      // Standalone mode: a new shared sec_* object through the standard
      // create path — identical to a hand-authored one, then usable via
      // shared_ref from any page. This CREATES a section object, so the
      // creation gate applies (page-mode stamping above is a patch to an
      // existing page — deliberately ungated). Pre-check for dry_run
      // honesty; the create recursion is authoritative.
      const standaloneDenied = creationDenied('section', principal, creationPolicy);
      if (standaloneDenied) return standaloneDenied;
      let requestedId = request.target.requested_id;
      if (!requestedId) {
        try {
          requestedId = mintId({ kind: 'object', objectType: 'section' }, stplRecord.object_id.replace(/^stpl_/, ''));
        } catch (error) {
          if (error instanceof MintIdError)
            return err(400, { error: 'Could not mint an object id', detail: error.message });
          throw error;
        }
      }
      const body = {
        section: {
          ...deepClone(parsedStpl.data.blueprint),
          // Deterministic per recipe: the wrapper holds exactly one instance,
          // so the id needs no per-target variation.
          id: mintId({ kind: 'section_instance' }, `${stplRecord.object_id}/standalone`),
        },
      };

      if (request.dry_run) {
        const check = validateObjectIdForType('section', requestedId);
        if (!check.ok) return err(400, { error: 'Invalid requested_id', detail: check.error });
        const groups = validateObject({ objectType: 'section', objectId: requestedId, body }, context);
        const summary = summarizeValidation(groups);
        const idTaken = Boolean(await store.get(objectRecordKey('section', requestedId)));
        return ok({
          dry_run: true,
          instantiated_from: stplRecord.object_id,
          object_id: requestedId,
          id_available: !idTaken,
          body,
          validation: groups,
          summary,
        });
      }

      const result = await handleObjectVerb(
        store,
        {
          action: 'create',
          object_type: 'section',
          site: stplRecord.site,
          body,
          requested_id: requestedId,
        },
        principal,
        options
      );
      if (result.status !== 200) return result;
      return ok({ ...result.body, instantiated_from: stplRecord.object_id });
    }

    case 'apply_theme': {
      // The theme must EXIST (draft is fine) and parse as theme.v1; the site
      // record must exist and parse as site.v1 (the diff needs its current
      // brandTokens).
      //
      // W16 C1 (§4/§5): a theme MAY also carry brandImagery, but this verb's
      // copy stays brandTokens-only (colors/fonts/axes) — deliberate, not an
      // oversight. brandTokens' exact-replace semantics need a per-KEY
      // stale-unset diff (see below); brandImagery has no equivalent
      // key-by-key merge target (styleSentence/medium/seedBase are single
      // scalars, palette/negative are whole-list replacements, aspectRatios
      // is an open-keyed record) — copying it faithfully is a separate,
      // non-trivial feature, not a small extension of the brandTokens path.
      // A theme's brandImagery is preset data for a future writer, unused
      // by apply_theme today.
      const themeRecord = await loadRecord(store, objectRecordKey('theme', request.theme_id));
      if (!themeRecord) {
        return err(404, { error: 'Theme not found', not_found: true, theme_id: request.theme_id });
      }
      const parsedTheme = themeBodySchema.safeParse(themeRecord.body);
      if (!parsedTheme.success) {
        return err(422, {
          error: 'Theme body does not parse as theme.v1 — fix the theme before applying.',
          theme_id: request.theme_id,
          issues: parsedTheme.error.issues,
        });
      }
      // The theme must be TOTAL to be appliable: exact-replace would DELETE
      // any consumed key the theme lacks from site.brandTokens, silently
      // rendering fallback literals instead of the palette. The theme_token_keys
      // rule only BLOCKS at theme publish (drafts warn) — and apply doesn't
      // require a published theme — so the funnel enforces it here.
      const missingKeys = THEME_COLOR_KEYS.filter((key) => typeof parsedTheme.data.tokens.colors[key] !== 'string');
      if (missingKeys.length > 0) {
        return err(422, {
          error: `Theme "${request.theme_id}" is not total: missing consumed color key(s) ${missingKeys.join(', ')} — applying it would delete them from site.brandTokens and render fallback literals. Complete the theme first.`,
          theme_id: request.theme_id,
          missing_keys: missingKeys,
        });
      }

      const siteRecord = await loadRecord(store, objectRecordKey('site', request.site_id));
      if (!siteRecord) {
        return err(404, { error: 'Site not found', not_found: true, object_id: request.site_id });
      }
      const parsedSite = siteBodySchema.safeParse(siteRecord.body);
      if (!parsedSite.success) {
        return err(422, {
          error: 'Site body does not parse as site.v1 — heal it before applying a theme.',
          object_id: request.site_id,
          issues: parsedSite.error.issues,
        });
      }

      // Exact-replace semantics: after the apply, site.brandTokens EQUALS the
      // theme's tokens. `fields` deep-merges, so every color key the site
      // carries but the theme doesn't must be explicitly unset (null) — the
      // stale-palette leak a hand-written brandTokens patch would make (§6.4).
      // brandTokens rides the privileged set_site_brand_tokens op — set_site_fields
      // refuses it (theme-only palette governance).
      const themeColors = parsedTheme.data.tokens.colors;
      const staleUnsets = Object.fromEntries(
        Object.keys(parsedSite.data.brandTokens.colors)
          .filter((key) => !(key in themeColors))
          .map((key) => [key, null])
      );
      // T10.2: exact-replace extends to the T10.1 axes at axis-key
      // granularity — a theme axis present is copied; an axis (or a whole
      // group) the theme lacks is UNSET on the site, so the code-side
      // defaults win (a theme MAY omit axes; omission means "the default
      // look", never "keep whatever the site had").
      const axisFields: Record<string, Record<string, string | null> | null> = {};
      for (const group of THEME_AXIS_GROUPS) {
        const themeGroup: Record<string, string | undefined> = parsedTheme.data.tokens[group] ?? {};
        const siteGroup: Record<string, string | undefined> | undefined = parsedSite.data.brandTokens[group];
        const themeAxes = Object.fromEntries(
          Object.entries(themeGroup).filter(([, value]) => typeof value === 'string')
        ) as Record<string, string>;
        if (Object.keys(themeAxes).length === 0) {
          // Theme carries nothing for this group — unset it if the site has it.
          if (siteGroup !== undefined) axisFields[group] = null;
          continue;
        }
        const staleAxisUnsets = Object.fromEntries(
          Object.keys(siteGroup ?? {})
            .filter((key) => !(key in themeAxes))
            .map((key) => [key, null])
        );
        axisFields[group] = { ...staleAxisUnsets, ...themeAxes };
      }
      const op = {
        op: 'set_site_brand_tokens',
        fields: {
          brandTokens: {
            colors: { ...staleUnsets, ...themeColors },
            fonts: { ...parsedTheme.data.tokens.fonts },
            ...axisFields,
          },
        },
      };

      if (request.dry_run) {
        const validation = validateCandidatePatch(siteRecord, [op], context, ['set_site_brand_tokens']);
        return ok({
          dry_run: true,
          applied_theme: themeRecord.object_id,
          object_id: request.site_id,
          op,
          eligible: validation.eligible,
          validation: validation.groups,
          apply_error: validation.applyError,
        });
      }

      // T9.18 (§8 matrix): a REAL apply by a HUMAN requires the Owner tier —
      // dry_run stays open to any admin (preview is a read). Agent principals
      // are unchanged (no roles by design; gated by the approval machinery
      // and the privileged-op funnel — the W8.4 production path).
      if (principal.kind === 'human' && !(options.roles ?? []).includes('owner')) {
        return err(403, { error: 'Applying a theme requires the Owner role.' });
      }

      // A REAL apply needs the caller's site checkout (schema-optional only
      // so dry_run can omit them).
      if (request.lock_token === undefined || request.expected_record_version === undefined) {
        return err(400, {
          error:
            'Applying a theme requires lock_token and expected_record_version from YOUR site checkout (only dry_run: true works without them).',
        });
      }

      // ONE op = one atomic content_revision bump; the history entry carries
      // the theme provenance; the exact inverse (fields capture) makes
      // "revert the theme" a standard Discard.
      const result = await handleObjectVerb(
        store,
        {
          action: 'patch',
          object_type: 'site',
          object_id: request.site_id,
          lock_token: request.lock_token,
          expected_record_version: request.expected_record_version,
          ops: [op],
        },
        principal,
        {
          ...options,
          patchEntryDetails: { applied_theme: themeRecord.object_id },
          // The palette writer is not agent-submittable; only THIS verb applies it.
          privilegedOps: ['set_site_brand_tokens'],
        }
      );
      if (result.status !== 200) return result;
      return ok({ ...result.body, applied_theme: themeRecord.object_id });
    }

    case 'checkout': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const result = await checkoutObjectLock(store, key, {
        actor: principal,
        leaseSeconds: request.lease_seconds,
        nowMs: ts,
      });
      // Surface the post-checkout version so the client can patch immediately
      // (lock writes bump version, D§3.1); the T0.5 library body omits it.
      return withRecordVersion(result);
    }

    case 'refresh_lock': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const result = await refreshObjectLock(store, key, {
        actor: principal,
        lockToken: request.lock_token,
        leaseSeconds: request.lease_seconds,
        nowMs: ts,
      });
      return withRecordVersion(result);
    }

    case 'checkin': {
      const key = objectRecordKey(request.object_type, request.object_id);
      if (request.force) {
        // Owner-only lock takeover (OQ-W9-8). Delegates to the tested
        // force-release path: previous-owner history, version bump, and
        // content_revision is never touched.
        if (!(options.roles ?? []).includes('owner')) {
          return err(403, { error: 'Force check-in requires the owner role.' });
        }
        const forced = await forceReleaseObjectLock(store, key, { actor: principal, nowMs: ts });
        return withRecordVersion(forced);
      }
      if (!request.lock_token) {
        return err(400, { error: 'checkin requires lock_token (or force for an owner).' });
      }
      const result = await checkinObjectLock(store, key, {
        actor: principal,
        lockToken: request.lock_token,
        nowMs: ts,
      });
      return withRecordVersion(result);
    }

    case 'patch': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      // Lock precondition (423): you must hold the live lock to mutate.
      if (!record.lock || record.lock.token !== request.lock_token || !isObjectLockActive(record.lock, ts)) {
        return err(423, { error: 'Lock required', locked: true, lock: sanitizeObjectLock(record.lock) });
      }
      // Optimistic concurrency (409): your view must be current.
      if (record.version !== request.expected_record_version) {
        return err(409, {
          error: 'Record version conflict',
          expected_record_version: request.expected_record_version,
          actual_record_version: record.version,
        });
      }

      // S4x (2/2): the canvas Ask-AI proposal trail rides as one marker entry
      // in the SAME ops array the save already sends — pull it out before
      // minting/applying so it is never itself a patch op and never reaches
      // the engine (it does not touch the object body or history[].details).
      // It ships to agent-learning only after the REST of the ops persist.
      const learningOps = request.ops.filter(isAgentLearningTrailOp);
      const contentOps = request.ops.filter((op) => !isAgentLearningTrailOp(op));

      let minted: MintedId[];
      let normalizedOps: unknown[];
      try {
        const result = mintOpsIds(contentOps);
        normalizedOps = result.ops;
        minted = result.minted;
      } catch (error) {
        if (error instanceof MintIdError)
          return err(400, { error: 'Could not mint an id for a patch op', detail: error.message });
        throw error;
      }
      // D3-sharedref: after ids are minted (so upsert_section always has a
      // section.id to address) but before the engine applies anything —
      // stamps data.sectionName on any op that creates/touches a shared_ref
      // section, reading the CURRENT (pre-patch) record for update_section_data.
      normalizedOps = stampSharedRefSectionNames(normalizedOps, record.body, context);

      let appliedRecord: ObjectRecord;
      try {
        const applied = applyPatchOps(record, normalizedOps, {
          actor: principal,
          at: timestamp,
          ...(options.patchEntryDetails ? { entryDetails: options.patchEntryDetails } : {}),
          ...(options.privilegedOps ? { privilegedOps: options.privilegedOps } : {}),
        });
        appliedRecord = applied.record;
      } catch (error) {
        if (error instanceof PatchApplyError) {
          return err(patchErrorStatus(error.code), {
            error: 'Patch could not be applied',
            code: error.code,
            message: error.message,
            details: error.details,
            minted,
          });
        }
        throw error;
      }

      const groups = validateObject(
        {
          objectType: request.object_type,
          objectId: request.object_id,
          body: appliedRecord.body,
          published: record.publication.published_time != null,
        },
        context
      );
      const summary = summarizeValidation(groups);
      if (!summary.eligible) {
        // Hard-fail rejects the op and does NOT persist (C§2.0) — a pending
        // learning trail is discarded right along with it: no orphaned
        // record for a change that never landed.
        return err(422, {
          error: 'Validation failed',
          validation: groups,
          blockers: summary.blockers,
          record_version_unchanged: record.version,
          minted,
        });
      }

      await store.setJSON(key, appliedRecord);

      // Ship the trail ONLY now that the save it describes has actually
      // persisted — atomic with the save (one call from the caller, not a
      // separate request ahead of it). Absent agentLearningStore (the
      // publish-key agent path never wires one): the trail is dropped, not
      // queued — it was never anything but ops-array cargo for this one call.
      if (learningOps.length > 0 && options.agentLearningStore) {
        const learningRecord: AgentLearningRecord = {
          object_id: request.object_id,
          object_type: request.object_type,
          site: record.site,
          saved_at: timestamp,
          editor: principal,
          proposals: learningOps.flatMap((op) => op.proposals),
          ...(learningOps.some((op) => (op.manual_edits?.length ?? 0) > 0)
            ? { manual_edits: learningOps.flatMap((op) => op.manual_edits ?? []) }
            : {}),
        };
        await options.agentLearningStore.setJSON(
          agentLearningRecordKey(request.object_type, request.object_id, timestamp),
          learningRecord
        );
      }

      return ok({
        version: appliedRecord.version,
        content_revision: appliedRecord.content_revision,
        minted,
        validation_summary: summary,
      });
    }

    case 'validate': {
      // Mode (2): no object_id yet — dry-run a CANDIDATE body through the
      // identical checks object_create would run (id pattern/availability,
      // singleton conflict, schema, references, structural invariants),
      // without persisting anything. This is the ONLY way to learn whether a
      // body is valid before an object_id exists to validate against — the
      // gap that previously forced an agent to attempt a real object_create
      // just to learn its body was invalid (400 object_id required / 404 not
      // found on a pre-create validate attempt).
      if (request.object_id === undefined) {
        if (request.body === undefined) {
          return err(400, {
            error:
              'validate requires either object_id (validate an existing object, optionally with candidate_patch) ' +
              'or body (dry-run a candidate object that has no object_id yet).',
          });
        }
        if (request.candidate_patch && request.candidate_patch.length > 0) {
          return err(400, {
            error:
              'candidate_patch applies ops to an EXISTING record and requires object_id. To validate a brand-new ' +
              'body, pass body with no object_id and no candidate_patch.',
          });
        }

        const objectType = request.object_type;
        let objectIdValue: string;
        if (request.requested_id) {
          const check = validateObjectIdForType(objectType, request.requested_id);
          if (!check.ok) return err(400, { error: 'Invalid requested_id', detail: check.error });
          objectIdValue = request.requested_id;
        } else {
          try {
            objectIdValue =
              objectType === 'content_item'
                ? mintId(
                    { kind: 'content_item', yyyymmdd: timestamp.slice(0, 10).replaceAll('-', '') },
                    seedForCreate(objectType, request.body)
                  )
                : mintId({ kind: 'object', objectType }, seedForCreate(objectType, request.body));
          } catch (error) {
            if (error instanceof MintIdError)
              return err(400, { error: 'Could not mint an object id', detail: error.message });
            throw error;
          }
        }

        const idTaken = Boolean(await store.get(objectRecordKey(objectType, objectIdValue)));

        const singleton = SINGLETON_TYPES[objectType];
        let singletonConflict: { object_id: string | undefined; label: string; editOp: string } | undefined;
        if (singleton) {
          const existing = await collectBlobListItems(
            await store.list({ prefix: objectStatusIndexPrefix(objectType, 'active') })
          );
          if (existing.length > 0) {
            singletonConflict = {
              object_id: existing[0]!.key.split('/').at(-1),
              label: singleton.label,
              editOp: singleton.editOp,
            };
          }
        }

        const groups = validateObject({ objectType, objectId: objectIdValue, body: request.body }, context);
        const summary = summarizeValidation(groups);
        return ok({
          dry_run: true,
          object_type: objectType,
          object_id: objectIdValue,
          id_available: !idTaken,
          ...(singletonConflict
            ? {
                singleton_conflict: {
                  ...singletonConflict,
                  note: `A ${singletonConflict.label} singleton already exists (${singletonConflict.object_id}) — a real object_create would be refused (409); edit the existing one via ${singletonConflict.editOp} instead.`,
                },
              }
            : {}),
          body: request.body,
          validation: groups,
          summary,
        });
      }

      // Mode (1): object_id present — validate (or dry-run a candidate_patch
      // against) an EXISTING record, unchanged since T0.8/T-2.
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      if (request.candidate_patch && request.candidate_patch.length > 0) {
        let minted: MintedId[];
        let normalizedOps: unknown[];
        try {
          const result = mintOpsIds(request.candidate_patch);
          normalizedOps = result.ops;
          minted = result.minted;
        } catch (error) {
          if (error instanceof MintIdError)
            return err(400, { error: 'Could not mint an id for a candidate op', detail: error.message });
          throw error;
        }
        const validation = validateCandidatePatch(record, normalizedOps, context);
        return ok({
          eligible: validation.eligible,
          validation: validation.groups,
          apply_error: validation.applyError,
          minted,
        });
      }

      const groups = validateObject(
        {
          objectType: request.object_type,
          objectId: request.object_id,
          body: record.body,
          published: record.publication.published_time != null,
        },
        context
      );
      return ok({ validation: groups, summary: summarizeValidation(groups) });
    }

    // ─── T1.4 review-state wiring (UI wiring only; no gate/review logic
    // lives here — everything below calls straight into the already-built
    // T1.3/T1.4 pure functions) ────────────────────────────────────────────

    case 'submit_review': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });
      if (!record.lock || record.lock.token !== request.lock_token || !isObjectLockActive(record.lock, ts)) {
        return err(423, { error: 'Lock required', locked: true, lock: sanitizeObjectLock(record.lock) });
      }

      const result = submitReview(record, {
        actor: principal,
        at: timestamp,
        note: request.note,
        requested_publish_action: request.requested_publish_action,
      });
      if (!result.ok) return err(result.status, result.body);

      await store.setJSON(key, result.record);
      return ok({ ...result.body, version: result.record.version, content_revision: result.record.content_revision });
    }

    case 'review_decide': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      const result = decideReview(record, {
        actor: principal,
        actorRoles: options.roles ?? resolveRolesForPrincipal(principal),
        at: timestamp,
        decision: request.decision,
        note: request.note,
        publish_action: request.publish_action,
        approval_pin: request.approval_pin,
      });
      if (!result.ok) return err(result.status, result.body);

      await store.setJSON(key, result.record);
      return ok({ ...result.body, version: result.record.version, content_revision: result.record.content_revision });
    }

    case 'discard': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });
      if (!record.lock || record.lock.token !== request.lock_token || !isObjectLockActive(record.lock, ts)) {
        return err(423, { error: 'Lock required', locked: true, lock: sanitizeObjectLock(record.lock) });
      }

      const result = discardProposal(record, { entries: request.entries, actor: principal, at: timestamp });
      if (!result.ok) return err(result.status, result.body);

      await store.setJSON(key, result.record);
      return ok({ ...result.body, version: result.record.version, content_revision: result.record.content_revision });
    }

    case 'purge_archived': {
      // Owner-only: this is the one irreversible verb in the system.
      if (!(options.roles ?? []).includes('owner')) {
        return err(403, { error: 'Purging archived objects requires the owner role.' });
      }
      const result = await purgeArchivedObjects(
        store as unknown as Parameters<typeof purgeArchivedObjects>[0],
        {
          ...(request.dry_run !== undefined ? { dry_run: request.dry_run } : {}),
          ...(request.grace_days !== undefined ? { grace_days: request.grace_days } : {}),
        },
        { nowMs: ts }
      );
      return ok(result as unknown as Record<string, unknown>);
    }

    case 'retire': {
      // W14 F6. The heavy lifting (lock, review, references, export removal,
      // redirect, archive) is in object-retire.ts; this wires it to the store
      // and reuses the publish deps, since a retire is an export-commit too.
      const referrerIndex = async (): Promise<(objectType: ObjectType, objectId: string) => string[]> => {
        // A retire is rare and the sweep is bounded by the fleet's own inventory,
        // so the simple approach — read every active record once and look for the
        // id — is the honest one. It catches nav→page, page→section, site→nav.
        const all = await listAllObjectRecords(store, { status: 'active' });
        return (objectType, objectId) =>
          all
            .filter((candidate) => candidate.object_id !== objectId)
            .filter((candidate) => JSON.stringify(candidate.body ?? {}).includes(`"${objectId}"`))
            .map((candidate) => candidate.object_id);
      };

      const existingRedirects = await loadSiteRedirects(store);

      const result = await retireObject(
        store as unknown as Parameters<typeof retireObject>[0],
        {
          object_type: request.object_type,
          object_id: request.object_id,
          lock_token: request.lock_token,
          actor: principal,
          ...(request.redirect_to !== undefined ? { redirect_to: request.redirect_to } : {}),
          ...(request.reason !== undefined ? { reason: request.reason } : {}),
        },
        {
          nowMs: ts,
          findReferrers: await referrerIndex(),
          existingRedirects,
          ...options.publishDeps,
        }
      );
      return { status: result.status, body: result.body };
    }

    case 'publish_by_time': {
      const key = objectRecordKey(request.object_type, request.object_id);
      const record = await loadRecord(store, key);
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      const gate = checkPublishGate({
        record,
        principal,
        roles: resolveRolesForPrincipal(principal),
        requested: {
          published_time: request.published_time,
          ...(request.artifact_set !== undefined ? { artifact_set: request.artifact_set } : {}),
          ...(request.release_build !== undefined ? { release_build: request.release_build } : {}),
        },
        policy: options.approvalPolicy,
      });
      if (!gate.allow)
        return err(gate.status, { error: gate.reason, code: gate.code, requires_approval: gate.requires_approval });

      const result = await publishObject(
        store,
        {
          object_type: request.object_type,
          object_id: request.object_id,
          published_time: request.published_time,
          lock_token: request.lock_token,
          actor: principal,
          ...(request.producer ? { producer: request.producer } : {}),
        },
        { nowMs: ts, validationContext: context, ...options.publishDeps }
      );
      return { status: result.status, body: result.body };
    }

    // ─── W15 S4 (MVP): Marginalia ────────────────────────────────────────────
    case 'marginalia_create': {
      const denied = marginaliaDenied(principal, options.roles);
      if (denied) return denied;
      if (!options.marginaliaStore) {
        return err(500, { error: 'Marginalia store is not configured for this endpoint.' });
      }
      const record = await loadRecord(store, objectRecordKey(request.object_type, request.object_id));
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      const { thread, comment } = await createMarginaliaThread(options.marginaliaStore, {
        objectType: request.object_type,
        objectId: request.object_id,
        anchor: {
          ...(request.section_id !== undefined ? { sectionId: request.section_id } : {}),
          ...(request.node_id !== undefined ? { nodeId: request.node_id } : {}),
          ...(request.field !== undefined ? { field: request.field } : {}),
          ...(request.selected_text !== undefined ? { selectedText: request.selected_text } : {}),
        },
        body: request.body,
        author: principal,
        at: timestamp,
        contentRevision: record.content_revision,
      });
      return ok({ thread: { ...thread, comments: [comment] } });
    }

    case 'marginalia_reply': {
      const denied = marginaliaDenied(principal, options.roles);
      if (denied) return denied;
      if (!options.marginaliaStore) {
        return err(500, { error: 'Marginalia store is not configured for this endpoint.' });
      }
      const record = await loadRecord(store, objectRecordKey(request.object_type, request.object_id));
      if (!record) return err(404, { error: 'Object record not found', not_found: true });

      const result = await addMarginaliaComment(options.marginaliaStore, {
        objectType: request.object_type,
        objectId: request.object_id,
        threadId: request.thread_id,
        body: request.body,
        author: principal,
        at: timestamp,
        contentRevision: record.content_revision,
        ...(request.parent_comment_id !== undefined ? { parentCommentId: request.parent_comment_id } : {}),
      });
      if (!result.ok) return err(404, { error: 'Thread not found', not_found: true });
      return ok({ comment: result.comment });
    }

    case 'marginalia_list': {
      if (!options.marginaliaStore) {
        return err(500, { error: 'Marginalia store is not configured for this endpoint.' });
      }
      // Read-only — no role/agent gate, same posture as object_get/object_list.
      const threads = await listMarginaliaThreads(options.marginaliaStore, request.object_type, request.object_id);
      return ok({ threads });
    }

    case 'marginalia_resolve': {
      const denied = marginaliaDenied(principal, options.roles);
      if (denied) return denied;
      if (!options.marginaliaStore) {
        return err(500, { error: 'Marginalia store is not configured for this endpoint.' });
      }
      const result = await setMarginaliaThreadStatus(options.marginaliaStore, {
        objectType: request.object_type,
        objectId: request.object_id,
        threadId: request.thread_id,
        status: request.status,
      });
      if (!result.ok) return err(404, { error: 'Thread not found', not_found: true });
      return ok({ thread: result.thread });
    }
  }
};
