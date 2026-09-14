/**
 * A8 Part 2 — `document-render.ts`'s decisions, tested against fakes.
 *
 * `runDocumentRender` composes reused, unmodified modules (`pdf-bridge-defaults.ts`,
 * `pdf-render-data-mapper-seam.ts`, `render-data-schema-check.ts`, and — for the one
 * end-to-end-supported kind, `article` — `article-pdf-render.ts`'s own `renderArticlePdf`,
 * called for real, not mocked out, so these tests exercise the actual create→poll→attach
 * lifecycle too). Every effect is injected (repo posture, BRIEF §4).
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DEFAULT_DOCUMENT_KIND_MAPPERS,
  getDocumentKindMapper,
  resolveDocumentRenderTemplateId,
  runDocumentRender,
  type DocumentKindMapperRegistry,
  type DocumentRenderEffects,
} from './document-render.js';
import type { ArticleNodeLike, ArticlePdfAttachOp, ArticlePdfJobView } from './article-pdf-render.js';
import type { SitePdfDefaults } from './pdf-bridge-defaults.js';

// ─── resolveDocumentRenderTemplateId — pure precedence ──────────────────────

test('template resolution: an explicit template_id always wins', () => {
  const result = resolveDocumentRenderTemplateId('tpl_explicit', { defaultTemplateId: 'tpl_default' }, 'article');
  assert.deepEqual(result, { templateId: 'tpl_explicit', source: 'explicit' });
});

test('template resolution: falls back to the site default when nothing explicit is given', () => {
  const result = resolveDocumentRenderTemplateId(undefined, { defaultTemplateId: 'tpl_default' }, 'article');
  assert.deepEqual(result, { templateId: 'tpl_default', source: 'site_default' });
});

test('template resolution: byKind[kind] beats the bare default (D-1, reused unchanged)', () => {
  const sitePdf: SitePdfDefaults = { defaultTemplateId: 'tpl_default', byKind: { guide: 'tpl_guide' } };
  const result = resolveDocumentRenderTemplateId(undefined, sitePdf, 'guide');
  assert.deepEqual(result, { templateId: 'tpl_guide', source: 'site_default' });
});

test('template resolution: unresolved, honestly, when neither an explicit id nor any site default exists', () => {
  const result = resolveDocumentRenderTemplateId(undefined, undefined, 'article');
  assert.deepEqual(result, { templateId: undefined, source: 'unresolved' });
});

// ─── the kind → mapper registry ─────────────────────────────────────────────

test('only "article" has a registered mapper by default', () => {
  assert.equal(typeof getDocumentKindMapper('article'), 'function');
  assert.equal(getDocumentKindMapper('newsletter'), undefined);
  assert.equal(getDocumentKindMapper('report'), undefined);
  assert.equal(getDocumentKindMapper('literally_anything_else'), undefined);
});

test('a caller-supplied registry can extend the mapper set without touching the default', () => {
  const custom: DocumentKindMapperRegistry = {
    ...DEFAULT_DOCUMENT_KIND_MAPPERS,
    newsletter: async () => ({ ok: true, data: { headline: 'x' } }),
  };
  assert.equal(typeof getDocumentKindMapper('newsletter', custom), 'function');
  // The default export itself is untouched by building `custom`.
  assert.equal(getDocumentKindMapper('newsletter'), undefined);
});

// ─── runDocumentRender — the fake world ─────────────────────────────────────

const CONTENT_ITEM = {
  object_id: 'content_moisturizer_guide',
  object_type: 'content_item',
  site: 'site_drlurie',
  body: {
    slug: 'what-moisturizers-actually-do',
    title: 'What Moisturizers Actually Do',
    deck: 'A short guide.',
    nodes: [{ id: 'n_a', kind: 'content', visibility: 'public', public: { body: 'Body copy.' } }],
  },
};

const ARTICLE_NODES: ArticleNodeLike[] = [
  { id: 'n_a', kind: 'content', visibility: 'public', public: { body: 'Body copy.' } },
];

type FakeWorld = {
  effects: DocumentRenderEffects;
  createCalls: number;
  attachOps: ArticlePdfAttachOp[];
};

const makeEffects = (options: {
  ownerFails?: boolean;
  sitePdf?: SitePdfDefaults;
  templateSchema?: unknown;
  createResult?: ArticlePdfJobView | { error: { message: string } };
  polls?: ArticlePdfJobView[];
  nodes?: ArticleNodeLike[];
}): FakeWorld => {
  let clock = 0;
  let createCalls = 0;
  let pollIndex = 0;
  const attachOps: ArticlePdfAttachOp[] = [];
  const world = { attachOps } as unknown as FakeWorld;

  const effects: DocumentRenderEffects = {
    readOwnerRecord: async () =>
      options.ownerFails
        ? { ok: false, error: { message: 'content item not found' } }
        : { ok: true, value: CONTENT_ITEM },
    readSitePdfDefaults: async () => options.sitePdf,
    readTemplateRenderDataSchema: async () => options.templateSchema,
    createJob: async () => {
      createCalls += 1;
      const result = options.createResult ?? { jobId: 'job_1', status: 'pending' as const };
      return 'jobId' in result ? { ok: true, value: result } : { ok: false, error: result.error };
    },
    pollJob: async (jobId) => {
      const list = options.polls ?? [];
      const view = list[Math.min(pollIndex, list.length - 1)];
      pollIndex += 1;
      return view ? { ok: true, value: view } : { ok: true, value: { jobId, status: 'pending' } };
    },
    readArticleNodes: async () => ({ ok: true, value: options.nodes ?? ARTICLE_NODES }),
    applyAttach: async (op) => {
      attachOps.push(op);
      return { ok: true, value: true };
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  };

  Object.defineProperty(world, 'createCalls', { get: () => createCalls });
  world.effects = effects;
  return world;
};

const baseParams = () => ({
  siteId: 'site_drlurie',
  ownerObjectType: 'content_item' as const,
  ownerObjectId: 'content_moisturizer_guide',
  attach: true,
  pollBudgetMs: 5_000,
  pollIntervalMs: 1_000,
});

test('ACCEPTANCE — blocked, no job created, when no template can be resolved at all', async () => {
  const world = makeEffects({ sitePdf: undefined });
  const outcome = await runDocumentRender(baseParams(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') return;
  assert.equal(outcome.reason, 'no_template');
  assert.equal(world.createCalls, 0);
});

test('ACCEPTANCE (correctness requirement) — an unregistered document kind (newsletter) is refused, never silently forced through the article schema', async () => {
  const world = makeEffects({ sitePdf: { defaultTemplateId: 'tpl_newsletter' } });
  const outcome = await runDocumentRender({ ...baseParams(), documentKind: 'newsletter' }, world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') return;
  assert.equal(outcome.reason, 'no_mapper_for_kind');
  assert.match(outcome.detail, /own declared mapping/);
  assert.match(outcome.detail, /never forced through the article schema/);
  assert.equal(world.createCalls, 0, 'a document with no registered mapper must never reach job creation');
});

test('the same refusal applies to "report", by the same rule, not a hardcoded newsletter-only check', async () => {
  const world = makeEffects({ sitePdf: { defaultTemplateId: 'tpl_report' } });
  const outcome = await runDocumentRender({ ...baseParams(), documentKind: 'report' }, world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') return;
  assert.equal(outcome.reason, 'no_mapper_for_kind');
  assert.equal(world.createCalls, 0);
});

test('a mapper the registry DOES supply, but that itself refuses the content, blocks as invalid_render_data (not a crash, not a forced render)', async () => {
  const registry: DocumentKindMapperRegistry = {
    newsletter: async () => ({ ok: false, error: 'newsletter content has no sections to map' }),
  };
  const world = makeEffects({ sitePdf: { defaultTemplateId: 'tpl_newsletter' } });
  const outcome = await runDocumentRender({ ...baseParams(), documentKind: 'newsletter', registry }, world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') return;
  assert.equal(outcome.reason, 'invalid_render_data');
  assert.match(outcome.detail, /no sections to map/);
  assert.equal(world.createCalls, 0);
});

test("ACCEPTANCE — mapped render data that fails the template's own schema blocks before any job, with errors named", async () => {
  const schema = {
    type: 'object',
    required: ['this_field_the_article_mapper_will_never_produce'],
    properties: {},
    additionalProperties: true,
  };
  const world = makeEffects({ sitePdf: { defaultTemplateId: 'tpl_brochure' }, templateSchema: schema });
  const outcome = await runDocumentRender(baseParams(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') return;
  assert.equal(outcome.reason, 'invalid_render_data');
  assert.ok(outcome.errors && outcome.errors.length > 0);
  assert.equal(world.createCalls, 0);
});

test('ACCEPTANCE — a resolvable article renders end-to-end through the reused renderArticlePdf lifecycle', async () => {
  const world = makeEffects({
    sitePdf: { defaultTemplateId: 'tpl_brochure' },
    // No templateSchema ⇒ the explicit pre-validate step is skipped, exactly as
    // documented — the create/poll/attach path (renderArticlePdf) still runs.
    createResult: { jobId: 'job_1', status: 'pending', templateId: 'tpl_brochure' },
    polls: [
      {
        jobId: 'job_1',
        status: 'complete',
        templateId: 'tpl_brochure',
        publicPath: `/pdf/content_moisturizer_guide/${'a'.repeat(64)}.pdf`,
        pageCount: 4,
      },
    ],
  });
  const outcome = await runDocumentRender(baseParams(), world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'rendered');
  if (outcome.outcome !== 'rendered') return;
  assert.equal(outcome.documentKind, 'article');
  assert.equal(outcome.templateId, 'tpl_brochure');
  assert.equal(outcome.receipt.status, 'complete');
  assert.equal(outcome.receipt.attached, true);
  assert.equal(world.createCalls, 1);
});

test('an unreadable owner record fails cleanly with ok:false, before any template/mapper work', async () => {
  const world = makeEffects({ ownerFails: true, sitePdf: { defaultTemplateId: 'tpl_brochure' } });
  const outcome = await runDocumentRender(baseParams(), world.effects);
  assert.equal(outcome.ok, false);
  assert.equal(world.createCalls, 0);
});

test('documentKind defaults to "article" (resolvePdfJobKind, reused) when the caller names none', async () => {
  const world = makeEffects({
    sitePdf: { defaultTemplateId: 'tpl_brochure' },
    createResult: { jobId: 'job_1', status: 'complete', publicPath: `/pdf/x/${'b'.repeat(64)}.pdf`, pageCount: 1 },
  });
  const outcome = await runDocumentRender({ ...baseParams(), documentKind: undefined }, world.effects);
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(outcome.outcome, 'rendered');
  if (outcome.outcome !== 'rendered') return;
  assert.equal(outcome.documentKind, 'article');
});
