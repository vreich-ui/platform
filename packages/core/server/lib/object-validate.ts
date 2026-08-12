/**
 * Generic object validation engine — the six C§2.0 safety checks as a
 * composable pipeline (03-mapping-and-agent-contract.md §2.0 item list).
 *
 * An agent write is "eligible for review" only if none of the checks report a
 * `missing` (hard-failure) criterion. The same report is produced two ways per
 * the contract: `object_patch` rejects the op when any criterion is `missing`;
 * `object_validate` returns the full grouped report as a dry-run. Both call
 * `validateObject`; the caller decides via `summarizeValidation`.
 *
 * The report reuses the exact readiness-report shape and status vocabulary from
 * src/lib/admin/readiness-criteria.ts (A§1.6) — grouped criteria, each
 * `complete | warning | missing | optional`, no numeric score.
 *
 * Reuse over reinvention (per the brief):
 *   - check 1 schema:        the T0.2 body schemas + the node-renderer RichText
 *                            allowlist (A§1.5).
 *   - check 2 id discipline: validateObjectIdForType / validateSectionInstanceId (T0.3).
 *   - check 4 reader safety: assertReaderSafe (A§1.1), generalized to any body.
 *   - check 5 artifact trust: MAJOR_KEY_ARTIFACT_REF_RE + the admin-patch-workflow
 *                            reject rules (A§2.12). admin-patch-workflow is not
 *                            imported from (its reject regexes are module-local);
 *                            the three rules are mirrored here with a citation.
 *
 * Purity: this module never touches the blob store. Reference-integrity and
 * structural checks that need to know what else exists (which pages/sections
 * are published, which taxonomy terms are active, the PageType definition) take
 * injected resolvers on ObjectValidationContext. When a resolver is absent the
 * dependent check is reported `optional` (not verifiable here) rather than
 * `missing` — T0.8 wires real resolvers; unit tests inject fakes.
 *
 * Nav *layout* rules (duplicate-target warnings, empty groups, depth ≤ 2,
 * nav-link-to-unpublished-page) were deliberately left out of T0.7 and land
 * here with T2.1 as `checkNavigationStructure`, dispatched through the same
 * structural-invariants group the page/taxonomy/template rules use.
 *
 * Candidate patches: `validateObject` validates a finished body. The
 * `object_validate {candidate_patch?}` dry-run is `validateCandidatePatch`,
 * which applies the proposed ops through T0.6's real `applyPatchOps` engine
 * (never a re-implementation) and validates the result — so a patch the engine
 * would refuse fails validation with T0.6's own error code, and the op grammar
 * has exactly one owner. T0.8 calls one or the other; this module still never
 * touches the blob store.
 */
import { assertReaderSafe } from '../../lib/article-content/assert-reader-safe.js';
import type { CriterionStatus, ReadinessCriterion, ReadinessGroup } from '../../lib/admin/readiness-criteria.js';
import { validateObjectIdForType, validateSectionInstanceId } from '../../lib/object-ids.js';
import { applyPatchOps, PatchApplyError } from '../../lib/object-patch-apply.js';
import { navigationBodySchema, type NavigationBody } from '../../schema/bodies/navigation-v1.js';
import { navActionCapacity, type CapacityRule } from '../../lib/registry/structural-capacity.js';
import { splitRichTextBlocks, splitRichTextParagraphs } from '../../lib/richtext/paragraphs.js';
import {
  PROSE_GRAMMAR,
  richTextV1Schema,
  validateRichTextGrammar,
  type RichTextGrammar,
} from '../../lib/richtext/rich-text-v1.js';
import { BLOCKS, INLINES } from '@contentful/rich-text-types';
import {
  contentItemBodySchema,
  type ContentItemBody,
  type ContentItemNode,
} from '../../schema/bodies/content-item-v1.js';
import { pageBodySchema } from '../../schema/bodies/page-v1.js';
import { productBodySchema } from '../../schema/bodies/product-v1.js';
import { sectionBodySchema, type SectionInstance, type SectionType } from '../../schema/bodies/section-v1.js';
import { sectionTemplateBodySchema } from '../../schema/bodies/section-template-v1.js';
import { themeBodySchema } from '../../schema/bodies/theme-v1.js';
import { editorialVoiceBodySchema } from '../../schema/bodies/editorial-voice-v1.js';
import { findPromptFormattedText } from '../../lib/registry/voice-prose.js';
import { isStandalonePlaceableSectionType } from '../../lib/registry/components/registered-types.js';
import {
  checkBrandTokenValue,
  THEME_AXES,
  THEME_AXIS_GROUPS,
  THEME_COLOR_KEYS,
} from '../../lib/registry/theme-tokens.js';
import {
  CONVERSION_LABEL_RE,
  GOAL_KEY_RE,
  TRACKABLE_ACTIVITIES_BY_TYPE,
} from '../../schema/bodies/tracking-attribute-v1.js';
import { trackingConfigBodySchema } from '../../schema/bodies/tracking-config-v1.js';
import { siteBodySchema } from '../../schema/bodies/site-v1.js';
import { taxonomyBodySchema } from '../../schema/bodies/taxonomy-v1.js';
import { templateBodySchema } from '../../schema/bodies/template-v1.js';
import type { ObjectRecord, ObjectType, Principal } from '../../schema/object-record-v1.js';
import { MAJOR_KEY_ARTIFACT_REF_RE, publicPathForArtifactRef, rawArtifactRefForPublicPath } from './artifact-trust.js';
import { activeMediaPolicy, type MediaPolicy } from '../../lib/media-policy.js';

export type { CriterionStatus, ReadinessCriterion, ReadinessGroup } from '../../lib/admin/readiness-criteria.js';

// ─── injected context ──────────────────────────────────────────────────────

export type ObjectResolution = { exists: boolean; published?: boolean };
export type TaxonomyResolution = { active: boolean };
export type TaxonomyUsage = { inUse: boolean };
/** Resolution of one Major-Key blobKey against the artifact index. */
export type ArtifactRefResolution = {
  exists: boolean;
  deleted?: boolean;
  sizeBytes?: number;
  contentType?: string;
  /**
   * Set when the index entry for this blobKey WAS found but failed ArtifactReference
   * validation. `exists:false` with an `indexIssue` means "the artifact's bytes may be
   * perfectly fine; platform refused its index entry" — a categorically different repair
   * from "never uploaded", and the message must say so.
   */
  indexIssue?: string;
};

export type PageTypeConstraint = {
  id?: string;
  allowedSections: readonly SectionType[] | 'any';
  requiredSections?: readonly SectionType[];
  /** Minimum visible sections to publish; defaults to 1 (W6: content_detail sets 0). */
  minVisibleSections?: number;
};

export type ObjectValidationContext = {
  /**
   * Resolve an object reference. Keys are type-namespaced, so a truthy `exists`
   * for objectType 'section' already means "exists and is a section". Return
   * undefined only if you cannot answer (treated the same as no resolver for
   * that lookup).
   */
  resolveObject?: (objectType: ObjectType, objectId: string) => ObjectResolution | undefined;
  /**
   * Resolve a taxonomy term_id OR slug, following merged_into aliases
   * (D§5.5). Slugs cannot collide with term ids (t_* ids carry underscores,
   * slugs are hyphen-only), so one resolver serves both callers: nav targets
   * pass term ids; article taxonomy (W7.3) passes the W3 frontmatter slugs.
   */
  resolveTaxonomyTerm?: (kind: 'category' | 'tag', termId: string) => TaxonomyResolution | undefined;
  /**
   * Whether a taxonomy term has live usage on published content (frontmatter
   * strings resolving to it). Used only to enforce "deprecating a term with
   * live usage requires merged_into" (§2.3-taxonomy). Absent → not verified.
   */
  resolveTaxonomyTermUsage?: (kind: 'category' | 'tag', termId: string) => TaxonomyUsage | undefined;
  /** Effective variant type of a shared 'section' object (for structural re-check). */
  resolveSharedSectionType?: (objectId: string) => SectionType | undefined;
  /**
   * Human display name of a shared 'section' object (D3-sharedref) — the
   * `objectDisplayName` derivation for that target, so the shared_ref write
   * path (object-verbs.ts) can stamp `data.sectionName` without a second
   * store read of its own. NOT used by validation itself (the name is
   * display-only, not a reference-integrity criterion); it rides on this
   * context purely because the context is where a store-backed, per-write,
   * synchronous resolver already lives. Absent, or returning undefined for a
   * given id, both mean "cannot resolve a name" — the write path treats them
   * identically and leaves `sectionName` unset (never `null`; see
   * object-verbs.ts's stampSharedRefSectionNames for why).
   */
  resolveSharedSectionName?: (objectId: string) => string | undefined;
  /**
   * Blueprint type of a section_template object (W8.2) — the
   * resolveSharedSectionType sibling, for template slot blueprintRef checks.
   */
  resolveSectionTemplateType?: (objectId: string) => SectionType | undefined;
  /**
   * Whether a component type exists in the code component registry (D§3.4/OQ-4).
   * Registry lands in P3; absent here → registry membership not verified.
   */
  componentTypeExists?: (type: string) => boolean;
  /**
   * Whether a page `route` is already taken by a DIFFERENT page (the resolver
   * excludes the object under validation). Absent → uniqueness not verified.
   */
  isRouteTaken?: (route: string) => boolean;
  /**
   * Whether a product `slug` is already taken by a DIFFERENT product — the
   * /shop/<slug> analogue of isRouteTaken (06-shop-module-plan §1). Excludes
   * the object under validation. Absent → uniqueness not verified.
   */
  isSlugTaken?: (slug: string) => boolean;
  /**
   * Whether an article `slug` is already taken by a DIFFERENT content_item
   * object OR a committed legacy post (src/data/post filename stem) — both
   * families share the blog permalink space (W7.3). Excludes the object under
   * validation. Absent → uniqueness not verified.
   */
  isArticleSlugTaken?: (slug: string) => boolean;
  /**
   * Resolve a Stripe Price id to its live amount (the §3 canonicality
   * backstop for direct dashboard edits): the display cache is compared to
   * the live Price at publish. Return undefined for "cannot answer" (unknown
   * id, Stripe unreachable). Absent → cache sync not verified here — wired
   * when the Stripe server surface lands (S1c/S3).
   */
  resolveStripePrice?: (priceId: string) => { amount_cents: number; currency: string } | undefined;
  /** Major-Key blobKeys trusted for this object's asset refs (A§2.12). */
  trustedAssetRefs?: Set<string>;
  /**
   * Resolve a Major-Key blobKey against the artifact index (existence,
   * soft-deletion, size, content type). Consulted only when `trustedAssetRefs`
   * is absent. Return undefined for "cannot answer" (ref not pre-loaded /
   * index unavailable) — existence is then not verified rather than failed.
   * The object path's trust unit is EXISTENCE, not same-request: canvas
   * uploads mint their own request ids and legitimately cross objects.
   */
  resolveArtifactRef?: (blobKey: string) => ArtifactRefResolution | undefined;
  /** Major-Key refs whose index read THREW (not "absent" — unconsultable). A
   * non-empty list almost always means a blob credential fault; existence for
   * these keys is unverified and must be reported as such rather than passing
   * silently. See preloadArtifactRefResolutions in object-validation-context. */
  artifactIndexUnreadable?: string[];
  /** The PageType definition for a page's `pageType` (registry is code, D§3.4/OQ-4). */
  pageType?: PageTypeConstraint;
  /**
   * Resolve a page's PageType constraint from its `pageType` id (the code
   * registry). Preferred over the static `pageType` field for the generic
   * write path, which validates whatever page arrives; `pageType` still wins
   * when set directly (tests). Absent → PageType rules not verified.
   */
  resolvePageType?: (pageTypeId: string) => PageTypeConstraint | undefined;
  /** True when validating a publish (or the record is already published). */
  publishIntent?: boolean;
};

export type ObjectValidationInput = {
  objectType: ObjectType;
  objectId: string;
  body: unknown;
  /** record.publication.published_time != null. */
  published?: boolean;
};

// ─── criterion helpers ───────────────────────────────────────────────────────

const crit = (id: string, label: string, status: CriterionStatus, message: string): ReadinessCriterion => ({
  id,
  label,
  status,
  message,
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** Depth-first walk of every string leaf, tracking the key path to each. */
const walkStrings = (value: unknown, visit: (path: string[], value: string) => void, path: string[] = []): void => {
  if (typeof value === 'string') {
    visit(path, value);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkStrings(item, visit, [...path, String(index)]));
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) walkStrings(child, visit, [...path, key]);
  }
};

/** Deep walk of every object node (for reference-shape recognition). */
const walkObjects = (value: unknown, visit: (node: Record<string, unknown>) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walkObjects(item, visit);
    return;
  }
  if (isRecord(value)) {
    visit(value);
    for (const child of Object.values(value)) walkObjects(child, visit);
  }
};

// ─── check 1: per-type zod + RichText allowlist ──────────────────────────────

// A body schema per object type — all nine since W7.3 (content_item.v1 is the
// article as a governed object; the legacy committed posts stay on their own
// pipeline and never pass through this engine).
const BODY_SCHEMAS: Partial<Record<ObjectType, { safeParse: (v: unknown) => { success: boolean; error?: unknown } }>> =
  {
    navigation: navigationBodySchema,
    page: pageBodySchema,
    section: sectionBodySchema,
    template: templateBodySchema,
    section_template: sectionTemplateBodySchema,
    theme: themeBodySchema,
    site: siteBodySchema,
    taxonomy: taxonomyBodySchema,
    product: productBodySchema,
    content_item: contentItemBodySchema,
    tracking_config: trackingConfigBodySchema,
    editorial_voice: editorialVoiceBodySchema,
  };

// Mirrors node-renderer.ts TIPTAP_ALLOWED (A§1.5): the only tags TipTap emits.
// `code` widens the vocabulary (inline code display, theme-tokens.ts `mono`
// font) — additive, every existing body still validates unchanged.
const RICHTEXT_ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'em', 'a', 'ul', 'ol', 'li', 'h2', 'h3', 'code']);
const HTML_TAG_RE = /<\/?([a-z][a-z0-9-]*)\b[^>]*>/gi;
const ANCHOR_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi;
const LOOKS_LIKE_HTML_RE = /<[a-z!/]/i;
const SAFE_HREF_RE = /^https?:\/\//i;

const zodIssueSummary = (error: unknown): string => {
  const issues = isRecord(error) && Array.isArray(error.issues) ? error.issues : [];
  if (issues.length === 0) return 'Body failed per-type schema validation.';
  return issues
    .slice(0, 3)
    .map((issue) => {
      if (!isRecord(issue)) return 'invalid';
      const where = Array.isArray(issue.path) && issue.path.length ? issue.path.join('.') : '(root)';
      return `${where}: ${String(issue.message ?? 'invalid')}`;
    })
    .join('; ');
};

/** Collect RichText allowlist violations across every HTML-bearing string leaf. */
const scanRichText = (body: unknown): string[] => {
  const violations: string[] = [];
  walkStrings(body, (path, value) => {
    // `notes` is private-by-design and never rendered — not RichText.
    if (path.includes('notes')) return;
    if (!LOOKS_LIKE_HTML_RE.test(value)) return;
    const at = path.length ? path.join('.') : '(root)';

    for (const match of value.matchAll(HTML_TAG_RE)) {
      const tag = match[1].toLowerCase();
      if (!RICHTEXT_ALLOWED_TAGS.has(tag))
        violations.push(`${at}: disallowed tag <${tag}> (allowlist ${[...RICHTEXT_ALLOWED_TAGS].join(',')}).`);
    }
    for (const match of value.matchAll(ANCHOR_HREF_RE)) {
      if (!SAFE_HREF_RE.test(match[1])) violations.push(`${at}: link href "${match[1]}" must be http(s).`);
    }
  });
  return violations;
};

export const checkSchema = (objectType: ObjectType, body: unknown): ReadinessCriterion[] => {
  const criteria: ReadinessCriterion[] = [];
  const schema = BODY_SCHEMAS[objectType];

  if (!schema) {
    criteria.push(
      crit(
        'schema_zod',
        'Per-type schema',
        'optional',
        `${objectType} bodies are validated by the existing pipeline, not this engine.`
      )
    );
    return criteria;
  }

  const parsed = schema.safeParse(body);
  criteria.push(
    parsed.success
      ? crit('schema_zod', 'Per-type schema', 'complete', '')
      : crit('schema_zod', 'Per-type schema', 'missing', zodIssueSummary(parsed.error))
  );

  const richTextViolations = scanRichText(body);
  criteria.push(
    richTextViolations.length === 0
      ? crit('schema_richtext', 'RichText allowlist', 'complete', '')
      : crit('schema_richtext', 'RichText allowlist', 'missing', richTextViolations.slice(0, 3).join(' '))
  );

  return criteria;
};

// ─── check 2: ID discipline ──────────────────────────────────────────────────

export const checkIdDiscipline = (objectType: ObjectType, objectId: string, body: unknown): ReadinessCriterion[] => {
  const criteria: ReadinessCriterion[] = [];

  const idResult = validateObjectIdForType(objectType, objectId);
  criteria.push(
    idResult.ok
      ? crit('id_object', 'Object id', 'complete', '')
      : crit('id_object', 'Object id', 'missing', idResult.error ?? 'Invalid object id.')
  );

  // Section instance ids (s_*) inside page/section bodies.
  const badSectionIds: string[] = [];
  walkObjects(body, (node) => {
    if (typeof node.type === 'string' && typeof node.id === 'string' && 'data' in node) {
      // A section instance: { id, type, data, ... }.
      const result = validateSectionInstanceId(node.id);
      if (!result.ok) badSectionIds.push(node.id);
    }
  });
  if (badSectionIds.length > 0) {
    criteria.push(
      crit('id_sections', 'Section instance ids', 'missing', `Invalid section ids: ${badSectionIds.join(', ')}.`)
    );
  } else {
    criteria.push(crit('id_sections', 'Section instance ids', 'complete', ''));
  }

  return criteria;
};

// ─── check 3: reference integrity ────────────────────────────────────────────

const NAV_TARGET_KINDS = new Set(['page', 'taxonomy', 'listing', 'external', 'asset', 'route']);

export const checkReferenceIntegrity = (
  objectType: ObjectType,
  body: unknown,
  context: ObjectValidationContext
): ReadinessCriterion[] => {
  const criteria: ReadinessCriterion[] = [];
  const problems: string[] = [];
  let checkedAnyResolvable = false;
  let sawUnresolvableResolver = false;

  const requireObject = (refType: ObjectType, id: string, label: string) => {
    if (!context.resolveObject) return; // not verifiable here (T0.8 wires it)
    const resolution = context.resolveObject(refType, id);
    if (resolution === undefined) {
      // The documented contract: undefined = "cannot answer" — same as no
      // resolver for this lookup (e.g. content_item ids with no GitHub env),
      // NOT a failed reference. Before trap 4 closed this fell through to a
      // hard failure, which is why manual grid picks always blocked.
      sawUnresolvableResolver = true;
      return;
    }
    checkedAnyResolvable = true;
    if (!resolution.exists) {
      problems.push(`${label} "${id}" does not resolve to an existing ${refType}.`);
    }
  };

  const requireTerm = (kind: 'category' | 'tag', termId: string, label: string) => {
    if (!context.resolveTaxonomyTerm) return;
    checkedAnyResolvable = true;
    const resolution = context.resolveTaxonomyTerm(kind, termId);
    if (!resolution || !resolution.active) {
      sawUnresolvableResolver = true;
      problems.push(`${label} term "${termId}" does not resolve to an active ${kind} term.`);
    }
  };

  // Article taxonomy (W7.3): category/tags are registry SLUGS (the W3
  // frontmatter convention — the store resolver also matches slugs, following
  // merged_into aliases). Registry-gated exactly like the publish-article
  // hook: no resolver → not verified, never a false failure.
  if (objectType === 'content_item' && isRecord(body) && isRecord(body.taxonomy)) {
    const taxonomy = body.taxonomy;
    if (typeof taxonomy.category === 'string' && taxonomy.category) {
      requireTerm('category', taxonomy.category, 'taxonomy.category');
    }
    if (Array.isArray(taxonomy.tags)) {
      for (const tag of taxonomy.tags) {
        if (typeof tag === 'string' && tag) requireTerm('tag', tag, 'taxonomy.tags');
      }
    }
  }

  walkObjects(body, (node) => {
    // NavTarget (in nav items/groups/actions and page-body LinkActions).
    if (typeof node.kind === 'string' && NAV_TARGET_KINDS.has(node.kind)) {
      if (node.kind === 'page' && typeof node.page === 'string') {
        requireObject('page', node.page, 'NavTarget.page');
      }
      // route-kind is the Gap-Note-2 transitional variant: explicitly ALLOWED,
      // never rejected here. It is removed from the validators in P6 cleanup.
      if (
        node.kind === 'taxonomy' &&
        typeof node.term_id === 'string' &&
        (node.termKind === 'category' || node.termKind === 'tag')
      ) {
        requireTerm(node.termKind, node.term_id, 'NavTarget.taxonomy');
      }
    }

    // Section variants carrying references.
    if (typeof node.type === 'string' && isRecord(node.data)) {
      const data = node.data;
      if (node.type === 'shared_ref' && typeof data.section === 'string') {
        requireObject('section', data.section, 'shared_ref.section');
        // Reference-chain policy (DECISION, previously left implicit — the
        // section-v1 schema comment defers it here): a shared section must
        // NOT itself be a `shared_ref`. The renderer dereferences shared_ref
        // to the target's current variant in a single hop (D§3.5); chains
        // would require multi-hop deref and admit cycles. Enforced whenever
        // the effective target type is resolvable.
        const targetType = context.resolveSharedSectionType?.(data.section);
        if (targetType === 'shared_ref') {
          checkedAnyResolvable = true;
          sawUnresolvableResolver = true;
          problems.push(
            `shared_ref.section "${data.section}" points at another shared_ref — reference chains are not allowed (single-hop only).`
          );
        }
      }
      if (node.type === 'content_embed' && typeof data.contentItem === 'string') {
        requireObject('content_item', data.contentItem, 'content_embed.contentItem');
      }
      // pricing_table tiers must reference existing products (W5 — money data
      // resolves from commerce objects, so a ghost tier is a hard failure).
      if (node.type === 'pricing_table' && Array.isArray(data.tiers)) {
        for (const tier of data.tiers) {
          if (isRecord(tier) && typeof tier.product === 'string') {
            requireObject('product', tier.product, 'pricing_table tier');
          }
        }
      }
      // product_preview manual picks must resolve to existing products (S2 —
      // the content_grid manual-item rule over the product keyspace).
      if (node.type === 'product_preview' && isRecord(data.source)) {
        const source = data.source;
        if (source.kind === 'manual' && Array.isArray(source.items)) {
          for (const item of source.items) {
            if (typeof item === 'string') requireObject('product', item, 'product_preview manual item');
          }
        }
      }
      if (node.type === 'content_grid' && isRecord(data.source)) {
        const source = data.source;
        const requireQueryTerms = (query: unknown, label: string) => {
          if (!isRecord(query)) return;
          if (typeof query.category === 'string') requireTerm('category', query.category, `${label}.category`);
          if (Array.isArray(query.tags)) {
            for (const tag of query.tags) if (typeof tag === 'string') requireTerm('tag', tag, `${label}.tags`);
          }
        };
        if (source.kind === 'manual' && Array.isArray(source.items)) {
          for (const item of source.items) {
            if (typeof item === 'string') requireObject('content_item', item, 'content_grid manual item');
          }
          // M-8: the fallback query's terms are validated exactly like a
          // primary query's — an unknown term in the backfill is as wrong
          // as one in the main source.
          if (isRecord(source.fallback)) requireQueryTerms(source.fallback.query, 'content_grid fallback query');
        }
        if (source.kind === 'query') requireQueryTerms(source.query, 'content_grid query');
      }
    }
  });

  // Page-level references outside sections.
  if (objectType === 'page' && isRecord(body)) {
    if (isRecord(body.template) && typeof body.template.ref === 'string') {
      requireObject('template', body.template.ref, 'page.template.ref');
    }
    if (isRecord(body.navigationOverrides)) {
      for (const role of ['header', 'footer'] as const) {
        const ref = body.navigationOverrides[role];
        if (typeof ref === 'string') requireObject('navigation', ref, `navigationOverrides.${role}`);
      }
    }
  }

  // Product-level references: the OPTIONAL long-form Page a product composes
  // with (06-shop-module-plan §2 — /shop/[slug] renders buy box + hero from
  // the product, then the referenced page's sections).
  if (objectType === 'product' && isRecord(body)) {
    const presentation = body.presentation;
    if (isRecord(presentation) && typeof presentation.page_ref === 'string') {
      requireObject('page', presentation.page_ref, 'presentation.page_ref');
    }
  }

  // Site-level references (existence only; the "right role" nuance is §2.3-site).
  if (objectType === 'site' && isRecord(body)) {
    const defaultNavigation = body.defaultNavigation;
    if (isRecord(defaultNavigation)) {
      for (const role of ['header', 'footer', 'secondary', 'social'] as const) {
        const ref = defaultNavigation[role];
        if (typeof ref === 'string') requireObject('navigation', ref, `defaultNavigation.${role}`);
      }
    }
    if (isRecord(body.chrome) && isRecord(body.chrome.announcement)) {
      const sectionRef = body.chrome.announcement.sectionRef;
      if (typeof sectionRef === 'string') requireObject('section', sectionRef, 'chrome.announcement.sectionRef');
    }
  }

  if (problems.length > 0) {
    criteria.push(crit('references', 'Reference integrity', 'missing', problems.slice(0, 5).join(' ')));
  } else if (!checkedAnyResolvable) {
    criteria.push(
      crit('references', 'Reference integrity', 'optional', 'No resolvers supplied — references not verified here.')
    );
  } else {
    void sawUnresolvableResolver;
    criteria.push(crit('references', 'Reference integrity', 'complete', ''));
  }

  return criteria;
};

// ─── check 4: reader safety ──────────────────────────────────────────────────

/** Deep clone stripping every `notes` field (private-by-design, never rendered). */
const stripNotes = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripNotes);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === 'notes') continue;
      out[key] = stripNotes(child);
    }
    return out;
  }
  return value;
};

/**
 * The reader projection of a content_item body: exactly what the article
 * renderer emits (public-visibility nodes' `public` fields + the envelope's
 * rendered copy). The annotation layer (private/commercial/chat internals,
 * claims/sources/scores/…) is the POINT of the type — it must never be
 * scanned as reader content, and equally must never be part of this
 * projection. Kept in lockstep with src/lib/article-object/render-nodes.ts.
 */
const contentItemReaderProjection = (body: unknown): unknown => {
  const parsed = contentItemBodySchema.safeParse(body);
  if (!parsed.success) return {}; // schema check owns this failure
  const article: ContentItemBody = parsed.data;
  return {
    title: article.title,
    deck: article.deck,
    description: article.description,
    author: article.author,
    image: article.image,
    seo: article.seo,
    nodes: article.nodes
      .filter((node) => (node.visibility ?? 'public') === 'public')
      .map((node) => ({ id: node.id, public: node.public })),
  };
};

export const checkReaderSafety = (body: unknown, objectType?: ObjectType): ReadinessCriterion[] => {
  // Generalizes assert-reader-safe (A§1.1): private/internal markers must never
  // appear in RENDERABLE fields. `notes` is excluded — it is the private field.
  // content_item scans its READER PROJECTION (the annotation layer is
  // legitimate body data there, never rendered — the leak rule guards the
  // rendered surface, not the record); only there do the bare words "private"
  // and "strategy" carry leak-meaning. For every other type they are ordinary
  // prose, so the projection scan runs field-name-only (W14 finding F4: a
  // marketing "Our Strategy" page — or documenting the model itself — must
  // publish).
  const isContentItem = objectType === 'content_item';
  const renderable = isContentItem ? contentItemReaderProjection(body) : stripNotes(body);
  try {
    assertReaderSafe(renderable, { scanProseWords: isContentItem });
    return [crit('reader_safety', 'Reader-safe content', 'complete', '')];
  } catch (error) {
    return [crit('reader_safety', 'Reader-safe content', 'missing', (error as Error).message)];
  }
};

// ─── check 5: media / artifact trust ─────────────────────────────────────────

// Mirrors admin-patch-workflow.ts validateImageRef reject rules (A§2.12). That
// module's regexes are not exported; they are reproduced here with citation
// rather than importing (or modifying) it.
const BASE64_DATA_URI_RE = /^data:/i;
const LEGACY_REPO_PATH_RE = /^src\/assets\//;
const REMOTE_URL_RE = /^https?:\/\//i;

type AssetRefProblem = {
  message: string;
  /**
   * `shape`/`trust` problems always block the write (prior behavior).
   * `existence` problems (resolver-backed) block only at publish and warn while
   * drafting — an agent mid-assembly may reference an artifact it uploads next.
   */
  kind: 'shape' | 'trust' | 'existence';
};

const validateAssetRef = (
  path: string,
  value: string,
  context: ObjectValidationContext
): AssetRefProblem | undefined => {
  if (BASE64_DATA_URI_RE.test(value)) return { kind: 'shape', message: `${path} must not be a data URI.` };
  if (LEGACY_REPO_PATH_RE.test(value))
    return { kind: 'shape', message: `${path} is a legacy repo path. Provide a Major Key artifact reference.` };
  if (REMOTE_URL_RE.test(value))
    return {
      kind: 'shape',
      message: `${path} is an arbitrary remote URL. Provide a Major Key artifact reference instead.`,
    };
  if (!MAJOR_KEY_ARTIFACT_REF_RE.test(value))
    return {
      kind: 'shape',
      message: `${path} must be a Major Key artifact reference ({image|pdf}/{id}/{sha256}.{ext}).`,
    };
  if (context.trustedAssetRefs) {
    return context.trustedAssetRefs.has(value)
      ? undefined
      : { kind: 'trust', message: `${path} "${value}" is not an index-trusted artifact reference.` };
  }
  const resolution = context.resolveArtifactRef?.(value);
  if (!resolution) return undefined; // existence not verifiable — shape checks stand on their own
  if (resolution.deleted) {
    return {
      kind: 'existence',
      message:
        `${path} "${value}" refers to a soft-deleted artifact — excluded from listing, trust, and serving. ` +
        `Re-upload the exact bytes (or ask an admin to run restore_artifact), then retry.`,
    };
  }
  if (!resolution.exists) {
    return {
      kind: 'existence',
      message:
        `${path} "${value}" is not in the artifact index (never uploaded, or the key is mistyped). ` +
        `Generate it through the site's Platform artifact bridge (create_agent_artifact_job) and use the ` +
        `exact returned ArtifactReference blobKey — list_artifacts_for_request shows what exists.`,
    };
  }
  return undefined;
};

const ASSET_REF_KEY_RE = /assetref$/i; // imageAssetRef, portraitAssetRef, … (the *AssetRef convention)

export const checkArtifactTrust = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish = false
): ReadinessCriterion[] => {
  const blocking: string[] = [];
  const existence: string[] = [];
  let sawAssetRef = false;

  walkStrings(body, (path, value) => {
    const key = path[path.length - 1] ?? '';
    if (!ASSET_REF_KEY_RE.test(key) || !value) return;
    sawAssetRef = true;
    const problem = validateAssetRef(path.join('.'), value, context);
    if (!problem) return;
    (problem.kind === 'existence' ? existence : blocking).push(problem.message);
  });

  if (blocking.length > 0)
    return [crit('artifact_trust', 'Media / artifact trust', 'missing', blocking.slice(0, 5).join(' '))];
  if (existence.length > 0) {
    // Missing/deleted artifacts break the live page, not the draft: block the
    // publish, warn while drafting.
    return [
      crit(
        'artifact_trust',
        'Media / artifact trust',
        atPublish ? 'missing' : 'warning',
        existence.slice(0, 5).join(' ')
      ),
    ];
  }
  if (!sawAssetRef)
    return [crit('artifact_trust', 'Media / artifact trust', 'optional', 'No asset references present.')];
  return [crit('artifact_trust', 'Media / artifact trust', 'complete', '')];
};

// ─── check 5c: image byte budget (src/config/media-policy.ts) ────────────────
//
// The budget rides the pdf-tool storage grant and object_contract, but nothing
// on the write path surfaced an over-budget artifact — a 1024×1024 PNG from
// default generation settings ships silently at ~10× the 150 KB webp budget.
// Uses the artifact-index resolver's metadata (sizeBytes). Severity follows
// the committed policy: overBudget 'warn' → warning; 'block' → publish blocker
// (draft warning) — flipping the config upgrades enforcement with zero code.
// Only image artifacts are budgeted (PDFs carry no byte budget), and only
// over-budget is reported — format is generation guidance, not a write nag.

const BUDGET_IMG_PUBLIC_PATH_RE = /^\/img\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;

export const checkMediaBudget = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish = false,
  policyOverride?: MediaPolicy
): ReadinessCriterion[] => {
  if (!context.resolveArtifactRef) return []; // no size metadata — nothing to report
  const policy = policyOverride ?? activeMediaPolicy();
  const over: string[] = [];
  const reported = new Set<string>();
  let sawResolvedImage = false;

  walkStrings(body, (path, value) => {
    if (path.includes('notes')) return;
    let raw: string | undefined;
    if (BUDGET_IMG_PUBLIC_PATH_RE.test(value)) raw = rawArtifactRefForPublicPath(value);
    else if (MAJOR_KEY_ARTIFACT_REF_RE.test(value) && value.toLowerCase().startsWith('image/')) raw = value;
    if (!raw || reported.has(raw)) return;

    const resolution = context.resolveArtifactRef?.(raw);
    if (!resolution?.exists || typeof resolution.sizeBytes !== 'number') return;
    sawResolvedImage = true;
    if (resolution.sizeBytes > policy.maxImageBytes) {
      reported.add(raw);
      over.push(
        `${path.join('.')} "${value}" is ${resolution.sizeBytes} bytes — over the ${policy.maxImageBytes}-byte ` +
          `image budget. Ask pdf-tool to shrink it under the budget (preferred format: ${policy.preferredImageFormat}).`
      );
    }
  });

  if (over.length > 0) {
    const status: CriterionStatus = policy.overBudget === 'block' && atPublish ? 'missing' : 'warning';
    return [crit('media_budget', 'Image byte budget', status, over.slice(0, 5).join(' '))];
  }
  if (sawResolvedImage) return [crit('media_budget', 'Image byte budget', 'complete', '')];
  return [];
};

// ─── check 5b: raw artifact refs in RENDERABLE fields (build-breaker guard) ───
//
// A raw Major Key artifact key (`image/<id>/<sha>.ext`) is servable ONLY as its
// public path `/img/<id>/<sha>.ext` (the netlify `/img/*` redirect). It is the
// correct stored value ONLY in a `*AssetRef` field, which the renderers resolve
// / don't render. In any OTHER string field the value is passed to a renderer
// verbatim — a plain `<img src>` (content_split images, bio portrait, product
// card) 404s, and `seo.ogImage` reaches Astro's `getImage`, which THROWS
// `LocalImageUsedWrongly` and fails the ENTIRE build (hit for real 2026-07-13:
// an agent set page_shop_preview's images[].src + seo.ogImage to raw
// `image/req_publish_premium_skus_…` keys). The article pipeline already blocks
// this (publish-article.ts rawImageArtifactReferencePattern); this is the
// object-pipeline analogue. `*AssetRef` fields and private `notes` are exempt.

// Fields that LEGITIMATELY hold a raw Major-Key artifact ref (resolved or
// token-delivered, never passed to an image renderer): the `*AssetRef`
// convention (imageAssetRef/portraitAssetRef — resolved/unrendered) and the
// product download `fulfillment.artifact_ref` (delivered through token-gated
// links, its trust checked by the product_artifact criterion). Everything
// else that carries a raw ref is a rendered field and needs the /img|/pdf path.
const RAW_REF_CARRIER_KEY_RE = /(assetref|artifact_ref)$/i;

export const checkRenderableImageRefs = (body: unknown): ReadinessCriterion[] => {
  const problems: string[] = [];
  walkStrings(body, (path, value) => {
    const key = path[path.length - 1] ?? '';
    if (RAW_REF_CARRIER_KEY_RE.test(key)) return; // trusted-ref fields legitimately hold raw refs
    if (path.includes('notes')) return; // private, never rendered
    if (!MAJOR_KEY_ARTIFACT_REF_RE.test(value)) return;
    problems.push(
      `${path.join('.')} is a raw artifact key ("${value}"), which is not servable and breaks the site build ` +
        `(Astro's <Image>/getImage throws on it). Use its public path "${publicPathForArtifactRef(value)}" instead ` +
        `(only *AssetRef fields hold the raw ref).`
    );
  });
  return [
    problems.length === 0
      ? crit('render_image_ref', 'Renderable image refs', 'complete', '')
      : crit('render_image_ref', 'Renderable image refs', 'missing', problems.slice(0, 3).join(' ')),
  ];
};

// ─── check 6: structural invariants ──────────────────────────────────────────

const collectSections = (body: unknown): SectionInstance[] => {
  if (!isRecord(body) || !Array.isArray(body.sections)) return [];
  return body.sections.filter(
    (section): section is SectionInstance => isRecord(section) && typeof section.type === 'string'
  );
};

const effectiveSectionType = (section: SectionInstance, context: ObjectValidationContext): SectionType | undefined => {
  if (section.type === 'shared_ref') {
    return context.resolveSharedSectionType?.(section.data.section);
  }
  return section.type;
};

// ─── check 6 (grid): content_grid cards vs. limit (warn-only) ────────────────
//
// A `cards`-source content_grid with more cells than `limit` silently truncates
// at render (ContentGrid.astro slices curated cells to `limit`), so an agent who
// adds or edits a cell beyond `limit` sees no change and gets no error. This
// surfaces the overflow as a WARNING — never a blocker, because a deliberately
// short render is a legal choice, but a surprising one worth flagging. Applies
// to grids anywhere in the body (page sections OR a shared `section` wrapper),
// so it runs for both page and section objects.
export const checkContentGridCardLimits = (body: unknown): ReadinessCriterion[] => {
  const overflow: string[] = [];
  let sawGrid = false;
  walkObjects(body, (node) => {
    if (node.type !== 'content_grid' || !isRecord(node.data)) return;
    sawGrid = true;
    const data = node.data;
    const source = data.source;
    const limit = typeof data.limit === 'number' ? data.limit : undefined;
    if (
      isRecord(source) &&
      source.kind === 'cards' &&
      Array.isArray(source.cards) &&
      limit !== undefined &&
      source.cards.length > limit
    ) {
      const id = typeof node.id === 'string' ? node.id : '(grid)';
      const hidden = source.cards.length - limit;
      overflow.push(`${id}: ${source.cards.length} cards but limit ${limit} — ${hidden} will not render.`);
    }
  });
  if (!sawGrid) return [];
  return [
    overflow.length === 0
      ? crit('content_grid_card_limit', 'Content grid card count', 'complete', '')
      : crit('content_grid_card_limit', 'Content grid card count', 'warning', overflow.slice(0, 5).join(' ')),
  ];
};

// ─── check 6a: taxonomy registry integrity (body-only + optional usage) ──────

// The slug shape shared with the article pipeline (A§1.6) and D§3.7.
const TAXONOMY_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Registry-level taxonomy rules the section/taxonomy-v1 schema explicitly
 * defers here (§2.3-taxonomy): slug shape, per-kind slug uniqueness,
 * `merged_into` targets exist + are active + form no cycle, and (when a usage
 * resolver is supplied) a deprecated term with live usage must carry
 * `merged_into` so references don't strand.
 *
 * This validates registry STATE only. It never re-derives how a *usage*
 * resolves through aliases — that resolution stays with the injected
 * `resolveTaxonomyTerm` resolver (D§5.5), so this engine and T0.6/T0.8 can
 * never disagree on which aliases are live.
 */
export const checkTaxonomyRegistry = (body: unknown, context: ObjectValidationContext): ReadinessCriterion[] => {
  if (!isRecord(body) || !isRecord(body.kinds)) {
    return [
      crit(
        'taxonomy_registry',
        'Taxonomy registry',
        'optional',
        'Taxonomy body shape not recognized (see schema check).'
      ),
    ];
  }

  const slugProblems: string[] = [];
  const mergeProblems: string[] = [];
  const usageProblems: string[] = [];
  let usageChecked = false;

  for (const kind of ['category', 'tag'] as const) {
    const registry = (body.kinds as Record<string, unknown>)[kind];
    const terms = isRecord(registry) && Array.isArray(registry.terms) ? registry.terms : [];
    const byId = new Map<string, Record<string, unknown>>();
    const slugCounts = new Map<string, number>();

    for (const term of terms) {
      if (!isRecord(term)) continue;
      const termId = typeof term.term_id === 'string' ? term.term_id : '';
      const slug = typeof term.slug === 'string' ? term.slug : '';
      if (termId) byId.set(termId, term);
      if (slug) {
        if (!TAXONOMY_SLUG_RE.test(slug))
          slugProblems.push(
            `${kind} term ${termId || '(no id)'}: slug "${slug}" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$.`
          );
        slugCounts.set(slug, (slugCounts.get(slug) ?? 0) + 1);
      }
    }
    for (const [slug, count] of slugCounts) {
      if (count > 1) slugProblems.push(`${kind}: slug "${slug}" is used by ${count} terms (must be unique per kind).`);
    }

    for (const term of terms) {
      if (!isRecord(term)) continue;
      const termId = typeof term.term_id === 'string' ? term.term_id : '(no id)';
      const mergedInto = typeof term.merged_into === 'string' ? term.merged_into : undefined;

      if (mergedInto !== undefined) {
        const target = byId.get(mergedInto);
        if (!target)
          mergeProblems.push(`${kind} term ${termId}: merged_into "${mergedInto}" does not exist in this kind.`);
        else if (target.status !== 'active')
          mergeProblems.push(`${kind} term ${termId}: merged_into "${mergedInto}" is not an active term.`);
      }

      if (term.status === 'deprecated' && mergedInto === undefined && context.resolveTaxonomyTermUsage) {
        usageChecked = true;
        const usage = context.resolveTaxonomyTermUsage(kind, termId);
        if (usage?.inUse)
          usageProblems.push(
            `${kind} term ${termId} is deprecated with live usage but has no merged_into (would strand references).`
          );
      } else if (context.resolveTaxonomyTermUsage) {
        usageChecked = true;
      }
    }

    // Cycle detection over the merged_into graph.
    for (const term of terms) {
      if (!isRecord(term) || typeof term.term_id !== 'string') continue;
      const start = term.term_id;
      const seen = new Set<string>();
      let cursor: string | undefined = start;
      while (cursor !== undefined) {
        if (seen.has(cursor)) {
          mergeProblems.push(`${kind}: merged_into chain starting at ${start} forms a cycle.`);
          break;
        }
        seen.add(cursor);
        const node = byId.get(cursor);
        cursor = node && typeof node.merged_into === 'string' ? node.merged_into : undefined;
      }
    }
  }

  const criteria: ReadinessCriterion[] = [
    slugProblems.length === 0
      ? crit('taxonomy_slugs', 'Taxonomy slugs', 'complete', '')
      : crit('taxonomy_slugs', 'Taxonomy slugs', 'missing', [...new Set(slugProblems)].slice(0, 5).join(' ')),
    mergeProblems.length === 0
      ? crit('taxonomy_merges', 'Taxonomy merge integrity', 'complete', '')
      : crit(
          'taxonomy_merges',
          'Taxonomy merge integrity',
          'missing',
          [...new Set(mergeProblems)].slice(0, 5).join(' ')
        ),
  ];
  if (usageProblems.length > 0) {
    criteria.push(
      crit('taxonomy_usage', 'Deprecation without stranding', 'missing', usageProblems.slice(0, 5).join(' '))
    );
  } else if (!usageChecked) {
    criteria.push(
      crit('taxonomy_usage', 'Deprecation without stranding', 'optional', 'No usage resolver — not verified here.')
    );
  } else {
    criteria.push(crit('taxonomy_usage', 'Deprecation without stranding', 'complete', ''));
  }
  return criteria;
};

// ─── check 6b: template slot integrity ───────────────────────────────────────

/**
 * Template slot rules the template-v1 schema defers here (§2.3-template):
 * a blueprint's type must be in its slot's `allowed` set; a required slot
 * should carry a blueprint; and `allowed` types must exist in the component
 * registry (code, injected via `componentTypeExists` — the registry lands in
 * P3, so this is `optional` until wired). `appliesTo` PageType existence is
 * already enforced by the body zod (a fixed enum), so it isn't re-checked.
 */
export const checkTemplate = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  if (!isRecord(body) || !Array.isArray(body.slots)) {
    return [
      crit('template_slots', 'Template slots', 'optional', 'Template body shape not recognized (see schema check).'),
    ];
  }

  const blueprintProblems: string[] = [];
  const requiredProblems: string[] = [];
  const registryProblems: string[] = [];
  const refProblems: string[] = [];
  let registryChecked = false;
  let sawRef = false;
  let refChecked = false;

  for (const slot of body.slots) {
    if (!isRecord(slot)) continue;
    const slotId = typeof slot.slotId === 'string' ? slot.slotId : '(no id)';
    const allowed = Array.isArray(slot.allowed) ? slot.allowed.filter((t): t is string => typeof t === 'string') : [];

    if (context.componentTypeExists) {
      registryChecked = true;
      for (const type of allowed) {
        if (!context.componentTypeExists(type))
          registryProblems.push(`slot ${slotId}: allowed type "${type}" is not a registered component.`);
      }
    }

    if (isRecord(slot.blueprint) && typeof slot.blueprint.type === 'string') {
      if (allowed.length > 0 && !allowed.includes(slot.blueprint.type))
        blueprintProblems.push(
          `slot ${slotId}: blueprint type "${slot.blueprint.type}" is not in the slot's allowed set.`
        );
    }

    // blueprintRef (W8.2): must resolve to an existing section_template whose
    // blueprint type the slot allows. Deref is instantiation-time-only; here
    // we only verify the reference is honest. Mutual exclusion with an inline
    // blueprint is the slot schema's refine (check 1).
    const blueprintRef = typeof slot.blueprintRef === 'string' ? slot.blueprintRef : undefined;
    if (blueprintRef) {
      sawRef = true;
      const resolution = context.resolveObject?.('section_template', blueprintRef);
      if (resolution) {
        refChecked = true;
        if (!resolution.exists)
          refProblems.push(`slot ${slotId}: blueprintRef "${blueprintRef}" does not resolve to a section_template.`);
      }
      const refType = context.resolveSectionTemplateType?.(blueprintRef);
      if (refType !== undefined) {
        refChecked = true;
        if (allowed.length > 0 && !allowed.includes(refType))
          blueprintProblems.push(
            `slot ${slotId}: referenced blueprint type "${refType}" (${blueprintRef}) is not in the slot's allowed set.`
          );
      }
    }

    // A blueprintRef counts as "has a blueprint" — the recipe supplies content.
    if (slot.required === true && !isRecord(slot.blueprint) && !blueprintRef) requiredProblems.push(slotId);
  }

  const criteria: ReadinessCriterion[] = [
    blueprintProblems.length === 0
      ? crit('template_blueprints', 'Blueprint types', 'complete', '')
      : crit('template_blueprints', 'Blueprint types', 'missing', blueprintProblems.slice(0, 5).join(' ')),
    // Required-without-blueprint is a warning, not a hard failure: registry
    // defaultData may supply the section at instantiation (D§3.6) — but flag it.
    requiredProblems.length === 0
      ? crit('template_required', 'Required slots have blueprints', 'complete', '')
      : crit(
          'template_required',
          'Required slots have blueprints',
          'warning',
          `Required slot(s) without a blueprint: ${requiredProblems.join(', ')}.`
        ),
  ];
  if (registryProblems.length > 0) {
    criteria.push(
      crit('template_registry', 'Allowed types registered', 'missing', registryProblems.slice(0, 5).join(' '))
    );
  } else if (!registryChecked) {
    criteria.push(
      crit('template_registry', 'Allowed types registered', 'optional', 'No component registry supplied (lands in P3).')
    );
  } else {
    criteria.push(crit('template_registry', 'Allowed types registered', 'complete', ''));
  }
  if (sawRef) {
    criteria.push(
      refProblems.length > 0
        ? crit('template_blueprint_refs', 'Blueprint references', 'missing', refProblems.slice(0, 5).join(' '))
        : refChecked
          ? crit('template_blueprint_refs', 'Blueprint references', 'complete', '')
          : crit(
              'template_blueprint_refs',
              'Blueprint references',
              'optional',
              'No section-template resolver supplied — blueprintRef resolution not verified here.'
            )
    );
  }
  criteria.push(...checkRecipeMetadata(body, atPublish));
  return criteria;
};

// ─── check 6g: recipe self-description (W8.3b) ───────────────────────────────

/**
 * Every recipe (template / section_template / theme) must explain itself
 * before it publishes: description (what it is), whenToUse (when to pick it
 * over sibling recipes), and scope ('evergreen' = standing/strategic,
 * 'one_off' = single-project). Schema-optional — pre-W8.3b records parse —
 * but publish-gated here, the theme_token_keys idiom. These fields ARE the
 * reuse-first index object_inventory serves, so emptiness after trim counts
 * as missing: a blank description indexes nothing.
 */
export const checkRecipeMetadata = (body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  if (!isRecord(body)) return []; // the schema group owns shape failures
  const missing: string[] = [];
  if (typeof body.description !== 'string' || !body.description.trim()) missing.push('description');
  if (typeof body.whenToUse !== 'string' || !body.whenToUse.trim()) missing.push('whenToUse');
  if (body.scope !== 'evergreen' && body.scope !== 'one_off') missing.push('scope');
  return [
    missing.length === 0
      ? crit('recipe_metadata', 'Recipe metadata', 'complete', '')
      : crit(
          'recipe_metadata',
          'Recipe metadata',
          atPublish ? 'missing' : 'warning',
          `A published recipe must explain itself: missing ${missing.join(', ')}. Set description (what it is), ` +
            `whenToUse (when to pick it over sibling recipes), and scope ('evergreen' = standing recipe with a ` +
            `strategy behind it; 'one_off' = built for a single project) via this type's meta/fields op.`
        ),
  ];
};

// ─── check 6e: section-template blueprint rules (W8, 09-plan §2.4) ───────────

/**
 * A recipe may only blueprint what a page could legally hold STANDALONE: the
 * blueprint's type must be component-bound (isStandalonePlaceableSectionType).
 * That excludes `card` — a block-tree leaf with no standalone component, which
 * parses under the section union but kills the build (the Session-K gap this
 * wave closes at every enforcement site) — and `shared_ref`: a pointer is not
 * a recipe (instantiation deep-copies; copying a pointer would alias the
 * target, not copy it). Enforced by direct import of the code registry — the
 * same total Record the renderer dispatches through — so it is always on,
 * never resolver-dependent.
 */
export const checkSectionTemplate = (body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  if (!isRecord(body) || !isRecord(body.blueprint) || typeof body.blueprint.type !== 'string') {
    return [
      crit(
        'blueprint_standalone_renderable',
        'Blueprint type',
        'optional',
        'Section-template body shape not recognized (see schema check).'
      ),
    ];
  }
  const type = body.blueprint.type;
  const placeable = isStandalonePlaceableSectionType(type)
    ? crit('blueprint_standalone_renderable', 'Blueprint type', 'complete', '')
    : crit(
        'blueprint_standalone_renderable',
        'Blueprint type',
        'missing',
        type === 'shared_ref'
          ? 'A blueprint must be a concrete section, not a shared_ref pointer — instantiation copies, never aliases.'
          : `Blueprint type "${type}" has no standalone component and would break the build — a card composes only inside a content_grid cards source.`
      );
  return [placeable, ...checkRecipeMetadata(body, atPublish)];
};

// ─── check 6f: brand-token rules (W8.3, 09-plan §6.3) ────────────────────────

/**
 * CSS-value safety over a brandTokens tree — shared by `theme` bodies and the
 * `site` singleton, because BOTH feed the same raw interpolation into
 * CustomStyles' inline <style> tag (set_site_fields accepted any string until
 * this check — the live gap 09 §7.3 closes). Blocks at write.
 */
const brandTokenValueProblems = (tokens: unknown, at: string): string[] => {
  if (!isRecord(tokens)) return [];
  const problems: string[] = [];
  const colors = isRecord(tokens.colors) ? tokens.colors : {};
  for (const [key, value] of Object.entries(colors)) {
    if (typeof value !== 'string') continue;
    const check = checkBrandTokenValue('color', value);
    if (!check.ok) problems.push(`${at}.colors.${key}: ${check.error}.`);
  }
  const fonts = isRecord(tokens.fonts) ? tokens.fonts : {};
  for (const [key, value] of Object.entries(fonts)) {
    if (typeof value !== 'string') continue;
    const check = checkBrandTokenValue('font', value);
    if (!check.ok) problems.push(`${at}.fonts.${key}: ${check.error}.`);
  }
  return problems;
};

const brandTokenValueCriterion = (tokens: unknown, at: string): ReadinessCriterion => {
  const problems = brandTokenValueProblems(tokens, at);
  return problems.length === 0
    ? crit('brand_token_values', 'Brand token value safety', 'complete', '')
    : crit('brand_token_values', 'Brand token value safety', 'missing', problems.slice(0, 3).join(' '));
};

/**
 * T10.2 — axis rules over a brandTokens tree, shared by `theme` bodies and
 * the `site` singleton (both carry the T10.1 layout/shape/type axes). An
 * invalid enum value mirrors the zod rejection with human-readable copy
 * (blocks at write via the schema; this criterion keeps the WHY legible);
 * an unknown axis key warns as inert (the registry-driven renderer never
 * reads it — the strict schema refuses it on any new write, so this fires
 * only on validate-time inspection of legacy/hand-edited bodies). Absent
 * axes are always fine: omission means the default look at apply time — the
 * 10-required-colors totality posture does NOT extend to axes.
 */
const brandTokenAxisCriteria = (tokens: unknown, at: string): ReadinessCriterion[] => {
  if (!isRecord(tokens)) return [];
  const problems: string[] = [];
  const unknown: string[] = [];
  for (const group of THEME_AXIS_GROUPS) {
    const groupValue = tokens[group];
    if (groupValue === undefined) continue;
    if (!isRecord(groupValue)) {
      problems.push(`${at}.${group}: must be an object of axis settings.`);
      continue;
    }
    const axes = THEME_AXES[group] as Record<string, { values: readonly string[] }>;
    for (const [key, value] of Object.entries(groupValue)) {
      const spec = axes[key];
      if (!spec) {
        unknown.push(`${at}.${group}.${key}`);
        continue;
      }
      if (typeof value !== 'string' || !spec.values.includes(value)) {
        problems.push(`${at}.${group}.${key}: ${JSON.stringify(value)} is not one of ${spec.values.join(' | ')}.`);
      }
    }
  }
  const criteria: ReadinessCriterion[] = [
    problems.length === 0
      ? crit('brand_token_axes', 'Brand token axes', 'complete', '')
      : crit('brand_token_axes', 'Brand token axes', 'missing', problems.slice(0, 3).join(' ')),
  ];
  if (unknown.length > 0) {
    criteria.push(
      crit(
        'brand_token_axis_unknown_keys',
        'Unknown axis keys',
        'warning',
        `Axis key(s) the renderer never reads: ${unknown.slice(0, 5).join(', ')} — inert (kept, but they style nothing).`
      )
    );
  }
  return criteria;
};

/**
 * Theme structural rules: every CustomStyles-consumed color key must be
 * present so `site_apply_theme` is TOTAL (exact-replace leaves no key to fall
 * back) — publish-gated, warns while drafting; unknown color keys warn
 * (inert — the renderer reads only the known list; `dark:`-prefixed keys are
 * the documented optional overrides); every value passes the safety grammar
 * (blocks at write). Font keys are required by the zod shape already.
 */
export const checkTheme = (body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  if (!isRecord(body) || !isRecord(body.tokens)) {
    return [
      crit('theme_token_keys', 'Theme token keys', 'optional', 'Theme body shape not recognized (see schema check).'),
    ];
  }
  const tokens = body.tokens;
  const colors = isRecord(tokens.colors) ? tokens.colors : {};

  const criteria: ReadinessCriterion[] = [];
  const missing = THEME_COLOR_KEYS.filter((key) => typeof colors[key] !== 'string');
  if (missing.length === 0) {
    criteria.push(crit('theme_token_keys', 'Theme token keys', 'complete', ''));
  } else {
    criteria.push(
      crit(
        'theme_token_keys',
        'Theme token keys',
        atPublish ? 'missing' : 'warning',
        `Missing color key(s) the renderer consumes: ${missing.join(', ')} — a published theme must be total so applying it leaves no stale fallbacks.`
      )
    );
  }

  const known = new Set<string>([...THEME_COLOR_KEYS, ...THEME_COLOR_KEYS.map((key) => `dark:${key}`)]);
  const unknown = Object.keys(colors).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    criteria.push(
      crit(
        'theme_token_unknown_keys',
        'Unknown token keys',
        'warning',
        `Color key(s) the renderer never reads: ${unknown.slice(0, 5).join(', ')} — inert (kept, but they style nothing).`
      )
    );
  }

  criteria.push(brandTokenValueCriterion(tokens, 'tokens'));
  criteria.push(...brandTokenAxisCriteria(tokens, 'tokens'));
  criteria.push(...checkRecipeMetadata(body, atPublish));
  return criteria;
};

/**
 * Editorial-voice structural rules (D1, 2026-07-28).
 *
 * `voice_not_a_prompt` is the one that matters and it BLOCKS AT WRITE (status
 * 'missing' regardless of atPublish): a governed voice is third-person data
 * about how a publication sounds, never instructions to a model. Prompt text
 * inside an approved object is an injection the approval silently covered, so
 * it must never land in the store — warning at publish would be too late,
 * because the body is already committed and readable by any agent that fetched
 * it. The marker catalog lives in lib/registry/voice-prose.ts and is the SAME
 * array the object contract publishes, so the rule an agent reads is the rule
 * that rejects it.
 *
 * `voice_frameworks_declared` is the coverage half: a framework set is only
 * useful to a chooser if each entry says when to pick it over its siblings
 * (the recipe types' whenToUse idiom). Warns while drafting, blocks publish.
 */
export const checkEditorialVoice = (body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  if (!isRecord(body)) {
    return [
      crit(
        'voice_not_a_prompt',
        'Voice is data, not a prompt',
        'optional',
        'Voice body shape not recognized (see schema check).'
      ),
    ];
  }

  const criteria: ReadinessCriterion[] = [];

  const promptFindings = findPromptFormattedText(body);
  if (promptFindings.length === 0) {
    criteria.push(crit('voice_not_a_prompt', 'Voice is data, not a prompt', 'complete', ''));
  } else {
    criteria.push(
      crit(
        'voice_not_a_prompt',
        'Voice is data, not a prompt',
        'missing',
        `Prompt-formatted text is not storable in a governed voice — state the voice as a fact about the publication, ` +
          `not as an instruction to a model: ` +
          promptFindings
            .slice(0, 3)
            .map((finding) => `${finding.path} contains ${finding.markerLabel} ("${finding.excerpt}")`)
            .join('; ') +
          (promptFindings.length > 3 ? ` (+${promptFindings.length - 3} more)` : '')
      )
    );
  }

  const frameworks = Array.isArray(body.frameworks) ? body.frameworks : [];
  const undecidable = frameworks
    .map((framework, index) =>
      isRecord(framework) && typeof framework.when_to_use === 'string' && framework.when_to_use.trim().length > 0
        ? undefined
        : isRecord(framework) && typeof framework.framework_id === 'string'
          ? framework.framework_id
          : `#${index}`
    )
    .filter((id): id is string => id !== undefined);
  if (frameworks.length === 0) {
    criteria.push(
      crit(
        'voice_frameworks_declared',
        'Frameworks are choosable',
        atPublish ? 'missing' : 'warning',
        'No frameworks declared — an agent has nothing to choose from and no default to fall back to.'
      )
    );
  } else if (undecidable.length === 0) {
    criteria.push(crit('voice_frameworks_declared', 'Frameworks are choosable', 'complete', ''));
  } else {
    criteria.push(
      crit(
        'voice_frameworks_declared',
        'Frameworks are choosable',
        atPublish ? 'missing' : 'warning',
        `Framework(s) without when_to_use: ${undecidable.join(', ')} — a set of shapes with no selection rule is a coin flip.`
      )
    );
  }

  return criteria;
};

// ─── check 6c: navigation layout rules (T2.1, C§2.3-Navigation) ──────────────

/** Canonical identity of a NavTarget for duplicate detection (key-order-free). */
const targetKey = (target: Record<string, unknown>): string =>
  JSON.stringify(
    Object.keys(target)
      .sort()
      .map((key) => [key, target[key]])
  );

type NavItemish = Record<string, unknown>;

const navItems = (value: unknown): NavItemish[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/**
 * Navigation structural rules (C§2.3-Navigation, finalized by T2.1):
 *
 * - empty groups rejected;
 * - depth ≤ 2 (a top-level item may carry children — one dropdown level, the
 *   only depth Header.astro renders, A§2.2 — but children may not nest);
 * - duplicate item targets *within a group* warn, never reject: the audited
 *   real nav ships 'Early Access' + 'Join Early Access' → the same route
 *   (C§1.7-4) and the contract must not declare the current site invalid.
 *   Deliberately scoped to item targets: an M-5 group target mirroring one of
 *   its own items is the audited dropdown-parent pattern ('Start Here' → '/'
 *   with item 'Home' → '/', C§1.2), and the action↔item duplication is the
 *   editorial T2.9 checkpoint — flagging either here would bury the one
 *   warning the seed verification pins ("exactly one warning class").
 * - `page`-kind targets must point at *published* pages at publish time (a
 *   nav link to an unpublished page 404s — hard failure), warn-only while
 *   drafting. Existence itself is check 3's job; `route`-kind passes through
 *   (Gap Note 2). Without a resolver the criterion reports `optional`.
 */
/**
 * Structural-capacity criterion for a role's `actions[]` slot (T-guardrail).
 * Reads the fixed bounds from the structural-capacity registry so the rule
 * lives as inspectable data, not logic buried here. Within bounds → complete;
 * out of bounds → the rule's level ('warning' always advises; 'missing' warns
 * while drafting and hard-blocks at publish, the established nav idiom). No
 * `min` is configured today, so emptying the slot never trips this.
 */
const navActionsCapacityCriterion = (
  role: string | undefined,
  actionsCount: number,
  atPublish: boolean
): ReadinessCriterion => {
  const label = 'Header action capacity';
  const rule: CapacityRule | undefined = role ? navActionCapacity[role as NavigationBody['role']] : undefined;
  if (!rule) return crit('nav_actions_capacity', label, 'complete', '');

  const blockLevel = rule.level === 'missing' && atPublish ? 'missing' : 'warning';
  if (rule.max !== undefined && actionsCount > rule.max) {
    return crit(
      'nav_actions_capacity',
      label,
      blockLevel,
      `${actionsCount} ${role} action(s) exceed the ${rule.max} this navigation renders comfortably — extra CTAs crowd the menu's shared header width. Remove or consolidate one.`
    );
  }
  if (rule.min !== undefined && actionsCount < rule.min) {
    return crit(
      'nav_actions_capacity',
      label,
      blockLevel,
      `${actionsCount} ${role} action(s) is below the ${rule.min} this navigation expects.`
    );
  }
  return crit('nav_actions_capacity', label, 'complete', '');
};

export const checkNavigationStructure = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  if (!isRecord(body) || !Array.isArray(body.groups)) {
    return [
      crit(
        'nav_structure',
        'Navigation structure',
        'optional',
        'Navigation body shape not recognized (see schema check).'
      ),
    ];
  }

  const emptyGroups: string[] = [];
  const depthProblems: string[] = [];
  const duplicateWarnings: string[] = [];

  for (const group of body.groups) {
    if (!isRecord(group)) continue;
    const groupLabel = typeof group.title === 'string' && group.title ? group.title : String(group.id ?? '(no id)');
    const items = navItems(group.items);

    if (items.length === 0) emptyGroups.push(groupLabel);

    // Depth: group → item (1) → children (2); a child with children is depth 3.
    for (const item of items) {
      for (const child of navItems(item.children)) {
        if (navItems(child.children).length > 0) {
          depthProblems.push(`group "${groupLabel}" item "${String(item.label ?? item.id)}" nests beyond depth 2.`);
        }
      }
    }

    // Duplicate item targets within this group (items + their children).
    const seenTargets = new Map<string, string[]>();
    const collect = (item: NavItemish) => {
      if (isRecord(item.target)) {
        const key = targetKey(item.target);
        seenTargets.set(key, [...(seenTargets.get(key) ?? []), String(item.label ?? item.id ?? '(item)')]);
      }
      for (const child of navItems(item.children)) collect(child);
    };
    for (const item of items) collect(item);
    for (const labels of seenTargets.values()) {
      if (labels.length > 1) {
        duplicateWarnings.push(
          `group "${groupLabel}": ${labels.map((label) => `"${label}"`).join(' and ')} share one target.`
        );
      }
    }
  }

  const criteria: ReadinessCriterion[] = [
    emptyGroups.length === 0
      ? crit('nav_groups', 'No empty groups', 'complete', '')
      : crit('nav_groups', 'No empty groups', 'missing', `Empty group(s): ${emptyGroups.join(', ')}.`),
    depthProblems.length === 0
      ? crit('nav_depth', 'Depth ≤ 2', 'complete', '')
      : crit('nav_depth', 'Depth ≤ 2', 'missing', depthProblems.slice(0, 5).join(' ')),
    duplicateWarnings.length === 0
      ? crit('nav_duplicates', 'Duplicate targets within a group', 'complete', '')
      : crit('nav_duplicates', 'Duplicate targets within a group', 'warning', duplicateWarnings.slice(0, 5).join(' ')),
    navActionsCapacityCriterion(
      typeof body.role === 'string' ? body.role : undefined,
      Array.isArray(body.actions) ? body.actions.length : 0,
      atPublish
    ),
  ];

  // Published-page requirement for page-kind targets (anywhere in the body:
  // items, children, M-5 group targets, actions).
  if (!context.resolveObject) {
    criteria.push(
      crit('nav_published_targets', 'Page targets published', 'optional', 'No object resolver — not verified here.')
    );
    return criteria;
  }
  const unpublished: string[] = [];
  walkObjects(body, (node) => {
    if (node.kind === 'page' && typeof node.page === 'string') {
      const resolution = context.resolveObject?.('page', node.page);
      // Non-existence is check 3's hard failure; only "exists but unpublished" is ours.
      if (resolution?.exists && !resolution.published) unpublished.push(node.page);
    }
  });
  if (unpublished.length === 0) {
    criteria.push(crit('nav_published_targets', 'Page targets published', 'complete', ''));
  } else {
    criteria.push(
      crit(
        'nav_published_targets',
        'Page targets published',
        atPublish ? 'missing' : 'warning',
        `Nav links target unpublished page(s): ${[...new Set(unpublished)].join(', ')} — a published nav must not 404.`
      )
    );
  }
  return criteria;
};

// ─── check 6d: product commerce/fulfillment invariants (06-shop-module-plan §1/§3) ───

// The /shop/<slug> segment shape — same vocabulary as taxonomy slugs.
const PRODUCT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Product rules the product-v1 schema explicitly defers here (plan §1):
 *
 * - slug shape + uniqueness across products (`isSlugTaken`, the route
 *   analogue) — hard write failures;
 * - mode↔fields coherence — `fixed` needs the price cache and forbids pwyw;
 *   `pwyw` needs the pwyw block, has no Stripe Price (§3: Checkout
 *   `custom_unit_amount` enforces the minimum) and no fixed cache; `free`
 *   never touches Stripe (`provider: 'none'`, no price/pwyw/linkage) — hard
 *   write failures, all body-local;
 * - an 'available' fixed-price product must carry Stripe linkage to publish
 *   (`stripe.price_id`, or the pre-launch `stripe_test` mirror, §8.7) —
 *   publish-gated so drafts can exist before `product_set_price` links them;
 * - `fulfillment.artifact_ref` must be a trusted Major-Key artifact ref
 *   (the private-store download, §5) — hard write failure;
 * - `commerce_price_sync` (§3 backstop): the display cache is compared to
 *   the live Stripe Price via the injected resolver — publish-gated;
 *   without a resolver it reports `optional`, never a false failure.
 */
export const checkProduct = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  if (!isRecord(body)) {
    return [
      crit(
        'product_structure',
        'Product structure',
        'optional',
        'Product body shape not recognized (see schema check).'
      ),
    ];
  }
  const criteria: ReadinessCriterion[] = [];

  // Slug shape + uniqueness (§1: /shop/<slug>; unique like isRouteTaken).
  const slug = typeof body.slug === 'string' ? body.slug : '';
  if (!slug) {
    criteria.push(crit('product_slug', 'Slug shape', 'missing', 'slug is required.'));
  } else if (!PRODUCT_SLUG_RE.test(slug)) {
    criteria.push(
      crit('product_slug', 'Slug shape', 'missing', `slug "${slug}" must match ^[a-z0-9]+(?:-[a-z0-9]+)*$.`)
    );
  } else if (context.isSlugTaken) {
    criteria.push(
      context.isSlugTaken(slug)
        ? crit('product_slug', 'Slug uniqueness', 'missing', `slug "${slug}" is already used by another product.`)
        : crit('product_slug', 'Slug uniqueness', 'complete', '')
    );
  } else {
    criteria.push(
      crit('product_slug', 'Slug uniqueness', 'optional', 'No slug resolver — uniqueness not verified here.')
    );
  }

  const commerce = isRecord(body.commerce) ? body.commerce : undefined;
  const stripe = commerce && isRecord(commerce.stripe) ? commerce.stripe : undefined;
  const stripeTest = commerce && isRecord(commerce.stripe_test) ? commerce.stripe_test : undefined;

  // Mode↔fields coherence (§1) — body-local, so always verifiable.
  if (!commerce) {
    criteria.push(
      crit(
        'product_commerce',
        'Commerce mode coherence',
        'optional',
        'Commerce block not recognized (see schema check).'
      )
    );
  } else {
    const problems: string[] = [];
    const mode = commerce.mode;
    if (mode === 'free') {
      if (commerce.provider !== 'none') {
        problems.push("mode 'free' never touches Stripe — provider must be 'none'.");
      }
      for (const key of ['price', 'pwyw', 'stripe', 'stripe_test'] as const) {
        if (commerce[key] !== undefined) problems.push(`mode 'free' forbids commerce.${key}.`);
      }
    }
    if ((mode === 'fixed' || mode === 'pwyw') && commerce.provider !== 'stripe') {
      problems.push(`mode '${String(mode)}' charges through Stripe — provider must be 'stripe'.`);
    }
    if (mode === 'fixed') {
      if (commerce.price === undefined) {
        problems.push(
          "mode 'fixed' requires the price display cache (set at create, or via product_set_price once it ships)."
        );
      }
      if (commerce.pwyw !== undefined) problems.push("mode 'fixed' forbids the pwyw block.");
    }
    if (mode === 'pwyw') {
      const pwyw = isRecord(commerce.pwyw) ? commerce.pwyw : undefined;
      if (!pwyw) problems.push("mode 'pwyw' requires the pwyw block (min_cents at least).");
      if (commerce.price !== undefined) problems.push("mode 'pwyw' has no fixed amount — remove the price cache.");
      // §3: PWYW uses Checkout custom_unit_amount; no Stripe Price exists.
      if (stripe?.price_id !== undefined) {
        problems.push("mode 'pwyw' uses custom_unit_amount, not a Stripe Price — remove stripe.price_id.");
      }
      if (stripeTest?.price_id !== undefined) {
        problems.push("mode 'pwyw' uses custom_unit_amount, not a Stripe Price — remove stripe_test.price_id.");
      }
      if (
        typeof pwyw?.min_cents === 'number' &&
        typeof pwyw?.suggested_cents === 'number' &&
        pwyw.suggested_cents < pwyw.min_cents
      ) {
        problems.push('pwyw.suggested_cents must be at least pwyw.min_cents.');
      }
    }
    criteria.push(
      problems.length === 0
        ? crit('product_commerce', 'Commerce mode coherence', 'complete', '')
        : crit('product_commerce', 'Commerce mode coherence', 'missing', problems.slice(0, 5).join(' '))
    );
  }

  // Stripe linkage for a sellable product — publish-gated so drafts can exist
  // before product_set_price links them (§9-S3); only 'available' products
  // must be buyable (coming_soon/retired publish without linkage).
  if (commerce && commerce.mode === 'fixed' && commerce.availability === 'available') {
    const priceId =
      (typeof stripe?.price_id === 'string' && stripe.price_id) ||
      (typeof stripeTest?.price_id === 'string' && stripeTest.price_id) ||
      '';
    criteria.push(
      priceId
        ? crit('product_linkage', 'Stripe linkage', 'complete', '')
        : crit(
            'product_linkage',
            'Stripe linkage',
            atPublish ? 'missing' : 'warning',
            "An 'available' fixed-price product needs stripe.price_id (or the pre-launch stripe_test mirror) " +
              'before it can publish — link it via product_set_price.'
          )
    );
  } else {
    criteria.push(crit('product_linkage', 'Stripe linkage', 'complete', ''));
  }

  // Fulfillment artifact trust (§1/§5): the download lives in the PRIVATE
  // artifacts store, addressed by a Major-Key ref — same reject rules as
  // every *AssetRef (no URLs, no data:, no repo paths; index-trusted when
  // the trust set is supplied).
  const fulfillment = isRecord(body.fulfillment) ? body.fulfillment : undefined;
  if (fulfillment?.kind === 'download' && typeof fulfillment.artifact_ref === 'string') {
    const problem = validateAssetRef('fulfillment.artifact_ref', fulfillment.artifact_ref, context);
    criteria.push(
      problem
        ? crit(
            'product_artifact',
            'Fulfillment artifact trust',
            problem.kind === 'existence' && !atPublish ? 'warning' : 'missing',
            problem.message
          )
        : crit('product_artifact', 'Fulfillment artifact trust', 'complete', '')
    );
  } else {
    criteria.push(
      crit('product_artifact', 'Fulfillment artifact trust', 'optional', 'No fulfillment artifact for this kind.')
    );
  }

  // §3 backstop for direct Stripe-dashboard edits: compare the display cache
  // to the live Price on publish. The site renders the cache; Checkout
  // charges the price_id — so a mismatch is cosmetic, but worth catching at
  // the next publish rather than never.
  const cache = commerce && isRecord(commerce.price) ? commerce.price : undefined;
  const syncPriceId =
    (typeof stripe?.price_id === 'string' && stripe.price_id) ||
    (typeof stripeTest?.price_id === 'string' && stripeTest.price_id) ||
    '';
  if (!context.resolveStripePrice) {
    criteria.push(
      crit('commerce_price_sync', 'Price cache sync', 'optional', 'No Stripe resolver — cache sync not verified here.')
    );
  } else if (!cache || !syncPriceId) {
    criteria.push(crit('commerce_price_sync', 'Price cache sync', 'optional', 'No cache/linkage pair to compare.'));
  } else {
    const live = context.resolveStripePrice(syncPriceId);
    if (!live) {
      criteria.push(
        crit(
          'commerce_price_sync',
          'Price cache sync',
          'optional',
          `Stripe Price "${syncPriceId}" not resolvable — not verified here.`
        )
      );
    } else if (live.amount_cents !== cache.amount_cents || live.currency !== cache.currency) {
      criteria.push(
        crit(
          'commerce_price_sync',
          'Price cache sync',
          atPublish ? 'missing' : 'warning',
          `Display cache (${String(cache.amount_cents)} ${String(cache.currency)}) does not match the live Stripe ` +
            `Price ${syncPriceId} (${live.amount_cents} ${live.currency}) — re-sync via product_set_price ` +
            'or fix the Price in Stripe.'
        )
      );
    } else {
      criteria.push(crit('commerce_price_sync', 'Price cache sync', 'complete', ''));
    }
  }

  return criteria;
};

// ─── content_item media path + hero rules (bug ② object-path closure) ────────
//
// The renderer serves node media over the blob routes: `type:'image'` →
// `<img src>`, `type:'document'` → an honest download link
// (src/lib/article-object/render-nodes.ts). Nothing validated those srcs, so a
// mistyped path 404'd live, and a PDF in the hero (`body.image.src`) would
// reach Astro's getImage at build — the object-path analogue of the legacy
// PDF-as-featuredImage bug. Raw Major Keys are already blocked by check 5b;
// these rules cover the PATH FORMS: `/img|/pdf/{id}/{sha}.{ext}` is the
// governed value (existence-checked via resolveArtifactRef when available),
// other root-relative site paths and remote https URLs WARN (renderable but
// ungoverned/unverifiable — remote-block is a policy decision flagged for
// Wolf), and everything else (data:, legacy src/assets/, bare relative paths)
// blocks. video/audio/embed srcs are out of scope until they render richer
// than a link.

const IMG_PUBLIC_PATH_RE = /^\/img\/[^/]+\/[0-9a-f]{64}\.[a-z]+$/i;
const PDF_PUBLIC_PATH_RE = /^\/pdf\/[^/]+\/[0-9a-f]{64}\.pdf$/i;

type ArticleMediaProblem = { message: string; kind: 'block' | 'warn' | 'existence' };

const resolvePublicPathExistence = (
  path: string,
  value: string,
  context: ObjectValidationContext
): ArticleMediaProblem | undefined => {
  const resolution = context.resolveArtifactRef?.(rawArtifactRefForPublicPath(value));
  if (!resolution) return undefined;
  if (resolution.deleted) {
    return {
      kind: 'existence',
      message: `${path} "${value}" points at a soft-deleted artifact — restore it (restore_artifact) or re-upload, then retry.`,
    };
  }
  if (!resolution.exists) {
    if (resolution.indexIssue) {
      // The index entry is THERE — platform rejected it. Saying "no artifact behind it"
      // here sends the operator to re-upload bytes that are already stored and serving.
      return {
        kind: 'existence',
        message:
          `${path} "${value}" has an artifact index entry that platform rejected: ${resolution.indexIssue}. ` +
          `The bytes are probably fine — this is a contract mismatch between pdf-tool's stored ArtifactReference ` +
          `and platform's schema, not a missing upload. Re-uploading will not fix it; reconcile the schema.`,
      };
    }
    return {
      kind: 'existence',
      message:
        `${path} "${value}" has no artifact behind it (never uploaded, or the key is mistyped) — it will 404 on the live page. ` +
        `Use the exact blobKey pdf-tool returned (list_artifacts_for_request shows what exists), as its public path.`,
    };
  }
  return undefined;
};

const classifyArticleImageSrc = (
  path: string,
  value: string,
  context: ObjectValidationContext,
  { forbidPdf = false } = {}
): ArticleMediaProblem | undefined => {
  if (BASE64_DATA_URI_RE.test(value)) return { kind: 'block', message: `${path} must not be a data URI.` };
  if (LEGACY_REPO_PATH_RE.test(value))
    return {
      kind: 'block',
      message: `${path} is a legacy repo path (src/assets/…) — not servable from an article object.`,
    };
  if (MAJOR_KEY_ARTIFACT_REF_RE.test(value)) return undefined; // check 5b reports raw keys with the canonical message
  if (forbidPdf && (PDF_PUBLIC_PATH_RE.test(value) || /\.pdf$/i.test(value))) {
    return {
      kind: 'block',
      message:
        `${path} "${value}" is a PDF — the hero image field must hold an IMAGE ` +
        `(a PDF here reaches Astro's getImage and fails the whole build). Link the PDF from a document media node or a /pdf/ ctaLink instead.`,
    };
  }
  if (IMG_PUBLIC_PATH_RE.test(value)) return resolvePublicPathExistence(path, value, context);
  if (REMOTE_URL_RE.test(value)) {
    return {
      kind: 'warn',
      message: `${path} is a remote URL — it bypasses artifact governance and can rot. Prefer a /img/ artifact path (pdf-tool under a storage grant).`,
    };
  }
  if (value.startsWith('/')) {
    return {
      kind: 'warn',
      message: `${path} is a site-static path ("${value}") — existence is not verifiable here. Prefer a /img/ artifact path.`,
    };
  }
  return {
    kind: 'block',
    message: `${path} "${value}" is not a servable image path. Use the /img/{id}/{sha256}.{ext} public path of an uploaded artifact.`,
  };
};

const classifyArticleDocumentSrc = (
  path: string,
  value: string,
  context: ObjectValidationContext
): ArticleMediaProblem | undefined => {
  if (BASE64_DATA_URI_RE.test(value)) return { kind: 'block', message: `${path} must not be a data URI.` };
  if (LEGACY_REPO_PATH_RE.test(value))
    return {
      kind: 'block',
      message: `${path} is a legacy repo path (src/assets/…) — not servable from an article object.`,
    };
  if (MAJOR_KEY_ARTIFACT_REF_RE.test(value)) return undefined; // check 5b reports raw keys
  if (PDF_PUBLIC_PATH_RE.test(value)) return resolvePublicPathExistence(path, value, context);
  if (REMOTE_URL_RE.test(value)) {
    return {
      kind: 'warn',
      message: `${path} is a remote URL — prefer a /pdf/ artifact path (pdf-tool under a storage grant) so the download is governed.`,
    };
  }
  return {
    kind: 'block',
    message: `${path} "${value}" is not a servable document path. Use the /pdf/{id}/{sha256}.pdf public path of an uploaded PDF artifact.`,
  };
};

const checkContentItemMedia = (
  article: ContentItemBody,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  const problems: ArticleMediaProblem[] = [];
  let sawMedia = false;

  const inspect = (problem: ArticleMediaProblem | undefined) => {
    if (problem) problems.push(problem);
  };

  const inspectMediaObject = (path: string, media: { type: string; src: string }) => {
    sawMedia = true;
    if (media.type === 'image') inspect(classifyArticleImageSrc(`${path}.src`, media.src, context));
    if (media.type === 'document') inspect(classifyArticleDocumentSrc(`${path}.src`, media.src, context));
    // video/audio/embed srcs are out of scope (no richer renderer yet).
  };

  article.nodes.forEach((node, index) => {
    const base = `nodes.${index}.public`;
    if (node.public.media) inspectMediaObject(`${base}.media`, node.public.media);
    (node.public.images ?? []).forEach((image, imageIndex) =>
      inspectMediaObject(`${base}.images.${imageIndex}`, image)
    );
    const ctaLink = node.public.ctaLink;
    if (typeof ctaLink === 'string' && (ctaLink.startsWith('/pdf/') || PDF_PUBLIC_PATH_RE.test(ctaLink))) {
      sawMedia = true;
      inspect(classifyArticleDocumentSrc(`${base}.ctaLink`, ctaLink, context));
    }
  });

  if (article.image) {
    sawMedia = true;
    inspect(classifyArticleImageSrc('image.src', article.image.src, context, { forbidPdf: true }));
  }

  if (!sawMedia) return [];

  const blocks = problems.filter((problem) => problem.kind === 'block').map((problem) => problem.message);
  const existence = problems.filter((problem) => problem.kind === 'existence').map((problem) => problem.message);
  const warns = problems.filter((problem) => problem.kind === 'warn').map((problem) => problem.message);

  if (blocks.length > 0) return [crit('article_media', 'Article media paths', 'missing', blocks.slice(0, 5).join(' '))];
  if (existence.length > 0) {
    return [
      crit('article_media', 'Article media paths', atPublish ? 'missing' : 'warning', existence.slice(0, 5).join(' ')),
    ];
  }
  if (warns.length > 0) return [crit('article_media', 'Article media paths', 'warning', warns.slice(0, 5).join(' '))];
  // The index could not be consulted at all for some refs: say so. Passing
  // "complete" here is what let a bad NETLIFY_BLOBS_TOKEN read as a healthy
  // gate on 2026-08-11 — every read threw, nothing was verified, and the only
  // visible signal was silence.
  const unreadable = context.artifactIndexUnreadable ?? [];
  if (unreadable.length > 0) {
    return [
      crit(
        'article_media',
        'Article media paths',
        'warning',
        `the artifact index could not be read for ${unreadable.length} reference(s) ` +
          `(e.g. "${unreadable[0]}") — existence is NOT verified, so a missing or mistyped ` +
          `artifact would not be caught here. This is usually a blob credential fault: check ` +
          `NETLIFY_SITE_ID / NETLIFY_BLOBS_TOKEN on this site (a value that is not a real ` +
          `Netlify PAT fails this way).`
      ),
    ];
  }
  return [crit('article_media', 'Article media paths', 'complete', '')];
};

/**
 * content_item structural invariants (W7.3): node-id uniqueness, slug
 * uniqueness across article objects AND committed legacy posts (one permalink
 * space), and the article-side ≥1-public-content-node rule (A§1.1, carried
 * over) — publish-gated like a page's visible-section minimum.
 */
const checkContentItemStructure = (
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  const parsed = contentItemBodySchema.safeParse(body);
  if (!parsed.success) {
    return [crit('structure', 'Structural invariants', 'optional', 'Body does not parse; see the schema group.')];
  }
  const article = parsed.data;
  const criteria: ReadinessCriterion[] = [];

  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const node of article.nodes) {
    if (seen.has(node.id)) duplicates.add(node.id);
    seen.add(node.id);
  }
  criteria.push(
    duplicates.size === 0
      ? crit('article_node_ids', 'Node id uniqueness', 'complete', '')
      : crit('article_node_ids', 'Node id uniqueness', 'missing', `Duplicate node ids: ${[...duplicates].join(', ')}.`)
  );

  if (context.isArticleSlugTaken) {
    criteria.push(
      context.isArticleSlugTaken(article.slug)
        ? crit(
            'article_slug',
            'Article slug uniqueness',
            'missing',
            `slug "${article.slug}" is already used by another article or a committed post.`
          )
        : crit('article_slug', 'Article slug uniqueness', 'complete', '')
    );
  } else {
    criteria.push(
      crit('article_slug', 'Article slug uniqueness', 'optional', 'No slug resolver — uniqueness not verified here.')
    );
  }

  const publicContentNodes = article.nodes.filter(
    (node: ContentItemNode) => node.kind === 'content' && (node.visibility ?? 'public') === 'public'
  ).length;
  if (publicContentNodes >= 1) {
    criteria.push(crit('article_visible_nodes', 'At least one public content node', 'complete', ''));
  } else {
    criteria.push(
      crit(
        'article_visible_nodes',
        'At least one public content node',
        atPublish ? 'missing' : 'warning',
        atPublish
          ? 'A published article must keep at least one public content node.'
          : 'No public content nodes yet — required before this article can publish.'
      )
    );
  }

  criteria.push(...checkContentItemMedia(article, context, atPublish));

  return criteria;
};

/**
 * T13.1 — the shared `tracking` attribute criterion, uniform across all ten
 * types (12-plan §2). Regex conformance always (mirrors the zod bounds with
 * readable copy); a goal whose `on` activity is not COLLECTABLE for this
 * object type per the §6 matrix (TRACKABLE_ACTIVITIES_BY_TYPE — the shared
 * table validation and the T13.5 renderer both read) warns while drafting
 * and blocks at publish. Store-independent: never reads trk_drlurie —
 * disabled providers are simply skipped at render.
 */
const checkTrackingAttribute = (objectType: ObjectType, body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  const tracking = isRecord(body) ? body.tracking : undefined;
  if (tracking === undefined) return [];
  const label = 'Tracking attribute';
  if (!isRecord(tracking)) {
    return [crit('tracking_attribute', label, 'missing', 'tracking must be an object (see schema check).')];
  }
  const hard: string[] = [];
  const activityProblems: string[] = [];
  const goals = Array.isArray(tracking.goals) ? tracking.goals : [];
  const collectable = TRACKABLE_ACTIVITIES_BY_TYPE[objectType] ?? [];
  goals.filter(isRecord).forEach((goal, index) => {
    const key = typeof goal.goal === 'string' ? goal.goal : '';
    if (!GOAL_KEY_RE.test(key)) {
      hard.push(
        `tracking.goals[${index}].goal ${JSON.stringify(goal.goal)} must be a neutral slug (${String(GOAL_KEY_RE)}) — goal keys reach the page.`
      );
    }
    const conversions = Array.isArray(goal.provider_conversions) ? goal.provider_conversions : [];
    conversions.filter(isRecord).forEach((conversion, conversionIndex) => {
      if (typeof conversion.label !== 'string' || !CONVERSION_LABEL_RE.test(conversion.label)) {
        hard.push(
          `tracking.goals[${index}].provider_conversions[${conversionIndex}].label must match ${String(CONVERSION_LABEL_RE)}.`
        );
      }
    });
    if (typeof goal.on === 'string' && !(collectable as readonly string[]).includes(goal.on)) {
      activityProblems.push(
        `tracking.goals[${index}] binds on '${goal.on}', which is not collectable for ${objectType} (${
          collectable.length > 0 ? `collectable: ${collectable.join(', ')}` : 'this type has no reader events'
        }) — the goal can never fire.`
      );
    }
  });
  if (hard.length > 0) {
    return [crit('tracking_attribute', label, 'missing', hard.slice(0, 3).join(' '))];
  }
  if (activityProblems.length > 0) {
    return [
      crit('tracking_attribute', label, atPublish ? 'missing' : 'warning', activityProblems.slice(0, 3).join(' ')),
    ];
  }
  return [crit('tracking_attribute', label, 'complete', '')];
};

/**
 * T13.2 — `tracking_config_ready` (12-plan §3): the publish criterion for
 * the tracker-registry singleton. Enabled providers must carry their
 * regex-pinned id (the schema already blocks the write; the criterion keeps
 * the WHY readable); banner copy must exist whenever any advertising-class
 * provider is enabled under a posture that can show a banner (≠ 'us-first');
 * `restricted_regions` must be non-empty under 'geo-adaptive'; GTM can never
 * be enabled (permanently OUT, OQ-W13-3). Publish-gating rules warn while
 * drafting. Store-independent — reads only the body.
 */
const checkTrackingConfig = (body: unknown, atPublish: boolean): ReadinessCriterion[] => {
  const label = 'Tracking config readiness';
  if (!isRecord(body) || !isRecord(body.providers) || !isRecord(body.consent)) {
    return [crit('tracking_config_ready', label, 'optional', 'Body shape not recognized (see schema check).')];
  }
  const providers = body.providers;
  const consent = body.consent;

  const hard: string[] = [];
  const publishProblems: string[] = [];

  const idFieldByProvider: Record<string, string> = {
    ga4: 'measurement_id',
    gtm: 'container_id',
    google_ads: 'conversion_id',
    meta_pixel: 'pixel_id',
    taboola: 'account_id',
    outbrain: 'account_id',
    mgid: 'account_id',
    plausible: 'api_host',
  };
  let advertisingEnabled = false;
  for (const [key, idField] of Object.entries(idFieldByProvider)) {
    const block = providers[key];
    if (!isRecord(block) || block.enabled !== true) continue;
    if (key === 'gtm') {
      hard.push('providers.gtm: GTM is permanently OUT (OQ-W13-3) — it can never be enabled.');
      continue;
    }
    const id = block[idField];
    if (typeof id !== 'string' || id.trim() === '') {
      hard.push(`providers.${key}: enabled requires ${idField} to be set (regex-pinned; see the contract).`);
    }
    if (block.consent_class === 'advertising') advertisingEnabled = true;
  }

  const posture = typeof consent.posture === 'string' ? consent.posture : '';
  const banner = consent.banner;
  const bannerPresent =
    isRecord(banner) &&
    typeof banner.headline === 'string' &&
    banner.headline.trim() !== '' &&
    typeof banner.body === 'string' &&
    banner.body.trim() !== '';
  if (advertisingEnabled && posture !== 'us-first' && !bannerPresent) {
    publishProblems.push(
      `consent.banner: an advertising-class provider is enabled under posture '${posture}' — banner copy (headline + body) is required before publish.`
    );
  }
  if (
    posture === 'geo-adaptive' &&
    (!Array.isArray(consent.restricted_regions) || consent.restricted_regions.length === 0)
  ) {
    publishProblems.push(
      "consent.restricted_regions: must be non-empty under 'geo-adaptive' (seed = EEA-30 + UK + CH per OQ-W13-1)."
    );
  }

  if (hard.length > 0) {
    return [crit('tracking_config_ready', label, 'missing', hard.slice(0, 3).join(' '))];
  }
  if (publishProblems.length > 0) {
    return [
      crit('tracking_config_ready', label, atPublish ? 'missing' : 'warning', publishProblems.slice(0, 3).join(' ')),
    ];
  }
  return [crit('tracking_config_ready', label, 'complete', '')];
};

export const checkStructuralInvariants = (
  objectType: ObjectType,
  objectId: string,
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => [
  ...checkTrackingAttribute(objectType, body, atPublish),
  ...checkStructuralInvariantsByType(objectType, objectId, body, context, atPublish),
];

const checkStructuralInvariantsByType = (
  objectType: ObjectType,
  objectId: string,
  body: unknown,
  context: ObjectValidationContext,
  atPublish: boolean
): ReadinessCriterion[] => {
  // Structural invariants are type-specific. Pages carry the ≥1-visible-section
  // + PageType rules below; taxonomy, template, navigation, product and
  // content_item carry their own rules (dispatched here so the pipeline keeps
  // its single 'structure' group).
  if (objectType === 'taxonomy') return checkTaxonomyRegistry(body, context);
  if (objectType === 'tracking_config') return checkTrackingConfig(body, atPublish);
  if (objectType === 'template') return checkTemplate(body, context, atPublish);
  if (objectType === 'section_template') return checkSectionTemplate(body, atPublish);
  if (objectType === 'theme') return checkTheme(body, atPublish);
  if (objectType === 'editorial_voice') return checkEditorialVoice(body, atPublish);
  if (objectType === 'navigation') return checkNavigationStructure(body, context, atPublish);
  if (objectType === 'product') return checkProduct(body, context, atPublish);
  if (objectType === 'content_item') return checkContentItemStructure(body, context, atPublish);
  // The site singleton's brandTokens feed the SAME inline <style> as themes —
  // value safety applies on every site write too (the 09 §7.3 gap).
  if (objectType === 'site') {
    const siteTokens = isRecord(body) ? body.brandTokens : undefined;
    return [brandTokenValueCriterion(siteTokens, 'brandTokens'), ...brandTokenAxisCriteria(siteTokens, 'brandTokens')];
  }

  // content_grid card/limit sanity applies to any body that can carry a grid —
  // a page's inline sections OR a shared `section` wrapper. Emits nothing when
  // no grid is present (so non-grid sections keep the generic result below).
  const gridCriteria = checkContentGridCardLimits(body);

  // The shared-section wrapper enforces the same standalone-placeability rule
  // as pages (the Session-K gap): a leaf-only wrapped instance would break
  // every page that shared_refs it, and a wrapper may not itself be a
  // shared_ref (check 3 already rejects chains at the referencing side; this
  // closes the authoring side).
  if (objectType === 'section') {
    const criteria: ReadinessCriterion[] = [...gridCriteria];
    const instance = isRecord(body) && isRecord(body.section) ? body.section : undefined;
    const type = instance && typeof instance.type === 'string' ? instance.type : undefined;
    if (type !== undefined) {
      criteria.push(
        isStandalonePlaceableSectionType(type)
          ? crit('structure_placeable', 'Standalone-placeable section', 'complete', '')
          : crit(
              'structure_placeable',
              'Standalone-placeable section',
              'missing',
              type === 'shared_ref'
                ? 'A shared section wraps a concrete instance, never another shared_ref (no reference chains).'
                : `Section type "${type}" has no standalone component and would break the build — a card composes only inside a content_grid cards source.`
            )
      );
    }
    return criteria.length > 0
      ? criteria
      : [crit('structure', 'Structural invariants', 'optional', 'No structural invariants for this type.')];
  }

  if (objectType !== 'page') {
    return gridCriteria.length > 0
      ? gridCriteria
      : [crit('structure', 'Structural invariants', 'optional', 'No structural invariants for this type.')];
  }

  const criteria: ReadinessCriterion[] = [...gridCriteria];
  const sections = collectSections(body);
  const visibleCount = sections.filter((section) => section.visibility !== 'hidden').length;

  // Standalone placeability (the Session-K gap): the zod union admits every
  // member, but a leaf-only type (`card`) has no standalone component — the
  // production build died with "No component registered for section type
  // 'card'" on 2026-07-13 after validation admitted one as a top-level page
  // section. Rejected here at write time, the same layer that rejects
  // disallowed types. `shared_ref` stays legal on pages (it dereferences
  // before dispatch); `cards`-source grid CELLS are data, not section
  // instances, and are untouched by this rule.
  const notPlaceable = [
    ...new Set(
      sections
        .filter((section) => section.type !== 'shared_ref' && !isStandalonePlaceableSectionType(section.type))
        .map((section) => section.type)
    ),
  ];
  criteria.push(
    notPlaceable.length === 0
      ? crit('structure_placeable', 'Standalone-placeable sections', 'complete', '')
      : crit(
          'structure_placeable',
          'Standalone-placeable sections',
          'missing',
          `Section type(s) with no standalone component: ${notPlaceable.join(', ')} — placing them directly on a page breaks the build (a card composes only inside a content_grid cards source).`
        )
  );

  // PageType constraint, resolved up front: the ≥N-visible rule below is
  // per-PageType since W6 (content_detail publishes with zero sections — the
  // article is its content), and the allowed/required checks reuse it further
  // down. context.pageType (directly injected, tests) wins over the registry
  // lookup from the body's declared pageType.
  const pageTypeConstraint =
    context.pageType ??
    (isRecord(body) && typeof body.pageType === 'string' ? context.resolvePageType?.(body.pageType) : undefined);

  // Route shape + uniqueness (§2.3-page). Shape is checked here because the
  // body schema only pins `route` to a non-empty string; uniqueness needs the
  // injected resolver (T0.8 supplies it, excluding this page).
  const route = isRecord(body) && typeof body.route === 'string' ? body.route : '';
  if (route && !route.startsWith('/')) {
    criteria.push(crit('structure_route', 'Route shape', 'missing', `route "${route}" must start with "/".`));
  } else if (!route) {
    criteria.push(crit('structure_route', 'Route shape', 'missing', 'route is required.'));
  } else if (context.isRouteTaken) {
    criteria.push(
      context.isRouteTaken(route)
        ? crit('structure_route', 'Route uniqueness', 'missing', `route "${route}" is already used by another page.`)
        : crit('structure_route', 'Route uniqueness', 'complete', '')
    );
  } else {
    criteria.push(
      crit('structure_route', 'Route uniqueness', 'optional', 'No route resolver — uniqueness not verified here.')
    );
  }

  // ≥N visible sections — the analogue of article_body's "≥1 public node"
  // (A§1.1). Publish-gated: a hard failure at publish, a warning while
  // drafting. N defaults to 1; a PageType may lower it (W6: `content_detail`
  // sets 0 — the article IS the page's content, sections are optional extras).
  const minVisible = pageTypeConstraint?.minVisibleSections ?? 1;
  if (visibleCount >= minVisible) {
    criteria.push(
      crit(
        'structure_visible',
        'At least one visible section',
        'complete',
        minVisible === 0 ? `PageType ${pageTypeConstraint?.id ?? ''} publishes without sections.` : ''
      )
    );
  } else {
    criteria.push(
      crit(
        'structure_visible',
        'At least one visible section',
        atPublish ? 'missing' : 'warning',
        atPublish
          ? 'A published page must keep at least one visible section.'
          : 'No visible sections yet — required before this page can publish.'
      )
    );
  }

  // The homepage renderer (src/pages/index.astro) hardcodes loading object id
  // `page_home` and unconditionally throws if navigationOverrides.footer is
  // absent (the homepage uses the nav_footer_home variant, never the site
  // default) — a build-time crash that takes down the ENTIRE static build, not
  // just this page, since Astro's build is all-or-nothing. That coupling is
  // keyed on the literal object id, NOT on pageType — index.astro never reads
  // pageType at all — so this gate checks id first; pageType 'home' is checked
  // too (below) as the general, declared-intent case. Schema-wise
  // `navigationOverrides` is optional (most pages have none), so nothing before
  // this blocked an agent from validly patching/publishing page_home with it
  // missing — discovered for real on 2026-07-10 when four production publishes
  // progressively stripped page_home down to a single section with no
  // navigationOverrides (and, midway, changed its OWN pageType away from
  // 'home' too — which did nothing to stop the crash, proving the id-based
  // gate is the one that matters), passing validation the whole way and only
  // surfacing as an opaque site-wide Netlify build failure. This closes that
  // gap at the layer it belongs in — validation, not a runtime throw
  // discovered on deploy. (Existence-if-present is already checked above via
  // requireObject 'navigationOverrides.footer'; this only adds that presence
  // is REQUIRED.)
  if (objectId === 'page_home' || (isRecord(body) && body.pageType === 'home')) {
    const hasFooterOverride =
      isRecord(body) && isRecord(body.navigationOverrides) && typeof body.navigationOverrides.footer === 'string';
    criteria.push(
      hasFooterOverride
        ? crit('structure_home_footer', 'Home footer override', 'complete', '')
        : crit(
            'structure_home_footer',
            'Home footer override',
            atPublish ? 'missing' : 'warning',
            "The object id 'page_home' (or a page declaring pageType 'home') must set " +
              'navigationOverrides.footer — the renderer requires it unconditionally, and its absence ' +
              'crashes the ENTIRE site build, not just this page.'
          )
    );
  }

  // PageType allowed/required sections (D§3.4) — the constraint was resolved
  // above (it also feeds the visible-section minimum). Without one, not
  // verifiable here.
  if (!pageTypeConstraint) {
    criteria.push(crit('structure_pagetype', 'PageType section rules', 'optional', 'No PageType definition supplied.'));
    return criteria;
  }

  const { allowedSections, requiredSections } = pageTypeConstraint;
  if (allowedSections !== 'any') {
    const allowed = new Set(allowedSections);
    const disallowed: string[] = [];
    for (const section of sections) {
      const type = effectiveSectionType(section, context);
      // A shared_ref whose target type can't be resolved is left to §2.3-section
      // re-validation; don't reject on an unknown effective type here.
      if (type && !allowed.has(type)) disallowed.push(type);
    }
    criteria.push(
      disallowed.length === 0
        ? crit('structure_allowed', 'Allowed section types', 'complete', '')
        : crit(
            'structure_allowed',
            'Allowed section types',
            'missing',
            `Section types not allowed on PageType ${pageTypeConstraint.id ?? ''}: ${[...new Set(disallowed)].join(', ')}.`
          )
    );
  }

  if (requiredSections && requiredSections.length > 0) {
    const present = new Set(sections.map((section) => effectiveSectionType(section, context)).filter(Boolean));
    const missing = requiredSections.filter((type) => !present.has(type));
    if (missing.length === 0) {
      criteria.push(crit('structure_required', 'Required section types', 'complete', ''));
    } else {
      // Publish-gated, like ≥1 visible: reject at publish, warn while drafting.
      criteria.push(
        crit(
          'structure_required',
          'Required section types',
          atPublish ? 'missing' : 'warning',
          `Missing required section types: ${missing.join(', ')}.`
        )
      );
    }
  }

  return criteria;
};

// ─── check 7: renderability (trap 5 — per-component rich-text vocabulary) ────
//
// The global RichText allowlist (check 1) permits h2/h3/ul/ol everywhere, but
// most components render their `body` through splitRichTextParagraphs, which
// THROWS at build time on anything but top-level <p> blocks — so a body could
// pass validation and still kill the next release build. This check calls the
// REAL splitters (never a re-implementation, so it cannot drift from what the
// build actually does) on every field a component will split.

const PARAGRAPH_BODY_TYPES = new Set([
  'hero',
  'lede',
  'bio',
  'cta_banner',
  'newsletter_signup',
  'content_grid',
  'content_split',
]);

const splitterProblem = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  // The splitter appends the full body JSON — name the rule, not the payload.
  return message.split(' Received:')[0];
};

// What the W7.3 article renderer can actually turn into HTML today: the full
// prose vocabulary plus quotes. Embeds (embedded-entry/asset blocks) are in
// the rich_text.v1 universe but have NO resolver on the article render path
// yet — a document carrying one would throw at build (the renderer's
// never-silently-drop contract), so it is blocked at write instead (trap 5's
// rule: what would kill the build is a blocker, not a surprise).
const ARTICLE_RENDERABLE_GRAMMAR: RichTextGrammar = {
  enabledNodeTypes: [...PROSE_GRAMMAR.enabledNodeTypes, BLOCKS.QUOTE],
  enabledMarks: PROSE_GRAMMAR.enabledMarks,
};

const SAFE_RICH_TEXT_HREF_RE = /^https?:\/\//i;

/** Grammar + link-safety problems for one rich_text.v1 node body. */
const richTextDocumentProblems = (at: string, doc: unknown): string[] => {
  const parsed = richTextV1Schema.safeParse(doc);
  if (!parsed.success) return []; // the schema group owns shape failures
  const problems = validateRichTextGrammar(parsed.data, ARTICLE_RENDERABLE_GRAMMAR).map(
    (violation) => `${at}: ${violation} (embeds arrive with their resolvers; use prose blocks and quotes).`
  );
  const walkLinks = (node: { nodeType?: string; data?: Record<string, unknown>; content?: unknown[] }): void => {
    if (node.nodeType === INLINES.HYPERLINK) {
      const uri = isRecord(node.data) && typeof node.data.uri === 'string' ? node.data.uri : '';
      if (!SAFE_RICH_TEXT_HREF_RE.test(uri)) problems.push(`${at}: hyperlink uri "${uri}" must be http(s).`);
    }
    for (const child of node.content ?? []) {
      if (isRecord(child)) walkLinks(child as { nodeType?: string });
    }
  };
  walkLinks(parsed.data as { nodeType?: string });
  return problems;
};

const checkContentItemRenderability = (body: unknown): ReadinessCriterion[] => {
  const parsed = contentItemBodySchema.safeParse(body);
  if (!parsed.success) return [crit('render_splitters', 'Component renderability', 'complete', '')];
  const problems: string[] = [];
  for (const node of parsed.data.nodes) {
    const nodeBody = node.public.body;
    if (nodeBody !== undefined && typeof nodeBody !== 'string') {
      problems.push(...richTextDocumentProblems(`node '${node.id}' body`, nodeBody));
    }
  }
  return [
    problems.length === 0
      ? crit('render_splitters', 'Component renderability', 'complete', '')
      : crit('render_splitters', 'Component renderability', 'missing', problems.slice(0, 3).join(' ')),
  ];
};

export const checkRenderability = (objectType: ObjectType, body: unknown): ReadinessCriterion[] => {
  if (objectType === 'content_item') return checkContentItemRenderability(body);
  // A shared 'section' object wraps one instance; a section_template's
  // blueprint IS one instance (W8) — run the real splitters over it too, so a
  // recipe can never stamp a build-breaking body.
  const wrappedInstance = (key: 'section' | 'blueprint'): SectionInstance[] => {
    const instance = isRecord(body) ? body[key] : undefined;
    return isRecord(instance) && typeof instance.type === 'string' ? [instance as SectionInstance] : [];
  };
  const sections: SectionInstance[] =
    objectType === 'page' && isRecord(body)
      ? collectSections(body)
      : objectType === 'section'
        ? wrappedInstance('section')
        : objectType === 'section_template'
          ? wrappedInstance('blueprint')
          : [];
  if (sections.length === 0) {
    return [crit('render_splitters', 'Component renderability', 'complete', '')];
  }

  const problems: string[] = [];
  for (const section of sections) {
    if (!isRecord(section.data)) continue;
    const at = `section '${section.id}' (${section.type})`;
    const data = section.data as Record<string, unknown>;
    try {
      if (section.type === 'prose' && typeof data.body === 'string') splitRichTextBlocks(data.body);
      else if (PARAGRAPH_BODY_TYPES.has(section.type) && typeof data.body === 'string')
        splitRichTextParagraphs(data.body);
    } catch (error) {
      const hint =
        section.type === 'prose'
          ? '(prose accepts only top-level <p>/<h2>/<h3>/<ul>/<ol> blocks — bare text must be wrapped in <p>)'
          : "(this component is paragraph-only — headings/lists belong in a 'prose' section)";
      problems.push(`${at} body would fail the site build: ${splitterProblem(error)} ${hint}.`);
    }
    if (section.type === 'faq' && Array.isArray(data.items)) {
      data.items.forEach((item, index) => {
        if (!isRecord(item) || typeof item.a !== 'string') return;
        try {
          splitRichTextParagraphs(item.a);
        } catch (error) {
          problems.push(
            `${at} items[${index}].a would fail the site build: ${splitterProblem(error)} (FAQ answers are paragraph-only).`
          );
        }
      });
    }
  }
  return [
    problems.length === 0
      ? crit('render_splitters', 'Component renderability', 'complete', '')
      : crit('render_splitters', 'Component renderability', 'missing', problems.slice(0, 3).join(' ')),
  ];
};

// The schemas deliberately admit taxonomy targets, but the Astro resolver has
// no taxonomy-export-to-route implementation yet. Treat that mismatch exactly
// like the rich-text splitter mismatches above: reject it at every governed
// write boundary instead of discovering it as an all-site build failure during
// release. Page targets are renderable now via the committed Page collection.
const NAV_TARGET_RENDERED_OBJECT_TYPES = new Set<ObjectType>([
  'navigation',
  'page',
  'section',
  'template',
  'section_template',
]);

export const checkRenderTargetSupport = (
  objectType: ObjectType,
  body: unknown,
  context: ObjectValidationContext = {},
  atPublish = false
): ReadinessCriterion[] => {
  if (!NAV_TARGET_RENDERED_OBJECT_TYPES.has(objectType)) {
    return [crit('render_nav_targets', 'Navigation target renderability', 'complete', '')];
  }

  const taxonomyTargets: string[] = [];
  const unpublishedPages: string[] = [];
  let pageResolutionUnavailable = false;
  walkObjects(body, (node) => {
    if (
      node.kind === 'taxonomy' &&
      (node.termKind === 'category' || node.termKind === 'tag') &&
      typeof node.term_id === 'string'
    ) {
      taxonomyTargets.push(`${node.termKind}/${node.term_id}`);
    }
    if (node.kind === 'page' && typeof node.page === 'string') {
      const resolution = context.resolveObject?.('page', node.page);
      if (resolution === undefined) pageResolutionUnavailable = true;
      else if (resolution.exists && !resolution.published) unpublishedPages.push(node.page);
    }
  });

  const criteria: ReadinessCriterion[] = [
    taxonomyTargets.length === 0
      ? crit('render_nav_targets', 'Navigation target renderability', 'complete', '')
      : crit(
          'render_nav_targets',
          'Navigation target renderability',
          'missing',
          `Taxonomy target(s) are not renderable by the site yet: ${[...new Set(taxonomyTargets)].join(
            ', '
          )}. Use a route-kind target with the public category/tag URL until taxonomy target resolution is implemented.`
        ),
  ];

  if (unpublishedPages.length > 0) {
    criteria.push(
      crit(
        'render_page_targets_published',
        'Page target exports available',
        atPublish ? 'missing' : 'warning',
        `Page target(s) are not published: ${[...new Set(unpublishedPages)].join(
          ', '
        )}. Publish each target Page first so its committed route export exists before this object is released.`
      )
    );
  } else if (pageResolutionUnavailable) {
    criteria.push(
      crit(
        'render_page_targets_published',
        'Page target exports available',
        'optional',
        'No object resolver — published Page exports not verified here.'
      )
    );
  } else {
    criteria.push(crit('render_page_targets_published', 'Page target exports available', 'complete', ''));
  }

  return criteria;
};

// ─── check 8: deploy safety (trap 14 — content the secrets scanner blocks) ───
//
// Netlify's post-build secrets scan fails EVERY deploy when the value of a
// secret-marked env var appears in repo files or build output — hit for real
// 2026-07-11 when an agent set an image URL through a proxy of
// raw.githubusercontent.com/<repo>/… (the repo slug is GITHUB_REPOSITORY's
// value; the scanner matches even URL-encoded forms). Two rules, both
// blockers, both checked on every string leaf (exports commit the WHOLE body
// to the repo, `notes` included):
//   1. no string may contain a protected env value (raw, URL-encoded, or
//      double-encoded; matched case-insensitively) — the error names the KEY,
//      never the value;
//   2. no repo-file hotlinks: raw.githubusercontent.com / githubusercontent
//      proxies (images.weserv.nl) are forbidden URL families — fragile AND
//      the incident vector.

const PROTECTED_ENV_KEYS = [
  'GITHUB_REPOSITORY',
  'GITHUB_CONTENT_TOKEN',
  'PUBLISH_SECRET',
  'NETLIFY_PUBLISH_SECRET',
  'NETLIFY_AUTH_TOKEN',
  'NETLIFY_BLOBS_TOKEN',
  'NETLIFY_BUILD_HOOK_URL',
  'OPENAI_API_KEY',
  'ARTIFACT_UPLOAD_TOKEN_SECRET',
  // PF1: the per-site scoped CMS-Agent bearer. Only the TOKEN belongs here —
  // CMS_AGENT_MCP_ENDPOINT is a public URL, and CMS_AGENT_CHAT_MODE's values
  // ('off'/'fallback'/'required') are ordinary English long enough to clear the
  // 8-char scan floor, so listing either would block deploys on innocent copy.
  'CMS_AGENT_MCP_TOKEN',
  // Commerce (06-shop-module-plan §8.5): the keys are env-only; Stripe IDS in
  // content are fine (ids aren't secrets), but a pasted key would block every
  // deploy exactly as the portrait URL did. Both mode pairs (§8.7) plus the
  // purchase-token signing secret.
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_SECRET_KEY_TEST',
  'STRIPE_WEBHOOK_SECRET_TEST',
  'PURCHASE_TOKEN_SECRET',
] as const;

export type ProtectedValue = { key: string; value: string };

/** Values worth scanning for: present and long enough to never match innocent copy. */
export const protectedEnvValues = (env: NodeJS.ProcessEnv = process.env): ProtectedValue[] =>
  PROTECTED_ENV_KEYS.flatMap((key) => {
    const value = (env[key] ?? '').trim();
    return value.length >= 8 ? [{ key, value }] : [];
  });

const FORBIDDEN_URL_RE = /raw\.githubusercontent\.com|images\.weserv\.nl/i;

export const checkDeploySafety = (
  body: unknown,
  protectedValues: ProtectedValue[] = protectedEnvValues()
): ReadinessCriterion[] => {
  const problems: string[] = [];
  const needles = protectedValues.map(({ key, value }) => ({
    key,
    variants: [value, encodeURIComponent(value), encodeURIComponent(encodeURIComponent(value))].map((variant) =>
      variant.toLowerCase()
    ),
  }));
  walkStrings(body, (path, leaf) => {
    const at = path.join('.') || '(root)';
    if (FORBIDDEN_URL_RE.test(leaf)) {
      problems.push(
        `${at}: links a repository file (raw.githubusercontent.com / images.weserv.nl proxy) — use a site asset URL instead; this URL family blocks every production deploy.`
      );
    }
    const lower = leaf.toLowerCase();
    for (const needle of needles) {
      if (needle.variants.some((variant) => lower.includes(variant))) {
        problems.push(
          `${at}: contains the value of protected env var ${needle.key} — the deploy secrets scanner blocks ALL production deploys while this is in published content.`
        );
        break;
      }
    }
  });
  return [
    problems.length === 0
      ? crit('deploy_safety', 'Deploy safety', 'complete', '')
      : crit('deploy_safety', 'Deploy safety', 'missing', problems.slice(0, 3).join(' ')),
  ];
};

// ─── pipeline composition ────────────────────────────────────────────────────

export const validateObject = (
  input: ObjectValidationInput,
  context: ObjectValidationContext = {}
): ReadinessGroup[] => {
  const atPublish = Boolean(context.publishIntent || input.published);

  return [
    { id: 'schema', label: 'Schema validity', criteria: checkSchema(input.objectType, input.body) },
    {
      id: 'identifiers',
      label: 'ID discipline',
      criteria: checkIdDiscipline(input.objectType, input.objectId, input.body),
    },
    {
      id: 'references',
      label: 'Reference integrity',
      criteria: checkReferenceIntegrity(input.objectType, input.body, context),
    },
    { id: 'reader_safety', label: 'Reader safety', criteria: checkReaderSafety(input.body, input.objectType) },
    {
      id: 'renderability',
      label: 'Component renderability',
      criteria: [
        ...checkRenderability(input.objectType, input.body),
        ...checkRenderTargetSupport(input.objectType, input.body, context, atPublish),
        ...checkRenderableImageRefs(input.body),
      ],
    },
    { id: 'deploy_safety', label: 'Deploy safety', criteria: checkDeploySafety(input.body) },
    {
      id: 'artifact_trust',
      label: 'Media / artifact trust',
      criteria: [
        ...checkArtifactTrust(input.body, context, atPublish),
        ...checkMediaBudget(input.body, context, atPublish),
      ],
    },
    {
      id: 'structure',
      label: 'Structural invariants',
      criteria: checkStructuralInvariants(input.objectType, input.objectId, input.body, context, atPublish),
    },
  ];
};

export type ValidationSummary = {
  level: 'missing' | 'warning' | 'ready';
  /** eligible for review = no hard failures (C§2.0). */
  eligible: boolean;
  blockers: ReadinessCriterion[];
  warnings: ReadinessCriterion[];
};

export const summarizeValidation = (groups: ReadinessGroup[]): ValidationSummary => {
  const all = groups.flatMap((group) => group.criteria);
  const blockers = all.filter((criterion) => criterion.status === 'missing');
  const warnings = all.filter((criterion) => criterion.status === 'warning');
  const level: ValidationSummary['level'] = blockers.length > 0 ? 'missing' : warnings.length > 0 ? 'warning' : 'ready';
  return { level, eligible: blockers.length === 0, blockers, warnings };
};

// ─── candidate-patch dry-run (object_validate {candidate_patch?}, C§2.0) ──────

// A fixed timestamp: the dry-run discards the produced record and validates
// only its body, so the history stamp is irrelevant (and Date.now() is avoided
// to keep validation deterministic).
const DRY_RUN_AT = '1970-01-01T00:00:00.000Z';
const DRY_RUN_ACTOR: Principal = { kind: 'agent', agent_name: 'object_validate', auth: 'publish_key' };

export type CandidatePatchValidation = {
  /** True only when the ops applied AND the resulting body is eligible. */
  eligible: boolean;
  groups: ReadinessGroup[];
  /** Present iff T0.6's engine refused the patch (the ops never applied). */
  applyError?: { code: PatchApplyError['code']; message: string };
};

/**
 * The `object_validate {candidate_patch?}` dry-run (C§2.0): apply the proposed
 * ops through **T0.6's real engine** (`applyPatchOps`) — never a hand-rolled
 * simulation — then run the resulting body through the same six-check pipeline.
 *
 * A patch T0.6 refuses (an unknown/typo'd op discriminant → `invalid_op`, a
 * blind revert → `blind_revert_refused`, a slug-rename alias conflict →
 * `alias_required`/`alias_conflict`, etc.) surfaces LOUDLY as a hard `missing`
 * criterion carrying T0.6's real error code — it is never silently dropped.
 * Because the engine owns the op discriminants (its `patchOpSchema.parse`
 * rejects any unknown `op`), this validator inherits exhaustiveness for free
 * and cannot drift from the grammar's member names.
 */
export const validateCandidatePatch = (
  record: ObjectRecord<unknown>,
  ops: readonly unknown[],
  context: ObjectValidationContext = {},
  // Privileged, non-submittable ops to accept (site_apply_theme's dry_run passes
  // ['set_site_brand_tokens']); an agent object_validate passes none, so a
  // hand-authored privileged op dry-runs as op_not_applicable — honest.
  privilegedOps: readonly string[] = []
): CandidatePatchValidation => {
  let appliedBody: unknown;
  try {
    const result = applyPatchOps(record, ops, { actor: DRY_RUN_ACTOR, at: DRY_RUN_AT, privilegedOps });
    appliedBody = result.record.body;
  } catch (error) {
    if (error instanceof PatchApplyError) {
      const groups: ReadinessGroup[] = [
        {
          id: 'patch',
          label: 'Candidate patch',
          criteria: [crit('patch_apply', 'Candidate patch applies', 'missing', `${error.code}: ${error.message}`)],
        },
      ];
      return { eligible: false, groups, applyError: { code: error.code, message: error.message } };
    }
    throw error;
  }

  const bodyGroups = validateObject(
    {
      objectType: record.object_type,
      objectId: record.object_id,
      body: appliedBody,
      published: record.publication.published_time != null,
    },
    context
  );
  const groups: ReadinessGroup[] = [
    {
      id: 'patch',
      label: 'Candidate patch',
      criteria: [crit('patch_apply', 'Candidate patch applies', 'complete', '')],
    },
    ...bodyGroups,
  ];
  return { eligible: summarizeValidation(groups).eligible, groups };
};
