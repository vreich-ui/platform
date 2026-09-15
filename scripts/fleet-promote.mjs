#!/usr/bin/env node
/**
 * fleet-promote — the deliberate way a fleet site goes live (cloud-cost N1).
 *
 * WHY THIS EXISTS. Every site's netlify.toml now skips production builds triggered
 * from git: a merge to main used to fan out into one charged production deploy on
 * each of the five projects, because packages/core sits in every site's ignore list.
 * Netlify does not run the ignore command at all for a build started by a BUILD HOOK
 * ("regardless of exit code" — docs.netlify.com/build/configure-builds/ignore-builds),
 * so a hook is the one trigger the gate cannot swallow. Content already reaches
 * production that way through release_to_production; this script is the same move for
 * code, done on purpose instead of on every merge.
 *
 *   node scripts/fleet-promote.mjs --site genesis-lab-2
 *   node scripts/fleet-promote.mjs --all
 *   node scripts/fleet-promote.mjs --all --dry-run
 *
 * Each site's hook URL comes from NETLIFY_BUILD_HOOK_URL__<SLUG> in the environment —
 * never argv, and never printed, because a build hook URL is a bearer credential: anyone
 * holding it can spend this account's build minutes. The same env-name convention as
 * fleet-capability-probe.mjs's tokenEnvName, for the same reason (one rule to remember).
 *
 * A promote is not a deploy confirmation. The hook returns as soon as Netlify has queued
 * the build; whether that build succeeds and publishes is the Deploys page's answer, or
 * deploy_status {commit} for a site that exposes it.
 */
import process from 'node:process';
import { FLEET_SITES } from './fleet-capability-probe.mjs';

/** `genesis-lab-2` -> `NETLIFY_BUILD_HOOK_URL__GENESIS_LAB_2`. */
export const buildHookEnvName = (slug) => `NETLIFY_BUILD_HOOK_URL__${slug.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;

export const FLEET_SLUGS = FLEET_SITES.map((site) => site.slug);

/**
 * Pure argv -> intent. Separated from the network so "what would --all promote" is
 * answerable in a test without a fetch, and so a typo'd slug fails before anything
 * is spent rather than after the first hook fires.
 */
export const parseArgs = (argv, slugs = FLEET_SLUGS) => {
  const sites = [];
  let all = false;
  let dryRun = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--all') all = true;
    else if (arg === '--dry-run') dryRun = true;
    else if (arg === '--site') {
      const slug = argv[i + 1];
      if (!slug || slug.startsWith('--')) return { error: '--site needs a slug, e.g. --site genesis-lab-2' };
      sites.push(slug);
      i += 1;
    } else if (arg.startsWith('--site=')) sites.push(arg.slice('--site='.length));
    else return { error: `unknown argument: ${arg}` };
  }
  if (all && sites.length) return { error: '--all and --site are mutually exclusive' };
  if (!all && !sites.length) return { error: `nothing to promote: pass --all or --site <slug> (slugs: ${slugs.join(', ')})` };
  const targets = all ? [...slugs] : sites;
  const unknown = targets.filter((slug) => !slugs.includes(slug));
  if (unknown.length) return { error: `unknown site(s): ${unknown.join(', ')} — known slugs: ${slugs.join(', ')}` };
  return { targets, dryRun };
};

/**
 * Fire one site's hook. Resolves to a result rather than throwing, so one unconfigured
 * or failing site never silently truncates a --all promote: every site gets a verdict
 * and the exit code is decided once, at the end, over all of them.
 */
export const promoteSite = async (slug, { env = process.env, fetchImpl = fetch } = {}) => {
  const envName = buildHookEnvName(slug);
  const url = (env[envName] ?? '').trim();
  if (!url) return { slug, ok: false, status: 'not_configured', detail: `${envName} is not set in this environment` };
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trigger_title: 'fleet-promote' }),
    });
    return response.ok
      ? { slug, ok: true, status: 'queued', detail: `build hook accepted (HTTP ${response.status})` }
      : { slug, ok: false, status: 'hook_rejected', detail: `build hook returned HTTP ${response.status}` };
  } catch (error) {
    // The URL is deliberately absent from this message: fetch failures often echo the
    // request target, and that target is the credential.
    return { slug, ok: false, status: 'request_failed', detail: error instanceof Error ? error.message.replace(url, '<hook url>') : 'request failed' };
  }
};

export const main = async (argv = process.argv.slice(2), { env = process.env, fetchImpl = fetch, log = console.log } = {}) => {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    log(`fleet-promote: ${parsed.error}`);
    return 2;
  }
  if (parsed.dryRun) {
    for (const slug of parsed.targets) {
      const envName = buildHookEnvName(slug);
      log(`${slug.padEnd(16)} would POST ${envName} ${(env[envName] ?? '').trim() ? '(configured)' : '(NOT SET)'}`);
    }
    return 0;
  }
  // Sequential on purpose: five concurrent production builds is the fan-out this whole
  // change exists to stop, and a promote is never on a latency budget.
  const results = [];
  for (const slug of parsed.targets) results.push(await promoteSite(slug, { env, fetchImpl }));
  for (const result of results) log(`${result.slug.padEnd(16)} ${result.ok ? 'OK  ' : 'FAIL'} ${result.status} — ${result.detail}`);
  const failed = results.filter((result) => !result.ok);
  if (failed.length) log(`\nfleet-promote: ${failed.length} of ${results.length} site(s) were not promoted.`);
  return failed.length ? 1 : 0;
};

if (import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => { process.exitCode = code; });
}
