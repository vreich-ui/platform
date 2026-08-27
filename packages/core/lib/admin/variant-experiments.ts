/**
 * T4.4 — article VARIANT FAMILIES: the read-side derivation behind
 * `/admin/variants`, and the honest account of what this repo can and cannot
 * tell you about them.
 *
 * ## Read this before calling any of it an A/B test
 *
 * An A/B test needs three things. This repo has one of them.
 *
 *  1. VARIANTS — real. `object_create_variant`
 *     (`server/lib/object-verbs.ts:999`, built by
 *     `lib/article-object/variant.ts`) clones a `content_item`, re-mints its
 *     node ids, re-points the annotations that reference them, resets
 *     `scores[]`, and stamps `lineage.parent_content_id` on the clone. That
 *     one field is the ONLY link between a variant and its parent, and it is
 *     what this module walks.
 *
 *  2. A TRAFFIC SPLIT — DOES NOT EXIST. `lib/article-object/variant.ts:17-19`
 *     states it outright ("Serving/traffic-splitting is explicitly out of
 *     scope (OQ-W7-2)"), the MCP tool description repeats it
 *     (`server/lib/mcp-tool-definitions-2.ts:144`), and nothing in the repo
 *     buckets, assigns or serves one of two articles to a visitor — a variant
 *     is a separate object with its OWN slug, so publishing it adds a second
 *     permalink, it does not split traffic to the first. This module
 *     therefore exposes no split config: a control that changes nothing is
 *     worse than no control.
 *
 *  3. PER-VARIANT RESULTS — NOT READABLE HERE. `tracking_event.v1` carries an
 *     `object_id` (`schema/tracking-event-v1.ts:39`) and `/api/t`
 *     (`server/functions/track-ingest.ts`) forwards batches to the owner's
 *     sink and mirrors them to the `tracking-events` blob store — but nothing
 *     in this repo READS either back (`getTrackingEventsBlobStore` has exactly
 *     one caller, the writer). The results join lives in the owner's database
 *     (`docs/cms-architecture/tracking-sink-reference/schema.sql`), outside
 *     the CMS boundary by design (12-plan section 3). Metric-derived
 *     `scores[]` entries — the design that would carry those numbers back INTO
 *     the record — are section 15 of the same plan, marked "DESIGN ONLY,
 *     nothing implemented", and its ruling line is still blank.
 *
 * So what this module derives is a VARIANT FAMILY and its judged evidence,
 * not an experiment. 12-plan section 15.4 states the rule this file obeys:
 * parent and variant exposure is sequential or organic, never concurrent
 * randomized arms, so comparisons here are directional evidence and "the
 * design refuses any UI/tooling copy that calls them A/B tests."
 *
 * The one thing that IS real evidence today: `body.scores[]`
 * (`schema/bodies/content-item-v1.ts:159`), the agent-authored judge scores
 * `create_variant` deliberately resets on a clone so a variant starts
 * unjudged. Those are records, not estimates, and this module compares them —
 * labelled as the agent judgments they are. It computes no significance,
 * because there is no sample to compute one over.
 */
import type { AdminSeverity } from './severity.js';

// ─── inputs ─────────────────────────────────────────────────────────────────

/** One entry of `body.scores[]` (`contentItemScoreSchema`), as read. */
export interface VariantScore {
  scored_by: string;
  at: string;
  framework: string;
  dimension: string;
  score: number;
  rationale?: string;
}

/**
 * One article, as the variants surface needs it: the inventory row's lifecycle
 * fields plus the three body fields only a record fetch carries
 * (`lineage.parent_content_id`, `slug`, `scores`). Inventory rows carry no
 * body (`server/lib/object-inventory.ts:148`), which is why the caller fetches
 * records — the link this module walks simply is not in the list response.
 */
export interface VariantMember {
  object_id: string;
  display_name: string;
  status: 'active' | 'archived';
  review_state: 'none' | 'open' | 'changes_requested' | 'approved';
  approval_state?: 'none' | 'open' | 'changes_requested' | 'approved_stale' | 'approved_current';
  requires_approval?: boolean;
  published_time: string | null;
  unpublished_changes: boolean;
  updated_at: string;
  /** True when SOMEONE holds the edit lock — the caller says whether it is this viewer. */
  lock?: { held: boolean; owner_label?: string; own?: boolean };
  /** `body.lineage.parent_content_id` — set only on clones, absent on parents. */
  parent_content_id?: string;
  slug?: string;
  scores?: readonly VariantScore[];
}

// ─── derived rows ───────────────────────────────────────────────────────────

export type VariantRole = 'parent' | 'variant';

export interface VariantMemberView {
  member: VariantMember;
  role: VariantRole;
  /** D4 level for this row's lifecycle state (T1.1's five, no sixth vocabulary). */
  severity: AdminSeverity;
  /** The label the D4 badge shows — one phrase, no punctuation. */
  statusLabel: string;
  /** True when this record's export is the one a release would ship. */
  live: boolean;
}

/**
 * A parent article and every clone that names it. `parentMissing` marks the
 * case a real store produces: the parent was retired or purged while its
 * clones survive, so the family has children and no head.
 */
export interface VariantFamily {
  parentId: string;
  parent?: VariantMemberView;
  parentMissing: boolean;
  variants: VariantMemberView[];
  /** parent (when present) first, then variants — the render order. */
  members: VariantMemberView[];
  stage: VariantFamilyStage;
  stageLabel: string;
  stageSeverity: AdminSeverity;
  /** Most recent `updated_at` across the family — the list's sort key. */
  updatedAt: string;
}

/**
 * Where a family has got to. Deliberately NOT called "experiment status":
 * nothing here is running, because nothing is being served against anything.
 */
export type VariantFamilyStage =
  /** No clone has been published — the family is still drafting. */
  | 'drafting'
  /** Parent and at least one clone are both published: two permalinks, no split. */
  | 'both_published'
  /** Exactly one member is published and the rest are archived — a winner stands. */
  | 'settled'
  /** Nothing in the family is published at all (or everything is archived). */
  | 'dormant';

// ─── lifecycle → D4 ─────────────────────────────────────────────────────────

/**
 * The five-level D4 read of one article's lifecycle. Mirrors the state machine
 * in T0.1 section 5.2/5.3 rather than inventing a sixth status vocabulary:
 * `status:'archived'` is terminal, an open review is the one state that wants a
 * human, and "published with no edits since" is the only `success`.
 */
export function memberSeverity(member: VariantMember): { severity: AdminSeverity; label: string; live: boolean } {
  // `live` is a fact about the EXPORT, derived only from publication + archive
  // status. A review is a fact about the draft: an article can perfectly well
  // be serving readers while a revision of it sits in review, and conflating
  // the two would hide a published loser from the archive leg.
  const live = member.status === 'active' && Boolean(member.published_time);

  if (member.status === 'archived') return { severity: 'info', label: 'Archived', live };
  if (member.review_state === 'open') return { severity: 'needs_you', label: 'In review', live };
  if (member.review_state === 'changes_requested') return { severity: 'needs_you', label: 'Changes requested', live };
  if (member.published_time && !member.unpublished_changes) return { severity: 'success', label: 'Published', live };
  if (member.published_time) return { severity: 'info', label: 'Published, edited since', live };
  return { severity: 'info', label: 'Draft', live };
}

const toView = (member: VariantMember, role: VariantRole): VariantMemberView => {
  const { severity, label, live } = memberSeverity(member);
  return { member, role, severity, statusLabel: label, live };
};

const STAGE_LABEL: Record<VariantFamilyStage, string> = {
  drafting: 'Variant drafted',
  both_published: 'Both published',
  settled: 'Winner published',
  dormant: 'Nothing published',
};

const STAGE_SEVERITY: Record<VariantFamilyStage, AdminSeverity> = {
  drafting: 'info',
  // Two live permalinks of the same article is the state a winner selection
  // exists to end — it wants a human, so D4 says needs_you (amber, never red).
  both_published: 'needs_you',
  settled: 'success',
  dormant: 'info',
};

const stageOf = (members: readonly VariantMemberView[]): VariantFamilyStage => {
  const publishedActive = members.filter((view) => view.live);
  if (publishedActive.length === 0) {
    return members.some((view) => view.member.status === 'active') ? 'drafting' : 'dormant';
  }
  if (publishedActive.length === 1) {
    // "Settled" only once the alternatives are actually gone; a lone published
    // parent with a draft clone beside it is still drafting.
    return members.every((view) => view.live || view.member.status === 'archived') ? 'settled' : 'drafting';
  }
  return 'both_published';
};

// ─── families ───────────────────────────────────────────────────────────────

const latest = (members: readonly VariantMemberView[]): string =>
  members.reduce((max, view) => (view.member.updated_at > max ? view.member.updated_at : max), '');

/**
 * Groups articles into variant families by `lineage.parent_content_id`.
 *
 * A family is created by a CLONE, never by a parent: an article nobody has
 * cloned is not an experiment and does not appear. Grandchildren (a clone of a
 * clone — `create_variant` permits it) attach to their immediate parent, which
 * then appears both as that family's head and as a variant inside its own
 * parent's family; the object id in `parentId` disambiguates them.
 *
 * Sorted most-recently-touched first, and the member lists are sorted so the
 * output is stable for the same input regardless of input order.
 */
export function buildVariantFamilies(members: readonly VariantMember[]): VariantFamily[] {
  const byId = new Map(members.map((member) => [member.object_id, member]));
  const childrenOf = new Map<string, VariantMember[]>();

  for (const member of members) {
    const parentId = member.parent_content_id;
    if (!parentId || parentId === member.object_id) continue;
    const bucket = childrenOf.get(parentId);
    if (bucket) bucket.push(member);
    else childrenOf.set(parentId, [member]);
  }

  const families: VariantFamily[] = [];
  for (const [parentId, children] of childrenOf) {
    const parentMember = byId.get(parentId);
    const parent = parentMember ? toView(parentMember, 'parent') : undefined;
    const variants = children
      .slice()
      .sort((a, b) => (a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0))
      .map((child) => toView(child, 'variant'));
    const all = parent ? [parent, ...variants] : variants;
    const stage = stageOf(all);
    families.push({
      parentId,
      ...(parent ? { parent } : {}),
      parentMissing: !parent,
      variants,
      members: all,
      stage,
      stageLabel: STAGE_LABEL[stage],
      stageSeverity: STAGE_SEVERITY[stage],
      updatedAt: latest(all),
    });
  }

  return families.sort((a, b) =>
    a.updatedAt === b.updatedAt ? a.parentId.localeCompare(b.parentId) : b.updatedAt.localeCompare(a.updatedAt)
  );
}

// ─── judged evidence (the only numbers that are real) ───────────────────────

/**
 * `metric:` is the permanent provenance marker 12-plan section 15.1 reserves
 * for a tracking-derived score. Nothing writes one today (section 15 is
 * unruled), so this predicate exists to keep the two apart the moment one
 * appears rather than to filter anything now.
 */
export const isMetricScore = (score: VariantScore): boolean => score.scored_by.startsWith('metric:');

export interface JudgementCell {
  objectId: string;
  score: number;
  scoredBy: string;
  at: string;
  rationale?: string;
  /** True for a `metric:`-namespaced entry — reader behaviour, not agent judgment. */
  metric: boolean;
}

/**
 * One comparable line: the same `(framework, dimension)` judged across the
 * family. `cells` is sparse on purpose — a variant `create_variant` reset and
 * no agent has judged since simply has no entry, and an empty cell says that
 * far better than a zero would.
 */
export interface JudgementRow {
  framework: string;
  dimension: string;
  cells: JudgementCell[];
  /** True when every cell on this row is an agent judgment (all of them, today). */
  agentJudgmentOnly: boolean;
}

/**
 * The family's judged comparison: `body.scores[]` from each member, aligned on
 * `(framework, dimension)`, keeping only the LATEST entry per member per line
 * (scores are append-only by design — section 15.3 rule 1 — so a re-judge adds
 * rather than replaces, and the newest is the current opinion).
 *
 * This is a read-side join over records, exactly as 12-plan section 15.4
 * describes. It is not a metric, not a rate, and not a sample — see
 * `variantEvidence`.
 */
export function judgementRows(family: VariantFamily): JudgementRow[] {
  const rows = new Map<string, JudgementRow>();
  for (const view of family.members) {
    for (const score of view.member.scores ?? []) {
      const key = `${score.framework} ${score.dimension}`;
      let row = rows.get(key);
      if (!row) {
        row = { framework: score.framework, dimension: score.dimension, cells: [], agentJudgmentOnly: true };
        rows.set(key, row);
      }
      const at = row.cells.findIndex((cell) => cell.objectId === view.member.object_id);
      const cell: JudgementCell = {
        objectId: view.member.object_id,
        score: score.score,
        scoredBy: score.scored_by,
        at: score.at,
        ...(score.rationale ? { rationale: score.rationale } : {}),
        metric: isMetricScore(score),
      };
      if (at === -1) row.cells.push(cell);
      else if (score.at >= (row.cells[at]?.at ?? '')) row.cells[at] = cell;
    }
  }
  for (const row of rows.values()) {
    row.agentJudgmentOnly = row.cells.every((cell) => !cell.metric);
    row.cells.sort((a, b) => a.objectId.localeCompare(b.objectId));
  }
  return [...rows.values()].sort((a, b) =>
    a.framework === b.framework ? a.dimension.localeCompare(b.dimension) : a.framework.localeCompare(b.framework)
  );
}

// ─── the honest results surface ─────────────────────────────────────────────

/** One thing an actual experiment would need that this repo does not have. */
export interface EvidenceGap {
  id: 'traffic_split' | 'per_variant_outcomes' | 'metric_scores';
  title: string;
  /** What is missing, in one sentence. */
  detail: string;
  /** Where it would have to come from — a real path in this repo, so it is checkable. */
  source: string;
}

/**
 * The three gaps, stated once, with the file that proves each. Rendered
 * verbatim as the results-surface empty state: this is the "name exactly what
 * is missing and where it would come from" the task asks for, and it is the
 * reason there is no chart and no p-value anywhere in T4.4.
 */
export const EVIDENCE_GAPS: readonly EvidenceGap[] = [
  {
    id: 'traffic_split',
    title: 'No traffic split exists',
    detail:
      'A variant is a separate article with its own slug, so publishing it adds a second permalink rather than splitting traffic to the first. Nothing in this repo assigns a visitor to one of two articles.',
    source:
      'packages/core/lib/article-object/variant.ts:17 — "Serving/traffic-splitting is explicitly out of scope (OQ-W7-2)"',
  },
  {
    id: 'per_variant_outcomes',
    title: 'Per-variant outcomes are not readable here',
    detail:
      'Tracking events carry an object_id, so the numbers exist — but /api/t only forwards them to the owner sink and mirrors them to a blob store nothing in this repo reads back. The join lives in the owner database, outside the CMS boundary.',
    source:
      'packages/core/server/functions/track-ingest.ts (write-only) + docs/cms-architecture/tracking-sink-reference/schema.sql',
  },
  {
    id: 'metric_scores',
    title: 'Metric-derived scores are unruled',
    detail:
      'The design that would carry reader metrics back into a record as scores[] entries is written but not commissioned, and its ruling line is still blank. Until it lands, every score below is an agent judgment.',
    source: 'docs/cms-architecture/12-object-tracking-and-analytics.md section 15 — "DESIGN ONLY, nothing implemented"',
  },
];

export type EvidenceKind =
  /** Nothing has judged any member of this family. */
  | 'none'
  /** Agent judge scores exist and are compared — directional evidence, not a test. */
  | 'agent_judgment'
  /** A `metric:` entry appeared: section 15 shipped and this module needs revisiting. */
  | 'metric_present';

export interface VariantEvidence {
  kind: EvidenceKind;
  rows: JudgementRow[];
  /** Always the full list — the gaps do not stop being true because scores exist. */
  gaps: readonly EvidenceGap[];
  /** One sentence naming what the surface above it is, and is not. */
  headline: string;
  /**
   * Why no significance figure is shown. A two-proportion z-test is the honest
   * default for comparing conversion RATES; there are no rates and no sample
   * sizes here, so computing one would be fabricating both.
   */
  significanceNote: string;
}

const SIGNIFICANCE_NOTE =
  'No significance is calculated. A significance hint needs per-variant sample sizes and outcome counts from concurrent randomized exposure; none of the three exist here, so any figure shown would be invented.';

export function variantEvidence(family: VariantFamily): VariantEvidence {
  const rows = judgementRows(family);
  const kind: EvidenceKind =
    rows.length === 0 ? 'none' : rows.some((row) => !row.agentJudgmentOnly) ? 'metric_present' : 'agent_judgment';
  const headline =
    kind === 'none'
      ? 'Nothing has judged this family yet, and no reader metrics reach this screen.'
      : kind === 'agent_judgment'
        ? 'Agent judgments on the record — directional evidence from sequential exposure, not a randomized test.'
        : 'A metric-derived score is present: the tracking-score design has shipped and this surface needs revisiting.';
  return { kind, rows, gaps: EVIDENCE_GAPS, headline, significanceNote: SIGNIFICANCE_NOTE };
}
