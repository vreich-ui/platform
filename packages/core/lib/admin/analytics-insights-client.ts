/**
 * Analytics insights client (T21.36; runner R11.5) — browser wrapper over
 * `admin-analytics?source=insights`. Same house pattern as
 * `own-analytics-client.ts`'s `fetchAnalyticsObjectIdentity`: a plain GET,
 * no range/window/filters (this tab does not share the KPI-strip/chart
 * window the other two tabs do — every row carries its own evidence window
 * instead), a small in-memory TTL cache so a tab-switch back doesn't refetch
 * instantly, and the SAME `Authorization: Bearer` + JSON-envelope handling
 * every other analytics client here uses.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { InsightsOverview } from './analytics-insights-logic.js';
import { currentPageSignal } from './page-generation.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';
const CACHE_TTL_MS = 60_000;

let cache: { overview: InsightsOverview; fetchedAt: number } | null = null;
let inflight: Promise<InsightsOverview> | null = null;

async function requestInsightsOverview(getToken: GetToken): Promise<InsightsOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ source: 'insights' }).toString()}`, {
    headers: { Authorization: `Bearer ${token}` },
    // T1.1: a plain page-load read, no cross-navigation store — always rides
    // the current page-generation signal.
    signal: currentPageSignal(),
  });
  const body = (await response.json().catch(() => ({}))) as InsightsOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Insights request failed (${response.status}).`);
  return body;
}

export async function fetchAnalyticsInsightsOverview(
  getToken: GetToken,
  opts?: { force?: boolean }
): Promise<InsightsOverview> {
  if (!opts?.force) {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.overview;
    if (inflight) return inflight;
  }

  const thisFetch = requestInsightsOverview(getToken).then((overview) => {
    cache = { overview, fetchedAt: Date.now() };
    return overview;
  });
  inflight = thisFetch;
  thisFetch.finally(() => {
    if (inflight === thisFetch) inflight = null;
  });
  return thisFetch;
}

export function invalidateAnalyticsInsightsCache(): void {
  cache = null;
  inflight = null;
}
