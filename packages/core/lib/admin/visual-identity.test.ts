import assert from 'node:assert/strict';
import test from 'node:test';

import { buildVisualIdentityViewModel } from './visual-identity.js';

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
        body: { name: 'Default editorial', tokens: { fonts: { sans: 'Example Sans', heading: 'Example Serif' }, colors: { accent: '#abcdef', primary: '#123456' } } },
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
    site: { object_id: 'site_example', object_type: 'site', body: {} } as unknown as import('./studio-client.js').StudioRecord,
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
