/**
 * W2 T2.3 — the dry render-data check behind `validate_pdf_render_data`.
 *
 * The bar: it must agree with what W1 actually fails a real job on. Both
 * fixtures below are checked against the SAME `article_brochure_v1`
 * renderDataSchema the mapper targets and pdf-tool validates against, so a
 * pass here means something.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA } from './article-brochure-v1-render-data-schema.js';
import { buildRenderData } from './render-data-mapper.js';
import { checkRenderDataAgainstSchema, checkRenderDataAssets } from './render-data-schema-check.js';

const REQUEST = 'req_plugin_moisturizer_functions_20260903_01';
const SHA = 'a'.repeat(64);

const BRAND = {
  colors: { primary: 'rgb(46 111 149)' },
  fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
};

const VALID_DATA = {
  brand: BRAND,
  title: 'What moisturizers actually do',
  deck: 'Three basic jobs.',
  sections: [{ heading: 'Barrier', paragraphs: ['The stratum corneum holds water in.'] }],
  pullQuotes: [],
  sources: [],
};

test('valid render data passes, with no errors and no asset gaps', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, VALID_DATA);
  assert.deepEqual(check.errors, []);
  assert.equal(check.valid, true);
  assert.equal(check.authoritative, true, 'this schema uses no keyword outside the implemented subset');
  assert.deepEqual(checkRenderDataAssets(check.assetRefs, { images: [] }).missingAssetIds, []);
});

test('a missing required slot is an ajv-shaped error naming the property', () => {
  const { sections: _dropped, ...withoutSections } = VALID_DATA;
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, withoutSections);
  assert.equal(check.valid, false);
  const error = check.errors.find((entry) => entry.keyword === 'required' && entry.message.includes('sections'));
  assert.ok(error, JSON.stringify(check.errors));
  assert.equal(error!.instancePath, '');
  assert.equal(error!.schemaPath, '#/required');
});

test('the JSON pointer points at the offending value, not at the whole document', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, {
    ...VALID_DATA,
    sections: [{ heading: 'Barrier', paragraphs: [42] }],
  });
  assert.equal(check.valid, false);
  assert.equal(check.errors[0]?.instancePath, '/sections/0/paragraphs/0');
  assert.equal(check.errors[0]?.message, 'must be string');
});

test('an unknown slot is caught the way an additionalProperties:false render would fail', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, {
    ...VALID_DATA,
    strategy: 'hook',
  });
  assert.equal(check.valid, false);
  assert.ok(check.errors.some((entry) => entry.keyword === 'additionalProperties' && entry.message.includes('strategy')));
});

test('an over-long string is caught before the render is spent, not after', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, {
    ...VALID_DATA,
    title: 'x'.repeat(400),
  });
  assert.equal(check.valid, false);
  const error = check.errors.find((entry) => entry.keyword === 'maxLength');
  assert.equal(error?.instancePath, '/title');
});

test('the assetId pattern is enforced — a slashed blobKey in a data slot is exactly the 2026-09-03 defect', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, {
    ...VALID_DATA,
    coverImage: `/img/${REQUEST}/${SHA}.webp`,
  });
  assert.equal(check.valid, false);
  const error = check.errors.find((entry) => entry.keyword === 'pattern');
  assert.equal(error?.instancePath, '/coverImage');
});

test('asset ids named by data are collected, and a missing one is reported (W1 ASSET_MISSING, pre-flight)', () => {
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, {
    ...VALID_DATA,
    coverImage: 'cover',
    sections: [{ heading: 'Barrier', paragraphs: ['copy'], figure: { assetId: 'figure-1', caption: 'x' } }],
  });
  assert.equal(check.valid, true);
  assert.deepEqual(
    check.assetRefs.map((ref) => ref.instancePath).sort(),
    ['/coverImage', '/sections/0/figure/assetId']
  );

  const supplied = checkRenderDataAssets(check.assetRefs, {
    images: [{ assetId: 'cover', blobKey: `image/${REQUEST}/${SHA}.webp` }, { assetId: 'stray', blobKey: 'x' }],
  });
  assert.deepEqual(supplied.missingAssetIds, ['figure-1']);
  assert.deepEqual(supplied.unusedAssetIds, ['stray']);
  assert.deepEqual(supplied.referencedAssetIds, ['cover', 'figure-1']);

  // No assets at all: every referenced id is missing, which is the truth.
  assert.deepEqual(checkRenderDataAssets(check.assetRefs, undefined).missingAssetIds, ['cover', 'figure-1']);
});

test('a schema using a keyword this pre-flight does not implement says so instead of passing', () => {
  const check = checkRenderDataAgainstSchema(
    { type: 'object', properties: { n: { type: 'number', multipleOf: 2 } } },
    { n: 3 }
  );
  assert.equal(check.authoritative, false);
  assert.ok(check.errors.some((entry) => entry.keyword === 'unsupportedKeyword' && entry.message.includes('multipleOf')));
});

test('a template with no usable schema is reported, never silently passed', () => {
  const check = checkRenderDataAgainstSchema(undefined, VALID_DATA);
  assert.equal(check.valid, false);
  assert.equal(check.authoritative, false);
  assert.match(check.errors[0]!.message, /no usable renderDataSchema/);
});

test('what the REAL mapper produces passes this check — the two agree', () => {
  const article = {
    publication: { published_time: '2026-09-03T17:32:01.774Z' },
    body: {
      title: 'What Moisturizers Actually Do',
      deck: 'Three basic jobs.',
      author: 'Dr. Lurie',
      image: { src: `/img/${REQUEST}/${SHA}.webp` },
      nodes: [
        {
          id: 'n_a',
          kind: 'content',
          visibility: 'public',
          public: { title: 'Barrier', body: 'The stratum corneum holds water in.' },
        },
      ],
      sources: { source_list: [{ name: 'Moisturization and Skin Barrier Function' }] },
    },
  };
  const mapped = buildRenderData(article, {
    templateSchema: ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    brand: BRAND,
  });
  const check = checkRenderDataAgainstSchema(ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA, mapped.data);
  assert.deepEqual(check.errors, [], JSON.stringify(check.errors));

  // …and the assets the mapper emitted cover every id it put in the data.
  const assets = checkRenderDataAssets(check.assetRefs, mapped.assets);
  assert.deepEqual(assets.missingAssetIds, []);
  assert.deepEqual(assets.unusedAssetIds, []);
});
