/**
 * M4 — `/admin/analytics`'s one call on mount.
 *
 * The page used to fire FOUR invocations of `admin-analytics` at mount:
 * `?resource=views`, `?source=netlify`, `?source=own` and
 * `?resource=annotations`. Behind the snapshots each of those is now one or
 * two blob reads, which makes the ~300 ms per-invocation platform floor —
 * charged four times — the largest remaining thing on the page. So they
 * coalesce into `?resource=boot`, the same move M2.2 made for the admin shell.
 *
 * ## The cache key, and the bug it fixes
 *
 * The key is the RANGE, not the resolved window. That is not a detail:
 * `resolveDateWindow('30d', new Date())` returns `to = Date.now()` to the
 * millisecond, so the page's previous keys
 * (`analytics:netlify:${window.from}:${window.to}`) were unique per page load
 * and the browser cache above them could never hit — the same defect the
 * server's TTL memo had, in the same page, for the same reason. Keying on what
 * the viewer actually chose makes a repeat visit within
 * `CACHED_RESOURCE_MAX_AGE_MS` paint synchronously, which is what
 * `useCachedResource` was built to do and has not been able to do here.
 *
 * ## Degradation
 *
 * Each of the four parts degrades on its own: the server answers
 * `{ error: string }` in that part's place rather than failing the boot, so a
 * saved-views list that cannot be read never costs a viewer their KPIs. The
 * helpers below turn that shape back into the `null`/`[]` each panel already
 * knew how to render, so no caller learns a new failure mode.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { AnalyticsFilters, AnalyticsRangeKey, AnalyticsOverview, CustomRangeInput } from './analytics-logic.js';
import type { OwnAnalyticsOverview } from './own-analytics-logic.js';
import type { AnalyticsSavedView } from './analytics-views-logic.js';
import type { AnnotationMarker } from './analytics-annotations-logic.js';
import { currentPageSignal } from './page-generation.js';

const ENDPOINT = '/.netlify/functions/admin-analytics';

/** A part the server could not build. Never a thrown boot — see the header. */
export type BootPartError = { error: string };

export interface AnalyticsBoot {
  range: AnalyticsRangeKey;
  window: { from: number; to: number; resolution: 'hour' | 'day' };
  netlify: AnalyticsOverview | BootPartError;
  own: OwnAnalyticsOverview | BootPartError;
  views: AnalyticsSavedView[] | BootPartError;
  markers: AnnotationMarker[] | BootPartError;
}

export interface FetchAnalyticsBootOptions {
  range: AnalyticsRangeKey;
  custom?: CustomRangeInput | undefined;
  filters?: AnalyticsFilters | undefined;
}

/** True for the `{ error }` placeholder a degraded part carries. */
export const isBootPartError = (part: unknown): part is BootPartError =>
  typeof part === 'object' && part !== null && typeof (part as BootPartError).error === 'string';

/**
 * The stable cache key for a boot read. Range + custom span + filters — every
 * input the request varies on, and NOT the clock (see the header).
 */
export const analyticsBootKey = (opts: FetchAnalyticsBootOptions): string => {
  const rangePart =
    opts.range === 'custom' ? `custom:${opts.custom?.from ?? ''}:${opts.custom?.to ?? ''}` : opts.range;
  const f = opts.filters;
  return `analytics:boot:${rangePart}:${f?.country ?? ''}|${f?.source ?? ''}|${f?.object_id ?? ''}`;
};

const buildQuery = (opts: FetchAnalyticsBootOptions): string => {
  const params = new URLSearchParams({ resource: 'boot', range: opts.range });
  if (opts.range === 'custom' && opts.custom) {
    params.set('from', opts.custom.from);
    params.set('to', opts.custom.to);
  }
  if (opts.filters?.country) params.set('country', opts.filters.country);
  if (opts.filters?.source) params.set('fsource', opts.filters.source);
  if (opts.filters?.object_id) params.set('object', opts.filters.object_id);
  return params.toString();
};

/** T1.1: a plain page-load read — always rides the current page-generation signal. */
export async function fetchAnalyticsBoot(
  getToken: GetToken,
  opts: FetchAnalyticsBootOptions,
  signal?: AbortSignal
): Promise<AnalyticsBoot> {
  const token = await getToken();
  const response = await fetch(`${ENDPOINT}?${buildQuery(opts)}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: signal ?? currentPageSignal(),
  });
  const body = (await response.json().catch(() => ({}))) as AnalyticsBoot & { error?: string };
  if (!response.ok) throw new Error(body.error || `Analytics request failed (${response.status}).`);
  return body;
}

/**
 * The four readers each panel wants: the value, or the honest empty the panel
 * already renders. A degraded part is `null`/`[]` here rather than a thrown
 * error, because the page's contract has always been that one dead panel does
 * not take the others with it.
 */
export const bootNetlify = (boot: AnalyticsBoot | undefined): AnalyticsOverview | null =>
  boot && !isBootPartError(boot.netlify) ? boot.netlify : null;

export const bootOwn = (boot: AnalyticsBoot | undefined): OwnAnalyticsOverview | null =>
  boot && !isBootPartError(boot.own) ? boot.own : null;

export const bootViews = (boot: AnalyticsBoot | undefined): AnalyticsSavedView[] =>
  boot && !isBootPartError(boot.views) ? boot.views : [];

export const bootMarkers = (boot: AnalyticsBoot | undefined): AnnotationMarker[] =>
  boot && !isBootPartError(boot.markers) ? boot.markers : [];

/** The message for a part that failed, when a panel wants to say so instead of showing an empty state. */
export const bootPartError = (part: unknown): string | null => (isBootPartError(part) ? part.error : null);
