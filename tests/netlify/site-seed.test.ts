/**
 * Offline verification of the site singleton seed
 * (scripts/lib/site-seed-data.mjs) — the W4 conversion's byte-identical
 * transcription of the currently hardcoded site configuration:
 *
 *   - the body parses under site.v1 (strict — a stray key fails); the id
 *     passes T0.3; validation is clean with the defaultNavigation reference
 *     targets resolvable;
 *   - the brand-token color set covers exactly the CustomStyles.astro custom
 *     properties (every `--aw-color-*` in both blocks, dark overrides under
 *     the `dark:` key prefix) so the data-driven render has a value for every
 *     var it emits;
 *   - a missing defaultNavigation target is a real blocker (the reference
 *     check is live for site objects, not decorative).
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { summarizeValidation, validateObject } from '../../packages/core/server/lib/object-validate.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { siteBodySchema, type SiteBody } from '../../packages/core/schema/bodies/site-v1.js';
import { CONVERSION_SEEDS, SEED_SITE, siteBody } from '../../sites/drlurie/seeds/site-seed-data.mjs';

const body = siteBody as SiteBody;

// The compiled test runs from a temp dir; ascend to the repo root to read the
// committed production export.
const findExport = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    const candidate = join(dir, 'sites', 'drlurie', 'data', 'site', 'site.json');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate sites/drlurie/data/site/site.json');
};

// Order-independent deep equality (the export sorts object keys).
const stable = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => [key, stable((value as Record<string, unknown>)[key])])
        )
      : value;

const resolveObject = (objectType: string, objectId: string) => ({
  exists: objectType === 'navigation' && ['nav_header', 'nav_footer', 'nav_footer_home'].includes(objectId),
});

test('the batch is the single site_drlurie singleton owning itself', () => {
  assert.equal(SEED_SITE, 'site_drlurie');
  assert.deepEqual(
    (CONVERSION_SEEDS as Array<{ objectType: string; objectId: string }>).map((seed) => [
      seed.objectType,
      seed.objectId,
    ]),
    [['site', 'site_drlurie']]
  );
});

// Fields production owns and a seed must not: an operator configures these per site
// THROUGH THE ADMIN after the site exists, so production legitimately carries values a
// seed has no business shipping. `brandImagery` is set from a visual standard or derived
// from a theme; `pdf` binds that tenant's own template ids. Comparing them made a routine
// publish turn `main` red — four consecutive runs in a row on 2026-09-07 — and pulling
// them INTO the seed is worse: the seed is the starting state for a NEW site, and six
// brand-imagery tests correctly build on a site that has no brandImagery yet.
//
// Everything else still drifts loudly. Adding a key here is a deliberate statement that
// production owns it, not a way to quiet a failing guard.
const OPERATOR_OWNED_KEYS = new Set(['brandImagery', 'pdf']);

test('the seed body matches the released production export (drift guard — run sites/drlurie/seeds/sync-site-seed.mjs)', () => {
  const exported = JSON.parse(readFileSync(findExport(), 'utf8')) as Record<string, unknown>;
  delete exported.__generated;
  const drift = [...new Set([...Object.keys(exported), ...Object.keys(body as Record<string, unknown>)])]
    .filter((key) => !OPERATOR_OWNED_KEYS.has(key))
    .filter(
      (key) => JSON.stringify(stable((body as Record<string, unknown>)[key])) !== JSON.stringify(stable(exported[key]))
    );
  assert.deepEqual(
    drift,
    [],
    `site seed drifted from production on: ${drift.join(', ')} — run \`node sites/drlurie/seeds/sync-site-seed.mjs\` to resync`
  );
});

// The exemption list is the whole risk of narrowing the guard: it is quiet by design, so
// growing it must be a visible line in a diff rather than a thing that happens.
test('exactly two keys are exempt from the drift guard, and they are the operator-owned ones', () => {
  assert.deepEqual([...OPERATOR_OWNED_KEYS].sort(), ['brandImagery', 'pdf']);
});

test('the body parses under site.v1 and the id passes T0.3', () => {
  const parsed = siteBodySchema.safeParse(body);
  assert.ok(parsed.success, JSON.stringify(parsed.success ? '' : parsed.error.issues));
  assert.ok(validateObjectIdForType('site', 'site_drlurie').ok);
});

test('the singleton validates clean with the defaultNavigation targets resolvable', () => {
  const summary = summarizeValidation(
    validateObject({ objectType: 'site', objectId: 'site_drlurie', body }, { resolveObject })
  );
  assert.deepEqual(summary.blockers, [], JSON.stringify(summary.blockers));
});

test('a dangling defaultNavigation target is a blocker (reference check is live)', () => {
  const broken = structuredClone(body) as SiteBody;
  broken.defaultNavigation.header = 'nav_missing';
  const summary = summarizeValidation(
    validateObject({ objectType: 'site', objectId: 'site_drlurie', body: broken }, { resolveObject })
  );
  assert.ok(
    summary.blockers.some((blocker) => JSON.stringify(blocker).includes('nav_missing')),
    JSON.stringify(summary.blockers)
  );
});

test('brand tokens cover every CustomStyles custom property, light and dark', () => {
  const colorKeys = Object.keys(body.brandTokens.colors);
  const light = colorKeys.filter((key) => !key.startsWith('dark:'));
  const dark = colorKeys.filter((key) => key.startsWith('dark:')).map((key) => key.slice('dark:'.length));
  assert.deepEqual(
    light.sort(),
    [
      'accent',
      'bg-page',
      'bg-page-dark',
      'bg-surface',
      'gold',
      'primary',
      'secondary',
      'text-default',
      'text-heading',
      'text-muted',
    ],
    'light tokens must cover the :root block'
  );
  assert.deepEqual(
    dark.sort(),
    ['accent', 'bg-page', 'bg-surface', 'gold', 'primary', 'secondary', 'text-default', 'text-heading', 'text-muted'],
    'dark tokens must cover the .dark block (bg-page-dark has no dark override)'
  );
  for (const key of ['sans', 'serif', 'heading'] as const) {
    assert.ok(body.brandTokens.fonts[key].length > 0, `fonts.${key} present`);
  }
});
