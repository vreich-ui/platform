/**
 * Shared helpers for the per-type materializers (T1.1).
 *
 * Every derived export is `{ __generated: {from, at, record_version}, ...body }`
 * (D§1), serialized with object keys sorted recursively so re-materializing an
 * unchanged object produces byte-identical output — the property T1.3's retry
 * logic depends on. Array order is preserved (it is meaningful — section
 * order, nav item order, term order); only plain-object key iteration order
 * is normalized.
 *
 * `at`/`record_version` are caller-supplied inputs, never generated in this
 * module — a materializer that called Date.now() itself could never be
 * deterministic across two calls.
 *
 * `exportRoot` (W11 T11.6) is likewise a caller-supplied input, never a core
 * default: `packages/core` must not hardcode any client's tree (the exports
 * this module writes were `src/data/site/**` pre-W11; each site now owns its
 * own `<site>/data/site/**`, e.g. `sites/drlurie/data/site`). The caller
 * resolves it from the SiteBinding (`dataRoot`) and passes it through
 * unchanged — same determinism contract as `at`/`record_version`.
 */
import { objectRecordKey } from '../object-store-keys.js';
import type { ObjectType, ProducerContext } from '../../../schema/object-record-v1.js';

export interface MaterializeMeta {
  /** ISO timestamp of this materialization. An input, not generated here. */
  at: string;
  /** ObjectRecord.version at the moment of materialization. */
  record_version: number;
  /** Optional execution context responsible for this published revision. */
  producer?: ProducerContext;
  /** The site's export root (from its SiteBinding.dataRoot), e.g. `sites/drlurie/data/site`. */
  exportRoot: string;
}

/** Join the site's export root with the per-type path segments (no leading/trailing slash logic needed — callers pass plain segments). */
export const exportPath = (meta: Pick<MaterializeMeta, 'exportRoot'>, ...segments: string[]): string =>
  [meta.exportRoot, ...segments].join('/');

export interface GeneratedMarker {
  from: string;
  at: string;
  record_version: number;
  producer?: ProducerContext;
}

export interface MaterializedFile {
  path: string;
  content: string;
}

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonicalize((value as Record<string, unknown>)[key])])
    );
  }
  return value;
};

/** Deterministic JSON serialization: object keys sorted recursively, array order preserved. */
export const canonicalJsonStringify = (value: unknown): string => `${JSON.stringify(canonicalize(value), null, 2)}\n`;

const generatedMarker = (objectType: ObjectType, objectId: string, meta: MaterializeMeta): GeneratedMarker => {
  // Runtime guard, not just a type: untyped callers (compiled-JS drivers,
  // agent scripts) that pass camelCase `recordVersion` would otherwise have
  // `record_version: undefined` silently DROPPED by JSON.stringify, producing
  // an export whose failure only surfaces much later as an opaque astro
  // content-collection error ("__generated.record_version: Required").
  if (typeof meta.at !== 'string' || meta.at.length === 0) {
    throw new Error('materialize: meta.at must be a non-empty ISO timestamp string.');
  }
  if (!Number.isInteger(meta.record_version) || meta.record_version < 0) {
    throw new Error(
      `materialize: meta.record_version must be a non-negative integer (got ${String(meta.record_version)}). ` +
        'The MaterializeMeta contract is snake_case: { at, record_version } — a camelCase recordVersion key is not read.'
    );
  }
  return {
    from: objectRecordKey(objectType, objectId),
    at: meta.at,
    record_version: meta.record_version,
    ...(meta.producer ? { producer: meta.producer } : {}),
  };
};

/**
 * W6 Q — the annotation layer never reaches git.
 *
 * `node.private` (strategy / intent / agentNotes) is the persuasion
 * architecture of an article: which block is the hook, which is the agitation,
 * what each one is for. The RENDERER has always stripped it, so it never
 * reaches reader HTML — but the derived export is committed to the repository,
 * and it carried `private` verbatim for every node. Reader HTML was clean; git
 * was not. Found in the 2026-08-31 acceptance run, where all ten nodes of the
 * published article shipped their strategy annotations into
 * `sites/drlurie/data/site/articles/`.
 *
 * Ruled: strip regardless of repository visibility. A private repo is an
 * access-control accident away from a public one, and nothing downstream of
 * the export reads these fields — the build renders from `public`, and the
 * admin surfaces that DO read the annotation layer
 * (`lib/edit-mode/ui.ts`, `lib/admin/preview-logic.ts`) read the OBJECT STORE,
 * which is unchanged. The store remains the full record; the export is a
 * derived, reader-facing mirror and now says so.
 *
 * Applied here rather than in `content-item.ts` because the same annotation
 * layer rides on section and page nodes: one seam, every type, and any future
 * body that adds a `private` block inherits the guarantee instead of having to
 * remember it.
 */
const stripPrivate = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripPrivate);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== 'private')
        .map(([key, nested]) => [key, stripPrivate(nested)])
    );
  }
  return value;
};

/**
 * Wraps a validated body with its `__generated` marker and serializes it
 * deterministically. The annotation layer (`private`, at any depth) is dropped
 * on the way out — see `stripPrivate`.
 */
export const renderExport = <TBody extends object>(
  objectType: ObjectType,
  objectId: string,
  body: TBody,
  meta: MaterializeMeta
): string =>
  canonicalJsonStringify({
    __generated: generatedMarker(objectType, objectId, meta),
    ...(stripPrivate(body) as TBody),
  });
