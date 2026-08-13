import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

import {
  DEFAULT_FIDELITY_LIMITS,
  FidelityError,
  consolidatedGapReport,
  fidelityLimitsFromProject,
  normalizedScreenshotDiff,
  runBoundedFidelityIterations,
  scoreCaptureFidelity,
} from './score.mjs';

const directory = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const fixture = async (name) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));

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
  assert.deepEqual(first.rubric.coverage, {
    score: 0.1579,
    mappedBlocks: 3,
    relevantBlocks: 19,
    minimum: 0.9,
    met: false,
  });
  assert.equal(first.visual.scoredCount, 0);
  assert.equal(first.visual.unavailableCount, 38);
  assert.ok(first.pages.every((page) => page.structural.allGapsEnumerated));
  assert.deepEqual(first, await fixture('zilberman.fidelity-report.v1.golden.json'));
});

test('project-owned coverage rubric override uses the exact CMS-Agent contract seam and fails closed', () => {
  const project = {
    project: {
      id: 'fixture-target',
      capture_policy: {
        fidelity: {
          coverageRubricOverride: {
            minimumMappedBlockCoverage: 0.5,
            requireCompleteTokens: false,
            requireEnumeratedGaps: false,
          },
        },
      },
    },
  };
  assert.deepEqual(fidelityLimitsFromProject(project, 'fixture-target'), {
    structuralCoverage: 0.5,
    requireTokensComplete: false,
    requireGapsEnumerated: false,
    maxRounds: 3,
    source: 'target_project_contract_override',
  });
  assert.throws(() => fidelityLimitsFromProject(project, 'other-target'), FidelityError);
  assert.equal(
    fidelityLimitsFromProject(
      {
        project: {
          id: 'fixture-target',
          capture_policy: { fidelity: { coverageRubricOverride: { minimumMappedBlockCoverage: 0 } } },
        },
      },
      'fixture-target'
    ).structuralCoverage,
    0
  );
  assert.throws(
    () =>
      fidelityLimitsFromProject(
        {
          project: {
            id: 'fixture-target',
            capture_policy: { fidelity: { coverageRubricOverride: { minimumMappedBlockCoverage: 2 } } },
          },
        },
        'fixture-target'
      ),
    /structuralCoverage/
  );
  assert.throws(
    () =>
      fidelityLimitsFromProject(
        {
          project: {
            id: 'fixture-target',
            capture_policy: { fidelity: { coverageRubricOverride: { coverage: 0.5 } } },
          },
        },
        'fixture-target'
      ),
    /unknown field/
  );
  assert.throws(
    () =>
      fidelityLimitsFromProject(
        {
          project: {
            id: 'fixture-target',
            capture_policy: { fidelity: { coverageRubricOverride: { requireCompleteTokens: 'yes' } } },
          },
        },
        'fixture-target'
      ),
    /boolean/
  );
  assert.equal(
    fidelityLimitsFromProject(
      {
        project: {
          id: 'fixture-target',
          capturePolicy: { fidelity: { coverageRubricOverride: { minimumMappedBlockCoverage: 0 } } },
        },
      },
      'fixture-target'
    ).structuralCoverage,
    DEFAULT_FIDELITY_LIMITS.structuralCoverage
  );
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
    projectPolicy: {
      project: {
        id: 'fixture-target',
        capture_policy: { fidelity: { coverageRubricOverride: { minimumMappedBlockCoverage: 1 } } },
      },
    },
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
