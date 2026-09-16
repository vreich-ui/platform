#!/usr/bin/env node
/**
 * The charter of the genesis-scaffold job, enforced.
 *
 * That job exists so tenant birth needs no human, which means it holds something no other workflow
 * in this repo holds: a token that can commit to `main`, driven by a dispatch from another system.
 * The thing standing between "genesis scaffolds a tenant" and "a dispatch rewrites the fleet" is
 * this file. It runs after the scaffold and BEFORE the commit, and it refuses anything that is not
 * the birth of exactly one new tenant.
 *
 * Three paths may change, and nothing else:
 *
 *   sites/<slug>/**             ADDED only. A modification or deletion here means the slug already
 *                               existed — create-site is idempotent and leaves an existing tree
 *                               untouched, so a modified file there is something else entirely.
 *   package-lock.json           MODIFIED. A new site is a new npm workspace; without the regenerated
 *                               lockfile every `npm ci` in the fleet fails.
 *   docs/generated/INVENTORY.md MODIFIED. A generated artifact whose freshness `npm test` gates, so
 *                               omitting it turns the next run on main red for everyone.
 *
 * Mirrors capture-preview-report.mjs, which asserts that job's own refusals rather than trusting
 * them. The pattern is the point: a workflow's charter is a claim until something fails on it.
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** The object-id law (packages/core/lib/object-ids.ts), re-stated rather than imported: this runs
 *  before any build, and a guard that can be widened from elsewhere is not a guard. */
// Matches create-site's own validateClientSlug, not a looser re-statement of it: a guard that is
// more permissive than the thing it guards is a guard with a gap in it by construction.
export const LEGAL_SLUG = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
export const SLUG_LENGTH = { min: 2, max: 31 };

export const ALLOWED_MODIFICATIONS = new Set(['package-lock.json', 'docs/generated/INVENTORY.md']);

/** `git status --porcelain -z`: NUL-separated, so a path containing a space or quote cannot be
 *  mistaken for two entries. */
export const parsePorcelain = (output) => {
  const records = output.split('\0').filter(Boolean);
  const entries = [];
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    const code = record.slice(0, 2);
    entries.push({ code, path: record.slice(3) });
    // A rename/copy emits the ORIGINAL path as a SEPARATE record carrying no status prefix. Consume
    // it here, or the next loop reads its first two characters as a status code and its remainder as
    // a path — a garbled violation instead of a legible one.
    if (code[0] === 'R' || code[0] === 'C') {
      index += 1;
      if (records[index] !== undefined) entries.push({ code: 'R-', path: records[index] });
    }
  }
  return entries;
};

/**
 * @returns {{ ok: boolean, siteFiles: number, violations: string[] }}
 */
export const classifyScaffoldChanges = (slug, entries) => {
  const violations = [];
  if (!LEGAL_SLUG.test(slug) || slug.length < SLUG_LENGTH.min || slug.length > SLUG_LENGTH.max) {
    return { ok: false, siteFiles: 0, violations: [`"${slug}" is not a legal tenant slug`] };
  }
  const sitePrefix = `sites/${slug}/`;
  const modified = new Set();
  let siteFiles = 0;

  for (const { code, path } of entries) {
    const added = code === '??' || code.includes('A');
    if (path.startsWith(sitePrefix)) {
      if (added) siteFiles += 1;
      else violations.push(`${path} is ${code.trim()}, but a new tenant's tree may only be ADDED (does sites/${slug}/ already exist?)`);
      continue;
    }
    if (ALLOWED_MODIFICATIONS.has(path)) {
      if (added) violations.push(`${path} is being ADDED, which means it was missing — this job regenerates it, it does not create it`);
      else if (code.includes('D')) violations.push(`${path} is being DELETED. The charter permits it to be MODIFIED; deleting the root lockfile breaks npm ci for the whole fleet`);
      else modified.add(path);
      continue;
    }
    violations.push(`${path} (${code.trim()}) is outside this job's charter`);
  }

  if (siteFiles === 0) violations.push(`no files under ${sitePrefix} — the scaffold produced nothing, so there is no tenant to commit`);
  // The charter is a ceiling for two paths and a FLOOR for this one. A new site is a new npm
  // workspace: committing the tree without the regenerated lockfile makes every `npm ci` in the
  // fleet fail, so a no-op `npm install` must not pass for a completed scaffold.
  if (siteFiles > 0 && !modified.has('package-lock.json')) {
    violations.push('package-lock.json did not change — a new site is a new npm workspace, so a scaffold that leaves the root lockfile untouched breaks npm ci for the whole fleet');
  }
  return { ok: violations.length === 0, siteFiles, violations };
};

export const main = () => {
  const slug = (process.env.GENESIS_SLUG ?? '').trim();
  const entries = parsePorcelain(execFileSync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { encoding: 'utf8' }));
  const result = classifyScaffoldChanges(slug, entries);

  if (!result.ok) {
    console.error(`[genesis-scaffold-guard] Refusing to commit. The scaffold of "${slug}" touched paths outside its charter:`);
    for (const violation of result.violations) console.error(`  - ${violation}`);
    console.error('\nNothing has been committed. The charter is sites/<slug>/** (added), package-lock.json and docs/generated/INVENTORY.md (modified).');
    process.exit(1);
  }
  console.log(`[genesis-scaffold-guard] OK — ${result.siteFiles} file(s) under sites/${slug}/, plus the regenerated lockfile and inventory.`);
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
