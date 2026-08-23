/**
 * Page body schema — 'page.v1' (D§3.3).
 *
 * A page owns its inline sections the way an article owns its nodes: one
 * record, one lock, one publish (the structural analogue of
 * article_body.v1.nodes, D§3.3 Δ note). `navigationOverrides` is the
 * sanctioned data-only replacement for the homepage's `<Fragment slot>` code
 * override (A§2.1/D§5.4) — it references another Navigation instance; no
 * slot/code overrides exist.
 *
 * `template` records instantiation provenance only; Pages never live-inherit
 * from Templates (D§3.6).
 *
 * The PageType *registry* is code, not a blob object (D§3.4/OQ-4); this file
 * only pins the id vocabulary pages may reference. Route shape/uniqueness and
 * PageType section constraints are validation-pipeline checks (T0.7).
 */
import { z } from 'zod';

import { sectionInstanceSchema } from './section-v1.js';
import { trackingAttributeShape } from './tracking-attribute-v1.js';

export const PAGE_SCHEMA_VERSION = 'page.v1';

// 'clone' (T12.29) is the page type for a CAPTURED page — one produced by duplicating a source
// site rather than authored inside this CMS. It exists so cloned pages are not governed by the
// DTC-marketing editorial families the other types encode: `home` deliberately permits only
// hero/checklist/content_grid/bio/newsletter_signup/shared_ref (C§1.1), which meant a cloned
// homepage could not carry `media` or `content_split` at all and lost its imagery to a
// `section_not_allowed_for_page_type` gap. Rather than widen `home` — that allowlist is a product
// decision and stays exactly as narrow as it is — a clone declares what it is and is governed
// accordingly. It is also the seam where future clone-specific rules belong.
export const pageTypeIds = ['home', 'standard', 'listing', 'content_detail', 'system', 'clone'] as const;
export const pageTypeIdSchema = z.enum(pageTypeIds);
export type PageTypeId = z.infer<typeof pageTypeIdSchema>;

export const pageBodySchema = z
  .object({
    // W13: shared tracking attribute (12-plan §2) — set_tracking is its one writer.
    ...trackingAttributeShape,
    route: z.string().min(1), // '/', '/about', '/start-here', …
    pageType: pageTypeIdSchema,
    title: z.string().min(1),
    seo: z
      .object({
        title: z.string().optional(),
        description: z.string().optional(),
        ogImage: z.string().optional(),
        robots: z.object({ index: z.boolean(), follow: z.boolean() }).strict().optional(),
      })
      .strict(),
    template: z
      .object({
        ref: z.string().min(1), // template ObjectId
        instantiated_at: z.string(), // ISO — provenance, not live inheritance
      })
      .strict()
      .optional(),
    sections: z.array(sectionInstanceSchema), // ordered (D§3.5)
    navigationOverrides: z
      .object({
        footer: z.string().min(1).optional(), // navigation ObjectId
        header: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type PageBody = z.infer<typeof pageBodySchema>;
