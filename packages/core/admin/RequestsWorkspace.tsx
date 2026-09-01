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
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { navigate } from 'astro:transitions/client';

import { AdminShell } from './AdminShell';
import type { SiteIdentity } from '@core/lib/site-identity';
import { Badge, Button, Card, EmptyState, IconButton, Skeleton } from './primitives';
import { RequestActivity, useRetryRequest } from './RequestActivity';
import { ActionRow, RunProgress } from './approval';
import { StatusBadge } from './severity';
import { ConfirmDialog, Dialog, Drawer, Popover } from './overlays';
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
  DEFAULT_REQUEST_URL_FILTERS,
  requestsAddress,
  urlFiltersToApply,
  type RequestUrlFilterField,
} from '@core/lib/admin/request-url-filters';
import {
  DEFAULT_REQUEST_QUICK_FILTER,
  matchesQuickFilter,
  nodeLabel,
  QUICK_FILTERS,
  quickFilterToStatuses,
  publishPolicyFromApproval,
  publishTargetFor,
  requestObjectHref,
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
import { liveArticleUrl } from '@core/lib/admin/publication-card';
import { fetchReleaseOverview, triggerProductionRelease } from '@core/lib/admin/release-client';
import {
  releaseConfirmation,
  releaseScopeFrom,
  type ReleaseConfirmation,
} from '@core/lib/admin/release-confirmation';
import { useCurrentUser } from '@core/lib/admin/use-current-user';
import {
  isAuthExpired,
  SESSION_EXPIRED_MESSAGE,
  SESSION_EXPIRED_TITLE,
  SIGN_IN_LABEL,
  subscribeAuthExpiry,
} from '@core/lib/admin/auth-expiry';

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

/**
 * C3 — the one fact every part of this page needs: is the session still ours?
 *
 * Read from the module-scope store (`lib/admin/auth-expiry.ts`) rather than
 * from `useCurrentUser`, because an empty role list is the SYMPTOM shared by
 * two different states and cannot distinguish them.
 */
const useAuthExpired = (): boolean => useSyncExternalStore(subscribeAuthExpiry, isAuthExpired, () => false);

/**
 * C3 — a persistent banner, deliberately not a toast.
 *
 * A toast is for something that has happened and is over; this is a state
 * that does not resolve itself, and dismissing it would leave the rows below
 * reading as if they were live. It stays until someone signs in.
 */
function SessionExpiredBanner() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center gap-3 rounded-[var(--adm-radius-md)] border border-[var(--adm-warning)] bg-[var(--adm-warning-soft)] px-4 py-3"
    >
      <div className="min-w-0 flex-1">
        <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-warning-text)]">
          {SESSION_EXPIRED_TITLE}
        </p>
        <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-warning-text)]">
          {SESSION_EXPIRED_MESSAGE}
        </p>
      </div>
      <Button size="sm" onClick={openSignIn}>
        {SIGN_IN_LABEL}
      </Button>
    </div>
  );
}

/**
 * The sign-in CTA. `LoginModal.astro` publishes `window.__cmsLoginModal` on
 * every admin page (`AdminLayout.astro` mounts it), so the modal opens in
 * place. If a page somehow has no modal, a reload lands on the layout's own
 * signed-out gate, which offers the same sign-in — never a dead button.
 */
function openSignIn(): void {
  const modal = (globalThis as unknown as { __cmsLoginModal?: { open: () => void } }).__cmsLoginModal;
  if (modal) modal.open();
  else window.location.reload();
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
  /**
   * W21.3: the SITE release — the one thing that turns a published row's
   * "no live URL yet" into a live URL. Not per-object; see `rowActions`.
   */
  onRelease: (row: RequestRowView) => void;
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
  // C3: read here rather than threaded as a prop, so the row and the Drawer
  // can never disagree about whether the session is alive.
  const signedOut = useAuthExpired();
  const actions = useMemo(() => {
    return rowActions(
      {
        status: row.status,
        archived: row.archived,
        ...(row.chat_id ? { chat_id: row.chat_id } : {}),
        ...(row.object_id ? { object_id: row.object_id } : {}),
        // C1: the index row carries the object's publication truth now, so a
        // finished article stops being offered a Publish it does not need.
        // Absent (a server deployed before C1) reads as not published.
        ...(row.object_published !== undefined ? { object_published: row.object_published } : {}),
        // W21.1: the probe's own answer about the LIBRARY, forwarded verbatim.
        // Absent stays absent — an unprobed row must not read as confirmed.
        ...(row.object_in_library !== undefined ? { object_in_library: row.object_in_library } : {}),
        ...(row.live_path ? { live_path: row.live_path } : {}),
        muted,
        mine,
      },
      roles,
      { publishPolicy, signedOut }
    ).map((action) => {
      if (!action.enabled) return action;
      if ((action.id === 'approve' || action.id === 'reject') && !canDecide)
        return { ...action, enabled: false, reason: ROW_DECISION_DENIED_REASON };
      return action;
    });
  }, [row, roles, mine, muted, canDecide, publishPolicy, signedOut]);

  const invoke = (action: RowAction) => {
    switch (action.id) {
      case 'open_chat':
        if (row.chat_id) void navigate(`/admin/agents?chat=${encodeURIComponent(row.chat_id)}`);
        return;
      case 'open_object':
        if (row.object_id) void navigate(requestObjectHref(row.object_id));
        return;
      case 'view_live': {
        // The admin is served BY the site, so its own origin is the site's —
        // the same join `RequestActivity`'s live link makes.
        const href = liveArticleUrl(row.live_path, window.location.origin);
        if (href) window.open(href, '_blank', 'noopener,noreferrer');
        return;
      }
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
      case 'release':
        handlers.onRelease(row);
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
  // C3: whether this browser still has a session. Held with the other
  // top-level hooks — never below an early return (`rules-of-hooks`).
  const authExpired = useAuthExpired();
  const [nowMs, setNowMs] = useState(() => Date.now());
  /**
   * W21.2 — every filter starts at its DEFAULT, on both sides.
   *
   * These used to read `window.location.search` in their initializers, which
   * the server cannot do: `requests.astro` mounts this island `client:load`,
   * so it is server-rendered first with an empty `URLSearchParams`, and
   * `/admin/requests?filter=done` painted the Needs-you tab. Hydration did not
   * repair it — React warns about a `className` mismatch and keeps the
   * server's — so the tab stayed wrong while the list, fetched afterwards,
   * looked right. The URL is applied below instead, after hydration, where a
   * state change is a real re-render rather than a disagreement.
   */
  const [quickFilter, setQuickFilter] = useState<RequestQuickFilter>(DEFAULT_REQUEST_URL_FILTERS.quickFilter);
  const [kindFilter, setKindFilter] = useState(DEFAULT_REQUEST_URL_FILTERS.kind);
  const [mine, setMine] = useState(DEFAULT_REQUEST_URL_FILTERS.mine);
  const [queryInput, setQueryInput] = useState(DEFAULT_REQUEST_URL_FILTERS.q);
  const [query, setQuery] = useState(queryInput);
  const [urlFiltersApplied, setUrlFiltersApplied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [emailMode, setEmailModeState] = useState<EmailMode>('immediate');

  /**
   * FIX 4 — which filters the person has actually touched.
   *
   * W21.2 decided "untouched" by comparing the value to its default, which
   * cannot tell "nobody has touched this" from "someone deliberately set it to
   * the default". So on `/admin/requests?filter=done`, clicking **Needs you**
   * (the default tab) before the mount effect flushed was silently undone —
   * and the same for clearing the kind, unticking Mine, or emptying the search
   * box. Interaction is recorded here instead, which is the thing actually
   * being asked about. A ref, not state: it must be readable by the effect
   * below in the same tick it was written, and it must never cause a render.
   */
  const touchedFilters = useRef(new Set<RequestUrlFilterField>());
  const touch =
    <T,>(field: RequestUrlFilterField, set: (value: T) => void) =>
    (value: T) => {
      touchedFilters.current.add(field);
      set(value);
    };
  const onQuickFilterChange = touch<RequestQuickFilter>('quickFilter', setQuickFilter);
  const onKindFilterChange = touch<string>('kind', setKindFilter);
  const onMineChange = touch<boolean>('mine', setMine);
  const onQueryInputChange = touch<string>('q', setQueryInput);

  /**
   * W21.2 — the URL, applied once the browser is the one rendering.
   *
   * Only fields the person has NOT touched are written, so a filter changed
   * between hydration and this effect survives whatever the address said —
   * including a filter changed TO its default value (FIX 4). `[]` on purpose:
   * the URL is an ENTRY condition, and the writer below owns the address from
   * here on — re-running this would fight that writer for the same state.
   */
  useEffect(() => {
    const apply = urlFiltersToApply(window.location.search, touchedFilters.current);
    if (apply.quickFilter !== undefined) setQuickFilter(apply.quickFilter);
    if (apply.kind !== undefined) setKindFilter(apply.kind);
    if (apply.mine !== undefined) setMine(apply.mine);
    if (apply.q !== undefined) {
      setQueryInput(apply.q);
      // The debounce below would arrive here 300 ms later; a search that came
      // in the address has already waited long enough.
      setQuery(apply.q);
    }
    setUrlFiltersApplied(true);
  }, []);

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
  /**
   * W21.3: the row a pending release was asked for FROM — the release itself
   * is site-wide. FIX 5: it is only ever set once the release overview has
   * been read, so the dialog states the REAL pending scope instead of a
   * sentence written from the row.
   */
  const [releaseTarget, setReleaseTarget] = useState<
    { row: RequestRowView; confirmation: ReleaseConfirmation } | undefined
  >(undefined);

  // ─── the slide-over: an in-list row click opens the detail without losing
  // the filtered list underneath. `/admin/requests/<id>` (this same
  // component, `selectedId` mode) is the load-bearing route this enhances —
  // a direct navigation, a shared link or Cmd/Ctrl-click still lands there. ─
  // Declared above the URL writer because FIX 6 makes the writer own the whole
  // address, drawer included, rather than only its query string.
  const [openId, setOpenId] = useState<string | undefined>(() => (selectedId ? undefined : requestIdFromPath()));

  /** The four filters as one value — what the address is written from. */
  const urlFilters = useMemo(
    () => ({ quickFilter, kind: kindFilter, mine, q: query }),
    [quickFilter, kindFilter, mine, query]
  );

  // Filter state lives in the query string, so a filtered view is linkable.
  useEffect(() => {
    // W21.2: not before the address has been read, or this writer would erase
    // the very filters it is about to start maintaining.
    if (typeof window === 'undefined' || selectedId || !urlFiltersApplied) return;
    // FIX 6: `openId` is part of the address, so opening or closing the drawer
    // no longer means writing a path that has forgotten the filters.
    window.history.replaceState({}, '', requestsAddress(urlFilters, openId));
  }, [urlFilters, openId, selectedId, urlFiltersApplied]);

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
      // C3: `mine`/search/archived run their own chain, and it must stop for
      // the same reason the shared one does — polling a dead session burns
      // requests and keeps rewriting rows nobody can trust. No timer is armed
      // either; the recovery effect below restarts it.
      if (isAuthExpired()) return;
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
        // C3: an expired session is not a load error — the banner says it once,
        // in words, and no retry is armed because retrying cannot help.
        if (isAuthExpired()) return;
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

  // C3: the custom chain's half of the recovery. The shared chain restarts
  // itself (`watchAuthRecovery` in `requests-store.ts`); this one is owned
  // here, so it re-fetches here — the moment the session comes back, not on a
  // timer that was never armed.
  const wasAuthExpired = useRef(false);
  useEffect(() => {
    const recovered = wasAuthExpired.current && !authExpired;
    wasAuthExpired.current = authExpired;
    if (!recovered || !custom || selectedId) return;
    void loadCustom(customGenerationRef.current);
  }, [authExpired, custom, selectedId, loadCustom]);

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
   * W21.3 — the release, through the client that already owns it
   * (`lib/admin/release-client.ts`, the same `triggerProductionRelease`
   * `ReleaseWorkspace` calls). Nothing new is posted from here: there is ONE
   * release call, and it invalidates the shared release overview so the
   * Release surface cannot keep showing this build as still pending.
   *
   * `refresh()` afterwards because the request row's `live_path` is written by
   * the sweeper from the release's own confirmation — the row learns the URL
   * on a later poll, not from this response, and must not be made to claim it
   * sooner (guardrail 5).
   */
  /**
   * FIX 5 — the check that has to happen before a row may offer a deploy.
   *
   * The row knows nothing about what is pending, so it asks (the shared,
   * deduped, 15 s-cached overview `ReleaseWorkspace` already reads) and lets
   * `releaseConfirmation` decide what may be claimed. With nothing waiting
   * there is no confirm step to reach: the dialog says so and offers no
   * Release, which is the honest form of "unavailable" here — the button
   * performs a check, and only a checked release can be started.
   */
  const askToRelease = useCallback(
    async (target: RequestRowView) => {
      setBusy(true);
      try {
        const overview = await fetchReleaseOverview(getToken);
        setReleaseTarget({ row: target, confirmation: releaseConfirmation(releaseScopeFrom(overview, target)) });
      } catch (reason) {
        // Guardrail 5: unknown pending scope is not a reason to guess one, and
        // certainly not a reason to deploy anyway.
        toast({
          title: 'Could not check what is waiting to be released',
          description: reason instanceof Error ? reason.message : undefined,
          tone: 'danger',
        });
      } finally {
        setBusy(false);
      }
    },
    [toast]
  );

  const releaseSite = useCallback(async () => {
    setBusy(true);
    try {
      const result = await triggerProductionRelease(getToken);
      toast({
        title: result.released ? 'Release is live' : 'Release started',
        description: result.reason,
        tone: result.released ? 'success' : 'info',
      });
      refresh();
    } catch (reason) {
      toast({
        title: 'Release could not start',
        description: reason instanceof Error ? reason.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusy(false);
    }
  }, [refresh, toast]);

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

  // E3b: the standalone `/admin/requests/<id>` route's own object id, read
  // from the shared cache directly rather than the quick-filter-narrowed
  // `rows` below — a `running` selected request would otherwise vanish from
  // `rows` under the default `needsYou` filter and the open-draft link would
  // never appear for the one status it matters most on.
  const selectedRowObjectId = selectedId
    ? sharedIndex.rows?.find((row) => row.request_id === selectedId)?.object_id
    : undefined;

  const rows = useMemo(() => {
    if (custom) return sortRequestRows(customRows ?? []);
    const base = sharedIndex.rows ?? [];
    return sortRequestRows(
      base.filter(
        (row) => matchesQuickFilter(row, quickFilter, sharedIndex.muted) && (!kindFilter || row.kind === kindFilter)
      )
    );
  }, [custom, customRows, sharedIndex.rows, sharedIndex.muted, quickFilter, kindFilter]);

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
    // FIX 6: the filters ride along, so Back and Close return to the list the
    // person was actually looking at rather than to an unfiltered one.
    window.history.pushState({}, '', requestsAddress(urlFilters, row.request_id));
  };

  const closeDrawer = () => {
    setOpenId(undefined);
    window.history.pushState({}, '', requestsAddress(urlFilters));
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
    // W21.3: a release rebuilds and deploys the whole site, so it asks first
    // too — and FIX 5: it reads what is actually waiting before it asks, so
    // the question is about the real batch rather than about this row.
    onRelease: (target) => void askToRelease(target),
    onRaiseBudget: openDetail,
  };

  return (
    <div className="flex flex-col gap-4">
      {/* C3: above everything, because it changes how everything below must
          be read — and it stays until someone signs in. */}
      {authExpired ? <SessionExpiredBanner /> : null}
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
            <QuickFilterTabs value={quickFilter} onChange={onQuickFilterChange} />
            {/* B5: Search + Kind + Mine on one line — the notification settings
                (e-mail cadence, desktop alerts) are per-person preferences, not
                filters over the list, so they move behind a gear rather than
                competing with the filters for row space. */}
            <div className="my-3 flex flex-wrap items-end gap-2">
              <div className="min-w-[9rem]">
                <Select
                  label="Kind"
                  value={kindFilter}
                  onChange={(event) => onKindFilterChange(event.target.value)}
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
                  onChange={(event) => onQueryInputChange(event.target.value)}
                />
              </div>
              <label className="flex items-center gap-1.5 pb-2.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
                <input type="checkbox" checked={mine} onChange={(event) => onMineChange(event.target.checked)} /> Mine
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

        {/* C3: while the session is gone the banner above IS the explanation;
            a second, vaguer sentence in red only competes with it. */}
        {error && !authExpired ? (
          <p className="mb-2 text-[length:var(--adm-text-xs)] text-[var(--adm-danger)]">{error}</p>
        ) : null}

        {/* W19: on a single request, the full node timeline is the page — an
            editor who opened THIS request wants the detail, not a summary. */}
        {selectedId ? (
          /* C3: the single-request route has no rows to dim — the run's own
             timeline is what is stale here, so it dims instead. */
          <div className={`mb-3${authExpired ? ' opacity-50' : ''}`}>
            <RequestActivity
              requestId={selectedId}
              defaultExpanded
              onSettled={refresh}
              isOwner={isOwner}
              onRetry={() => void retryRun(selectedId)}
              // E3b: `sharedIndex.rows` (the shared cache's own, un-filtered-
              // by-quick-filter set — the doubly-filtered `rows` below can
              // exclude a `running` selected row entirely) rather than a
              // second fetch this route has never needed. Absent when the
              // id is outside that cache's cap: honest, not a guess.
              {...(selectedRowObjectId ? { objectId: selectedRowObjectId } : {})}
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
          /* C3: dimmed, so it is visible at a glance that these rows are a
             snapshot of a session that ended rather than current truth. The
             principle applied literally — the UI must not present stale rows
             as if they were live. `aria-hidden` is deliberately NOT set: the
             rows are still readable, just no longer trustworthy, and the
             banner above already says so. */
          <ul className={`flex flex-col${authExpired ? ' opacity-50' : ''}`}>
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
                  {/* D3: the object this request produced, one click from
                      open — every object id or title rendered in this admin
                      must carry an href (`tests/scripts/admin-object-links.test.mjs`),
                      and the request detail pane was the one place that
                      named the object with nothing to click. */}
                  {openRow.object_id ? (
                    <a
                      href={requestObjectHref(openRow.object_id)}
                      className="adm-focusable inline-flex items-center gap-1 rounded-[var(--adm-radius-pill)] bg-[var(--adm-surface-sunken)] px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
                    >
                      <IconExternalLink size={12} />
                      Object
                    </a>
                  ) : null}
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
                // E3b: `openRow` is this same drawer's own row (C1's
                // `object_id`) — the mid-run "open draft" link the run card
                // offers, not a second guess at where the object lives.
                {...(openRow?.object_id ? { objectId: openRow.object_id } : {})}
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

      {/* W21.3: the release is SITE-wide — `admin-release`'s options carry no
          object id — so the dialog says so rather than letting the row it was
          started from imply a scope the endpoint does not have. FIX 5: every
          sentence in it is now derived from the release overview
          (`releaseConfirmation`), and with nothing waiting there is no confirm
          to press. */}
      {releaseTarget?.confirmation.kind === 'confirm' ? (
        <ConfirmDialog
          open
          onClose={() => setReleaseTarget(undefined)}
          onConfirm={() => {
            setReleaseTarget(undefined);
            void releaseSite();
          }}
          title={releaseTarget.confirmation.title}
          message={releaseTarget.confirmation.message}
          confirmLabel={releaseTarget.confirmation.confirmLabel}
        />
      ) : null}
      <Dialog
        open={releaseTarget?.confirmation.kind === 'nothing_waiting'}
        onClose={() => setReleaseTarget(undefined)}
        title={releaseTarget?.confirmation.title ?? ''}
        size="sm"
        footer={
          <Button variant="secondary" onClick={() => setReleaseTarget(undefined)}>
            Close
          </Button>
        }
      >
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">
          {releaseTarget?.confirmation.message}
        </p>
      </Dialog>
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
