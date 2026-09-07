#!/usr/bin/env node
/**
 * Sync the site-singleton seed to production.
 *
 * `scripts/lib/site-seed-data.mjs` is the reconcile driver's idea of the
 * canonical `site_drlurie` body. It is hand-maintained and drifts: an agent
 * edited the live site's name/logo/metadata (the "Skincare" rebrand) AFTER the
 * seed was written, so the seed no longer matched production — and a
 * `home-conversion-roundtrip --seeds site-seed-data.mjs --production` run would
 * have "healed" the live branding back to the stale seed. This script closes
 * that gap: it rewrites the seed's `siteBody` from the COMMITTED production
 * export (`sites/drlurie/data/site/site.json` — W11 T11.6 relocated this from
 * `src/data/site/site.json` — the byte-for-byte materialization of the
 * released store record), so seed === production and a reconcile is a no-op.
 *
 * The export is the right source of truth: it is what the release materialized
 * and what the renderers read; it needs no credentials and is deterministic.
 * Re-run this whenever the site export changes (after any released
 * set_site_fields / site_apply_theme) to keep the seed honest before the next
 * site-family reconcile.
 *
 * brandTokens is included for completeness (create + byte-identity), but note
 * the reconcile driver's site branch EXCLUDES brandTokens (theme-only palette
 * governance, Wolf 2026-07-15) — the palette is healed by applying a theme, not
 * by this seed.
 *
 * Usage:
 *   node scripts/sync-site-seed.mjs           # write the seed in sync with the export
 *   node scripts/sync-site-seed.mjs --check    # report drift, exit 1 if any (CI-friendly)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
// W11 T11.6: the export moved from src/data/site/ to sites/drlurie/data/site/.
const EXPORT_PATH = path.join(repoRoot, 'sites', 'drlurie', 'data', 'site', 'site.json');
const SEED_PATH = path.join(repoRoot, 'sites', 'drlurie', 'seeds', 'site-seed-data.mjs');

const checkOnly = process.argv.slice(2).includes('--check');

// ── the production truth: the committed, released export minus its provenance ──
if (!fs.existsSync(EXPORT_PATH)) {
  console.error(`[sync-site-seed] export not found: ${EXPORT_PATH}`);
  process.exit(2);
}
const exported = JSON.parse(fs.readFileSync(EXPORT_PATH, 'utf8'));
delete exported.__generated;

// ── the current seed body ──
const seedModule = await import(pathToFileURL(SEED_PATH).href);
const currentBody = seedModule.siteBody;

// ── order-independent deep drift report (values only, ignore key order) ──
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])])
        )
      : value;

// Fields production owns and a seed must not. An operator configures these per site
// THROUGH THE ADMIN after the site exists — `brandImagery` from a visual standard or
// derived from a theme, `pdf` binding that tenant's own template ids — so a routine
// content publish carries them into the export and the guard fired on a difference that
// is not drift at all. Four consecutive `main` runs went red that way on 2026-09-07.
//
// Syncing them INTO the seed is worse: a seed is the starting state for a NEW site, and
// six brand-imagery tests correctly build on a site that has no `brandImagery` yet.
//
// Everything else still drifts loudly. Adding a key here is a deliberate statement that
// production owns it, not a way to quiet a failing guard — tests/netlify/site-seed.test.ts
// imports this list and pins its contents so growing it shows up in a diff.
export const OPERATOR_OWNED_KEYS = ['brandImagery', 'pdf'];

const driftedKeys = [...new Set([...Object.keys(exported), ...Object.keys(currentBody)])]
  .filter((key) => !OPERATOR_OWNED_KEYS.includes(key))
  .filter((key) => JSON.stringify(stable(currentBody[key])) !== JSON.stringify(stable(exported[key])));

if (driftedKeys.length === 0) {
  console.log('[sync-site-seed] seed already matches the production export — nothing to do.');
  process.exit(0);
}

console.log(`[sync-site-seed] drifted field(s) vs production: ${driftedKeys.join(', ')}`);
for (const key of driftedKeys) {
  console.log(`  · ${key}`);
  console.log(`      seed: ${JSON.stringify(currentBody[key])}`);
  console.log(`      prod: ${JSON.stringify(exported[key])}`);
}

if (checkOnly) {
  console.error('[sync-site-seed] --check: seed is OUT OF SYNC with production. Run without --check to fix.');
  process.exit(1);
}

// ── build the next body with a MINIMAL diff: the export is the source of
//    truth, so the result carries EXACTLY the export's keys. Keep every
//    unchanged field verbatim from the seed (preserving its readable key
//    order/formatting — e.g. brandTokens' grouped order), take the export's
//    value for fields that drifted, DROP any seed-only keys (a key the export
//    no longer has), and append any export-only keys last — so a sync always
//    reaches seed === export (the drift guard's invariant). ──
const valuesEqual = (a, b) => JSON.stringify(stable(a)) === JSON.stringify(stable(b));
const nextBody = {};
for (const key of Object.keys(currentBody)) {
  if (!(key in exported)) continue; // seed-only key → dropped (export is authoritative)
  nextBody[key] = valuesEqual(currentBody[key], exported[key]) ? currentBody[key] : exported[key];
}
for (const key of Object.keys(exported)) if (!(key in nextBody)) nextBody[key] = exported[key];

// ── serialize as a JS object literal (prettier-compatible; prettier --write
//    normalizes any remaining style afterward). ──
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const keyLiteral = (key) => (IDENT.test(key) ? key : `'${key.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`);
const stringLiteral = (value) =>
  value.includes("'") && !value.includes('"')
    ? JSON.stringify(value) // double quotes avoid escaping the single quotes (font stacks)
    : `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
const literal = (value, depth) => {
  if (value === null) return 'null';
  if (typeof value === 'string') return stringLiteral(value);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  const pad = '  '.repeat(depth);
  const padIn = '  '.repeat(depth + 1);
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => padIn + literal(item, depth + 1)).join(',\n')}\n${pad}]`;
  }
  const keys = Object.keys(value);
  if (keys.length === 0) return '{}';
  return `{\n${keys.map((key) => `${padIn}${keyLiteral(key)}: ${literal(value[key], depth + 1)}`).join(',\n')}\n${pad}}`;
};

const block = `export const siteBody = ${literal(nextBody, 0)};`;

const source = fs.readFileSync(SEED_PATH, 'utf8');
const pattern = /export const siteBody = \{[\s\S]*?\n\};/;
if (!pattern.test(source)) {
  console.error('[sync-site-seed] could not locate the `export const siteBody = { … };` block to replace.');
  process.exit(2);
}
fs.writeFileSync(SEED_PATH, source.replace(pattern, block));
console.log(`[sync-site-seed] rewrote ${path.relative(repoRoot, SEED_PATH)} from the production export.`);
console.log(
  '[sync-site-seed] run `npx prettier --write sites/drlurie/seeds/site-seed-data.mjs` to normalize, then re-run the seed test.'
);
