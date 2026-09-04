import assert from 'node:assert/strict';
import test from 'node:test';

import {
  classifyRenderDataBrandSlot,
  injectPdfRenderDataBrand,
  injectPdfRenderDataBrandForSlot,
  injectPdfRenderDataBrandString,
  pdfRenderBrandFromSiteBody,
  pdfRenderBrandNameFromSiteBody,
} from './pdf-render-brand.js';

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

// ─── D-3 (BRIEF-W2.md §3, T2.2): classifyRenderDataBrandSlot ───────────────
// The 2026-09-03 incident: this bridge injected `data.brand` as an object
// into ANY templateId'd pdf job, with no regard for what that template's own
// renderDataSchema slots `brand` AS. A string-typed slot rendered the
// literal text "[object Object]". These are the regression tests.

test('classifyRenderDataBrandSlot: a directly object-typed brand slot classifies as object', () => {
  const schema = { properties: { brand: { type: 'object', properties: { colors: {}, fonts: {} } } } };
  assert.equal(classifyRenderDataBrandSlot(schema), 'object');
});

test('classifyRenderDataBrandSlot: a directly string-typed brand slot classifies as string, never object', () => {
  const schema = { properties: { brand: { type: 'string' } } };
  assert.equal(classifyRenderDataBrandSlot(schema), 'string');
});

test('classifyRenderDataBrandSlot: a $ref to an object $def resolves to object (article_brochure_v1 shape)', () => {
  const schema = {
    properties: { brand: { $ref: '#/$defs/brand' } },
    $defs: { brand: { type: 'object', properties: { colors: {}, fonts: {} } } },
  };
  assert.equal(classifyRenderDataBrandSlot(schema), 'object');
});

test('classifyRenderDataBrandSlot: a $ref to a string $def resolves to string', () => {
  const schema = {
    properties: { brand: { $ref: '#/$defs/brandName' } },
    $defs: { brandName: { type: 'string' } },
  };
  assert.equal(classifyRenderDataBrandSlot(schema), 'string');
});

test('classifyRenderDataBrandSlot: also supports the older #/definitions/ ref form', () => {
  const schema = {
    properties: { brand: { $ref: '#/definitions/brand' } },
    definitions: { brand: { type: 'object' } },
  };
  assert.equal(classifyRenderDataBrandSlot(schema), 'object');
});

test('classifyRenderDataBrandSlot: an unresolved $ref classifies as none rather than guessing', () => {
  const schema = { properties: { brand: { $ref: '#/$defs/missing' } }, $defs: {} };
  assert.equal(classifyRenderDataBrandSlot(schema), 'none');
});

test('classifyRenderDataBrandSlot: a brand schema with properties but no explicit type is treated as object', () => {
  const schema = { properties: { brand: { properties: { colors: {} } } } };
  assert.equal(classifyRenderDataBrandSlot(schema), 'object');
});

test('classifyRenderDataBrandSlot: no properties.brand at all classifies as none', () => {
  assert.equal(classifyRenderDataBrandSlot({ properties: { title: { type: 'string' } } }), 'none');
  assert.equal(classifyRenderDataBrandSlot({ properties: {} }), 'none');
});

test('classifyRenderDataBrandSlot: no schema at all (undefined, or not an object) classifies as none', () => {
  assert.equal(classifyRenderDataBrandSlot(undefined), 'none');
  assert.equal(classifyRenderDataBrandSlot('not a schema'), 'none');
  assert.equal(classifyRenderDataBrandSlot(null), 'none');
});

// ─── pdfRenderBrandNameFromSiteBody / injectPdfRenderDataBrandString ───────

test('pdfRenderBrandNameFromSiteBody reads the site display name', () => {
  assert.equal(pdfRenderBrandNameFromSiteBody(SITE_BODY_WITH_TOKENS), 'Dr. Lurié');
});

test('pdfRenderBrandNameFromSiteBody returns undefined for a site with no usable name', () => {
  assert.equal(pdfRenderBrandNameFromSiteBody(undefined), undefined);
  assert.equal(pdfRenderBrandNameFromSiteBody({ name: '   ' }), undefined);
  assert.equal(pdfRenderBrandNameFromSiteBody({}), undefined);
});

/**
 * W2 REVIEW: this fills `data.brand` — the slot the template actually
 * declares — with a STRING. It used to fill `data.brandName`, a key no such
 * schema declares: `additionalProperties: false` fails that at job creation
 * (RENDER_DATA_INVALID) and the still-unbound `{{ brand }}` fails the render
 * (DATA_BINDING_ERROR), so the "fix" for `[object Object]` was a hard double
 * failure. These tests pin the corrected direction in both directions.
 */
test('injectPdfRenderDataBrandString fills data.brand with the site NAME when the caller supplied none', () => {
  const result = injectPdfRenderDataBrandString(SITE_BODY_WITH_TOKENS, { title: 'Report' }) as Record<string, unknown>;
  assert.deepEqual(result, { title: 'Report', brand: 'Dr. Lurié' });
  assert.equal(typeof result.brand, 'string', 'a string slot gets a string, never an object');
  assert.equal('brandName' in result, false, 'never a key the template schema does not declare');
});

test('injectPdfRenderDataBrandString leaves a caller-supplied brand untouched', () => {
  const data = { title: 'Report', brand: 'Custom Brand' };
  assert.deepEqual(injectPdfRenderDataBrandString(SITE_BODY_WITH_TOKENS, data), data);
});

test('injectPdfRenderDataBrandString injects nothing for a site with no usable name', () => {
  const data = { title: 'Report' };
  assert.deepEqual(injectPdfRenderDataBrandString({}, data), data);
  assert.equal((injectPdfRenderDataBrandString({}, data) as Record<string, unknown>).brand, undefined);
});

test('injectPdfRenderDataBrandString leaves a non-object data value untouched', () => {
  assert.equal(injectPdfRenderDataBrandString(SITE_BODY_WITH_TOKENS, 'raw string data'), 'raw string data');
  assert.equal(injectPdfRenderDataBrandString(SITE_BODY_WITH_TOKENS, 42), 42);
});

// ─── injectPdfRenderDataBrandForSlot: the top-level D-3 decision ───────────
// The exact regression this wave fixes: `brand` is always the slot written,
// and its TYPE follows what the template's own schema declares — the object
// for an object slot, the site's name as a plain string for a string slot,
// and nothing at all when the template declares neither.

test('injectPdfRenderDataBrandForSlot: an object slot gets the brand OBJECT', () => {
  const result = injectPdfRenderDataBrandForSlot('object', SITE_BODY_WITH_TOKENS, { title: 'Report' }) as Record<
    string,
    unknown
  >;
  assert.deepEqual(result.brand, pdfRenderBrandFromSiteBody(SITE_BODY_WITH_TOKENS));
  assert.equal(result.brandName, undefined);
});

test('injectPdfRenderDataBrandForSlot: a string slot gets brand as a STRING, never the object', () => {
  const result = injectPdfRenderDataBrandForSlot('string', SITE_BODY_WITH_TOKENS, { title: 'Report' }) as Record<
    string,
    unknown
  >;
  assert.equal(result.brand, 'Dr. Lurié');
  assert.equal(typeof result.brand, 'string');
  assert.equal(result.brandName, undefined, 'no undeclared key reaches an additionalProperties:false schema');
});

test('injectPdfRenderDataBrandForSlot: none injects neither brand nor brandName, even with usable brandTokens', () => {
  const data = { title: 'Report' };
  const result = injectPdfRenderDataBrandForSlot('none', SITE_BODY_WITH_TOKENS, data);
  assert.deepEqual(result, data);
  assert.equal((result as Record<string, unknown>).brand, undefined);
  assert.equal((result as Record<string, unknown>).brandName, undefined);
});
