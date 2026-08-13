import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import '../../../../sites/drlurie/config/policy-bindings.js';
import {
  checkBrandTokenValue,
  FALLBACK_COLORS,
  FALLBACK_FONTS,
  THEME_AXES,
  THEME_COLOR_KEYS,
} from '../../lib/registry/theme-tokens.js';
import { themeBodySchema } from '../../schema/bodies/theme-v1.js';
import { handleObjectVerb } from '../../server/lib/object-verbs.js';
import { objectRecordKey } from '../../server/lib/object-store-keys.js';
import { siteBody } from '../../../../sites/drlurie/seeds/site-seed-data.mjs';
import { extractTheme, renderThemeReport } from './theme.mjs';

async function fixturePath(name: string) {
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await readFile(path.join(root, 'astro.config.ts'));
      return path.join(root, 'packages/core/cli/capture/fixtures', name);
    } catch {
      root = path.dirname(root);
    }
  }
  throw new Error('Could not locate source fixture root.');
}

async function readFixture() {
  return JSON.parse(await readFile(await fixturePath('zilberman.snapshot.v1.redacted.json'), 'utf8'));
}

test('snapshot theme draft is total, schema-valid, and constrained to the token registry', async () => {
  const extraction = extractTheme(await readFixture());
  assert.equal(themeBodySchema.safeParse(extraction.body).success, true);
  assert.deepEqual(Object.keys(extraction.body.tokens.colors), THEME_COLOR_KEYS);
  for (const color of Object.values(extraction.body.tokens.colors))
    assert.equal(checkBrandTokenValue('color', color).ok, true);
  for (const font of Object.values(extraction.body.tokens.fonts))
    assert.equal(checkBrandTokenValue('font', font).ok, true);
  for (const [group, values] of Object.entries({
    layout: extraction.body.tokens.layout,
    shape: extraction.body.tokens.shape,
    type: extraction.body.tokens.type,
  }))
    for (const [key, value] of Object.entries(values)) assert.ok(THEME_AXES[group][key].values.includes(value));
  assert.match(renderThemeReport(extraction), /Theme extraction specimen/);
  assert.match(renderThemeReport(extraction), /Quantized axes/);
  assert.ok(extraction.report.swatches.filter((entry) => entry.confidence === 0).every((entry) => entry.fallback));
  for (const entry of extraction.report.swatches.filter((entry) => entry.fallback)) {
    assert.equal(entry.value, FALLBACK_COLORS[entry.key]);
  }
  assert.equal(extraction.body.tokens.fonts.serif, FALLBACK_FONTS.serif);
  assert.equal(extraction.body.tokens.fonts.heading, FALLBACK_FONTS.heading);
  assert.deepEqual(extraction.body, JSON.parse(await readFile(await fixturePath('zilberman.theme.v1.json'), 'utf8')));
  assert.equal(renderThemeReport(extraction), await readFile(await fixturePath('zilberman.theme-report.html'), 'utf8'));
  const hostile = structuredClone(extraction);
  hostile.report.gaps = ['<img src=x onerror=alert(1)>'];
  hostile.body.tokens.fonts.sans = 'x"><script>alert(1)</script>';
  assert.doesNotMatch(renderThemeReport(hostile), /<script>|<img src=x/);
});

test('invalid and quarantined snapshots fail closed', async () => {
  const snapshot = await readFixture();
  assert.throws(() => extractTheme({}), /snapshot\.v1/);
  assert.throws(
    () => extractTheme({ ...snapshot, diagnostics: { ...snapshot.diagnostics, quarantined: [{}] } }),
    /quarantined/
  );
});

test('site_apply_theme dry-run produces a clean exact-replace op for the extracted fixture theme', async () => {
  const extraction = extractTheme(await readFixture());
  const records = [
    {
      object_id: 'thm_fixture_capture',
      object_type: 'theme',
      schema_version: 'theme.v1',
      site: 'site_drlurie',
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
      status: 'active',
      body: extraction.body,
      publication: { published_time: null },
      history: [],
      version: 1,
      content_revision: 1,
    },
    {
      object_id: 'site_drlurie',
      object_type: 'site',
      schema_version: 'site.v1',
      site: 'site_drlurie',
      created_at: '2026-08-13T00:00:00.000Z',
      updated_at: '2026-08-13T00:00:00.000Z',
      status: 'active',
      body: structuredClone(siteBody),
      publication: { published_time: null },
      history: [],
      version: 1,
      content_revision: 1,
    },
  ];
  const blobs = new Map(
    records.map((record) => [objectRecordKey(record.object_type as never, record.object_id), JSON.stringify(record)])
  );
  let writes = 0;
  const store = {
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      writes += 1;
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
  const result = await handleObjectVerb(
    store,
    { action: 'apply_theme', theme_id: 'thm_fixture_capture', site_id: 'site_drlurie', dry_run: true },
    { kind: 'human', id: 'fixture', email: 'fixture@example.com' }
  );
  assert.equal(result.status, 200);
  const body = result.body as {
    eligible: boolean;
    apply_error?: unknown;
    op: { fields: { brandTokens: { colors: Record<string, string | null> } } };
  };
  assert.equal(body.eligible, true);
  assert.equal(body.apply_error, undefined);
  for (const [key, value] of Object.entries(extraction.body.tokens.colors))
    assert.equal(body.op.fields.brandTokens.colors[key], value);
  for (const key of Object.keys(siteBody.brandTokens.colors).filter((key) => key.startsWith('dark:'))) {
    assert.equal(body.op.fields.brandTokens.colors[key], null, `exact-replace unsets stale ${key}`);
  }
  assert.equal(writes, 0, 'dry-run must not write');
});
