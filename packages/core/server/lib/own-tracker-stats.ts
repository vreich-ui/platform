/**
 * Own-tracker stats fetch (T21.2b; R6.2 data points, T21.24) —
 * `admin-analytics`'s second data source, a first-party proxy over the same
 * TRACKING_SINK_URL/TRACKING_PROJECT_ID pair `commerce-events.ts`/
 * `member-link.ts` already forward events to (fleet-shared + per-site env,
 * already in the T11.7 table and `fleet-capability-probe.mjs` — no new env
 * var, so no new P2 obligation).
 *
 * R6.2 replaces the old `?days=7|30` query with `from`/`to` (ISO window
 * bounds, from the SAME `resolveDateWindow` the Netlify branch already uses)
 * plus the D7 filter params (`country`/`source`/`object_id`) and
 * `exclude_test` (default on — R7.3's `x-trk-test` header already excludes
 * test traffic at ingest; this asks the read side to honor the same flag).
 * This is what lets the range picker serve 90d/custom on the own tab (D10).
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
import type { OwnTrackerStatsPayload } from '../../lib/admin/own-analytics-logic.js';

/** An admin dashboard read, not a fire-and-forget event write — longer than
 *  the 2s used for best-effort sends elsewhere, still bounded. */
const STATS_TIMEOUT_MS = 8_000;

/** A raw event pull can be a lot more rows than one `/stats` aggregate — a longer bound, still finite. */
const EXPORT_TIMEOUT_MS = 25_000;

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

/** ISO window bounds — the same shape `resolveDateWindow` in `analytics-logic.ts` produces (converted from epoch ms to ISO by the caller). */
export interface OwnTrackerStatsWindow {
  from: string;
  to: string;
}

/** D7 — the three dimensions the sink accepts as filters, all optional/combinable. */
export interface OwnTrackerStatsFilters {
  country?: string;
  source?: string;
  object_id?: string;
}

const statsEndpoint = (
  sinkUrl: string,
  projectId: string,
  window: OwnTrackerStatsWindow,
  filters: OwnTrackerStatsFilters,
  excludeTest: boolean
): string => {
  const params = new URLSearchParams({ project_id: projectId, from: window.from, to: window.to });
  if (excludeTest) params.set('exclude_test', '1');
  if (filters.country) params.set('country', filters.country);
  if (filters.source) params.set('source', filters.source);
  if (filters.object_id) params.set('object_id', filters.object_id);
  return `${sinkUrl.replace(/\/+$/, '')}/stats?${params.toString()}`;
};

export interface FetchOwnTrackerStatsOptions {
  env?: OwnTrackerEnv;
  fetchImpl?: typeof fetch;
  filters?: OwnTrackerStatsFilters;
  /** D8 — default true. Test traffic (R7.3's `x-trk-test` header) is already excluded at ingest; this is the read-side flag the sink contract names. */
  excludeTest?: boolean;
}

/**
 * Throws when the sink cannot be reached or returns a non-2xx — the caller
 * (`admin-analytics.ts`) treats that as a real 500, the same posture the
 * Netlify branch takes for an unexpected failure (this proxy has no
 * per-tenant "not enabled" gap to distinguish, unlike the paid Analytics
 * add-on — configured or not is the only two-state split here).
 */
export const fetchOwnTrackerStats = async (
  window: OwnTrackerStatsWindow,
  options: FetchOwnTrackerStatsOptions = {}
): Promise<OwnTrackerStatsPayload> => {
  const env = options.env ?? process.env;
  const { sinkUrl, projectId, token } = readEnv(env);
  if (!sinkUrl || !projectId) throw new Error('Own-tracker sink is not configured.');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await (options.fetchImpl ?? fetch)(
    statsEndpoint(sinkUrl, projectId, window, options.filters ?? {}, options.excludeTest ?? true),
    { headers, signal: AbortSignal.timeout(STATS_TIMEOUT_MS) }
  );
  if (!response.ok) throw new Error(`Own-tracker stats request failed with HTTP ${response.status}.`);
  return (await response.json()) as OwnTrackerStatsPayload;
};

// ─── R11.2 (T21.28) — raw event export ──────────────────────────────────────
//
// A second, distinct sink endpoint from `/stats`: `GET /api/tracking-sink/
// export?project_id&from&to&kind=events|commerce|dims`, Bearer-authenticated,
// NDJSON, one row per event/commerce-event/dim-fact in the window. This
// module is the ONLY place the Bearer token is ever attached to a request —
// `admin-analytics.ts`'s `resource=raw_export` branch calls this and returns
// only the resulting NDJSON body (or a named degrade) to the browser, so the
// token itself never crosses the wire to the client.
//
// The endpoint "may not exist yet" per spec: a 404 (or the whole sink being
// unconfigured) degrades to `{available: false, errorCode, message}`, never
// a thrown error — `admin-analytics.ts` turns that into a clear "not
// available on this sink yet" state rather than a broken download.

export type OwnTrackerExportKind = 'events' | 'commerce' | 'dims';

export interface OwnTrackerExportOptions {
  env?: OwnTrackerEnv;
  fetchImpl?: typeof fetch;
  kind: OwnTrackerExportKind;
  /** ISO window bounds, same convention as `fetchOwnTrackerStats`. */
  from: string;
  to: string;
}

export type OwnTrackerExportResult =
  | { available: true; ndjson: string }
  | { available: false; errorCode: string; message: string; status?: number };

const exportEndpoint = (sinkUrl: string, projectId: string, options: OwnTrackerExportOptions): string => {
  const params = new URLSearchParams({
    project_id: projectId,
    from: options.from,
    to: options.to,
    kind: options.kind,
  });
  return `${sinkUrl.replace(/\/+$/, '')}/api/tracking-sink/export?${params.toString()}`;
};

/**
 * Never throws — every failure mode (unconfigured, unreachable, 404 "this
 * sink doesn't have the endpoint yet", any other non-2xx) comes back as a
 * `{available: false, ...}` result the caller renders as a named state.
 */
export const fetchOwnTrackerRawExport = async (options: OwnTrackerExportOptions): Promise<OwnTrackerExportResult> => {
  const env = options.env ?? process.env;
  const { sinkUrl, projectId, token } = readEnv(env);
  if (!sinkUrl || !projectId) {
    return {
      available: false,
      errorCode: 'own_tracker_unconfigured',
      message: 'The own-tracker sink is not configured for this site.',
    };
  }

  const headers: Record<string, string> = { Accept: 'application/x-ndjson' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let response: Response;
  try {
    response = await (options.fetchImpl ?? fetch)(exportEndpoint(sinkUrl, projectId, options), {
      headers,
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
  } catch {
    return {
      available: false,
      errorCode: 'raw_export_unreachable',
      message: 'Could not reach the tracking sink.',
    };
  }

  if (response.status === 404) {
    return {
      available: false,
      status: 404,
      errorCode: 'raw_export_not_available',
      message: 'Raw event export is not available on this sink yet.',
    };
  }
  if (!response.ok) {
    return {
      available: false,
      status: response.status,
      errorCode: 'raw_export_failed',
      message: `Raw export request failed with HTTP ${response.status}.`,
    };
  }

  return { available: true, ndjson: await response.text() };
};
