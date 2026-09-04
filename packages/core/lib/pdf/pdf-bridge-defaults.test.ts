import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ARTICLE_PDF_REQUIREMENTS_DEFAULT,
  readSitePdfDefaults,
  resolvePdfDefaultFilename,
  resolvePdfDefaultTemplateId,
  resolvePdfJobKind,
  resolvePdfRequirementsDefault,
} from './pdf-bridge-defaults.js';

// ─── readSitePdfDefaults ────────────────────────────────────────────────────

test('readSitePdfDefaults reads defaultTemplateId and byKind off site.pdf', () => {
  const result = readSitePdfDefaults({
    name: 'Dr. Lurié',
    pdf: { defaultTemplateId: 'tpl_article_v1', byKind: { article: 'tpl_article_v1', sales_brochure: 'tpl_brochure_v1' } },
  });
  assert.deepEqual(result, {
    defaultTemplateId: 'tpl_article_v1',
    byKind: { article: 'tpl_article_v1', sales_brochure: 'tpl_brochure_v1' },
  });
});

test('readSitePdfDefaults returns undefined for a site with no pdf block at all', () => {
  assert.equal(readSitePdfDefaults({ name: 'no pdf block here' }), undefined);
  assert.equal(readSitePdfDefaults(undefined), undefined);
  assert.equal(readSitePdfDefaults('not an object'), undefined);
});

test('readSitePdfDefaults omits byKind when the site has none', () => {
  const result = readSitePdfDefaults({ pdf: { defaultTemplateId: 'tpl_article_v1' } });
  assert.deepEqual(result, { defaultTemplateId: 'tpl_article_v1' });
});

test('readSitePdfDefaults drops non-string byKind entries rather than throwing', () => {
  const result = readSitePdfDefaults({
    pdf: { defaultTemplateId: 'tpl_article_v1', byKind: { article: 'tpl_article_v1', broken: 42 } },
  });
  assert.deepEqual(result, { defaultTemplateId: 'tpl_article_v1', byKind: { article: 'tpl_article_v1' } });
});

// ─── resolvePdfDefaultTemplateId (D-1) ──────────────────────────────────────

test('resolvePdfDefaultTemplateId resolves byKind[kind] before the site-wide default', () => {
  const sitePdf = { defaultTemplateId: 'tpl_article_v1', byKind: { sales_brochure: 'tpl_brochure_v1' } };
  assert.equal(resolvePdfDefaultTemplateId(sitePdf, 'sales_brochure'), 'tpl_brochure_v1');
});

test('resolvePdfDefaultTemplateId falls back to defaultTemplateId when the kind has no pin', () => {
  const sitePdf = { defaultTemplateId: 'tpl_article_v1', byKind: { sales_brochure: 'tpl_brochure_v1' } };
  assert.equal(resolvePdfDefaultTemplateId(sitePdf, 'article'), 'tpl_article_v1');
  assert.equal(resolvePdfDefaultTemplateId(sitePdf, 'lead_magnet'), 'tpl_article_v1');
});

test('resolvePdfDefaultTemplateId falls back to defaultTemplateId when kind is undefined', () => {
  const sitePdf = { defaultTemplateId: 'tpl_article_v1', byKind: { article: 'tpl_article_v1' } };
  assert.equal(resolvePdfDefaultTemplateId(sitePdf, undefined), 'tpl_article_v1');
});

test('resolvePdfDefaultTemplateId resolves to undefined for a site with no site.pdf at all', () => {
  assert.equal(resolvePdfDefaultTemplateId(undefined, 'article'), undefined);
  assert.equal(resolvePdfDefaultTemplateId(undefined, undefined), undefined);
});

// ─── resolvePdfDefaultFilename (D-4) ─────────────────────────────────────────

test('resolvePdfDefaultFilename lets a caller-supplied filename win untouched', () => {
  assert.equal(resolvePdfDefaultFilename('custom-report.pdf', 'the-article-slug'), 'custom-report.pdf');
});

test('resolvePdfDefaultFilename defaults to <slug>.pdf when the caller omitted filename', () => {
  assert.equal(resolvePdfDefaultFilename(undefined, 'what-moisturizers-actually-do'), 'what-moisturizers-actually-do.pdf');
});

test('resolvePdfDefaultFilename resolves to undefined when both filename and slug are missing', () => {
  assert.equal(resolvePdfDefaultFilename(undefined, undefined), undefined);
});

// ─── resolvePdfRequirementsDefault (D-4) ────────────────────────────────────

test('resolvePdfRequirementsDefault applies the A4 article default only for kind article with no explicit requirements', () => {
  const result = resolvePdfRequirementsDefault('article', undefined);
  assert.deepEqual(result, {
    format: 'A4',
    orientation: 'portrait',
    pageCount: { min: 2 },
    maxBytes: 8_000_000,
  });
  // Returned object must be independent of the shared frozen constant.
  assert.notEqual(result, ARTICLE_PDF_REQUIREMENTS_DEFAULT);
});

test('resolvePdfRequirementsDefault lets caller-supplied requirements win untouched, even a partial one', () => {
  const explicit = { maxBytes: 2_000_000 };
  assert.equal(resolvePdfRequirementsDefault('article', explicit), explicit);
});

test('resolvePdfRequirementsDefault applies no default for a non-article kind', () => {
  assert.equal(resolvePdfRequirementsDefault('sales_brochure', undefined), undefined);
  assert.equal(resolvePdfRequirementsDefault(undefined, undefined), undefined);
});

// ─── resolvePdfJobKind ───────────────────────────────────────────────────────

test('resolvePdfJobKind keeps an explicit kind', () => {
  assert.equal(resolvePdfJobKind('sales_brochure'), 'sales_brochure');
});

test('resolvePdfJobKind defaults to article when the caller supplied none', () => {
  assert.equal(resolvePdfJobKind(undefined), 'article');
});
