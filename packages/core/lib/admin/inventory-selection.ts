/**
 * What a bulk selection SPANS — the missing half of `bulkActionsFor`
 * (`inventory-logic.ts`).
 *
 * WHY THIS MODULE EXISTS. `bulkActionsFor` intersects `allowedActions` across
 * every selected row, so a verb only ever appears when it is valid for all of
 * them. That rule is correct and stays exactly as it is. What it was missing
 * is a VOICE: a selection that spans more than one collection collapses to
 * `send-to-chat` (the only verb objects, artifacts and store blobs share),
 * and the shipped toolbar said nothing about why — it only had a message for
 * an EMPTY action set, which an owner/admin can never actually reach, since
 * `send-to-chat` survives every intersection. So the reported symptom ("I
 * selected several rows and Add tag / Remove tag were gone") had no
 * explanation on screen and no way out except un-picking rows by hand.
 *
 * This module answers both questions from the selection alone: what is in it,
 * and which single-collection subsets it could be narrowed to. It decides
 * nothing about permissions — a narrowed selection still goes back through
 * `bulkActionsFor`, which still intersects.
 *
 * Pure: no React, no I/O, no roles. `inventory-selection.test.ts` covers it.
 */
import { inventoryCollections, type InventoryCollection, type InventoryHit } from './inventory-server-logic.js';

/**
 * The plain-words name of each collection, for anything a human reads. Lives
 * here rather than in `InventoryPage.tsx` so the toolbar's sentence and the
 * facet chips cannot drift apart, and so the sentence itself is testable.
 */
export const INVENTORY_COLLECTION_LABELS: Record<InventoryCollection, string> = {
  objects: 'Objects',
  artifacts: 'Artifacts',
  stores: 'System stores',
};

export interface InventoryCollectionTally {
  collection: InventoryCollection;
  /** `INVENTORY_COLLECTION_LABELS[collection]`, carried so a renderer never re-derives it. */
  label: string;
  count: number;
}

/** One "narrow the selection to just this" affordance, derived from the selection itself. */
export interface InventoryNarrowingOption {
  collection: InventoryCollection;
  /** Button text, e.g. `Keep only Artifacts (5)`. */
  label: string;
  count: number;
  /** Exactly the selected ids in this collection — the new selection, in full. */
  ids: string[];
}

export interface InventorySelectionSpan {
  total: number;
  /** Non-empty collections, most-selected first, then in canonical collection order. */
  tallies: InventoryCollectionTally[];
  /** True when the selection covers two or more collections. */
  spansMultiple: boolean;
  /** Empty unless `spansMultiple` — there is nothing to narrow to otherwise. */
  narrowingOptions: InventoryNarrowingOption[];
  /** What is selected, in one sentence. `null` when the selection does not span. */
  headline: string | null;
  /** Why some verbs are missing, in one sentence. `null` when the selection does not span. */
  detail: string | null;
}

/** `['a', 'b', 'c']` → `'a, b and c'`. */
const joinWithAnd = (parts: readonly string[]): string => {
  if (parts.length <= 1) return parts[0] ?? '';
  return `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}`;
};

const plural = (count: number, singular: string, pluralForm: string): string =>
  count === 1 ? singular : pluralForm;

/**
 * Everything the bulk toolbar needs to explain itself.
 *
 * The counts and the narrowing options come from the SELECTION, never from
 * the loaded page or the server's facet totals: "Keep only Artifacts (5)"
 * has to mean the five artifacts this human actually ticked, or the button
 * would silently select rows they did not choose.
 */
export function describeInventorySelection(selection: readonly InventoryHit[]): InventorySelectionSpan {
  const idsByCollection = new Map<InventoryCollection, string[]>();
  for (const hit of selection) {
    const existing = idsByCollection.get(hit.collection);
    if (existing) existing.push(hit.id);
    else idsByCollection.set(hit.collection, [hit.id]);
  }

  const tallies: InventoryCollectionTally[] = inventoryCollections
    .filter((collection) => (idsByCollection.get(collection)?.length ?? 0) > 0)
    .map((collection) => ({
      collection,
      label: INVENTORY_COLLECTION_LABELS[collection],
      count: idsByCollection.get(collection)?.length ?? 0,
    }))
    // Biggest group first (the one a human most likely meant to act on),
    // canonical order as the tie-break so the row never reshuffles between
    // renders of the same selection.
    .sort((a, b) => b.count - a.count || inventoryCollections.indexOf(a.collection) - inventoryCollections.indexOf(b.collection));

  const total = selection.length;
  const spansMultiple = tallies.length > 1;

  if (!spansMultiple) {
    return { total, tallies, spansMultiple, narrowingOptions: [], headline: null, detail: null };
  }

  const narrowingOptions: InventoryNarrowingOption[] = tallies.map((tally) => ({
    collection: tally.collection,
    label: `Keep only ${tally.label} (${tally.count})`,
    count: tally.count,
    ids: [...(idsByCollection.get(tally.collection) ?? [])],
  }));

  const breakdown = joinWithAnd(tallies.map((tally) => `${tally.label} (${tally.count})`));

  return {
    total,
    tallies,
    spansMultiple,
    narrowingOptions,
    headline: `${total} ${plural(total, 'item', 'items')} selected, from ${tallies.length} different kinds of thing: ${breakdown}.`,
    // Deliberately names tagging: it is the verb the owner went looking for,
    // and "actions valid for every selected row" on its own is the sentence
    // that already failed to explain anything.
    detail:
      'These buttons only show actions that work on every selected item, so anything that belongs to just one kind — adding or removing an artifact tag, for example — stays hidden while the selection is mixed. Narrow it to one kind to get that kind’s own actions back.',
  };
}
