/**
 * Function name: Admin_Requests (W19 T19.2) — the editorial request registry's
 * read/manage door.
 *
 * `list` is deliberately ONE blob GET: it reads `requests/index.json` and never
 * falls back to an N-read scan (plan F7 — the shell polls this). A missing or
 * unparseable index is rebuilt ONCE and the response says so (`rebuilt: true`)
 * rather than degrading to O(N) silently.
 *
 * VISIBILITY (plan §8, a deliberate departure from `agent/chat-visibility.ts`):
 * requests are TEAM-WIDE readable. Any signed-in admin sees every request on
 * the site; `mine` is a view, not a wall. Archive/unarchive is Owner or
 * publisher; cancel is the creator or an Owner; mute is self-only. Do not
 * "fix" the read rule back to creator-scoped — a stalled article belonging to
 * a colleague is the desk's problem, which is the whole point of the surface.
 */
import { createHash } from 'node:crypto';

import { z } from 'zod';

import type { SiteBinding } from '../lib/site-binding.js';
import { CmsAgentClient, isCmsAgentConfigured } from '../lib/agent/cms-agent-client.js';
import { getAdminStateFromEvent, type LambdaContext } from '../lib/admin-auth.js';
import { getEditorialRequestsBlobStore, getSiteObjectsBlobStore } from '../lib/blob-store.js';
import { objectRecordKey } from '../lib/object-store-keys.js';
import { isOwner, resolveRolesForPrincipalAsync, type Role } from '../lib/roles.js';
import { getUsersBlobStore, getUserRecord } from '../lib/users-store.js';
import type { Principal } from '../../schema/object-record-v1.js';
import {
  archiveRequest,
  cancelRequest,
  loadIndex,
  loadRequest,
  projectIndexRow,
  rebuildIndex,
  reconcileObject,
  requeueRequest,
  unarchiveRequest,
  requestStatusSchema,
  type EditorialRequest,
  type EditorialRequestStore,
  type RequestIndexRow,
  type RequestStatus,
} from '../lib/requests/store.js';
import { filterRequestRows, sortRequestRows, type RequestListFilters } from '../../lib/admin/request-logic.js';
import {
  ackNotifications,
  emailModeFor,
  emailModeSchema,
  loadNotifyState,
  loadSeenLedger,
  muteRequest,
  setEmailMode,
  unmuteRequest,
} from '../lib/requests/notify-state.js';

type LambdaEvent = {
  httpMethod?: string;
  body?: string | null;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
};

const jsonHeaders = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
const jsonResponse = (status: number, body: Record<string, unknown>, extraHeaders: Record<string, string> = {}) => ({
  statusCode: status,
  headers: { ...jsonHeaders, ...extraHeaders },
  body: JSON.stringify({ ok: status >= 200 && status < 300, status, ...body }),
});

/**
 * T5.1 R8 (T0.2 F12): the `list` action is the busiest endpoint in the admin —
 * T0.2 measured ~16 requests/minute per open tab against it, every one
 * re-serialising and re-transferring byte-identical JSON, because there was no
 * `ETag` anywhere in `server/functions/` and `no-store` forbade even
 * conditional revalidation.
 *
 * This is an EXPLICIT conditional-request protocol between this handler and
 * `requests-client.ts`, not browser HTTP caching: the action is a POST, so no
 * cache would honour it. The client keeps the last `ETag` and sends it as
 * `If-None-Match`; an unchanged view comes back `304` with an empty body and
 * the client keeps the snapshot it already has.
 *
 * It saves BYTES and serialisation, never blob reads — the handler still reads
 * the index, the notify state and the seen ledger before it can hash. Pairs
 * with the index read those three already collapsed to.
 */
const LIST_CACHE_CONTROL = 'private, no-cache';
const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** Page size for `list`. The index is bounded already; this bounds the wire. */
export const REQUEST_PAGE_SIZE = 100;

/** One client per site process (the PF1 design), so a cancel can reach the run. */
const cmsAgentClient = new CmsAgentClient();

/**
 * Cancelling the RECORD without cancelling the RUN would leave the workflow
 * executing — spending budget, and still walking toward its publish gate —
 * while the desk reads "Cancelled". Best-effort by design: an unreachable
 * bridge must not block a human from closing a request, so the failure is
 * recorded in the request's own history rather than thrown at the caller.
 */
const cancelWorkflowRun = async (runId: string): Promise<string | undefined> => {
  if (!isCmsAgentConfigured()) return 'cms_agent_unavailable';
  try {
    const result = await cmsAgentClient.callTool('workflow_cancel_run', { runId });
    return result.ok ? undefined : result.code || 'cancel_failed';
  } catch (error) {
    return error instanceof Error ? error.message.slice(0, 120) : 'cancel_threw';
  }
};

/** Exported for the contract test (the admin-governance.test.ts precedent: no auth-injection seam exists). */
export const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('list'),
    status: z.array(requestStatusSchema).optional(),
    kind: z.array(z.string().min(1)).optional(),
    mine: z.boolean().optional(),
    archived: z.boolean().optional(),
    q: z.string().max(200).optional(),
    cursor: z.string().max(200).optional(),
    limit: z.number().int().positive().max(REQUEST_PAGE_SIZE).optional(),
  }),
  z.object({ action: z.literal('get'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('archive'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('unarchive'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('cancel'), request_id: z.string().min(1), reason: z.string().max(2000).optional() }),
  z.object({ action: z.literal('mute'), request_id: z.string().min(1) }),
  /** B2: the surface's Retry button — `requeueRequest` is the writer, this is only its door. */
  z.object({ action: z.literal('retry'), request_id: z.string().min(1) }),
  z.object({ action: z.literal('unmute'), request_id: z.string().min(1) }),
  /**
   * T19.6: the client says what it has now shown this person. Stored
   * server-side so the dedup holds across tabs, devices and reloads — browser
   * storage would re-announce an approval on every new tab.
   */
  z.object({ action: z.literal('notify_ack'), acked: z.record(z.string(), z.string()) }),
  z.object({ action: z.literal('set_email_mode'), mode: emailModeSchema }),
]);

/** Archive/unarchive: Owner, or the W18 publisher tier (plan §8). Exported for the gating test. */
export const canArchive = (roles: readonly Role[]): boolean => isOwner(roles) || roles.includes('publisher');

/**
 * B2 — how a refused retry reaches the browser, kept out of the handler so it
 * is testable without an Identity-authenticated event (the module's own
 * `canArchive` precedent).
 *
 * `requeueRequest` reports the reason AND the status it refused on; the one
 * refusal that carries no status is "there is no such request" (404).
 * Everything else is a CONFLICT with the row's current state, so 409 —
 * sharpest for `needs_you`, where the request is waiting on a human and
 * retrying it is a category error, not a transient failure: pushing a gate
 * does not open it. The reason is the store's own sentence, verbatim.
 */
export const retryRefusal = (failure: { reason: string; status?: RequestStatus }): { code: number; error: string } =>
  failure.status ? { code: 409, error: failure.reason } : { code: 404, error: 'Request not found.' };

/**
 * The index, rebuilding ONCE when it is absent or unreadable. Never scans on
 * the happy path — see the module header.
 */
const readIndex = async (
  store: EditorialRequestStore
): Promise<{ rows: RequestIndexRow[]; seq: number; rebuilt: boolean }> => {
  const existing = await loadIndex(store);
  if (existing) return { rows: existing.rows, seq: existing.seq, rebuilt: false };
  const rebuilt = await rebuildIndex(store);
  return { rows: rebuilt.rows, seq: rebuilt.seq, rebuilt: true };
};

// ─── C2: the object a finished run produced, reconciled onto its row ─────────

/**
 * The bug: a `done` row for a published article rendered BOTH Open object and
 * Publish disabled with "No object attached". `object_id` is written in
 * exactly one place — the sweeper, on the pass that sees `article_body`
 * complete — and only while the request is still sweepable, so a run that
 * reached a terminal status without passing through that moment never got one,
 * and never would: a terminal request is never polled again.
 *
 * This is the repair, on the read path, under three rules:
 *
 *  1. It NEVER guesses. `object_id === request_id` by construction (that is
 *     what `sweep.ts` writes), but the id is only recorded once the object
 *     record is proven to be in the store. A guess would put a permanent link
 *     to a 404 in the inbox, and "No object attached" is the honest answer
 *     when there is genuinely no object.
 *  2. It is bounded. `list` is polled roughly four times a minute per open
 *     tab; turning that into one object read per row would be a new N-read
 *     path in the endpoint whose whole point is one blob GET. Only `done`
 *     rows, only ones missing the field, at most `OBJECT_BACKFILL_MAX` per
 *     call, and never one this process has already looked for and not found.
 *  3. It is one-shot. A found object is recorded on the doc, so the row
 *     carries it from then on and no probe is made again.
 */
export const OBJECT_BACKFILL_MAX = 5;

/**
 * Request ids not worth probing again yet, and until when. Per-process and
 * lossy on a cold start, which is the right trade — this is a cost control,
 * never a fact anyone reads.
 *
 * C2c: the two outcomes are NOT the same, and conflating them was a bug.
 *
 *   a TRUE MISS — no object record at all — is permanent (`Infinity`). A
 *   terminal run that produced nothing will not start producing one.
 *
 *   EXISTS BUT UNPUBLISHED is a live fact that changes the moment someone
 *   clicks Publish, so it expires. Caching it made the inbox show the article
 *   as unpublished after a publish from that very row, and invited a second
 *   click on an article that was already live — hiding exactly the transition
 *   this wave exists to make visible.
 */
const objectProbeSkipUntil = new Map<string, number>();
const OBJECT_PROBE_MEMO_MAX = 500;

/**
 * How long an "exists but unpublished" answer stands. Matched to
 * `requestPollIntervalFor`'s idle floor (30 s, the cadence a Done-only tab
 * polls at), so the tab Wolf is looking at re-reads on essentially every poll,
 * while a page that also holds a running run — polling every 5 s — still
 * cannot spend more than OBJECT_BACKFILL_MAX object reads per 30 s window,
 * however many tabs are open on the same warm process.
 */
export const OBJECT_UNPUBLISHED_TTL_MS = 30_000;

/** The suite clears this between cases; nothing else may touch it. */
export const resetObjectBackfillMemoForTesting = (): void => objectProbeSkipUntil.clear();

const rememberSkip = (skipUntil: Map<string, number>, requestId: string, until: number): void => {
  if (skipUntil.size >= OBJECT_PROBE_MEMO_MAX) skipUntil.clear();
  skipUntil.set(requestId, until);
};

/** Which rows on this page are worth one object read. Exported for the bound test. */
export const objectBackfillCandidates = (
  rows: readonly { request_id: string; status: RequestStatus; object_id?: string; object_published?: boolean }[],
  skipUntil: ReadonlyMap<string, number> = objectProbeSkipUntil,
  nowMs: number = Date.now(),
  max: number = OBJECT_BACKFILL_MAX
): string[] =>
  rows
    // C2b: a finished row is worth a read while EITHER answer is still
    // missing — the object it names, or whether that object was published.
    .filter(
      (row) =>
        row.status === 'done' &&
        (!row.object_id || !row.object_published) &&
        (skipUntil.get(row.request_id) ?? 0) <= nowMs
    )
    .slice(0, max)
    .map((row) => row.request_id);

/**
 * C2b — what the object record PROVES about publication, read from the record
 * this call already fetches to check the object exists.
 *
 * `object_publish` (`server/lib/object-publish.ts`) is the only writer of these
 * fields, and it stamps `published_time` ONLY after the export commit
 * succeeded — so a stamped record is proof, not a guess. `publish_receipt` is
 * that commit's own receipt; without it the record under-claims and so does
 * this. Nothing here reads status, age or the mere existence of the object.
 *
 * FIX 1: it answers PUBLISHED and nothing else. It used to also mint a
 * `live_path` from `publish_receipt`, on the reasoning that a committed export
 * is eventually served — but `object-publish.ts` commits with
 * `[skip netlify]` (`withDeferredDeployMarker`) and stamps the receipt at
 * commit time, so the receipt proves the export, never the deploy. `live_path`
 * is defined on the request doc as release-CONFIRMED (`store.ts`), and
 * `NO_LIVE_PATH` (`lib/admin/request-logic.ts`) is the sentence for a
 * published row with no confirmed URL. A record cannot clear that bar, so it
 * does not try: a legacy row gets Open object enabled and View live disabled
 * with the honest reason, rather than a link that 404s until someone releases.
 */
export const publicationFromObjectRecord = (raw: string): { published: boolean } => {
  let record: unknown;
  try {
    record = JSON.parse(raw);
  } catch {
    // The object is there (the blob answered) but says nothing readable about
    // publication, so it proves nothing.
    return { published: false };
  }
  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
  if (!isRecord(record)) return { published: false };
  const publication = isRecord(record.publication) ? record.publication : undefined;
  const published = typeof publication?.published_time === 'string' && publication.published_time.length > 0;
  return { published };
};

/** The object store's answer for one request: `undefined` when there is no record at all. */
export type ObjectExistenceProbe = (objectId: string) => Promise<{ published: boolean } | undefined>;

/**
 * One request. `undefined` back means nothing changed — either the object is
 * not there (recorded in the memo, so the next poll is free) or the probe
 * could not answer, which is NOT a verdict and is deliberately not memoised.
 */
const reconcileOneObject = async (
  store: EditorialRequestStore,
  requestId: string,
  exists: ObjectExistenceProbe,
  skipUntil: Map<string, number>,
  nowMs: number
): Promise<EditorialRequest | undefined> => {
  let found: { published: boolean } | undefined;
  try {
    found = await exists(requestId);
  } catch {
    // A store that could not answer says nothing about the article, so this is
    // retried on the next poll rather than memoised as a verdict.
    return undefined;
  }
  if (!found) {
    // A true miss: there is no object, and a terminal run will not make one.
    rememberSkip(skipUntil, requestId, Number.POSITIVE_INFINITY);
    return undefined;
  }
  const doc = await reconcileObject(store, requestId, {
    object_type: 'content_item',
    object_id: requestId,
    ...(found.published ? { published: true } : {}),
  }).catch(() => undefined);
  // C2c: the object is THERE and simply not published yet. That answer is only
  // good for a moment — a click on this row's own Publish changes it — so it
  // is held briefly to bound the read rate and then re-read, never cached
  // until the process recycles.
  if (doc?.object?.published !== true) {
    rememberSkip(skipUntil, requestId, nowMs + OBJECT_UNPUBLISHED_TTL_MS);
  } else {
    // Answered for good — the row carries it now and is not a candidate again.
    skipUntil.delete(requestId);
  }
  return doc?.object ? doc : undefined;
};

/**
 * The page, with any object this call could prove filled in. `wrote` says
 * whether the index moved, so the caller can re-read `seq` on the one call
 * that changed it rather than on every poll.
 */
export const backfillPageObjects = async (
  store: EditorialRequestStore,
  page: readonly RequestIndexRow[],
  exists: ObjectExistenceProbe,
  skipUntil: Map<string, number> = objectProbeSkipUntil,
  nowMs: number = Date.now()
): Promise<{ rows: RequestIndexRow[]; wrote: boolean }> => {
  const candidates = objectBackfillCandidates(page, skipUntil, nowMs);
  if (candidates.length === 0) return { rows: [...page], wrote: false };

  const repaired = new Map<string, RequestIndexRow>();
  let wrote = false;
  for (const requestId of candidates) {
    const before = page.find((row) => row.request_id === requestId);
    const doc = await reconcileOneObject(store, requestId, exists, skipUntil, nowMs);
    if (!doc) continue;
    // Project the row from the doc that was just written, so the response and
    // the index cannot disagree about what was recorded.
    const row = projectIndexRow(doc);
    repaired.set(requestId, row);
    if (JSON.stringify(before) !== JSON.stringify(row)) wrote = true;
  }
  return { rows: page.map((row) => repaired.get(row.request_id) ?? row), wrote };
};

/**
 * The probe, over the site's object store. Created per call and connected
 * LAZILY — a poll with nothing to reconcile (the steady state) never opens the
 * store at all.
 */
const siteObjectProbe = (event: LambdaEvent): ObjectExistenceProbe => {
  let store: Promise<{ get(key: string): Promise<string | null> }> | undefined;
  return async (objectId) => {
    store ??= getSiteObjectsBlobStore(event);
    const raw = await (await store).get(objectRecordKey('content_item', objectId));
    // C2b: the SAME read answers both questions — is the object there, and
    // does its record prove a publish. No extra fetch, so the cost profile is
    // exactly C2's.
    return raw === null || raw === undefined ? undefined : publicationFromObjectRecord(raw);
  };
};

const buildHandlerImpl = (_binding: SiteBinding) => async (event: LambdaEvent, context?: LambdaContext) => {
  if (event.httpMethod !== 'POST') return jsonResponse(405, { error: 'Method not allowed' });
  const adminState = await getAdminStateFromEvent(event, context);
  if (!adminState.authenticated) return jsonResponse(401, { error: adminState.error ?? 'Unauthorized' });

  const callerPrincipal: Principal = { kind: 'human', id: adminState.userId ?? '', email: adminState.email ?? '' };
  const callerRoles = await resolveRolesForPrincipalAsync(callerPrincipal, {
    getUserRecord: async (email) => getUserRecord(await getUsersBlobStore(event), email),
  });
  if (!callerRoles.includes('admin')) return jsonResponse(403, { error: 'Admin access required' });

  let parsedBody: unknown;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : (event.body ?? '');
    parsedBody = JSON.parse(raw);
  } catch {
    return jsonResponse(400, { error: 'Invalid request body.' });
  }
  const request = requestSchema.safeParse(parsedBody);
  if (!request.success) return jsonResponse(400, { error: 'Invalid request fields.', issues: request.error.issues });

  const callerEmail = (adminState.email ?? '').trim().toLowerCase();

  try {
    const store = await getEditorialRequestsBlobStore(event);

    switch (request.data.action) {
      case 'list': {
        const { rows, seq, rebuilt } = await readIndex(store);
        const filters: RequestListFilters = {
          ...(request.data.status ? { status: request.data.status } : {}),
          ...(request.data.kind ? { kind: request.data.kind } : {}),
          ...(request.data.mine !== undefined ? { mine: request.data.mine } : {}),
          ...(request.data.archived !== undefined ? { archived: request.data.archived } : {}),
          ...(request.data.q ? { q: request.data.q } : {}),
          callerEmail,
        };
        const matched = sortRequestRows(filterRequestRows(rows, filters));
        const limit = request.data.limit ?? REQUEST_PAGE_SIZE;
        const start = request.data.cursor ? Math.max(0, Number.parseInt(request.data.cursor, 10) || 0) : 0;
        const page = matched.slice(start, start + limit);
        const nextCursor = start + limit < matched.length ? String(start + limit) : undefined;
        // C2: a finished row whose doc never recorded its object. Bounded and
        // one-shot — see the block above the handler for the three rules.
        const backfilled = await backfillPageObjects(store, page, siteObjectProbe(event));
        // `seq` is the index's write counter, so it is re-read on the one call
        // that actually wrote and left alone on every other.
        const seqNow = backfilled.wrote ? ((await loadIndex(store))?.seq ?? seq) : seq;
        const notify = await loadNotifyState(store, callerEmail);
        const seen = await loadSeenLedger(store, callerEmail, notify);
        const listBody: Record<string, unknown> = {
          requests: backfilled.rows,
          total: matched.length,
          seq: seqNow,
          ...(nextCursor ? { next_cursor: nextCursor } : {}),
          ...(rebuilt ? { rebuilt: true } : {}),
          muted: notify?.muted ?? [],
          last_notified: seen,
          /**
           * First contact. An empty ledger and a NEVER-WRITTEN ledger look
           * identical on the wire, and the browser treats every difference as
           * news — so on the day this ships, and on every new team member's
           * first visit, each of them would get a toast and a desktop
           * notification for every finished, failed and waiting job on the
           * site at once. The flag lets the first ingest ack silently.
           */
          ...(Object.keys(seen).length === 0 ? { notify_first_contact: true } : {}),
          email_mode: emailModeFor(notify),
        };
        const etag = etagFor(listBody);
        const ifNoneMatch = event.headers?.['if-none-match'] ?? event.headers?.['If-None-Match'];
        if (ifNoneMatch && ifNoneMatch === etag) {
          return { statusCode: 304, headers: { 'Cache-Control': LIST_CACHE_CONTROL, ETag: etag }, body: '' };
        }
        return jsonResponse(200, listBody, { 'Cache-Control': LIST_CACHE_CONTROL, ETag: etag });
      }

      case 'get': {
        const doc = await loadRequest(store, request.data.request_id);
        if (!doc) return jsonResponse(404, { error: 'Request not found.' });
        // C2: the same reconciliation the list makes, for the one request the
        // drawer opened — the detail view draws the same row actions.
        const reconciled =
          doc.status === 'done' && doc.object?.published === undefined
            ? await reconcileOneObject(store, doc.request_id, siteObjectProbe(event), objectProbeSkipUntil, Date.now())
            : undefined;
        return jsonResponse(200, { request: reconciled ?? doc });
      }

      case 'archive':
      case 'unarchive': {
        if (!canArchive(callerRoles)) {
          return jsonResponse(403, { error: 'Owner or publisher access required to archive a request.' });
        }
        const doc =
          request.data.action === 'archive'
            ? await archiveRequest(store, request.data.request_id, callerEmail)
            : await unarchiveRequest(store, request.data.request_id, callerEmail);
        if (!doc) return jsonResponse(404, { error: 'Request not found.' });
        return jsonResponse(200, { request: doc });
      }

      case 'cancel': {
        const existing = await loadRequest(store, request.data.request_id);
        if (!existing) return jsonResponse(404, { error: 'Request not found.' });
        const isCreator = existing.created_by.trim().toLowerCase() === callerEmail;
        if (!isCreator && !isOwner(callerRoles)) {
          return jsonResponse(403, { error: 'Only the editor who asked for this, or an Owner, can cancel it.' });
        }
        const runCancelFailure = existing.workflow?.run_id
          ? await cancelWorkflowRun(existing.workflow.run_id)
          : undefined;
        const reason = request.data.reason
          ? request.data.reason
          : runCancelFailure
            ? `Cancelled by ${callerEmail}. The workflow run could not be stopped (${runCancelFailure}) — check it on the workspace surface.`
            : undefined;
        const doc = await cancelRequest(store, request.data.request_id, {
          by: callerEmail,
          ...(reason ? { reason } : {}),
        });
        return jsonResponse(200, {
          request: doc,
          ...(runCancelFailure ? { run_cancel_failed: runCancelFailure } : {}),
        });
      }

      case 'retry': {
        // The registry endpoint is already admin-gated above, which is at or
        // above the `edit` tier `rowActions` asks for; `requeueRequest` owns
        // every state rule (terminal, needs_you, still-moving, no run).
        const result = await requeueRequest(store, request.data.request_id);
        if (!result.ok) {
          const refusal = retryRefusal(result);
          return jsonResponse(refusal.code, { error: refusal.error });
        }
        return jsonResponse(200, { request: result.doc });
      }

      case 'set_email_mode': {
        const state = await setEmailMode(store, callerEmail, request.data.mode);
        return jsonResponse(200, { email_mode: emailModeFor(state) });
      }

      case 'notify_ack': {
        const entries = await ackNotifications(store, callerEmail, request.data.acked);
        return jsonResponse(200, { last_notified: entries });
      }

      case 'mute':
      case 'unmute': {
        const state =
          request.data.action === 'mute'
            ? await muteRequest(store, callerEmail, request.data.request_id)
            : await unmuteRequest(store, callerEmail, request.data.request_id);
        return jsonResponse(200, { muted: state.muted });
      }
    }
  } catch (error) {
    console.error('Admin_Requests request failed.', error);
    return jsonResponse(500, { error: 'Request registry call could not be processed.' });
  }
};

/** W11 T11.4: per-site factory — the site shim instantiates this with its binding. */
export const createHandler = (binding: SiteBinding) => buildHandlerImpl(binding);
