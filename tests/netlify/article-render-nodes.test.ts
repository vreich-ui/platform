/**
 * The content_item node renderer (W7.3) — the leak rule and the render
 * matrix. The leak rule is the preservation directive's enforcement half:
 * annotations exist so agents can judge/score, and READERS MUST NEVER SEE
 * THEM — the output is grepped for the strategy vocabulary and annotation
 * field names, the same discipline the W7.1 substrate's leak test set.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { renderArticleNodes } from '../../packages/core/lib/article-object/render-nodes.js';
import { contentItemBodySchema, type ContentItemBody } from '../../packages/core/schema/bodies/content-item-v1.js';

// Overrides are plain JSON (the zod parse validates them) — literal strings
// for nodeType/marks don't unify with the enum-pinned output types otherwise.
const article = (overrides: Record<string, unknown> = {}): ContentItemBody =>
  contentItemBodySchema.parse({
    slug: 'barrier-myths',
    title: 'Five barrier myths',
    // T13.1 leak seed: label/tags are reporting-only and must NEVER render.
    tracking: {
      enabled: true,
      label: 'TRKLABELSENTINEL retarget the anxious-buyer cohort',
      tags: ['TRKTAGSENTINEL_q3_push'],
      goals: [{ goal: 'opt_in', on: 'completion' }],
    },
    nodes: [
      {
        id: 'n_a1',
        kind: 'content',
        public: { eyebrow: 'Skin science', title: 'The myth', body: 'First paragraph.\n\nSecond paragraph.' },
        private: { strategy: 'hook', intent: 'persuade', agentNotes: 'Lean into the frustration angle.' },
      },
      {
        id: 'n_a2',
        kind: 'content',
        public: { items: ['One', 'Two'] },
        private: { strategy: 'proof' },
        visibility: 'public',
      },
      {
        id: 'n_a3',
        kind: 'content',
        public: { body: 'Internal working notes block.' },
        visibility: 'internal',
      },
      {
        id: 'n_a4',
        kind: 'action',
        public: { ctaText: 'Start here', ctaLink: '/start-here' },
        private: { strategy: 'recommendation', intent: 'convert' },
      },
    ],
    ...overrides,
  });

test('renders public nodes with canvas identity; internal/hidden nodes never reach HTML', () => {
  const { html } = renderArticleNodes('req_agent_barrier_myths_20260713_01', article());
  assert.match(html, /data-cms-node-id="n_a1"/);
  assert.match(html, /data-cms-node-kind="content"/);
  assert.match(html, /<h2>The myth<\/h2>/);
  assert.match(html, /<p>First paragraph\.<\/p><p>Second paragraph\.<\/p>/);
  assert.match(html, /<ul><li>One<\/li><li>Two<\/li><\/ul>/);
  // The CTA renders as a real site button: not-prose blocks the prose anchor
  // color (text-white must win) and font-sans blocks the serif leak.
  assert.match(html, /class="article-node-cta not-prose"><a class="btn btn-primary font-sans" href="\/start-here"/);
  // never-render-private: the internal node is absent ENTIRELY (no wrapper).
  assert.equal(html.includes('n_a3'), false);
  assert.equal(html.includes('Internal working notes'), false);
});

test('THE LEAK RULE: no strategy vocabulary or annotation field names in the output', () => {
  const { html } = renderArticleNodes('req_agent_barrier_myths_20260713_01', article());
  // T13.1: tracking.label / tracking.tags join the forbidden set — reporting
  // vocabulary, same never-render discipline as strategy annotations.
  for (const forbidden of [
    'hook',
    'agitation',
    'persuade',
    'convert',
    'agentNotes',
    'private',
    'strategy',
    'TRKLABELSENTINEL',
    'TRKTAGSENTINEL',
    'anxious-buyer',
  ]) {
    assert.equal(
      html.toLowerCase().includes(forbidden.toLowerCase()),
      false,
      `rendered HTML must not contain "${forbidden}"`
    );
  }
});

test('plain-text bodies are escaped (typed HTML shows literally, never executes)', () => {
  const { html } = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_b1',
          kind: 'content',
          public: { body: '<script>alert(1)</script> & <b>bold?</b>' },
        },
      ],
    })
  );
  assert.equal(html.includes('<script>'), false);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /&amp;/);
});

test('rich_text.v1 document bodies render through the W7.1 substrate', () => {
  const { html } = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_b1',
          kind: 'content',
          public: {
            body: {
              nodeType: 'document',
              data: {},
              content: [
                {
                  nodeType: 'paragraph',
                  data: {},
                  content: [
                    { nodeType: 'text', value: 'Bold ', marks: [{ type: 'bold' }], data: {} },
                    { nodeType: 'text', value: 'and plain.', marks: [], data: {} },
                  ],
                },
                {
                  nodeType: 'blockquote',
                  data: {},
                  content: [
                    {
                      nodeType: 'paragraph',
                      data: {},
                      content: [{ nodeType: 'text', value: 'Quoted.', marks: [], data: {} }],
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    })
  );
  assert.match(html, /<strong>Bold <\/strong>/);
  assert.match(html, /<blockquote><p>Quoted\.<\/p><\/blockquote>/);
});

test('a node title is not double-headed when the body already opens with a heading-2 (T9.16)', () => {
  const heading = 'What changes in the barrier after 40';
  const richBody = (firstBlock: Record<string, unknown>) => ({
    nodeType: 'document',
    data: {},
    content: [
      firstBlock,
      { nodeType: 'paragraph', data: {}, content: [{ nodeType: 'text', value: 'Body copy.', marks: [], data: {} }] },
    ],
  });

  // Body opens with a heading-2 (matching the title): only ONE heading renders.
  const deduped = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_dup',
          kind: 'content',
          public: {
            title: heading,
            body: richBody({
              nodeType: 'heading-2',
              data: {},
              content: [{ nodeType: 'text', value: heading, marks: [], data: {} }],
            }),
          },
        },
      ],
    })
  ).html;
  const headings = deduped.match(/<h2>What changes in the barrier after 40<\/h2>/g) ?? [];
  assert.equal(headings.length, 1, `expected the section heading exactly once, got ${headings.length}`);

  // Body opens with a paragraph (no leading heading-2): the title STILL renders
  // as the section heading — the fix only suppresses a duplicate, never a title.
  const kept = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_titled',
          kind: 'content',
          public: {
            title: heading,
            body: richBody({
              nodeType: 'paragraph',
              data: {},
              content: [{ nodeType: 'text', value: 'Lede paragraph.', marks: [], data: {} }],
            }),
          },
        },
      ],
    })
  ).html;
  assert.match(kept, /<h2>What changes in the barrier after 40<\/h2>/);
});

test('offer placements render with their disclosure; unsafe hrefs degrade to text', () => {
  const { html } = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_b1',
          kind: 'placement',
          public: {
            title: 'Reader deal',
            body: 'A relevant thing.',
            ctaText: 'Get it',
            ctaLink: 'https://example.com/deal',
          },
          rendering: { presentation: 'offerCard' },
          commercial: { type: 'offer', rel: 'sponsored', disclosure: { required: true, label: 'Partner offer' } },
        },
        {
          id: 'n_b2',
          kind: 'action',
          public: { ctaText: 'Bad link', ctaLink: 'javascript:alert(1)' },
        },
      ],
    })
  );
  assert.match(html, /Partner offer/);
  assert.match(html, /rel="sponsored"/);
  assert.match(html, /article-node-offer/);
  // Unsafe href: the CTA text renders, the link does not.
  assert.equal(html.includes('javascript:'), false);
  assert.match(html, /<strong>Bad link<\/strong>/);
});

test('reading time matches the md pipeline convention (ceil, min 1)', () => {
  const { readingTime } = renderArticleNodes('req_x', article());
  assert.equal(readingTime, 1);
  const words = Array.from({ length: 450 }, (_, index) => `word${index}`).join(' ');
  const { readingTime: longer } = renderArticleNodes(
    'req_x',
    article({ nodes: [{ id: 'n_b1', kind: 'content', public: { body: words } }] })
  );
  assert.equal(longer, 3);
});

// ═══ W7.7: adSlot mockup bank + multi-image blocks ═══════════════════════════

test('a mock adSlot renders its bank unit, honestly labeled; real providers render nothing', () => {
  const withAd = (adSlot: Record<string, unknown>, creativeId?: string) =>
    article({
      nodes: [
        {
          id: 'n_c1',
          kind: 'placement',
          public: {},
          commercial: { type: 'adSlot', source: 'programmatic', ...(creativeId ? { creativeId } : {}), adSlot },
          rendering: { presentation: 'adSlot' },
        },
      ],
    });

  const native = renderArticleNodes('req_x', withAd({ provider: 'mock' })).html;
  assert.match(native, /article-node-ad/);
  assert.match(native, /Sponsored · Golden Hour Botanicals/);
  assert.match(native, /rel="nofollow sponsored"/);

  const leaderboard = renderArticleNodes('req_x', withAd({ provider: 'mock' }, 'mock-leaderboard')).html;
  assert.match(leaderboard, /Advertisement/);
  assert.match(leaderboard, /btn-primary font-sans/);

  const rectangle = renderArticleNodes('req_x', withAd({ provider: 'mock' }, 'mock-rectangle')).html;
  assert.match(rectangle, /w-\[300px\]/);

  // A REAL provider config renders nothing (no runtime — never fake it):
  // the wrapper emits (canvas-addressable), the box does not.
  const real = renderArticleNodes('req_x', withAd({ provider: 'gpt', adUnitPath: '/123/slot' })).html;
  assert.ok(real.includes('data-cms-node-id="n_c1"'));
  assert.equal(real.includes('article-node-ad'), false);

  // Leak rule holds for ad units too.
  for (const forbidden of ['hook', 'agitation', 'agentNotes', 'strategy']) {
    assert.equal(native.toLowerCase().includes(forbidden.toLowerCase()), false);
  }
});

test('a multi-image block renders each image in order; empty srcs render nothing', () => {
  const { html } = renderArticleNodes(
    'req_x',
    article({
      nodes: [
        {
          id: 'n_g1',
          kind: 'content',
          public: {
            images: [
              { type: 'image', src: '/img/one.webp', alt: 'One' },
              { type: 'image', src: '', alt: 'Placeholder' },
              { type: 'image', src: '/img/two.webp', alt: 'Two', caption: 'Second' },
            ],
          },
        },
      ],
    })
  );
  const first = html.indexOf('/img/one.webp');
  const second = html.indexOf('/img/two.webp');
  assert.ok(first >= 0 && second > first, 'images render in order');
  assert.match(html, /<figcaption>Second<\/figcaption>/);
  assert.equal(html.includes('Placeholder'), false, 'an empty src renders nothing, not a broken img');
});

test('media render matrix: image media renders <img>, document media renders an honest download link', () => {
  const sha = 'f'.repeat(64);
  const body = article({
    nodes: [
      {
        id: 'n_a1',
        kind: 'content',
        public: {
          body: 'Copy.',
          media: { type: 'image', src: `/img/req_render_20260719_01/${sha}.webp`, alt: 'A calm flatlay' },
        },
      },
      {
        id: 'n_a2',
        kind: 'content',
        public: {
          body: 'Get the guide.',
          media: { type: 'document', src: `/pdf/req_render_20260719_01/${sha}.pdf`, title: 'Flare tracker' },
        },
      },
    ],
  });
  const { html } = renderArticleNodes('req_render_20260719_01', body);
  assert.match(html, new RegExp(`<img src="/img/req_render_20260719_01/${sha}\\.webp" alt="A calm flatlay"`));
  assert.match(
    html,
    new RegExp(`<a class="article-document-link[^"]*" href="/pdf/req_render_20260719_01/${sha}\\.pdf"`)
  );
  assert.match(html, /<span class="font-semibold">Flare tracker<\/span>/);
});

test('document media SNAPSHOT: a PDF attachment renders a download block + <object> preview, never an <img>', () => {
  const sha = 'e'.repeat(64);
  const src = `/pdf/req_render_pdf_20260831_01/${sha}.pdf`;
  const body = article({
    nodes: [
      {
        id: 'n_a1',
        kind: 'content',
        public: {
          title: 'Download the tracker',
          media: {
            type: 'document',
            src,
            title: 'Flare tracker',
            contentType: 'application/pdf',
            sizeBytes: 245760,
            caption: 'PDF, 4 pages',
          },
        },
        commercial: { rel: 'sponsored' },
      },
    ],
  });
  const { html } = renderArticleNodes('req_render_pdf_20260831_01', body);
  const start = html.indexOf('<figure class="article-node-document');
  const end = html.indexOf('</figure>', start) + '</figure>'.length;
  assert.ok(start >= 0, html);
  const block = html.slice(start, end);
  assert.equal(
    block,
    `<figure class="article-node-document not-prose my-6" data-media-type="document">` +
      `<a class="article-document-link flex items-center gap-3 rounded-lg border border-gray-200 dark:border-slate-700 bg-surface px-4 py-3 font-sans no-underline hover:border-primary" href="${src}" type="application/pdf" rel="sponsored" download="${sha}.pdf">` +
      `<span class="article-document-icon text-2xl" aria-hidden="true">📄</span>` +
      `<span class="flex flex-col"><span class="font-semibold">Flare tracker</span>` +
      `<span class="text-sm text-muted">${sha}.pdf · PDF · 240 KB</span></span>` +
      `</a>` +
      `<object class="article-document-preview w-full aspect-[3/4] max-h-[80vh] rounded-lg border border-gray-200 dark:border-slate-700" data="${src}" type="application/pdf" aria-label="Flare tracker">` +
      `<p class="text-sm text-muted">Your browser cannot preview this PDF — <a href="${src}" rel="sponsored" download="${sha}.pdf">download ${sha}.pdf</a>.</p>` +
      `</object>` +
      `<figcaption>PDF, 4 pages</figcaption>` +
      `</figure>`
  );
  // The whole point: a PDF is never an <img>.
  assert.equal(/<img[^>]*\.pdf/.test(html), false);
});

test('document media: size is omitted when unknown; title falls back to the node title, then the filename', () => {
  const sha = 'd'.repeat(64);
  const src = `/pdf/req_render_pdf_20260831_02/${sha}.pdf`;
  const { html } = renderArticleNodes(
    'req_render_pdf_20260831_02',
    article({
      nodes: [
        { id: 'n_a1', kind: 'content', public: { title: 'Node title', media: { type: 'document', src } } },
        { id: 'n_a2', kind: 'content', public: { media: { type: 'document', src } } },
      ],
    })
  );
  assert.match(html, /<span class="font-semibold">Node title<\/span>/);
  assert.match(html, new RegExp(`<span class="font-semibold">${sha}\\.pdf</span>`));
  assert.match(html, new RegExp(`<span class="text-sm text-muted">${sha}\\.pdf · PDF</span>`));
  assert.equal(html.includes(' KB'), false);
});
