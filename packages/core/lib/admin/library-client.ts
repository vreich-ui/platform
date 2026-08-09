/**
 * Content library data client (T9.8). One `inventory` fetch over the existing
 * admin-object verb endpoint returns every object's row (including the T9.2
 * display_name and updated_at added to the row); the browse surface filters
 * and sorts client-side.
 *
 * Perf follow-up: `fetchInventoryRows` used to be called independently from
 * three places (ContentLibrary on mount, AdminShell's Cmd-K palette on first
 * open, and object-type-resolve's bare-deep-link fallback) with zero sharing
 * — opening the palette seconds after the library page loaded fired a second
 * identical full object-store sweep. This module now caches + de-dupes:
 *
 *  - An in-memory, in-flight-de-duped, short-TTL cache: concurrent callers
 *    within the window share one network request.
 *  - A `sessionStorage`-persisted copy of the last successful rows (no
 *    tokens, no auth data — just `LibraryRow[]` + a timestamp) so a page
 *    render (e.g. ContentLibrary's mount) can paint instantly from the last
 *    known rows instead of a full blocking skeleton, then quietly refresh.
 *
 * Every mutating verb call site invalidates the cache on success
 * (`invalidateInventoryCache`) so a write is never followed by a stale list;
 * `goTrueClient.logout()` also invalidates so the cache never leaks across
 * signed-in users on a shared machine.
 */
import { callObjectVerb, type GetToken } from '../edit-mode/verbs-client.js';
import type { LibraryRow } from './library-logic.js';
import { getSiteIdentity } from '../site-identity.js';

export type { GetToken };

/** Cache window: a call within this many ms of the last successful fetch reuses it. */
export const INVENTORY_CACHE_TTL_MS = 30_000;

/**
 * How stale a `sessionStorage`-persisted row set may be and still be worth
 * painting immediately (a background `force: false` refetch follows right
 * away, so this only needs to guard against genuinely ancient data — e.g. a
 * tab left open for hours — not to match the in-memory TTL exactly).
 */
export const INVENTORY_PERSISTED_MAX_AGE_MS = 10 * 60_000;

const STORAGE_KEY = () => `${getSiteIdentity().siteSlug}-inventory-cache`;

export interface CachedInventory {
  rows: LibraryRow[];
  fetchedAt: number;
}

let memoryCache: CachedInventory | null = null;
let inflight: Promise<LibraryRow[]> | null = null;

const readSessionCache = (): CachedInventory | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedInventory>;
    if (!Array.isArray(parsed.rows) || typeof parsed.fetchedAt !== 'number') return null;
    return { rows: parsed.rows as LibraryRow[], fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
};

const writeSessionCache = (entry: CachedInventory): void => {
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

/**
 * Synchronous, no-network peek at the last known rows — the in-memory cache
 * if this page already fetched, otherwise whatever was persisted to
 * `sessionStorage` by an earlier page/navigation. Callers decide their own
 * staleness tolerance (see `INVENTORY_PERSISTED_MAX_AGE_MS`); this never
 * triggers a fetch and never throws.
 */
export function peekCachedInventoryRows(): CachedInventory | null {
  if (memoryCache) return memoryCache;
  return readSessionCache();
}

/**
 * Returns persisted rows only when they are fresh enough to paint while a
 * background refresh runs. Call this after hydration: reading browser storage
 * during a React state initializer makes the client tree differ from SSR.
 */
export function freshCachedInventoryRows(nowMs = Date.now()): LibraryRow[] | null {
  const cached = peekCachedInventoryRows();
  if (!cached || nowMs - cached.fetchedAt > INVENTORY_PERSISTED_MAX_AGE_MS) return null;
  return cached.rows;
}

async function requestInventory(getToken: GetToken): Promise<LibraryRow[]> {
  const { status, body } = await callObjectVerb(getToken, { action: 'inventory' });
  if (status !== 200) {
    throw new Error((body?.error as string) || `Inventory request failed (${status}).`);
  }
  return (body.objects as LibraryRow[] | undefined) ?? [];
}

/** Always issues a fresh request, updates both caches, and tracks it as the shared in-flight promise. */
function runFetch(getToken: GetToken): Promise<LibraryRow[]> {
  const thisFetch = requestInventory(getToken).then((rows) => {
    const entry: CachedInventory = { rows, fetchedAt: Date.now() };
    memoryCache = entry;
    writeSessionCache(entry);
    return rows;
  });
  inflight = thisFetch;
  // Clear the in-flight marker once this fetch settles, without creating a
  // second unhandled-rejection path — the caller-facing `thisFetch` promise
  // (returned below) still carries the real rejection for whoever awaits it.
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

export async function fetchInventoryRows(getToken: GetToken, opts?: { force?: boolean }): Promise<LibraryRow[]> {
  const force = opts?.force ?? false;

  if (!force) {
    if (memoryCache && Date.now() - memoryCache.fetchedAt < INVENTORY_CACHE_TTL_MS) {
      return memoryCache.rows;
    }
    if (inflight) return inflight;
  }

  return runFetch(getToken);
}

/** Clears the in-memory cache and any in-flight promise reference so the next call is forced to hit the network. */
export function invalidateInventoryCache(): void {
  memoryCache = null;
  inflight = null;
  clearSessionCache();
}
