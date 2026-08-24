/**
 * T16.0 — genesis-manifest drift test.
 *
 * The manifest (`packages/core/cli/genesis-manifest.mjs`) is the one staged
 * source of truth for what a tenant is born with. This test is the thing that
 * makes it true rather than aspirational, in three directions:
 *
 *   1. MANIFEST → FLEET: every entry exists on every existing site where its
 *      stage says it must (seed file present, export subdir present).
 *   2. MANIFEST → CONSUMERS: `buildPlan()`'s seed block, `DATA_SITE_SUBDIRS`
 *      and the genesis drive's `SEED_MODULES` all derive from it, in the right
 *      order — and no consumer carries an entry the manifest doesn't.
 *   3. SCAFFOLD COVERAGE: every file create-site emits falls in exactly one
 *      declared scaffold group, so a new scaffold family cannot appear
 *      undeclared.
 *
 * Plain, uncompiled node:test run directly against the real repo (the
 * admin-parity.test.mjs / discover-fleet-matrix.test.mjs pattern), and picked
 * up by `npm test`'s `node --test tests/scripts/*.test.mjs` leg.
 *
 * ── KNOWN GAPS ──────────────────────────────────────────────────────────────
 * The manifest states the TARGET; the fleet does not meet all of it yet. Each
 * unmet target is one row in `KNOWN_GAPS` below, annotated with the task that
 * closes it, and is asserted to STILL FAIL. So the suite is green, the gaps
 * are machine-recorded rather than forgotten, and the moment a gap is fixed
 * this test goes red telling whoever fixed it to delete the row.
 *
 * T16.1 closed the four original rows (voice + platform templates). It also
 * found a fifth, narrower one: `tracking-config-seed-data.mjs` joined the
 * manifest alongside `voice-seed-data.mjs` (same onboarding-stage shape,
 * same ruling), but T16.1's own backfill scope only covered platform —
 * fernwell still lacks the seed file. That row stays open for a fast-follow.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildPlan } from '../../packages/core/cli/create-site.mjs';
import {
  CANONICAL_PACKS,
  DATA_SITE_SUBDIRS,
  SCAFFOLD_GROUPS,
  SEED_MODULES,
  STAGES,
  dataSiteSubdirs,
  genesisSeedFiles,
  pendingEntries,
  scaffoldSeedFiles,
} from '../../packages/core/cli/genesis-manifest.mjs';
import { realTenantNames } from './scratch-sites.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sitesDir = path.join(repoRoot, 'sites');

/**
 * Every real tenant, discovered — never a hardcoded three.
 *
 * Scratch tenants are excluded: admin-parity.test.mjs scaffolds them under `sites/`
 * and node:test runs test FILES concurrently, so one can be on disk while this walk
 * runs. A fresh scaffold is genesis-stage by definition and would fail the manifest
 * targets below — nondeterministically. See tests/scripts/scratch-sites.mjs.
 */
const SITES = realTenantNames(sitesDir);

/**
 * Targets the manifest states that the fleet does not meet yet. Key format is
 * `<check>:<subject>`; `todo` names the task that closes it. A row here is
 * asserted to still FAIL — closing the gap without deleting the row is itself
 * a failure, which is how the annotation gets cleaned up.
 */
const KNOWN_GAPS = new Map([]);

const exercised = new Set();

/**
 * Assert a manifest target holds — unless it is a recorded gap, in which case
 * assert it still does NOT hold.
 */
const expectTarget = (key, holds, message) => {
  const gap = KNOWN_GAPS.get(key);
  if (!gap) {
    assert.ok(holds, message);
    return;
  }
  exercised.add(key);
  assert.ok(
    !holds,
    `EXPECTED-FAILURE '${key}' (todo: ${gap.todo}) now HOLDS — the gap is closed. Delete its row from KNOWN_GAPS in this test.`
  );
};

const plan = buildPlan({ name: 'genesis-manifest-probe' });
const planPaths = plan.files.map((file) => file.path.replace('sites/genesis-manifest-probe/', ''));

// ─── 0. manifest shape ──────────────────────────────────────────────────────

test('manifest entries are well formed: known stages, unique ids, a contiguous drive order', () => {
  for (const entry of SEED_MODULES) {
    assert.ok(STAGES.includes(entry.stage), `seed ${entry.file} has unknown stage '${entry.stage}'`);
    assert.match(entry.file, /-seed-data\.mjs$/);
  }
  for (const entry of DATA_SITE_SUBDIRS) {
    assert.ok(STAGES.includes(entry.stage), `subdir ${entry.name} has unknown stage '${entry.stage}'`);
  }
  const dupes = (values) => values.filter((v, i) => values.indexOf(v) !== i);
  assert.deepEqual(dupes(SEED_MODULES.map((e) => e.file)), []);
  assert.deepEqual(dupes(DATA_SITE_SUBDIRS.map((e) => e.name)), []);
  assert.deepEqual(dupes(SCAFFOLD_GROUPS.map((e) => e.id)), []);

  // Only genesis-stage seeds are driven, and their order is 1..n exactly once.
  const driven = SEED_MODULES.filter((e) => e.driveOrder !== undefined);
  assert.deepEqual(
    driven.map((e) => e.stage),
    driven.map(() => 'genesis'),
    'driveOrder on a non-genesis seed: the drive only births genesis-stage objects'
  );
  assert.deepEqual(
    driven.map((e) => e.driveOrder).sort((a, b) => a - b),
    driven.map((_, i) => i + 1)
  );
});

test('the navs-first genesis law is encoded in the manifest, not in the driver', () => {
  assert.deepEqual(genesisSeedFiles().slice(0, 2), ['navigation-seed-data.mjs', 'site-seed-data.mjs']);
});

// ─── 1. manifest → fleet ────────────────────────────────────────────────────

test('every existing site carries every seed module the manifest lists', () => {
  assert.ok(SITES.length >= 3, `expected the three tenants under sites/, found: ${SITES.join(', ') || 'none'}`);
  for (const site of SITES) {
    for (const entry of SEED_MODULES) {
      const file = path.join(sitesDir, site, 'seeds', entry.file);
      expectTarget(
        `seed-present:${site}:${entry.file}`,
        fs.existsSync(file),
        `sites/${site}/seeds/${entry.file} is missing — the manifest says every tenant carries it (stage: ${entry.stage})`
      );
    }
  }
});

test('every existing site carries every data/site export subdir the manifest lists', () => {
  for (const site of SITES) {
    for (const entry of DATA_SITE_SUBDIRS) {
      const dir = path.join(sitesDir, site, 'data', 'site', entry.name);
      expectTarget(
        `subdir-present:${site}:${entry.name}`,
        fs.existsSync(dir) && fs.statSync(dir).isDirectory(),
        `sites/${site}/data/site/${entry.name}/ is missing — the manifest says every tenant carries it (stage: ${entry.stage})`
      );
    }
  }
});

// ─── 1b. canonical packs (T14.1) ────────────────────────────────────────────
//
// Two directions, mirroring the fleet checks above: every site RECEIVES every
// canonical id (nothing quietly missing one), and no site RESTATES a
// canonical body as its own local literal — the exact failure the pack
// exists to end. The restatement check is a referential-identity check, not
// a content diff: a site that imports the canonical export gets the SAME
// object; a site that pastes an identical-looking literal instead gets a
// different one, so `===` catches restatement even when the copy is
// byte-perfect today. A site's OWN recipes (no `portability: 'canonical'`
// stamp — absent means 'client', recipe-metadata-v1.ts) are never examined
// here; only entries actually claiming to be canonical are held to it.

for (const pack of CANONICAL_PACKS) {
  test(`canonical pack ${pack.module}: every site receives it, and no site restates a body it imports`, async () => {
    const packMod = await import(pathToFileURL(path.join(repoRoot, pack.module)).href);
    const ids = packMod[pack.idsExport];
    const entries = packMod[pack.entriesExport];
    assert.ok(Array.isArray(ids) && ids.length > 0, `${pack.module} exports no ${pack.idsExport}`);
    assert.ok(Array.isArray(entries) && entries.length > 0, `${pack.module} exports no ${pack.entriesExport}`);
    assert.deepEqual(
      entries.map((e) => e.objectId).sort(),
      [...ids].sort(),
      `${pack.idsExport} and ${pack.entriesExport} disagree on membership`
    );
    const bodyById = new Map(entries.map((e) => [e.objectId, e.body]));

    for (const site of SITES) {
      const consumerFile = path.join(sitesDir, site, 'seeds', pack.consumedBy);
      if (!fs.existsSync(consumerFile)) continue; // covered by the seed-present check above
      const consumerMod = await import(pathToFileURL(consumerFile).href);
      const seeds = consumerMod.CONVERSION_SEEDS ?? [];
      const seedById = new Map(seeds.map((s) => [s.objectId, s.body]));

      for (const id of ids) {
        expectTarget(
          `canonical-received:${site}:${id}`,
          seedById.has(id),
          `sites/${site}/seeds/${pack.consumedBy} does not carry canonical recipe '${id}' — every site must receive the canonical pack`
        );
      }

      for (const [id, body] of seedById) {
        if (body?.portability !== 'canonical') continue; // a site-specific override under the same id — not this check's business
        assert.equal(
          body,
          bodyById.get(id),
          `sites/${site}/seeds/${pack.consumedBy}'s '${id}' is stamped portability: 'canonical' but is not the SAME object ${pack.module} exports — it restates the canonical body locally instead of importing it`
        );
      }
    }
  });
}

// ─── 2. manifest → consumers ────────────────────────────────────────────────

test('create-site scaffolds exactly the manifest seed pack, in manifest order', () => {
  const scaffolded = planPaths.filter((p) => p.startsWith('seeds/')).map((p) => p.slice('seeds/'.length));

  // Nothing the manifest doesn't know about (this direction has no gaps: a
  // consumer inventing a seed is always a bug).
  const manifestFiles = SEED_MODULES.map((entry) => entry.file);
  assert.deepEqual(
    scaffolded.filter((file) => !manifestFiles.includes(file)),
    [],
    'buildPlan() emits a seed file the genesis manifest does not list'
  );

  // …and everything the manifest says a tenant is born with.
  for (const entry of SEED_MODULES) {
    expectTarget(
      `seed-scaffolded:${entry.file}`,
      scaffolded.includes(entry.file),
      `buildPlan() does not emit seeds/${entry.file}, which the manifest lists (stage: ${entry.stage})`
    );
  }
  assert.deepEqual(scaffolded, scaffoldSeedFiles(), 'seed order drifted from the manifest');
});

test('create-site scaffolds exactly the manifest export tree', () => {
  const scaffolded = planPaths
    .filter((p) => /^data\/site\/[^/]+\/\.gitkeep$/.test(p))
    .map((p) => p.split('/')[2])
    .sort();

  const manifestNames = DATA_SITE_SUBDIRS.map((entry) => entry.name);
  assert.deepEqual(
    scaffolded.filter((name) => !manifestNames.includes(name)),
    [],
    'buildPlan() emits a data/site subdir the genesis manifest does not list'
  );
  for (const entry of DATA_SITE_SUBDIRS) {
    expectTarget(
      `subdir-scaffolded:${entry.name}`,
      scaffolded.includes(entry.name),
      `buildPlan() does not scaffold data/site/${entry.name}/, which the manifest lists (stage: ${entry.stage})`
    );
  }
  assert.deepEqual([...dataSiteSubdirs()].sort(), scaffolded);
});

test('the genesis drive derives SEED_MODULES from the manifest rather than repeating it', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts', 'site-genesis-drive.mjs'), 'utf8');
  assert.match(
    source,
    /genesisSeedFiles\(\)/,
    'site-genesis-drive.mjs no longer derives its seed list from the manifest'
  );
  const hardcoded = [...source.matchAll(/'([a-z-]+-seed-data\.mjs)'/g)].map((m) => m[1]);
  assert.deepEqual(hardcoded, [], `site-genesis-drive.mjs hardcodes seed names again: ${hardcoded.join(', ')}`);
});

test('the drive births every genesis-stage seed and nothing from a later stage', () => {
  assert.deepEqual(
    [...genesisSeedFiles()].sort(),
    SEED_MODULES.filter((e) => e.stage === 'genesis' && !e.todo)
      .map((e) => e.file)
      .sort()
  );
  const onboarding = SEED_MODULES.filter((e) => e.stage === 'onboarding').map((e) => e.file);
  for (const file of onboarding) {
    assert.ok(
      !genesisSeedFiles().includes(file),
      `${file} is onboarding-stage — genesis scaffolds the skeleton file but never invents its content (plan §2, 2026-08-05 ruling)`
    );
  }
});

// ─── 3. scaffold-group coverage ─────────────────────────────────────────────

test('every scaffolded file falls in exactly one declared scaffold group', () => {
  const groups = SCAFFOLD_GROUPS.map((group) => ({ ...group, re: new RegExp(group.pattern) }));
  const hits = new Map(groups.map((group) => [group.id, 0]));
  for (const relPath of planPaths) {
    const matched = groups.filter((group) => group.re.test(relPath));
    assert.equal(
      matched.length,
      1,
      `${relPath} matches ${matched.length} scaffold groups (${matched.map((g) => g.id).join(', ') || 'none'}) — declare it in SCAFFOLD_GROUPS`
    );
    hits.set(matched[0].id, hits.get(matched[0].id) + 1);
  }
  const empty = [...hits].filter(([, count]) => count === 0).map(([id]) => id);
  assert.deepEqual(empty, [], `scaffold groups matching nothing create-site emits: ${empty.join(', ')}`);
});

// ─── 4. the ledger itself ───────────────────────────────────────────────────

test('every recorded gap was actually exercised, and every manifest todo is recorded', () => {
  const stale = [...KNOWN_GAPS.keys()].filter((key) => !exercised.has(key));
  assert.deepEqual(stale, [], `KNOWN_GAPS rows no check exercises (stale): ${stale.join(', ')}`);

  for (const entry of pendingEntries()) {
    const covered = [...KNOWN_GAPS].some(([key, gap]) => key.endsWith(`:${entry.id}`) && gap.todo === entry.todo);
    assert.ok(
      covered,
      `manifest entry '${entry.id}' carries todo ${entry.todo} but no KNOWN_GAPS row records what is actually missing`
    );
  }
});
