#!/usr/bin/env node
/**
 * W2.1/G6-T1 — assemble one capture run's inputs into a single run root, so
 * `preview.mjs` and `score.mjs --preview` can be pointed at it unchanged.
 *
 * ## The one thing this script is for
 *
 * `score.mjs` resolves BOTH sides of every visual pair against ONE
 * `--screenshot-root`: a source shot at its snapshot `path`
 * (`pages/<pageId>/<viewportId>/blocks/<blockId>.png`) and a preview shot at
 * the path `capture-preview.v1` names (`preview/pages/...`, written there by
 * `preview.mjs` for exactly this reason). A file at any other path reads as
 * `unavailable`, and an unavailable pair is a defect, not a missing nicety.
 * So path fidelity IS this script: the source bytes are written at the
 * snapshot's own path, byte for byte, or the whole job is pointless.
 *
 * ## Where the inputs come from
 *
 * Two places, for one reason each.
 *
 *   - The four stage DOCUMENTS (snapshot.v1, capture-map.v1, the emission
 *     plan, theme.v1) are cms-agent's, and they are large: Zilberman's
 *     snapshot alone is 187 KB and its mapping 120 KB, against a
 *     workflow_dispatch payload ceiling near 64 KB. They travel as GIT BLOBS:
 *     cms-agent POSTs each document to `/repos/{owner}/{repo}/git/blobs` and
 *     passes the returned SHA as a dispatch input; this script reads them back
 *     with the workflow's own GITHUB_TOKEN. No new read surface on cms-agent,
 *     no CI-to-cms-agent credential, and no size ceiling. The blobs are
 *     unreferenced (no commit, no branch, no tree points at them) — they are a
 *     transport, not history.
 *   - The SOURCE SCREENSHOT BYTES are pdf-tool's, fetched through the
 *     bearer-gated export function W2.1/G6-T0 added
 *     (`/.netlify/functions/export-capture-screenshots`). Only block shots are
 *     fetched: `scoreVisuals` compares `kind === 'block'` and nothing else, so
 *     pulling full-page shots would be bytes over the wire that no comparison
 *     reads.
 *
 * ## What it refuses to do
 *
 * Nothing here writes to the working tree outside the run root, commits,
 * publishes, releases or deploys — the preview plane's own forbidden-verb
 * property, kept by never acquiring the ability in the first place. A
 * screenshot whose digest does not match what pdf-tool recorded is a hard
 * failure, not a warning: scoring against the wrong pixels produces a fidelity
 * number about the wrong page, which is worse than no number at all.
 */
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const STAGE_DOCUMENTS = Object.freeze([
  Object.freeze({ key: 'snapshot', file: 'snapshot.v1.json', required: true }),
  Object.freeze({ key: 'mapping', file: 'capture-map.v1.json', required: true }),
  Object.freeze({ key: 'plan', file: 'capture-emission-plan.v1.json', required: true }),
  Object.freeze({ key: 'theme', file: 'theme.v1.json', required: true }),
]);

/** pdf-tool's own per-call ceiling (screenshot-export.ts). Stay under it rather than discover it. */
export const SCREENSHOT_PATHS_PER_CALL = 100;

class InputsError extends Error {}

const isBlobSha = (value) => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value.trim());

/**
 * Every block screenshot the crawl says it captured, in snapshot order.
 *
 * `captured: false` entries are skipped deliberately: the crawl recorded that it never got that
 * shot, so asking pdf-tool for bytes it was never given would turn a known, already-enumerated gap
 * into a fetch failure that looks like a transport problem.
 */
export function blockScreenshotPaths(snapshot) {
  const paths = [];
  for (const page of snapshot?.pages ?? []) {
    for (const block of page.blocks ?? []) {
      for (const shot of block.screenshots ?? []) {
        if (shot.captured && shot.kind === 'block' && typeof shot.path === 'string') paths.push(shot.path);
      }
    }
  }
  return [...new Set(paths)];
}

/** A screenshot path may only ever land INSIDE the run root — the same bound score.mjs enforces. */
export function resolveWithinRoot(runRoot, relativePath) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new InputsError(`Screenshot path ${JSON.stringify(relativePath)} is not a relative path.`);
  }
  const root = path.resolve(runRoot);
  const resolved = path.resolve(root, relativePath);
  const within = path.relative(root, resolved);
  if (within === '..' || within.startsWith(`..${path.sep}`)) {
    throw new InputsError(`Screenshot path ${JSON.stringify(relativePath)} escapes the run root.`);
  }
  return resolved;
}

async function writeFileAt(target, bytes) {
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, bytes);
}

/**
 * Read one unreferenced git blob back as raw bytes. `Accept: application/vnd.github.raw` returns
 * the content itself rather than a base64 envelope, so a 187 KB snapshot costs one request.
 */
export async function fetchGitBlob({ repository, sha, token, apiBaseUrl = 'https://api.github.com', fetchImpl = fetch }) {
  if (!isBlobSha(sha)) throw new InputsError(`"${sha}" is not a 40-character git blob sha.`);
  const response = await fetchImpl(`${apiBaseUrl}/repos/${repository}/git/blobs/${sha.trim()}`, {
    headers: {
      accept: 'application/vnd.github.raw',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new InputsError(
      `Git blob ${sha} could not be read (HTTP ${response.status}). Blobs created for a dispatch are unreferenced; re-create them and re-dispatch rather than retrying this run.`
    );
  }
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Fetch every named screenshot from pdf-tool and write each at its own snapshot path under the run
 * root. Pages on `remainingPaths` (pdf-tool's byte budget) until the list is exhausted.
 *
 * Returns `{ written, missing }`. A `missing` entry is a named hole in the evidence — it is
 * returned rather than thrown so the caller can report the whole set at once instead of one per
 * run, which is how the 0-of-34 defect stayed invisible for a whole acceptance cycle.
 */
export async function fetchSourceScreenshots({
  baseUrl,
  token,
  projectId,
  jobId,
  requestId,
  paths,
  runRoot,
  fetchImpl = fetch,
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, '')}/.netlify/functions/export-capture-screenshots`;
  const written = [];
  const missing = [];
  let queue = [...paths];
  let guard = 0;
  while (queue.length > 0) {
    if (guard++ > 10_000) throw new InputsError('Screenshot export made no progress; refusing to loop.');
    const batch = queue.slice(0, SCREENSHOT_PATHS_PER_CALL);
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ projectId, ...(jobId ? { jobId } : { requestId }), paths: batch }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new InputsError(
        `pdf-tool refused the screenshot export (HTTP ${response.status}${body.errorCode ? ` ${body.errorCode}` : ''}): ${body.error ?? 'no detail'}`
      );
    }
    for (const shot of body.screenshots ?? []) {
      const bytes = Buffer.from(shot.bytesBase64, 'base64');
      const digest = createHash('sha256').update(bytes).digest('hex');
      if (digest !== shot.sha256) {
        // Never "best effort" here. A scorer fed the wrong pixels reports a fidelity number about
        // the wrong page, which is worse than reporting none.
        throw new InputsError(`Screenshot ${shot.path} failed its digest check (stored ${shot.sha256}, received ${digest}).`);
      }
      await writeFileAt(resolveWithinRoot(runRoot, shot.path), bytes);
      written.push({ path: shot.path, sha256: shot.sha256, byteLength: bytes.byteLength });
    }
    for (const gap of body.missing ?? []) missing.push({ path: gap.path, reason: gap.reason, detail: gap.detail });
    const consumed = new Set([
      ...(body.screenshots ?? []).map((shot) => shot.path),
      ...(body.missing ?? []).map((gap) => gap.path),
    ]);
    const remaining = Array.isArray(body.remainingPaths) ? body.remainingPaths : [];
    const unanswered = batch.filter((candidate) => !consumed.has(candidate) && !remaining.includes(candidate));
    if (unanswered.length > 0) {
      throw new InputsError(`pdf-tool answered neither with bytes nor a reason for ${unanswered.length} path(s), starting at ${unanswered[0]}.`);
    }
    queue = [...remaining, ...queue.slice(batch.length)];
  }
  return { written, missing };
}

export async function assembleCaptureRunInputs({
  runRoot,
  repository,
  githubToken,
  blobs,
  pdfTool,
  fetchImpl = fetch,
  apiBaseUrl = 'https://api.github.com',
}) {
  await mkdir(path.resolve(runRoot), { recursive: true });
  const documents = {};
  for (const document of STAGE_DOCUMENTS) {
    const sha = blobs?.[document.key];
    if (!sha) {
      if (document.required) throw new InputsError(`No blob sha was supplied for ${document.file}.`);
      continue;
    }
    const bytes = await fetchGitBlob({ repository, sha, token: githubToken, apiBaseUrl, fetchImpl });
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      throw new InputsError(`Blob ${sha} (${document.file}) is not JSON: ${error.message}`);
    }
    const target = path.resolve(runRoot, document.file);
    await writeFileAt(target, bytes);
    documents[document.key] = { file: target, sha, byteLength: bytes.byteLength, document: parsed };
  }

  const paths = blockScreenshotPaths(documents.snapshot.document);
  if (paths.length === 0) {
    throw new InputsError('The snapshot declares no captured block screenshots; there is nothing for the scorer to compare against.');
  }
  const screenshots = await fetchSourceScreenshots({ ...pdfTool, paths, runRoot, fetchImpl });
  return {
    runRoot: path.resolve(runRoot),
    documents: Object.fromEntries(Object.entries(documents).map(([key, value]) => [key, { file: value.file, sha: value.sha, byteLength: value.byteLength }])),
    screenshots: {
      declared: paths.length,
      written: screenshots.written.length,
      missing: screenshots.missing,
      bytes: screenshots.written.reduce((total, shot) => total + shot.byteLength, 0),
    },
  };
}

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node scripts/ci/capture-preview-inputs.mjs --run-root <dir> --repository <owner/repo> --snapshot-blob <sha> --mapping-blob <sha> --plan-blob <sha> --theme-blob <sha> --pdf-tool-base-url <url> --project <projectId> [--capture-job-id <id>] [--capture-request-id <id>] --out <summary.json>'
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
  for (const required of ['run-root', 'repository', 'snapshot-blob', 'mapping-blob', 'plan-blob', 'theme-blob', 'pdf-tool-base-url', 'project', 'out'])
    if (!args[required]) usage(`Missing --${required}`);
  if (!args['capture-job-id'] && !args['capture-request-id']) usage('One of --capture-job-id or --capture-request-id is required.');
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const githubToken = process.env.GITHUB_TOKEN;
  const pdfToolToken = process.env.PDF_TOOL_AGENT_RUN_TOKEN;
  if (!githubToken) throw new InputsError('GITHUB_TOKEN is not set; the stage documents travel as git blobs in this repository.');
  if (!pdfToolToken) throw new InputsError('PDF_TOOL_AGENT_RUN_TOKEN is not set; the source screenshots live in pdf-tool.');
  const summary = await assembleCaptureRunInputs({
    runRoot: args['run-root'],
    repository: args.repository,
    githubToken,
    blobs: {
      snapshot: args['snapshot-blob'],
      mapping: args['mapping-blob'],
      plan: args['plan-blob'],
      theme: args['theme-blob'],
    },
    pdfTool: {
      baseUrl: args['pdf-tool-base-url'],
      token: pdfToolToken,
      projectId: args.project,
      jobId: args['capture-job-id'],
      requestId: args['capture-request-id'],
    },
  });
  await writeFile(path.resolve(args.out), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
  // A hole in the SOURCE evidence is reported and carried, not swallowed: the scorer will name
  // each one as a defect, and this exit code lets the workflow surface it without pretending the
  // report is unusable.
  if (summary.screenshots.missing.length > 0) process.exitCode = 3;
}

export const __testFileName = fileURLToPath(import.meta.url);

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url)
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
