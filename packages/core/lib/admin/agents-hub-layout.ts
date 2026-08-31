/**
 * A6 — the "Start something" rail vs. the chat column on `AgentsHub.tsx`.
 * There is no DOM harness in this repo (BRIEF.md's test convention), so the
 * column split is expressed as data here and asserted arithmetically in
 * `agents-hub-layout.test.ts` instead of being verified by rendering.
 *
 * `AgentsHub.tsx`'s grid (`lg:grid-cols-[260px_minmax(0,1fr)]`, `gap-5`) MUST
 * stay in lockstep with `railPx`/`gapPx` below — Tailwind's arbitrary values
 * have to be literal strings for its content scanner (see `primitives.tsx`'s
 * header comment), so nothing enforces that at compile time. Keep both
 * edits together.
 */
export const AGENTS_HUB_LAYOUT = {
  /** The rail (starters + session list) is now a FIXED width, not a fraction
   * of the viewport — the old `minmax(0,1fr)` column grew with the window,
   * squeezing the chat column at exactly the sizes where it mattered most. */
  railPx: 260,
  /** Matches the grid's `gap-5` (Tailwind gap-5 = 1.25rem = 20px). */
  gapPx: 20,
} as const;

/** The chat column's pixel width at a given content width, once the fixed rail and the gap are subtracted. */
export function chatColumnWidthPx(contentWidthPx: number): number {
  return Math.max(0, contentWidthPx - AGENTS_HUB_LAYOUT.railPx - AGENTS_HUB_LAYOUT.gapPx);
}

/** The chat column's share of the content width, as a 0–1 fraction. */
export function chatColumnFraction(contentWidthPx: number): number {
  if (contentWidthPx <= 0) return 0;
  return chatColumnWidthPx(contentWidthPx) / contentWidthPx;
}
