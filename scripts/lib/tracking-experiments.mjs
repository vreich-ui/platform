/**
 * The build-time half of T21.5's experiments: turn a site's published
 * `tracking.json` into the two artifacts the deploy needs.
 *
 *   `<publicDir>/_trk/experiments.json`
 *       `{object_id: {route, arms: [{variant_id, route, weight}]}}` — the
 *       loader/test copy. `{}` when nothing is active.
 *   `<edgeDir>/_experiments.generated.json`
 *       `{experiments: <that same map>, consent: {restricted_regions, honor_gpc}}`
 *       — what `netlify/edge-functions/variant-serve.ts` imports. Edge bundles
 *       cannot import from `public/`, hence the second copy; the consent block
 *       rides along because the edge cannot read `data/site/tracking.json`
 *       either (it lives outside the bundle) and the gate needs it.
 *
 * Weights come from `${TRACKING_SINK_URL}/weights?project_id=<id>` with a 2s
 * timeout. Absent configuration, a timeout, a non-2xx, or an unusable body all
 * degrade to EQUAL weights — a weight outage must never change WHICH arms are
 * served, only how the traffic splits, and it must never fail a build.
 *
 * This module never throws for content reasons: a malformed experiment is
 * dropped with a warning and the build continues on the remaining ones.
 */
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const EMPTY_MAP = Object.freeze({});
const DEFAULT_PERMALINK_PATTERN = '/%slug%';

/** A content_item's public route, from its slug and the site's pattern. */
export const contentItemRoute = (slug, pattern = DEFAULT_PERMALINK_PATTERN) => {
  const filled = String(pattern).replace('%slug%', slug);
  const trimmed = filled.replace(/\/+$/, '');
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
};

/**
 * Equal integer shares summing to exactly 100 (3 arms → 34/33/33). Integer
 * shares keep the edge's cumulative pick free of float drift, which is what
 * makes the ±2%-over-10,000-draws test mean what it says.
 */
export const equalWeights = (count) => {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const remainder = 100 - base * count;
  return Array.from({ length: count }, (_unused, index) => base + (index < remainder ? 1 : 0));
};

/**
 * Normalize one fetched weight row to integer shares summing to 100, in the
 * given arm order. A row missing an arm, carrying a non-finite/negative value,
 * or summing to zero falls back to EQUAL weights for the whole experiment: a
 * partially-trusted split is worse than an even one.
 */
export const normalizeWeights = (armIds, row) => {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return equalWeights(armIds.length);
  const raw = [];
  for (const id of armIds) {
    const value = row[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return equalWeights(armIds.length);
    raw.push(value);
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return equalWeights(armIds.length);
  const scaled = raw.map((value) => Math.floor((value / total) * 100));
  let remainder = 100 - scaled.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % scaled.length) {
    scaled[index] += 1;
    remainder -= 1;
  }
  return scaled;
};

/**
 * Build the served map from `experiments[]`.
 *
 * Only `status: 'active'` materializes. An experiment is DROPPED (warned, not
 * fatal) when its arm list is shorter than 2, does not contain its own control,
 * or — when `routeOf` can answer — names a route that disagrees with the
 * referenced item's own slug. The last check is the build-time twin of the
 * write-time validation rule: a stale route in the registry would otherwise
 * rewrite readers to a 404.
 */
export const buildExperimentMap = (experiments, { weights, routeOf, warn = () => {} } = {}) => {
  const map = {};
  for (const experiment of Array.isArray(experiments) ? experiments : []) {
    const id = experiment?.object_id;
    if (typeof id !== 'string' || !Array.isArray(experiment.arms)) continue;
    if (experiment.status !== 'active') continue;
    if (experiment.arms.length < 2) {
      warn(`${id}: fewer than 2 arms — dropped.`);
      continue;
    }
    const control = experiment.arms.find((arm) => arm?.variant_id === id);
    if (!control) {
      warn(`${id}: arms do not include the control (${id}) — dropped.`);
      continue;
    }
    let routesAgree = true;
    for (const arm of experiment.arms) {
      const expected = routeOf?.(arm?.variant_id);
      if (expected !== undefined && expected !== arm?.route) {
        warn(`${id}: arm ${arm?.variant_id} route "${arm?.route}" != published route "${expected}" — dropped.`);
        routesAgree = false;
      }
    }
    if (!routesAgree) continue;
    const armIds = experiment.arms.map((arm) => arm.variant_id);
    const shares = normalizeWeights(armIds, weights?.[id]);
    map[id] = {
      route: control.route,
      arms: experiment.arms.map((arm, index) => ({
        variant_id: arm.variant_id,
        route: arm.route,
        weight: shares[index] ?? 0,
      })),
    };
  }
  return map;
};

/** Read `<exportRoot>/tracking.json`. Absent/unreadable/unparseable → null. */
export const readTrackingExport = async (exportRoot) => {
  try {
    return JSON.parse(await readFile(path.join(exportRoot, 'tracking.json'), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * `{content_item id → published route}` from `<exportRoot>/articles/*.json`.
 * Absent directory → an empty index, which makes `routeOf` answer "unknown"
 * and the route cross-check a no-op rather than a false rejection.
 */
export const readArticleRoutes = async (exportRoot, permalinkPattern = DEFAULT_PERMALINK_PATTERN) => {
  const routes = {};
  let names;
  try {
    names = await readdir(path.join(exportRoot, 'articles'));
  } catch {
    return routes;
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    try {
      const body = JSON.parse(await readFile(path.join(exportRoot, 'articles', name), 'utf8'));
      if (typeof body?.slug === 'string') routes[name.replace(/\.json$/, '')] = contentItemRoute(body.slug, permalinkPattern);
    } catch {
      // A malformed export is already a loud skip in the Astro loader; here it
      // just means "route unknown", which disables the cross-check for it.
    }
  }
  return routes;
};

/** `apps.blog.post.permalink` out of a site's config.yaml, without a YAML dep. */
export const readPermalinkPattern = async (configYamlPath) => {
  try {
    const text = await readFile(configYamlPath, 'utf8');
    const match = /^\s*permalink:\s*'([^']+)'/m.exec(text) ?? /^\s*permalink:\s*"([^"]+)"/m.exec(text);
    return match ? match[1] : DEFAULT_PERMALINK_PATTERN;
  } catch {
    return DEFAULT_PERMALINK_PATTERN;
  }
};

/**
 * `GET ${TRACKING_SINK_URL}/weights?project_id=<id>` — 2s timeout, best effort.
 * Returns `{}` (→ equal weights everywhere) on any failure at all.
 */
export const fetchWeights = async ({
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
  warn = () => {},
} = {}) => {
  const sinkUrl = env.TRACKING_SINK_URL?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!sinkUrl || !projectId || typeof fetchImpl !== 'function') return {};
  const token = env.TRACKING_SINK_TOKEN?.trim();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(
      `${sinkUrl.replace(/\/+$/, '')}/weights?project_id=${encodeURIComponent(projectId)}`,
      {
        method: 'GET',
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      warn(`weights: HTTP ${response.status} — equal weights.`);
      return {};
    }
    const body = await response.json();
    if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
    return body.weights && typeof body.weights === 'object' ? body.weights : body;
  } catch (error) {
    warn(`weights: ${error instanceof Error ? error.message : String(error)} — equal weights.`);
    return {};
  } finally {
    clearTimeout(timeout);
  }
};

const EDGE_CORE_SOURCE = 'packages/core/lib/tracking/experiments/edge-core.ts';

/** repo root, from this module's own location (scripts/lib/…). */
const repoRootFrom = (metaUrl) => path.resolve(path.dirname(new URL(metaUrl).pathname), '..', '..');

const writeJson = async (filePath, value) => {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
};

/**
 * The whole build step. Always writes BOTH files, including in the
 * zero-experiment case — the edge function's JSON import must never be a
 * missing module, and a stale map from a previous build must never survive.
 */
export const buildExperimentArtifacts = async ({
  exportRoot,
  publicDir,
  edgeDir,
  configYaml,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
  warn = (message) => console.warn(`[tracking-experiments] ${message}`),
} = {}) => {
  const body = exportRoot ? await readTrackingExport(exportRoot) : null;
  const consent = {
    restricted_regions: Array.isArray(body?.consent?.restricted_regions) ? body.consent.restricted_regions : [],
    honor_gpc: body?.consent?.honor_gpc !== false,
  };
  const experiments = Array.isArray(body?.experiments) ? body.experiments : [];

  let map = EMPTY_MAP;
  if (experiments.some((experiment) => experiment?.status === 'active')) {
    const pattern = configYaml ? await readPermalinkPattern(configYaml) : DEFAULT_PERMALINK_PATTERN;
    const articleRoutes = await readArticleRoutes(exportRoot, pattern);
    const weights = await fetchWeights({ env, fetchImpl, timeoutMs, warn });
    map = buildExperimentMap(experiments, {
      weights,
      routeOf: (id) => articleRoutes[id],
      warn,
    });
  }

  if (publicDir) await writeJson(path.join(publicDir, '_trk', 'experiments.json'), map);
  if (edgeDir) {
    await writeJson(path.join(edgeDir, '_experiments.generated.json'), { experiments: map, consent });
    // Netlify bundles a tenant's edge functions with basePath = sites/<client>,
    // so a relative import that climbs above that base resolves to nothing and
    // the bundle fails (`Module not found "file:///packages/..."`). The decision
    // code therefore travels WITH the wrapper: one canonical source in
    // packages/core, vendored beside every wrapper on each build, and pinned
    // byte-for-byte by tests/netlify/tracking-experiments-edge.test.ts. It goes in
    // a `_shared/` SUBDIRECTORY: Netlify deploys every top-level file in the edge
    // directory as its own edge function, and a module with no default export is
    // rejected ("Default export ... must be a function").
    await mkdir(edgeDir, { recursive: true });
    await mkdir(path.join(edgeDir, '_shared'), { recursive: true });
    await copyFile(path.join(repoRootFrom(import.meta.url), EDGE_CORE_SOURCE), path.join(edgeDir, '_shared', 'edge-core.ts'));
  }
  return { map, consent, active: Object.keys(map).length };
};

const parseArgs = (argv) => {
  const value = (flag) => {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  return {
    exportRoot: value('--export-root'),
    publicDir: value('--public-dir'),
    edgeDir: value('--edge-dir'),
    configYaml: value('--config-yaml'),
  };
};

const main = async () => {
  const args = parseArgs(process.argv.slice(2));
  const result = await buildExperimentArtifacts(args);
  console.log(`[tracking-experiments] ${result.active} active experiment(s) materialized.`);
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
