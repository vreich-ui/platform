#!/usr/bin/env node

/**
 * Push the published object/producer/strategy dimensions to the owner DB.
 *
 * W7.4 added `surface` and `attribution` to the `object_version` family — the
 * columns that let `/admin/analytics` (T21.9b; formerly `/admin/traffic`) and
 * any owner-side query separate plugin-written articles from workflow-written
 * ones. Both are nullable and additive.
 *
 * This is deliberately a post-build best-effort sync: missing configuration,
 * malformed individual exports, network failures, and non-2xx responses are
 * reported without throwing. A dimensions outage must never fail a site build.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PRODUCER_KEYS = ['run_id', 'node_id', 'prompt_version', 'model'];
const EMPTY_ROWS = Object.freeze({ object_version: [], producer: [], node_strategy: [] });

const stringOrNull = (value) => (typeof value === 'string' && value.length > 0 ? value : null);

const objectIdFromMarker = (marker) => {
  const from = stringOrNull(marker?.from);
  if (!from) return null;
  return from.match(/\/by-id\/([^/]+)\.json$/)?.[1] ?? null;
};

const validProducer = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join('\0') !== [...PRODUCER_KEYS].sort().join('\0')) return null;
  if (
    !PRODUCER_KEYS.every((key) => typeof value[key] === 'string' && value[key].length > 0 && value[key].length <= 128)
  ) {
    return null;
  }
  return Object.fromEntries(PRODUCER_KEYS.map((key) => [key, value[key]]));
};

/** Convert one page/article export into the exact /dims row families. */
export const dimensionRowsForExport = (raw, objectType) => {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const marker = raw.__generated;
  const objectId = objectIdFromMarker(marker);
  if (!objectId || !Number.isInteger(marker?.record_version) || marker.record_version < 0) return null;

  const version = marker.record_version;
  const isArticle = objectType === 'content_item';
  const route = isArticle
    ? typeof raw.slug === 'string' && raw.slug.length > 0
      ? `/${raw.slug}`
      : null
    : stringOrNull(raw.route);
  const variantOf = stringOrNull(raw.lineage?.parent_content_id);

  const rows = {
    object_version: [
      {
        object_id: objectId,
        version,
        published_at: stringOrNull(marker.at),
        route,
        variant_of: variantOf,
        /**
         * W7.4 — the learning join. Which chat surface published this revision
         * (`plugin:claude` / `plugin:openai-gpt` / `plugin:openai-agent`, or
         * null for the autonomous workflow path) and how that identity was
         * established. Stamped into `__generated` at publish from the
         * auth-derived actor, so grouping engagement by surface is a plain
         * column and not an inference from run ids.
         *
         * SINK CONTRACT: two additional columns on `object_version`, both
         * nullable. A sink that ignores unknown keys is unaffected; a sink that
         * validates strictly needs the migration before this deploys.
         */
        surface: stringOrNull(marker.surface),
        attribution: stringOrNull(marker.attribution),
      },
    ],
    producer: [],
    node_strategy: [],
  };

  const producer = validProducer(marker.producer);
  if (producer) rows.producer.push({ object_id: objectId, version, ...producer });

  if (isArticle && Array.isArray(raw.nodes)) {
    raw.nodes.forEach((node, position) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return;
      const nodeId = stringOrNull(node.id);
      if (!nodeId) return;
      rows.node_strategy.push({
        object_id: objectId,
        node_id: nodeId,
        strategy: stringOrNull(node.private?.strategy),
        intent: stringOrNull(node.private?.intent),
        node_kind: stringOrNull(node.kind),
        position,
      });
    });
  }

  return rows;
};

const jsonFiles = async (directory) => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
};

/** Read every committed page/article export, skipping bad files individually. */
export const collectDimensionRows = async (exportRoot) => {
  const rows = { object_version: [], producer: [], node_strategy: [] };
  const skipped = [];
  for (const [directoryName, objectType] of [
    ['pages', 'page'],
    ['articles', 'content_item'],
  ]) {
    const directory = path.join(exportRoot, directoryName);
    for (const fileName of await jsonFiles(directory)) {
      const filePath = path.join(directory, fileName);
      try {
        const parsed = JSON.parse(await readFile(filePath, 'utf8'));
        const fileRows = dimensionRowsForExport(parsed, objectType);
        if (!fileRows) {
          skipped.push(filePath);
          continue;
        }
        rows.object_version.push(...fileRows.object_version);
        rows.producer.push(...fileRows.producer);
        rows.node_strategy.push(...fileRows.node_strategy);
      } catch {
        skipped.push(filePath);
      }
    }
  }
  return { rows, skipped };
};

/** Best-effort /dims POST. Never throws. */
export const pushTrackingDimensions = async ({
  exportRoot,
  env = process.env,
  fetchImpl = globalThis.fetch,
  timeoutMs = 2_000,
} = {}) => {
  const sinkUrl = env.TRACKING_SINK_URL?.trim();
  const token = env.TRACKING_SINK_TOKEN?.trim();
  const projectId = env.TRACKING_PROJECT_ID?.trim();
  if (!exportRoot || !sinkUrl || !token || !projectId || typeof fetchImpl !== 'function') {
    return { ok: true, skipped: 'missing_configuration', rows: EMPTY_ROWS, skipped_files: [] };
  }

  let collected;
  try {
    collected = await collectDimensionRows(exportRoot);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rows: EMPTY_ROWS,
      skipped_files: [],
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${sinkUrl.replace(/\/+$/, '')}/dims`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ project_id: projectId, ...collected.rows }),
      signal: controller.signal,
    });
    return {
      ok: response.ok,
      status: response.status,
      rows: collected.rows,
      skipped_files: collected.skipped,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      rows: collected.rows,
      skipped_files: collected.skipped,
    };
  } finally {
    clearTimeout(timeout);
  }
};

const parseArgs = (argv) => {
  const index = argv.indexOf('--export-root');
  return { exportRoot: index >= 0 ? argv[index + 1] : undefined };
};

const main = async () => {
  const result = await pushTrackingDimensions(parseArgs(process.argv.slice(2)));
  const counts = Object.fromEntries(
    Object.entries(result.rows ?? EMPTY_ROWS).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])
  );
  if (result.skipped) console.log(`[tracking-dims] skipped: ${result.skipped}`);
  else if (result.ok) console.log(`[tracking-dims] synced ${JSON.stringify(counts)}`);
  else console.warn(`[tracking-dims] sync failed; build continues (${JSON.stringify(counts)})`);
};

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  await main();
}
