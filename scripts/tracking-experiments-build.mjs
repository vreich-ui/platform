#!/usr/bin/env node
/**
 * T21.5 build step — write the experiment map the edge function and the loader
 * read. Runs BEFORE `astro build` (the public copy has to exist before Astro
 * copies `publicDir` into `dist`).
 *
 *   node scripts/tracking-experiments-build.mjs \
 *     --export-root sites/drlurie/data/site \
 *     --public-dir  sites/drlurie/public \
 *     --edge-dir    netlify/edge-functions \
 *     --config-yaml sites/drlurie/config.yaml
 *
 * All the logic lives in `scripts/lib/tracking-experiments.mjs` (tested by
 * `tests/scripts/tracking-experiments.test.mjs`); this is the CLI wrapper. It
 * NEVER throws: a tracking-sink outage, a missing export, or a malformed
 * experiment degrades to equal weights or an empty map, and the build goes on.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildExperimentArtifacts } from './lib/tracking-experiments.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const readFlag = (flag, fallback) => {
  const index = process.argv.indexOf(flag);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
};

// Defaults are the repo-root build (Dr-Lurie, `npm run build`); each site's
// netlify.toml passes its own site-relative paths.
const exportRoot = readFlag('--export-root', path.join(repoRoot, 'sites/drlurie/data/site'));
const publicDir = readFlag('--public-dir', path.join(repoRoot, 'sites/drlurie/public'));
const edgeDir = readFlag('--edge-dir', path.join(repoRoot, 'netlify/edge-functions'));
const configYaml = readFlag('--config-yaml', path.join(repoRoot, 'sites/drlurie/config.yaml'));

try {
  const result = await buildExperimentArtifacts({ exportRoot, publicDir, edgeDir, configYaml });
  console.log(`[tracking-experiments] ${result.active} active experiment(s) materialized.`);
} catch (error) {
  console.warn(`[tracking-experiments] step failed; build continues: ${error?.message ?? error}`);
}
