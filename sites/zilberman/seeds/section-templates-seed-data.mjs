/**
 * Baseline starter section-template RECIPES for 'site_zilberman' (T11.7
 * create-site scaffold) — the same five core-provided starter shapes every
 * client gets (Dr-Lurie's sites/drlurie/seeds/section-templates-seed-data.mjs,
 * W8.1): a landing hero, a curated audience/feature grid, an automatic
 * related-articles strip, a newsletter CTA, and a closing CTA banner. All
 * blueprint copy is neutral starter text — a recipe supplies structure, an
 * agent replaces the copy before publishing. Recipe ids are stable across
 * the fleet (they carry no client-specific data, so there is no reason for
 * a client's copy to diverge from the canonical starter set).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/section-templates-seed-data.mjs
 */

export const SEED_SITE = 'site_zilberman';

export const sectionTemplateHeroLandingBody = {
  name: 'Landing hero',
  description: 'Opening hero for a landing or campaign page: kicker + heading + intro copy + action slots.',
  whenToUse: 'Stamp as the FIRST section of a campaign or landing page.',
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
  whenToUse: '"Who this is for" and feature-highlight rows where every cell is hand-written copy.',
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
  whenToUse: 'End-of-article and hub pages that should surface further reading automatically.',
  scope: 'evergreen',
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

export const CONVERSION_SEEDS = [
  { objectType: 'section_template', objectId: 'stpl_hero_landing', body: sectionTemplateHeroLandingBody },
  { objectType: 'section_template', objectId: 'stpl_audience_grid', body: sectionTemplateAudienceGridBody },
  { objectType: 'section_template', objectId: 'stpl_related_articles', body: sectionTemplateRelatedArticlesBody },
  { objectType: 'section_template', objectId: 'stpl_newsletter_cta', body: sectionTemplateNewsletterCtaBody },
  { objectType: 'section_template', objectId: 'stpl_cta_banner', body: sectionTemplateCtaBannerBody },
];
