#!/usr/bin/env node
/**
 * T12.5 capture fidelity scoring.
 *
 * This module deliberately separates visual evidence from the ratified
 * release bar. A capture is accepted on governed coverage, theme completeness,
 * and explicit gaps; image diffs explain where a draft differs but never
 * authorize arbitrary CSS or a publish/release action.
 */
import { readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

export const DEFAULT_FIDELITY_LIMITS = Object.freeze({
  structuralCoverage: 0.9,
  requireTokensComplete: true,
  requireGapsEnumerated: true,
  maxRounds: 3,
});
export const MAX_FIDELITY_ROUNDS = 5;
export const FIDELITY_SCHEMA_VERSION = 'capture-fidelity-report.v1';
export const PALETTE_GAP_SCHEMA_VERSION = 'capture-palette-gaps.v1';

export class FidelityError extends Error {}

const clone = (value) => JSON.parse(JSON.stringify(value));
const round = (value, places = 4) => Number(Number(value).toFixed(places));
const mappedStatuses = new Set(['mapped', 'mapped_with_gap']);
const nonContentStatuses = new Set(['duplicate', 'merged', 'ignored_noncontent']);
const forbiddenProposalKeys = new Set(['css', 'style', 'stylesheet', 'html', 'script']);

function containsForbiddenProposalKey(value) {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some(containsForbiddenProposalKey);
  return Object.entries(value).some(
    ([key, child]) => forbiddenProposalKeys.has(key.toLowerCase()) || containsForbiddenProposalKey(child)
  );
}

function payload(result) {
  return result?.data ?? result?.structuredContent?.data ?? result?.structuredContent ?? result;
}

function targetId(result) {
  const value = payload(result);
  const project = value?.project ?? value;
  return project?.id ?? project?.project_id ?? project?.projectId ?? null;
}

/** Reads the project-owned override while retaining a bounded local ceiling. */
export function fidelityLimitsFromProject(result, target) {
  if (result && targetId(result) !== target) throw new FidelityError(`Target binding mismatch: expected ${target}.`);
  const value = payload(result);
  const project = value?.project ?? value;
  const fidelity = project?.capture_policy?.fidelity ?? {};
  // This is the CMS-Agent project-registry seam. Do not infer an alternate
  // spelling: a malformed contract must stop the run rather than weaken it.
  const supplied = fidelity.coverageRubricOverride;
  if (supplied !== undefined && (supplied === null || typeof supplied !== 'object' || Array.isArray(supplied)))
    throw new FidelityError('Project coverageRubricOverride must be an object when supplied.');
  const override = supplied ?? {};
  const allowed = new Set(['minimumMappedBlockCoverage', 'requireCompleteTokens', 'requireEnumeratedGaps']);
  for (const key of Object.keys(override))
    if (!allowed.has(key)) throw new FidelityError(`Project coverageRubricOverride has unknown field ${key}.`);
  const coverage = override.minimumMappedBlockCoverage ?? DEFAULT_FIDELITY_LIMITS.structuralCoverage;
  const maxRounds = DEFAULT_FIDELITY_LIMITS.maxRounds;
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1)
    throw new FidelityError('Project structuralCoverage must be in [0, 1].');
  if (override.requireCompleteTokens !== undefined && typeof override.requireCompleteTokens !== 'boolean')
    throw new FidelityError('Project requireCompleteTokens must be boolean.');
  if (override.requireEnumeratedGaps !== undefined && typeof override.requireEnumeratedGaps !== 'boolean')
    throw new FidelityError('Project requireEnumeratedGaps must be boolean.');
  return {
    structuralCoverage: coverage,
    requireTokensComplete: override.requireCompleteTokens ?? DEFAULT_FIDELITY_LIMITS.requireTokensComplete,
    requireGapsEnumerated: override.requireEnumeratedGaps ?? DEFAULT_FIDELITY_LIMITS.requireGapsEnumerated,
    maxRounds,
    source: Object.keys(override).length ? 'target_project_contract_override' : 'ratified_default',
  };
}

function sourcePage(snapshot, pageRef) {
  const page = (snapshot.pages ?? []).find((candidate) => candidate.pageId === pageRef);
  if (!page) throw new FidelityError(`Snapshot has no page for mapping pageRef ${pageRef}.`);
  return page;
}

function isThemeComplete(theme) {
  const tokens = theme?.tokens;
  const required = {
    colors: [
      'primary',
      'secondary',
      'accent',
      'gold',
      'text-heading',
      'text-default',
      'text-muted',
      'bg-page',
      'bg-surface',
      'bg-page-dark',
    ],
    fonts: ['sans', 'serif', 'heading'],
    layout: ['containerWidth', 'sectionRhythm'],
    shape: ['radius', 'buttonShape', 'shadow'],
    type: ['scale', 'headingWeight'],
  };
  return (
    Boolean(tokens) &&
    Object.entries(required).every(([group, keys]) =>
      keys.every((key) => typeof tokens[group]?.[key] === 'string' && tokens[group][key].trim().length > 0)
    )
  );
}

function pageStructure(page) {
  const relevant = (page.blockAccounting ?? []).filter((entry) => !nonContentStatuses.has(entry.status));
  const accounted = new Set(relevant.map((entry) => entry.blockRef));
  const mapped = relevant.filter((entry) => mappedStatuses.has(entry.status));
  const gapIds = new Set((page.gaps ?? []).map((gap) => gap.gapId));
  const allGapsEnumerated = relevant
    .filter((entry) => entry.status === 'gap' || entry.status === 'mapped_with_gap')
    .every((entry) => typeof entry.gapId === 'string' && gapIds.has(entry.gapId));
  const sections = page.pageBody?.sections ?? [];
  const expectedIds = (page.candidates ?? []).map((candidate) => candidate.section?.id).filter(Boolean);
  const emittedIds = sections.map((section) => section.id).filter(Boolean);
  const expectedOrder = expectedIds.join('\0');
  const emittedOrder = emittedIds.filter((id) => expectedIds.includes(id)).join('\0');
  const orderFidelity = expectedIds.length === 0 ? 1 : expectedOrder === emittedOrder ? 1 : 0;
  return {
    sourceBlocks: relevant.length,
    mappedBlocks: mapped.length,
    mappedBlockCoverage: relevant.length ? round(mapped.length / relevant.length) : 1,
    accountedBlocks: accounted.size,
    allGapsEnumerated,
    orderFidelity,
    expectedSectionIds: expectedIds,
    emittedSectionIds: emittedIds,
  };
}

function previewLookup(previewManifest) {
  const result = new Map();
  for (const page of previewManifest?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      if (!page.pageRef || !block.blockRef || !block.viewportId || !block.screenshotPath) continue;
      result.set(`${page.pageRef}\0${block.blockRef}\0${block.viewportId}`, block.screenshotPath);
    }
  }
  return result;
}

async function readableFile(file) {
  if (!file) return false;
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

function evidencePath(root, relativePath) {
  if (typeof relativePath !== 'string' || path.isAbsolute(relativePath)) {
    throw new FidelityError('Screenshot evidence paths must be relative to the run root.');
  }
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, relativePath);
  const withinRoot = path.relative(resolvedRoot, resolved);
  if (withinRoot === '..' || withinRoot.startsWith(`..${path.sep}`)) {
    throw new FidelityError('Screenshot evidence path escapes the run root.');
  }
  return resolved;
}

/** Pixel score after deterministic RGBA flattening and resize to source dimensions. */
export async function normalizedScreenshotDiff(sourcePath, previewPath) {
  const [sourceMeta, previewMeta] = await Promise.all([sharp(sourcePath).metadata(), sharp(previewPath).metadata()]);
  if (!sourceMeta.width || !sourceMeta.height || !previewMeta.width || !previewMeta.height)
    throw new FidelityError('Screenshot dimensions are unavailable.');
  const source = await sharp(sourcePath).flatten({ background: '#ffffff' }).removeAlpha().raw().toBuffer();
  const preview = await sharp(previewPath)
    .flatten({ background: '#ffffff' })
    .resize(sourceMeta.width, sourceMeta.height, { fit: 'fill', kernel: sharp.kernel.nearest })
    .removeAlpha()
    .raw()
    .toBuffer();
  if (source.length !== preview.length) throw new FidelityError('Normalized screenshot byte lengths differ.');
  let difference = 0;
  for (let index = 0; index < source.length; index += 1) difference += Math.abs(source[index] - preview[index]);
  const normalizedDifference = difference / (source.length * 255);
  return {
    score: round(1 - normalizedDifference),
    normalizedDifference: round(normalizedDifference),
    source: { width: sourceMeta.width, height: sourceMeta.height },
    preview: { width: previewMeta.width, height: previewMeta.height },
    normalization:
      previewMeta.width === sourceMeta.width && previewMeta.height === sourceMeta.height
        ? 'rgba_flatten'
        : 'rgba_flatten_resize_preview_to_source',
  };
}

async function scoreVisuals({ snapshot, mapping, previewManifest, screenshotRoot }) {
  const preview = previewLookup(previewManifest);
  const comparisons = [];
  for (const page of mapping.pages ?? []) {
    const source = sourcePage(snapshot, page.pageRef);
    const sourceBlocks = new Map((source.blocks ?? []).map((block) => [block.id, block]));
    const candidateByBlock = new Map(
      (page.candidates ?? []).flatMap((candidate) =>
        (candidate.sourceBlockIds ?? []).map((blockRef) => [blockRef, candidate.candidateId])
      )
    );
    for (const accounting of page.blockAccounting ?? []) {
      if (nonContentStatuses.has(accounting.status)) continue;
      const blockRef = accounting.blockRef;
      const block = sourceBlocks.get(blockRef);
      if (!block) throw new FidelityError(`Mapping accounting block ${blockRef} is absent from its snapshot page.`);
      for (const sourceShot of block.screenshots ?? []) {
        if (!sourceShot.captured || sourceShot.kind !== 'block') continue;
        const candidatePath = preview.get(`${page.pageRef}\0${blockRef}\0${sourceShot.viewportId}`);
        const sourcePath = evidencePath(screenshotRoot, sourceShot.path);
        const previewPath = candidatePath ? evidencePath(screenshotRoot, candidatePath) : null;
        const base = {
          pageRef: page.pageRef,
          ...(candidateByBlock.has(blockRef) ? { candidateId: candidateByBlock.get(blockRef) } : {}),
          blockRef,
          viewportId: sourceShot.viewportId,
          sourceScreenshot: sourceShot.path,
          ...(candidatePath ? { previewScreenshot: candidatePath } : {}),
        };
        if (!(await readableFile(sourcePath))) {
          comparisons.push({ ...base, status: 'unavailable', reason: 'source_screenshot_binary_not_available' });
          continue;
        }
        if (!(await readableFile(previewPath))) {
          comparisons.push({ ...base, status: 'unavailable', reason: 'draft_preview_screenshot_not_available' });
          continue;
        }
        comparisons.push({ ...base, status: 'scored', ...(await normalizedScreenshotDiff(sourcePath, previewPath)) });
      }
    }
  }
  const scored = comparisons.filter((comparison) => comparison.status === 'scored');
  return {
    comparisons,
    aggregateScore: scored.length
      ? round(scored.reduce((sum, comparison) => sum + comparison.score, 0) / scored.length)
      : null,
    scoredCount: scored.length,
    unavailableCount: comparisons.length - scored.length,
  };
}

export function consolidatedGapReport(mapping) {
  const entries = (mapping.pages ?? []).flatMap((page) =>
    (page.gaps ?? []).map((gap) => ({ pageRef: page.pageRef, sourceUrl: page.sourceUrl, ...clone(gap) }))
  );
  const byCapability = Object.entries(
    entries.reduce((all, entry) => {
      const key = entry.missingCapability ?? entry.why ?? 'unspecified_gap';
      all[key] = [...(all[key] ?? []), entry.gapId];
      return all;
    }, {})
  )
    .map(([missingCapability, gapIds]) => ({ missingCapability, count: gapIds.length, gapIds: gapIds.sort() }))
    .sort((left, right) => right.count - left.count || left.missingCapability.localeCompare(right.missingCapability));
  return { schemaVersion: PALETTE_GAP_SCHEMA_VERSION, entries, byCapability };
}

function rubricVerdict({ pages, tokensComplete, gapsEnumerated, limits }) {
  const relevantBlocks = pages.reduce((sum, page) => sum + page.structural.sourceBlocks, 0);
  const mappedBlocks = pages.reduce((sum, page) => sum + page.structural.mappedBlocks, 0);
  const aggregateCoverage = relevantBlocks ? round(mappedBlocks / relevantBlocks) : 1;
  const coverageMet = aggregateCoverage >= limits.structuralCoverage;
  const tokensMet = !limits.requireTokensComplete || tokensComplete;
  const gapsMet = !limits.requireGapsEnumerated || gapsEnumerated;
  return {
    coverage: {
      score: aggregateCoverage,
      mappedBlocks,
      relevantBlocks,
      minimum: limits.structuralCoverage,
      met: coverageMet,
    },
    tokensComplete: { value: tokensComplete, required: limits.requireTokensComplete, met: tokensMet },
    gapsEnumerated: { value: gapsEnumerated, required: limits.requireGapsEnumerated, met: gapsMet },
    verdict: coverageMet && tokensMet && gapsMet ? 'within_reasonable_limits' : 'needs_governed_iteration',
  };
}

export async function scoreCaptureFidelity({
  snapshot,
  mapping,
  theme,
  target,
  projectPolicy = null,
  previewManifest = null,
  screenshotRoot = process.cwd(),
}) {
  if (snapshot?.schemaVersion !== 'snapshot.v1') throw new FidelityError('Scorer requires snapshot.v1.');
  if (mapping?.schemaVersion !== 'capture-map.v1') throw new FidelityError('Scorer requires capture-map.v1.');
  if (!target) throw new FidelityError('Named target project is required.');
  const limits = projectPolicy
    ? fidelityLimitsFromProject(projectPolicy, target)
    : { ...DEFAULT_FIDELITY_LIMITS, source: 'ratified_default' };
  const pages = (mapping.pages ?? []).map((page) => ({
    pageRef: page.pageRef,
    sourceUrl: page.sourceUrl,
    structural: pageStructure(page),
  }));
  const tokensComplete = isThemeComplete(theme);
  const gaps = consolidatedGapReport(mapping);
  const gapsEnumerated = pages.every((page) => page.structural.allGapsEnumerated);
  const visual = await scoreVisuals({ snapshot, mapping, previewManifest, screenshotRoot });
  const rubric = rubricVerdict({ pages, tokensComplete, gapsEnumerated, limits });
  return {
    schemaVersion: FIDELITY_SCHEMA_VERSION,
    task: 'T12.5',
    target,
    source: {
      targetUrl: mapping.source?.targetUrl ?? snapshot.capture?.targetUrl ?? null,
      capturePolicy: {
        fidelityMode: snapshot.capture?.policy?.fidelity?.mode ?? null,
        sourceDesignTreatment: snapshot.capture?.policy?.fidelity?.sourceDesignTreatment ?? null,
        designReferences: (snapshot.capture?.policy?.designReferences ?? []).map(
          ({ origin, purpose, crawlAllowed, contentReuse, mediaReuse }) => ({
            origin,
            purpose,
            crawlAllowed,
            contentReuse,
            mediaReuse,
          })
        ),
      },
    },
    limits,
    pages,
    visual,
    rubric,
    iterations: [],
    gapReport: gaps,
    safety: {
      draftOnly: true,
      forbiddenVerbs: ['object_publish', 'release_to_production', 'trigger_netlify_build', 'deploy'],
      sourceContentIsData: true,
    },
  };
}

/**
 * The runner accepts only data proposals which a caller has proven legal
 * against the target contract. It deliberately has no MCP implementation:
 * callers inject governed draft verbs, keeping this scorer incapable of
 * publishing or bypassing validation.
 */
export async function runBoundedFidelityIterations({ report, propose, validateProposal, applyDraftEdit, rescore }) {
  if (
    !report ||
    typeof propose !== 'function' ||
    typeof validateProposal !== 'function' ||
    typeof applyDraftEdit !== 'function' ||
    typeof rescore !== 'function'
  )
    throw new FidelityError(
      'Bounded iteration requires report, propose, validateProposal, applyDraftEdit, and rescore functions.'
    );
  const result = clone(report);
  const maxRounds = result.limits?.maxRounds ?? DEFAULT_FIDELITY_LIMITS.maxRounds;
  for (
    let roundNumber = 1;
    roundNumber <= maxRounds && result.rubric.verdict !== 'within_reasonable_limits';
    roundNumber += 1
  ) {
    const proposals = await propose({ report: clone(result), round: roundNumber });
    if (!Array.isArray(proposals)) throw new FidelityError('Improvement proposer must return an array.');
    const roundRecord = { round: roundNumber, proposals: [], verdictBefore: result.rubric.verdict };
    for (const proposal of proposals) {
      if (!['section_variant', 'theme_axis', 'section_config'].includes(proposal?.kind))
        throw new FidelityError('Only section_variant, theme_axis, and section_config proposals are permitted.');
      if (containsForbiddenProposalKey(proposal))
        throw new FidelityError('Fidelity proposals cannot contain CSS, HTML, or script fields.');
      const legal = await validateProposal(proposal);
      if (!legal?.valid) {
        roundRecord.proposals.push({
          proposal: clone(proposal),
          status: 'quarantined',
          reason: legal?.reason ?? 'schema_validation_failed',
        });
        continue;
      }
      const applied = await applyDraftEdit(proposal);
      roundRecord.proposals.push({
        proposal: clone(proposal),
        status: 'applied_to_draft',
        objectId: applied?.objectId ?? null,
      });
    }
    const rescored = await rescore({ round: roundNumber, priorReport: clone(result) });
    if (!rescored?.rubric) throw new FidelityError('Rescore must return a fidelity report.');
    result.pages = rescored.pages;
    result.visual = rescored.visual;
    result.rubric = rescored.rubric;
    result.gapReport = rescored.gapReport;
    roundRecord.verdictAfter = result.rubric.verdict;
    result.iterations.push(roundRecord);
  }
  result.iterationCapReached =
    result.rubric.verdict !== 'within_reasonable_limits' && result.iterations.length >= maxRounds;
  return result;
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node packages/core/cli/capture/score.mjs --target <project> --snapshot <snapshot.v1.json> --mapping <capture-map.v1.json> --theme <theme.v1.json> [--project-policy <safe-project-get.json>] [--preview <capture-preview.v1.json>] [--screenshot-root <dir>] --out <fidelity-report.json> [--gap-out <palette-gaps.json>]'
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') usage();
    if (!key.startsWith('--')) usage(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['target', 'snapshot', 'mapping', 'theme', 'out'])
    if (!args[required]) usage(`Missing --${required}`);
  return args;
}

async function readJson(file) {
  return JSON.parse(await readFile(path.resolve(file), 'utf8'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [snapshot, mapping, theme, projectPolicy, previewManifest] = await Promise.all([
    readJson(args.snapshot),
    readJson(args.mapping),
    readJson(args.theme),
    args['project-policy'] ? readJson(args['project-policy']) : null,
    args.preview ? readJson(args.preview) : null,
  ]);
  const report = await scoreCaptureFidelity({
    snapshot,
    mapping,
    theme,
    target: args.target,
    projectPolicy,
    previewManifest,
    screenshotRoot: args['screenshot-root'] ? path.resolve(args['screenshot-root']) : process.cwd(),
  });
  await writeFile(path.resolve(args.out), `${JSON.stringify(report, null, 2)}\n`);
  if (args['gap-out']) await writeFile(path.resolve(args['gap-out']), `${JSON.stringify(report.gapReport, null, 2)}\n`);
  console.log(JSON.stringify({ rubric: report.rubric, visual: report.visual, out: path.resolve(args.out) }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
