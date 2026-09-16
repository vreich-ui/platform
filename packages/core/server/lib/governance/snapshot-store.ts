/**
 * M3.4 — `snapshots/governance.json`, the ONE place it is written.
 *
 * Every write goes through `writeGovernanceSnapshot` below, exactly as every
 * site-objects record write goes through `objects/record-writer.ts` and every
 * release snapshot goes through `release/snapshot-store.ts`;
 * `tests/netlify/object-inventory-index.test.ts`'s writer-pinning scan fails
 * the build on a `.setJSON` against `GOVERNANCE_SNAPSHOT_KEY` anywhere else.
 *
 * ## Two halves, one blob, one writer
 *
 * The blob carries two facts with two different clocks:
 *
 *   - THE DOCUMENT (`overrides.v1`). Changes only when somebody writes it, and
 *     the places that do call `refreshGovernanceSnapshotAfterWrite`
 *     immediately afterwards. INTEGRATE (wave 2): verified with `rg` against
 *     `putGovernanceDoc` rather than taken on trust, and this list was one
 *     entry wrong. There are THREE callers, not the two named here plus a
 *     learning-mode toggle: `admin-governance`'s `set`/`revert` (refreshes),
 *     `genesis_policy_set` (refreshes), and `admin-agent-chat`'s one-time
 *     `chat_tools` KEY migration, which deliberately does not — see the note
 *     at that call site for why, and note that it changes no policy value.
 *     `admin-agent-chat` only ever READS `learning_mode`; the toggle that
 *     writes it is `admin-governance`'s `set`, already covered. An
 *     Owner who saves a guardrail must not read their own change five minutes
 *     late, which is the same reason `object_publish` refreshes the release
 *     snapshot rather than waiting for its schedule.
 *   - THE PROBE. Changes without us — CMS-Agent goes down, comes back, rotates
 *     a credential — and no write path in this repo observes any of that. So
 *     it needs a clock, and `functions/governance-probe-refresh.ts` is it.
 *
 * Those are two writers of two halves, which is exactly the shape that breaks
 * a blob. So neither of them writes a half: both call this module, and this
 * module always writes a WHOLE snapshot, carrying the half its caller did not
 * bring. A governance write carries the previous probe forward verbatim; a
 * probe pass re-reads the document (one blob read) and carries it. Two passes
 * racing both write a complete, internally consistent snapshot; the loser's
 * only cost is that its facts were overwritten by facts gathered at a similar
 * moment. That is the same reasoning `release/snapshot-store.ts` gives for
 * writing this kind of blob unconditionally rather than under a
 * compare-and-swap: the blob is a re-derivation, never an amendment, so a CAS
 * would buy nothing and leave the loser with nothing written at all.
 *
 * ## What this module deliberately does NOT contain
 *
 * The probe itself. `governance/cms-agent-probe.ts` owns the CMS-Agent call;
 * this module takes a `CmsAgentProbeResult` as a value. That is what lets the
 * write path — which runs inside an Owner's request — import the writer
 * without importing the client that makes cross-service HTTP calls, and it is
 * what lets the read-path repair below be structurally incapable of probing.
 */
import { getGovernanceDoc, type GovernanceBlobStore, type GovernanceDoc } from '../governance-store.js';
import {
  governanceSnapshotSchema,
  isGovernanceSnapshotFresh,
  readGovernanceSnapshot,
  GOVERNANCE_SNAPSHOT_KEY,
  GOVERNANCE_SNAPSHOT_SCHEMA_VERSION,
  type CmsAgentProbeResult,
  type GovernanceSnapshot,
  type GovernanceSnapshotSource,
  type GovernanceSnapshotStore,
} from './snapshot-view.js';

/**
 * The read half is re-exported whole, so every caller keeps its single import
 * and both spellings mean the same thing. Only `./snapshot-view.js` is on the
 * diet — see its header for what may not reach a read path.
 */
export * from './snapshot-view.js';

/**
 * THE writer. Never throws: a snapshot write that failed costs the next read
 * a repair, and it must never fail the governance write or the probe pass
 * that noticed.
 */
export const writeGovernanceSnapshot = async (
  store: GovernanceSnapshotStore,
  snapshot: GovernanceSnapshot
): Promise<boolean> => {
  try {
    await store.setJSON(GOVERNANCE_SNAPSHOT_KEY, governanceSnapshotSchema.parse(snapshot));
    return true;
  } catch (error) {
    console.warn('governance: could not persist snapshots/governance.json; the next read will repair.', error);
    return false;
  }
};

/** Assemble a whole snapshot from the two halves. Pure. */
export const buildGovernanceSnapshot = (options: {
  doc: GovernanceDoc | null;
  probe: CmsAgentProbeResult | null;
  nowMs: number;
  source: GovernanceSnapshotSource;
}): GovernanceSnapshot => ({
  schema_version: GOVERNANCE_SNAPSHOT_SCHEMA_VERSION,
  as_of: new Date(options.nowMs).toISOString(),
  source: options.source,
  doc: options.doc,
  cms_agent_probe: options.probe,
});

/**
 * The write-path spelling, for `admin-governance`, `admin-agent-chat` and
 * `genesis_policy_set`.
 *
 * Best-effort in the strongest sense: the document write it follows is
 * already durable, and nothing here may fail it. The worst case is a snapshot
 * up to one probe pass old — which is the state the schedule guarantees
 * anyway.
 *
 * Carries the previous probe forward. It costs one blob read to find it, and
 * that read is the alternative to the far worse thing: a governance write
 * that blanked `cms_agent_probe` would make every guardrail save look like
 * CMS-Agent had just been forgotten about.
 */
export const refreshGovernanceSnapshotAfterWrite = async (
  store: GovernanceBlobStore,
  doc: GovernanceDoc | null,
  nowMs: number
): Promise<void> => {
  try {
    const snapshotStore = store as unknown as GovernanceSnapshotStore;
    const previous = await readGovernanceSnapshot(snapshotStore);
    await writeGovernanceSnapshot(
      snapshotStore,
      buildGovernanceSnapshot({
        doc,
        probe: previous?.cms_agent_probe ?? null,
        nowMs,
        source: 'governance_write',
      })
    );
  } catch (error) {
    console.warn('governance: post-write snapshot refresh failed; the schedule will repair it.', error);
  }
};

/**
 * The PROBE pass: a fresh probe result, plus the document as it stands.
 *
 * Reads `overrides.v1` rather than carrying the previous snapshot's copy of
 * it, so the schedule is also the repair for a document half that a failed
 * write-path refresh left behind. One extra blob read every five minutes buys
 * that; it is the cheapest self-healing in the wave.
 */
export const refreshGovernanceProbeSnapshot = async (
  store: GovernanceBlobStore,
  probe: CmsAgentProbeResult,
  nowMs: number
): Promise<{ snapshot: GovernanceSnapshot; written: boolean }> => {
  const snapshotStore = store as unknown as GovernanceSnapshotStore;
  let doc: GovernanceDoc | null = null;
  try {
    doc = await getGovernanceDoc(store);
  } catch {
    // A governance store that will not answer is not a reason to lose the
    // probe result. `null` is the same value an absent document has, and the
    // committed policy is what it resolves to either way.
    doc = null;
  }
  const snapshot = buildGovernanceSnapshot({ doc, probe, nowMs, source: 'probe_schedule' });
  const written = await writeGovernanceSnapshot(snapshotStore, snapshot);
  return { snapshot, written };
};

/**
 * THE REPAIR — the old read path, which writes back what it built.
 *
 * Reached when the snapshot is absent, unreadable, unparseable, written by
 * another schema version, or older than `GOVERNANCE_SNAPSHOT_MAX_AGE_MS`. It
 * reads `overrides.v1` — the read `admin-governance` made on every request
 * before this milestone — and stores the result, so the next page view is one
 * blob read again. No script, no per-tenant remediation: the first admin page
 * view on a cold tenant pays one extra blob read, once.
 *
 * IT DOES NOT PROBE, and it cannot: this module has no CMS-Agent client to
 * call. `previous?.cms_agent_probe ?? null` is the whole probe story on a
 * repair — a parseable-but-stale snapshot keeps the last answer it had (and
 * the reader renders it as "last checked hh:mm"), and an absent or corrupt
 * one reports `never_checked` until the schedule runs. That is the decision
 * `cmsAgentProbeView` states in full.
 */
export const repairGovernanceSnapshot = async (
  store: GovernanceBlobStore,
  options: { nowMs: number; previous?: GovernanceSnapshot | undefined }
): Promise<GovernanceSnapshot> => {
  const snapshotStore = store as unknown as GovernanceSnapshotStore;
  let doc: GovernanceDoc | null = null;
  try {
    doc = await getGovernanceDoc(store);
  } catch {
    doc = null;
  }
  const snapshot = buildGovernanceSnapshot({
    doc,
    probe: options.previous?.cms_agent_probe ?? null,
    nowMs: options.nowMs,
    source: 'repair',
  });
  await writeGovernanceSnapshot(snapshotStore, snapshot);
  return snapshot;
};

/**
 * What `admin-governance`'s `get` verb calls: one blob read, and a repair only
 * when that read cannot be trusted.
 *
 * `repaired` is the `stats.rebuilt` idiom — a surface whose every read reports
 * `repaired: true` has a dead schedule and a failing write path, and that is
 * worth being able to see from a response rather than a log.
 */
export const loadGovernanceSnapshot = async (
  store: GovernanceBlobStore,
  nowMs: number
): Promise<{ snapshot: GovernanceSnapshot; repaired: boolean }> => {
  const snapshotStore = store as unknown as GovernanceSnapshotStore;
  const existing = await readGovernanceSnapshot(snapshotStore);
  if (existing && isGovernanceSnapshotFresh(existing, nowMs)) return { snapshot: existing, repaired: false };
  return { snapshot: await repairGovernanceSnapshot(store, { nowMs, previous: existing }), repaired: true };
};
