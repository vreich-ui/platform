/**
 * `trk_<site>`'s `experiments[]`, read server-side (T21.6b / R4b).
 *
 * `/admin/variants`' honesty rule (12-plan §15.4 / §16) turns on whether an
 * ACTIVE `experiments[]` entry names a family — never on whether metrics
 * happen to be present (a directional family accrues organic metrics too).
 * That decision has to be made from the real registry, not inferred, so this
 * reads the SAME record `track-ingest.ts`'s `loadSinkConfig` already reads
 * for its `providers.own` block: list the `tracking_config` active-status
 * index (there is exactly one singleton per site, `trk_<site>`, but this
 * walks the index rather than assuming the id — the same posture
 * `loadSinkConfig` takes), take the one result, and read its body.
 *
 * An absent or unreadable registry returns `[]` — same "never blocks the
 * caller" posture `loadSinkConfig` documents — because a site with no
 * `tracking_config` record yet, or one this reader cannot parse, has no
 * active experiments by definition; every family renders `directional`.
 */
import { getSiteObjectsBlobStore } from './blob-store.js';
import { objectRecordKey, objectStatusIndexPrefix } from './object-store-keys.js';
import { collectBlobListItems, type BlobListResponse } from './blob-list.js';
import type { SiteBinding } from './site-binding.js';
import type { Experiment } from '../../schema/bodies/tracking-config-v1.js';

export type TrackingConfigObjectsStore = {
  get(key: string): Promise<string | null>;
  list(options: { prefix: string }): Promise<unknown>;
};

export interface ReadTrackingExperimentsDeps {
  getObjectsStore?: (event: unknown, binding?: SiteBinding) => Promise<TrackingConfigObjectsStore>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const isExperiment = (value: unknown): value is Experiment =>
  isRecord(value) &&
  typeof value.object_id === 'string' &&
  Array.isArray(value.arms) &&
  typeof value.status === 'string';

/**
 * Reads `trk_<site>`'s `experiments[]`. Every status is returned (draft,
 * active, concluded) — callers filter to `active` themselves
 * (`honestyLabel` in `lib/admin/variant-arm-metrics.ts`), matching the
 * server export shape rather than pre-deciding what the caller needs.
 */
export const readTrackingExperiments = async (
  binding: SiteBinding,
  deps: ReadTrackingExperimentsDeps = {}
): Promise<Experiment[]> => {
  try {
    const store = await (deps.getObjectsStore ?? getSiteObjectsBlobStore)({}, binding);
    const items = await collectBlobListItems(
      (await store.list({ prefix: objectStatusIndexPrefix('tracking_config', 'active') })) as BlobListResponse
    );
    const objectId = items[0]?.key.split('/').at(-1);
    if (!objectId) return [];
    const raw = await store.get(objectRecordKey('tracking_config', objectId));
    if (!raw) return [];
    const record = JSON.parse(raw) as { body?: { experiments?: unknown } };
    const experiments = record.body?.experiments;
    return Array.isArray(experiments) ? experiments.filter(isExperiment) : [];
  } catch {
    return [];
  }
};
