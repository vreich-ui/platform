import assert from 'node:assert/strict';
import test from 'node:test';

import { injectPdfRenderDataBrand, pdfRenderBrandFromSiteBody } from './pdf-render-brand.js';

const SITE_BODY_WITH_TOKENS: Record<string, unknown> = {
  name: 'Dr. Lurié',
  logo: { text: 'Dr. Lurié', imageAssetRef: 'image/site/logo-abc123.webp' },
  brandTokens: {
    colors: {
      primary: 'rgb(46 111 149)',
      accent: 'rgb(94 140 138)',
      'text-heading': 'rgb(22 26 29)',
      'text-default': 'rgb(36 41 46)',
      'text-muted': 'rgb(58 65 73 / 76%)',
      'bg-page': 'rgb(252 251 248)',
      'bg-surface': 'rgb(247 245 240)',
    },
    fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora', mono: 'JetBrains Mono' },
  },
};

const EXPECTED_COLORS: Record<string, string> = {
  primary: 'rgb(46 111 149)',
  accent: 'rgb(94 140 138)',
  'text-heading': 'rgb(22 26 29)',
  'text-default': 'rgb(36 41 46)',
  'text-muted': 'rgb(58 65 73 / 76%)',
  'bg-page': 'rgb(252 251 248)',
  'bg-surface': 'rgb(247 245 240)',
};

test('pdfRenderBrandFromSiteBody reads colors/fonts straight off brandTokens', () => {
  const brand = pdfRenderBrandFromSiteBody(SITE_BODY_WITH_TOKENS);
  assert.ok(brand);
  assert.deepEqual(brand!.colors, EXPECTED_COLORS);
  assert.deepEqual(brand!.fonts, { sans: 'Inter', serif: 'Lora', heading: 'Lora', mono: 'JetBrains Mono' });
});

// REVIEW (brand-imagery wave): `logo` is a pdf-tool ASSET ID, bound at
// https://render.assets.invalid/<assetId> and pattern-bounded to
// ^[a-zA-Z0-9._-]{1,128}$ by article_brochure_v1's own renderDataSchema. A
// platform Major-Key artifact ref (image/<req>/<sha>.png) is neither — it has
// slashes and no matching assets.images entry — so forwarding it verbatim put
// a permanently broken <img> on every branded cover.
test('pdfRenderBrandFromSiteBody never forwards a platform artifact ref as an assetId', () => {
  const brand = pdfRenderBrandFromSiteBody(SITE_BODY_WITH_TOKENS);
  assert.ok(brand);
  assert.equal(brand!.logo, undefined, 'a slashed blob key is not a renderable assetId');
});

test('pdfRenderBrandFromSiteBody forwards a logo ref that IS already a valid assetId', () => {
  const brand = pdfRenderBrandFromSiteBody({
    ...SITE_BODY_WITH_TOKENS,
    logo: { text: 'Dr. Lurié', imageAssetRef: 'brand-logo.png' },
  });
  assert.ok(brand);
  assert.equal(brand!.logo, 'brand-logo.png');
});

test('pdfRenderBrandFromSiteBody omits logo when the site has none', () => {
  const body: Record<string, unknown> = {
    brandTokens: {
      colors: { primary: '#123456' },
      fonts: { sans: 'Inter', serif: 'Lora', heading: 'Lora' },
    },
  };
  const brand = pdfRenderBrandFromSiteBody(body);
  assert.ok(brand);
  assert.equal(brand!.logo, undefined);
  assert.deepEqual(brand!.fonts, { sans: 'Inter', serif: 'Lora', heading: 'Lora' });
});

test('pdfRenderBrandFromSiteBody returns undefined for a site with no brandTokens', () => {
  assert.equal(pdfRenderBrandFromSiteBody(undefined), undefined);
  assert.equal(pdfRenderBrandFromSiteBody({ name: 'no tokens here' }), undefined);
});

test('pdfRenderBrandFromSiteBody returns undefined when brandTokens carries no usable colors', () => {
  assert.equal(
    pdfRenderBrandFromSiteBody({ brandTokens: { colors: {}, fonts: { sans: 'a', serif: 'b', heading: 'c' } } }),
    undefined
  );
});

test('pdfRenderBrandFromSiteBody returns undefined when a required font family is missing', () => {
  assert.equal(
    pdfRenderBrandFromSiteBody({ brandTokens: { colors: { primary: '#123456' }, fonts: { sans: 'Inter' } } }),
    undefined
  );
});

test('injectPdfRenderDataBrand fills data.brand from brandTokens when the caller supplied no brand', () => {
  const data = { title: 'Q3 Report', total: '$4,200' };
  const result = injectPdfRenderDataBrand(SITE_BODY_WITH_TOKENS, data) as Record<string, unknown>;
  assert.equal(result.title, 'Q3 Report');
  assert.equal(result.total, '$4,200');
  assert.deepEqual(result.brand, pdfRenderBrandFromSiteBody(SITE_BODY_WITH_TOKENS));
  // The original object is left untouched (a fresh object is returned).
  assert.equal((data as Record<string, unknown>).brand, undefined);
});

test('injectPdfRenderDataBrand builds a fresh { brand } object when the caller supplied no data at all', () => {
  const result = injectPdfRenderDataBrand(SITE_BODY_WITH_TOKENS, undefined) as Record<string, unknown>;
  assert.deepEqual(result, { brand: pdfRenderBrandFromSiteBody(SITE_BODY_WITH_TOKENS) });
});

test('injectPdfRenderDataBrand leaves a caller-supplied data.brand untouched', () => {
  const callerBrand = { colors: { primary: '#ffffff' }, fonts: { sans: 'Comic Sans', serif: 'x', heading: 'y' } };
  const data = { title: 'Custom-branded report', brand: callerBrand };
  const result = injectPdfRenderDataBrand(SITE_BODY_WITH_TOKENS, data);
  assert.deepEqual(result, data);
  assert.deepEqual((result as { brand: unknown }).brand, callerBrand);
});

test('injectPdfRenderDataBrand injects nothing for a site with no brandTokens', () => {
  const data = { title: 'No brand here' };
  const result = injectPdfRenderDataBrand({ name: 'no tokens' }, data);
  assert.deepEqual(result, data);
  assert.equal((result as Record<string, unknown>).brand, undefined);
});

test('injectPdfRenderDataBrand injects nothing when no site body is available at all', () => {
  const data = { title: 'No site' };
  assert.deepEqual(injectPdfRenderDataBrand(undefined, data), data);
  assert.equal(injectPdfRenderDataBrand(undefined, undefined), undefined);
});

test('injectPdfRenderDataBrand leaves a non-object data value untouched', () => {
  assert.equal(injectPdfRenderDataBrand(SITE_BODY_WITH_TOKENS, 'raw string data'), 'raw string data');
  assert.equal(injectPdfRenderDataBrand(SITE_BODY_WITH_TOKENS, 42), 42);
});
