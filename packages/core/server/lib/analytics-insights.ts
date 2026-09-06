/**
 * Analytics insights (T21.36; runner R11.5) — the RAW CMS-Agent shape
 * guessing behind `admin-analytics.ts`'s `?source=insights` branch,
 * deliberately kept out of `lib/admin/analytics-insights-logic.ts` (the
 * `netlify-analytics.ts` precedent: raw upstream JSON parsing stays
 * server-side and untested-in-lib; the pure module only shapes what this
 * file already normalized).
 *
 * The four calls, verified live against CMS-Agent on 2026-09-05 (not
 * guessed from a doc — none of these tools are documented in THIS repo):
 *
 *  - `feedback_list({kind:'outcome'})` → `{records:[{feedbackId, kind,
 *    nodeId, runId, outcome:{source, metrics:{...}}, actor, note,
 *    createdAt}]}`. `nodeId` IS the producer (`plugin:claude`,
 *    `plugin:openai-agent`); the evidence WINDOW lives only in the
 *    free-text `note` field (`"window 2026-08-22..2026-09-05"`) — there is
 *    no structured `window_start`/`window_end` on the wire, so
 *    `parseWindowFromNote` below is load-bearing, not decorative; `n` is
 *    `outcome.metrics.sessions`.
 *  - `playbook_get({nodeId})` → `{playbook: null | {...}, rendered}`.
 *    NODE-SCOPED — there is no "list every playbook" tool — so this module
 *    calls it once per distinct producer `nodeId` seen in (1). A tenant
 *    with no playbook yet on a node gets `playbook: null` (verified live:
 *    both `plugin:claude` and `plugin:openai-agent` on dr-lurie return this
 *    today) — a real, honest "nothing here", not a fetch failure.
 *  - `optimizer_status({})` (no `nodeId` — the global roll-up) →
 *    `{status:{proposals:[...], trials:[...]}}`. Verified live: empty on
 *    dr-lurie today.
 *  - `learning_list_observations({})` → `{observations:[{id, observation,
 *    createdAt, runId?, nodeId?, metadata?}]}`. Verified live: dozens of
 *    rows, NONE carrying a `tracking:strategy.v1` source tag today — this
 *    tool predates the tracking-strategy job and is a general fleet
 *    learning log (build/publish failures, workflow notes) with no project
 *    scoping visible on the wire, so the `tracking:strategy.v1` source
 *    filter (§ below) is the ONLY predicate this module applies, exactly as
 *    the task specifies — it is not safe to also assume every row belongs
 *    to this tenant.
 *
 * None of these four tools accept a `project_id` argument (checked against
 * their actual schemas, not assumed from `agent_converse`/
 * `visual_identity_propose`'s convention) — the per-site `CmsAgentClient`
 * (env-scoped bearer, "one client per site binding") is what scopes every
 * call to this tenant's own CMS-Agent workspace.
 *
 * Every one of the four fetches is independent and never throws past this
 * module — a failure on one degrades ONLY that section (mirrors R6.2's
 * `admin-analytics.ts` own doc: "a failure on any one never blocks the
 * primary series").
 */
import { CmsAgentClient, cmsAgentMissingEnvVars, type CmsAgentResult } from './agent/cms-agent-client.js';
import {
  type InsightsOverview,
  type InsightsSectionPayload,
  type TrackingOutcomeRow,
  type TrackingOutcomeMetrics,
  type PlaybookTrackingItem,
  type OptimizerProposalRow,
  type StrategyObservationRow,
  type InsightsEvidence,
} from '../../lib/admin/analytics-insights-logic.js';

const cmsAgentClient = new CmsAgentClient();

/** How many distinct producer nodes get a `playbook_get` call — bounded fanout, not "one call per row". */
const MAX_PLAYBOOK_NODES = 10;
/** How many outcome rows the tab shows — "latest", not "all of history". */
const OUTCOMES_DISPLAY_LIMIT = 20;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * CMS-Agent's own wrapper key for each list-shaped tool isn't pinned
 * anywhere in this repo (feedback_list uses `records`, learning_list_observations
 * uses `observations` — verified live — the other two are unverified since
 * they're empty on every tenant we could check). Checking a short list of
 * plausible keys, rather than assuming one, means a wrapper-key rename
 * upstream degrades this section to "empty", never a crash.
 */
export function extractArray(data: unknown, keys: readonly string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (!isRecord(data)) return [];
  for (const key of keys) {
    const value = data[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function readString(row: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
}

function readNumber(row: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/**
 * `"window 2026-08-22..2026-09-05"` → `{start,end}`. Verified against every
 * live `feedback_list` row on 2026-09-05 (all five used this exact
 * grammar). Anything else (a note with no window mention, a hand-typed
 * note) degrades to `null` — `formatEvidence` (the lib module) turns that
 * into the honest "no evidence window recorded" sentence, never a guess.
 */
const WINDOW_NOTE_RE = /window\s+(\S+)\.\.(\S+)/i;

export function parseWindowFromNote(note: string | undefined): { start: string; end: string } | null {
  if (!note) return null;
  const match = WINDOW_NOTE_RE.exec(note);
  return match ? { start: match[1]!, end: match[2]! } : null;
}

/** Structured window fields, when a record carries them directly — checked before falling back to free-text parsing. */
export function readEvidence(row: Record<string, unknown>, noteFallback?: string): InsightsEvidence {
  const block = isRecord(row.evidence) ? row.evidence : row;
  const structuredStart = readString(block, ['window_start', 'windowStart', 'from', 'start']);
  const structuredEnd = readString(block, ['window_end', 'windowEnd', 'to', 'end']);
  const parsedFromNote = structuredStart && structuredEnd ? null : parseWindowFromNote(noteFallback);
  return {
    windowStart: structuredStart ?? parsedFromNote?.start ?? null,
    windowEnd: structuredEnd ?? parsedFromNote?.end ?? null,
    n: readNumber(block, ['n', 'n_sessions', 'sample_size', 'count', 'sessions']) ?? null,
  };
}

const humanFailureMessage = <T>(result: CmsAgentResult<T> & { ok: false }): string => result.message;

// ─── section 1: tracking:engagement.v1 outcomes ────────────────────────────

const TRACKING_ENGAGEMENT_SOURCE = 'tracking:engagement.v1';

export function normalizeOutcomeRow(raw: unknown): TrackingOutcomeRow | null {
  if (!isRecord(raw)) return null;
  const outcome = isRecord(raw.outcome) ? raw.outcome : undefined;
  const source = outcome ? readString(outcome, ['source']) : readString(raw, ['source']);
  if (source !== TRACKING_ENGAGEMENT_SOURCE) return null;

  const id = readString(raw, ['feedbackId', 'id']);
  if (!id) return null;
  const producer = readString(raw, ['nodeId', 'producer']) ?? 'unknown producer';
  const rawMetrics = outcome && isRecord(outcome.metrics) ? outcome.metrics : {};
  const metrics: TrackingOutcomeMetrics = {
    pageviews: readNumber(rawMetrics, ['pageviews']),
    exposures: readNumber(rawMetrics, ['exposures']),
    sessions: readNumber(rawMetrics, ['sessions']),
    completion_rate: readNumber(rawMetrics, ['completion_rate']),
    cta_ctr: readNumber(rawMetrics, ['cta_ctr']),
    purchase_rate: readNumber(rawMetrics, ['purchase_rate']),
    revenue_cents: readNumber(rawMetrics, ['revenue_cents']),
    p75_dwell_ms: readNumber(rawMetrics, ['p75_dwell_ms']),
  };
  const note = readString(raw, ['note']);
  const evidence = readEvidence(raw, note);
  // `n` for an engagement outcome is its session count, not a generic
  // "count" field the record may not carry — override whatever
  // `readEvidence` found generically.
  evidence.n = typeof metrics.sessions === 'number' ? metrics.sessions : evidence.n;

  return {
    id,
    producer,
    runId: readString(raw, ['runId']) ?? null,
    createdAt: readString(raw, ['createdAt']) ?? null,
    metrics,
    evidence,
  };
}

interface OutcomesFetchResult {
  payload: InsightsSectionPayload<TrackingOutcomeRow>;
  /** Distinct producer nodeIds seen — feeds the playbook fetch below (playbook_get is node-scoped). */
  producers: string[];
}

async function fetchOutcomesSection(client: CmsAgentClient): Promise<OutcomesFetchResult> {
  const result = await client.callTool<unknown>('feedback_list', { kind: 'outcome', limit: 200 });
  if (!result.ok) return { payload: { message: humanFailureMessage(result) }, producers: [] };

  const rows = extractArray(result.data, ['records', 'items', 'feedback', 'rows'])
    .map(normalizeOutcomeRow)
    .filter((row): row is TrackingOutcomeRow => row !== null)
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .slice(0, OUTCOMES_DISPLAY_LIMIT);

  const producers = [...new Set(rows.map((row) => row.producer))];
  return { payload: { rows }, producers };
}

// ─── section 2: playbook items citing tracking ─────────────────────────────

export function itemEvidenceSources(item: Record<string, unknown>): string[] {
  const sources = new Set<string>();
  const direct = readString(item, ['source']);
  if (direct) sources.add(direct);

  const evidenceList = Array.isArray(item.evidence) ? item.evidence : [];
  for (const entry of evidenceList) {
    if (isRecord(entry)) {
      const s = readString(entry, ['source', 'provenance', 'type']);
      if (s) sources.add(s);
    } else if (typeof entry === 'string') {
      sources.add(entry);
    }
  }

  const provenance = item.provenance;
  if (isRecord(provenance)) {
    const s = readString(provenance, ['source']);
    if (s) sources.add(s);
  } else if (typeof provenance === 'string') {
    sources.add(provenance);
  }

  return [...sources];
}

export function normalizePlaybookItem(nodeId: string, raw: unknown): PlaybookTrackingItem | null {
  if (!isRecord(raw)) return null;
  const sources = itemEvidenceSources(raw);
  if (!sources.some((source) => source.toLowerCase() === 'tracking')) return null;

  const id = readString(raw, ['id', 'itemId']) ?? `${nodeId}:${sources.join(',')}:${Math.random().toString(36).slice(2)}`;
  const text = readString(raw, ['text', 'lesson', 'title', 'summary']) ?? 'Playbook item';
  return { id, nodeId, text, evidenceSources: sources, evidence: readEvidence(raw) };
}

async function fetchPlaybookSection(
  client: CmsAgentClient,
  producers: string[]
): Promise<InsightsSectionPayload<PlaybookTrackingItem>> {
  if (producers.length === 0) return { rows: [] };

  const nodeIds = producers.slice(0, MAX_PLAYBOOK_NODES);
  const results = await Promise.all(nodeIds.map((nodeId) => client.callTool<unknown>('playbook_get', { nodeId })));

  const failures = results.filter((result): result is CmsAgentResult<unknown> & { ok: false } => !result.ok);
  // A roll-up across nodes: one unreadable node must not blank the others.
  // Only surface a hard error when EVERY node failed — otherwise render
  // whatever succeeded (possibly zero items, a real empty state).
  if (failures.length === results.length && results.length > 0) {
    return { message: humanFailureMessage(failures[0]!) };
  }

  const rows: PlaybookTrackingItem[] = [];
  results.forEach((result, index) => {
    if (!result.ok) return;
    const nodeId = nodeIds[index]!;
    const playbook = isRecord(result.data) ? result.data.playbook : undefined;
    if (!isRecord(playbook)) return; // `playbook: null` — no playbook on this node yet, not a failure.
    for (const raw of extractArray(playbook, ['items', 'lessons', 'entries'])) {
      const item = normalizePlaybookItem(nodeId, raw);
      if (item) rows.push(item);
    }
  });
  return { rows };
}

// ─── section 3: open optimizer proposals ───────────────────────────────────

/** Proposal lifecycle terminology isn't pinned in this repo's tools — treat anything not clearly settled as still open, defaulting a missing status to open (a brand-new proposal has nothing else to be). */
const TERMINAL_PROPOSAL_STATUSES = new Set([
  'promoted',
  'rejected',
  'applied',
  'archived',
  'closed',
  'discarded',
  'declined',
]);

export function isOpenProposalStatus(status: string | undefined): boolean {
  if (!status) return true;
  return !TERMINAL_PROPOSAL_STATUSES.has(status.toLowerCase());
}

export function normalizeProposalRow(raw: unknown): OptimizerProposalRow | null {
  if (!isRecord(raw)) return null;
  const status = readString(raw, ['status', 'state']);
  if (!isOpenProposalStatus(status)) return null;
  const id = readString(raw, ['id', 'proposalId']);
  if (!id) return null;
  return {
    id,
    nodeId: readString(raw, ['nodeId']) ?? null,
    title: readString(raw, ['title', 'summary', 'description']) ?? 'Optimizer proposal',
    status: status ?? 'open',
    createdAt: readString(raw, ['createdAt', 'proposedAt', 'timestamp']) ?? null,
    evidence: readEvidence(raw),
  };
}

async function fetchProposalsSection(client: CmsAgentClient): Promise<InsightsSectionPayload<OptimizerProposalRow>> {
  const result = await client.callTool<unknown>('optimizer_status', {});
  if (!result.ok) return { message: humanFailureMessage(result) };

  const statusBlock = isRecord(result.data) ? (result.data.status ?? result.data) : result.data;
  const rows = extractArray(statusBlock, ['proposals', 'items', 'rows'])
    .map(normalizeProposalRow)
    .filter((row): row is OptimizerProposalRow => row !== null);
  return { rows };
}

// ─── section 4: tracking:strategy.v1 observations ──────────────────────────

const TRACKING_STRATEGY_SOURCE = 'tracking:strategy.v1';

export function observationSource(raw: Record<string, unknown>): string | undefined {
  const metadata = isRecord(raw.metadata) ? raw.metadata : undefined;
  return (
    readString(raw, ['source', 'schema']) ??
    (metadata ? readString(metadata, ['source', 'schema']) : undefined) ??
    // The job hasn't shipped on any tenant yet (task brief, verbatim) — no
    // live example exists to confirm the field name, so a last-resort
    // substring check on the free-text `observation` catches an early,
    // undocumented shape without over-fitting to a guessed field name.
    (typeof raw.observation === 'string' && raw.observation.includes(TRACKING_STRATEGY_SOURCE)
      ? TRACKING_STRATEGY_SOURCE
      : undefined)
  );
}

export function normalizeStrategyObservation(raw: unknown): StrategyObservationRow | null {
  if (!isRecord(raw)) return null;
  if (observationSource(raw) !== TRACKING_STRATEGY_SOURCE) return null;

  const id = readString(raw, ['id']);
  if (!id) return null;
  const label = readString(raw, ['label', 'title', 'statistic', 'observation']) ?? 'Strategy observation';
  return { id, label, evidence: readEvidence(raw) };
}

async function fetchStrategySection(
  client: CmsAgentClient
): Promise<InsightsSectionPayload<StrategyObservationRow>> {
  const result = await client.callTool<unknown>('learning_list_observations', {});
  if (!result.ok) return { message: humanFailureMessage(result) };

  const rows = extractArray(result.data, ['observations', 'items', 'rows'])
    .map(normalizeStrategyObservation)
    .filter((row): row is StrategyObservationRow => row !== null);
  return { rows };
}

// ─── top level ──────────────────────────────────────────────────────────────

export async function fetchAnalyticsInsights(): Promise<InsightsOverview> {
  const missing = cmsAgentMissingEnvVars();
  if (missing.length > 0) {
    return {
      configured: false,
      message: 'CMS-Agent is not configured for this site. Set the CMS-Agent endpoint/token this deployment already uses for chat.',
    };
  }

  const [outcomesResult, proposals, strategyObservations] = await Promise.all([
    fetchOutcomesSection(cmsAgentClient),
    fetchProposalsSection(cmsAgentClient),
    fetchStrategySection(cmsAgentClient),
  ]);
  // Playbook lookups need the producers the outcomes fetch just found
  // (playbook_get is node-scoped) — this is the one section that can't run
  // fully in parallel with the others.
  const playbookItems = await fetchPlaybookSection(cmsAgentClient, outcomesResult.producers);

  return {
    configured: true,
    outcomes: outcomesResult.payload,
    playbookItems,
    proposals,
    strategyObservations,
  };
}
