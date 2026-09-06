/**
 * T21.6b (R4b) — per-arm reader metrics on `/admin/variants`.
 *
 * `variant-experiments.ts` was written before T21.5's edge split existed —
 * `EVIDENCE_GAPS` there still names "no traffic split" and "per-variant
 * outcomes are not readable here" as the two open gaps. T21.5 closed the
 * first for any family an ACTIVE `experiments[]` entry covers, and this
 * module closes the second: it reads `${TRACKING_SINK_URL}/rollups?by=object`
 * (proxied through `admin-analytics?source=arm_metrics`, the exact
 * `?source=own` shape T21.2b already established) and turns the per-object
 * rows into per-member metric cells.
 *
 * Everything HERE is pure shaping — no fetch, no env, no store — so it is
 * unit-testable against fixture rows with no live sink, matching the split
 * `own-analytics-logic.ts` already draws for the `?source=own` feed. The I/O
 * half lives in `server/lib/own-tracker-rollups.ts` (rollups + weights fetch)
 * and `server/lib/tracking-config-read.ts` (the `trk_<site>` read).
 *
 * ## The honesty rule this module exists to enforce (12-plan §15.4 + §16)
 *
 * §15.4's standing rule: a comparison made WITHOUT a concurrent randomized
 * split is directional evidence, and "the design refuses any UI/tooling copy
 * that calls them A/B tests." §16 (T21.5) scopes that rule precisely: it now
 * applies exactly to a family with NO `active` `experiments[]` entry naming
 * it. A family an active entry DOES cover is a real concurrent randomized
 * test and may be called one. `honestyLabel` below is the one place that
 * decision is made — every rendering call site asks it rather than guessing
 * from whether metrics happen to be present, because metrics exist for a
 * directional family too (an object accrues organic sessions whether or not
 * anything is splitting traffic to it).
 *
 * ## The sample floor (12-plan §15.3 rule 4)
 *
 * `n_sessions >= 50` is the floor doc-12 already sets for a metric-derived
 * SCORE entry to be written at all ("noisy small-sample scores cannot flood
 * the envelope"). This surface never writes a score — it only DISPLAYS sink
 * numbers — but the same reasoning applies to display: a completion/CTA/
 * purchase rate (or a revenue sum, which one large purchase can swing wildly)
 * computed over a handful of sessions is not evidence, it is noise that reads
 * as evidence. Below the floor those four cells render the literal words
 * `BELOW_FLOOR_TEXT` — never a greyed number, never a zero.
 *
 * Exposures, sessions, and the sink weight are deliberately NOT gated by the
 * floor: sessions IS the floor's own yardstick (hiding it would make the
 * placeholder unverifiable), exposures is further upstream and no noisier
 * than sessions, and the weight is a CONFIGURED split, not a reader outcome —
 * it is exactly as meaningful at 5 sessions as at 5,000.
 */
import type { Experiment } from '../../schema/bodies/tracking-config-v1.js';
import type { VariantFamily } from './variant-experiments.js';

export type { Experiment };

// ─── the pinned rollups contract ────────────────────────────────────────────

/**
 * One row of `${TRACKING_SINK_URL}/rollups?by=object` (kugel-data, built in
 * parallel — same posture `own-tracker-stats.ts` takes toward `/stats`: the
 * shape is pinned here, not guessed, but every reader below degrades a
 * missing/malformed field to a safe default rather than throwing, since the
 * contract is still moving).
 *
 * Rates are fractions in `[0, 1]` (not percentages, not per-mille) — display
 * code multiplies by 100. `revenue` is the project's base currency unit
 * (dollars), not cents — unlike `preview-logic.ts`'s commerce cents fields,
 * this is an aggregate SINK sum with no per-row currency code, so a single
 * unit is pinned fleet-wide rather than carried per row.
 */
export interface ArmRollupRow {
  object_id: string;
  exposures: number;
  sessions: number;
  completion_rate: number;
  cta_click_rate: number;
  purchase_rate: number;
  revenue: number;
}

/** Index rollup rows by object id — the shape every function below consumes. */
export function rollupsByObjectId(rows: readonly ArmRollupRow[]): Record<string, ArmRollupRow> {
  const map: Record<string, ArmRollupRow> = {};
  for (const row of rows) {
    if (row && typeof row.object_id === 'string' && row.object_id) map[row.object_id] = row;
  }
  return map;
}

// ─── the honest label (§15.4 / §16) ─────────────────────────────────────────

export type HonestyKind = 'ab_test' | 'directional';

export interface HonestyResult {
  kind: HonestyKind;
  /** The covering entry, present only when `kind === 'ab_test'`. */
  experiment?: Experiment;
}

/**
 * The ONLY place `/admin/variants` decides whether a family may be called an
 * A/B test: an `experiments[]` entry with `status: 'active'` whose
 * `object_id` names this family's parent. Anything else — a `draft` or
 * `concluded` entry, an entry for a different family, no entry at all — is
 * `directional`, per §15.4's standing rule.
 */
export function honestyLabel(experiments: readonly Experiment[] | undefined, parentId: string): HonestyResult {
  const active = (experiments ?? []).find((entry) => entry.status === 'active' && entry.object_id === parentId);
  return active ? { kind: 'ab_test', experiment: active } : { kind: 'directional' };
}

/** One line of copy per honesty kind — every render call site uses these, never ad hoc strings. */
export const HONESTY_COPY: Record<HonestyKind, { badge: string; sentence: string }> = {
  ab_test: {
    badge: 'A/B test — active',
    sentence:
      'An active experiment covers this family: reader traffic is split concurrently and at random across these arms, so these numbers are a real A/B test.',
  },
  directional: {
    badge: 'Directional',
    sentence:
      'No active experiment covers this family, so any exposure is sequential or organic, never concurrent — these numbers are directional evidence, not an A/B test.',
  },
};

// ─── the sample floor ───────────────────────────────────────────────────────

/** 12-plan §15.3 rule 4 — the same floor a metric-derived score would need to be written at all. */
export const ARM_METRICS_SESSION_FLOOR = 50;

/** The exact words the floor rule requires in place of a rate/revenue number — never a greyed number, never a zero. */
export const BELOW_FLOOR_TEXT = 'n too small';

// ─── arm weight (the sink's current split) ─────────────────────────────────

export type ArmWeightSource =
  /** The sink returned a usable row for this experiment's control. */
  | 'sink'
  /** No usable row (absent, missing an arm, non-finite/negative, or a zero sum) — the SAME fallback law the T21.5 build step applies, reused here so the admin surface never claims a split the build itself would not have served. */
  | 'default_equal'
  /** This object is not an arm of any active experiment — a weight would describe a split that is not running. */
  | 'not_experiment';

export interface ArmWeight {
  /** Integer percentage, 0..100, summing to 100 across one experiment's arms. */
  pct: number;
  source: ArmWeightSource;
}

/** Equal integer shares summing to exactly 100 — mirrors `scripts/lib/tracking-experiments.mjs`'s `equalWeights`. */
export function equalShares(count: number): number[] {
  if (count <= 0) return [];
  const base = Math.floor(100 / count);
  const remainder = 100 - base * count;
  return Array.from({ length: count }, (_unused, index) => base + (index < remainder ? 1 : 0));
}

export interface ArmShareResult {
  shares: number[];
  source: 'sink' | 'default_equal';
}

/**
 * Mirrors `scripts/lib/tracking-experiments.mjs`'s `normalizeWeights` exactly
 * (same fallback law: a row missing an arm, carrying a non-finite/negative
 * value, or summing to zero degrades the WHOLE experiment to equal shares,
 * never a partial mix). Reimplemented rather than imported: `scripts/` is
 * plain build-time `.mjs` that `packages/core` never imports in either
 * direction (the two run in different tool-chains — see `arms.ts`'s own
 * "dependency-free on purpose" note), so the admin surface needs its own
 * small copy of the same decision to show the CURRENT sink weight at read
 * time rather than the value baked into the last build's artifact.
 */
export function normalizeArmShares(
  armIds: readonly string[],
  row: Readonly<Record<string, number>> | undefined
): ArmShareResult {
  if (!row || armIds.length === 0) return { shares: equalShares(armIds.length), source: 'default_equal' };
  const raw: number[] = [];
  for (const id of armIds) {
    const value = row[id];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      return { shares: equalShares(armIds.length), source: 'default_equal' };
    }
    raw.push(value);
  }
  const total = raw.reduce((sum, value) => sum + value, 0);
  if (total <= 0) return { shares: equalShares(armIds.length), source: 'default_equal' };
  const scaled = raw.map((value) => Math.floor((value / total) * 100));
  let remainder = 100 - scaled.reduce((sum, value) => sum + value, 0);
  for (let index = 0; remainder > 0; index = (index + 1) % scaled.length) {
    scaled[index] += 1;
    remainder -= 1;
  }
  return { shares: scaled, source: 'sink' };
}

// ─── per-member metric cells ────────────────────────────────────────────────

const numOrZero = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const formatPct = (rate: unknown): string => `${(numOrZero(rate) * 100).toFixed(1)}%`;
const formatRevenue = (value: unknown): string => `$${numOrZero(value).toFixed(2)}`;

export interface ArmMetricCell {
  objectId: string;
  /** True when the sink returned a matching row at all — a missing row reads as zero traffic, not an error. */
  hasData: boolean;
  belowFloor: boolean;
  exposures: number;
  sessions: number;
  /** Formatted (`"12.3%"`) or `BELOW_FLOOR_TEXT` — never a raw number the caller has to format again. */
  completion: string;
  ctaCtr: string;
  purchase: string;
  revenue: string;
  weight: ArmWeight;
}

/**
 * One row per family member (control first, then variants — the caller's own
 * order). `experiment` is the family's ACTIVE entry from `honestyLabel`
 * (`undefined` for a directional family) and `sinkWeightsForControl` is
 * `weights[experiment.object_id]` from the sink's `/weights` response (raw,
 * un-normalized) — both optional because a directional family has neither.
 */
export function armMetricCells(
  memberIds: readonly string[],
  rollups: Readonly<Record<string, ArmRollupRow>>,
  experiment: Experiment | undefined,
  sinkWeightsForControl: Readonly<Record<string, number>> | undefined
): ArmMetricCell[] {
  const armIds = experiment ? experiment.arms.map((arm) => arm.variant_id) : [];
  const shareResult = experiment ? normalizeArmShares(armIds, sinkWeightsForControl) : undefined;

  return memberIds.map((objectId) => {
    const row = rollups[objectId];
    const sessions = numOrZero(row?.sessions);
    const exposures = numOrZero(row?.exposures);
    const belowFloor = sessions < ARM_METRICS_SESSION_FLOOR;

    const armIndex = armIds.indexOf(objectId);
    const weight: ArmWeight =
      shareResult && armIndex >= 0
        ? { pct: shareResult.shares[armIndex] ?? 0, source: shareResult.source }
        : { pct: 0, source: 'not_experiment' };

    return {
      objectId,
      hasData: Boolean(row),
      belowFloor,
      exposures,
      sessions,
      completion: belowFloor ? BELOW_FLOOR_TEXT : formatPct(row?.completion_rate),
      ctaCtr: belowFloor ? BELOW_FLOOR_TEXT : formatPct(row?.cta_click_rate),
      purchase: belowFloor ? BELOW_FLOOR_TEXT : formatPct(row?.purchase_rate),
      revenue: belowFloor ? BELOW_FLOOR_TEXT : formatRevenue(row?.revenue),
      weight,
    } satisfies ArmMetricCell;
  });
}

// ─── the admin-analytics?source=arm_metrics response shape ────────────────

export type ArmMetricsErrorCode = 'own_tracker_unconfigured';

/**
 * The `admin-analytics?source=arm_metrics` payload — same two-state shape
 * (`configured`/`enabled`) `OwnAnalyticsOverview` already uses for
 * `?source=own`, fetched ONCE for the whole `/admin/variants` page (every
 * family's metrics are cells sliced out of the same `rows`/`weights`, not a
 * separate request per family).
 */
export interface ArmMetricsOverview {
  configured: boolean;
  enabled: boolean;
  error_code?: ArmMetricsErrorCode;
  message?: string;
  rows?: ArmRollupRow[];
  /** The `trk_<site>` record's `experiments[]`, every status — `honestyLabel` filters to `active` itself. */
  experiments?: Experiment[];
  /** Raw sink weights, keyed by experiment `object_id` (control) — un-normalized; `armMetricCells` normalizes. */
  weights?: Record<string, Record<string, number>>;
}

export type ArmMetricsPanelState =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'not_configured'; message: string }
  | {
      kind: 'ready';
      rollups: Record<string, ArmRollupRow>;
      experiments: Experiment[];
      weights: Record<string, Record<string, number>>;
    };

/**
 * The page-level gate: turns the fetch's loading/error/response states into
 * ONE named state, rendered ONCE above the family list — never per-family,
 * and never as zeros standing in for "we don't know". A family's own
 * per-member cells are only computed (`armMetricCells`) once this resolves
 * to `'ready'`.
 */
export function resolveArmMetricsPanel(input: {
  loading: boolean;
  error: string | null;
  overview: ArmMetricsOverview | null;
}): ArmMetricsPanelState {
  const { loading, error, overview } = input;
  if (loading) return { kind: 'loading' };
  if (error) return { kind: 'error', message: error };
  if (!overview) return { kind: 'loading' };
  if (!overview.configured) {
    return {
      kind: 'not_configured',
      message:
        overview.message ??
        'The tracking sink is not configured for this site, so no reader metrics reach this page. Set TRACKING_SINK_URL and TRACKING_PROJECT_ID to see arm metrics here.',
    };
  }
  return {
    kind: 'ready',
    rollups: rollupsByObjectId(overview.rows ?? []),
    experiments: overview.experiments ?? [],
    weights: overview.weights ?? {},
  };
}

/** Convenience: `honestyLabel` + `armMetricCells` for one family, given the page-level `'ready'` state. */
export function familyArmMetrics(
  ready: Extract<ArmMetricsPanelState, { kind: 'ready' }>,
  family: Pick<VariantFamily, 'parentId' | 'members'>
): { honesty: HonestyResult; cells: ArmMetricCell[] } {
  const honesty = honestyLabel(ready.experiments, family.parentId);
  const memberIds = family.members.map((view) => view.member.object_id);
  const sinkWeightsForControl = honesty.experiment ? ready.weights[honesty.experiment.object_id] : undefined;
  const cells = armMetricCells(memberIds, ready.rollups, honesty.experiment, sinkWeightsForControl);
  return { honesty, cells };
}
