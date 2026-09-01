/**
 * W21.2 — the query string of `/admin/requests`, parsed once, in one place.
 *
 * ## Why this is a module and not four `useState` initializers
 *
 * The live bug: `/admin/requests?filter=done` rendered the Done list with the
 * **Needs you** tab highlighted. The component was already reading `filter`
 * from the URL — but it read it inside the state initializers, and
 * `requests.astro` mounts the island `client:load`, which SERVER-renders it
 * first. On the server `window` is undefined, so the read returned nothing and
 * the markup was painted with `DEFAULT_REQUEST_QUICK_FILTER`. On hydration the
 * same initializer ran again, this time saw `done`, and React kept the
 * server's `className` anyway — attribute mismatches are not patched during
 * hydration, only warned about in development. The rows looked right because
 * they arrive from a client-side fetch afterwards; the tab was the one thing
 * painted server-side, so the tab was the one thing that stayed wrong.
 *
 * The repair is to stop asking a question the server cannot answer while it is
 * rendering: both renders start from the SAME defaults, and the URL is applied
 * afterwards, in an effect, through React's own update path. That makes this
 * function the load-bearing piece — the parse and the default — and it is pure,
 * so it can be tested where a hydration lifecycle cannot.
 */
import { DEFAULT_REQUEST_QUICK_FILTER, QUICK_FILTERS, type RequestQuickFilter } from './request-logic.js';

export interface RequestUrlFilters {
  quickFilter: RequestQuickFilter;
  /** The `kind` select's value; `''` is "any kind", which is also its default. */
  kind: string;
  mine: boolean;
  /** The search box's text. */
  q: string;
}

/**
 * What BOTH renders start from — the server's, which has no URL to read, and
 * the browser's first (hydrating) one, which must agree with it. Every value
 * here is also the one the URL-writer omits, so a default view has a bare
 * `/admin/requests` address.
 */
export const DEFAULT_REQUEST_URL_FILTERS: RequestUrlFilters = {
  quickFilter: DEFAULT_REQUEST_QUICK_FILTER,
  kind: '',
  mine: false,
  q: '',
};

/** `filter=` only names a tab that exists — anything else is not a filter, it is noise. */
export const isQuickFilter = (value: string | null | undefined): value is RequestQuickFilter =>
  Boolean(value) && QUICK_FILTERS.some((tab) => tab.key === value);

/**
 * The four filters a `/admin/requests` address can carry.
 *
 * Takes the search string rather than reading `window`, so the caller decides
 * WHEN this is asked — which is the whole point (see the header). Accepts the
 * leading `?` or not, and `undefined` for "there is no location", which is the
 * server's honest answer and yields exactly the defaults.
 *
 * A parameter that is present but unusable (`filter=nonsense`) falls back to
 * the default for that field alone; the others still apply. Guardrail 5 in
 * miniature: an unreadable value is not an excuse to invent one, and it is not
 * a reason to throw the readable ones away either.
 */
export const readRequestUrlFilters = (search: string | undefined): RequestUrlFilters => {
  const params = new URLSearchParams(search ?? '');
  const filter = params.get('filter');
  return {
    quickFilter: isQuickFilter(filter) ? filter : DEFAULT_REQUEST_URL_FILTERS.quickFilter,
    kind: params.get('kind') ?? DEFAULT_REQUEST_URL_FILTERS.kind,
    mine: params.get('mine') === '1',
    q: params.get('q') ?? DEFAULT_REQUEST_URL_FILTERS.q,
  };
};


/** The four fields, as a key — what "the user has touched this one" is keyed by. */
export type RequestUrlFilterField = keyof RequestUrlFilters;

/**
 * FIX 4 — which of the address's filters may still be applied after
 * hydration, and the load-bearing half of the W21.2 repair.
 *
 * The island is `client:load`, so the URL can only be read AFTER the first
 * render — which leaves a window in which the person can already have clicked
 * a tab. W21.2 decided "they have not touched this" by comparing the current
 * value to its default, which cannot distinguish "untouched" from
 * "deliberately set to the default value": on `?filter=done`, clicking the
 * default **Needs you** tab inside that window was silently reverted to Done.
 *
 * Interaction is the actual question, so it is the actual input here. A field
 * the person has touched is simply absent from the result; the caller applies
 * only what comes back. Pure, so the property can be tested where the
 * hydration lifecycle cannot be (no DOM harness — see the test file).
 */
export const urlFiltersToApply = (
  search: string | undefined,
  touched: ReadonlySet<RequestUrlFilterField>
): Partial<RequestUrlFilters> => {
  const fromUrl = readRequestUrlFilters(search);
  return {
    ...(touched.has('quickFilter') ? {} : { quickFilter: fromUrl.quickFilter }),
    ...(touched.has('kind') ? {} : { kind: fromUrl.kind }),
    ...(touched.has('mine') ? {} : { mine: fromUrl.mine }),
    ...(touched.has('q') ? {} : { q: fromUrl.q }),
  };
};

/**
 * FIX 6 — the address `/admin/requests` should be showing, given the filters
 * and whichever row's drawer is open.
 *
 * THE one writer, so the query string cannot be lost by a caller that only
 * meant to change the path. It was: the drawer pushed a bare
 * `/admin/requests/<id>` and closing it pushed a bare `/admin/requests`, so
 * opening and closing a row silently dropped `?filter=done` while the Done tab
 * stayed lit — the same "the tab disagrees with the URL" symptom W21.2 exists
 * to end, reachable in two clicks.
 *
 * A filter at its default is omitted, so a default view keeps a bare address
 * and a link copied out of the bar reopens the view it was copied from.
 */
export const requestsAddress = (filters: RequestUrlFilters, openId?: string): string => {
  const params = new URLSearchParams();
  if (filters.quickFilter !== DEFAULT_REQUEST_URL_FILTERS.quickFilter) params.set('filter', filters.quickFilter);
  if (filters.kind) params.set('kind', filters.kind);
  if (filters.mine) params.set('mine', '1');
  if (filters.q) params.set('q', filters.q);
  const search = params.toString();
  const path = openId ? `/admin/requests/${encodeURIComponent(openId)}` : '/admin/requests';
  return search ? `${path}?${search}` : path;
};
