#!/usr/bin/env node
/**
 * T21.5 dist drill — the acceptance check that a REAL build emits the arm
 * markers and the arm SEO, run against real HTML rather than a render stub.
 *
 *   npm run drill:experiments:dist
 *
 * It is a DRILL, not part of `npm test`, for one reason: proving it requires an
 * ACTIVE experiment, and the committed fleet state has none — that empty state
 * is itself the most important thing this task must not break (the
 * zero-experiment guarantee). So the drill plants an experiment into the
 * working tree, runs the experiments build step + a full `astro build`, asserts
 * against `dist/`, and restores the tree in a `finally` — leaving the repo
 * exactly as it found it whether it passes or fails.
 *
 * The two articles it uses are the real Dr-Lurié parent/variant pair created by
 * `object_create_variant` (W7), so the drill also proves the lineage rule
 * against live content instead of a fixture.
 *
 * What it asserts, and why each one is the thing that matters:
 *   - the CONTROL page carries no arm markup at all beyond its own ids;
 *   - the VARIANT page's <article> carries data-cms-experiment/-variant (this
 *     is what the loader reads to emit its one `exposure`);
 *   - the VARIANT page carries <meta name="robots" content="noindex"> tagged
 *     with data-cms-experiment-arm — the marker that distinguishes the arm's
 *     own de-indexing from the site-wide pre-launch robots default, which is
 *     on for every page today and would otherwise make the assertion vacuous;
 *   - the VARIANT page has EXACTLY ONE canonical, and it points at the CONTROL
 *     route (two conflicting canonicals would be ignored wholesale, leaving
 *     both arms indexable — the failure mode this exists to catch);
 *   - the CONTROL page has exactly one canonical, pointing at itself.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const trackingJson = path.join(repoRoot, 'sites/drlurie/data/site/tracking.json');

const CONTROL = 'req_agent_object_model_demo_20260713_01';
const VARIANT = 'req_agent_object_model_demo_variant_20260831_01';
const CONTROL_ROUTE = '/object-model-demo';
const VARIANT_ROUTE = '/object-model-demo-variant';

const log = (message) => console.log(`[experiments-dist] ${message}`);

const readDistPage = (route) => {
  for (const candidate of [`${route}/index.html`, `${route}.html`]) {
    const file = path.join(repoRoot, 'dist', candidate.replace(/^\//, ''));
    if (existsSync(file)) return { file, html: readFileSync(file, 'utf8') };
  }
  throw new Error(`no built page for ${route} under dist/`);
};

// astro-compress normalizes attribute ORDER in the built HTML, so every
// assertion below matches a tag and then its attributes, never a fixed string.
const tags = (html, name) => [...html.matchAll(new RegExp(`<${name}\\b[^>]*>`, 'g'))].map((match) => match[0]);
const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
const hasAttrs = (tag, expected) => Object.entries(expected).every(([key, value]) => attr(tag, key) === value);
const findTag = (html, name, expected) => tags(html, name).find((tag) => hasAttrs(tag, expected));
const canonicals = (html) => tags(html, 'link').filter((tag) => attr(tag, 'rel') === 'canonical');
const hrefOf = (tag) => attr(tag, 'href') ?? '';

const original = readFileSync(trackingJson, 'utf8');
try {
  const body = JSON.parse(original);
  body.experiments = [
    {
      object_id: CONTROL,
      status: 'active',
      arms: [
        { variant_id: CONTROL, route: CONTROL_ROUTE },
        { variant_id: VARIANT, route: VARIANT_ROUTE },
      ],
    },
  ];
  writeFileSync(trackingJson, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  log('planted one ACTIVE experiment over the real parent/variant pair');

  execFileSync('npm', ['run', 'build'], {
    cwd: repoRoot,
    stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', FORCE_COLOR: '0' },
  });

  const generated = JSON.parse(readFileSync(path.join(repoRoot, 'netlify/edge-functions/_experiments.generated.json'), 'utf8'));
  assert.deepEqual(Object.keys(generated.experiments), [CONTROL], 'the edge map names the control');
  assert.deepEqual(
    generated.experiments[CONTROL].arms.map((arm) => arm.weight),
    [50, 50],
    'no weights configured → an even split'
  );
  const publicMap = JSON.parse(readFileSync(path.join(repoRoot, 'dist/_trk/experiments.json'), 'utf8'));
  assert.deepEqual(publicMap, generated.experiments, 'the public copy shipped into dist and matches the edge copy');
  log('both artifacts built and agree');

  const control = readDistPage(CONTROL_ROUTE);
  const variant = readDistPage(VARIANT_ROUTE);

  // ── wrapper markers ──
  assert.ok(
    findTag(variant.html, 'article', { 'data-cms-experiment': CONTROL, 'data-cms-variant': VARIANT }),
    'the variant article wrapper carries both arm ids'
  );
  assert.ok(
    findTag(control.html, 'article', { 'data-cms-experiment': CONTROL, 'data-cms-variant': CONTROL }),
    'the CONTROL is an arm too — the loader must count its exposures or the denominator is wrong'
  );

  // ── arm SEO ──
  assert.ok(
    findTag(variant.html, 'meta', { name: 'robots', content: 'noindex', 'data-cms-experiment-arm': VARIANT }),
    "the variant carries its own noindex, marked as the arm's"
  );
  assert.doesNotMatch(
    control.html,
    /data-cms-experiment-arm=/,
    'the control carries NO arm noindex — it is the page that is meant to rank'
  );

  const variantCanonicals = canonicals(variant.html);
  assert.equal(variantCanonicals.length, 1, `expected exactly one canonical on the variant, saw ${variantCanonicals.length}`);
  assert.ok(
    hrefOf(variantCanonicals[0]).endsWith(CONTROL_ROUTE),
    `the variant canonicalizes to the control (saw ${hrefOf(variantCanonicals[0])})`
  );

  const controlCanonicals = canonicals(control.html);
  assert.equal(controlCanonicals.length, 1);
  assert.ok(
    hrefOf(controlCanonicals[0]).endsWith(CONTROL_ROUTE),
    `the control canonicalizes to itself (saw ${hrefOf(controlCanonicals[0])})`
  );

  log('PASS — variant: noindex + canonical-to-control; control: neither.');
} finally {
  writeFileSync(trackingJson, original, 'utf8');
  execFileSync('node', ['scripts/tracking-experiments-build.mjs'], { cwd: repoRoot, stdio: 'ignore' });
  log('restored tracking.json and the zero-experiment artifacts');
}
