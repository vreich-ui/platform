import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { CAPTURE_VIEWPORTS } from './browser.mjs';
import {
  DRAFT_PREVIEW_ROUTE_PREFIX,
  PREVIEW_SCHEMA_VERSION,
  PreviewError,
  buildDraftPreviewPlan,
  buildPreviewManifest,
  draftPageExport,
  emissionPlanOf,
  previewBlockSelector,
  previewBrandTokens,
} from './preview.mjs';
import { comparisonRaster } from './screenshot-normalize.mjs';

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'preview-fixture');
const runRoot = path.join(fixtureDir, 'run');
const runFixture = async (name) => JSON.parse(await readFile(path.join(runRoot, name), 'utf8'));

const section = (id, type = 'prose') => ({ id, type, data: { body: '<p>x</p>' } });
const pageBody = (route, sections, pageType = 'standard') => ({
  route,
  pageType,
  title: 'A page',
  seo: {},
  sections,
});
const syntheticPair = ({ pageType = 'standard', emittedSections, mappedSectionId = 's_one' } = {}) => {
  const mapping = {
    schemaVersion: 'capture-map.v1',
    pages: [
      {
        pageRef: 'page_one',
        sourceUrl: 'https://example.com/one',
        pageBody: pageBody('/one', [section(mappedSectionId)], pageType),
        candidates: [
          {
            candidateId: 'candidate_one',
            sectionType: 'prose',
            section: section(mappedSectionId),
            sourceBlockIds: ['page_one_block_001'],
          },
        ],
      },
    ],
  };
  const plan = {
    schemaVersion: 'capture-emission-plan.v1',
    target: 'fixture-target',
    pageRefs: ['page_one'],
    creates: [
      { kind: 'theme', objectType: 'theme', requestedId: 'thm_x', body: {} },
      {
        kind: 'page',
        objectType: 'page',
        requestedId: 'page_capture_abc',
        body: pageBody('/one', emittedSections ?? [section(mappedSectionId)], pageType),
      },
    ],
  };
  return { plan, mapping };
};

test('the shared browser plane pins the two capture viewports exactly', () => {
  // Source and preview must be shot at identical sizes or the per-block diff
  // is comparing two different layouts (T12.10 brief).
  assert.deepEqual(
    CAPTURE_VIEWPORTS.map(({ id, width, height }) => [id, width, height]),
    [
      ['mobile', 390, 844],
      ['desktop', 1440, 1000],
    ]
  );
});

test('a dry-run emission document and a live report both yield the plan', () => {
  const { plan } = syntheticPair();
  assert.equal(emissionPlanOf({ dryRun: true, plan }), plan);
  assert.equal(emissionPlanOf(plan), plan);
  assert.throws(() => emissionPlanOf({ schemaVersion: 'something-else' }), PreviewError);
});

test('draft pages are paired with their mapped source page and rehomed on the preview prefix', () => {
  const { plan, mapping } = syntheticPair();
  const { pages, defects } = buildDraftPreviewPlan({ plan, mapping });
  assert.deepEqual(defects, []);
  assert.equal(pages.length, 1);
  assert.equal(pages[0].pageRef, 'page_one');
  assert.equal(pages[0].pageObjectId, 'page_capture_abc');
  assert.equal(pages[0].emittedRoute, '/one');
  assert.equal(pages[0].previewRoute, `${DRAFT_PREVIEW_ROUTE_PREFIX}/page_capture_abc`);
  assert.deepEqual(pages[0].blocks, [
    { blockRef: 'page_one_block_001', candidateId: 'candidate_one', sectionId: 's_one' },
  ]);
  // The export carries the preview route, never the emitted one: a captured
  // home page claims '/', which the tenant already owns.
  assert.equal(draftPageExport(pages[0]).route, `${DRAFT_PREVIEW_ROUTE_PREFIX}/page_capture_abc`);
  assert.equal(draftPageExport(pages[0]).pageType, 'standard');
});

test('an unpairable plan stops the preview instead of guessing', () => {
  const { plan, mapping } = syntheticPair();
  assert.throws(
    () => buildDraftPreviewPlan({ plan: { ...plan, creates: [plan.creates[0]] }, mapping }),
    /refusing to guess the pairing/
  );
  assert.throws(
    () => buildDraftPreviewPlan({ plan: { ...plan, pageRefs: ['page_other'] }, mapping }),
    /does not match the mapping page order/
  );
  const rerouted = structuredClone(plan);
  rerouted.creates[1].body.route = '/elsewhere';
  assert.throws(() => buildDraftPreviewPlan({ plan: rerouted, mapping }), /does not carry mapped page/);
  assert.throws(() => buildDraftPreviewPlan({ plan, mapping: { schemaVersion: 'nope' } }), PreviewError);
});

test('every reason a draft cannot be previewed is an enumerated defect, never a silent drop', () => {
  // A section the mapper produced but the emitter did not carry: the block has
  // no rendered counterpart, and saying nothing is how 0/34 looked clean.
  const missingSection = syntheticPair({ emittedSections: [section('s_other')] });
  const missing = buildDraftPreviewPlan(missingSection);
  assert.equal(missing.pages[0].blocks.length, 0);
  assert.deepEqual(missing.defects.map((defect) => defect.code).sort(), [
    'mapped_section_absent_from_emitted_page',
    'page_has_no_previewable_block',
  ]);
  assert.ok(missing.defects.every((defect) => defect.severity === 'defect'));

  // A listing/content_detail page binds to a dedicated loader, not the
  // object-page catch-all, so it cannot be served at a preview route.
  const loaderOwned = buildDraftPreviewPlan(syntheticPair({ pageType: 'listing' }));
  assert.deepEqual(loaderOwned.pages, []);
  assert.deepEqual(
    loaderOwned.defects.map((defect) => defect.code),
    ['page_type_not_previewable']
  );
});

test('the captured theme reaches the preview as brandTokens, never through site_apply_theme', async () => {
  const theme = await runFixture('theme.v1.json');
  const tokens = previewBrandTokens(theme);
  assert.deepEqual(tokens.colors, theme.tokens.colors);
  assert.deepEqual(tokens.fonts, theme.tokens.fonts);
  assert.deepEqual(tokens.layout, theme.tokens.layout);
  assert.throws(() => previewBrandTokens({ tokens: { colors: {} } }), PreviewError);
});

test('the preview manifest records that nothing was published, released, or deployed', () => {
  const { plan, mapping } = syntheticPair();
  const manifest = buildPreviewManifest({
    target: 'fixture-target',
    plan,
    mapping,
    siteDir: 'sites/fernwell',
    previewSiteDir: '.tmp/capture-preview-fixture-target',
    themeApplied: true,
    pages: [],
    defects: [],
  });
  assert.equal(manifest.schemaVersion, PREVIEW_SCHEMA_VERSION);
  assert.equal(manifest.preview.published, false);
  assert.equal(manifest.preview.released, false);
  assert.equal(manifest.preview.deployed, false);
  assert.deepEqual(manifest.preview.refusedVerbs, [
    'deploy',
    'object_publish',
    'release_to_production',
    'trigger_netlify_build',
  ]);
  assert.deepEqual(
    manifest.viewports.map((viewport) => viewport.id),
    ['mobile', 'desktop']
  );
});

test('the preview block selector targets the rendered section, not its display:contents wrapper', () => {
  // The annotation element generates no box, so the screenshot must be of its
  // rendered child (section-annotations.ts wraps with style="display:contents").
  assert.equal(
    previewBlockSelector('page_capture_abc', 's_one'),
    '[data-cms-object-id="page_capture_abc"][data-cms-section-id="s_one"] > *'
  );
});

test('the committed fixture run holds a real preview screenshot for every emitted block', async () => {
  const [manifest, mapping] = await Promise.all([runFixture('capture-preview.v1.json'), runFixture('mapping.v1.json')]);
  assert.equal(manifest.schemaVersion, PREVIEW_SCHEMA_VERSION);
  assert.equal(manifest.preview.mechanism, 'local_astro_build_of_scratch_tenant_copy');
  assert.equal(manifest.preview.themeApplied, true);
  assert.deepEqual(manifest.defects, []);
  assert.equal(manifest.pages.length, mapping.pages.length);
  for (const page of manifest.pages) {
    assert.ok(page.previewRoute.startsWith(`${DRAFT_PREVIEW_ROUTE_PREFIX}/`));
    const mapped = mapping.pages.find((candidate) => candidate.pageRef === page.pageRef);
    const expected = (mapped.candidates ?? []).flatMap((candidate) => candidate.sourceBlockIds ?? []);
    for (const viewport of CAPTURE_VIEWPORTS) {
      const shot = page.screenshots.find((entry) => entry.viewportId === viewport.id && entry.kind === 'full-page');
      assert.ok(shot, `page ${page.pageRef} has no ${viewport.id} full-page preview`);
      assert.ok((await stat(path.join(runRoot, shot.path))).isFile());
      for (const blockRef of expected) {
        const block = page.blocks.find((entry) => entry.blockRef === blockRef && entry.viewportId === viewport.id);
        assert.ok(block, `no ${viewport.id} preview screenshot for ${blockRef}`);
        const info = await stat(path.join(runRoot, block.screenshotPath));
        assert.ok(info.isFile() && info.size > 0);
      }
    }
  }
});

test('the comparison raster is a pure function of the source dimensions', () => {
  assert.deepEqual(comparisonRaster({ width: 640, height: 480 }), { width: 320, height: 240 });
  assert.deepEqual(comparisonRaster({ width: 1440, height: 60_000 }), { width: 320, height: 4_096 });
  assert.deepEqual(comparisonRaster({ width: 1440, height: 1 }), { width: 320, height: 1 });
  assert.throws(() => comparisonRaster({ width: 0, height: 10 }), /dimensions/);
});
