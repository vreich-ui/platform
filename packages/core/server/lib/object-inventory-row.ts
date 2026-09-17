/**
 * The inventory ROW — what a row is, and how a record becomes one.
 *
 * Split out of `object-inventory.ts` in M3.3, the cut that file's own bundle
 * note has been naming since M0: `objects/index-doc.ts` projects a row on every
 * record write, and `membership/offboarding.ts` is a choke-point caller, so
 * `admin-users` — a function that LISTS PEOPLE — statically reached the filter,
 * sort and detail vocabulary too. `object-inventory.ts` keeps those and
 * re-exports this file whole, so no existing import moved.
 *
 * INTEGRATE (wave 2): `objectDisplayName` comes from the LEAF
 * `lib/admin/display-name-core.ts`, not from `lib/admin/display-name.ts`. M3.2
 * made that split for the same cold start this file exists for, and the two
 * spellings compile identically — only the `-core` one is on the diet.
 */
import { isObjectLockActive, sanitizeObjectLock } from './object-lock-view.js';
import {
  activeApprovalPolicy,
  isGovernedObjectType,
  publishRequiresApproval,
  type ApprovalPolicy,
} from '../../lib/approval-policy.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';
import { objectDisplayName } from '../../lib/admin/display-name-core.js';
import { effectiveApproval, type EffectiveApproval } from './review-approval.js';

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

/**
 * W4.1 — the VARIANTS index: the `content_item` body facts `/admin/variants`
 * needs to group a family, carried on the row so the page reads the inventory
 * ONCE instead of one `object_get` per article (measured live: 40
 * `admin-object` invocations, each warm, all paying the ~250-400 ms fixed
 * per-invocation overhead). Same move as the W8.3b recipe summary above — a
 * row answers what the browse surface is actually asking.
 *
 * Nulls, never absent keys, for the two scalars: "declares no parent" must not
 * look like "this row predates the projection". It cannot — the index rebuilds
 * on the schema bump (`objects/index-store.ts`).
 */
export type InventoryContentSummary = {
  /** `body.slug` — the permalink tail the variants table shows next to a name. */
  slug: string | null;
  /** `body.lineage.parent_content_id` — set on clones, null on a parent. The ONLY variant→parent link. */
  parent_content_id: string | null;
  /** The judged-score digest, omitted entirely when the record carries none (most do). */
  scores?: InventoryScoreDigestEntry[];
};

/** One digest entry — `contentItemScoreSchema`'s field set, minus nothing the surface reads. */
export type InventoryScoreDigestEntry = {
  scored_by: string;
  at: string;
  framework: string;
  dimension: string;
  score: number;
  rationale?: string;
};

/**
 * `body.scores[]` reduced to the LATEST entry per `(framework, dimension)`.
 *
 * Not the whole array: scores are append-only by design (12-plan §15.3 rule 1)
 * so it grows without bound, while `variant-experiments.ts:judgementRows`
 * performs exactly this reduction itself and throws the rest away. Doing it
 * here bounds what every OTHER inventory consumer now carries. The tie rule is
 * `judgementRows`' own (`score.at >= …` keeps the later entry) and the drop
 * rule is the client's own, so the digest and a full record read produce
 * identical judgement rows.
 */
const scoreDigestFromBody = (body: Record<string, unknown>): InventoryScoreDigestEntry[] => {
  if (!Array.isArray(body.scores)) return [];
  const latest = new Map<string, InventoryScoreDigestEntry>();
  for (const entry of body.scores) {
    if (!isRecord(entry)) continue;
    const framework = typeof entry.framework === 'string' ? entry.framework : '';
    const dimension = typeof entry.dimension === 'string' ? entry.dimension : '';
    const score = typeof entry.score === 'number' ? entry.score : Number.NaN;
    if (!framework || !dimension || !Number.isFinite(score)) continue;
    const at = typeof entry.at === 'string' ? entry.at : '';
    const key = `${framework}\u0000${dimension}`;
    if (at < (latest.get(key)?.at ?? '')) continue;
    latest.set(key, {
      scored_by: typeof entry.scored_by === 'string' ? entry.scored_by : '',
      at,
      framework,
      dimension,
      score,
      ...(typeof entry.rationale === 'string' ? { rationale: entry.rationale } : {}),
    });
  }
  return [...latest.values()];
};

/** Defensive, exactly like `recipeSummaryFromBody`: a half-healed draft body yields nulls, never a throw. Undefined for every type but `content_item`. */
export const contentSummaryFromBody = (
  objectType: ObjectRecord['object_type'],
  body: unknown
): InventoryContentSummary | undefined => {
  if (objectType !== 'content_item') return undefined;
  const record = isRecord(body) ? body : {};
  const lineage = isRecord(record.lineage) ? record.lineage : {};
  const scores = scoreDigestFromBody(record);
  return {
    slug: stringOrNull(record.slug),
    parent_content_id: stringOrNull(lineage.parent_content_id),
    ...(scores.length ? { scores } : {}),
  };
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
  /** Present on content_item rows only — the W4.1 variants index. */
  content?: InventoryContentSummary;
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
  const content = contentSummaryFromBody(record.object_type, record.body);
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
    ...(content ? { content } : {}),
  };
};

