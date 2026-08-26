/**
 * T3.2 — the optimistic layer under the one decision façade
 * (`./decisions.ts`).
 *
 * Deliberately its own module, with no imports at all: `requests-store.ts`
 * (the shared poll behind the shell pills AND the runs inbox) holds this
 * state, `decisions.ts` writes it, and both need the same reducer. Putting
 * the reducer in either of them would make the two import each other.
 *
 * **W19 law, and the whole reason this is an overlay rather than a status
 * write.** Only the sweeper writes a running request's status. Nothing here
 * ever produces `running`/`stalled`/`failed`/`done`, or edits a
 * `RequestRowView`: an entry says only *"this person already decided this,
 * and the server has not caught up yet"*, which is a fact about the browser,
 * not about the run. Every surface renders the server's status and this
 * overlay side by side; when they disagree, the server wins on the next
 * snapshot (see `reconcile` below).
 *
 * The reconcile rule is the interesting part. A confirmed decision is
 * dropped as soon as the server stops listing its target as still needing
 * one — that is the server catching up, and the overlay's job is over. A
 * confirmed decision whose target is STILL listed is kept, because the poll
 * that produced the snapshot may simply have been in flight when the
 * decision landed — but only until `expire` (a TTL) removes it, so a
 * decision the server quietly did not apply cannot hide a row that still
 * needs a human forever.
 */

export type DecisionAction = 'approve' | 'reject' | 'modify';

/** `pending` — the request is in flight. `confirmed` — the server took it, the poll has not caught up. */
export type DecisionPhase = 'pending' | 'confirmed';

export interface DecisionOverlayEntry {
  decision: DecisionAction;
  phase: DecisionPhase;
  /** When the entry entered its CURRENT phase — what `expire` measures against. */
  atMs: number;
  /**
   * Every key this ONE decision is filed under — its mechanism's own key
   * first, then any alias (today: the `workflow_gate:request:<id>` key the
   * inbox row, the header pill and the needs-you dropdown all look up).
   *
   * This is what makes the alias impossible to desync rather than merely
   * unlikely to. There is one entry OBJECT per decision, stored under each of
   * its keys, and every mutation below goes through `writeGroup` /
   * `withoutGroup`, which write or delete the whole `keys` list together. A
   * rollback, a reconcile or an expiry that reached one keying and not the
   * other would have to bypass both helpers — there is no such path, and a
   * single-key delete is not expressible in this module.
   */
  keys: readonly string[];
}

export type DecisionOverlay = Readonly<Record<string, DecisionOverlayEntry>>;

export const EMPTY_DECISION_OVERLAY: DecisionOverlay = Object.freeze({});

/**
 * How long a confirmed decision may keep hiding a target the server still
 * reports as needing one. Two poll cycles of the slowest cadence the shared
 * store uses for a `needs_you` row (15s, `requestPollIntervalFor`) — long
 * enough that a decision never flickers back on the very next tick, short
 * enough that a silently-dropped decision resurfaces while the person who
 * made it is still looking at the screen.
 */
export const DECISION_OVERLAY_TTL_MS = 30_000;

export type DecisionOverlayEvent =
  /**
   * A decision request just went out — roll back if it fails. `alsoKeys` are
   * the extra keys this same decision must answer to (see
   * `decisionKeys` in `./decisions.ts`); they join one group with `key`.
   */
  | { type: 'begin'; key: string; decision: DecisionAction; atMs: number; alsoKeys?: readonly string[] }
  /** The server accepted it; keep hiding the target until a snapshot agrees. */
  | { type: 'confirm'; key: string; atMs: number; alsoKeys?: readonly string[] }
  /** It failed (or was refused) — the target goes straight back to needing a human. */
  | { type: 'rollback'; key: string }
  /** A fresh server snapshot: `keys` is every target it still says needs a decision. */
  | { type: 'reconcile'; keys: readonly string[] }
  /** Wall-clock sweep — drops confirmed entries the server never caught up with. */
  | { type: 'expire'; nowMs: number; ttlMs?: number };

/**
 * Drops a decision from EVERY key it is filed under. The only removal
 * primitive in this module — see `DecisionOverlayEntry.keys`.
 */
const withoutGroup = (state: DecisionOverlay, key: string): DecisionOverlay => {
  const entry = state[key];
  if (!entry) return state;
  const next = { ...state };
  for (const member of entry.keys) delete next[member];
  return next;
};

/** Files ONE entry object under every key in its group. The only write primitive. */
const writeGroup = (
  state: DecisionOverlay,
  keys: readonly string[],
  fields: Omit<DecisionOverlayEntry, 'keys'>
): DecisionOverlay => {
  const entry: DecisionOverlayEntry = { ...fields, keys };
  const next = { ...state };
  for (const member of keys) next[member] = entry;
  return next;
};

const groupKeys = (primary: string, ...more: ReadonlyArray<readonly string[] | undefined>): readonly string[] => {
  const keys = [primary];
  for (const list of more) for (const key of list ?? []) if (!keys.includes(key)) keys.push(key);
  return keys;
};

/**
 * Retires every group any of `keys` currently belongs to, before the new
 * entry is written over them. Two things need this: a re-`begin` whose alias
 * set SHRANK (the old alias must not survive pointing at a decision that no
 * longer exists), and two decisions in flight on the same request from
 * different mechanisms (the newer one takes the request key, and the older
 * one is dropped whole rather than left half-keyed).
 */
const clearAll = (state: DecisionOverlay, keys: readonly string[]): DecisionOverlay => keys.reduce(withoutGroup, state);

/**
 * Walks one representative key per group, so a two-key decision is judged
 * once rather than twice (and never half-dropped by a second visit to a key
 * the first visit already deleted).
 */
function* groups(state: DecisionOverlay): Generator<[string, DecisionOverlayEntry]> {
  const seen = new Set<string>();
  for (const [key, entry] of Object.entries(state)) {
    if (seen.has(key)) continue;
    for (const member of entry.keys) seen.add(member);
    yield [key, entry];
  }
}

export function reduceDecisionOverlay(state: DecisionOverlay, event: DecisionOverlayEvent): DecisionOverlay {
  switch (event.type) {
    case 'begin': {
      const keys = groupKeys(event.key, event.alsoKeys);
      return writeGroup(clearAll(state, keys), keys, {
        decision: event.decision,
        phase: 'pending',
        atMs: event.atMs,
      });
    }
    case 'confirm': {
      const entry = state[event.key];
      // Confirming something nobody began is not an error — a surface may
      // decide without having rendered an optimistic state first — but it
      // must still record WHAT was decided, so callers get the same
      // "decided, waiting for the server" reading either way.
      const keys = groupKeys(event.key, entry?.keys, event.alsoKeys);
      return writeGroup(clearAll(state, keys), keys, {
        decision: entry?.decision ?? 'approve',
        phase: 'confirmed',
        atMs: event.atMs,
      });
    }
    case 'rollback':
      return withoutGroup(state, event.key);
    case 'reconcile': {
      const stillOpen = new Set(event.keys);
      let next = state;
      for (const [key, entry] of groups(state)) {
        // A decision still in flight is never reconciled away by a snapshot
        // that was fetched before it landed.
        if (entry.phase === 'pending') continue;
        // A group survives while ANY of its keys is still listed. The
        // snapshot only ever names request keys (`openDecisionKeys`), so this
        // is exactly what keeps an object-review or chat-tool approval hiding
        // its inbox row for as long as the server still says that row needs
        // a human — and drops it the moment the server agrees it does not.
        if (!entry.keys.some((member) => stillOpen.has(member))) next = withoutGroup(next, key);
      }
      return next;
    }
    case 'expire': {
      const ttl = event.ttlMs ?? DECISION_OVERLAY_TTL_MS;
      let next = state;
      for (const [key, entry] of groups(state)) {
        if (entry.phase !== 'confirmed') continue;
        if (event.nowMs - entry.atMs >= ttl) next = withoutGroup(next, key);
      }
      return next;
    }
  }
}

// ─── target keys ────────────────────────────────────────────────────────────
//
// One key space across all three mechanisms, so a single overlay serves the
// chat card, the inbox row and the header pill without any of them knowing
// which mechanism the others are looking at.
//
// The three key SHAPES are addressed differently, though — an object review
// by its object, a chat tool by its call, a run gate by its run or request —
// and `pendingDecisionForRequest` (every inbox-shaped reader's only entry
// point) can only look up the last of those. So a decision whose surface
// also knows the request it belongs to is filed under BOTH its own key and
// the request key, as one entry in one group (see `DecisionOverlayEntry.keys`
// and `decisionKeys` in `./decisions.ts`). That is what makes an approval
// taken on the object page or a chat card move the inbox row in the same
// tick, instead of waiting up to five minutes for the sweeper.

export const objectReviewKey = (objectType: string, objectId: string): string =>
  `object_review:${objectType}:${objectId}`;

export const chatToolKey = (chatId: string, callId: string): string => `chat_tool:${chatId}:${callId}`;

/**
 * A run-level gate is addressed by run id when one is known and by request id
 * otherwise — the same either-or the `admin-request-activity` endpoint takes.
 * A surface that only ever holds one of the two (the inbox row holds the
 * request id; a chat rail bound to a run may hold both) therefore still
 * produces the key the other surfaces will match on, as long as it passes
 * every id it has.
 */
export const workflowGateKey = (target: { requestId?: string; runId?: string }): string =>
  target.runId ? `workflow_gate:run:${target.runId}` : `workflow_gate:request:${target.requestId ?? ''}`;

/**
 * The overlay entry for one request row, if this browser has already decided
 * it — by ANY mechanism, as long as that surface knew the request id.
 *
 * Still exactly one map read: the alias is a key in the same map, not a
 * second key space to search.
 */
export const pendingDecisionForRequest = (
  overlay: DecisionOverlay,
  requestId: string
): DecisionOverlayEntry | undefined => overlay[workflowGateKey({ requestId })];

/**
 * The rows a surface should still treat as needing a human, given what this
 * browser has already decided. Pure, and deliberately NOT a status rewrite:
 * the row objects come back untouched, just fewer of them.
 */
export const rowsStillNeedingDecision = <T extends { request_id: string; status: string }>(
  rows: readonly T[],
  overlay: DecisionOverlay
): T[] => rows.filter((row) => row.status === 'needs_you' && !pendingDecisionForRequest(overlay, row.request_id));

/** Every request-row target the server still says needs a decision — the `reconcile` input. */
export const openDecisionKeys = (rows: readonly { request_id: string; status: string }[]): string[] =>
  rows.filter((row) => row.status === 'needs_you').map((row) => workflowGateKey({ requestId: row.request_id }));

/** Header/row copy while a decision is recorded but the run has not moved yet. */
export const DECIDED_WAITING_LABEL: Record<DecisionAction, string> = {
  approve: 'Approved · applying',
  reject: 'Rejected · applying',
  modify: 'Modified · applying',
};
