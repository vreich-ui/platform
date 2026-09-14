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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { cn } from './utils';
import { Badge, Button, IconButton, Card, EmptyState, RefreshingChip, Skeleton } from './primitives';
import { Input, Select } from './forms';
import { DropdownMenu, type MenuItem } from './menus';
import { ConfirmDialog, Drawer, useToast } from './overlays';
import { AgentRail, useAgentDock } from './AgentRail';
import { useChat, type UseChatState } from './chat';
import { createObjectChat, sendChatMessage } from '@core/lib/admin/chat-client';
import { parseFocus, type ObjectSelection } from '@core/lib/admin/object-selection';
import { WORKSPACE_EXPANDED_MIN_WIDTH } from '@core/lib/admin/responsive-workspace';
import {
  dockAddress,
  dockChatIntent,
  dockFocusLabel,
  dockLayout,
  dockPreferenceScope,
  rememberDockChat,
  type DockChatCache,
} from '@core/lib/admin/universal-dock';
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
  IconSparkles,
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
import { ObjectActionMenu, ObjectActionStrip } from './ObjectActionStrip';
import type { ControlsActionSurface } from './ControlsCard';
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

/** A row as the pair the dock (and, through it, the wire) binds to. */
const selectionForRow = (row: LibraryRow): ObjectSelection => ({
  object_type: row.object_type,
  object_id: row.object_id,
});

const detailHref = (row: LibraryRow): string =>
  `/admin/content/${encodeURIComponent(row.object_id)}?type=${encodeURIComponent(row.object_type)}`;

/**
 * Reflects current facet/view state into the URL without a navigation — same
 * idiom AgentsHub.tsx already uses.
 *
 * ASV2-W2.2: this REBUILDS the address from scratch, so the dock's `?focus=`
 * has to be re-applied to the result or every facet click would silently
 * unbind the dock. `dockAddress` is that re-application, and it is symmetric:
 * the selection survives a filter change, and the filters survive a selection
 * change (`withFocus` keeps every other parameter).
 */
const syncUrl = (type: TypeFacetSelection, view: ViewMode, selection?: ObjectSelection): void => {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams();
  const typeParam = typeFacetToParam(type);
  if (typeParam) params.set('type', typeParam);
  if (view !== 'table') params.set('view', view);
  const qs = params.toString();
  window.history.replaceState({}, '', dockAddress(qs ? `/admin/objects?${qs}` : '/admin/objects', selection));
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

/**
 * ASV2-W2.2 — the row's agent gesture is a SELECTION now, not a navigation.
 *
 * It used to `createObjectChat` on the click and navigate to `/admin/agents`.
 * Both halves are wrong under this wave: the click MINTED A CHAT DOC for
 * every row anyone was ever curious about (a click never mints — see
 * `universal-dock.ts`), and it took the editor off the library to talk about
 * a row they were still comparing with its neighbours. The dock does the same
 * job in place, and binds only when they actually send something. Nothing
 * became unreachable: the object's own detail page still docks a rail, and
 * `/admin/agents` still lists every conversation there is.
 */
function SelectForDockButton({
  row,
  selected,
  onSelect,
  size = 'sm' as const,
}: {
  row: LibraryRow;
  selected: boolean;
  onSelect: (row: LibraryRow) => void;
  size?: 'sm';
}) {
  return (
    <IconButton
      label={selected ? `${row.display_name} is in the agent dock` : `Ask the agent about ${row.display_name}`}
      icon={<IconRobot size={16} />}
      size={size}
      variant={selected ? 'secondary' : 'ghost'}
      aria-pressed={selected}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(row);
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

  // ─── ASV2-W2.2: the universal dock ────────────────────────────────────────
  // `selection` above is the BULK checkbox set; this is the single row the
  // agent dock is bound to. Different facts, deliberately different names.
  const [focused, setFocused] = useState<ObjectSelection | undefined>(undefined);
  /**
   * Selection key → the chat this selection has already been bound to. Held
   * as state AND in a ref: `send` below is called from a callback that must
   * read the newest cache in the same tick it may have written it.
   */
  const [chatCache, setChatCache] = useState<DockChatCache>({});
  const chatCacheRef = useRef<DockChatCache>({});
  chatCacheRef.current = chatCache;
  /**
   * `undefined` until the editor SENDS. This is the whole no-request-on-click
   * proof: `useChat` polls only when it holds an id, and nothing sets this on
   * a selection — not even when a chat for that selection is already cached,
   * because attaching would still be a poll the click did not ask for.
   */
  const [dockChatId, setDockChatId] = useState<string | undefined>(undefined);
  /**
   * ASV2-W3.2 — the composer's draft, for a hand-off taken from the strip or
   * from a row's `⋯`. Seeding a DRAFT is not sending: nothing is posted and
   * no chat doc is minted until the editor presses send, which is the same
   * promise `dockChatIntent('select', …)` makes about clicking a row.
   */
  const [dockSeed, setDockSeed] = useState<{ key: string; text: string } | undefined>(undefined);
  const [dockBusy, setDockBusy] = useState(false);
  const [dockError, setDockError] = useState<string | undefined>(undefined);
  const [dockDrawerOpen, setDockDrawerOpen] = useState(false);
  const [expandedWorkspace, setExpandedWorkspace] = useState(false);
  const [contentWidthPx, setContentWidthPx] = useState(0);
  const contentRef = useRef<HTMLDivElement>(null);
  const dockChat = useChat(getToken, dockChatId);
  const viewer = useCurrentUser().user?.email;
  /** Whether a row is the one in the dock. Cheaper than a key round trip per row per render. */
  const isFocusedRow = (row: LibraryRow): boolean =>
    focused?.object_id === row.object_id && focused.object_type === row.object_type;
  /**
   * ASV2-W5 (review): matched on the PAIR, not on the id alone. An object key
   * in this repo is `{object_type, object_id}` — that is the whole reason the
   * address format is `?focus=<type>:<id>` — so two rows of different types
   * may share an id, and an id-only lookup could hand the strip a DIFFERENT
   * row than the one the dock is bound to. `runQuickAction` reads
   * `row.object_type`/`row.object_id` straight off it, so that would have run
   * a verb against the wrong object. Same comparison as `isFocusedRow`.
   */
  const focusedRow = focused ? rows.find((r) => isFocusedRow(r)) : undefined;
  /**
   * TWO scopes, because they are two facts. The rail's own per-chat
   * preferences (run mode, test mode, thread state) are per OBJECT — the
   * shape `ObjectWorkspace.tsx` already uses. Whether the dock is a spine is
   * a property of this SURFACE, not of the object in it: scoping it per
   * object would re-open a dock the editor deliberately collapsed every time
   * they clicked a different row.
   */
  const preferenceScope = dockPreferenceScope('objects', viewer, focused);
  const dock = useAgentDock(focused, dockPreferenceScope('objects', viewer));

  // URL → initial facet/view (deep-linkable, and what the old-route redirects preselect).
  useEffect(() => {
    setNow(Date.now());
    const params = new URLSearchParams(window.location.search);
    setTypeFacet(parseTypeFacetParam(params.get('type')));
    // W2.2: the address restores the dock's binding. `parseFocus` reads an
    // unpaired or over-long value as NO selection, so a hand-edited URL opens
    // an empty dock rather than sending a malformed pair (Constraint 7).
    setFocused(parseFocus(window.location.search));
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
  useEffect(() => syncUrl(typeFacet, view, focused), [typeFacet, view, focused]);

  // ─── ASV2-W2.2/W2.3: the dock's own effects and handlers ─────────────────

  /**
   * W2.3: the SAME viewport contract `ObjectWorkspace.tsx` gates its dock on,
   * and the same mutual exclusion — the inline dock and the overlay `Drawer`
   * are never both mounted, because the rail owns approval effects and two
   * of it on one surface would double-submit them. This is only HALF the
   * gate; see `dockLayout`.
   */
  useEffect(() => {
    const media = window.matchMedia(`(min-width: ${WORKSPACE_EXPANDED_MIN_WIDTH}px)`);
    const sync = () => setExpandedWorkspace(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, []);

  /**
   * The other half: the dock's promise is about CONTENT width, which no
   * viewport media query can see (the admin shell's `xl` sidebar and padding
   * come out of it first). Re-attached when the skeleton is replaced by the
   * real tree, since the measured element only exists then.
   */
  useEffect(() => {
    const element = contentRef.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (typeof width === 'number') setContentWidthPx(width);
    });
    observer.observe(element);
    setContentWidthPx(element.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, [loading, error]);

  const layout = dockLayout({ expandedWorkspace, contentWidthPx });

  /**
   * The mutual exclusion, keyed on the LAYOUT rather than the breakpoint: in
   * the 1280–1298 band the breakpoint matches while the dock is still a
   * Drawer, and closing it there would shut the agent on a viewer who has no
   * other way in.
   */
  useEffect(() => {
    if (layout === 'beside') setDockDrawerOpen(false);
  }, [layout]);

  const clearFocus = useCallback((next?: ObjectSelection) => {
    setFocused(next);
    // A different object is a different conversation: stop polling the old
    // one rather than showing its transcript under the new object's name.
    setDockChatId(undefined);
    setDockError(undefined);
  }, []);

  /**
   * The row gesture. `dockChatIntent('select', …)` is `idle` by construction,
   * so this issues NO request and mints NO chat doc — it moves local state
   * and rewrites the address, nothing else.
   */
  const selectRow = useCallback(
    (row: LibraryRow) => {
      const first = !focused;
      clearFocus(selectionForRow(row));
      // "Opens on the first selection" — in the narrow arrangement the dock
      // has no spine to open, so the overlay is what opens. Only the FIRST
      // time: an overlay that reappeared over the list on every later row
      // click would fight an editor who is still comparing rows.
      if (first && layout === 'drawer') setDockDrawerOpen(true);
    },
    [clearFocus, focused, layout]
  );

  /**
   * The LAZY binding. `createObjectChat` is reached from here and nowhere
   * else on this surface, and this runs on a SEND. The paired
   * `object_type`/`object_id` go up with `create_chat kind:'object'`, which
   * is what puts the pair on every later turn's `CmsAgentContext`
   * (engine.ts Constraint 7).
   */
  const sendFromDock = useCallback(
    async (text: string, sendFocus?: string, testMode?: boolean) => {
      const intent = dockChatIntent('send', focused, chatCacheRef.current);
      if (intent.kind === 'idle') return;
      // Already attached and polling: let `useChat` own the send, so its
      // busy flag and its immediate re-poll behave exactly as everywhere else.
      if (intent.kind === 'attach' && intent.chatId === dockChatId) {
        await dockChat.send(text, sendFocus, testMode);
        return;
      }
      setDockBusy(true);
      setDockError(undefined);
      try {
        let chatId: string;
        if (intent.kind === 'attach') {
          chatId = intent.chatId;
        } else {
          const bound = intent.selection;
          const created = await createObjectChat(
            getToken,
            bound.object_type,
            bound.object_id,
            focusedRow?.display_name
          );
          chatId = created.chat.chat_id;
          setChatCache((cache) => rememberDockChat(cache, bound, created.chat.chat_id));
        }
        await sendChatMessage(getToken, chatId, text, sendFocus, testMode);
        // Only now does anything start polling.
        setDockChatId(chatId);
      } catch (reason) {
        setDockError(reason instanceof Error ? reason.message : 'The message could not be sent.');
      } finally {
        setDockBusy(false);
      }
    },
    [dockChat, dockChatId, focused, focusedRow?.display_name]
  );

  const dockChatState: UseChatState = useMemo(
    () => ({
      ...dockChat,
      busy: dockChat.busy || dockBusy,
      error: dockError ?? dockChat.error,
      send: sendFromDock,
    }),
    [dockChat, dockBusy, dockError, sendFromDock]
  );

  /**
   * ASV2-W3.3 — does a conversation for the focused object ALREADY exist?
   *
   * Asked through W2's own decision rather than re-derived: `attach` means a
   * chat is known for this selection, `mint` means sending would CREATE one.
   * The trace may only ever ride an `attach` — `sendFromDock` is the LAZY
   * BINDING, so a trace fired at an unbound object would mint a chat doc as a
   * side effect of clicking Validate, which is the exact thing the dock was
   * built not to do. `actionTraceDelivery` owns what happens instead.
   */
  const dockChatBound = dockChatIntent('send', focused, chatCache).kind === 'attach';

  /**
   * A hand-off taken from a ROW's menu belongs to that row, not to whatever
   * the dock happens to be showing — so it binds the dock first and then
   * seeds the draft. Still no request: `selectRow` is `idle` by construction
   * and a draft is not a send.
   */
  const seedFromRow = useCallback(
    (row: LibraryRow, prompt: string) => {
      selectRow(row);
      setDockSeed({ key: `strip-${row.object_id}-${Date.now()}`, text: prompt });
    },
    [selectRow]
  );

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
          <ObjectActionMenu
            row={r}
            roles={roles}
            onSeedComposer={(prompt) => seedFromRow(r, prompt)}
            onChanged={() => void refresh()}
          />
          <SelectForDockButton row={r} selected={isFocusedRow(r)} onSelect={selectRow} />
        </div>
      ),
    },
  ];

  /**
   * ONE `AgentRail` element, placed EITHER in the column or in the Drawer —
   * never both. The rail mounts approval effects, so two of it on one surface
   * would auto-approve the same call twice; `ObjectWorkspace.tsx`'s own
   * comment says the same thing about the same pair.
   */
  // W3.2/W4.2 — one bundle, two affordances: the strip beside the composer and
  // any `actions` card the agent puts in the transcript.
  const actionSurface: ControlsActionSurface | undefined = focusedRow
    ? {
        row: focusedRow,
        roles,
        onSeedComposer: (prompt) => setDockSeed({ key: `strip-${Date.now()}`, text: prompt }),
        trace: { bound: dockChatBound, send: (text) => sendFromDock(text) },
        onChanged: () => void refresh(),
      }
    : undefined;

  const agentRail = (
    <AgentRail
      chat={dockChatState}
      focus={dockFocusLabel(focused, focusedRow?.display_name)}
      preferenceScope={preferenceScope}
      selection={focused}
      {...(focusedRow ? { selectionTitle: focusedRow.display_name } : {})}
      onSelectionChange={clearFocus}
      {...(dockSeed ? { draftSeed: dockSeed } : {})}
      {...(actionSurface
        ? {
            // W3.2 — the strip sits beside the composer, so the verb and the
            // conversation about it are the same gesture. No `exclude`: this
            // surface has no controls of its own for these actions.
            aboveComposer: <ObjectActionStrip {...actionSurface} />,
            // W4.2 — the same bundle as data, so an §6.1 `actions` card in the
            // transcript runs through that one executor rather than a second.
            controlsActionSurface: actionSurface,
          }
        : {})}
      isOwner={roles.includes('owner')}
      canUseTestMode={roles.includes('owner')}
      collapsed={layout === 'beside' && dock.collapsed}
      {...(layout === 'beside' ? { onToggleCollapsed: dock.toggle } : {})}
    />
  );

  return (
    <div ref={contentRef} className="grid min-h-0 gap-5 lg:grid-cols-[minmax(0,1fr)_auto]">
      <div className="flex min-w-0 flex-col gap-4">
        <RefreshingChip active={refreshing} />

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
            label={
              sortDir === 'asc' ? 'Sort ascending — click for descending' : 'Sort descending — click for ascending'
            }
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
          {/* W2.3: the narrow arrangement's way into the dock — the same
            compact button `ObjectWorkspace.tsx` puts in its header. */}
          {layout === 'drawer' ? (
            <Button
              size="sm"
              variant="secondary"
              leftIcon={<IconSparkles size={16} />}
              onClick={() => setDockDrawerOpen(true)}
            >
              Agent
            </Button>
          ) : null}
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
            message={
              rows.length === 0 ? 'Objects you create will appear here.' : 'Try a different type or search term.'
            }
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
                        <ObjectActionMenu
                          row={r}
                          roles={roles}
                          onSeedComposer={(prompt) => seedFromRow(r, prompt)}
                          onChanged={() => void refresh()}
                        />
                        <SelectForDockButton row={r} selected={isFocusedRow(r)} onSelect={selectRow} />
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

      {/* The dock: sticky while the list scrolls. `_auto` on the grid track so
          a collapsed dock shrinks to its spine instead of leaving a blank
          24rem gutter. `w-[24rem]` / `w-12` are the literals for
          `AGENT_SURFACE_LAYOUT.dockPx` (384) and DOCK_SPINE_PX (48) —
          Tailwind's scanner needs them written out. */}
      {layout === 'beside' ? (
        <div
          className={cn('sticky top-4 self-start', dock.collapsed ? 'w-12' : 'w-[24rem]')}
          aria-label="Contextual agent dock"
        >
          {agentRail}
        </div>
      ) : (
        /* W2.3: the EXISTING narrow-screen path, not a second one — the same
           kit `Drawer` at the same width `ObjectWorkspace.tsx` uses. */
        <Drawer open={dockDrawerOpen} onClose={() => setDockDrawerOpen(false)} title="Publishing Agent" width={480}>
          {dockDrawerOpen ? agentRail : null}
        </Drawer>
      )}
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
