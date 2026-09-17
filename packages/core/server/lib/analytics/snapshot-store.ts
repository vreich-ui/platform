/**
 * M4 — `snapshots/analytics/<source>/<range>.json`: the two body builders that
 * used to run on the page path, and the ONE place the blobs are written.
 *
 * Every write goes through `writeAnalyticsSnapshot` below, exactly as every
 * site-objects record write goes through `objects/record-writer.ts`;
 * `tests/netlify/object-inventory-index.test.ts`'s writer-pinning scan fails
 * the build on a `.setJSON` against `analyticsSnapshotKey` anywhere else.
 *
 * ## What moved here, and why it had to move
 *
 * `buildNetlifyAnalyticsBody` is the eleven-call Netlify Analytics fan-out
 * that measured `sec.netlify_upstream_pageviews = 2151` inside a 4.9 s page.
 * `buildOwnAnalyticsBody` is the tracking-sink call plus the object directory
 * and the per-object publish-receipt reads. Both used to be inline in
 * `functions/admin-analytics.ts`, which is to say both used to be on a page
 * path. They are now builders a SCHEDULE and a BACKGROUND refresh call, and
 * `admin-analytics` reaches them only when it has nothing cached at all.
 *
 * ## Stale-while-revalidate, honestly
 *
 * The rule the read path applies (`functions/admin-analytics.ts`):
 *
 *   - A blob exists -> SERVE IT, whatever its age. The response carries
 *     `as_of`, so a lagging feed is stated rather than hidden.
 *   - …and if it is older than `ANALYTICS_SNAPSHOT_MAX_AGE_MS`, start a
 *     refresh and DO NOT await it.
 *   - No blob at all -> build it synchronously, once, and store it. The user
 *     sees a spinner that resolves. They never see a zero that is really an
 *     empty cache, which is the one outcome worth blocking for.
 *
 * The honest limit of the un-awaited refresh: this runtime freezes a function
 * container once its response is written, so a promise still in flight resumes
 * only when that container is next invoked — possibly much later, possibly
 * never. So the background refresh is an OPTIMISATION, not a guarantee, and
 * `functions/analytics-snapshot-warm.ts` is the guarantee. Saying which is
 * which matters: a design that quietly depended on post-response work would
 * look fine in a test and lag by hours in production.
 *
 * ## The 6 s upstream cap stays, and stays off the response path
 *
 * `netlify-analytics.ts` already bounds each call at 6 s. Nothing here raises
 * or removes it; what changes is who waits — a schedule, or a background
 * refresh nobody is watching.
 */
import { createHash } from 'node:crypto';

import {
  fetchTrafficAnalytics,
  fetchNotFoundAndCountries,
  fetchPreviousTrafficAnalytics,
  fetchBandwidth,
  isNetlifyAnalyticsLookupConfigured,
  NetlifyAnalyticsNotEnabledError,
} from '../netlify-analytics.js';
import { fetchOwnTrackerStats, ownTrackerMissingEnvVars } from '../own-tracker-stats.js';
import { resolveAnalyticsObjectDirectory } from '../analytics-object-directory.js';
import { getSiteObjectsBlobStore } from '../blob-store.js';
import { objectRecordKey } from '../object-store-keys.js';
import { timeSection } from '../server-timing.js';
import type { SiteBinding } from '../site-binding.js';
import type { ObjectRecord } from '../../../schema/object-record-v1.js';
import {
  mapAnalyticsToChartSeries,
  ANALYTICS_RANGE_OPTIONS,
  DEFAULT_ANALYTICS_RANGE,
  type AnalyticsDateWindow,
  type AnalyticsFilters,
  type AnalyticsRangeKey,
} from '../../../lib/admin/analytics-logic.js';
import { surfaceSplit } from '../../../lib/admin/own-analytics-logic.js';
import {
  analyticsSnapshotKey,
  analyticsSnapshotSchema,
  readAnalyticsSnapshot,
  ANALYTICS_SNAPSHOT_SCHEMA_VERSION,
  type AnalyticsSnapshot,
  type AnalyticsSnapshotSource,
  type AnalyticsSnapshotStore,
} from './snapshot-view.js';

/**
 * The read half is re-exported whole, so every caller keeps its single import.
 * Only `./snapshot-view.js` is on the diet — see its header.
 */
export * from './snapshot-view.js';

/**
 * WHAT THE HOURLY WARM REFRESHES — derived from the client, not invented.
 *
 * `ANALYTICS_RANGE_OPTIONS` minus `custom` is exactly the set a page can open
 * on: `AnalyticsWorkspace.tsx` seeds `rangeKey` from `DEFAULT_ANALYTICS_RANGE`
 * ('30d'), and the only other thing that can win is `?range=` or the
 * remembered range in `localStorage`, both of which are one of these three. A
 * custom span is never warmed: it is one operator's ad-hoc window, and
 * manufacturing upstream traffic for a span nobody may open again is the
 * opposite of what this milestone is for.
 *
 * Both SOURCES are warmed, because both are on the mount path:
 * `DEFAULT_ANALYTICS_SOURCE` is `own`, and the Netlify feed is fetched
 * regardless of which tab is active (the own tab's capture-rate stat needs its
 * pageviews — see `AnalyticsWorkspace.tsx`).
 */
export const ANALYTICS_WARM_RANGES: readonly AnalyticsRangeKey[] = ANALYTICS_RANGE_OPTIONS.map(
  (option) => option.key
).filter((key): key is AnalyticsRangeKey => key !== 'custom');

export const ANALYTICS_WARM_SOURCES: readonly AnalyticsSnapshotSource[] = ['netlify', 'own'];

/**
 * A warm pass refreshes a `(source, range)` pair when it is the DEFAULT pair
 * or when a blob for it already exists.
 *
 * The alternative — refresh all six, always — would have a tenant nobody has
 * opened in a month paying 3 x 11 = 33 Netlify Analytics calls every hour
 * forever, against an undocumented and presumably rate-limited API, to keep
 * warm two ranges nobody has ever selected. This bounds a never-visited tenant
 * at the two default blobs and lets a tenant that actually uses 7d and 90d
 * keep them warm because the blobs are there to prove it.
 */
export const shouldWarmTarget = (range: AnalyticsRangeKey, existing: AnalyticsSnapshot | undefined): boolean =>
  range === DEFAULT_ANALYTICS_RANGE || existing !== undefined;

/**
 * REVIEW2 — THE ORDER THE WARM WORKS IN, and why it is not two nested loops.
 *
 * `functions/analytics-snapshot-warm.ts` is a SCHEDULED function, and Netlify
 * kills one of those at 30 s with no log line at all — measured on this fleet
 * and written up at `media-compaction-run.ts:SWEEP_BUDGET_MS` and in
 * DEPLOYMENT.md, where `media-compaction-sweep` spent three days being killed
 * mid-run while its log looked exactly like "the schedule never fired". The
 * warm does up to six upstream fan-outs serially, so it can reach that wall on
 * a tenant that keeps all three ranges warm.
 *
 * Two things follow. The budget below is one. This order is the other: the
 * pass was `for source { for range }`, which put BOTH of the default range's
 * feeds fifth and second — so a pass that ran out of clock starved
 * `own/30d`, the pair every bare visit to the page opens, in favour of
 * `netlify/90d`, a range nobody may have selected. Default range first, and
 * `own` (`DEFAULT_ANALYTICS_SOURCE`) ahead of `netlify` within each range, so
 * the two pairs a default mount reads are always the two that complete.
 */
export const analyticsWarmTargets = (): ReadonlyArray<{ source: AnalyticsSnapshotSource; range: AnalyticsRangeKey }> => {
  const ranges = [
    ...ANALYTICS_WARM_RANGES.filter((range) => range === DEFAULT_ANALYTICS_RANGE),
    ...ANALYTICS_WARM_RANGES.filter((range) => range !== DEFAULT_ANALYTICS_RANGE),
  ];
  const sources: readonly AnalyticsSnapshotSource[] = [
    ...ANALYTICS_WARM_SOURCES.filter((source) => source === 'own'),
    ...ANALYTICS_WARM_SOURCES.filter((source) => source !== 'own'),
  ];
  return ranges.flatMap((range) => sources.map((source) => ({ source, range })));
};

/**
 * REVIEW2 — how long a warm pass may keep STARTING new pairs.
 *
 * The same 20 s `media-compaction-run.ts` picked against the same 30 s wall,
 * for the same reason: a pair already in flight still has to finish, and the
 * Netlify fan-out bounds itself at 6 s per call in two dependent layers, so the
 * margin has to cover one more pair after the last decision to start one. What
 * this buys is not speed — a pass has a whole hour — it is that the function
 * RETURNS, which is the difference between a `deferred` entry an operator can
 * read in the log and a kill that leaves no line at all.
 */
export const ANALYTICS_WARM_BUDGET_MS = 20_000;

// ═══ the write — the choke point ══════════════════════════════════════════

/**
 * THE writer. Unconditional (no compare-and-swap), for the reason
 * `release/snapshot-store.ts` states at length: this blob is never amended,
 * only re-derived whole, so two writers racing both store a complete and
 * internally consistent snapshot and a CAS would leave the loser with nothing.
 *
 * Never throws: a failed write costs the next read a build, and must never
 * fail the request or the pass that noticed.
 */
export const writeAnalyticsSnapshot = async (
  store: AnalyticsSnapshotStore,
  snapshot: AnalyticsSnapshot
): Promise<boolean> => {
  try {
    await store.setJSON(
      analyticsSnapshotKey(snapshot.source as AnalyticsSnapshotSource, snapshot.range),
      analyticsSnapshotSchema.parse(snapshot)
    );
    return true;
  } catch (error) {
    console.warn('analytics: could not persist an analytics snapshot; the next read will build it.', error);
    return false;
  }
};

// ═══ the Netlify feed ═════════════════════════════════════════════════════

/**
 * R6.2/D2 — "probe `/bandwidth` once [per deploy]". Sticks to `false` the
 * first time the probe comes back `null`, so a tenant whose plan does not
 * carry the endpoint stops retrying it. Moved here with the builder it guards;
 * it is per instance, which for a scheduled builder means per pass, which is
 * the correct granularity for "this plan does not have it".
 */
let bandwidthKnownUnavailable = false;

/** Test-only: the module-scope latch above outlives a single test. Never imported outside the acceptance test. */
export const __resetBandwidthProbeForTesting = (): void => {
  bandwidthKnownUnavailable = false;
};

export type NetlifyAnalyticsBody =
  | { configured: false; enabled: false; error_code: string; message: string; range: AnalyticsRangeKey }
  | { configured: true; enabled: false; error_code: string; message: string; range: AnalyticsRangeKey }
  | Record<string, unknown>;

/**
 * The eleven upstream calls, in the two dependent layers they have always run
 * in, with the Server-Timing sections `admin-analytics.ts`'s header documents
 * kept verbatim. The only thing that changed is WHERE this runs: a schedule or
 * a background refresh, never a page load that someone is waiting on.
 *
 * Every degradation it had, it keeps: an unconfigured tenant and a tenant
 * without the Analytics add-on both produce a catalogued, storable body rather
 * than an error, so neither hammers the API on every page view.
 */
export const buildNetlifyAnalyticsBody = async (
  range: AnalyticsRangeKey,
  window: AnalyticsDateWindow,
  siteHost: string | undefined
): Promise<Record<string, unknown>> => {
  if (!isNetlifyAnalyticsLookupConfigured()) {
    return {
      configured: false,
      enabled: false,
      error_code: 'analytics_lookup_unconfigured',
      message: 'Netlify Analytics credentials are not configured for this site.',
      range,
    };
  }

  try {
    const raw = await timeSection('netlify_upstream_pageviews', () => fetchTrafficAnalytics(window, siteHost));

    // R6.2 — every one of these is best-effort and independent: none of them
    // may throw past this point, so a failure on any one never blocks the
    // primary series above. Concurrent, so the three sections overlap.
    const [previousRaw, notFoundAndCountries, bandwidthBytes] = await Promise.all([
      timeSection('netlify_upstream_previous', () => fetchPreviousTrafficAnalytics(window, siteHost)),
      timeSection('netlify_upstream_rankings', () => fetchNotFoundAndCountries(window).catch(() => null)),
      timeSection('netlify_upstream_bandwidth', () =>
        bandwidthKnownUnavailable ? Promise.resolve(null) : fetchBandwidth(window)
      ),
    ]);
    if (bandwidthBytes === null) bandwidthKnownUnavailable = true;

    // R6.4/D8 — "excl. admin" combines both path-shaped rankings; "Internal"
    // is `topSources`' same-host referrers alone. Both are approximations
    // computed from visible ranking rows only.
    const excludedAdminVisits =
      (raw.excludedAdminPathVisits ?? 0) + (notFoundAndCountries?.excludedAdminNotFoundVisits ?? 0);

    return timeSection('netlify_shape', () => ({
      configured: true,
      enabled: true,
      range,
      window,
      series: mapAnalyticsToChartSeries(raw),
      previousSeries: previousRaw ? mapAnalyticsToChartSeries(previousRaw) : undefined,
      topNotFound: notFoundAndCountries?.topNotFound,
      topCountries: notFoundAndCountries?.topCountries,
      bandwidthBytes,
      excludedAdminVisits,
      internalReferrerVisits: raw.internalReferrerVisits ?? 0,
    }));
  } catch (error) {
    if (error instanceof NetlifyAnalyticsNotEnabledError) {
      // A per-tenant plan gap, not a fault — catalogued and STORED exactly
      // like a real result, so a tenant without the add-on does not re-ask the
      // API on every pass or every page view.
      return {
        configured: true,
        enabled: false,
        error_code: 'analytics_not_enabled',
        message:
          'Analytics is not enabled for this site. Turn on the Netlify Analytics add-on for this site in Netlify to see analytics data here.',
        range,
      };
    }
    throw error;
  }
};

// ═══ the own-tracker feed ═════════════════════════════════════════════════

/**
 * W7.4 — the publishing surface for each object in the top-N window, read off
 * each record's publish receipt. Bounded by construction (`top_objects` is a
 * top-N list), and individual read failures are skipped rather than failing
 * the build: a feed that dies because one object is unreadable is worse than
 * one that says "unknown" for that row.
 */
const publishingSurfaces = async (
  binding: SiteBinding,
  topObjects: ReadonlyArray<{ object_id?: unknown }>
): Promise<Record<string, string | null>> => {
  const ids = [...new Set(topObjects.map((row) => (typeof row?.object_id === 'string' ? row.object_id : '')))].filter(
    Boolean
  );
  if (ids.length === 0) return {};

  let store: Awaited<ReturnType<typeof getSiteObjectsBlobStore>>;
  try {
    store = await getSiteObjectsBlobStore({}, binding);
  } catch {
    return {};
  }

  const entries = await Promise.all(
    ids.map(async (objectId) => {
      for (const objectType of ['content_item', 'page'] as const) {
        try {
          const raw = await store.get(objectRecordKey(objectType, objectId));
          if (!raw) continue;
          const record = JSON.parse(raw as string) as ObjectRecord;
          return [objectId, record.publication?.publish_receipt?.surface ?? null] as const;
        } catch {
          // Unreadable or not this type — try the next, then give up quietly.
        }
      }
      return null;
    })
  );
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string | null] => entry !== null));
};

export const buildOwnAnalyticsBody = async (
  binding: SiteBinding,
  range: AnalyticsRangeKey,
  window: AnalyticsDateWindow,
  filters: AnalyticsFilters
): Promise<Record<string, unknown>> => {
  const missing = ownTrackerMissingEnvVars();
  if (missing.length > 0) {
    return {
      configured: false,
      enabled: false,
      error_code: 'own_tracker_unconfigured',
      message: 'The own-tracker sink is not configured for this site.',
      range,
    };
  }

  const stats = await timeSection('own_sink_stats', () =>
    fetchOwnTrackerStats(
      { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
      { filters: { country: filters.country, source: filters.source, object_id: filters.object_id } }
    )
  );

  // D6 — resolve every object id this response references to
  // title/route/admin-link, server-side.
  const objectIds = [
    ...(stats.top_objects ?? []).map((row) => row?.object_id),
    ...(stats.engagement_funnel ?? []).map((row) => row?.object_id),
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);
  const objectDirectory = await timeSection('own_object_directory', () =>
    resolveAnalyticsObjectDirectory(binding.dataRoot, objectIds)
  );
  const surfaces = await timeSection('own_surfaces', () => publishingSurfaces(binding, stats.top_objects ?? []));

  return {
    configured: true,
    enabled: true,
    range,
    window,
    stats,
    object_directory: objectDirectory,
    surfaces: surfaceSplit(stats, surfaces),
  };
};

// ═══ build + write ════════════════════════════════════════════════════════

export type RefreshAnalyticsSnapshotOptions = {
  source: AnalyticsSnapshotSource;
  range: AnalyticsRangeKey;
  window: AnalyticsDateWindow;
  nowMs: number;
  binding: SiteBinding;
  /** Own-feed filters. The default pair — and everything the warm touches — is unfiltered; see `refreshAnalyticsSnapshot`. */
  filters?: AnalyticsFilters;
  siteHost?: string | undefined;
};

/**
 * Build one feed and store it.
 *
 * FILTERS ARE NEVER PART OF THE KEY, and that is a deliberate limit rather
 * than an oversight: the own feed takes `country`/`source`/`object_id`, and a
 * blob per filter combination is an unbounded key space written by whoever
 * happens to click a chip. A filtered own read therefore bypasses the
 * snapshot entirely (`functions/admin-analytics.ts` keeps the per-instance
 * memo for that case, which is what it was always worth). Only the UNFILTERED
 * feed — the one every mount asks for — is materialised.
 */
export const refreshAnalyticsSnapshot = async (
  store: AnalyticsSnapshotStore,
  options: RefreshAnalyticsSnapshotOptions
): Promise<{ snapshot: AnalyticsSnapshot; written: boolean }> => {
  const body =
    options.source === 'netlify'
      ? await buildNetlifyAnalyticsBody(options.range, options.window, options.siteHost)
      : await buildOwnAnalyticsBody(options.binding, options.range, options.window, options.filters ?? {});

  const snapshot: AnalyticsSnapshot = {
    schema_version: ANALYTICS_SNAPSHOT_SCHEMA_VERSION,
    as_of: new Date(options.nowMs).toISOString(),
    source: options.source,
    range: options.range,
    window: options.window,
    body,
  };
  const written = await writeAnalyticsSnapshot(store, snapshot);
  return { snapshot, written };
};

/**
 * The background spelling: never throws, never awaited by a response path.
 *
 * See the header for the honest limit — a frozen container does not finish
 * this, which is why the hourly warm exists and why this is described as an
 * optimisation rather than a guarantee.
 */
export const refreshAnalyticsSnapshotInBackground = (
  store: AnalyticsSnapshotStore,
  options: RefreshAnalyticsSnapshotOptions
): void => {
  void refreshAnalyticsSnapshot(store, options).catch((error) => {
    console.warn('analytics: background snapshot refresh failed; the hourly warm will repair it.', error);
  });
};

/** Re-exported so the read path can look before it builds without a second import. */
export { readAnalyticsSnapshot };

/** The ETag every analytics response has always carried, over whatever body it serves. */
export const analyticsBodyEtag = (body: unknown): string =>
  `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;
