/**
 * admin-analytics (T4.1; renamed from admin-traffic, T21.9b; R6.2 data
 * points, T21.24) — analytics dashboard data: visits/sources/top content
 * over a range, from Netlify Analytics (gate G1) and the own-tracker sink.
 * GET-only, admin auth wall matching `admin-release-state.ts`.
 *
 * R6.2 additions, all server-side (never in the client — D8's "the admin
 * function computes it, never the client"):
 *  - the own branch now takes `range`/`from`/`to` (the SAME shared window as
 *    the Netlify branch, `resolveDateWindow`) plus D7's filter params
 *    (`country`/`fsource`/`object` on the wire — see `analytics-logic.ts`'s
 *    `parseAnalyticsSearchParams` for why `fsource` and not `source`) instead
 *    of the old `?days=7|30`, which is what let the own tab's range picker
 *    drop its 90d/custom restriction (D10);
 *  - object ids in `top_objects`/`engagement_funnel` are resolved to
 *    title/route/admin-link here (D6, `analytics-object-directory.ts`), never
 *    shipped to the client as bare ids;
 *  - the Netlify branch wires `/ranking/not_found` + `/ranking/countries`,
 *    probes `/bandwidth` once, and fetches the immediately-preceding window
 *    for KPI deltas (D3) — every one of these is best-effort and independent:
 *    a failure on any of them degrades that one field to absent, never fails
 *    the request.
 *
 * R6.4/D8 (T21.26) — exclusions. The own tab needs no new code here: its
 * loader hard-bails on `/admin` before an event is ever sent (never reaches
 * the sink), and same-host referrers were already bucketed to "Internal" at
 * the sink since R6.2 (`top_referrer_hosts.internal_sessions`). The Netlify
 * tab's server-side Analytics API sees admin/function traffic and takes no
 * filter parameter, so `netlify-analytics.ts` now sweeps `/admin`/`/.netlify`
 * rows out of `topPaths`/`topNotFound` and same-host rows out of
 * `topSources` itself, reporting both swept totals here as
 * `excludedAdminVisits`/`internalReferrerVisits` — approximations computed
 * from visible ranking rows only, since Netlify's aggregate totals can't be
 * filtered directly. `siteHostFromEnv()` reads `process.env.URL` (the
 * established convention for this site's own URL, not a new env var).
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
import { timeAuth, timeSerialize, withServerTiming } from '../lib/server-timing.js';
import {
  fetchTrafficAnalytics,
  fetchNotFoundAndCountries,
  fetchPreviousTrafficAnalytics,
  fetchBandwidth,
  isNetlifyAnalyticsLookupConfigured,
  NetlifyAnalyticsNotEnabledError,
} from '../lib/netlify-analytics.js';
import {
  resolveDateWindow,
  mapAnalyticsToChartSeries,
  DEFAULT_ANALYTICS_RANGE,
  isAnalyticsRangeKey,
  isAnalyticsSource,
  type AnalyticsRangeKey,
  type AnalyticsFilters,
} from '../../lib/admin/analytics-logic.js';
import { surfaceSplit } from '../../lib/admin/own-analytics-logic.js';
import {
  fetchOwnTrackerRawExport,
  fetchOwnTrackerStats,
  ownTrackerMissingEnvVars,
  type OwnTrackerExportKind,
} from '../lib/own-tracker-stats.js';
import {
  armMetricsMissingEnvVars,
  fetchOwnTrackerRollups,
  fetchOwnTrackerWeights,
} from '../lib/own-tracker-rollups.js';
import { readTrackingExperiments } from '../lib/tracking-config-read.js';
import { rawExportFilename } from '../../lib/admin/analytics-export-logic.js';
import { resolveAnalyticsObjectDirectory } from '../lib/analytics-object-directory.js';
import { getAnalyticsViewsBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { objectRecordKey } from '../lib/object-store-keys.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';
import {
  addAnalyticsNote,
  deleteAnalyticsNote,
  deleteAnalyticsView,
  listAnalyticsNotes,
  listAnalyticsViews,
  saveAnalyticsView,
} from '../lib/analytics-views-store.js';
import {
  isAnalyticsPagesSort,
  isValidNoteDate,
  isValidNoteText,
  isValidViewName,
  MAX_VIEW_NAME_LENGTH,
  type AnalyticsNoteInput,
  type AnalyticsViewInput,
} from '../../lib/admin/analytics-views-logic.js';
import { fetchAnnotationMarkers } from '../lib/analytics-annotations.js';
import type { ObjectVerbStore } from '../lib/object-verbs.js';
import { fetchAnalyticsInsights } from '../lib/analytics-insights.js';

type LambdaEvent = {
  headers?: Record<string, string | undefined>;
  httpMethod?: string;
  queryStringParameters?: Record<string, string | undefined> | null;
  body?: string | null;
  isBase64Encoded?: boolean;
};

const jsonResponse = (
  statusCode: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {}
) => ({
  statusCode,
  headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders },
  body: timeSerialize(() => JSON.stringify({ ok: statusCode >= 200 && statusCode < 300, status: statusCode, ...body })),
});

const isRangeKey = (value: string | undefined): value is AnalyticsRangeKey =>
  value === '7d' || value === '30d' || value === '90d' || value === 'custom';

/**
 * R6.4/D8 — this site's own URL, for same-host-referrer ("Internal")
 * detection on the Netlify tab. `process.env.URL` is the established
 * repo-wide convention for "this site's primary URL" (the same env var
 * `admin-auth.ts`, `mcp.ts`, `create-checkout-session.ts`, and others already
 * read) — a real Netlify-provided build/runtime env var, not a new one (no
 * P2 obligation). Passed straight through, scheme and all —
 * `isInternalReferrerHost` (`analytics-logic.ts`) does its own scheme/path/
 * `www.` stripping on both sides of the comparison, so there is nothing to
 * parse here. Unset degrades to `undefined`, which that predicate in turn
 * treats as "nothing is internal", never a guess.
 */
const siteHostFromEnv = (): string | undefined => process.env.URL || undefined;

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
    body: timeSerialize(() => JSON.stringify(entry.body)),
  };
};

/**
 * R6.2/D2 — "probe `/bandwidth` once [per deploy]": a tenant whose Netlify
 * plan doesn't carry this endpoint should not have every dashboard load
 * retry it. Sticks to `false` (never try again this instance) the first time
 * the probe comes back `null`; a tenant that DOES have it keeps getting a
 * live number every call, keyed by nothing here — `fetchBandwidth` itself is
 * still per-window.
 */
let bandwidthKnownUnavailable = false;

/**
 * D7 — the three sink filter params, read off the wire names
 * `analytics-logic.ts`'s `parseAnalyticsSearchParams` writes
 * (`country`/`fsource`/`object`, chosen so `fsource` never collides with the
 * `source` tab selector already on this same query string).
 */
const readFilters = (params: Record<string, string | undefined>): AnalyticsFilters => {
  const filters: AnalyticsFilters = {};
  if (params.country) filters.country = params.country;
  if (params.fsource) filters.source = params.fsource;
  if (params.object) filters.object_id = params.object;
  return filters;
};

const filterCacheKey = (filters: AnalyticsFilters): string =>
  `${filters.country ?? ''}|${filters.source ?? ''}|${filters.object_id ?? ''}`;

/**
 * `?source=own` — the T21.2b own-tracker feed. Same admin auth wall (checked
 * by the caller before this runs), same memo-Map TTL-cache pattern as the
 * Netlify branch below, keyed separately (`own:` prefix) so the two sources
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

const ownAnalyticsResponse = async (
  binding: SiteBinding,
  range: AnalyticsRangeKey,
  custom: { from: string; to: string } | undefined,
  filters: AnalyticsFilters,
  ifNoneMatch: string | undefined
) => {
  const windowResult = resolveDateWindow(range, new Date(), custom);
  if (!windowResult.ok) return jsonResponse(400, { error: windowResult.error });
  const window = windowResult.window;

  const missing = ownTrackerMissingEnvVars();
  if (missing.length > 0) {
    return jsonResponse(
      200,
      {
        configured: false,
        enabled: false,
        error_code: 'own_tracker_unconfigured',
        message: 'The own-tracker sink is not configured for this site.',
        range,
      },
      { 'Cache-Control': CACHE_CONTROL }
    );
  }

  const cacheKey = `own:${binding.siteId}:${range}:${window.from}:${window.to}:${filterCacheKey(filters)}`;
  const cached = memo.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cachedResponse(cached, ifNoneMatch);

  try {
    const stats = await fetchOwnTrackerStats(
      { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() },
      { filters: { country: filters.country, source: filters.source, object_id: filters.object_id } }
    );

    // D6 — resolve every object id this response references (top objects +
    // the engagement funnel) to title/route/admin-link, server-side.
    const objectIds = [
      ...(stats.top_objects ?? []).map((row) => row?.object_id),
      ...(stats.engagement_funnel ?? []).map((row) => row?.object_id),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0);
    const objectDirectory = await resolveAnalyticsObjectDirectory(binding.dataRoot, objectIds);

    const body = {
      configured: true,
      enabled: true,
      range,
      window,
      stats,
      object_directory: objectDirectory,
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

/**
 * R11.1 (T21.27) — saved-view request bodies. Every field is re-validated
 * here, never trusted from the client: `name`/`range`/`tab`/`filters` all get
 * the same shape checks the pure logic module would refuse to build a view
 * from, so a hand-crafted POST can't smuggle a malformed row into the store.
 */
const parseJsonBody = (event: LambdaEvent): Record<string, unknown> | undefined => {
  if (!event.body) return undefined;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

const readFiltersFromBody = (value: unknown): AnalyticsFilters => {
  if (!value || typeof value !== 'object') return {};
  const raw = value as Record<string, unknown>;
  const filters: AnalyticsFilters = {};
  if (typeof raw.country === 'string' && raw.country) filters.country = raw.country;
  if (typeof raw.source === 'string' && raw.source) filters.source = raw.source;
  if (typeof raw.object_id === 'string' && raw.object_id) filters.object_id = raw.object_id;
  return filters;
};

const viewInputFromBody = (body: Record<string, unknown>): AnalyticsViewInput | { error: string } => {
  const name = typeof body.name === 'string' ? body.name : '';
  if (!isValidViewName(name)) return { error: `A view name is required (1-${MAX_VIEW_NAME_LENGTH} characters).` };
  const tab = body.tab;
  if (!isAnalyticsSource(tab)) return { error: 'tab must be "own" or "netlify".' };
  const range = body.range;
  if (!isAnalyticsRangeKey(range)) return { error: 'range must be one of 7d, 30d, 90d, custom.' };
  if (range === 'custom' && !(typeof body.from === 'string' && typeof body.to === 'string' && body.from && body.to)) {
    return { error: 'A custom range needs both from and to.' };
  }
  const pagesSortRaw = body.pagesSort;
  const pagesSort = tab === 'own' && isAnalyticsPagesSort(pagesSortRaw) ? pagesSortRaw : undefined;
  return {
    name: name.trim(),
    tab,
    range,
    from: range === 'custom' ? (body.from as string) : undefined,
    to: range === 'custom' ? (body.to as string) : undefined,
    compare: Boolean(body.compare),
    filters: readFiltersFromBody(body.filters),
    pagesSort,
  };
};

/** GET/POST/DELETE `?resource=views` — the Views menu's list/save/delete. Same admin auth wall; a small blob store, not the object substrate (see `analytics-views-logic.ts`'s header for why). */
const viewsResourceResponse = async (binding: SiteBinding, event: LambdaEvent) => {
  const store = await getAnalyticsViewsBlobStore(event, binding);
  const params = event.queryStringParameters ?? {};

  if (event.httpMethod === 'GET') {
    return jsonResponse(200, { views: await listAnalyticsViews(store) });
  }

  if (event.httpMethod === 'POST') {
    const body = parseJsonBody(event);
    if (!body) return jsonResponse(400, { error: 'A JSON body is required.' });
    const input = viewInputFromBody(body);
    if ('error' in input) return jsonResponse(400, { error: input.error });
    const existingId = typeof body.id === 'string' && body.id ? body.id : undefined;
    try {
      const view = await saveAnalyticsView(store, input, existingId);
      return jsonResponse(200, { view });
    } catch (error) {
      return jsonResponse(404, { error: error instanceof Error ? error.message : 'Could not save that view.' });
    }
  }

  if (event.httpMethod === 'DELETE') {
    const id = params.id;
    if (!id) return jsonResponse(400, { error: 'id is required.' });
    const deleted = await deleteAnalyticsView(store, id);
    return jsonResponse(200, { deleted });
  }

  return jsonResponse(405, { error: 'Method not allowed' });
};

const isExportKind = (value: string | undefined): value is OwnTrackerExportKind =>
  value === 'events' || value === 'commerce' || value === 'dims';

/**
 * R11.2 (T21.28) — `GET ?resource=raw_export&kind=events|commerce|dims&from&to`:
 * "Download raw events (range)". Proxies `fetchOwnTrackerRawExport` (the
 * ONLY place the sink Bearer token is attached — see that module's header),
 * so the browser only ever sees this admin function's own response, never
 * the sink's token. A 404/unconfigured sink comes back as a 200 JSON
 * `{available:false, error_code, message}` — a clear "not available on this
 * sink yet" state for the client to render, never a broken download.
 */
const rawExportResourceResponse = async (params: Record<string, string | undefined>) => {
  if (!isExportKind(params.kind)) return jsonResponse(400, { error: 'kind must be one of events, commerce, dims.' });
  if (!params.from || !params.to) return jsonResponse(400, { error: 'from and to are required (ISO timestamps).' });

  const result = await fetchOwnTrackerRawExport({ kind: params.kind, from: params.from, to: params.to });
  if (!result.available) {
    return jsonResponse(200, { available: false, error_code: result.errorCode, message: result.message });
  }
  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/x-ndjson',
      'Cache-Control': 'no-store',
      'Content-Disposition': `attachment; filename="${rawExportFilename(params.kind, params.from, params.to)}"`,
    },
    body: result.ndjson,
  };
};

/**
 * R11.3 (T21.29) — `GET ?resource=annotations&from&to`: release markers
 * (recent Netlify deploy receipts), publish markers (`publish` history
 * entries off `content_item`/`page` records), and operator notes, merged
 * and scoped to the window — one call for every tick the chart draws.
 * `fetchAnnotationMarkers` degrades each of its three sources
 * independently, so this never 500s just because e.g. deploy lookup isn't
 * configured for this tenant.
 */
/**
 * T2.3 — this GET-shaped resource had no validator at all (T0.2's "zero
 * ETags anywhere in `server/functions/`" finding, before the rest of this
 * file closed the gap resource by resource). `from`/`to` are the only inputs
 * and both are already part of `markers`' derivation, so hashing the exact
 * response body — not a separately-built cache key — is enough for the etag
 * to vary with everything that varies it.
 *
 * Deliberately `private, no-cache` (always revalidate), NOT this file's own
 * `CACHE_CONTROL` (`max-age=60, stale-while-revalidate=240`): annotations
 * back the chart an operator is actively adding notes/markers to in the same
 * session (`?resource=notes`, right below), so the read after that write
 * must not still be within a 60s client-side max-age window.
 */
const ANNOTATIONS_CACHE_CONTROL = 'private, no-cache';

const annotationsResourceResponse = async (binding: SiteBinding, event: LambdaEvent) => {
  const params = event.queryStringParameters ?? {};
  if (!params.from || !params.to) return jsonResponse(400, { error: 'from and to are required (ISO timestamps).' });

  const [objectsStore, viewsStore] = await Promise.all([
    getSiteObjectsBlobStore(event, binding),
    getAnalyticsViewsBlobStore(event, binding),
  ]);
  const markers = await fetchAnnotationMarkers({
    store: objectsStore as unknown as ObjectVerbStore,
    viewsStore,
    from: params.from,
    to: params.to,
  });
  const body = { markers };
  const etag = timeSerialize(() => etagFor(body));
  const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
  if (ifNoneMatch && ifNoneMatch === etag) {
    return { statusCode: 304, headers: { 'Cache-Control': ANNOTATIONS_CACHE_CONTROL, ETag: etag }, body: '' };
  }
  return jsonResponse(200, body, { 'Cache-Control': ANNOTATIONS_CACHE_CONTROL, ETag: etag });
};

const noteInputFromBody = (body: Record<string, unknown>): AnalyticsNoteInput | { error: string } => {
  const date = typeof body.date === 'string' ? body.date : '';
  if (!isValidNoteDate(date)) return { error: 'date must be YYYY-MM-DD.' };
  const text = typeof body.text === 'string' ? body.text : '';
  if (!isValidNoteText(text)) return { error: 'text is required (1-500 characters).' };
  return { date, text: text.trim() };
};

/** GET/POST/DELETE `?resource=notes` — "click a day to add a note" (R11.3). Same small `analytics-views` Blobs store as saved views (R11.1's header explains why this is a preference, not a governed object). `actorEmail` is the ALREADY-RESOLVED admin identity from the caller's auth check — never re-resolved here. */
const notesResourceResponse = async (binding: SiteBinding, event: LambdaEvent, actorEmail: string) => {
  const store = await getAnalyticsViewsBlobStore(event, binding);
  const params = event.queryStringParameters ?? {};

  if (event.httpMethod === 'GET') {
    const range = params.from && params.to ? { from: params.from, to: params.to } : undefined;
    return jsonResponse(200, { notes: await listAnalyticsNotes(store, range) });
  }

  if (event.httpMethod === 'POST') {
    const body = parseJsonBody(event);
    if (!body) return jsonResponse(400, { error: 'A JSON body is required.' });
    const input = noteInputFromBody(body);
    if ('error' in input) return jsonResponse(400, { error: input.error });
    const note = await addAnalyticsNote(store, input, actorEmail);
    return jsonResponse(200, { note });
  }

  if (event.httpMethod === 'DELETE') {
    const id = params.id;
    if (!id) return jsonResponse(400, { error: 'id is required.' });
    const deleted = await deleteAnalyticsNote(store, id);
    return jsonResponse(200, { deleted });
  }

  return jsonResponse(405, { error: 'Method not allowed' });
};

/**
 * GET `?resource=object_identity&id=<objectId>` — R11.4's drill-down page
 * (T21.30): the object's title/route/type (D6, the same committed-export
 * directory `resolveAnalyticsObjectDirectory` already builds for the main
 * page's ranking rows) plus its producer surface + prompt version, read off
 * the object's own publish receipt exactly the way `publishingSurfaces`
 * above reads it for the main page's surface split. Deliberately independent
 * of the tracking sink and the range picker's window — an object's identity
 * and who produced its live revision don't change per range, and this stays
 * answerable even before the sink has deployed anything the drill-down's
 * funnel/nodes/variants panels need. `found: false` is a real, rendered
 * state (a stale link, a deleted object), never a 404 — the caller degrades,
 * it does not fail the page.
 */
const objectIdentityResourceResponse = async (binding: SiteBinding, event: LambdaEvent) => {
  const params = event.queryStringParameters ?? {};
  const objectId = params.id;
  if (!objectId) return jsonResponse(400, { error: 'id is required.' });

  const directory = await resolveAnalyticsObjectDirectory(binding.dataRoot, [objectId]);
  const entry = directory[objectId];

  let producer: { surface: string | null; promptVersion: string | null } | null = null;
  try {
    const store = await getSiteObjectsBlobStore({}, binding);
    for (const objectType of ['content_item', 'page'] as const) {
      const raw = await store.get(objectRecordKey(objectType, objectId));
      if (!raw) continue;
      const record = JSON.parse(raw as string) as ObjectRecord;
      const receipt = record.publication?.publish_receipt;
      producer = { surface: receipt?.surface ?? null, promptVersion: receipt?.prompt_version ?? null };
      break;
    }
  } catch {
    // Store unreadable — identity still renders from the export directory; producer degrades to a named "unknown" (null), never a 500.
  }

  const identity = entry
    ? { objectId, found: true, title: entry.title, route: entry.route, objectType: entry.objectType }
    : { objectId, found: false, title: objectId, route: null, objectType: 'unknown' };

  return jsonResponse(200, { identity, producer });
};

/**
 * R11.5 (T21.36) — `?source=insights`: the read-only "is the learning loop
 * working" tab. Unlike `own`/`netlify`, this data carries no range/window
 * of its own (every row is its own evidence window — see
 * `analytics-insights-logic.ts`), so there is nothing to derive from
 * `resolveDateWindow` here; the cache key is therefore a constant, not
 * windowed like the other two branches. Same memo-Map TTL + real ETag/304
 * pattern as every other branch on this function (`fetchAnalyticsInsights`
 * itself never throws — every CMS-Agent call it makes degrades to a typed
 * per-section failure — but the try/catch here matches this file's own
 * defensive posture rather than trusting that invariant blindly).
 */
const INSIGHTS_CACHE_KEY = 'insights';

const insightsAnalyticsResponse = async (ifNoneMatch: string | undefined) => {
  const cached = memo.get(INSIGHTS_CACHE_KEY);
  if (cached && cached.expiresAt > Date.now()) return cachedResponse(cached, ifNoneMatch);

  try {
    const body = await fetchAnalyticsInsights();
    // `InsightsOverview` is a named interface (unlike every other branch's
    // inline object-literal body), so it needs an explicit cast to satisfy
    // `MemoEntry.body`'s `Record<string, unknown>` — TS requires a declared
    // index signature for a named interface even though every field here is
    // already index-compatible.
    const entry: MemoEntry = {
      body: body as unknown as Record<string, unknown>,
      etag: etagFor(body),
      expiresAt: Date.now() + MEMO_TTL_MS,
    };
    memo.set(INSIGHTS_CACHE_KEY, entry);
    return cachedResponse(entry, ifNoneMatch);
  } catch (error) {
    console.error('Failed to load analytics insights.', error);
    return jsonResponse(500, { error: 'Analytics insights could not be loaded.' });
  }
};

/**
 * `?source=arm_metrics` (T21.6b / R4b) — `/admin/variants`' per-arm reader
 * metrics feed. Same shape law as `ownAnalyticsResponse` above (own env pair,
 * same `own_tracker_unconfigured` degrade, same memo-Map TTL cache keyed
 * separately — `arm:` prefix — so none of the three `?source=` feeds ever
 * collide), fetched ONCE for the whole page rather than per family:
 *
 *  - `rows` — every object's rollup, from `${TRACKING_SINK_URL}/rollups?by=object`.
 *  - `experiments` — `trk_<site>`'s `experiments[]` (every status; the pure
 *    `honestyLabel` in `lib/admin/variant-arm-metrics.ts` filters to `active`
 *    per family) — the server-side read the honesty rule requires (12-plan
 *    §15.4 / §16): a family is never labelled from whether metrics exist.
 *  - `weights` — the sink's CURRENT `/weights` row, un-normalized; the client
 *    normalizes per family via `familyArmMetrics`.
 *
 * A `/rollups` failure is a real 500 (this is the page's primary data source,
 * not an optional extra — same posture `ownAnalyticsResponse` takes toward a
 * `/stats` failure). A `/weights` failure never reaches here at all:
 * `fetchOwnTrackerWeights` already degrades to `{}` internally.
 */
const armMetricsResponse = async (binding: SiteBinding, ifNoneMatch: string | undefined) => {
  const missing = armMetricsMissingEnvVars();
  if (missing.length > 0) {
    return jsonResponse(
      200,
      {
        configured: false,
        enabled: false,
        error_code: 'own_tracker_unconfigured',
        message: 'The tracking sink is not configured for this site.',
      },
      { 'Cache-Control': CACHE_CONTROL }
    );
  }

  const cacheKey = `arm:${binding.siteId}`;
  const cached = memo.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cachedResponse(cached, ifNoneMatch);

  try {
    const [rows, experiments, weights] = await Promise.all([
      fetchOwnTrackerRollups(),
      readTrackingExperiments(binding),
      fetchOwnTrackerWeights({ warn: (message) => console.warn(`[admin-analytics] ${message}`) }),
    ]);
    const body = { configured: true, enabled: true, rows, experiments, weights };
    const entry: MemoEntry = { body, etag: etagFor(body), expiresAt: Date.now() + MEMO_TTL_MS };
    memo.set(cacheKey, entry);
    return cachedResponse(entry, ifNoneMatch);
  } catch (error) {
    console.error('Failed to load arm metrics.', error);
    return jsonResponse(500, { error: 'Arm metrics could not be loaded.' });
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  const params = event.queryStringParameters ?? {};

  // R11.1/R11.2/R11.3 — the resources on this function that aren't a plain
  // GET (a saved view or a note is created/renamed/deleted through the same
  // admin surface rather than a separate function; see
  // viewsResourceResponse's own doc), or that are a GET but return a body
  // other than the usual analytics JSON (the raw NDJSON export). Every other
  // resource/branch below stays GET-only-analytics-JSON, matching the method
  // gate this replaces exactly for every request that doesn't name one of
  // these resources.
  if (params.resource === 'views') {
    const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
    if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
    return viewsResourceResponse(binding, event);
  }

  if (params.resource === 'raw_export') {
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
    const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
    if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
    return rawExportResourceResponse(params);
  }

  if (params.resource === 'annotations') {
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
    const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
    if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
    return annotationsResourceResponse(binding, event);
  }

  if (params.resource === 'notes') {
    const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
    if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
    return notesResourceResponse(binding, event, access.email);
  }

  if (params.resource === 'object_identity') {
    if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
    const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
    if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
    if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });
    return objectIdentityResourceResponse(binding, event);
  }

  if (event.httpMethod !== 'GET') return jsonResponse(405, { error: 'Method not allowed' });
  const access = await timeAuth(() => resolveAdminAccessFromEvent(event, context, binding));
  if (!access.authenticated) return jsonResponse(401, { error: access.error || 'Authentication is required.' });
  if (!access.isAdmin || !access.email) return jsonResponse(403, { error: 'Admin access is required.' });

  const range = isRangeKey(params.range) ? params.range : DEFAULT_ANALYTICS_RANGE;
  const custom = range === 'custom' && params.from && params.to ? { from: params.from, to: params.to } : undefined;
  const filters = readFilters(params);

  if (params.source === 'own') {
    const ifNoneMatchOwn = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    return ownAnalyticsResponse(binding, range, custom, filters, ifNoneMatchOwn);
  }

  if (params.source === 'insights') {
    const ifNoneMatchInsights = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    return insightsAnalyticsResponse(ifNoneMatchInsights);
  }

  if (params.source === 'arm_metrics') {
    const ifNoneMatchArm = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
    return armMetricsResponse(binding, ifNoneMatchArm);
  }

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
    const siteHost = siteHostFromEnv();
    const raw = await fetchTrafficAnalytics(window, siteHost);
    const series = mapAnalyticsToChartSeries(raw);

    // R6.2 — every one of these is best-effort and independent: none of
    // them may throw past this point (their own modules already catch), so
    // a failure on any one never blocks the primary series above.
    const [previousRaw, notFoundAndCountries, bandwidthBytes] = await Promise.all([
      fetchPreviousTrafficAnalytics(window, siteHost),
      fetchNotFoundAndCountries(window).catch(() => null),
      bandwidthKnownUnavailable ? Promise.resolve(null) : fetchBandwidth(window),
    ]);
    if (bandwidthBytes === null) bandwidthKnownUnavailable = true;

    // R6.4/D8 — "excl. admin" combines both path-shaped rankings
    // (`topPaths` + `topNotFound`) that could carry a `/admin`/`/.netlify`
    // row; "Internal" is `topSources`' same-host referrers alone. Both are
    // approximations computed from visible ranking rows only (Netlify's
    // aggregate totals can't be filtered directly) — labelled as such on
    // the client, never presented as exact.
    const excludedAdminVisits =
      (raw.excludedAdminPathVisits ?? 0) + (notFoundAndCountries?.excludedAdminNotFoundVisits ?? 0);
    const internalReferrerVisits = raw.internalReferrerVisits ?? 0;

    const body = {
      configured: true,
      enabled: true,
      range,
      window,
      series,
      previousSeries: previousRaw ? mapAnalyticsToChartSeries(previousRaw) : undefined,
      topNotFound: notFoundAndCountries?.topNotFound,
      topCountries: notFoundAndCountries?.topCountries,
      bandwidthBytes,
      excludedAdminVisits,
      internalReferrerVisits,
    };
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

export const createHandler = (binding: SiteBinding) => withServerTiming('admin-analytics', buildHandlerImpl(binding));
