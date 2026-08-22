/**
 * Function name: Editorial_Request_Sweep (W19 T19.3) — SCHEDULED, every 5
 * minutes (plan D1).
 *
 * This is the function that makes "close the window and come back" true. It
 * deliberately does NOT call CMS-Agent itself: a slow bridge must not be able
 * to blow the scheduled invocation. It reads the index, picks the non-terminal
 * requests, and hands them to the background worker, which owns the 15-minute
 * budget.
 *
 * A scheduled function only runs if its schedule is DECLARED in the site's
 * `netlify.toml` — the block declaring a five-minute schedule for it.
 * P1: every `sites/<client>/netlify.toml` carries the block; the parity audit
 * checks it.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getEditorialRequestsBlobStore } from '../lib/blob-store.js';
import { loadIndex, mintSweepToken, rebuildIndex } from '../lib/requests/store.js';
import { selectSweepable } from '../lib/requests/sweep.js';

/**
 * Fire-and-forget: a lost POST simply means the next tick does the work. The
 * one-shot token is what authorizes the worker — a background function is a
 * public endpoint, so an unauthenticated POST must not be able to spend model
 * budget on nudges.
 */
const triggerWorker = async (triggerToken: string, requestIds: string[]): Promise<boolean> => {
  const base = process.env.URL;
  if (!base || requestIds.length === 0) return false;
  try {
    await fetch(`${base}/.netlify/functions/editorial-request-sweep-background`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger_token: triggerToken, request_ids: requestIds }),
    });
    return true;
  } catch (error) {
    console.error('editorial request sweep trigger failed', error);
    return false;
  }
};

export const runEditorialRequestSweep = async (event: unknown) => {
  const store = await getEditorialRequestsBlobStore(event);
  const index = (await loadIndex(store)) ?? (await rebuildIndex(store));
  const requestIds = selectSweepable(index.rows);
  // Minting a fresh token also invalidates any earlier one, so a pass that is
  // still running when the next tick fires cannot be joined by a second.
  const dispatched = requestIds.length ? await triggerWorker(await mintSweepToken(store), requestIds) : false;
  console.info('editorial request sweep', { candidates: requestIds.length, dispatched });
  return { candidates: requestIds.length, dispatched };
};

const buildHandlerImpl = (_binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runEditorialRequestSweep(event);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Editorial_Request_Sweep failed.', error);
    return { statusCode: 500, body: 'sweep failed' };
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
