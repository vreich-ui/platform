#!/usr/bin/env node
/**
 * `env-audit` — R8.2: a fleet-wide health check for the tracking-pipeline's
 * per-site env vars (`npm run env:audit [-- --fix]`).
 *
 * Scope is deliberately narrow — the FOUR tracking tenancy-axis rows from
 * `create-site.mjs`'s `ENV_CHECKLIST` (pulled from there, not re-declared, so
 * genesis and audit never drift on class/generate/teamInherited):
 *
 *   - `TRACKING_PROJECT_ID` (per-site — this client's partition slug)
 *   - `TRACKING_SALT`       (per-site — secret, must differ per site)
 *   - `TRACKING_SINK_URL`   (fleet-shared, R8.1 team-inherited)
 *   - `TRACKING_SINK_TOKEN` (fleet-shared, R8.1 team-inherited)
 *
 * For every `sites/<client>` directory that has a matching live Netlify site
 * (by name — same `findNetlifySite` lookup `create-site.mjs` uses), prints a
 * per-site table with a ✓/☐ mark per row and, for a present row, whether it
 * was found at the SITE level or inherited from the TEAM (`GET /api/v1/
 * accounts/{account_slug}/env`, names only — this tool never reads or logs
 * an env var's VALUE, full stop, for any row, present or missing).
 *
 * `--fix` mints a missing `TRACKING_SALT` (fresh random, 32+ chars, via the
 * same generator create-site.mjs uses) and sets a missing `TRACKING_PROJECT_ID`
 * to the client slug — the two PER-SITE rows only. It NEVER writes
 * `TRACKING_SINK_URL`/`TRACKING_SINK_TOKEN` (fleet-shared — R8.1 retired that
 * copy path everywhere, this tool included) and never touches any env var
 * outside this four-row set (`NETLIFY_AUTH_TOKEN` included) — the write path
 * is a fixed allowlist of exactly two names, not a generic "fix what's
 * missing" loop over someone else's checklist. Idempotent: a row already
 * present is left untouched, so running `--fix` twice changes nothing the
 * second time.
 *
 * Exit codes (so this can run unattended in CI):
 *   0 — every audited site has every row (or nothing needed auditing).
 *   1 — one or more rows are missing on one or more sites, or a site's
 *       check could not complete (fails closed — never reported as "ok").
 *   2 — could not run at all: `NETLIFY_AUTH_TOKEN` is unset. Not a crash —
 *       a one-line message on stderr and a clean exit.
 *
 * Usage:
 *   NETLIFY_AUTH_TOKEN=... node packages/core/cli/env-audit.mjs
 *   NETLIFY_AUTH_TOKEN=... node packages/core/cli/env-audit.mjs --fix
 *   NETLIFY_AUTH_TOKEN=... node packages/core/cli/env-audit.mjs --site acme
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENV_CHECKLIST, findNetlifySite, getAccountEnvVarNames, getNetlifyEnvVars, setNetlifyEnvVar } from './create-site.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Single source of truth for row metadata (cls/generate/teamInherited) is
// create-site.mjs's ENV_CHECKLIST — this just selects the tracking subset.
const TRACKING_ROW_NAMES = ['TRACKING_PROJECT_ID', 'TRACKING_SALT', 'TRACKING_SINK_URL', 'TRACKING_SINK_TOKEN'];
export const AUDIT_ROWS = ENV_CHECKLIST.flatMap(({ rows }) => rows).filter((row) => TRACKING_ROW_NAMES.includes(row.name));

// The exact, fixed allowlist `--fix` is ever allowed to write. Never derived
// from AUDIT_ROWS at runtime — a future addition to that list (or to
// ENV_CHECKLIST) must not silently widen what --fix can touch.
const FIXABLE_ROW_NAMES = ['TRACKING_SALT', 'TRACKING_PROJECT_ID'];

/**
 * Every `sites/<client>` directory that looks like a real scaffolded tenant
 * (has `config/site-identity.ts` — the T11.7 scaffold's marker file).
 */
export const listClientSlugs = (root = repoRoot) => {
  const sitesDir = path.join(root, 'sites');
  if (!fs.existsSync(sitesDir)) return [];
  return fs
    .readdirSync(sitesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => fs.existsSync(path.join(sitesDir, name, 'config', 'site-identity.ts')))
    .sort();
};

/**
 * Audits ONE client's live Netlify site for the four tracking rows. Returns
 * a plain data object — names, booleans, and a `level` tag — NEVER a value,
 * by construction: this function only ever inspects `.key` on variables
 * returned by the Netlify API, never `.values`.
 *
 * `found: false` means no Netlify site named `siteName` (default
 * `clientSlug`) exists yet — not a failure, just nothing to audit yet.
 * `checkError` (string) means the site exists but a live lookup failed —
 * reported, never silently treated as "all present".
 */
export const auditSiteEnv = async (fetchImpl, token, clientSlug, { siteName } = {}) => {
  const site = await findNetlifySite(fetchImpl, token, siteName || clientSlug);
  if (!site) return { clientSlug, found: false };

  const siteId = site.id || site.site_id;
  const accountId = site.account_id;
  const accountSlug = site.account_slug || accountId;
  if (!siteId || !accountId) {
    return { clientSlug, found: true, siteId, accountId, checkError: 'Netlify site response has no account id' };
  }

  let siteScopedNames;
  let teamNames;
  try {
    const [siteScoped, team] = await Promise.all([
      getNetlifyEnvVars(fetchImpl, token, accountId, siteId),
      getAccountEnvVarNames(fetchImpl, token, accountSlug),
    ]);
    // NAMES ONLY — `.values` on any entry here is never read.
    siteScopedNames = new Set(siteScoped.map((variable) => variable?.key).filter((key) => typeof key === 'string'));
    teamNames = team;
  } catch (error) {
    return {
      clientSlug,
      found: true,
      siteId,
      accountId,
      accountSlug,
      checkError: error instanceof Error ? error.message : String(error),
    };
  }

  const rows = AUDIT_ROWS.map((row) => {
    if (row.teamInherited) {
      if (teamNames.has(row.name)) return { name: row.name, cls: row.cls, present: true, level: 'team' };
      // A site-level override of a normally team-level var is unusual but
      // possible (e.g. a pre-R8.1 site that still carries one) — still
      // "present", called out as an override rather than silently folded
      // into the "team" case.
      if (siteScopedNames.has(row.name)) return { name: row.name, cls: row.cls, present: true, level: 'site-override' };
      return { name: row.name, cls: row.cls, present: false, level: null };
    }
    const present = siteScopedNames.has(row.name);
    return { name: row.name, cls: row.cls, present, level: present ? 'site' : null };
  });

  return { clientSlug, found: true, siteId, accountId, accountSlug, rows };
};

const LEVEL_LABEL = { team: 'inherited from team', 'site-override': 'set at site level (override of a team-level var)', site: 'set at site level' };

/**
 * @param {Awaited<ReturnType<typeof auditSiteEnv>>} result
 */
export const renderSiteAuditReport = (result) => {
  const lines = [`${result.clientSlug}:`];
  if (!result.found) {
    lines.push('  (no matching Netlify site found — skipped)');
    return lines.join('\n');
  }
  if (result.checkError) {
    lines.push(`  ⚠ could not verify — ${result.checkError}`);
    return lines.join('\n');
  }
  for (const row of result.rows) {
    const mark = row.present ? '✓' : '☐';
    let status;
    if (row.present) {
      status = LEVEL_LABEL[row.level] || 'present';
    } else if (row.name === 'TRACKING_SALT') {
      status = 'missing — run with --fix to mint one';
    } else if (row.name === 'TRACKING_PROJECT_ID') {
      status = `missing — run with --fix to set it to '${result.clientSlug}'`;
    } else if (row.cls === 'fleet-shared') {
      status = 'missing — add it as a TEAM-level env var (Team → Environment variables; scope Functions, all contexts, all projects), then re-run';
    } else {
      status = 'missing';
    }
    lines.push(`  ${mark} ${row.name.padEnd(24)} [${row.cls}]  ${status}`);
  }
  return lines.join('\n');
};

/**
 * `--fix`: mints/sets the two PER-SITE rows this tool is allowed to write,
 * ONLY when currently missing. Returns which names were fixed vs. failed —
 * never a minted value. A row not in `FIXABLE_ROW_NAMES` (which today means:
 * every fleet-shared row) is never passed to `setNetlifyEnvVar` from here,
 * by construction — there is no code path in this function that can reach
 * one.
 */
export const fixSiteEnv = async (fetchImpl, token, result) => {
  const fixed = [];
  const failed = [];
  if (!result.found || result.checkError) return { fixed, failed };

  for (const row of result.rows) {
    if (row.present) continue;
    if (!FIXABLE_ROW_NAMES.includes(row.name)) continue; // fleet-shared rows never reach here
    // `row` here is auditSiteEnv's plain {name, cls, present, level} projection —
    // look the ENV_CHECKLIST row back up for its `generate` closure.
    const checklistRow = AUDIT_ROWS.find((candidate) => candidate.name === row.name);
    const value = row.name === 'TRACKING_PROJECT_ID' ? result.clientSlug : checklistRow.generate();
    try {
      await setNetlifyEnvVar(fetchImpl, token, result.accountId, result.siteId, row.name, value, {
        scopes: ['functions'],
        context: 'all',
        isSecret: row.name === 'TRACKING_SALT',
      });
      fixed.push(row.name);
    } catch (error) {
      failed.push({ name: row.name, message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { fixed, failed };
};

const parseArgs = (argv) => {
  const opts = { fix: false, sites: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fix') opts.fix = true;
    else if (arg === '--site') {
      opts.sites.push(argv[i + 1]);
      i += 1;
    }
  }
  return opts;
};

export const main = async (argv, { fetchImpl = fetch, tokenEnv = process.env, root = repoRoot } = {}) => {
  const token = tokenEnv.NETLIFY_AUTH_TOKEN;
  if (!token) {
    console.error(
      '[env-audit] NETLIFY_AUTH_TOKEN is not set — cannot reach the Netlify API to audit any site. Set it and re-run.'
    );
    return 2;
  }

  const opts = parseArgs(argv);
  const clientSlugs = opts.sites.length ? opts.sites : listClientSlugs(root);
  if (!clientSlugs.length) {
    console.log('[env-audit] no sites/<client> directories found — nothing to audit.');
    return 0;
  }

  let anyMissing = false;
  for (const clientSlug of clientSlugs) {
    let result = await auditSiteEnv(fetchImpl, token, clientSlug);

    if (opts.fix && result.found && !result.checkError) {
      const stillMissingBeforeFix = result.rows.some((row) => !row.present);
      if (stillMissingBeforeFix) {
        const { fixed, failed } = await fixSiteEnv(fetchImpl, token, result);
        if (fixed.length) console.log(`[env-audit] ${clientSlug}: fixed ${fixed.join(', ')}`);
        for (const failure of failed) console.error(`[env-audit] ${clientSlug}: FAILED to fix ${failure.name}: ${failure.message}`);
        // Re-audit so the printed table reflects what --fix actually did,
        // not the pre-fix snapshot.
        result = await auditSiteEnv(fetchImpl, token, clientSlug);
      }
    }

    console.log(renderSiteAuditReport(result));
    if (!result.found) continue;
    if (result.checkError || result.rows.some((row) => !row.present)) anyMissing = true;
  }

  return anyMissing ? 1 : 0;
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[env-audit] FAILED: ${error instanceof Error ? error.message : error}`);
      process.exit(1);
    }
  );
}
