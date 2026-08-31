/**
 * Admin kit — approval primitives (T1.2): `<ApprovalCard>`, `<ActionRow>`,
 * `<RunProgress>`.
 *
 * Builds on D4 (`@core/lib/admin/severity`, `./severity.tsx`, T1.1) rather
 * than inventing a second status vocabulary — every color/glyph here comes
 * from `SEVERITY` or an `--adm-*` token, never a literal hex.
 *
 * D9 — approval cards go flat: single border, one background, inline button
 * row, no nested cards/frames, no accordion. `<ApprovalCard>` enforces this
 * STRUCTURALLY, not just by convention — see its own comment below for the
 * exact invariant and how to keep it true when editing this file.
 *
 * D3 — decision buttons render WITH the state, never a text-only "supply
 * approval". `<ActionRow>` always renders its buttons; when the viewer lacks
 * rights they render disabled with a `title` explaining why (T0.3 row A4),
 * they are never hidden.
 *
 * Vocabulary ruling (T1.2 brief): the three decision actions are **Approve**,
 * **Reject**, **Modify** — see `docs/plan/ux-inventory.md` Table C
 * ("Decision-reject/decision-modify button") for the four different words the
 * codebase used for these same two non-Approve actions. The convergence is
 * finished: A7 deleted `chat.tsx`'s own older `ApprovalCard` and moved the
 * chat's pending tool-call onto this one, so every approval surface now
 * renders these buttons, with these words, from `DECISION_LABEL`
 * (`@core/lib/admin/approval-actions`, where `DECISION_KEYS` and its test
 * hold the invariant).
 *
 * These are primitives + a kit demo only — nothing here calls a decision
 * endpoint. T0.1 found three separate decision mechanisms (object
 * `review_decide`, chat `approve_tool`/`deny_tool`, workflow
 * `decideRunPublish`) and no single endpoint unifying them, so `ActionRow`'s
 * callback props are plain endpoint-agnostic `() => Promise<void>` /
 * `(reason?: string) => Promise<void>` functions — the caller (T3.2) decides
 * which mechanism a given callback actually calls.
 */
import { useEffect, useReducer, useRef } from 'react';
import type { ReactNode } from 'react';

import { SEVERITY, type AdminSeverity, type SeverityTokenFamily } from '@core/lib/admin/severity';
import { formatDuration, formatUsd } from '@core/lib/admin/requests-client';
import {
  canConfirmReason,
  needsReasonCapture,
  DECISION_LABEL,
  DECISION_PENDING_LABEL,
  decisionFailedTitle,
  INITIAL_ACTION_ROW_STATE,
  isActionRowBusy,
  reduceActionRow,
  runStepLabel,
  runStepPercent,
  type DecisionKey,
  type ReasonRequirement,
} from '@core/lib/admin/approval-actions';
import { Button, type ButtonProps } from './primitives';
import { Textarea } from './forms';
import { Popover, useToast } from './overlays';
import { SeverityIcon } from './severity';
import { cn } from './utils';

/** Icon-chip soft tint, one literal pair per family — same Tailwind-scanner
 * constraint `severity.tsx`'s `PILL_TONE` documents (content-scanned classes
 * must appear literally in source, not be assembled from the token name). */
const CHIP_SOFT: Record<SeverityTokenFamily, string> = {
  info: 'bg-[var(--adm-info-soft)]',
  success: 'bg-[var(--adm-success-soft)]',
  warning: 'bg-[var(--adm-warning-soft)]',
  danger: 'bg-[var(--adm-danger-soft)]',
};

/** Progress-bar fill per family — same shape as `RequestActivity.tsx`'s `PROGRESS_FILL`. */
const BAR_FILL: Record<SeverityTokenFamily, string> = {
  info: 'bg-[var(--adm-info)]',
  success: 'bg-[var(--adm-success)]',
  warning: 'bg-[var(--adm-warning)]',
  danger: 'bg-[var(--adm-danger)]',
};

/**
 * One decision button, gated per Convention D3 (disabled with a reason,
 * never hidden). A plain `title=` on a disabled `<button>` only ever reached
 * a mouse — this is exactly what T0's `Popover` (hover mode) exists to fix:
 * `disabled` on `Popover` moves the listeners onto a focusable wrapper span
 * so the reason opens on keyboard focus and stays tappable on touch, not
 * just a mouse hover. Only wraps in a `Popover` when there IS a reason —
 * a transiently `busy`-disabled button (no `blockedReason`) needs no tooltip,
 * its spinner already says why.
 */
function DecisionButton({ blockedReason, disabled, ...buttonProps }: { blockedReason?: string } & ButtonProps) {
  if (!blockedReason) return <Button disabled={disabled} {...buttonProps} />;
  return (
    <Popover
      mode="hover"
      content={blockedReason}
      disabled
      trigger={(a11y) => <Button {...buttonProps} disabled {...a11y} />}
    />
  );
}

// ─── ActionRow ──────────────────────────────────────────────────────────────

/**
 * A capture that is richer than a one-line reason. `validate` is the load-
 * bearing part: returning a message keeps the row in capture WITH the typed
 * text (a `refuse_draft` in `reduceActionRow`), where a handler that simply
 * threw would settle the row and drop the draft on the floor.
 */
export interface DraftCapture {
  /** Prefill — the chat's Modify opens on the call's current arguments. */
  initial?: string;
  rows?: number;
  /** Overrides the `"<Action> reason"` aria-label and the placeholder. */
  label?: string;
  placeholder?: string;
  validate?: (draft: string) => string | undefined;
}

export interface ActionRowProps {
  /** Omit to not offer that action at all — each of the three is independently optional. */
  onApprove?: () => Promise<void>;
  onReject?: (reason?: string) => Promise<void>;
  onModify?: (reason?: string) => Promise<void>;
  approveLabel?: string;
  rejectLabel?: string;
  modifyLabel?: string;
  /** Whether Reject's/Modify's in-place textarea must have text before Confirm enables.
   * Default 'optional', mirroring the chat reject→reason→confirm flow this
   * mirrors (its reason is optional — "Why? (optional — the agent sees this)"). */
  rejectReason?: ReasonRequirement;
  modifyReason?: ReasonRequirement;
  /**
   * A7 — Modify does not always capture a free-text "why". On a chat tool
   * call it captures the tool's ARGUMENTS, re-approved: the box opens on the
   * current JSON, needs more than two rows, and must refuse a draft that
   * does not parse instead of settling and losing the edit. One prop
   * describes that capture rather than four parallel ones; omitting it
   * leaves every existing caller on the plain reason textarea.
   */
  modifyCapture?: DraftCapture;
  /** Non-decision actions — Open chat, Mute, Archive. Rendered flush right of the
   * decision buttons. A destructive one (e.g. Archive) should confirm itself through
   * the existing `ConfirmDialog` overlay — ActionRow does not add a second confirmation
   * mechanism of its own for Reject/Modify, which use the in-place reason swap instead. */
  secondary?: ReactNode;
  /** Rights-gated case (T0.3 row A4): buttons render disabled with this as the
   * tooltip/title explaining why, rather than being hidden. */
  disabledReason?: string;
  /**
   * Per-action override of `disabledReason` (T2.2). The three decisions do not
   * always share one availability — an object with no review yet is directly
   * approvable but has nothing to request changes ON (`object-review-ui.ts`'s
   * `canApprove` vs `canRequestChanges`) — and A4 wants the button that is
   * unavailable disabled with ITS OWN reason, not the whole row disabled with
   * someone else's. Each falls back to `disabledReason` when unset, so every
   * pre-existing caller renders exactly as before.
   */
  approveDisabledReason?: string;
  rejectDisabledReason?: string;
  modifyDisabledReason?: string;
  className?: string;
}

/**
 * The inline decision button row. Always renders its buttons — no accordion,
 * no "show actions" toggle, no `<details>` — and owns its own pending state
 * (via `reduceActionRow`, `@core/lib/admin/approval-actions`) so a caller's
 * callback is a plain promise-returning function, nothing more. A rejected
 * promise returns the row to rest and surfaces the error through the shared
 * toast (`useToast`) rather than leaving a button stuck spinning.
 */
export function ActionRow({
  onApprove,
  onReject,
  onModify,
  approveLabel = DECISION_LABEL.approve,
  rejectLabel = DECISION_LABEL.reject,
  modifyLabel = DECISION_LABEL.modify,
  rejectReason = 'optional',
  modifyReason = 'optional',
  modifyCapture,
  secondary,
  disabledReason,
  approveDisabledReason,
  rejectDisabledReason,
  modifyDisabledReason,
  className,
}: ActionRowProps) {
  const [state, dispatch] = useReducer(reduceActionRow, INITIAL_ACTION_ROW_STATE);
  const { toast } = useToast();
  const busy = isActionRowBusy(state);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // T6.1 (a11y acceptance criterion): the reason textarea must take focus
  // the moment it swaps in — a keyboard user who just pressed Reject/Modify
  // would otherwise land nowhere.
  useEffect(() => {
    if (state.reasonFor) reasonRef.current?.focus();
  }, [state.reasonFor]);
  const approveBlocked = approveDisabledReason ?? disabledReason;
  const rejectBlocked = rejectDisabledReason ?? disabledReason;
  const modifyBlocked = modifyDisabledReason ?? disabledReason;

  const runDecision = async (key: DecisionKey, handler: (reason?: string) => Promise<void>, reason?: string) => {
    dispatch({ type: 'begin', action: key });
    try {
      await handler(reason);
      dispatch({ type: 'settle' });
    } catch (err) {
      dispatch({ type: 'settle' });
      toast({
        title: decisionFailedTitle(key),
        description: err instanceof Error ? err.message : String(err),
        tone: 'danger',
      });
    }
  };

  if (state.reasonFor) {
    const key = state.reasonFor;
    const requirement = key === 'reject' ? rejectReason : modifyReason;
    const handler = key === 'reject' ? onReject : onModify;
    const label = key === 'reject' ? rejectLabel : modifyLabel;
    const capture = key === 'modify' ? modifyCapture : undefined;
    const confirmEnabled = canConfirmReason(state, requirement) && !busy;
    return (
      <div className={cn('flex flex-col gap-2', className)}>
        <Textarea
          ref={reasonRef}
          value={state.reasonDraft}
          onChange={(event) => dispatch({ type: 'edit_reason', text: event.target.value })}
          onKeyDown={(event) => {
            // T6.1 (a11y acceptance criterion): Escape cancels the reason
            // capture and returns to the Approve/Reject/Modify row.
            if (event.key === 'Escape') {
              event.stopPropagation();
              dispatch({ type: 'cancel_reason' });
            }
          }}
          rows={capture?.rows ?? 2}
          placeholder={
            capture?.placeholder ??
            (requirement === 'required'
              ? 'Why? (required — the agent sees this)'
              : 'Why? (optional — the agent sees this)')
          }
          aria-label={capture?.label ?? `${label} reason`}
          disabled={busy}
          {...(state.draftError ? { error: state.draftError } : {})}
        />
        <div className="flex gap-2">
          <Button
            size="sm"
            variant={key === 'reject' ? 'danger' : 'primary'}
            loading={state.pending === key}
            disabled={!confirmEnabled}
            onClick={() => {
              // Validation first, and only on the way OUT of the capture —
              // typing invalid JSON is a normal intermediate state, being
              // told about it on every keystroke is not.
              const problem = capture?.validate?.(state.reasonDraft);
              if (problem) {
                dispatch({ type: 'refuse_draft', message: problem });
                return;
              }
              if (handler) void runDecision(key, handler, state.reasonDraft.trim() || undefined);
            }}
          >
            {state.pending === key ? DECISION_PENDING_LABEL[key] : `Confirm ${label.toLowerCase()}`}
          </Button>
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => dispatch({ type: 'cancel_reason' })}>
            Cancel
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {onApprove ? (
        <DecisionButton
          size="sm"
          loading={state.pending === 'approve'}
          disabled={busy}
          blockedReason={approveBlocked}
          onClick={() => void runDecision('approve', () => onApprove())}
        >
          {state.pending === 'approve' ? DECISION_PENDING_LABEL.approve : approveLabel}
        </DecisionButton>
      ) : null}
      {onReject ? (
        <DecisionButton
          size="sm"
          variant="secondary"
          loading={state.pending === 'reject'}
          disabled={busy}
          blockedReason={rejectBlocked}
          onClick={() =>
            // T3.2: a mechanism with nowhere to put the reviewer's words
            // (`rejectReason='none'`) decides on the click rather than opening
            // a textarea whose contents would be dropped. Independent of
            // whether the button is available at all (T2.2's per-action
            // `rejectBlocked`) — availability gates the click, the reason
            // requirement only decides what the click does.
            needsReasonCapture(rejectReason)
              ? dispatch({ type: 'request_reason', action: 'reject' })
              : void runDecision('reject', onReject)
          }
        >
          {state.pending === 'reject' ? DECISION_PENDING_LABEL.reject : rejectLabel}
        </DecisionButton>
      ) : null}
      {onModify ? (
        <DecisionButton
          size="sm"
          variant="secondary"
          loading={state.pending === 'modify'}
          disabled={busy}
          blockedReason={modifyBlocked}
          onClick={() =>
            needsReasonCapture(modifyReason)
              ? dispatch({
                  type: 'request_reason',
                  action: 'modify',
                  ...(modifyCapture?.initial !== undefined ? { draft: modifyCapture.initial } : {}),
                })
              : void runDecision('modify', onModify)
          }
        >
          {state.pending === 'modify' ? DECISION_PENDING_LABEL.modify : modifyLabel}
        </DecisionButton>
      ) : null}
      {secondary ? <div className="ml-auto flex shrink-0 items-center gap-1">{secondary}</div> : null}
    </div>
  );
}

// ─── ApprovalCard ───────────────────────────────────────────────────────────

export interface ApprovalCardMeta {
  age?: ReactNode;
  cost?: ReactNode;
  requester?: ReactNode;
}

export interface ApprovalCardProps {
  severity?: AdminSeverity;
  title: ReactNode;
  /** The one-line reason — required. D4's needs-you copy is imperative and
   * blocked copy is cause + escape hatch; either way, one line always exists. */
  cause: ReactNode;
  meta?: ApprovalCardMeta;
  actions: Omit<ActionRowProps, 'disabledReason'>;
  /** Optional details region (e.g. a diff, proposed arguments). Rendered
   * below the action row — never behind a disclosure, since D9 requires the
   * actions themselves to already be visible without expanding anything;
   * `children` is additional context, not where the buttons live. */
  children?: ReactNode;
  /** Rights-gated case — passed straight through to `ActionRow`. */
  disabledReason?: string;
  className?: string;
}

/**
 * D9, made structural rather than a matter of styling discipline:
 *
 * - Exactly ONE `border` utility exists anywhere in this component's markup
 *   — the outer container below. There is no second bordered element, so
 *   there is no way to render a nested card/frame inside it without adding
 *   a second `border-*` class that a reviewer (or a future edit) can spot by
 *   grepping this file for `border` and counting to one.
 * - Exactly TWO `bg-*` utilities exist in this component's own markup: the
 *   card surface (`--adm-surface-raised`) and the severity icon chip's soft
 *   tint (`CHIP_SOFT`). No third background is introduced here — status is
 *   never painted as a full tinted panel behind the card (contrast the
 *   sunken `bg-[var(--adm-surface-sunken)]` panel the chat's own pre-D9
 *   approval card used, deleted in A7, and `RequestActivity.tsx`'s full
 *   `bg-[var(--adm-warning-soft)]` "Waiting for you" section). `Button`/`Textarea` bring their
 *   own control chrome from the shared primitives — that is unavoidable
 *   interactive-control styling, not a second status panel, and is not
 *   counted against this card's own two.
 * - No `<details>`, no expand/collapse state, no second status badge:
 *   `ActionRow`'s buttons are unconditionally in the returned tree, and the
 *   D4 icon + the `cause` line are the only status signal.
 */
export function ApprovalCard({
  severity = 'needs_you',
  title,
  cause,
  meta,
  actions,
  children,
  disabledReason,
  className,
}: ApprovalCardProps) {
  const def = SEVERITY[severity];
  const metaLine = meta ? [meta.requester, meta.age, meta.cost].filter(Boolean) : [];
  const hasDecision = Boolean(actions.onApprove || actions.onReject || actions.onModify || actions.secondary);

  return (
    <div
      className={cn(
        'flex flex-col gap-3 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-3 shadow-[var(--adm-shadow-sm)]',
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <span
          className={cn(
            'mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
            CHIP_SOFT[def.tokens.family]
          )}
        >
          <SeverityIcon level={severity} size={14} title="" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text-heading)]">{title}</p>
          <p className="mt-0.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{cause}</p>
          {metaLine.length > 0 ? (
            <p className="mt-1 flex flex-wrap items-center gap-x-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
              {metaLine.map((part, index) => (
                <span key={index}>
                  {index > 0 ? <span aria-hidden="true">· </span> : null}
                  {part}
                </span>
              ))}
            </p>
          ) : null}
        </div>
      </div>
      {/* A card whose decision belongs to ANOTHER surface passes no
          callbacks (ux-inventory A9: a sequential proposal is decided on the
          Object Stage, and this card names it in `cause`). That is the one
          case with no row to render — it is not a D3 exception, since there
          is no action here to hide; every card that CAN decide still renders
          its buttons unconditionally. */}
      {hasDecision ? <ActionRow {...actions} disabledReason={disabledReason} /> : null}
      {children ? <div className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{children}</div> : null}
    </div>
  );
}

// ─── RunProgress ────────────────────────────────────────────────────────────

export interface RunProgressProps {
  step: number;
  totalSteps: number;
  /** The current step's name, e.g. "Drafting the outline". */
  label: string;
  elapsedMs?: number;
  costUsd?: number;
  /** Tints the bar fill; defaults to the neutral accent (an ordinary run in progress). */
  severity?: AdminSeverity;
  className?: string;
}

/**
 * The ambient/progress tier of D5 (T3.1 consumes this for the live run
 * view). One line — step count, the step's name, elapsed time, cost — plus a
 * thin bar. No existing `Progress` component was found in this package
 * (grepped `primitives.tsx`/admin dir for `Progress`/`Spinner`; the closest
 * precedent is `RequestActivity.tsx`'s inline node-progress bar, which this
 * mirrors rather than duplicates as a shared component would be a larger
 * refactor than T1.2's scope) — this is that minimal bar, built once here.
 */
export function RunProgress({ step, totalSteps, label, elapsedMs, costUsd, severity, className }: RunProgressProps) {
  const percent = runStepPercent(step, totalSteps);
  const stepLabel = runStepLabel(step, totalSteps);
  const fill = severity ? BAR_FILL[SEVERITY[severity].tokens.family] : 'bg-[var(--adm-accent)]';

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-2 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
        <span className="shrink-0 font-medium text-[var(--adm-text)]">{stepLabel}</span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex shrink-0 items-center gap-2 tabular-nums">
          {elapsedMs !== undefined ? <span>{formatDuration(elapsedMs)}</span> : null}
          {costUsd !== undefined ? <span>{formatUsd(costUsd)}</span> : null}
        </span>
      </div>
      <span
        className="block h-1 w-full overflow-hidden rounded-[var(--adm-radius-pill)] bg-[var(--adm-border)]"
        role="progressbar"
        aria-valuenow={Math.max(0, Math.min(step, totalSteps))}
        aria-valuemin={0}
        aria-valuemax={totalSteps}
        aria-valuetext={`${stepLabel} · ${percent}%`}
      >
        <span
          className={cn('block h-full rounded-[var(--adm-radius-pill)] transition-[width]', fill)}
          style={{ width: `${percent}%` }}
        />
      </span>
    </div>
  );
}
