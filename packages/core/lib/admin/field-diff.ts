/**
 * Field diff rendering for the generic objects surface (T1.5, surface 1).
 *
 * Deliberately NOT imported from `ai-suggestion.ts` — that file is the
 * article editor's diff overlay and is off-limits (non-goal: reuse the
 * pattern, don't touch the original). This module replicates the same
 * technique verbatim (word-level diff via `diffWords` for long prose,
 * side-by-side old/new for short fields, the same >80-char threshold and
 * visual language) generalized to any field name/value pair — article
 * nodes, section data, nav items, taxonomy terms, and site fields alike —
 * rather than only `ArticleBodyNode['public']`.
 *
 * Consumes a T0.6 `{kind:'fields', before, after}` capture directly: one
 * `renderFieldDiff` call per changed leaf. Pure DOM construction, no
 * network calls — Accept/Discard wiring lives in the page that mounts this.
 */
import { diffWords, type Change } from 'diff';
import type { HistoryEntry } from '../../schema/object-record-v1.js';

const PROSE_LENGTH_THRESHOLD = 80;

export function renderWordDiff(oldText: string, newText: string): HTMLElement {
  const container = document.createElement('div');
  container.className = 'dl-diff-word';

  const changes: Change[] = diffWords(oldText, newText);
  for (const change of changes) {
    if (change.added) {
      const ins = document.createElement('ins');
      // B9 (T0.3): "added" is diff semantics, not a D4 severity — normalized
      // to the `--adm-success-*` tokens (not a literal Tailwind color) so the
      // dark-mode swap comes from admin-tokens.css, not a hand-written
      // `dark:` pair, matching every other status color in the admin kit.
      ins.className =
        'dl-diff-ins bg-[var(--adm-success-soft)] text-[var(--adm-success-text)] rounded px-0.5 no-underline';
      ins.textContent = change.value;
      container.append(ins);
    } else if (change.removed) {
      const del = document.createElement('del');
      // B9 (T0.3): "removed" is diff semantics, not a D4 severity — same
      // token normalization as the `ins` branch above, using `--adm-danger-*`.
      del.className =
        'dl-diff-del bg-[var(--adm-danger-soft)] text-[var(--adm-danger-text)] rounded px-0.5 line-through';
      del.textContent = change.value;
      container.append(del);
    } else {
      container.append(document.createTextNode(change.value));
    }
  }
  return container;
}

/** A field counts as prose when either side is long enough that word-level diffing is more legible than a side-by-side swap. */
export const isProseField = (oldValue: string | undefined, newValue: string | undefined): boolean =>
  (oldValue ?? '').length > PROSE_LENGTH_THRESHOLD || (newValue ?? '').length > PROSE_LENGTH_THRESHOLD;

export function renderFieldDiff(
  fieldName: string,
  oldValue: string | undefined,
  newValue: string | undefined
): HTMLElement {
  const row = document.createElement('div');
  row.className = 'dl-diff-field flex flex-col gap-1 py-2 border-b border-[var(--adm-border)] last:border-0';

  const label = document.createElement('span');
  label.className = 'text-xs font-bold uppercase tracking-wide text-[var(--adm-text-muted)]';
  label.textContent = fieldName;
  row.append(label);

  if (isProseField(oldValue, newValue)) {
    row.append(renderWordDiff(oldValue ?? '', newValue ?? ''));
  } else {
    const pair = document.createElement('div');
    pair.className = 'flex gap-3 text-sm';

    if (oldValue !== undefined && oldValue !== '') {
      const oldEl = document.createElement('div');
      oldEl.className = 'flex-1 rounded p-2 bg-[var(--adm-danger-soft)] text-[var(--adm-danger-text)] line-through';
      oldEl.textContent = oldValue;
      pair.append(oldEl);
    }

    const newEl = document.createElement('div');
    newEl.className = 'flex-1 rounded p-2 bg-[var(--adm-success-soft)] text-[var(--adm-success-text)]';
    newEl.textContent = newValue ?? '';
    pair.append(newEl);

    row.append(pair);
  }

  return row;
}

/** Flattens a T0.6 `fields` capture's {before, after} trees into leaf-level string diffs, skipping unchanged and non-scalar leaves. */
export function fieldDiffLeaves(
  before: Record<string, unknown>,
  after: Record<string, unknown>
): Array<{ field: string; oldValue: string | undefined; newValue: string | undefined }> {
  const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
  const leaves: Array<{ field: string; oldValue: string | undefined; newValue: string | undefined }> = [];

  for (const field of fields) {
    const oldRaw = before[field];
    const newRaw = after[field];
    if (oldRaw !== null && typeof oldRaw === 'object') continue; // nested trees are rendered by their own recursive call
    if (newRaw !== null && typeof newRaw === 'object') continue;
    const oldValue = oldRaw === undefined || oldRaw === null ? undefined : String(oldRaw);
    const newValue = newRaw === undefined || newRaw === null ? undefined : String(newRaw);
    if (oldValue === newValue) continue;
    leaves.push({ field, oldValue, newValue });
  }
  return leaves;
}

export interface FieldDiffEntry {
  historyIndex: number;
  action: string;
  label: string;
  leaves: Array<{ field: string; oldValue: string | undefined; newValue: string | undefined }>;
}

/**
 * Walks a history slice (see `structural-diff.ts`'s `pendingHistory`) and
 * extracts the `kind: 'fields'` capture entries — the surface-1 (word/
 * side-by-side) diff counterpart to `computeStructuralDiff`. Pure data, no
 * DOM; the page renders each entry's `leaves` via `renderFieldDiff`.
 */
export function computeFieldDiffEntries(history: readonly HistoryEntry[]): FieldDiffEntry[] {
  const entries: FieldDiffEntry[] = [];

  history.forEach((historyEntry, historyIndex) => {
    const details = historyEntry.details as
      | { capture?: { kind?: string; before?: unknown; after?: unknown } }
      | undefined;
    const capture = details?.capture;
    if (!capture || capture.kind !== 'fields') return;
    const leaves = fieldDiffLeaves(
      (capture.before ?? {}) as Record<string, unknown>,
      (capture.after ?? {}) as Record<string, unknown>
    );
    if (leaves.length === 0) return;
    entries.push({ historyIndex, action: historyEntry.action, label: historyEntry.action, leaves });
  });

  return entries;
}
