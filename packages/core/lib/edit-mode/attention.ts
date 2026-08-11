/**
 * The attention model (T17.6) — the pure half.
 *
 * "Needs attention" has exactly one definition in this system: **an open
 * thread**. Not unread — the marginalia store has no per-user read state and
 * this task does not invent one. Everything a gutter marker or the toolbar's
 * `Attention N` shows is derived here, from a thread list, so the definition
 * lives in one testable place rather than in three DOM callbacks.
 *
 * Spec: docs/design/marginalia-interaction-model.md §4.
 */
import type { MarginaliaThreadStatus } from '../../schema/marginalia-v1.js';

export type AttentionThread = { status: MarginaliaThreadStatus };
export type AttentionRow<T extends AttentionThread> = { key: string; thread: T };

/** Open threads only — `resolved` and `dismissed` never count (§4.1). */
export const openThreadCount = (threads: readonly AttentionThread[]): number =>
  threads.filter((thread) => thread.status === 'open').length;

export type BlockAttention = { open: number; resolved: number };

/**
 * Per-block tallies, keyed by anchor key. `resolved` folds `dismissed` in:
 * both mean "there is history here, but nothing wants you" (§4.2's hollow
 * marker), and the marker has no third state to distinguish them with.
 */
export const blockAttentionCounts = <T extends AttentionThread>(
  rows: readonly AttentionRow<T>[]
): Map<string, BlockAttention> => {
  const counts = new Map<string, BlockAttention>();
  for (const row of rows) {
    const entry = counts.get(row.key) ?? { open: 0, resolved: 0 };
    if (row.thread.status === 'open') entry.open += 1;
    else entry.resolved += 1;
    counts.set(row.key, entry);
  }
  return counts;
};

/**
 * The toolbar's `N`: every open thread anchored anywhere on this page,
 * including whole-object threads with no block anchor and orphans whose block
 * is gone (§4.3, §8.2). Deliberately NOT the same quantity as `Pending N`,
 * which counts unpublished objects.
 */
export const pageAttentionTotal = <T extends AttentionThread>(rows: readonly AttentionRow<T>[]): number =>
  openThreadCount(rows.map((row) => row.thread));

/**
 * §4.2's marker states:
 * - `count`  — ≥1 open thread: a filled attention dot carrying the numeral.
 * - `muted`  — only resolved/dismissed threads: a hollow dot, on hover only.
 * - `accent` — no threads at all, but the block is hovered.
 * - `none`   — nothing to draw.
 */
export type MarkerState = 'count' | 'muted' | 'accent' | 'none';

export const gutterMarkerState = (input: { open: number; resolved: number; hovered: boolean }): MarkerState => {
  if (input.open > 0) return 'count';
  if (input.resolved > 0) return input.hovered ? 'muted' : 'none';
  return input.hovered ? 'accent' : 'none';
};

/**
 * The marker's accessible name. Colour is never the only carrier of "needs
 * attention" — the numeral is, and this is its spoken equivalent (§9).
 */
export const markerAriaLabel = (state: MarkerState, open: number, blockLabel: string): string => {
  if (state === 'count') return `${open} open comment${open === 1 ? '' : 's'} on ${blockLabel}`;
  if (state === 'muted') return `No open comments on ${blockLabel}`;
  return `Comment on ${blockLabel}`;
};
