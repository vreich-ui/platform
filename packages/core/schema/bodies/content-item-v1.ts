/**
 * Content-item body schema — 'content_item.v1' (08-articles-plan §2.1–2.2, W7.3).
 *
 * The article as a governed object: the ninth object type. The body model is
 * "node envelope outside, Rich Text inside" (§2.2) — the article body stays a
 * LIST OF ANNOTATED NODES because the annotation's unit is the node (a hook is
 * often more than one paragraph; the node grouping IS the behavioral-framework
 * structure agents judge and score against). Inside a content node,
 * `public.body` accepts a flat string (plain text — paragraphs split on blank
 * lines, escaped at render) OR a `rich_text.v1` document (headings, lists,
 * quotes, marks, embeds).
 *
 * THE PRESERVATION DIRECTIVE (Wolf, 2026-07-12/13 — governing): the semantic
 * annotation layer of the original architecture survives VERBATIM — these are
 * imports from `article-content-v1.ts`, not copies:
 *   - `node.private.strategy` (hook / agitation / resolution / …) + `intent`
 *     — the storytelling framework + DTC edge every block carries;
 *   - `node.commercial` (offers, disclosure, rel, adSlot, …);
 *   - `node.rendering` hints, `node.chat`, node `visibility`, opaque `n_*` ids
 *     that never leak strategy words to readers.
 * Envelope-level judge/score substrate: `emotional_strategy`, `sources`,
 * `claims`, `compliance`, `editorial`, `lineage` (variant parentage), and
 * typed `scores[]` (§2.4 — what `revision_control.change_assessments`
 * anticipated). None of it is ever serialized into reader HTML (the leak rule
 * — enforced at the renderer and pinned by tests).
 *
 * Object ids keep the article pipeline's `req_*` request-id shape verbatim
 * (§1.6): artifact blobKeys embed the owning id and per-request trust hangs
 * off it. The committed legacy posts (src/data/post/*.md) are NOT migrated
 * (Wolf, 2026-07-13: not worth the effort) — this type serves new articles;
 * slug-collision with a committed post is a validation blocker.
 */
import { z } from 'zod';

import {
  articleChatConfigSchema,
  articlePrivateMetadataSchema,
  articleRenderingHintsSchema,
  commercialMetadataSchema,
} from '../article-content-v1.js';
import { richTextV1Schema } from '../../lib/richtext/rich-text-v1.js';
import { trackingAttributeShape } from './tracking-attribute-v1.js';

export const CONTENT_ITEM_SCHEMA_VERSION = 'content_item.v1';

// ── node identity (verbatim rule from article-content-v1) ────────────────────

export const ARTICLE_NODE_ID_RE = /^n_[a-z0-9]+$/i;

/** Strategy/commercial words that must never appear in a reader-visible id. */
const FORBIDDEN_NODE_ID_WORDS = ['hook', 'agitation', 'cta', 'advert', 'offer'];

export const articleNodeIdSchema = z
  .string()
  .regex(ARTICLE_NODE_ID_RE, { message: 'Node ids must be stable opaque ids starting with n_' })
  .refine((id) => !FORBIDDEN_NODE_ID_WORDS.some((word) => id.toLowerCase().includes(word)), {
    message: 'Node ids must be opaque and not contain strategy or commercial keywords (hook, agitation, cta, …).',
  });

// ── node public fields (the reader-facing half) ──────────────────────────────

// article-content-v1's public shape with ONE upgrade (§2.2): `body` accepts a
// rich_text.v1 document alongside the flat string. String bodies are PLAIN
// TEXT (escaped at render; blank lines split paragraphs) — rich formatting is
// what the document is for. Everything else is carried verbatim.
//
// `type` is the render discriminant and is never defaulted: the patch engine
// infers it from the src when an op omits it (.pdf → document, image
// extension → image, anything else refused) and rejects a type the src
// contradicts (lib/article-content/media-type.ts). `document` media renders
// as a download/embed block, never an <img>; `sizeBytes` (the artifact
// bridge's sizeBytes) lets that block show the download size.
export const contentItemNodeMediaSchema = z
  .object({
    type: z.enum(['image', 'video', 'audio', 'embed', 'document']),
    title: z.string().optional(),
    contentType: z.string().optional(),
    src: z.string(),
    alt: z.string().optional(),
    caption: z.string().optional(),
    sizeBytes: z.number().int().positive().optional(),
  })
  .strict();

export const contentItemNodePublicSchema = z
  .object({
    eyebrow: z.string().optional(),
    title: z.string().optional(),
    body: z.union([z.string(), richTextV1Schema]).optional(),
    items: z.array(z.string()).optional(),
    ctaText: z.string().optional(),
    ctaLink: z.string().optional(),
    label: z.string().optional(),
    media: contentItemNodeMediaSchema.optional(),
    /**
     * Multi-image block (Wolf, 2026-07-13): one image per node stays the
     * norm (the node is the annotation unit), `images` is the sanctioned
     * gallery option — each entry is a full media object, rendered in order.
     */
    images: z.array(contentItemNodeMediaSchema).optional(),
  })
  .strict();
export type ContentItemNodePublic = z.infer<typeof contentItemNodePublicSchema>;

// ── the annotated node envelope ───────────────────────────────────────────────

export const contentItemNodeSchema = z
  .object({
    id: articleNodeIdSchema,
    // The original architecture's four kinds. ('reference' — bug ⑧ — stays
    // out until it can actually render; a kind that publishes but dead-ends
    // the build would be a trap-5 regression.)
    kind: z.enum(['content', 'action', 'placement', 'interactive']),
    public: contentItemNodePublicSchema,
    private: articlePrivateMetadataSchema.optional(),
    commercial: commercialMetadataSchema.optional(),
    chat: z
      .object({
        invitationText: z.string().optional(),
        suggestedQuery: z.string().optional(),
      })
      .strict()
      .optional(),
    rendering: articleRenderingHintsSchema.optional(),
    visibility: z.enum(['public', 'internal', 'hidden']).optional(),
  })
  .strict();
export type ContentItemNode = z.infer<typeof contentItemNodeSchema>;

// ── envelope-level judge/score substrate (§2.1 mapping, carried by name) ─────

export const contentItemTaxonomySchema = z
  .object({
    category: z.string().optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();

export const contentItemSeoSchema = z
  .object({
    meta_title: z.string().optional(),
    meta_description: z.string().optional(),
    canonical_url: z.string().optional(),
  })
  .strict();

export const contentItemImageSchema = z
  .object({
    src: z.string(),
    alt: z.string().optional(),
  })
  .strict();

/** Variant parentage (§2.4) — `object_inventory {variants_of}` reads this. */
export const contentItemLineageSchema = z
  .object({
    parent_content_id: z.string().optional(),
    source_version_id: z.string().optional(),
  })
  .strict();

/**
 * Typed scores (§2.4) — the judge/score substrate `change_assessments`
 * anticipated. Framework/dimension are free strings in v1 (they become
 * `strategy_drlurie` term ids if/when Wolf approves OQ-W7-3's registry).
 */
export const contentItemScoreSchema = z
  .object({
    scored_by: z.string(),
    at: z.string(),
    framework: z.string(),
    dimension: z.string(),
    score: z.number(),
    rationale: z.string().optional(),
  })
  .strict();
export type ContentItemScore = z.infer<typeof contentItemScoreSchema>;

export const contentItemEditorialSchema = z
  .object({
    writer_notes: z.string().optional(),
    /** Optional declared arc (§2.5) — a validator may warn, never block. */
    framework: z.string().optional(),
  })
  .strict();

export const contentItemEmotionalStrategySchema = z
  .object({
    overall_texture_assessment: z.string().optional(),
    overly_polished_moments: z.array(z.string()).optional(),
    opportunities_for_specificity: z.array(z.string()).optional(),
    rhythm_adjustments: z.array(z.string()).optional(),
    sensory_detail_additions: z.array(z.string()).optional(),
    lines_to_preserve: z.array(z.string()).optional(),
  })
  .strict();

export const contentItemSourceSchema = z
  .object({
    source_id: z.string().optional(),
    name: z.string(),
    url: z.string(),
    publisher: z.string().optional(),
    accessed_at: z.string().optional(),
  })
  .strict();

export const contentItemClaimSchema = z
  .object({
    claim_id: z.string().optional(),
    text: z.string(),
    node_ids: z.array(articleNodeIdSchema).optional(),
    source_ids: z.array(z.string()).optional(),
    risk: z.enum(['low', 'medium', 'high']).optional(),
    status: z.enum(['unverified', 'verified', 'disputed', 'retracted']).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const contentItemComplianceRequirementSchema = z
  .object({
    requirement_id: z.string().optional(),
    kind: z.string(),
    text: z.string(),
    satisfied: z.boolean().optional(),
    node_ids: z.array(articleNodeIdSchema).optional(),
    notes: z.string().optional(),
  })
  .strict();

export const contentItemPublicationContextSchema = z
  .object({
    publication_name: z.string().optional(),
    domain: z.string().optional(),
    topic_scope: z.string().optional(),
  })
  .strict();

// ── the body ──────────────────────────────────────────────────────────────────

export const contentItemBodySchema = z
  .object({
    // W13: shared tracking attribute (12-plan §2) — set_tracking is its one writer.
    ...trackingAttributeShape,
    /** Route slug: /<permalink pattern>/<slug>, like a committed post's id. */
    slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, { message: 'slug must be lowercase-hyphen ([a-z0-9-]).' }),
    title: z.string().min(1),
    deck: z.string().optional(),
    description: z.string().optional(),
    /**
     * Free-text byline (T9.23a — the one T9.23 parity gap: legacy
     * `/admin/publish` exposed an author, the object model didn't carry one).
     * v1 is deliberately a bare name, not a users/admins reference — plain
     * text, no rich text/HTML (the schema-wide RichText allowlist scan
     * already covers that). Optional: omitted renders no byline at all.
     */
    author: z.string().max(120).optional(),
    /** Hero image, rendered exactly once by the article furniture (bug ③). */
    image: contentItemImageSchema.optional(),
    taxonomy: contentItemTaxonomySchema.optional(),
    seo: contentItemSeoSchema.optional(),

    /** The annotated node list — the article body (§2.2). */
    nodes: z.array(contentItemNodeSchema),

    chat: articleChatConfigSchema.optional(),
    editorial: contentItemEditorialSchema.optional(),
    emotional_strategy: contentItemEmotionalStrategySchema.optional(),
    sources: z
      .object({ source_list: z.array(contentItemSourceSchema) })
      .strict()
      .optional(),
    claims: z
      .object({ claim_list: z.array(contentItemClaimSchema) })
      .strict()
      .optional(),
    compliance: z
      .object({ requirements: z.array(contentItemComplianceRequirementSchema) })
      .strict()
      .optional(),
    publication_context: contentItemPublicationContextSchema.optional(),
    lineage: contentItemLineageSchema.optional(),
    scores: z.array(contentItemScoreSchema).optional(),
  })
  .strict();

export type ContentItemBody = z.infer<typeof contentItemBodySchema>;

export const parseContentItemBody = (value: unknown): ContentItemBody => contentItemBodySchema.parse(value);
