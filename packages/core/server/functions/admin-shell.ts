/**
 * Function name: Admin_Shell — the `/admin/*` shell's whole opening question,
 * answered in ONE round trip.
 *
 * ## Why this function exists, and why it is not "make the functions faster"
 *
 * The `Server-Timing` wave (T0.1) settled the question the original perf plan
 * got wrong. Measured on drluriescience.netlify.app/admin, owner login,
 * 2026-09-13:
 *
 *   admin-auth-state   wall 242-683 ms   [cold=0, auth=0.05, work=0.02, serialize=0.01]
 *   admin-requests     wall 496-821 ms   [cold=0, auth=0.04, work=212-387, serialize=0.08]
 *   admin-users        wall 454-710 ms   [no Server-Timing — now wrapped]
 *
 * `admin-auth-state` does 0.02 ms of server work and still costs 242-683 ms on
 * the wire. So the per-click floor is neither cold starts nor auth resolution:
 * it is ~250-400 ms of fixed platform/network overhead PER INVOCATION, and the
 * shell paid it three times on every navigation because it fired
 * `admin-auth-state` + `admin-requests{list}` + `admin-users{me}` as three
 * separate requests. The fix is fewer calls, not faster functions — which is
 * this file.
 *
 * ## The contract
 *
 * POST (GET is accepted too, so the shell can be probed by hand), Identity
 * bearer or injected `clientContext`, and a 200 whose body is:
 *
 *   { ok, status, sections: { access, requests, me } }
 *
 * where every section is `{ status: 'ok' | 'error' | 'skipped', … }`:
 *
 *   access    — `admin-auth-state`'s payload under `data`, byte for byte
 *               (`resolveAdminAccessSection`). Never `skipped`: it IS the auth.
 *   requests  — `admin-requests{action:'list'}`'s body under `data`, plus the
 *               `etag` the dedicated endpoint would have put in the header, so
 *               `requests-store.ts` can keep its conditional-poll protocol
 *               after a coalesced first load.
 *   me        — `admin-users{verb:'me'}`'s body under `data`.
 *
 * ### Three rules this file is built on
 *
 * 1. AUTH IS RESOLVED ONCE. `resolveAdminAccessSection` runs at the top; its
 *    `AdminAccessState` gates the other two sections. That is most of the
 *    point — three calls meant three identical tier resolutions.
 * 2. THE TWO READS RUN CONCURRENTLY (`Promise.allSettled`), not serially. A
 *    coalesced call that ran them in sequence would trade three round trips
 *    for one round trip plus the sum of the work, and `admin-requests`' work
 *    alone is 212-387 ms.
 * 3. A SECTION THAT FAILS DOES NOT FAIL THE RESPONSE. With three endpoints,
 *    one failing left the other two answers intact and the client degraded
 *    around it; a coalesced call that 500s on one bad blob read would be a
 *    strictly worse surface. Hence `allSettled` and a per-section `status`,
 *    and hence the client's own per-section fallback (`admin-shell-client.ts`).
 *
 * `skipped` is the third state and is not a failure: a signed-in caller with
 * no admin tier gets `access` resolved (the layout needs it to render the
 * "ask an Owner" panel) and the other two `skipped` with `code:
 * 'admin_required'` — exactly what the dedicated endpoints' 403s meant.
 *
 * ## Cold start
 *
 * This function runs on EVERY navigation, so its bundle is a latency number
 * (`tests/netlify/function-bundle-budget.test.ts` caps it with the trio at
 * 500 KB and bans the MCP surface / `sharp` / `stripe`). It therefore imports
 * the two READ paths from leaf modules — `lib/requests/list-snapshot.ts` and
 * `lib/membership/session.ts` — rather than importing `admin-requests.ts` and
 * `admin-users.ts` for them, which would have dragged in the workflow-cancel
 * bridge and the entire membership-management surface: ~200 KB of cold start
 * belonging to mutations this function cannot perform.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessSection } from './admin-auth-state.js';
import { getEditorialRequestsBlobStore } from '../lib/blob-store.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import { isOwner } from '../lib/roles.js';
import { REQUEST_PAGE_SIZE, buildRequestsListBody, etagFor, siteObjectProbe } from '../lib/requests/list-snapshot.js';
import { resolveMeSection } from '../lib/membership/session.js';
import { timeSection, timeSerialize, withServerTiming } from '../lib/server-timing.js';
import type { Principal } from '../../schema/object-record-v1.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>) => ({
  statusCode: status,
  headers: jsonHeaders,
  body: timeSerialize(() => JSON.stringify({ ok: status >= 200 && status < 300, status, ...body })),
});

/**
 * One section of the shell answer.
 *
 * `error` carries a sentence, never an exception: a blob read that threw is
 * this server's problem and the client's only decision is "ask the dedicated
 * endpoint instead", which `code` is for. Deliberately NOT a union on `data` —
 * a client reading `section.data` when `status !== 'ok'` gets `undefined`,
 * which every consumer already treats as "nothing to install".
 */
export interface AdminShellSection<T> {
  status: 'ok' | 'error' | 'skipped';
  data?: T;
  error?: string;
  /** Machine-readable reason a section is not `ok` — `admin_required`, `read_failed`. */
  code?: string;
}

/**
 * The bound the shell asks the request index for.
 *
 * DERIVED from `admin-requests`' own page size, never a second literal: the
 * `etag` this function hands back is a hash of the body built for THIS limit,
 * and the client replays it as `If-None-Match` against the DEDICATED endpoint,
 * which builds its body for `REQUEST_PAGE_SIZE`. Two hand-copied hundreds that
 * drifted would leave the conditional-poll protocol dead with nothing failing
 * to say so — see `lib/admin/request-list-limits.ts`, which exists because a
 * drifted copy of this number shipped once already.
 */
export const SHELL_REQUEST_LIMIT = REQUEST_PAGE_SIZE;

/**
 * The caller may narrow the requests section exactly as it would through
 * `admin-requests{list}` (the shell store asks for a `limit` and nothing
 * else). Unvalidated beyond shape on purpose: every field is forwarded to
 * `buildRequestsListBody`, which is the same code path the dedicated
 * endpoint's zod-parsed `list` reaches, and a nonsense value there degrades
 * to the default rather than to a wrong answer. `limit` IS clamped, because
 * it is the one field that bounds the wire.
 */
const requestsQueryFrom = (parsedBody: unknown): { limit: number } => {
  const body = parsedBody && typeof parsedBody === 'object' ? (parsedBody as Record<string, unknown>) : {};
  const requests = body.requests && typeof body.requests === 'object' ? (body.requests as Record<string, unknown>) : {};
  const raw = typeof requests.limit === 'number' && Number.isFinite(requests.limit) ? requests.limit : undefined;
  return { limit: raw ? Math.min(Math.max(1, Math.floor(raw)), SHELL_REQUEST_LIMIT) : SHELL_REQUEST_LIMIT };
};

/** A rejected `allSettled` entry, as a section. The reason never reaches the wire verbatim — it may hold store internals. */
const failedSection = <T>(what: string, reason: unknown): AdminShellSection<T> => {
  console.error(`Admin_Shell ${what} section failed.`, reason);
  return { status: 'error', code: 'read_failed', error: `The ${what} could not be read.` };
};

const buildHandlerImpl = (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST' && event.httpMethod !== 'GET') {
    return jsonResponse(405, { error: 'Method not allowed' });
  }

  // Rule 1: ONE auth resolution, shared by all three sections. `timeAuth`
  // lives inside `resolveAdminAccessSection`, so the `auth;dur=` metric on
  // this response measures the same call the dedicated endpoint's does — and
  // `sec.access` measures the section as a whole, defaulting write included.
  let access;
  try {
    access = await timeSection('access', () => resolveAdminAccessSection(event, context, binding));
  } catch (error) {
    // Auth itself failing is not a degradable section: without it there is no
    // caller to answer for. Same 500 the dedicated endpoints would give.
    console.error('Admin_Shell access resolution failed.', error);
    return jsonResponse(500, { error: 'Admin access could not be resolved.' });
  }
  const { payload, adminState } = access;

  // Unauthenticated is a 401 here exactly as it is on all three endpoints —
  // there is nothing to degrade to, and the client's auth-expiry protocol
  // (`lib/admin/auth-expiry.ts`) reads the status code, not the body.
  if (!adminState.authenticated) {
    return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });
  }

  const accessSection: AdminShellSection<typeof payload> = { status: 'ok', data: payload };

  const email = (adminState.email ?? '').trim().toLowerCase();
  // No admin tier: `access` still answers (the gate panel is rendered from it)
  // and the two admin-gated reads are `skipped`, which is what the dedicated
  // endpoints' 403s already meant. A missing verified e-mail lands here too —
  // `admin-users` answers that with a 403 of its own.
  if (!adminState.isAdmin || !email) {
    const skipped: AdminShellSection<never> = {
      status: 'skipped',
      code: 'admin_required',
      error: 'Admin access required',
    };
    return jsonResponse(200, { sections: { access: accessSection, requests: skipped, me: skipped } });
  }

  let parsedBody: unknown = {};
  if (event.body) {
    try {
      const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
      parsedBody = JSON.parse(raw);
    } catch {
      // An unreadable body narrows nothing; the shell's defaults are the
      // answer the shell wants anyway. Never a 400 — the body is optional.
      parsedBody = {};
    }
  }

  const principal: Principal = { kind: 'human', id: adminState.userId ?? '', email };
  const owner = isOwner(adminState.roles);

  // Rule 2: concurrently. Two independent blob stores, two independent
  // answers; running them in sequence would put `admin-requests`' 212-387 ms
  // of work in front of a `me` read that does not depend on it.
  const [requestsResult, meResult] = await Promise.allSettled([
    timeSection('requests', async () => {
      const store = await getEditorialRequestsBlobStore(event, binding);
      const body = await buildRequestsListBody(
        store,
        email,
        requestsQueryFrom(parsedBody),
        siteObjectProbe(event, binding)
      );
      // The same hash the dedicated endpoint puts on the wire as an `ETag`,
      // over the same object — so a client seeded from the shell can send it
      // as `If-None-Match` on its very next poll and get a `304`.
      return { ...body, etag: etagFor(body) };
    }),
    timeSection('me', async () => {
      const store = await getUsersBlobStore(event, binding);
      const result = await resolveMeSection({
        store,
        email,
        userId: adminState.userId,
        roles: adminState.roles,
        owner,
        principal,
      });
      return result.body;
    }),
  ]);

  // Rule 3: a section that failed is reported as failed, next to the ones
  // that did not. The client then asks the dedicated endpoint for that one
  // section only — it degrades exactly as well as it did when one of three
  // separate calls failed, which is the bar this had to clear.
  return jsonResponse(200, {
    sections: {
      access: accessSection,
      requests:
        requestsResult.status === 'fulfilled'
          ? { status: 'ok', data: requestsResult.value }
          : failedSection('requests index', requestsResult.reason),
      me:
        meResult.status === 'fulfilled'
          ? { status: 'ok', data: meResult.value }
          : failedSection('member record', meResult.reason),
    },
  });
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => withServerTiming('admin-shell', buildHandlerImpl(binding));
