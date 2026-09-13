/**
 * T5.1 (admin latency plan) — one generic stale-while-revalidate resource for
 * admin panels.
 *
 * Three modules had already grown the same shape by hand — `studio-client.ts`
 * (`peekCachedStudioData`), `editorial-view-client.ts`
 * (`peekCachedEditorialView`) and `use-current-user.ts` — each pairing a
 * module-scope in-memory entry with a `sessionStorage`-persisted copy, and
 * each read by a component that seeds `useState` from the persisted snapshot
 * in a lazy initialiser (`Studio.tsx`, `AdminHome.tsx`) so a repeat visit
 * paints immediately instead of showing a blocking skeleton. `ObjectsPlane.tsx`
 * does the third half of it inline: paint from cache, show a quiet
 * "Refreshing…" chip, revalidate.
 *
 * This module is that pattern, once, for panels that have no client module of
 * their own to hang a cache on. It exists because of what T5.2 needs: a page
 * whose single `Promise.all` is being split into per-panel resources needs
 * every panel to own its cache/refresh/error state independently, and writing
 * the Studio dance out five times per page is how a page ends up
 * all-or-nothing again.
 *
 * WHAT IT GUARANTEES
 *
 *  - FIRST PAINT IS SYNCHRONOUS when a snapshot exists. The value is read in
 *    a lazy `useState` initialiser during the first render — never in an
 *    effect — so a returning viewer never sees the skeleton flash.
 *  - A SKELETON IS ONLY FOR A PANEL NOBODY HAS SEEN. `loading` is true only
 *    when there is no value at all; a panel with a cached value reports
 *    `refreshing` instead, which is the quiet chip (`RefreshingChip` in
 *    `admin/primitives.tsx`), not a skeleton.
 *  - A FAILED REVALIDATION NEVER BLANKS THE PANEL. `error` is set and `value`
 *    is left exactly as it was; the caller decides whether an error next to
 *    real content is worth showing at all.
 *  - EVERY READ RIDES THE PAGE-GENERATION SIGNAL (T1.1). The fetcher is handed
 *    `currentPageSignal()`, and the one error an abort produces is swallowed
 *    rather than painted as a failure — a fetch that died because the viewer
 *    navigated away is not a load failure.
 *  - STORAGE NEVER THROWS. Safari private mode throws on `sessionStorage`
 *    access itself, so every read and write is wrapped; a tab with no storage
 *    still works, it just never paints from cache.
 *
 * WHAT IT IS NOT. This is a paint-latency cache, not a data store: it holds
 * whatever `JSON.stringify` round-trips, is scoped to one tab and one site,
 * and is always revalidated behind the paint. A verb that WRITES server state
 * must call `refresh()` (or `invalidateCachedResource`) rather than trusting
 * the window to expire.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getSiteIdentity } from '../site-identity.js';
import { currentPageSignal, isAbortError } from './page-generation.js';

/**
 * Default staleness tolerance for a synchronous first paint — the same ten
 * minutes `studio-client.ts` and `editorial-view-client.ts` already chose,
 * and for the same reason: a revalidation always follows immediately behind
 * the cached paint, so this only has to rule out genuinely ancient data (a
 * tab left open overnight), not to approximate freshness.
 */
export const CACHED_RESOURCE_MAX_AGE_MS = 10 * 60_000;

export interface CachedResourceEntry<T> {
  value: T;
  fetchedAt: number;
}

/** Site-scoped, so two publications open in one browser never read each other's snapshots. */
export function cachedResourceStorageKey(key: string): string {
  return `${getSiteIdentity().siteSlug}-resource-${key}`;
}

/**
 * Module-scope memory, which survives an Astro `ClientRouter` swap even
 * though the React tree does not — the same reason `library-client.ts` and
 * friends keep theirs at module scope.
 */
const memoryCache = new Map<string, CachedResourceEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

const readSessionEntry = <T>(key: string): CachedResourceEntry<T> | null => {
  try {
    const raw = sessionStorage.getItem(cachedResourceStorageKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedResourceEntry<T>>;
    if (typeof parsed.fetchedAt !== 'number' || !('value' in parsed)) return null;
    return { value: parsed.value as T, fetchedAt: parsed.fetchedAt };
  } catch {
    // No storage (private browsing), or a snapshot written by an older shape
    // of this value — either way there is nothing to paint from.
    return null;
  }
};

/**
 * Drops every snapshot THIS module wrote for this site, leaving other
 * modules' `sessionStorage` keys (and other sites') alone. Used as the
 * quota-recovery step below, and exported for the same reason
 * `invalidateStudioCache` is: a caller that knows the whole tab's view of
 * the world is stale should be able to say so.
 */
export function clearPersistedCachedResources(): void {
  try {
    const prefix = cachedResourceStorageKey('');
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const name = sessionStorage.key(index);
      if (name && name.startsWith(prefix)) doomed.push(name);
    }
    doomed.forEach((name) => sessionStorage.removeItem(name));
  } catch {
    // ignored — nothing to clear if storage isn't reachable
  }
}

const writeSessionEntry = <T>(key: string, entry: CachedResourceEntry<T>): void => {
  const serialized = JSON.stringify(entry);
  try {
    sessionStorage.setItem(cachedResourceStorageKey(key), serialized);
    return;
  } catch {
    // Private browsing or disabled storage (the write is simply lost — the
    // in-memory entry still serves this page's lifetime), OR a quota
    // refusal. Quota is the one worth handling: keys here carry what the
    // request varied on (a window, a filter set), so a session spent
    // drilling through analytics filters accumulates snapshots nothing will
    // ask for again, and one of them eventually fills the tab's budget for
    // everything — including the modules that are NOT this one. Clearing
    // this module's own keys and retrying once trades the least valuable
    // thing (old snapshots) for the most valuable (the current one).
  }
  clearPersistedCachedResources();
  try {
    sessionStorage.setItem(cachedResourceStorageKey(key), serialized);
  } catch {
    // Storage is genuinely unavailable, or this single value does not fit in
    // an empty budget. Either way the in-memory entry stands on its own.
  }
};

const clearSessionEntry = (key: string): void => {
  try {
    sessionStorage.removeItem(cachedResourceStorageKey(key));
  } catch {
    // ignored — nothing to clear if storage isn't reachable
  }
};

/** The last snapshot for `key`, whatever its age — memory first, then this tab's persisted copy. Never fetches, never throws. */
export function readCachedResource<T>(key: string): CachedResourceEntry<T> | null {
  const remembered = memoryCache.get(key) as CachedResourceEntry<T> | undefined;
  if (remembered) return remembered;
  return readSessionEntry<T>(key);
}

/**
 * The last snapshot for `key`, but only if it is younger than `maxAgeMs` —
 * what a lazy `useState` initialiser wants. Never fetches, never throws.
 */
export function peekCachedResource<T>(
  key: string,
  maxAgeMs: number = CACHED_RESOURCE_MAX_AGE_MS
): CachedResourceEntry<T> | null {
  const entry = readCachedResource<T>(key);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > maxAgeMs) return null;
  return entry;
}

/** Records a value in both caches and returns the entry that was stored. */
export function writeCachedResource<T>(key: string, value: T): CachedResourceEntry<T> {
  const entry: CachedResourceEntry<T> = { value, fetchedAt: Date.now() };
  memoryCache.set(key, entry as CachedResourceEntry<unknown>);
  writeSessionEntry(key, entry);
  return entry;
}

/** Drops `key` from memory, from this tab's storage, and from the in-flight table, so the next read is forced to the network. */
export function invalidateCachedResource(key: string): void {
  memoryCache.delete(key);
  inflight.delete(key);
  clearSessionEntry(key);
}

/**
 * Runs `fetcher` for `key`, de-duped: two panels (or a remount inside the
 * same tick) that ask for the same key while a request is already in flight
 * share that one request instead of issuing a second. A success updates both
 * caches; a failure updates neither, which is what leaves the last good value
 * on screen.
 *
 * Keys must therefore carry whatever the fetcher varies on (a window, an id)
 * — `analytics:netlify:<from>:<to>`, not `analytics:netlify`.
 */
export function fetchCachedResource<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;

  const thisFetch: Promise<T> = fetcher().then((value) => {
    // Only the CURRENT request for this key may write the cache. A
    // `refresh()` drops the in-flight marker before starting a new request,
    // so a slow superseded response can no longer land on top of the fresher
    // one it lost the race to.
    if (inflight.get(key) === thisFetch) writeCachedResource(key, value);
    return value;
  });
  inflight.set(key, thisFetch as Promise<unknown>);
  // Clear the marker on settle without creating a second unhandled-rejection
  // path — the returned promise still carries the rejection for whoever
  // awaits it (`library-client.ts`'s discipline).
  thisFetch.then(
    () => {
      if (inflight.get(key) === thisFetch) inflight.delete(key);
    },
    () => {
      if (inflight.get(key) === thisFetch) inflight.delete(key);
    }
  );
  return thisFetch;
}

/** Test-only: start each test from empty caches instead of leaking module state across files. */
export function resetCachedResourcesForTests(): void {
  memoryCache.clear();
  inflight.clear();
}

export interface CachedResourceState<T> {
  /** The value to render. Present as soon as a cached snapshot exists, and never cleared by a failed revalidation. */
  value: T | undefined;
  /**
   * No value at all — the ONLY state in which a skeleton is the right
   * answer. A panel with a cached value is `refreshing`, not `loading`.
   */
  loading: boolean;
  /** A value is on screen and a revalidation is in flight — render `RefreshingChip`, not a skeleton. */
  refreshing: boolean;
  /** The value on screen came from the cache rather than from this mount's own fetch. */
  stale: boolean;
  /** The last revalidation's failure, if any. `value` is untouched — a panel showing real content may choose to ignore it. */
  error: string | undefined;
  /** Discards the snapshot and revalidates — what a panel's `onChanged` calls after a write. */
  refresh: () => void;
}

interface Snapshot<T> {
  key: string;
  value: T | undefined;
  loading: boolean;
  refreshing: boolean;
  stale: boolean;
  error: string | undefined;
}

function seedSnapshot<T>(key: string, maxAgeMs: number, enabled: boolean): Snapshot<T> {
  const cached = peekCachedResource<T>(key, maxAgeMs);
  if (!cached) return { key, value: undefined, loading: true, refreshing: false, stale: false, error: undefined };
  return { key, value: cached.value, loading: false, refreshing: enabled, stale: true, error: undefined };
}

export interface UseCachedResourceOptions {
  /**
   * Gate the fetch (not the paint) on a prerequisite this panel is still
   * waiting for — a resolved date window, a hydrated URL. A disabled resource
   * still paints whatever is cached, and still reports `loading` when nothing
   * is; it simply does not go to the network until it is enabled.
   */
  enabled?: boolean;
}

/**
 * A single panel's data: paint from cache synchronously, revalidate behind it.
 *
 *   const assets = useCachedResource('visual-identity:assets', (signal) => fetchEditorialAssets(getToken, signal));
 *   if (assets.loading) return <Skeleton variant="rect" height={320} />;
 *   return <><RefreshingChip active={assets.refreshing} /><AssetsBoard assets={assets.value} /></>;
 *
 * `fetcher` may be an inline arrow: it is read through a ref, so a new
 * closure every render does NOT re-fetch. What re-fetches is `key` changing,
 * `enabled` flipping on, or `refresh()`.
 */
export function useCachedResource<T>(
  key: string,
  fetcher: (signal: AbortSignal) => Promise<T>,
  ttlMs: number = CACHED_RESOURCE_MAX_AGE_MS,
  options?: UseCachedResourceOptions
): CachedResourceState<T> {
  const enabled = options?.enabled ?? true;
  const [snapshot, setSnapshot] = useState<Snapshot<T>>(() => seedSnapshot<T>(key, ttlMs, enabled));
  const [revalidations, setRevalidations] = useState(0);

  // A `key` change is a different resource, and its cached value must paint
  // on THIS render rather than one frame later — so the snapshot is adjusted
  // during render (React's documented "derive state from props" escape
  // hatch), not in an effect. An effect here would show the previous
  // resource's value, or a skeleton, for one paint.
  if (snapshot.key !== key) {
    setSnapshot(seedSnapshot<T>(key, ttlMs, enabled));
  }

  // The fetcher is almost always an inline arrow. Reading it through a ref is
  // what keeps a new closure per render from re-firing the request — the
  // effect below deliberately depends only on what should actually re-fetch.
  // (`exhaustive-deps` is not enabled in this repo; see eslint.config.js.)
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    // T1.1: minted once for this read, so an in-flight revalidation dies with
    // the page generation that asked for it.
    const signal = currentPageSignal();
    setSnapshot((prev) => {
      if (prev.key !== key) return prev;
      // A panel with nothing on screen stays `loading` (skeleton); one with a
      // cached value flips to `refreshing` (chip). Identity-preserving when
      // neither changed, so a re-run of this effect costs no extra render.
      const refreshing = prev.value !== undefined;
      return prev.refreshing === refreshing ? prev : { ...prev, refreshing };
    });
    fetchCachedResource(key, () => fetcherRef.current(signal))
      .then((value) => {
        if (!live) return;
        setSnapshot((prev) =>
          prev.key === key ? { key, value, loading: false, refreshing: false, stale: false, error: undefined } : prev
        );
      })
      .catch((reason: unknown) => {
        if (!live) return;
        // T1.1: the page navigating away is why this fetch died, not a real
        // failure — leave the panel exactly as it is.
        if (isAbortError(reason)) return;
        setSnapshot((prev) =>
          prev.key === key
            ? {
                ...prev,
                loading: false,
                refreshing: false,
                error: reason instanceof Error ? reason.message : 'This panel could not be loaded.',
              }
            : prev
        );
      });
    return () => {
      live = false;
    };
  }, [key, enabled, revalidations]);

  const refresh = useCallback(() => {
    invalidateCachedResource(key);
    setRevalidations((count) => count + 1);
  }, [key]);

  return {
    value: snapshot.value,
    loading: snapshot.loading,
    refreshing: snapshot.refreshing,
    stale: snapshot.stale,
    error: snapshot.error,
    refresh,
  };
}
