/**
 * ASV2-W0.1 — the geometry of the agent surface: the universal dock beside an
 * object, and the hub's session rail beside the conversation.
 *
 * Principle this file encodes (`docs/cms-architecture/chat-controls-protocol.md`
 * §6–§7's companion design): one agent, many entry points, one active surface
 * at a time. The dock is a guest on an object's page and must never be the
 * reason the object is unreadable — `MIN_OBJECT_FRACTION` is that promise,
 * expressed as arithmetic so it can be tested.
 *
 * There is no DOM harness in this repo (AGENTS.md §4), so every layout
 * decision lives here as data and is asserted arithmetically in
 * `agents-hub-layout.test.ts` rather than by rendering.
 *
 * LOCKSTEP WARNING — Tailwind's arbitrary values must be literal strings for
 * its content scanner (see `primitives.tsx`'s header comment), so nothing
 * enforces the following at compile time. Change a number here and change its
 * literal in the same commit. The literals AS THEY ARE WRITTEN TODAY
 * (re-verified by the ASV2-W5 review pass; `rg` for each string before
 * trusting this list):
 *   - `dockPx: 384`      → `w-[24rem]` (= 384px) on the dock wrapper in
 *                          `ObjectWorkspace.tsx`, `ObjectsPlane.tsx` and
 *                          `RequestsWorkspace.tsx`. Their grid track is
 *                          `lg:grid-cols-[minmax(0,1fr)_auto]`, not a pixel
 *                          literal, so that a COLLAPSED dock shrinks to its
 *                          48px spine (`w-12`, `DOCK_SPINE_PX`) instead of
 *                          leaving a blank 24rem gutter.
 *   - `hubRailPx: 220`   → `lg:grid-cols-[220px_minmax(0,1fr)]` in `AgentsHub.tsx`
 *   - `gapPx: 20`        → `gap-5`, on the hub grid AND on all three dock
 *                          grids. W2 shipped the dock grids as `gap-4`, which
 *                          made `dockFitsBeside`'s arithmetic 4px pessimistic
 *                          against the real layout; W5 aligned the literal
 *                          rather than the constant, because `gapPx` also
 *                          feeds `minContentWidthForDockPx()` (= 1010), which
 *                          is asserted in `agents-hub-layout.test.ts`.
 */
export const AGENT_SURFACE_LAYOUT = {
  /** The universal dock: 24rem. Fixed — there is no `Resizable` primitive in this kit, so it collapses rather than drags. */
  dockPx: 384,
  /** The hub's starters + sessions rail. Narrower than the 260px it replaces because it now slides away entirely while a chat is open. */
  hubRailPx: 220,
  /** Matches `gap-5` (1.25rem = 20px) in both grids. */
  gapPx: 20,
  /** The dock may never push the object it is docked beside below this share of the content width. */
  minObjectFraction: 0.6,
} as const;

export const DOCK_PX = AGENT_SURFACE_LAYOUT.dockPx;
export const HUB_RAIL_PX = AGENT_SURFACE_LAYOUT.hubRailPx;
export const MIN_OBJECT_FRACTION = AGENT_SURFACE_LAYOUT.minObjectFraction;

/** The object column's pixel width at a given content width, with the dock open or collapsed to its spine. */
export function objectColumnWidthPx(contentWidthPx: number, dockOpen: boolean): number {
  if (!dockOpen) return Math.max(0, contentWidthPx);
  return Math.max(0, contentWidthPx - AGENT_SURFACE_LAYOUT.dockPx - AGENT_SURFACE_LAYOUT.gapPx);
}

/** The object column's share of the content width, as a 0–1 fraction. */
export function objectColumnFraction(contentWidthPx: number, dockOpen: boolean): number {
  if (contentWidthPx <= 0) return 0;
  return objectColumnWidthPx(contentWidthPx, dockOpen) / contentWidthPx;
}

/**
 * Whether the dock may open BESIDE the object at this content width, or must
 * fall back to the overlay `Drawer` path (`ObjectWorkspace.tsx`'s existing
 * branch). The rule is the promise above, not a second breakpoint: below this
 * width the dock would starve the object, so it stops being a column.
 */
export function dockFitsBeside(contentWidthPx: number): boolean {
  return objectColumnFraction(contentWidthPx, true) >= AGENT_SURFACE_LAYOUT.minObjectFraction;
}

/** The narrowest content width at which the dock still keeps its promise. Rounded up to a whole pixel. */
export function minContentWidthForDockPx(): number {
  return Math.ceil((AGENT_SURFACE_LAYOUT.dockPx + AGENT_SURFACE_LAYOUT.gapPx) / (1 - AGENT_SURFACE_LAYOUT.minObjectFraction));
}
