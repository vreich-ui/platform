/**
 * T2.3 — the one shared poll behind the shell's pills AND the runs inbox's
 * default view.
 *
 * T0.2 (`docs/plan/perf-diagnosis.md` §1.1, F7) found THREE poll chains
 * hitting `/admin/requests` at once: `AdminShell.tsx`'s fixed 15s interval,
 * `RequestsWorkspace.tsx`'s own 5-30s chain on the SAME endpoint with
 * different filters, and `RequestActivity.tsx`'s 3s per-run chain on a
 * DIFFERENT endpoint. This module collapses the first two — both call
 * `admin-requests {action:'list'}` for a view of the same active-request
 * index — into one module-scope chain, mirroring `use-current-user.ts`'s
 * shape (module snapshot + `useSyncExternalStore`, ref-counted subscribers,
 * survives an Astro `ClientRouter` swap because it lives at module scope,
 * not inside a route island).
 *
 * The generation counter below is not a stylistic choice — `RequestsWorkspace`
 * and `RequestActivity`'s own poll chains both carry the identical comment
 * for the identical reason: a shared boolean `live` flag lets a fetch still
 * in-flight from a chain that was just retired pass the check anyway,
 * overwrite the snapshot, and reschedule itself — a zombie chain. Only the
 * generation that started a fetch may write its result or arm the next timer.
 *
 * What this store is deliberately NOT for: `mine`, `archived` and free-text
 * search (`q`) address a different or larger universe than the "active,
 * attention-sorted, capped" set this store keeps warm — the same set the
 * header pills already watch today. `RequestsWorkspace` queries those three
 * on demand through `listRequests` directly (see its own comment) rather
 * than through this cache, so this store's own request body never changes.
 *
 * The third chain T0.2 found (`RequestActivity`'s 3s per-run poll) is a
 * different endpoint over different data (one run's full node tree, not the
 * index) and is intentionally left as its own chain here — collapsing it
 * into this one would need a server-side delta (`since_seq`, F13), which
 * lives in `admin-request-activity.ts` (a server function, outside this
 * task's file scope).
 */
import { useEffect, useSyncExternalStore } from 'react';

import { REQUEST_LIST_MAX_LIMIT } from './request-list-limits.js';

import {
  listRequestsIfChanged,
  pollIntervalWithBackoff,
  requestPollIntervalFor,
  type EmailMode,
  type RequestRowView,
} from './requests-client.js';
import {
  EMPTY_DECISION_OVERLAY,
  openDecisionKeys,
  reduceDecisionOverlay,
  type DecisionAction,
  type DecisionOverlay,
} from './decision-overlay.js';

export interface RequestsIndexState {
  /** `null` only until the first response lands — the "loading" signal for a skeleton. */
  rows: RequestRowView[] | null;
  total: number;
  muted: readonly string[];
  lastNotified: Readonly<Record<string, string>>;
  notifyFirstContact: boolean;
  emailMode: EmailMode;
  error?: string;
  /** When the snapshot currently on screen was fetched — for a "stale, retrying" hint. */
  fetchedAtMs?: number;
}

const EMPTY: RequestsIndexState = {
  rows: null,
  total: 0,
  muted: [],
  lastNotified: {},
  notifyFirstContact: false,
  emailMode: 'immediate',
};

type GetToken = () => Promise<string>;

let snapshot: RequestsIndexState = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
/**
 * T5.1 R8: the `ETag` of the last list response, replayed as `If-None-Match`
 * so an unchanged index comes back as a bodyless `304` instead of the same
 * JSON re-serialised and re-sent (T0.2 F12: ~16 requests/minute per open tab
 * against this one endpoint, none of them conditional).
 *
 * It lives beside the snapshot it describes and MUST be dropped with it — an
 * etag whose body the store no longer holds would turn a `304` into "keep
 * showing rows we threw away". `refreshRequestsIndexNow` therefore clears it:
 * a caller asking for a forced refresh after a mutation wants bytes back, not
 * a `304`.
 */
let lastEtag: string | undefined;
/** Bumped on every subscribe-from-zero and every unsubscribe-to-zero; only a fetch started under the CURRENT generation may write. */
let generation = 0;
let subscriberCount = 0;

const emit = () => listeners.forEach((listener) => listener());
const setSnapshot = (next: RequestsIndexState) => {
  snapshot = next;
  emit();
};

const hidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden';

function schedule(getToken: GetToken, myGeneration: number, baseMs: number): void {
  if (timer) clearTimeout(timer);
  timer = undefined;
  const delay = pollIntervalWithBackoff(baseMs, hidden());
  if (delay === undefined) return; // hidden — the visibility handler re-arms this on return
  timer = setTimeout(() => void tick(getToken, myGeneration), delay);
}

async function tick(getToken: GetToken, myGeneration: number): Promise<void> {
  if (myGeneration !== generation) return; // this chain was retired while the timer was pending
  try {
    // W19 T19.2: ONE blob GET (the request index), capped generously enough
    // that the quick-filter tabs (all subsets of this same active set) stay
    // accurate — see the module comment for what is deliberately NOT served
    // from this cache.
    const response = await listRequestsIfChanged(getToken, { limit: REQUEST_LIST_MAX_LIMIT }, lastEtag);
    if (myGeneration !== generation) return;
    lastEtag = response.etag;

    /**
     * T5.1 R8: a `304` means the list body is byte-identical to the snapshot
     * already published, so there are no new rows to install. The overlay's
     * `expire` step is still time-based and must still run, and the snapshot
     * still gets a fresh `fetchedAtMs` — the data WAS just confirmed current,
     * which is what that field means.
     */
    if (response.unchanged) {
      const currentRows = snapshot.rows ?? [];
      setOverlay(
        reduceDecisionOverlay(
          reduceDecisionOverlay(overlay, { type: 'reconcile', keys: openDecisionKeys(currentRows) }),
          { type: 'expire', nowMs: Date.now() }
        )
      );
      setSnapshot({ ...snapshot, error: undefined, fetchedAtMs: Date.now() });
      schedule(getToken, myGeneration, requestPollIntervalFor(currentRows));
      return;
    }

    const result = response.view;
    // T3.2: every snapshot reconciles the optimistic decision overlay before
    // it is published, so no subscriber ever sees a row the server has moved
    // on from AND the local "you already decided this" marker at the same
    // time. The status itself is never touched here — W19 keeps that with
    // the sweeper.
    setOverlay(
      reduceDecisionOverlay(
        reduceDecisionOverlay(overlay, { type: 'reconcile', keys: openDecisionKeys(result.requests) }),
        { type: 'expire', nowMs: Date.now() }
      )
    );
    setSnapshot({
      rows: result.requests,
      total: result.total,
      muted: result.muted ?? [],
      lastNotified: result.last_notified ?? {},
      notifyFirstContact: Boolean(result.notify_first_contact),
      emailMode: result.email_mode ?? 'immediate',
      error: undefined,
      fetchedAtMs: Date.now(),
    });
    schedule(getToken, myGeneration, requestPollIntervalFor(result.requests));
  } catch (err) {
    if (myGeneration !== generation) return;
    setSnapshot({
      ...snapshot,
      error: err instanceof Error ? err.message : 'Could not load requests.',
    });
    schedule(getToken, myGeneration, 20_000);
  }
}

/** Ref-counted: the chain runs while at least one page has a subscriber, and stops the moment the last one goes away. */
export function startRequestsIndexPoll(getToken: GetToken): () => void {
  subscriberCount += 1;
  if (subscriberCount === 1) {
    generation += 1;
    void tick(getToken, generation);
  }
  return () => {
    subscriberCount = Math.max(0, subscriberCount - 1);
    if (subscriberCount === 0) {
      generation += 1; // retires the chain even if a fetch is mid-flight
      if (timer) clearTimeout(timer);
      timer = undefined;
    }
  };
}

/** Re-fetch outside the timer's own cadence — after a mutation (archive/cancel/mute), so the change is visible on the click, not on the next tick. */
export function refreshRequestsIndexNow(getToken: GetToken): void {
  if (subscriberCount === 0) return;
  // T5.1 R8: a forced refresh must come back with a body. Something just
  // changed on the server, and a `304` here would be a lie of omission.
  lastEtag = undefined;
  generation += 1;
  if (timer) clearTimeout(timer);
  timer = undefined;
  void tick(getToken, generation);
}

/** Called by a subscriber's own `visibilitychange` listener; a no-op if a chain is already armed or nobody is subscribed. */
export function resumeRequestsIndexPoll(getToken: GetToken): void {
  if (subscriberCount === 0 || timer) return;
  void tick(getToken, generation);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ─── T3.2: the shared optimistic decision overlay ──────────────────────────
//
// This lives HERE, next to the index it annotates, because cross-surface sync
// is the acceptance criterion: the header pill, the inbox row and the chat
// rail must agree the instant one of them is used, and they already share
// this module's subscriber set. A second store would be a second truth.
//
// The overlay never edits a row. It records only "this browser already
// decided that target", which surfaces render alongside the server's status
// and which every fresh snapshot reconciles away (see `tick`).

let overlay: DecisionOverlay = EMPTY_DECISION_OVERLAY;

const setOverlay = (next: DecisionOverlay) => {
  if (next === overlay) return;
  overlay = next;
  emit();
};

/**
 * Called by the façade the moment a decision request goes out. `alsoKeys` is
 * `decisionKeys(target)` minus the primary — the request key an object-review
 * or chat-tool decision must ALSO answer to, so the inbox row and the header
 * pill stop counting it in this same tick.
 */
export function beginDecisionOverlay(key: string, decision: DecisionAction, alsoKeys?: readonly string[]): void {
  setOverlay(reduceDecisionOverlay(overlay, { type: 'begin', key, decision, atMs: Date.now(), alsoKeys }));
}

/**
 * Called by the façade when the server answers: keep it until a snapshot
 * agrees, or roll it back now. Rollback needs no `alsoKeys` — the reducer
 * drops every key the entry was filed under, so a failed decision can never
 * leave an alias behind holding a row shut.
 */
export function settleDecisionOverlay(key: string, ok: boolean, alsoKeys?: readonly string[]): void {
  setOverlay(
    ok
      ? reduceDecisionOverlay(overlay, { type: 'confirm', key, atMs: Date.now(), alsoKeys })
      : reduceDecisionOverlay(overlay, { type: 'rollback', key })
  );
}

/** Read-only access for a surface that renders outside React (tests, non-hook callers). */
export const decisionOverlaySnapshot = (): DecisionOverlay => overlay;

/**
 * Subscribe to the overlay alone. Shares this module's listener set, so a
 * decision taken on any surface re-renders every other subscribed surface in
 * the same tick — with no reload and no second poll.
 */
export function useDecisionOverlay(): DecisionOverlay {
  return useSyncExternalStore(
    subscribe,
    () => overlay,
    () => EMPTY_DECISION_OVERLAY
  );
}

/**
 * The hook every page-level consumer uses. `AdminShell`'s `RequestPulse` and
 * `RequestsWorkspace`'s list body both call this — whichever mounts first
 * starts the chain, and it keeps running for as long as either is mounted.
 */
export function useRequestsIndex(getToken: GetToken): RequestsIndexState {
  const state = useSyncExternalStore(
    subscribe,
    () => snapshot,
    () => EMPTY
  );
  useEffect(() => {
    const stop = startRequestsIndexPoll(getToken);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') resumeRequestsIndexPoll(getToken);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      stop();
    };
  }, [getToken]);
  return state;
}
