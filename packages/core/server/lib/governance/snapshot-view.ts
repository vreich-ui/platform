/**
 * M3.4 — the READ half of `snapshots/governance.json`: its shape, the pure
 * readings a surface takes of it, and the one blob read that fetches it. No
 * writer, and — the whole point of the milestone — no CMS-Agent client.
 *
 * ## The defect this removes
 *
 * `/admin/visual-identity` paid `governance` 3.9 s, of which `probe = 2768 ms`
 * was a LIVE CMS-Agent health probe made while a person waited for a page. The
 * same function measured `work = 109 ms` two minutes later on
 * `/admin/guardrails`, which is not a fix — it is the memo lottery wave 1
 * already established protects nobody: the memo is module scope, Netlify runs
 * many instances, and a cold one starts with an empty map by construction.
 * Worse, `/admin/visual-identity` reads exactly ONE field off that response
 * (`active.brandImageryOverrides`, `VisualIdentityWorkspace.tsx`) and no admin
 * surface in this repo renders the probe's answer at all.
 *
 * So the probe moves to a clock (`functions/governance-probe-refresh.ts`,
 * every five minutes) and its LAST RESULT is stored in this blob beside the
 * governance document. A page reads one blob. A page never probes.
 *
 * ## Why this is a separate file from `snapshot-store.ts`
 *
 * Same cut `release/snapshot-view.ts` made, for the same reason: the writer
 * drags what the reader can never execute. Here the reader must not reach
 * `agent/cms-agent-client.ts` — the probe client and its transport are the
 * cold-start weight this milestone is removing, and a read path that imports
 * them has only moved the cost from wall clock to boot.
 */
import { z } from 'zod';

import { governanceDocSchema, type GovernanceDoc } from '../governance-store.js';

export const GOVERNANCE_SNAPSHOT_KEY = 'snapshots/governance.json';
export const GOVERNANCE_SNAPSHOT_SCHEMA_VERSION = 'governance-snapshot.v1';

/**
 * How old the blob may be before a READ rebuilds it.
 *
 * The probe schedule runs every five minutes and re-stamps `as_of` on every
 * pass, so this is three missed passes — the same calibration
 * `RELEASE_SNAPSHOT_MAX_AGE_MS` uses against its own two-minute schedule, and
 * for the same reason: forgiving beats trigger-happy, because the cost of
 * lag is a guardrail card that shows a value somebody set a moment ago and
 * the cost of impatience is that a scheduled-function outage turns every
 * admin page view back into a compute.
 *
 * Note what a rebuild does NOT do: it does not probe (see `snapshot-store.ts`,
 * `repairGovernanceSnapshot`). Staleness here is staleness of the DOCUMENT
 * half, which one blob read repairs.
 */
export const GOVERNANCE_SNAPSHOT_MAX_AGE_MS = 15 * 60_000;

/**
 * The bound past which a probe result stops being a STATUS and becomes a
 * TIMESTAMP — "last checked hh:mm" — and never a reason to probe.
 *
 * Also three missed passes of the five-minute schedule. Stating the bound is
 * the point: a reader who can see when the answer was taken can decide what
 * it is worth, which is strictly more than a green dot that might be an hour
 * old and looks exactly like one taken a second ago.
 */
export const CMS_AGENT_PROBE_MAX_AGE_MS = 15 * 60_000;

/**
 * One probe result, as the blob carries it.
 *
 * `reachable` is the whole verdict; `latency_ms` is what the pass measured
 * end to end (handshake included, because a lost session forcing a fresh
 * handshake is exactly the slowness worth seeing); `code`/`message` carry the
 * typed CMS-Agent failure when there is one; `agent_ref` is the proof of a
 * successful `agent_resolve`.
 */
export const cmsAgentProbeResultSchema = z.object({
  checked_at: z.string(),
  reachable: z.boolean(),
  latency_ms: z.number().int().nonnegative(),
  agent_ref: z.string().nullable(),
  code: z.string().nullable(),
  message: z.string().nullable(),
});
export type CmsAgentProbeResult = z.infer<typeof cmsAgentProbeResultSchema>;

export const governanceSnapshotSchema = z.object({
  schema_version: z.literal(GOVERNANCE_SNAPSHOT_SCHEMA_VERSION),
  /** When the DOCUMENT half was gathered. The probe carries its own `checked_at`. */
  as_of: z.string(),
  /** Which writer produced it. Diagnostic only — a store whose snapshot is only ever `repair` has a dead schedule. */
  source: z.enum(['governance_write', 'probe_schedule', 'repair']),
  /**
   * `overrides.v1` as stored. `null` is a real, common state — a tenant that
   * has never overridden anything — and is exactly what `getGovernanceDoc`
   * answers for it, so the snapshot can carry the same value rather than a
   * second spelling of "no overrides".
   */
  doc: governanceDocSchema.nullable(),
  /**
   * The last probe, or `null` for "nobody has ever asked".
   *
   * `null` is deliberately NOT `{reachable: false}`. See
   * `cmsAgentProbeView` below: reporting a service as down on the strength of
   * our own schedule never having run is a wrong red, and a wrong red is
   * worse than no colour.
   */
  cms_agent_probe: cmsAgentProbeResultSchema.nullable(),
});
export type GovernanceSnapshot = z.infer<typeof governanceSnapshotSchema>;
export type GovernanceSnapshotSource = GovernanceSnapshot['source'];

/** The store subset both halves need — `getGovernanceBlobStore`'s shape, narrowed. */
export interface GovernanceSnapshotStore {
  get(key: string): Promise<string | null>;
  setJSON(key: string, value: unknown): Promise<unknown>;
}

// ═══ the read ═════════════════════════════════════════════════════════════

/**
 * ONE blob read. `undefined` covers absent, unreadable, unparseable and
 * written-by-another-schema alike — every one of them means "repair", which
 * is the same answer `release/snapshot-view.ts` gives for its blob and
 * `objects/index-doc.ts` gives for the projection docs.
 */
export const readGovernanceSnapshot = async (
  store: GovernanceSnapshotStore
): Promise<GovernanceSnapshot | undefined> => {
  let raw: string | null;
  try {
    raw = await store.get(GOVERNANCE_SNAPSHOT_KEY);
  } catch {
    return undefined;
  }
  if (!raw) return undefined;
  try {
    const parsed = governanceSnapshotSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
};

export const governanceSnapshotAgeMs = (snapshot: GovernanceSnapshot, nowMs: number): number => {
  const asOf = Date.parse(snapshot.as_of);
  return Number.isFinite(asOf) ? nowMs - asOf : Number.POSITIVE_INFINITY;
};

/** Fresh enough to serve without repairing. An unparseable `as_of` is never fresh. */
export const isGovernanceSnapshotFresh = (snapshot: GovernanceSnapshot, nowMs: number): boolean =>
  governanceSnapshotAgeMs(snapshot, nowMs) <= GOVERNANCE_SNAPSHOT_MAX_AGE_MS;

/**
 * What the wire says about the probe, and the one decision this milestone
 * had to make: WHAT A PAGE SHOWS WHEN THERE HAS NEVER BEEN A PROBE.
 *
 * Three states, and no fourth:
 *
 *   - `never_checked` — `cms_agent_probe` is `null`. The schedule has not run
 *     on this tenant yet (a fresh deploy, a tenant whose scheduled functions
 *     only start on the published production deploy). The page says so in
 *     those words and shows NO health verdict. It does not say "unreachable",
 *     because we did not ask; it does not probe to find out, because the
 *     whole milestone is that a page load never makes that call. `configured`
 *     is still answered — that is an env-var NAME check, no network — so the
 *     genuinely actionable state ("this tenant has no CMS-Agent credentials")
 *     is still visible immediately, which is the one an operator can fix.
 *   - `fresh` — a probe inside `CMS_AGENT_PROBE_MAX_AGE_MS`. Render the
 *     verdict.
 *   - `stale` — older than that. Render "last checked hh:mm" and the verdict
 *     it went with, because a five-minute-old yes and an hour-old yes are not
 *     the same claim. Never a reason to probe.
 *
 * Pure, and the clock arrives as an argument: staleness is a reading taken at
 * a moment, never a fact frozen into the blob (the same rule
 * `release/snapshot-view.ts` applies to `deploy.state`).
 */
export type CmsAgentProbeView =
  | { state: 'never_checked' }
  | ({ state: 'fresh' | 'stale'; age_ms: number } & CmsAgentProbeResult);

export const cmsAgentProbeView = (
  probe: CmsAgentProbeResult | null | undefined,
  nowMs: number
): CmsAgentProbeView => {
  if (!probe) return { state: 'never_checked' };
  const checkedAt = Date.parse(probe.checked_at);
  const ageMs = Number.isFinite(checkedAt) ? nowMs - checkedAt : Number.POSITIVE_INFINITY;
  return { ...probe, state: ageMs <= CMS_AGENT_PROBE_MAX_AGE_MS ? 'fresh' : 'stale', age_ms: ageMs };
};

/**
 * The `health` block the `get` wire has always carried, derived from the
 * stored probe instead of a live call.
 *
 * `undefined` when there has never been a probe, which is exactly what the
 * pre-M3.4 `cmsAgentStatus` did with a probe it never made (an unconfigured
 * tenant): the key is simply absent. So a client that reads `health` sees no
 * new shape, and one that reads `probe` (below it on the wire) gets the
 * honest three-state answer.
 */
export const cmsAgentHealthFromProbe = (
  probe: CmsAgentProbeResult | null | undefined
): Record<string, unknown> | undefined => {
  if (!probe) return undefined;
  return probe.reachable
    ? { ok: true, agent_ref: probe.agent_ref }
    : { ok: false, code: probe.code ?? 'cms_agent_unreachable', message: probe.message ?? '' };
};

/** The doc as the read paths consume it — `null` when the tenant overrides nothing. */
export const governanceDocFromSnapshot = (snapshot: GovernanceSnapshot): GovernanceDoc | null => snapshot.doc;
