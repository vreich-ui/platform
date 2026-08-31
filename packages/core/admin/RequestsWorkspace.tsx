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
import type { ReactNode } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, IconButton, Skeleton } from './primitives';
import { RequestActivity, useRetryRequest } from './RequestActivity';
import { ActionRow, RunProgress } from './approval';
import { StatusBadge } from './severity';
import { ConfirmDialog, Drawer, Popover } from './overlays';
import { browserPermission, requestBrowserPermission, type BrowserPermission } from './useRequestNotifications';
import { Input, Select } from './forms';
import { useToast } from './overlays';
import { DropdownMenu } from './menus';
import { IconDots, IconExternalLink, IconRobot, IconSettings } from './icons';
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
  QUICK_FILTERS,
  quickFilterToStatuses,
  publishPolicyFromApproval,
  publishTargetFor,
  requestSeverityLevel,
  rowActions,
  rowMetaLine,
  sortRequestRows,
  type PublishPolicy,
  type RequestQuickFilter,
  type RowAction,
  type RowActionId,
} from '@core/lib/admin/request-logic';
import { activeApprovalPolicy, publishRequiresApproval } from '@core/lib/approval-policy';
import { runQuickAction } from '@core/lib/admin/quick-actions';
import { callObjectVerb } from '@core/lib/edit-mode/verbs-client';
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

/**
 * B3 — this client's publish posture, read once from the committed approval
 * policy (`lib/approval-policy.ts`, the same client-safe read
 * `object-review-ui.ts` makes; the admin entry point already imports the
 * site's policy bindings). `content_item` is the type asked about, the same
 * assumption the row's Open object link already makes: an editorial request's
 * object is an article.
 *
 * A bundle that reached this without registered bindings would THROW, and a
 * config read must not blank a publisher's only action, so that degrades to
 * `manual` — Publish still renders and the server's own gate stays the
 * authority. Never to `block`: this surface must not invent a refusal.
 */
const resolvePublishPolicy = (): PublishPolicy => {
  try {
    return publishPolicyFromApproval(publishRequiresApproval('content_item', activeApprovalPolicy()));
  } catch {
    return 'manual';
  }
};

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
 * B1 — a `RowAction` made visible.
 *
 * Icons and variants live here rather than in `request-logic.ts`: which
 * action is worth an accent button is a LOOK, and the model must stay
 * renderer-free (it is tested in node, with no React).
 */
const ROW_ACTION_ICON: Partial<Record<RowActionId, ReactNode>> = {
  open_chat: <IconRobot size={14} />,
  open_object: <IconExternalLink size={14} />,
};

const ROW_ACTION_VARIANT: Partial<Record<RowActionId, 'primary' | 'secondary' | 'ghost'>> = {
  publish: 'primary',
  retry: 'secondary',
  raise_budget: 'secondary',
  restore: 'secondary',
  open_chat: 'secondary',
};

/**
 * One primary action. D3: a disabled one keeps its place in the row and
 * carries its reason on a `Popover` (`mode="hover"`) — reachable by keyboard
 * focus and by touch, which a native `title=` on a disabled button is not.
 * A merely `busy`-disabled button gets no popover: the toast that follows
 * says what happened, and a tooltip repeating "busy" is noise.
 */
function RowActionButton({
  action,
  busy,
  onInvoke,
}: {
  action: RowAction;
  busy: boolean;
  onInvoke: (action: RowAction) => void;
}) {
  const icon = ROW_ACTION_ICON[action.id];
  const variant = ROW_ACTION_VARIANT[action.id] ?? 'ghost';
  if (!action.enabled) {
    return (
      <Popover
        mode="hover"
        disabled
        content={action.reason ?? ''}
        trigger={(a11y) => (
          <Button size="sm" variant={variant} disabled {...(icon ? { leftIcon: icon } : {})} {...a11y}>
            {action.label}
          </Button>
        )}
      />
    );
  }
  return (
    <Button
      size="sm"
      variant={variant}
      disabled={busy}
      {...(icon ? { leftIcon: icon } : {})}
      onClick={() => onInvoke(action)}
    >
      {action.label}
    </Button>
  );
}

/**
 * The row's action cluster: at most two primaries (the model decides which —
 * `rowActions`), then everything else behind ONE overflow menu. The list is
 * the same object the Drawer renders from, which is the point of B1: the two
 * surfaces cannot offer different actions for the same row any more.
 */
function RowActionCluster({
  actions,
  busy,
  onInvoke,
  menuLabel,
}: {
  actions: readonly RowAction[];
  busy: boolean;
  onInvoke: (action: RowAction) => void;
  menuLabel: string;
}) {
  const primaries = actions.filter((action) => action.kind === 'primary');
  const overflow = actions.filter((action) => action.kind === 'menu');
  return (
    <>
      {primaries.map((action) => (
        <RowActionButton key={action.id} action={action} busy={busy} onInvoke={onInvoke} />
      ))}
      {overflow.length > 0 ? (
        <DropdownMenu
          align="end"
          trigger={({ ref, onToggle }) => (
            <IconButton ref={ref} label={menuLabel} icon={<IconDots size={16} />} size="sm" onClick={onToggle} />
          )}
          items={overflow.map((action) => ({
            id: action.id,
            label: action.label,
            disabled: !action.enabled || busy,
            // `MenuItem.title` is now rendered as a hover Popover, not a
            // native title= (see `menus.tsx`) — same D3 guarantee as above.
            ...(action.reason ? { title: action.reason } : {}),
            onSelect: () => onInvoke(action),
          }))}
        />
      ) : null}
    </>
  );
}

/**
 * Every effect a row action can have. All required since B2/B3 landed the last
 * two: the "Not wired yet" placeholder reason is gone, and an action's
 * availability is now decided by `rowActions` and the server's own gates
 * alone — never by whether this file happened to pass a prop.
 */
export interface RowActionHandlers {
  onArchive: (row: RequestRowView) => void;
  onCancel: (row: RequestRowView) => void;
  onMute: (row: RequestRowView, muted: boolean) => void;
  /** B2: `retryRequest()` — puts a stopped run back in front of the sweeper. */
  onRetry: (row: RequestRowView) => void;
  /** B3: the object publish path, behind a confirmation. */
  onPublish: (row: RequestRowView) => void;
  /** Opens the run's detail, where the Owner-only budget-raise card (`budgetRaiseButtons` → `raiseNodeBudget`) already lives. */
  onRaiseBudget: (row: RequestRowView) => void;
}

/**
 * The one place a row's actions are computed AND dispatched — the inbox row
 * and the Drawer both call it, so a change to either is a change to both.
 *
 * Two component-level overrides sit on top of the pure model, both narrowing
 * never widening: an action whose handler has not landed yet and the
 * publish-DECISION mirror (`canDecideRunPublish` — the endpoint's own line is
 * `roles.includes('admin')`, narrower than the publish tier `rowActions`
 * gates on, and showing a publisher a live Approve the server then refuses
 * would be worse than showing it disabled with the real reason).
 *
 * B3 resolves the mismatch B1 flagged by SCOPING that mirror, not widening
 * it: `canDecideRunPublish` mirrors ONE server line — the run gate's
 * `can_approve` on `admin-request-activity` — so it narrows Approve/Reject
 * and nothing else. The row's Publish is a different server gate entirely
 * (`checkPublishGate`'s `canExecutePublish`: admin OR publisher), which is
 * exactly the `publish` tier `rowActions` already applies, so a publisher
 * gets a live Publish and a disabled Approve, both truthfully.
 */
function useRowActions(
  row: RequestRowView,
  {
    roles,
    mine,
    muted,
    canDecide,
    publishPolicy,
    handlers,
  }: {
    roles: readonly string[];
    mine: boolean;
    muted: boolean;
    canDecide: boolean;
    publishPolicy: PublishPolicy;
    handlers: RowActionHandlers;
  }
) {
  const actions = useMemo(() => {
    return rowActions(
      {
        status: row.status,
        archived: row.archived,
        ...(row.chat_id ? { chat_id: row.chat_id } : {}),
        ...(row.object_id ? { object_id: row.object_id } : {}),
        muted,
        mine,
      },
      roles,
      { publishPolicy }
    ).map((action) => {
      if (!action.enabled) return action;
      if ((action.id === 'approve' || action.id === 'reject') && !canDecide)
        return { ...action, enabled: false, reason: ROW_DECISION_DENIED_REASON };
      return action;
    });
  }, [row, roles, mine, muted, canDecide, publishPolicy]);

  const invoke = (action: RowAction) => {
    switch (action.id) {
      case 'open_chat':
        if (row.chat_id) void navigate(`/admin/agents?chat=${encodeURIComponent(row.chat_id)}`);
        return;
      case 'open_object':
        if (row.object_id) void navigate(`/admin/content/${encodeURIComponent(row.object_id)}?type=content_item`);
        return;
      case 'mute':
        handlers.onMute(row, muted);
        return;
      case 'cancel':
        handlers.onCancel(row);
        return;
      case 'archive':
      case 'restore':
        handlers.onArchive(row);
        return;
      case 'retry':
        handlers.onRetry(row);
        return;
      case 'publish':
        handlers.onPublish(row);
        return;
      case 'raise_budget':
        handlers.onRaiseBudget(row);
        return;
      default:
        // approve/reject are the one pair that does NOT dispatch from here —
        // `ActionRow` owns their pending state and their reason flow.
        return;
    }
  };

  return { actions, invoke };
}

/**
 * T3.2 (T0.3 row A3): the row decides. A `needs_you` row is a run held at its
 * publish-risk gate, which the decision façade addresses by request id — the
 * same target the request detail page and the header pill use, so a decision
 * from any of the three moves the other two through the shared store.
 *
 * B1: WHICH actions a row offers is no longer written here — `rowActions`
 * (`lib/admin/request-logic.ts`) answers that from the status and the
 * caller's roles, and this component only draws the answer: at most two
 * primaries plus one overflow menu. The Drawer draws the same list.
 */
function RequestRow({
  row,
  nowMs,
  roles,
  mine,
  busy,
  muted,
  canDecide,
  publishPolicy,
  decided,
  onDecide,
  handlers,
  onOpen,
  selected,
}: {
  row: RequestRowView;
  nowMs: number;
  roles: readonly string[];
  mine: boolean;
  busy: boolean;
  muted: boolean;
  canDecide: boolean;
  publishPolicy: PublishPolicy;
  decided?: DecisionOverlayEntry;
  onDecide: (row: RequestRowView, decision: DecisionAction, reason?: string) => Promise<void>;
  handlers: RowActionHandlers;
  onOpen: (row: RequestRowView, event: React.MouseEvent<HTMLAnchorElement>) => void;
  selected: boolean;
}) {
  // B4: one meta line — progressPhrase · owner · age. `status_reason`
  // ("The artifact plan step failed, so the job has stopped.") used to render
  // as its own line here, restating the StatusBadge right above it; it now
  // shows only in the Drawer. `rowMetaLine` already omits the phrase for a
  // live row, since `RunProgress` (below) takes its place.
  const meta = rowMetaLine(row, nowMs);
  const metaLine = [meta.primary, ...meta.secondary].filter(Boolean).join(' · ');
  const level = requestSeverityLevel(row.status);
  const live = row.status === 'running' || row.status === 'queued';
  const { actions, invoke } = useRowActions(row, { roles, mine, muted, canDecide, publishPolicy, handlers });
  // Approve/Reject render through `ActionRow`, which owns the pending state
  // and the reason flow; every other action is a plain button or a menu item.
  const approve = actions.find((action) => action.id === 'approve');
  const reject = actions.find((action) => action.id === 'reject');
  const rest = actions.filter((action) => action.id !== 'approve' && action.id !== 'reject');
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
          <span className="mt-0.5 block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {metaLine}
          </span>
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
          ) : approve && reject ? (
            <ActionRow
              className="mr-1"
              onApprove={() => onDecide(row, 'approve')}
              onReject={() => onDecide(row, 'reject')}
              /* The publish-gate endpoint has no field for a reason (see
                 `decisions.ts`'s `reasonDroppedNote`), so Reject decides on
                 the click instead of prompting for words nobody would read. */
              rejectReason="none"
              approveLabel={approve.label}
              rejectLabel={reject.label}
              {...(approve.reason ? { approveDisabledReason: approve.reason } : {})}
              {...(reject.reason ? { rejectDisabledReason: reject.reason } : {})}
            />
          ) : null}
          <RowActionCluster
            actions={rest}
            busy={busy}
            onInvoke={invoke}
            menuLabel={`More actions for ${row.title}`}
          />
        </span>
      </div>
    </li>
  );
}

/**
 * The Drawer's action cluster — the SAME list the row renders (B1: the
 * duplicated Open chat / Open object JSX that used to live in the Drawer is
 * gone). Approve/Reject are dropped here only because `RequestActivity`
 * below already renders the run's own approval card; offering a second pair
 * of decision buttons six inches above it is how two surfaces disagree.
 */
function RequestDrawerActions({
  row,
  roles,
  mine,
  muted,
  canDecide,
  publishPolicy,
  busy,
  handlers,
}: {
  row: RequestRowView;
  roles: readonly string[];
  mine: boolean;
  muted: boolean;
  canDecide: boolean;
  publishPolicy: PublishPolicy;
  busy: boolean;
  handlers: RowActionHandlers;
}) {
  const { actions, invoke } = useRowActions(row, { roles, mine, muted, canDecide, publishPolicy, handlers });
  return (
    <RowActionCluster
      actions={actions.filter((action) => action.id !== 'approve' && action.id !== 'reject')}
      busy={busy}
      onInvoke={invoke}
      menuLabel={`More actions for ${row.title}`}
    />
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

  // Task B (provider-error-details): gates the Owner-only provider detail
  // line on a failed run's error text — the surface already resolves roles,
  // so `RequestActivity` reads it from here rather than resolving its own.
  const isOwner = user.roles.includes('owner');
  // B1: `rowActions` needs the caller's own address to answer "may this
  // editor cancel THIS run" — an editor may cancel their own, a publisher
  // anyone's. Unknown fails closed (see `rowActions`).
  const myEmail = user.user?.email?.trim().toLowerCase();
  // T3.2: the same overlay the shell's pill reads, so a decision taken here
  // and a decision taken from the header are the same fact to both surfaces.
  const decisionOverlay = useDecisionOverlay();
  const canDecide = canDecideRunPublish(user.roles);
  // B3: one read of the committed posture per mount — it cannot change under us.
  const publishPolicy = useMemo(resolvePublishPolicy, []);
  /** B3: the row awaiting its publish confirmation, if any (`ConfirmDialog`). */
  const [publishTarget, setPublishTarget] = useState<RequestRowView | undefined>(undefined);

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
   * B2 — Retry, for all three places this page shows a run: the inbox row's
   * action, the Drawer's copy of it, and the run card on the detail route.
   * One handler, so a retry taken from any of them makes the same call, says
   * the same thing and refreshes the same list.
   */
  const retryRun = useRetryRequest(refresh);

  /**
   * B3 — Publish, through the object publish path that already exists
   * (`runQuickAction`'s `object_publish`: checkout → publish_by_time →
   * checkin, giving the lock back on both paths). Nothing new is written
   * here; the server's `checkPublishGate` remains the only authority on
   * whether this publish may happen.
   *
   * What the inbox can truthfully say about the object it is publishing —
   * and what it deliberately does not invent — is `publishTargetFor`'s own
   * documented job (`request-logic.ts`), so the shape this passes and the
   * shape the test drives cannot drift.
   */
  const publishRow = useCallback(
    async (target: RequestRowView) => {
      const object = publishTargetFor(target);
      if (!object) return;
      setBusy(true);
      try {
        const result = await runQuickAction(
          (body) => callObjectVerb(getToken, body),
          { id: 'publish', verb: 'object_publish', label: 'Publish' },
          object
        );
        toast({
          title: result.ok ? 'Published' : 'Publish failed',
          description: result.receipt,
          tone: result.ok ? 'success' : 'danger',
        });
        if (result.ok) refresh();
      } finally {
        setBusy(false);
      }
    },
    [refresh, toast]
  );

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

  /**
   * B1 — every row action's effect, in ONE place, for both the row and the
   * Drawer. B2 landed `onRetry` (`retryRequest()`) and B3 `onPublish` (the
   * object publish path, behind a confirmation), so nothing here is a button
   * that says "not wired yet" any more.
   *
   * `onRaiseBudget` opens the run's detail rather than raising anything here:
   * the Owner-only raise card (`budgetRaiseButtons` → `raiseNodeBudget`)
   * already exists in `RequestActivity`, and it needs the failed node's own
   * budget numbers — which an index row does not carry. Routing to it beats
   * a second, number-less copy of the same two buttons.
   */
  const openDetail = useCallback(
    (target: RequestRowView) => {
      if (selectedId) return;
      setOpenId(target.request_id);
      window.history.pushState({}, '', `/admin/requests/${encodeURIComponent(target.request_id)}`);
    },
    [selectedId]
  );

  const rowHandlers: RowActionHandlers = {
    onArchive: (target) =>
      void act(target.archived ? 'Restored' : 'Archived', () =>
        target.archived ? unarchiveRequest(getToken, target.request_id) : archiveRequest(getToken, target.request_id)
      ),
    onCancel: (target) => void act('Cancelled', () => cancelRequest(getToken, target.request_id)),
    onMute: (target, isMuted) =>
      void act(isMuted ? 'Unmuted' : 'Muted', () =>
        isMuted ? unmuteRequest(getToken, target.request_id) : muteRequest(getToken, target.request_id)
      ),
    // B2: the index row carries `current_node`, which is the best name a list
    // row has for where the run stopped — the run card passes the sharper
    // `recovery.node_id` instead.
    onRetry: (target) => void retryRun(target.request_id),
    // B3: publishing is not undoable from here, so it asks first.
    onPublish: (target) => setPublishTarget(target),
    onRaiseBudget: openDetail,
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
            {/* B5: Search + Kind + Mine on one line — the notification settings
                (e-mail cadence, desktop alerts) are per-person preferences, not
                filters over the list, so they move behind a gear rather than
                competing with the filters for row space. */}
            <div className="my-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[9rem]">
                <Select
                  label="Kind"
                  value={kindFilter}
                  onChange={(event) => setKindFilter(event.target.value)}
                  options={[
                    { value: '', label: 'Every kind' },
                    ...Object.entries(KIND_LABELS).map(([value, label]) => ({ value, label })),
                  ]}
                />
              </div>
              <div className="min-w-[12rem] flex-1">
                <Input
                  label="Search"
                  value={queryInput}
                  placeholder="Title or request id"
                  onChange={(event) => setQueryInput(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 pb-2.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                <input type="checkbox" checked={mine} onChange={(event) => setMine(event.target.checked)} /> Mine
              </label>
              <Popover
                mode="click"
                placement="bottom"
                trigger={(a11y) => (
                  <IconButton
                    {...a11y}
                    label="Notification settings"
                    icon={<IconSettings size={16} />}
                    variant="secondary"
                  />
                )}
                content={
                  <div className="flex w-64 flex-col gap-3">
                    <EmailModeControl
                      mode={emailMode}
                      onChange={(next) => {
                        setEmailModeState(next);
                        void act('Saved', () => setEmailMode(getToken, next));
                      }}
                    />
                    <BrowserNotifyControl />
                  </div>
                }
              />
            </div>
          </>
        )}

        {error ? <p className="mb-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{error}</p> : null}

        {/* W19: on a single request, the full node timeline is the page — an
            editor who opened THIS request wants the detail, not a summary. */}
        {selectedId ? (
          <div className="mb-3">
            <RequestActivity
              requestId={selectedId}
              defaultExpanded
              onSettled={refresh}
              isOwner={isOwner}
              onRetry={() => void retryRun(selectedId)}
            />
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
                roles={user.roles}
                mine={Boolean(myEmail) && row.created_by.trim().toLowerCase() === myEmail}
                busy={busy}
                muted={muted.includes(row.request_id)}
                canDecide={canDecide}
                publishPolicy={publishPolicy}
                decided={pendingDecisionForRequest(decisionOverlay, row.request_id)}
                onDecide={decideRow}
                selected={row.request_id === (selectedId ?? openId)}
                onOpen={onOpenRow}
                handlers={rowHandlers}
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
                  {/* B1: the same action list the row renders — the two
                      hand-written buttons that used to live here are gone. */}
                  <RequestDrawerActions
                    row={openRow}
                    roles={user.roles}
                    mine={Boolean(myEmail) && openRow.created_by.trim().toLowerCase() === myEmail}
                    muted={muted.includes(openRow.request_id)}
                    canDecide={canDecide}
                    publishPolicy={publishPolicy}
                    busy={busy}
                    handlers={rowHandlers}
                  />
                </div>
              ) : null}
              <RequestActivity
                requestId={openId}
                defaultExpanded
                onSettled={refresh}
                isOwner={isOwner}
                onRetry={() => void retryRun(openId)}
              />
            </div>
          ) : null}
        </Drawer>
      )}

      {/* B3: publishing commits the draft to the export — not undoable from
          this row — so it asks first, and says what the client's posture
          means for the click. A `manual` client still gets the button: the
          record's approval state lives on the object, not on this row, so
          the server's publish gate is what actually decides. */}
      <ConfirmDialog
        open={Boolean(publishTarget)}
        onClose={() => setPublishTarget(undefined)}
        onConfirm={() => {
          const target = publishTarget;
          setPublishTarget(undefined);
          if (target) void publishRow(target);
        }}
        title={`Publish “${publishTarget?.title ?? 'this article'}”?`}
        message={
          publishPolicy === 'manual'
            ? 'This client requires an approved review before a publish is accepted. If the article has one, this commits it to the export; it goes live on the next release.'
            : 'This commits the article to the export. It goes live on the next release.'
        }
        confirmLabel="Publish"
      />
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
