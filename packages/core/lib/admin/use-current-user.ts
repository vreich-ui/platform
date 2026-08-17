import { useCallback, useEffect, useSyncExternalStore } from 'react';

import { fetchMe, type OnboardingView, type UserView } from './users-client.js';

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
let snapshot = EMPTY;
let inflight: Promise<CurrentUserState> | undefined;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());
const setSnapshot = (next: CurrentUserState) => {
  snapshot = next;
  emit();
};

async function token(): Promise<string> {
  const auth = await import('./goTrueClient.js');
  return (await auth.getAccessToken()) ?? '';
}

export function invalidateCurrentUser(): void {
  inflight = undefined;
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
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY
  );
  useEffect(() => {
    if (state.loading && !inflight) void refreshCurrentUser();
  }, [state.loading]);
  useEffect(() => {
    const refresh = () => {
      invalidateCurrentUser();
      void refreshCurrentUser();
    };
    const clear = () => invalidateCurrentUser();
    window.addEventListener('cms:login', refresh);
    window.addEventListener('cms:user-updated', refresh);
    window.addEventListener('cms:logout', clear);
    return () => {
      window.removeEventListener('cms:login', refresh);
      window.removeEventListener('cms:user-updated', refresh);
      window.removeEventListener('cms:logout', clear);
    };
  }, []);
  return { ...state, refresh: useCallback(() => refreshCurrentUser(), []) };
}
