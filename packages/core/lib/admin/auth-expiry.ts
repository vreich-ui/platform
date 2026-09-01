/**
 * C3 — "signed out" is a STATE, not a rights problem.
 *
 * When the session token expired, the admin did not say so. `getAccessToken()`
 * answers `null` on an expired session, every caller collapsed that to `''`,
 * an empty bearer went out, and what came back was a generic failure — while
 * `use-current-user` collapsed the roles to `[]` and every disabled action
 * started explaining itself with "Ask an owner". A rights sentence for an auth
 * problem sends the operator looking for a colleague instead of a sign-in
 * button.
 *
 * This module is the ONE place that fact lives. It exists because an empty
 * role list cannot tell you WHY it is empty: empty-because-viewer and
 * empty-because-signed-out are different states, and a surface that has to
 * guess between them will guess wrong. `rowActions` gets the signal
 * explicitly (`RowActionOptions.signedOut`) rather than inferring it.
 *
 * Module scope, like `requests-store.ts` and `use-current-user.ts`: the fact
 * must survive an Astro `ClientRouter` swap and must be the same fact to
 * every island on the page, not one copy per React tree.
 *
 * Deliberately free of React and of every other module in this directory —
 * `requests-client.ts` (the fetch seam that SETS this) imports it, so a
 * dependency in the other direction would be a cycle.
 */

/** The banner's heading. Persistent, never a toast: this state does not resolve itself. */
export const SESSION_EXPIRED_TITLE = 'Session expired — sign in again';

/** Why what is on screen must not be read as current. */
export const SESSION_EXPIRED_MESSAGE =
  'These rows are a snapshot from before your session ended. Nothing is being refreshed until you sign in.';

/** The banner's call to action. */
export const SIGN_IN_LABEL = 'Sign in';

/** What a request that never went out, or came back a 401, tells its caller. */
export const AUTH_EXPIRED_MESSAGE = 'Your session has expired. Sign in again to continue.';

/**
 * Thrown by the `requests-client.ts` seam instead of the generic
 * `Request failed (401).` — a caller can then tell "the session ended" from
 * "the server refused this action", which is the whole distinction this task
 * exists to restore.
 */
export class AuthExpiredError extends Error {
  readonly authExpired = true;
  constructor(message: string = AUTH_EXPIRED_MESSAGE) {
    super(message);
    this.name = 'AuthExpiredError';
  }
}

export const isAuthExpiredError = (error: unknown): error is AuthExpiredError =>
  error instanceof AuthExpiredError || (error as { authExpired?: boolean } | null)?.authExpired === true;

/**
 * The ONE status that means "your session, not your rights".
 *
 * Every endpoint this admin's request client talks to draws the same line:
 * `401` for `!adminState.authenticated`, `403` for a role it does not have
 * (`admin-requests.ts`, `admin-request-activity.ts`, `admin-requests-view.ts`
 * all gate in exactly that order). So a `403` must NOT set this state — a
 * genuine viewer being refused is a rights answer, and telling them to sign
 * in again would be the same lie in the opposite direction.
 */
export const isAuthExpiredStatus = (status: number): boolean => status === 401;

let expired = false;
const listeners = new Set<() => void>();
let recoveryArmed = false;

const emit = () => listeners.forEach((listener) => listener());

/**
 * Recovery is armed only while expired, on BOTH targets on purpose:
 * `LoginModal.astro` and `HeaderAuthButton.astro` dispatch `cms:login` on
 * `document` with `bubbles` unset, so a `window`-only listener never hears it.
 */
const onLogin = () => clearAuthExpired();

const armRecovery = () => {
  if (recoveryArmed || typeof window === 'undefined' || typeof document === 'undefined') return;
  recoveryArmed = true;
  window.addEventListener('cms:login', onLogin);
  document.addEventListener('cms:login', onLogin);
};

const disarmRecovery = () => {
  if (!recoveryArmed) return;
  recoveryArmed = false;
  window.removeEventListener('cms:login', onLogin);
  document.removeEventListener('cms:login', onLogin);
};

/** Is this browser's admin session over? */
export const isAuthExpired = (): boolean => expired;

/** `useSyncExternalStore`'s subscribe half — the surfaces read the flag through this. */
export const subscribeAuthExpiry = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

/**
 * Called by the fetch seam, and by nothing else — one seam, not a check
 * scattered over the call sites. Idempotent: repeated 401s from a poll chain
 * must not re-notify every subscriber.
 */
export function markAuthExpired(): void {
  if (expired) return;
  expired = true;
  armRecovery();
  emit();
}

/**
 * The session is usable again — from `cms:login`, from a deliberate sign-out,
 * or from any response that came back at all (a `403` included: the server
 * answered us, so it knows who we are).
 */
export function clearAuthExpired(): void {
  if (!expired) return;
  expired = false;
  disarmRecovery();
  emit();
}

/** Test seam. Drops the flag AND its listeners, so no test leaks state into the next. */
export function resetAuthExpiryForTests(): void {
  disarmRecovery();
  expired = false;
  listeners.clear();
}
