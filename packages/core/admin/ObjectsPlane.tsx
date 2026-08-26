/**
 * ObjectsPlane (T2.1, D1(a)) — the one library of governed objects that
 * replaces the separate Templates / Media / Content entry points
 * (`/admin/templates`, `/admin/studio`, `/admin/media`, `/admin/content`;
 * see netlify.toml's redirects into `/admin/objects`).
 *
 * Type facets come from `objectTypes` (schema/object-record-v1.ts) via
 * `OBJECT_TYPE_FACETS` — never a hand-maintained guess. Status renders
 * through D4 (`SeverityIcon`/`StatusBadge`, `objects-plane-logic.ts`'s
 * `statusFor`) — no new status vocabulary. Bulk archive is real end to end
 * (`bulk-object-ops.ts`: checkout → retire → checkin-on-failure); bulk
 * validate fans out the existing `object_validate` verb; bulk tag is
 * rendered disabled — no generic "tag any governed object" verb exists on
 * the MCP surface today (T0.1 §7).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { cn } from './utils';
import { Badge, Button, IconButton, Card, EmptyState, Skeleton } from './primitives';
import { Input, Select } from './forms';
import { DropdownMenu, type MenuItem } from './menus';
import { ConfirmDialog, useToast } from './overlays';
import { DataTable, type Column } from './data';
import { SeverityIcon, StatusBadge } from './severity';
import {
  IconLibrary,
  IconLayoutGrid,
  IconLayoutList,
  IconArchive,
  IconTag,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconRobot,
} from './icons';
import {
  OBJECT_TYPE_FACETS,
  OBJECT_SORT_OPTIONS,
  parseTypeFacetParam,
  typeFacetToParam,
  toggleTypeFacet,
  filterObjectRows,
  typeFacetCounts,
  sortObjectRows,
  paginateRows,
  statusFor,
  DEFAULT_PAGE_SIZE,
  type TypeFacetSelection,
  type ObjectSortKey,
  type SortDirection,
} from '@core/lib/admin/objects-plane-logic';
import {
  emptySelection,
  toggleSelection,
  selectAll,
  clearSelection,
  pruneSelection,
  selectionCount,
  isSelected,
  isAllSelected,
  isSomeSelected,
  toggleSelectAll,
  type SelectionState,
} from '@core/lib/admin/bulk-selection';
import { bulkArchiveObjects, bulkValidateObjects, type VerbCaller } from '@core/lib/admin/bulk-object-ops';
import { QuickActionChips } from './QuickActions';
import { objectTypeLabel, idTooltip } from '@core/lib/admin/display-name';
import { type LibraryRow } from '@core/lib/admin/library-logic';
import { type EditorialObjectState } from '@core/lib/admin/editorial-state';
import { fetchReleaseOverview, invalidateReleaseOverview } from '@core/lib/admin/release-client';
import { freshCachedInventoryRows, invalidateInventoryCache } from '@core/lib/admin/library-client';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import { relativeTimeFromNow } from './logic';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const VIEW_MODE_STORAGE_KEY = 'admin-objects-view-mode';

type ViewMode = 'table' | 'grid';

const readStoredViewMode = (): ViewMode | null => {
  try {
    const v = localStorage.getItem(VIEW_MODE_STORAGE_KEY);
    return v === 'table' || v === 'grid' ? v : null;
  } catch {
    return null;
  }
};

const writeStoredViewMode = (mode: ViewMode): void => {
  try {
    localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // private browsing / disabled storage — the toggle still works this page-load
  }
};

const detailHref = (row: LibraryRow): string =>
  `/admin/content/${encodeURIComponent(row.object_id)}?type=${encodeURIComponent(row.object_type)}`;

/** Reflects current facet/view state into the URL without a navigation — same idiom AgentsHub.tsx already uses. */
const syncUrl = (type: TypeFacetSelection, view: ViewMode): void => {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  const typeParam = typeFacetToParam(type);
  if (typeParam) params.set('type', typeParam);
  if (view !== 'table') params.set('view', view);
  const qs = params.toString();
  window.history.replaceState({}, '', qs ? `/admin/objects?${qs}` : '/admin/objects');
};

// ─── selection checkbox (native input, indeterminate set imperatively) ──────

function RowCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      onChange={onChange}
      aria-label={label}
      className="adm-focusable h-4 w-4 shrink-0 cursor-pointer rounded border-[var(--adm-border-strong)] text-[var(--adm-accent)]"
      onClick={(e) => e.stopPropagation()}
    />
  );
}

function OpenChatButton({ row, size = 'sm' as const }: { row: LibraryRow; size?: 'sm' }) {
  const { toast } = useToast();
  const [pending, setPending] = useState(false);
  const open = async () => {
    setPending(true);
    try {
      const { createObjectChat } = await import('@core/lib/admin/chat-client');
      const { chat } = await createObjectChat(getToken, row.object_type, row.object_id, row.display_name);
      await navigate(`/admin/agents?chat=${encodeURIComponent(chat.chat_id)}`);
    } catch (err) {
      toast({
        title: "Couldn't open chat",
        description: err instanceof Error ? err.message : undefined,
        tone: 'danger',
      });
    } finally {
      setPending(false);
    }
  };
  return (
    <IconButton
      label={`Open chat for ${row.display_name}`}
      icon={<IconRobot size={16} />}
      size={size}
      disabled={pending}
      onClick={(e) => {
        e.stopPropagation();
        void open();
      }}
    />
  );
}

// ─── status cell (D4 — the ONE place this renders) ──────────────────────────

function StatusCell({ row, states }: { row: LibraryRow; states: Record<string, EditorialObjectState> }) {
  const status = statusFor(row, states[row.object_id]);
  return <StatusBadge level={status.level}>{status.label}</StatusBadge>;
}

// ─── type facet chips ────────────────────────────────────────────────────────

function TypeFacetChips({
  rows,
  selection,
  onChange,
}: {
  rows: readonly LibraryRow[];
  selection: TypeFacetSelection;
  onChange: (next: TypeFacetSelection) => void;
}) {
  const counts = useMemo(() => typeFacetCounts(rows), [rows]);
  const presentTypes = OBJECT_TYPE_FACETS.filter((t) => (counts[t] ?? 0) > 0);
  return (
    <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Filter by object type">
      <button
        type="button"
        onClick={() => onChange('all')}
        aria-pressed={selection === 'all'}
        className={cn(
          'adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border px-3 py-1 text-[length:var(--adm-text-sm)] font-medium transition-colors',
          selection === 'all'
            ? 'border-transparent bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]'
            : 'border-[var(--adm-border-strong)] text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)]'
        )}
      >
        All
        <span className="text-[length:var(--adm-text-xs)] opacity-70">{rows.length}</span>
      </button>
      {presentTypes.map((type) => {
        const active = selection !== 'all' && selection.has(type);
        return (
          <button
            key={type}
            type="button"
            onClick={() => onChange(toggleTypeFacet(selection === 'all' ? new Set() : selection, type))}
            aria-pressed={active}
            className={cn(
              'adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] border px-3 py-1 text-[length:var(--adm-text-sm)] font-medium transition-colors',
              active
                ? 'border-transparent bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]'
                : 'border-[var(--adm-border-strong)] text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)]'
            )}
          >
            {objectTypeLabel(type)}
            <span className="text-[length:var(--adm-text-xs)] opacity-70">{counts[type] ?? 0}</span>
          </button>
        );
      })}
    </div>
  );
}

// ─── bulk toolbar ────────────────────────────────────────────────────────────

function BulkToolbar({
  count,
  onClear,
  onArchive,
  onValidate,
  busy,
}: {
  count: number;
  onClear: () => void;
  onArchive: () => void;
  onValidate: () => void;
  busy: boolean;
}) {
  const items: MenuItem[] = [
    {
      id: 'archive',
      label: 'Archive',
      icon: <IconArchive size={16} />,
      tone: 'danger',
      onSelect: onArchive,
    },
    {
      id: 'validate',
      label: 'Validate',
      icon: <IconCheck size={16} />,
      onSelect: onValidate,
    },
    {
      id: 'tag',
      label: 'Tag',
      icon: <IconTag size={16} />,
      disabled: true,
      title: 'No bulk tagging verb exists yet — taxonomy is set per object via patch, not as a governed bulk verb.',
    },
  ];
  return (
    <div className="flex items-center gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-3 py-2">
      <span className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">{count} selected</span>
      <DropdownMenu
        items={items}
        trigger={({ ref, onToggle, open }) => (
          <Button ref={ref} variant="secondary" size="sm" onClick={onToggle} aria-expanded={open} disabled={busy}>
            Bulk actions
            {open ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}
          </Button>
        )}
      />
      <button
        type="button"
        onClick={onClear}
        className="adm-focusable ml-auto rounded px-2 py-1 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
      >
        Clear
      </button>
    </div>
  );
}

// ─── the body ────────────────────────────────────────────────────────────────

function ObjectsPlaneBody({ roles }: { roles: readonly string[] }) {
  const { toast } = useToast();

  const [rows, setRows] = useState<LibraryRow[]>([]);
  const [states, setStates] = useState<Record<string, EditorialObjectState>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(0);

  const [typeFacet, setTypeFacet] = useState<TypeFacetSelection>('all');
  const [queryInput, setQueryInput] = useState('');
  const [query, setQuery] = useState(''); // debounced
  const [sortKey, setSortKey] = useState<ObjectSortKey>('updated_at');
  const [sortDir, setSortDir] = useState<SortDirection>('desc');
  const [view, setView] = useState<ViewMode>('table');
  const [page, setPage] = useState(1);
  const [selection, setSelection] = useState<SelectionState>(emptySelection());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [validateReport, setValidateReport] = useState<string | null>(null);

  // URL → initial facet/view (deep-linkable, and what the old-route redirects preselect).
  useEffect(() => {
    setNow(Date.now());
    const params = new URLSearchParams(window.location.search);
    setTypeFacet(parseTypeFacetParam(params.get('type')));
    const urlView = params.get('view');
    if (urlView === 'grid' || urlView === 'table') setView(urlView);
    else {
      const stored = readStoredViewMode();
      if (stored) setView(stored);
    }
  }, []);

  // Debounce search (perf-diagnosis F8's fix, applied here from the start).
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput), 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  // Data load — ONE Promise.all for inventory + release state (ContentLibrary
  // used to fire these as two independent effects; folded together here,
  // since this is the perf-diagnosis F2/R2 dedupe fix that lands "free"
  // while this surface is being rebuilt anyway).
  useEffect(() => {
    const cached = freshCachedInventoryRows();
    if (cached) {
      setRows(cached);
      setLoading(false);
      setRefreshing(true);
    }
    let alive = true;
    (async () => {
      try {
        const [{ fetchInventoryRows }, overview] = await Promise.all([
          import('@core/lib/admin/library-client'),
          fetchReleaseOverview(getToken).catch(() => undefined),
        ]);
        const freshRows = await fetchInventoryRows(getToken);
        if (!alive) return;
        setRows(freshRows);
        if (overview) setStates(Object.fromEntries(overview.objects.map((o) => [o.object_id, o.state])));
        setLoading(false);
        setRefreshing(false);
      } catch (err) {
        if (!alive) return;
        if (cached !== null) setRefreshing(false);
        else {
          setError(err instanceof Error ? err.message : 'Could not load objects.');
          setLoading(false);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const filtered = useMemo(() => filterObjectRows(rows, { type: typeFacet, query }), [rows, typeFacet, query]);
  const sorted = useMemo(
    () => sortObjectRows(filtered, sortKey, sortDir, states),
    [filtered, sortKey, sortDir, states]
  );
  const paged = useMemo(() => paginateRows(sorted, page, DEFAULT_PAGE_SIZE), [sorted, page]);

  useEffect(() => setPage(1), [typeFacet, query, sortKey, sortDir]);
  useEffect(() => {
    setSelection((s) =>
      pruneSelection(
        s,
        rows.map((r) => r.object_id)
      )
    );
  }, [rows]);
  useEffect(() => syncUrl(typeFacet, view), [typeFacet, view]);

  const setViewMode = (mode: ViewMode) => {
    setView(mode);
    writeStoredViewMode(mode);
  };

  const pageIds = paged.items.map((r) => r.object_id);
  const filteredIds = sorted.map((r) => r.object_id);
  const rowsById = useMemo(() => new Map(rows.map((r) => [r.object_id, r])), [rows]);

  const refresh = async () => {
    invalidateInventoryCache();
    invalidateReleaseOverview(); // T5.1 R2 — the same write moved release state
    void import('@core/lib/admin/editorial-view-client').then(({ invalidateEditorialView }) =>
      invalidateEditorialView()
    );
    const { fetchInventoryRows } = await import('@core/lib/admin/library-client');
    const [freshRows, overview] = await Promise.all([
      fetchInventoryRows(getToken, { force: true }),
      // T5.1 R2: an explicit refresh forces BOTH caches, matching the
      // inventory call beside it — a human pressed Refresh, or just wrote.
      fetchReleaseOverview(getToken, { force: true }).catch(() => undefined),
    ]);
    setRows(freshRows);
    if (overview) setStates(Object.fromEntries(overview.objects.map((o) => [o.object_id, o.state])));
  };

  const makeCallVerb = async (): Promise<VerbCaller> => {
    const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
    return (body) => callObjectVerb(getToken, body);
  };

  const selectedRows = [...selection.selected].map((id) => rowsById.get(id)).filter((r): r is LibraryRow => Boolean(r));

  const runArchive = async () => {
    setConfirmArchive(false);
    setBulkBusy(true);
    try {
      const callVerb = await makeCallVerb();
      const targets = selectedRows.map((r) => ({ object_id: r.object_id, object_type: r.object_type }));
      const summary = await bulkArchiveObjects(targets, callVerb);
      await refresh();
      setSelection((s) => {
        const next = new Set(s.selected);
        for (const id of summary.succeeded) next.delete(id);
        return { selected: next };
      });
      if (summary.failed.length === 0) {
        toast({
          title: `Archived ${summary.succeeded.length} object${summary.succeeded.length === 1 ? '' : 's'}.`,
          tone: 'success',
        });
      } else {
        toast({
          title: `Archived ${summary.succeeded.length} of ${targets.length}`,
          description: summary.failed
            .slice(0, 3)
            .map((f) => `${f.object_id}: ${f.error}`)
            .join(' · '),
          tone: summary.succeeded.length > 0 ? 'warning' : 'danger',
          duration: 8000,
        });
      }
    } catch (err) {
      toast({ title: 'Archive failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setBulkBusy(false);
    }
  };

  const runValidate = async () => {
    setBulkBusy(true);
    setValidateReport(null);
    try {
      const callVerb = await makeCallVerb();
      const targets = selectedRows.map((r) => ({ object_id: r.object_id, object_type: r.object_type }));
      const summary = await bulkValidateObjects(targets, callVerb);
      const parts = [
        summary.readyCount ? `${summary.readyCount} ready` : null,
        summary.warningCount ? `${summary.warningCount} with warnings` : null,
        summary.blockedCount ? `${summary.blockedCount} blocked` : null,
        summary.requestFailedCount ? `${summary.requestFailedCount} could not be checked` : null,
      ].filter(Boolean);
      const line = `Validated ${targets.length} object${targets.length === 1 ? '' : 's'} — ${parts.join(', ') || 'no issues found'}.`;
      setValidateReport(line);
      toast({
        title: line,
        tone: summary.blockedCount > 0 ? 'danger' : summary.warningCount > 0 ? 'warning' : 'success',
        duration: 6000,
      });
    } catch (err) {
      toast({ title: 'Validate failed', description: err instanceof Error ? err.message : undefined, tone: 'danger' });
    } finally {
      setBulkBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton variant="rect" height={40} width="60%" />
        <Skeleton variant="rect" height={40} width="30%" />
        <Skeleton variant="rect" height={320} />
      </div>
    );
  }

  if (error) {
    return (
      <Card>
        <EmptyState severity="error" title="Couldn't load objects" message={error} />
      </Card>
    );
  }

  const columns: Column<LibraryRow>[] = [
    {
      key: 'select',
      header: (
        <RowCheckbox
          checked={isAllSelected(selection, pageIds)}
          indeterminate={isSomeSelected(selection, pageIds)}
          onChange={() => setSelection((s) => toggleSelectAll(s, pageIds))}
          label="Select all rows on this page"
        />
      ),
      render: (r) => (
        <RowCheckbox
          checked={isSelected(selection, r.object_id)}
          onChange={() => setSelection((s) => toggleSelection(s, r.object_id))}
          label={`Select ${r.display_name}`}
        />
      ),
    },
    {
      key: 'display_name',
      header: 'Name',
      render: (r) => (
        <a href={detailHref(r)} className="adm-focusable group flex min-w-0 items-center gap-2 rounded">
          <span
            className="block truncate font-medium text-[var(--adm-text)] group-hover:text-[var(--adm-accent)]"
            title={idTooltip(r.object_id)}
          >
            {r.display_name}
          </span>
        </a>
      ),
    },
    { key: 'object_type', header: 'Type', render: (r) => <Badge>{objectTypeLabel(r.object_type)}</Badge> },
    { key: 'status', header: 'Status', render: (r) => <StatusCell row={r} states={states} /> },
    {
      key: 'updated_at',
      header: 'Updated',
      align: 'right',
      render: (r) => (
        <span className="text-[var(--adm-text-muted)]" title={r.updated_at}>
          {relativeTimeFromNow(r.updated_at, now) || '—'}
        </span>
      ),
    },
    {
      key: 'quick_actions',
      header: '',
      render: (r) => (
        <div className="flex items-center justify-end gap-1.5">
          <QuickActionChips row={r} roles={roles} onChanged={() => void refresh()} />
          <OpenChatButton row={r} />
        </div>
      ),
    },
  ];

  return (
    <div className="flex flex-col gap-4">
      {refreshing ? (
        <p
          className="flex items-center gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]"
          role="status"
          aria-live="polite"
        >
          <span className="inline-block animate-pulse">●</span> Refreshing…
        </p>
      ) : null}

      <TypeFacetChips rows={rows} selection={typeFacet} onChange={setTypeFacet} />

      <div className="flex flex-wrap items-center gap-2">
        <div className="max-w-sm flex-1">
          <Input
            placeholder="Search by name or id…"
            value={queryInput}
            onChange={(e) => setQueryInput(e.target.value)}
            aria-label="Search objects"
          />
        </div>
        <Select
          aria-label="Sort by"
          value={sortKey}
          onChange={(e) => setSortKey(e.target.value as ObjectSortKey)}
          options={OBJECT_SORT_OPTIONS.map((o) => ({ value: o.key, label: o.label }))}
          className="w-40"
        />
        <IconButton
          label={sortDir === 'asc' ? 'Sort ascending — click for descending' : 'Sort descending — click for ascending'}
          icon={sortDir === 'asc' ? <IconChevronUp size={16} /> : <IconChevronDown size={16} />}
          variant="secondary"
          onClick={() => setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))}
        />
        <div className="ml-auto flex items-center gap-1 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] p-0.5">
          <IconButton
            label="Table view"
            icon={<IconLayoutList size={16} />}
            variant={view === 'table' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'table'}
            onClick={() => setViewMode('table')}
          />
          <IconButton
            label="Grid view"
            icon={<IconLayoutGrid size={16} />}
            variant={view === 'grid' ? 'secondary' : 'ghost'}
            aria-pressed={view === 'grid'}
            onClick={() => setViewMode('grid')}
          />
        </div>
      </div>

      {selectionCount(selection) > 0 ? (
        <BulkToolbar
          count={selectionCount(selection)}
          onClear={() => setSelection(clearSelection())}
          onArchive={() => setConfirmArchive(true)}
          onValidate={() => void runValidate()}
          busy={bulkBusy}
        />
      ) : null}

      {validateReport ? (
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]" role="status" aria-live="polite">
          {validateReport}
        </p>
      ) : null}

      {sorted.length === 0 ? (
        <EmptyState
          icon={<IconLibrary size={26} />}
          title={rows.length === 0 ? 'No objects yet' : 'No matches'}
          message={rows.length === 0 ? 'Objects you create will appear here.' : 'Try a different type or search term.'}
        />
      ) : (
        <>
          <div className="flex items-center justify-between">
            <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {sorted.length} {sorted.length === 1 ? 'object' : 'objects'}
            </p>
            {isAllSelected(selection, pageIds) && filteredIds.length > pageIds.length ? (
              <button
                type="button"
                onClick={() => setSelection(selectAll(filteredIds))}
                className="adm-focusable rounded px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-accent)] hover:underline"
              >
                Select all {filteredIds.length} filtered
              </button>
            ) : null}
          </div>

          {view === 'table' ? (
            <DataTable columns={columns} rows={paged.items} getRowKey={(r) => r.object_id} />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {paged.items.map((r) => {
                const status = statusFor(r, states[r.object_id]);
                return (
                  <div
                    key={r.object_id}
                    className="flex flex-col gap-2 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-3"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <RowCheckbox
                        checked={isSelected(selection, r.object_id)}
                        onChange={() => setSelection((s) => toggleSelection(s, r.object_id))}
                        label={`Select ${r.display_name}`}
                      />
                      <SeverityIcon level={status.level} title={status.label} />
                    </div>
                    <div className="grid aspect-square place-items-center rounded-[var(--adm-radius-md)] bg-[var(--adm-surface-sunken)] text-[var(--adm-text-muted)]">
                      <IconLibrary size={28} />
                    </div>
                    <a href={detailHref(r)} className="adm-focusable min-w-0 rounded">
                      <p
                        className="truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:text-[var(--adm-accent)]"
                        title={idTooltip(r.object_id)}
                      >
                        {r.display_name}
                      </p>
                    </a>
                    <div className="flex items-center justify-between gap-1">
                      <Badge>{objectTypeLabel(r.object_type)}</Badge>
                      <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                        {relativeTimeFromNow(r.updated_at, now) || '—'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <QuickActionChips row={r} roles={roles} onChanged={() => void refresh()} />
                      <OpenChatButton row={r} />
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {paged.pageCount > 1 ? (
            <div className="flex items-center justify-center gap-3">
              <Button variant="secondary" size="sm" disabled={paged.page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                Page {paged.page} of {paged.pageCount}
              </span>
              <Button
                variant="secondary"
                size="sm"
                disabled={paged.page >= paged.pageCount}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          ) : null}
        </>
      )}

      <ConfirmDialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        onConfirm={() => void runArchive()}
        title={`Archive ${selectionCount(selection)} object${selectionCount(selection) === 1 ? '' : 's'}?`}
        message="Archived objects are removed from the live export on the next release and can be restored from Maintenance within the grace period. Anything still referenced or with an open review is skipped and reported."
        confirmLabel="Archive"
        tone="danger"
      />
    </div>
  );
}

export interface ObjectsPlaneProps {
  identity: SiteIdentity;
}

export default function ObjectsPlane({ identity }: ObjectsPlaneProps) {
  const { roles } = useCurrentUser();
  return (
    <AdminShell currentPath="/admin/objects" title="Objects" identity={identity} wide>
      <div className="flex flex-col gap-5">
        <header>
          <h1 className="text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">Objects</h1>
          <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            Every governed object — pages, templates, articles, media and the rest — in one library.
          </p>
        </header>
        <ObjectsPlaneBody roles={roles} />
      </div>
    </AdminShell>
  );
}
