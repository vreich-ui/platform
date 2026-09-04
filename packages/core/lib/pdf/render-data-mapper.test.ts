import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
  ARTICLE_BROCHURE_V1_TEMPLATE_ID,
} from './article-brochure-v1-render-data-schema.js';
import { artifactBlobKeyForImageSrc, buildRenderData, formatRenderDate } from './render-data-mapper.js';

// ── a real JSON-Schema check, not an eyeball ────────────────────────────────
//
// The acceptance bar for this module is that its output SATISFIES
// article_brochure_v1's renderDataSchema — the same schema W1's
// RENDER_DATA_INVALID validates a job against. Asserting field-by-field would
// re-state the mapper's own opinion; this walks the schema instead. The
// keyword subset is exactly what that schema uses (type, required,
// properties, additionalProperties, items, min/maxItems, min/maxLength,
// pattern, minProperties, $ref into $defs) — an unknown keyword is a loud
// failure here rather than a silent pass, so the check cannot quietly weaken.
const KNOWN_KEYWORDS = new Set([
  '$schema',
  '$id',
  '$ref',
  '$defs',
  'title',
  'type',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minProperties',
  'pattern',
]);

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const validate = (root: Json, schema: unknown, value: unknown, path: string, errors: string[]): void => {
  if (!isObject(schema)) return;
  for (const keyword of Object.keys(schema)) {
    assert.ok(KNOWN_KEYWORDS.has(keyword), `test validator does not implement schema keyword '${keyword}'`);
  }

  const ref = schema.$ref;
  if (typeof ref === 'string') {
    assert.ok(ref.startsWith('#/$defs/'), `test validator only resolves #/$defs refs, got ${ref}`);
    const defs = root.$defs as Json;
    validate(root, defs[ref.slice('#/$defs/'.length)], value, path, errors);
    return;
  }

  const type = schema.type;
  if (type === 'object' && !isObject(value)) return void errors.push(`${path}: expected object`);
  if (type === 'array' && !Array.isArray(value)) return void errors.push(`${path}: expected array`);
  if (type === 'string' && typeof value !== 'string') return void errors.push(`${path}: expected string`);

  if (type === 'string' && typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${path}: longer than maxLength ${schema.maxLength} (${value.length})`);
    }
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${path}: "${value}" does not match ${schema.pattern}`);
    }
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${path}: fewer than minItems ${schema.minItems}`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${path}: more than maxItems ${schema.maxItems}`);
    }
    value.forEach((entry, index) => validate(root, schema.items, entry, `${path}[${index}]`, errors));
  }

  if (isObject(value)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    for (const name of Array.isArray(schema.required) ? (schema.required as string[]) : []) {
      if (!(name in value)) errors.push(`${path}: missing required '${name}'`);
    }
    if (typeof schema.minProperties === 'number' && Object.keys(value).length < schema.minProperties) {
      errors.push(`${path}: fewer than minProperties ${schema.minProperties}`);
    }
    for (const [name, entry] of Object.entries(value)) {
      if (name in properties) {
        validate(root, properties[name], entry, `${path}.${name}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push(`${path}: additional property '${name}' is not allowed`);
        continue;
      }
      if (isObject(schema.additionalProperties)) {
        validate(root, schema.additionalProperties, entry, `${path}.${name}`, errors);
      }
    }
  }
};

const schemaErrors = (data: unknown): string[] => {
  const errors: string[] = [];
  validate(
    ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA as Json,
    ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    data,
    'data',
    errors
  );
  return errors;
};

const assertValid = (data: unknown): void => {
  const errors = schemaErrors(data);
  assert.deepEqual(
    errors,
    [],
    `render data must satisfy article_brochure_v1's renderDataSchema:\n${errors.join('\n')}`
  );
};

// A brand exactly as pdf-render-brand.ts builds one. The mapper never makes
// one; every test that wants schema-valid output passes this in, which is
// what the bridge does at job creation.
const BRAND = {
  colors: { primary: 'rgb(46 111 149)', accent: 'rgb(94 140 138)' },
  fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
};

const REQUEST = 'req_plugin_moisturizer_functions_20260903_01';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const img = (sha: string) => `/img/${REQUEST}/${sha}.webp`;

const paragraph = (value: string) => ({
  nodeType: 'paragraph',
  data: {},
  content: [{ nodeType: 'text', value, marks: [], data: {} }],
});

/**
 * A realistic multi-node article: the shape the drlurie "What moisturizers
 * actually do" content_item actually has (an untitled lede, titled prose
 * nodes, TWO media-only nodes carrying nothing but an image, an `action` CTA
 * node at the end), carrying a full annotation layer so the leak rule has
 * something real to be tested against.
 */
const ARTICLE_RECORD = {
  object_id: REQUEST,
  object_type: 'content_item',
  site: 'site_drlurie',
  created_at: '2026-09-01T09:00:00.000Z',
  updated_at: '2026-09-03T18:32:03.000Z',
  publication: { published_time: '2026-09-03T17:32:01.774Z' },
  body: {
    slug: 'what-moisturizers-actually-do',
    title: 'What Moisturizers Actually Do: Humectants, Emollients, and Occlusives',
    deck: 'Most moisturizers perform three basic jobs. Understanding them makes it easier to choose a formula.',
    description: 'A clear guide to humectants, emollients, and occlusives.',
    author: 'Dr. Lurie',
    image: { src: img(SHA_A), alt: 'Moisturizer textures beside a model of the outer skin barrier.' },
    taxonomy: { category: 'Skin Science', tags: ['barrier', 'moisturizer'] },
    seo: { meta_title: 'What moisturizers do', meta_description: 'A clear guide.' },
    editorial: { writer_notes: 'Keep the agitation beat short.', framework: 'problem_agitation_resolution' },
    emotional_strategy: { overall_texture_assessment: 'Calm, unhurried, clinical.' },
    scores: [{ scored_by: 'judge', at: '2026-09-03T10:00:00.000Z', framework: 'dtc', dimension: 'hook', score: 0.8 }],
    claims: { claim_list: [{ claim_id: 'c1', text: 'Ceramides occur naturally in the barrier.', risk: 'low' }] },
    nodes: [
      {
        id: 'n_a7k2m9',
        kind: 'content',
        visibility: 'public',
        public: {
          body: 'The moisturizer shelf can make a basic step feel like a specialist subject.\n\nUnderneath those labels, most moisturizers perform one or more of three jobs.',
        },
        private: { strategy: 'hook', intent: 'establish the everyday problem', agentNotes: 'open cold' },
      },
      {
        id: 'n_b4r8q1',
        kind: 'content',
        visibility: 'public',
        public: {
          title: 'Start with the skin barrier',
          body: 'The outermost layer of your skin is called the stratum corneum.\n\nThis structure helps keep water in and irritants out.',
        },
        private: { strategy: 'agitation' },
      },
      {
        id: 'n_m8f2r6',
        kind: 'content',
        visibility: 'public',
        rendering: { emphasis: 'medium', placement: 'section', presentation: 'section' },
        public: {
          media: {
            type: 'image',
            src: img(SHA_B),
            contentType: 'image/webp',
            sizeBytes: 34082,
            alt: 'Cross-section of the outer skin layer.',
            caption: 'Moisturizers work at the surface, helping the outer layer hold water.',
          },
        },
      },
      {
        id: 'n_c6t3v8',
        kind: 'content',
        visibility: 'public',
        public: {
          title: 'Humectants help the outer layer hold water',
          body: 'Humectants bind water within the outer layer of the skin.\n\nThey often appear in light lotions and gels.',
        },
      },
      {
        id: 'n_k1q6d8',
        kind: 'action',
        visibility: 'public',
        public: {
          title: 'Book a barrier consultation',
          body: 'Bring your current routine.',
          ctaText: 'Book a consultation',
          ctaLink: '/consultations',
          media: { type: 'image', src: img(SHA_C) },
        },
        commercial: { disclosure: { required: true, label: 'Sponsored' }, rel: 'nofollow sponsored' },
      },
      {
        id: 'n_z9x1c2',
        kind: 'content',
        visibility: 'internal',
        public: { title: 'Internal note', body: 'Not for readers.' },
        private: { strategy: 'resolution' },
      },
    ],
    sources: {
      source_list: [
        {
          source_id: 'src_loden_2003',
          name: 'Role of Topical Emollients and Moisturizers in the Treatment of Dry Skin Barrier Disorders',
          url: 'https://doi.org/10.2165/00128071-200304110-00005',
          publisher: 'American Journal of Clinical Dermatology',
          accessed_at: '2026-09-03',
        },
        {
          source_id: 'src_rawlings_harding_2004',
          name: 'Moisturization and Skin Barrier Function',
          url: 'https://doi.org/10.1111/j.1396-0296.2004.04s1005.x',
          publisher: 'Dermatologic Therapy',
          accessed_at: '2026-09-03',
        },
      ],
    },
  },
};

test('a realistic multi-node article maps to data that satisfies article_brochure_v1 renderDataSchema', () => {
  const { data } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assertValid(data);

  assert.equal(data.title, 'What Moisturizers Actually Do: Humectants, Emollients, and Occlusives');
  assert.equal(
    data.deck,
    'Most moisturizers perform three basic jobs. Understanding them makes it easier to choose a formula.'
  );
  assert.equal(data.author, 'Dr. Lurie');
  assert.equal(data.kicker, 'Skin Science');
  assert.deepEqual(
    data.sections.map((section) => section.heading),
    [
      'What Moisturizers Actually Do: Humectants, Emollients, and Occlusives',
      'Start with the skin barrier',
      'Humectants help the outer layer hold water',
    ]
  );
  assert.deepEqual(data.sources, [
    {
      label: 'Role of Topical Emollients and Moisturizers in the Treatment of Dry Skin Barrier Disorders',
      url: 'https://doi.org/10.2165/00128071-200304110-00005',
      note: 'American Journal of Clinical Dermatology',
    },
    {
      label: 'Moisturization and Skin Barrier Function',
      url: 'https://doi.org/10.1111/j.1396-0296.2004.04s1005.x',
      note: 'Dermatologic Therapy',
    },
  ]);
});

test('the untitled lede is headed by the article title and a media-only node figures the section it follows', () => {
  const { data } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  // n_m8f2r6 carries nothing but an image. On the page it renders in flow
  // after "Start with the skin barrier"; in the PDF it must become that
  // section's figure, not vanish.
  const barrier = data.sections[1];
  assert.equal(barrier.heading, 'Start with the skin barrier');
  assert.equal(barrier.figure?.assetId, 'figure-n_m8f2r6');
  assert.equal(barrier.figure?.caption, 'Moisturizers work at the surface, helping the outer layer hold water.');
  assert.equal(data.sections[0].paragraphs.length, 2);
});

test('every /img artifact src becomes an assets.images entry and the data slot holds the BARE id', () => {
  const { data, assets } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });

  assert.deepEqual(assets.images, [
    { assetId: 'cover', blobKey: `image/${REQUEST}/${SHA_A}.webp` },
    { assetId: 'figure-n_m8f2r6', blobKey: `image/${REQUEST}/${SHA_B}.webp` },
  ]);
  assert.equal(data.coverImage, 'cover');

  // The whole defect in one assertion: nothing reachable in `data` is a path.
  const bareIdPattern = /^[a-zA-Z0-9._-]{1,128}$/;
  const ids = [data.coverImage, ...data.sections.map((section) => section.figure?.assetId)].filter(
    (id): id is string => typeof id === 'string'
  );
  assert.equal(ids.length, 2);
  for (const id of ids) {
    assert.ok(bareIdPattern.test(id), `${id} must be a bare asset id`);
    assert.ok(!id.includes('/'), `${id} must not be a path`);
  }
  assert.ok(!JSON.stringify(data).includes('/img/'), 'no site-relative image path may survive into data');
  assert.ok(!JSON.stringify(data).includes('image/'), 'no blobKey may survive into data');
});

test('only assets the data actually names travel with the job', () => {
  // n_orph01 opens a section of its own (it has a title) but carries no
  // prose, so no section can be emitted for it; the section before it already
  // has a figure, so its image has nowhere to go. It must not ride along as an
  // orphan asset either.
  const { data, assets, unfilled } = buildRenderData(
    {
      body: {
        title: 'An image with nowhere to go',
        deck: 'It is reported, and it does not ship.',
        nodes: [
          {
            id: 'n_prose1',
            kind: 'content',
            public: { title: 'A section', body: 'Body text.', media: { type: 'image', src: img(SHA_A) } },
          },
          {
            id: 'n_orph01',
            kind: 'content',
            public: { title: 'A heading with no prose', media: { type: 'image', src: img(SHA_B) } },
          },
        ],
      },
    },
    { brand: BRAND }
  );
  assert.deepEqual(assets.images, [{ assetId: 'figure-n_prose1', blobKey: `image/${REQUEST}/${SHA_A}.webp` }]);
  assert.equal(data.sections.length, 1);
  assert.ok(unfilled.includes('dropped_figure:n_orph01'));
  assert.ok(unfilled.includes('empty_section:n_orph01'));
  assertValid(data);
});

test('assetIds are deterministic — the same article maps to the same ids twice', () => {
  const first = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  const second = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assert.deepEqual(first, second);
});

test('one image referenced twice gets one asset id and one assets.images entry', () => {
  const shared = img(SHA_A);
  const { data, assets } = buildRenderData(
    {
      body: {
        title: 'Repeated hero',
        deck: 'One image, two slots.',
        image: { src: shared },
        nodes: [
          {
            id: 'n_one',
            kind: 'content',
            public: { title: 'A', body: 'Alpha.', media: { type: 'image', src: shared } },
          },
        ],
      },
    },
    { brand: BRAND }
  );
  assert.equal(assets.images.length, 1);
  assert.equal(data.sections[0].figure?.assetId, assets.images[0].assetId);
  assert.equal(data.coverImage, assets.images[0].assetId);
});

test('a flat-string body splits on blank lines into paragraphs', () => {
  const { data } = buildRenderData(
    {
      body: {
        title: 'Flat body',
        deck: 'Plain text in, paragraphs out.',
        nodes: [
          {
            id: 'n_flat01',
            kind: 'content',
            public: {
              title: 'Three jobs',
              body: '  First paragraph, with\na soft wrap inside it.\n\n\nSecond paragraph.\n\n   \n\nThird paragraph.  ',
            },
          },
        ],
      },
    },
    { brand: BRAND }
  );
  assert.deepEqual(data.sections[0].paragraphs, [
    'First paragraph, with a soft wrap inside it.',
    'Second paragraph.',
    'Third paragraph.',
  ]);
  assertValid(data);
});

test('a rich_text.v1 body flattens to paragraphs, lists keep their markers, and an in-body heading opens a section', () => {
  const { data, unfilled } = buildRenderData(
    {
      body: {
        title: 'Rich body',
        deck: 'A document in, paragraphs out.',
        nodes: [
          {
            id: 'n_rich01',
            kind: 'content',
            public: {
              title: 'Ignored — the body opens with its own heading',
              body: {
                nodeType: 'document',
                data: {},
                content: [
                  {
                    nodeType: 'heading-2',
                    data: {},
                    content: [{ nodeType: 'text', value: 'How the barrier works', marks: [], data: {} }],
                  },
                  {
                    nodeType: 'paragraph',
                    data: {},
                    content: [
                      { nodeType: 'text', value: 'Lipids surround the cells like ', marks: [], data: {} },
                      { nodeType: 'text', value: 'mortar', marks: [{ type: 'bold' }], data: {} },
                      { nodeType: 'text', value: ', and ', marks: [], data: {} },
                      {
                        nodeType: 'hyperlink',
                        data: { uri: 'https://example.org/barrier' },
                        content: [{ nodeType: 'text', value: 'the structure holds water in', marks: [], data: {} }],
                      },
                      { nodeType: 'text', value: '.', marks: [], data: {} },
                    ],
                  },
                  {
                    nodeType: 'unordered-list',
                    data: {},
                    content: [
                      { nodeType: 'list-item', data: {}, content: [paragraph('Humectants bind water.')] },
                      { nodeType: 'list-item', data: {}, content: [paragraph('Occlusives slow water loss.')] },
                    ],
                  },
                  {
                    nodeType: 'heading-3',
                    data: {},
                    content: [{ nodeType: 'text', value: 'What that means in practice', marks: [], data: {} }],
                  },
                  paragraph('Pick the texture you will actually use.'),
                ],
              },
            },
          },
        ],
      },
    },
    { brand: BRAND }
  );

  assert.deepEqual(
    data.sections.map((section) => section.heading),
    ['How the barrier works', 'What that means in practice']
  );
  assert.deepEqual(data.sections[0].paragraphs, [
    'Lipids surround the cells like mortar, and the structure holds water in.',
    '• Humectants bind water.',
    '• Occlusives slow water loss.',
  ]);
  assert.deepEqual(data.sections[1].paragraphs, ['Pick the texture you will actually use.']);
  // The href has no slot in this contract — said once, per node, not swallowed.
  assert.ok(unfilled.includes('dropped_link:n_rich01'));
  assertValid(data);
});

test('pull quotes come only from a blockquote the article itself marked, and are not repeated as prose', () => {
  const { data } = buildRenderData(
    {
      body: {
        title: 'Marked quotes only',
        deck: 'Nothing is promoted to a pull quote by sounding quotable.',
        nodes: [
          {
            id: 'n_quote1',
            kind: 'content',
            public: {
              title: 'On waiting',
              body: {
                nodeType: 'document',
                data: {},
                content: [
                  paragraph('The council stopped waiting for the state.'),
                  {
                    nodeType: 'blockquote',
                    data: {},
                    content: [paragraph('We stopped waiting for the map to catch up with the water.')],
                  },
                ],
              },
            },
          },
        ],
      },
    },
    { brand: BRAND }
  );
  assert.deepEqual(data.pullQuotes, [{ quote: 'We stopped waiting for the map to catch up with the water.' }]);
  assert.deepEqual(data.sections[0].paragraphs, ['The council stopped waiting for the state.']);
  assertValid(data);
});

test('a flat-string article invents no pull quotes — an empty array is the honest answer', () => {
  const { data, unfilled } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assert.deepEqual(data.pullQuotes, []);
  assert.ok(unfilled.includes('missing:pullQuotes'));
  assertValid(data);
});

test('an image src that is not an artifact path lands in unfilled and produces NO figure', () => {
  const { data, assets, unfilled } = buildRenderData(
    {
      body: {
        title: 'Unfetchable images',
        deck: 'A path the render service could never fetch must not reach a slot.',
        image: { src: 'https://cdn.example.com/hero.jpg' },
        nodes: [
          {
            id: 'n_bad001',
            kind: 'content',
            public: { title: 'A section', body: 'Body text.', media: { type: 'image', src: '/img/logo.png' } },
          },
        ],
      },
    },
    { brand: BRAND }
  );

  assert.equal(data.coverImage, undefined);
  assert.equal(data.sections[0].figure, undefined);
  assert.deepEqual(assets.images, []);
  assert.ok(unfilled.includes('unconvertible_image:coverImage'));
  assert.ok(unfilled.includes('unconvertible_image:sections.figure:n_bad001'));
  // Omitted, never emitted: an unfetchable value in a slot is what W1's
  // ASSET_MISSING fails the whole render on.
  assert.ok(!JSON.stringify(data).includes('cdn.example.com'));
  assert.ok(!JSON.stringify(data).includes('/img/'));
  assertValid(data);
});

test('a document media node is not a figure, and is named rather than silently dropped', () => {
  const { data, unfilled } = buildRenderData(
    {
      body: {
        title: 'A PDF is not a figure',
        deck: 'media-type.ts draws this line; so does the mapper.',
        nodes: [
          {
            id: 'n_doc001',
            kind: 'content',
            public: {
              title: 'Download the summary',
              body: 'The one-page summary is attached.',
              media: { type: 'document', src: `/pdf/${REQUEST}/${SHA_A}.pdf`, contentType: 'application/pdf' },
            },
          },
        ],
      },
    },
    { brand: BRAND }
  );
  assert.equal(data.sections[0].figure, undefined);
  assert.ok(unfilled.includes('skipped_media:document:n_doc001'));
});

test('an article with no sources yields sources: [] and still validates', () => {
  const { data, unfilled } = buildRenderData(
    {
      body: {
        title: 'Unsourced',
        deck: 'No source_list at all.',
        nodes: [{ id: 'n_nosrc1', kind: 'content', public: { title: 'A section', body: 'Body text.' } }],
      },
    },
    { brand: BRAND }
  );
  assert.deepEqual(data.sources, []);
  assert.ok(unfilled.includes('missing:sources'));
  assertValid(data);
});

test('non-prose node kinds and non-public nodes are skipped, and each is named', () => {
  const { unfilled } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assert.ok(unfilled.includes('skipped_node:action:n_k1q6d8'));
  assert.ok(unfilled.includes('skipped_node:non_public:n_z9x1c2'));
});

test('no annotation-layer field ever reaches data', () => {
  const { data, assets, unfilled } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  const serialized = JSON.stringify({ data, assets, unfilled });

  // The field names of the annotation layer (content-item-v1.ts's preservation
  // directive) and the actual VALUES the fixture carries in them.
  for (const key of [
    'private',
    'strategy',
    'intent',
    'agentNotes',
    'commercial',
    'disclosure',
    'editorial',
    'writer_notes',
    'emotional_strategy',
    'scores',
    'claims',
    'claim_list',
    'rendering',
    'visibility',
    'seo',
    'slug',
  ]) {
    assert.ok(!serialized.includes(key), `annotation-layer key '${key}' leaked into render output`);
  }
  for (const value of [
    'hook',
    'agitation',
    'resolution',
    'establish the everyday problem',
    'open cold',
    'Keep the agitation beat short.',
    'problem_agitation_resolution',
    'Calm, unhurried, clinical.',
    'Sponsored',
    'nofollow sponsored',
    'Not for readers.',
    'Ceramides occur naturally in the barrier.',
  ]) {
    assert.ok(!serialized.includes(value), `annotation-layer value '${value}' leaked into render output`);
  }
});

test('unfilled carries no tenant path, blobKey or blob sha', () => {
  const { unfilled } = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  for (const entry of unfilled) {
    assert.ok(!entry.includes('/'), `unfilled entry '${entry}' must not carry a path`);
    assert.ok(!entry.includes(SHA_A) && !entry.includes(SHA_B), `unfilled entry '${entry}' must not carry a blob sha`);
    assert.ok(!entry.includes(REQUEST), `unfilled entry '${entry}' must not carry a tenant request id`);
  }
});

test('date comes from the publication stamp, else the record updated_at, else it is reported missing', () => {
  const published = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assert.equal(published.data.date, '3 September 2026');

  const unpublishedRecord = { ...ARTICLE_RECORD, publication: { published_time: null } };
  const unpublished = buildRenderData(unpublishedRecord, { brand: BRAND });
  assert.equal(unpublished.data.date, '3 September 2026');

  const bare = buildRenderData({ body: ARTICLE_RECORD.body }, { brand: BRAND });
  assert.equal(bare.data.date, undefined);
  assert.ok(bare.unfilled.includes('missing:date'));

  assert.equal(formatRenderDate('2026-01-09T00:00:00.000Z'), '9 January 2026');
  assert.equal(formatRenderDate('not a date'), 'not a date');
});

test('brand is passed through untouched and reported missing when the caller has none', () => {
  const withBrand = buildRenderData(ARTICLE_RECORD, { brand: BRAND });
  assert.equal(withBrand.data.brand, BRAND);
  assert.ok(!withBrand.unfilled.includes('missing:brand'));

  const without = buildRenderData(ARTICLE_RECORD);
  assert.equal('brand' in without.data, false);
  assert.ok(without.unfilled.includes('missing:brand'));
  // The one thing it must never do: build one itself.
  assert.deepEqual(schemaErrors(without.data), ["data: missing required 'brand'"]);
});

test('a caller-supplied template schema wins: its limits are honored and its unknown slots are not emitted', () => {
  const narrow = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'sections', 'pullQuotes', 'sources'],
    properties: {
      title: { type: 'string', maxLength: 20 },
      sections: {
        type: 'array',
        maxItems: 1,
        items: {
          type: 'object',
          required: ['heading', 'paragraphs'],
          properties: {
            heading: { type: 'string', maxLength: 150 },
            paragraphs: { type: 'array', maxItems: 1, items: { type: 'string', maxLength: 2000 } },
          },
        },
      },
      pullQuotes: { type: 'array', maxItems: 0 },
      sources: { type: 'array', maxItems: 1 },
    },
  };
  const { data, unfilled } = buildRenderData(ARTICLE_RECORD, { brand: BRAND, templateSchema: narrow });

  assert.equal(data.deck, undefined, 'a slot the target schema does not declare is not emitted');
  assert.equal(data.brand, undefined);
  assert.ok(unfilled.includes('unsupported_slot:deck'));
  assert.ok(unfilled.includes('unsupported_slot:brand'));
  assert.equal(data.title, 'What Moisturizers…');
  assert.ok(unfilled.includes('truncated:title'));
  assert.equal(data.sections.length, 1);
  assert.equal(data.sections[0].paragraphs.length, 1, 'over-long sections spill into continuations, then cap');
  assert.equal(data.sources.length, 1);
  assert.ok(unfilled.includes('dropped_source:1'));
  assert.ok(unfilled.some((entry) => entry.startsWith('dropped_section:')));
});

test('an over-long paragraph is split rather than cut', () => {
  const sentence = `${'word '.repeat(120).trim()}. `;
  const long = sentence.repeat(6).trim();
  const { data } = buildRenderData(
    {
      body: {
        title: 'Long body',
        deck: 'Nothing is thrown away to fit a maxLength.',
        nodes: [{ id: 'n_long01', kind: 'content', public: { title: 'One long paragraph', body: long } }],
      },
    },
    { brand: BRAND }
  );
  const rejoined = data.sections
    .flatMap((section) => section.paragraphs)
    .join(' ')
    .replace(/\s+/g, ' ');
  assert.equal(rejoined, long.replace(/\s+/g, ' '));
  assertValid(data);
});

test('an article with nothing usable still returns a shape, and says why it is empty', () => {
  const { data, assets, unfilled } = buildRenderData({ body: { nodes: [] } });
  assert.deepEqual(data, { sections: [], pullQuotes: [], sources: [] });
  assert.deepEqual(assets, { images: [] });
  for (const entry of [
    'missing:sections',
    'missing:sources',
    'missing:pullQuotes',
    'missing:coverImage',
    'missing:title',
    'missing:deck',
    'missing:author',
    'missing:kicker',
    'missing:date',
    'missing:brand',
  ]) {
    assert.ok(unfilled.includes(entry), `expected ${entry}`);
  }
});

test('garbage in does not throw — the mapper never fails the render it exists to make succeed', () => {
  for (const input of [undefined, null, 42, 'an article', [], { body: 'not an object' }, { body: { nodes: 'x' } }]) {
    assert.doesNotThrow(() => buildRenderData(input));
  }
  const { data } = buildRenderData({ body: { title: { toString: 'no' }, nodes: [{ id: 'n_x', kind: 'content' }] } });
  assert.equal(data.title, undefined, 'a non-string title is absent, never "[object Object]"');
});

test('artifactBlobKeyForImageSrc converts exactly the public artifact image paths', () => {
  assert.equal(artifactBlobKeyForImageSrc(img(SHA_A)), `image/${REQUEST}/${SHA_A}.webp`);
  assert.equal(artifactBlobKeyForImageSrc(`/pdf/${REQUEST}/${SHA_A}.pdf`), undefined);
  assert.equal(artifactBlobKeyForImageSrc('/img/logo.png'), undefined);
  assert.equal(artifactBlobKeyForImageSrc(`image/${REQUEST}/${SHA_A}.webp`), undefined);
  assert.equal(artifactBlobKeyForImageSrc(`https://x.test/img/${REQUEST}/${SHA_A}.webp`), undefined);
});

// ─── the mirror must not drift from the contract that is actually seeded ────
//
// W2 REVIEW. `article-brochure-v1-render-data-schema.ts` is a MIRROR of the
// template's own `renderDataSchema`, and T2.7 seeds that template into every
// tenant from `scripts/lib/pdf-templates/article_brochure_v1.json`. Two copies,
// nothing binding them: edit the seeded JSON (the contract W1's
// RENDER_DATA_INVALID actually enforces) without editing the mirror, and the
// mapper silently maps to the OLD limits — a gate that has stopped matching the
// thing it gates, which is the failure mode this whole wave exists to prevent.
// `build_pdf_render_data` and `validate_pdf_render_data` fall back to the
// mirror too, so the drift would reach three tools at once.

test('the mirrored contract is byte-for-byte the renderDataSchema genesis actually seeds', async () => {
  const { existsSync, readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const path = await import('node:path');
  // The compiled test runs from `.tmp/ci-test`, so walk up to the repo root
  // (the admin-requests.test.ts precedent).
  let root = path.dirname(fileURLToPath(import.meta.url));
  while (root !== path.dirname(root)) {
    if (existsSync(path.join(root, 'netlify.toml')) && existsSync(path.join(root, 'packages/core/admin'))) break;
    root = path.dirname(root);
  }
  const seedPath = path.join(root, 'scripts', 'lib', 'pdf-templates', 'article_brochure_v1.json');
  const seeded = JSON.parse(readFileSync(seedPath, 'utf8')) as { templateId: string; renderDataSchema: unknown };

  assert.equal(seeded.templateId, ARTICLE_BROCHURE_V1_TEMPLATE_ID);
  assert.deepEqual(
    seeded.renderDataSchema,
    ARTICLE_BROCHURE_V1_RENDER_DATA_SCHEMA,
    'scripts/lib/pdf-templates/article_brochure_v1.json is the contract seeded into tenants; regenerate the mirror from it rather than hand-editing either side'
  );
});
