/**
 * ASV2-W0.2 — the object SELECTION the universal dock binds to.
 *
 * The dock is mounted on surfaces that LIST objects (objects library,
 * requests, editorial, media), where there is no single object in scope the
 * way there is on a detail page. What the agent is talking about is instead a
 * selection: the row the editor clicked, or the one the URL named.
 *
 * Why the pair is validated here and nowhere else: `engine.ts`'s Constraint 7
 * sends `object_type`/`object_id` to CMS-Agent **paired or not at all**, and
 * the wire bounds them (128 / 256 chars, `cms-agent-client.ts`
 * `checkConverseBounds`). A half-parsed selection out of a hand-edited URL
 * must therefore be no selection, not a malformed one — a bad pair does not
 * fail a render, it burns a turn_id.
 *
 * Address format: `?focus=<object_type>:<object_id>`. One parameter, because
 * it is one fact; `:` because no object type or id in this system contains
 * one (types are snake_case, ids are `req_…` / slug / uuid shaped) and the
 * split is on the FIRST colon so an id that ever does keeps working.
 *
 * Pure and DOM-free on purpose (AGENTS.md §4: no DOM harness — UI decisions
 * live in `packages/core/lib/admin/*.ts` and are tested with `node:test`).
 */

export type ObjectSelection = {
  object_type: string;
  object_id: string;
};

/** The wire's own bounds, restated so a selection can never produce an invalid turn. */
const MAX_TYPE = 128;
const MAX_ID = 256;

const clean = (raw: string | null | undefined): string => (typeof raw === 'string' ? raw.trim() : '');

/**
 * Read a selection out of a query string (`window.location.search`, with or
 * without its leading `?`). Anything that is not a valid, bounded pair reads
 * as no selection at all.
 */
export function parseFocus(search: string | null | undefined): ObjectSelection | undefined {
  const raw = clean(new URLSearchParams(clean(search)).get('focus'));
  if (!raw) return undefined;
  const cut = raw.indexOf(':');
  if (cut <= 0 || cut === raw.length - 1) return undefined;
  const object_type = raw.slice(0, cut).trim();
  const object_id = raw.slice(cut + 1).trim();
  if (!object_type || !object_id) return undefined;
  if (object_type.length > MAX_TYPE || object_id.length > MAX_ID) return undefined;
  return { object_type, object_id };
}

/**
 * A stable identity for a selection — the key a dock keys its chat cache,
 * its collapsed-state preference and its `useEffect` deps on. Empty string
 * for "nothing selected", so it is safe to compare without a null dance.
 */
export function selectionKey(selection: ObjectSelection | undefined | null): string {
  if (!selection) return '';
  const parsed = parseFocus(`focus=${encodeURIComponent(`${selection.object_type}:${selection.object_id}`)}`);
  return parsed ? `${parsed.object_type}:${parsed.object_id}` : '';
}

/**
 * The same address with the selection set (or cleared, when `selection` is
 * undefined). Every other parameter, the path and the hash survive — the
 * dock writes this back with `history.replaceState`, and the surfaces it
 * mounts on carry filter state in the query string too (`RequestsWorkspace`'s
 * `requestsAddress`, `ObjectsPlane`'s params), so a selection that dropped
 * them would silently reset the editor's filters.
 *
 * Accepts an absolute or a root-relative URL and returns the same shape it
 * was given.
 */
export function withFocus(url: string, selection: ObjectSelection | undefined | null): string {
  const relative = !/^[a-z][a-z0-9+.-]*:\/\//i.test(url);
  const parsed = new URL(url, relative ? 'https://selection.invalid' : undefined);
  const key = selectionKey(selection);
  if (key) parsed.searchParams.set('focus', key);
  else parsed.searchParams.delete('focus');
  return relative ? `${parsed.pathname}${parsed.search}${parsed.hash}` : parsed.toString();
}
