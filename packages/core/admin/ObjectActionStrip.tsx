/**
 * ASV2-W3 — the object action strip, rendered.
 *
 * A row of deterministic verbs the agent sits next to, so the editor clicks
 * the verb instead of asking for it. Two affordances, ONE registry
 * (`lib/admin/quick-actions.ts`) resolved through ONE decision module
 * (`lib/admin/object-action-strip.ts`):
 *
 *   `<ObjectActionStrip>`  — buttons, in the dock's `aboveComposer` slot
 *   `<ObjectActionMenu>`   — the same entries as a row `⋯` menu, in the lists
 *
 * Neither names a verb, a label, a rights list or a wire body. If you find
 * yourself typing a verb name into this file, the registry is the place.
 *
 * Three things this file owns, because none of them can live in a pure
 * module: what a mode LOOKS like, where the popover is anchored, and who the
 * receipt is told.
 *
 *   immediate     → run the verb, toast the receipt, trace it
 *   popover       → one field anchored under the control, then the same
 *   chat-handoff  → seed this object's composer with the registry's prompt
 *
 * A control the viewer may not run renders DISABLED WITH THE REASON IN A
 * TOOLTIP, never hidden — `resolveObjectControls`'s convention, expressed in
 * its own `ControlState` shape rather than a second one. The button path
 * wraps a disabled control in `Popover mode="hover"` (which is built for
 * exactly this: a `title=` on a disabled button reaches a mouse and nothing
 * else); the menu path hands the reason to `MenuItem.title`, which
 * `menus.tsx` already renders as that same Popover on a focusable
 * `aria-disabled` item.
 */
import { useCallback, useRef, useState } from 'react';

import { Button } from './primitives';
import { DropdownMenu } from './menus';
import { IconDots } from './icons';
import { Popover, useToast, type PopoverTriggerA11yProps } from './overlays';
import { QuickActionPopover } from './QuickActions';
import { cn } from './utils';
import {
  resolveActionStrip,
  actionTraceDelivery,
  type ActionStripEntry,
} from '@core/lib/admin/object-action-strip';
import { runQuickAction, type QuickActionValues } from '@core/lib/admin/quick-actions';
import type { ControlState } from '@core/lib/admin/object-detail-actions';
import type { LibraryRow } from '@core/lib/admin/library-logic';

/** The same two-line adapter `QuickActions.tsx` uses — the admin's one verb door. */
async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

const callVerb = async (body: Record<string, unknown>) => {
  const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
  return callObjectVerb(getToken, body);
};

/**
 * How this surface writes the run into the transcript (W3.3).
 *
 * `bound` is the surface's own answer to "does a conversation for this object
 * already exist" — a held `chatId` on the object workspace,
 * `dockChatIntent('send', …) === 'attach'` on the list surfaces. It is asked
 * rather than assumed because `send` on those surfaces is the LAZY BINDING:
 * it mints a chat when there is none, and a trace must never be the thing
 * that mints one. `actionTraceDelivery` owns that decision and is tested.
 */
export interface ObjectActionTrace {
  bound: boolean;
  send: (text: string) => void | Promise<void>;
}

export interface ObjectActionSurfaceProps {
  row: LibraryRow;
  /** The signed-in caller's roles, as `useCurrentUser()` reports them. */
  roles: readonly string[];
  /** Ids this surface already offers through its own controls (nothing is hidden — see the module). */
  exclude?: readonly string[];
  /** A surface's authoritative gate for an id it owns (`objectControlOverrides`). */
  overrides?: Readonly<Partial<Record<string, ControlState>>>;
  /**
   * Seed this object's composer with a hand-off prompt. Required in practice
   * on every surface that mounts the strip, since all three host the dock;
   * without it a hand-off has nowhere to go and the entry is disabled saying
   * so, rather than opening a chat the editor did not ask for.
   */
  onSeedComposer?: (prompt: string) => void;
  trace?: ObjectActionTrace;
  /** Called after an action changed the record, so the surface can refetch. */
  onChanged?: () => void;
  className?: string;
}

const NO_CHAT_REASON = 'This action needs the agent, and this surface has no conversation to hand it to.';

/**
 * The shared execution machine. Every renderer calls this and none owns a
 * copy of the run/toast/trace sequence.
 *
 * Exported since ASV2-W4.2: §6.1's `actions` card in the transcript is a THIRD
 * affordance for the same registry (buttons the agent asked for, rather than
 * buttons the surface offers), and it dispatches through this hook rather than
 * growing a second executor. `ControlsCard.tsx` supplies its own `trace` so
 * the run's trace line and the block's `[controls:<id>] ran <verb>` receipt
 * ride one message; everything else — rights, overrides, the popover, the
 * toast, the hand-off — is unchanged and unduplicated.
 */
export function useObjectActions({
  row,
  roles,
  exclude,
  overrides,
  onSeedComposer,
  trace,
  onChanged,
}: ObjectActionSurfaceProps) {
  const { toast } = useToast();
  const [openId, setOpenId] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();
  const anchorRef = useRef<HTMLElement | null>(null);

  const entries = resolveActionStrip({
    row,
    roles,
    ...(exclude ? { exclude } : {}),
    ...(overrides ? { overrides } : {}),
  }).map((entry) =>
    entry.execution === 'chat-handoff' && !onSeedComposer && entry.state.enabled
      ? { ...entry, state: { enabled: false, reason: NO_CHAT_REASON } as ControlState }
      : entry
  );

  const run = useCallback(
    async (entry: ActionStripEntry, values: QuickActionValues) => {
      setBusyId(entry.id);
      const result = await runQuickAction(callVerb, entry, row, values);
      setBusyId(undefined);
      setOpenId(undefined);
      toast({
        title: result.ok ? entry.label : `${entry.label} didn't run`,
        description: result.receipt,
        tone: result.ok ? 'success' : 'danger',
      });
      // W3.3 — the transcript stays the record. An ordinary user message
      // through the chat path that already exists; no new event type, no
      // server change. `skip` is a decision, not a failure: see the module.
      const delivery = actionTraceDelivery({
        chatBound: trace?.bound === true,
        execution: entry.execution,
        verb: entry.verb,
        label: entry.label,
        receipt: result.receipt,
      });
      if (delivery.kind === 'send' && trace) await trace.send(delivery.text);
      // A preview writes nothing, so it is not a reason to refetch.
      if (result.ok && values.mode !== 'preview') onChanged?.();
    },
    [onChanged, row, toast, trace]
  );

  const activate = useCallback(
    (entry: ActionStripEntry, anchor: HTMLElement | null) => {
      if (!entry.state.enabled || busyId) return;
      anchorRef.current = anchor;
      if (entry.execution === 'immediate') void run(entry, {});
      else if (entry.execution === 'popover') setOpenId((current) => (current === entry.id ? undefined : entry.id));
      else onSeedComposer?.(entry.prompt ?? '');
    },
    [busyId, onSeedComposer, run]
  );

  return {
    entries,
    openId,
    busyId,
    anchorRef,
    activate,
    confirm: (entry: ActionStripEntry, values: QuickActionValues) => void run(entry, values),
    cancel: () => setOpenId(undefined),
  };
}

/** An ellipsis is the honest signal that the click opens something rather than doing the thing. */
const entryLabel = (entry: ActionStripEntry): string =>
  entry.execution === 'immediate' ? entry.label : `${entry.label}…`;

// ─── the strip ──────────────────────────────────────────────────────────────

/**
 * The dock's row of verbs, in `AgentRail`'s `aboveComposer` slot. Horizontally
 * scrollable rather than wrapping: the dock is 384px wide and a verb row that
 * grows to three lines pushes the transcript off the bottom of the panel.
 */
export function ObjectActionStrip(props: ObjectActionSurfaceProps) {
  const { entries, openId, busyId, anchorRef, activate, confirm, cancel } = useObjectActions(props);
  if (!entries.length) return null;

  const openEntry = entries.find((entry) => entry.id === openId);

  return (
    <div
      className={cn('flex items-center gap-1.5 overflow-x-auto pb-1', props.className)}
      role="group"
      aria-label="Object actions"
    >
      {entries.map((entry) => {
        const busy = busyId === entry.id;
        const button = (a11y?: PopoverTriggerA11yProps) => (
          <Button
            size="sm"
            variant="secondary"
            disabled={!entry.state.enabled || Boolean(busyId)}
            loading={busy}
            aria-expanded={entry.execution === 'popover' ? openId === entry.id : undefined}
            onClick={(event) => activate(entry, event.currentTarget)}
            className="shrink-0"
            {...a11y}
          >
            {entryLabel(entry)}
          </Button>
        );
        // Convention D3: the reason must be reachable by keyboard and touch,
        // which is what `Popover`'s `disabled` mode is for. An enabled control
        // shows what it is about to do in the same place.
        return (
          <Popover
            key={entry.id}
            mode="hover"
            content={entry.state.enabled ? entry.title : (entry.state.reason ?? entry.title)}
            disabled={!entry.state.enabled}
            trigger={(a11y) => button(a11y)}
          />
        );
      })}
      {openEntry ? (
        <QuickActionPopover
          chip={{ ...openEntry, onSelect: () => {} }}
          anchor={anchorRef.current}
          busy={busyId === openEntry.id}
          onConfirm={(values) => confirm(openEntry, values)}
          onCancel={cancel}
        />
      ) : null}
    </div>
  );
}

// ─── the same entries, as a row menu ────────────────────────────────────────

/**
 * The row `⋯` in a list. Same registry, same execution, same reasons — the
 * only difference is that a list row has no space for a strip.
 *
 * The popover anchors to this wrapper (which is the trigger's own box) rather
 * than to the menu item: the menu closes on select, so by the time a
 * one-parameter action opens its field there is no item left to hang it from.
 */
export function ObjectActionMenu(props: ObjectActionSurfaceProps & { label?: string }) {
  const { entries, openId, busyId, anchorRef, activate, confirm, cancel } = useObjectActions(props);
  const wrapRef = useRef<HTMLSpanElement>(null);
  if (!entries.length) return null;

  const openEntry = entries.find((entry) => entry.id === openId);

  return (
    <span ref={wrapRef} className={cn('inline-flex', props.className)}>
      <DropdownMenu
        align="end"
        trigger={({ ref, onToggle, open }) => (
          <button
            ref={ref}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              onToggle();
            }}
            aria-expanded={open}
            aria-label={props.label ?? `Actions for ${props.row.display_name}`}
            className="adm-focusable grid h-7 w-7 shrink-0 place-items-center rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
          >
            <IconDots size={16} />
          </button>
        )}
        items={entries.map((entry) => ({
          id: entry.id,
          label: entryLabel(entry),
          disabled: !entry.state.enabled || Boolean(busyId),
          // Enabled: what it will do. Disabled: why it cannot. `menus.tsx`
          // renders either as the same reachable Popover.
          title: entry.state.enabled ? entry.title : (entry.state.reason ?? entry.title),
          onSelect: () => activate(entry, wrapRef.current),
        }))}
      />
      {openEntry ? (
        <QuickActionPopover
          chip={{ ...openEntry, onSelect: () => {} }}
          anchor={anchorRef.current}
          busy={busyId === openEntry.id}
          onConfirm={(values) => confirm(openEntry, values)}
          onCancel={cancel}
        />
      ) : null}
    </span>
  );
}
