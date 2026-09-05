/**
 * admin-analytics (T4.1; renamed from admin-traffic, T21.9b) — analytics
 * dashboard data: visits/sources/top content over a range, from Netlify
 * Analytics (gate G1). GET-only, admin auth wall matching
 * `admin-release-state.ts`.
 *
 * Caching (D8 + T0.2's "zero ETags anywhere in server/functions/" finding):
 * this data is not live-critical, so this sets BOTH a short `Cache-Control`
 * and — the better precedent T0.2 asked for — a real `ETag`, honoring
 * `If-None-Match` with a `304`. A module-scope memo backs the same cache for
 * the lifetime of the warm function instance, so a burst of requests for the
 * same window (e.g. the range picker firing on mount, then a tab regaining
 * focus) never re-hits Netlify's undocumented, presumably rate-limited
 * Analytics API more than once per TTL.
 */
import { createHash } from 'node:crypto';

import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessFromEvent } from '../lib/request-roles.js';
import {
  fetchTrafficAnalytics,
  isNetlifyAnalyticsLookupConfigured,
  NetlifyAnalyticsNotEnabledError,
} from '../lib/netlify-analytics.js';
import {
  resolveDateWindow,
  mapAnalyticsToChartSeries,
  DEFAULT_ANALYTICS_RANGE,
  type AnalyticsRangeKey,
} from '../../lib/admin/analytics-logic.js';
import { isOwnTrackerDays, surfaceSplit, type OwnTrackerDays } from '../../lib/admin/own-analytics-logic.js';
import { fetchOwnTrackerStats, ownTrackerMissingEnvVars } from '../lib/own-tracker-stats.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { objectRecordKey } from '../lib/object-store-keys.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
};

const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body }),
});

const isRangeKey = (value: string | undefined): value is AnalyticsRangeKey =>
  value === '7d' || value === '30d' || value === '90d' || value === 'custom';

/** Function-instance-lifetime memo — good enough for "stale by a few minutes is fine", no shared store needed. */
const MEMO_TTL_MS = 5 * 60_000;
const CACHE_CONTROL = 'private, max-age=60, stale-while-revalidate=240';
type MemoEntry = { body: Record<string, unknown>; etag: string; expiresAt: number };
const memo = new Map<string, MemoEntry>();

const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

const cachedResponse = (entry: MemoEntry, ifNoneMatch: string | undefined) => {
  if (ifNoneMatch && ifNoneMatch === entry.etag) {
    return { statusCode: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: entry.etag }, body: '' };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': CACHE_CONTROL, ETag: entry.etag },
    body: JSON.stringify(entry.body),
  };
};

const DEFAULT_OWN_TRACKER_DAYS: OwnTrackerDays = 7;

/**
 * `?source=own` — the T21.2b own-tracker feed. Same admin auth wall (checked
 * by the caller before this runs), same memo-Map TTL-cache pattern as the
 * Netlify branch above, keyed separately (`own:` prefix) so the two sources
 * never collide. Missing TRACKING_SINK_URL/TRACKING_PROJECT_ID degrades to
 * the SAME {configured:false, enabled:false, error_code, message} shape the
 * Netlify branch already returns for "not connected" — never a 500 for an
 * honest not-configured state.
 */
/**
 * W7.4 — the publishing surface for each object in the top-N window.
 *
 * Read from the PUBLISH RECEIPT on each record: that receipt is stamped at
 * publish from the auth-derived actor, so it says which chat app (or the
 * autonomous workflow) produced the revision that is live. `null` means the
 * record exists and carries no surface — the workflow path, or a revision
 * published before W7.4 stamped one; an id absent from the map entirely means
 * the record could not be read, which the split reports as `unknown` rather
 * than folding into either.
 *
 * Bounded by construction: `top_objects` is a top-N list (tens, not thousands),
 * so this is a handful of point reads on an admin dashboard load, not a scan.
 * Individual read failures are skipped rather than failing the page — an analytics
 * dashboard that 500s because one object is unreadable is worse than one that
 * says "unknown" for that row.
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

const ownAnalyticsResponse = async (binding: SiteBinding, rawDays: number, ifNoneMatch: string | undefined) => {
  const days: OwnTrackerDays = isOwnTrackerDays(rawDays) ? rawDays : DEFAULT_OWN_TRACKER_DAYS;

  const missing = ownTrackerMissingEnvVars();
  if (missing.length > 0) {
    return jsonResponse(
      200,
      {
        configured: false,
        enabled: false,
        error_code: 'own_tracker_unconfigured',
        message: 'The own-tracker sink is not configured for this site.',
        days,
      },
      { 'Cache-Control': CACHE_CONTROL }
    );
  }

  const cacheKey = `own:${binding.siteId}:${days}`;
  const cached = memo.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cachedResponse(cached, ifNoneMatch);

  try {
    const stats = await fetchOwnTrackerStats(days);
    const body = {
      configured: true,
      enabled: true,
      days,
      stats,
      // W7.4: which surface published each of the objects in this window.
      surfaces: surfaceSplit(stats, await publishingSurfaces(binding, stats.top_objects ?? [])),
    };
    const entry: MemoEntry = { body, etag: etagFor(body), expiresAt: Date.now() + MEMO_TTL_MS };
    memo.set(cacheKey, entry);
    return cachedResponse(entry, ifNoneMatch);
  } catch (error) {
    console.error('Failed to load own-tracker stats.', error);
    return jsonResponse(500, { error: 'Own-tracker stats could not be loaded.' });
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
  const access = await resolveAdminAccessFromEvent(event, context);
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });

  const params = event.queryStringParameters ?? {};

  if (params.source === 'own') {
    const ifNoneMatchOwn = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    return ownAnalyticsResponse(binding, Number(params.days), ifNoneMatchOwn);
  }

  const range = isRangeKey(params.range) ? params.range : DEFAULT_ANALYTICS_RANGE;
  const custom = range === 'custom' && params.from && params.to ? { from: params.from, to: params.to } : undefined;

  const windowResult = resolveDateWindow(range, new Date(), custom);
  if (!windowResult.ok) return jsonResponse(400, { error: windowResult.error });
  const window = windowResult.window;

  // Not configured at all (missing token/site id) — same env vars as
  // deploy_lookup, so this can only happen if that family is also broken.
  // Not an error to surface loudly: an honest, catalogued degrade.
  if (!isNetlifyAnalyticsLookupConfigured()) {
    return jsonResponse(
      200,
      {
        configured: false,
        enabled: false,
        error_code: 'analytics_lookup_unconfigured',
        message: 'Netlify Analytics credentials are not configured for this site.',
        range,
      },
      { 'Cache-Control': CACHE_CONTROL }
    );
  }

  const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
  const cacheKey = `${binding.siteId}:${range}:${window.from}:${window.to}:${window.resolution}`;
  const cached = memo.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cachedResponse(cached, ifNoneMatch);

  try {
    const raw = await fetchTrafficAnalytics(window);
    const series = mapAnalyticsToChartSeries(raw);
    const body = { configured: true, enabled: true, range, window, series };
    const entry: MemoEntry = { body, etag: etagFor(body), expiresAt: Date.now() + MEMO_TTL_MS };
    memo.set(cacheKey, entry);
    return cachedResponse(entry, ifNoneMatch);
  } catch (error) {
    if (error instanceof NetlifyAnalyticsNotEnabledError) {
      // A per-tenant plan gap, not a fault — catalogued and cached exactly
      // like a real result so a tenant without the add-on doesn't hammer the
      // API every time someone opens the page.
      const body = {
        configured: true,
        enabled: false,
        error_code: 'analytics_not_enabled',
        message:
          'Analytics is not enabled for this site. Turn on the Netlify Analytics add-on for this site in Netlify to see analytics data here.',
        range,
      };
      const entry: MemoEntry = { body, etag: etagFor(body), expiresAt: Date.now() + MEMO_TTL_MS };
      memo.set(cacheKey, entry);
      return cachedResponse(entry, ifNoneMatch);
    }
    console.error('Failed to load analytics.', error);
    return jsonResponse(500, { error: 'Analytics data could not be loaded.' });
  }
};

export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
