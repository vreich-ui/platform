/**
 * Traffic dashboard client (T4.1) — browser wrapper over `admin-traffic`.
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
import type { TrafficChartSeries, TrafficRangeKey, TrafficDateWindow } from './traffic-logic.js';

const ENDPOINT = '/.netlify/functions/admin-traffic';

/** Mirrors the server's catalogued degrade states (`admin-traffic.ts`) — never a generic string the UI has to pattern-match. */
export type TrafficErrorCode = 'analytics_lookup_unconfigured' | 'analytics_not_enabled';

export interface TrafficOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: TrafficErrorCode;
  message?: string;
  range: TrafficRangeKey;
  window?: TrafficDateWindow;
  series?: TrafficChartSeries;
}

export interface FetchTrafficOptions {
  range: TrafficRangeKey;
  custom?: { from: string; to: string };
  force?: boolean;
}

/** Cache window: short — traffic pages are usually open-and-glance, not open-and-monitor. */
const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  overview: TrafficOverview;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<TrafficOverview>>();

const cacheKeyFor = (opts: FetchTrafficOptions): string =>
  opts.range === 'custom' ? `custom:${opts.custom?.from ?? ''}:${opts.custom?.to ?? ''}` : opts.range;

const buildQuery = (opts: FetchTrafficOptions): string => {
  const params = new URLSearchParams({ range: opts.range });
  if (opts.range === 'custom' && opts.custom) {
    params.set('from', opts.custom.from);
    params.set('to', opts.custom.to);
  }
  return params.toString();
};

async function requestTraffic(getToken: GetToken, opts: FetchTrafficOptions): Promise<TrafficOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${buildQuery(opts)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as TrafficOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Traffic data request failed (${response.status}).`);
  return body;
}

export async function fetchTrafficOverview(getToken: GetToken, opts: FetchTrafficOptions): Promise<TrafficOverview> {
  const key = cacheKeyFor(opts);

  if (!opts.force) {
    const cached = cache.get(key);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.overview;
    const existing = inflight.get(key);
    if (existing) return existing;
  }

  const thisFetch = requestTraffic(getToken, opts).then((overview) => {
    cache.set(key, { overview, fetchedAt: Date.now() });
    return overview;
  });
  inflight.set(key, thisFetch);
  thisFetch.finally(() => {
    if (inflight.get(key) === thisFetch) inflight.delete(key);
  });
  return thisFetch;
}

export function invalidateTrafficCache(): void {
  cache.clear();
  inflight.clear();
}
