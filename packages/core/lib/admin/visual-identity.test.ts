import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSetSiteLogoOp, buildVisualIdentityViewModel } from './visual-identity.js';

const site = {
  object_id: 'site_example',
  object_type: 'site',
  body: {
    name: 'Example Journal',
    logo: { text: 'EXAMPLE', imageAssetRef: 'image/private-reference/logo.svg' },
    urls: { base: '/journal' },
    brandTokens: {
      colors: { primary: '#123456', accent: '#abcdef' },
      fonts: { heading: 'Example Serif', sans: 'Example Sans' },
    },
  },
} as unknown as import('./studio-client.js').StudioRecord;

test('visual identity lens treats site tokens as active and finds a matching named theme', () => {
  const model = buildVisualIdentityViewModel({
    site,
    fallbackName: 'Fallback',
    themes: [
      {
        object_id: 'thm_default',
        object_type: 'theme',
        body: {
          name: 'Default editorial',
          tokens: {
            fonts: { sans: 'Example Sans', heading: 'Example Serif' },
            colors: { accent: '#abcdef', primary: '#123456' },
          },
        },
      } as unknown as import('./studio-client.js').StudioRecord,
    ],
    artifacts: [],
  });

  assert.equal(model.publicationName, 'Example Journal');
  assert.equal(model.logoText, 'EXAMPLE');
  assert.equal(model.logoImageConfigured, true);
  assert.equal(model.activeThemeLabel, 'Default editorial');
  assert.deepEqual(model.colors, [
    { name: 'primary', value: '#123456' },
    { name: 'accent', value: '#abcdef' },
  ]);
  assert.equal(model.previewUrl, '/journal');
});

test('visual identity lens is safe with partial site data and only uses an available logo as a preview', () => {
  const model = buildVisualIdentityViewModel({
    site: {
      object_id: 'site_example',
      object_type: 'site',
      body: {},
    } as unknown as import('./studio-client.js').StudioRecord,
    fallbackName: 'Fallback publication',
    themes: [],
    artifacts: [
      {
        id: 'asset-1',
        kind: 'image',
        family: 'logos',
        label: 'Publication wordmark',
        filename: 'wordmark.svg',
        preview_url: '/preview',
        created_at: '2026-08-01T00:00:00Z',
        size_bytes: 1,
        tags: [],
      },
    ],
  });

  assert.equal(model.logoText, 'Fallback publication');
  assert.equal(model.logoImageConfigured, false);
  assert.equal(model.availableLogo?.label, 'Publication wordmark');
  assert.equal(model.previewUrl, undefined);
});

test('visual identity lens does not turn an untrusted site value into a preview URL', () => {
  const model = buildVisualIdentityViewModel({
    site: {
      object_id: 'site_example',
      object_type: 'site',
      body: { urls: { base: 'javascript:alert(1)' } },
    } as unknown as import('./studio-client.js').StudioRecord,
    fallbackName: 'Fallback publication',
    themes: [],
    artifacts: [],
  });
  assert.equal(model.previewUrl, undefined);
});

// ─── buildSetSiteLogoOp (T2.2) ──────────────────────────────────────────────

const MAJOR_KEY_REF = 'image/req_abc123/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.png';

test('buildSetSiteLogoOp emits the exact set_site_fields op for a valid Major Key ref', () => {
  assert.deepEqual(buildSetSiteLogoOp({ artifactRef: MAJOR_KEY_REF }), {
    op: 'set_site_fields',
    fields: { logo: { imageAssetRef: MAJOR_KEY_REF } },
  });
});

test('buildSetSiteLogoOp refuses a non-Major-Key string rather than emit a half-op', () => {
  assert.equal(buildSetSiteLogoOp({ artifactRef: '/img/req_abc123/aaaa.png' }), undefined);
  assert.equal(buildSetSiteLogoOp({ artifactRef: 'not-a-ref-at-all' }), undefined);
});

test('buildSetSiteLogoOp refuses an empty or missing artifactRef', () => {
  assert.equal(buildSetSiteLogoOp({ artifactRef: '' }), undefined);
  assert.equal(buildSetSiteLogoOp({ artifactRef: '   ' }), undefined);
  assert.equal(buildSetSiteLogoOp({}), undefined);
});

test('buildSetSiteLogoOp never emits brandTokens, brandImagery or tracking — only logo', () => {
  const op = buildSetSiteLogoOp({ artifactRef: MAJOR_KEY_REF });
  assert.ok(op);
  assert.deepEqual(Object.keys(op.fields), ['logo']);
});
