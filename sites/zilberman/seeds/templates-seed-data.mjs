/**
 * Baseline starter TEMPLATE recipes for 'site_zilberman' (W15 S3 follow-up to
 * the T11.7 create-site scaffold) — the same three core-provided starter
 * page shapes every client gets (Dr-Lurie's
 * sites/drlurie/seeds/templates-seed-data.mjs, W2.5): the standard interior
 * page, the campaign/landing page, and the minimal legal/system page. All
 * blueprint copy is neutral starter text — a recipe supplies structure, an
 * agent replaces the copy before publishing. Recipe ids are stable across
 * the fleet (they carry no client-specific data, so there is no reason for
 * a client's copy to diverge from the canonical starter set).
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/zilberman --seeds sites/zilberman/seeds/templates-seed-data.mjs
 */

export const SEED_SITE = 'site_zilberman';

export const templateInteriorBody = {
  name: 'Interior page',
  description:
    'The standard interior-page shape: a quiet lede opener, one or more prose body sections, and an optional closing CTA banner.',
  whenToUse:
    'The default recipe for any evergreen content page — guides, explainers, policies. Pick tpl_landing when the page must convert with a hero + highlight grid; tpl_legal for single-block system boilerplate.',
  scope: 'evergreen',
  appliesTo: ['standard'],
  slots: [
    {
      slotId: 'slot_lede',
      allowed: ['lede'],
      required: true,
      repeatable: false,
      blueprint: {
        id: 's_tplintlede',
        type: 'lede',
        data: { kicker: 'Overview', heading: 'New page heading', actions: [] },
      },
    },
    {
      slotId: 'slot_body',
      allowed: ['prose'],
      required: true,
      repeatable: true,
      blueprint: {
        id: 's_tplintbody',
        type: 'prose',
        data: { body: '<p></p>' },
      },
    },
    {
      slotId: 'slot_cta',
      allowed: ['cta_banner'],
      required: false,
      repeatable: false,
      blueprint: {
        id: 's_tplintcta',
        type: 'cta_banner',
        data: { heading: 'Keep exploring', actions: [] },
      },
    },
  ],
};

export const templateLandingBody = {
  name: 'Landing page',
  description: 'The campaign/landing shape: hero opener, optional curated highlight grid, closing CTA banner.',
  whenToUse:
    'Conversion-weight pages — launches, program and offer pages, campaign destinations. For ordinary informational pages use tpl_interior.',
  scope: 'evergreen',
  appliesTo: ['standard'],
  slots: [
    {
      slotId: 'slot_hero',
      allowed: ['hero'],
      required: true,
      repeatable: false,
      blueprint: {
        id: 's_tpllandhero',
        type: 'hero',
        data: { heading: 'New page heading', actions: [] },
      },
    },
    {
      slotId: 'slot_grid',
      allowed: ['content_grid'],
      required: false,
      repeatable: true,
      blueprint: {
        id: 's_tpllandgrid',
        type: 'content_grid',
        data: {
          heading: 'Highlights',
          source: {
            kind: 'cards',
            cards: [{ title: 'First highlight' }, { title: 'Second highlight' }],
          },
          limit: 4,
        },
      },
    },
    {
      slotId: 'slot_cta',
      allowed: ['cta_banner'],
      required: false,
      repeatable: false,
      blueprint: {
        id: 's_tpllandcta',
        type: 'cta_banner',
        data: { heading: 'Ready for the next step?', actions: [] },
      },
    },
  ],
};

export const templateLegalBody = {
  name: 'Legal page',
  description:
    'A minimal system-page recipe: one required prose slot with no blueprint — instantiation fills it from the prose registry defaultData (the standing proof of the fallback path).',
  whenToUse:
    'Legal and system boilerplate — privacy, terms, disclaimers — where the page is one run of prose and nothing else.',
  scope: 'evergreen',
  appliesTo: ['system'],
  slots: [
    // No blueprint on purpose: instantiation falls back to the prose registry
    // defaultData — the standing proof that the fallback path works end-to-end.
    { slotId: 'slot_body', allowed: ['prose'], required: true, repeatable: true },
  ],
};

export const CONVERSION_SEEDS = [
  { objectType: 'template', objectId: 'tpl_interior', body: templateInteriorBody },
  { objectType: 'template', objectId: 'tpl_landing', body: templateLandingBody },
  { objectType: 'template', objectId: 'tpl_legal', body: templateLegalBody },
];
