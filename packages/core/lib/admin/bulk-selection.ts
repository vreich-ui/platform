/**
 * Bulk-selection state (T2.1) — pure reducer over a `Set<string>` of selected
 * object ids. No framework, no network; the objects plane's row checkboxes
 * and the header "select all" checkbox are both thin wrappers over this.
 */
export interface SelectionState {
  selected: ReadonlySet<string>;
}

export function emptySelection(): SelectionState {
  return { selected: new Set() };
}

export function toggleSelection(state: SelectionState, id: string): SelectionState {
  const next = new Set(state.selected);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  return { selected: next };
}

/** Selects exactly the given ids (the current page/filtered set) — replaces, does not merge. */
export function selectAll(ids: readonly string[]): SelectionState {
  return { selected: new Set(ids) };
}

export function clearSelection(): SelectionState {
  return emptySelection();
}

/** Drops any selected id no longer present in `ids` — call after a filter/search/page change. */
export function pruneSelection(state: SelectionState, ids: readonly string[]): SelectionState {
  const valid = new Set(ids);
  const next = new Set([...state.selected].filter((id) => valid.has(id)));
  return next.size === state.selected.size ? state : { selected: next };
}

export function selectionCount(state: SelectionState): number {
  return state.selected.size;
}

export function isSelected(state: SelectionState, id: string): boolean {
  return state.selected.has(id);
}

/** True only when every one of `ids` (a non-empty set) is selected. */
export function isAllSelected(state: SelectionState, ids: readonly string[]): boolean {
  return ids.length > 0 && ids.every((id) => state.selected.has(id));
}

/** True when some but not all of `ids` are selected — the header checkbox's indeterminate state. */
export function isSomeSelected(state: SelectionState, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  const selectedCount = ids.filter((id) => state.selected.has(id)).length;
  return selectedCount > 0 && selectedCount < ids.length;
}

/** Header-checkbox toggle: select all of `ids` unless they're all already selected, then clear. */
export function toggleSelectAll(state: SelectionState, ids: readonly string[]): SelectionState {
  return isAllSelected(state, ids) ? clearSelection() : selectAll(ids);
}
