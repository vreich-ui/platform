/**
 * Netlify Analytics (T4.1, rewritten T21.2c / R1.4) — the analytics dashboard's
 * data source, per Wolf's gate answer G1 (Netlify Analytics, not
 * GA4/Plausible/Supermetrics).
 *
 * ## T21.2c: the endpoint drift (2026-09-01)
 *
 * The original implementation called the undocumented
 * `https://api.netlify.com/api/v1/sites/{site_id}/analytics/*` surface.
 * Every path under it now returns 404, which this module's 401/403/404 →
 * "not enabled" mapping (correctly) treats as "no Analytics add-on" — so
 * `/admin/analytics` (then `/admin/traffic`) showed the empty state for `drluriescience` even though
 * the Analytics add-on IS active (`analytics_instance_id` set on the site
 * object). The old host is gone/renamed; it was never the real contract.
 *
 * Diagnosed live against the real API (not guessed) with a real token:
 *
 *  - **Base URL**: `https://analytics.services.netlify.com/v2/{SITE_ID}` —
 *    the site id (same `blobSiteId` binding used everywhere else in this
 *    file, e.g. `NETLIFY_SITE_ID`/`SITE_ID`), **not** the site's
 *    `analytics_instance_id` — the instance id 401s on this host.
 *  - **Auth**: `Authorization: Bearer <token>`, the SAME token/env as
 *    before (`NETLIFY_AUTH_TOKEN`/`NETLIFY_BLOBS_TOKEN`) — nothing new to
 *    configure, so `netlifyAnalyticsLookupMissingEnvVars` still just reuses
 *    `netlifyDeployLookupMissingEnvVars` (fleet law P2 does not apply; there
 *    is no new env var).
 *  - **Trend**: `/pageviews` and `/visitors` (same query params: `from`,
 *    `to` epoch-ms, `timezone` as a URL-encoded `±HH:MM` offset, and
 *    `resolution`) each return `{"data":[[epochMs, count], ...]}` — a tuple
 *    array, not a row-of-objects. `/pageviews` gives the visits series,
 *    `/visitors` the uniques series; they are zipped by bucket timestamp
 *    into one trend series below.
 *  - **Rankings**: one path per dimension —
 *    `/ranking/pages?from&to&limit=N`, `/ranking/sources?...`,
 *    `/ranking/not_found?...`, `/ranking/countries?...` — each returning
 *    `{"data":[{"count": N, "resource": "…", "country_name"?: "…"}, ...]}`.
 *    The old `association_key`/`value_key`/`per_page` query shape is gone;
 *    it's a distinct path plus `limit` per dimension now. Only `pages` and
 *    `sources` are wired into `fetchTrafficAnalytics` (the two dimensions
 *    the dashboard renders, `topPaths`/`topSources` on
 *    `RawAnalyticsData`) — `not_found`/`countries` are documented above
 *    because they were verified live in the same pass, but there is no
 *    consuming UI for them yet; wiring them in is future scope, not this
 *    fix. `parseRankingRowsV2` below is dimension-agnostic, so adding either
 *    is a call-site change, not a parser change.
 *  - **Empty `resource`** on the sources ranking means direct/none —
 *    `normalizeSourceLabel` already maps an empty/falsy label to `"Direct"`,
 *    so no change was needed there; a fixture test pins this row shape.
 *
 * `NetlifyAnalyticsNotEnabledError` is UNCHANGED in meaning: 401 (auth), 403
 * (authenticated but not entitled), and 404 (route doesn't exist for an
 * un-purchased add-on) still all collapse to "not enabled for this site" —
 * that mapping is exactly what let this real drift hide as a false
 * "disabled" for as long as it did. What's NEW (R1.4) is a server-log-only
 * line on that branch recording the raw HTTP status and request path (never
 * the token — it only ever appears in the `Authorization` header, never in
 * a logged string) so the *next* drift is diagnosable from logs alone
 * instead of requiring another live-API reverse-engineering pass.
 *
 * Because the response shape, while now pinned by a live diagnosis, is
 * still an undocumented/unversioned private API, the parsers below stay
 * defensive: an unexpected row shape is dropped, never thrown on. This
 * module remains intentionally NOT unit-tested against a live network call
 * (no test file exists for `netlify-deploys.ts` either, for the same
 * reason) — but IS now fixture-tested against a stubbed `fetch` for the
 * exact shapes verified above (`tests/netlify/netlify-analytics.test.ts`),
 * which the pre-T21.2c version had no coverage for at all. The pure
 * last-mile transform this module hands off to —
 * `mapAnalyticsToChartSeries` in `lib/admin/analytics-logic.ts` — is
 * separately unit-tested against the normalized intermediate shape this
 * module produces.
 */
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from './site-binding.js';
import { netlifyDeployLookupMissingEnvVars } from './netlify-deploys.js';
import {
  normalizePathLabel,
  normalizeSourceLabel,
  type RawAnalyticsData,
  type AnalyticsRankingRow,
  type AnalyticsTrendPoint,
} from '../../lib/admin/analytics-logic.js';

/** v2 host — see the module doc comment for the live diagnosis behind this. */
const NETLIFY_ANALYTICS_BASE_URL = 'https://analytics.services.netlify.com/v2';

/**
 * `resolveDateWindow` (this module's only caller of `windowQuery`) always
 * computes its `from`/`to` in UTC, so the timezone this module asks
 * Netlify's Analytics API for buckets in is always UTC too — never the host
 * machine's local zone, which would silently desync from the window math.
 */
const ANALYTICS_TIMEZONE_OFFSET = '+00:00';

/** How many rows to ask for per ranking dimension — same cap the old `per_page=20` used. */
const RANKING_LIMIT = 20;

const getNetlifyAnalyticsConfig = (envNames: SiteBindingEnvNames = PLATFORM_ENV_NAMES) => ({
  siteId: readBoundEnv(envNames.blobSiteId) ?? '',
  token: readBoundEnv(envNames.deployLookupToken) ?? '',
});

/** Same predicate as deploy lookup — same two env vars, see module doc comment. */
export const netlifyAnalyticsLookupMissingEnvVars = netlifyDeployLookupMissingEnvVars;
export const isNetlifyAnalyticsLookupConfigured = (): boolean => netlifyAnalyticsLookupMissingEnvVars().length === 0;

/**
 * Credentials are fine; this Netlify site simply has no Analytics add-on
 * purchased/enabled. The admin page renders this as an honest empty state
 * naming what to turn on — never a 500, never a blank chart.
 */
export class NetlifyAnalyticsNotEnabledError extends Error {
  constructor(message = 'Netlify Analytics is not enabled for this site.') {
    super(message);
    this.name = 'NetlifyAnalyticsNotEnabledError';
  }
}

export interface NetlifyAnalyticsWindow {
  from: number;
  to: number;
  resolution: 'hour' | 'day';
}

const toNumberValue = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/**
 * `subpath` starts with `/pageviews`, `/visitors`, or `/ranking/<dimension>`
 * — the site id and base URL are assembled here so every call site only
 * ever names the part of the path that varies.
 */
const fetchNetlifyAnalyticsApi = async (subpath: string): Promise<unknown> => {
  const { siteId, token } = getNetlifyAnalyticsConfig();
  if (!siteId || !token) throw new Error('Netlify Analytics lookup is not configured.');

  const requestPath = `/${encodeURIComponent(siteId)}${subpath}`;
  const response = await fetch(`${NETLIFY_ANALYTICS_BASE_URL}${requestPath}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // The private Analytics surface can reject an un-entitled site at any of
  // three layers depending on how Netlify's own gateway is set up for it —
  // plain auth (401), an authenticated-but-not-entitled account (403), or a
  // route that simply does not exist for a site with no Analytics package
  // (404). All three mean the same thing from here: no Analytics for this
  // site, not a real fault.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    // R1.4: server-log-only diagnostic line — records the raw status and
    // request path so the NEXT drift on this undocumented API is
    // diagnosable from logs alone. `requestPath` never contains the token
    // (it only ever goes in the `Authorization` header above); do not add
    // headers or the token to this line.
    console.warn(`[netlify-analytics] mapped to "not enabled": HTTP ${response.status} on GET ${requestPath}`);
    throw new NetlifyAnalyticsNotEnabledError();
  }
  if (!response.ok) {
    throw new Error(`Netlify Analytics lookup failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
};

/** The `{"data": [...]}` envelope both trend and ranking endpoints share. Anything else (missing/non-array `data`) degrades to no rows, never a throw. */
const extractDataArray = (payload: unknown): unknown[] => {
  if (payload && typeof payload === 'object') {
    const data = (payload as Record<string, unknown>).data;
    if (Array.isArray(data)) return data;
  }
  return [];
};

/** `/pageviews` and `/visitors` rows: a `[epochMs, count]` tuple. A malformed row is dropped, not thrown on. */
const parseTuplePoint = (row: unknown): { t: string; count: number } | undefined => {
  if (!Array.isArray(row) || row.length !== 2) return undefined;
  const [rawT, rawCount] = row;
  if (typeof rawT !== 'number' || !Number.isFinite(rawT)) return undefined;
  return { t: new Date(rawT).toISOString(), count: toNumberValue(rawCount) };
};

/**
 * Zips the pageviews tuple series (visits) and the visitors tuple series
 * (uniques) by bucket timestamp into one `AnalyticsTrendPoint[]`. A bucket
 * present in only one series still produces a point, with the missing side
 * defaulting to 0, rather than being dropped — a plan tier or transient
 * failure that loses the uniques call shouldn't also blank the visits bar
 * for that bucket.
 */
const buildTrend = (pageviewRows: unknown[], visitorRows: unknown[]): AnalyticsTrendPoint[] => {
  const visitsByT = new Map<string, number>();
  for (const row of pageviewRows) {
    const point = parseTuplePoint(row);
    if (point) visitsByT.set(point.t, point.count);
  }
  const uniquesByT = new Map<string, number>();
  for (const row of visitorRows) {
    const point = parseTuplePoint(row);
    if (point) uniquesByT.set(point.t, point.count);
  }
  const allBuckets = new Set<string>([...visitsByT.keys(), ...uniquesByT.keys()]);
  return [...allBuckets].map((t) => ({ t, visits: visitsByT.get(t) ?? 0, uniques: uniquesByT.get(t) ?? 0 }));
};

/** One `/ranking/<dimension>` row: `{count, resource, country_name?}`. Dimension-agnostic — `pages`/`sources`/`not_found`/`countries` all share this shape. */
interface RankingRowV2 {
  count: number;
  resource: string;
  countryName?: string;
}

/** Parses a `/ranking/<dimension>` payload's `data` array. A row missing a numeric `count` is dropped, not thrown on; `resource` defaults to `''` (renders as "Direct"/"(unknown page)" via the label normalizers, never as a literal empty string). */
const parseRankingRowsV2 = (payload: unknown): RankingRowV2[] =>
  extractDataArray(payload)
    .map((row): RankingRowV2 | undefined => {
      if (!row || typeof row !== 'object') return undefined;
      const r = row as Record<string, unknown>;
      if (typeof r.count !== 'number' || !Number.isFinite(r.count)) return undefined;
      return {
        count: r.count,
        resource: typeof r.resource === 'string' ? r.resource : '',
        countryName: typeof r.country_name === 'string' ? r.country_name : undefined,
      };
    })
    .filter((row): row is RankingRowV2 => Boolean(row));

const windowQuery = (window: NetlifyAnalyticsWindow): string =>
  `from=${Math.round(window.from)}&to=${Math.round(window.to)}&timezone=${encodeURIComponent(ANALYTICS_TIMEZONE_OFFSET)}&resolution=${window.resolution}`;

const rankingQuery = (window: NetlifyAnalyticsWindow): string =>
  `from=${Math.round(window.from)}&to=${Math.round(window.to)}&limit=${RANKING_LIMIT}`;

/**
 * Fetches and normalizes one window of traffic data. `/pageviews` goes
 * first and alone — it is the cheapest signal for "does this tenant have
 * Analytics at all" and lets a not-enabled tenant fail in one round trip
 * instead of four. `/visitors` and the two ranking calls (top pages, top
 * sources) then run in parallel and degrade independently to an empty
 * result on their own failure (a plan tier that has pageviews but not one
 * of these, or a transient error on one of the three) rather than failing
 * the whole dashboard for a partial result.
 */
export const fetchTrafficAnalytics = async (window: NetlifyAnalyticsWindow): Promise<RawAnalyticsData> => {
  const trendQs = windowQuery(window);
  const rankingQs = rankingQuery(window);

  const pageviewsPayload = await fetchNetlifyAnalyticsApi(`/pageviews?${trendQs}`);

  const [visitorsPayload, pagesPayload, sourcesPayload] = await Promise.all([
    fetchNetlifyAnalyticsApi(`/visitors?${trendQs}`).catch(() => null),
    fetchNetlifyAnalyticsApi(`/ranking/pages?${rankingQs}`).catch(() => null),
    fetchNetlifyAnalyticsApi(`/ranking/sources?${rankingQs}`).catch(() => null),
  ]);

  const trend = buildTrend(extractDataArray(pageviewsPayload), extractDataArray(visitorsPayload));

  const toRankingRow = (row: RankingRowV2, label: (resource: string) => string): AnalyticsRankingRow => ({
    label: label(row.resource),
    visits: row.count,
  });
  const topPaths = parseRankingRowsV2(pagesPayload).map((row) => toRankingRow(row, normalizePathLabel));
  const topSources = parseRankingRowsV2(sourcesPayload).map((row) => toRankingRow(row, normalizeSourceLabel));

  return { trend, topPaths, topSources };
};
