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
 * ### One shared fetch per PAGE GENERATION, each section handed over once
 *
 * Everything here is keyed to `currentPageGeneration()` — the identity
 * `page-generation.ts` mints alongside each navigation's `AbortController` —
 * and to nothing else. Within one generation:
 *
 *   - the FIRST consumer to ask starts the shell fetch; the others join the
 *     promise it left behind, so three consumers waking in the same tick cost
 *     one request;
 *   - that generation gets exactly ONE attempt. Once it has settled — with a
 *     payload, a failure or an abort — no later ask re-probes the shell, it
 *     just answers `null` and the consumer uses its own endpoint;
 *   - each section is handed over exactly ONCE.
 *
 * A new generation resets all three: a fresh attempt, a fresh payload, a fresh
 * set of sections to hand out. That is the whole fix behind this design —
 * keying the handoff to a WALL CLOCK instead made the coalescing work on only
 * every other click. A navigation inside the freshness window found the
 * previous navigation's payload still "fresh", started no new fetch, and then
 * found all three sections already taken, so all three consumers fell back.
 * That is worse than not coalescing at all: with the shell serving almost all
 * shell traffic, the three dedicated functions are COLD whenever a fallback
 * fires (measured 1037-2471 ms against 476 ms for the coalesced call), and
 * operators click faster than the window, so the fallback was the common case.
 *
 * The one-shot-per-section rule is what keeps the steady state honest, and it
 * needs no clock to do it. `requests-store` polls every 5-30 s without
 * navigating, so its second and later ticks are the same generation asking
 * again for a section it has already taken — `null`, straight to
 * `admin-requests`. If a poll asked through the shell it would re-read the
 * users store and re-resolve the tier for data it was not asking for. The
 * shell serves the NAVIGATION BURST — the moment all three want an answer at
 * once — and each consumer's own endpoint serves its own cadence afterwards.
 *
 * `ADMIN_SHELL_HANDOFF_MS` survives with a narrower job: it bounds how STALE a
 * payload may be when it is handed over, for the consumer that mounts late in
 * a long-lived generation. It no longer decides whether a fetch happens, and
 * a lapsed payload does NOT buy its generation a second attempt.
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
 *   - a **load this generation already attempted** — one that failed (a 401 on
 *     an expired session, a 500, a network error), or was aborted, or whose
 *     payload has since gone stale. The three consumers do not wake in the
 *     same tick, so without this each one that arrives after a failed attempt
 *     settled would start its own shell fetch and make its own fallback call
 *     anyway: SIX requests, where the promise below is "worst case, the old
 *     three". The NEXT generation always attempts again — an attempt is a fact
 *     about one navigation, never a verdict on the endpoint.
 *   - the section already having been handed over. Nothing is wrong; the
 *     caller is just on its own cadence now.
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
 * three-call behaviour, for the page the user has already left — and only for
 * that page. The abort spends the outgoing generation's one attempt, never the
 * incoming one's: the navigation that aborted the load also minted the
 * generation the next three consumers will ask in, so they coalesce normally.
 */
import { cacheAdminAccessState, fetchAdminAccessState, type AdminAccessState } from './admin-access-client.js';
import { clearAuthExpired, isAuthExpiredStatus, markAuthExpired } from './auth-expiry.js';
import { currentPageGeneration, currentPageSignal, isAbortError } from './page-generation.js';
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
 * How stale a fetched payload may be and still be worth handing over.
 *
 * A STALENESS bound, not the coalescing key: what decides whether a consumer
 * joins this navigation's load or falls back is the page generation (see the
 * header). This only stops a consumer that mounts late in a long-lived
 * generation — an overlay opened minutes after the page settled — from being
 * handed an opening snapshot that has since moved on. Matched to
 * `REQUESTS_INDEX_FRESH_MS`, the window `requests-store.ts` already treats a
 * snapshot of the same data as current within, so the two agree on what
 * "still current" means.
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
  /** The page generation this payload was fetched in — see `usableHandoff`. */
  generation: number;
  fetchedAtMs: number;
  taken: Set<AdminShellSectionName>;
}

/** A load in flight, and the generation that started it. A load is only ever joined by its OWN generation. */
interface InflightLoad {
  generation: number;
  load: Promise<Handoff | null>;
}

/** Sticky once a deploy has told us there is no `admin-shell`. One 404 is enough. */
let shellUnavailable = false;
let inflight: InflightLoad | undefined;
let handoff: Handoff | null = null;
/**
 * The page generation whose `admin-shell` load has already been STARTED —
 * settled or not, successful or not.
 *
 * One attempt per generation, shared by every consumer. The three consumers do
 * not wake in the same tick in production (the gate runs in `AdminLayout`'s
 * inline script, the two stores when their React islands mount), so without
 * this each consumer that wakes after a failed attempt settled starts its own
 * shell fetch and then makes its own fallback call anyway: a shell that 401s
 * on an expired session costs SIX requests, where this module's contract is
 * "worst case, the old three-call behaviour".
 *
 * Keyed to the generation and to nothing else, because that is what the fact
 * is about: one navigation asked, once. The NEXT navigation always asks again,
 * whatever happened to this one — the page going away is not a verdict about
 * the endpoint (only a 404 is, via `shellUnavailable`), and suppressing the
 * next generation's coalescing would be the opposite of the point.
 */
let attemptedGeneration: number | null = null;

/** Test-only: back to a pristine module — no sticky 404, no spent attempt, no in-flight load, no payload waiting to be handed over. */
export function resetAdminShellClientForTests(): void {
  shellUnavailable = false;
  inflight = undefined;
  handoff = null;
  attemptedGeneration = null;
}

/** Whether a 404 has retired the coalesced path for this page's lifetime. Exported for the test, and for nothing else. */
export const isAdminShellUnavailable = (): boolean => shellUnavailable;

const isSections = (value: unknown): value is AdminShellSections => {
  if (!value || typeof value !== 'object') return false;
  const sections = value as Partial<AdminShellSections>;
  return Boolean(sections.access && sections.requests && sections.me);
};

async function fetchShell(token: string, generation: number): Promise<Handoff | null> {
  let response: Response;
  try {
    response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ requests: { limit: ADMIN_SHELL_REQUEST_LIMIT } }),
      signal: currentPageSignal(),
    });
  } catch (error) {
    // An abort is the page going away, never a verdict about the endpoint, so
    // it must NOT set `shellUnavailable`. It spends only the generation it was
    // started in — the navigation that aborted it has already minted the next
    // one, whose consumers get a fetch of their own.
    if (isAbortError(error)) return null;
    console.error('Admin shell load failed (network).', error);
    return null;
  }

  // A deploy without `admin-shell`. Retire the path rather than paying a 404
  // on every navigation for the rest of the page's life.
  if (response.status === 404) {
    shellUnavailable = true;
    return null;
  }
  if (isAuthExpiredStatus(response.status)) {
    markAuthExpired();
    return null;
  }
  if (!response.ok) {
    console.error(`Admin shell load failed (HTTP ${response.status}).`);
    return null;
  }
  // The server knew who we are, so a banner left over from an earlier expiry
  // is now stale — the same rule `requests-client.ts`'s `authorizedFetch` has.
  clearAuthExpired();

  const body = await response.json().catch((error: unknown) => {
    console.error('Admin shell load failed (bad response body).', error);
    return null;
  });
  const sections = (body as { sections?: unknown } | null)?.sections;
  if (!isSections(sections)) return null;
  return { sections, generation, fetchedAtMs: Date.now(), taken: new Set() };
}

/**
 * The payload this generation is entitled to, or `null`.
 *
 * Drops a payload that belongs to a page the user has already left — however
 * recent it is, it is the PREVIOUS navigation's answer and this one is owed a
 * fetch of its own — and one that has gone stale inside its own generation.
 */
function usableHandoff(generation: number): Handoff | null {
  if (!handoff) return null;
  if (handoff.generation !== generation || Date.now() - handoff.fetchedAtMs >= ADMIN_SHELL_HANDOFF_MS) handoff = null;
  return handoff;
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
  const generation = currentPageGeneration();

  if (!usableHandoff(generation)) {
    // A load in flight for a generation the user has LEFT is never joined: it
    // carries that page's signal, so it is already aborting, and joining it
    // would hand this navigation a `null` and three fallback calls — exactly
    // the every-other-click failure this module is keyed to generations to
    // avoid. This generation's own load is joined, never bailed on.
    let load = inflight?.generation === generation ? inflight.load : undefined;
    if (!load) {
      // One attempt per generation — see `attemptedGeneration`. A consumer
      // that arrives after this generation's attempt settled (a failure, an
      // abort, or a payload since gone stale) falls straight back to its own
      // endpoint rather than re-probe the shell on its own account.
      if (attemptedGeneration === generation) return null;
      attemptedGeneration = generation;
      load = fetchShell(token, generation).finally(() => {
        if (inflight?.generation === generation) inflight = undefined;
      });
      inflight = { generation, load };
    }
    const loaded = await load;
    // Navigated while this was in flight: the answer belongs to the page the
    // user has left, and the generation that took over is owed its own fetch,
    // which its own consumers will start. Never store it — it would be dropped
    // by `usableHandoff` on sight anyway.
    if (currentPageGeneration() !== generation) return null;
    // A second consumer awaiting the same promise must not clobber a payload
    // the first already began taking sections out of.
    if (loaded) handoff ??= loaded;
    if (!usableHandoff(generation)) return null;
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
