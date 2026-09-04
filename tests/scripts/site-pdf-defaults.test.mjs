/**
 * T2.7 — tests for `scripts/lib/site-pdf-defaults.mjs`: the `site.pdf`
 * shape (ruling D-B) as a pure decision.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSitePdfDefaults,
  DRLURIE_SALES_BROCHURE_TEMPLATE_IDS,
  planSitePdfSeed,
} from '../../scripts/lib/site-pdf-defaults.mjs';

test('buildSitePdfDefaults: defaultTemplateId + byKind.article/lead_magnet all point at the seeded article template', () => {
  const defaults = buildSitePdfDefaults({ articleTemplateId: 'drlurie_article_v1' });
  assert.deepEqual(defaults, {
    defaultTemplateId: 'drlurie_article_v1',
    byKind: { article: 'drlurie_article_v1', lead_magnet: 'drlurie_article_v1' },
  });
});

test('buildSitePdfDefaults: byKind.sales_brochure pins the supplied brochure id, default stays the article template', () => {
  const defaults = buildSitePdfDefaults({
    articleTemplateId: 'drlurie_article_v1',
    salesBrochureTemplateId: DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.routine5Page,
  });
  assert.equal(defaults.defaultTemplateId, 'drlurie_article_v1');
  assert.equal(defaults.byKind.sales_brochure, '674a43bd-40c0-40ed-847a-67a9e0b4ec2c');
  assert.notEqual(defaults.defaultTemplateId, defaults.byKind.sales_brochure, 'neither brochure stays the site default');
});

test("drlurie's two hardcoded brochures are exactly the ids the brief names, and are distinct", () => {
  assert.equal(DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.niacinamide6Page, 'eca2337c-de69-4376-8645-75225caabfa0');
  assert.equal(DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.routine5Page, '674a43bd-40c0-40ed-847a-67a9e0b4ec2c');
  assert.notEqual(DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.niacinamide6Page, DRLURIE_SALES_BROCHURE_TEMPLATE_IDS.routine5Page);
});

test('planSitePdfSeed: set when site.pdf is entirely absent', () => {
  assert.equal(planSitePdfSeed(undefined).action, 'set');
});

test('planSitePdfSeed: set when site.pdf carries no defaultTemplateId yet', () => {
  assert.equal(planSitePdfSeed({}).action, 'set');
});

test('ACCEPTANCE: planSitePdfSeed is a no-op (already_present) once site.pdf.defaultTemplateId is set, regardless of value', () => {
  const first = planSitePdfSeed({ defaultTemplateId: 'drlurie_article_v1' });
  assert.equal(first.action, 'already_present');
  // Even a value a re-run would compute differently (e.g. a hypothetical v2)
  // is left alone -- genesis never overrules a prior seed or an operator edit.
  const edited = planSitePdfSeed({ defaultTemplateId: 'some_other_template_v2' });
  assert.equal(edited.action, 'already_present');
});
