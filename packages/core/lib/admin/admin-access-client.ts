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
 */

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

export async function fetchAdminAccessState(token: string | null | undefined): Promise<AdminAccessState> {
  if (!token) return NOT_SIGNED_IN;

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

  return response.json().catch((error) => {
    console.error('Admin access check failed (bad response body).', error);
    return {
      authenticated: true,
      isAdmin: false,
      checkFailed: true,
      error: 'Admin access could not be verified.',
    };
  });
}
