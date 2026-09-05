/**
 * Own-tracker stats fetch (T21.2b) — `admin-analytics`'s second data source,
 * a first-party proxy over the same TRACKING_SINK_URL/TRACKING_PROJECT_ID
 * pair `commerce-events.ts`/`member-link.ts` already forward events to
 * (fleet-shared + per-site env, already in the T11.7 table and
 * `fleet-capability-probe.mjs` — no new env var, so no new P2 obligation).
 *
 * The `/stats` endpoint itself is being built in parallel in the kugel-data
 * repo; this module codes against the pinned contract
 * (`OwnTrackerStatsPayload`, `lib/admin/own-analytics-logic.ts`) but does not
 * validate it strictly, matching `netlify-analytics.ts`'s posture toward a
 * still-moving, externally-owned response shape: degrade a missing field to
 * a safe default rather than throw.
 *
 * Env NAMES only ever appear in code/logs/tests here — never a literal
 * TRACKING_SINK_URL value or TRACKING_SINK_TOKEN.
 */
import type { OwnTrackerDays, OwnTrackerStatsPayload } from '../../lib/admin/own-analytics-logic.js';

/** An admin dashboard read, not a fire-and-forget event write — longer than
 *  the 2s used for best-effort sends elsewhere, still bounded. */
const STATS_TIMEOUT_MS = 8_000;

export type OwnTrackerEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'TRACKING_SINK_URL' | 'TRACKING_PROJECT_ID' | 'TRACKING_SINK_TOKEN'>
>;

const readEnv = (env: OwnTrackerEnv) => ({
  sinkUrl: env.TRACKING_SINK_URL?.trim() || '',
  projectId: env.TRACKING_PROJECT_ID?.trim() || '',
  token: env.TRACKING_SINK_TOKEN?.trim() || '',
});

/** Same predicate shape as `netlifyDeployLookupMissingEnvVars` — env NAMES only. */
export const ownTrackerMissingEnvVars = (env: OwnTrackerEnv = process.env): string[] => {
  const { sinkUrl, projectId } = readEnv(env);
  return [...(sinkUrl ? [] : ['TRACKING_SINK_URL']), ...(projectId ? [] : ['TRACKING_PROJECT_ID'])];
};

export const isOwnTrackerConfigured = (env: OwnTrackerEnv = process.env): boolean =>
  ownTrackerMissingEnvVars(env).length === 0;

const statsEndpoint = (sinkUrl: string, projectId: string, days: OwnTrackerDays): string =>
  `${sinkUrl.replace(/\/+$/, '')}/stats?project_id=${encodeURIComponent(projectId)}&days=${days}`;

export interface FetchOwnTrackerStatsOptions {
  env?: OwnTrackerEnv;
  fetchImpl?: typeof fetch;
}

/**
 * Throws when the sink cannot be reached or returns a non-2xx — the caller
 * (`admin-analytics.ts`) treats that as a real 500, the same posture the
 * Netlify branch takes for an unexpected failure (this proxy has no
 * per-tenant "not enabled" gap to distinguish, unlike the paid Analytics
 * add-on — configured or not is the only two-state split here).
 */
export const fetchOwnTrackerStats = async (
  days: OwnTrackerDays,
  options: FetchOwnTrackerStatsOptions = {}
): Promise<OwnTrackerStatsPayload> => {
  const env = options.env ?? process.env;
  const { sinkUrl, projectId, token } = readEnv(env);
  if (!sinkUrl || !projectId) throw new Error('Own-tracker sink is not configured.');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await (options.fetchImpl ?? fetch)(statsEndpoint(sinkUrl, projectId, days), {
    headers,
    signal: AbortSignal.timeout(STATS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Own-tracker stats request failed with HTTP ${response.status}.`);
  return (await response.json()) as OwnTrackerStatsPayload;
};
