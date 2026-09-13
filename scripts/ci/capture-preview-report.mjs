#!/usr/bin/env node
/**
 * W2.1/G6-T1 — the job's own verdict on itself.
 *
 * Two jobs, in this order of importance:
 *
 *   1. PROVE THE JOB PUBLISHED NOTHING. `preview.mjs` renders a captured draft by copying the
 *      tenant into a scratch directory and building THAT — it never calls `object_publish`,
 *      `release_to_production`, `trigger_netlify_build` or `deploy`, and records them as refused in
 *      its manifest. That property is the reason a preview is allowed to exist at all, so it is
 *      asserted here rather than assumed: a manifest that claims a publish, a release or a deploy
 *      fails this job outright, whatever the fidelity number says.
 *
 *   2. Reduce the fidelity report to a small outcome document and a run summary. The report itself
 *      is the artifact T2 reads; this is what a human sees without downloading anything.
 *
 * Incomplete visual evidence is REPORTED, never converted into a pass. The whole W2.1/G6 thread
 * exists because `visual 0 scored / N unavailable` completed quietly for a whole acceptance cycle;
 * this script's exit code distinguishes "the preview plane misbehaved" (fail) from "the evidence
 * has named holes" (exit 3, artifact still uploaded, holes named in the summary).
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const FORBIDDEN_PREVIEW_OUTCOMES = Object.freeze(['published', 'released', 'deployed']);

export class PreviewSafetyError extends Error {}

/**
 * The preview may not have published, released or deployed anything, and must still record the
 * forbidden verbs as refused. Absent fields are a failure, not a pass: a manifest that stopped
 * stating the property is a manifest that stopped proving it.
 */
export function assertPreviewPublishedNothing(manifest) {
  const preview = manifest?.preview;
  if (!preview || typeof preview !== 'object') {
    throw new PreviewSafetyError('The preview manifest carries no `preview` block, so it states nothing about publishing.');
  }
  for (const outcome of FORBIDDEN_PREVIEW_OUTCOMES) {
    if (preview[outcome] !== false) {
      throw new PreviewSafetyError(
        `The preview manifest reports \`preview.${outcome}\` = ${JSON.stringify(preview[outcome])}; a draft preview must never ${outcome === 'published' ? 'publish' : outcome === 'released' ? 'release' : 'deploy'} anything.`
      );
    }
  }
  const refused = Array.isArray(preview.refusedVerbs) ? preview.refusedVerbs : [];
  for (const verb of ['deploy', 'object_publish', 'release_to_production', 'trigger_netlify_build']) {
    if (!refused.includes(verb)) {
      throw new PreviewSafetyError(`The preview manifest does not record "${verb}" among its refused verbs.`);
    }
  }
  return true;
}

export function summarizeFidelity({ report, manifest, inputs }) {
  const visual = report?.visual ?? {};
  const reasons = new Map();
  for (const defect of visual.defects ?? []) {
    const reason = defect.detail || defect.code || 'unknown';
    reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
  }
  return {
    schemaVersion: 'capture-fidelity-ci-outcome.v1',
    target: report?.target ?? null,
    verdict: report?.rubric?.verdict ?? null,
    coverage: report?.rubric?.coverage ?? null,
    visual: {
      scoredCount: visual.scoredCount ?? 0,
      unavailableCount: visual.unavailableCount ?? 0,
      aggregateScore: visual.aggregateScore ?? null,
      evidenceComplete: visual.evidenceComplete ?? false,
      pagesWithoutScoredComparison: (visual.pagesWithoutScoredComparison ?? []).length,
      reasons: [...reasons.entries()]
        .map(([reason, count]) => ({ reason, count }))
        .sort((left, right) => right.count - left.count || left.reason.localeCompare(right.reason)),
    },
    preview: {
      pages: (manifest?.pages ?? []).length,
      blockScreenshots: (manifest?.pages ?? []).reduce((total, page) => total + (page.blocks ?? []).length, 0),
      defectCount: manifest?.defectCount ?? 0,
      published: manifest?.preview?.published ?? null,
      released: manifest?.preview?.released ?? null,
      deployed: manifest?.preview?.deployed ?? null,
    },
    source: inputs?.screenshots ?? null,
  };
}

export function renderRunSummary(outcome) {
  const lines = [
    '## Capture fidelity',
    '',
    `**Target:** \`${outcome.target ?? 'unknown'}\` · **Verdict:** \`${outcome.verdict ?? 'unknown'}\``,
    '',
    '| | |',
    '|---|---|',
    `| Visual comparisons scored | ${outcome.visual.scoredCount} |`,
    `| Unavailable | ${outcome.visual.unavailableCount} |`,
    `| Aggregate visual score | ${outcome.visual.aggregateScore ?? '—'} |`,
    `| Evidence complete | ${outcome.visual.evidenceComplete ? 'yes' : 'NO'} |`,
    `| Preview pages rendered | ${outcome.preview.pages} |`,
    `| Preview block screenshots | ${outcome.preview.blockScreenshots} |`,
    `| Published / released / deployed | ${outcome.preview.published === false && outcome.preview.released === false && outcome.preview.deployed === false ? 'nothing (refused)' : 'CHECK THE MANIFEST'} |`,
  ];
  if (outcome.visual.reasons.length > 0) {
    lines.push('', '### Why evidence is missing', '', '| reason | count |', '|---|---|');
    for (const entry of outcome.visual.reasons) lines.push(`| \`${entry.reason}\` | ${entry.count} |`);
  }
  return `${lines.join('\n')}\n`;
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error('Usage: node scripts/ci/capture-preview-report.mjs --preview <capture-preview.v1.json> --report <fidelity-report.v1.json> --inputs <inputs-summary.json> --out <outcome.json> [--summary <step-summary.md>]');
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
  for (const required of ['preview', 'report', 'out']) if (!args[required]) usage(`Missing --${required}`);
  return args;
}

const readJson = async (file) => JSON.parse(await readFile(path.resolve(file), 'utf8'));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const [manifest, report, inputs] = await Promise.all([
    readJson(args.preview),
    readJson(args.report),
    args.inputs ? readJson(args.inputs).catch(() => null) : null,
  ]);
  assertPreviewPublishedNothing(manifest);
  const outcome = summarizeFidelity({ report, manifest, inputs });
  await writeFile(path.resolve(args.out), `${JSON.stringify(outcome, null, 2)}\n`);
  const summary = renderRunSummary(outcome);
  if (args.summary) await writeFile(path.resolve(args.summary), summary);
  console.log(summary);
  if (!outcome.visual.evidenceComplete) process.exitCode = 3;
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
