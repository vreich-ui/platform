import assert from 'node:assert/strict';
import test from 'node:test';

import {
  NAVIGATION_SCHEMA_VERSION,
  navigationBodySchema,
  navTargetSchema,
  type NavigationBody,
} from '../../packages/core/schema/bodies/navigation-v1.js';
import {
  PAGE_SCHEMA_VERSION,
  pageBodySchema,
  pageTypeIds,
  type PageBody,
} from '../../packages/core/schema/bodies/page-v1.js';
import {
  SECTION_SCHEMA_VERSION,
  contentGridSourceSchema,
  sectionBodySchema,
  sectionInstanceSchema,
  sectionTypes,
  type SectionInstance,
} from '../../packages/core/schema/bodies/section-v1.js';
import {
  PRODUCT_SCHEMA_VERSION,
  productBodySchema,
  type ProductBody,
} from '../../packages/core/schema/bodies/product-v1.js';
import { SITE_SCHEMA_VERSION, siteBodySchema, type SiteBody } from '../../packages/core/schema/bodies/site-v1.js';
import {
  TAXONOMY_SCHEMA_VERSION,
  taxonomyBodySchema,
  type TaxonomyBody,
} from '../../packages/core/schema/bodies/taxonomy-v1.js';
import {
  TEMPLATE_SCHEMA_VERSION,
  templateBodySchema,
  type TemplateBody,
} from '../../packages/core/schema/bodies/template-v1.js';

// ---------------------------------------------------------------------------
// Navigation ('navigation.v1', D§3.8 + amendments M-1/M-2/M-5/M-7 and the
// transitional route-kind target from Gap Note 2)
// ---------------------------------------------------------------------------

const headerNavFixture: NavigationBody = {
  role: 'header',
  groups: [
    {
      id: 'g_starthere',
      title: 'Start Here',
      // M-5: the top-level group carries its own target in the data
      // (navigation.ts:8) — stored, not rendered as a link.
      target: { kind: 'route', href: '/' },
      items: [
        {
          id: 'i_skinafter60',
          label: 'Skin After 60',
          // M-1: every header dropdown item carries a description.
          description: 'A science-first overview of what changes in skin after 60.',
          target: { kind: 'route', href: '/start-here' },
        },
        {
          id: 'i_library',
          label: 'Library',
          description: 'Browse all skin science articles and practical explainers.',
          target: { kind: 'listing', list: 'content_index' },
        },
        {
          id: 'i_topics',
          label: 'Topics',
          description: 'Explore articles grouped by their category frontmatter topics.',
          target: { kind: 'taxonomy', termKind: 'category', term_id: 't_skinscience' },
        },
      ],
    },
  ],
  actions: [{ label: 'Join Newsletter', target: { kind: 'route', href: '/newsletter' }, style: 'primary' }],
};

const footerNavFixture: NavigationBody = {
  role: 'footer',
  brand: { text: 'Dr. Lurié Skin Care', descriptor: 'Healthy Skin for Skincare Newcomers' },
  groups: [
    {
      id: 'g_startlearning',
      title: 'Start learning',
      // M-2: footer rows are groups with a slot hint, not parallel arrays.
      slot: 'primary',
      items: [{ id: 'i_about', label: 'About', target: { kind: 'route', href: '/about' } }],
    },
    {
      id: 'g_legal',
      slot: 'secondary',
      items: [
        { id: 'i_terms', label: 'Terms', target: { kind: 'route', href: '/terms' } },
        { id: 'i_privacy', label: 'Privacy', target: { kind: 'route', href: '/privacy' } },
      ],
    },
    {
      id: 'g_social',
      slot: 'social',
      items: [
        {
          id: 'i_rss',
          label: 'RSS',
          // M-7: social links carry icon + ariaLabel today (navigation.ts:104).
          icon: 'tabler:rss',
          ariaLabel: 'RSS',
          target: { kind: 'asset', href: '/rss.xml' },
        },
      ],
    },
  ],
  footNote: '<p>Educational content only. Not medical advice.</p>',
};

test('navigation: header fixture parses with M-1 descriptions and M-5 group targets intact', () => {
  const parsed = navigationBodySchema.parse(headerNavFixture);
  assert.equal(NAVIGATION_SCHEMA_VERSION, 'navigation.v1');
  assert.deepEqual(parsed, headerNavFixture);
  assert.deepEqual(parsed.groups[0].target, { kind: 'route', href: '/' });
  assert.equal(parsed.groups[0].items[0].description, 'A science-first overview of what changes in skin after 60.');
});

test('navigation: footer fixture parses with M-2 slots and M-7 icon/ariaLabel intact', () => {
  const parsed = navigationBodySchema.parse(footerNavFixture);
  assert.deepEqual(parsed, footerNavFixture);
  assert.deepEqual(
    parsed.groups.map((group) => group.slot),
    ['primary', 'secondary', 'social']
  );
  const rss = parsed.groups[2].items[0];
  assert.equal(rss.icon, 'tabler:rss');
  assert.equal(rss.ariaLabel, 'RSS');
});

test('navigation: nested children (dropdowns) parse recursively', () => {
  const nested = navigationBodySchema.parse({
    role: 'header',
    groups: [
      {
        id: 'g_learn',
        items: [
          {
            id: 'i_parent',
            label: 'Learn',
            target: { kind: 'route', href: '/learn/library' },
            children: [
              {
                id: 'i_child',
                label: 'Guides',
                target: { kind: 'route', href: '/guides/free-guide' },
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(nested.groups[0].items[0].children?.[0].label, 'Guides');
});

test('nav targets: every documented kind is accepted, including the transitional route kind', () => {
  const targets = [
    { kind: 'page', page: 'page_home' },
    { kind: 'taxonomy', termKind: 'tag', term_id: 't_barrier' },
    { kind: 'listing', list: 'content_index' },
    { kind: 'external', href: 'https://example.com' },
    { kind: 'asset', href: '/rss.xml' },
    { kind: 'route', href: '/solutions/shop-preview' }, // Gap Note 2 transitional variant
  ];
  for (const target of targets) {
    assert.equal(navTargetSchema.safeParse(target).success, true, `kind ${target.kind} must parse`);
  }
});

test('nav targets: unknown kinds and malformed variants are rejected', () => {
  assert.equal(navTargetSchema.safeParse({ kind: 'anchor', href: '#top' }).success, false);
  assert.equal(navTargetSchema.safeParse({ kind: 'href', href: '/x' }).success, false);
  assert.equal(navTargetSchema.safeParse({ href: '/no-kind' }).success, false);
  // Wrong payload for a known kind.
  assert.equal(navTargetSchema.safeParse({ kind: 'page', href: '/not-a-ref' }).success, false);
  assert.equal(navTargetSchema.safeParse({ kind: 'route' }).success, false);
  // Strict: extra keys rejected.
  assert.equal(navTargetSchema.safeParse({ kind: 'route', href: '/x', label: 'X' }).success, false);
});

// ---------------------------------------------------------------------------
// Sections ('section.v1', D§3.5/D§2.5): the full union, the shared-section
// wrapper, and the transitional content_grid static variant
// ---------------------------------------------------------------------------

const sectionFixtures: SectionInstance[] = [
  {
    id: 's_hero',
    type: 'hero',
    data: {
      kicker: 'Aging skin needs focused care.',
      heading: 'Age-aware skincare is coming.',
      body: '<p>Skin after 60 behaves differently.</p>',
      actions: [
        // Page-body LinkActions may use the transitional route kind too
        // (the P3 homepage hero targets pages that only exist in P4).
        { label: 'Start Here', target: { kind: 'route', href: '/start-here' }, style: 'primary' },
      ],
    },
  },
  { id: 's_prose', type: 'prose', data: { body: '<p>Plain prose section.</p>' } },
  {
    id: 's_checklist',
    type: 'checklist',
    data: { heading: 'This is for you if…', items: ['You are new to skincare', 'Your skin changed after 60'] },
  },
  {
    id: 's_bio',
    type: 'bio',
    data: {
      heading: 'Meet Dr. Lurié',
      portraitAssetRef: 'artifact:portrait',
      body: '<p>Biophysicist.</p>',
      trustNotes: ['PhD in biophysics', 'Peer-reviewed research', 'No sponsored content'],
    },
  },
  {
    id: 's_grid',
    type: 'content_grid',
    data: { heading: 'Start here', source: { kind: 'query', query: { category: 't_skinscience' } }, limit: 5 },
  },
  {
    id: 's_newsletter',
    type: 'newsletter_signup',
    data: { heading: 'Join the newsletter', formName: 'newsletter', consentText: 'You can unsubscribe anytime.' },
  },
  {
    id: 's_contact',
    type: 'contact_form',
    data: { formName: 'contact', heading: 'Get in touch', disclaimer: 'No medical advice.' },
  },
  {
    id: 's_cta',
    type: 'cta_banner',
    data: {
      heading: 'Ready?',
      actions: [{ label: 'Join Early Access', target: { kind: 'route', href: '/solutions/early-access' } }],
    },
  },
  {
    id: 's_faq',
    type: 'faq',
    data: { items: [{ q: 'Is this medical advice?', a: '<p>No — education only.</p>' }] },
  },
  {
    id: 's_links',
    type: 'link_list',
    data: { links: [{ label: 'RSS', target: { kind: 'asset', href: '/rss.xml' } }] },
  },
  {
    id: 's_products',
    type: 'product_preview',
    data: { heading: 'Available now', source: { kind: 'query', query: {} }, limit: 6 },
  },
  {
    id: 's_productpicks',
    type: 'product_preview',
    data: {
      heading: 'Featured',
      source: {
        kind: 'manual',
        items: ['prod_barrier_repair_guide'],
        fallback: { kind: 'query', query: {} },
      },
      limit: 3,
    },
  },
  {
    id: 's_productcards',
    type: 'product_preview',
    data: {
      heading: 'Coming soon',
      source: { kind: 'cards', cards: [{ title: 'Barrier Serum', description: 'Age-aware formula.' }] },
      limit: 3,
    },
  },
  {
    id: 's_steps',
    type: 'steps',
    data: {
      heading: 'How it works',
      items: [
        { title: 'Pick a guide', icon: 'tabler:shopping-bag' },
        { title: 'Instant download', description: 'No waiting on email.' },
      ],
    },
  },
  {
    id: 's_split',
    type: 'content_split',
    data: {
      kicker: 'Aging skin needs focused care.',
      heading: 'Age-aware skincare is coming.',
      body: '<p>Copy beside media.</p>',
      actions: [{ label: 'Join Early Access', target: { kind: 'route', href: '/solutions/early-access' } }],
      images: [{ src: 'https://kugelmedia.netlify.app/drlurieblog/hero.jpg', alt: 'Product preview' }],
    },
  },
  {
    id: 's_tiers',
    type: 'pricing_table',
    data: {
      heading: 'Pricing',
      tiers: [
        { product: 'prod_barrier_repair_guide', features: ['Full protocol'], highlighted: true },
        { product: 'prod_starter_checklist', features: [] },
      ],
    },
  },
  { id: 's_search', type: 'search', data: { placeholder: 'Search articles…', indexRoute: '/search.json' } },
  { id: 's_embed', type: 'content_embed', data: { contentItem: 'req_smoke_pdf_cta_20260630_01' } },
  {
    id: 's_thanks',
    type: 'form_confirmation',
    data: {
      eyebrow: 'Submission received',
      heading: 'Thank you.',
      message: 'Your submission has been received.',
      formMessages: [{ form: 'contact', heading: 'Thanks for reaching out.', message: 'We will follow up.' }],
      actions: [{ label: 'Return home', target: { kind: 'route', href: '/' } }],
    },
  },
  {
    id: 's_card',
    type: 'card',
    data: { title: 'What Healthy Skin Means', description: 'A plain-language starting point.' },
  },
  { id: 's_shared', type: 'shared_ref', data: { section: 'sec_newsletter_signup' } },
  {
    id: 's_media1',
    type: 'media',
    data: {
      heading: 'Gallery',
      layout: 'grid',
      items: [
        { kind: 'image', src: '/images/a.jpg', alt: 'A figure', caption: 'Caption' },
        { kind: 'video', provider: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'Routine walkthrough' },
      ],
    },
  },
  {
    id: 's_brandrow1',
    type: 'brand_row',
    data: {
      heading: 'As seen in',
      logos: [
        { src: '/logos/a.svg', alt: 'Journal A', target: { kind: 'route', href: '/start-here' } },
        { src: '/logos/b.svg', alt: 'Journal B' },
      ],
    },
  },
  {
    id: 's_stats1',
    type: 'stats',
    data: {
      kicker: 'By the numbers',
      items: [
        { value: '10k+', label: 'Readers', sublabel: 'monthly' },
        { value: '97%', label: 'Satisfaction' },
      ],
    },
  },
  {
    id: 's_timeline1',
    type: 'timeline',
    data: {
      heading: 'What to expect',
      milestones: [
        { label: 'Getting started', period: 'Week 1', description: 'Skin adjusts.' },
        { label: 'Visible change', period: 'Week 8', description: 'Texture evens out.' },
      ],
    },
  },
  {
    id: 's_comparison1',
    type: 'comparison_table',
    data: {
      heading: 'How we compare',
      columns: [{ label: 'Us', highlighted: true }, { label: 'Them' }],
      rows: [
        { label: 'Evidence-based', cells: [true, false] },
        { label: 'Response time', cells: ['24h', '5 days'] },
      ],
    },
  },
];

test('sections: every union member parses from a seed fixture', () => {
  for (const fixture of sectionFixtures) {
    const result = sectionInstanceSchema.safeParse(fixture);
    assert.equal(result.success, true, `section type ${fixture.type} must parse`);
    assert.deepEqual(result.success && result.data, fixture);
  }
  assert.equal(SECTION_SCHEMA_VERSION, 'section.v1');
  // The union covers exactly the documented types.
  assert.deepEqual([...sectionTypes].sort(), [
    'bio',
    'brand_row',
    'card',
    'checklist',
    'comparison_table',
    'contact_form',
    'content_embed',
    'content_grid',
    'content_split',
    'cta_banner',
    'faq',
    'form_confirmation',
    'hero',
    'lede',
    'link_list',
    'media',
    'newsletter_signup',
    'pricing_table',
    'product_preview',
    'prose',
    'search',
    'shared_ref',
    'stats',
    'steps',
    'testimonial',
    'timeline',
  ]);
});

test('sections: unknown types, bad ids, and shadow-copy shared_refs are rejected', () => {
  assert.equal(
    sectionInstanceSchema.safeParse({ id: 's_x', type: 'no_such_type', data: { quote: 'Nice' } }).success,
    false,
    'unknown union member must be rejected (growth is a code change)'
  );
  assert.equal(
    sectionInstanceSchema.safeParse({ id: 'hero1', type: 'prose', data: { body: '<p>x</p>' } }).success,
    false,
    'ids must match s_<lowercase alphanumerics>'
  );
  assert.equal(
    sectionInstanceSchema.safeParse({ id: 'n_abc', type: 'prose', data: { body: '<p>x</p>' } }).success,
    false,
    'article node ids are not section ids'
  );
  assert.equal(
    sectionInstanceSchema.safeParse({
      id: 's_shared',
      type: 'shared_ref',
      // A shadow copy of the target's type/data must not be representable.
      data: { section: 'sec_newsletter_signup', type: 'newsletter_signup', dataCopy: {} },
    }).success,
    false
  );
  assert.equal(
    sectionInstanceSchema.safeParse({ id: 's_v', type: 'prose', data: { body: '<p>x</p>' }, visibility: 'internal' })
      .success,
    false,
    "'internal' visibility was deliberately dropped for sections"
  );
});

test('content_grid: query, manual (with M-8 fallback), and curated cards sources parse', () => {
  assert.equal(contentGridSourceSchema.safeParse({ kind: 'query', query: {} }).success, true);
  assert.equal(
    contentGridSourceSchema.safeParse({ kind: 'manual', items: ['req_smoke_pdf_cta_20260630_01'] }).success,
    true
  );
  // Curated cells (2026-07-10): title and/or description, optional link.
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'cards',
      cards: [
        { title: 'Understanding Skin Changes After 60', description: 'What shifts in the skin barrier and why.' },
        { description: 'A description-only text cell (the audience-grid shape).' },
        {
          title: 'A linked cell',
          link: { label: 'Start Here', target: { kind: 'route', href: '/start-here' }, style: 'link' },
        },
      ],
    }).success,
    true
  );
  assert.equal(
    contentGridSourceSchema.safeParse({ kind: 'cards', cards: [{}] }).success,
    false,
    'a card cell needs a title or a description'
  );
  // Optional Tabler icon (the /contact "how we can help" feature-grid shape).
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'cards',
      cards: [{ icon: 'tabler:school', title: 'Education questions', description: 'Ask about our content.' }],
    }).success,
    true,
    'a card cell may carry an optional icon'
  );
  assert.equal(
    contentGridSourceSchema.safeParse({ kind: 'cards', cards: [{ icon: 'tabler:school' }] }).success,
    false,
    'an icon alone is not a card — it still needs a title or a description'
  );
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'cards',
      cards: Array.from({ length: 9 }, (_, index) => ({ title: `Cell ${index + 1}` })),
    }).success,
    false,
    'the flat cards source carries the block-tree bound (max 8 cells)'
  );
  // The transitional P3 `static` variant is retired (2026-07-10).
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'static',
      cards: [{ title: 'Placeholder', description: 'Audited copy.' }],
    }).success,
    false,
    "the retired 'static' escape hatch must not parse"
  );
  // M-8 (manual-primary + query fallback), landed at T3.3: an empty manual
  // list with a fallback is the legal pure-fallback configuration.
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'manual',
      items: [],
      fallback: { kind: 'query', query: {} },
    }).success,
    true,
    'M-8 fallback is legal as of T3.3'
  );
  assert.equal(
    contentGridSourceSchema.safeParse({
      kind: 'manual',
      items: [],
      fallback: { kind: 'manual', items: [] },
    }).success,
    false,
    'a fallback can only be a query — manual-in-manual is meaningless'
  );
  assert.equal(contentGridSourceSchema.safeParse({ kind: 'auto' }).success, false);
});

test('sections: the shared-section wrapper holds exactly one instance', () => {
  const shared = sectionBodySchema.parse({
    section: {
      id: 's_newsletter',
      type: 'newsletter_signup',
      data: { heading: 'Join the newsletter', formName: 'newsletter' },
    },
  });
  assert.equal(shared.section.type, 'newsletter_signup');
  assert.equal(sectionBodySchema.safeParse({ sections: [] }).success, false);
});

// ---------------------------------------------------------------------------
// Page ('page.v1', D§3.3)
// ---------------------------------------------------------------------------

const pageHomeFixture: PageBody = {
  route: '/',
  pageType: 'home',
  title: 'Dr. Lurié Skin Care',
  seo: {
    description: 'Science-first skincare education for skin after 60.',
    robots: { index: true, follow: true },
  },
  template: { ref: 'tpl_home', instantiated_at: '2026-07-01T00:00:00.000Z' },
  sections: [
    sectionFixtures[0], // hero (route-kind LinkActions)
    sectionFixtures[2], // checklist
    {
      id: 's_grid',
      type: 'content_grid',
      data: {
        heading: 'Start here',
        source: { kind: 'cards', cards: [{ title: 'Curated card', description: 'Audited copy.' }] },
        limit: 5,
      },
    },
    sectionFixtures[3], // bio
    { id: 's_shared', type: 'shared_ref', data: { section: 'sec_newsletter_signup' } },
  ],
  navigationOverrides: { footer: 'nav_footer_home' },
};

test('page: the page_home-shaped fixture parses cleanly', () => {
  const parsed = pageBodySchema.parse(pageHomeFixture);
  assert.equal(PAGE_SCHEMA_VERSION, 'page.v1');
  assert.deepEqual(parsed, pageHomeFixture);
  assert.deepEqual(pageTypeIds, ['home', 'standard', 'listing', 'content_detail', 'system']);
});

test('page: unknown pageType, unknown section types, and code-override keys are rejected', () => {
  assert.equal(pageBodySchema.safeParse({ ...pageHomeFixture, pageType: 'landing' }).success, false);
  assert.equal(
    pageBodySchema.safeParse({
      ...pageHomeFixture,
      sections: [{ id: 's_x', type: 'fragment_override', data: {} }],
    }).success,
    false
  );
  // navigationOverrides is DATA-ONLY variation: references only, no slots/code.
  assert.equal(
    pageBodySchema.safeParse({
      ...pageHomeFixture,
      navigationOverrides: { footer: 'nav_footer_home', slot: '<Fragment/>' },
    }).success,
    false
  );
});

// ---------------------------------------------------------------------------
// Template ('template.v1', D§3.6)
// ---------------------------------------------------------------------------

const templateFixture: TemplateBody = {
  name: 'Standard page',
  appliesTo: ['standard'],
  slots: [
    {
      slotId: 'main_hero',
      allowed: ['hero'],
      required: true,
      repeatable: false,
      blueprint: {
        id: 's_bphero',
        type: 'hero',
        data: { heading: 'New page', actions: [] },
      },
    },
    { slotId: 'content', allowed: ['prose', 'faq', 'cta_banner'], required: false, repeatable: true },
  ],
};

test('template: fixture with slot blueprints parses cleanly', () => {
  const parsed = templateBodySchema.parse(templateFixture);
  assert.equal(TEMPLATE_SCHEMA_VERSION, 'template.v1');
  assert.deepEqual(parsed, templateFixture);
});

test('template: unknown allowed section types and unknown PageTypes are rejected', () => {
  assert.equal(
    templateBodySchema.safeParse({
      ...templateFixture,
      slots: [{ slotId: 's', allowed: ['no_such_type'], required: false, repeatable: false }],
    }).success,
    false
  );
  assert.equal(templateBodySchema.safeParse({ ...templateFixture, appliesTo: ['landing'] }).success, false);
});

test('template: allowed types expose concrete registered sections only', () => {
  for (const pointerOrLeaf of ['shared_ref', 'card']) {
    const parsed = templateBodySchema.safeParse({
      ...templateFixture,
      slots: [{ slotId: 's', allowed: [pointerOrLeaf], required: false, repeatable: false }],
    });
    assert.equal(parsed.success, false, `${pointerOrLeaf} must not be advertised as a template slot type`);
  }

  assert.equal(
    templateBodySchema.safeParse({
      ...templateFixture,
      slots: [{ slotId: 's', allowed: ['comparison_table'], required: false, repeatable: false }],
    }).success,
    true
  );
});

// ---------------------------------------------------------------------------
// Site ('site.v1', D§3.2)
// ---------------------------------------------------------------------------

const siteFixture: SiteBody = {
  name: 'Dr. Lurié Skin Care',
  logo: { text: 'Dr. Lurié Skin Care' },
  urls: { base: 'https://drluriescience.netlify.app', canonicalHost: 'drluriescience.netlify.app' },
  metadataDefaults: {
    titleTemplate: '%s — Dr. Lurié Skin Care',
    description: 'Science-first skincare education.',
    ogImage: '~/assets/images/default-og.jpg',
    twitterHandle: '@drlurie',
  },
  brandTokens: {
    colors: { accent: '#0ea5e9', muted: '#64748b' },
    fonts: { sans: 'Inter Variable', serif: 'Georgia', heading: 'Inter Variable' },
  },
  chrome: {
    showRssFeed: true,
    showThemeToggle: true,
    announcement: { enabled: false },
  },
  defaultNavigation: { header: 'nav_header', footer: 'nav_footer' },
  blog: { listPath: '/learn/library', postsPerPage: 12, categoryBase: 'category', tagBase: 'tag' },
};

test('site: fixture parses cleanly and strictness rejects stray config keys', () => {
  const parsed = siteBodySchema.parse(siteFixture);
  assert.equal(SITE_SCHEMA_VERSION, 'site.v1');
  assert.deepEqual(parsed, siteFixture);

  assert.equal(siteBodySchema.safeParse({ ...siteFixture, googleSiteVerificationId: 'x' }).success, false);
  const { defaultNavigation, ...withoutNav } = siteFixture;
  void defaultNavigation;
  assert.equal(siteBodySchema.safeParse(withoutNav).success, false, 'defaultNavigation is required');
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, blog: { ...siteFixture.blog, postsPerPage: 0 } }).success,
    false
  );
});

// brandImagery (W16 C1, §4 vocabulary): additive-optional visual-identity
// contract for AI image generation/search — bounded the same way brandTokens'
// value grammar keeps the palette small (capped array/string lengths, no
// unbounded blobs). `palette` is deliberately separate from
// brandTokens.colors (see the schema module's doc comment for why).
const VALID_BRAND_IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42', '#C2A878'],
  negative: ['no stock-photo gloss', 'no harsh flash'],
  composition: { subjectScale: 'medium close-up', cropRule: 'rule of thirds', depthOfField: 'shallow' },
  aspectRatios: { article_header: '3:2', article_body: '4:3', pdf_cover: '1:1' },
  seedBase: 100001,
  lora: {
    url: 'https://fal.media/files/brand/dr-lurie-v3.safetensors',
    scale: 0.8,
    triggerPhrase: 'drlurie_style',
    version: 'v3',
    modelEndpoint: 'fal-ai/flux-2/klein/9b',
  },
} as const;

test('site.brandImagery: optional, bounded, and matches the §4 vocabulary', () => {
  assert.equal(
    siteBodySchema.safeParse(siteFixture).success,
    true,
    'brandImagery is optional — a site without one still parses'
  );

  const withImagery = { ...siteFixture, brandImagery: VALID_BRAND_IMAGERY };
  assert.equal(siteBodySchema.safeParse(withImagery).success, true, JSON.stringify(withImagery));

  // The minimal shape (no composition, no lora) also parses.
  const { composition: _composition, lora: _lora, ...minimalImagery } = VALID_BRAND_IMAGERY;
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: minimalImagery }).success,
    true,
    'composition and lora are optional'
  );

  // Unknown keys are rejected (strict), matching brandTokens' posture.
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, stray: 'nope' },
    }).success,
    false
  );

  // version is a pinned literal — only exactly 1 is accepted.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, version: 2 } }).success,
    false,
    'version must be exactly 1'
  );
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: (() => {
        const { version: _version, ...rest } = VALID_BRAND_IMAGERY;
        return rest;
      })(),
    }).success,
    false,
    'version is required'
  );

  // medium is a bounded enum — an unknown medium is rejected.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, medium: 'oil_painting' } })
      .success,
    false
  );

  // palette entries must be #RRGGBB hex — case-insensitive hex passes,
  // anything else (named colors, short hex, missing '#') is rejected.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, palette: ['#aAbBcC'] } })
      .success,
    true,
    'lowercase/mixed-case hex is accepted'
  );
  for (const bad of ['red', '#fff', '2E5C42', '#2E5C4', '#2E5C42FF']) {
    assert.equal(
      siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, palette: [bad] } }).success,
      false,
      `palette entry "${bad}" must be rejected`
    );
  }
  // palette requires at least one entry and is capped at 8.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, palette: [] } }).success,
    false
  );
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, palette: Array.from({ length: 9 }, () => '#2E5C42') },
    }).success,
    false
  );

  // aspectRatios values must be "W:H" ratio strings; keys must be bounded
  // lowercase snake_case.
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, aspectRatios: { article_header: '3x2' } },
    }).success,
    false,
    'aspect ratio value must be "W:H", not "WxH"'
  );
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, aspectRatios: { 'Article Header': '3:2' } },
    }).success,
    false,
    'aspect ratio context keys must be lowercase snake_case'
  );

  // seedBase must be a non-negative safe integer.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, seedBase: -1 } }).success,
    false
  );
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, seedBase: 1.5 } }).success,
    false
  );

  // Bounded string lengths: an oversized styleSentence is rejected so nothing
  // unbounded lands in the store.
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, styleSentence: 'x'.repeat(500) } })
      .success,
    false
  );

  // negative is capped at 12 entries.
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, negative: Array.from({ length: 13 }, (_, i) => `bad-${i}`) },
    }).success,
    false
  );

  // lora needs a non-empty url; scale/triggerPhrase/version/modelEndpoint stay optional.
  assert.equal(
    siteBodySchema.safeParse({
      ...siteFixture,
      brandImagery: { ...VALID_BRAND_IMAGERY, lora: { url: 'https://fal.media/files/brand/x.safetensors' } },
    }).success,
    true,
    'lora only requires url'
  );
  assert.equal(
    siteBodySchema.safeParse({ ...siteFixture, brandImagery: { ...VALID_BRAND_IMAGERY, lora: { url: '' } } }).success,
    false
  );
});

// ---------------------------------------------------------------------------
// Taxonomy ('taxonomy.v1', D§3.7)
// ---------------------------------------------------------------------------

const taxonomyFixture: TaxonomyBody = {
  kinds: {
    category: {
      terms: [
        { term_id: 't_skinscience', slug: 'skin-science', label: 'Skin Science', status: 'active' },
        {
          term_id: 't_skincare101',
          slug: 'skincare-101',
          label: 'Skincare 101',
          description: 'Old intro category.',
          status: 'deprecated',
          merged_into: 't_skinscience',
        },
      ],
    },
    tag: {
      terms: [{ term_id: 't_barrier', slug: 'skin-barrier', label: 'Skin barrier', status: 'active' }],
    },
  },
};

test('taxonomy: fixture with an active term and a deprecated merged term parses cleanly', () => {
  const parsed = taxonomyBodySchema.parse(taxonomyFixture);
  assert.equal(TAXONOMY_SCHEMA_VERSION, 'taxonomy.v1');
  assert.deepEqual(parsed, taxonomyFixture);
});

test('taxonomy: malformed term ids, statuses, and kinds are rejected', () => {
  const term = taxonomyFixture.kinds.tag.terms[0];
  const withTagTerm = (patch: Record<string, unknown>) => ({
    kinds: { category: { terms: [] }, tag: { terms: [{ ...term, ...patch }] } },
  });

  assert.equal(taxonomyBodySchema.safeParse(withTagTerm({ term_id: 'barrier' })).success, false);
  assert.equal(taxonomyBodySchema.safeParse(withTagTerm({ term_id: 't_Barrier' })).success, false);
  assert.equal(taxonomyBodySchema.safeParse(withTagTerm({ status: 'retired' })).success, false);
  assert.equal(taxonomyBodySchema.safeParse(withTagTerm({ merged_into: 'skin-science' })).success, false);
  assert.equal(
    taxonomyBodySchema.safeParse({ kinds: { category: { terms: [] }, collection: { terms: [] } } }).success,
    false,
    'term kinds are fixed to category/tag in v1'
  );
});

// ---------------------------------------------------------------------------
// Product ('product.v1', 06-shop-module-plan §1)
// ---------------------------------------------------------------------------

const productFixture: ProductBody = {
  slug: 'barrier-repair-guide',
  presentation: {
    title: 'The Barrier Repair Guide',
    excerpt: 'A practical, science-first repair plan.',
    images: [{ src: 'https://kugelmedia.example/covers/barrier.jpg', alt: 'Guide cover' }],
    seo: { description: 'Repair your skin barrier.', ogImage: '/images/og/barrier.jpg' },
    page_ref: 'page_prod_barrier_guide',
  },
  commerce: {
    provider: 'stripe',
    mode: 'fixed',
    price: { amount_cents: 1900, currency: 'usd' },
    stripe: { product_id: 'prod_Abc123', price_id: 'price_Abc123' },
    availability: 'available',
  },
  fulfillment: {
    kind: 'download',
    artifact_ref: 'pdf/guides/2f4d1b6f9d1e4c1a8e1b3c5d7f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345.pdf',
    filename: 'barrier-repair-guide.pdf',
  },
};

test('product: fixed-download fixture parses cleanly; strictness rejects stray keys', () => {
  const parsed = productBodySchema.parse(productFixture);
  assert.equal(PRODUCT_SCHEMA_VERSION, 'product.v1');
  assert.deepEqual(parsed, productFixture);

  assert.equal(productBodySchema.safeParse({ ...productFixture, sku: 'X1' }).success, false);
  assert.equal(
    productBodySchema.safeParse({
      ...productFixture,
      presentation: { ...productFixture.presentation, body: '<p>long form belongs in the page_ref page</p>' },
    }).success,
    false
  );
});

test('product: every fulfillment kind parses; half-filled variants are rejected', () => {
  // Tip/PWYW support — nothing to deliver.
  const tip: ProductBody = {
    slug: 'leave-a-tip',
    presentation: { title: 'Leave a tip' },
    commerce: {
      provider: 'stripe',
      mode: 'pwyw',
      pwyw: { min_cents: 300, suggested_cents: 900 },
      stripe: { product_id: 'prod_Tip1' },
      availability: 'available',
    },
    fulfillment: { kind: 'none' },
  };
  assert.deepEqual(productBodySchema.parse(tip), tip);

  // Pay-to-unlock names the PRE-generated artifact's key prefix (§5).
  const unlock: ProductBody = {
    ...productFixture,
    slug: 'quiz-deep-dive',
    fulfillment: { kind: 'unlock', unlock_prefix: 'unlock/quiz-results/' },
  };
  assert.deepEqual(productBodySchema.parse(unlock), unlock);

  // Free lead magnet — no Stripe anywhere.
  const free: ProductBody = {
    slug: 'starter-checklist',
    presentation: { title: 'Starter checklist' },
    commerce: { provider: 'none', mode: 'free', availability: 'available' },
    fulfillment: {
      kind: 'download',
      artifact_ref: 'pdf/guides/2f4d1b6f9d1e4c1a8e1b3c5d7f9a1b2c3d4e5f60718293a4b5c6d7e8f9012345.pdf',
      filename: 'starter.pdf',
    },
  };
  assert.deepEqual(productBodySchema.parse(free), free);

  // Discriminated union: a download without its file, an unlock without its
  // prefix, and cross-variant leftovers (the trap-2 deep-merge residue) all fail.
  assert.equal(
    productBodySchema.safeParse({ ...productFixture, fulfillment: { kind: 'download', filename: 'x.pdf' } }).success,
    false
  );
  assert.equal(productBodySchema.safeParse({ ...productFixture, fulfillment: { kind: 'unlock' } }).success, false);
  assert.equal(
    productBodySchema.safeParse({
      ...productFixture,
      fulfillment: { kind: 'none', artifact_ref: 'pdf/guides/x.pdf', filename: 'x.pdf' },
    }).success,
    false
  );
  assert.equal(productBodySchema.safeParse({ ...productFixture, fulfillment: { kind: 'shipment' } }).success, false);
});

test('product: Stripe id shapes are pinned so keys can never sit where ids belong', () => {
  const withStripe = (stripe: Record<string, unknown>) => ({
    ...productFixture,
    commerce: { ...productFixture.commerce, stripe },
  });
  assert.equal(productBodySchema.safeParse(withStripe({ product_id: 'sk_live_abc' })).success, false);
  assert.equal(
    productBodySchema.safeParse(withStripe({ product_id: 'prod_Abc123', price_id: 'whsec_abc' })).success,
    false
  );
  assert.equal(
    productBodySchema.safeParse({
      ...productFixture,
      commerce: { ...productFixture.commerce, price: { amount_cents: 19.5, currency: 'usd' } },
    }).success,
    false,
    'amounts are integer cents'
  );
  assert.equal(
    productBodySchema.safeParse({
      ...productFixture,
      commerce: { ...productFixture.commerce, price: { amount_cents: 1900, currency: 'USD' } },
    }).success,
    false,
    'currency is a lowercase ISO code'
  );
});
