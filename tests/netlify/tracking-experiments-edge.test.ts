/**
 * T21.5 — the EDGE decision (`lib/tracking/experiments/edge-core.ts`).
 *
 * This is the file that stands in for a Deno test of
 * `netlify/edge-functions/variant-serve.ts`. That wrapper is ~30 lines of
 * Deno wiring around `decide()` and holds no branch of its own; every branch
 * the edge takes is here, exercised in the exact order the function evaluates
 * them, because the wrapper is excluded from `tsc` (Deno `.ts` specifiers) and
 * would otherwise be untested. The wrapper's own shape is asserted structurally
 * at the bottom of this file so it cannot drift back into holding logic.
 *
 * The runtime is Deno; the LOGIC is plain ES2022 with no imports, so `node
 * --test` and `deno test` execute identical semantics.
 */
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

import {
  ASSIGNMENT_COOKIE,
  buildControlRouteIndex,
  decide,
  hasAnalyticsConsent,
  normalizePath,
  parseCookieHeader,
  pickArm,
  readAssignments,
  serializeAssignments,
  VARIANT_HEADER,
  type EdgeConsent,
  type ExperimentMapLike,
} from '../../packages/core/lib/tracking/experiments/edge-core.js';

/**
 * `npm test` compiles this suite into `.tmp/ci-test` and runs it from there, so
 * "the repo root" is wherever `netlify.toml` actually is — walked for, rather
 * than assumed from a fixed depth, since the output directory is a flag.
 */
const repoRoot = (() => {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (existsSync(join(dir, 'netlify.toml')) && existsSync(join(dir, 'sites'))) return dir;
    dir = resolve(dir, '..');
  }
  return process.cwd();
})();

const CONTROL = 'req_agent_demo_20260713_01';
const VARIANT_A = 'req_agent_demo_variant_a_20260831_01';
const VARIANT_B = 'req_agent_demo_variant_b_20260831_01';

const MAP: ExperimentMapLike = {
  [CONTROL]: {
    route: '/demo',
    arms: [
      { variant_id: CONTROL, route: '/demo', weight: 34 },
      { variant_id: VARIANT_A, route: '/demo-a', weight: 33 },
      { variant_id: VARIANT_B, route: '/demo-b', weight: 33 },
    ],
  },
};
const INDEX = buildControlRouteIndex(MAP);
const CONSENT: EdgeConsent = { restricted_regions: ['DE', 'FR', 'GB'], honor_gpc: true };

const run = (
  over: Partial<{ path: string; cookieHeader: string | null; secGpc: string | null; country: string | null }> = {},
  roll = 0.5,
  map: ExperimentMapLike = MAP,
  index: Record<string, string> = INDEX
) =>
  decide({
    map,
    controlRouteIndex: index,
    consent: CONSENT,
    roll,
    request: { path: '/demo', cookieHeader: null, secGpc: null, country: 'US', ...over },
  });

// ═══ 1 + 2 — the pass-throughs, before anything else is read ══════════════════

test('an empty map passes every request through untouched (the zero-experiment guarantee)', () => {
  assert.deepEqual(decide({
    map: {},
    controlRouteIndex: {},
    consent: CONSENT,
    roll: 0.5,
    request: { path: '/demo', cookieHeader: `${ASSIGNMENT_COOKIE}=x`, secGpc: '1', country: 'DE' },
  }), { kind: 'next', reason: 'no-experiments' });
});

test('a non-control path passes through — including a VARIANT\'s own route', () => {
  assert.deepEqual(run({ path: '/about' }), { kind: 'next', reason: 'not-a-control-route' });
  assert.deepEqual(run({ path: '/' }), { kind: 'next', reason: 'not-a-control-route' });
  assert.deepEqual(
    run({ path: '/demo-a' }),
    { kind: 'next', reason: 'not-a-control-route' },
    'a direct hit on a variant route must NOT be re-randomized — it is already an arm'
  );
});

test('the control route matches with or without a trailing slash, ignoring query/hash', () => {
  assert.equal(run({ path: '/demo/' }).kind, 'serve');
  assert.equal(normalizePath('/demo/?utm_source=x'), '/demo');
  assert.equal(normalizePath('/'), '/');
});

// ═══ 3 — the consent gate ════════════════════════════════════════════════════

test('a restricted region without analytics consent is served the CONTROL, and no cookie is set', () => {
  const decision = run({ country: 'DE' });
  assert.equal(decision.kind, 'control');
  assert.equal(decision.route, '/demo');
  assert.equal(decision.kind === 'control' && decision.reason, 'restricted-region');
  assert.equal((decision as { setCookie?: string }).setCookie, undefined, 'a held visitor is never assigned an arm');
});

test('a restricted region WITH an analytics-true _dlconsent cookie is split normally', () => {
  const cookie = `_dlconsent=${encodeURIComponent(JSON.stringify({ analytics: true, ads: false }))}`;
  assert.equal(run({ country: 'DE', cookieHeader: cookie }).kind, 'serve');
  const denied = `_dlconsent=${encodeURIComponent(JSON.stringify({ analytics: false, ads: false }))}`;
  assert.equal(run({ country: 'DE', cookieHeader: denied }).kind, 'control');
});

test('Sec-GPC: 1 is served the CONTROL in ANY region, ahead of every other gate', () => {
  const consented = `_dlconsent=${encodeURIComponent(JSON.stringify({ analytics: true }))}`;
  for (const country of ['US', 'DE', null]) {
    const decision = run({ country, secGpc: '1', cookieHeader: consented });
    assert.equal(decision.kind, 'control', `GPC must beat consent in ${country}`);
    assert.equal(decision.kind === 'control' && decision.reason, 'gpc');
  }
  assert.equal(run({ secGpc: '0' }).kind, 'serve', 'only the literal "1" signals GPC');
  assert.equal(
    decide({
      map: MAP,
      controlRouteIndex: INDEX,
      consent: { ...CONSENT, honor_gpc: false },
      roll: 0.5,
      request: { path: '/demo', cookieHeader: null, secGpc: '1', country: 'US' },
    }).kind,
    'serve',
    'honor_gpc:false is the registry saying not to honour it'
  );
});

test('an unresolved country is NOT treated as restricted (the split must not depend on geo coverage)', () => {
  assert.equal(run({ country: null }).kind, 'serve');
});

// ═══ 4 — stickiness ══════════════════════════════════════════════════════════

test('a _dlab cookie naming a served arm wins, and is not re-set', () => {
  const cookie = `${ASSIGNMENT_COOKIE}=${encodeURIComponent(JSON.stringify({ [CONTROL]: VARIANT_B }))}`;
  for (const roll of [0, 0.2, 0.5, 0.9, 0.999]) {
    const decision = run({ cookieHeader: cookie }, roll);
    assert.equal(decision.kind, 'serve');
    assert.equal(decision.kind === 'serve' && decision.variant_id, VARIANT_B, 'sticky beats the roll, every time');
    assert.equal(decision.kind === 'serve' && decision.reason, 'sticky-cookie');
    assert.equal((decision as { setCookie?: string }).setCookie, undefined);
  }
});

test('a cookie naming an arm that is no longer served falls back to a fresh pick', () => {
  const cookie = `${ASSIGNMENT_COOKIE}=${encodeURIComponent(JSON.stringify({ [CONTROL]: 'req_agent_retired_20260101_01' }))}`;
  const decision = run({ cookieHeader: cookie }, 0.5);
  assert.equal(decision.kind === 'serve' && decision.reason, 'weighted-pick');
  assert.ok(decision.kind === 'serve' && decision.setCookie);
});

test('a corrupt or absent cookie re-randomizes rather than throwing', () => {
  assert.deepEqual(readAssignments(parseCookieHeader(`${ASSIGNMENT_COOKIE}=not-json`)), {});
  assert.deepEqual(readAssignments(parseCookieHeader(`${ASSIGNMENT_COOKIE}=${encodeURIComponent('[1,2]')}`)), {});
  assert.deepEqual(readAssignments({}), {});
  assert.equal(hasAnalyticsConsent(parseCookieHeader('_dlconsent=%7Bbroken')), false);
  assert.equal(run({ cookieHeader: `${ASSIGNMENT_COOKIE}=not-json` }).kind, 'serve');
});

test('the fresh assignment cookie carries the specified attributes and preserves other experiments', () => {
  const existing = { req_agent_other_20260101_01: 'req_agent_other_v_20260101_01' };
  const decision = run({ cookieHeader: `${ASSIGNMENT_COOKIE}=${encodeURIComponent(JSON.stringify(existing))}` }, 0.9);
  assert.equal(decision.kind, 'serve');
  const setCookie = decision.kind === 'serve' ? decision.setCookie! : '';
  assert.match(setCookie, /^_dlab=/);
  assert.match(setCookie, /Max-Age=2592000/, '30 days');
  assert.match(setCookie, /SameSite=Lax/);
  assert.match(setCookie, /Secure/);
  assert.match(setCookie, /Path=\//);
  const written = readAssignments(parseCookieHeader(setCookie));
  assert.equal(written.req_agent_other_20260101_01, 'req_agent_other_v_20260101_01', 'other experiments survive');
  assert.equal(written[CONTROL], decision.kind === 'serve' ? decision.variant_id : '');
  assert.equal(serializeAssignments({}), `${ASSIGNMENT_COOKIE}=%7B%7D; Max-Age=2592000; SameSite=Lax; Secure; Path=/`);
});

// ═══ 5 — the split ═══════════════════════════════════════════════════════════

test('weighted distribution stays within ±2% of the configured shares over 10,000 draws', () => {
  // A seeded LCG, not Math.random: the assertion must fail on a broken picker,
  // never on an unlucky CI run.
  let seed = 0x2f6e2b1;
  const nextRoll = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const draws = 10_000;
  const counts: Record<string, number> = { [CONTROL]: 0, [VARIANT_A]: 0, [VARIANT_B]: 0 };
  for (let index = 0; index < draws; index += 1) {
    const decision = run({}, nextRoll());
    assert.equal(decision.kind, 'serve');
    if (decision.kind === 'serve') counts[decision.variant_id] = (counts[decision.variant_id] ?? 0) + 1;
  }
  for (const arm of MAP[CONTROL]!.arms) {
    const actual = (counts[arm.variant_id]! / draws) * 100;
    assert.ok(
      Math.abs(actual - arm.weight) <= 2,
      `${arm.variant_id}: served ${actual.toFixed(2)}%, configured ${arm.weight}% (±2% band)`
    );
  }
});

test('an uneven split is honoured, and a zero-weight arm is never served', () => {
  const skewed: ExperimentMapLike = {
    [CONTROL]: {
      route: '/demo',
      arms: [
        { variant_id: CONTROL, route: '/demo', weight: 90 },
        { variant_id: VARIANT_A, route: '/demo-a', weight: 10 },
        { variant_id: VARIANT_B, route: '/demo-b', weight: 0 },
      ],
    },
  };
  const index = buildControlRouteIndex(skewed);
  let seed = 991;
  const nextRoll = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  const counts: Record<string, number> = {};
  for (let i = 0; i < 10_000; i += 1) {
    const decision = run({}, nextRoll(), skewed, index);
    if (decision.kind === 'serve') counts[decision.variant_id] = (counts[decision.variant_id] ?? 0) + 1;
  }
  assert.ok(Math.abs((counts[CONTROL]! / 100) - 90) <= 2);
  assert.ok(Math.abs((counts[VARIANT_A]! / 100) - 10) <= 2);
  assert.equal(counts[VARIANT_B], undefined, 'weight 0 means never');
});

test('pickArm covers its own boundaries', () => {
  const arms = [
    { variant_id: 'a', route: '/a', weight: 50 },
    { variant_id: 'b', route: '/b', weight: 50 },
  ];
  assert.equal(pickArm(arms, 0)!.variant_id, 'a');
  assert.equal(pickArm(arms, 0.4999)!.variant_id, 'a');
  assert.equal(pickArm(arms, 0.5)!.variant_id, 'b');
  assert.equal(pickArm(arms, 0.9999999)!.variant_id, 'b');
  assert.equal(pickArm(arms, 1)!.variant_id, 'b', 'an out-of-range roll is clamped into the last arm, never undefined');
  assert.equal(pickArm(arms, -1)!.variant_id, 'a');
  assert.equal(pickArm([], 0.5), null);
  assert.equal(
    pickArm([{ variant_id: 'a', route: '/a', weight: 0 }], 0.5)!.variant_id,
    'a',
    'a zero total degrades to the first arm rather than serving nothing'
  );
});

// ═══ the wrapper stays thin ══════════════════════════════════════════════════

test('every deployed variant-serve.ts is a wrapper over edge-core, declared at /*', () => {
  const files = [
    'netlify/edge-functions/variant-serve.ts',
    'sites/platform/netlify/edge-functions/variant-serve.ts',
    'sites/fernwell/netlify/edge-functions/variant-serve.ts',
    'sites/zilberman/netlify/edge-functions/variant-serve.ts',
  ];
  for (const file of files) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    assert.match(source, /from '\.\/_shared\/edge-core\.ts';/, `${file} imports the decision core from _shared/`);
    // Netlify bundles a tenant's edge functions with basePath = sites/<client>.
    // A relative import that climbs above that base is not "one directory up"
    // to Deno — it resolves to nothing, and the bundle fails with
    // `Module not found "file:///packages/..."`. That is what took
    // kugel-platform and zilbermanfilmfoundation down on PR #694 while
    // drluriescience (whose base IS the repo root) deployed fine. Every import
    // in a wrapper must therefore stay inside the wrapper's own directory.
    for (const specifier of source.match(/from '([^']+)'/g) ?? []) {
      assert.doesNotMatch(specifier, /\.\.\//, `${file} must not import above its own directory: ${specifier}`);
    }
    assert.match(source, /_experiments\.generated\.json' with \{ type: 'json' \}/, `${file} imports its generated map`);
    assert.match(source, /export const config = \{ path: '\/\*' \}/, `${file} is declared at /*`);
    assert.match(source, /if \(!HAS_EXPERIMENTS\) return context\.next\(\)/, `${file} short-circuits the empty map`);
    assert.match(source, /headers\.set\(VARIANT_HEADER, decision\.variant_id\)/, `${file} stamps the variant header`);
    // No arm maths, no cookie construction, no region comparison: those are
    // the three places a wrapper would start quietly re-implementing decide().
    assert.doesNotMatch(
      source,
      /Math\.floor|\.arms\b|Max-Age=|regions\.includes|=== '1'/,
      `${file} holds no decision logic`
    );
  }
  assert.equal(VARIANT_HEADER, 'x-trk-variant');

  // Every generated map ships committed at its zero-experiment baseline, so a
  // checkout that has never run the build step still bundles.
  for (const file of [
    'netlify/edge-functions/_experiments.generated.json',
    'sites/platform/netlify/edge-functions/_experiments.generated.json',
    'sites/fernwell/netlify/edge-functions/_experiments.generated.json',
    'sites/zilberman/netlify/edge-functions/_experiments.generated.json',
  ]) {
    const generated = JSON.parse(readFileSync(join(repoRoot, file), 'utf8'));
    assert.deepEqual(generated.experiments, {}, `${file} is committed at the zero-experiment baseline`);
    assert.equal(typeof generated.consent.honor_gpc, 'boolean');
    assert.ok(Array.isArray(generated.consent.restricted_regions));
  }

  // The decision core travels WITH each wrapper: one canonical source, vendored
  // beside every wrapper by the build step and committed so a fresh checkout
  // bundles. Byte-identical or the vendored copy has drifted from the file the
  // tests above actually exercise.
  const canonical = readFileSync(join(repoRoot, 'packages/core/lib/tracking/experiments/edge-core.ts'), 'utf8');
  for (const dir of [
    'netlify/edge-functions',
    'sites/platform/netlify/edge-functions',
    'sites/fernwell/netlify/edge-functions',
    'sites/zilberman/netlify/edge-functions',
  ]) {
    assert.equal(
      readFileSync(join(repoRoot, dir, '_shared/edge-core.ts'), 'utf8'),
      canonical,
      `${dir}/_shared/edge-core.ts must be byte-identical to packages/core/lib/tracking/experiments/edge-core.ts`
    );
    // Netlify deploys EVERY top-level file in the edge directory as its own
    // edge function, and rejects one without a default-exported function
    // ("Default export ... must be a function" — it did, on all four tenants).
    // Shared code therefore lives one level down, in `_shared/`.
    const topLevel = readdirSync(join(repoRoot, dir), { withFileTypes: true })
      .filter((entry) => entry.isFile() && /\.(ts|js|tsx|jsx|mjs)$/.test(entry.name))
      .map((entry) => entry.name)
      .sort();
    assert.deepEqual(topLevel, ['variant-serve.ts'], `${dir} may hold exactly one deployable edge function`);
  }
});

test('every netlify.toml declares the edge function exactly once, at /*', () => {
  for (const file of ['netlify.toml', 'sites/platform/netlify.toml', 'sites/fernwell/netlify.toml', 'sites/zilberman/netlify.toml']) {
    const source = readFileSync(join(repoRoot, file), 'utf8');
    // No `[edge_functions]` TABLE. TOML forbids a table and an array-of-tables
    // sharing a key, so `[edge_functions] directory = …` next to an
    // `[[edge_functions]]` declaration makes the whole file unparseable and
    // every deploy dies at "Reading and parsing configuration files" (it did,
    // on all three tenants, PR #694). `netlify/edge-functions` is Netlify's
    // default directory anyway, so the declaration alone is the whole config.
    assert.doesNotMatch(source, /^\[edge_functions\]/m, file);
    const declarations = source.match(/\[\[edge_functions\]\]/g) ?? [];
    assert.equal(declarations.length, 1, `${file} must declare exactly one /* edge function`);
    assert.match(source, /\[\[edge_functions\]\]\n\s+path = "\/\*"\n\s+function = "variant-serve"/, file);
  }
});
