import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA } from './article-brochure-v1-render-data-schema.js';
import {
  PdfRenderDataMapperUnavailableError,
  defaultPdfRenderDataMapper,
  resolvePdfJobRenderData,
  type PdfRenderDataMapper,
} from './pdf-render-data-mapper-seam.js';

const CONTENT_ITEM = { slug: 'what-moisturizers-actually-do', title: 'What moisturizers actually do' };

test('resolvePdfJobRenderData returns the fake mapper output on success', async () => {
  const fakeMapper: PdfRenderDataMapper = async (input) => {
    assert.deepEqual(input.contentItem, CONTENT_ITEM);
    assert.equal(input.templateId, 'tpl_article_v1');
    return { ok: true, data: { title: 'What moisturizers actually do', sections: [] } };
  };

  const result = await resolvePdfJobRenderData({
    contentItem: CONTENT_ITEM,
    templateId: 'tpl_article_v1',
    getMapper: async () => fakeMapper,
  });

  assert.deepEqual(result, { ok: true, data: { title: 'What moisturizers actually do', sections: [] } });
});

test('resolvePdfJobRenderData carries the mapper-supplied assets through on success', async () => {
  const fakeMapper: PdfRenderDataMapper = async () => ({
    ok: true,
    data: { title: 'x' },
    assets: { images: [{ assetId: 'hero', blobKey: 'image/req_x/abc.webp' }] },
  });

  const result = await resolvePdfJobRenderData({
    contentItem: CONTENT_ITEM,
    templateId: 'tpl_article_v1',
    getMapper: async () => fakeMapper,
  });

  assert.deepEqual(result, {
    ok: true,
    data: { title: 'x' },
    assets: { images: [{ assetId: 'hero', blobKey: 'image/req_x/abc.webp' }] },
  });
});

test('resolvePdfJobRenderData surfaces the mapper\'s own deterministic refusal', async () => {
  const fakeMapper: PdfRenderDataMapper = async () => ({
    ok: false,
    error: 'Cannot fill required slot: sections',
    errorCode: 'artifact_render_data_unfilled:sections',
  });

  const result = await resolvePdfJobRenderData({
    contentItem: CONTENT_ITEM,
    templateId: 'tpl_article_v1',
    getMapper: async () => fakeMapper,
  });

  assert.deepEqual(result, {
    ok: false,
    reason: 'mapper_refused',
    error: 'Cannot fill required slot: sections',
    errorCode: 'artifact_render_data_unfilled:sections',
  });
});

test('resolvePdfJobRenderData turns an unavailable mapper into a typed result, never a crash', async () => {
  const result = await resolvePdfJobRenderData({
    contentItem: CONTENT_ITEM,
    templateId: 'tpl_article_v1',
    getMapper: async () => {
      throw new PdfRenderDataMapperUnavailableError('render-data-mapper.ts is not present in this build (T2.1).');
    },
  });

  assert.equal(result.ok, false);
  assert.equal((result as { reason: string }).reason, 'mapper_unavailable');
  assert.match((result as { detail: string }).detail, /T2\.1/);
});

test('resolvePdfJobRenderData lets an unexpected getMapper error propagate rather than swallowing it', async () => {
  await assert.rejects(
    () =>
      resolvePdfJobRenderData({
        contentItem: CONTENT_ITEM,
        templateId: 'tpl_article_v1',
        getMapper: async () => {
          throw new Error('unrelated infrastructure failure');
        },
      }),
    /unrelated infrastructure failure/
  );
});

test('resolvePdfJobRenderData lets an unexpected mapper-call error propagate rather than swallowing it', async () => {
  const throwingMapper: PdfRenderDataMapper = async () => {
    throw new Error('mapper crashed');
  };
  await assert.rejects(
    () =>
      resolvePdfJobRenderData({
        contentItem: CONTENT_ITEM,
        templateId: 'tpl_article_v1',
        getMapper: async () => throwingMapper,
      }),
    /mapper crashed/
  );
});

// ── Join A: the REAL mapper through the REAL seam ────────────────────────────
//
// T2.2 wrote this seam against a mapper that did not exist; T2.1 landed a
// mapper with a different name and a different signature; nothing checked that
// the two met, and they did not — D-2 fell through to "mapper unavailable" on
// every call and no article was ever mapped. These tests are the join, proven:
// no fake mapper anywhere below, only `defaultPdfRenderDataMapper` (which is
// `buildRenderData`) driven through `resolvePdfJobRenderData`.

const JOIN_REQUEST = 'req_plugin_moisturizer_functions_20260903_01';
const JOIN_SHA_HERO = 'a'.repeat(64);
const JOIN_SHA_FIGURE = 'b'.repeat(64);

const JOIN_ARTICLE = {
  object_id: JOIN_REQUEST,
  object_type: 'content_item',
  site: 'site_drlurie',
  updated_at: '2026-09-03T18:32:03.000Z',
  publication: { published_time: '2026-09-03T17:32:01.774Z' },
  body: {
    slug: 'what-moisturizers-actually-do',
    title: 'What Moisturizers Actually Do',
    deck: 'Most moisturizers perform three basic jobs.',
    author: 'Dr. Lurie',
    taxonomy: { category: 'Skin Science' },
    image: { src: `/img/${JOIN_REQUEST}/${JOIN_SHA_HERO}.webp`, alt: 'Moisturizer textures.' },
    nodes: [
      {
        id: 'n_a7k2m9',
        kind: 'content',
        visibility: 'public',
        public: { body: 'The moisturizer shelf can make a basic step feel like a specialist subject.' },
        private: { strategy: 'hook' },
      },
      {
        id: 'n_b4r8q1',
        kind: 'content',
        visibility: 'public',
        public: {
          title: 'Start with the skin barrier',
          body: 'The outermost layer of your skin is called the stratum corneum.',
          media: {
            type: 'image',
            src: `/img/${JOIN_REQUEST}/${JOIN_SHA_FIGURE}.webp`,
            caption: 'Moisturizers work at the surface.',
          },
        },
      },
      { id: 'n_k1q6d8', kind: 'action', visibility: 'public', public: { ctaText: 'Book a consultation' } },
    ],
    sources: {
      source_list: [
        { source_id: 's1', name: 'Moisturization and Skin Barrier Function', publisher: 'Dermatologic Therapy' },
      ],
    },
  },
};

const JOIN_BRAND = {
  colors: { primary: 'rgb(46 111 149)' },
  fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
};

test('JOIN A: the real render-data mapper, through the real seam, actually maps an article', async () => {
  const result = await resolvePdfJobRenderData({
    contentItem: JOIN_ARTICLE,
    templateId: 'article_brochure_v1',
    templateSchema: ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    brand: JOIN_BRAND,
    // No fake: this is the module the bridge itself uses.
    getMapper: async () => defaultPdfRenderDataMapper,
  });

  assert.equal(result.ok, true, 'the seam must not fall through to mapper_unavailable any more');
  if (!result.ok) return;

  // Real mapped data, not an empty shell.
  assert.equal(result.data.title, 'What Moisturizers Actually Do');
  assert.equal(result.data.deck, 'Most moisturizers perform three basic jobs.');
  assert.equal(result.data.author, 'Dr. Lurie');
  assert.equal(result.data.kicker, 'Skin Science');
  assert.equal(result.data.date, '3 September 2026');

  const sections = result.data.sections as { heading: string; paragraphs: string[]; figure?: { assetId: string } }[];
  assert.equal(sections.length, 2);
  assert.equal(sections[0]!.heading, 'What Moisturizers Actually Do', 'the lede is headed by the article title');
  assert.equal(sections[1]!.heading, 'Start with the skin barrier');

  // The whole point of the mapper: /img/… paths become {assetId, blobKey}
  // job assets, and the DATA slot carries the bare id.
  const images = result.assets?.images as { assetId: string; blobKey: string }[];
  assert.equal(images.length, 2, 'the hero and the section figure both became job assets');
  assert.match(String(result.data.coverImage), /^[a-zA-Z0-9._-]{1,128}$/);
  assert.ok(!String(result.data.coverImage).includes('/'), 'a data slot never carries a path');
  assert.equal(images[0]!.assetId, result.data.coverImage);
  assert.equal(images[0]!.blobKey, `image/${JOIN_REQUEST}/${JOIN_SHA_HERO}.webp`);
  assert.equal(images[1]!.assetId, sections[1]!.figure?.assetId);

  // The leak rule: nothing from the annotation layer reached `data`.
  assert.equal(JSON.stringify(result.data).includes('hook'), false);
});

test('JOIN A: the brand the bridge resolved reaches the mapper and stops the false missing:brand', async () => {
  const withBrand = await resolvePdfJobRenderData({
    contentItem: JOIN_ARTICLE,
    templateId: 'article_brochure_v1',
    templateSchema: ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    brand: JOIN_BRAND,
    getMapper: async () => defaultPdfRenderDataMapper,
  });
  assert.equal(withBrand.ok, true);
  if (!withBrand.ok) return;
  assert.deepEqual(withBrand.data.brand, JOIN_BRAND, 'passed through verbatim, never rebuilt');
  assert.equal(withBrand.unfilled?.includes('missing:brand'), false);

  const withoutBrand = await resolvePdfJobRenderData({
    contentItem: JOIN_ARTICLE,
    templateId: 'article_brochure_v1',
    templateSchema: ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    getMapper: async () => defaultPdfRenderDataMapper,
  });
  assert.equal(withoutBrand.ok, true);
  if (!withoutBrand.ok) return;
  assert.equal(withoutBrand.data.brand, undefined);
  assert.equal(withoutBrand.unfilled?.includes('missing:brand'), true);
});

test("JOIN A: the template's own renderDataSchema reaches the mapper and binds its limits", async () => {
  // A real template can declare tighter limits than article_brochure_v1's.
  // Before this join the schema never left the bridge, so every article was
  // mapped against the generic contract and a long one failed
  // RENDER_DATA_INVALID at job creation instead of being fitted here.
  const tightSchema = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'sections'],
    properties: {
      title: { type: 'string', maxLength: 12 },
      sections: {
        type: 'array',
        maxItems: 1,
        items: {
          type: 'object',
          properties: { heading: { type: 'string' }, paragraphs: { type: 'array', items: { type: 'string' } } },
        },
      },
    },
  };

  const result = await resolvePdfJobRenderData({
    contentItem: JOIN_ARTICLE,
    templateId: 'tpl_tight',
    templateSchema: tightSchema,
    brand: JOIN_BRAND,
    getMapper: async () => defaultPdfRenderDataMapper,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal((result.data.title as string).length <= 12, true, "cut to the TEMPLATE's maxLength");
  assert.equal((result.data.sections as unknown[]).length, 1, "capped at the TEMPLATE's maxItems");
  // Slots this template does not declare are dropped, and SAID, rather than
  // emitted into an additionalProperties:false schema that would reject the
  // whole render.
  assert.equal(result.data.deck, undefined);
  assert.equal(result.unfilled?.includes('unsupported_slot:deck'), true);
  assert.equal(result.unfilled?.includes('unsupported_slot:brand'), true);
  assert.equal(result.unfilled?.includes('truncated:title'), true);
  assert.equal(result.unfilled?.includes('dropped_section:1'), true);
});

test('JOIN A: unfilled[] survives the seam so the bridge can surface it', async () => {
  const bare = { body: { title: 'Bare', nodes: [] } };
  const result = await resolvePdfJobRenderData({
    contentItem: bare,
    templateId: 'article_brochure_v1',
    templateSchema: ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    getMapper: async () => defaultPdfRenderDataMapper,
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  for (const code of ['missing:coverImage', 'missing:sections', 'missing:sources', 'missing:deck']) {
    assert.equal(result.unfilled?.includes(code), true, `expected ${code} in unfilled[]`);
  }
  // No tenant data ever rides in unfilled[] (BRIEF §1).
  for (const entry of result.unfilled ?? []) {
    assert.equal(/[0-9a-f]{64}/.test(entry), false, `unfilled entry leaked a sha: ${entry}`);
    assert.equal(entry.startsWith('/'), false, `unfilled entry leaked a path: ${entry}`);
  }
});
