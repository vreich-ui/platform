/**
 * T2.7 — the `site.pdf` shape (ruling D-B) as a pure decision, separate from
 * `article-template-seed.mjs`'s "does the TEMPLATE need seeding" decision:
 * this only decides what `site.pdf` should BECOME, given the seeded article
 * template id and whatever sales-brochure template already exists for the
 * tenant. The schema (`packages/core/schema/bodies/site-v1.ts:165-183`,
 * `sitePdfSchema`) already supports both fields; nothing here extends it.
 *
 * ── The byKind.sales_brochure choice ─────────────────────────────────────
 * `byKind` is `Record<kind, ONE templateId>` (`site-v1.ts`'s
 * `z.record(pdfKindKeySchema, pdfTemplateIdSchema)`) -- a kind can pin
 * exactly one template, not a list. drlurie carries TWO hardcoded brochures
 * (a 6-page niacinamide brochure and a 5-page routine brochure) and the
 * brief says both move out of being the site default and under
 * `byKind.sales_brochure`, which can only hold one of them as the pinned
 * value. Judgement call: the ROUTINE brochure is the one pinned, because a
 * multi-step-routine brochure is the more general "sell our approach"
 * sales piece, while the niacinamide brochure is a single-ingredient topic
 * piece -- a worse fit for an unqualified "sales_brochure" default. The
 * other id is not lost: it still exists in pdf-tool's template list and an
 * agent can name it explicitly via `template_id` on a job. This is an
 * arbitrary-but-reasoned pick given the information available (brief §2)
 * and is a one-line `set_site_fields` change later if wrong. This module
 * takes the chosen id as a plain argument -- the two drlurie-specific UUIDs
 * themselves live in `scripts/seed-drlurie-pdf-defaults.mjs`, a
 * drlurie-only one-off, never in this fleet-generic module (genesis must
 * never invent -- or bake in another tenant's -- content).
 *
 * ── byKind.lead_magnet ────────────────────────────────────────────────────
 * No lead-magnet-specific template exists. The bridge already falls back to
 * `defaultTemplateId` when a `byKind` entry is absent (D-1), so leaving
 * `lead_magnet` out would render identically -- but the brief's table lists
 * all three kinds explicitly, and an explicit pin documents the decision
 * ("a lead magnet renders as an article-shaped PDF today") instead of
 * leaving a reader to work out that the fallback applies. Pinned to the
 * same seeded article template id.
 */

/**
 * @param {{ articleTemplateId: string, salesBrochureTemplateId?: string }} input
 */
export const buildSitePdfDefaults = (input) => ({
  defaultTemplateId: input.articleTemplateId,
  byKind: {
    article: input.articleTemplateId,
    lead_magnet: input.articleTemplateId,
    ...(input.salesBrochureTemplateId ? { sales_brochure: input.salesBrochureTemplateId } : {}),
  },
});

/** drlurie's two live hardcoded brochures (BRIEF §2) -- neither stays the site default; see the module doc comment for which one is pinned and why. Deliberately drlurie-SPECIFIC data, kept out of `buildSitePdfDefaults` itself (genesis must never invent -- or bake in another tenant's -- content). */
export const DRLURIE_SALES_BROCHURE_TEMPLATE_IDS = Object.freeze({
  niacinamide6Page: 'eca2337c-de69-4376-8645-75225caabfa0',
  routine5Page: '674a43bd-40c0-40ed-847a-67a9e0b4ec2c',
});

/**
 * Idempotency for the `site.pdf` write itself, mirroring
 * `planArticleTemplateSeed`'s rule: if the site already carries a
 * `pdf.defaultTemplateId` -- seeded by an earlier run, or set by hand -- this
 * is a no-op regardless of what a fresh computation would produce. Genesis
 * populates an EMPTY site.pdf; it never overwrites a site's own choice.
 *
 * @param {{ defaultTemplateId?: string } | undefined} existingSitePdf
 */
export const planSitePdfSeed = (existingSitePdf) => {
  if (existingSitePdf?.defaultTemplateId) {
    return {
      action: 'already_present',
      reason: `site.pdf.defaultTemplateId is already '${existingSitePdf.defaultTemplateId}' -- left untouched.`,
    };
  }
  return { action: 'set', reason: 'site.pdf.defaultTemplateId is unset.' };
};
