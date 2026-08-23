/**
 * W19 T19.2 — per-person notification state, at the key T19.1 reserved
 * (`requests/notify/<person>.json`).
 *
 * This row owns only MUTE (personal, always — muting affects your
 * notifications and nobody's list, plan §8). The `last_notified` map that
 * dedupes delivery across tabs and reloads is T19.6's; the schema carries it
 * as an optional field from day one so T19.6 is additive, not a migration.
 */
import { z } from 'zod';

import { notifyStateKey, type EditorialRequestStore } from './store.js';

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

export const ackNotifications = async (
  store: EditorialRequestStore,
  email: string,
  acked: Readonly<Record<string, string>>,
  at: string = new Date().toISOString()
): Promise<NotifyState> => {
  const current = (await loadNotifyState(store, email)) ?? blank(email, at);
  return save(store, { ...current, last_notified: mergeBounded(current.last_notified, acked), updated_at: at });
};

/** The mail channel's own ledger — see `last_mailed` on the schema for why it is separate. */
export const ackMailed = async (
  store: EditorialRequestStore,
  email: string,
  acked: Readonly<Record<string, string>>,
  at: string = new Date().toISOString()
): Promise<NotifyState> => {
  const current = (await loadNotifyState(store, email)) ?? blank(email, at);
  return save(store, { ...current, last_mailed: mergeBounded(current.last_mailed, acked), updated_at: at });
};

/** Has the MAIL channel already covered this exact transition? */
export const alreadyMailed = (state: NotifyState | undefined, requestId: string, status: string): boolean =>
  state?.last_mailed?.[requestId] === status;

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
