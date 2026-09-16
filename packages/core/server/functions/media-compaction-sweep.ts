/**
 * Function name: Media_Compaction_Sweep (W4) — SCHEDULED, daily at 41 3.
 *
 * This function does NO work. It mints a one-shot token and hands the job to
 * `media-compaction-sweep-background`, exactly as `editorial-request-sweep`
 * hands its candidates to `editorial-request-sweep-background`.
 *
 * WHY, measured on zilbermanfilmfoundation 2026-09-16. The sweep used to run
 * inline here and was killed by Netlify's 30 s scheduled-function wall every
 * single time — which was invisible twice over: Netlify's function log shows
 * NOTHING for this function, not even a timeout line, so three days of dead
 * runs looked exactly like "the schedule never fired", and the run's own
 * 20 s checkpoint never helped because the kill lands in the ONE-TIME
 * collection phase at the top of a run (a full-projection walk of every active
 * object, plus a listing of the whole artifact plane), which has no page
 * boundary to stop at. A manual "Run now" wrote `startedAtISO` at 09:29:12 and
 * still had no `finishedAtISO` 95 s later. A background function gets 15
 * minutes, and a function cannot be both scheduled and background — hence the
 * pair.
 *
 * A lost POST is not a problem: the next tick mints a new token and tries
 * again, and the run is resumable and idempotent by construction.
 *
 * Declared per site in netlify.toml (`[functions."media-compaction-sweep"]
 * schedule = "41 3 * * *"`, after membership-sweep at 17 3) — a scheduled
 * function only runs if its schedule is DECLARED (every
 * `sites/<client>/netlify.toml` carries the block; `admin-parity.mjs` checks
 * it, `create-site.mjs` writes it into every new tenant).
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { mintMediaCompactionTriggerToken } from '../lib/media-compaction-heartbeat.js';

/** The worker this tick starts. Public HTTP, so the token is what authorizes it. */
export const MEDIA_COMPACTION_BACKGROUND_PATH = '/.netlify/functions/media-compaction-sweep-background';

export const dispatchMediaCompactionSweep = async (event: unknown, binding?: SiteBinding) => {
  const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
  const base = process.env.URL;
  if (!base) return { dispatched: false, reason: 'no_site_url' as const };

  const triggerToken = await mintMediaCompactionTriggerToken(indexStore);

  try {
    await fetch(`${base}${MEDIA_COMPACTION_BACKGROUND_PATH}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_token: triggerToken }),
    });
    return { dispatched: true as const };
  } catch (error) {
    console.error('media compaction dispatch failed', error);
    return { dispatched: false, reason: 'fetch_failed' as const };
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await dispatchMediaCompactionSweep(event, binding);
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'media_compaction_dispatch',
        site: binding.siteId,
        ...result,
      })
    );
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Media compaction dispatch failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);

/**
 * Re-exported so the run keeps ONE public name across the split: tests, the
 * worker and any operator tooling still reach it as
 * `functions/media-compaction-sweep`.
 */
export {
  runMediaCompactionSweep,
  ORPHAN_GRACE_MS,
  COMPACTION_ACTOR,
  SWEEP_BUDGET_MS,
  type MediaCompactionSweepResult,
} from '../lib/media-compaction-run.js';
