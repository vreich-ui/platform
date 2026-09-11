/**
 * Component registry contracts (T3.2, D§3.5/D§4.2).
 *
 * The single field-level source of truth for every section type stays in
 * `src/schema/bodies/section-v1.ts` — the exact schemas the T0.7 validator
 * runs. Registry modules do not redeclare fields; they LOOK UP their
 * variant's `data` schema from the live discriminated union via
 * `sectionVariantDataSchema`, so the registry cannot drift from validation.
 *
 * Testability split (deliberate, documented deviation from the D§3.5
 * interface listing `component` on the per-type module): per-type modules
 * are pure TypeScript ({type, schema, editor, resolveRefs?}) so the repo's
 * tsc + node--test harness can execute them; the `.astro` component binding
 * happens once in `index.ts` (which only Astro's vite pipeline loads).
 * Growth cost stays "one registry module + one union member" plus a
 * one-line binding.
 */
import { z } from 'zod';

import { sectionInstanceSchema, type SectionInstance } from '../../../schema/bodies/section-v1.js';
import type { RegionId } from '../region-ids.js';

export type SectionType = SectionInstance['type'];

/** The variant's `data` payload type for a given section type. */
export type SectionDataOf<TType extends SectionType> = Extract<SectionInstance, { type: TType }>['data'];

/**
 * The variant's `data` zod schema, extracted from the live union — identity
 * with the validator by construction.
 */
export const sectionVariantDataSchema = (type: SectionType): z.ZodType<unknown> => {
  const option = sectionInstanceSchema.options.find((candidate) => candidate.shape.type.value === type);
  if (!option) throw new Error(`No section variant '${type}' in sectionInstanceSchema`);
  return option.shape.data;
};

/**
 * Editor affordances (replaces input-bank.ts's template role for pages,
 * D§3.5). Consumed by the page editor at T3.12; `defaultData` is the
 * "insert new section" blueprint and must parse under the type's schema
 * (pinned by tests).
 */
export type FieldHint = {
  label: string;
  help?: string;
  widget?: 'text' | 'richtext' | 'text_list' | 'link_actions' | 'select' | 'number' | 'cards' | 'image_url' | 'hidden';
};

export type ComponentEditorHints<TType extends SectionType> = {
  label: string;
  icon: string;
  /**
   * One-line "reach for this when…" (W8.3b) — the type-choosing agent reads
   * this before any schema, so contrast with sibling types where confusion
   * is likely (hero vs lede, checklist vs steps, link_list vs content_grid).
   * Flows automatically into object_contract.section_types and registry_get.
   */
  useWhen?: string;
  fieldHints: Partial<Record<keyof SectionDataOf<TType> & string, FieldHint>>;
  defaultData: SectionDataOf<TType>;
};

/**
 * D§4.2: dereferenced pointers computed by the Renderer at build time. Each
 * type declares its own resolved shape; types with no references resolve to
 * an empty object. The resolver machinery itself arrives with T3.6
 * (`src/lib/renderer/resolve.ts`) — the shapes are the contract it fills.
 */
export type HeroResolved = {
  /** hrefs for data.actions, aligned by index (page/route targets → urls). */
  actionHrefs: string[];
};
/** link_list: hrefs for data.links, aligned by index (same policy as actions). */
export type LinkListResolved = {
  linkHrefs: string[];
};
/**
 * product_preview (S2): `manual`/`query` sources resolve to product `cards`
 * from published + available product objects; the price badge is derived from
 * `commerce.mode` ("$19" / "Pay what you want" / "Free"). A `cards` source
 * renders its curated cells from data — only each cell's optional action
 * resolves, to `cardHrefs` aligned by index. Exactly one of the two fields is
 * populated per grid (the ContentGridResolved pattern).
 */
export type ProductPreviewCard = {
  id: string; // product object id (prod_…)
  title: string;
  excerpt?: string;
  image?: { src: string; alt: string };
  href: string; // /shop/<slug>
  priceBadge: string;
};
export type ProductPreviewResolved = {
  cards?: ProductPreviewCard[];
  cardHrefs?: Array<string | undefined>;
};
/**
 * composition (T12.31): hrefs for every ACTION BLOCK's actions.
 *
 * Indexed by the block's position among ACTION BLOCKS — not by its position in
 * `blocks`. A composition interleaves text, images and actions freely, so a
 * blocks-indexed array would be mostly holes and would shift whenever a text
 * block was added. `actionHrefs[n][m]` is the m-th action of the n-th action
 * block, and both indexes are stable under edits to the other kinds.
 */
export type CompositionResolved = {
  actionHrefs: string[][];
};
/** content_split: hrefs for data.actions, aligned by index (the hero policy). */
export type ContentSplitResolved = {
  actionHrefs: string[];
};
/**
 * pricing_table (W5): each tier's product reference resolved from the SAME
 * commerce data the shop renders — title (tier override wins), price badge by
 * mode, availability, and the product page href. `undefined` where the
 * product no longer resolves (skipped with a build warning, never fatal —
 * the content_grid temporal-drift rule).
 */
export type PricingTierResolved = {
  title: string;
  priceBadge: string;
  available: boolean;
  href: string;
};
export type PricingTableResolved = {
  tiers: Array<PricingTierResolved | undefined>;
};
/**
 * content_embed: the referenced content_item resolved to a link card. `card` is
 * absent when the article is missing or unpublished — an embed of a
 * not-yet-published item simply renders nothing rather than failing the page.
 */
export type ContentEmbedCard = { title: string; href: string; excerpt?: string };
export type ContentEmbedResolved = { card?: ContentEmbedCard };
export type EmptyResolved = Record<string, never>;

/**
 * content_grid (M-8, T3.9): `manual`/`query` sources resolve to `cards` here.
 * A `cards` source renders its curated cells from data instead — only each
 * cell's optional link needs resolving, to `cardHrefs` aligned by cell index
 * (undefined where a cell carries no link). Exactly one of the two fields is
 * populated per grid, keyed by the source kind.
 */
export type ContentGridCard = { title: string; description?: string; href?: string };
export type ContentGridResolved = { cards?: ContentGridCard[]; cardHrefs?: Array<string | undefined> };

/** Read-only site context (D§4.2). Populated from the Site export in P5; opaque until then. */
export type RenderCtx = Record<string, unknown>;

export type SectionRenderProps<TData, TResolved> = {
  data: TData;
  resolved: TResolved;
  ctx: RenderCtx;
};

/**
 * WHERE a section type is allowed to live, and how much of the viewport it
 * takes when it lives at an edge (W1 T1.1).
 *
 * The reader side of a page is not one list — it is a header, an optional
 * announcement strip, the ordered flow of sections, and (reserved for later
 * waves) sticky/floating/overlay layers. Until this type existed, every
 * section kind was implicitly `flow` and nothing said so, so the first sticky
 * kind would have had to invent the vocabulary at the same time as the
 * behaviour. Declaring it now, while the answer is `flow` for all 25 kinds,
 * is what makes the region table derivable rather than hand-authored.
 *
 * `footprint` is REQUIRED: `region-registry.ts` keys a total `Record` off the
 * registered-type list, so a new kind cannot be added without saying where it
 * goes.
 */
export type SectionFootprint = {
  /** The region this kind may be placed in. Every kind bound today is `flow`. */
  region: RegionId;
  /** For an edge-pinned kind: which edge. Meaningless (and absent) in `flow`. */
  edge?: 'top' | 'bottom';
  /**
   * The share of a small viewport an edge-pinned kind occupies, as a band
   * rather than a number — xs ≈ 8 %, s ≈ 12 %, m ≈ 20 %. Feeds
   * `structure_viewport_budget`, which is a no-op while no kind declares one.
   */
  heightClass?: 'xs' | 's' | 'm';
  /** At most one instance of this kind per page (`structure_singletons`). */
  singleton?: boolean;
};

/** The pure (node-testable) part of a per-type registry module. */
export type SectionComponentDefinition<TType extends SectionType, TResolved> = {
  type: TType;
  schema: z.ZodType<unknown>;
  editor: ComponentEditorHints<TType>;
  /** Where this kind may be placed — see SectionFootprint. Required since W1 T1.1. */
  footprint: SectionFootprint;
  /** Renderer hook (T3.6): computes TResolved from data. Absent = no references. */
  resolveRefs?: (data: SectionDataOf<TType>, ctx: RenderCtx) => Promise<TResolved>;
  /**
   * Block-tree bounds (docs/cms-architecture/block-tree.md): the child block
   * types this type may contain, and how many. Absent = a **leaf** (no children).
   * Validation walks the tree and enforces these at every node; `object_contract`
   * surfaces them so an agent knows the legal tree grammar before acting. This
   * generalizes `PageType.allowedSections` / `Template.slots.allowed` to every
   * container block.
   */
  allowedChildren?: SectionType[];
  childCount?: { min?: number; max?: number };
};
