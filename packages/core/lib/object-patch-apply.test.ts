import { describe, it } from 'node:test';
import assert from 'node:assert';
import type { ObjectRecord, ObjectType, Principal } from '../schema/object-record-v1.js';
import { patchOpSchema } from '../schema/object-patch-ops.js';
import {
  applyPatchOps,
  derivePatchInverse,
  PatchApplyError,
  type ApplyPatchResult,
  type PatchOpCapture,
} from './object-patch-apply.js';

const AGENT: Principal = { kind: 'agent', agent_name: 'tester', auth: 'publish_key' };
const AT = '2026-07-04T00:00:00.000Z';

const makeRecord = (objectType: ObjectType, body: unknown): ObjectRecord<unknown> => ({
  object_id:
    objectType === 'page'
      ? 'page_home'
      : objectType === 'section'
        ? 'sec_newsletter_signup'
        : objectType === 'navigation'
          ? 'nav_header'
          : objectType === 'taxonomy'
            ? 'tax_drlurie'
            : objectType === 'site'
              ? 'site_drlurie'
              : objectType === 'template'
                ? 'tpl_standard'
                : objectType === 'section_template'
                  ? 'stpl_hero_landing'
                  : objectType === 'theme'
                    ? 'thm_default'
                    : objectType === 'product'
                      ? 'prod_barrier_repair_guide'
                      : 'req_agent_topic_20260704_01',
  object_type: objectType,
  schema_version: `${objectType}.v1`,
  site: 'site_drlurie',
  created_at: '2026-07-01T00:00:00.000Z',
  updated_at: '2026-07-01T00:00:00.000Z',
  status: 'active',
  body,
  publication: { published_time: null },
  history: [],
  version: 3,
  content_revision: 2,
});

const apply = (record: ObjectRecord<unknown>, ops: unknown[], privilegedOps?: readonly string[]): ApplyPatchResult =>
  applyPatchOps(record, ops, { actor: AGENT, at: AT, ...(privilegedOps ? { privilegedOps } : {}) });

// ——— fixtures (structural mirrors of the D§3.2–3.8 shapes) ———

const pageBody = () => ({
  route: '/',
  pageType: 'home',
  title: 'Home',
  seo: { title: 'Dr. Lurie', description: 'Newborn help' },
  sections: [
    {
      id: 's_hero',
      type: 'hero',
      data: {
        kicker: 'Hi',
        heading: 'A calmer start',
        actions: [{ label: 'Start', target: { kind: 'route', href: '/start-here' } }],
      },
    },
    {
      id: 's_grid',
      type: 'content_grid',
      data: { heading: 'Start here', source: { kind: 'manual', items: [] }, limit: 5 },
    },
    { id: 's_bio', type: 'bio', data: { heading: 'About', body: '<p>bio</p>', trustNotes: ['MD'] } },
  ],
});

const sharedSectionBody = () => ({
  section: { id: 's_signup', type: 'newsletter_signup', data: { heading: 'Join', formName: 'newsletter' } },
});

const navBody = () => ({
  role: 'header',
  brand: { text: 'Dr. Lurie' },
  groups: [
    {
      id: 'g_main',
      title: 'Main',
      items: [
        { id: 'i_start', label: 'Start Here', target: { kind: 'route', href: '/start-here' } },
        {
          id: 'i_learn',
          label: 'Learn',
          target: { kind: 'route', href: '/learn' },
          children: [
            { id: 'i_sleep', label: 'Sleep', target: { kind: 'route', href: '/topics/sleep' } },
            { id: 'i_feeding', label: 'Feeding', target: { kind: 'route', href: '/topics/feeding' } },
          ],
        },
      ],
    },
    {
      id: 'g_social',
      slot: 'social',
      items: [{ id: 'i_rss', label: 'RSS', target: { kind: 'asset', href: '/rss.xml' }, icon: 'tabler:rss' }],
    },
  ],
  footNote: '<p>All rights reserved.</p>',
});

const taxonomyBody = () => ({
  kinds: {
    category: {
      terms: [
        { term_id: 't_sleep', slug: 'sleep', label: 'Sleep', status: 'active' },
        { term_id: 't_colic', slug: 'colic', label: 'Colic', status: 'deprecated', merged_into: 't_sleep' },
        { term_id: 't_feeding', slug: 'feeding', label: 'Feeding', status: 'active' },
      ],
    },
    tag: { terms: [{ term_id: 't_newborn', slug: 'newborn', label: 'Newborn', status: 'active' }] },
  },
});

const siteBody = () => ({
  name: 'Dr. Lurie',
  brandTokens: {
    colors: { primary: '#112233', accent: '#445566' },
    fonts: { sans: 'Inter', serif: 'Lora', heading: 'Inter' },
  },
  chrome: { showRssFeed: true, showThemeToggle: false },
});

const templateBody = () => ({
  name: 'Standard page',
  appliesTo: ['standard'],
  slots: [
    { slotId: 'main', allowed: ['hero', 'prose'], required: true, repeatable: false },
    { slotId: 'aside', allowed: ['bio'], required: false, repeatable: true },
  ],
});

const sectionTemplateBody = () => ({
  name: 'Landing hero',
  description: 'Opening hero recipe.',
  blueprint: {
    id: 's_stplhero',
    type: 'hero',
    data: { kicker: 'Overview', heading: 'New hero heading', actions: [] },
  },
});

const productBody = () => ({
  slug: 'barrier-repair-guide',
  presentation: {
    title: 'The Barrier Repair Guide',
    excerpt: 'Card copy.',
    seo: { description: 'A guide.' },
  },
  commerce: {
    provider: 'stripe',
    mode: 'fixed',
    price: { amount_cents: 1900, currency: 'usd' },
    stripe: { product_id: 'prod_Abc123', price_id: 'price_Abc123' },
    availability: 'available',
  },
  fulfillment: { kind: 'download', artifact_ref: 'pdf/guides/abc.pdf', filename: 'barrier-repair-guide.pdf' },
});

const articleBody = () => ({
  slug: 'barrier-myths',
  title: 'Five barrier myths',
  deck: 'What the research actually says.',
  taxonomy: { category: 'skin-science', tags: ['barrier-repair'] },
  nodes: [
    {
      id: 'n_a1',
      kind: 'content',
      public: { title: 'The myth', body: 'Everyone repeats it.' },
      private: { strategy: 'hook', intent: 'persuade' },
    },
    {
      id: 'n_a2',
      kind: 'content',
      public: { body: 'Here is why it spread.' },
      private: { strategy: 'agitation' },
    },
    {
      id: 'n_a3',
      kind: 'content',
      public: { body: 'And here is the fix.' },
      private: { strategy: 'resolution' },
      visibility: 'public',
    },
  ],
});

// ——— property-style round-trips: apply(op) then apply(inverse(op)) restores
//     the prior body exactly, for every op in every family (T0.6 acceptance) ———

interface RoundTripCase {
  name: string;
  objectType: ObjectType;
  body: () => unknown;
  op: Record<string, unknown>;
  /** Privileged, non-allowlisted ops the case needs (e.g. set_site_brand_tokens). */
  privilegedOps?: readonly string[];
}

const ROUND_TRIP_CASES: RoundTripCase[] = [
  // page / shared-section family
  {
    name: 'set_page_meta merges, unsets, and adds fields',
    objectType: 'page',
    body: pageBody,
    op: { op: 'set_page_meta', fields: { title: 'New home', seo: { description: null, ogImage: 'og.png' } } },
  },
  {
    name: 'upsert_section inserts at a position',
    objectType: 'page',
    body: pageBody,
    op: { op: 'upsert_section', section: { id: 's_faq', type: 'faq', data: { items: [] } }, position: 1 },
  },
  {
    name: 'upsert_section appends without a position',
    objectType: 'page',
    body: pageBody,
    op: { op: 'upsert_section', section: { id: 's_cta', type: 'cta_banner', data: { actions: [] } } },
  },
  {
    name: 'upsert_section replaces an existing section',
    objectType: 'page',
    body: pageBody,
    op: {
      op: 'upsert_section',
      section: {
        id: 's_grid',
        type: 'content_grid',
        data: { heading: 'Curated', source: { kind: 'manual', items: [] }, limit: 3 },
      },
    },
  },
  {
    name: 'update_section_data merges and unsets data fields',
    objectType: 'page',
    body: pageBody,
    op: {
      op: 'update_section_data',
      section_id: 's_hero',
      fields: { heading: 'A calmer, clearer start', kicker: null },
    },
  },
  {
    name: 'move_section to the front',
    objectType: 'page',
    body: pageBody,
    op: { op: 'move_section', section_id: 's_bio', to_index: 0 },
  },
  {
    name: 'move_section clamps past the end',
    objectType: 'page',
    body: pageBody,
    op: { op: 'move_section', section_id: 's_hero', to_index: 99 },
  },
  {
    name: 'set_section_visibility on a section with no visibility',
    objectType: 'page',
    body: pageBody,
    op: { op: 'set_section_visibility', section_id: 's_grid', visibility: 'hidden' },
  },
  {
    name: 'remove_section restores at its index',
    objectType: 'page',
    body: pageBody,
    op: { op: 'remove_section', section_id: 's_grid' },
  },
  {
    name: 'upsert_section replaces the shared-section wrapper',
    objectType: 'section',
    body: sharedSectionBody,
    op: {
      op: 'upsert_section',
      section: { id: 's_signup', type: 'newsletter_signup', data: { heading: 'Join us', formName: 'newsletter' } },
    },
  },
  {
    name: 'update_section_data on a shared section',
    objectType: 'section',
    body: sharedSectionBody,
    op: {
      op: 'update_section_data',
      section_id: 's_signup',
      fields: { heading: 'Get the letter', consentText: 'No spam.' },
    },
  },
  {
    name: 'set_section_visibility on a shared section',
    objectType: 'section',
    body: sharedSectionBody,
    op: { op: 'set_section_visibility', section_id: 's_signup', visibility: 'hidden' },
  },
  // navigation family
  {
    name: 'set_nav_meta merges brand and unsets footNote',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'set_nav_meta', fields: { brand: { descriptor: 'Pediatrician' }, footNote: null } },
  },
  {
    name: 'upsert_group inserts',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'upsert_group',
      group: {
        id: 'g_legal',
        slot: 'secondary',
        items: [{ id: 'i_privacy', label: 'Privacy', target: { kind: 'route', href: '/privacy' } }],
      },
      position: 0,
    },
  },
  {
    name: 'upsert_group replaces',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'upsert_group', group: { id: 'g_social', slot: 'social', items: [] } },
  },
  {
    name: 'move_group',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'move_group', group_id: 'g_social', to_index: 0 },
  },
  { name: 'remove_group', objectType: 'navigation', body: navBody, op: { op: 'remove_group', group_id: 'g_main' } },
  {
    name: 'upsert_item inserts at the top level',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'upsert_item',
      group_id: 'g_main',
      item: { id: 'i_news', label: 'Newsletter', target: { kind: 'route', href: '/newsletter' } },
      position: 1,
    },
  },
  {
    name: 'upsert_item creates a dropdown (children container) — inverse prunes it',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'upsert_item',
      group_id: 'g_main',
      item: { id: 'i_faq', label: 'FAQ', target: { kind: 'route', href: '/faq' } },
      parent_item_id: 'i_start',
    },
  },
  {
    name: 'upsert_item replaces a child in place',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'upsert_item',
      group_id: 'g_main',
      item: { id: 'i_sleep', label: 'Infant sleep', target: { kind: 'route', href: '/topics/infant-sleep' } },
    },
  },
  {
    name: 'update_item on a dropdown child',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'update_item',
      group_id: 'g_main',
      item_id: 'i_sleep',
      fields: { label: 'Sleep basics', description: 'Where to begin' },
    },
  },
  {
    name: 'move_item within children',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'move_item', group_id: 'g_main', item_id: 'i_feeding', to_index: 0 },
  },
  {
    name: 'move_item at the top level',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'move_item', group_id: 'g_main', item_id: 'i_learn', to_index: 0 },
  },
  {
    name: 'remove_item child',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'remove_item', group_id: 'g_main', item_id: 'i_sleep' },
  },
  {
    name: 'remove_item top-level',
    objectType: 'navigation',
    body: navBody,
    op: { op: 'remove_item', group_id: 'g_main', item_id: 'i_start' },
  },
  {
    name: 'upsert_action creates the actions container — inverse prunes it',
    objectType: 'navigation',
    body: navBody,
    op: {
      op: 'upsert_action',
      action: { label: 'Join Newsletter', target: { kind: 'route', href: '/newsletter' }, style: 'primary' },
    },
  },
  // taxonomy family
  {
    name: 'add_term inverts to removal',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'add_term', kind: 'tag', term: { term_id: 't_reflux', slug: 'reflux', label: 'Reflux' } },
  },
  {
    name: 'remove_term restores a deprecated term exactly (status, merge target, position)',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'remove_term', kind: 'category', term_id: 't_colic' },
  },
  {
    name: 'update_term label/description only',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: {
      op: 'update_term',
      kind: 'category',
      term_id: 't_feeding',
      fields: { label: 'Feeding & nutrition', description: 'Bottles, breastfeeding, solids' },
    },
  },
  {
    name: 'update_term slug rename mints the auto-alias — inverse removes it',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'infant-sleep' } },
  },
  {
    name: 'update_term slug rename with explicit alias id and label change',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: {
      op: 'update_term',
      kind: 'category',
      term_id: 't_sleep',
      fields: { slug: 'infant-sleep', label: 'Infant sleep' },
      alias_term_id: 't_oldsleep',
    },
  },
  {
    name: 'deprecate_term with a merge target inverts to reactivation',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'deprecate_term', kind: 'category', term_id: 't_feeding', merged_into: 't_sleep' },
  },
  {
    name: 'deprecate_term without a merge target',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'deprecate_term', kind: 'tag', term_id: 't_newborn' },
  },
  {
    name: 're-deprecating with a different merge target inverts to the old one',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'deprecate_term', kind: 'category', term_id: 't_colic', merged_into: 't_feeding' },
  },
  {
    name: 'reactivate_term inverts to deprecation with the old merge target',
    objectType: 'taxonomy',
    body: taxonomyBody,
    op: { op: 'reactivate_term', kind: 'category', term_id: 't_colic' },
  },
  // site family
  {
    name: 'set_site_fields deep-merges non-palette fields and unsets a subtree',
    objectType: 'site',
    body: siteBody,
    op: {
      op: 'set_site_fields',
      fields: { metadataDefaults: { description: 'New description' }, chrome: null },
    },
  },
  // The palette writer (theme-only governance): brandTokens rides its own
  // privileged op, deep-merging nested tokens and unsetting a subtree — and it
  // inverts exactly, so "revert the theme" is a standard Discard.
  {
    name: 'set_site_brand_tokens deep-merges nested tokens and unsets a subtree',
    objectType: 'site',
    body: siteBody,
    op: {
      op: 'set_site_brand_tokens',
      fields: { brandTokens: { colors: { primary: '#000000', tertiary: '#abcdef' } } },
    },
    // Privileged: not in the site allowlist — only site_apply_theme (and the
    // inverse re-applied here) may apply it.
    privilegedOps: ['set_site_brand_tokens'],
  },
  // brandImagery's writer (W16 C1, §4 vocabulary) — same privileged funnel as
  // brandTokens: deep-merges nested fields and unsets a subtree, and inverts
  // exactly.
  {
    name: 'set_site_brand_imagery deep-merges nested fields and unsets a subtree',
    objectType: 'site',
    body: () => ({
      ...siteBody(),
      brandImagery: {
        version: 1,
        medium: 'photograph',
        styleSentence: 'Clinical-clean skincare editorial photography.',
        palette: ['#2E5C42'],
        negative: ['no stock-photo gloss'],
        aspectRatios: { article_header: '3:2' },
        seedBase: 100001,
        composition: { subjectScale: 'medium close-up' },
      },
    }),
    op: {
      op: 'set_site_brand_imagery',
      fields: {
        brandImagery: {
          styleSentence: 'Clinical-clean skincare editorial photography, soft studio light.',
          composition: null,
        },
      },
    },
    // Privileged: not in the site allowlist — hand-authoring it via
    // object_patch is refused (op_not_applicable); only a future privileged
    // writer (and the inverse re-applied here) may apply it.
    privilegedOps: ['set_site_brand_imagery'],
  },
  // product family
  {
    name: 'set_product_fields deep-merges presentation, unsets excerpt, and flips availability',
    objectType: 'product',
    body: productBody,
    op: {
      op: 'set_product_fields',
      fields: {
        presentation: { title: 'The Barrier Repair Guide (2nd ed.)', excerpt: null },
        commerce: { availability: 'coming_soon' },
      },
    },
  },
  // template family
  {
    name: 'set_template_meta replaces arrays wholesale',
    objectType: 'template',
    body: templateBody,
    op: { op: 'set_template_meta', fields: { name: 'Landing', appliesTo: ['home', 'standard'] } },
  },
  {
    name: 'upsert_slot inserts',
    objectType: 'template',
    body: templateBody,
    op: {
      op: 'upsert_slot',
      slot: { slotId: 'footerslot', allowed: ['cta_banner'], required: false, repeatable: false },
      position: 1,
    },
  },
  {
    name: 'upsert_slot replaces',
    objectType: 'template',
    body: templateBody,
    op: {
      op: 'upsert_slot',
      slot: { slotId: 'aside', allowed: ['bio', 'link_list'], required: true, repeatable: false },
    },
  },
  {
    name: 'move_slot',
    objectType: 'template',
    body: templateBody,
    op: { op: 'move_slot', slot_id: 'aside', to_index: 0 },
  },
  { name: 'remove_slot', objectType: 'template', body: templateBody, op: { op: 'remove_slot', slot_id: 'main' } },

  // section_template family (W8.1)
  {
    name: 'set_section_template_meta merges name and unsets description',
    objectType: 'section_template',
    body: sectionTemplateBody,
    op: { op: 'set_section_template_meta', fields: { name: 'Campaign hero', description: null } },
  },
  {
    name: 'replace_blueprint swaps the whole instance (type change included)',
    objectType: 'section_template',
    body: sectionTemplateBody,
    op: {
      op: 'replace_blueprint',
      blueprint: { id: 's_stplcta', type: 'cta_banner', data: { heading: 'Keep exploring', actions: [] } },
    },
  },
  {
    name: 'update_blueprint_data deep-merges and unsets with null',
    objectType: 'section_template',
    body: sectionTemplateBody,
    op: { op: 'update_blueprint_data', fields: { heading: 'A sharper hero heading', kicker: null } },
  },

  // theme family (W8.3)
  {
    name: 'set_theme_fields deep-merges token values and unsets a color',
    objectType: 'theme',
    body: () => ({
      name: 'Default',
      tokens: {
        colors: { primary: '#112233', accent: '#445566' },
        fonts: { sans: 'Inter', serif: 'Lora', heading: 'Inter' },
      },
    }),
    op: { op: 'set_theme_fields', fields: { tokens: { colors: { primary: '#000000', accent: null } } } },
  },

  // content_item / article node family (W7.3)
  {
    name: 'set_article_meta merges, unsets, and adds fields',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'set_article_meta', fields: { title: 'Six barrier myths', deck: null, seo: { meta_title: 'Myths' } } },
  },
  {
    // T9.23a: author starts absent (articleBody carries none) — the same
    // generic fields-op inverse that unsets deck/seo above must unset a
    // freshly-set author exactly, restoring "absent" rather than "".
    name: 'set_article_meta sets an author (T9.23a); inverse unsets it exactly',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'set_article_meta', fields: { author: 'Dr. Lurie' } },
  },
  {
    name: 'upsert_node inserts at a position',
    objectType: 'content_item',
    body: articleBody,
    op: {
      op: 'upsert_node',
      node: { id: 'n_b1', kind: 'content', public: { body: 'A new middle.' }, private: { strategy: 'proof' } },
      position: 1,
    },
  },
  {
    name: 'upsert_node replaces an existing node',
    objectType: 'content_item',
    body: articleBody,
    op: {
      op: 'upsert_node',
      node: { id: 'n_a2', kind: 'content', public: { body: 'Rewritten.' }, private: { strategy: 'context' } },
    },
  },
  {
    name: 'update_node merges annotation and copy fields, unsets with null',
    objectType: 'content_item',
    body: articleBody,
    op: {
      op: 'update_node',
      node_id: 'n_a1',
      fields: { public: { body: 'A sharper opening.', title: null }, private: { intent: 'convert' } },
    },
  },
  {
    name: 'move_node',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'move_node', node_id: 'n_a3', to_index: 0 },
  },
  {
    name: 'set_node_visibility on a bare node (inverse restores unset)',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'set_node_visibility', node_id: 'n_a2', visibility: 'internal' },
  },
  {
    name: 'set_node_visibility overwriting an explicit value',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'set_node_visibility', node_id: 'n_a3', visibility: 'hidden' },
  },
  {
    name: 'remove_node (inverse restores position)',
    objectType: 'content_item',
    body: articleBody,
    op: { op: 'remove_node', node_id: 'n_a2' },
  },
];

describe('apply(op) then apply(inverse(op)) restores the prior body exactly', () => {
  for (const testCase of ROUND_TRIP_CASES) {
    it(testCase.name, () => {
      const original = testCase.body();
      const record = makeRecord(testCase.objectType, testCase.body());

      const forward = apply(record, [testCase.op], testCase.privilegedOps);
      const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);
      const reverted = apply(forward.record, [inverse], testCase.privilegedOps);

      assert.deepStrictEqual(reverted.record.body, original);
    });
  }

  it('set_site_brand_tokens is REFUSED without privilege (theme-only governance — object_patch cannot hand-author it)', () => {
    const record = makeRecord('site', siteBody());
    assert.throws(
      () => apply(record, [{ op: 'set_site_brand_tokens', fields: { brandTokens: { colors: { primary: '#000' } } } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
    // …but the exact same op applies when the caller is privileged (the verb path).
    const okApply = apply(
      record,
      [{ op: 'set_site_brand_tokens', fields: { brandTokens: { colors: { primary: '#000' } } } }],
      ['set_site_brand_tokens']
    );
    assert.equal(
      (okApply.record.body as { brandTokens: { colors: { primary: string } } }).brandTokens.colors.primary,
      '#000'
    );
  });

  it('set_site_brand_imagery is REFUSED without privilege (object_patch cannot hand-author it)', () => {
    const record = makeRecord('site', siteBody());
    assert.throws(
      () =>
        apply(record, [
          { op: 'set_site_brand_imagery', fields: { brandImagery: { styleSentence: 'Clinical-clean.' } } },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
    // …but the exact same op applies when the caller is privileged.
    const okApply = apply(
      record,
      [{ op: 'set_site_brand_imagery', fields: { brandImagery: { styleSentence: 'Clinical-clean.' } } }],
      ['set_site_brand_imagery']
    );
    assert.deepEqual(
      (okApply.record.body as { brandImagery: { styleSentence: string } }).brandImagery.styleSentence,
      'Clinical-clean.'
    );
  });

  it('set_site_fields REFUSES a brandImagery-carrying patch (theme-only-style governance)', () => {
    const record = makeRecord('site', siteBody());
    assert.throws(
      () =>
        apply(record, [{ op: 'set_site_fields', fields: { brandImagery: { styleSentence: 'Clinical-clean.' } } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
  });

  it('a multi-op batch round-trips by applying inverses in reverse order', () => {
    const original = pageBody();
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } },
      { op: 'move_section', section_id: 's_bio', to_index: 0 },
      { op: 'remove_section', section_id: 's_grid' },
      { op: 'set_page_meta', fields: { title: 'Front page' } },
    ]);
    const inverses = forward.applied.map((entry) => derivePatchInverse(entry.op, entry.capture)).reverse();
    const reverted = apply(forward.record, inverses);
    assert.deepStrictEqual(reverted.record.body, original);
  });

  it('the inverse is derivable from what history stores (JSON round-trip)', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }]);
    const entry = forward.record.history.at(-1);
    assert.ok(entry);
    assert.strictEqual(entry.action, 'update_section_data');
    assert.deepStrictEqual(entry.actor, AGENT);
    const details = JSON.parse(JSON.stringify(entry.details)) as { op: unknown; capture: PatchOpCapture };
    const inverse = derivePatchInverse(patchOpSchema.parse(details.op), details.capture);
    const reverted = apply(forward.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, pageBody());
  });
});

describe('conditional upsert inverse (C§2.4)', () => {
  it('inverts a replacing upsert to an upsert restoring `before` — not a remove', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [
      {
        op: 'upsert_section',
        section: { id: 's_grid', type: 'content_grid', data: { source: { kind: 'manual', items: [] }, limit: 1 } },
      },
    ]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);
    assert.strictEqual(inverse.op, 'upsert_section');
  });

  it('inverts an inserting upsert to a remove', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [
      { op: 'upsert_section', section: { id: 's_faq', type: 'faq', data: { items: [] } } },
    ]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);
    assert.strictEqual(inverse.op, 'remove_section');
  });
});

describe('slug-rename auto-alias rule (C§2.3-taxonomy)', () => {
  it('renaming a slug mints a deprecated alias so old references still resolve', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const forward = apply(record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'infant-sleep' } },
    ]);
    const body = forward.record.body as ReturnType<typeof taxonomyBody>;
    const terms = body.kinds.category.terms;

    assert.strictEqual(terms.find((term) => term.term_id === 't_sleep')?.slug, 'infant-sleep');
    const alias = terms.find((term) => term.slug === 'sleep');
    assert.ok(alias, 'expected an alias entry carrying the old slug');
    assert.strictEqual(alias.status, 'deprecated');
    assert.strictEqual(alias.merged_into, 't_sleep');
    assert.strictEqual(alias.label, 'Sleep');
    assert.strictEqual(alias.term_id, 't_sleep2'); // deterministic mint ('t_sleep' is taken by the term itself)
    assert.strictEqual(forward.applied[0].body_mutated, true);
  });

  it('renaming back to a previously-owned slug consumes the alias instead of colliding', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const renamed = apply(record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'infant-sleep' } },
    ]);
    const intermediate = JSON.parse(JSON.stringify(renamed.record.body)) as unknown;

    const renamedBack = apply(renamed.record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'sleep' } },
    ]);
    const body = renamedBack.record.body as ReturnType<typeof taxonomyBody>;
    const terms = body.kinds.category.terms;
    assert.strictEqual(terms.find((term) => term.term_id === 't_sleep')?.slug, 'sleep');
    assert.strictEqual(terms.filter((term) => term.slug === 'sleep').length, 1, 'the old alias must be consumed');
    assert.ok(
      terms.some((term) => term.slug === 'infant-sleep' && term.status === 'deprecated'),
      'the vacated slug gets its own alias'
    );

    // The rename-back op is itself exactly invertible (restores the consumed alias verbatim).
    const inverse = derivePatchInverse(renamedBack.applied[0].op, renamedBack.applied[0].capture);
    const reverted = apply(renamedBack.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, intermediate);
  });

  it('a rename survives a double inverse (discard, then discard the discard)', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const renamed = apply(record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'infant-sleep' } },
    ]);
    const renamedBody = JSON.parse(JSON.stringify(renamed.record.body)) as unknown;

    const inverse = derivePatchInverse(renamed.applied[0].op, renamed.applied[0].capture);
    const reverted = apply(renamed.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, taxonomyBody());

    const inverseOfInverse = derivePatchInverse(reverted.applied[0].op, reverted.applied[0].capture);
    const reapplied = apply(reverted.record, [inverseOfInverse]);
    assert.deepStrictEqual(reapplied.record.body, renamedBody);
  });

  it('rejects add_term minting an active term with a merge target', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    assert.throws(
      () =>
        apply(record, [
          { op: 'add_term', kind: 'tag', term: { term_id: 't_x', slug: 'x', label: 'X', merged_into: 't_newborn' } },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
  });

  it('refuses an alias-less rename that is not a revert', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    assert.throws(
      () =>
        apply(record, [
          {
            op: 'update_term',
            kind: 'category',
            term_id: 't_sleep',
            fields: { slug: 'infant-sleep' },
            mint_alias: false,
          },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'alias_required'
    );
  });

  it('rejects alias controls when the slug does not actually change', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    assert.throws(
      () =>
        apply(record, [
          { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'sleep' }, mint_alias: false },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
  });

  it('rejects a minted alias id that collides', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    assert.throws(
      () =>
        apply(record, [
          {
            op: 'update_term',
            kind: 'category',
            term_id: 't_sleep',
            fields: { slug: 'infant-sleep' },
            alias_term_id: 't_feeding',
          },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'alias_conflict'
    );
  });
});

describe('blind-revert refusal (C§2.4 conflict rule)', () => {
  it('refuses a field inverse when the field moved on', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);

    const intervening = apply(forward.record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Even better' } },
    ]);
    assert.throws(
      () => apply(intervening.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses an element inverse when the removed element was re-added', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'remove_section', section_id: 's_grid' }]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);

    const intervening = apply(forward.record, [
      { op: 'upsert_section', section: { id: 's_grid', type: 'prose', data: { body: '<p>x</p>' } } },
    ]);
    assert.throws(
      () => apply(intervening.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses a move inverse when the section moved again', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'move_section', section_id: 's_bio', to_index: 0 }]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);

    const intervening = apply(forward.record, [{ op: 'move_section', section_id: 's_bio', to_index: 1 }]);
    assert.throws(
      () => apply(intervening.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses an inverse whose target unit is gone entirely', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'update_section_data', section_id: 's_grid', fields: { heading: 'X' } }]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);

    const intervening = apply(forward.record, [{ op: 'remove_section', section_id: 's_grid' }]);
    assert.throws(
      () => apply(intervening.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('applies the inverse when the draft still matches', () => {
    const record = makeRecord('page', pageBody());
    const forward = apply(record, [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }]);
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);
    const reverted = apply(forward.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, pageBody());
  });
});

describe('content_revision bumps iff an op mutates the body (D§3.1)', () => {
  it('a mutating op bumps version and content_revision', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }]);
    assert.strictEqual(result.record.version, record.version + 1);
    assert.strictEqual(result.record.content_revision, record.content_revision + 1);
    assert.strictEqual(result.body_mutated, true);
  });

  it('a no-op write bumps version and history but NOT content_revision', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'A calmer start' } },
    ]);
    assert.strictEqual(result.record.version, record.version + 1);
    assert.strictEqual(result.record.content_revision, record.content_revision);
    assert.strictEqual(result.record.history.length, 1);
    assert.strictEqual(result.applied[0].body_mutated, false);
    assert.strictEqual(result.body_mutated, false);
  });

  it('a move to the same index does not bump content_revision', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, [{ op: 'move_section', section_id: 's_hero', to_index: 0 }]);
    assert.strictEqual(result.record.version, record.version + 1);
    assert.strictEqual(result.record.content_revision, record.content_revision);
  });

  it('a mixed batch bumps content_revision only for the mutating ops', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }, // mutates
      { op: 'move_section', section_id: 's_hero', to_index: 0 }, // no-op
    ]);
    assert.strictEqual(result.record.version, record.version + 2);
    assert.strictEqual(result.record.content_revision, record.content_revision + 1);
  });

  it('an empty batch changes nothing', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, []);
    assert.strictEqual(result.record.version, record.version);
    assert.strictEqual(result.record.content_revision, record.content_revision);
    assert.strictEqual(result.record.updated_at, record.updated_at);
    assert.strictEqual(result.record.history.length, 0);
  });
});

describe('apply mechanics', () => {
  it('never mutates the input record and is atomic on failure', () => {
    const record = makeRecord('page', pageBody());
    const snapshot = JSON.parse(JSON.stringify(record)) as unknown;

    assert.throws(
      () =>
        apply(record, [
          { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }, // valid
          { op: 'remove_section', section_id: 's_missing' }, // fails
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'target_not_found'
    );
    assert.deepStrictEqual(JSON.parse(JSON.stringify(record)), snapshot);

    const success = apply(record, [{ op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Better' } }]);
    assert.notStrictEqual(success.record, record);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(record)), snapshot);
  });

  it('stamps updated_at and appends one attributed history entry per op', () => {
    const record = makeRecord('navigation', navBody());
    const result = apply(record, [
      { op: 'set_nav_meta', fields: { footNote: '<p>Updated.</p>' } },
      { op: 'move_group', group_id: 'g_social', to_index: 0 },
    ]);
    assert.strictEqual(result.record.updated_at, AT);
    assert.strictEqual(result.record.history.length, 2);
    assert.deepStrictEqual(
      result.record.history.map((entry) => entry.action),
      ['set_nav_meta', 'move_group']
    );
    for (const entry of result.record.history) {
      assert.strictEqual(entry.at, AT);
      assert.deepStrictEqual(entry.actor, AGENT);
      assert.ok(entry.details && 'op' in entry.details && 'capture' in entry.details);
    }
  });

  it('rejects ops for content_item (article surface is untouched, C§2.0)', () => {
    const record = makeRecord('content_item', { title: 'Article' });
    assert.throws(
      () => apply(record, [{ op: 'set_page_meta', fields: { title: 'X' } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
  });

  it('rejects an op from the wrong family', () => {
    const record = makeRecord('page', pageBody());
    assert.throws(
      () => apply(record, [{ op: 'add_term', kind: 'tag', term: { term_id: 't_x', slug: 'x', label: 'X' } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
  });

  it('rejects structural ops on a shared section wrapper', () => {
    const record = makeRecord('section', sharedSectionBody());
    assert.throws(
      () => apply(record, [{ op: 'remove_section', section_id: 's_signup' }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
  });

  it('refuses price/linkage writes through set_product_fields (the §3 canonicality funnel)', () => {
    const record = makeRecord('product', productBody());
    for (const fields of [
      { commerce: { price: { amount_cents: 100, currency: 'usd' } } },
      { commerce: { stripe: { product_id: 'prod_X1', price_id: 'price_X1' } } },
      { commerce: { stripe_test: { product_id: 'prod_T1' } } },
      { commerce: null }, // products always carry a commerce block
    ]) {
      assert.throws(
        () => apply(record, [{ op: 'set_product_fields', fields }]),
        (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op',
        JSON.stringify(fields)
      );
    }
    // …while sibling commerce fields stay patchable in the same op shape.
    const result = apply(record, [{ op: 'set_product_fields', fields: { commerce: { availability: 'retired' } } }]);
    assert.strictEqual((result.record.body as { commerce: { availability: string } }).commerce.availability, 'retired');
  });

  it('set_product_fields applies only to product objects', () => {
    assert.throws(
      () => apply(makeRecord('site', siteBody()), [{ op: 'set_product_fields', fields: { slug: 'x' } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
    assert.throws(
      () => apply(makeRecord('product', productBody()), [{ op: 'set_site_fields', fields: { name: 'X' } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
  });

  it('rejects unknown ops and malformed payloads', () => {
    const record = makeRecord('page', pageBody());
    for (const badOp of [
      { op: 'replace_body', body: {} },
      { op: 'set_page_meta', fields: { sections: [] } }, // sections only via section ops
      { op: 'update_item', group_id: 'g', item_id: 'i', fields: { id: 'i2' } }, // ids are stable
      { op: 'upsert_section', section: { id: 'not_a_section_id' } },
    ]) {
      assert.throws(
        () => apply(record, [badOp]),
        (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op',
        `expected invalid_op for ${JSON.stringify(badOp)}`
      );
    }
  });

  it('rejects duplicate add_term', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    assert.throws(
      () =>
        apply(record, [
          { op: 'add_term', kind: 'category', term: { term_id: 't_sleep', slug: 'sleep2', label: 'Sleep 2' } },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'duplicate_target'
    );
  });

  it('add_term defaults status to active (C§2.0)', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const result = apply(record, [
      { op: 'add_term', kind: 'tag', term: { term_id: 't_reflux', slug: 'reflux', label: 'Reflux' } },
    ]);
    const body = result.record.body as ReturnType<typeof taxonomyBody>;
    assert.strictEqual(body.kinds.tag.terms.find((term) => term.term_id === 't_reflux')?.status, 'active');
  });

  it('rejects an insert under a missing parent item', () => {
    const record = makeRecord('navigation', navBody());
    assert.throws(
      () =>
        apply(record, [
          {
            op: 'upsert_item',
            group_id: 'g_main',
            item: { id: 'i_x', label: 'X', target: { kind: 'route', href: '/x' } },
            parent_item_id: 'i_missing',
          },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'target_not_found'
    );
  });
});

describe('alias consume is guarded (C§2.4 applied to the minted alias)', () => {
  const renameThenInverse = () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const renamed = apply(record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'infant-sleep' } },
    ]);
    const inverse = derivePatchInverse(renamed.applied[0].op, renamed.applied[0].capture);
    return { renamed, inverse };
  };

  it('refuses the rename inverse when the minted alias was edited since', () => {
    const { renamed, inverse } = renameThenInverse();
    const tampered = apply(renamed.record, [
      { op: 'update_term', kind: 'category', term_id: 't_sleep2', fields: { label: 'Sleep (old name)' } },
    ]);
    assert.throws(
      () => apply(tampered.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses the rename inverse when the minted alias was removed since', () => {
    const { renamed, inverse } = renameThenInverse();
    const tampered = apply(renamed.record, [{ op: 'remove_term', kind: 'category', term_id: 't_sleep2' }]);
    assert.throws(
      () => apply(tampered.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('still applies the rename inverse across unrelated intervening edits', () => {
    const { renamed, inverse } = renameThenInverse();
    const unrelated = apply(renamed.record, [
      { op: 'add_term', kind: 'category', term: { term_id: 't_teething', slug: 'teething', label: 'Teething' } },
    ]);
    const reverted = apply(unrelated.record, [inverse]);
    const body = reverted.record.body as ReturnType<typeof taxonomyBody>;
    const terms = body.kinds.category.terms;
    assert.strictEqual(terms.find((term) => term.term_id === 't_sleep')?.slug, 'sleep');
    assert.ok(!terms.some((term) => term.slug === 'infant-sleep'), 'the minted alias must be consumed');
    assert.ok(
      terms.some((term) => term.term_id === 't_teething'),
      'the unrelated edit must survive'
    );
  });

  it('refuses a hand-written expectation-less revert when a consumable alias exists', () => {
    const { renamed } = renameThenInverse();
    assert.throws(
      () =>
        apply(renamed.record, [
          { op: 'update_term', kind: 'category', term_id: 't_sleep', fields: { slug: 'sleep' }, mint_alias: false },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });
});

describe('null handling: unset markers never reach the body', () => {
  const hasNullValue = (value: unknown): boolean => {
    if (value === null) return true;
    if (Array.isArray(value)) return value.some(hasNullValue);
    if (typeof value === 'object' && value !== null) return Object.values(value).some(hasNullValue);
    return false;
  };

  it('treats nested nulls as unsets when the parent is absent', () => {
    const bodyWithoutBrand = () => {
      const body = navBody() as Record<string, unknown>;
      delete body.brand;
      return body;
    };
    const record = makeRecord('navigation', bodyWithoutBrand());
    const result = apply(record, [{ op: 'set_nav_meta', fields: { brand: { text: null } } }]);
    const body = result.record.body as Record<string, unknown>;
    assert.deepStrictEqual(body.brand, {}, 'nested null must be treated as an unset, not stored');
    assert.strictEqual(hasNullValue(result.record.body), false);

    const inverse = derivePatchInverse(result.applied[0].op, result.applied[0].capture);
    const reverted = apply(result.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, bodyWithoutBrand());
  });

  it('normalizes deep replacement subtrees and round-trips exactly', () => {
    const record = makeRecord('page', pageBody());
    const result = apply(record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { config: { a: null, b: 'x', c: { d: null } } } },
    ]);
    const body = result.record.body as ReturnType<typeof pageBody>;
    const hero = body.sections.find((section) => section.id === 's_hero') as unknown as {
      data: Record<string, unknown>;
    };
    assert.deepStrictEqual(hero.data.config, { b: 'x', c: {} });
    assert.strictEqual(hasNullValue(result.record.body), false);

    const inverse = derivePatchInverse(result.applied[0].op, result.applied[0].capture);
    const reverted = apply(result.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, pageBody());
  });

  it('rejects null values inside element payloads', () => {
    const page = makeRecord('page', pageBody());
    assert.throws(
      () => apply(page, [{ op: 'upsert_section', section: { id: 's_x', type: 'prose', data: { body: null } } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
    const nav = makeRecord('navigation', navBody());
    assert.throws(
      () =>
        apply(nav, [
          {
            op: 'upsert_item',
            group_id: 'g_main',
            item: { id: 'i_x', label: 'X', target: { kind: 'route', href: '/x' }, description: null },
          },
        ]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
  });

  it('rejects null array elements in fields', () => {
    const record = makeRecord('page', pageBody());
    assert.throws(
      () => apply(record, [{ op: 'update_section_data', section_id: 's_bio', fields: { trustNotes: ['MD', null] } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'invalid_op'
    );
  });
});

describe('removal inverses pin the container order (C§2.4 applied to restores)', () => {
  const removeThenInverse = () => {
    const record = makeRecord('page', pageBody());
    const removed = apply(record, [{ op: 'remove_section', section_id: 's_grid' }]);
    const inverse = derivePatchInverse(removed.applied[0].op, removed.applied[0].capture);
    return { removed, inverse };
  };

  it('refuses the restore when the remaining sections were reordered since', () => {
    const { removed, inverse } = removeThenInverse();
    const reordered = apply(removed.record, [{ op: 'move_section', section_id: 's_bio', to_index: 0 }]);
    assert.throws(
      () => apply(reordered.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses the restore when a section was inserted since', () => {
    const { removed, inverse } = removeThenInverse();
    const grown = apply(removed.record, [
      { op: 'upsert_section', section: { id: 's_faq', type: 'faq', data: { items: [] } }, position: 0 },
    ]);
    assert.throws(
      () => apply(grown.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('still applies the restore across edits that do not touch the container order', () => {
    const { removed, inverse } = removeThenInverse();
    const edited = apply(removed.record, [
      { op: 'update_section_data', section_id: 's_hero', fields: { heading: 'Changed meanwhile' } },
    ]);
    const reverted = apply(edited.record, [inverse]);
    const body = reverted.record.body as ReturnType<typeof pageBody>;
    assert.deepStrictEqual(
      body.sections.map((section) => section.id),
      ['s_hero', 's_grid', 's_bio'],
      'the removed section must restore at its original position'
    );
    const hero = body.sections.find((section) => section.id === 's_hero') as unknown as {
      data: Record<string, unknown>;
    };
    assert.strictEqual(hero.data.heading, 'Changed meanwhile', 'the unrelated edit must survive');
  });

  it('refuses an item restore when its sibling order changed since', () => {
    const record = makeRecord('navigation', navBody());
    const removed = apply(record, [{ op: 'remove_item', group_id: 'g_main', item_id: 'i_sleep' }]);
    const inverse = derivePatchInverse(removed.applied[0].op, removed.applied[0].capture);
    const reordered = apply(removed.record, [
      {
        op: 'upsert_item',
        group_id: 'g_main',
        item: { id: 'i_naps', label: 'Naps', target: { kind: 'route', href: '/topics/naps' } },
        parent_item_id: 'i_learn',
        position: 0,
      },
    ]);
    assert.throws(
      () => apply(reordered.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });

  it('refuses a term restore when the registry gained a term since', () => {
    const record = makeRecord('taxonomy', taxonomyBody());
    const removed = apply(record, [{ op: 'remove_term', kind: 'category', term_id: 't_colic' }]);
    const inverse = derivePatchInverse(removed.applied[0].op, removed.applied[0].capture);
    const grown = apply(removed.record, [
      { op: 'add_term', kind: 'category', term: { term_id: 't_teething', slug: 'teething', label: 'Teething' } },
    ]);
    assert.throws(
      () => apply(grown.record, [inverse]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'blind_revert_refused'
    );
  });
});

describe('article node family mechanics (W7.3)', () => {
  it('set_article_meta refuses a nodes payload at the grammar (use the node ops)', () => {
    assert.throws(() => patchOpSchema.parse({ op: 'set_article_meta', fields: { nodes: [] } }));
  });

  it('update_node refuses id (node ids are stable)', () => {
    assert.throws(() => patchOpSchema.parse({ op: 'update_node', node_id: 'n_a1', fields: { id: 'n_zz' } }));
  });

  it('node ops are not applicable to other object types', () => {
    const record = makeRecord('page', pageBody());
    assert.throws(
      () => apply(record, [{ op: 'update_node', node_id: 'n_a1', fields: { public: { body: 'x' } } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'op_not_applicable'
    );
  });

  it('update_node on a missing node is target_not_found', () => {
    const record = makeRecord('content_item', articleBody());
    assert.throws(
      () => apply(record, [{ op: 'update_node', node_id: 'n_zz', fields: { public: { body: 'x' } } }]),
      (error: unknown) => error instanceof PatchApplyError && error.code === 'target_not_found'
    );
  });

  it('"mark this block a hook" is one op and inverts exactly', () => {
    const record = makeRecord('content_item', articleBody());
    const forward = apply(record, [
      { op: 'update_node', node_id: 'n_a2', fields: { private: { strategy: 'hook', intent: 'convert' } } },
    ]);
    const node = (forward.record.body as { nodes: Array<{ id: string; private?: Record<string, unknown> }> }).nodes[1];
    assert.deepStrictEqual(node.private, { strategy: 'hook', intent: 'convert' });
    const inverse = derivePatchInverse(forward.applied[0].op, forward.applied[0].capture);
    const reverted = apply(forward.record, [inverse]);
    assert.deepStrictEqual(reverted.record.body, articleBody());
  });
});
