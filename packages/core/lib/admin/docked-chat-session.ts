/**
 * A DOCKED chat's session decision logic — the part that decides which
 * conversation a self-hosting surface is attached to, and when the human is
 * offered a fresh one.
 *
 * Why this exists (reported defect, brand-imagery wave): the visual-identity
 * dock minted ONE free chat per `siteId`, cached its id in `sessionStorage`,
 * and never cleared that key. When the underlying conversation broke — a
 * provider 400 that made every subsequent turn fail — every reload
 * re-attached to the same dead thread, and typing "start new chat" only
 * posted another message into it. There was no way out of a dead chat, and a
 * failed `createFreeChat` left the dock silently pointed at `undefined` with
 * nothing on screen to retry.
 *
 * WHAT THIS DOES NOT CHANGE: one conversation per `siteId` stays. Imagery and
 * PDF templates deliberately SHARE a chat so image standards and PDF
 * templates can be part of one generation process. This module adds a RESET
 * to that arrangement; it does not split it.
 *
 * Everything here is pure (a state machine, key derivation, and a guarded
 * storage wrapper that never throws), so the platform-admin convention holds:
 * the decision logic is tested with `node:test` on plain `.ts`, no jsdom, and
 * the `.tsx` that mounts the dock stays a thin, unconditional hook list.
 */
import { agentStarterByKey } from './agent-starters.js';

/** The scope segment of the visual-identity dock's cache key — unchanged from the shipped key. */
export const VISUAL_IDENTITY_CHAT_SCOPE = 'visual-identity-chat';

/**
 * `<scope>:<siteId>` — ONE conversation per site per browser tab. The site is
 * part of the key (not the tab), which is exactly why the shared
 * Imagery/PDF-templates conversation survives a tab switch remount.
 */
export const dockedChatStorageKey = (scope: string, siteId: string): string => `${scope}:${siteId}`;

/** The three `Storage` methods this module needs — so a test can pass a plain object. */
export interface DockedChatStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * `sessionStorage` when the document has one, `undefined` during SSR or when
 * a browser refuses storage (private mode). Every reader below tolerates
 * `undefined`, so a storage-less browser simply mints a chat per mount rather
 * than failing the page.
 */
export function browserDockedChatStorage(): DockedChatStorage | undefined {
  try {
    if (typeof sessionStorage === 'undefined') return undefined;
    return sessionStorage;
  } catch {
    return undefined;
  }
}

/** Reads a cached chat id. Never throws; a blank/absent/unavailable value reads as `undefined`. */
export function readDockedChatId(storage: DockedChatStorage | undefined, key: string): string | undefined {
  try {
    const raw = storage?.getItem(key);
    return raw && raw.trim().length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

/** Caches a chat id. Never throws — a write failure only means this dock re-mints on the next mount. */
export function writeDockedChatId(storage: DockedChatStorage | undefined, key: string, chatId: string): void {
  try {
    storage?.setItem(key, chatId);
  } catch {
    // ignored — private browsing / disabled storage
  }
}

/**
 * Drops the cached id. THE missing half of the shipped defect: without this
 * the dock could never be pointed anywhere but the one chat it first minted.
 */
export function clearDockedChatId(storage: DockedChatStorage | undefined, key: string): void {
  try {
    storage?.removeItem(key);
  } catch {
    // ignored — nothing to clear if storage isn't available
  }
}

export type DockedChatPhase =
  /** Nothing attempted yet this generation. */
  | 'idle'
  /** `createFreeChat` is in flight. */
  | 'creating'
  /** A chat id is held (cached or freshly minted). */
  | 'ready'
  /** The last attempt to mint one failed; the human is owed a retry. */
  | 'failed';

export interface DockedChatSession {
  phase: DockedChatPhase;
  chatId?: string;
  /** Set only in `failed`: the human-readable reason to show beside the retry. */
  error?: string;
  /**
   * The reset generation. Bumped by every `reset`, and used as the mint
   * effect's dependency so a reset genuinely re-runs it instead of relying on
   * the (now cleared) cache being re-read by chance.
   */
  attempt: number;
}

export type DockedChatEvent =
  /** A cached id was found — attach, do not mint, do not re-seed. */
  | { type: 'attached'; chatId: string }
  /** `createFreeChat` has been called. */
  | { type: 'minting' }
  | { type: 'minted'; chatId: string }
  | { type: 'failed'; reason?: unknown }
  /** The human asked for a new chat. */
  | { type: 'reset' };

export const DOCKED_CHAT_FAILURE_TEXT = 'A new conversation could not be started.';

/** Normalizes whatever `createFreeChat` rejected with into one line a human can read. */
export function dockedChatErrorText(reason: unknown): string {
  const detail = reason instanceof Error ? reason.message.trim() : typeof reason === 'string' ? reason.trim() : '';
  return detail ? `${DOCKED_CHAT_FAILURE_TEXT} ${detail}` : DOCKED_CHAT_FAILURE_TEXT;
}

export const initialDockedChatSession = (): DockedChatSession => ({ phase: 'idle', attempt: 0 });

/**
 * The whole session machine. Note what `reset` does and does NOT do: it drops
 * the held id and bumps the generation, so the mint effect starts a genuinely
 * new conversation — it never carries the dead chat's id forward, and it
 * never widens the one-chat-per-site rule.
 */
export function dockedChatReducer(state: DockedChatSession, event: DockedChatEvent): DockedChatSession {
  switch (event.type) {
    case 'attached':
      return { phase: 'ready', chatId: event.chatId, attempt: state.attempt };
    case 'minting':
      return { phase: 'creating', attempt: state.attempt };
    case 'minted':
      return { phase: 'ready', chatId: event.chatId, attempt: state.attempt };
    case 'failed':
      return { phase: 'failed', error: dockedChatErrorText(event.reason), attempt: state.attempt };
    case 'reset':
      return { phase: 'idle', attempt: state.attempt + 1 };
    default:
      return state;
  }
}

/** What the "New chat" control should say and whether it can be pressed. */
export interface DockedChatControl {
  label: string;
  /** True only while a chat is being minted — a second click there would orphan the first. */
  disabled: boolean;
  /**
   * The accessible name: the label alone is too terse for a 22rem rail. It
   * is rendered as `aria-label`, NEVER as a native `title` tooltip — a
   * `title` on a disabled control reaches neither a touch user nor a
   * keyboard user (the repo-wide `no-title-on-disabled-actions` invariant),
   * and every hint here therefore OPENS with its own visible label so the
   * accessible name still contains it.
   */
  hint: string;
  /** Present exactly when the last attempt failed — shown beside the control. */
  error?: string;
}

/**
 * The control is ALWAYS offered (never hidden): "there is no way to start a
 * new chat" was the defect, and a control that disappears in the state the
 * user most needs it — the conversation is dead but `chatId` still resolves —
 * would reproduce it. It is disabled only while a mint is in flight, and a
 * failed mint turns it into the visible retry.
 */
export function dockedChatControl(state: DockedChatSession): DockedChatControl {
  if (state.phase === 'creating') return { label: 'Starting…', disabled: true, hint: 'Starting a new conversation…' };
  if (state.phase === 'failed')
    return {
      label: 'Try again',
      disabled: false,
      hint: 'Try again — starting a new conversation failed',
      error: state.error ?? DOCKED_CHAT_FAILURE_TEXT,
    };
  return {
    label: 'New chat',
    disabled: false,
    hint: 'New chat — starts a fresh conversation in this dock',
  };
}

/** The title and opening turn a docked chat is created with. */
export interface DockedChatSeed {
  title: string;
  /** Absent when the starter key resolves to nothing — then the chat opens empty rather than with a wrong prompt. */
  prompt?: string;
}

/**
 * ONE derivation of the starter seed, used by first load AND by reset, so a
 * reset conversation opens exactly as the original did. Falls back to a plain
 * title (and no opening turn) if the starter key ever stops resolving.
 */
export function dockedChatSeed(starterKey: string, fallbackTitle: string): DockedChatSeed {
  const starter = agentStarterByKey(starterKey);
  if (!starter) return { title: fallbackTitle };
  return { title: starter.label, prompt: starter.prompt };
}
