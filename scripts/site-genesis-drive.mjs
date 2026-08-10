#!/usr/bin/env node
/**
 * SITE GENESIS DRIVE — births a scaffolded site's starter pack as real store
 * objects, through that site's own `/mcp` front door.
 *
 * This is the step that used to be hand-driven with ad-hoc MCP calls (platform's
 * genesis, W14 T14.3/T14.4) and was the single largest manual cost of a new
 * client. It is fleet law now: every site scaffolded by `create-site` exposes the
 * same seed modules and the same bootstrap exports, so one driver births any of
 * them.
 *
 * GENESIS ORDER IS LAW (pinned by tests/netlify/site-genesis.e2e.test.ts):
 * navigation FIRST, then the site singleton (its defaultNavigation refs must
 * resolve), then everything else. Creating the site before its navs fails
 * reference integrity with a 422 — that is correct behavior, not a bug.
 *
 * For each object, in order:
 *   object_get → object_create when missing → object_checkout → object_publish
 *   → object_checkin   (publish does NOT release the lock — W14 F5)
 * then ONE release_to_production at the end (the deploy is the paid step).
 *
 * Idempotent: an object that already exists is left alone and only published if
 * it has never been published. Re-running after a partial failure is safe.
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/site-genesis-drive.mjs \
 *     --site sites/<client> --endpoint https://<host>/mcp [--dry-run] [--no-release]
 *
 * The key is always from env, never an argument (argv leaks into shell history
 * and process lists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { genesisSeedFiles } from '../packages/core/cli/genesis-manifest.mjs';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
};
const SITE_DIR = flag('--site');
const ENDPOINT = flag('--endpoint');
const DRY_RUN = args.includes('--dry-run');
const NO_RELEASE = args.includes('--no-release');
const KEY = process.env.MCP_HTTP_AUTH_TOKEN;

if (!SITE_DIR || !ENDPOINT) {
  console.error(
    'usage: MCP_HTTP_AUTH_TOKEN=… node scripts/site-genesis-drive.mjs --site sites/<client> --endpoint https://<host>/mcp [--dry-run] [--no-release]'
  );
  process.exit(2);
}
if (!KEY && !DRY_RUN) {
  console.error('[genesis] MCP_HTTP_AUTH_TOKEN is required (omit only with --dry-run).');
  process.exit(2);
}

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const siteRoot = path.resolve(repoRoot, SITE_DIR);
const AGENT = 'site-genesis-drive';

// ─── the ordered genesis plan ────────────────────────────────────────────────
//
// Seed modules first, in dependency order, then the bootstrap page exports.
// Pages come last: they may reference navigation (navigationOverrides) and the
// site's own defaults.
// T16.0: the list and its order come from the genesis manifest — the one
// staged source of truth `create-site` also derives from. Add a seed THERE,
// not here; `driveOrder` in the manifest carries the navs-first law.
const SEED_MODULES = genesisSeedFiles();

const loadSeeds = async () => {
  const plan = [];
  for (const name of SEED_MODULES) {
    const file = path.join(siteRoot, 'seeds', name);
    if (!fs.existsSync(file)) {
      console.log(`skip   ${name} (not scaffolded)`);
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    const seeds = mod.CONVERSION_SEEDS ?? [];
    const site = mod.SEED_SITE;
    for (const seed of seeds) plan.push({ ...seed, site });
  }

  // Bootstrap page exports → real page objects. `__generated` is the stub
  // marker create-site writes; it is metadata about the FILE, never part of the
  // object body, so it is stripped before the body reaches the store.
  const pagesDir = path.join(siteRoot, 'data', 'site', 'pages');
  if (fs.existsSync(pagesDir)) {
    const siteId = plan.find((entry) => entry.site)?.site;
    for (const file of fs
      .readdirSync(pagesDir)
      .filter((f) => f.endsWith('.json'))
      .sort()) {
      const raw = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8'));
      const { __generated, ...body } = raw;
      void __generated;
      plan.push({ objectType: 'page', objectId: path.basename(file, '.json'), body, site: siteId });
    }
  }
  return plan;
};

// ─── MCP transport ───────────────────────────────────────────────────────────
let rpcId = 0;
const tool = async (name, toolArgs) => {
  const response = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'tools/call',
      params: { name, arguments: toolArgs ?? {} },
    }),
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return { isError: true, data: { error: `non-JSON response (${response.status})`, detail: text.slice(0, 200) } };
  }
  const result = body.result ?? {};
  return {
    isError: Boolean(result.isError) || Boolean(body.error),
    data: result.structuredContent ?? body.error ?? {},
  };
};

const brief = (data) => JSON.stringify(data).slice(0, 200);

// ─── drive ───────────────────────────────────────────────────────────────────
const main = async () => {
  const plan = await loadSeeds();
  console.log(`[genesis] ${SITE_DIR} → ${ENDPOINT}`);
  console.log(`[genesis] ${plan.length} objects planned, in dependency order:`);
  for (const entry of plan) console.log(`   ${entry.objectType.padEnd(17)} ${entry.objectId}`);

  if (DRY_RUN) {
    console.log('[genesis] --dry-run: nothing sent.');
    return;
  }

  let created = 0;
  let published = 0;
  let failed = 0;

  for (const entry of plan) {
    const ref = { object_type: entry.objectType, object_id: entry.objectId };

    const existing = await tool('object_get', ref);
    const record = existing.isError ? undefined : existing.data.record;

    if (!record) {
      const result = await tool('object_create', {
        object_type: entry.objectType,
        site: entry.site,
        requested_id: entry.objectId,
        agent_name: AGENT,
        body: entry.body,
      });
      if (result.isError) {
        console.log(`FAIL create  ${entry.objectId}  ${brief(result.data)}`);
        failed += 1;
        continue;
      }
      console.log(`created      ${entry.objectId}`);
      created += 1;
    } else if (record.publication?.published_time) {
      console.log(`ok           ${entry.objectId} (already published)`);
      continue;
    } else {
      console.log(`exists       ${entry.objectId} (unpublished — publishing)`);
    }

    // Publish under a fresh lock, then ALWAYS check in: publish deliberately
    // keeps the lock (W14 F5), so skipping check-in would strand the object for
    // the rest of the 15-minute lease.
    const checkout = await tool('object_checkout', { ...ref, agent_name: AGENT });
    const lock = checkout.data.lockToken;
    if (!lock) {
      console.log(`LOCKED       ${entry.objectId} — publish on the next pass`);
      failed += 1;
      continue;
    }
    const result = await tool('object_publish', { ...ref, lock_token: lock, agent_name: AGENT });
    if (result.isError) {
      console.log(`FAIL publish ${entry.objectId}  ${brief(result.data)}`);
      failed += 1;
    } else {
      console.log(`published    ${entry.objectId}`);
      published += 1;
    }
    await tool('object_checkin', { ...ref, lock_token: lock, agent_name: AGENT });
  }

  console.log(`[genesis] created ${created}, published ${published}, failed ${failed}`);

  if (failed > 0) {
    console.error('[genesis] not releasing — fix the failures above and re-run (the drive is idempotent).');
    process.exit(1);
  }
  if (NO_RELEASE) {
    console.log('[genesis] --no-release: skipping release_to_production.');
    return;
  }
  const release = await tool('release_to_production', { agent_name: AGENT });
  console.log(`[genesis] release: ${brief(release.data)}`);
};

main().catch((error) => {
  console.error('[genesis] failed:', error.message);
  process.exit(1);
});
