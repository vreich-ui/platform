import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { takeAdminShellSection } from './admin-shell-client.js';
import { fetchMe, type MembershipPolicyServer, type OnboardingView, type UserView } from './users-client.js';
import { getSiteIdentity } from '../site-identity.js';
import { decodeTokenSubject } from './token-subject.js';
// Statically imported for ONE synchronous thing: `currentUser()` is a plain
// `localStorage` peek (no network, no refresh, no module-scope side effect at
// import time), and `hydrateFromCacheOnce` has to know whose cache to read
// DURING the first render. `token()` below keeps its dynamic import: that path
// wants `getAccessToken`, which awaits the shared OAuth-callback readiness
// point, and must not be pulled forward into this module's import.
import { currentUser } from './goTrueClient.js';

export interface CurrentUserState {
  user: UserView | null;
  roles: string[];
  loading: boolean;
  error?: string;
  /** T18.5: null = no stored record; undefined = not loaded. */
  onboarding?: OnboardingView | null;
  requireDisplayName?: boolean;
  /**
   * T-shell: the whole membership policy, from the SAME `me` read that
   * already fetched it to answer `require_display_name`.
   *
   * `/admin/settings/admins` was measured firing `admin-users` three times
   * (n=3, max 2317 ms) — `me`, `list` and a third `policy_get` purely for the
   * role-picker's grant rules. `policy_get` read a record `me` had already
   * read on the same page load, so the third call was buying nothing but
   * another ~250-400 ms of per-invocation overhead. It rides `me` now, and
   * `AdminUsers.tsx` reads it from here. `undefined` = not loaded (or a
   * server older than this change), which every consumer answers with
   * `DEFAULT_POLICY_VIEW` exactly as it did before `policy_get` returned.
   */
  policy?: MembershipPolicyServer;
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

/**
 * Site-scoped AND SUBJECT-scoped, the same shape
 * `admin-access-client.ts`'s `-admin-access-cache-<sub>` already has, and for
 * the same reason: this entry holds a resolved identity — e-mail, display
 * name, roles, and since T-shell the whole membership policy — and a key that
 * stopped at the site let the next person at the keyboard in this tab read
 * it, and let a stale entry PAINT as them for a moment before the revalidation
 * landed. Keyed by the token's `sub` (via the shared `decodeTokenSubject`),
 * not by the token itself, because a token rotates on refresh while the
 * subject is stable for the session.
 *
 * `STORAGE_PREFIX` deliberately stops before the `-<sub>` suffix, so the
 * sign-out sweep below matches every subject's entry AND the flat
 * `…-current-user-cache` key older deploys wrote, which nothing reads any more
 * and which is exactly the un-scoped entry this change exists to stop leaving
 * behind.
 */
const STORAGE_PREFIX = () => `${getSiteIdentity().siteSlug}-current-user-cache`;
const STORAGE_KEY = (subject: string) => `${STORAGE_PREFIX()}-${subject}`;

/**
 * Whose cache this tab is reading and writing, right now, synchronously.
 *
 * `currentUser()` is goTrue's own `localStorage` peek — no network, no token
 * refresh — so this is safe to call during render, which is what
 * `hydrateFromCacheOnce`'s instant first paint needs. The SUBJECT is derived
 * from the access token through the one shared decoder rather than from the
 * stored `id` field, so this key and `admin-access-client`'s can never
 * disagree about whose entry is whose.
 *
 * `null` — signed out, an expired stored session, a token that is not a
 * readable JWT, or storage that throws — means this tab has no cache to read
 * or write. Never a fallback to an unscoped key: an entry nobody can be
 * identified as the owner of is precisely the one that must not be written.
 */
const cacheSubject = (): string | null => {
  try {
    return decodeTokenSubject(currentUser()?.token?.access_token);
  } catch {
    return null;
  }
};

interface CachedCurrentUser {
  state: CurrentUserState;
  fetchedAt: number;
}

/** Only a genuinely resolved, signed-in state is worth persisting — never `loading`, and never an error. */
const isCacheable = (state: CurrentUserState): boolean => !state.loading && !state.error && state.user !== null;

const readSessionCache = (): CachedCurrentUser | null => {
  const subject = cacheSubject();
  if (!subject) return null;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY(subject));
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
  const subject = cacheSubject();
  // No identifiable owner, no persisted entry. The in-memory snapshot still
  // serves this page's lifetime, which is the only thing that is lost.
  if (!subject) return;
  try {
    sessionStorage.setItem(
      STORAGE_KEY(subject),
      JSON.stringify({ state, fetchedAt: Date.now() } satisfies CachedCurrentUser)
    );
  } catch {
    // Private browsing / disabled storage — the in-memory snapshot still
    // works for this page's lifetime, which is all this is for.
  }
};

/**
 * Drops every snapshot this module ever wrote for this site in this tab.
 *
 * Every key is swept, not just the current subject's — the same rule
 * `clearCachedAdminAccessState` is built on, and for the same reason: at
 * sign-out the token is usually already gone, so there is no subject left to
 * derive and a targeted `removeItem` would remove nothing at all. The prefix
 * also catches the flat, un-scoped key older deploys wrote.
 */
const clearSessionCache = (): void => {
  try {
    const prefix = STORAGE_PREFIX();
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
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
 * Synchronous, no-network peek at the last persisted `me` FOR THE SIGNED-IN
 * SUBJECT — exposed mainly so this caching layer is testable without a
 * renderer (this repo's test stack has neither jsdom nor testing-library);
 * `hydrateFromCacheOnce` below is the only production caller. A tab with no
 * readable session reads as a miss. Never throws, never triggers a fetch.
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

/**
 * T-shell: `me` through the coalesced `admin-shell` call when this page
 * generation has one going, and through `admin-users{verb:'me'}` when it does
 * not.
 *
 * `takeAdminShellSection` answers `null` for every "not this time" reason
 * there is — no shell on this deploy (404), the section errored server-side,
 * the caller has no admin tier, the load was aborted by a navigation, or this
 * store already took its section — and `null` always means the same thing
 * here: make the call this store has always made. One fallback path, no
 * negotiation.
 */
type MeReply = Awaited<ReturnType<typeof fetchMe>>;

const readMe = async (): Promise<MeReply> => {
  // Resolved ONCE and replayed: `token()` reaches goTrue, and the shell client
  // and `fetchMe` must be looking at the same session, not two lookups of it.
  const accessToken = await token();
  const section = await takeAdminShellSection<MeReply>(accessToken, 'me');
  return section ?? (await fetchMe(async () => accessToken));
};

export function refreshCurrentUser(): Promise<CurrentUserState> {
  if (inflight) return inflight;
  setSnapshot({ ...snapshot, loading: true, error: undefined });
  inflight = readMe()
    .then(({ user, roles, onboarding, policy }) => {
      const next = {
        user,
        roles,
        loading: false,
        onboarding: onboarding ?? null,
        requireDisplayName: policy?.require_display_name ?? true,
        ...(policy ? { policy } : {}),
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
