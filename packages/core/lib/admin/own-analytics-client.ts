/**
 * Own-tracker analytics client (T21.2b; admin-traffic renamed admin-analytics,
 * T21.9b; R6.2 data points, T21.24) — browser wrapper over
 * `admin-analytics?source=own`. Same house pattern as `analytics-client.ts`
 * (Identity bearer, typed result, small in-memory TTL cache keyed by the
 * resolved window+filters) — a SEPARATE cache from the Netlify one since the
 * two feeds are fetched and displayed independently.
 *
 * R6.2 swaps the old `{days: 7|30}` option for the SAME `{range, custom}`
 * shape `analytics-client.ts` already used for Netlify, plus the D7 filter
 * set — the own tab now rides the one shared range picker/filter state
 * instead of a bespoke day-count.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { AnalyticsRangeKey, AnalyticsFilters } from './analytics-logic.js';
import type { OwnAnalyticsOverview } from './own-analytics-logic.js';
import { currentPageSignal } from './page-generation.js';

/** Re-exported for existing importers — the shape itself now lives in `own-analytics-logic.ts` (the panel resolver is pure and needs it without this module's I/O). */
export type { OwnAnalyticsErrorCode, OwnAnalyticsOverview } from './own-analytics-logic.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

export interface FetchOwnAnalyticsOptions {
  range: AnalyticsRangeKey;
  custom?: { from: string; to: string };
  filters?: AnalyticsFilters;
  force?: boolean;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  overview: OwnAnalyticsOverview;
  fetchedAt: number;
}

const cacheKeyFor = (opts: FetchOwnAnalyticsOptions): string => {
  const rangePart = opts.range === 'custom' ? `custom:${opts.custom?.from ?? ''}:${opts.custom?.to ?? ''}` : opts.range;
  const f = opts.filters;
  return `${rangePart}|${f?.country ?? ''}|${f?.source ?? ''}|${f?.object_id ?? ''}`;
};

const buildQuery = (opts: FetchOwnAnalyticsOptions): string => {
  const params = new URLSearchParams({ source: 'own', range: opts.range });
  if (opts.range === 'custom' && opts.custom) {
    params.set('from', opts.custom.from);
    params.set('to', opts.custom.to);
  }
  if (opts.filters?.country) params.set('country', opts.filters.country);
  if (opts.filters?.source) params.set('fsource', opts.filters.source);
  if (opts.filters?.object_id) params.set('object', opts.filters.object_id);
  return params.toString();
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<OwnAnalyticsOverview>>();

async function requestOwnAnalytics(getToken: GetToken, opts: FetchOwnAnalyticsOptions): Promise<OwnAnalyticsOverview> {
  const token = await getToken();
  // T1.1: a plain page-load read, no cross-navigation store — always rides
  // the current page-generation signal.
  const response = await fetch(`${ENDPOINT}?${buildQuery(opts)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: currentPageSignal(),
  });
  const body = (await response.json().catch(() => ({}))) as OwnAnalyticsOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Own-tracker analytics request failed (${response.status}).`);
  return body;
}

export async function fetchOwnAnalyticsOverview(
  getToken: GetToken,
  opts: FetchOwnAnalyticsOptions
): Promise<OwnAnalyticsOverview> {
  const key = cacheKeyFor(opts);

  if (!opts.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.overview;
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const thisFetch = requestOwnAnalytics(getToken, opts).then((overview) => {
    cache.set(key, { overview, fetchedAt: Date.now() });
    return overview;
  });
  inflight.set(key, thisFetch);
  thisFetch.finally(() => {
    if (inflight.get(key) === thisFetch) inflight.delete(key);
  });
  return thisFetch;
}

// ─── R11.4 (T21.30): object drill-down identity + producer ──────────────────

export interface AnalyticsObjectIdentityResult {
  identity: { objectId: string; found: boolean; title: string; route: string | null; objectType: string };
  producer: { surface: string | null; promptVersion: string | null } | null;
}

/**
 * `?resource=object_identity` — store-backed (D6 export directory + the
 * object's own publish receipt), never dependent on the tracking sink, so
 * this always answers even before the sink deploys the `object` block the
 * drill-down's other panels need.
 */
export async function fetchAnalyticsObjectIdentity(
  getToken: GetToken,
  objectId: string
): Promise<AnalyticsObjectIdentityResult> {
  const token = await getToken();
  const response = await fetch(
    `${ENDPOINT}?${new URLSearchParams({ resource: 'object_identity', id: objectId }).toString()}`,
    { headers: { Authorization: `Bearer ${token}` }, signal: currentPageSignal() }
  );
  const body = (await response.json().catch(() => ({}))) as AnalyticsObjectIdentityResult & { error?: string };
  if (!response.ok) throw new Error(body.error || `Object identity request failed (${response.status}).`);
  return body;
}

export function invalidateOwnAnalyticsCache(): void {
  cache.clear();
  inflight.clear();
}
