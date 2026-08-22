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

export const notifyStateSchema = z.object({
  schema_version: z.literal(NOTIFY_STATE_SCHEMA_VERSION),
  person: z.string(),
  updated_at: z.string(),
  muted: z.array(z.string()),
  /** T19.6: request_id → the status last announced to this person. */
  last_notified: z.record(z.string(), z.string()).optional(),
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
