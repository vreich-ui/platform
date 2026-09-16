/**
 * list-snapshot.ts — the `admin-requests` `list` answer, as a leaf.
 *
 * WHY THIS IS A SEPARATE MODULE, and not still inside `admin-requests.ts`:
 * `admin-shell.ts` returns this same snapshot as one section of its single
 * coalesced response, and a shell function is measured by its COLD START
 * (`tests/netlify/function-bundle-budget.test.ts`) as much as by its work.
 * Importing `admin-requests.ts` to reuse its `list` logic would have dragged
 * `lib/agent/cms-agent-client.ts` (42 KB of first-party source, reached only
 * by the `cancel` action's workflow-cancel call) into a function that cannot
 * cancel anything — so the READ path moved down here, where both callers can
 * reach it without reaching each other's write paths. `admin-requests.ts`
 * re-exports everything its own tests already imported by name, so nothing
 * outside had to move with it.
 *
 * Everything here is VERBATIM from `admin-requests.ts` (W19 T19.2 → W21.1,
 * C2/C2b/C2c and FIX 1/2/8) apart from `buildRequestsListBody`, which is the
 * `list` case's body lifted into a function so the two call sites cannot
 * drift. Read the block comments as the history they are.
 *
 * The object-probe memo below is module scope, which is the point: it is a
 * per-process read-rate control, so `admin-requests` and `admin-shell` each
 * keep their own (they are separate Lambdas and always were) while the two
 * code paths inside one of them share one.
 */
import { createHash } from 'node:crypto';

import { getSiteObjectsBlobStore } from '../blob-store.js';
import { objectRecordKey } from '../object-store-keys.js';
import type { SiteBinding } from '../site-binding.js';
import {
  loadIndex,
  projectIndexRow,
  rebuildIndex,
  reconcileObject,
  type EditorialRequest,
  type EditorialRequestStore,
  type RequestIndexRow,
  type RequestStatus,
} from './store.js';
import { emailModeFor, loadRequestInbox } from './notify-state.js';
import { filterRequestRows, sortRequestRows, type RequestListFilters } from '../../../lib/admin/request-list-order.js';

/** The minimal event shape the object probe needs — just enough for `getSiteObjectsBlobStore`. */
type BlobEvent = { headers?: Record<string, string | undefined> };

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
export const LIST_CACHE_CONTROL = 'private, no-cache';
export const etagFor = (body: unknown): string => `"${createHash('sha1').update(JSON.stringify(body)).digest('hex')}"`;

/** Page size for `list`. The index is bounded already; this bounds the wire. */
export const REQUEST_PAGE_SIZE = 100;

/**
 * The index, rebuilding ONCE when it is absent or unreadable. Never scans on
 * the happy path — see the module header.
 */
export const readIndex = async (
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
export interface ObjectProbeVerdict {
  /**
   * W21.1 — whether the probe SAW a platform object record. This is the fact
   * `open_object` is gated on, and the only place it exists: the index row
   * cannot carry it (`store.ts`'s row field set is closed, and both fields it
   * does carry — `object_id` from `sweep.ts`, `object_published` from the run's
   * receipts — describe the RUN, not the library).
   */
  in_library: boolean;
  /** When this row is worth one object read again. `Infinity` = never. */
  until: number;
}

export const objectProbeMemo = new Map<string, ObjectProbeVerdict>();
/** Bound on the memo; oldest-out past it (`remember`). Exported for the bound test. */
export const OBJECT_PROBE_MEMO_MAX = 500;

/**
 * How long an "exists but unpublished" answer stands. Matched to
 * `requestPollIntervalFor`'s idle floor (30 s, the cadence a Done-only tab
 * polls at), so the tab Wolf is looking at re-reads on essentially every poll,
 * while a page that also holds a running run — polling every 5 s — still
 * cannot spend more than OBJECT_BACKFILL_MAX object reads per 30 s window,
 * however many tabs are open on the same warm process.
 */
export const OBJECT_UNPUBLISHED_TTL_MS = 30_000;

/**
 * FIX 2 — how long "the library has no record for this row" is believed.
 *
 * `Infinity` was right while a miss meant "this run made nothing and never
 * will". It stopped being right the moment W21.1 put that answer on screen as
 * "Not in the library yet — publish first": publishing is PRECISELY the
 * transition that creates the record, so the operator does what the row asks,
 * `object_publish` writes the object store — and nothing writes the request
 * doc (`recordPublication` is the sweeper's, and the sweeper is not in this
 * path), so the row stayed a candidate on paper and was excluded by its own
 * `until: Infinity` for the life of the process. The reason told the truth and
 * then refused to notice it had been acted on.
 *
 * 60 s, against the read-rate bound:
 *  - The HARD bound is untouched: `objectBackfillCandidates` still slices to
 *    `OBJECT_BACKFILL_MAX`, so a list call makes at most 5 object reads no
 *    matter how many rows are in this state.
 *  - The steady-state cadence for a page with nothing live is 30 s
 *    (`requestPollIntervalFor`), so this is one read per row per TWO polls —
 *    half the rate C2c already accepts for "exists but unpublished" (30 s),
 *    which is the right ordering: a miss changes only when a human acts.
 *  - And it is inside the operator's own attention span: the record appears
 *    on the next publish, and the row picks it up within a minute — the same
 *    poll that flips `object_published` and retires the row from the candidate
 *    set for good.
 */
export const OBJECT_MISSING_TTL_MS = 60_000;

/** The suite clears this between cases; nothing else may touch it. */
export const resetObjectBackfillMemoForTesting = (): void => objectProbeMemo.clear();

/**
 * FIX 8 — evict the oldest entries, rather than wiping the map.
 *
 * `memo.clear()` was cheap and, while the memo only suppressed reads, harmless.
 * It stopped being harmless when W21.1 made the memo a source of what the ROW
 * SAYS: a single write past the cap dropped every verdict at once, so a whole
 * page reverted to "not in the library" and re-converged at
 * `OBJECT_BACKFILL_MAX` rows per poll. FIX 1 removes most of that exposure —
 * published rows no longer depend on the memo at all — but the blunt instrument
 * is still a blunt instrument, and a `Map` iterates in insertion order, so
 * dropping from the front is the whole change.
 */
const remember = (memo: Map<string, ObjectProbeVerdict>, requestId: string, verdict: ObjectProbeVerdict): void => {
  memo.delete(requestId); // re-inserting moves it to the young end
  while (memo.size >= OBJECT_PROBE_MEMO_MAX) {
    const oldest = memo.keys().next();
    if (oldest.done) break;
    memo.delete(oldest.value);
  }
  memo.set(requestId, verdict);
};

/** Which rows on this page are worth one object read. Exported for the bound test. */
export const objectBackfillCandidates = (
  rows: readonly { request_id: string; status: RequestStatus; object_id?: string; object_published?: boolean }[],
  memo: ReadonlyMap<string, ObjectProbeVerdict> = objectProbeMemo,
  nowMs: number = Date.now(),
  max: number = OBJECT_BACKFILL_MAX
): string[] =>
  rows
    // C2b: a finished row is worth a read while EITHER answer is still
    // missing — the object it names, or whether that object was published.
    //
    // FIX 1 removes W21.1's third term (`|| !memo.has(...)`). It made every
    // published row a candidate so the probe could confirm library presence,
    // but a published row does not need a probe: publication ENTAILS the
    // platform record (see `libraryPresence`). Asking anyway cost a read per
    // row AND — because only `OBJECT_BACKFILL_MAX` of them fit in a page —
    // left the rest of the page rendering "not in the library" about rows the
    // library certainly holds. The read profile here is exactly C2's again.
    .filter(
      (row) =>
        row.status === 'done' &&
        (!row.object_id || !row.object_published) &&
        (memo.get(row.request_id)?.until ?? 0) <= nowMs
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
 *
 * It WRITES the memo and never reads it, so the `get` case is a second
 * recovery door on top of FIX 2's window: opening a row asks the library
 * again straight away rather than waiting for the window to lapse.
 */
export const reconcileOneObject = async (
  store: EditorialRequestStore,
  requestId: string,
  exists: ObjectExistenceProbe,
  memo: Map<string, ObjectProbeVerdict>,
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
    // The library has no record. That is the state `open_object` must refuse,
    // and the only place it is ever proven — but FIX 2 holds it for a window
    // rather than for ever, because the publish the row is asking for is what
    // makes the record appear (see `OBJECT_MISSING_TTL_MS`).
    remember(memo, requestId, { in_library: false, until: nowMs + OBJECT_MISSING_TTL_MS });
    return undefined;
  }
  const doc = await reconcileObject(store, requestId, {
    object_type: 'content_item',
    object_id: requestId,
    ...(found.published ? { published: true } : {}),
  }).catch(() => undefined);
  // W21.1: the record was READ, so library presence is settled whatever the
  // reconciliation write then did with it — the two are separate facts and
  // only this one gates Open object.
  if (doc?.object?.published !== true) {
    // C2c: the object is THERE and simply not published yet. That answer is
    // only good for a moment — a click on this row's own Publish changes it —
    // so it is held briefly to bound the read rate and then re-read, never
    // cached until the process recycles.
    remember(memo, requestId, { in_library: true, until: nowMs + OBJECT_UNPUBLISHED_TTL_MS });
  } else {
    // Answered for good. `Infinity` rather than a delete: the row is no longer
    // a candidate on the publication question, and W21.1's library question is
    // settled too — dropping the entry would make it a candidate again forever.
    remember(memo, requestId, { in_library: true, until: Number.POSITIVE_INFINITY });
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
  memo: Map<string, ObjectProbeVerdict> = objectProbeMemo,
  nowMs: number = Date.now()
): Promise<{ rows: RequestListRow[]; wrote: boolean }> => {
  const candidates = objectBackfillCandidates(page, memo, nowMs);
  if (candidates.length === 0) return { rows: withLibraryFacts(page, memo), wrote: false };

  const repaired = new Map<string, RequestIndexRow>();
  let wrote = false;
  for (const requestId of candidates) {
    const before = page.find((row) => row.request_id === requestId);
    const doc = await reconcileOneObject(store, requestId, exists, memo, nowMs);
    if (!doc) continue;
    // Project the row from the doc that was just written, so the response and
    // the index cannot disagree about what was recorded.
    const row = projectIndexRow(doc);
    repaired.set(requestId, row);
    if (JSON.stringify(before) !== JSON.stringify(row)) wrote = true;
  }
  return {
    rows: withLibraryFacts(
      page.map((row) => repaired.get(row.request_id) ?? row),
      memo
    ),
    wrote,
  };
};

/**
 * W21.1 — the response row, which is the stored row plus one fact the store
 * does not hold.
 *
 * `RequestIndexRow`'s field set is CLOSED by `store.ts` (and asserted there),
 * and `server/lib/requests/*` is not this task's to widen — nor should it be:
 * library presence is a per-process observation about ANOTHER store, not a
 * property of the request. It rides the response only.
 */
export type RequestListRow = RequestIndexRow & { object_in_library?: boolean };

/**
 * FIX 1 — the one place library presence is decided, in the two ways it can
 * be known.
 *
 * PUBLICATION ENTAILS PRESENCE, so a published row needs no read at all.
 * `object_published` is only ever set from proof: the sweeper's publication
 * evidence (the run's own publish receipt, `sweep.ts`) or the object record's
 * `published_time` (`publicationFromObjectRecord`). Neither can exist without
 * a platform record, so `true` here is DERIVED, not assumed — guardrail 5 is
 * about not inventing facts, and an entailment is not an invention.
 *
 * That leaves the probe answering the one question it is actually needed for:
 * `done && !object_published`, the finished-but-unpublished row W21.1 exists
 * for. There, and only there, "Not in the library yet — publish first" is both
 * true and actionable, because Publish is the primary on that branch.
 *
 * `undefined` back means nobody has looked and nothing entails an answer,
 * which `rowActions` renders as unconfirmed rather than as present.
 */
export const libraryPresence = (published: boolean, memoed: ObjectProbeVerdict | undefined): boolean | undefined =>
  published ? true : memoed?.in_library;

/**
 * Attach what the probe has actually seen. Three states survive to the wire —
 * `true` (a record was read), `false` (a probe looked and found none) and
 * ABSENT (nobody has looked) — because `rowActions` must be able to tell
 * "proven absent" from "unknown" even though it renders them the same way.
 * Only `done` rows carry the field at all; it is the only status probed.
 */
export const withLibraryFacts = (
  rows: readonly RequestIndexRow[],
  memo: ReadonlyMap<string, ObjectProbeVerdict> = objectProbeMemo
): RequestListRow[] =>
  rows.map((row) => {
    if (row.status !== 'done') return row;
    const inLibrary = libraryPresence(row.object_published === true, memo.get(row.request_id));
    return inLibrary === undefined ? row : { ...row, object_in_library: inLibrary };
  });

/**
 * The probe, over the site's object store. Created per call and connected
 * LAZILY — a poll with nothing to reconcile (the steady state) never opens the
 * store at all.
 */
export const siteObjectProbe = (event: BlobEvent, binding?: SiteBinding): ObjectExistenceProbe => {
  let store: Promise<{ get(key: string): Promise<string | null> }> | undefined;
  return async (objectId) => {
    store ??= getSiteObjectsBlobStore(event, binding);
    const raw = await (await store).get(objectRecordKey('content_item', objectId));
    // C2b: the SAME read answers both questions — is the object there, and
    // does its record prove a publish. No extra fetch, so the cost profile is
    // exactly C2's.
    return raw === null || raw === undefined ? undefined : publicationFromObjectRecord(raw);
  };
};

/**
 * The `list` answer, as one function both `admin-requests.ts` (the action) and
 * `admin-shell.ts` (the coalesced shell section) call.
 *
 * Deliberately returns the BODY, not a response: the two callers wrap it
 * differently — one in its own `jsonResponse` with the `ETag`/`Cache-Control`
 * pair and the `304` short-circuit, the other as one section of a larger
 * document — and the `ETag` is computed over exactly this object, so the hash
 * stays the hash of what the client receives either way.
 *
 * ## Read cost (M2.1)
 *
 * The steady state is ONE PARALLEL STAGE of three blob reads — the request
 * index, the caller's notify settings and their seen ledger — where it used to
 * be three SERIAL ones (index, then notify, then seen: ~440 ms of round trips
 * for ~150-250 ms of work). Nothing in the notify pair answers a question the
 * index asked, or the other way round, so the only thing that ever made them
 * sequential was the order they were written in.
 *
 * On top of that stage, unchanged and still conditional: at most
 * `OBJECT_BACKFILL_MAX` object reads for finished rows missing their object,
 * and the index re-read ONLY when that backfill actually wrote.
 *
 * `loadRequestInbox`'s own header records why the two notify reads are two
 * reads and not one merged document — the M2.1 task asked for the merge and
 * it was refused, because `store.ts` splits those keys by writer to kill a
 * lost-mute race, and parallelism buys the same latency for nothing.
 */
export interface RequestsListQuery {
  status?: RequestStatus[];
  kind?: string[];
  mine?: boolean;
  archived?: boolean;
  q?: string;
  cursor?: string;
  limit?: number;
}

export const buildRequestsListBody = async (
  store: EditorialRequestStore,
  callerEmail: string,
  query: RequestsListQuery,
  exists: ObjectExistenceProbe
): Promise<Record<string, unknown>> => {
  // M2.1: ONE stage, not three. The inbox pair does not depend on the index
  // and the index does not depend on it; see the block above.
  const [{ rows, seq, rebuilt }, inbox] = await Promise.all([readIndex(store), loadRequestInbox(store, callerEmail)]);
  const { notify, seen } = inbox;
  const filters: RequestListFilters = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.kind ? { kind: query.kind } : {}),
    ...(query.mine !== undefined ? { mine: query.mine } : {}),
    ...(query.archived !== undefined ? { archived: query.archived } : {}),
    ...(query.q ? { q: query.q } : {}),
    callerEmail,
  };
  const matched = sortRequestRows(filterRequestRows(rows, filters));
  const limit = query.limit ?? REQUEST_PAGE_SIZE;
  const start = query.cursor ? Math.max(0, Number.parseInt(query.cursor, 10) || 0) : 0;
  const page = matched.slice(start, start + limit);
  const nextCursor = start + limit < matched.length ? String(start + limit) : undefined;
  // C2: a finished row whose doc never recorded its object. Bounded and
  // one-shot — see the block above for the three rules.
  const backfilled = await backfillPageObjects(store, page, exists);
  // `seq` is the index's write counter, so it is re-read on the one call
  // that actually wrote and left alone on every other.
  const seqNow = backfilled.wrote ? ((await loadIndex(store))?.seq ?? seq) : seq;
  return {
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
};
