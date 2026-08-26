/**
 * T3.2 (T0.3 row A5) — the header "Needs you" pill, as a dropdown that
 * decides.
 *
 * D3 names the "header badge dropdown" as one of the three places a
 * needs-decision state must render its decision buttons WITH it. Until this
 * task the pill was a plain `<a href="/admin/requests?filter=needsYou">`
 * (`AdminShell.tsx:402-408`) — a navigation link, no decision anywhere near
 * it. It now opens a panel carrying the same Approve/Reject controls as the
 * inbox row, over the same rows, through the same façade
 * (`@core/lib/admin/decisions`) and the same shared store, so approving from
 * the header and approving from the inbox are one fact to both surfaces.
 *
 * Why a panel rather than the kit's `DropdownMenu`: that component is a
 * `role="menu"` of single-action `MenuItem`s (label + `onSelect`), and a row
 * here is not one action — it is a title, a severity badge, an age, a link and
 * an `<ActionRow>` that owns its own in-flight state. Forcing it into a menu
 * would either flatten the row or lie about the ARIA role, so this is a
 * labelled `dialog`-style disclosure instead — no new component library, the
 * same tokens, the same `<ActionRow>` the inbox and the request detail use.
 *
 * Two rows can appear here that carry NO decision: `stalled` (which joins the
 * amber `needs_you` count under `STALLED_VS_FAILED_SPLIT` but is a job that
 * has not moved, not a question anyone asked) and any row whose decision this
 * browser has already made. Both render with what IS available — the link to
 * the request — rather than an approve button that would do nothing.
 */
import { useEffect, useRef, useState } from 'react';
import { navigate } from 'astro:transitions/client';

import { Badge, Button } from './primitives';
import { ActionRow } from './approval';
import { SeverityIcon, StatusBadge } from './severity';
import { useToast } from './overlays';
import { cn } from './utils';
import { SEVERITY } from '@core/lib/admin/severity';
import type { GetToken } from '@core/lib/edit-mode/verbs-client';
import { matchesQuickFilter, relativeAge, requestSeverityLevel, sortRequestRows } from '@core/lib/admin/request-logic';
import { requestStatusLabel, type RequestRowView } from '@core/lib/admin/requests-client';
import { useDecisionOverlay, useRequestsIndex } from '@core/lib/admin/requests-store';
import { DECIDED_WAITING_LABEL, pendingDecisionForRequest } from '@core/lib/admin/decision-overlay';
import { assertDecided, canDecideRunPublish, decide, type DecisionAction } from '@core/lib/admin/decisions';

/** How many rows the panel shows before it stops and points at the full inbox. */
const PANEL_ROWS = 6;

const DENIED_REASON = 'You do not have publish-decision authority for this run.';

function NeedsYouRow({
  row,
  nowMs,
  canDecide,
  onDecide,
}: {
  row: RequestRowView;
  nowMs: number;
  canDecide: boolean;
  onDecide: (row: RequestRowView, decision: DecisionAction, reason?: string) => Promise<void>;
}) {
  const overlay = useDecisionOverlay();
  const decided = pendingDecisionForRequest(overlay, row.request_id);
  const level = requestSeverityLevel(row.status);
  return (
    <li className="border-b border-[var(--adm-border)] px-3 py-2.5 last:border-0">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 shrink-0">
          <SeverityIcon level={level} size={14} title="" />
        </span>
        <div className="min-w-0 flex-1">
          <a
            href={`/admin/requests/${encodeURIComponent(row.request_id)}`}
            className="adm-focusable block truncate rounded text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:text-[var(--adm-accent)]"
          >
            {row.title}
          </a>
          <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {row.status_reason ? `${row.status_reason} · ` : ''}
            {relativeAge(row.updated_at, nowMs)}
          </p>
        </div>
        {decided ? null : <StatusBadge level={level}>{requestStatusLabel(row.status)}</StatusBadge>}
      </div>
      <div className="mt-2 pl-6">
        {decided ? (
          // Optimistic, client-only: what this person decided, never a claim
          // about the run's status (W19 — only the sweeper writes that).
          <Badge tone="info">{DECIDED_WAITING_LABEL[decided.decision]}</Badge>
        ) : row.status === 'needs_you' ? (
          <ActionRow
            onApprove={() => onDecide(row, 'approve')}
            onReject={() => onDecide(row, 'reject')}
            /* No reason field exists on this mechanism — `decisions.ts`'s
               `reasonDroppedNote`. One click, no dead-end prompt. */
            rejectReason="none"
            disabledReason={canDecide ? undefined : DENIED_REASON}
            approveLabel="Approve"
            rejectLabel="Reject"
          />
        ) : (
          // A stalled run has not asked anyone a question — there is nothing
          // here to approve, and saying so beats an inert button.
          <p className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Nothing to decide yet — this one has not moved. Open it to see where it stopped.
          </p>
        )}
      </div>
    </li>
  );
}

export function NeedsYouMenu({
  getToken,
  count,
  roles,
  className,
}: {
  getToken: GetToken;
  count: number;
  roles: readonly string[];
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { toast } = useToast();
  const index = useRequestsIndex(getToken);
  const overlay = useDecisionOverlay();
  const canDecide = canDecideRunPublish(roles);

  useEffect(() => {
    if (!open) return;
    setNowMs(Date.now());
    const onDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const rows = sortRequestRows((index.rows ?? []).filter((row) => matchesQuickFilter(row, 'needsYou', index.muted)));
  const shown = rows.slice(0, PANEL_ROWS);

  const onDecide = async (row: RequestRowView, decision: DecisionAction, reason?: string) => {
    const result = await decide(
      getToken,
      { mechanism: 'workflow_gate', requestId: row.request_id, canApprove: canDecide },
      decision,
      reason ? { reason } : {}
    );
    assertDecided(result);
    toast({ title: row.title, description: result.receipt, tone: 'success' });
  };

  const family = SEVERITY.needs_you.tokens.family;
  const waiting = rows.filter((row) => pendingDecisionForRequest(overlay, row.request_id)).length;

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium',
          // One literal pair, same Tailwind-scanner constraint `severity.tsx`
          // documents for `PILL_TONE` — the class cannot be assembled.
          family === 'warning' ? 'bg-[var(--adm-warning-soft)] text-[var(--adm-warning-text)]' : ''
        )}
      >
        <SeverityIcon level="needs_you" size={12} title="" />
        {SEVERITY.needs_you.label} · {count}
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Requests that need you"
          className="absolute right-0 top-full z-50 mt-1 w-[22rem] max-w-[calc(100vw-2rem)] overflow-hidden rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] shadow-[var(--adm-shadow-lg)]"
        >
          <div className="flex items-center justify-between gap-2 border-b border-[var(--adm-border)] px-3 py-2">
            <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
              Needs you
            </p>
            {waiting > 0 ? <Badge tone="info">{waiting} applying</Badge> : null}
          </div>
          {shown.length === 0 ? (
            <p className="px-3 py-4 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              Nothing is waiting on you right now.
            </p>
          ) : (
            <ul className="max-h-[60vh] overflow-y-auto">
              {shown.map((row) => (
                <NeedsYouRow key={row.request_id} row={row} nowMs={nowMs} canDecide={canDecide} onDecide={onDecide} />
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between gap-2 border-t border-[var(--adm-border)] px-3 py-2">
            <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {rows.length > shown.length ? `${rows.length - shown.length} more waiting` : ''}
            </span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                void navigate('/admin/requests?filter=needsYou');
              }}
            >
              Open the inbox
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
