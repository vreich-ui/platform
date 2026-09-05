/**
 * Analytics dashboard client (T4.1; renamed from traffic-client, T21.9b) — browser wrapper over `admin-analytics`.
 * Same house pattern as `release-client.ts`: Identity bearer, typed result,
 * errors thrown with the server's human message.
 *
 * A small in-memory TTL cache, keyed by the resolved range (mirrors
 * `library-client.ts`'s in-flight de-dupe, scaled down to "one entry per
 * range" since a viewer flips between a handful of ranges, not one list).
 * This is on top of, not instead of, the server's own `Cache-Control`/`ETag`
 * — it saves the round trip entirely for a range already fetched this page
 * load (e.g. flipping 30d → 7d → 30d), where the server cache would still
 * cost a request even on a 304.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { AnalyticsRangeKey, AnalyticsOverview } from './analytics-logic.js';

/** Re-exported for existing importers — the shape itself now lives in `analytics-logic.ts` (R6.1's panel resolver is pure and needs it without this module's I/O). */
export type { AnalyticsErrorCode, AnalyticsOverview } from './analytics-logic.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

export interface FetchAnalyticsOptions {
  range: AnalyticsRangeKey;
  custom?: { from: string; to: string };
  force?: boolean;
}

/** Cache window: short — analytics pages are usually open-and-glance, not open-and-monitor. */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  overview: AnalyticsOverview;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<AnalyticsOverview>>();

const cacheKeyFor = (opts: FetchAnalyticsOptions): string =>
  opts.range === 'custom' ? `custom:${opts.custom?.from ?? ''}:${opts.custom?.to ?? ''}` : opts.range;

const buildQuery = (opts: FetchAnalyticsOptions): string => {
  const params = new URLSearchParams({ range: opts.range });
  if (opts.range === 'custom' && opts.custom) {
    params.set('from', opts.custom.from);
    params.set('to', opts.custom.to);
  }
  return params.toString();
};

async function requestAnalytics(getToken: GetToken, opts: FetchAnalyticsOptions): Promise<AnalyticsOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${buildQuery(opts)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as AnalyticsOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Analytics data request failed (${response.status}).`);
  return body;
}

export async function fetchAnalyticsOverview(
  getToken: GetToken,
  opts: FetchAnalyticsOptions
): Promise<AnalyticsOverview> {
  const key = cacheKeyFor(opts);

  if (!opts.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.overview;
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const thisFetch = requestAnalytics(getToken, opts).then((overview) => {
    cache.set(key, { overview, fetchedAt: Date.now() });
    return overview;
  });
  inflight.set(key, thisFetch);
  thisFetch.finally(() => {
    if (inflight.get(key) === thisFetch) inflight.delete(key);
  });
  return thisFetch;
}

export function invalidateAnalyticsCache(): void {
  cache.clear();
  inflight.clear();
}
