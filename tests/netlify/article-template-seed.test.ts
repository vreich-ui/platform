/**
 * T2.7 — tests for `scripts/lib/article-template-seed.mjs`: the seed
 * decision (what the seeded template body is for a given site's brand;
 * whether a seed is needed or already present) as pure functions.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  articleTemplateIdForSite,
  buildBrandedArticleTemplateSeed,
  pdfRenderBrandFromSiteBody,
  planArticleTemplateSeed,
  validateSeedSampleData,
} from '../../scripts/lib/article-template-seed.mjs';

// The canonical brand-extraction rule this module's `pdfRenderBrandFromSiteBody`
// MIRRORS — a standalone (no relative imports of its own) .ts leaf module, so
// Node's native type-stripping can import it directly here for a real,
// executable parity check (not just a comment claiming the two match).
import { pdfRenderBrandFromSiteBody as canonicalPdfRenderBrandFromSiteBody } from '../../packages/core/server/lib/pdf-render-brand.js';

/**
 * The repo root, walked up to rather than counted with `..`.
 *
 * This file moved from `tests/scripts/` (run raw) to `tests/netlify/` (compiled
 * by `tsc -p tsconfig.test.json`), so at run time it lives under `.tmp/ci-test/`
 * — and tsc emits `.js`, it does not copy `.json` fixtures. A path relative to
 * this FILE would resolve inside the build output and find nothing; the seed
 * template it reads is a repo file. Same walk-up the other compiled tests use.
 */
const findRepoRoot = (startDir: string): string => {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'astro.config.ts'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('repo root not found');
    dir = parent;
  }
};
const here = path.join(findRepoRoot(path.dirname(fileURLToPath(import.meta.url))), 'tests', 'scripts');
const ARTICLE_BROCHURE_V1 = JSON.parse(
  readFileSync(path.join(here, '..', '..', 'scripts', 'lib', 'pdf-templates', 'article_brochure_v1.json'), 'utf8')
);

const DRLURIE_SITE_BODY = {
  name: 'Dr. Lurié Skincare',
  logo: { text: 'DR. LURIÉ SKINCARE' },
  brandTokens: {
    colors: {
      primary: 'rgb(46 111 149)',
      secondary: 'rgb(37 90 120)',
      accent: 'rgb(94 140 138)',
      gold: 'rgb(194 168 120)',
      'text-heading': 'rgb(22 26 29)',
      'text-default': 'rgb(36 41 46)',
      'text-muted': 'rgb(58 65 73 / 76%)',
      'bg-page': 'rgb(252 251 248)',
      'bg-surface': 'rgb(247 245 240)',
      'bg-page-dark': 'rgb(3 6 32)',
    },
    fonts: {
      sans: "'Inter Variable'",
      serif: "'Source Serif 4', Georgia, serif",
      heading: "'Playfair Display', 'Times New Roman', serif",
    },
  },
};

// ─── articleTemplateIdForSite ───────────────────────────────────────────────

test('articleTemplateIdForSite strips the site_ prefix', () => {
  assert.equal(articleTemplateIdForSite('site_drlurie'), 'drlurie_article_v1');
});

test('articleTemplateIdForSite falls back to the whole id when there is no site_ prefix', () => {
  assert.equal(articleTemplateIdForSite('acme'), 'acme_article_v1');
});

// ─── pdfRenderBrandFromSiteBody parity with pdf-render-brand.ts ────────────

test('pdfRenderBrandFromSiteBody matches the canonical pdf-render-brand.ts implementation, fixture by fixture', () => {
  const fixtures = [
    DRLURIE_SITE_BODY,
    undefined,
    { name: 'no tokens' },
    { brandTokens: { colors: {}, fonts: { sans: 'a', serif: 'b', heading: 'c' } } },
    { brandTokens: { colors: { primary: '#123456' }, fonts: { sans: 'Inter' } } },
    {
      logo: { imageAssetRef: 'image/site/logo-abc123.webp' },
      brandTokens: { colors: { primary: '#111' }, fonts: { sans: 'a', serif: 'b', heading: 'c' } },
    },
    {
      logo: { imageAssetRef: 'brand-logo.png' },
      brandTokens: { colors: { primary: '#111' }, fonts: { sans: 'a', serif: 'b', heading: 'c', mono: 'm' } },
    },
  ];
  for (const body of fixtures) {
    assert.deepEqual(pdfRenderBrandFromSiteBody(body), canonicalPdfRenderBrandFromSiteBody(body));
  }
});

// ─── planArticleTemplateSeed (idempotency) ──────────────────────────────────

test('planArticleTemplateSeed says create when the template id is not in the tenant list', () => {
  const plan = planArticleTemplateSeed('drlurie_article_v1', ['some_other_template']);
  assert.equal(plan.action, 'create');
});

test('planArticleTemplateSeed says already_seeded (no-op) when the template id already exists', () => {
  const plan = planArticleTemplateSeed('drlurie_article_v1', ['drlurie_article_v1', 'other']);
  assert.equal(plan.action, 'already_seeded');
  assert.match(plan.reason, /left untouched/);
});

// ─── buildBrandedArticleTemplateSeed + validateSeedSampleData (acceptance) ──

test('the drlurie-branded seed carries drlurie colors/fonts, not the generic sample brand', () => {
  const seed = buildBrandedArticleTemplateSeed({
    templateId: 'drlurie_article_v1',
    source: ARTICLE_BROCHURE_V1,
    siteBody: DRLURIE_SITE_BODY,
  });
  assert.ok(seed);
  assert.equal(seed.sampleData.brand.colors.primary, 'rgb(46 111 149)');
  assert.equal(seed.sampleData.brand.fonts.heading, "'Playfair Display', 'Times New Roman', serif");
  assert.equal(seed.sampleData.brand.logo, undefined, 'drlurie has no imageAssetRef, so no logo is fabricated');
  // Non-brand sample content (title, sections, sources, ...) travels verbatim.
  assert.equal(seed.sampleData.title, ARTICLE_BROCHURE_V1.sampleData.title);
  assert.deepEqual(seed.sampleData.sections, ARTICLE_BROCHURE_V1.sampleData.sections);
  assert.deepEqual(seed.sampleAssets, ARTICLE_BROCHURE_V1.sampleAssets);
  assert.deepEqual(seed.templateJson, ARTICLE_BROCHURE_V1.templateJson);
  assert.deepEqual(seed.renderDataSchema, ARTICLE_BROCHURE_V1.renderDataSchema);
});

test('ACCEPTANCE: the drlurie-branded sampleData validates against its own renderDataSchema', () => {
  const seed = buildBrandedArticleTemplateSeed({
    templateId: 'drlurie_article_v1',
    source: ARTICLE_BROCHURE_V1,
    siteBody: DRLURIE_SITE_BODY,
  });
  assert.ok(seed);
  const result = validateSeedSampleData(seed);
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('buildBrandedArticleTemplateSeed refuses to seed a site with no usable brandTokens', () => {
  const seed = buildBrandedArticleTemplateSeed({
    templateId: 'acme_article_v1',
    source: ARTICLE_BROCHURE_V1,
    siteBody: { name: 'Acme, no brand yet' },
  });
  assert.equal(seed, undefined);
});

test('validateSeedSampleData catches a brand swap that breaks the schema (e.g. an empty colors object)', () => {
  const seed = buildBrandedArticleTemplateSeed({
    templateId: 'drlurie_article_v1',
    source: ARTICLE_BROCHURE_V1,
    siteBody: DRLURIE_SITE_BODY,
  });
  assert.ok(seed);
  seed.sampleData.brand.colors = {};
  const result = validateSeedSampleData(seed);
  assert.equal(result.valid, false);
  assert.ok(result.errors.some((e) => e.includes('brand.colors')));
});
