import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { navigationBodySchema } from '../../schema/bodies/navigation-v1.js';
import { pageBodySchema } from '../../schema/bodies/page-v1.js';
import { sectionInstanceSchema } from '../../schema/bodies/section-v1.js';
import { REGISTERED_SECTION_TYPES } from '../../lib/registry/components/registered-types.js';
import { getPageTypeDefinition } from '../../lib/registry/page-types.js';
import { checkStructuralInvariants } from '../../server/lib/object-validate.js';
import { CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS, mapSnapshot } from './map.mjs';

async function readFixture(name: string) {
  let root = path.dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 8; depth += 1) {
    try {
      await readFile(path.join(root, 'astro.config.ts'));
      return JSON.parse(await readFile(path.join(root, 'packages/core/cli/capture/fixtures', name), 'utf8'));
    } catch {
      root = path.dirname(root);
    }
  }
  throw new Error('Could not locate source fixture root.');
}

test('redacted snapshot maps byte-for-byte to the checked-in golden artifact', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const golden = await readFixture('zilberman.mapping.v1.redacted.json');
  assert.deepEqual(mapSnapshot(snapshot), golden);
});

test('every emitted page, section, and navigation candidate uses the live schemas', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  for (const page of mapping.pages) {
    assert.equal(pageBodySchema.safeParse(page.pageBody).success, true, page.sourceUrl);
    for (const candidate of page.candidates) {
      assert.equal(REGISTERED_SECTION_TYPES.includes(candidate.sectionType as never), true, candidate.sectionType);
      assert.deepEqual(candidate.data, candidate.section.data);
      const parsed = sectionInstanceSchema.safeParse(candidate.section);
      assert.equal(parsed.success, true, parsed.success ? candidate.candidateId : JSON.stringify(parsed.error.issues));
    }
  }
  for (const candidate of mapping.navigationCandidates) {
    const parsed = navigationBodySchema.safeParse(candidate.body);
    assert.equal(parsed.success, true, parsed.success ? candidate.candidateId : JSON.stringify(parsed.error.issues));
    assert.ok(candidate.body.groups.every((group: { items: unknown[] }) => group.items.length > 0));
    assert.ok((candidate.body.actions?.length ?? 0) <= 3);
  }
});

test('every emitted page survives the live PageType structural contract unchanged', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  for (const page of mapping.pages) {
    const lookup = getPageTypeDefinition(page.pageBody.pageType);
    assert.equal(lookup.ok, true, page.pageBody.pageType);
    if (!lookup.ok) continue;
    const captureAllowed = CAPTURE_PAGE_TYPE_ALLOWED_SECTIONS[page.pageBody.pageType as 'home' | 'standard'];
    assert.deepEqual(
      captureAllowed === 'any' ? captureAllowed : [...captureAllowed],
      lookup.definition.allowedSections,
      `${page.pageBody.pageType} capture guard drifted from the registry`
    );
    const criteria = checkStructuralInvariants(
      'page',
      `candidate_${page.pageRef}`,
      page.pageBody,
      { pageType: lookup.definition },
      false
    );
    assert.equal(
      criteria.some((criterion) => criterion.id === 'structure_allowed' && criterion.status === 'missing'),
      false,
      JSON.stringify(criteria)
    );
  }
});

test('every source block is accounted exactly once and every copy field is tagged extracted', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  const mapping = mapSnapshot(snapshot);
  assert.equal(mapping.summary.sourceBlocks, mapping.summary.accountedBlocks);
  for (const page of mapping.pages) {
    assert.equal(
      new Set(page.blockAccounting.map((item: { blockRef: string }) => item.blockRef)).size,
      page.blockAccounting.length
    );
    for (const candidate of page.candidates) {
      assert.ok(candidate.provenance.textFields.length > 0);
      assert.ok(candidate.provenance.textFields.every((field: { source: string }) => field.source === 'extracted'));
      assert.ok(
        candidate.assetBindings.every(
          (asset: { sourceUrl: string }) => !JSON.stringify(candidate.section).includes(asset.sourceUrl)
        )
      );
    }
  }
});

test('quarantined input and unsafe thresholds fail closed', async () => {
  const snapshot = await readFixture('zilberman.snapshot.v1.redacted.json');
  assert.throws(
    () => mapSnapshot({ ...snapshot, diagnostics: { ...snapshot.diagnostics, quarantined: [{}] } }),
    /quarantined/
  );
  assert.throws(() => mapSnapshot(snapshot, { threshold: -0.1 }), /0\.\.1/);
});

test('assistance can choose a registered builder but cannot inject arbitrary section data', () => {
  const snapshot = {
    schemaVersion: 'snapshot.v1',
    capture: {
      capturedAt: '2026-08-13T00:00:00.000Z',
      targetUrl: 'https://example.com/',
      origin: 'https://example.com',
      redacted: false,
    },
    diagnostics: { quarantined: [] },
    pages: [
      {
        pageId: 'page_example',
        url: 'https://example.com/example',
        path: '/example',
        title: 'Example',
        metaDescription: null,
        outline: [{ tag: 'h1', level: 1, text: 'Example' }],
        navigation: { primary: [], footer: [] },
        assets: [],
        blocks: [
          {
            id: 'page_example_block_001',
            ordinal: 0,
            tag: 'section',
            text: { value: 'ExampleA body with enough deterministic content.' },
            links: [],
            assetUrls: [],
            boundingBoxes: { desktop: { width: 100, height: 100 } },
            screenshots: [{ captured: true, path: 'example.png' }],
          },
        ],
      },
    ],
  };
  const mapping = mapSnapshot(snapshot, {
    assistance: {
      suggestions: [
        { blockRef: 'page_example_block_001', sectionType: 'prose', data: { arbitrary: 'must be ignored' } },
      ],
    },
  });
  assert.equal(mapping.pages[0].candidates[0].sectionType, 'prose');
  assert.deepEqual(mapping.pages[0].candidates[0].section.data, {
    body: '<p>ExampleA body with enough deterministic content.</p>',
  });
});
