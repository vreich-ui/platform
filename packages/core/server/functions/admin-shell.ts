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
 *   { ok, status, sections: { access, me, requests, inventory, release } }
 *
 * where every section is `{ status: 'ok' | 'error' | 'skipped', … }`:
 *
 *   access    — `admin-auth-state`'s payload under `data`, byte for byte
 *               (`resolveAdminAccessSection`). Never `skipped`: it IS the auth.
 *   me        — `admin-users{verb:'me'}`'s body under `data`.
 *   requests  — `admin-requests{action:'list'}`'s body under `data`, plus the
 *               `etag` the dedicated endpoint would have put in the header, so
 *               `requests-store.ts` can keep its conditional-poll protocol
 *               after a coalesced first load.
 *   inventory — M2.1. `object_inventory{}`'s answer under `data`:
 *               `{ objects, generated_at, index }`, the same rows, the same
 *               order and the same `index` diagnostics the verb returns —
 *               UNFILTERED, because the dedicated call the client falls back
 *               to is unfiltered and the two must be interchangeable (REVIEW,
 *               see `RELEASE_INVENTORY_STATUS`). See "Why `readInventoryRows`"
 *               below.
 *   release   — M2.1b. The publication-state overview: M1's deploy snapshot
 *               joined to the `inventory` rows above. One extra blob read,
 *               never a rebuild, and `as_of`/`stale` say how old the deploy
 *               facts are — see "`release`: one blob read" below.
 *
 * ## M2.1: the name stayed `admin-shell`, and why
 *
 * The plan called the widened payload `admin-boot`. Renaming a DEPLOYED
 * function is not a rename: this handler reaches the fleet through a one-line
 * shim per tenant (`netlify/functions/admin-shell.ts` plus five under
 * `sites/<client>/netlify/functions/`) and the scaffold in
 * `cli/create-site.mjs`, so the new name costs seven files — and every tab
 * already open against the old name 404s, which
 * `admin-shell-client.ts` handles by retiring the coalesced path for that
 * page's lifetime (`shellUnavailable`), i.e. by going back to three calls on
 * exactly the machines that were already warm. Keeping the old name alive
 * therefore costs seven MORE shims, forever, in a repo whose law is that
 * retired mechanisms stay retired. Against that: nothing but the plan document
 * refers to `admin-boot`. The client constant, the bundle-budget key, the
 * parity script, the site-scaffold fixture and this file's own tests all spell
 * it `admin-shell`, and a payload growing is not a contract break — it is the
 * same function answering more of the same opening question. Cheapest that
 * works wins, so the function keeps its name and grows its payload; the WORD
 * "boot" is the payload's, not the URL's.
 *
 * ### Three rules this file is built on
 *
 * 1. AUTH IS RESOLVED ONCE. `resolveAdminAccessSection` runs at the top; its
 *    `AdminAccessState` gates every other section. That is most of the
 *    point — three calls meant three identical tier resolutions, and five
 *    sections would have meant five.
 * 2. EVERY SECTION RUNS CONCURRENTLY (`Promise.allSettled`), never serially.
 *    A coalesced call that ran them in sequence would trade N round trips for
 *    one round trip plus the SUM of the work, and `admin-requests`' work alone
 *    is 212-387 ms. This is the rule that lets the payload grow: the wall cost
 *    of the boot is its slowest section, not its section count — which is why
 *    three sections became five without the 900 ms budget moving.
 * 3. A SECTION THAT FAILS DOES NOT FAIL THE RESPONSE. With three endpoints,
 *    one failing left the other two answers intact and the client degraded
 *    around it; a coalesced call that 500s on one bad blob read would be a
 *    strictly worse surface. Hence `allSettled` and a per-section `status`,
 *    and hence the client's own per-section fallback (`admin-shell-client.ts`).
 *    New sections get the same treatment, with one honest exception recorded
 *    in `docs/KNOWN_ISSUES.md` #70: the inventory read path swallows store
 *    failures by design, so a dead object store reaches the wire as an empty
 *    library with `index.trusted: false`, not as `status: 'error'`.
 *
 * `skipped` is the third state and is not a failure: a signed-in caller with
 * no admin tier gets `access` resolved (the layout needs it to render the
 * "ask an Owner" panel) and the other four `skipped` with `code:
 * 'admin_required'` — exactly what the dedicated endpoints' 403s meant.
 *
 * ## Why `readInventoryRows`, and not `handleObjectVerb{action:'inventory'}`
 *
 * They return the same rows; they do not cost the same. `handleObjectVerb` is
 * the WRITE dispatcher — it reaches `object-validate.ts` (185 KB),
 * `object-patch-apply.ts`, the contract registry and `object-publish.ts` —
 * and measured here it takes this bundle from 380 KB to 1564 KB, three times
 * the cap. `objects/index-store.ts` is the read path M0 built and nothing
 * else: `readInventoryRows` is 2 parallel blob reads and no `list()` on a
 * warm store, and it brings 93 KB with it. The eleven lines this file spends
 * re-applying the verb's own `matchesInventoryFilters` /
 * `compareInventoryRows` (both leaves, already in the graph) are what a
 * 1.1 MB import edge costs to avoid, and they call the SAME two functions the
 * verb calls, so the two answers cannot drift.
 *
 * M2.1 also cut one edge to pay for the section: `object-inventory.ts` used to
 * reach `object-lock.ts` — a record-WRITE library — for two twelve-line pure
 * predicates. They now live in the leaf `lib/object-lock-view.ts`, worth 21 KB
 * here and on every other read path that lists objects.
 *
 * ## `release`: one blob read joined to rows this function already has
 *
 * HISTORY, in two sentences, because the shape of this section is an answer to
 * it: M2.1 wired `release` behind an injected loader and shipped it
 * `{ status: 'skipped', code: 'release_source_unavailable' }`, because
 * `lib/release-overview.ts` statically imported `handleObjectVerb` (1605 KB in
 * this bundle against a 500 KB cap) and because `loadReleaseOverview` made two
 * Netlify deploys-API calls plus a GitHub `/compare` per publish commit on a
 * page-load path. M1 removed both: the deploy facts now live in
 * `snapshots/release.json`, and neither `object-verbs.ts` nor the deploy
 * clients are on the read path any more.
 *
 * So the section is lit, and it costs ONE blob read. Not three.
 *
 * `loadReleaseOverview` costs three — the snapshot, plus `objects/index.json`
 * and `objects/version` for the trusted inventory it re-derives object state
 * from. This function has already read those two, for its `inventory` section,
 * off the same store in the same `Promise.allSettled`. Calling
 * `loadReleaseOverview` here would read them a second time and hand back a
 * `rows` array byte-identical to `sections.inventory.data.objects`. So the
 * section is COMPOSED instead, out of M1's named API and nothing else:
 *
 *   readReleaseSnapshot(store)                    ← the one new read
 *   releaseDeployFacts(snapshot)                  ┐
 *   deriveReleaseObjects(inventoryRows, facts)    │ pure, microseconds,
 *   releaseDeployView(snapshot, nowMs)            │ after the allSettled
 *   releaseCounts(objects)                        ┘
 *
 * `deriveReleaseObjects` is the ONE place an inventory row becomes a release
 * row — the same function `loadReleaseOverview` and `buildReleaseSnapshot`
 * call — and the rows it is given here are `readReleaseRows`' rows: active,
 * in `compareInventoryRows` order. The two surfaces cannot disagree.
 *
 * Rule 2 still holds, and the dependency does not break it. The snapshot read
 * is issued in the SAME `Promise.allSettled` as everything else; what depends
 * on the inventory is the CPU join, which runs after both have landed. The
 * wall cost of the release section is therefore `max(snapshot, inventory)`,
 * already paid, plus a map over rows already in memory.
 *
 * ### Why the boot never rebuilds, and what it answers instead
 *
 * `loadReleaseOverview`'s read path REPAIRS: a missing, corrupt or stale
 * snapshot is rebuilt in place under an interactive budget and written back.
 * That rebuild is the one thing on M1's path that can make an external call,
 * and this function runs on EVERY `/admin/*` navigation. Putting a repair here
 * would mean that the first navigation after a `release-snapshot-refresh`
 * outage pays 14 s — on the page path, for a section the page may not even be
 * showing. That is the exact defect this wave exists to remove, so the boot
 * does not rebuild. Ever. It answers honestly instead, and the two cases are
 * answered differently on purpose:
 *
 *  - STALE (present, `isReleaseSnapshotFresh` false). SERVED, with
 *    `stale: true` and the snapshot's own `as_of`. The facts are real, they
 *    are simply old, and M1 already made their age part of the wire and part
 *    of the UI ("as of hh:mm", M1.3). Refusing here would send every
 *    navigation to `admin-release-state`, whose read path rebuilds — i.e. an
 *    outage of the two-minute refresh would convert itself into a 14 s compute
 *    on every click, which is precisely the trade `RELEASE_SNAPSHOT_MAX_AGE_MS`
 *    was chosen to avoid ("the cost of being slightly stale is a deploy badge
 *    that lags"). A lagging badge that says how old it is beats a fast page
 *    that stalls.
 *  - ABSENT (no blob, unparseable, or written by another schema).
 *    `{ status: 'skipped', code: 'release_snapshot_unavailable' }`. There is
 *    nothing here to label: with no deploy facts at all, `deriveReleaseObjects`
 *    would report every live object as merely `published` and every deploy as
 *    unconfigured. That is M2.1's "a wrong answer fast is not the deliverable",
 *    and it is why this is not simply an empty snapshot. `skipped` sends the
 *    client to `admin-release-state`, which DOES rebuild — so the repair still
 *    happens, once, on the surface that actually wants the data, rather than on
 *    every boot. A cold tenant self-heals on its first visit to `/admin/release`
 *    exactly as M1 designed; the schedule then keeps it warm.
 *
 * A failed INVENTORY read degrades this section to `error`, not the response
 * (Rule 3): without rows there is nothing to join the snapshot to. Note that
 * a dead object store does not reach that branch — `readInventoryRows`
 * swallows store failures by design (`docs/KNOWN_ISSUES.md` #70) and returns
 * an empty, `trusted: false` library — so in practice `error` here means the
 * store could not be OPENED at all.
 *
 * ### The `loadRelease` seam is gone
 *
 * M2.1 injected the section through `createHandler(binding, { loadRelease })`
 * because there was no affordable default. There is one now, and the seam does
 * not survive contact with it: a loader typed to return the finished section
 * is a loader that has to read the inventory itself, which is the second and
 * third blob reads this task exists to remove. Keeping it would leave a
 * supported way to reintroduce them. The tests lost nothing — they seed
 * `snapshots/release.json` into the same in-memory store they already seed
 * object records into, which exercises the real read path rather than a stand-
 * in for it (`tests/netlify/admin-auth-state.test.ts`).
 *
 * ## Cold start
 *
 * This function runs on EVERY navigation, so its bundle is a latency number
 * (`tests/netlify/function-bundle-budget.test.ts` caps it with the trio at
 * 500 KB and bans the MCP surface / `sharp` / `stripe`). It therefore imports
 * every READ path from a LEAF module — `lib/requests/list-snapshot.ts`,
 * `lib/membership/session.ts`, `lib/objects/index-store.ts` — rather than
 * importing `admin-requests.ts`, `admin-users.ts` or `object-verbs.ts` for
 * them, which would have dragged in the workflow-cancel bridge, the entire
 * membership-management surface and the whole object write dispatcher:
 * mutations this function cannot perform, and cannot afford to load.
 *
 * Measured after M2.1: 431 KB across 48 first-party modules — LOWER than the
 * 380 KB this function shipped at with three sections, because the inventory
 * edge (+93 KB) was paid for twice over by two cuts it forced:
 * `lib/object-lock-view.ts` (above) and `lib/admin/request-list-order.ts`,
 * which takes the request filter and sort out of `lib/admin/request-logic.ts`
 * — 52 KB of the request surface's UI vocabulary, plus `severity.ts` behind
 * it, that a server which sorts rows never calls. `admin-requests` got the
 * same 53 KB back.
 *
 * Measured after M2.1b: 453 KB across 50 modules, 47 KB under the cap. The
 * release section cost ONE new module, and that took a third cut: importing
 * `lib/release/snapshot-store.ts` — the spelling M1 exposes — measured 489 KB,
 * because that file is the WRITER and drags `lib/netlify-deploys.ts`,
 * `lib/production-release.ts` and `lib/blob-list.ts` behind
 * `buildReleaseSnapshot`. Code this function can never execute, since it never
 * rebuilds. The read half now lives in the leaf `lib/release/snapshot-view.ts`
 * and the store re-exports it, so no other call site changed.
 *
 * If that cap ever fails, suspect exactly one thing — a new import edge from
 * here to an action handler, to `object-verbs.ts`, or to the non-leaf
 * spelling of a module whose leaf exists (`request-logic.js` for
 * `request-list-order.js`, `object-lock.js` for `object-lock-view.js`,
 * `release/snapshot-store.js` for `release/snapshot-view.js`). Either
 * spelling compiles; only one is on the diet.
 */
import type { SiteBinding } from '../lib/site-binding.js';
import type { LambdaContext } from '../lib/admin-auth.js';
import { resolveAdminAccessSection } from './admin-auth-state.js';
import { getEditorialRequestsBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { getUsersBlobStore } from '../lib/users-store.js';
import { isOwner } from '../lib/roles.js';
import { REQUEST_PAGE_SIZE, buildRequestsListBody, etagFor, siteObjectProbe } from '../lib/requests/list-snapshot.js';
import { resolveMeSection } from '../lib/membership/session.js';
import { readInventoryRows, type ObjectIndexStore } from '../lib/objects/index-store.js';
/**
 * M2.1b — the LEAF spelling, and load bearing that it stays leaf. The same
 * names re-export from `lib/release/snapshot-store.js`, which also carries
 * `buildReleaseSnapshot` and therefore `lib/netlify-deploys.ts`,
 * `lib/production-release.ts` and `lib/blob-list.ts`: 32 KB of deploy-API and
 * GitHub client this function can never execute, because it never rebuilds.
 * Either spelling compiles; only this one is on the diet.
 */
import {
  deriveReleaseObjects,
  isReleaseSnapshotFresh,
  readReleaseSnapshot,
  releaseCounts,
  releaseDeployFacts,
  releaseDeployView,
  type ReleaseSnapshot,
  type ReleaseSnapshotStore,
} from '../lib/release/snapshot-view.js';
import {
  compareInventoryRows,
  matchesInventoryFilters,
  type InventoryRow,
} from '../lib/object-inventory.js';
import { timeSection, timeSerialize, withServerTiming } from '../lib/server-timing.js';
import { objectTypes, type Principal } from '../../schema/object-record-v1.js';
/**
 * TYPE ONLY, and load bearing that it stays that way: esbuild erases an
 * `import type`, so this costs the bundle nothing while pinning this
 * function's release payload to the shape `admin-release-state` serves. A
 * VALUE import of this module still costs 1.2 MB — it reaches
 * `handleObjectVerb` through the rebuild path — which is why the section is
 * composed from `release/snapshot-view.js` instead. See the header.
 */
import type { ReleaseOverview } from '../lib/release-overview.js';

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
 * M2.1 — the `inventory` section's payload, field for field
 * `object_inventory{status:'active'}`'s body.
 *
 * Exported as the section's stated shape. REVIEW (2026-09-16): this used to
 * claim `admin-shell-client.ts` and M2.2's store hold it, and they do not —
 * the client types every section as `AdminShellSection<Record<string,
 * unknown>>` on purpose, because a `packages/core/lib` module that imported
 * a `packages/core/server` type would put a server import in a bundle that
 * ships to the browser. This is the server's own name for what it builds.
 */
export interface AdminShellInventory {
  objects: InventoryRow[];
  generated_at: string;
  /** `readInventoryRows`' own diagnostics — `trusted`, `listed`, `cached`, `read`, `wrote`, `rebuilt`. */
  index: Awaited<ReturnType<typeof readInventoryRows>>['stats'];
}

/**
 * M2.1b — the `release` section's payload: `admin-release-state`'s overview
 * minus the two fields a BOOT cannot honestly serve, plus the one it must.
 *
 * Expressed as an `Omit` of `ReleaseOverview` rather than as a fresh interface
 * so the two surfaces are pinned to one shape by the compiler: a field added
 * to the overview and not handled here is a type error, not a client bug.
 *
 *  - `rows` is dropped because it would be a byte-for-byte duplicate of
 *    `sections.inventory.data.objects` in the same response. `admin-release-
 *    state` carries it because it is the only thing the caller gets; a boot
 *    that shipped both would pay for the whole library twice on the wire.
 *  - `rebuilt` is dropped because it is always `false` here and a constant
 *    field invites someone to trust it. The boot does not rebuild — see
 *    "Why the boot never rebuilds" in the header.
 *  - `stale` is added because it is the honest half of that refusal: the
 *    snapshot is served even when `isReleaseSnapshotFresh` says no, and the
 *    client is told so rather than left to compare `as_of` against a
 *    threshold it would have to duplicate.
 */
export type AdminShellRelease = Omit<ReleaseOverview, 'rows' | 'rebuilt'> & {
  /**
   * True when the served snapshot is older than `RELEASE_SNAPSHOT_MAX_AGE_MS`
   * — i.e. when `admin-release-state` would have rebuilt it. `as_of` says how
   * old; this says that somebody should care.
   */
  stale: boolean;
};

/**
 * The status filter the RELEASE join applies — and only it.
 *
 * REVIEW (2026-09-16): this used to narrow the `inventory` SECTION to
 * `status: 'active'`, and that was a silent contract break. The dedicated
 * endpoint this section replaces is `callObjectVerb({ action: 'inventory' })`
 * with NO filters (`lib/admin/library-client.ts:requestInventory`), so it
 * answers archived rows too — `library-logic.ts:rowStatus` renders them with
 * an "Archived" pill, and `ContentLibrary`, `ObjectBrowser`, the Cmd-K palette
 * and `object-type-resolve.ts` all read them. Worse, `fetchInventoryRowsViaShell`
 * PRIMES the shared `library-client` cache (memory AND `sessionStorage`) with
 * whatever the boot answered, so one narrowed boot took archived objects out
 * of every one of those surfaces for the rest of the session.
 *
 * So the section is the verb's answer, unfiltered, and the one place `active`
 * was actually wanted keeps it: `loadReleaseOverview` derives release state
 * from `readReleaseRows`, which is active-only, and the boot's release section
 * must join the same rows or the two surfaces disagree.
 */
const RELEASE_INVENTORY_STATUS = 'active' as const;

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

const buildHandlerImpl =
  (binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
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
    return jsonResponse(200, {
      sections: { access: accessSection, me: skipped, requests: skipped, inventory: skipped, release: skipped },
    });
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
  /**
   * ONE clock for the whole response. The `inventory` section stamps
   * `generated_at` with it and the `release` join judges the snapshot's
   * freshness against it, so the two sections of one boot cannot disagree
   * about what time it is.
   */
  const nowMs = Date.now();

  // Rule 2: concurrently. Four independent answers off three blob stores;
  // running them in sequence would put `admin-requests`' 212-387 ms of work
  // in front of reads that do not depend on it. This is the whole reason the
  // boot payload can grow from three sections to five and still come in under
  // 900 ms warm: the wall cost is the SLOWEST section, never the sum.
  const [meResult, requestsResult, inventoryResult, snapshotResult] = await Promise.allSettled([
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
    /**
     * M2.1 — the object index, through M0's cheap read path. `readInventoryRows`
     * is 2 parallel blob reads and NO `list()` against a warm store; the filter
     * and the sort are the verb's own two functions, so this row set is the
     * verb's row set. `index` rides along so drift is observable on the
     * response exactly as it is on `object_inventory`: a `trusted: false` here,
     * call after call, means the store is repairing itself every time.
     */
    timeSection('inventory', async (): Promise<AdminShellInventory> => {
      const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ObjectIndexStore;
      const sweep = await readInventoryRows(store, { nowMs });
      // Unfiltered, and sorted by the verb's own comparator — this IS
      // `object_inventory{}`'s body, which is what the client falls back to.
      const objects = [...sweep.rows].sort(compareInventoryRows(objectTypes));
      return { objects, generated_at: new Date(nowMs).toISOString(), index: sweep.stats };
    }),
    /**
     * M2.1b — the publication-state overview's ONE new read: the deploy facts,
     * `snapshots/release.json`, off the same store the `inventory` section is
     * reading concurrently beside it.
     *
     * This entry is the I/O and nothing else — `sec.release` therefore times
     * the blob read, which is the only part of this section that can be slow.
     * The join onto the inventory rows happens after the `allSettled`, in
     * `releaseSection` below, because it is the one thing here that depends on
     * another section's answer. `readReleaseSnapshot` never throws: absent,
     * unreadable, unparseable and wrong-schema all arrive as `undefined`.
     */
    timeSection('release', async (): Promise<ReleaseSnapshot | undefined> => {
      const store = (await getSiteObjectsBlobStore(event, binding)) as unknown as ReleaseSnapshotStore;
      return readReleaseSnapshot(store);
    }),
  ]);

  /**
   * M2.1b — the CPU half of the `release` section, after both its inputs have
   * landed. Pure: a map over rows already in memory and four calls into M1's
   * own derivation. No read happens here.
   */
  const releaseSection = ((): AdminShellSection<AdminShellRelease> => {
    // Opening the store failed. `readReleaseSnapshot` swallows everything
    // else, so this is the only way the read itself rejects.
    if (snapshotResult.status === 'rejected') return failedSection('publication state', snapshotResult.reason);
    // Rule 3, in the one direction a composed section can break: without rows
    // there is nothing to join the deploy facts TO, so the release section
    // degrades on its own rather than serving an empty library as fact.
    if (inventoryResult.status === 'rejected') return failedSection('publication state', inventoryResult.reason);
    const snapshot = snapshotResult.value;
    if (!snapshot) return RELEASE_SNAPSHOT_UNAVAILABLE;

    // ACTIVE rows only, exactly as `readReleaseRows` selects them for
    // `loadReleaseOverview` — an archived object has no release state to show
    // and must not reach `waiting_count`.
    const releaseRows = inventoryResult.value.objects.filter((row) =>
      matchesInventoryFilters(row, { status: RELEASE_INVENTORY_STATUS })
    );
    const objects = deriveReleaseObjects(releaseRows, releaseDeployFacts(snapshot));
    return {
      status: 'ok',
      data: {
        deploy: releaseDeployView(snapshot, nowMs),
        objects,
        ...releaseCounts(objects),
        as_of: snapshot.as_of,
        stale: !isReleaseSnapshotFresh(snapshot, nowMs),
      },
    };
  })();

  // Rule 3: a section that failed is reported as failed, next to the ones
  // that did not. The client then asks the dedicated endpoint for that one
  // section only — it degrades exactly as well as it did when one of three
  // separate calls failed, which is the bar this had to clear, and which the
  // two new sections are held to identically.
  return jsonResponse(200, {
    sections: {
      access: accessSection,
      me:
        meResult.status === 'fulfilled'
          ? { status: 'ok', data: meResult.value }
          : failedSection('member record', meResult.reason),
      requests:
        requestsResult.status === 'fulfilled'
          ? { status: 'ok', data: requestsResult.value }
          : failedSection('requests index', requestsResult.reason),
      inventory:
        inventoryResult.status === 'fulfilled'
          ? { status: 'ok', data: inventoryResult.value }
          : failedSection('object inventory', inventoryResult.reason),
      release: releaseSection,
    },
  });
};

/**
 * The `release` answer when `snapshots/release.json` is absent, unreadable,
 * unparseable or written by another schema version.
 *
 * `skipped` rather than `error`, and the distinction is the whole of this
 * section's honesty: nothing is broken here, the facts simply do not exist
 * yet, and a boot that refuses to invent them has answered correctly. The
 * client's handling of the two is identical (ask `admin-release-state`) while
 * the meaning is not — and in this case that fallback is also the REPAIR, on
 * the one surface that actually wants the data. See the header.
 *
 * Deliberately NOT M2.1's `release_source_unavailable`, which meant "this
 * deploy does not serve the section at all". Every deploy serves it now; this
 * code means "this tenant's snapshot has not been written yet".
 */
const RELEASE_SNAPSHOT_UNAVAILABLE: AdminShellSection<never> = {
  status: 'skipped',
  code: 'release_snapshot_unavailable',
  error: 'Publication state has not been captured for this site yet.',
};

/**
 * W11 T11.4: per-site factory — the site shim instantiates this with its
 * binding, and that is the whole of its surface again: M2.1's `deps` argument
 * carried one thing, the `loadRelease` seam, and M2.1b removed it (see the
 * header). Every shim — six tenants plus the `create-site.mjs` scaffold —
 * already spelled it `createHandler(binding)` and is unchanged.
 */
export const createHandler = (binding: SiteBinding) =>
  withServerTiming('admin-shell', buildHandlerImpl(binding));
