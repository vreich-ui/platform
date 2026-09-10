/**
 * Browser wrapper over `admin-editorial-view` (T5.1 Phase 2, T0.2 §6.3) — the
 * one call `/admin`'s publication map makes.
 *
 * It replaces three: the full object inventory, the full release overview
 * (which recomputed that same inventory server-side) and the full chat list.
 * The page renders three rows and eight integers, so that is what comes back;
 * see the handler's header for what is deliberately NOT folded in (`me` and
 * the request-attention counts, both already served by shared module stores
 * the shell owns).
 *
 * Module-scope TTL + in-flight dedupe, the `library-client.ts` shape: module
 * state survives an Astro `ClientRouter` navigation even though the React tree
 * does not, so returning to Editorial inside the window is free.
 *
 * T1.6 (admin latency plan): this call was measured as the single slowest
 * one in the whole admin (16.0s cold / 9.8s warm), and the 15s in-memory TTL
 * alone means every fresh page load re-pays the full cost — the in-memory
 * cache does not survive a reload. Adds a `sessionStorage`-persisted copy of
 * the last successful result, the same shape `studio-client.ts` already uses
 * for Studio: a repeat visit (or a reload) can paint from the persisted
 * snapshot immediately via `peekCachedEditorialView()` instead of the
 * blocking skeleton, while a normal `fetchEditorialView()` call refreshes it
 * in the background.
 */
import { getSiteIdentity } from '../site-identity.js';
import type { GetToken } from '../edit-mode/verbs-client.js';
import { currentPageSignal } from './page-generation.js';
import type { ChatSummaryView } from './chat-client.js';
import type { EditorialObjectState } from './editorial-state.js';
import type { LibraryRow } from './library-logic.js';
import type { ReleaseDeployState } from './release-client.js';

const ENDPOINT = '/.netlify/functions/admin-editorial-view';

/** Exactly the fields `FoundationSlot` reads — assignable to `LibraryRow`. */
export type EditorialSlotRow = Pick<
  LibraryRow,
  'object_id' | 'object_type' | 'display_name' | 'updated_at' | 'status' | 'review_state' | 'published_time'
> & { unpublished_changes: boolean };

export interface EditorialWorkView {
  chat_id: string;
  title: string;
  status: ChatSummaryView['status'];
  updated_at: string;
  object_id?: string;
}

export interface EditorialSlotView {
  rows: EditorialSlotRow[];
  count: number;
  state: EditorialObjectState | null;
  work: EditorialWorkView | null;
}

export interface EditorialView {
  foundation: {
    site: EditorialSlotView;
    editorial_voice: EditorialSlotView;
    visual_identity: EditorialSlotView & { theme_count: number };
  };
  families: {
    pages: number;
    navigation: number;
    templates: number;
    media: number;
    content: number;
  };
  deploy: {
    configured: boolean;
    state: ReleaseDeployState;
    production_confirmed: boolean;
    live_commit: string | null;
  };
}

/** Short: the map is a landing surface, and an editor who publishes elsewhere should see it here. */
export const EDITORIAL_VIEW_TTL_MS = 15_000;

/**
 * How stale a `sessionStorage`-persisted snapshot may be and still be worth
 * painting immediately (`studio-client.ts`'s identical constant and
 * rationale: a background `force: false` refetch follows right behind it,
 * so this only needs to guard against a tab left open for hours, not to
 * match the in-memory TTL exactly).
 */
export const EDITORIAL_VIEW_PERSISTED_MAX_AGE_MS = 10 * 60_000;

const STORAGE_KEY = () => `${getSiteIdentity().siteSlug}-editorial-view-cache`;

export interface CachedEditorialView {
  view: EditorialView;
  fetchedAt: number;
}

const isEditorialViewShape = (value: unknown): value is EditorialView => {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<EditorialView>;
  return !!v.foundation && !!v.families && !!v.deploy;
};

const readSessionCache = (): CachedEditorialView | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedEditorialView>;
    if (typeof parsed.fetchedAt !== 'number' || !isEditorialViewShape(parsed.view)) return null;
    return { view: parsed.view, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
};

const writeSessionCache = (entry: CachedEditorialView): void => {
  try {
    sessionStorage.setItem(STORAGE_KEY(), JSON.stringify(entry));
  } catch {
    // Private browsing / disabled storage — the in-memory cache still works
    // for this page's lifetime, which is all this is for.
  }
};

const clearSessionCache = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEY());
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
};

let memoryCache: CachedEditorialView | null = null;
let inflight: Promise<EditorialView> | null = null;

/**
 * Synchronous, no-network peek at the last known Editorial view — the
 * in-memory cache if this page already fetched, otherwise whatever was
 * persisted to `sessionStorage` by an earlier page/navigation. Callers
 * decide their own staleness tolerance (see `EDITORIAL_VIEW_PERSISTED_MAX_AGE_MS`);
 * this never triggers a fetch and never throws.
 */
export function peekCachedEditorialView(): CachedEditorialView | null {
  if (memoryCache) return memoryCache;
  return readSessionCache();
}

async function request(getToken: GetToken): Promise<EditorialView> {
  // T1.1: a page-load read for the /admin publication map — always rides
  // the current page-generation signal (no cross-navigation store here).
  const response = await fetch(ENDPOINT, {
    headers: { Authorization: `Bearer ${await getToken()}` },
    signal: currentPageSignal(),
  });
  const body = (await response.json().catch(() => ({}))) as EditorialView & { error?: string };
  if (!response.ok) throw new Error(body.error || `Publication map request failed (${response.status}).`);
  return body;
}

function runFetch(getToken: GetToken): Promise<EditorialView> {
  const thisFetch = request(getToken).then((view) => {
    const entry: CachedEditorialView = { view, fetchedAt: Date.now() };
    memoryCache = entry;
    writeSessionCache(entry);
    return view;
  });
  inflight = thisFetch;
  // Clear the marker on settle without creating a second unhandled-rejection
  // path — the returned promise still carries the rejection (library-client's
  // discipline).
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

export async function fetchEditorialView(getToken: GetToken, opts?: { force?: boolean }): Promise<EditorialView> {
  if (!opts?.force) {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < EDITORIAL_VIEW_TTL_MS) return memoryCache.view;
    if (inflight) return inflight;
  }
  return runFetch(getToken);
}

/** Clears the in-memory cache, any in-flight promise reference, and the persisted `sessionStorage` copy. */
export function invalidateEditorialView(): void {
  memoryCache = null;
  inflight = null;
  clearSessionCache();
}
