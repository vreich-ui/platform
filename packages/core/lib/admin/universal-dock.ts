/**
 * ASV2-W2 — the UNIVERSAL DOCK's decisions.
 *
 * `AgentRail` was mounted only on surfaces with exactly one object in scope
 * (object detail, visual identity, templates, inventory). W2 binds it to a
 * SELECTION instead (`object-selection.ts`) so it can also dock on the
 * surfaces that LIST objects. Everything that surface has to decide — is the
 * dock a spine or a panel, does it sit beside the list or open as a drawer,
 * what does its header say, when may a chat be minted, what does the address
 * look like afterwards — lives here as pure functions, because there is no
 * DOM harness in this repo (AGENTS.md §4) and a decision that lives only in
 * JSX is untested by construction.
 *
 * THE ONE INVARIANT WORTH READING TWICE: `dockChatIntent` returns `idle` for
 * every `'select'` phase, unconditionally. Clicking a row is not a request.
 * The dock binds through `createObjectChat` on the first SEND, never on the
 * selection — a click that minted a chat doc would leave an empty
 * conversation behind for every row an editor ever skimmed past.
 */
import { dockFitsBeside, minContentWidthForDockPx } from './agent-surface-layout.js';
import { objectTypeLabel } from './display-name.js';
import { selectionKey, withFocus, type ObjectSelection } from './object-selection.js';
import type { ObjectType } from '../../schema/object-record-v1.js';

/** The collapsed dock's spine. LOCKSTEP: `w-12` in `AgentRail.tsx`'s collapsed branch. */
export const DOCK_SPINE_PX = 48;

// ─── layout: beside, or the existing Drawer ─────────────────────────────────

export type DockLayout = 'beside' | 'drawer';

/**
 * Which of the two gates each surface uses — and why BOTH.
 *
 * They measure different quantities and they DISAGREE in a real band:
 *
 *  - `WORKSPACE_EXPANDED_MIN_WIDTH` (1280, `responsive-workspace.ts`) is a
 *    VIEWPORT breakpoint. It is the repo's existing statement that a surface
 *    is in its expanded arrangement, and it is what `ObjectWorkspace.tsx`
 *    already gates its dock on. Using it keeps the dock's narrow-screen
 *    behaviour identical on every surface that hosts one.
 *  - `dockFitsBeside(contentWidthPx)` (W0) is the dock's own PROMISE, in
 *    CONTENT pixels: never push the object below 60% of the width. It needs
 *    `minContentWidthForDockPx()` = 1010 content px.
 *
 * At the breakpoint itself the admin shell's chrome eats the difference: the
 * `xl` sidebar (`w-60` = 240px) appears at exactly 1280, and `<main>` adds
 * `sm:p-6` (24px a side), so a 1280px viewport leaves ~992 content px — 18px
 * SHORT of the dock's promise (the object would get 588 of 992 = 59.3%). The
 * viewport gate alone would therefore break the promise between roughly 1280
 * and 1298 viewport px. Neither gate subsumes the other, so this takes both:
 * the breakpoint for cross-surface consistency, the arithmetic for the
 * promise. Below either, the surface falls back to the EXISTING overlay
 * `Drawer` path rather than a second narrow-screen layout.
 */
export function dockLayout(input: { expandedWorkspace: boolean; contentWidthPx: number }): DockLayout {
  return input.expandedWorkspace && dockFitsBeside(input.contentWidthPx) ? 'beside' : 'drawer';
}

/**
 * The admin shell's chrome beside `<main>`'s content box at `xl`: the 240px
 * (`w-60`) sidebar plus `sm:p-6`'s 24px of padding a side.
 *
 * DESCRIPTIVE, NOT LOAD-BEARING — nothing gates on this. `dockLayout` is fed
 * the element's MEASURED width, so a shell change cannot silently move the
 * gate. It exists so the disagreement documented above is an assertion in
 * `universal-dock.test.ts` rather than a claim in a comment.
 */
export const ADMIN_SHELL_CHROME_PX = 240 + 24 * 2;

/** The viewport width at which the dock's 60% promise first holds inside the admin shell. */
export function minViewportWidthForDockPx(): number {
  return minContentWidthForDockPx() + ADMIN_SHELL_CHROME_PX;
}

// ─── open / collapsed ───────────────────────────────────────────────────────

/**
 * The dock is a 48px spine until something is selected, and opens on the
 * first selection.
 *
 * `userCollapsed` is the human's own toggle and wins WHENEVER there is a
 * selection — including for the second and every later selection, so an
 * editor who collapsed the dock does not get it re-opened in their face by
 * every row they click. With no selection there is nothing to talk about and
 * the spine is forced, whatever the toggle last said.
 */
export function resolveDockCollapsed(input: { selection?: ObjectSelection; userCollapsed?: boolean }): boolean {
  if (!selectionKey(input.selection)) return true;
  return input.userCollapsed === true;
}

// ─── header ─────────────────────────────────────────────────────────────────

export interface DockHeading {
  /** The selected object's title, or the instruction when nothing is selected. */
  title: string;
  /** The type pill's text. Absent exactly when nothing is selected. */
  typeLabel?: string;
  /** True when this is the instruction rather than an object. */
  empty: boolean;
}

export const DOCK_EMPTY_HEADING = 'Select an object';

/**
 * Title + type pill, or the instruction. `displayName` is the host's own row
 * label; the id is the honest fallback, because a selection restored from the
 * address names an object whose row this surface may not have loaded.
 */
export function dockHeading(selection: ObjectSelection | undefined, displayName?: string): DockHeading {
  if (!selectionKey(selection) || !selection) return { title: DOCK_EMPTY_HEADING, empty: true };
  const label = (displayName ?? '').trim();
  return {
    title: label || selection.object_id,
    // The cast is the seam between W0's deliberately-string selection (it
    // parses hand-edited URLs, so it cannot promise a member of the union)
    // and this label map, which falls back to title-cased text for anything
    // it does not know.
    typeLabel: objectTypeLabel(selection.object_type as ObjectType),
    empty: false,
  };
}

/** What the rail says it is working on, and what rides `send`'s `focus`. */
export function dockFocusLabel(selection: ObjectSelection | undefined, displayName?: string): string {
  const heading = dockHeading(selection, displayName);
  return heading.empty ? 'nothing yet — select an object' : `${heading.typeLabel} “${heading.title}”`;
}

// ─── the address ────────────────────────────────────────────────────────────

/**
 * Re-apply the selection to an address the surface has just REBUILT.
 *
 * This is the half that is easy to lose: `ObjectsPlane`'s `syncUrl` and
 * `RequestsWorkspace`'s `requestsAddress` both compose a fresh address out of
 * their own filter state, so every filter change would otherwise drop
 * `?focus=` and silently unbind the dock. Running the rebuilt address back
 * through `withFocus` makes the two independent — a filter change keeps the
 * selection, a selection change keeps the filters.
 */
export function dockAddress(address: string, selection?: ObjectSelection): string {
  return withFocus(address, selection);
}

// ─── the chat binding (lazy, on first send only) ────────────────────────────

/** Selection key → the chat id that selection has already been bound to. */
export type DockChatCache = Readonly<Record<string, string>>;

export type DockChatPhase = 'select' | 'send';

export type DockChatIntent =
  /** Do nothing at all — no fetch, no chat doc. */
  | { kind: 'idle' }
  /** A chat for this selection is already known; attach to it. */
  | { kind: 'attach'; chatId: string }
  /** First send for this selection: `createObjectChat(type, id)`, then send. */
  | { kind: 'mint'; selection: ObjectSelection };

/**
 * THE invariant, as a function.
 *
 * `'select'` is always `idle` — a row click issues no request and mints no
 * chat doc, whatever the cache holds. Only `'send'` may bind, and it prefers
 * a cached id so a second message never mints again. (`admin-agent-chat`'s
 * `create_chat kind:'object'` derives its id from the object id, so a mint is
 * idempotent server-side too — but an unnecessary round trip on every click
 * would still be a round trip on every click.)
 */
export function dockChatIntent(
  phase: DockChatPhase,
  selection: ObjectSelection | undefined,
  cache: DockChatCache
): DockChatIntent {
  if (phase === 'select') return { kind: 'idle' };
  const key = selectionKey(selection);
  if (!key || !selection) return { kind: 'idle' };
  const cached = cache[key];
  return cached ? { kind: 'attach', chatId: cached } : { kind: 'mint', selection };
}

/** The cache after a mint. A new object, so a React state setter can use it directly. */
export function rememberDockChat(
  cache: DockChatCache,
  selection: ObjectSelection | undefined,
  chatId: string
): DockChatCache {
  const key = selectionKey(selection);
  if (!key || !chatId.trim()) return cache;
  return { ...cache, [key]: chatId };
}

// ─── the collapsed preference ───────────────────────────────────────────────

/**
 * Persisted exactly like the rail's other per-scope preferences
 * (`approval-mode.ts`): `sessionStorage`, a versioned key prefix, every
 * read and write guarded so SSR or disabled storage simply behaves as if
 * nothing were persisted. This is the SAME `preferenceScope` the rail
 * already threads to `useRunApprovalMode` / `useTestMode` / `ChatThread` —
 * one scope mechanism, not a second one.
 */
const COLLAPSED_KEY_PREFIX = 'agent-dock-collapsed:v1:';
const DEFAULT_PREFERENCE_SCOPE = 'default';

export const dockCollapsedStorageKey = (scope: string | undefined): string =>
  `${COLLAPSED_KEY_PREFIX}${scope || DEFAULT_PREFERENCE_SCOPE}`;

/**
 * The scope a docked list surface keys its preferences on. Mirrors
 * `ObjectWorkspace`'s `${viewer}:${object_id}` shape and adds the surface,
 * because one viewer can have a dock open on two surfaces at once and their
 * preferences are not the same fact.
 *
 * `selection` is OPTIONAL, and which callers pass it is the point:
 *  - the rail's per-chat preferences (run mode, test mode) are per OBJECT and
 *    pass it, exactly as `ObjectWorkspace` does;
 *  - whether the dock is a SPINE belongs to the surface and omits it —
 *    scoping that per object would re-open a dock the editor deliberately
 *    collapsed the moment they clicked a different row.
 */
export function dockPreferenceScope(surface: string, viewer: string | undefined, selection?: ObjectSelection): string {
  return `${viewer?.trim() || 'anonymous'}:${surface}:${selectionKey(selection)}`;
}

/** `undefined` when nothing has been stored for this scope — the caller's default then stands. */
export function readPersistedDockCollapsed(scope: string | undefined): boolean | undefined {
  try {
    const raw = sessionStorage.getItem(dockCollapsedStorageKey(scope));
    return raw === '1' ? true : raw === '0' ? false : undefined;
  } catch {
    return undefined;
  }
}

/** Never throws — a write failure only means the choice is not sticky this session. */
export function writePersistedDockCollapsed(scope: string | undefined, collapsed: boolean): void {
  try {
    sessionStorage.setItem(dockCollapsedStorageKey(scope), collapsed ? '1' : '0');
  } catch {
    // ignored — private browsing / disabled storage
  }
}
