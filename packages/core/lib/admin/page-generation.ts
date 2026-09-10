/**
 * T1.1 (admin latency plan) — one page-generation `AbortSignal`, shared by
 * every admin client module and React island.
 *
 * Every admin data effect used a bare `alive` boolean that only ever
 * DISCARDED the result of a stale fetch — the HTTP request itself kept
 * running to completion, competing with the next page's own calls for the
 * same Netlify function concurrency. Measured effect: leaving
 * `/admin/inventory` for `/admin/kit` produced 58 calls on the Kit page, 53
 * of which were `get-blob-image` requests Inventory had already issued and
 * abandoned — the root cause of the 5-10x call-to-call latency variance.
 *
 * This module owns ONE `AbortController` for "whatever page generation is
 * current". Astro's `ClientRouter` (view transitions) fires
 * `astro:before-preparation` on `document` the instant a same-origin
 * navigation begins — before the next page's HTML is even requested — so
 * `AdminLayout.astro` wires that event to `beginNewPageGeneration()` (the
 * only writer this module has). Every other module only ever READS the
 * current signal, via `currentPageSignal()` (plain getter, for client
 * modules) or `usePageSignal()` (a hook, for components that want to
 * re-render when a new generation begins — most don't need to, since a fresh
 * page generation also remounts the React tree that issued the original
 * read).
 *
 * Only ever wire this signal into READS. A verb the user explicitly
 * triggered that writes server state (approve / archive / publish / save /
 * …) must run to completion even if the user navigates away the instant
 * after clicking it — each client module's own call sites decide which of
 * its functions is which; see their comments.
 */
import { useSyncExternalStore } from 'react';

let controller = new AbortController();
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((listener) => listener());

/** The signal for whatever page generation is current right now. Read-only; never mutate it directly. */
export function currentPageSignal(): AbortSignal {
  return controller.signal;
}

/**
 * Aborts the outgoing generation's signal (every READ still holding it fails
 * with `AbortError`) and mints a fresh one for the page that is about to
 * take over. Safe to call more than once per navigation — a second call just
 * aborts an already-fresh, request-free signal — so callers never need to
 * guard against a double fire.
 */
export function beginNewPageGeneration(): AbortSignal {
  if (!controller.signal.aborted) controller.abort();
  controller = new AbortController();
  emit();
  return controller.signal;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Hook form of `currentPageSignal()` — re-renders the caller when a new page generation begins. */
export function usePageSignal(): AbortSignal {
  return useSyncExternalStore(subscribe, currentPageSignal, currentPageSignal);
}

/** True for the one error `fetch` throws when its `signal` aborts — never a real load failure, and never worth an error toast. */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

/** Test-only: start each test from a clean, unaborted controller instead of leaking one across files. */
export function resetPageGenerationForTests(): void {
  controller = new AbortController();
}
