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
 * T2.7: after the object seed pack, `runDrive` also seeds the generic
 * `article_brochure_v1` pdf-tool template for this site and populates
 * `site.pdf` (ruling D-B) — see `runArticleTemplateSeed` in
 * `seed-article-pdf-template.mjs`. This step warns rather than blocks: it
 * never turns a genesis run non-zero on its own (see the call site below).
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/site-genesis-drive.mjs \
 *     --site sites/<client> --endpoint https://<host>/mcp [--dry-run] [--no-release]
 *
 * T16.8 adds a second, READ-ONLY mode:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/site-genesis-drive.mjs \
 *     --site sites/<client> --endpoint https://<host>/mcp --verify [--json]
 *
 * `--verify` reads the store back and reports whether stage 1 (genesis) is
 * actually proven — MISSING / DRIFTED / OK per manifest entry, INFO-only for
 * stage-2 (onboarding) entries, plus a check that every bootstrap page export
 * has been replaced by a real materialized one. It never creates, patches,
 * publishes, checks out, or releases anything — see `READ_ONLY_TOOLS` below,
 * which is the whole read-only guarantee in one place.
 *
 * The key is always from env, never an argument (argv leaks into shell history
 * and process lists).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { genesisSeedFiles, isPublishableObjectType, SEED_MODULES } from '../packages/core/cli/genesis-manifest.mjs';
import { driftFields } from './lib/roundtrip-reconcile.mjs';
import { runArticleTemplateSeed } from './seed-article-pdf-template.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const AGENT = 'site-genesis-drive';

const USAGE =
  'usage: MCP_HTTP_AUTH_TOKEN=… node scripts/site-genesis-drive.mjs --site sites/<client> --endpoint https://<host>/mcp [--dry-run] [--no-release] [--verify [--json]]';

// ─── arg parsing ─────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const flag = (name) => {
    const i = argv.indexOf(name);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    siteDir: flag('--site'),
    endpoint: flag('--endpoint'),
    dryRun: argv.includes('--dry-run'),
    noRelease: argv.includes('--no-release'),
    verify: argv.includes('--verify'),
    json: argv.includes('--json'),
  };
};

// ─── seed loading (shared by the drive AND verify) ──────────────────────────
//
// T16.0: the seed-module list and its order come from the genesis manifest —
// the one staged source of truth `create-site` also derives from. Add a seed
// THERE, not here; `driveOrder` in the manifest carries the navs-first law.
export const SEED_MODULES_DRIVEN = genesisSeedFiles();

/**
 * The ordered genesis plan for a site: seed modules first (dependency order),
 * then the bootstrap page exports. Pages come last: they may reference
 * navigation (navigationOverrides) and the site's own defaults. Every entry
 * returned here is genesis-stage — this is the drive's write plan AND the
 * set of objects `--verify` treats as failures if MISSING/DRIFTED.
 */
export const loadSeeds = async (siteRoot) => {
  const plan = [];
  for (const name of SEED_MODULES_DRIVEN) {
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

/**
 * Onboarding-stage (stage-2) seed entries, for `--verify`'s INFO-only report.
 * Genesis never invents this content (the 2026-08-05 types-not-instances
 * ruling) — `create-site` emits the skeleton FILE so the shape is
 * fleet-uniform, and stage 1 never births the object. `--verify` mirrors that:
 * it reports present/absent, never a failure, and never for a seed file that
 * was never scaffolded onto this site in the first place.
 */
export const loadOnboardingEntries = async (siteRoot) => {
  const entries = [];
  for (const entry of SEED_MODULES.filter((e) => e.stage === 'onboarding')) {
    const file = path.join(siteRoot, 'seeds', entry.file);
    if (!fs.existsSync(file)) {
      entries.push({ file: entry.file, scaffolded: false, seeds: [] });
      continue;
    }
    const mod = await import(pathToFileURL(file).href);
    const seeds = (mod.CONVERSION_SEEDS ?? []).map((seed) => ({ objectType: seed.objectType, objectId: seed.objectId }));
    entries.push({ file: entry.file, scaffolded: true, seeds });
  }
  return entries;
};

// ─── bootstrap-page-export check (repo-only, no MCP call) ───────────────────
//
// Mirrors `BOOTSTRAP_FROM` in packages/core/cli/create-site.mjs (matched by
// prefix, not re-exported — that module is a parallel task's territory this
// brief must not touch). A page export still carrying it has never been
// through a real publish: the drive strips `__generated` from the BODY it
// sends to the store, but the committed export file itself is only rewritten
// once a real publish materializes it (see `object-publish.ts`), so the file
// on disk is the ground truth for "has stage 1 actually replaced this yet".
const BOOTSTRAP_FROM_PREFIX = 'create-site:bootstrap';

export const checkBootstrapPages = (siteRoot) => {
  const pagesDir = path.join(siteRoot, 'data', 'site', 'pages');
  if (!fs.existsSync(pagesDir)) return [];
  return fs
    .readdirSync(pagesDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((file) => {
      const raw = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8'));
      const stillBootstrap = typeof raw?.__generated?.from === 'string' && raw.__generated.from.startsWith(BOOTSTRAP_FROM_PREFIX);
      return { file, status: stillBootstrap ? 'STILL_BOOTSTRAP' : 'OK' };
    });
};

// ─── MCP transport ───────────────────────────────────────────────────────────

export const createTool = (endpoint, key) => {
  let rpcId = 0;
  return async (name, toolArgs) => {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
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
};

const brief = (data) => JSON.stringify(data).slice(0, 200);

// ─── read-only guarantee (--verify) ─────────────────────────────────────────
//
// The whole read-only guarantee lives here: `--verify`'s entire code path
// (`runVerify` below) is given ONLY a tool function wrapped by
// `createReadOnlyTool`, and that wrapper throws — synchronously, before any
// network call — on any name outside this allowlist. There is no separate
// "trust me, verify never calls X" convention to audit: `object_create`,
// `object_checkout`, `object_publish`, `object_checkin`, `object_patch`, and
// `release_to_production` are structurally unreachable from `--verify`, not
// just unused by convention.
export const READ_ONLY_TOOLS = Object.freeze(['object_get']);

export const createReadOnlyTool = (baseTool) => {
  const readOnly = async (name, toolArgs) => {
    if (!READ_ONLY_TOOLS.includes(name)) {
      throw new Error(
        `[genesis:verify] read-only guarantee violated: '${name}' is not in READ_ONLY_TOOLS (${READ_ONLY_TOOLS.join(', ')})`
      );
    }
    return baseTool(name, toolArgs);
  };
  return readOnly;
};

// ─── verify ──────────────────────────────────────────────────────────────────

/**
 * Read-back proof of stage 1 (genesis) against the manifest, plus an
 * INFO-only look at stage 2 (onboarding). Never writes anything — `tool` MUST
 * already be wrapped by `createReadOnlyTool` (both call sites here go through
 * it: the CLI entry point below, and every test).
 */
export const runVerify = async ({ siteRoot, tool }) => {
  const plan = await loadSeeds(siteRoot);
  const onboarding = await loadOnboardingEntries(siteRoot);
  const bootstrapPages = checkBootstrapPages(siteRoot);

  const genesis = [];
  for (const seed of plan) {
    const ref = { object_type: seed.objectType, object_id: seed.objectId };
    const result = await tool('object_get', ref);
    const record = result.isError ? undefined : result.data.record;
    if (!record) {
      genesis.push({ objectType: seed.objectType, objectId: seed.objectId, status: 'MISSING' });
      continue;
    }
    const diff = driftFields(seed.body, record.body);
    if (Object.keys(diff).length > 0) {
      genesis.push({ objectType: seed.objectType, objectId: seed.objectId, status: 'DRIFTED', diff });
    } else {
      genesis.push({ objectType: seed.objectType, objectId: seed.objectId, status: 'OK' });
    }
  }

  const info = [];
  for (const entry of onboarding) {
    if (!entry.scaffolded) {
      info.push({ file: entry.file, status: 'INFO', present: false, detail: 'seed file not scaffolded on this site' });
      continue;
    }
    for (const seed of entry.seeds) {
      const ref = { object_type: seed.objectType, object_id: seed.objectId };
      const result = await tool('object_get', ref);
      const present = !result.isError && Boolean(result.data.record);
      info.push({ file: entry.file, objectType: seed.objectType, objectId: seed.objectId, status: 'INFO', present });
    }
  }

  const missing = genesis.filter((e) => e.status === 'MISSING').length;
  const drifted = genesis.filter((e) => e.status === 'DRIFTED').length;
  const ok = genesis.filter((e) => e.status === 'OK').length;
  const bootstrapFailures = bootstrapPages.filter((p) => p.status === 'STILL_BOOTSTRAP').length;

  return {
    genesis,
    onboarding: info,
    bootstrapPages,
    summary: { ok, missing, drifted, bootstrapFailures, total: genesis.length },
    ok: missing === 0 && drifted === 0 && bootstrapFailures === 0,
  };
};

export const printVerifyReport = (report, { siteDir, endpoint } = {}) => {
  console.log(`[genesis:verify] ${siteDir ?? ''} → ${endpoint ?? ''}`);
  for (const entry of report.genesis) {
    const line = `${entry.status.padEnd(9)} ${entry.objectType.padEnd(17)} ${entry.objectId}`;
    console.log(entry.status === 'OK' ? line : `${line}  ${brief(entry.diff ?? {})}`);
  }
  for (const entry of report.onboarding) {
    const label = entry.objectId ? `${entry.objectType} ${entry.objectId}` : entry.file;
    console.log(`INFO      ${label.padEnd(25)} present=${Boolean(entry.present)}${entry.detail ? `  (${entry.detail})` : ''}`);
  }
  for (const page of report.bootstrapPages) {
    console.log(`${page.status === 'OK' ? 'OK       ' : 'FAIL     '} bootstrap page    ${page.file}`);
  }
  console.log(
    `[genesis:verify] ${report.summary.ok} ok, ${report.summary.missing} missing, ${report.summary.drifted} drifted, ` +
      `${report.summary.bootstrapFailures} bootstrap page(s) not yet replaced`
  );
  console.log(report.ok ? '[genesis:verify] RESULT: PASS' : '[genesis:verify] RESULT: FAIL');
};

// ─── drive (the original write path) ────────────────────────────────────────

export const runDrive = async ({ siteDir, siteRoot, endpoint, tool, dryRun, noRelease }) => {
  const plan = await loadSeeds(siteRoot);
  console.log(`[genesis] ${siteDir} → ${endpoint}`);
  console.log(`[genesis] ${plan.length} objects planned, in dependency order:`);
  for (const entry of plan) console.log(`   ${entry.objectType.padEnd(17)} ${entry.objectId}`);

  if (dryRun) {
    console.log('[genesis] --dry-run: nothing sent.');
    return 0;
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
    } else if (!isPublishableObjectType(entry.objectType)) {
      console.log(`ok           ${entry.objectId} (already seeded — ${entry.objectType} is not publishable)`);
      continue;
    } else if (record.publication?.published_time) {
      console.log(`ok           ${entry.objectId} (already published)`);
      continue;
    } else {
      console.log(`exists       ${entry.objectId} (unpublished — publishing)`);
    }

    // REVIEW (brand-imagery wave): `visual_standard` is deliberately outside
    // the generic publish gate (genesis-manifest.mjs's
    // NON_PUBLISHABLE_OBJECT_TYPES / approval-policy.ts's
    // governedObjectTypes) — `object_publish` on it is refused
    // (`content_item_not_gated`), so attempting it could only ever add a
    // spurious FAIL and a non-zero exit to a genesis run that had in fact
    // seeded everything. Creating the record IS the deliverable for such a
    // type; the only way its content reaches anything published is a
    // separate, deliberate apply (site_apply_brand_imagery).
    if (!isPublishableObjectType(entry.objectType)) continue;

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
    return 1;
  }

  // T2.7 (ruling D-B; "genesis is never a manual step"): seed the generic
  // article_brochure_v1 template + site.pdf defaults for the site this plan
  // just birthed. Deliberately NOT counted in `failed` / does not block
  // release: the object seed pack above is the tenant's actual existence,
  // and (per BRIEF's own framing of the known create_pdf_template bridge
  // gap — see seed-article-pdf-template.mjs's header) this step can fail
  // for a reason genesis cannot fix by re-running. A failure here is loud
  // (printed, non-zero exit further down is deliberately NOT set) rather
  // than silent — same D-A posture ("warns, never blocks") applied to a
  // script instead of the admin UI.
  const siteId = plan.find((entry) => entry.objectType === 'site')?.objectId;
  if (siteId) {
    const pdfSeed = await runArticleTemplateSeed({ tool, siteId });
    for (const step of pdfSeed.steps) console.log(`   pdf-template-seed  ${JSON.stringify(step)}`);
    console.log(
      pdfSeed.ok
        ? `[genesis] pdf-template-seed OK (${pdfSeed.templateId})`
        : `[genesis] pdf-template-seed WARN (not blocking release): ${pdfSeed.error}`
    );
  } else {
    console.log('[genesis] pdf-template-seed skipped — this plan has no site object.');
  }

  if (noRelease) {
    console.log('[genesis] --no-release: skipping release_to_production.');
    return 0;
  }
  const release = await tool('release_to_production', { agent_name: AGENT });
  console.log(`[genesis] release: ${brief(release.data)}`);
  return 0;
};

// ─── CLI entry ───────────────────────────────────────────────────────────────

export const main = async (argv) => {
  const opts = parseArgs(argv);
  if (!opts.siteDir || !opts.endpoint) {
    console.error(USAGE);
    process.exitCode = 2;
    return;
  }
  const key = process.env.MCP_HTTP_AUTH_TOKEN;
  // `--dry-run` only means something for the write drive (print the plan,
  // send nothing) — `--verify` always makes real, read-only calls against a
  // live endpoint, so it always needs a key regardless of `--dry-run`.
  if (!key && !(opts.dryRun && !opts.verify)) {
    console.error('[genesis] MCP_HTTP_AUTH_TOKEN is required (omit only with --dry-run, and never with --verify).');
    process.exitCode = 2;
    return;
  }

  const siteRoot = path.resolve(repoRoot, opts.siteDir);
  const tool = createTool(opts.endpoint, key);

  if (opts.verify) {
    const report = await runVerify({ siteRoot, tool: createReadOnlyTool(tool) });
    if (opts.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printVerifyReport(report, { siteDir: opts.siteDir, endpoint: opts.endpoint });
    }
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  const exitCode = await runDrive({
    siteDir: opts.siteDir,
    siteRoot,
    endpoint: opts.endpoint,
    tool,
    dryRun: opts.dryRun,
    noRelease: opts.noRelease,
  });
  process.exitCode = exitCode;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[genesis] failed:', error.message);
    process.exit(1);
  });
}
