/**
 * Analytics annotations (T21.29; runner R11.3) — I/O only. Gathers the three
 * raw inputs `lib/admin/analytics-annotations-logic.ts`'s pure builders turn
 * into one merged, range-scoped marker list: recent Netlify deploy receipts
 * (release markers), `publish` entries off any `content_item`/`page`
 * record's `history[]` (publish markers), and operator notes from the same
 * `analytics-views` Blobs store R11.1 introduced (note markers — this is a
 * dashboard annotation, not a second changelog page).
 *
 * Every source degrades independently and never throws past this module —
 * an unconfigured/failing deploy lookup, an unreadable object store, or a
 * corrupt notes doc each fold to "zero markers from that source", matching
 * this file's neighbors' best-effort posture (`admin-analytics.ts`'s R6.2
 * additions, `analytics-object-directory.ts`).
 */
import { fetchRecentDeploys, netlifyDeployLookupMissingEnvVars } from './netlify-deploys.js';
import { listAllObjectRecords, type ObjectVerbStore } from './object-verbs.js';
import { listAnalyticsNotes, type AnalyticsViewsStore } from './analytics-views-store.js';
import {
  markersInRange,
  mergeAnnotationMarkers,
  noteMarkersFromNotes,
  publishMarkersFromRecords,
  releaseMarkersFromDeploys,
  type AnnotatableObjectRecordLike,
  type AnnotationMarker,
} from '../../lib/admin/analytics-annotations-logic.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

const adminObjectHref = (objectId: string): string => `/admin/content/${encodeURIComponent(objectId)}`;

async function fetchReleaseMarkers(): Promise<AnnotationMarker[]> {
  if (netlifyDeployLookupMissingEnvVars().length > 0) return [];
  try {
    return releaseMarkersFromDeploys(await fetchRecentDeploys());
  } catch (error) {
    console.error('Failed to load recent deploys for analytics annotations.', error);
    return [];
  }
}

function titleOf(record: ObjectRecord): string | undefined {
  const body = record.body as { title?: unknown } | undefined;
  return typeof body?.title === 'string' && body.title ? body.title : undefined;
}

async function fetchPublishMarkers(
  store: ObjectVerbStore,
  fromIso: string,
  toIso: string
): Promise<AnnotationMarker[]> {
  let records: ObjectRecord[];
  try {
    records = await listAllObjectRecords(store, { status: 'active' });
  } catch (error) {
    console.error('Failed to sweep object records for analytics annotations.', error);
    return [];
  }

  const likeRecords: AnnotatableObjectRecordLike[] = records.map((record) => ({
    objectId: record.object_id,
    objectType: record.object_type,
    title: titleOf(record),
    adminHref: adminObjectHref(record.object_id),
    history: record.history ?? [],
  }));
  return publishMarkersFromRecords(likeRecords, fromIso, toIso);
}

export interface FetchAnnotationMarkersOptions {
  store: ObjectVerbStore;
  viewsStore: AnalyticsViewsStore;
  /** ISO window bounds — same convention as `own-tracker-stats.ts`. */
  from: string;
  to: string;
}

export async function fetchAnnotationMarkers(options: FetchAnnotationMarkersOptions): Promise<AnnotationMarker[]> {
  const [releases, publishes, notes] = await Promise.all([
    fetchReleaseMarkers(),
    fetchPublishMarkers(options.store, options.from, options.to),
    listAnalyticsNotes(options.viewsStore, { from: options.from, to: options.to }).catch(() => []),
  ]);
  const merged = mergeAnnotationMarkers(releases, publishes, noteMarkersFromNotes(notes));
  // Releases aren't pre-scoped to the window (fetchRecentDeploys is a flat
  // "most recent N", not a ranged query) — one final filter keeps every
  // source honest to the same [from, to] the caller asked for.
  return markersInRange(merged, options.from, options.to);
}
