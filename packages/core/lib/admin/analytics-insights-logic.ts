/**
 * Analytics insights (T21.36; runner R11.5) — pure logic behind the
 * `/admin/analytics` **Insights** tab (`?source=insights`, the third tab
 * alongside `own`/`netlify` — D1's grammar: a tab is a change of data, not
 * of vocabulary). Read-only: this tab shows the learning loop actually
 * working —
 *
 *  1. the latest `tracking:engagement.v1` outcomes CMS-Agent has ingested
 *     (`feedback_list`);
 *  2. playbook items whose evidence cites tracking (`playbook_get`, one
 *     call per node that produced an outcome in (1) — that tool is
 *     node-scoped, there is no "list every playbook" call);
 *  3. open optimizer proposals (`optimizer_status`);
 *  4. the strategy-level table — observations sourced `tracking:strategy.v1`
 *     (`learning_list_observations`), each carrying its evidence window
 *     and `n`.
 *
 * Same split as every other analytics module: the RAW CMS-Agent shape
 * guessing (wrapper-key hunting, free-text window parsing) is server-side
 * (`server/lib/analytics-insights.ts`, deliberately NOT here — the
 * `netlify-analytics.ts` precedent) and untested-in-lib; this file only
 * shapes the ALREADY-NORMALIZED rows into one of four independent section
 * states. "Independent" is the load-bearing word: one section erroring or
 * having nothing to show must never blank the other three, and a genuinely
 * empty section must say WHY (a live fixture on 2026-09-05: outcomes had 5
 * rows, the other three had zero — playbooks and proposals simply don't
 * exist yet for this tenant, and strategy observations need a migration +
 * two job runs that haven't happened) — never a silent zero, never a
 * spinner that never resolves.
 */

// ─── shared evidence shape ──────────────────────────────────────────────────

/**
 * Every row on this tab carries evidence — a window and a sample size `n`.
 * Both are optional because the underlying CMS-Agent record may not carry
 * them in a parseable form (a live `feedback_list` row's window lives in a
 * free-text `note` field like `"window 2026-08-22..2026-09-05"`, which the
 * server-side parser may fail to match) — `formatEvidence` below is what
 * turns "missing" into an honest sentence instead of a blank or a fake `0`.
 */
export interface InsightsEvidence {
  /** ISO date/timestamp, or whatever grain the source recorded. */
  windowStart?: string | null;
  windowEnd?: string | null;
  /** Sample size — sessions, observations, whatever the row's own unit is. */
  n?: number | null;
}

const hasWindow = (evidence: InsightsEvidence | undefined): boolean =>
  Boolean(evidence?.windowStart && evidence?.windowEnd);

const hasSampleSize = (evidence: InsightsEvidence | undefined): boolean =>
  typeof evidence?.n === 'number' && Number.isFinite(evidence.n) && evidence.n > 0;

export interface FormattedEvidence {
  windowLabel: string;
  /** The sample-size half of the line — a real number, or the honest "insufficient evidence" text. Never a fabricated 0. */
  nLabel: string;
  /** `true` only when BOTH a window and a positive `n` are present — the bar a reader can actually trust a number against. */
  sufficient: boolean;
}

/**
 * "Every row shows its evidence window and n. A row without enough evidence
 * says so rather than showing a number" (the task, verbatim) — this is the
 * one function that rule lives in, called by every row renderer on the tab
 * so the four sections can never drift into inconsistent copy.
 */
export function formatEvidence(evidence: InsightsEvidence | undefined): FormattedEvidence {
  const windowOk = hasWindow(evidence);
  const nOk = hasSampleSize(evidence);
  return {
    windowLabel: windowOk ? `${evidence!.windowStart} → ${evidence!.windowEnd}` : 'no evidence window recorded',
    nLabel: nOk ? `n=${evidence!.n}` : 'insufficient evidence',
    sufficient: windowOk && nOk,
  };
}

// ─── section 1: tracking:engagement.v1 outcomes (feedback_list) ───────────

export interface TrackingOutcomeMetrics {
  pageviews?: number;
  exposures?: number;
  sessions?: number;
  completion_rate?: number;
  cta_ctr?: number;
  purchase_rate?: number;
  revenue_cents?: number;
  p75_dwell_ms?: number;
}

export interface TrackingOutcomeRow {
  id: string;
  /** The `feedback_list` record's `nodeId` — the producer the outcome is attributed to, e.g. `plugin:claude`. */
  producer: string;
  runId: string | null;
  createdAt: string | null;
  metrics: TrackingOutcomeMetrics;
  evidence: InsightsEvidence;
}

const pct = (value: number | undefined): string | null =>
  typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value * 100)}%` : null;

/** A compact one-line summary for the row — every present metric, human units, nothing fabricated for an absent one. */
export function summarizeOutcomeMetrics(metrics: TrackingOutcomeMetrics): string {
  const parts: string[] = [];
  if (typeof metrics.sessions === 'number') parts.push(`${metrics.sessions} session${metrics.sessions === 1 ? '' : 's'}`);
  const completion = pct(metrics.completion_rate);
  if (completion) parts.push(`${completion} completion`);
  const ctaCtr = pct(metrics.cta_ctr);
  if (ctaCtr) parts.push(`${ctaCtr} CTA CTR`);
  const purchaseRate = pct(metrics.purchase_rate);
  if (purchaseRate) parts.push(`${purchaseRate} purchase rate`);
  if (typeof metrics.revenue_cents === 'number' && metrics.revenue_cents > 0) {
    parts.push(`$${(metrics.revenue_cents / 100).toFixed(2)} revenue`);
  }
  if (typeof metrics.p75_dwell_ms === 'number' && metrics.p75_dwell_ms > 0) {
    parts.push(`p75 dwell ${Math.round(metrics.p75_dwell_ms / 1000)}s`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'no metrics reported';
}

// ─── section 2: playbook items citing tracking (playbook_get) ─────────────

export interface PlaybookTrackingItem {
  id: string;
  /** Which node's playbook this lesson lives on (`plugin:claude`, …) — `playbook_get` is node-scoped, so every row needs to say whose playbook it came from. */
  nodeId: string;
  text: string;
  /** Every provenance source cited on this item, e.g. `['tracking', 'eval']` — the row is included because at least one is `tracking`. */
  evidenceSources: string[];
  evidence: InsightsEvidence;
}

// ─── section 3: open optimizer proposals (optimizer_status) ───────────────

export interface OptimizerProposalRow {
  id: string;
  nodeId: string | null;
  title: string;
  status: string;
  createdAt: string | null;
  evidence: InsightsEvidence;
}

// ─── section 4: tracking:strategy.v1 observations (learning_list_observations) ─

export interface StrategyObservationRow {
  id: string;
  label: string;
  evidence: InsightsEvidence;
}

// ─── the wire shape `admin-analytics.ts` returns for `?source=insights` ───

/**
 * `rows` present (possibly `[]`) means the CMS-Agent call succeeded — an
 * empty array is a REAL "nothing here", resolved to the section's named
 * empty copy below. `rows` absent means the call itself failed (transport,
 * auth, a CMS-Agent tool error) — `message` is already the human-safe text
 * `cms-agent-client.ts` produced, safe to render verbatim.
 */
export interface InsightsSectionPayload<T> {
  rows?: T[];
  error_code?: string;
  message?: string;
}

export interface InsightsOverview {
  configured: boolean;
  /** Only set when `configured` is false — why CMS-Agent isn't reachable at all for this site. */
  message?: string;
  outcomes?: InsightsSectionPayload<TrackingOutcomeRow>;
  playbookItems?: InsightsSectionPayload<PlaybookTrackingItem>;
  proposals?: InsightsSectionPayload<OptimizerProposalRow>;
  strategyObservations?: InsightsSectionPayload<StrategyObservationRow>;
}

// ─── render state ───────────────────────────────────────────────────────────

export type InsightsSectionState<T> =
  | { kind: 'ready'; rows: T[] }
  | { kind: 'empty'; message: string }
  | { kind: 'error'; message: string };

export interface InsightsPanelReady {
  kind: 'ready';
  outcomes: InsightsSectionState<TrackingOutcomeRow>;
  playbookItems: InsightsSectionState<PlaybookTrackingItem>;
  proposals: InsightsSectionState<OptimizerProposalRow>;
  strategyObservations: InsightsSectionState<StrategyObservationRow>;
}

export type InsightsPanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not_configured'; message: string }
  | InsightsPanelReady;

/** Named per-section "why is this empty" copy — the task's own words for the strategy row, matched in tone for the other three. */
export const INSIGHTS_EMPTY_COPY = {
  outcomes: 'No tracking:engagement.v1 outcomes ingested yet.',
  playbookItems: 'No playbook items cite tracking evidence yet.',
  proposals: 'No open optimizer proposals.',
  strategyObservations: 'No strategy observations yet — needs two consecutive windows.',
} as const;

function resolveSection<T>(
  payload: InsightsSectionPayload<T> | undefined,
  emptyMessage: string
): InsightsSectionState<T> {
  if (!payload) return { kind: 'error', message: 'This section did not load.' };
  if (payload.rows) {
    return payload.rows.length > 0 ? { kind: 'ready', rows: payload.rows } : { kind: 'empty', message: emptyMessage };
  }
  return { kind: 'error', message: payload.message || 'Could not load this section from CMS-Agent.' };
}

export interface InsightsPanelInput {
  loading: boolean;
  error: string | null;
  overview: InsightsOverview | null;
}

/**
 * The one function the Insights tab renders through — mirrors
 * `resolveOwnAnalyticsPanel`/`resolveNetlifyAnalyticsPanel`'s shape (a pure
 * "fetch/loading state in, one named render state out" switch) but returns
 * FOUR independently-resolved sections instead of one KPI+chart+rankings
 * bundle, because that is the actual shape of this tab: nothing here shares
 * a clock or a window the way the other two tabs' KPI strip and chart do.
 */
export function resolveInsightsPanel(input: InsightsPanelInput): InsightsPanelState {
  const { loading, error, overview } = input;
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error', message: error };
  if (!overview) return { kind: 'loading' };

  if (!overview.configured) {
    return {
      kind: 'not_configured',
      message: overview.message || 'CMS-Agent is not configured for this site.',
    };
  }

  return {
    kind: 'ready',
    outcomes: resolveSection(overview.outcomes, INSIGHTS_EMPTY_COPY.outcomes),
    playbookItems: resolveSection(overview.playbookItems, INSIGHTS_EMPTY_COPY.playbookItems),
    proposals: resolveSection(overview.proposals, INSIGHTS_EMPTY_COPY.proposals),
    strategyObservations: resolveSection(overview.strategyObservations, INSIGHTS_EMPTY_COPY.strategyObservations),
  };
}
