import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  ASSET_DEFECT_CODE_UNEMITTED,
  DEFAULT_FIDELITY_LIMITS,
  FidelityError,
  VISUAL_DEFECT_CODES,
  consolidatedGapReport,
  fidelityLimitsFromProject,
  normalizedScreenshotDiff,
  runBoundedFidelityIterations,
  scoreCaptureFidelity,
} from './score.mjs';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));

// The T12.10 fixture: a synthetic two-page source site captured, mapped,
// emitted, PREVIEWED (local build of a scratch tenant), and scored — the whole
// pipeline with real screenshot bytes on both sides. Regenerate with
// `node scripts/capture-preview-fixture.mjs`.
const previewRunRoot = path.join(directory, 'preview-fixture', 'run');
const previewFixture = async (name) => JSON.parse(await readFile(path.join(previewRunRoot, name), 'utf8'));
const scorePreviewFixture = async () => {
  const [snapshot, mapping, theme, previewManifest] = await Promise.all([
    previewFixture('snapshot.v1.json'),
    previewFixture('mapping.v1.json'),
    previewFixture('theme.v1.json'),
    previewFixture('capture-preview.v1.json'),
  ]);
  return scoreCaptureFidelity({
    snapshot,
    mapping,
    theme,
    target: 'fixture-preview-target',
    previewManifest,
    screenshotRoot: previewRunRoot,
  });
};

async function scoreFixture(options = {}) {
  const [snapshot, mapping, theme] = await Promise.all([
    fixture('zilberman.snapshot.v1.redacted.json'),
    fixture('zilberman.mapping.v1.redacted.json'),
    fixture('zilberman.theme.v1.json'),
  ]);
  return scoreCaptureFidelity({ snapshot, mapping, theme, target: 'fixture-target', ...options });
}

test('fixture score is deterministic and records the ratified coverage-based rubric', async () => {
  const [first, second] = await Promise.all([scoreFixture(), scoreFixture()]);
  assert.deepEqual(first, second);
  assert.equal(first.limits.structuralCoverage, DEFAULT_FIDELITY_LIMITS.structuralCoverage);
  assert.equal(first.limits.source, 'ratified_default');
  assert.equal(first.source.capturePolicy.fidelityMode, 'design_inspired');
  assert.equal(first.source.capturePolicy.designReferences[0].origin, 'https://prconsulting.net');
  assert.equal(first.source.capturePolicy.designReferences[0].crawlAllowed, false);
  assert.equal(first.rubric.verdict, 'needs_governed_iteration');
  // T12.14 raised this from 3/19 = 15.79% to 10/19 = 52.63% by binding media
  // blocks instead of declining them. The bar is untouched at 90%: the verdict
  // is still `needs_governed_iteration`, and the residue is still enumerated.
  assert.deepEqual(first.rubric.coverage, {
    // 10/19 -> 17/19 with T12.29: captured pages declare pageType 'clone', so the seven blocks
    // the DTC `home` family used to discard from '/' (media, brand_row, content_split, prose) are
    // mapped instead of gapped. Still short of the 0.9 bar, deliberately unmoved.
    score: 0.8947,
    mappedBlocks: 17,
    relevantBlocks: 19,
    minimum: 0.9,
    met: false,
  });
  assert.equal(first.visual.scoredCount, 0);
  assert.equal(first.visual.unavailableCount, 38);
  // The 0/34 condition itself: unavailable evidence is a DEFECT, never a
  // neutral absence. 38 missing comparisons + 5 pages with nothing scored.
  assert.equal(first.visual.evidenceComplete, false);
  assert.equal(first.visual.defectCount, 43);
  assert.equal(first.visual.pagesWithoutScoredComparison.length, first.pages.length);
  assert.ok(first.visual.defects.every((defect) => defect.severity === 'defect' && typeof defect.code === 'string'));
  assert.equal(
    first.visual.defects.filter((defect) => defect.code === VISUAL_DEFECT_CODES.page_not_previewed).length,
    5
  );
  // …and the rubric is untouched by it: visual evidence explains, never authorizes.
  assert.equal(first.rubric.verdict, 'needs_governed_iteration');
  assert.ok(first.pages.every((page) => page.structural.allGapsEnumerated));
  assert.deepEqual(first, await fixture('zilberman.fidelity-report.v1.golden.json'));
});

// Every case here reads the ONE canonical shape: a ProjectCapturePolicy under
// the CMS-Agent ProjectSummary's `capturePolicy` key (T12.7).
const withOverride = (coverageRubricOverride, key = 'capturePolicy') => ({
  project: { projectId: 'fixture-target', [key]: { fidelity: { coverageRubricOverride } } },
});

test('project-owned coverage rubric override uses the exact CMS-Agent contract seam and fails closed', () => {
  const project = withOverride({
    minimumMappedBlockCoverage: 0.5,
    requireCompleteTokens: false,
    requireEnumeratedGaps: false,
  });
  assert.deepEqual(fidelityLimitsFromProject(project, 'fixture-target'), {
    structuralCoverage: 0.5,
    requireTokensComplete: false,
    requireGapsEnumerated: false,
    maxRounds: 3,
    source: 'target_project_contract_override',
  });
  assert.throws(() => fidelityLimitsFromProject(project, 'other-target'), FidelityError);
  const zeroed = { minimumMappedBlockCoverage: 0, requireCompleteTokens: true, requireEnumeratedGaps: true };
  assert.equal(fidelityLimitsFromProject(withOverride(zeroed), 'fixture-target').structuralCoverage, 0);
  // The snake_case envelope stays readable; the policy inside it does not change.
  assert.equal(
    fidelityLimitsFromProject(withOverride(zeroed, 'capture_policy'), 'fixture-target').structuralCoverage,
    0
  );
  assert.throws(
    () => fidelityLimitsFromProject(withOverride({ ...zeroed, minimumMappedBlockCoverage: 2 }), 'fixture-target'),
    /minimumMappedBlockCoverage/
  );
  assert.throws(() => fidelityLimitsFromProject(withOverride({ coverage: 0.5 }), 'fixture-target'), /unknown field/);
  assert.throws(
    () => fidelityLimitsFromProject(withOverride({ ...zeroed, requireCompleteTokens: 'yes' }), 'fixture-target'),
    /boolean/
  );
  // A partial override is a malformed contract, not a set of defaults to fill in.
  assert.throws(
    () => fidelityLimitsFromProject(withOverride({ minimumMappedBlockCoverage: 0.5 }), 'fixture-target'),
    /requireCompleteTokens/
  );
  // No override at all: the ratified default applies untouched.
  assert.deepEqual(fidelityLimitsFromProject(withOverride(undefined), 'fixture-target'), {
    structuralCoverage: DEFAULT_FIDELITY_LIMITS.structuralCoverage,
    requireTokensComplete: DEFAULT_FIDELITY_LIMITS.requireTokensComplete,
    requireGapsEnumerated: DEFAULT_FIDELITY_LIMITS.requireGapsEnumerated,
    maxRounds: DEFAULT_FIDELITY_LIMITS.maxRounds,
    source: 'ratified_default',
  });
});

test('the recorded Zilberman policy drives the scorer through the canonical envelope', async () => {
  const snapshot = await fixture('zilberman.snapshot.v1.redacted.json');
  const recorded = snapshot.capture.policy;
  const project = { project: { projectId: 'platform', capturePolicy: recorded } };
  // The live record declares no rubric override, so the 90% bar stands.
  assert.deepEqual(fidelityLimitsFromProject(project, 'platform'), {
    structuralCoverage: DEFAULT_FIDELITY_LIMITS.structuralCoverage,
    requireTokensComplete: true,
    requireGapsEnumerated: true,
    maxRounds: 3,
    source: 'ratified_default',
  });
  const report = await scoreFixture({ projectPolicy: project, target: 'platform' });
  assert.equal(report.limits.structuralCoverage, 0.9);
  assert.equal(report.source.capturePolicy.fidelityMode, 'design_inspired');
});

test('visual comparison uses normalized image bytes and reports unavailable evidence safely', async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 't12-5-score-'));
  try {
    const source = path.join(temporary, 'source.png');
    const same = path.join(temporary, 'same.png');
    const different = path.join(temporary, 'different.png');
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#204060' } })
      .png()
      .toFile(source);
    await sharp({ create: { width: 8, height: 8, channels: 3, background: '#204060' } })
      .png()
      .toFile(same);
    await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ffffff' } })
      .png()
      .toFile(different);
    assert.equal((await normalizedScreenshotDiff(source, same)).score, 1);
    assert.ok((await normalizedScreenshotDiff(source, different)).score < 0.5);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test('screenshot evidence paths cannot escape the run root', async () => {
  const snapshot = await fixture('zilberman.snapshot.v1.redacted.json');
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const theme = await fixture('zilberman.theme.v1.json');
  snapshot.pages[0].blocks[0].screenshots[0].path = '../../outside.png';
  await assert.rejects(
    () => scoreCaptureFidelity({ snapshot, mapping, theme, target: 'fixture-target', screenshotRoot: directory }),
    /escapes the run root/
  );
});

test('token completeness enforces the total T12.3 color, font, and axis contract', async () => {
  const snapshot = await fixture('zilberman.snapshot.v1.redacted.json');
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const theme = await fixture('zilberman.theme.v1.json');
  const partial = structuredClone(theme);
  delete partial.tokens.colors.gold;
  const report = await scoreCaptureFidelity({ snapshot, mapping, theme: partial, target: 'fixture-target' });
  assert.equal(report.rubric.tokensComplete.value, false);
  assert.equal(report.rubric.tokensComplete.met, false);
});

test('consolidated gap report retains every mapped gap as T10.7 evidence', async () => {
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const report = consolidatedGapReport(mapping);
  assert.equal(report.entries.length, mapping.summary.gaps);
  assert.ok(report.byCapability.some((entry) => entry.count >= 1));
  assert.deepEqual(report, await fixture('zilberman.palette-gap-report.v1.golden.json'));
});

test('bounded iterations admit only validated data edits and quarantine invalid proposals', async () => {
  const report = await scoreFixture({
    projectPolicy: withOverride({
      minimumMappedBlockCoverage: 1,
      requireCompleteTokens: true,
      requireEnumeratedGaps: true,
    }),
  });
  const applied = [];
  const result = await runBoundedFidelityIterations({
    report,
    propose: async () => [
      { kind: 'theme_axis', axis: 'layout.sectionRhythm', value: 'airy' },
      { kind: 'section_config', sectionId: 's_1', value: 'bad' },
    ],
    validateProposal: async (proposal) =>
      proposal.kind === 'theme_axis' ? { valid: true } : { valid: false, reason: 'schema_validation_failed' },
    applyDraftEdit: async (proposal) => {
      applied.push(proposal);
      return { objectId: 'draft_theme' };
    },
    rescore: async () => ({ ...report, rubric: { ...report.rubric, verdict: 'within_reasonable_limits' } }),
  });
  assert.equal(applied.length, 1);
  assert.equal(result.iterations.length, 1);
  assert.equal(result.iterations[0].proposals[1].status, 'quarantined');
  await assert.rejects(
    () =>
      runBoundedFidelityIterations({
        report,
        propose: async () => [{ kind: 'section_config', css: 'display:none' }],
        validateProposal: async () => ({ valid: true }),
        applyDraftEdit: async () => ({}),
        rescore: async () => report,
      }),
    /CSS/
  );
  await assert.rejects(
    () =>
      runBoundedFidelityIterations({
        report,
        propose: async () => [{ kind: 'section_config', value: { style: 'display:none' } }],
        validateProposal: async () => ({ valid: true }),
        applyDraftEdit: async () => ({}),
        rescore: async () => report,
      }),
    /CSS/
  );
});

test('the draft-preview fixture scores at least one visual comparison per emitted page', async () => {
  const report = await scorePreviewFixture();
  assert.ok(report.pages.length >= 2, 'fixture must cover more than one page');
  for (const page of report.pages) {
    const scored = report.visual.comparisons.filter(
      (comparison) => comparison.pageRef === page.pageRef && comparison.status === 'scored'
    );
    assert.ok(scored.length >= 1, `page ${page.pageRef} has no scored visual comparison`);
    assert.ok(
      new Set(scored.map((comparison) => comparison.viewportId)).size === 2,
      `page ${page.pageRef} must be scored at both capture viewports`
    );
  }
  assert.equal(report.visual.pagesWithoutScoredComparison.length, 0);
  assert.ok(report.visual.aggregateScore > 0 && report.visual.aggregateScore <= 1);
  // Every scored comparison went through the common comparison raster.
  assert.ok(
    report.visual.comparisons
      .filter((comparison) => comparison.status === 'scored')
      .every((comparison) => comparison.normalization === 'flatten_rgb_common_raster.v1')
  );
  // Evidence still missing for blocks the mapper never mapped: reported as
  // defects that name the gap, not quietly dropped.
  for (const defect of report.visual.defects) {
    assert.equal(defect.severity, 'defect');
    assert.equal(defect.blockStatus, 'gap');
    assert.equal(typeof defect.gapId, 'string');
  }
});

test('draft-preview fixture scores are reproducible across runs on the same input', async () => {
  const [first, second] = await Promise.all([scorePreviewFixture(), scorePreviewFixture()]);
  assert.deepEqual(first.visual, second.visual);
  assert.deepEqual(first, second);
  // …and match the report committed with the fixture run.
  const committed = await previewFixture('fidelity-report.v1.json');
  assert.deepEqual(first.visual, committed.visual);
  assert.deepEqual(first.rubric, committed.rubric);
});

test('a preview manifest that names no screenshot leaves every comparison a defect', async () => {
  const [snapshot, mapping, theme] = await Promise.all([
    previewFixture('snapshot.v1.json'),
    previewFixture('mapping.v1.json'),
    previewFixture('theme.v1.json'),
  ]);
  const report = await scoreCaptureFidelity({
    snapshot,
    mapping,
    theme,
    target: 'fixture-preview-target',
    previewManifest: { schemaVersion: 'capture-preview.v1', pages: [] },
    screenshotRoot: previewRunRoot,
  });
  assert.equal(report.visual.scoredCount, 0);
  assert.equal(report.visual.evidenceComplete, false);
  assert.equal(
    report.visual.defectCount,
    report.visual.unavailableCount + report.visual.pagesWithoutScoredComparison.length
  );
  assert.ok(
    report.visual.defects.some((defect) => defect.code === VISUAL_DEFECT_CODES.draft_preview_screenshot_not_available)
  );
});

// ─── T12.14 asset-binding evidence ───────────────────────────────────────────

test('unbound asset sections are enumerated defects and the rubric is untouched', async () => {
  const mapping = await fixture('zilberman.mapping.v1.redacted.json');
  const planned = mapping.pages.flatMap((page) => page.candidates.filter((candidate) => candidate.assetPlan));
  // 7 -> 10 with T12.29: three more asset-bearing sections survive on '/', where the DTC `home`
  // family had been discarding them before they could ever reach an asset plan.
  assert.equal(planned.length, 10);

  // Without an emission report the binding is simply not verified — reported as
  // such, never as clean.
  const unverified = await scoreFixture();
  assert.equal(unverified.assets.plannedSections, 10);
  assert.equal(unverified.assets.evidenceComplete, null);
  assert.equal(unverified.assets.reason, 'no_emission_report_supplied_binding_not_verified');

  // A run where nothing bound: every planned section is a DEFECT carrying the
  // emitter's own reason, and the acceptance rubric is byte-identical.
  const nothingBound = await scoreFixture({
    emissionReport: {
      assetBindings: [],
      assetGaps: planned.map((candidate) => ({
        gapId: `gap_${candidate.candidateId}`,
        sectionId: candidate.section.id,
        why: 'asset_binding_unresolved',
        missingCapability: '0/1 planned asset(s) resolved to a first-party artifact path',
      })),
    },
  });
  assert.equal(nothingBound.assets.evidenceComplete, false);
  assert.equal(nothingBound.assets.defectCount, 10);
  assert.equal(nothingBound.assets.boundSections, 0);
  assert.ok(
    nothingBound.assets.defects.every(
      (defect) => defect.severity === 'defect' && defect.code === 'asset_binding_unresolved' && defect.gapId
    )
  );
  assert.deepEqual(nothingBound.rubric, unverified.rubric);

  // A run where everything bound: evidence complete, still no rubric movement.
  const allBound = await scoreFixture({
    emissionReport: {
      assetBindings: planned.map((candidate) => ({ sectionId: candidate.section.id, status: 'bound' })),
      assetGaps: [],
    },
  });
  assert.equal(allBound.assets.evidenceComplete, true);
  assert.equal(allBound.assets.defectCount, 0);
  assert.equal(allBound.assets.boundSections, 10);
  assert.deepEqual(allBound.rubric, unverified.rubric);

  // A section emission never mentioned at all is still a defect, not a silence.
  const silent = await scoreFixture({ emissionReport: { assetBindings: [], assetGaps: [] } });
  assert.equal(silent.assets.defectCount, 10);
  assert.ok(silent.assets.defects.every((defect) => defect.code === ASSET_DEFECT_CODE_UNEMITTED));
});
