/**
 * Analytics object drill-down (T21.30; runner R11.4) — pure logic behind
 * `/admin/analytics/object/<objectId>`: the engagement funnel, per-node
 * read-depth bars (the `node_strategy` join — a private, admin-only
 * vocabulary, never shown to a reader), the object's traffic sources, and
 * its variant family, all for one object over the shared range picker's
 * window.
 *
 * Same house split as every other analytics module: I/O (the store-backed
 * identity/producer lookup, the sink's `?source=own&object=<id>` request)
 * stays server-side; this file only shapes what those two calls already
 * return. Every sink field is optional end to end (D-brief, verbatim) — the
 * central design problem this module solves is telling "the sink hasn't
 * shipped the `object` block yet" apart from "this object legitimately has
 * zero of something", which is why `resolveObjectDrilldownPanel` carries a
 * dedicated `sinkObjectAbsent` flag rather than only degrading each number
 * to zero.
 */
import { formatAnalyticsCount, type AnalyticsRankingRowWithShare } from './analytics-logic.js';
import type {
  OwnTrackerEngagementFunnelRow,
  OwnTrackerObjectDetail,
  OwnTrackerObjectNode,
  OwnTrackerObjectVariant,
  OwnTrackerTopSource,
} from './own-analytics-logic.js';

// ─── identity + producer (store-backed, never absent because of the sink) ──

/** The object's title/route/type, resolved the same way every other ranking row's id is (D6) — `found: false` when the id does not resolve to a real, readable record at all (a stale link, a deleted object). */
export interface ObjectDrilldownIdentity {
  objectId: string;
  found: boolean;
  title: string;
  route: string | null;
  objectType: string;
}

/**
 * `surface`/`promptVersion` come off the object's own publish receipt
 * (`publication.publish_receipt`), the same field `publishingSurfaces` in
 * `admin-analytics.ts` reads for the main page's surface split — store data,
 * not sink data, so it is available regardless of whether the tracking sink
 * has deployed anything. Both are `null`, not absent, when the record is
 * readable but carries no receipt (a pre-W7.4 revision) or the receipt has
 * no `prompt_version` (a human-authored publish) — a real, nameable state,
 * distinct from the identity lookup failing outright.
 */
export interface ObjectDrilldownProducer {
  surface: string | null;
  promptVersion: string | null;
}

// ─── funnel ─────────────────────────────────────────────────────────────────

export interface FunnelStageRow {
  stage: keyof Omit<OwnTrackerEngagementFunnelRow, 'object_id'>;
  label: string;
  count: number;
  /** 0..1 of the FIRST stage (pageview) — unlike a ranking bar list, funnel order is fixed, never sorted by count. */
  share: number;
  /** Formatted rate relative to pageview, e.g. "42%"; "—" when pageview is 0. */
  rateOfEntry: string;
}

const FUNNEL_STAGES: ReadonlyArray<{ stage: FunnelStageRow['stage']; label: string }> = [
  { stage: 'pageview', label: 'Pageview' },
  { stage: 'read_progress', label: 'Read progress' },
  { stage: 'completion', label: 'Completion' },
  { stage: 'cta_click', label: 'CTA click' },
  { stage: 'buy_click', label: 'Buy click' },
];

/** `undefined` funnel (the sink hasn't deployed the object block, or the funnel sub-field specifically) renders as an empty list — the caller distinguishes that from "computed, all zero" via `sinkObjectAbsent`. */
export function funnelStageRows(funnel: OwnTrackerObjectDetail['funnel'] | undefined): FunnelStageRow[] {
  if (!funnel) return [];
  const pageview = typeof funnel.pageview === 'number' ? funnel.pageview : 0;
  return FUNNEL_STAGES.map(({ stage, label }) => {
    const raw = funnel[stage];
    const count = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
    return {
      stage,
      label,
      count,
      share: pageview > 0 ? Math.min(count / pageview, 1) : 0,
      rateOfEntry: pageview > 0 ? `${Math.round((count / pageview) * 100)}%` : '—',
    };
  });
}

/** The funnel as `BarList` rows — reusing that component rather than a bespoke funnel chart (task brief: "no parallel implementations"). */
export function funnelBarRows(funnel: OwnTrackerObjectDetail['funnel'] | undefined): AnalyticsRankingRowWithShare[] {
  return funnelStageRows(funnel).map((row) => ({
    label: row.label,
    visits: row.count,
    share: row.share,
    sublabel: `${row.rateOfEntry} of pageviews`,
  }));
}

// ─── node-level read-depth ──────────────────────────────────────────────────

/**
 * `nodes[]` sorted by document `position` (reading order), not by any
 * metric — a read-depth chart that reordered itself by traffic would be
 * unreadable as "where do readers drop off". `strategy`/`intent` are the
 * private vocabulary D-brief calls out as admin-only; a node missing either
 * (an older annotation, or one the strategy registry never covered) falls
 * back to its bare `node_id` rather than hiding the row.
 */
export function nodeReadDepthRows(nodes: readonly OwnTrackerObjectNode[] | undefined): AnalyticsRankingRowWithShare[] {
  if (!nodes || nodes.length === 0) return [];
  const ordered = [...nodes].sort((a, b) => (a?.position ?? 0) - (b?.position ?? 0));
  const max = ordered.reduce((most, node) => Math.max(most, node?.impressions ?? 0), 0);
  return ordered.map((node, index) => {
    const impressions = typeof node?.impressions === 'number' ? node.impressions : 0;
    const label = node?.strategy || node?.node_id || `Node ${index + 1}`;
    const dwellSeconds = typeof node?.dwell_ms_avg === 'number' ? Math.round(node.dwell_ms_avg / 1000) : null;
    const sublabelParts = [
      node?.intent ? node.intent : null,
      dwellSeconds !== null ? `${dwellSeconds}s avg dwell` : null,
    ].filter((part): part is string => Boolean(part));
    return {
      label,
      visits: impressions,
      share: max > 0 ? impressions / max : 0,
      sublabel: sublabelParts.length > 0 ? sublabelParts.join(' · ') : undefined,
    };
  });
}

// ─── sources (already scoped to this object by the `object_id` sink filter) ─

export function objectSourceRows(sources: readonly OwnTrackerTopSource[] | undefined): AnalyticsRankingRowWithShare[] {
  if (!sources || sources.length === 0) return [];
  const rows = sources.map((row) => ({
    label: row?.referrer_host_or_utm_source || 'Direct',
    visits: typeof row?.sessions === 'number' ? row.sessions : 0,
  }));
  const max = rows.reduce((most, row) => Math.max(most, row.visits), 0);
  return rows.map((row) => ({ ...row, share: max > 0 ? row.visits / max : 0 }));
}

// ─── variants ───────────────────────────────────────────────────────────────

export interface VariantDisplayRow {
  objectId: string;
  version: number;
  route: string | null;
  publishedAt: string | null;
  /** `undefined` — never zeros — when the sink has not attributed traffic to this specific variant. */
  pageviews?: number;
  sessions?: number;
  completionRate?: number;
}

export function variantDisplayRows(variants: readonly OwnTrackerObjectVariant[] | undefined): VariantDisplayRow[] {
  if (!variants || variants.length === 0) return [];
  return [...variants]
    .sort((a, b) => (a?.version ?? 0) - (b?.version ?? 0))
    .map((variant) => ({
      objectId: variant?.object_id ?? '',
      version: typeof variant?.version === 'number' ? variant.version : 0,
      route: variant?.route ?? null,
      publishedAt: variant?.published_at ?? null,
      pageviews: variant?.metrics?.pageviews,
      sessions: variant?.metrics?.sessions,
      completionRate: variant?.metrics?.completion_rate,
    }));
}

// ─── the page-ready panel ────────────────────────────────────────────────────

export interface ObjectDrilldownKpi {
  id: string;
  label: string;
  value: string;
}

export interface ObjectDrilldownPanel {
  status: 'loading' | 'error' | 'ready';
  error?: string;
  identity?: ObjectDrilldownIdentity;
  producer?: ObjectDrilldownProducer;
  kpis: ObjectDrilldownKpi[];
  funnel: FunnelStageRow[];
  funnelBars: AnalyticsRankingRowWithShare[];
  nodeRows: AnalyticsRankingRowWithShare[];
  sourceRows: AnalyticsRankingRowWithShare[];
  variants: VariantDisplayRow[];
  /**
   * True only when the `?source=own` payload carried no `object` field at
   * all — the sink has not deployed this block yet. `false` with every list
   * above empty means the sink DID answer and this object genuinely has no
   * recorded funnel/nodes for the window — a real zero, not an absence, and
   * the page must render those two states with different copy.
   */
  sinkObjectAbsent: boolean;
}

export interface ObjectDrilldownInput {
  loading: boolean;
  error: string | null;
  identity?: ObjectDrilldownIdentity;
  producer?: ObjectDrilldownProducer;
  /** `undefined` while the own-tracker request is still in flight or failed; `null` is the sink's own explicit "no object block" answer. */
  objectDetail?: OwnTrackerObjectDetail | null;
  sourceRows?: readonly OwnTrackerTopSource[];
}

export function resolveObjectDrilldownPanel(input: ObjectDrilldownInput): ObjectDrilldownPanel {
  if (input.loading) {
    return {
      status: 'loading',
      kpis: [],
      funnel: [],
      funnelBars: [],
      nodeRows: [],
      sourceRows: [],
      variants: [],
      sinkObjectAbsent: false,
    };
  }
  if (input.error) {
    return {
      status: 'error',
      error: input.error,
      kpis: [],
      funnel: [],
      funnelBars: [],
      nodeRows: [],
      sourceRows: [],
      variants: [],
      sinkObjectAbsent: false,
    };
  }

  const detail = input.objectDetail;
  const sinkObjectAbsent = detail === undefined || detail === null;

  const kpis: ObjectDrilldownKpi[] = detail
    ? [
        { id: 'pageviews', label: 'Pageviews', value: formatAnalyticsCount(detail.pageviews ?? 0) },
        { id: 'sessions', label: 'Sessions', value: formatAnalyticsCount(detail.sessions ?? 0) },
        {
          id: 'completion_rate',
          label: 'Completion rate',
          value: `${Math.round((detail.completion_rate ?? 0) * 100)}%`,
        },
      ]
    : [];

  return {
    status: 'ready',
    identity: input.identity,
    producer: input.producer,
    kpis,
    funnel: funnelStageRows(detail?.funnel),
    funnelBars: funnelBarRows(detail?.funnel),
    nodeRows: nodeReadDepthRows(detail?.nodes),
    sourceRows: objectSourceRows(input.sourceRows),
    variants: variantDisplayRows(detail?.variants),
    sinkObjectAbsent,
  };
}
