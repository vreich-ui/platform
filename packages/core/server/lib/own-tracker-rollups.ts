/**
 * Own-tracker arm-metrics fetch (T21.6b / R4b) — `admin-analytics`'s THIRD
 * data source (`?source=arm_metrics`), the I/O half of
 * `lib/admin/variant-arm-metrics.ts`'s pure shaping.
 *
 * Two calls, same TRACKING_SINK_URL/TRACKING_PROJECT_ID/TRACKING_SINK_TOKEN
 * triple `own-tracker-stats.ts` already reads for `/stats` and
 * `scripts/lib/tracking-experiments.mjs` already reads for `/weights` at
 * build time (no new env var, no new P2 obligation):
 *
 *   `GET ${TRACKING_SINK_URL}/rollups?by=object&project_id=<id>` — pinned
 *   contract, `ArmRollupRow[]`; being built in parallel in kugel-data, same
 *   posture as `/stats`: degrade a missing/malformed field rather than throw
 *   on the SHAPE, but a network failure or non-2xx still throws — this is
 *   the page's primary data source, not an optional extra, so `admin-
 *   analytics.ts` treats that the same way it treats a `/stats` failure (a
 *   real 500, not a silent zero).
 *
 *   `GET ${TRACKING_SINK_URL}/weights?project_id=<id>` — the SAME endpoint
 *   `scripts/lib/tracking-experiments.mjs`'s `fetchWeights` calls at build
 *   time, reimplemented here (not imported: `scripts/` is plain build-time
 *   `.mjs` that `packages/core` never imports either direction) so the admin
 *   page can show the CURRENT sink weight rather than the value baked into
 *   the last build. Same fail-open law as the build step: absent config, a
 *   timeout, a non-2xx, or a malformed body all degrade to `{}` — a weight
 *   outage must never fail this page, only make its weight column fall back
 *   to `normalizeArmShares`'s `default_equal`.
 *
 * Env NAMES only ever appear in code/logs/tests here — never a literal
 * TRACKING_SINK_URL value or TRACKING_SINK_TOKEN. The Bearer token is sent
 * in the outgoing REQUEST header only; neither function below ever places it
 * in its return value, so it cannot leak into the JSON `admin-analytics.ts`
 * hands back to the browser (proven by `own-tracker-rollups.test.ts`).
 */
import type { ArmRollupRow } from '../../lib/admin/variant-arm-metrics.js';

const ROLLUPS_TIMEOUT_MS = 8_000;
const WEIGHTS_TIMEOUT_MS = 2_000;

export type OwnTrackerRollupsEnv = Partial<
  Pick<NodeJS.ProcessEnv, 'TRACKING_SINK_URL' | 'TRACKING_PROJECT_ID' | 'TRACKING_SINK_TOKEN'>
>;

const readEnv = (env: OwnTrackerRollupsEnv) => ({
  sinkUrl: env.TRACKING_SINK_URL?.trim() || '',
  projectId: env.TRACKING_PROJECT_ID?.trim() || '',
  token: env.TRACKING_SINK_TOKEN?.trim() || '',
});

/** Same predicate shape as `ownTrackerMissingEnvVars` — env NAMES only. */
export const armMetricsMissingEnvVars = (env: OwnTrackerRollupsEnv = process.env): string[] => {
  const { sinkUrl, projectId } = readEnv(env);
  return [...(sinkUrl ? [] : ['TRACKING_SINK_URL']), ...(projectId ? [] : ['TRACKING_PROJECT_ID'])];
};

export interface FetchOwnTrackerRollupsOptions {
  env?: OwnTrackerRollupsEnv;
  fetchImpl?: typeof fetch;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** One raw rollup entry → the pinned `ArmRollupRow` shape, degrading anything malformed to a safe default. */
const toRollupRow = (raw: unknown): ArmRollupRow | undefined => {
  if (!isRecord(raw) || typeof raw.object_id !== 'string' || !raw.object_id) return undefined;
  return {
    object_id: raw.object_id,
    exposures: num(raw.exposures),
    sessions: num(raw.sessions),
    completion_rate: num(raw.completion_rate),
    cta_click_rate: num(raw.cta_click_rate),
    purchase_rate: num(raw.purchase_rate),
    revenue: num(raw.revenue),
  };
};

const rollupsEndpoint = (sinkUrl: string, projectId: string): string =>
  `${sinkUrl.replace(/\/+$/, '')}/rollups?by=object&project_id=${encodeURIComponent(projectId)}`;

/**
 * Throws when the sink cannot be reached or returns a non-2xx — the caller
 * (`admin-analytics.ts`) treats that as a real 500, the same posture
 * `fetchOwnTrackerStats` takes for `/stats`.
 */
export const fetchOwnTrackerRollups = async (options: FetchOwnTrackerRollupsOptions = {}): Promise<ArmRollupRow[]> => {
  const env = options.env ?? process.env;
  const { sinkUrl, projectId, token } = readEnv(env);
  if (!sinkUrl || !projectId) throw new Error('Own-tracker sink is not configured.');

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await (options.fetchImpl ?? fetch)(rollupsEndpoint(sinkUrl, projectId), {
    headers,
    signal: AbortSignal.timeout(ROLLUPS_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Own-tracker rollups request failed with HTTP ${response.status}.`);
  const body = (await response.json()) as unknown;
  const rawRows = isRecord(body) && Array.isArray(body.rows) ? body.rows : Array.isArray(body) ? body : [];
  return rawRows.map(toRollupRow).filter((row): row is ArmRollupRow => row !== undefined);
};

export interface FetchOwnTrackerWeightsOptions {
  env?: OwnTrackerRollupsEnv;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  warn?: (message: string) => void;
}

const weightsEndpoint = (sinkUrl: string, projectId: string): string =>
  `${sinkUrl.replace(/\/+$/, '')}/weights?project_id=${encodeURIComponent(projectId)}`;

/**
 * `GET ${TRACKING_SINK_URL}/weights?project_id=<id>` — best effort, NEVER
 * throws. Returns `{}` (→ every experiment's weight column falls back to
 * `default_equal`) on missing config, a timeout, a non-2xx, or an unusable
 * body — the exact fallback law `scripts/lib/tracking-experiments.mjs`'s
 * `fetchWeights` documents for the build step, reused here so a weight-sink
 * outage degrades this admin page the same way it degrades a live build.
 */
export const fetchOwnTrackerWeights = async (
  options: FetchOwnTrackerWeightsOptions = {}
): Promise<Record<string, Record<string, number>>> => {
  const env = options.env ?? process.env;
  const { sinkUrl, projectId, token } = readEnv(env);
  const fetchImpl = options.fetchImpl ?? fetch;
  const warn = options.warn ?? (() => {});
  if (!sinkUrl || !projectId || typeof fetchImpl !== 'function') return {};

  const headers: Record<string, string> = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const response = await fetchImpl(weightsEndpoint(sinkUrl, projectId), {
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? WEIGHTS_TIMEOUT_MS),
    });
    if (!response.ok) {
      warn(`arm-metrics weights: HTTP ${response.status} — equal weights.`);
      return {};
    }
    const body = (await response.json()) as unknown;
    if (!isRecord(body)) return {};
    const rows = isRecord(body.weights) ? body.weights : body;
    if (!isRecord(rows)) return {};
    const result: Record<string, Record<string, number>> = {};
    for (const [controlId, row] of Object.entries(rows)) {
      if (isRecord(row)) result[controlId] = row as Record<string, number>;
    }
    return result;
  } catch (error) {
    warn(`arm-metrics weights: ${error instanceof Error ? error.message : String(error)} — equal weights.`);
    return {};
  }
};
