/**
 * CHAT-ORIGIN — where a chat came from, as data.
 *
 * Client Manager (CMS-Agent `client_manager`, rev 9) renders a "What this chat
 * is about" block from `context.origin`. Platform is the only thing that knows
 * the answer: which admin surface opened the conversation, which hub starter
 * seeded it, and which editorial request / workflow run it is about.
 *
 * TWO RULES THIS MODULE EXISTS TO HOLD.
 *
 * 1. **The surface is DERIVED FROM THE ROUTE, never hand-typed per call site.**
 *    Eight surfaces mint chats today and more will; a string literal at each
 *    `createFreeChat` call is a set of eight facts that drift independently
 *    the first time a component is reused on a second route. `currentOriginSurface()`
 *    reads the route the component is actually mounted on, and this file owns
 *    the route → slug map.
 * 2. **Unknown is a slug, not `undefined`.** The wire's `surface` is required
 *    (CMS-Agent's `conversationContract.ts`), so a route this map has never
 *    heard of answers `'admin'` — "some admin surface" is a true statement and
 *    an absent field is not a legal one.
 *
 * Pure by construction (one string in, one string out) so it is tested with
 * `node:test` on plain `.ts` — the platform-admin convention: UI decisions live
 * in `packages/core/lib/admin/*.ts`, never in a `.tsx` a test cannot reach.
 */

/** A route this map has never seen. Never `undefined` — see rule 2 above. */
export const UNKNOWN_ORIGIN_SURFACE = 'admin';

/** Slug hygiene: the wire wants a short route-derived token, not a path. */
const MAX_SURFACE_LENGTH = 64;

/** The ASV2 dock's selection, wire-shaped (`object-selection.ts` keeps the same pair). */
export interface ChatOriginSelection {
  object_type: string;
  object_id: string;
}

/** What a chat CREATION knows: the surface, and the starter when one seeded it. */
export interface ChatCreateOrigin {
  surface: string;
  starter?: string;
}

/**
 * What a SEND knows: the job this turn is about, the dock's selection when
 * the chat is not object-bound, and (PCL-P4) the starter chip key the
 * composer's text still traces back to, when it does. Unlike `surface`
 * (`ChatCreateOrigin`, stamped once at chat creation and immutable after), a
 * chip can be clicked on ANY send while the transcript is still empty, so its
 * key rides the per-send half and is frozen onto the RUN, not the chat doc.
 */
export interface ChatSendOrigin {
  request_id?: string;
  run_id?: string;
  selection?: ChatOriginSelection;
  starter?: string;
}

/**
 * The routes whose slug is NOT their first path segment, and why.
 *
 * Keyed by the path under `/admin` — the first segment, or the first two when
 * the second is what names the surface (`settings/visual-identity`). Everything
 * else derives: `/admin/requests/req_123` → `requests`, `/admin/inventory` →
 * `inventory`, `/admin/objects` → `objects`, `/admin/agents` → `agents`,
 * `/admin/templates` → `templates`.
 */
const SURFACE_OVERRIDES: Readonly<Record<string, string>> = {
  // `/admin` redirects to the landing surface; a chat minted on the way there
  // is a home chat, not an "admin" one.
  '': 'home',
  // AdminHome's own route since T1.6 moved it off the bare `/admin`.
  editorial: 'home',
  // `/admin/content/<objectId>` is ObjectWorkspace — one object, one workspace.
  // The bare `/admin/content` is a retired redirect target (see
  // `admin-nav-route-parity.test.ts`) and answers the same thing, which is
  // still true of any chat opened while passing through it.
  content: 'object-workspace',
  'settings/visual-identity': 'visual-identity',
};

/** Keep a derived slug to the shape CMS-Agent's block renders: lowercase token, bounded. */
const cleanSlug = (raw: string): string | undefined => {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!slug) return undefined;
  return slug.slice(0, MAX_SURFACE_LENGTH);
};

/**
 * The route → surface slug map, as a function. Query strings, hashes and
 * trailing slashes are all the same route.
 */
export const originSurfaceForPath = (pathname: string | undefined): string => {
  const path = (pathname ?? '').split('?')[0]!.split('#')[0]!;
  const segments = path.split('/').filter((segment) => segment.length > 0);
  if (segments[0] !== 'admin') return UNKNOWN_ORIGIN_SURFACE;
  const rest = segments.slice(1);
  const first = rest[0] ?? '';
  const firstTwo = rest.slice(0, 2).join('/');
  const override = SURFACE_OVERRIDES[firstTwo] ?? SURFACE_OVERRIDES[first];
  if (override) return override;
  return cleanSlug(first) ?? UNKNOWN_ORIGIN_SURFACE;
};

/**
 * The surface the calling component is mounted on. The ONE impure line in this
 * module, and the reason every call site reads `currentOriginSurface()` rather
 * than naming itself: a component that moves route moves surface with it.
 *
 * SSR-safe — a render with no `location` answers the unknown slug rather than
 * throwing, exactly like every other browser-storage read in this directory.
 */
export const currentOriginSurface = (): string => {
  if (typeof window === 'undefined' || typeof window.location?.pathname !== 'string') {
    return UNKNOWN_ORIGIN_SURFACE;
  }
  return originSurfaceForPath(window.location.pathname);
};

/** The creation origin for the surface this component is mounted on, with an optional starter key. */
export const chatCreateOrigin = (starter?: string): ChatCreateOrigin => ({
  surface: currentOriginSurface(),
  ...(starter ? { starter } : {}),
});

/**
 * A send origin with the empty parts dropped — `undefined` when there is
 * nothing to say. `sendChatMessage` omits the field entirely in that case, so
 * a turn that knows nothing about a request is byte-identical to today's.
 */
export const chatSendOrigin = (parts: ChatSendOrigin | undefined): ChatSendOrigin | undefined => {
  if (!parts) return undefined;
  const origin: ChatSendOrigin = {
    ...(parts.request_id ? { request_id: parts.request_id } : {}),
    ...(parts.run_id ? { run_id: parts.run_id } : {}),
    ...(parts.selection?.object_type && parts.selection?.object_id
      ? { selection: { object_type: parts.selection.object_type, object_id: parts.selection.object_id } }
      : {}),
    ...(parts.starter ? { starter: parts.starter } : {}),
  };
  return Object.keys(origin).length > 0 ? origin : undefined;
};
