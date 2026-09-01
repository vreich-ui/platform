/**
 * Admin kit — data display (T9.2): DataTable, DiffView, ReadinessList,
 * LockBanner, HistoryTimeline.
 *
 * DiffView wraps the existing DOM renderer in src/lib/admin/field-diff.ts
 * (mounted via ref in an effect). ReadinessList renders the existing
 * `ReadinessCriterion[]` shape verbatim. HistoryTimeline phrases entries with
 * the display-name module — no raw ids or verbs on screen.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from './utils';
import { sortRows, statusTone, relativeTimeFromNow, type SortDirection, type Tone } from './logic';
import {
  IconCheck,
  IconX,
  IconInfo,
  IconAlertTriangle,
  IconChevronUp,
  IconChevronDown,
  IconSelector,
  IconLock,
} from './icons';
import { Avatar, EmptyState } from './primitives';
import { renderFieldDiff } from '@core/lib/admin/field-diff';
import type { ReadinessGroup, ReadinessCriterion, CriterionStatus } from '@core/lib/admin/readiness-criteria';
import type { HistoryEntry } from '@core/schema/object-record-v1';
import { verbToPhrase, principalName } from '@core/lib/admin/display-name';

// ─── DataTable ────────────────────────────────────────────────────────────────

export interface Column<T> {
  key: string;
  header: ReactNode;
  sortable?: boolean;
  align?: 'left' | 'right';
  accessor?: (row: T) => unknown;
  render?: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  getRowKey: (row: T, index: number) => string;
  initialSort?: { key: string; dir: SortDirection };
  emptyState?: ReactNode;
  className?: string;
}

export function DataTable<T>({ columns, rows, getRowKey, initialSort, emptyState, className }: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDirection } | null>(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col) return rows;
    const accessor = col.accessor ?? ((row: T) => (row as Record<string, unknown>)[col.key]);
    return sortRows(rows, accessor, sort.dir);
  }, [rows, sort, columns]);

  const toggleSort = (key: string) => {
    setSort((prev) => {
      if (prev?.key !== key) return { key, dir: 'asc' };
      if (prev.dir === 'asc') return { key, dir: 'desc' };
      return null; // third click clears
    });
  };

  if (rows.length === 0) {
    return <>{emptyState ?? <EmptyState title="Nothing here yet" message="Items will appear here once created." />}</>;
  }

  return (
    <div className={cn('overflow-x-auto rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)]', className)}>
      <table className="w-full border-collapse text-[length:var(--adm-text-sm)]">
        <thead>
          <tr className="border-b border-[var(--adm-border)] bg-[var(--adm-surface-sunken)]">
            {columns.map((col) => {
              const isSorted = sort?.key === col.key;
              const ariaSort = !col.sortable
                ? undefined
                : isSorted
                  ? sort!.dir === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none';
              return (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={ariaSort}
                  className={cn(
                    'px-3 py-2 font-semibold text-[var(--adm-text-muted)]',
                    col.align === 'right' ? 'text-right' : 'text-left'
                  )}
                >
                  {col.sortable ? (
                    <button
                      type="button"
                      onClick={() => toggleSort(col.key)}
                      className={cn(
                        'adm-focusable inline-flex items-center gap-1 rounded hover:text-[var(--adm-text)]',
                        col.align === 'right' ? 'flex-row-reverse' : ''
                      )}
                    >
                      {col.header}
                      {isSorted ? (
                        sort!.dir === 'asc' ? (
                          <IconChevronUp size={14} />
                        ) : (
                          <IconChevronDown size={14} />
                        )
                      ) : (
                        <IconSelector size={14} className="opacity-50" />
                      )}
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, index) => (
            <tr
              key={getRowKey(row, index)}
              className="border-b border-[var(--adm-border)] last:border-0 hover:bg-[var(--adm-surface-sunken)]"
            >
              {columns.map((col) => {
                const accessor = col.accessor ?? ((r: T) => (r as Record<string, unknown>)[col.key]);
                return (
                  <td
                    key={col.key}
                    className={cn(
                      'px-3 py-2 text-[var(--adm-text)]',
                      col.align === 'right' ? 'text-right' : 'text-left'
                    )}
                  >
                    {col.render ? col.render(row) : String(accessor(row) ?? '')}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── DiffView ─────────────────────────────────────────────────────────────────

export interface DiffEntry {
  field: string;
  before?: string;
  after?: string;
}

export function DiffView({ entries, className }: { entries: DiffEntry[]; className?: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    node.replaceChildren();
    for (const entry of entries) {
      node.append(renderFieldDiff(entry.field, entry.before, entry.after));
    }
  }, [entries]);
  return <div ref={host} className={cn('flex flex-col gap-3 text-[length:var(--adm-text-sm)]', className)} />;
}

// ─── ReadinessList ────────────────────────────────────────────────────────────

/**
 * Exhaustive over CriterionStatus — a new tier without an icon here is a
 * compile error, which is the point. `info` (W6 D4) shares `optional`'s icon
 * and neutral tone deliberately: both say "nothing to do", and giving `info`
 * its own glyph would make a statement of fact look like a distinct thing to
 * act on. See `readiness-criteria.ts` for what separates the tiers.
 *
 * This file is OUTSIDE the node test stack (tsconfig.test.json excludes
 * packages/core/admin/**\/*.tsx), so `npm test` cannot see a gap here — only
 * `astro check` can. tests/scripts/readiness-status-coverage.test.mjs is the
 * cheap guard that fails in the normal suite instead.
 */
const STATUS_ICON: Record<CriterionStatus, ReactNode> = {
  complete: <IconCheck size={16} />,
  warning: <IconAlertTriangle size={16} />,
  missing: <IconX size={16} />,
  optional: <IconInfo size={16} />,
  info: <IconInfo size={16} />,
};

const TONE_TEXT: Record<Tone, string> = {
  neutral: 'text-[var(--adm-text-muted)]',
  accent: 'text-[var(--adm-accent)]',
  success: 'text-[var(--adm-success)]',
  warning: 'text-[var(--adm-warning)]',
  danger: 'text-[var(--adm-danger)]',
  info: 'text-[var(--adm-info)]',
};

function Criterion({ criterion }: { criterion: ReadinessCriterion }) {
  const tone = statusTone(criterion.status);
  return (
    <li className="flex items-start gap-2 py-1.5">
      <span className={cn('mt-0.5 shrink-0', TONE_TEXT[tone])}>{STATUS_ICON[criterion.status]}</span>
      <div className="min-w-0">
        <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">{criterion.label}</p>
        <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{criterion.message}</p>
      </div>
    </li>
  );
}

export function ReadinessList({
  groups,
  criteria,
  className,
}: {
  groups?: ReadinessGroup[];
  criteria?: ReadinessCriterion[];
  className?: string;
}) {
  if (criteria && !groups) {
    return (
      <ul className={cn('flex flex-col', className)}>
        {criteria.map((c) => (
          <Criterion key={c.id} criterion={c} />
        ))}
      </ul>
    );
  }
  return (
    <div className={cn('flex flex-col gap-4', className)}>
      {(groups ?? []).map((group) => (
        <div key={group.id}>
          <p className="mb-1 text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
            {group.label}
          </p>
          <ul className="flex flex-col">
            {group.criteria.map((c) => (
              <Criterion key={c.id} criterion={c} />
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

// ─── LockBanner ───────────────────────────────────────────────────────────────

export interface LockBannerProps {
  /** Display name of the lock holder (never a raw id). */
  holder: string;
  since?: string;
  now?: number;
  isOwnLock?: boolean;
  onRefresh?: () => void;
  onForceRelease?: () => void;
  className?: string;
}

export function LockBanner({ holder, since, now, isOwnLock, onRefresh, onForceRelease, className }: LockBannerProps) {
  const [tick, setTick] = useState<number | null>(now ?? null);
  useEffect(() => {
    if (now === undefined) setTick(Date.now());
  }, [now]);
  const rel = since && tick != null ? relativeTimeFromNow(since, tick) : '';

  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-4 py-3',
        className
      )}
    >
      <IconLock size={18} className="text-[var(--adm-warning-text)]" />
      <p className="flex-1 text-[length:var(--adm-text-sm)] text-[var(--adm-warning-text)]">
        {isOwnLock ? 'You hold the edit lock' : `Checked out by ${holder}`}
        {rel ? <span className="opacity-80"> · {rel}</span> : null}
      </p>
      {onRefresh ? (
        <button
          type="button"
          onClick={onRefresh}
          className="adm-focusable rounded-[var(--adm-radius-sm)] px-2 py-1 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-warning-text)] underline"
        >
          Refresh lock
        </button>
      ) : null}
      {onForceRelease ? (
        <button
          type="button"
          onClick={onForceRelease}
          className="adm-focusable rounded-[var(--adm-radius-sm)] px-2 py-1 text-[length:var(--adm-text-xs)] font-semibold text-[var(--adm-danger)] underline"
        >
          Force release
        </button>
      ) : null}
    </div>
  );
}

// ─── HistoryTimeline ──────────────────────────────────────────────────────────

export function HistoryTimeline({
  entries,
  now,
  className,
}: {
  entries: HistoryEntry[];
  now?: number;
  className?: string;
}) {
  const [tick, setTick] = useState<number | null>(now ?? null);
  useEffect(() => {
    if (now === undefined) setTick(Date.now());
  }, [now]);

  if (entries.length === 0) {
    return (
      <p className={cn('text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]', className)}>No history yet.</p>
    );
  }

  return (
    <ol className={cn('flex flex-col', className)}>
      {entries.map((entry, index) => {
        const rel = tick != null ? relativeTimeFromNow(entry.at, tick) : new Date(entry.at).toLocaleDateString();
        return (
          <li key={`${entry.at}-${index}`} className="flex gap-3 pb-4 last:pb-0">
            <div className="flex flex-col items-center">
              <Avatar name={principalName(entry.actor)} size={28} />
              {index < entries.length - 1 ? <span className="mt-1 w-px flex-1 bg-[var(--adm-border)]" /> : null}
            </div>
            <div className="min-w-0 pt-0.5">
              <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{verbToPhrase(entry)}</p>
              <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{rel}</p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
