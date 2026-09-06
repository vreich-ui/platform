/**
 * Analytics object directory (R6.2/D6, T21.24) — resolves an `object_id` the
 * tracking sink reports (in `top_objects`/`engagement_funnel`) to its title
 * and live route, from the tenant's committed `data/site/**` exports.
 *
 * D6, verbatim: "`admin-analytics.ts` resolves `object_id` → title + route
 * from the tenant's `data/site/**` export, cached per deploy. Each row links
 * to the live page, with a secondary link to its admin object. An id that
 * cannot be resolved renders as the id with a muted 'unresolved' marker —
 * visible, not hidden."
 *
 * Reads the SAME two directories, with the SAME id-from-marker and
 * route-derivation rules, as `scripts/tracking-dims-push.mjs`'s
 * `collectDimensionRows` (the tracking-dimensions push already reads this
 * exact tree for the same object types) — duplicated in miniature here
 * rather than imported, since that script lives outside the `packages/core`
 * workspace boundary and this module needs only id→{title,route,objectType},
 * not the full dimension-row shape.
 *
 * "Cached per deploy" = a module-scope Map keyed by `dataRoot`, read once per
 * warm function instance and never invalidated within it — the export tree
 * only changes on a new deploy, which is a new instance. A missing directory
 * (`ENOENT`) or an individually unparsable file degrades to "not found for
 * this id" (or simply absent from the map), never a thrown error — object
 * resolution is a link-quality enhancement, not something an analytics page
 * load may fail over.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ObjectDirectory, ObjectDirectoryEntry } from '../../lib/admin/own-analytics-logic.js';

const OBJECT_ID_FROM_MARKER = /\/by-id\/([^/]+)\.json$/;

const stringOrNull = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

const objectIdFromExport = (raw: Record<string, unknown>): string | null => {
  const marker = raw.__generated as Record<string, unknown> | undefined;
  const from = stringOrNull(marker?.from);
  if (!from) return null;
  return from.match(OBJECT_ID_FROM_MARKER)?.[1] ?? null;
};

/** Same rule as `tracking-dims-push.mjs`: a page's route is its own `route` field; an article's is `/${slug}`. */
const routeOf = (raw: Record<string, unknown>, objectType: 'page' | 'content_item'): string | null =>
  objectType === 'content_item' ? (typeof raw.slug === 'string' && raw.slug ? `/${raw.slug}` : null) : stringOrNull(raw.route);

const jsonFilesIn = async (directory: string): Promise<string[]> => {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
};

const loadDirectory = async (dataRoot: string): Promise<Map<string, ObjectDirectoryEntry>> => {
  const map = new Map<string, ObjectDirectoryEntry>();
  for (const [dirName, objectType] of [
    ['pages', 'page'],
    ['articles', 'content_item'],
  ] as const) {
    const dir = path.join(dataRoot, dirName);
    for (const fileName of await jsonFilesIn(dir)) {
      try {
        const raw = JSON.parse(await readFile(path.join(dir, fileName), 'utf8')) as Record<string, unknown>;
        const objectId = objectIdFromExport(raw);
        if (!objectId) continue;
        const title = typeof raw.title === 'string' && raw.title ? raw.title : objectId;
        map.set(objectId, { title, route: routeOf(raw, objectType), objectType });
      } catch {
        // One bad export file is skipped, not fatal — same posture as the tracking-dims push.
      }
    }
  }
  return map;
};

/** Per-deploy memo, keyed by `dataRoot` — see the module doc comment. */
const memo = new Map<string, Promise<Map<string, ObjectDirectoryEntry>>>();

const directoryFor = (dataRoot: string): Promise<Map<string, ObjectDirectoryEntry>> => {
  let cached = memo.get(dataRoot);
  if (!cached) {
    cached = loadDirectory(dataRoot);
    memo.set(dataRoot, cached);
  }
  return cached;
};

/**
 * Resolves exactly the ids the caller asks for (the top-N object ids
 * `top_objects`/`engagement_funnel` reference on this page load — tens, not
 * thousands) into an `ObjectDirectory`. An id present in the export tree
 * maps to its entry; an id NOT found maps to `null` (looked up, unresolved —
 * still rendered, per D6); an id never asked for is simply absent from the
 * result (the caller's `objectDisplay` treats "absent" the same as "null").
 */
export const resolveAnalyticsObjectDirectory = async (dataRoot: string, objectIds: readonly string[]): Promise<ObjectDirectory> => {
  const ids = [...new Set(objectIds)].filter(Boolean);
  if (ids.length === 0) return {};

  let directory: Map<string, ObjectDirectoryEntry>;
  try {
    directory = await directoryFor(dataRoot);
  } catch {
    return {};
  }

  return Object.fromEntries(ids.map((id) => [id, directory.get(id) ?? null]));
};

/** Test-only: clears the per-deploy memo so a test can exercise a fresh `dataRoot` read. */
export const __resetAnalyticsObjectDirectoryMemo = (): void => memo.clear();
