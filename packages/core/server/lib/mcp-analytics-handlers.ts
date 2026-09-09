/**
 * Tool-call handlers for the analytics family (R12.3 / T21.20):
 * `analytics_summary`, `analytics_top_content`, `analytics_object`.
 *
 * Two data sources, kept honestly separate:
 *
 *  1. The own-tracker SINK (`fetchOwnTrackerStats`, `own-tracker-stats.ts`) —
 *     proxied server-side only. `TRACKING_SINK_TOKEN` is read from
 *     `process.env` inside that module and never appears in any value these
 *     handlers return (see `mcp-analytics-handlers.test.ts`'s token-leak
 *     assertion). Missing `TRACKING_SINK_URL`/`TRACKING_PROJECT_ID` degrades
 *     to `{configured:false, error_code:'analytics_not_configured', message}`
 *     — never a crash, never a fabricated zero.
 *  2. THIS TENANT's own object store (publish receipts, `body.lineage`) —
 *     for producer / prompt_version / variant facts the sink does not carry
 *     at all. Read directly, bounded, best-effort (a store fault degrades a
 *     field to `null`, never the whole call).
 *
 * The sink's `/stats` is being extended in parallel (per-object funnel beyond
 * pageview/completion_rate, previous-period deltas, per-object sources — see
 * `docs/cms-architecture/analytics-dashboard-spec.md` §6.1, R6.2). Every
 * field not yet in today's response is OMITTED and named in a
 * `*_unavailable`/`degraded_fields` list with a one-line reason — this file
 * is the one place that rule is enforced, so a future sink field lands here
 * exactly once, not once per caller.
 */
import {
  ownTrackerChartSeries,
  ownTrackerStatRow,
  WORKFLOW_SURFACE,
  type OwnTrackerStatsPayload,
  type OwnTrackerTopObject,
} from '../../lib/admin/own-analytics-logic.js';
import { resolveDateWindow } from '../../lib/admin/analytics-logic.js';
import { fetchOwnTrackerStats, ownTrackerMissingEnvVars, type OwnTrackerStatsWindow } from './own-tracker-stats.js';
import { getSiteObjectsBlobStore } from './blob-store.js';
import { getMcpBinding } from './mcp-binding.js';
import { objectRecordKey, objectStatusIndexPrefix } from './object-store-keys.js';
import { collectBlobListItems, mapWithConcurrency, STORE_READ_CONCURRENCY } from './blob-list.js';
import type { ObjectRecord } from '../../schema/object-record-v1.js';
import { toNonEmptyString, toolError, toolResult, type LambdaEvent } from '../functions/mcp.js';

// ─── shared bits ─────────────────────────────────────────────────────────────

type AnalyticsRange = '7d' | '30d';
const isAnalyticsRange = (value: unknown): value is AnalyticsRange => value === '7d' || value === '30d';

/**
 * T21.24 rebased the sink onto `from`/`to` ISO bounds (the same
 * `resolveDateWindow` the admin dashboard uses) instead of the original
 * `days=7|30` count this tool contract still speaks on the wire — `range`
 * stays `7d`/`30d` for MCP callers, resolved to a window right here so
 * `loadStats` always calls the current sink contract.
 */
const windowForRange = (range: AnalyticsRange): OwnTrackerStatsWindow => {
  const result = resolveDateWindow(range, new Date());
  // `range` is one of the two non-custom keys handled above, so this branch
  // always succeeds — `resolveDateWindow` only returns `ok:false` for `custom`.
  const window = result.ok ? result.window : { from: Date.now() - 7 * 86_400_000, to: Date.now() };
  return { from: new Date(window.from).toISOString(), to: new Date(window.to).toISOString() };
};

const FUNNEL_FIELDS_UNAVAILABLE = ['read_progress', 'cta_click', 'cta_ctr', 'buy_click'] as const;

const notConfiguredResult = () =>
  toolResult({
    configured: false,
    error_code: 'analytics_not_configured',
    message:
      "Analytics is not configured for this tenant. Set TRACKING_SINK_URL and TRACKING_PROJECT_ID (and optionally TRACKING_SINK_TOKEN) in this site's environment to enable analytics tools.",
  });

const loadStats = async (
  window: OwnTrackerStatsWindow
): Promise<{ ok: true; stats: OwnTrackerStatsPayload } | { ok: false; result: ReturnType<typeof toolError> }> => {
  try {
    return { ok: true, stats: await fetchOwnTrackerStats(window) };
  } catch (error) {
    return {
      ok: false,
      result: toolError(error instanceof Error ? error.message : 'Analytics sink request failed.', {
        error_code: 'analytics_sink_unreachable',
      }),
    };
  }
};

const isRecordShape = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

/** The object types this tenant might publish a tracked page/article as. */
const PRODUCER_OBJECT_TYPES = ['content_item', 'page'] as const;

/**
 * Which surface published each object id, read straight from that object's
 * own publish receipt (`publication.publish_receipt.surface` — stamped at
 * publish, W7.4). Bounded to the ids actually asked for (a top-N window is
 * tens of rows, not thousands), best-effort: an unreadable id is reported
 * "unknown" rather than failing the whole call. Mirrors
 * `admin-analytics.ts`'s `publishingSurfaces` exactly, for the same reason.
 */
const producersForObjects = async (
  event: LambdaEvent,
  objectIds: readonly string[]
): Promise<Record<string, string | null>> => {
  const ids = [...new Set(objectIds)].filter(Boolean);
  if (ids.length === 0) return {};

  let store: Awaited<ReturnType<typeof getSiteObjectsBlobStore>>;
  try {
    store = await getSiteObjectsBlobStore(event, getMcpBinding());
  } catch {
    return {};
  }

  const entries = await mapWithConcurrency(ids, STORE_READ_CONCURRENCY, async (objectId) => {
    for (const objectType of PRODUCER_OBJECT_TYPES) {
      try {
        const raw = await store.get(objectRecordKey(objectType, objectId));
        if (!raw) continue;
        const record = JSON.parse(raw) as ObjectRecord;
        return [objectId, record.publication?.publish_receipt?.surface ?? null] as const;
      } catch {
        // Unreadable or not this type — try the next, then give up quietly.
      }
    }
    return null;
  });
  return Object.fromEntries(entries.filter((entry): entry is readonly [string, string | null] => entry !== null));
};

/** `null` (record read failed / no receipt) vs a known surface vs the workflow default — never folds "couldn't tell" into "workflow". */
const producerLabel = (producers: Record<string, string | null>, objectId: string): string =>
  Object.hasOwn(producers, objectId) ? (producers[objectId] ?? WORKFLOW_SURFACE) : 'unknown';

// ─── analytics_summary ───────────────────────────────────────────────────────

export const callAnalyticsSummary = async (_event: LambdaEvent, input: Record<string, unknown>) => {
  if (ownTrackerMissingEnvVars().length > 0) return notConfiguredResult();

  const range = isAnalyticsRange(input.range) ? input.range : '7d';
  const loaded = await loadStats(windowForRange(range));
  if (!loaded.ok) return loaded.result;

  const series = ownTrackerChartSeries(loaded.stats);
  const row = ownTrackerStatRow(loaded.stats);

  return toolResult({
    configured: true,
    range,
    pageviews: series.totals.visits,
    sessions: row.sessions,
    visitors: row.visitors,
    consented_share_pct: row.consentedPct,
    purchases: row.purchases,
    last_event_at: row.lastEventAt,
    deltas: null,
    degraded_fields: ['deltas_vs_previous_period'],
    note: "Delta-vs-previous-period comparison is not available yet: the sink's /stats endpoint has no `previous` window today (a parallel wave is adding one — see docs/cms-architecture/analytics-dashboard-spec.md §6.1). `deltas` is omitted, not approximated.",
  });
};

// ─── analytics_top_content ───────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 20;
type SortKey = 'pageviews' | 'completion_rate' | 'cta_ctr';
const isSortKey = (value: unknown): value is SortKey =>
  value === 'pageviews' || value === 'completion_rate' || value === 'cta_ctr';

const sortComparator = (sort: 'pageviews' | 'completion_rate') => (a: OwnTrackerTopObject, b: OwnTrackerTopObject) => {
  if (sort === 'completion_rate') {
    return (
      (typeof b.completion_rate === 'number' ? b.completion_rate : 0) -
      (typeof a.completion_rate === 'number' ? a.completion_rate : 0)
    );
  }
  return (typeof b.pageviews === 'number' ? b.pageviews : 0) - (typeof a.pageviews === 'number' ? a.pageviews : 0);
};

export const callAnalyticsTopContent = async (event: LambdaEvent, input: Record<string, unknown>) => {
  if (ownTrackerMissingEnvVars().length > 0) return notConfiguredResult();

  const range = isAnalyticsRange(input.range) ? input.range : '7d';
  const requestedSort: SortKey = isSortKey(input.sort) ? input.sort : 'pageviews';
  const ctaSortDegraded = requestedSort === 'cta_ctr';
  const effectiveSort: 'pageviews' | 'completion_rate' = ctaSortDegraded ? 'pageviews' : requestedSort;
  const rawLimit =
    typeof input.limit === 'number' && Number.isFinite(input.limit) ? Math.floor(input.limit) : DEFAULT_LIMIT;
  const limit = Math.min(MAX_LIMIT, Math.max(1, rawLimit));

  const loaded = await loadStats(windowForRange(range));
  if (!loaded.ok) return loaded.result;

  const topObjects = loaded.stats.top_objects ?? [];
  const limited = [...topObjects].sort(sortComparator(effectiveSort)).slice(0, limit);
  const producers = await producersForObjects(
    event,
    limited.map((row) => row.object_id)
  );

  const items = limited.map((row) => ({
    object_id: row.object_id,
    object_type: row.object_type,
    producer: producerLabel(producers, row.object_id),
    sessions: typeof row.sessions === 'number' ? row.sessions : 0,
    funnel: {
      pageview: typeof row.pageviews === 'number' ? row.pageviews : 0,
      completion_rate: typeof row.completion_rate === 'number' ? row.completion_rate : null,
    },
  }));

  return toolResult({
    configured: true,
    range,
    sort: requestedSort,
    ...(ctaSortDegraded
      ? {
          sort_degraded: true,
          sort_degraded_reason:
            'cta_ctr requires per-object CTA-click counts, which the sink does not serve yet (planned, not built). Sorted by pageviews instead.',
        }
      : {}),
    limit,
    count: items.length,
    items,
    funnel_fields_unavailable: FUNNEL_FIELDS_UNAVAILABLE,
    note: 'Per-object funnel is partial: only pageview and completion_rate are available from the sink today. read_progress/cta_click/cta_ctr/buy_click are omitted, not approximated, pending the sink extension.',
  });
};

// ─── analytics_object ────────────────────────────────────────────────────────

/** Bound on the corpus scan for "which other content_items name this one as their parent". Matches the house precedent (variants-client.ts) of a bounded, honest-about-its-cost sweep rather than an index that does not exist. */
const VARIANT_SCAN_CAP = 300;

type Lineage = { parent_content_id?: string; source_version_id?: string };
const lineageFromBody = (body: unknown): Lineage | undefined =>
  isRecordShape(body) && isRecordShape((body as { lineage?: unknown }).lineage)
    ? ((body as { lineage?: Lineage }).lineage as Lineage)
    : undefined;

export const callAnalyticsObject = async (event: LambdaEvent, input: Record<string, unknown>) => {
  const objectId = toNonEmptyString(input.object_id);
  if (!objectId) return toolError('object_id is required.');
  if (ownTrackerMissingEnvVars().length > 0) return notConfiguredResult();

  const range = isAnalyticsRange(input.range) ? input.range : '7d';
  const loaded = await loadStats(windowForRange(range));
  if (!loaded.ok) return loaded.result;

  const row = (loaded.stats.top_objects ?? []).find((candidate) => candidate.object_id === objectId);

  // producer / prompt_version / lineage: read from THIS TENANT's own object
  // store, never the sink — the sink carries no such dimension today.
  let record: ObjectRecord | undefined;
  let recordObjectType: (typeof PRODUCER_OBJECT_TYPES)[number] | undefined;
  let store: Awaited<ReturnType<typeof getSiteObjectsBlobStore>> | undefined;
  try {
    store = await getSiteObjectsBlobStore(event, getMcpBinding());
    for (const objectType of PRODUCER_OBJECT_TYPES) {
      const raw = await store.get(objectRecordKey(objectType, objectId));
      if (raw) {
        record = JSON.parse(raw) as ObjectRecord;
        recordObjectType = objectType;
        break;
      }
    }
  } catch {
    // Best-effort — the tool still reports what the sink had.
  }

  if (!row && !record) {
    return toolError(`No analytics or object record found for "${objectId}".`, { error_code: 'object_not_found' });
  }

  const receipt = record?.publication?.publish_receipt;
  const lineage = lineageFromBody(record?.body);

  // variants (children): bounded scan of active content_item records whose
  // lineage.parent_content_id points at this object. Skipped entirely when
  // the object itself is known and is not a content_item (pages/etc never
  // carry lineage) to avoid an unnecessary scan.
  let variants: Array<{ object_id: string }> = [];
  let variantScanTruncated = false;
  if (store && (recordObjectType === 'content_item' || !recordObjectType)) {
    try {
      const items = await collectBlobListItems(
        await store.list({ prefix: objectStatusIndexPrefix('content_item', 'active') })
      );
      const candidateIds = items
        .map((item) => item.key.split('/').at(-1))
        .filter((id): id is string => Boolean(id) && id !== objectId);
      const capped = candidateIds.slice(0, VARIANT_SCAN_CAP);
      variantScanTruncated = candidateIds.length > capped.length;
      const scanned = await mapWithConcurrency(capped, STORE_READ_CONCURRENCY, async (id) => {
        try {
          const raw = await store!.get(objectRecordKey('content_item', id));
          if (!raw) return null;
          const candidateRecord = JSON.parse(raw) as ObjectRecord;
          const candidateLineage = lineageFromBody(candidateRecord.body);
          return candidateLineage?.parent_content_id === objectId ? { object_id: id } : null;
        } catch {
          return null;
        }
      });
      variants = scanned.filter((entry): entry is { object_id: string } => entry !== null);
    } catch {
      // Best-effort — an unreadable index degrades `variants` to empty, not the whole call.
    }
  }

  return toolResult({
    configured: true,
    object_id: objectId,
    range,
    found_in_analytics: Boolean(row),
    funnel: row
      ? {
          pageview: typeof row.pageviews === 'number' ? row.pageviews : 0,
          sessions: typeof row.sessions === 'number' ? row.sessions : 0,
          completion_rate: typeof row.completion_rate === 'number' ? row.completion_rate : null,
        }
      : null,
    funnel_fields_unavailable: FUNNEL_FIELDS_UNAVAILABLE,
    sources: null,
    sources_unavailable_reason:
      "Per-object traffic sources are not in the sink's /stats response yet — today's top_sources is site-wide, not per-object.",
    producer: receipt?.surface ?? null,
    prompt_version: receipt?.prompt_version ?? null,
    attribution: receipt?.attribution ?? null,
    found_in_object_store: Boolean(record),
    variant_of: lineage?.parent_content_id ?? null,
    variants,
    ...(variantScanTruncated
      ? {
          variants_note: `Variant scan capped at ${VARIANT_SCAN_CAP} objects; this tenant's content_item corpus is larger, so this list may be incomplete.`,
        }
      : {}),
    note: "producer/prompt_version/variant lineage are read from this tenant's own object store (publish receipts + body.lineage), never the sink. Per-object funnel beyond pageview/completion_rate, and per-object sources, are not yet served by the sink's /stats endpoint (planned, not built) — omitted rather than approximated.",
  });
};
