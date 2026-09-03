#!/usr/bin/env node
/**
 * P6 — backfills the house `visual_standard` (`vis_<client>`, BRIEF.md
 * §3.1/R1/R2) onto tenants that existed before `create-site.mjs` started
 * minting one at genesis for every NEW site.
 *
 * Per tenant, over that site's own `/mcp` front door (the same transport
 * `scripts/site-genesis-drive.mjs` uses):
 *   1. `object_get` the site; derive a `brandImagery` contract from its
 *      CURRENT `brandTokens` via the existing, unmodified
 *      `deriveBrandImageryFromTokens` (never reimplemented — see
 *      packages/core/cli/visual-standard-genesis.mjs).
 *   2. MINT `vis_<client>` (`object_create`, kind 'house', status 'active',
 *      derivedFrom.method 'tokens') if it does not already exist. Never
 *      overwrites an existing `vis_<client>` — a hand-edited or
 *      writer-produced house standard is left alone.
 *   3. APPLY it onto `site.brandImagery` (the `site_apply_brand_imagery`
 *      verb, BRIEF §3.3) ONLY when the site does not already declare
 *      `brandImagery` — this backfill closes a GAP, it never overwrites a
 *      real declaration (the same rule `deriveBrandImageryFromTokens`'s own
 *      doc comment states for its own runtime fallback).
 *
 * `visual_standard` (the object TYPE) and `site_apply_brand_imagery` (the
 * verb/MCP tool) are being built CONCURRENTLY in another worktree (tasks
 * P1/P3 — see BRIEF.md's dependency note). This script never imports
 * either: every reference to them below is a plain STRING sent over the MCP
 * wire (an `object_type` value, a tool name) — exactly like every other
 * `object_type`/tool name this script and site-genesis-drive.mjs already
 * send as data, never as a compile-time import. Run against the REAL fleet
 * before P1/P3 merge, step 2 above 422s (unknown object type) and step 3
 * 404s/"unknown tool" (the verb does not exist in `tools/list` yet); this
 * script reports that per tenant and moves on rather than crashing the
 * whole run. Nothing here needs to change once the type/verb land — only
 * the live server's answers do.
 *
 * `--dry-run` is the DEFAULT (planning only — `object_get` reads, nothing
 * written). `--apply` performs the writes above. Idempotent: a tenant that
 * already carries `vis_<client>` AND a declared `site.brandImagery` plans
 * `mint: false, apply: false` — a second `--apply` run against it issues
 * zero write calls.
 *
 * Usage:
 *   MCP_HTTP_AUTH_TOKEN=… node scripts/backfill-visual-standard.mjs \
 *     --site drlurie --endpoint https://drluriescience.netlify.app/.netlify/functions/mcp [--apply]
 *
 *   MCP_HTTP_AUTH_TOKEN__DRLURIE=… MCP_HTTP_AUTH_TOKEN__PLATFORM=… MCP_HTTP_AUTH_TOKEN__FERNWELL=… \
 *     MCP_HTTP_AUTH_TOKEN__ZILBERMAN=… node scripts/backfill-visual-standard.mjs --all [--apply]
 *
 * The per-site token is ALWAYS read from env, NEVER from argv (same rule as
 * site-genesis-drive.mjs and fleet-capability-probe.mjs): a single `--site`
 * reads plain `MCP_HTTP_AUTH_TOKEN`; `--all` reads
 * `MCP_HTTP_AUTH_TOKEN__<SLUG>` per site (fleet-capability-probe.mjs's own
 * convention — imported from there, not restated, so the two never drift).
 * A site with no token set is reported `token missing` and skipped over the
 * network, never a crash, never a silent 401.
 */
import process from 'node:process';

import {
  buildHouseVisualStandardBody,
  deriveBrandImageryFromTokens,
  visualStandardIdFor,
} from '../packages/core/cli/visual-standard-genesis.mjs';
import { FLEET_SITES } from './fleet-capability-probe.mjs';

const AGENT = 'backfill-visual-standard';

// The verb this backfill's apply step calls (BRIEF §3.3) — a NEW MCP tool
// name, sent as plain data like every tool name below. No import, no
// compile-time dependency on the worktree building it.
const APPLY_TOOL = 'site_apply_brand_imagery';

export const clientIdFor = (slug) => slug.replace(/-/g, '_');
export const siteIdFor = (clientId) => `site_${clientId}`;

const hasDeclaredBrandImagery = (siteBody) => Boolean(siteBody) && siteBody.brandImagery != null;

/**
 * Pure planning: given what is already on the store (or `undefined` when
 * nothing was found), decides what this tenant still needs. No I/O — every
 * branch is independently unit-testable without a network or a mocked tool.
 */
export const planForTenant = ({ siteBody, existingVisualStandard, houseBody }) => {
  const mint = !existingVisualStandard;
  const apply = !hasDeclaredBrandImagery(siteBody);
  return {
    mint,
    apply,
    houseBody,
    reasons: {
      mint: mint
        ? 'no house visual_standard yet'
        : `${houseBody ? 'vis_<client>' : 'standard'} already exists — leaving the existing standard alone`,
      apply: apply
        ? 'site.brandImagery is empty — will apply the house standard'
        : 'site.brandImagery is already declared — never overwritten',
    },
  };
};

/** `undefined` on a 404/isError object_get, the record body's `body` field on a hit. */
const getObject = async (tool, objectType, objectId) => {
  const result = await tool('object_get', { object_type: objectType, object_id: objectId });
  if (result.isError) return undefined;
  return result.data?.record;
};

const brief = (data) => JSON.stringify(data).slice(0, 200);

/**
 * Runs the full get -> derive -> plan -> (optionally) write sequence for ONE
 * tenant against its own `tool(name, args)` function — the same shape
 * `site-genesis-drive.mjs`'s `createTool` returns, so a test can inject a
 * mock exactly like `tests/scripts/site-genesis-verify.test.mjs` already
 * does for that script.
 */
export const backfillTenant = async ({ tool, slug, siteId, clientId, brandName, niche, apply, log = console.log }) => {
  const visualStandardId = visualStandardIdFor(clientId);
  const siteRecord = await getObject(tool, 'site', siteId);
  if (!siteRecord) {
    log(`[${slug}] SKIP — site ${siteId} not found`);
    return { slug, skipped: 'site_not_found' };
  }
  const siteBody = siteRecord.body ?? {};

  const brandImagery = deriveBrandImageryFromTokens(siteBody, siteId);
  if (!brandImagery) {
    log(`[${slug}] SKIP — no brandTokens to derive a visual identity from`);
    return { slug, skipped: 'no_brand_tokens' };
  }

  const existingVisualStandardRecord = await getObject(tool, 'visual_standard', visualStandardId);
  const houseBody = buildHouseVisualStandardBody({
    brandName: brandName ?? siteBody.name ?? slug,
    brandImagery,
    niche,
  });
  const plan = planForTenant({ siteBody, existingVisualStandard: existingVisualStandardRecord, houseBody });

  log(
    `[${slug}] plan: mint=${plan.mint} (${plan.reasons.mint}); apply=${plan.apply} (${plan.reasons.apply}); visual_standard_id=${visualStandardId}`
  );

  if (!apply) return { slug, visualStandardId, plan, minted: false, applied: false };

  let minted = false;
  let mintFailed = false;
  if (plan.mint) {
    const created = await tool('object_create', {
      object_type: 'visual_standard',
      site: siteId,
      requested_id: visualStandardId,
      agent_name: AGENT,
      body: houseBody,
    });
    if (created.isError) {
      log(`[${slug}] FAIL mint visual_standard  ${brief(created.data)}`);
      mintFailed = true;
    } else {
      // REVIEW (brand-imagery wave): NO publish step. This script was written
      // before P1 landed and copied genesis's create -> checkout -> publish ->
      // checkin sequence, but `visual_standard` is deliberately outside the
      // generic publish gate (BRIEF rule 4 / approval-policy.ts's
      // governedObjectTypes) — `object_publish` on it is refused with
      // `content_item_not_gated`, so that step could only ever fail, and its
      // failure was what set `minted` to false on a mint that had in fact
      // succeeded. A created standard IS the deliverable; the only way its
      // imagery reaches anything published is the apply below.
      log(`[${slug}] minted ${visualStandardId}`);
      minted = true;
    }
  }

  let applied = false;
  let applyFailed = false;
  if (plan.apply) {
    // REVIEW: `site_apply_brand_imagery` is a real apply, so it needs THIS
    // caller's site checkout — the verb 400s without lock_token +
    // expected_record_version (object-verbs.ts's apply_brand_imagery case; the
    // pair is schema-optional only so `dry_run` can omit it). The original
    // call passed neither and could only ever 400. Own the lease, release it
    // in every path.
    const siteRef = { object_type: 'site', object_id: siteId };
    const checkout = await tool('object_checkout', { ...siteRef, agent_name: AGENT });
    const lock = checkout.data?.lockToken;
    const recordVersion = checkout.data?.record_version;
    if (!lock) {
      log(`[${slug}] LOCKED ${siteId} — apply on the next pass  ${brief(checkout.data)}`);
      applyFailed = true;
    } else {
      try {
        const result = await tool(APPLY_TOOL, {
          site_id: siteId,
          visual_standard_id: visualStandardId,
          lock_token: lock,
          ...(recordVersion !== undefined ? { expected_record_version: recordVersion } : {}),
          agent_name: AGENT,
        });
        if (result.isError) {
          log(`[${slug}] FAIL apply ${APPLY_TOOL}  ${brief(result.data)}`);
          applyFailed = true;
        } else {
          log(`[${slug}] applied ${visualStandardId} onto ${siteId}.brandImagery`);
          applied = true;
        }
      } finally {
        await tool('object_checkin', { ...siteRef, lock_token: lock, agent_name: AGENT });
      }
    }
  }

  return { slug, visualStandardId, plan, minted, applied, failed: mintFailed || applyFailed };
};

/**
 * Drives every tenant in `tenants` (each `{ slug, siteId, clientId,
 * brandName?, niche?, tool }`) through `backfillTenant`, sequentially (fleet
 * tenants are independent, but sequential keeps console output ordered and
 * avoids a thundering herd against several production endpoints — same
 * reasoning fleet-capability-probe.mjs's own loop gives).
 */
export const runBackfill = async ({ tenants, apply, log = console.log }) => {
  log(apply ? `[backfill] --apply: writing for ${tenants.length} tenant(s)` : `[backfill] dry run — ${tenants.length} tenant(s), nothing written`);
  const results = [];
  for (const tenant of tenants) {
    results.push(await backfillTenant({ ...tenant, apply, log }));
  }
  if (!apply) log('[backfill] dry run — nothing written. Re-run with --apply.');
  return results;
};

// ─── MCP transport (identical shape to site-genesis-drive.mjs's createTool) ──

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

// ─── CLI entry ─────────────────────────────────────────────────────────────

export const parseArgs = (argv) => {
  const flag = (name) => argv.includes(`--${name}`);
  const value = (name) => {
    const index = argv.indexOf(`--${name}`);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    slug: value('site'),
    endpoint: value('endpoint'),
    all: flag('all'),
    apply: flag('apply'),
  };
};

const tokenEnvNameFor = (slug) => `MCP_HTTP_AUTH_TOKEN__${slug.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;

/** Resolves `{ slug, endpoint, siteId, clientId, tool }` for every requested tenant, skipping any with no token. */
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
    console.error('[backfill-visual-standard] pass --site <slug> --endpoint <url>, or --all');
    process.exitCode = 2;
    return;
  }
  const tenants = resolveTenants(opts, console.log);
  if (tenants.length === 0) {
    console.error('[backfill-visual-standard] no tenant had a usable token — nothing to do.');
    process.exitCode = 1;
    return;
  }
  const results = await runBackfill({ tenants, apply: opts.apply, log: console.log });
  process.exitCode = results.some((r) => r.failed) ? 1 : 0;
};

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error('[backfill-visual-standard] failed:', error);
    process.exitCode = 1;
  });
}
