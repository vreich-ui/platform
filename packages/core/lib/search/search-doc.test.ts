import assert from 'node:assert/strict';
import test from 'node:test';

import { projectSearchDoc } from './search-doc.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

const record = (overrides: Record<string, unknown>): ObjectRecord =>
  ({
    object_id: 'req_nac_skin_20260901_01',
    object_type: 'content_item',
    schema_version: 'content_item.v1',
    site: 'site_drlurie',
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    status: 'active',
    publication: { published_time: '2026-09-01T06:00:00.000Z' },
    history: [],
    version: 1,
    content_revision: 1,
    ...overrides,
  }) as unknown as ObjectRecord;

test('an article projects its slug, route, SEO fields, taxonomy and request id', () => {
  const doc = projectSearchDoc(
    record({
      body: {
        slug: 'nac-for-skin-health',
        title: 'NAC for Skin Health',
        description: 'What N-acetylcysteine does.',
        seo: { meta_title: 'NAC for skin', meta_description: 'Glutathione and the barrier.' },
        taxonomy: { category: 'ingredients', tags: ['nac', 'glutathione'] },
        nodes: [],
      },
    })
  );

  assert.equal(doc.slug, 'nac-for-skin-health');
  // A content_item owns no route field — its public path is derived from the slug.
  assert.equal(doc.route, '/nac-for-skin-health');
  assert.equal(doc.title, 'NAC for Skin Health');
  assert.equal(doc.seo_title, 'NAC for skin');
  assert.equal(doc.seo_description, 'Glutathione and the barrier.');
  assert.equal(doc.category, 'ingredients');
  assert.deepEqual(doc.tags, ['nac', 'glutathione']);
  assert.equal(doc.published, true);
  // content_item ids ARE request ids by construction.
  assert.equal(doc.request_id, 'req_nac_skin_20260901_01');
});

test('headings come from node titles and rich-text heading blocks, not from body prose', () => {
  const doc = projectSearchDoc(
    record({
      body: {
        slug: 'barrier-myths',
        title: 'Five barrier myths',
        nodes: [
          { id: 'n_a1', kind: 'content', public: { eyebrow: 'Myth 1', title: 'The myth', body: 'Everyone repeats it.' } },
          {
            id: 'n_a2',
            kind: 'content',
            public: {
              body: {
                nodeType: 'document',
                data: {},
                content: [
                  {
                    nodeType: 'heading-2',
                    data: {},
                    content: [{ nodeType: 'text', value: 'Ceramides in context', marks: [], data: {} }],
                  },
                  {
                    nodeType: 'paragraph',
                    data: {},
                    content: [{ nodeType: 'text', value: 'Prose that must not be indexed.', marks: [], data: {} }],
                  },
                ],
              },
            },
          },
        ],
      },
    })
  );

  assert.deepEqual(doc.headings, ['Myth 1', 'The myth', 'Ceramides in context']);
  assert.ok(!doc.headings.some((heading) => heading.includes('must not be indexed')));
});

test('a page projects its own route and derives a slug from the last segment', () => {
  const doc = projectSearchDoc(
    record({
      object_id: 'page_about',
      object_type: 'page',
      schema_version: 'page.v1',
      publication: { published_time: null },
      body: {
        route: '/About/',
        pageType: 'standard',
        title: 'About Dr. Lurié',
        // page nests SEO under camelCase where content_item uses snake_case.
        seo: { title: 'About', description: 'Who we are.' },
        sections: [],
      },
    })
  );

  assert.equal(doc.route, '/about');
  assert.equal(doc.slug, 'about');
  assert.equal(doc.seo_title, 'About');
  assert.equal(doc.seo_description, 'Who we are.');
  assert.equal(doc.published, false);
  assert.equal(doc.request_id, null, 'a page id is not a request id');
});

test('a canonical URL is folded in as an alias, so a re-slugged article still resolves', () => {
  const doc = projectSearchDoc(
    record({
      body: {
        slug: 'nac-for-skin-health',
        title: 'NAC for Skin Health',
        seo: { canonical_url: 'https://drluriescience.netlify.app/nac-and-glutathione' },
        nodes: [],
      },
    })
  );
  assert.deepEqual(doc.aliases, ['nac-and-glutathione']);
});

test('an unrecognized body degrades to a thin document rather than throwing', () => {
  assert.doesNotThrow(() => {
    const doc = projectSearchDoc(record({ object_type: 'theme', body: { tokens: { color: {} } } }));
    assert.equal(doc.slug, null);
    assert.equal(doc.title, null);
    assert.deepEqual(doc.headings, []);
  });
});
