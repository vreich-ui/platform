/**
 * W4 (Wolf, 2026-09-15) — the compaction run's own receipt, written to the
 * artifact-index store.
 *
 * Why a receipt exists at all: `media-compaction-sweep` was deployed to every
 * tenant on 2026-09-13 with a correct schedule block, a correct shim and a
 * correct deploy manifest (`function_schedules` carries
 * `media-compaction-sweep 41 3 * * *`), and then produced NOTHING — no
 * soft-deletes, no dedupe, and not one line in Netlify's function log, on any
 * tenant, for two days, while `membership-sweep` logged a clean run every
 * morning from the same deploys. A scheduled job whose only interface is a log
 * line is a job that can fail completely and invisibly, and the only reason
 * anyone noticed is that Wolf went and looked at two blobs by hand.
 *
 * So the run writes its own evidence, in the store, where the next run, the
 * membership sweep and any operator can read it without Netlify's log
 * pipeline:
 *
 *   - `startedAtISO` is written BEFORE any work. A receipt with a start and no
 *     finish is an invocation that died mid-run (timeout, OOM, throw) — the one
 *     failure mode a log-only interface hides.
 *   - `finishedAtISO` + `totals` are the completed run's numbers.
 *   - `resume` carries the cursors, so a run that stops on the clock resumes
 *     where it left off instead of starting the same first page for ever.
 *
 * The key lives under `maintenance/`, outside both prefixes the sweep walks
 * (`request-artifacts/`, `by-slot/`), so it can never be mistaken for an
 * artifact reference by the very pass that writes it.
 */
import type { ArtifactIndexStore } from './artifact-index.js';

export const MEDIA_COMPACTION_HEARTBEAT_KEY = 'maintenance/media-compaction-sweep.json';

/** Where the scheduled tick leaves the one-shot token its worker must present. */
export const MEDIA_COMPACTION_TRIGGER_KEY = 'maintenance/media-compaction-trigger.json';

/** Cursors for the two passes. `null` means "this pass finished its cycle". */
export type MediaCompactionResume = {
  orphanCursor: number | null;
  dedupeCursor: number | null;
};

export type MediaCompactionHeartbeat = {
  schema: 'media_compaction_heartbeat.v1';
  startedAtISO: string;
  finishedAtISO: string | null;
  ok: boolean | null;
  error: string | null;
  resume: MediaCompactionResume;
  totals: Record<string, unknown> | null;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value && typeof value === 'object' && !Array.isArray(value));

const cursorOf = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

/** Missing OR unreadable → null: a corrupt receipt must never stop a sweep. */
export const readMediaCompactionHeartbeat = async (
  indexStore: ArtifactIndexStore
): Promise<MediaCompactionHeartbeat | null> => {
  let parsed: unknown;
  try {
    const raw = await indexStore.get(MEDIA_COMPACTION_HEARTBEAT_KEY);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isRecord(parsed) || parsed.schema !== 'media_compaction_heartbeat.v1') return null;
  const resume = isRecord(parsed.resume) ? parsed.resume : {};

  return {
    schema: 'media_compaction_heartbeat.v1',
    startedAtISO: typeof parsed.startedAtISO === 'string' ? parsed.startedAtISO : '',
    finishedAtISO: typeof parsed.finishedAtISO === 'string' ? parsed.finishedAtISO : null,
    ok: typeof parsed.ok === 'boolean' ? parsed.ok : null,
    error: typeof parsed.error === 'string' ? parsed.error : null,
    resume: { orphanCursor: cursorOf(resume.orphanCursor), dedupeCursor: cursorOf(resume.dedupeCursor) },
    totals: isRecord(parsed.totals) ? parsed.totals : null,
  };
};

/** Best effort: a store that refuses the receipt must not fail the sweep. */
export const writeMediaCompactionHeartbeat = async (
  indexStore: ArtifactIndexStore,
  heartbeat: MediaCompactionHeartbeat
): Promise<boolean> => {
  try {
    await indexStore.setJSON(MEDIA_COMPACTION_HEARTBEAT_KEY, heartbeat);
    return true;
  } catch (error) {
    console.warn('[media-compaction] heartbeat write failed', error);
    return false;
  }
};

/**
 * Hours since the last COMPLETED run, or null when none was ever recorded.
 * `membership-sweep` reports this daily (it is the one scheduled function in
 * this fleet with an unbroken run record), so "compaction has not completed in
 * N hours" shows up in a log line that is known to be written.
 */
export const mediaCompactionAgeHours = (
  heartbeat: MediaCompactionHeartbeat | null,
  now = new Date().toISOString()
): number | null => {
  if (!heartbeat?.finishedAtISO) return null;
  const finished = Date.parse(heartbeat.finishedAtISO);
  const nowMs = Date.parse(now);
  if (!Number.isFinite(finished) || !Number.isFinite(nowMs)) return null;
  return Math.round(((nowMs - finished) / 3_600_000) * 10) / 10;
};

/** A cycle is stale once a daily job has had a full extra day to finish it. */
export const MEDIA_COMPACTION_STALE_HOURS = 25;


/**
 * The one-shot trigger token, the same mechanic `editorial-request-sweep` uses.
 *
 * A `-background` function is a PUBLIC HTTP endpoint and this one's side effects
 * are real (soft-deletes and byte deletes across the whole artifact plane), so
 * an unauthenticated POST must not be able to start one. Minting also
 * INVALIDATES any earlier token, so a pass still running when the next tick
 * fires cannot be joined by a second.
 */
export const mintMediaCompactionTriggerToken = async (indexStore: ArtifactIndexStore): Promise<string> => {
  const token = `mcs_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 12)}`;
  await indexStore.setJSON(MEDIA_COMPACTION_TRIGGER_KEY, { token, mintedAtISO: new Date().toISOString() });
  return token;
};

/** True exactly once per minted token; every replay and every forged POST is false. */
export const consumeMediaCompactionTriggerToken = async (
  indexStore: ArtifactIndexStore,
  token: string
): Promise<boolean> => {
  let stored: unknown;
  try {
    const raw = await indexStore.get(MEDIA_COMPACTION_TRIGGER_KEY);
    if (!raw) return false;
    stored = JSON.parse(raw);
  } catch {
    return false;
  }

  if (!isRecord(stored) || typeof stored.token !== 'string' || stored.token !== token) return false;

  await indexStore.setJSON(MEDIA_COMPACTION_TRIGGER_KEY, { token: null, consumedAtISO: new Date().toISOString() });
  return true;
};
