import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { fetchMe, type OnboardingView, type UserView } from './users-client.js';
import { getSiteIdentity } from '../site-identity.js';

export interface CurrentUserState {
  user: UserView | null;
  roles: string[];
  loading: boolean;
  error?: string;
  /** T18.5: null = no stored record; undefined = not loaded. */
  onboarding?: OnboardingView | null;
  requireDisplayName?: boolean;
}

const EMPTY: CurrentUserState = { user: null, roles: [], loading: true };

/**
 * T1.2 R3: `me` is part of the "shell trio" (`admin-auth-state` +
 * `admin-requests list` + `admin-users me`) that used to re-fire on every
 * `/admin/*` navigation. The in-memory module snapshot below already
 * survives an Astro `ClientRouter` swap (it did before this change), but not
 * a fresh page load — a hard reload, or the very first `/admin/*` visit of a
 * tab, always started from `loading: true`. A `sessionStorage`-persisted
 * copy, the same shape `studio-client.ts`/`editorial-view-client.ts` already
 * use, lets a fresh load seed the module snapshot already-resolved so every
 * `useCurrentUser()` consumer paints roles/identity immediately; a real
 * background fetch still runs exactly once behind it (see `hydrateFromCache`
 * and `hasRevalidatedFromCache` below) so nothing goes stale forever.
 */
export const CURRENT_USER_CACHE_TTL_MS = 10 * 60_000;

const STORAGE_KEY = () => `${getSiteIdentity().siteSlug}-current-user-cache`;

interface CachedCurrentUser {
  state: CurrentUserState;
  fetchedAt: number;
}

/** Only a genuinely resolved, signed-in state is worth persisting — never `loading`, and never an error. */
const isCacheable = (state: CurrentUserState): boolean => !state.loading && !state.error && state.user !== null;

const readSessionCache = (): CachedCurrentUser | null => {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedCurrentUser>;
    if (typeof parsed.fetchedAt !== 'number' || !parsed.state || typeof parsed.state !== 'object') return null;
    const state = parsed.state as CurrentUserState;
    if (!state.user) return null;
    return { state, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
};

const writeSessionCache = (state: CurrentUserState): void => {
  try {
    sessionStorage.setItem(STORAGE_KEY(), JSON.stringify({ state, fetchedAt: Date.now() } satisfies CachedCurrentUser));
  } catch {
    // Private browsing / disabled storage — the in-memory snapshot still
    // works for this page's lifetime, which is all this is for.
  }
};

const clearSessionCache = (): void => {
  try {
    sessionStorage.removeItem(STORAGE_KEY());
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
};

let snapshot = EMPTY;
let inflight: Promise<CurrentUserState> | undefined;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const setSnapshot = (next: CurrentUserState) => {
  snapshot = next;
  if (isCacheable(next)) writeSessionCache(next);
  emit();
};

// T1.2 R3: read once, lazily — the first time anything actually asks for the
// current user (inside `useCurrentUser`, at component-mount time), not at
// this module's import time. Import time can run before the site-identity
// provider is registered (`STORAGE_KEY` would throw, harmlessly caught
// below, but there's no reason to race it) and, in the `node:test` runner,
// before any `sessionStorage` global exists at all.
let hasHydratedFromCache = false;
/** True once a real fetch has been kicked off for this module's lifetime, whether or not it started from a cache hit — see `useCurrentUser`. */
let hasRevalidatedFromCache = false;

/**
 * Synchronous, no-network peek at the last persisted `me` — exposed mainly
 * so this caching layer is testable without a renderer (this repo's test
 * stack has neither jsdom nor testing-library); `hydrateFromCacheOnce` below
 * is the only production caller. Never throws, never triggers a fetch.
 */
export function peekCachedCurrentUser(): CachedCurrentUser | null {
  return readSessionCache();
}

/**
 * Exported (not just called from the hook) so the lazy-hydrate decision
 * itself is directly testable without a renderer — pair with
 * `currentUserSnapshot()` below.
 */
export function hydrateFromCacheOnce(): void {
  if (hasHydratedFromCache) return;
  hasHydratedFromCache = true;
  const cached = peekCachedCurrentUser();
  if (!cached) return;
  if (Date.now() - cached.fetchedAt >= CURRENT_USER_CACHE_TTL_MS) return;
  snapshot = cached.state;
}

/** Read-only access to the current snapshot outside the hook — mirrors `decisionOverlaySnapshot()` in requests-store.ts. Mainly for tests; a React consumer should use the hook. */
export const currentUserSnapshot = (): CurrentUserState => snapshot;

/**
 * Test-only: back to a pristine, un-hydrated module — `EMPTY` snapshot, no
 * in-flight promise, both hydration flags cleared, and the persisted cache
 * wiped. Module state here is a deliberate singleton (it must survive an
 * Astro `ClientRouter` swap in production), so tests that exercise more than
 * one scenario must call this between them.
 */
export function resetCurrentUserForTests(): void {
  inflight = undefined;
  hasHydratedFromCache = false;
  hasRevalidatedFromCache = false;
  clearSessionCache();
  snapshot = EMPTY;
}

async function token(): Promise<string> {
  const auth = await import('./goTrueClient.js');
  return (await auth.getAccessToken()) ?? '';
}

export function invalidateCurrentUser(): void {
  inflight = undefined;
  hasHydratedFromCache = true; // an explicit sign-out/sign-in must win over a stale persisted snapshot, not race a lazy re-read of it
  hasRevalidatedFromCache = false;
  clearSessionCache();
  setSnapshot(EMPTY);
}

export function refreshCurrentUser(): Promise<CurrentUserState> {
  if (inflight) return inflight;
  setSnapshot({ ...snapshot, loading: true, error: undefined });
  inflight = fetchMe(token)
    .then(({ user, roles, onboarding, policy }) => {
      const next = {
        user,
        roles,
        loading: false,
        onboarding: onboarding ?? null,
        requireDisplayName: policy?.require_display_name ?? true,
      } satisfies CurrentUserState;
      setSnapshot(next);
      return next;
    })
    .catch((error: unknown) => {
      const next = {
        user: null,
        roles: [],
        loading: false,
        error: error instanceof Error ? error.message : 'Could not load your profile.',
      } satisfies CurrentUserState;
      setSnapshot(next);
      return next;
    })
    .finally(() => {
      inflight = undefined;
    });
  return inflight;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useCurrentUser(): CurrentUserState & { refresh: () => Promise<CurrentUserState> } {
  hydrateFromCacheOnce();
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY
  );
  useEffect(() => {
    // T1.2 R3: a cache hit paints `loading: false` immediately, so the
    // original `state.loading` gate alone would never fire the real
    // background fetch behind it — `hasRevalidatedFromCache` covers exactly
    // that case, once per module lifetime (an Astro ClientRouter swap keeps
    // this module alive, so this does not re-fire on every navigation any
    // more than the pre-existing `state.loading` gate did).
    if (!inflight && (state.loading || !hasRevalidatedFromCache)) {
      hasRevalidatedFromCache = true;
      void refreshCurrentUser();
    }
  }, [state.loading]);
  useEffect(() => {
    const refresh = () => {
      invalidateCurrentUser();
      void refreshCurrentUser();
    };
    const clear = () => invalidateCurrentUser();
    // C3: `LoginModal.astro` and `HeaderAuthButton.astro` dispatch these on
    // `document`, and a `CustomEvent` built without `bubbles` never reaches
    // `window` — so a `window`-only listener meant that signing back in never
    // re-fetched the roles, and the surface kept showing an empty role list
    // long after the session was healthy again. Both targets, both cleaned up;
    // a double delivery would cost at most one extra profile fetch.
    const targets: EventTarget[] = [window, document];
    for (const target of targets) {
      target.addEventListener('cms:login', refresh);
      target.addEventListener('cms:user-updated', refresh);
      target.addEventListener('cms:logout', clear);
    }
    return () => {
      for (const target of targets) {
        target.removeEventListener('cms:login', refresh);
        target.removeEventListener('cms:user-updated', refresh);
        target.removeEventListener('cms:logout', clear);
      }
    };
  }, []);
  return { ...state, refresh: useCallback(() => refreshCurrentUser(), []) };
}
