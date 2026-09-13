/**
 * admin-shell-client.ts — ONE fetch for the shell's three opening answers.
 *
 * ## What this replaces, and why
 *
 * Every `/admin/*` navigation used to fire three requests: `admin-auth-state`
 * (the gate), `admin-requests{list}` (the header pills / runs inbox) and
 * `admin-users{me}` (identity + roles). The `Server-Timing` wave measured what
 * each cost and the answer killed the original plan: `admin-auth-state` does
 * **0.02 ms** of server work and still costs 242-683 ms on the wire. The floor
 * is ~250-400 ms of fixed per-INVOCATION platform/network overhead, paid three
 * times. So the win is not faster functions, it is fewer calls — `admin-shell`
 * (server) returns all three in one response and this module hands each
 * section to the store that already owns it.
 *
 * ## The shape of the coordination — deliberately boring
 *
 * This module imports the page-generation signal, the auth-expiry protocol and
 * `admin-access-client.ts`; the two stores import IT:
 *
 *   AdminLayout.astro   →  `fetchAdminAccessStateViaShell` (then the existing
 *                          `admin-access-client` sessionStorage cache)
 *   use-current-user.ts →  `me`       (then its own snapshot + cache)
 *   requests-store.ts   →  `requests` (then its own snapshot + etag)
 *
 * Nothing is imported back, so there is no cycle and no new store: each
 * consumer keeps reading from exactly the store it read from before, and no
 * consumer COMPONENT changed at all.
 *
 * The direction of the `admin-access-client` edge is deliberate and load
 * bearing: `admin-access-client.ts` is also imported by
 * `HeaderAuthButton.astro`, which ships on every PUBLIC reader page. This
 * module reaches `page-generation.ts`, which imports React — so pointing the
 * edge the other way would have put React in the public header's bundle to
 * serve an admin-only optimisation. The access client stays React-free; the
 * coalescing lives here, where only `/admin/*` loads it.
 *
 * ### One shared fetch, each section handed over once
 *
 * `takeAdminShellSection` starts the shell fetch if one is not already in
 * flight and otherwise joins it, so three consumers waking in the same tick
 * cost one request. Each section is then handed to its consumer ONCE and the
 * payload is dropped after `ADMIN_SHELL_HANDOFF_MS`.
 *
 * That one-shot rule is what keeps the steady state honest. `requests-store`
 * polls every 5-30 s; if it kept asking through the shell, every poll would
 * re-read the users store and re-resolve the tier for data it was not asking
 * for. The shell serves the NAVIGATION BURST — the moment all three want an
 * answer at once — and each consumer's own endpoint serves its own cadence
 * afterwards. `ADMIN_SHELL_HANDOFF_MS` matches `REQUESTS_INDEX_FRESH_MS`, the
 * window `requests-store` already treats a snapshot as current within.
 *
 * ### `null` always means "ask your own endpoint"
 *
 * There is ONE fallback path, not a negotiation. `takeAdminShellSection`
 * answers `null` and the caller does exactly what it did before this module
 * existed. That covers all of:
 *
 *   - a **404** — a client loaded against a deploy that predates `admin-shell`.
 *     Sticky for the page's lifetime (`shellUnavailable`): one 404 is enough,
 *     nothing re-probes.
 *   - a **per-section failure** — `admin-shell` answers 200 with
 *     `sections.requests.status === 'error'` when that one blob read failed.
 *     Only that consumer falls back; the other two keep their answers. This is
 *     the degradation parity the coalescing had to preserve: with three calls,
 *     one failing left the other two intact.
 *   - `status: 'skipped'` — a signed-in caller with no admin tier. The `access`
 *     section still answers (the layout renders the "ask an Owner" panel from
 *     it); the two admin-gated sections are skipped, and a fallback call would
 *     simply collect the 403 the dedicated endpoint always gave.
 *   - an **abort** — see below.
 *   - a **load that already failed in this window** (a 401 on an expired
 *     session, a 500, a network error). Remembered for one handoff window so
 *     the other consumers fall straight back instead of each re-probing the
 *     shell first — otherwise a failing shell costs SIX requests where the
 *     promise below is "worst case, the old three".
 *   - the section already having been handed over, or the handoff window
 *     having lapsed. Nothing is wrong; the caller is just on its own cadence
 *     now.
 *
 * ### Abort
 *
 * The shell load is a READ, so it carries the page-generation signal
 * (`page-generation.ts`): navigating away aborts it rather than leaving it to
 * compete with the next page's calls — the whole point of T1.1. Crucially an
 * abort is NOT an error here, it is a `null`: `requests-store`'s chain is
 * built to survive a `ClientRouter` swap and deliberately passes no signal of
 * its own, so an aborted coalesced fetch must leave it doing what it always
 * did (its own unsignalled poll) rather than handing it an `AbortError` to
 * explain to the operator. Worst case on a navigation mid-flight is the old
 * three-call behaviour, for the page the user has already left.
 */
import { cacheAdminAccessState, fetchAdminAccessState, type AdminAccessState } from './admin-access-client.js';
import { clearAuthExpired, isAuthExpiredStatus, markAuthExpired } from './auth-expiry.js';
import { currentPageSignal, isAbortError } from './page-generation.js';
import { REQUEST_LIST_MAX_LIMIT } from './request-list-limits.js';

const ENDPOINT = '/.netlify/functions/admin-shell';

/** One section of the coalesced answer. Mirrors `server/functions/admin-shell.ts`'s `AdminShellSection`. */
export interface AdminShellSection<T> {
  status: 'ok' | 'error' | 'skipped';
  data?: T;
  error?: string;
  code?: string;
}

export interface AdminShellSections {
  access: AdminShellSection<Record<string, unknown>>;
  requests: AdminShellSection<Record<string, unknown>>;
  me: AdminShellSection<Record<string, unknown>>;
}

export type AdminShellSectionName = keyof AdminShellSections;

/**
 * How long a fetched payload is still worth handing over. Matched to
 * `REQUESTS_INDEX_FRESH_MS` — the window `requests-store.ts` already treats a
 * snapshot as current within — so a navigation burst is coalesced and a
 * steady-state poll is not.
 */
export const ADMIN_SHELL_HANDOFF_MS = 5_000;

/**
 * The row the shell asks the request index for.
 *
 * DERIVED, never a second literal: `requests-store.ts` asks
 * `admin-requests` for `REQUEST_LIST_MAX_LIMIT` rows, and the `ETag` the
 * shell hands back is a hash of the body the server built for THIS limit. Two
 * hand-copied hundreds that drifted would leave the conditional-poll protocol
 * silently dead — every first poll after every navigation re-transferring a
 * body the client already had, with nothing failing to say so. That module's
 * own header is the record of what a drifted copy of this number costs.
 */
export const ADMIN_SHELL_REQUEST_LIMIT = REQUEST_LIST_MAX_LIMIT;

interface Handoff {
  sections: AdminShellSections;
  fetchedAtMs: number;
  taken: Set<AdminShellSectionName>;
}

/** Sticky once a deploy has told us there is no `admin-shell`. One 404 is enough. */
let shellUnavailable = false;
let inflight: Promise<Handoff | null> | undefined;
let handoff: Handoff | null = null;
/**
 * When a load last failed for a reason that is NOT the sticky 404 and NOT an
 * abort — a 401, a 500, a network error, an unreadable body.
 *
 * One attempt per handoff window, shared by every consumer. Without this each
 * consumer that wakes AFTER the failed attempt settled starts its own shell
 * fetch and then makes its own fallback call anyway, so a shell that 401s on
 * an expired session costs SIX requests where this module's contract is "worst
 * case, the old three-call behaviour". An abort is excluded for the same
 * reason it does not set `shellUnavailable`: the page going away is not a
 * verdict about the endpoint, and suppressing the NEXT page generation's
 * coalescing would be the opposite of the point.
 */
let shellFailedAtMs = 0;

/** Test-only: back to a pristine module — no sticky 404, no remembered failure, no in-flight load, no payload waiting to be handed over. */
export function resetAdminShellClientForTests(): void {
  shellUnavailable = false;
  inflight = undefined;
  handoff = null;
  shellFailedAtMs = 0;
}

/** Whether a 404 has retired the coalesced path for this page's lifetime. Exported for the test, and for nothing else. */
export const isAdminShellUnavailable = (): boolean => shellUnavailable;

const isSections = (value: unknown): value is AdminShellSections => {
  if (!value || typeof value !== 'object') return false;
  const sections = value as Partial<AdminShellSections>;
  return Boolean(sections.access && sections.requests && sections.me);
};

async function fetchShell(token: string): Promise<Handoff | null> {
  /** A failure worth remembering for this window — see `shellFailedAtMs`. */
  const failed = (): null => {
    shellFailedAtMs = Date.now();
    return null;
  };

  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: { limit: ADMIN_SHELL_REQUEST_LIMIT } }),
      signal: currentPageSignal(),
    });
  } catch (error) {
    // An abort is the page going away, never a verdict about the endpoint —
    // so it must NOT set `shellUnavailable`, and must not be remembered as a
    // failure either, or one navigation would retire the coalesced path for
    // the rest of the session (or for the next page's whole burst).
    if (isAbortError(error)) return null;
    console.error('Admin shell load failed (network).', error);
    return failed();
  }

  // A deploy without `admin-shell`. Retire the path rather than paying a 404
  // on every navigation for the rest of the page's life.
  if (response.status === 404) {
    shellUnavailable = true;
    return null;
  }
  if (isAuthExpiredStatus(response.status)) {
    markAuthExpired();
    return failed();
  }
  if (!response.ok) {
    console.error(`Admin shell load failed (HTTP ${response.status}).`);
    return failed();
  }
  // The server knew who we are, so a banner left over from an earlier expiry
  // is now stale — the same rule `requests-client.ts`'s `authorizedFetch` has.
  clearAuthExpired();

  const body = await response.json().catch((error: unknown) => {
    console.error('Admin shell load failed (bad response body).', error);
    return null;
  });
  const sections = (body as { sections?: unknown } | null)?.sections;
  if (!isSections(sections)) return failed();
  shellFailedAtMs = 0;
  return { sections, fetchedAtMs: Date.now(), taken: new Set() };
}

/**
 * Join (or start) this page generation's single `admin-shell` load and take
 * `name`'s answer out of it.
 *
 * `null` means "use your own endpoint" — every reason is listed in this
 * module's header, and the caller treats them identically on purpose.
 */
export async function takeAdminShellSection<T>(
  token: string | null | undefined,
  name: AdminShellSectionName
): Promise<T | null> {
  if (!token || shellUnavailable) return null;

  const fresh = handoff && Date.now() - handoff.fetchedAtMs < ADMIN_SHELL_HANDOFF_MS ? handoff : null;
  if (!fresh) {
    handoff = null;
    // ONE attempt per window when the last one failed. A consumer that wakes
    // after a failed attempt has already settled must fall straight back to
    // its own endpoint rather than re-probe the shell on its own account —
    // three consumers doing that is three shell calls AND three fallbacks.
    // A load still in flight is joined, never bailed on: the marker is about
    // attempts that are already over.
    if (!inflight && Date.now() - shellFailedAtMs < ADMIN_SHELL_HANDOFF_MS) return null;
    inflight ??= fetchShell(token).finally(() => {
      inflight = undefined;
    });
    const loaded = await inflight;
    // A second consumer awaiting the same promise must not clobber a payload
    // the first already began taking sections out of.
    if (loaded) handoff ??= loaded;
    if (!handoff) return null;
  }

  const current = handoff;
  if (!current || current.taken.has(name)) return null;
  current.taken.add(name);
  const section = current.sections[name];
  if (section.status !== 'ok' || !section.data) return null;
  return section.data as T;
}

/**
 * The admin gate's access check, coalesced.
 *
 * Same contract as `fetchAdminAccessState` — which it falls back to verbatim
 * whenever the shell cannot answer — so `AdminLayout.astro`'s gate logic
 * (instant paint from cache, revalidate behind it, downgrade if the server
 * says less access than the cache did) is untouched: it still calls one
 * function and still gets one `AdminAccessState`.
 *
 * The shell's `access` section IS `admin-auth-state`'s payload, so the answer
 * is the same object either way, and it is written to the same
 * subject-keyed `sessionStorage` cache either way — a genuine answer only,
 * never a check failure.
 */
export async function fetchAdminAccessStateViaShell(token: string | null | undefined): Promise<AdminAccessState> {
  const section = await takeAdminShellSection<AdminAccessState>(token, 'access');
  if (!section) return fetchAdminAccessState(token);
  cacheAdminAccessState(token, section);
  return section;
}
