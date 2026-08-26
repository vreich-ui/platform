/**
 * Release-state client (T5.1 R2 / T0.2 F2).
 *
 * `admin-release-state` is the most expensive read in the admin: the handler
 * runs its own full object-store inventory sweep, then calls the Netlify
 * deploys API twice, then GitHub's `/compare` once per distinct publish
 * commit. T0.2 found SEVEN call sites for it and — worse — several on the
 * SAME page load (`/admin/content/<id>` fired it twice; the objects plane
 * has two independent effects that both want it).
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
 */
import type { GetToken } from '../edit-mode/verbs-client.js';
import type { EditorialObjectState } from './editorial-state.js';

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
  const response = await fetch(STATE_ENDPOINT, { headers: await authorized(getToken) });
  const body = (await response.json().catch(() => ({}))) as ReleaseOverview & { error?: string };
  if (!response.ok) throw new Error(body.error || `Release state request failed (${response.status}).`);
  return body;
}

/** Always issues a fresh request and tracks it as the shared in-flight promise. */
function runFetch(getToken: GetToken): Promise<ReleaseOverview> {
  const thisFetch = requestReleaseOverview(getToken).then((overview) => {
    memoryCache = { overview, fetchedAt: Date.now() };
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
 * Drop the cache so the next read hits the network. Call this from every path
 * that can change release state — publishing, approving, requesting changes —
 * so the TTL can never hide an editor's own action from them.
 */
export function invalidateReleaseOverview(): void {
  memoryCache = null;
  inflight = null;
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
