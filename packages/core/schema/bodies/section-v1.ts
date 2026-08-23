/**
 * Section instances + the shared-section wrapper — 'section.v1' (D§3.5, D§2.5).
 *
 * Sections are a strict discriminated union on `type` — deliberately NOT the
 * article node's combinatorial pattern (audit fork #1, D§2.5). Growth = one
 * new union member + one component-registry module; this file owns only the
 * data shapes.
 *
 * Two flavors (D§2.5): inline instances embedded in a Page body, and shared
 * sections stored as their own 'section' object (body = the wrapper at the
 * bottom of this file) referenced via the `shared_ref` union member.
 * `shared_ref` carries ONLY the target's ObjectId — never a shadow copy of the
 * target's type or data; the Renderer (and admin preview) dereference it to
 * the target's current variant before validation and render dispatch.
 *
 * The transitional `static` variant (04-phased-plan P3) is RETIRED (2026-07-10,
 * home-page conversion): its sanctioned replacement is the `cards` source —
 * curated card cells (title/description/optional link) an agent composes
 * directly, the flat-data form of the block-tree's `card` children
 * (docs/cms-architecture/block-tree.md, bounded by the same max the registry's
 * `childCount` declares). Unlike `manual`, `cards` claims no content_item
 * references, so reference integrity is not implicated — the cells ARE the
 * curated copy, not pointers at it.
 *
 * M-8 (content_grid manual-primary + query fallback) landed at T3.3: the
 * manual source carries an optional `fallback` query; resolution semantics
 * live in src/lib/renderer/resolve-content-grid.ts.
 *
 * Reference integrity (shared_ref targets exist and are sections, manual grid
 * items resolve, query terms exist — C§2.0/C§2.3) is the validation pipeline's
 * job (T0.7), not this schema's.
 */
import { z } from 'zod';

import { linkActionSchema, navTargetSchema, richTextSchema } from './navigation-v1.js';
import { trackingAttributeShape } from './tracking-attribute-v1.js';

export const SECTION_SCHEMA_VERSION = 'section.v1';

// Opaque like n_* node ids (A§1.1), stable across edits (D§3.5).
export const sectionInstanceIdSchema = z.string().regex(/^s_[a-z0-9]+$/, {
  message: 'Section ids must match s_<lowercase alphanumerics>',
});

// Minimally pinned: the docs reference ContentQuery (D§3.4/D§3.5) without a
// field-level definition; this captures the audited listing pattern's filter
// axes (category/tag terms — A§2.5–2.6). Term resolution against the taxonomy
// registry is T0.7/T3.3 territory; refine there, not here.
export const contentQuerySchema = z
  .object({
    category: z.string().optional(), // taxonomy term_id
    tags: z.array(z.string()).optional(), // taxonomy term_ids
    sort: z.enum(['published_time_desc', 'published_time_asc']).optional(),
  })
  .strict();
export type ContentQuery = z.infer<typeof contentQuerySchema>;

// A curated product card — the `cards` escape hatch of product_preview's
// source union (the content_grid `cards` precedent): hand-written cells for
// a promo row that shouldn't be object-backed.
export const productCardSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().optional(),
    imageAssetRef: z.string().optional(),
    action: linkActionSchema.optional(),
  })
  .strict();
export type ProductCard = z.infer<typeof productCardSchema>;

// Product query (S2, 06-shop-module-plan §4): v1 has exactly one query —
// "every published product with availability 'available'" — so the shape is
// an empty strict object; fields (mode, tag, sort) grow on demand, never
// speculatively (design-principles rule 1).
export const productQuerySchema = z.object({}).strict();
export type ProductQuery = z.infer<typeof productQuerySchema>;

/** Bounded composition, like CONTENT_GRID_MAX_CARDS. */
export const PRODUCT_PREVIEW_MAX_CARDS = 12;

// The M-8 source pattern over PRODUCT objects (manual-primary with query
// fallback; resolution in src/lib/renderer/resolve.ts via the shared
// resolveContentGridCards semantics). All three commerce modes render in one
// grid; the resolved card's price badge comes from `commerce.mode`.
export const productPreviewSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query'), query: productQuerySchema }).strict(),
  z
    .object({
      kind: z.literal('manual'),
      items: z.array(z.string().min(1)), // product object ids (prod_…)
      fallback: z
        .object({ kind: z.literal('query'), query: productQuerySchema })
        .strict()
        .optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('cards'),
      cards: z.array(productCardSchema).max(PRODUCT_PREVIEW_MAX_CARDS),
    })
    .strict(),
]);
export type ProductPreviewSource = z.infer<typeof productPreviewSourceSchema>;

// ─── media items (W10 T10.5) ─────────────────────────────────────────────────
// Image or provider-allowlisted video. The video carries provider + ID only
// (regex-pinned); the embed URL is a CODE-owned template in Media.astro —
// data never carries a playable URL (the write+render safety posture).
export const MEDIA_MAX_ITEMS = 8;
export const BRAND_ROW_MAX_LOGOS = 8;
/** `composition` bounds — a residue section, not a page builder. */
export const COMPOSITION_MAX_IMAGES = 12;
export const COMPOSITION_MAX_BLOCKS = 24;

export const STATS_MAX_ITEMS = 6;
export const TIMELINE_MAX_MILESTONES = 8;
export const COMPARISON_MAX_COLUMNS = 4;
export const COMPARISON_MAX_ROWS = 12;

export const MEDIA_VIDEO_ID_RE = /^[A-Za-z0-9_-]{4,20}$/;

const mediaImageItemSchema = z
  .object({
    kind: z.literal('image'),
    src: z.string().min(1),
    alt: z.string().min(1),
    caption: z.string().optional(),
  })
  .strict();
const mediaVideoItemSchema = z
  .object({
    kind: z.literal('video'),
    provider: z.enum(['youtube', 'vimeo']),
    videoId: z.string().regex(MEDIA_VIDEO_ID_RE),
    /** Accessible name for the embed frame. */
    title: z.string().min(1),
    poster: z
      .object({ src: z.string().min(1), alt: z.string().min(1) })
      .strict()
      .optional(),
    caption: z.string().optional(),
  })
  .strict();
export const mediaItemSchema = z.discriminatedUnion('kind', [mediaImageItemSchema, mediaVideoItemSchema]);
export type MediaItem = z.infer<typeof mediaItemSchema>;

const sectionVariant = <TType extends string, TData extends z.ZodRawShape>(type: TType, data: TData) =>
  z
    .object({
      id: sectionInstanceIdSchema,
      // Subset of node visibility (A§1.1); 'internal' dropped deliberately (D§3.5).
      visibility: z.enum(['public', 'hidden']).optional(),
      notes: z.string().optional(), // editor/agent notes; never rendered (assert-reader-safe)
      type: z.literal(type),
      data: z.object(data).strict(),
    })
    .strict();

// A curated grid cell — the flat-data form of the block-tree `card` leaf
// (title/description/link). At least one of title/description must be present:
// a title-only cell is a headline card, a description-only cell a text card
// (the audience grid's shape). `link` makes the cell navigable; its target is
// resolved by the renderer exactly like hero/lede actions. `icon` is an
// optional Tabler icon name (e.g. 'tabler:school') rendered above the cell —
// the "features / how we can help" grid shape (/contact) an agent composes as
// curated cards rather than a bespoke per-page type.
export const gridCardCellSchema = z
  .object({
    icon: z.string().min(1).optional(),
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    link: linkActionSchema.optional(),
  })
  .strict()
  .refine((cell) => cell.title !== undefined || cell.description !== undefined, {
    message: 'A grid card needs a title or a description.',
  });
export type GridCardCell = z.infer<typeof gridCardCellSchema>;

/** Bounded composition: mirrors contentGridDefinition.childCount.max (block-tree.md). */
export const CONTENT_GRID_MAX_CARDS = 8;

/**
 * Selection algorithms for a `related` content_grid (the "other articles to
 * read" block, 2026-07-12): `tag_similarity` is the site's existing related-
 * posts scoring (same category +5, each shared tag +1 — utils/blog.ts
 * rankRelatedPosts), `same_category` filters to the current post's category,
 * `latest` is newest-first. All are relative to the CURRENT content item when
 * the rendering surface provides one (the article route passes it); without
 * one they degrade to `latest`, so the same section is legal on any page.
 */
// `random` (2026-07-13) is a DETERMINISTIC seeded shuffle — seeded by the
// anchor post id when present (varied per article, stable across builds so it
// never churns the build-diff) and by a fixed salt otherwise. A static site
// has no per-request randomness; this is "a different-looking set per page."
export const relatedAlgorithmSchema = z.enum(['tag_similarity', 'same_category', 'latest', 'random']);
export type RelatedAlgorithm = z.infer<typeof relatedAlgorithmSchema>;

export const contentGridSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('query'), query: contentQuerySchema }).strict(),
  // Related-to-the-current-item selection (see relatedAlgorithmSchema above).
  z.object({ kind: z.literal('related'), algorithm: relatedAlgorithmSchema }).strict(),
  // M-8 (settled S-1, applied at T3.3): manual-primary with optional query
  // fallback. Resolution order (src/lib/renderer/resolve-content-grid.ts):
  // manual refs first — each MUST resolve to a published content item — then
  // fallback-query backfill up to `limit`, de-duplicated against the manual
  // picks. An empty manual list with a fallback is pure-fallback by design.
  z
    .object({
      kind: z.literal('manual'),
      items: z.array(z.string().min(1)),
      fallback: z
        .object({ kind: z.literal('query'), query: contentQuerySchema })
        .strict()
        .optional(),
    })
    .strict(),
  // Curated cells composed directly on the grid (replaces the retired
  // transitional `static` variant). Bounded like the block-tree child rule.
  z
    .object({
      kind: z.literal('cards'),
      cards: z.array(gridCardCellSchema).max(CONTENT_GRID_MAX_CARDS),
    })
    .strict(),
]);
export type ContentGridSource = z.infer<typeof contentGridSourceSchema>;

export const sectionInstanceSchema = z.discriminatedUnion('type', [
  sectionVariant('hero', {
    kicker: z.string().optional(),
    heading: z.string().min(1),
    body: richTextSchema.optional(),
    actions: z.array(linkActionSchema),
    // T10.6 ratified variant (rule 6): pre-built class mappings in Hero.astro.
    // Absent = 'center' = today's render byte-exactly.
    variant: z.enum(['center', 'split', 'background']).optional(),
  }),
  sectionVariant('prose', {
    body: richTextSchema,
  }),
  // Interior-page lede (T4.2): the kicker + h1 + intro + actions block the
  // audited standalone pages open with (start-here, newsletter, member-updates,
  // free-guide, early-access — A§2.x). Same field shape as `hero` but a
  // distinct, lighter presentation (interior pages, not the landing hero), so
  // it is its own type with its own component (Lede.astro), not a hero variant.
  sectionVariant('lede', {
    kicker: z.string().optional(),
    heading: z.string().min(1),
    body: richTextSchema.optional(),
    actions: z.array(linkActionSchema),
    anchor: z.string().optional(),
  }),
  // "This is for you if…" (A§2.1)
  // M-9 (T3.2, 2026-07-06): optional `kicker` (the small uppercase lead-in
  // line every audited homepage section renders) and `anchor` (the public
  // DOM id, e.g. "audience" — content, not layout: it is URL-addressable)
  // added to the four homepage variants. Without them the C§1.1 record
  // cannot reproduce the audited markup and the T3.6 byte-identical
  // cutover gate is unreachable. All additive-optional; no records of
  // these types exist in production yet.
  sectionVariant('checklist', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    items: z.array(z.string()),
    anchor: z.string().optional(),
  }),
  sectionVariant('bio', {
    kicker: z.string().optional(),
    heading: z.string().min(1),
    portraitAssetRef: z.string().optional(),
    // A rendered portrait image by URL (the reusable "person intro" got a photo
    // when /about was decomposed, 2026-07-10). Distinct from `portraitAssetRef`
    // (the trusted-artifact path, validated + still unrendered): `src`/`alt` do
    // NOT match the *AssetRef key convention, so a plain site-asset URL is
    // legal here and skips artifact-trust validation. Optional — a bio without
    // it renders exactly as before (the homepage bio is unaffected).
    portrait: z
      .object({ src: z.string().min(1), alt: z.string().min(1) })
      .strict()
      .optional(),
    body: richTextSchema,
    trustNotes: z.array(z.string()),
    // M-9: the audited "Educational content only. Not medical advice." line.
    disclaimer: z.string().optional(),
    anchor: z.string().optional(),
  }),
  // Replaces the placeholder grid (A§2.1).
  sectionVariant('content_grid', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    // M-9: the audited intro paragraph under the grid heading.
    body: richTextSchema.optional(),
    source: contentGridSourceSchema,
    limit: z.number().int().positive(),
    // Tiles per row (2026-07-13). Optional; the renderer defaults to 2, so an
    // unset grid is byte-identical to before. `limit` sets the tile count;
    // rows follow as ceil(limit / columns).
    columns: z.number().int().min(1).max(4).optional(),
    anchor: z.string().optional(),
  }),
  sectionVariant('newsletter_signup', {
    kicker: z.string().optional(),
    heading: z.string().min(1),
    body: richTextSchema.optional(),
    formName: z.string().min(1),
    consentText: z.string().optional(),
    anchor: z.string().optional(),
  }),
  sectionVariant('contact_form', {
    formName: z.string().min(1),
    heading: z.string().min(1),
    // Optional intro copy shown between the heading and the form: `subtitle`
    // sits under the heading, `description` is fine print above the field set.
    // Both plain text (not rich) — the form is furniture, the copy is data.
    subtitle: z.string().optional(),
    description: z.string().optional(),
    disclaimer: z.string().optional(),
  }),
  // (The bespoke single-use `contact` type was RETIRED 2026-07-11: /contact is
  // now composed from reusable lede + contact_form + content_grid (cards with
  // icons) sections, so the one-page anti-pattern type has no instances — same
  // move as `about` (2026-07-10). History in state-of-play.md.)
  sectionVariant('cta_banner', {
    heading: z.string().optional(),
    body: richTextSchema.optional(),
    actions: z.array(linkActionSchema),
    // T10.6 ratified variant: slim spacing preset (absent = today's render).
    compact: z.boolean().optional(),
  }),
  sectionVariant('faq', {
    heading: z.string().optional(),
    items: z.array(z.object({ q: z.string().min(1), a: richTextSchema }).strict()),
  }),
  sectionVariant('link_list', {
    heading: z.string().optional(),
    links: z.array(linkActionSchema),
  }),
  // Product grid over product objects (S2, plan §4) — upgraded 2026-07-12
  // from a static ProductCard[] to the M-8 resolved-source pattern; the old
  // shape had no live usage (shop-preview is a hand-coded page).
  sectionVariant('product_preview', {
    heading: z.string().min(1),
    source: productPreviewSourceSchema,
    limit: z.number().int().positive().max(PRODUCT_PREVIEW_MAX_CARDS),
  }),
  // Ordered process strip (W5 /pricing "how it works", plan §4) — numbered
  // steps, optionally iconed. Ordering is the semantic content_grid cards
  // lack; grids of unordered icon+title+description cells stay content_grid.
  sectionVariant('steps', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    items: z
      .array(
        z
          .object({
            title: z.string().min(1),
            description: z.string().optional(),
            icon: z.string().min(1).optional(), // Tabler icon name; numbered when absent
          })
          .strict()
      )
      .min(1),
    // T10.6 ratified variant: responsive column count (absent = 3 = today).
    columns: z.union([z.literal(2), z.literal(3), z.literal(4)]).optional(),
  }),
  // Text + media split (W5 shop-preview conversion, plan §4): kicker/heading/
  // paragraph body/actions beside 1–2 images. `reverse` flips the columns —
  // the repointable generic the bespoke shop-hero markup becomes.
  // ─── `composition` (T12.31) ────────────────────────────────────────────────
  //
  // The one COMPOSABLE section. Every other type in this union is a named shape
  // with a fixed field set, which is exactly what makes them predictable to
  // author and render — and exactly what a SITE CAPTURE cannot always fit. On
  // 2026-08-22 two thirds of the residual capture gaps on the reference site
  // were one problem stated twice:
  //
  //   section_type_has_no_asset_field            a block with copy AND images,
  //                                              typed by its copy, so its
  //                                              images had nowhere to go
  //   link_actions_not_carried_by_asset_section   a block with images AND links,
  //                                              typed by its images, so its
  //                                              links were dropped
  //
  // Both are "one source block holds more than any single named type can". The
  // answer is not fourteen more named types; it is one type whose body is an
  // ORDERED SEQUENCE, so copy, imagery and calls-to-action can interleave in the
  // order the source had them.
  //
  // IT IS NOT AN ESCAPE HATCH FROM THE DESIGN SYSTEM. `blocks` is a closed union
  // of three kinds — there is no raw HTML, no arbitrary attributes, no styling,
  // no nesting. Text is the same allowlisted rich text every other section uses;
  // actions are the same `linkActionSchema` the hero uses; images are the same
  // {src, alt} pair, and they live in a FLAT `images` array exactly like
  // content_split's so the asset binder's first-party guarantee applies to them
  // unchanged. A block referencing an image does so BY INDEX into that array —
  // an image can never arrive as a URL inside a block.
  //
  // Prefer a named type whenever one fits. This is for the residue.
  sectionVariant('composition', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    images: z
      .array(z.object({ src: z.string().min(1), alt: z.string().min(1) }).strict())
      .max(COMPOSITION_MAX_IMAGES),
    blocks: z
      .array(
        z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('text'), body: richTextSchema }).strict(),
          z.object({ kind: z.literal('actions'), actions: z.array(linkActionSchema).min(1) }).strict(),
          // By INDEX into `images`, never by URL. An out-of-range index is a
          // validation failure, not a broken picture.
          z.object({ kind: z.literal('image'), imageIndex: z.number().int().min(0) }).strict(),
        ])
      )
      .min(1)
      .max(COMPOSITION_MAX_BLOCKS),
    anchor: z.string().optional(),
  }),
  sectionVariant('content_split', {
    kicker: z.string().optional(),
    heading: z.string().min(1),
    body: richTextSchema, // paragraph-only (renderability check)
    actions: z.array(linkActionSchema),
    images: z.array(z.object({ src: z.string().min(1), alt: z.string().min(1) }).strict()).max(2),
    reverse: z.boolean().optional(),
    // T10.6 ratified variant: 'stagger' (today's offset second image) or
    // 'stack' (both images flush). Absent = 'stagger' = today byte-exactly.
    imageLayout: z.enum(['stagger', 'stack']).optional(),
  }),
  // Product-linked pricing tiers (W5 /pricing, plan §4): each tier REFERENCES
  // a product object — price badge + availability resolve from the SAME
  // commerce data at build (no copy drift; repointable; the design-principles
  // litmus). Tier copy (features, description) is editorial; money is not.
  sectionVariant('pricing_table', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    description: z.string().optional(),
    tiers: z
      .array(
        z
          .object({
            product: z.string().min(1), // product object id (prod_…)
            title: z.string().min(1).optional(), // defaults to the product's title
            description: z.string().optional(),
            features: z.array(z.string().min(1)),
            highlighted: z.boolean().optional(),
            actionLabel: z.string().min(1).optional(), // defaults to "View"
          })
          .strict()
      )
      .min(1),
  }),
  // W10 batch-1 mints (T10.5, ratified list — design-vocabulary-gaps.md §7).
  // `media`: standalone image/gallery/video section (survey B2+C3). Video is
  // provider-allowlisted BY ID — no URL field exists (the tracking_config
  // safety posture): the renderer builds the embed URL from a code-owned
  // template per provider, so data can never smuggle a src.
  sectionVariant('media', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    /** Rendered arrangement; absent = 'single' (rule-6 bounded enum). */
    layout: z.enum(['single', 'grid', 'strip']).optional(),
    items: z.array(mediaItemSchema).min(1).max(MEDIA_MAX_ITEMS),
    anchor: z.string().optional(),
  }),
  // `brand_row`: logo strip (survey A2+C4 — press logos, certifications,
  // partner marks). 2–8 small images, optional label, optional per-logo
  // targets (resolved like hero actions).
  sectionVariant('brand_row', {
    heading: z.string().optional(),
    logos: z
      .array(
        z
          .object({
            src: z.string().min(1),
            alt: z.string().min(1),
            target: navTargetSchema.optional(),
          })
          .strict()
      )
      .min(2)
      .max(BRAND_ROW_MAX_LOGOS),
    anchor: z.string().optional(),
  }),
  // `stats`: number band (survey A4+C6) — large value + label (+ sublabel).
  sectionVariant('stats', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    items: z
      .array(
        z
          .object({
            value: z.string().min(1).max(24),
            label: z.string().min(1).max(64),
            sublabel: z.string().max(96).optional(),
          })
          .strict()
      )
      .min(2)
      .max(STATS_MAX_ITEMS),
    anchor: z.string().optional(),
  }),
  // `timeline` (T10.6 mint, survey B7): ordered milestones on a time axis —
  // "what to expect over 12 weeks". Plain-text blurbs v1 (a rich body joins
  // on demand with its splitter wiring, rule 1).
  sectionVariant('timeline', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    milestones: z
      .array(
        z
          .object({
            label: z.string().min(1).max(64),
            period: z.string().max(48).optional(),
            description: z.string().min(1),
          })
          .strict()
      )
      .min(2)
      .max(TIMELINE_MAX_MILESTONES),
    anchor: z.string().optional(),
  }),
  // `comparison_table` (T10.6 mint, survey A12): a bounded feature matrix —
  // 2–4 columns, ≤12 rows; cells are booleans (check/dash) or short strings.
  // The renderer aligns cells to columns index-wise and renders '—' for a
  // missing cell (defensive; no cross-length schema coupling).
  sectionVariant('comparison_table', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    columns: z
      .array(z.object({ label: z.string().min(1).max(32), highlighted: z.boolean().optional() }).strict())
      .min(2)
      .max(COMPARISON_MAX_COLUMNS),
    rows: z
      .array(
        z
          .object({
            label: z.string().min(1).max(64),
            cells: z
              .array(z.union([z.boolean(), z.string().max(48)]))
              .min(1)
              .max(COMPARISON_MAX_COLUMNS),
          })
          .strict()
      )
      .min(1)
      .max(COMPARISON_MAX_ROWS),
    anchor: z.string().optional(),
  }),
  // T3.13 extensibility drill: a reader/expert quote grid. No audited markup
  // on the live site — this exists to prove a NEW section type is insertable
  // through the registry pattern (one union member + one module + one
  // component + one binding); see src/lib/registry/components/testimonial.ts.
  sectionVariant('testimonial', {
    kicker: z.string().optional(),
    heading: z.string().optional(),
    quotes: z.array(z.object({ quote: z.string().min(1), attribution: z.string().optional() }).strict()),
    anchor: z.string().optional(),
    // T10.6 ratified variants: layout 'single' (one spotlight column) or
    // 'wall' (3-col card wall); presentation 'quote' (cards) or 'pullquote'
    // (large serif pull-quotes). Absent = today's 2-col cards byte-exactly.
    layout: z.enum(['single', 'wall']).optional(),
    variant: z.enum(['quote', 'pullquote']).optional(),
  }),
  // Extracts the hardcoded Header search overlay (A§2.8).
  sectionVariant('search', {
    placeholder: z.string().optional(),
    indexRoute: z.string().min(1),
  }),
  // Explicit bridge to the article grammar (D§2.5 tradeoff).
  sectionVariant('content_embed', {
    contentItem: z.string().min(1),
  }),
  // (The bespoke single-use `about` type was RETIRED 2026-07-10: /about is now
  // composed from reusable bio/prose/cta_banner sections via shared_ref, so the
  // one-page anti-pattern type has no instances. History in state-of-play.md.)
  // Form-submission confirmation (the reusable post-submit block; today's
  // /thank-you page is one instance): a centered eyebrow + fallback
  // title/message, plus per-form overrides the client script swaps in from the
  // `?form=` query param. Copy is data; the message-swap furniture is owned by
  // the component. Renamed from the page-named `thank_you` (2026-07-11) — it is
  // the generic confirmation type, not a one-page type (design-principles rule 1).
  sectionVariant('form_confirmation', {
    eyebrow: z.string().optional(),
    heading: z.string().min(1),
    message: z.string().min(1),
    formMessages: z.array(
      z.object({ form: z.string().min(1), heading: z.string().min(1), message: z.string().min(1) }).strict()
    ),
    actions: z.array(linkActionSchema),
  }),
  // A single content cell — the reusable LEAF a container block (e.g.
  // `content_grid`) holds as a child block (docs/cms-architecture/block-tree.md).
  // Not tied to one page: the same `card` composes any grid, row, or strip.
  sectionVariant('card', {
    title: z.string().min(1),
    description: z.string().optional(),
    link: linkActionSchema.optional(),
  }),
  // Reference to a shared 'section' object — no shadow copy of the target's
  // type/data (D§3.5). `sectionName` (D3-sharedref, 2026-08-06) is the ONE
  // deliberate exception: a denormalized copy of the target's display name
  // (lib/admin/display-name.ts's `objectDisplayName`, the same derivation the
  // admin object list already uses for a shared 'section' object), stamped by
  // the write path (server/lib/object-verbs.ts) whenever this section is
  // created/updated — never computed at render/preview time, so admin reads
  // stay free and synchronous like every other display-name derivation
  // instead of paying an N+1 store read per shared_ref on every page load.
  // Tradeoff: it goes stale if the target is renamed and this ref isn't
  // re-written afterward — accepted (see the write-path comment for why no
  // refresh-on-target-write mechanism exists to fix that). Absent means
  // either the section was written before this field existed, OR the write
  // path couldn't resolve a name for the target at write time (a dangling
  // ref) — both degrade to the same `ref`/index fallback in ObjectPreview,
  // never to the raw "shared_ref" type-tag literal. (There is deliberately no
  // `null` state here: object-patch-apply.ts's engine reserves `null` as its
  // fields-unset marker and refuses it outright inside a whole-value
  // `upsert_section` payload — so "couldn't resolve" is represented the same
  // way "never attempted" already is, by omitting the key, not by a
  // null-vs-undefined distinction the engine can't carry.)
  sectionVariant('shared_ref', {
    section: z.string().min(1),
    sectionName: z.string().min(1).optional(),
  }),
]);
export type SectionInstance = z.infer<typeof sectionInstanceSchema>;

export const sectionTypes = sectionInstanceSchema.options.map((option) => option.shape.type.value);
export const sectionTypeSchema = z.enum(sectionTypes as [SectionInstance['type'], ...SectionInstance['type'][]]);
export type SectionType = SectionInstance['type'];

// The shared-section wrapper: body of a standalone 'section' object (D§2.5).
// Wraps exactly one instance; whether a shared section may itself be a
// shared_ref (reference chains) is policed by reference-integrity validation
// (T0.7), not by this shape.
export const sectionBodySchema = z
  .object({
    // W13: shared tracking attribute (12-plan §2) — set_tracking is its one writer.
    ...trackingAttributeShape,
    section: sectionInstanceSchema,
  })
  .strict();
export type SectionBody = z.infer<typeof sectionBodySchema>;

export { linkActionSchema, navTargetSchema, richTextSchema };
export type { LinkAction, NavTarget, RichText } from './navigation-v1.js';
