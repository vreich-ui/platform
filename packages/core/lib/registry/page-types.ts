/**
 * PageType registry v1 (T3.1) — the D§3.4 code registry.
 *
 * Lives in code, not Blobs (OQ-4): PageTypes bind to Astro route files and
 * loaders that are necessarily code. Exposed read-only through the MCP
 * `registry_get` tool (replacing the T0.9 stub); shared across sites.
 *
 * v1 shipped the three types Phase 3 needed — `home`, `standard`, `system`.
 * W6 (T6.1, 2026-07-12) formalized the last two: `listing` (the blog
 * list/category/tag/topics loaders — the query machinery stays the audited
 * build-time derivation, A§2.5–2.7; the page object owns headings/SEO) and
 * `content_detail` (the SinglePost article surface — route-level SEO defaults
 * plus optional sections rendered after the article; the article body itself
 * stays outside the object model, OQ-8). All five PageTypeIds are now defined.
 *
 * Review policy (D§3.9): pages are review-required across the board —
 * `page` is Tier 2, so publish is agent-executable but only after an
 * approval pinned to the reviewed content_revision (+ M-6 publish action).
 * `publishRoles` names the HUMAN roles allowed to execute a publish; the
 * agent capability class is governed by the tier gate, not listed here.
 */
import { z } from 'zod';

import { pageTypeIdSchema, type PageTypeId } from '../../schema/bodies/page-v1.js';
import { contentQuerySchema, sectionTypeSchema, type SectionInstance } from '../../schema/bodies/section-v1.js';
import { publishRequiresApproval, type ApprovalPolicy } from '../approval-policy.js';

type SectionType = SectionInstance['type'];

/** Mirrors netlify/lib/roles.ts `Role` (D§3.9) — src code must not import netlify/lib. */
export type PublishRole = 'admin' | 'publisher' | 'editor';

export type ReviewPolicy = {
  required: boolean;
  minApprovals: number;
  publishRoles: PublishRole[];
};

export type PageTypeListing = {
  source: 'content_items';
  defaultQuery: z.infer<typeof contentQuerySchema>;
  paginate: boolean;
};

export type PageTypeDefinition = {
  id: PageTypeId;
  routePattern: string;
  allowedSections: SectionType[] | 'any';
  requiredSections?: SectionType[];
  listing?: PageTypeListing;
  /**
   * Minimum count of visible (non-hidden) sections a page must keep to
   * publish. Defaults to 1 (the A§1.1 "≥1 public node" analogue) when absent.
   * `content_detail` sets 0: its content IS the article — the page object
   * exists for route-level SEO defaults, and sections are optional extras
   * rendered after the post.
   */
  minVisibleSections?: number;
  reviewPolicy: ReviewPolicy;
};

/** D§3.9: pages are review-required; one approval; humans with publish capability execute. */
const PAGE_REVIEW_POLICY: ReviewPolicy = {
  required: true,
  minApprovals: 1,
  publishRoles: ['admin', 'publisher'],
};

/**
 * The definitions, keyed by id. All five PageTypeIds are defined as of W6;
 * `getPageTypeDefinition` still distinguishes "unknown id" from "known but
 * not yet implemented" so a future enum addition fails loudly, not silently.
 */
export const pageTypeDefinitions: Partial<Record<PageTypeId, PageTypeDefinition>> = {
  home: {
    id: 'home',
    routePattern: '/',
    // The C§1.1 homepage record uses hero, checklist, content_grid, bio, and
    // a shared_ref to the newsletter section; the allowlist pins exactly that
    // family so a stray contact_form or product_preview on the homepage is a
    // validation failure, not a surprise.
    allowedSections: ['hero', 'checklist', 'content_grid', 'bio', 'newsletter_signup', 'shared_ref'],
    requiredSections: ['hero'],
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
  clone: {
    id: 'clone',
    // Descriptive only — routePattern is metadata and is not enforced anywhere, so a clone may sit
    // at '/' alongside the home type without contradiction.
    routePattern: '/[...captured]',
    // A capture reproduces what a source page contains; it does not get to choose from a curated
    // family. Any registered section may appear.
    allowedSections: 'any',
    // Deliberately NO requiredSections. `home` requires a hero; a captured page may legitimately
    // have none, and failing the whole page for that would discard content the capture did map.
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
  standard: {
    id: 'standard',
    routePattern: '/[slug]',
    // The general-purpose type: any registered section may appear.
    allowedSections: 'any',
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
  system: {
    id: 'system',
    routePattern: '/[system]', // 404, terms, privacy — fixed routes, prose-led
    allowedSections: ['hero', 'prose', 'link_list', 'cta_banner'],
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
  listing: {
    id: 'listing',
    // Five loader files bind here: src/pages/[...blog]/[...page].astro (the
    // library), [...blog]/[category|tag]/[...page].astro, and the topics hub
    // pair under src/pages/learn/topics/. The loaders keep the audited
    // build-time derivation (getStaticPathsBlogList/Category/Tag, fetchPosts —
    // A§2.5–2.7); the page object supplies the editable header copy (its first
    // `lede` section, `%term%` interpolated on per-term surfaces), SEO, and
    // any extra sections rendered after the list.
    routePattern: '/[...listing]',
    allowedSections: ['lede', 'prose', 'cta_banner', 'newsletter_signup', 'content_grid', 'link_list', 'shared_ref'],
    // The first lede IS the listing header block — a listing page without one
    // has no editable heading, so it is required (publish-gated, D§3.4).
    requiredSections: ['lede'],
    listing: {
      source: 'content_items',
      // The per-surface term filter (category/tag) is the loader's derivation;
      // the default is the unfiltered newest-first feed every listing starts from.
      defaultQuery: { sort: 'published_time_desc' },
      paginate: true,
    },
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
  content_detail: {
    id: 'content_detail',
    // Binds to src/pages/[...blog]/index.astro (the SinglePost surface). The
    // article body stays outside the object model (OQ-8); `page_article`
    // carries route-level SEO defaults plus optional sections rendered after
    // the article (no lede — the post supplies its own heading).
    routePattern: '/[...blog]',
    allowedSections: ['prose', 'cta_banner', 'newsletter_signup', 'content_grid', 'link_list', 'shared_ref'],
    minVisibleSections: 0,
    reviewPolicy: PAGE_REVIEW_POLICY,
  },
};

/**
 * T15.8 ("one approval truth on the platform"): every PageTypeDefinition
 * above hardcodes the SAME `PAGE_REVIEW_POLICY` constant — there has never
 * been genuine per-PageType granularity here, because `publish-gate.ts`
 * gates by governed OBJECT TYPE (`'page'`, one bucket covering every
 * PageTypeId), never by PageType. That made the static constant a second,
 * independent copy of a fact `approval-policy.ts` already decides — and on
 * every fleet site, which sets `master: 'all-autonomous'`, the two already
 * disagreed: this registry told an MCP caller `required: true` for the
 * `clone` page type while `publish-gate.ts` allowed a direct, unapproved
 * publish for the same object.
 *
 * `resolvePageTypeReviewPolicy` closes that gap by DERIVING `required` from
 * the live approval policy for the one governed type every PageType maps to
 * (`'page'`) — `approval-policy.ts` stays the sole deciding layer;
 * `minApprovals`/`publishRoles` are unaffected (they only matter once
 * `required` is true). `PAGE_REVIEW_POLICY` remains the fail-closed default
 * used when no policy is supplied — a client-safe caller (no server context,
 * e.g. a build-time or admin-UI read with no policy provider handy) still
 * sees the conservative `required: true`, never a silent "ask" → "auto" flip
 * for want of a policy argument.
 */
export const resolvePageTypeReviewPolicy = (policy: ApprovalPolicy): ReviewPolicy => ({
  ...PAGE_REVIEW_POLICY,
  required: publishRequiresApproval('page', policy),
});

const withResolvedReviewPolicy = (definition: PageTypeDefinition, policy?: ApprovalPolicy): PageTypeDefinition =>
  policy === undefined ? definition : { ...definition, reviewPolicy: resolvePageTypeReviewPolicy(policy) };

export type PageTypeLookup =
  | { ok: true; definition: PageTypeDefinition }
  | { ok: false; reason: 'unknown_page_type' | 'not_yet_implemented' };

/** `policy`, when supplied, derives `reviewPolicy.required` live from
 *  `approval-policy.ts` (see `resolvePageTypeReviewPolicy`) instead of the
 *  static default — pass the site's `activeApprovalPolicy()` from any
 *  server-side caller (e.g. `registry_get`) so the two layers cannot
 *  contradict each other. */
export const getPageTypeDefinition = (id: string, policy?: ApprovalPolicy): PageTypeLookup => {
  const parsed = pageTypeIdSchema.safeParse(id);
  if (!parsed.success) return { ok: false, reason: 'unknown_page_type' };
  const definition = pageTypeDefinitions[parsed.data];
  return definition ? { ok: true, definition: withResolvedReviewPolicy(definition, policy) } : { ok: false, reason: 'not_yet_implemented' };
};

export const listPageTypeDefinitions = (policy?: ApprovalPolicy): PageTypeDefinition[] =>
  Object.values(pageTypeDefinitions)
    .filter((definition): definition is PageTypeDefinition => Boolean(definition))
    .map((definition) => withResolvedReviewPolicy(definition, policy));

/** Ids typed in the enum but not yet defined here — empty since W6; surfaced by registry_get. */
export const unimplementedPageTypeIds = (): PageTypeId[] =>
  pageTypeIdSchema.options.filter((id) => !pageTypeDefinitions[id]);

/**
 * The JSON-schema rendering of the per-definition field constraints, for MCP
 * consumers that cannot execute zod (T3.1 verify criterion). Kept next to the
 * data so the two cannot drift: sections come from the same sectionTypeSchema
 * the validator uses.
 */
export const pageTypeDefinitionJsonSchema = () =>
  z.toJSONSchema(
    z
      .object({
        id: pageTypeIdSchema,
        routePattern: z.string().min(1),
        allowedSections: z.union([z.array(sectionTypeSchema), z.literal('any')]),
        requiredSections: z.array(sectionTypeSchema).optional(),
        listing: z
          .object({
            source: z.literal('content_items'),
            defaultQuery: contentQuerySchema,
            paginate: z.boolean(),
          })
          .strict()
          .optional(),
        minVisibleSections: z.number().int().nonnegative().optional(),
        reviewPolicy: z
          .object({
            required: z.boolean(),
            minApprovals: z.number().int().positive(),
            publishRoles: z.array(z.enum(['admin', 'publisher', 'editor'])),
          })
          .strict(),
      })
      .strict()
  );
