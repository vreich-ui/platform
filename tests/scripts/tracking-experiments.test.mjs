/**
 * T21.5 — the BUILD step: `scripts/lib/tracking-experiments.mjs`.
 *
 * What it must guarantee, in order of how badly a miss would hurt:
 *   - with `experiments: []` (the fleet default) both artifacts are written and
 *     the map is exactly `{}` — the zero-experiment guarantee's build half;
 *   - a weights outage NEVER changes which arms are served, only how the split
 *     falls, and never fails the build;
 *   - a stale route in the registry drops that experiment instead of rewriting
 *     live readers to a 404.
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildExperimentArtifacts,
  buildExperimentMap,
  contentItemRoute,
  equalWeights,
  fetchWeights,
  normalizeWeights,
  readPermalinkPattern,
} from '../../scripts/lib/tracking-experiments.mjs';

const CONTROL = 'req_agent_demo_20260713_01';
const VARIANT_A = 'req_agent_demo_variant_a_20260831_01';
const VARIANT_B = 'req_agent_demo_variant_b_20260831_01';

const experiment = (over = {}) => ({
  object_id: CONTROL,
  status: 'active',
  arms: [
    { variant_id: CONTROL, route: '/demo' },
    { variant_id: VARIANT_A, route: '/demo-a' },
    { variant_id: VARIANT_B, route: '/demo-b' },
  ],
  ...over,
});

const scratch = async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'trk-exp-'));
  await mkdir(path.join(root, 'data/site/articles'), { recursive: true });
  const write = async (file, value) => writeFile(path.join(root, file), JSON.stringify(value, null, 2), 'utf8');
  await write('data/site/articles/' + CONTROL + '.json', { slug: 'demo' });
  await write('data/site/articles/' + VARIANT_A + '.json', { slug: 'demo-a' });
  await write('data/site/articles/' + VARIANT_B + '.json', { slug: 'demo-b' });
  return {
    root,
    write,
    args: {
      exportRoot: path.join(root, 'data/site'),
      publicDir: path.join(root, 'public'),
      edgeDir: path.join(root, 'netlify/edge-functions'),
    },
    publicMap: async () => JSON.parse(await readFile(path.join(root, 'public/_trk/experiments.json'), 'utf8')),
    edgeMap: async () =>
      JSON.parse(await readFile(path.join(root, 'netlify/edge-functions/_experiments.generated.json'), 'utf8')),
  };
};

const trackingExport = (experiments) => ({
  __generated: { at: '2026-09-05T00:00:00.000Z', from: 'objects/tracking_config/by-id/trk_demo.json' },
  consent: { posture: 'geo-adaptive', restricted_regions: ['DE'], honor_gpc: true },
  defaults: {},
  providers: {},
  ...(experiments ? { experiments } : {}),
});

// ═══ weights ═════════════════════════════════════════════════════════════════

test('equalWeights sums to exactly 100, remainder to the first arms', () => {
  assert.deepEqual(equalWeights(2), [50, 50]);
  assert.deepEqual(equalWeights(3), [34, 33, 33]);
  assert.deepEqual(equalWeights(6), [17, 17, 17, 17, 16, 16]);
  for (const count of [1, 2, 3, 4, 5, 6]) {
    assert.equal(equalWeights(count).reduce((sum, value) => sum + value, 0), 100);
  }
  assert.deepEqual(equalWeights(0), []);
});

test('normalizeWeights scales a trusted row and falls back to equal on any doubt', () => {
  assert.deepEqual(normalizeWeights(['a', 'b'], { a: 3, b: 1 }), [75, 25]);
  assert.deepEqual(normalizeWeights(['a', 'b', 'c'], { a: 1, b: 1, c: 1 }), [34, 33, 33]);
  assert.deepEqual(normalizeWeights(['a', 'b'], undefined), [50, 50], 'no row');
  assert.deepEqual(normalizeWeights(['a', 'b'], { a: 1 }), [50, 50], 'a row missing an arm');
  assert.deepEqual(normalizeWeights(['a', 'b'], { a: 1, b: -1 }), [50, 50], 'a negative share');
  assert.deepEqual(normalizeWeights(['a', 'b'], { a: 0, b: 0 }), [50, 50], 'a zero-sum row');
  assert.deepEqual(normalizeWeights(['a', 'b'], { a: Number.NaN, b: 1 }), [50, 50]);
  assert.equal(normalizeWeights(['a', 'b', 'c'], { a: 5, b: 3, c: 2 }).reduce((s, v) => s + v, 0), 100);
});

test('fetchWeights: absent configuration, a timeout, and a non-2xx all mean equal weights', async () => {
  assert.deepEqual(await fetchWeights({ env: {} }), {}, 'no TRACKING_SINK_URL / project id');
  const env = { TRACKING_SINK_URL: 'https://sink.example.com/', TRACKING_PROJECT_ID: 'demo' };

  let seen;
  const ok = await fetchWeights({
    env,
    fetchImpl: async (url) => {
      seen = url;
      return { ok: true, json: async () => ({ weights: { [CONTROL]: { [CONTROL]: 1 } } }) };
    },
  });
  assert.equal(seen, 'https://sink.example.com/weights?project_id=demo', 'the documented endpoint, trailing slash trimmed');
  assert.deepEqual(ok, { [CONTROL]: { [CONTROL]: 1 } });

  assert.deepEqual(await fetchWeights({ env, fetchImpl: async () => ({ ok: false, status: 503 }) }), {});
  assert.deepEqual(
    await fetchWeights({ env, fetchImpl: async () => { throw new Error('ECONNRESET'); } }),
    {},
    'a network failure is not a build failure'
  );
  const slow = await fetchWeights({
    env,
    timeoutMs: 5,
    fetchImpl: (url, init) =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ ok: true, json: async () => ({}) }), 500);
        init.signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new Error('aborted'));
        });
      }),
  });
  assert.deepEqual(slow, {}, 'the 2s timeout is real and degrades to equal weights');
});

// ═══ map ═════════════════════════════════════════════════════════════════════

test('buildExperimentMap: active only, control required, routes cross-checked', () => {
  const warnings = [];
  const warn = (message) => warnings.push(message);

  assert.deepEqual(Object.keys(buildExperimentMap([experiment()], { warn })), [CONTROL]);
  for (const status of ['draft', 'concluded']) {
    assert.deepEqual(buildExperimentMap([experiment({ status })], { warn }), {});
  }

  const noControl = experiment({ arms: [{ variant_id: VARIANT_A, route: '/demo-a' }, { variant_id: VARIANT_B, route: '/demo-b' }] });
  assert.deepEqual(buildExperimentMap([noControl], { warn }), {});
  assert.ok(warnings.some((message) => /do not include the control/.test(message)));

  const stale = experiment({
    arms: [{ variant_id: CONTROL, route: '/demo' }, { variant_id: VARIANT_A, route: '/demo-a-old' }],
  });
  const routeOf = (id) => ({ [CONTROL]: '/demo', [VARIANT_A]: '/demo-a' })[id];
  assert.deepEqual(buildExperimentMap([stale], { routeOf, warn }), {}, 'a stale route drops the experiment, never serves a 404');

  const map = buildExperimentMap([experiment()], { weights: { [CONTROL]: { [CONTROL]: 8, [VARIANT_A]: 1, [VARIANT_B]: 1 } } });
  assert.equal(map[CONTROL].route, '/demo', 'the top-level route is the CONTROL arm route');
  assert.deepEqual(map[CONTROL].arms.map((arm) => arm.weight), [80, 10, 10]);
  assert.deepEqual(
    buildExperimentMap([experiment()])[CONTROL].arms.map((arm) => arm.weight),
    [34, 33, 33],
    'no weight table means an even split'
  );
});

test('contentItemRoute / readPermalinkPattern read the site pattern rather than assuming one', async () => {
  assert.equal(contentItemRoute('demo'), '/demo');
  assert.equal(contentItemRoute('demo', '/library/%slug%'), '/library/demo');
  const root = await mkdtemp(path.join(tmpdir(), 'trk-yaml-'));
  const file = path.join(root, 'config.yaml');
  await writeFile(file, "apps:\n  blog:\n    post:\n      permalink: '/library/%slug%'\n", 'utf8');
  assert.equal(await readPermalinkPattern(file), '/library/%slug%');
  assert.equal(await readPermalinkPattern(path.join(root, 'missing.yaml')), '/%slug%', 'absent config → the fleet default');
});

// ═══ artifacts ═══════════════════════════════════════════════════════════════

test('ZERO-EXPERIMENT GUARANTEE: both artifacts are written, and the map is exactly {}', async () => {
  const bed = await scratch();
  await bed.write('data/site/tracking.json', trackingExport([]));
  let fetched = false;
  const result = await buildExperimentArtifacts({
    ...bed.args,
    env: { TRACKING_SINK_URL: 'https://sink.example.com', TRACKING_PROJECT_ID: 'demo' },
    fetchImpl: async () => {
      fetched = true;
      return { ok: true, json: async () => ({}) };
    },
  });
  assert.equal(result.active, 0);
  assert.deepEqual(await bed.publicMap(), {});
  assert.deepEqual((await bed.edgeMap()).experiments, {});
  assert.equal(fetched, false, 'no active experiment means the sink is never even called');

  // A tracking export that predates T21.5 (no `experiments` key) behaves the same.
  await bed.write('data/site/tracking.json', trackingExport(undefined));
  await buildExperimentArtifacts(bed.args);
  assert.deepEqual(await bed.publicMap(), {});

  // No tracking export at all (fernwell/zilberman today) behaves the same.
  const bare = await scratch();
  await buildExperimentArtifacts(bare.args);
  assert.deepEqual(await bare.publicMap(), {});
  assert.deepEqual(await bare.edgeMap(), { experiments: {}, consent: { restricted_regions: [], honor_gpc: true } });
});

test('an active experiment materializes into both files, with the consent block on the edge copy', async () => {
  const bed = await scratch();
  await bed.write('data/site/tracking.json', trackingExport([experiment()]));
  const result = await buildExperimentArtifacts({
    ...bed.args,
    env: { TRACKING_SINK_URL: 'https://sink.example.com', TRACKING_PROJECT_ID: 'demo' },
    fetchImpl: async () => ({ ok: true, json: async () => ({ [CONTROL]: { [CONTROL]: 2, [VARIANT_A]: 1, [VARIANT_B]: 1 } }) }),
  });
  assert.equal(result.active, 1);

  const publicMap = await bed.publicMap();
  assert.deepEqual(publicMap, {
    [CONTROL]: {
      route: '/demo',
      arms: [
        { variant_id: CONTROL, route: '/demo', weight: 50 },
        { variant_id: VARIANT_A, route: '/demo-a', weight: 25 },
        { variant_id: VARIANT_B, route: '/demo-b', weight: 25 },
      ],
    },
  });

  const edge = await bed.edgeMap();
  assert.deepEqual(edge.experiments, publicMap, 'the two copies never disagree');
  assert.deepEqual(edge.consent, { restricted_regions: ['DE'], honor_gpc: true }, 'the edge cannot read tracking.json, so the gate rides along');
});

test('a sink outage still writes a served map — equal weights, never an empty one', async () => {
  const bed = await scratch();
  await bed.write('data/site/tracking.json', trackingExport([experiment()]));
  await buildExperimentArtifacts({
    ...bed.args,
    env: { TRACKING_SINK_URL: 'https://sink.example.com', TRACKING_PROJECT_ID: 'demo' },
    fetchImpl: async () => { throw new Error('ENOTFOUND'); },
    warn: () => {},
  });
  const map = await bed.publicMap();
  assert.deepEqual(map[CONTROL].arms.map((arm) => arm.weight), [34, 33, 33]);
});

test('a previous build\'s map never survives a concluded experiment', async () => {
  const bed = await scratch();
  await bed.write('data/site/tracking.json', trackingExport([experiment()]));
  await buildExperimentArtifacts(bed.args);
  assert.equal(Object.keys(await bed.publicMap()).length, 1);
  await bed.write('data/site/tracking.json', trackingExport([experiment({ status: 'concluded', winner: VARIANT_A })]));
  await buildExperimentArtifacts(bed.args);
  assert.deepEqual(await bed.publicMap(), {}, 'concluding is one publish + one build, with no second switch');
});
