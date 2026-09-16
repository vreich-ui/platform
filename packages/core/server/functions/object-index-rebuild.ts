/**
 * Function name: Object_Index_Rebuild (M0.2) — scheduled, hourly at :23.
 *
 * The safety net under the TRUSTED inventory index.
 *
 * M0 stopped `objects/index.json` being re-proved against thirteen `store.list()`
 * calls on every read: a warm read now costs two blob reads (the index and the
 * `objects/version` drift alarm) and no listing at all. Three things had to be
 * true for that, and `objects/index-store.ts`'s header names all three. Two of
 * them are enforced in-process — the record-write choke point arms the alarm
 * before it touches a record, and the index write is compare-and-swapped, so an
 * interrupted or raced write always leaves the two docs disagreeing and the next
 * read repairs them.
 *
 * The third has no in-process answer: a write that never went through
 * `objects/record-writer.ts` at all never armed the alarm, so a trusted read
 * cannot know it happened. `tests/netlify/object-inventory-index.test.ts` fails
 * the build on the source shapes that would cause it, but a test pins the code in
 * this repo, not a hand-edited blob, a restored backup, or a store two
 * deployments disagree about. So once a night, per tenant, the projection is
 * rebuilt from the records themselves.
 *
 * Deliberately NOT a new mechanism: it calls `sweepInventoryRows`, which is the
 * very same verified sweep an untrusted read takes — listings, per-key etag
 * checks, a re-read of anything that moved, and one write of the pair. The
 * self-healing law (`AGENTS.md`: self-healing over migrations) says the repair
 * path and the scheduled path must be the same code, and they are: this function
 * is a schedule wrapped around a read.
 *
 * Idempotent, and cheap when there is nothing to do: a store that was already in
 * step reports `wrote: false` and costs thirteen listings and one blob read.
 *
 * Declared per site in netlify.toml (`[functions."object-index-rebuild"]
 * schedule = "23 * * * *"`) — a scheduled function only runs if its schedule is
 * DECLARED (P1: every `sites/<client>/netlify.toml` carries the block, and so
 * does the `create-site.mjs` scaffold). HOURLY, not nightly: the adversarial
 * review (2026-09-16) found that the one drift this wave's compare-and-swap
 * cannot reach — a writer that crashes between its record write and its index
 * commit, then has its alarm re-armed at the same seq by a writer whose read of
 * `objects/version` was stale-low — is SILENT, and its only bound is this
 * sweep. Nightly made that bound a day: an object that exists in the store and
 * is invisible in `/admin/content`, with `index.trusted: true` on the wire.
 * Minute :23 is deliberately clear of the 03:17 membership pass, the 03:41
 * media compaction pass and the two- and five-minute jobs. The price is
 * thirteen listings and one blob read per tenant per hour when nothing moved
 * (`wrote: false`); `docs/KNOWN_ISSUES.md` #71 states the real close, which is
 * a blobs-scoped token that makes `consistency: 'strong'` real.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import { getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { sweepInventoryRows, type ObjectIndexStore } from '../lib/objects/index-store.js';

export const runObjectIndexRebuild = async (event: unknown, nowMs = Date.now(), binding?: SiteBinding) => {
  const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectIndexStore;
  const sweep = await sweepInventoryRows(store, { nowMs });
  return {
    ok: true,
    at: new Date(nowMs).toISOString(),
    /**
     * `read` is the number the operator should watch. A nightly rebuild that
     * keeps re-reading records nothing was supposed to have touched is the
     * signature of a writer outside the choke point — the one failure the
     * trusted read cannot see for itself.
     */
    listed: sweep.stats.listed,
    reprojected: sweep.stats.read,
    from_index: sweep.stats.cached,
    wrote: sweep.stats.wrote,
    rebuilt: sweep.stats.rebuilt,
  };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: unknown) => {
  try {
    const result = await runObjectIndexRebuild(event, Date.now(), binding);
    console.log(JSON.stringify({ ts: result.at, event: 'object_index_rebuild', ...result }));
    return { statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(result) };
  } catch (error) {
    console.error('Object index rebuild failed.', error);
    return { statusCode: 500, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: false }) };
  }
};

/** Per-site factory — the site shim instantiates this with its binding (the `membership-sweep` pattern). */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
