/**
 * Release-state client (T5.1 R2 / T0.2 F2).
 *
 * `admin-release-state` WAS the most expensive read in the admin: the handler
 * ran its own full object-store inventory sweep, then called the Netlify
 * deploys API twice, then GitHub's `/compare` once per distinct publish
 * commit. T0.2 found SEVEN call sites for it and — worse — several on the
 * SAME page load (`/admin/content/<id>` fired it twice; the objects plane
 * has two independent effects that both want it). Since M1 the server side is
 * three parallel blob reads and no external call, but the call-site count has
 * not changed, so the dedupe below is still what keeps one page load to one
 * request.
 *
 * This module gives it the shape `library-client.ts` already has: a
 * module-scope TTL cache plus in-flight dedupe. Module scope matters — the
 * admin is client-side routed by Astro's `<ClientRouter>` (`Layout.astro`),
 * so the ES module registry survives a navigation even though the React tree
 * does not. Combined with T5.1's `navigate()` sweep (R4), one overview now
 * serves a whole visit rather than one mount.
 *
 * There is no `sessionStorage` mirror on purpose. Inventory rows are
 * cosmetic if slightly stale; release state drives publish/approval
 * affordances, so it must never be painted from a previous page's snapshot
 * without a live fetch behind it.
 *
 * M2.2: `fetchReleaseOverviewViaShell` adds one more source ahead of the
 * network — this navigation's coalesced `admin-shell` boot, which carries the
 * `release` section for free alongside `access`/`me`/`requests`/`inventory`
 * whenever this tenant has a `snapshots/release.json` (see `admin-shell.ts`'s
 * own header for why an absent one answers `skipped` rather than rebuilding on
 * a page path). A `skipped` or `error`
 * section, or the section already taken this generation, is `null` from
 * `takeAdminShellSection` and this module falls back to
 * `fetchReleaseOverview` exactly as it does today — the two-reasons refusal
 * this file's header already explains does not change.
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { EditorialObjectState } from './editorial-state.js';
import { currentPageSignal } from './page-generation.js';
import { takeAdminShellSection } from './admin-shell-client.js';
import { invalidateAdminStoreEntry, recordAdminStoreEntry } from './admin-store.js';

const STATE_ENDPOINT = '/.netlify/functions/admin-release-state';
const RELEASE_ENDPOINT = '/.netlify/functions/admin-release';

export interface ReleaseObjectView {
  object_id: string;
  object_type: string;
  display_name: string;
  review_state: 'none' | 'open' | 'changes_requested' | 'approved';
  approval_state: 'none' | 'open' | 'changes_requested' | 'approved_stale' | 'approved_current';
  requires_approval: boolean;
  state: EditorialObjectState;
}

export type ReleaseDeployState =
  | 'unavailable'
  | 'idle'
  | 'queued'
  | 'building'
  | 'ready'
  | 'ready_not_published'
  | 'failed'
  | 'stalled';

export interface ReleaseOverview {
  deploy: {
    configured: boolean;
    state: ReleaseDeployState;
    production_confirmed: boolean;
    live_commit: string | null;
    latest: { id: string; status: string; production_url: string; commit?: string } | null;
    published: { id: string; status: string; production_url: string; commit?: string } | null;
  };
  objects: ReleaseObjectView[];
  waiting_count: number;
  pending_approval_count: number;
  /**
   * M1: when the DEPLOY facts in this response were gathered
   * (`snapshots/release.json`'s stamp). The object rows are live as of the
   * request; the deploy header can be up to one refresh interval old, and the
   * surfaces render `releaseAsOfLabel(as_of)` beside it rather than implying
   * "now". Optional: a function deploy older than M1 answers without it.
   */
  as_of?: string;
}

export interface ReleaseResultView {
  released: boolean;
  status: string;
  reason: string;
  productionUrl?: string;
}

const authorized = async (getToken: GetToken) => ({ Authorization: `Bearer ${await getToken()}` });

/**
 * Cache window. Deliberately short: this drives publish/approval state, so an
 * editor who publishes must see it reflected on the next surface they open.
 * `triggerProductionRelease` and every review decision invalidate explicitly
 * (see `invalidateReleaseOverview`), so the TTL only ever covers the "several
 * components mounting within the same second" case it exists for.
 */
export const RELEASE_OVERVIEW_TTL_MS = 15_000;

let memoryCache: { overview: ReleaseOverview; fetchedAt: number } | null = null;
let inflight: Promise<ReleaseOverview> | null = null;

async function requestReleaseOverview(getToken: GetToken): Promise<ReleaseOverview> {
  // T1.1: a page-load/poll read — rides the current page-generation signal.
  // Safe to abort unconditionally: a dropped fetch just leaves the module
  // cache as it was, and the next call (this page or another) refetches.
  const response = await fetch(STATE_ENDPOINT, { headers: await authorized(getToken), signal: currentPageSignal() });
  const body = (await response.json().catch(() => ({}))) as ReleaseOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Release state request failed (${response.status}).`);
  return body;
}

/** Always issues a fresh request and tracks it as the shared in-flight promise. */
function runFetch(getToken: GetToken): Promise<ReleaseOverview> {
  const thisFetch = requestReleaseOverview(getToken).then((overview) => {
    memoryCache = { overview, fetchedAt: Date.now() };
    recordAdminStoreEntry('release', overview, overview.as_of, 'network');
    return overview;
  });
  inflight = thisFetch;
  // Clear the in-flight marker on settle without creating a second
  // unhandled-rejection path — the returned promise still carries the
  // rejection for whoever awaits it (the library-client discipline).
  thisFetch.then(
    () => {
      if (inflight === thisFetch) inflight = null;
    },
    () => {
      if (inflight === thisFetch) inflight = null;
    }
  );
  return thisFetch;
}

export async function fetchReleaseOverview(getToken: GetToken, opts?: { force?: boolean }): Promise<ReleaseOverview> {
  if (!opts?.force) {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < RELEASE_OVERVIEW_TTL_MS) return memoryCache.overview;
    // The dedupe half: two components mounting in the same tick share one
    // request instead of racing two identical store sweeps (F2).
    if (inflight) return inflight;
  }
  return runFetch(getToken);
}

/**
 * M2.2 — ask this navigation's coalesced `admin-shell` boot before paying for
 * a dedicated `admin-release-state` round trip. Same contract as
 * `fetchAdminAccessStateViaShell`: a hit is recorded as `boot` in the shared
 * ledger (`admin-store.ts`) and primes this module's own cache; a miss (the
 * section already taken this generation, `error`, `skipped` — see this
 * file's own header — or an older deploy) falls back to
 * `fetchReleaseOverview` unchanged.
 */
export async function fetchReleaseOverviewViaShell(getToken: GetToken): Promise<ReleaseOverview> {
  const token = await getToken();
  const fromShell = await takeAdminShellSection<ReleaseOverview>(token, 'release');
  if (fromShell) {
    memoryCache = { overview: fromShell, fetchedAt: Date.now() };
    recordAdminStoreEntry('release', fromShell, fromShell.as_of, 'boot');
    return fromShell;
  }
  return fetchReleaseOverview(getToken);
}

/**
 * Drop the cache so the next read hits the network. Call this from every path
 * that can change release state — publishing, approving, requesting changes —
 * so the TTL can never hide an editor's own action from them.
 *
 * M1 kept this, and it is worth saying why, because a write-time snapshot looks
 * at first like it makes the call redundant. It does not, for two reasons.
 *
 * First, what this drops is a BROWSER cache with its own 15 s TTL. The server
 * being instantly correct does nothing about a client that will not ask for
 * 15 s, and the surfaces that call this — a review decision, a force-release, a
 * publish — are precisely the ones where the editor is waiting to see their own
 * action reflected.
 *
 * Second, only two of the paths that change release state write the snapshot.
 * `object_publish` and `release_to_production` do; approving an object, or
 * requesting changes, does not — those change `review_state` / `approval_state`,
 * which the server re-derives from the live inventory on every read rather than
 * serving from the snapshot (see `release-overview.ts`). So the fresh fetch this
 * forces is exactly what surfaces those, and dropping this call would have
 * reintroduced the up-to-15 s blindness it was written to remove.
 */
export function invalidateReleaseOverview(): void {
  memoryCache = null;
  inflight = null;
  invalidateAdminStoreEntry('release');
}

export async function triggerProductionRelease(getToken: GetToken): Promise<ReleaseResultView> {
  invalidateReleaseOverview();
  const response = await fetch(RELEASE_ENDPOINT, {
    method: 'POST',
    headers: { ...(await authorized(getToken)), 'Content-Type': 'application/json' },
    body: JSON.stringify({ force_build: true, timeout_seconds: 8 }),
  });
  const body = (await response.json().catch(() => ({}))) as { error?: string; result?: ReleaseResultView };
  if (!response.ok || !body.result) throw new Error(body.error || `Release request failed (${response.status}).`);
  return body.result;
}
