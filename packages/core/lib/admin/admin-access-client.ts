/**
 * S1 auth-dedupe/failure-states follow-up: the "call admin-auth-state and
 * decide isAdmin" logic previously existed as two independent, drifted
 * copies — one inline in AdminLayout.astro's gate script, one inline in
 * HeaderAuthButton.astro's account-menu script. Only the AdminLayout copy
 * was taught to distinguish a transient CHECK failure (network error,
 * non-2xx, bad JSON body) from a genuine "you are not an admin" answer;
 * HeaderAuthButton's copy silently collapsed every failure into
 * `isAdmin: false`, which is indistinguishable from a real denial in the
 * one place (the header's admin-only nav reveal) most visitors actually
 * encounter the check. One shared implementation now backs both call sites.
 *
 * T1.2 R1: this call is one of the "shell trio" that re-fires on every
 * `/admin/*` navigation while the whole shell sits `hidden` waiting for it —
 * a 1-2.5s floor before the section's own data even starts loading. A
 * `sessionStorage` cache, keyed by the token's `sub` claim (not the raw
 * token, which rotates on refresh — the subject is what stays stable across
 * a session), lets `AdminLayout.astro` paint the shell immediately from the
 * last known answer while `fetchAdminAccessState` revalidates for real in
 * the background; see `peekCachedAdminAccessState`.
 */
import { getSiteIdentity } from '../site-identity.js';
// The cache-key derivation this module and `use-current-user.ts` share — two
// persisted identity snapshots, one rule for whose entry is whose. It lives in
// its own dependency-free leaf because this module ships on public reader
// pages via `HeaderAuthButton.astro`.
import { decodeTokenSubject } from './token-subject.js';

const ENDPOINT = '/.netlify/functions/admin-auth-state';

export interface AdminAccessState {
  authenticated: boolean;
  isAdmin: boolean;
  email?: string;
  checkFailed?: boolean;
  error?: string;
  /** Full resolved tier (T18.1 five-tier model) — e.g. ['viewer'], ['owner','admin','publisher']. */
  roles?: string[];
}

const NOT_SIGNED_IN: AdminAccessState = { authenticated: false, isAdmin: false };

/** How long a cached access state is trusted for an instant paint. */
export const ADMIN_ACCESS_CACHE_TTL_MS = 10 * 60_000;

const CACHE_KEY = (subject: string) => `${getSiteIdentity().siteSlug}-admin-access-cache-${subject}`;

interface CachedAdminAccessState {
  state: AdminAccessState;
  fetchedAt: number;
}

const readCache = (subject: string): CachedAdminAccessState | null => {
  try {
    const raw = sessionStorage.getItem(CACHE_KEY(subject));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CachedAdminAccessState>;
    if (typeof parsed.fetchedAt !== 'number' || !parsed.state || typeof parsed.state !== 'object') return null;
    return { state: parsed.state as AdminAccessState, fetchedAt: parsed.fetchedAt };
  } catch {
    return null;
  }
};

const writeCache = (subject: string, state: AdminAccessState): void => {
  try {
    sessionStorage.setItem(
      CACHE_KEY(subject),
      JSON.stringify({ state, fetchedAt: Date.now() } satisfies CachedAdminAccessState)
    );
  } catch {
    // Private browsing / disabled storage — the caller still gets a correct
    // answer this page load, it just can't paint instantly next time.
  }
};

/**
 * Drops every cached access state this site ever wrote in this tab.
 *
 * Sign-out must not leave one person's resolved roles and e-mail sitting in
 * the tab's `sessionStorage` for the next person at the keyboard. Keying by
 * `sub` already means a SECOND user can never be painted from the FIRST
 * user's entry (the key would not match), so this is about not retaining the
 * data at all rather than about a cross-user paint — but the entry is
 * readable for the rest of the tab's life otherwise, and there is no reason
 * to keep it. Every key is swept, not just the signing-out subject's: at
 * logout the token is often already gone, so there is no subject to derive.
 */
export function clearCachedAdminAccessState(): void {
  try {
    const prefix = `${getSiteIdentity().siteSlug}-admin-access-cache-`;
    const doomed: string[] = [];
    for (let index = 0; index < sessionStorage.length; index += 1) {
      const key = sessionStorage.key(index);
      if (key?.startsWith(prefix)) doomed.push(key);
    }
    for (const key of doomed) sessionStorage.removeItem(key);
  } catch {
    // Private browsing / disabled storage — nothing was ever cached.
  }
}

/**
 * Write an access state into the instant-paint cache for `token`'s subject,
 * for an answer that did NOT come from this module's own fetch.
 *
 * T-shell: `admin-shell` returns the same `admin-auth-state` payload as one
 * section of its single coalesced response (`admin-shell-client.ts`), and an
 * answer that arrives that way must seed the very same cache, or the next
 * navigation would have nothing to paint from and the coalescing would have
 * bought a round trip back. The caching RULE is unchanged and stays here,
 * where it can only be written one way: a genuine answer (admit or deny) is
 * cache-worthy, a `checkFailed` blip never is — caching a transient failure
 * would paint the next navigation from a lie.
 */
export function cacheAdminAccessState(token: string | null | undefined, state: AdminAccessState): void {
  if (!token || state.checkFailed) return;
  const subject = decodeTokenSubject(token);
  if (subject) writeCache(subject, state);
}

/**
 * Synchronous, no-network peek at the last known access state for `token`'s
 * subject — lets `AdminLayout.astro` paint the shell immediately from a warm
 * cache while `fetchAdminAccessState` revalidates in the background. Returns
 * `null` on a cache miss, an undecodable token, or an entry older than
 * `ADMIN_ACCESS_CACHE_TTL_MS`; never throws and never triggers a fetch.
 */
export function peekCachedAdminAccessState(token: string | null | undefined): AdminAccessState | null {
  if (!token) return null;
  const subject = decodeTokenSubject(token);
  if (!subject) return null;
  const cached = readCache(subject);
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt >= ADMIN_ACCESS_CACHE_TTL_MS) return null;
  return cached.state;
}

export async function fetchAdminAccessState(token: string | null | undefined): Promise<AdminAccessState> {
  if (!token) return NOT_SIGNED_IN;
  const subject = decodeTokenSubject(token);

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Admin access check failed (network).', error);
    return {
      authenticated: true,
      isAdmin: false,
      checkFailed: true,
      error: 'Admin access could not be verified.',
    };
  }

  if (!response.ok) {
    console.error(`Admin access check failed (HTTP ${response.status}).`);
    return {
      authenticated: true,
      isAdmin: false,
      checkFailed: true,
      error: `Admin access could not be verified (HTTP ${response.status}).`,
    };
  }

  const state = await response.json().catch((error) => {
    console.error('Admin access check failed (bad response body).', error);
    return {
      authenticated: true,
      isAdmin: false,
      checkFailed: true,
      error: 'Admin access could not be verified.',
    } satisfies AdminAccessState;
  });

  // A genuine answer (admit or deny) is cache-worthy; a check failure is not
  // — caching a transient blip would paint the NEXT navigation from a lie.
  if (subject && !state.checkFailed) writeCache(subject, state);
  return state;
}
