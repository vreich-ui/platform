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
 */

/**
 * §1.3's three modes:
 * - `inset`  — the page already has margin enough; the rail floats in it and
 *              the document does not move.
 * - `slide`  — the rail does not fit; the page slides left (a wrapper gains
 *              `padding-right`, so the `mx-auto` column re-centres) and the
 *              rail pins to the viewport's right edge.
 * - `sheet`  — too narrow for both; no rail, the bottom sheet serves.
 */
export type RailLayoutMode = 'inset' | 'slide' | 'sheet';

export type RailMetrics = {
  viewportWidth: number;
  /**
   * Right edge of the widest in-viewport annotated region, in viewport px,
   * measured with NO slide applied. Measuring it while slid would feed the
   * mode decision its own output and oscillate (slide → more margin → inset
   * → less margin → slide); ui.ts removes the slide for the measurement.
   */
  columnRight: number;
  railWidth: number;
  railGap: number;
  /** Minimum rail → viewport right edge. */
  railPad: number;
  /** Below this viewport width there is no rail at all (§1.3, proposed 900). */
  slideFloor: number;
};

export const selectRailLayoutMode = (metrics: RailMetrics): RailLayoutMode => {
  if (metrics.viewportWidth < metrics.slideFloor) return 'sheet';
  const naturalMargin = metrics.viewportWidth - metrics.columnRight;
  return naturalMargin >= metrics.railWidth + metrics.railGap + metrics.railPad ? 'inset' : 'slide';
};

/** The `padding-right` the slide applies to the page wrapper; 0 in every other mode. */
export const railSlidePadding = (mode: RailLayoutMode, metrics: RailMetrics): number =>
  mode === 'slide' ? metrics.railWidth + metrics.railGap + metrics.railPad : 0;

/**
 * The rail's left edge in viewport px — derived from the CONTENT COLUMN in
 * `inset` mode (§1.2) and from the viewport's right edge in `slide` mode.
 * `undefined` in `sheet` mode: there is no rail to place.
 */
export const railLeftFor = (mode: RailLayoutMode, metrics: RailMetrics): number | undefined => {
  if (mode === 'sheet') return undefined;
  const pinnedRight = metrics.viewportWidth - metrics.railPad - metrics.railWidth;
  if (mode === 'slide') return Math.max(metrics.railPad, pinnedRight);
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
