#!/usr/bin/env node
/**
 * Wolf 2026-09-09 — backfills the `editorial_strategy` singleton
 * (`strat_<client>`) onto the tenants that existed before `create-site.mjs`
 * started seeding one at genesis for every NEW site.
 *
 * WHAT IT WRITES, AND WHY IT IS SAFE TO RUN ON A LIVE TENANT. Exactly one
 * object per tenant, and only when there is none: a skeleton body marked
 * `provenance.set_by: "genesis_default"`. That marker is the whole point of
 * the backfill. Before it, a tenant with no strategy forced every consumer to
 * special-case absence and gave `strategy-review` no address to propose
 * against; after it, every tenant has ONE address, one honest "this still
 * needs to be set" warning, and nothing blocked. The body invents nothing —
 * every free-text field is the same `onboarding: fill with the client`
 * placeholder `create-site` scaffolds, per Wolf's 2026-08-05
 * types-not-instances ruling.
 *
 * NEVER OVERWRITES AN AUTHORED STRATEGY. A tenant that already carries
 * `strat_<client>` plans `mint: false` whatever its provenance says — a
 * strategy somebody decided, and even a default somebody has since edited,
 * is left exactly as it is. That makes the script idempotent: a second
 * `--apply` run against a seeded fleet issues zero write calls.
 *
 * `--dry-run` is the DEFAULT (planning only — `object_get` reads, nothing
 * written); the flag is accepted explicitly so the runbook can spell it out.
 * `--apply` performs the mint.
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/seed-editorial-strategy.mjs \
 *     --site drlurie --endpoint https://drluriescience.netlify.app/.netlify/functions/mcp [--apply]
 *
 *   MCP_HTTP_AUTH_TOKEN__DRLURIE=… MCP_HTTP_AUTH_TOKEN__PLATFORM=… \
 *   MCP_HTTP_AUTH_TOKEN__FERNWELL=… MCP_HTTP_AUTH_TOKEN__ZILBERMAN=… \
 *     node scripts/seed-editorial-strategy.mjs --all [--apply]
 *
 * The per-site token is ALWAYS read from env, NEVER from argv — the same rule
 * site-genesis-drive.mjs, fleet-capability-probe.mjs and
 * backfill-visual-standard.mjs already follow. A site with no token set is
 * reported `token missing` and skipped over the network: never a crash, never
 * a silent 401.
 *
 * MINTING IDENTITY. `agent_name` is `object-conversion-roundtrip`, the one
 * sanctioned seed identity (T13.10) — the tenant creation policy pins
 * `editorial_strategy` to that allowlist exactly as it pins `editorial_voice`,
 * so a casual agent cannot mint a strategy and this script can.
 */
import process from 'node:process';

import { createTool, clientIdFor, siteIdFor } from './backfill-visual-standard.mjs';
import { FLEET_SITES } from './fleet-capability-probe.mjs';

// The sanctioned seed identity — see the header. NOT this script's own name:
// the creation policy allowlists the seed driver, and inventing a second name
// here would mean editing four tenant configs to let a backfill run.
const AGENT = 'object-conversion-roundtrip';

/** The epoch sentinel, matching create-site.mjs's GENESIS_DEFAULT_SET_AT: nobody has decided these values. */
const GENESIS_DEFAULT_SET_AT = '1970-01-01T00:00:00.000Z';

const ONBOARDING_FILL_MARKER = 'onboarding: fill with the client';

export const strategyIdFor = (clientId) => `strat_${clientId}`;

/**
 * The seeded body — byte-for-byte the shape `create-site.mjs`'s
 * `strategySkeletonBody` writes for a brand-new tenant, so a backfilled
 * tenant and a freshly minted one are indistinguishable at the point of use.
 * Kept as a local literal rather than imported because create-site.mjs does
 * not export it and widening that CLI's public surface for one backfill is a
 * worse trade than this duplication; `tests/scripts/seed-editorial-strategy.test.mjs`
 * pins the two against each other so they cannot drift.
 */
export const genesisStrategyBody = (brandName) => ({
  name: `${brandName} — strategy (${ONBOARDING_FILL_MARKER})`,
  goal: `${ONBOARDING_FILL_MARKER} — what is publishing FOR on this site?`,
  offer: `${ONBOARDING_FILL_MARKER} — the offer (or offer architecture) the funnel sells.`,
  audience_segments: [],
  topic_weights: [],
  angle_mix: [],
  funnel_aggression: { tofu: 0, mofu: 0.2, bofu: 0.4 },
  cadence: `${ONBOARDING_FILL_MARKER} — how often, and at what volume?`,
  provenance: { set_by: 'genesis_default', set_at: GENESIS_DEFAULT_SET_AT },
});

/**
 * Pure planning: no I/O, so every branch is unit-testable without a network.
 * The rule is one line long on purpose — an existing strategy is never
 * touched, whoever wrote it and whatever its provenance says.
 */
export const planForTenant = ({ existingStrategy }) => {
  const mint = !existingStrategy;
  return {
    mint,
    reason: mint
      ? 'no editorial_strategy yet — will seed a genesis_default skeleton'
      : 'strat_<client> already exists — left exactly as it is, authored or not',
  };
};

const getObject = async (tool, objectType, objectId) => {
  const result = await tool('object_get', { object_type: objectType, object_id: objectId });
  if (result.isError) return undefined;
  return result.data?.record;
};

const brief = (data) => JSON.stringify(data).slice(0, 200);

export const seedTenant = async ({ tool, slug, siteId, clientId, brandName, apply, log = console.log }) => {
  const strategyId = strategyIdFor(clientId);
  const siteRecord = await getObject(tool, 'site', siteId);
  if (!siteRecord) {
    log(`[${slug}] SKIP — site ${siteId} not found`);
    return { slug, skipped: 'site_not_found' };
  }

  const existingStrategy = await getObject(tool, 'editorial_strategy', strategyId);
  const plan = planForTenant({ existingStrategy });
  log(`[${slug}] plan: mint=${plan.mint} (${plan.reason}); strategy_id=${strategyId}`);

  if (!apply || !plan.mint) return { slug, strategyId, plan, minted: false };

  const body = genesisStrategyBody(brandName ?? siteRecord.body?.name ?? slug);
  const created = await tool('object_create', {
    object_type: 'editorial_strategy',
    site: siteId,
    requested_id: strategyId,
    agent_name: AGENT,
    body,
  });
  if (created.isError) {
    log(`[${slug}] FAIL mint editorial_strategy  ${brief(created.data)}`);
    return { slug, strategyId, plan, minted: false, failed: true };
  }
  // No publish step, deliberately. `editorial_strategy` IS in the publish
  // charter (unlike visual_standard), but publishing a thin default would
  // commit a placeholder export and burn a `content_revision` on a body
  // nobody has decided. The object is the deliverable; the tenant's first
  // real edit is what earns a publish.
  log(`[${slug}] minted ${strategyId} (genesis_default — will warn until somebody decides it)`);
  return { slug, strategyId, plan, minted: true };
};

export const runSeed = async ({ tenants, apply, log = console.log }) => {
  log(
    apply
      ? `[seed-strategy] --apply: writing for ${tenants.length} tenant(s)`
      : `[seed-strategy] dry run — ${tenants.length} tenant(s), nothing written`
  );
  const results = [];
  for (const tenant of tenants) {
    results.push(await seedTenant({ ...tenant, apply, log }));
  }
  if (!apply) log('[seed-strategy] dry run — nothing written. Re-run with --apply.');
  return results;
};

// ─── CLI entry ─────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  // `--dry-run` is the default; accepting it explicitly means the runbook step
  // can be copied verbatim, and `--dry-run --apply` resolves to the SAFE side
  // rather than to whichever flag the parser happened to read last.
  return {
    slug: value('site'),
    endpoint: value('endpoint'),
    all: flag('all'),
    apply: flag('apply') && !flag('dry-run'),
  };
};

const tokenEnvNameFor = (slug) => `MCP_HTTP_AUTH_TOKEN__${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

const resolveTenants = (opts, log) => {
  const targets = opts.all
    ? FLEET_SITES
    : opts.slug && opts.endpoint
      ? [{ slug: opts.slug, endpoint: opts.endpoint }]
      : [];
  const tenants = [];
  for (const { slug, endpoint } of targets) {
    const token = opts.all ? process.env[tokenEnvNameFor(slug)] : process.env.MCP_HTTP_AUTH_TOKEN;
    if (!token) {
      log(`[${slug}] SKIP — ${opts.all ? tokenEnvNameFor(slug) : 'MCP_HTTP_AUTH_TOKEN'} not set`);
      continue;
    }
    const clientId = clientIdFor(slug);
    tenants.push({ slug, siteId: siteIdFor(clientId), clientId, tool: createTool(endpoint, token) });
  }
  return tenants;
};

export const main = async (argv) => {
  const opts = parseArgs(argv);
  if (!opts.all && !(opts.slug && opts.endpoint)) {
    console.error('[seed-editorial-strategy] pass --site <slug> --endpoint <url>, or --all');
    process.exitCode = 2;
    return;
  }
  const tenants = resolveTenants(opts, console.log);
  if (tenants.length === 0) {
    console.error('[seed-editorial-strategy] no tenant had a usable token — nothing to do.');
    process.exitCode = 1;
    return;
  }
  const results = await runSeed({ tenants, apply: opts.apply, log: console.log });
  process.exitCode = results.some((r) => r.failed) ? 1 : 0;
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[seed-editorial-strategy] failed:', error);
    process.exitCode = 1;
  });
}
