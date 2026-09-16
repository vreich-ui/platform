#!/usr/bin/env node
/**
 * Publish what this job did, as a git blob whose sha rides in a marker artifact's NAME.
 *
 * The dispatcher PULLS this rather than the job pushing it: cms-agent is the only party that writes
 * cms-agent state, so the trust boundary stays one-directional. Same shape as
 * capture-preview-report.mjs, and read by the same kind of artifact-name match.
 *
 * The blob is created through the API, not with `git hash-object -w`. A locally-hashed object lives
 * only in the ephemeral runner's .git: nothing pushes an unreferenced object, so the dispatcher's
 * GET would 404 and every refusal would reach the operator as an opaque "the job concluded failure".
 *
 * Runs on `always()`, because a FAILED scaffold is the result that matters most. A policy refusal
 * (create-site's machine-readable 422 `genesis_artifact_required`) is carried back verbatim, so
 * genesis can put the missing artifact names on its own ledger instead of reporting an opaque
 * "scaffold failed".
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

const slug = (process.env.GENESIS_SLUG ?? "").trim();
const commitSha = (process.env.GENESIS_COMMIT_SHA ?? "").trim();
const jobStatus = (process.env.GENESIS_JOB_STATUS ?? "unknown").trim();

/** create-site's own --json document, when it got far enough to emit one. */
const readCreateSiteResult = () => {
  try {
    return JSON.parse(readFileSync(".tmp/genesis/create-site-result.json", "utf8"));
  } catch {
    return undefined;
  }
};

const createSiteResult = readCreateSiteResult();
const report = {
  document: "genesis-scaffold-result.v1",
  slug,
  status: commitSha ? "scaffolded" : "failed",
  jobStatus,
  ...(commitSha ? { commitSha } : {}),
  // The refusal, verbatim. `error_code` / `missing` / `ways_out` are create-site's contract, not
  // this script's to reshape.
  ...(createSiteResult?.error_code ? { refusal: createSiteResult } : {}),
  ...(createSiteResult?.site?.directory ? { siteDirectory: createSiteResult.site.directory } : {}),
  runId: process.env.GITHUB_RUN_ID ?? null,
  finishedAt: new Date().toISOString()
};

mkdirSync(".tmp/genesis", { recursive: true });
const reportPath = ".tmp/genesis/genesis-scaffold-result.v1.json";
writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

// An unreferenced blob on the SERVER: no commit, no tree, no ref. A transport, not history.
const token = (process.env.GH_TOKEN ?? '').trim();
const repository = (process.env.REPOSITORY ?? '').trim();
// GITHUB_API_URL is set natively on every Actions runner (and points at an Enterprise host there),
// so honouring it is both correct for GHES and what lets a test stand a stub in front of it.
const apiBaseUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
const created = await fetch(`${apiBaseUrl}/repos/${repository}/git/blobs`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ content: Buffer.from(JSON.stringify(report), 'utf8').toString('base64'), encoding: 'base64' }),
});
if (!created.ok) {
  console.error(`[genesis-scaffold-report] Could not publish the result blob: HTTP ${created.status}. The scaffold's own outcome is unaffected.`);
  process.exit(1);
}
const blobSha = String((await created.json()).sha ?? '').trim();
if (!/^[0-9a-f]{40}$/.test(blobSha)) {
  console.error('[genesis-scaffold-report] GitHub accepted the result blob but returned no sha.');
  process.exit(1);
}
appendFileSync(process.env.GITHUB_ENV, `GENESIS_REPORT_BLOB_SHA=${blobSha}\n`);

const summary = process.env.GITHUB_STEP_SUMMARY;
if (summary) {
  appendFileSync(
    summary,
    `## genesis-scaffold — ${slug}\n\n- status: **${report.status}** (job ${jobStatus})\n` +
      (commitSha ? `- commit: \`${commitSha}\`\n` : "") +
      (report.refusal ? `- refused: \`${report.refusal.error_code}\` — missing ${JSON.stringify(report.refusal.missing ?? [])}\n` : "") +
      `- result blob: \`${blobSha}\`\n`
  );
}

console.log(`[genesis-scaffold-report] ${report.status} — blob ${blobSha}`);
