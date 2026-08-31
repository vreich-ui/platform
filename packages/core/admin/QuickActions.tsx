/**
 * Quick-action chips, rendered (T3.3, design decision D6).
 *
 * The registry (`lib/admin/quick-actions.ts`) decides WHICH chips exist and
 * in which of the three execution modes; this file is the only place that
 * knows what those modes look like on screen:
 *
 *   immediate     → run the verb, toast the receipt
 *   popover       → one field anchored under the chip, then run the verb
 *   chat-handoff  → open this object's chat with the prompt prefilled
 *
 * Both surfaces render through `QuickActionChips` rather than mapping the
 * chip array themselves, because a popover cannot live inside a
 * `() => void`: the chip's `onSelect` raises intent, this component owns the
 * field, the busy state and the receipt. The registry's contract is
 * unchanged — `resolve({row, roles, getToken})` still returns
 * `{id, label, onSelect}` — and rights-gating still happens inside `resolve`.
 * The one thing this file filters is `exclude`: chips a surface already
 * offers through its own controls, so the workspace does not grow a second
 * Publish button beside the first one.
 *
 * Nothing in here is a new component kit: native inputs, the existing
 * `Button` primitive, `--adm-*` tokens, and the shared `.adm-focusable` ring,
 * exactly as `ControlsCard.tsx` does it. The popover is portalled and
 * fixed-positioned for the same reason `menus.tsx`'s dropdown is — a chip in
 * a `DataTable` row sits inside an `overflow-x-auto` container that would
 * otherwise clip it.
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { navigate } from 'astro:transitions/client';

import { Button } from './primitives';
import { Popover, useToast } from './overlays';
import { cn } from './utils';
import {
  DEFAULT_QUICK_ACTION_REGISTRY,
  runQuickAction,
  type QuickActionChip,
  type QuickActionValues,
} from '@core/lib/admin/quick-actions';
import type { LibraryRow } from '@core/lib/admin/library-logic';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

/** The one verb caller, shaped as `bulk-object-ops.ts`'s injectable `VerbCaller`. */
const callVerb = async (body: Record<string, unknown>) => {
  const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
  return callObjectVerb(getToken, body);
};

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;
const POPOVER_WIDTH = 256;

// ─── the single-field popover ───────────────────────────────────────────────

/**
 * One field, one confirm. Dismissed by Escape, an outside click, or a scroll
 * that would leave it stranded — the dismissal idiom `menus.tsx` already
 * uses, minus the keyboard roving a single radio group does not need.
 */
function QuickActionPopover({
  chip,
  anchor,
  busy,
  onConfirm,
  onCancel,
}: {
  chip: QuickActionChip;
  anchor: HTMLElement | null;
  busy: boolean;
  onConfirm: (values: QuickActionValues) => void;
  onCancel: () => void;
}) {
  const param = chip.params[0];
  const field = param?.field;
  const [value, setValue] = useState(field?.kind === 'choice' ? field.value : '');
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    setPosition({
      top: rect.bottom + POPOVER_GAP,
      left: Math.max(VIEWPORT_MARGIN, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - VIEWPORT_MARGIN)),
    });
    // A fixed panel does not travel with its trigger — close rather than drift.
    window.addEventListener('scroll', onCancel, true);
    window.addEventListener('resize', onCancel);
    return () => {
      window.removeEventListener('scroll', onCancel, true);
      window.removeEventListener('resize', onCancel);
    };
  }, [anchor, onCancel]);

  useEffect(() => {
    const onDocClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor?.contains(target)) return;
      onCancel();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCancel();
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [anchor, onCancel]);

  // T6.1: a keyboard user who activates the trigger with Enter/Space lands
  // here with focus still on that trigger — this dialog is portalled to the
  // end of <body>, so plain Tab order would skip past it entirely rather
  // than continuing into it. Move focus onto the first radio once the
  // dialog is positioned (falls back to the dialog itself if the field set
  // is ever empty) — the WAI-ARIA dialog pattern's initial-focus rule.
  useEffect(() => {
    if (!position) return;
    const first = ref.current?.querySelector<HTMLElement>('input, button');
    (first ?? ref.current)?.focus();
  }, [position]);

  if (!param || field?.kind !== 'choice' || typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={chip.label}
      tabIndex={-1}
      style={position ? { top: position.top, left: position.left } : { top: 0, left: 0, opacity: 0 }}
      className="adm-root adm-animate-in fixed z-[55] w-64 rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-3 text-left shadow-[var(--adm-shadow-lg)]"
    >
      <fieldset className="flex flex-col gap-1.5" disabled={busy}>
        <legend className="mb-1 text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
          {param.label}
        </legend>
        <div className="flex flex-col gap-1.5" role="radiogroup" aria-label={param.label}>
          {field.options.map((option) => {
            const inputId = `${chip.id}-${param.id}-${option.value}`;
            return (
              <label
                key={option.value}
                htmlFor={inputId}
                className={cn(
                  'flex items-start gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-2.5 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]',
                  busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-[var(--adm-border-strong)]'
                )}
              >
                <input
                  id={inputId}
                  type="radio"
                  name={`${chip.id}-${param.id}`}
                  value={option.value}
                  checked={value === option.value}
                  onChange={() => setValue(option.value)}
                  className="adm-focusable mt-0.5 h-4 w-4 shrink-0 border-[var(--adm-border-strong)] text-[var(--adm-accent)]"
                />
                <span className="flex flex-col gap-0.5">
                  <span>{option.label}</span>
                  {option.hint ? (
                    <span className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{option.hint}</span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <div className="mt-2.5 flex items-center justify-end gap-2">
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={busy} onClick={() => onConfirm({ [param.id]: value })}>
          {busy ? 'Working…' : chip.label}
        </Button>
      </div>
    </div>,
    document.body
  );
}

// ─── one chip ───────────────────────────────────────────────────────────────

function QuickActionChipButton({
  chip,
  variant,
  open,
  busy,
  onConfirm,
  onCancel,
}: {
  chip: QuickActionChip;
  variant: 'pill' | 'button';
  open: boolean;
  busy: boolean;
  onConfirm: (values: QuickActionValues) => void;
  onCancel: () => void;
}) {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasOpen = useRef(open);
  // T6.1: give focus back to the trigger once the popover this button owns
  // closes — otherwise a keyboard user who just moved focus into the portal
  // (see QuickActionPopover's own focus effect) loses their place entirely
  // on Escape/Cancel/Confirm, since the portal node is gone.
  useEffect(() => {
    if (wasOpen.current && !open) buttonRef.current?.focus();
    wasOpen.current = open;
  }, [open]);
  // An ellipsis is the honest signal that the click opens something rather
  // than doing the thing — both the popover and the hand-off ask first.
  const label = chip.execution === 'immediate' ? chip.label : `${chip.label}…`;
  const onClick = (event: { stopPropagation: () => void }) => {
    event.stopPropagation();
    chip.onSelect();
  };

  return (
    <span ref={triggerRef} className="inline-flex">
      {variant === 'button' ? (
        <Popover
          mode="hover"
          content={chip.title}
          disabled={busy}
          trigger={(a11y) => (
            <Button
              ref={buttonRef}
              size="sm"
              variant="secondary"
              disabled={busy}
              aria-expanded={chip.execution === 'popover' ? open : undefined}
              onClick={onClick}
              {...a11y}
            >
              {busy ? 'Working…' : label}
            </Button>
          )}
        />
      ) : (
        <Popover
          mode="hover"
          content={chip.title}
          disabled={busy}
          trigger={(a11y) => (
            <button
              ref={buttonRef}
              type="button"
              disabled={busy}
              aria-expanded={chip.execution === 'popover' ? open : undefined}
              onClick={onClick}
              className="adm-focusable rounded-[var(--adm-radius-pill)] border border-[var(--adm-border-strong)] px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)] disabled:opacity-50"
              {...a11y}
            >
              {busy ? 'Working…' : label}
            </button>
          )}
        />
      )}
      {open ? (
        <QuickActionPopover
          chip={chip}
          anchor={triggerRef.current}
          busy={busy}
          onConfirm={onConfirm}
          onCancel={onCancel}
        />
      ) : null}
    </span>
  );
}

// ─── the chip row ───────────────────────────────────────────────────────────

export interface QuickActionChipsProps {
  row: LibraryRow;
  roles: readonly string[];
  /**
   * `pill` is the dense row/card affordance (objects plane); `button` is the
   * action-surface affordance (object workspace). Presentation only — the
   * chip set and its rights gate are identical either way.
   */
  variant?: 'pill' | 'button';
  /**
   * Chat hand-off, when the surface already has this object's chat on screen:
   * seed its composer instead of navigating away. Surfaces without a chat
   * (the objects plane) omit this and get the default — open the object's
   * chat and send the prompt, the same path `AgentsHub.tsx`'s starters use.
   */
  onSeedComposer?: (prompt: string) => void;
  /**
   * Chip ids this surface already offers through its OWN controls, so the
   * chip row does not render a second Publish button beside the first one.
   * A surface-level fact, deliberately not a registry-level one: the chip
   * set for an object is the same everywhere, and this only says which of
   * them would be a duplicate HERE. Note what excluding does NOT do — the
   * workspace's own control renders disabled-with-a-reason
   * (`object-detail-actions.ts`), so nothing is hidden by this; the reason
   * is still on screen, on the control that owns it.
   */
  exclude?: readonly string[];
  /** Called after a chip changed the record, so the surface can refetch. */
  onChanged?: () => void;
  className?: string;
}

export function QuickActionChips({
  row,
  roles,
  variant = 'pill',
  exclude,
  onSeedComposer,
  onChanged,
  className,
}: QuickActionChipsProps) {
  const { toast } = useToast();
  const [openId, setOpenId] = useState<string | undefined>();
  const [busyId, setBusyId] = useState<string | undefined>();

  const run = async (chip: QuickActionChip, values: QuickActionValues) => {
    setBusyId(chip.id);
    const result = await runQuickAction(callVerb, chip, row, values);
    setBusyId(undefined);
    setOpenId(undefined);
    toast({
      title: result.ok ? chip.label : `${chip.label} didn't run`,
      description: result.receipt,
      tone: result.ok ? 'success' : 'danger',
    });
    // A preview writes nothing, so it is not a reason to refetch.
    if (result.ok && values.mode !== 'preview') onChanged?.();
  };

  const handOff = async (chip: QuickActionChip) => {
    const prompt = chip.prompt ?? '';
    if (onSeedComposer) {
      onSeedComposer(prompt);
      return;
    }
    setBusyId(chip.id);
    try {
      const { createObjectChat, sendChatMessage } = await import('@core/lib/admin/chat-client');
      const { chat } = await createObjectChat(getToken, row.object_type, row.object_id, row.display_name);
      await sendChatMessage(getToken, chat.chat_id, prompt);
      await navigate(`/admin/agents?chat=${encodeURIComponent(chat.chat_id)}`);
    } catch (error) {
      toast({
        title: "Couldn't open the chat",
        description: error instanceof Error ? error.message : undefined,
        tone: 'danger',
      });
    } finally {
      setBusyId(undefined);
    }
  };

  // Rights-gating lives inside `resolve` (T2.1's contract) — the only thing
  // filtered here is the surface's own duplicates, see `exclude`.
  const resolved = DEFAULT_QUICK_ACTION_REGISTRY.resolve({
    row,
    roles,
    getToken,
    handlers: {
      run: (chip, values) => void run(chip, values),
      openPopover: (chip) => setOpenId((current) => (current === chip.id ? undefined : chip.id)),
      handOff: (chip) => void handOff(chip),
    },
  });
  const chips = exclude?.length ? resolved.filter((chip) => !exclude.includes(chip.id)) : resolved;

  if (!chips.length) return variant === 'pill' ? <span className="block min-h-[1.5rem]" /> : null;

  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map((chip) => (
        <QuickActionChipButton
          key={chip.id}
          chip={chip}
          variant={variant}
          open={openId === chip.id}
          busy={busyId === chip.id}
          onConfirm={(values) => void run(chip, values)}
          onCancel={() => setOpenId(undefined)}
        />
      ))}
    </span>
  );
}
