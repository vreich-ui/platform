/**
 * W19 T19.2 — per-person notification state, split across three keys BY WRITER
 * (see `notifyStateKey` and its siblings in store.ts for why).
 *
 *   notify/<person>.json        the person's own settings: mute and mail mode.
 *                               Written only when they click something.
 *   notify-seen/<person>.json   what the browser has already shown them.
 *                               Written only by the ack path.
 *   notify-mailed/<person>.json what the mailer has already sent them.
 *                               Written only by the sweeper.
 *
 * They were one document with three writers, which on a store with no
 * compare-and-swap means a person's mute could be silently reverted by their
 * other tab's ack, and the sweeper's mail ledger clobbered mid-send so the
 * same e-mail went twice. The settings doc still CARRIES the two legacy maps
 * so a doc written before the split keeps deduping — they are read as a
 * fallback and never written again.
 */
import { z } from 'zod';

import { notifyMailedKey, notifySeenKey, notifyStateKey, type EditorialRequestStore } from './store.js';

export const NOTIFY_STATE_SCHEMA_VERSION = 'editorial-request-notify.v1';

/** Bound on the mute list — a person who has muted this many requests is served by the archive, not by more mutes. */
export const MUTED_MAX = 200;

/**
 * Bound on the dedup map. Oldest entries are dropped first, which is safe: a
 * request old enough to fall off has long since been seen, and the worst case
 * of a wrong drop is one repeated notification, never a missed one.
 */
export const LAST_NOTIFIED_MAX = 300;

/**
 * How much mail this person wants. `immediate` sends on the transitions that
 * need a person; `daily` batches the rest; `off` is off.
 *
 * RECORDED DEVIATION from plan §6.3, which put this on the W18 `Person`
 * record: it lives here instead. This doc is already keyed per person, already
 * exists, and already holds the mute list — so every notification setting sits
 * in one place and W19 needs no membership-schema migration. (R8: recorded,
 * moving on.)
 */
export const emailModeSchema = z.enum(['immediate', 'daily', 'off']);
export type EmailMode = z.infer<typeof emailModeSchema>;

/** Plan D4: the unhappy transitions interrupt; `done` waits for the digest. */
export const DEFAULT_EMAIL_MODE: EmailMode = 'immediate';

export const notifyStateSchema = z.object({
  schema_version: z.literal(NOTIFY_STATE_SCHEMA_VERSION),
  person: z.string(),
  updated_at: z.string(),
  muted: z.array(z.string()),
  email_mode: emailModeSchema.optional(),
  /**
   * T19.6: request_id → the status this person was last SHOWN in the browser.
   * It tracks the current status, notifying or not, so a request that returns
   * to a notifying status (a second approval gate; a job that stalls, revives
   * and stalls again) is announced again rather than silently swallowed.
   */
  last_notified: z.record(z.string(), z.string()).optional(),
  /**
   * T19.7: the same map for the MAIL channel, kept SEPARATE on purpose.
   *
   * Sharing one map let whichever channel fired first suppress the other — and
   * since the sweeper writes the transition and sends the mail in the same
   * invocation, mail always won: on a mail-configured tenant the person who
   * asked for the job would get an e-mail and never the toast, the desktop
   * notification or the tab count. "All three channels" was the decision; one
   * map per channel is what makes it true.
   */
  last_mailed: z.record(z.string(), z.string()).optional(),
});
export type NotifyState = z.infer<typeof notifyStateSchema>;

export const NOTIFY_LEDGER_SCHEMA_VERSION = 'editorial-request-notify-ledger.v1';

/** One channel's "already told them this" map, in its own document. */
export const notifyLedgerSchema = z.object({
  schema_version: z.literal(NOTIFY_LEDGER_SCHEMA_VERSION),
  person: z.string(),
  updated_at: z.string(),
  entries: z.record(z.string(), z.string()),
});
export type NotifyLedger = z.infer<typeof notifyLedgerSchema>;

const personKey = (email: string) => email.trim().toLowerCase();

export const loadNotifyState = async (
  store: EditorialRequestStore,
  email: string
): Promise<NotifyState | undefined> => {
  const raw = await store.get(notifyStateKey(personKey(email)));
  if (!raw) return undefined;
  const parsed = notifyStateSchema.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data : undefined;
};

const save = async (store: EditorialRequestStore, state: NotifyState): Promise<NotifyState> => {
  await store.setJSON(notifyStateKey(state.person), notifyStateSchema.parse(state));
  return state;
};

const blank = (email: string, at: string): NotifyState => ({
  schema_version: NOTIFY_STATE_SCHEMA_VERSION,
  person: personKey(email),
  updated_at: at,
  muted: [],
});

export const muteRequest = async (
  store: EditorialRequestStore,
  email: string,
  requestId: string,
  at: string = new Date().toISOString()
): Promise<NotifyState> => {
  const current = (await loadNotifyState(store, email)) ?? blank(email, at);
  if (current.muted.includes(requestId)) return current;
  const muted = [...current.muted, requestId].slice(-MUTED_MAX);
  return save(store, { ...current, muted, updated_at: at });
};

export const unmuteRequest = async (
  store: EditorialRequestStore,
  email: string,
  requestId: string,
  at: string = new Date().toISOString()
): Promise<NotifyState> => {
  const current = await loadNotifyState(store, email);
  if (!current || !current.muted.includes(requestId)) return current ?? blank(email, at);
  return save(store, { ...current, muted: current.muted.filter((id) => id !== requestId), updated_at: at });
};

/**
 * Record what this person has now been told, so a second tab, another device,
 * or a reload does not announce it again. Acked server-side rather than in
 * browser storage precisely so the dedup survives all three.
 */
/**
 * Bounded merge with LRU semantics: a key touched by THIS ack moves to the
 * end, so eviction takes the least recently seen entry.
 *
 * A plain spread kept a re-acked key at its original position, which meant a
 * long-lived active request could be evicted by the very ack that refreshed
 * it — and then immediately re-announced.
 */
const mergeBounded = (
  current: Readonly<Record<string, string>> | undefined,
  acked: Readonly<Record<string, string>>
): Record<string, string> => {
  const merged = new Map(Object.entries(current ?? {}));
  for (const [key, value] of Object.entries(acked)) {
    merged.delete(key);
    merged.set(key, value);
  }
  const entries = [...merged.entries()];
  return Object.fromEntries(entries.slice(Math.max(0, entries.length - LAST_NOTIFIED_MAX)));
};

/**
 * A ledger blob's entries, or the pre-split settings doc's legacy map when
 * there is no ledger. Split from the read (`loadLedger`) so `loadRequestInbox`
 * can issue the ledger read WITHOUT first awaiting the settings doc it may
 * fall back to — the fallback depends on the ledger's answer, never on
 * whether to ask for it.
 */
const parseLedger = (
  raw: string | null | undefined,
  legacy: Readonly<Record<string, string>> | undefined
): Record<string, string> => {
  if (!raw) return { ...(legacy ?? {}) };
  const parsed = notifyLedgerSchema.safeParse(JSON.parse(raw));
  // An unparseable ledger is treated as EMPTY, not as fatal: the cost is one
  // repeated notification, and refusing to load it would stop the sweep.
  return parsed.success ? parsed.data.entries : { ...(legacy ?? {}) };
};

const loadLedger = async (
  store: EditorialRequestStore,
  key: string,
  legacy: Readonly<Record<string, string>> | undefined
): Promise<Record<string, string>> => parseLedger(await store.get(key), legacy);

const saveLedger = async (
  store: EditorialRequestStore,
  key: string,
  person: string,
  entries: Record<string, string>,
  at: string
): Promise<Record<string, string>> => {
  await store.setJSON(
    key,
    notifyLedgerSchema.parse({
      schema_version: NOTIFY_LEDGER_SCHEMA_VERSION,
      person,
      updated_at: at,
      entries,
    })
  );
  return entries;
};

/**
 * M2.1 — the person's whole inbox state, in ONE round trip.
 *
 * ## What this replaces
 *
 * `buildRequestsListBody` closed with `await loadNotifyState(...)` and then
 * `await loadSeenLedger(..., notify)`, which is two blob reads IN SERIES on
 * the busiest read path in the admin. They were serial for one reason only:
 * `loadSeenLedger` takes the settings doc so that a person whose ledger
 * predates the W19 split still dedupes off the settings doc's legacy
 * `last_notified` map. That fallback needs the settings doc only when the
 * LEDGER IS ABSENT — it never decides whether to issue the ledger read — so
 * the dependency is on the RESULT, not on the request, and the two reads can
 * be issued together and joined afterwards.
 *
 * ## Why this is not the merged `users/<id>/inbox.json` the M2.1 task asked for
 *
 * REFUSED, with the reason. The task's premise was that this store "has
 * exactly one writer module by design", so folding `notify/` and
 * `notify-seen/` into one document would be safe. `store.ts`'s own header (at
 * `notifyStateKey`) says the opposite, names this exact pair, and names the
 * bug: the split is by writing COMPONENT, not by module, because Netlify
 * Blobs has no compare-and-swap —
 *
 *   "A person clicking Mute while their other tab acked a transition could
 *    have the mute silently reverted."
 *
 * Settings are written by an explicit click; the seen ledger is written by
 * EVERY OPEN TAB's delivery ack. Those are two components by the only
 * definition that matters here (two concurrent load-modify-write windows on
 * one key), and merging the documents re-creates a data-loss race that W19
 * removed by construction. `index-store.ts`'s header leans on the same law
 * from the other side: the object store could not have a writer-maintained
 * index precisely because "an index maintained by writers is only as correct
 * as the least careful writer".
 *
 * The performance the merge was asked for is bought here instead, and in
 * full: the requests surface went from THREE SERIAL reads (index -> notify ->
 * seen, ~440 ms) to ONE PARALLEL STAGE — the index read joins these two in
 * `buildRequestsListBody`'s `Promise.all`, so the wall cost is one blob read,
 * which is BETTER than the two-parallel target, and it costs no correctness.
 * The one thing the merge would have bought over this is a single concurrent
 * connection instead of two, worth ~0 ms against a race worth a lost mute.
 */
export const loadRequestInbox = async (
  store: EditorialRequestStore,
  email: string
): Promise<{ notify: NotifyState | undefined; seen: Record<string, string> }> => {
  const person = personKey(email);
  // THE two reads. Issued together; joined below.
  const [notify, seenRaw] = await Promise.all([loadNotifyState(store, email), store.get(notifySeenKey(person))]);
  return { notify, seen: parseLedger(seenRaw, notify?.last_notified) };
};

/** What the BROWSER has already shown this person. Falls back to a pre-split doc. */
export const loadSeenLedger = async (
  store: EditorialRequestStore,
  email: string,
  state?: NotifyState
): Promise<Record<string, string>> =>
  loadLedger(store, notifySeenKey(personKey(email)), (state ?? (await loadNotifyState(store, email)))?.last_notified);

/** What the MAILER has already sent this person. Falls back to a pre-split doc. */
export const loadMailedLedger = async (
  store: EditorialRequestStore,
  email: string,
  state?: NotifyState
): Promise<Record<string, string>> =>
  loadLedger(store, notifyMailedKey(personKey(email)), (state ?? (await loadNotifyState(store, email)))?.last_mailed);

/**
 * Record what this person has now been told, so a second tab, another device,
 * or a reload does not announce it again. Acked server-side rather than in
 * browser storage precisely so the dedup survives all three. Written to the
 * ack path's OWN document — a settings write must never be able to revert it,
 * and it must never be able to revert a mute.
 */
export const ackNotifications = async (
  store: EditorialRequestStore,
  email: string,
  acked: Readonly<Record<string, string>>,
  at: string = new Date().toISOString()
): Promise<Record<string, string>> => {
  const person = personKey(email);
  const current = await loadSeenLedger(store, email);
  return saveLedger(store, notifySeenKey(person), person, mergeBounded(current, acked), at);
};

/** The mail channel's own ledger, in the sweeper's own document. */
export const ackMailed = async (
  store: EditorialRequestStore,
  email: string,
  acked: Readonly<Record<string, string>>,
  at: string = new Date().toISOString()
): Promise<Record<string, string>> => {
  const person = personKey(email);
  const current = await loadMailedLedger(store, email);
  return saveLedger(store, notifyMailedKey(person), person, mergeBounded(current, acked), at);
};

/** Has the MAIL channel already covered this exact transition? */
export const alreadyMailed = (
  mailed: Readonly<Record<string, string>> | undefined,
  requestId: string,
  status: string
): boolean => mailed?.[requestId] === status;

/** Muting is personal and silences EVERY channel — in-app, browser and e-mail. */
export const isMuted = (state: NotifyState | undefined, requestId: string): boolean =>
  Boolean(state?.muted.includes(requestId));

export const setEmailMode = async (
  store: EditorialRequestStore,
  email: string,
  mode: EmailMode,
  at: string = new Date().toISOString()
): Promise<NotifyState> => {
  const current = (await loadNotifyState(store, email)) ?? blank(email, at);
  return save(store, { ...current, email_mode: mode, updated_at: at });
};

/** Absent means the default, not "off" — an editor who never opened the setting still gets told. */
export const emailModeFor = (state: NotifyState | undefined): EmailMode => state?.email_mode ?? DEFAULT_EMAIL_MODE;

/**
 * Whether THIS transition earns mail right now. `done` is the one that waits
 * for a digest — an editor does not need an interruption to learn something
 * finished, and plan D4 says so.
 */
export const shouldMailNow = (mode: EmailMode, status: string): boolean => {
  if (mode === 'off') return false;
  if (status === 'done') return false;
  return mode === 'immediate';
};
