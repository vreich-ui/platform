/**
 * Seed data for the starter section-template recipes (W8.1 —
 * 09-template-system-plan §2.6; "templates are recipes; PageTypes are law",
 * design-principles rule 5).
 *
 * Five recipes distilled from real converted sections — the shapes the site
 * actually reuses:
 *
 *   stpl_hero_landing      hero               the page_home s_hero shape
 *   stpl_audience_grid     content_grid       curated `cards` source (the
 *                                             sec_home_audience_grid shape)
 *   stpl_related_articles  content_grid       `related`/tag_similarity feed
 *                                             (the page_article s_related shape)
 *   stpl_newsletter_cta    newsletter_signup  the sec_newsletter_signup shape
 *   stpl_cta_banner        cta_banner         the W1/about closing-CTA shape
 *
 * T14.1: these five stay LOCAL, deliberately. Their content diverged from
 * the platform/fernwell/zilberman "canonical five" long ago (different
 * whenToUse copy, different blueprint ids, `stpl_related_articles` even
 * carries a different `data` shape) — they are drlurie's own tuned
 * overrides of the same recipe IDS, not restatements of the canonical
 * bodies. Importing the canonical pack for these five would change what
 * this site is born with, which T14.1 is explicitly not allowed to do.
 * They therefore carry no `portability` stamp (absent = 'client', per
 * packages/core/schema/bodies/recipe-metadata-v1.ts) rather than a false
 * 'canonical' one.
 *
 * Recipes are DATA: agents evolve them freely with the section_template patch
 * ops, and every blueprint here is self-contained (no shared_refs, no content
 * refs, no asset refs) so a stamped section validates with zero external
 * targets. Blueprint copy is neutral starter text an agent replaces before
 * publishing — a recipe supplies structure, never finished site content.
 * Blueprint s_* ids are placeholders: instantiation always re-mints them.
 *
 * Consumed by scripts/home-conversion-roundtrip.mjs via
 *   --seeds scripts/lib/section-templates-seed-data.mjs
 * which drills every section_template patch op (set_section_template_meta,
 * replace_blueprint, update_blueprint_data) ending byte-identical to the seed.
 */
import {
  sectionTemplateComparisonBody,
  sectionTemplateExpectationsTimelineBody,
  sectionTemplateMediaGalleryBody,
  sectionTemplateStatsBandBody,
} from '../../../packages/core/cli/canonical-seed-data.mjs';

export const SEED_SITE = 'site_drlurie';

// ─── the five recipes (site-specific — see the T14.1 note above) ────────────

export const sectionTemplateHeroLandingBody = {
  name: 'Landing hero',
  description: 'Opening hero for a landing or campaign page: kicker + heading + intro copy + action slots.',
  whenToUse:
    'Stamp as the FIRST section of a campaign or landing page. Interior pages open with a lede (registry default), not a hero.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplhero',
    type: 'hero',
    data: {
      kicker: 'Overview',
      heading: 'New hero heading',
      body: '<p>One short paragraph setting up what this page offers.</p>',
      actions: [],
    },
  },
};

export const sectionTemplateAudienceGridBody = {
  name: 'Audience grid',
  description: 'Curated text-cell grid ("who this is for" / feature highlights) — cards are hand-written copy.',
  whenToUse:
    '"Who this is for" and feature-highlight rows where every cell is hand-written copy. For automatic article tiles use stpl_related_articles.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplaudience',
    type: 'content_grid',
    data: {
      kicker: 'Who this is for',
      heading: 'New audience heading',
      limit: 4,
      source: {
        kind: 'cards',
        cards: [
          { description: 'First audience or feature cell.' },
          { description: 'Second audience or feature cell.' },
        ],
      },
    },
  },
};

export const sectionTemplateRelatedArticlesBody = {
  name: 'Related articles',
  description: 'Automatic related-content strip: three tiles picked by tag similarity from published articles.',
  whenToUse:
    'End-of-article and hub pages that should surface further reading automatically — cells fill themselves from published articles by tag similarity. For hand-curated cells use stpl_audience_grid.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplrelated',
    type: 'content_grid',
    data: {
      heading: 'More to read',
      limit: 3,
      columns: 3,
      source: { kind: 'related', algorithm: 'tag_similarity' },
    },
  },
};

export const sectionTemplateNewsletterCtaBody = {
  name: 'Newsletter signup',
  description: 'The standing newsletter capture block wired to the Netlify "newsletter" form.',
  whenToUse:
    'The standard email-capture ask, mid- or end-of-page, on any page meant to convert readers into subscribers.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplnewsletter',
    type: 'newsletter_signup',
    data: {
      kicker: 'Newsletter',
      heading: 'Get the next letter',
      formName: 'newsletter',
    },
  },
};

export const sectionTemplateCtaBannerBody = {
  name: 'Closing CTA banner',
  description: 'Closing call-to-action banner: heading + action slots (the interior-page closer).',
  whenToUse:
    'The standard page closer — stamp last on interior pages to route readers onward; customize heading and actions after stamping.',
  scope: 'evergreen',
  blueprint: {
    id: 's_stplcta',
    type: 'cta_banner',
    data: { heading: 'Keep exploring', actions: [] },
  },
};

// ─── W10 T10.8: starters for the ratified mints ──────────────────────────────
// One per minted type that warrants a generic starter. DELIBERATELY SKIPPED:
// `brand_row` (logo strips are inherently site-specific assets — a starter
// would stamp placeholder marks that read as broken; agents compose it
// directly) and `comparison_table`'s pricing cousin (pricing_table stays
// product-bound).
//
// T14.1: these four were promoted to the CANONICAL pack
// (packages/core/cli/canonical-seed-data.mjs) — they were always
// brand-neutral (verified by reading each body: no Dr-Lurie copy, no
// *AssetRef, no object/taxonomy refs), so every site draws from them now
// instead of only this one. Re-exported here under their original names so
// nothing that imported them FROM drlurie's seed file breaks.

export {
  sectionTemplateStatsBandBody,
  sectionTemplateExpectationsTimelineBody,
  sectionTemplateComparisonBody,
  sectionTemplateMediaGalleryBody,
};

// ─── driver contract ─────────────────────────────────────────────────────────

export const CONVERSION_SEEDS = [
  { objectType: 'section_template', objectId: 'stpl_hero_landing', body: sectionTemplateHeroLandingBody },
  { objectType: 'section_template', objectId: 'stpl_audience_grid', body: sectionTemplateAudienceGridBody },
  { objectType: 'section_template', objectId: 'stpl_related_articles', body: sectionTemplateRelatedArticlesBody },
  { objectType: 'section_template', objectId: 'stpl_newsletter_cta', body: sectionTemplateNewsletterCtaBody },
  { objectType: 'section_template', objectId: 'stpl_cta_banner', body: sectionTemplateCtaBannerBody },
  // W10 T10.8 — starters for the ratified mints. Bodies now canonical (T14.1).
  { objectType: 'section_template', objectId: 'stpl_stats_band', body: sectionTemplateStatsBandBody },
  {
    objectType: 'section_template',
    objectId: 'stpl_expectations_timeline',
    body: sectionTemplateExpectationsTimelineBody,
  },
  { objectType: 'section_template', objectId: 'stpl_comparison_matrix', body: sectionTemplateComparisonBody },
  { objectType: 'section_template', objectId: 'stpl_media_gallery', body: sectionTemplateMediaGalleryBody },
];
