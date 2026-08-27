/**
 * Netlify Analytics (T4.1) — the traffic dashboard's data source, per Wolf's
 * gate answer G1 (Netlify Analytics, not GA4/Plausible/Supermetrics).
 *
 * Netlify Analytics is a **paid per-site add-on** with a **private,
 * undocumented** API (`https://api.netlify.com/api/v1/sites/{site_id}/analytics/*`
 * — there is no published OpenAPI/reference for it, unlike the deploys API
 * `netlify-deploys.ts` already calls). Two consequences follow:
 *
 *  1. **Credentials are reused, not new.** The Analytics endpoints live under
 *     the same site and accept the same personal-access token as the deploy
 *     lookup already wired in this repo (`admin-release-state.ts` →
 *     `netlify-deploys.ts`) — `NETLIFY_SITE_ID`/`SITE_ID` for the site id,
 *     `NETLIFY_AUTH_TOKEN`/`NETLIFY_BLOBS_TOKEN` for the token
 *     (`PLATFORM_ENV_NAMES.blobSiteId` / `.deployLookupToken`,
 *     `site-binding.ts`). There is nothing new to configure, so this
 *     deliberately reuses `netlifyDeployLookupMissingEnvVars` rather than
 *     declaring a new env var or capability family — fleet law P2 ("any new
 *     env var lands in the T11.7 table + ENV_CHECKLIST + every site's env")
 *     does not apply here because there IS no new env var.
 *  2. **A configured token does not mean Analytics is ENABLED.** Analytics is
 *     a separate purchase from Netlify Blobs/Deploys/Functions access, so a
 *     site with perfectly valid deploy-lookup credentials can still have no
 *     Analytics add-on. That is a per-tenant plan gap, not a missing-env-var
 *     gap — the capability probe's env→family model has nothing to check
 *     (the vars ARE all present). It can only be discovered by calling the
 *     API and reading the response, which is what
 *     `NetlifyAnalyticsNotEnabledError` exists to distinguish from "not
 *     configured at all" (`isNetlifyAnalyticsLookupConfigured() === false`).
 *     `admin-traffic.ts` renders each of those two states with its own
 *     honest, catalogued `error_code` — never a broken page.
 *
 * Because the response shape is undocumented, every parser below reads
 * several plausible field-name spellings and falls back to a safe default
 * rather than throwing on an unexpected shape — the same posture
 * `netlify-deploys.ts`'s `mapNetlifyDeployToReceipt`/`normalizeDeployStatus`
 * already take toward Netlify's (documented, but still loosely-typed) deploy
 * JSON. This module is intentionally NOT unit-tested directly (no test file
 * exists for `netlify-deploys.ts` either, for the same reason: it is I/O
 * against a shape this repo cannot pin down without a live, Analytics-
 * enabled site to record a fixture from). The pure last-mile transform this
 * module hands off to — `mapAnalyticsToChartSeries` in
 * `lib/admin/traffic-logic.ts` — IS unit-tested, against the normalized
 * intermediate shape this module produces.
 */
import { PLATFORM_ENV_NAMES, readBoundEnv, type SiteBindingEnvNames } from './site-binding.js';
import { netlifyDeployLookupMissingEnvVars } from './netlify-deploys.js';
import {
  normalizePathLabel,
  normalizeSourceLabel,
  type RawTrafficAnalytics,
  type TrafficRankingRow,
  type TrafficTrendPoint,
} from '../../lib/admin/traffic-logic.js';

const NETLIFY_API_BASE_URL = 'https://api.netlify.com/api/v1';

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

const toStringValue = (value: unknown): string => (typeof value === 'string' ? value : '');
const toNumberValue = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

const fetchNetlifyAnalyticsApi = async (path: string): Promise<unknown> => {
  const { siteId, token } = getNetlifyAnalyticsConfig();
  if (!siteId || !token) throw new Error('Netlify Analytics lookup is not configured.');

  const response = await fetch(`${NETLIFY_API_BASE_URL}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });

  // The private Analytics surface can reject an un-entitled site at any of
  // three layers depending on how Netlify's own gateway is set up for it —
  // plain auth (401), an authenticated-but-not-entitled account (403), or a
  // route that simply does not exist for a site with no Analytics package
  // (404). All three mean the same thing from here: no Analytics for this
  // site, not a real fault.
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    throw new NetlifyAnalyticsNotEnabledError();
  }
  if (!response.ok) {
    throw new Error(`Netlify Analytics lookup failed with HTTP ${response.status}.`);
  }
  return response.json() as Promise<unknown>;
};

/** The pageviews endpoint's rows are known (from field-level reverse-engineering, since there is no spec) to use one of a few field-name spellings for the bucket timestamp and the counts. */
const parseTrendPoint = (row: unknown): TrafficTrendPoint | undefined => {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  const rawDate = r.date ?? r.timestamp ?? r.ts ?? r.bucket;
  const t =
    typeof rawDate === 'number'
      ? new Date(rawDate).toISOString()
      : typeof rawDate === 'string' && rawDate
        ? rawDate
        : undefined;
  if (!t) return undefined;

  const visits = toNumberValue(r.count ?? r.pageviews ?? r.visits ?? r.value);
  const uniques = toNumberValue(r.visitors ?? r.uniques ?? r.unique_visitors ?? r.uniqueVisitors ?? visits);
  return { t, visits, uniques };
};

const parseRankingRow = (
  row: unknown,
  resolveLabel: (fields: Record<string, unknown>) => string
): TrafficRankingRow | undefined => {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  return { label: resolveLabel(r), visits: toNumberValue(r.count ?? r.pageviews ?? r.visits ?? r.value) };
};

/** Netlify's dashboard XHRs for this API wrap rows in `{data: [...]}` on some calls and return a bare array on others — accept both. */
const extractRows = (payload: unknown): unknown[] => {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') {
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.data)) return p.data;
    if (Array.isArray(p.resources)) return p.resources;
  }
  return [];
};

const windowQuery = (window: NetlifyAnalyticsWindow): string =>
  `from=${Math.round(window.from)}&to=${Math.round(window.to)}&resolution=${window.resolution}`;

/**
 * Fetches and normalizes one window of traffic data. The pageviews call goes
 * first and alone — it is the cheapest signal for "does this tenant have
 * Analytics at all" and lets a not-enabled tenant fail in one round trip
 * instead of three. The two ranking calls (top pages, top sources) run in
 * parallel after that and degrade independently to an empty list on their
 * own failure (a plan tier that has pageviews but not the ranking endpoint,
 * or a transient error on one of the two) rather than failing the whole
 * dashboard for a partial result.
 */
export const fetchTrafficAnalytics = async (window: NetlifyAnalyticsWindow): Promise<RawTrafficAnalytics> => {
  const { siteId } = getNetlifyAnalyticsConfig();
  const qs = windowQuery(window);

  const pageviewsPayload = await fetchNetlifyAnalyticsApi(
    `/sites/${encodeURIComponent(siteId)}/analytics/pageviews?${qs}`
  );
  const trend = extractRows(pageviewsPayload)
    .map(parseTrendPoint)
    .filter((point): point is TrafficTrendPoint => Boolean(point));

  const [pathsPayload, sourcesPayload] = await Promise.all([
    fetchNetlifyAnalyticsApi(
      `/sites/${encodeURIComponent(siteId)}/analytics/ranking?${qs}&association_key=path&value_key=pageviews&per_page=20`
    ).catch(() => null),
    fetchNetlifyAnalyticsApi(
      `/sites/${encodeURIComponent(siteId)}/analytics/ranking?${qs}&association_key=referrer&value_key=pageviews&per_page=20`
    ).catch(() => null),
  ]);

  const topPaths = extractRows(pathsPayload)
    .map((row) =>
      parseRankingRow(row, (fields) => normalizePathLabel(toStringValue(fields.resource ?? fields.path ?? fields.id)))
    )
    .filter((row): row is TrafficRankingRow => Boolean(row));
  const topSources = extractRows(sourcesPayload)
    .map((row) =>
      parseRankingRow(row, (fields) =>
        normalizeSourceLabel(toStringValue(fields.resource ?? fields.referrer ?? fields.id))
      )
    )
    .filter((row): row is TrafficRankingRow => Boolean(row));

  return { trend, topPaths, topSources };
};
