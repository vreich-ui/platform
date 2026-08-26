/**
 * Object inventory (Part 2 of the agent-editability push) — the read-only
 * "what exists and what state is it in" view over the object store, for
 * agents deciding what to edit next and for humans auditing pending work.
 *
 * Pure derivation over ObjectRecord envelopes: no writes, no new stored
 * state. Every field is computed from what the T0.5/T1.3 verbs already
 * persist — in particular `unpublished_changes` works because the publish
 * receipt (T1.3) stamps the `content_revision` it materialized, so a record
 * whose current revision is ahead of its receipt has changes the live site
 * has not seen.
 */
import { isObjectLockActive, sanitizeObjectLock } from './object-lock.js';
import {
  activeApprovalPolicy,
  isGovernedObjectType,
  publishRequiresApproval,
  type ApprovalPolicy,
} from '../../lib/approval-policy.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';
import { objectDisplayName } from '../../lib/admin/display-name.js';
import { effectiveApproval, type EffectiveApproval } from './review-state.js';

export type InventoryReviewState = 'none' | 'open' | 'changes_requested' | 'approved';
export type InventoryApprovalState = EffectiveApproval['state'];

export type InventoryLockState =
  | { held: false }
  | { held: true; owner_id: string; owner_label: string; acquired_at: string; expires_at: string };

/**
 * The reuse-first index (W8.3b): a recipe row's one-line self-description,
 * derived from the body's recipe metadata so an agent answers "what recipes
 * exist and which fits?" from ONE inventory call instead of fetching bodies.
 * Nulls signal incomplete metadata (drafts; pre-backfill records) — the
 * recipe_metadata criterion blocks publish until they fill in.
 */
export type InventoryRecipeSummary = {
  name: string | null;
  scope: 'evergreen' | 'one_off' | null;
  description: string | null;
  /** Body key is `whenToUse`; rows are snake_case. */
  when_to_use: string | null;
  /** section_template: the blueprint's section type. */
  blueprint_type?: string | null;
  /** template: the PageTypes this recipe may start. */
  applies_to?: string[];
  /** template: how many slots the recipe carries. */
  slot_count?: number | null;
};

const RECIPE_TYPES = new Set(['template', 'section_template', 'theme']);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value : null);

/**
 * Defensive plain-object reads (no zod): a half-healed draft body yields
 * nulls instead of throwing, so a malformed record can never break an
 * inventory sweep. Returns undefined for non-recipe types.
 */
export const recipeSummaryFromBody = (
  objectType: ObjectRecord['object_type'],
  body: unknown
): InventoryRecipeSummary | undefined => {
  if (!RECIPE_TYPES.has(objectType)) return undefined;
  const record = isRecord(body) ? body : {};
  const summary: InventoryRecipeSummary = {
    name: stringOrNull(record.name),
    scope: record.scope === 'evergreen' || record.scope === 'one_off' ? record.scope : null,
    description: stringOrNull(record.description),
    when_to_use: stringOrNull(record.whenToUse),
  };
  if (objectType === 'section_template') {
    summary.blueprint_type =
      isRecord(record.blueprint) && typeof record.blueprint.type === 'string' ? record.blueprint.type : null;
  }
  if (objectType === 'template') {
    summary.applies_to = Array.isArray(record.appliesTo)
      ? record.appliesTo.filter((entry): entry is string => typeof entry === 'string')
      : [];
    summary.slot_count = Array.isArray(record.slots) ? record.slots.length : null;
  }
  return summary;
};

export type InventoryRow = {
  object_id: string;
  object_type: ObjectRecord['object_type'];
  /** Human display name derived from the body (T9.2) — browse surfaces show this, never the id. */
  display_name: string;
  /** Record last-updated timestamp, mirrored so browse surfaces can sort by it without a detail fetch. */
  updated_at: string;
  status: ObjectRecord['status'];
  /**
   * Whether publishing this type currently requires human approval, per the
   * configured approval policy (src/config/approval-policy.ts). Always false
   * for content_item, which the generic gate does not serve.
   */
  requires_approval: boolean;
  version: number;
  content_revision: number;
  review_state: InventoryReviewState;
  /** Current approval currency, derived from the pinned decision revision. */
  approval_state: InventoryApprovalState;
  lock: InventoryLockState;
  published_time: string | null;
  /** The content_revision the last publish materialized (from the receipt), or null if never published / receipt lacks it. */
  published_content_revision: number | null;
  /** Safe export commit identifier used only for production-live comparison. */
  publish_commit: string | null;
  /**
   * True when the live site has not seen the current body: never published,
   * or content_revision has moved past the receipt's. A published record
   * whose receipt lacks a numeric content_revision reports true
   * (conservative — we cannot prove the live export is current).
   */
  unpublished_changes: boolean;
  /** Present on recipe rows only (template / section_template / theme) — the W8.3b reuse-first index. */
  recipe?: InventoryRecipeSummary;
};

export type InventoryDetail = InventoryRow & {
  schema_version: string;
  site: string;
  created_at: string;
  updated_at: string;
  review: ObjectRecord['review'] | null;
  publish_receipt: Record<string, unknown> | null;
  history_length: number;
};

export type InventoryFilters = {
  requires_approval?: boolean;
  review_state?: InventoryReviewState;
  pending_changes?: boolean;
  status?: 'active' | 'archived';
};

const publishedContentRevision = (record: ObjectRecord): number | null => {
  const receipt = record.publication.publish_receipt;
  const revision = receipt?.content_revision;
  return typeof revision === 'number' ? revision : null;
};

/**
 * The lock half of a row, split out for T5.1 R3: it is the ONE field of an
 * `InventoryRow` that depends on the current time rather than on the record
 * alone (a lease expires without anything being written), so
 * `objects/index-store.ts` caches the raw lease and re-derives this per read
 * instead of caching a `held` boolean that would silently go wrong.
 */
export const inventoryLockState = (lock: ObjectRecord['lock'], atMs: number): InventoryLockState => {
  const sanitized = isObjectLockActive(lock, atMs) ? sanitizeObjectLock(lock) : undefined;
  return sanitized
    ? {
        held: true,
        owner_id: sanitized.owner_id,
        owner_label: sanitized.owner_label,
        acquired_at: sanitized.acquired_at,
        expires_at: sanitized.expires_at,
      }
    : { held: false };
};

export const inventoryRowFromRecord = (
  record: ObjectRecord,
  atMs: number,
  policy: ApprovalPolicy = activeApprovalPolicy()
): InventoryRow => {
  const publishedTime = record.publication.published_time;
  const receiptRevision = publishedContentRevision(record);
  const recipe = recipeSummaryFromBody(record.object_type, record.body);
  return {
    object_id: record.object_id,
    object_type: record.object_type,
    display_name: objectDisplayName(record),
    updated_at: record.updated_at,
    status: record.status,
    requires_approval: isGovernedObjectType(record.object_type)
      ? publishRequiresApproval(record.object_type, policy)
      : false,
    version: record.version,
    content_revision: record.content_revision,
    review_state: record.review?.state ?? 'none',
    approval_state: effectiveApproval(record).state,
    lock: inventoryLockState(record.lock, atMs),
    published_time: publishedTime,
    published_content_revision: receiptRevision,
    publish_commit: record.publication.publish_receipt?.commit_sha ?? null,
    unpublished_changes:
      publishedTime === null || publishedTime === undefined
        ? true
        : receiptRevision === null || receiptRevision !== record.content_revision,
    ...(recipe ? { recipe } : {}),
  };
};

export const inventoryDetailFromRecord = (
  record: ObjectRecord,
  atMs: number,
  policy?: ApprovalPolicy
): InventoryDetail => ({
  ...inventoryRowFromRecord(record, atMs, policy),
  schema_version: record.schema_version,
  site: record.site,
  created_at: record.created_at,
  updated_at: record.updated_at,
  review: record.review ?? null,
  publish_receipt: record.publication.publish_receipt ?? null,
  history_length: record.history.length,
});

export const matchesInventoryFilters = (row: InventoryRow, filters: InventoryFilters): boolean => {
  if (filters.status !== undefined && row.status !== filters.status) return false;
  if (filters.requires_approval !== undefined && row.requires_approval !== filters.requires_approval) return false;
  if (filters.review_state !== undefined && row.review_state !== filters.review_state) return false;
  if (filters.pending_changes !== undefined && row.unpublished_changes !== filters.pending_changes) return false;
  return true;
};

/** Stable output order: object_type in canonical enum order, then object_id. */
export const compareInventoryRows =
  (typeOrder: readonly string[]) =>
  (a: InventoryRow, b: InventoryRow): number => {
    const typeDelta = typeOrder.indexOf(a.object_type) - typeOrder.indexOf(b.object_type);
    if (typeDelta !== 0) return typeDelta;
    return a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0;
  };
