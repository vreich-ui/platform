/**
 * Arm-metrics client (T21.6b / R4b) — browser wrapper over
 * `admin-analytics?source=arm_metrics`. Same house pattern as
 * `own-analytics-client.ts` (Identity bearer, typed result, a small
 * in-memory TTL cache) — a SEPARATE cache from the other two feeds since all
 * three are fetched and displayed independently. Fetched ONCE for the whole
 * `/admin/variants` page; `familyArmMetrics` (in `variant-arm-metrics.ts`)
 * slices the result per family.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { ArmMetricsOverview } from './variant-arm-metrics.js';

export type { ArmMetricsOverview } from './variant-arm-metrics.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';
const CACHE_TTL_MS = 60_000;

let cache: { overview: ArmMetricsOverview; fetchedAt: number } | undefined;
let inflight: Promise<ArmMetricsOverview> | undefined;

async function requestArmMetrics(getToken: GetToken): Promise<ArmMetricsOverview> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${new URLSearchParams({ source: 'arm_metrics' })}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = (await response.json().catch(() => ({}))) as ArmMetricsOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Arm metrics request failed (${response.status}).`);
  return body;
}

export async function fetchArmMetricsOverview(
  getToken: GetToken,
  options: { force?: boolean } = {}
): Promise<ArmMetricsOverview> {
  if (!options.force) {
    if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.overview;
    if (inflight) return inflight;
  }

  const thisFetch = requestArmMetrics(getToken).then((overview) => {
    cache = { overview, fetchedAt: Date.now() };
    return overview;
  });
  inflight = thisFetch;
  thisFetch.finally(() => {
    if (inflight === thisFetch) inflight = undefined;
  });
  return thisFetch;
}

export function invalidateArmMetricsCache(): void {
  cache = undefined;
  inflight = undefined;
}
