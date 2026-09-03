/**
 * Repo-wide invariant (W6 D4): every `CriterionStatus` tier must be handled
 * everywhere the admin turns a status into something a person sees.
 *
 * Why this exists as a source scan rather than a normal unit test: the two
 * consumers live on opposite sides of the repo's test boundary.
 * `statusTone` (packages/core/admin/logic.ts) IS compiled by
 * tsconfig.test.json and pinned by logic.test.ts. `STATUS_ICON`
 * (packages/core/admin/data.tsx) is NOT — the config excludes
 * `packages/core/admin/**\/*.tsx` because the repo has no DOM/component test
 * stack, so only `astro check` type-checks it.
 *
 * That gap is not theoretical. Adding the `info` tier compiled clean, passed
 * the whole node suite, and then failed CI on `astro check` with
 * "Property 'info' is missing in type … but required in
 * Record<CriterionStatus, ReactNode>" — a five-minute fix found the slowest
 * possible way. `astro check` is a minute-plus and does not run in the normal
 * test loop; this file is the sub-second version that fails in `npm test`
 * instead.
 *
 * Deliberately a text scan and deliberately narrow: it reads the declared
 * union from the type and asserts each member appears as a key in each map.
 * It does not try to type-check anything — `astro check` still owns that, and
 * this is the early warning, not a replacement.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const read = (relative) => readFileSync(join(root, relative), 'utf8');

/** The declared union members of CriterionStatus, in declaration order. */
const declaredStatuses = () => {
  const source = read('packages/core/lib/admin/readiness-criteria.ts');
  const match = source.match(/export type CriterionStatus\s*=\s*([^;]+);/);
  assert.ok(match, 'could not find the CriterionStatus type declaration — did it move or get renamed?');
  const statuses = [...match[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(statuses.length >= 4, `expected several status tiers, parsed: ${JSON.stringify(statuses)}`);
  return statuses;
};

/** The keys of an object literal assigned to `name`, read as source text. */
const mapKeys = (source, name) => {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `could not find ${name}`);
  const open = source.indexOf('{', start);
  const close = source.indexOf('\n};', open);
  assert.ok(open !== -1 && close > open, `could not read the ${name} object literal`);
  return [...source.slice(open, close).matchAll(/^\s{2}([a-z_]+):/gm)].map((m) => m[1]);
};

test('every CriterionStatus has an icon in the admin readiness list', () => {
  // packages/core/admin/data.tsx is outside the node test stack — this is the
  // only place a missing tier is caught before `astro check`.
  const keys = mapKeys(read('packages/core/admin/data.tsx'), 'STATUS_ICON');
  for (const status of declaredStatuses()) {
    assert.ok(
      keys.includes(status),
      `CriterionStatus '${status}' has no entry in STATUS_ICON (packages/core/admin/data.tsx). ` +
        `That map is Record<CriterionStatus, ReactNode>, so this is an astro check failure waiting to happen.`
    );
  }
});

test('every CriterionStatus has a case in statusTone', () => {
  const source = read('packages/core/admin/logic.ts');
  const start = source.indexOf('export function statusTone');
  assert.notEqual(start, -1, 'could not find statusTone');
  const body = source.slice(start, start + 1600);
  for (const status of declaredStatuses()) {
    assert.ok(
      body.includes(`case '${status}':`),
      `CriterionStatus '${status}' has no case in statusTone — it would fall through to the default tone.`
    );
  }
});
