/**
 * CANONICAL section-template RECIPES — the shared, brand-neutral recipe
 * library every site draws from (T14.1).
 *
 * Before this module, the five core starter shapes (`stpl_hero_landing`,
 * `stpl_audience_grid`, `stpl_related_articles`, `stpl_newsletter_cta`,
 * `stpl_cta_banner`) were three separate, hand-copied literals —
 * sites/platform, sites/fernwell and sites/zilberman's
 * seeds/section-templates-seed-data.mjs files agreed byte-for-byte, but only
 * by luck: nothing enforced it, and a fourth site's copy could drift the
 * moment someone edited one file and not the others. Worse, drlurie's own
 * four EXTRA recipes (`stpl_media_gallery`, `stpl_stats_band`,
 * `stpl_comparison_matrix`, `stpl_expectations_timeline`) are just as
 * brand-neutral as the five above, yet were invisible everywhere but
 * drlurie — a clone run against an unrelated site needing a captioned image
 * gallery had no way to discover `stpl_media_gallery` already existed, and
 * built a bespoke one instead.
 *
 * This module is the fix: ONE body per canonical recipe, imported by every
 * site's section-templates-seed-data.mjs instead of restated. Every body
 * here carries `portability: 'canonical'` (packages/core/schema/bodies/
 * recipe-metadata-v1.ts) — the explicit, never-inferred stamp that marks a
 * recipe brand-neutral and safe for ANY site. `scope` (maturity) and
 * `portability` are independent axes; every recipe below happens to be both
 * evergreen AND canonical, but that is a fact about these nine recipes, not
 * a rule about the two fields.
 *
 * Membership (verified brand-neutral by reading each body — see the T14.1
 * report for what was checked and what was deliberately left out):
 *   stpl_hero_landing        hero               opening landing/campaign hero
 *   stpl_audience_grid       content_grid       curated "who this is for" grid
 *   stpl_related_articles    content_grid       automatic tag-similarity feed
 *   stpl_newsletter_cta      newsletter_signup  single-field email capture
 *   stpl_cta_banner          cta_banner         closing call-to-action band
 *   stpl_media_gallery       media              standalone image/video gallery
 *   stpl_stats_band          stats              headline-numbers trust band
 *   stpl_expectations_timeline timeline         "what to expect" milestone rail
 *   stpl_comparison_matrix   comparison_table   bounded us-vs-them feature matrix
 *
 * A site adds its OWN recipes on top by importing what it needs from here
 * and appending site-specific `{ objectType, objectId, body }` entries to its
 * own CONVERSION_SEEDS — this module never enumerates sites and never reaches
 * into a site's own seed files.
 *
 * Consumed by every sites/<client>/seeds/section-templates-seed-data.mjs.
 */

// ─── the five original shared recipes ───────────────────────────────────────
// Content is byte-identical to what sites/platform, sites/fernwell and
// sites/zilberman each carried locally before T14.1 — canonicalized here
// verbatim, now with the explicit portability stamp.

export const sectionTemplateHeroLandingBody = {
  name: 'Landing hero',
  description: 'Opening hero for a landing or campaign page: kicker + heading + intro copy + action slots.',
  whenToUse: 'Stamp as the FIRST section of a campaign or landing page.',
  scope: 'evergreen',
  portability: 'canonical',
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
  whenToUse: '"Who this is for" and feature-highlight rows where every cell is hand-written copy.',
  scope: 'evergreen',
  portability: 'canonical',
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
  whenToUse: 'End-of-article and hub pages that should surface further reading automatically.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplrelated',
    type: 'content_grid',
    data: {
      kicker: 'Keep reading',
      heading: 'Related articles',
      limit: 3,
      source: { kind: 'related', algorithm: 'tag_similarity' },
    },
  },
};

export const sectionTemplateNewsletterCtaBody = {
  name: 'Newsletter CTA',
  description: 'A single-field email capture band.',
  whenToUse: 'Anywhere the page should offer an email opt-in.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplnewsletter',
    type: 'newsletter_signup',
    data: {
      heading: 'Stay in the loop',
      body: '<p>Get occasional updates — no spam.</p>',
      formName: 'newsletter',
    },
  },
};

export const sectionTemplateCtaBannerBody = {
  name: 'CTA banner',
  description: 'A full-width closing call-to-action band.',
  whenToUse: 'End-of-page closing CTA on interior or about-style pages.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplctabanner',
    type: 'cta_banner',
    data: {
      heading: 'Ready to get started?',
      body: '<p>One short closing sentence.</p>',
      actions: [],
    },
  },
};

// ─── drlurie's four extras, promoted (T14.1) ────────────────────────────────
// Content is byte-identical to what sites/drlurie carried locally (W10
// T10.8) — read in full before promotion; every one is self-contained (plain
// site-asset placeholder paths only, no *AssetRef, no object/taxonomy refs)
// and carries no Dr-Lurie-specific copy, so promotion changes nothing about
// what an instantiation produces on any site.

export const sectionTemplateStatsBandBody = {
  name: 'Stats band',
  description: 'A row of headline numbers (value + label + optional sublabel) — the trust/metrics band.',
  whenToUse:
    'Stamp between content sections to anchor credibility with 2–6 numbers ("10k readers · 97% satisfaction"). Replace the starter figures before publishing — never ship placeholder metrics.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplstats',
    type: 'stats',
    data: {
      kicker: 'By the numbers',
      items: [
        { value: '10k+', label: 'Readers' },
        { value: '97%', label: 'Satisfaction' },
        { value: '5★', label: 'Average rating' },
      ],
    },
  },
};

export const sectionTemplateExpectationsTimelineBody = {
  name: 'Expectations timeline',
  description: 'An ordered "what to expect" milestone rail over time (label + period + short description).',
  whenToUse:
    'Any change-over-time narrative — a routine’s first 12 weeks, an onboarding arc. Use the steps recipe for a procedure the reader performs; this one is time, not tasks.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stpltimeline',
    type: 'timeline',
    data: {
      kicker: 'What to expect',
      milestones: [
        { label: 'Adjustment', period: 'Weeks 1–2', description: 'Starter copy: what happens first.' },
        { label: 'Early change', period: 'Weeks 3–6', description: 'Starter copy: the first visible shift.' },
        { label: 'Steady state', period: 'Week 12', description: 'Starter copy: where this settles.' },
      ],
    },
  },
};

export const sectionTemplateComparisonBody = {
  name: 'Comparison matrix',
  description: 'A bounded us-vs-them feature matrix (2–4 columns, yes/no or short-text cells).',
  whenToUse:
    'Positioning pages comparing approaches or offerings feature-by-feature. Use pricing_table when the columns are purchasable products — money truth stays object-bound.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplcomparison',
    type: 'comparison_table',
    data: {
      heading: 'How this compares',
      columns: [{ label: 'This approach', highlighted: true }, { label: 'The usual way' }],
      rows: [
        { label: 'Evidence-based', cells: [true, false] },
        { label: 'Starter row — replace', cells: ['Yes', 'Sometimes'] },
      ],
    },
  },
};

export const sectionTemplateMediaGalleryBody = {
  name: 'Media gallery',
  description: 'A standalone image gallery block (grid layout starter; swap items for single figures or video).',
  whenToUse:
    'Visual evidence between prose — result galleries, product-in-use shots, a video feature (switch an item to kind:’video’ with a provider + video ID). Replace the placeholder images before publishing.',
  scope: 'evergreen',
  portability: 'canonical',
  blueprint: {
    id: 's_stplmedia',
    type: 'media',
    data: {
      layout: 'grid',
      items: [
        { kind: 'image', src: '/images/default.png', alt: 'Placeholder — replace', caption: 'Starter caption' },
        { kind: 'image', src: '/images/default.png', alt: 'Placeholder — replace' },
      ],
    },
  },
};

// ─── the pack, as a list ─────────────────────────────────────────────────────
// `objectId` first so a consumer can build its own CONVERSION_SEEDS entries
// (`{ objectType: 'section_template', objectId, body }`) directly off this
// list without hand-repeating ids.

export const CANONICAL_SECTION_TEMPLATES = [
  { objectId: 'stpl_hero_landing', body: sectionTemplateHeroLandingBody },
  { objectId: 'stpl_audience_grid', body: sectionTemplateAudienceGridBody },
  { objectId: 'stpl_related_articles', body: sectionTemplateRelatedArticlesBody },
  { objectId: 'stpl_newsletter_cta', body: sectionTemplateNewsletterCtaBody },
  { objectId: 'stpl_cta_banner', body: sectionTemplateCtaBannerBody },
  { objectId: 'stpl_stats_band', body: sectionTemplateStatsBandBody },
  { objectId: 'stpl_expectations_timeline', body: sectionTemplateExpectationsTimelineBody },
  { objectId: 'stpl_comparison_matrix', body: sectionTemplateComparisonBody },
  { objectId: 'stpl_media_gallery', body: sectionTemplateMediaGalleryBody },
];

/** Every canonical section-template id, for the drift test and any consumer
 *  that needs membership without the bodies. */
export const CANONICAL_SECTION_TEMPLATE_IDS = CANONICAL_SECTION_TEMPLATES.map((entry) => entry.objectId);
