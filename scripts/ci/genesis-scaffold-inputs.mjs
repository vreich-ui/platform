#!/usr/bin/env node
/**
 * Unpack the tenant's genesis artifacts from the git blob the dispatch named, and turn them into
 * the `--editorial-strategy @file` style flags create-site.mjs expects.
 *
 * WHY IT IS READ OVER THE API, not with `git cat-file`. The blob cms-agent creates is UNREFERENCED —
 * no commit, no tree, no ref — so `actions/checkout` never fetches it, however deep the clone: git
 * only fetches objects reachable from refs. It is on the SERVER, not in the runner's .git. Reading
 * it locally was this script's first shape, and every mint carrying an artifact would have failed
 * here; capture-preview-inputs.mjs fetches over the API for exactly this reason.
 *
 * WHY A BLOB. The five partial bodies together exceed the ~64 KB workflow_dispatch payload ceiling,
 * and the fleet genesis policy can REQUIRE some of them, so they cannot simply be dropped. cms-agent
 * writes one `genesis-scaffold-artifacts.v1` document as an unreferenced git blob and passes its
 * sha — the same transport capture-preview uses, for the same reason.
 *
 * WHY EACH BODY IS WRITTEN TO A FILE rather than passed inline: create-site's flags accept inline
 * JSON, but inline JSON on a command line is a quoting problem with caller-controlled content in
 * it. `@path` sidesteps that entirely.
 *
 * No blob named = no flags. An absent artifact is a legitimate mint (the policy ships empty), and
 * create-site's own 422 is what refuses when the policy says otherwise — this script never
 * second-guesses that decision.
 */
import { mkdirSync, writeFileSync } from 'node:fs';

/** The document's keys, and the flag each one feeds. Anything else in the document is ignored. */
const FLAG_FOR_KEY = {
  editorialStrategy: "--editorial-strategy",
  editorialVoice: "--editorial-voice",
  visualStandard: "--visual-standard",
  logo: "--logo",
  trackingConfig: "--tracking-config"
};

/**
 * The scaffold step reads these as a NUL-separated argv file, not as a shell string. A string would
 * have to survive word splitting, and these are flags carrying caller-influenced values.
 */
const ARGS_PATH = '.tmp/genesis/artifact-args';
const writeArgs = (args) => {
  mkdirSync('.tmp/genesis', { recursive: true });
  writeFileSync(ARGS_PATH, args.length ? `${args.join('\0')}\0` : '');
};

const blobSha = (process.env.GENESIS_ARTIFACTS_BLOB ?? "").trim();
if (!blobSha) {
  console.log('[genesis-scaffold-inputs] No artifacts blob supplied; scaffolding from the skeleton defaults.');
  writeArgs([]);
  process.exit(0);
}
if (!/^[0-9a-f]{40}$/.test(blobSha)) {
  console.error(`[genesis-scaffold-inputs] "${blobSha}" is not a git blob sha.`);
  process.exit(1);
}

const token = (process.env.GH_TOKEN ?? '').trim();
const repository = (process.env.REPOSITORY ?? '').trim();
// GITHUB_API_URL is set natively on every Actions runner (and points at an Enterprise host there),
// so honouring it is both correct for GHES and what lets a test stand a stub in front of it.
const apiBaseUrl = (process.env.GITHUB_API_URL ?? 'https://api.github.com').replace(/\/$/, '');
if (!token || !repository) {
  console.error('[genesis-scaffold-inputs] GH_TOKEN and REPOSITORY are required to read the artifacts blob.');
  process.exit(1);
}

let document;
try {
  const response = await fetch(`${apiBaseUrl}/repos/${repository}/git/blobs/${blobSha}`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.json();
  const text = blob.encoding === 'base64' || blob.encoding === undefined ? Buffer.from(blob.content, 'base64').toString('utf8') : blob.content;
  document = JSON.parse(text);
} catch (error) {
  // Named, because the causes need different fixes: a sha this repository never received (the
  // dispatcher wrote it elsewhere), a token that cannot read it, or a document that is not JSON.
  console.error(`[genesis-scaffold-inputs] Could not read blob ${blobSha} from ${repository}: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
}

mkdirSync(".tmp/genesis/artifacts", { recursive: true });
/** Flat argv pairs: ["--editorial-voice", "@.tmp/…/editorialVoice.json", …]. */
const flags = [];
for (const [key, flag] of Object.entries(FLAG_FOR_KEY)) {
  const body = document?.[key];
  if (body === undefined || body === null) continue;
  const path = `.tmp/genesis/artifacts/${key}.json`;
  writeFileSync(path, JSON.stringify(body, null, 2));
  flags.push(flag, `@${path}`);
}

writeArgs(flags);
console.log(`[genesis-scaffold-inputs] Supplied ${flags.length / 2} genesis artifact(s): ${Object.keys(FLAG_FOR_KEY).filter((key) => document?.[key] != null).join(", ") || "none"}.`);
