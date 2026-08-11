/**
 * Margin-rail geometry and thread bucketing (T17.3) — the pure half.
 *
 * The rail itself is DOM-heavy and lives in ui.ts; everything here is a
 * function of numbers and plain data so the rules the concept fixes —
 * which layout mode a viewport gets, where a displaced bubble lands, which
 * bubble a thread belongs to — are unit-tested headlessly, the same
 * discipline targets.ts / preview.ts / marginalia-panel.ts already follow in
 * this directory (the repo has no DOM test harness on purpose).
 *
 * Spec: docs/design/marginalia-interaction-model.md §§1.2, 1.3, 3.1, 8.1, 8.2.
 *
 * §1.2/§1.3 were rewritten by W17 Fix 1 (2026-08-11): the page slide they
 * specified is RETRACTED. Nothing in this module may produce a number that
 * moves the document — see `no-page-movement.test.ts`, which pins that.
 */

/**
 * §1.3's mode ladder, after Wolf's 2026-08-11 ruling retired the page slide
 * ("The article must never move. Keep everything like it is published."):
 * - `inset`   — the margin already fits the full rail; the rail floats in it.
 * - `compact` — the rail narrows to the margin the page actually has (floor
 *               `railMinWidth`) and sits at `right: railPad`.
 * - `markers` — below that floor there is no rail: gutter markers only, and a
 *               marker click opens its bubble as a popover anchored to it.
 * - `sheet`   — too narrow for any of it; the bottom sheet serves.
 *
 * NOT ONE OF THEM MOVES THE PAGE. The reading column and the block being
 * worked on hold still at every width; the rail is what adapts.
 */
export type RailLayoutMode = 'inset' | 'compact' | 'markers' | 'sheet';

/** Widest first — how much rail a mode gets. Used for the hysteresis compare. */
const MODE_RANK: Record<RailLayoutMode, number> = { sheet: 0, markers: 1, compact: 2, inset: 3 };

/**
 * Wolf's ruling applies to ARTICLE surfaces without exception ("let's keep
 * this rule for articles only. if it doesn't fit move other objects") — so
 * this is the one seam where "may this surface displace page content to make
 * room?" is answered, rather than a conditional scattered through the layout
 * code.
 *
 * It answers `false` for every surface today: no mode in the ladder above
 * displaces anything, on any surface, so the non-article half of the ruling
 * has no implementation to gate yet. When a displacement behaviour is built
 * for non-article surfaces it is gated HERE and nowhere else, and the
 * never-move invariant test in `no-page-movement.test.ts` is what stops it
 * from leaking onto articles.
 */
export type RailSurfaceKind = 'article' | 'other';
export const railMayDisplaceContent = (_surface: RailSurfaceKind): boolean => false;

export type RailMetrics = {
  /** The LAYOUT viewport (documentElement.clientWidth) — scrollbar excluded. */
  viewportWidth: number;
  /**
   * Right edge of the widest in-viewport annotated CONTENT column, in
   * viewport px. Navigation regions and full-bleed bands are not columns and
   * ui.ts does not measure them.
   */
  columnRight: number;
  /** The rail at full width (the concept's 344px). */
  railWidth: number;
  /** The narrowest a `compact` rail is allowed to get before `markers` wins. */
  railMinWidth: number;
  railGap: number;
  /** Minimum rail → viewport right edge. */
  railPad: number;
  /** Below this viewport width there is no rail at all (§1.3, proposed 900). */
  sheetFloor: number;
};

/**
 * Enter a narrower mode the moment it is needed; return to a wider one only
 * once there are 24px to spare. Without the band, a viewport parked on a
 * threshold flips modes on every stray resize pixel.
 */
export const RAIL_MODE_HYSTERESIS = 24;

/** The mode the metrics imply cold, with every threshold raised by `slack`. */
const modeAt = (metrics: RailMetrics, slack: number): RailLayoutMode => {
  if (metrics.viewportWidth < metrics.sheetFloor + slack) return 'sheet';
  const naturalMargin = metrics.viewportWidth - metrics.columnRight;
  const chrome = metrics.railGap + metrics.railPad;
  if (naturalMargin >= metrics.railWidth + chrome + slack) return 'inset';
  if (naturalMargin >= metrics.railMinWidth + chrome + slack) return 'compact';
  return 'markers';
};

/**
 * The mode for these metrics. `previous` is the mode currently applied, if
 * any: narrowing takes effect immediately, widening only once the metrics
 * clear the threshold by `RAIL_MODE_HYSTERESIS`.
 *
 * ui.ts calls this on resize (and on the content-rebuild cadence) and NEVER
 * on hover, focus, pin or thread write — a pointer must not be able to change
 * the layout at all.
 */
export const selectRailLayoutMode = (metrics: RailMetrics, previous?: RailLayoutMode): RailLayoutMode => {
  const cold = modeAt(metrics, 0);
  if (previous === undefined) return cold;
  if (MODE_RANK[cold] <= MODE_RANK[previous]) return cold;
  const widened = modeAt(metrics, RAIL_MODE_HYSTERESIS);
  return MODE_RANK[widened] > MODE_RANK[previous] ? widened : previous;
};

/**
 * How wide the rail is drawn — `--dlem-rail-w`, so `compact` is a single
 * variable write. `undefined` where there is no rail column to size.
 */
export const railWidthFor = (mode: RailLayoutMode, metrics: RailMetrics): number | undefined => {
  if (mode === 'inset') return metrics.railWidth;
  if (mode !== 'compact') return undefined;
  const available = metrics.viewportWidth - metrics.columnRight - metrics.railGap - metrics.railPad;
  return Math.min(metrics.railWidth, Math.max(metrics.railMinWidth, available));
};

/**
 * The rail's left edge in viewport px — derived from the CONTENT COLUMN
 * (§1.2), never from a displaced page. `undefined` in `markers` / `sheet`
 * mode: there is no rail column to place.
 */
export const railLeftFor = (mode: RailLayoutMode, metrics: RailMetrics): number | undefined => {
  const width = railWidthFor(mode, metrics);
  if (width === undefined) return undefined;
  const pinnedRight = metrics.viewportWidth - metrics.railPad - width;
  return Math.max(metrics.railPad, Math.min(metrics.columnRight + metrics.railGap, pinnedRight));
};

export type RailEntryBox = { desiredTop: number; height: number };

/**
 * §8.1's top-down packing pass — the standard sidenote algorithm:
 * `top = max(desiredTop, previousBottom + gap)`. Entries are packed in the
 * order given (document order), so an earlier bubble never jumps below a
 * later one.
 */
export const packRailEntries = (entries: readonly RailEntryBox[], gap: number): number[] => {
  const tops: number[] = [];
  let previousBottom: number | undefined;
  for (const entry of entries) {
    const top = previousBottom === undefined ? entry.desiredTop : Math.max(entry.desiredTop, previousBottom + gap);
    tops.push(top);
    previousBottom = top + entry.height;
  }
  return tops;
};

export type RailAnchorLike = {
  objectType: string;
  objectId: string;
  sectionId?: string;
  nodeId?: string;
};

/**
 * The identity a thread and a rendered region agree on. Uses a NUL separator
 * so no id value can forge a different key by containing the separator.
 */
export const marginaliaAnchorKey = (anchor: RailAnchorLike): string =>
  [anchor.objectType, anchor.objectId, anchor.sectionId ?? '', anchor.nodeId ?? ''].join('\u0000');

/** True when the anchor names a specific block rather than the whole object. */
export const isBlockAnchor = (anchor: RailAnchorLike): boolean => Boolean(anchor.sectionId || anchor.nodeId);

export type RailThreadEntry<T> = { key: string; blockAnchored: boolean; thread: T };

export type RailPartition<T> = {
  /** Threads whose anchored block IS on the page, keyed by anchor key, input order preserved. */
  blocks: Map<string, T[]>;
  /** Whole-object threads (no section/node anchor) — the rail's top group (§3.1). */
  wholeObject: T[];
  /** Block-anchored threads whose block is not in the DOM — never dropped (§8.2). */
  orphans: T[];
};

/**
 * Bucket every thread on the page. A thread whose anchor key matches a
 * rendered region is a block thread — checked FIRST, so a whole-object anchor
 * on an object that does have a region (a navigation object, say) attaches to
 * that region instead of floating to the rail top.
 */
export const partitionRailThreads = <T>(
  entries: readonly RailThreadEntry<T>[],
  presentAnchorKeys: ReadonlySet<string>
): RailPartition<T> => {
  const blocks = new Map<string, T[]>();
  const wholeObject: T[] = [];
  const orphans: T[] = [];
  for (const entry of entries) {
    if (presentAnchorKeys.has(entry.key)) {
      const existing = blocks.get(entry.key);
      if (existing) existing.push(entry.thread);
      else blocks.set(entry.key, [entry.thread]);
    } else if (!entry.blockAnchored) {
      wholeObject.push(entry.thread);
    } else {
      orphans.push(entry.thread);
    }
  }
  return { blocks, wholeObject, orphans };
};

/**
 * §8.1: several threads on one block stack in the rail, newest last; beyond
 * `max` the stack collapses to the newest plus a `+N` control.
 */
export const collapseThreadStack = <T>(threads: readonly T[], max = 3): { visible: T[]; hidden: number } => {
  if (threads.length <= max) return { visible: [...threads], hidden: 0 };
  const newest = threads[threads.length - 1];
  return { visible: [newest], hidden: threads.length - 1 };
};
