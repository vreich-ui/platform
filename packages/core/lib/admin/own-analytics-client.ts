/**
 * Own-tracker analytics client (T21.2b; admin-traffic renamed admin-analytics, T21.9b) — browser wrapper over
 * `admin-analytics?source=own`. Same house pattern as `analytics-client.ts`
 * (Identity bearer, typed result, small in-memory TTL cache keyed by the
 * resolved window) — a SEPARATE cache from the Netlify one since the two
 * feeds are fetched and displayed independently.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { OwnTrackerDays, OwnAnalyticsOverview } from './own-analytics-logic.js';

/** Re-exported for existing importers — the shape itself now lives in `own-analytics-logic.ts` (R6.1's panel resolver is pure and needs it without this module's I/O). */
export type { OwnAnalyticsErrorCode, OwnAnalyticsOverview } from './own-analytics-logic.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

export interface FetchOwnAnalyticsOptions {
  days: OwnTrackerDays;
  force?: boolean;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  overview: OwnAnalyticsOverview;
  fetchedAt: number;
}

const cache = new Map<OwnTrackerDays, CacheEntry>();
const inflight = new Map<OwnTrackerDays, Promise<OwnAnalyticsOverview>>();

async function requestOwnAnalytics(getToken: GetToken, days: OwnTrackerDays): Promise<OwnAnalyticsOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ source: 'own', days: String(days) })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as OwnAnalyticsOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Own-tracker analytics request failed (${response.status}).`);
  return body;
}

export async function fetchOwnAnalyticsOverview(
  getToken: GetToken,
  opts: FetchOwnAnalyticsOptions
): Promise<OwnAnalyticsOverview> {
  if (!opts.force) {
    const cached = cache.get(opts.days);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.overview;
    const existing = inflight.get(opts.days);
    if (existing) return existing;
  }

  const thisFetch = requestOwnAnalytics(getToken, opts.days).then((overview) => {
    cache.set(opts.days, { overview, fetchedAt: Date.now() });
    return overview;
  });
  inflight.set(opts.days, thisFetch);
  thisFetch.finally(() => {
    if (inflight.get(opts.days) === thisFetch) inflight.delete(opts.days);
  });
  return thisFetch;
}

export function invalidateOwnAnalyticsCache(): void {
  cache.clear();
  inflight.clear();
}
