/**
 * `/admin/requests` (W19 T19.4, D1(b) T2.3) — the runs inbox.
 *
 * There is no standalone chat list in this admin: every agent run and every
 * conversation must be findable here. A row is a REQUEST, not a chat: the
 * editorial job survives the conversation that started it, and a job that
 * stalled at node 19 shows here whether or not anyone still has its chat
 * open. The inbox opens on "Needs you" — what is waiting for the operator —
 * not on everything; the other quick filters and the Kind/Search filters
 * stay one click away.
 *
 * Poll chains (T2.3, T0.2 F7): the shell's header pills and this page's
 * default view now share ONE poll chain (`lib/admin/requests-store.ts`)
 * instead of the two independent ones T0.2 found hitting the same endpoint.
 * `mine`/`archived`/a live search address a different or larger universe
 * than that shared cache, so those three run their own light, visibility-
 * backed-off chain while active — see `RequestsBody`'s own comment.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { RequestActivity } from './RequestActivity';
import { ActionRow, RunProgress } from './approval';
import { StatusBadge } from './severity';
import { Drawer } from './overlays';
import { browserPermission, requestBrowserPermission, type BrowserPermission } from './useRequestNotifications';
import { Input, Select } from './forms';
import { useToast } from './overlays';
import { IconExternalLink, IconRobot } from './icons';
import {
  archiveRequest,
  cancelRequest,
  listRequests,
  muteRequest,
  pollIntervalWithBackoff,
  requestPollIntervalFor,
  requestStatusLabel,
  setEmailMode,
  unarchiveRequest,
  unmuteRequest,
  type EmailMode,
  type RequestKind,
  type RequestRowView,
  type RequestStatus,
} from '@core/lib/admin/requests-client';
import {
  DEFAULT_REQUEST_QUICK_FILTER,
  matchesQuickFilter,
  nodeLabel,
  progressPhrase,
  QUICK_FILTERS,
  quickFilterToStatuses,
  relativeAge,
  requestSeverityLevel,
  sortRequestRows,
  type RequestQuickFilter,
} from '@core/lib/admin/request-logic';
import { refreshRequestsIndexNow, useDecisionOverlay, useRequestsIndex } from '@core/lib/admin/requests-store';
import {
  assertDecided,
  canDecideRunPublish,
  decide,
  type DecisionAction,
  type DecisionOverlayEntry,
} from '@core/lib/admin/decisions';
import { DECIDED_WAITING_LABEL, pendingDecisionForRequest } from '@core/lib/admin/decision-overlay';
import { useCurrentUser } from '@core/lib/admin/use-current-user';

/** D3: a viewer without publish-decision authority sees the buttons disabled with the reason, never absent. */
const ROW_DECISION_DENIED_REASON = 'You do not have publish-decision authority for this run.';

async function getToken(): Promise<string> {
  const m = await import('@core/lib/admin/goTrueClient');
  return (await m.getAccessToken()) ?? '';
}

const KIND_LABELS: Record<RequestKind, string> = {
  article: 'Article',
  page: 'Page',
  section: 'Section',
  theme: 'Theme',
  media: 'Media',
  capture: 'Capture',
  other: 'Other',
};

/** A live row gets a spinner, not a dot — an editor must be able to tell "moving" from "parked" at a glance. */
function LiveDot({ status }: { status: RequestStatus }) {
  if (status !== 'running' && status !== 'queued') return null;
  return (
    <svg
      className="animate-spin text-[var(--adm-info-text)]"
      width={13}
      height={13}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * T3.2 (T0.3 row A3): the row decides. A `needs_you` row is a run held at its
 * publish-risk gate, which the decision façade addresses by request id — the
 * same target the request detail page and the header pill use, so a decision
 * from any of the three moves the other two through the shared store.
 *
 * `canDecide` is the display-only mirror of the endpoint's own permission
 * line (`decisions.ts`'s `canDecideRunPublish`); the server re-checks, and a
 * viewer without the role gets the buttons DISABLED with the reason, never
 * hidden (D3).
 */
function RequestRow({
  row,
  nowMs,
  canArchive,
  busy,
  muted,
  canDecide,
  decided,
  onDecide,
  onArchive,
  onCancel,
  onMute,
  onOpen,
  selected,
}: {
  row: RequestRowView;
  nowMs: number;
  canArchive: boolean;
  busy: boolean;
  muted: boolean;
  canDecide: boolean;
  decided?: DecisionOverlayEntry;
  onDecide: (row: RequestRowView, decision: DecisionAction, reason?: string) => Promise<void>;
  onArchive: (row: RequestRowView) => void;
  onCancel: (row: RequestRowView) => void;
  onMute: (row: RequestRowView, muted: boolean) => void;
  onOpen: (row: RequestRowView, event: React.MouseEvent<HTMLAnchorElement>) => void;
  selected: boolean;
}) {
  const phrase = progressPhrase(row.progress, row.current_node);
  const level = requestSeverityLevel(row.status);
  const showReason = level === 'needs_you' || level === 'blocked';
  // Approve/Reject only makes sense where a DECISION is pending — the genuine
  // `needs_you` status, not `stalled` riding the same amber colour under the
  // split (STALLED_VS_FAILED_SPLIT): "taking longer than expected" is not a
  // decision waiting on anyone, just a job that hasn't moved. A `blocked`
  // (failed) row has already resolved, badly; nothing here to approve either.
  const showDecisionRow = row.status === 'needs_you';
  const live = row.status === 'running' || row.status === 'queued';
  return (
    <li
      className={`border-b border-[var(--adm-border)] last:border-0 ${selected ? 'bg-[var(--adm-surface-sunken)]' : ''}`}
    >
      <div className="flex flex-wrap items-start gap-3 px-2 py-3">
        <a
          href={`/admin/requests/${encodeURIComponent(row.request_id)}`}
          onClick={(event) => onOpen(row, event)}
          className="adm-focusable min-w-0 flex-1 rounded-[var(--adm-radius-md)]"
        >
          <span className="flex flex-wrap items-center gap-2">
            <LiveDot status={row.status} />
            <span className="truncate text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">
              {row.title}
            </span>
            {/* D4 (T1.1): every status routes through StatusBadge/SEVERITY — no
                surface here paints its own red/amber. */}
            <StatusBadge level={level}>{requestStatusLabel(row.status)}</StatusBadge>
            <Badge tone="neutral">{KIND_LABELS[row.kind] ?? row.kind}</Badge>
          </span>
          <span className="mt-0.5 block text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {phrase && !live ? <span>{phrase} · </span> : null}
            {row.created_by} · {relativeAge(row.updated_at, nowMs)}
          </span>
          {showReason && row.status_reason ? (
            <span className="mt-1 flex items-start gap-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {row.status_reason}
            </span>
          ) : null}
          {live && row.progress && row.progress.total > 0 ? (
            <RunProgress
              className="mt-1.5 max-w-sm"
              step={row.progress.done}
              totalSteps={row.progress.total}
              label={nodeLabel(row.current_node) ?? 'working'}
              // No per-row cost figure exists on `RequestRowView` today — only
              // the run-level activity view (`RequestActivity`) carries a
              // cost ledger. `RunProgress`'s cost slot is simply omitted here
              // rather than faked; the cost ticker still appears on the
              // detail slide-over, which reads the real number.
            />
          ) : null}
        </a>
        <span className="flex shrink-0 flex-wrap items-center gap-1.5">
          {decided ? (
            /* Optimistic: the decision is recorded, the sweeper has not moved
               the run's status yet (W19 — only it may). The row says what THIS
               person did, never what the run now is; the next snapshot
               reconciles it away. */
            <Badge tone="info">{DECIDED_WAITING_LABEL[decided.decision]}</Badge>
          ) : showDecisionRow ? (
            <ActionRow
              className="mr-1"
              onApprove={() => onDecide(row, 'approve')}
              onReject={() => onDecide(row, 'reject')}
              /* The publish-gate endpoint has no field for a reason (see
                 `decisions.ts`'s `reasonDroppedNote`), so Reject decides on
                 the click instead of prompting for words nobody would read. */
              rejectReason="none"
              disabledReason={canDecide ? undefined : ROW_DECISION_DENIED_REASON}
              approveLabel="Approve"
              rejectLabel="Reject"
            />
          ) : null}
          {/* D3/A3: both affordances always render — disabled with a tooltip
              when the data isn't there, never silently absent. */}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<IconRobot size={14} />}
            disabled={!row.chat_id}
            title={row.chat_id ? undefined : 'No chat is attached to this request yet.'}
            onClick={() => row.chat_id && void navigate(`/admin/agents?chat=${encodeURIComponent(row.chat_id)}`)}
          >
            Open chat
          </Button>
          <Button
            size="sm"
            variant="ghost"
            leftIcon={<IconExternalLink size={14} />}
            disabled={!row.object_id}
            title={row.object_id ? undefined : 'No object is attached to this request yet.'}
            onClick={() =>
              row.object_id && void navigate(`/admin/content/${encodeURIComponent(row.object_id)}?type=content_item`)
            }
          >
            Open object
          </Button>
          {/* W19 T19.6: muting is personal and silences ALL THREE channels —
              the toast, the desktop alert and the e-mail. Every notification
              e-mail points back here, so the control has to exist here. */}
          {!row.archived ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => onMute(row, muted)}
              title={muted ? 'You are not being told about this one' : 'Stop telling me about this one'}
            >
              {muted ? 'Unmute' : 'Mute'}
            </Button>
          ) : null}
          {row.status !== 'done' && row.status !== 'cancelled' && !row.archived ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onCancel(row)}>
              Cancel
            </Button>
          ) : null}
          {canArchive ? (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onArchive(row)}>
              {row.archived ? 'Restore' : 'Archive'}
            </Button>
          ) : null}
        </span>
      </div>
    </li>
  );
}

/**
 * W19 T19.6 — the browser-notification opt-in.
 *
 * The permission is requested ONCE, and only from this button (plan §6.2):
 * asking on page load is how a browser prompt gets dismissed forever. The
 * honest limit is stated next to it — this only fires while an admin tab is
 * open somewhere; closed-browser push needs a service worker and VAPID keys
 * and is deliberately not built (plan D5).
 */
function BrowserNotifyControl() {
  const [permission, setPermission] = useState<BrowserPermission>('unsupported');
  useEffect(() => setPermission(browserPermission()), []);

  if (permission === 'unsupported') return null;
  if (permission === 'granted') {
    return (
      <span className="pb-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        Desktop alerts on — while an admin tab is open.
      </span>
    );
  }
  if (permission === 'denied') {
    return (
      <span className="pb-1 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        Desktop alerts are blocked in your browser settings.
      </span>
    );
  }
  return (
    <Button size="sm" variant="secondary" onClick={() => void requestBrowserPermission().then(setPermission)}>
      Notify me on the desktop
    </Button>
  );
}

/**
 * W19 T19.7 — how much mail this person wants.
 *
 * Every notification e-mail ends by telling the reader they can change or stop
 * these e-mails on this page, so this control is what makes that sentence
 * true. Two options only: `daily` is still accepted by the API and by older
 * stored settings, but no digest pass exists yet, so offering it would be
 * offering silence under another name. (R8: recorded, and T19.11 owns the
 * digest.)
 */
function EmailModeControl({ mode, onChange }: { mode: EmailMode; onChange: (next: EmailMode) => void }) {
  return (
    <Select
      label="E-mail me"
      value={mode === 'daily' ? 'off' : mode}
      onChange={(event) => onChange(event.target.value as EmailMode)}
      options={[
        { value: 'immediate', label: 'When a job needs me or stops' },
        { value: 'off', label: 'Never' },
      ]}
    />
  );
}

/** The seven quick-filter tabs (D1(b)). Not W3C `Tabs` (`menus.tsx`) — this is a filter group over ONE list, not separate panel content per tab. */
function QuickFilterTabs({
  value,
  onChange,
}: {
  value: RequestQuickFilter;
  onChange: (next: RequestQuickFilter) => void;
}) {
  return (
    <div
      role="group"
      aria-label="Filter the inbox"
      className="flex flex-wrap gap-1 border-b border-[var(--adm-border)] pb-2"
    >
      {QUICK_FILTERS.map((tab) => {
        const active = tab.key === value;
        return (
          <button
            key={tab.key}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(tab.key)}
            className={
              active
                ? 'adm-focusable rounded-[var(--adm-radius-pill)] bg-[var(--adm-accent)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-on-accent)]'
                : 'adm-focusable rounded-[var(--adm-radius-pill)] px-3 py-1.5 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-muted)] hover:bg-[var(--adm-surface-sunken)]'
            }
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}

const readParams = () =>
  typeof window === 'undefined' ? new URLSearchParams() : new URLSearchParams(window.location.search);

const isQuickFilter = (value: string | null): value is RequestQuickFilter =>
  Boolean(value) && QUICK_FILTERS.some((tab) => tab.key === value);

/**
 * `/admin/requests/<id>` is served by the `__request` placeholder page through
 * the netlify.toml rewrite (the T9.9 object-workspace pattern), so the id is
 * read from the URL here rather than passed as a prop.
 */
const requestIdFromPath = (): string | undefined => {
  if (typeof window === 'undefined') return undefined;
  const match = /^\/admin\/requests\/([^/?#]+)/.exec(window.location.pathname);
  const id = match?.[1];
  return id && id !== '__request' ? decodeURIComponent(id) : undefined;
};

export function RequestsBody({ selectedId }: { selectedId?: string }) {
  const { toast } = useToast();
  const user = useCurrentUser();
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [quickFilter, setQuickFilter] = useState<RequestQuickFilter>(() =>
    isQuickFilter(readParams().get('filter'))
      ? (readParams().get('filter') as RequestQuickFilter)
      : DEFAULT_REQUEST_QUICK_FILTER
  );
  const [kindFilter, setKindFilter] = useState(() => readParams().get('kind') ?? '');
  const [mine, setMine] = useState(() => readParams().get('mine') === '1');
  const [queryInput, setQueryInput] = useState(() => readParams().get('q') ?? '');
  const [query, setQuery] = useState(queryInput);
  const [busy, setBusy] = useState(false);
  const [emailMode, setEmailModeState] = useState<EmailMode>('immediate');

  // R6 (T0.2 F8): the search box no longer fires a request per keystroke.
  useEffect(() => {
    const timer = setTimeout(() => setQuery(queryInput), 300);
    return () => clearTimeout(timer);
  }, [queryInput]);

  const canArchive = user.roles.includes('owner') || user.roles.includes('publisher');
  // Task B (provider-error-details): gates the Owner-only provider detail
  // line on a failed run's error text — the surface already resolves roles,
  // so `RequestActivity` reads it from here rather than resolving its own.
  const isOwner = user.roles.includes('owner');
  // T3.2: the same overlay the shell's pill reads, so a decision taken here
  // and a decision taken from the header are the same fact to both surfaces.
  const decisionOverlay = useDecisionOverlay();
  const canDecide = canDecideRunPublish(user.roles);

  // Filter state lives in the query string, so a filtered view is linkable.
  useEffect(() => {
    if (typeof window === 'undefined' || selectedId) return;
    const params = new URLSearchParams();
    if (quickFilter !== DEFAULT_REQUEST_QUICK_FILTER) params.set('filter', quickFilter);
    if (kindFilter) params.set('kind', kindFilter);
    if (mine) params.set('mine', '1');
    if (query) params.set('q', query);
    const search = params.toString();
    window.history.replaceState({}, '', search ? `/admin/requests?${search}` : '/admin/requests');
  }, [quickFilter, kindFilter, mine, query, selectedId]);

  // ─── the shared chain (T2.3): default view + the shell's pills, one poll ──
  const sharedIndex = useRequestsIndex(getToken);

  // ─── the custom chain: `mine`, a live search, or the Archived tab reach a
  // different or larger universe than the shared cache keeps warm, so they
  // run their own light, visibility-backed-off poll while active instead of
  // borrowing the shared one (see the file header comment). ───────────────
  const custom = mine || quickFilter === 'archived' || query.trim().length > 0;
  const [customRows, setCustomRows] = useState<RequestRowView[] | null>(null);
  const [customError, setCustomError] = useState<string | undefined>(undefined);
  const customTimerRef = useRef<ReturnType<typeof setTimeout>>();
  const customGenerationRef = useRef(0);

  const loadCustom = useCallback(
    async (generation: number) => {
      const current = () => customGenerationRef.current === generation;
      try {
        const result = await listRequests(getToken, {
          ...(quickFilterToStatuses(quickFilter) ? { status: quickFilterToStatuses(quickFilter) } : {}),
          ...(kindFilter ? { kind: [kindFilter] as RequestKind[] } : {}),
          ...(mine ? { mine: true } : {}),
          ...(quickFilter === 'archived' ? { archived: true } : {}),
          ...(query.trim() ? { q: query.trim() } : {}),
        });
        if (!current()) return;
        setCustomRows(result.requests);
        setCustomError(undefined);
        setNowMs(Date.now());
        if (customTimerRef.current) clearTimeout(customTimerRef.current);
        const delay = pollIntervalWithBackoff(
          requestPollIntervalFor(result.requests),
          typeof document !== 'undefined' && document.visibilityState === 'hidden'
        );
        if (delay !== undefined) customTimerRef.current = setTimeout(() => void loadCustom(generation), delay);
      } catch (loadError) {
        if (!current()) return;
        setCustomRows((rowsNow) => rowsNow ?? []);
        setCustomError(loadError instanceof Error ? loadError.message : 'Could not load requests.');
        if (customTimerRef.current) clearTimeout(customTimerRef.current);
        customTimerRef.current = setTimeout(() => void loadCustom(generation), 20_000);
      }
    },
    [quickFilter, kindFilter, mine, query]
  );

  useEffect(() => {
    if (!custom || selectedId) return;
    customGenerationRef.current += 1;
    const generation = customGenerationRef.current;
    if (customTimerRef.current) clearTimeout(customTimerRef.current);
    void loadCustom(generation);
    return () => {
      customGenerationRef.current += 1;
      if (customTimerRef.current) clearTimeout(customTimerRef.current);
    };
  }, [custom, selectedId, loadCustom]);

  useEffect(() => {
    if (!custom || selectedId) return;
    const onVisibility = () => {
      if (document.visibilityState === 'visible') void loadCustom(customGenerationRef.current);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [custom, selectedId, loadCustom]);

  const refresh = useCallback(() => {
    if (custom) void loadCustom(customGenerationRef.current);
    else refreshRequestsIndexNow(getToken);
  }, [custom, loadCustom]);

  /**
   * T3.2 (T0.3 row A3) — the inbox row's decision, through the one façade.
   *
   * `decide` already invalidates the SHARED index (the header pill and this
   * page's default view), so the extra `refresh()` here exists only for the
   * custom chain (`mine`/search/archived), which reads a different universe.
   * A failure throws so `<ActionRow>` returns to rest and surfaces it through
   * the existing toast, and the façade has already rolled the optimistic
   * marker back by then.
   */
  const decideRow = useCallback(
    async (row: RequestRowView, decision: DecisionAction, reason?: string) => {
      const result = await decide(
        getToken,
        { mechanism: 'workflow_gate', requestId: row.request_id, canApprove: canDecide },
        decision,
        reason ? { reason } : {}
      );
      assertDecided(result);
      toast({ title: row.title, description: result.receipt, tone: 'success' });
      refresh();
    },
    [canDecide, refresh, toast]
  );

  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      toast({ title: label, tone: 'success' });
      refresh();
    } catch (actionError) {
      toast({
        title: `${label} failed`,
        description: actionError instanceof Error ? actionError.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => {
    setEmailModeState(sharedIndex.emailMode);
  }, [sharedIndex.emailMode]);

  // Relative-age text ("12m", "3h") refreshes whenever a new snapshot lands —
  // from either chain — rather than freezing at first mount.
  useEffect(() => {
    setNowMs(Date.now());
  }, [sharedIndex.rows, customRows]);

  const loading = custom ? customRows === null : sharedIndex.rows === null;
  const error = custom ? customError : sharedIndex.error;
  const muted = custom ? [] : sharedIndex.muted;

  const rows = useMemo(() => {
    if (custom) return sortRequestRows(customRows ?? []);
    const base = sharedIndex.rows ?? [];
    return sortRequestRows(
      base.filter(
        (row) => matchesQuickFilter(row, quickFilter, sharedIndex.muted) && (!kindFilter || row.kind === kindFilter)
      )
    );
  }, [custom, customRows, sharedIndex.rows, sharedIndex.muted, quickFilter, kindFilter]);

  // ─── the slide-over: an in-list row click opens the detail without losing
  // the filtered list underneath. `/admin/requests/<id>` (this same
  // component, `selectedId` mode) is the load-bearing route this enhances —
  // a direct navigation, a shared link or Cmd/Ctrl-click still lands there. ─
  const [openId, setOpenId] = useState<string | undefined>(() => (selectedId ? undefined : requestIdFromPath()));

  useEffect(() => {
    if (selectedId) return;
    const onPop = () => setOpenId(requestIdFromPath());
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, [selectedId]);

  const openRow = useMemo(() => rows.find((row) => row.request_id === openId), [rows, openId]);

  const onOpenRow = (row: RequestRowView, event: React.MouseEvent<HTMLAnchorElement>) => {
    if (selectedId) return; // already the detail route — plain navigation
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    setOpenId(row.request_id);
    window.history.pushState({}, '', `/admin/requests/${encodeURIComponent(row.request_id)}`);
  };

  const closeDrawer = () => {
    setOpenId(undefined);
    window.history.pushState({}, '', '/admin/requests');
  };

  return (
    <div className="flex flex-col gap-4">
      <Card
        kicker="Requests"
        title={selectedId ? 'This request' : 'Runs inbox'}
        actions={
          selectedId ? (
            <Button size="sm" variant="secondary" onClick={() => void navigate('/admin/requests')}>
              All requests
            </Button>
          ) : (
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {loading ? '' : `${rows.length} ${rows.length === 1 ? 'request' : 'requests'}`}
            </span>
          )
        }
      >
        {selectedId ? null : (
          <>
            <QuickFilterTabs value={quickFilter} onChange={setQuickFilter} />
            <div className="my-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <Select
                label="Kind"
                value={kindFilter}
                onChange={(event) => setKindFilter(event.target.value)}
                options={[
                  { value: '', label: 'Every kind' },
                  ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
                ]}
              />
              <Input
                label="Search"
                value={queryInput}
                placeholder="Title or request id"
                onChange={(event) => setQueryInput(event.target.value)}
              />
              <EmailModeControl
                mode={emailMode}
                onChange={(next) => {
                  setEmailModeState(next);
                  void act('Saved', () => setEmailMode(getToken, next));
                }}
              />
              <div className="flex items-end gap-3 pb-1">
                <BrowserNotifyControl />
                <label className="flex items-center gap-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                  <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} /> Mine
                </label>
              </div>
            </div>
          </>
        )}

        {error ? <p className="mb-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{error}</p> : null}

        {/* W19: on a single request, the full node timeline is the page — an
            editor who opened THIS request wants the detail, not a summary. */}
        {selectedId ? (
          <div className="mb-3">
            <RequestActivity requestId={selectedId} defaultExpanded onSettled={refresh} isOwner={isOwner} />
          </div>
        ) : null}
        {loading ? (
          <Skeleton variant="rect" height={160} />
        ) : rows.length === 0 ? (
          <EmptyState
            title={quickFilter === 'archived' ? 'Nothing archived' : 'Nothing here'}
            message={
              quickFilter === 'archived'
                ? 'Archived requests appear here once someone files them away.'
                : quickFilter === DEFAULT_REQUEST_QUICK_FILTER
                  ? 'Nothing needs you right now — everything in flight is moving on its own.'
                  : 'Ask the agent for an article and it will appear here while it is being written.'
            }
          />
        ) : (
          <ul className="flex flex-col">
            {rows.map((row) => (
              <RequestRow
                key={row.request_id}
                row={row}
                nowMs={nowMs}
                canArchive={canArchive}
                busy={busy}
                muted={muted.includes(row.request_id)}
                canDecide={canDecide}
                decided={pendingDecisionForRequest(decisionOverlay, row.request_id)}
                onDecide={decideRow}
                selected={row.request_id === (selectedId ?? openId)}
                onOpen={onOpenRow}
                onArchive={(target) =>
                  void act(target.archived ? 'Restored' : 'Archived', () =>
                    target.archived
                      ? unarchiveRequest(getToken, target.request_id)
                      : archiveRequest(getToken, target.request_id)
                  )
                }
                onCancel={(target) => void act('Cancelled', () => cancelRequest(getToken, target.request_id))}
                onMute={(target, isMuted) =>
                  void act(isMuted ? 'Unmuted' : 'Muted', () =>
                    isMuted ? unmuteRequest(getToken, target.request_id) : muteRequest(getToken, target.request_id)
                  )
                }
              />
            ))}
          </ul>
        )}
      </Card>

      {/* D1(b): row detail as a slide-over — a small enhancement over the
          load-bearing `/admin/requests/<id>` route, not a replacement for it
          (see the file header comment). Only rendered on the plain list
          route; the direct route above already IS the detail view. */}
      {selectedId ? null : (
        <Drawer open={Boolean(openId)} onClose={closeDrawer} title={openRow?.title ?? 'Request'} width={480}>
          {openId ? (
            <div className="flex flex-col gap-3">
              {openRow ? (
                <div className="flex flex-wrap items-center gap-2">
                  <StatusBadge level={requestSeverityLevel(openRow.status)}>
                    {requestStatusLabel(openRow.status)}
                  </StatusBadge>
                  <Badge tone="neutral">{KIND_LABELS[openRow.kind] ?? openRow.kind}</Badge>
                  <Button
                    size="sm"
                    variant="secondary"
                    leftIcon={<IconRobot size={14} />}
                    disabled={!openRow.chat_id}
                    title={openRow.chat_id ? undefined : 'No chat is attached to this request yet.'}
                    onClick={() =>
                      openRow.chat_id && void navigate(`/admin/agents?chat=${encodeURIComponent(openRow.chat_id)}`)
                    }
                  >
                    Open chat
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    leftIcon={<IconExternalLink size={14} />}
                    disabled={!openRow.object_id}
                    title={openRow.object_id ? undefined : 'No object is attached to this request yet.'}
                    onClick={() =>
                      openRow.object_id &&
                      void navigate(`/admin/content/${encodeURIComponent(openRow.object_id)}?type=content_item`)
                    }
                  >
                    Open object
                  </Button>
                </div>
              ) : null}
              <RequestActivity requestId={openId} defaultExpanded onSettled={refresh} isOwner={isOwner} />
            </div>
          ) : null}
        </Drawer>
      )}
    </div>
  );
}

export interface RequestsWorkspaceProps {
  identity: SiteIdentity;
}

export default function RequestsWorkspace({ identity }: RequestsWorkspaceProps) {
  const [selectedId] = useState(requestIdFromPath);
  return (
    <AdminShell currentPath="/admin/requests" title="Requests" identity={identity}>
      <RequestsBody {...(selectedId ? { selectedId } : {})} />
    </AdminShell>
  );
}
