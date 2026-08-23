/**
 * Page render resolver (T3.6, D§4.2) — the pure layer between a published
 * Page export and the component registry.
 *
 * It does the three dereferences the registry components deliberately do NOT
 * do themselves (they own only layout, receiving `{data, resolved, ctx}`):
 *
 *   1. shared_ref → the target shared section's own variant. No component ever
 *      sees a `shared_ref`; the renderer swaps it for the inline section the
 *      referenced object wraps (D§3.5).
 *   2. hero action targets → hrefs (HeroResolved.actionHrefs, aligned by
 *      index). The href policy is injected (`resolveActionHref`) so this module
 *      stays free of Astro's permalink helper and is unit-testable offline.
 *   3. page metadata → the Layout's metadata prop. The `home` PageType uses its
 *      title verbatim (ignoreTitleTemplate), matching the audited homepage.
 *
 * Kept pure (no astro:content / Astro imports): the caller (the page loader)
 * performs the async collection loads and injects sync resolvers, so these
 * rules stay testable without a build. A `cards` content_grid renders its
 * curated cells from data (only cell links resolve, to hrefs); `manual`/
 * `query` sources resolve here (T3.9) via resolve-content-grid.ts (M-8).
 */
import type { NavTarget } from '../../schema/bodies/navigation-v1.js';
import { pageBodySchema, type PageBody } from '../../schema/bodies/page-v1.js';
import {
  sectionBodySchema,
  type ContentGridSource,
  type ProductPreviewSource,
  type ProductQuery,
} from '../../schema/bodies/section-v1.js';
import type {
  ContentEmbedCard,
  ContentGridCard,
  PricingTierResolved,
  ProductPreviewCard,
  RenderCtx,
  SectionType,
} from '../../lib/registry/components/types.js';
import { resolveContentGridCards, type ContentGridResolvers } from './resolve-content-grid.js';

/** A section ready for component-registry dispatch: `{data, resolved, ctx}` plus its stable page key. */
export type RenderableSection = {
  id: string;
  type: SectionType;
  data: unknown;
  resolved: unknown;
  ctx: RenderCtx;
  /**
   * When the instance was a `shared_ref`, the target section OBJECT id
   * (sec_*) it dereferenced to. Render output is unaffected; the edit-mode
   * canvas annotation reads it so an in-place edit is routed to the shared
   * object (where it belongs) instead of the referencing page.
   */
  sharedObjectId?: string;
  /**
   * T13.5 (W13): the OWNING object set `tracking.enabled: false` — the
   * annotation layer emits `data-cms-track="off"` so the loader skips this
   * wrapper's subtree. For inline sections the page's flag propagates; for
   * shared_refs the target section object's own flag governs.
   */
  trackingOff?: boolean;
};

/** The Layout `metadata` prop this page renders with. */
export type PageRenderMetadata = {
  title: string;
  description?: string;
  ignoreTitleTemplate?: true;
  openGraph?: { images: Array<{ url: string; width: number; height: number }> };
};

export type ResolvedPage = {
  metadata: PageRenderMetadata;
  sections: RenderableSection[];
};

/** Internal identity for de-duplicating manual picks against fallback-query backfill. */
type ContentGridCardInternal = ContentGridCard & { id: string };

export type ResolvePageDeps = {
  /** Resolve a hero action's target to its href (route/asset via permalink, external verbatim, listing → blog). */
  resolveActionHref: (target: NavTarget) => string;
  /** Dereference a shared_ref target object id to the inline section it wraps. */
  resolveSharedSection: (sectionObjectId: string) => {
    type: SectionType;
    data: unknown;
    visibility?: 'public' | 'hidden';
    /** T13.5: the shared OBJECT set tracking.enabled:false. */
    trackingOff?: boolean;
  };
  /**
   * Resolvers for content_grid `manual`/`query` sources (M-8, T3.9). A `cards`
   * source needs none — its curated cells live in data. Required only when a
   * page actually carries a `manual`/`query` content_grid section.
   */
  contentGrid?: ContentGridResolvers<ContentGridCardInternal>;
  /**
   * Resolve a content_embed's `contentItem` id to a link card (D§2.5 bridge to
   * the article grammar). Returns undefined for a missing/unpublished item.
   * Required only when a page actually carries a content_embed section.
   */
  resolveContentEmbed?: (contentItemId: string) => ContentEmbedCard | undefined;
  /**
   * Resolvers for product_preview `manual`/`query` sources (S2 — the M-8
   * pattern over product objects). Required only when a page actually carries
   * a product-backed product_preview section.
   */
  productGrid?: ContentGridResolvers<ProductPreviewCardInternal, ProductQuery>;
  /**
   * Resolve one pricing_table tier's product reference from commerce data
   * (W5). undefined = the product no longer resolves — the component skips
   * the tier (temporal drift, never fatal). Required only when a page carries
   * a pricing_table section.
   */
  resolvePricingTier?: (productId: string) => PricingTierResolved | undefined;
};

// The audited homepage OG image is emitted at these fixed dimensions; page.v1
// seo carries only the url, so the renderer supplies the standard card size.
const OG_IMAGE_DIMENSIONS = { width: 1200, height: 630 } as const;

/** Strip the T1.1 `__generated` provenance marker from a derived export. */
const stripGenerated = (data: unknown): unknown => {
  if (!data || typeof data !== 'object') return data;
  const { __generated, ...rest } = data as Record<string, unknown>;
  void __generated;
  return rest;
};

/** Parse a page export (marker stripped) into its validated body. */
export const parsePageExport = (data: unknown): PageBody => pageBodySchema.parse(stripGenerated(data));

/**
 * Parse a shared-section export into the inline `{type, data, visibility}` a
 * shared_ref dereferences to. `visibility` is carried so the resolver can
 * honor a shared section hidden AT ITS OWN OBJECT (`set_section_visibility`
 * on the section object) — hide once, hidden everywhere it is referenced.
 */
export const parseSharedSectionExport = (
  data: unknown
): { type: SectionType; data: unknown; visibility?: 'public' | 'hidden'; trackingOff?: boolean } => {
  const body = sectionBodySchema.parse(stripGenerated(data));
  return {
    type: body.section.type,
    data: body.section.data,
    ...(body.section.visibility !== undefined ? { visibility: body.section.visibility } : {}),
    // T13.5: a shared section OBJECT with tracking.enabled:false opts its
    // wrapper out everywhere it is referenced (data-cms-track="off").
    ...(body.tracking?.enabled === false ? { trackingOff: true } : {}),
  };
};

type HeroLikeData = { actions?: Array<{ target: NavTarget }> };
type LinkListLikeData = { links?: Array<{ target: NavTarget }> };
type ProductPreviewLikeData = { source: ProductPreviewSource; limit: number };
type PricingTableLikeData = { tiers?: Array<{ product: string }> };
/** Internal identity for de-duplicating product manual picks against fallback backfill. */
type ProductPreviewCardInternal = ProductPreviewCard;
type ContentGridLikeData = { source: ContentGridSource; limit: number };

const resolvedFor = (type: SectionType, data: unknown, deps: ResolvePageDeps): unknown => {
  // hero, lede, cta_banner and form_confirmation share the action-hrefs resolved shape.
  if (type === 'hero' || type === 'lede' || type === 'cta_banner' || type === 'form_confirmation') {
    return {
      actionHrefs: ((data as HeroLikeData).actions ?? []).map((action) => deps.resolveActionHref(action.target)),
    };
  }
  // link_list resolves its `links` with the same target policy (LinkListResolved).
  if (type === 'link_list') {
    return {
      linkHrefs: ((data as LinkListLikeData).links ?? []).map((link) => deps.resolveActionHref(link.target)),
    };
  }
  // product_preview (S2): the M-8 semantics over PRODUCT objects. `cards`
  // renders curated cells (only their optional actions resolve); manual/query
  // resolve to product cards via the injected resolvers.
  if (type === 'product_preview') {
    const { source, limit } = data as ProductPreviewLikeData;
    if (source.kind === 'cards') {
      return {
        cardHrefs: source.cards.map((card) => (card.action ? deps.resolveActionHref(card.action.target) : undefined)),
      };
    }
    if (!deps.productGrid) {
      throw new Error(
        'index: a manual/query product_preview section requires productGrid resolvers to be supplied to resolvePage.'
      );
    }
    return { cards: resolveContentGridCards(source, limit, deps.productGrid) };
  }
  // brand_row (T10.5): per-logo optional targets resolve like actions.
  if (type === 'brand_row') {
    const logos = (data as { logos?: Array<{ target?: NavTarget }> }).logos ?? [];
    return { logoHrefs: logos.map((logo) => (logo.target ? deps.resolveActionHref(logo.target) : undefined)) };
  }
  // composition (T12.31): one href list per ACTION BLOCK, in block order. See
  // CompositionResolved for why it is not indexed by position in `blocks`.
  if (type === 'composition') {
    const blocks = (data as { blocks?: Array<{ kind?: string; actions?: Array<{ target: NavTarget }> }> }).blocks ?? [];
    return {
      actionHrefs: blocks
        .filter((block) => block?.kind === 'actions')
        .map((block) => (block.actions ?? []).map((action) => deps.resolveActionHref(action.target))),
    };
  }
  // content_split shares the action-hrefs policy.
  if (type === 'content_split') {
    return {
      actionHrefs: ((data as HeroLikeData).actions ?? []).map((action) => deps.resolveActionHref(action.target)),
    };
  }
  // pricing_table (W5): tiers resolve against commerce data, index-aligned.
  if (type === 'pricing_table') {
    const tiers = (data as PricingTableLikeData).tiers ?? [];
    if (!deps.resolvePricingTier) {
      throw new Error('index: a pricing_table section requires resolvePricingTier to be supplied to resolvePage.');
    }
    return { tiers: tiers.map((tier) => deps.resolvePricingTier?.(tier.product)) };
  }
  if (type === 'content_embed') {
    if (!deps.resolveContentEmbed) {
      throw new Error('index: a content_embed section requires resolveContentEmbed to be supplied to resolvePage.');
    }
    return { card: deps.resolveContentEmbed((data as { contentItem: string }).contentItem) };
  }
  if (type === 'content_grid') {
    const gridData = data as ContentGridLikeData;
    // A `cards` source renders its curated cells verbatim from data; only each
    // cell's optional link target needs resolving (same policy as hero actions),
    // aligned by cell index.
    if (gridData.source.kind === 'cards') {
      return {
        cardHrefs: gridData.source.cards.map((cell) =>
          cell.link ? deps.resolveActionHref(cell.link.target) : undefined
        ),
      };
    }
    if (!deps.contentGrid) {
      throw new Error(
        `index: content_grid source kind '${gridData.source.kind}' requires contentGrid resolvers to be supplied to resolvePage.`
      );
    }
    return { cards: resolveContentGridCards(gridData.source, gridData.limit, deps.contentGrid) };
  }
  return {};
};

const renderable = (
  id: string,
  type: SectionType,
  data: unknown,
  deps: ResolvePageDeps,
  sharedObjectId?: string,
  trackingOff?: boolean
): RenderableSection => ({
  id,
  type,
  data,
  resolved: resolvedFor(type, data, deps),
  ctx: {},
  ...(sharedObjectId ? { sharedObjectId } : {}),
  ...(trackingOff ? { trackingOff: true } : {}),
});

/**
 * Resolve a bare section list (W6): the listing surfaces render object
 * sections around their derived list furniture, not through a whole-page
 * body, so the section half of resolvePage is exported on its own.
 *
 * Never-render-private (A§1.1): a section with `visibility: 'hidden'` is
 * skipped — whether hidden on the PAGE (the instance, including a hidden
 * shared_ref) or, for a shared_ref, hidden at the TARGET section object
 * (hide the shared section once, it disappears from every page referencing
 * it). This mirrors the validator's `structure_visible` count, which already
 * treats hidden sections as not rendered.
 */
export const resolveSections = (
  sections: PageBody['sections'],
  deps: ResolvePageDeps,
  options: { trackingOff?: boolean } = {}
): RenderableSection[] =>
  sections
    .filter((section) => section.visibility !== 'hidden')
    .flatMap((section) => {
      if (section.type === 'shared_ref') {
        // Render the referenced shared section as its own variant, keyed by the
        // page section id so React-style keys stay stable and unique per page.
        const target = deps.resolveSharedSection(section.data.section);
        if (target.visibility === 'hidden') return [];
        return [
          renderable(
            section.id,
            target.type,
            target.data,
            deps,
            section.data.section,
            // The shared OBJECT's flag governs its wrapper; the page-level
            // flag also covers everything the page places.
            target.trackingOff === true || options.trackingOff === true
          ),
        ];
      }
      return [renderable(section.id, section.type, section.data, deps, undefined, options.trackingOff === true)];
    });

export const resolvePageSections = (page: PageBody, deps: ResolvePageDeps): RenderableSection[] =>
  resolveSections(page.sections, deps, { trackingOff: page.tracking?.enabled === false });

export const resolvePageMetadata = (page: PageBody): PageRenderMetadata => ({
  title: page.title,
  ...(page.seo.description ? { description: page.seo.description } : {}),
  ...(page.pageType === 'home' ? { ignoreTitleTemplate: true as const } : {}),
  ...(page.seo.ogImage ? { openGraph: { images: [{ url: page.seo.ogImage, ...OG_IMAGE_DIMENSIONS }] } } : {}),
});

export const resolvePage = (page: PageBody, deps: ResolvePageDeps): ResolvedPage => ({
  metadata: resolvePageMetadata(page),
  sections: resolvePageSections(page, deps),
});
