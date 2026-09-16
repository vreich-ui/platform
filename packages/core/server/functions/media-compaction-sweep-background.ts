/**
 * Function name: Media_Compaction_Sweep_Run (W4) — Netlify BACKGROUND function
 * (`-background` suffix: 202 to the caller, 15-minute budget).
 *
 * The worker the daily scheduled tick dispatches. It runs the actual compaction
 * — orphan sweep, then by-sha dedupe — which does not fit inside a scheduled
 * function's 30 s wall on a real tenant: see the dispatcher's header for the
 * measurement that moved it here.
 *
 * AUTHORIZATION is the one-shot token the tick minted into the artifact index,
 * consumed on start (the mechanic `editorial-request-sweep-background` uses). A
 * background function is a PUBLIC HTTP endpoint and this one deletes bytes, so
 * an unauthenticated POST must not be able to start one. Consuming the token
 * also means two passes can never overlap.
 *
 * The run still watches its own clock and still checkpoints: `SWEEP_BUDGET_MS`
 * is raised here to 13 minutes, inside the 15-minute budget, and anything left
 * resumes from the receipt's cursors on the next day's tick.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getArtifactIndexBlobStore } from '../lib/blob-store.js';
import type { ArtifactIndexStore } from '../lib/artifact-index.js';
import { consumeMediaCompactionTriggerToken } from '../lib/media-compaction-heartbeat.js';
import { runMediaCompactionSweep } from '../lib/media-compaction-run.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
};
type LambdaContext = { getRemainingTimeInMillis?: () => number };

/** 13 minutes of a 15-minute budget; the remainder is the checkpoint write. */
export const BACKGROUND_BUDGET_MS = 13 * 60 * 1000;

const parseToken = (event: LambdaEvent): string | null => {
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    const parsed = JSON.parse(raw || '{}') as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const token = (parsed as { trigger_token?: unknown }).trigger_token;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method not allowed' };

  const token = parseToken(event);
  if (!token) return { statusCode: 400, body: 'Invalid body' };

  const indexStore = (await getArtifactIndexBlobStore(event, binding)) as unknown as ArtifactIndexStore;
  if (!(await consumeMediaCompactionTriggerToken(indexStore, token))) {
    // A replay, a forged POST, or a token a later tick already replaced.
    // 409-shaped refusal: the caller is a scheduler, and there is nothing to retry.
    console.warn('media compaction run refused: bad or spent trigger token');
    return { statusCode: 409, body: 'stale or unknown trigger token' };
  }

  try {
    const result = await runMediaCompactionSweep(event, undefined, binding, {
      budgetMs: BACKGROUND_BUDGET_MS,
      ...(context?.getRemainingTimeInMillis ? { remainingMs: () => context.getRemainingTimeInMillis!() } : {}),
    });
    console.log(
      JSON.stringify({ ts: result.at, event: 'media_compaction_sweep', site: binding.siteId, ...result })
    );
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Media compaction sweep failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
