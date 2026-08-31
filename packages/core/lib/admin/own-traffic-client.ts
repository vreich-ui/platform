/**
 * Own-tracker traffic client (T21.2b) — browser wrapper over
 * `admin-traffic?source=own`. Same house pattern as `traffic-client.ts`
 * (Identity bearer, typed result, small in-memory TTL cache keyed by the
 * resolved window) — a SEPARATE cache from the Netlify one since the two
 * feeds are fetched and displayed independently.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { OwnTrackerDays, OwnTrackerStatsPayload } from './own-traffic-logic.js';

const ENDPOINT = '/.netlify/functions/admin-traffic';

export type OwnTrafficErrorCode = 'own_tracker_unconfigured';

export interface OwnTrafficOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: OwnTrafficErrorCode;
  message?: string;
  days: OwnTrackerDays;
  stats?: OwnTrackerStatsPayload;
}

export interface FetchOwnTrafficOptions {
  days: OwnTrackerDays;
  force?: boolean;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  overview: OwnTrafficOverview;
  fetchedAt: number;
}

const cache = new Map<OwnTrackerDays, CacheEntry>();
const inflight = new Map<OwnTrackerDays, Promise<OwnTrafficOverview>>();

async function requestOwnTraffic(getToken: GetToken, days: OwnTrackerDays): Promise<OwnTrafficOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ source: 'own', days: String(days) })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as OwnTrafficOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Own-tracker traffic request failed (${response.status}).`);
  return body;
}

export async function fetchOwnTrafficOverview(
  getToken: GetToken,
  opts: FetchOwnTrafficOptions
): Promise<OwnTrafficOverview> {
  if (!opts.force) {
    const cached = cache.get(opts.days);
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.overview;
    const existing = inflight.get(opts.days);
    if (existing) return existing;
  }

  const thisFetch = requestOwnTraffic(getToken, opts.days).then((overview) => {
    cache.set(opts.days, { overview, fetchedAt: Date.now() });
    return overview;
  });
  inflight.set(opts.days, thisFetch);
  thisFetch.finally(() => {
    if (inflight.get(opts.days) === thisFetch) inflight.delete(opts.days);
  });
  return thisFetch;
}

export function invalidateOwnTrafficCache(): void {
  cache.clear();
  inflight.clear();
}
