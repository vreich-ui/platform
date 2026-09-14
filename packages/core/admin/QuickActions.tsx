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
 * ASV2-W5: what is LEFT here after W3 is the two pieces that outlived the
 * chip row — `QuickActionPopover` (the one single-field popover, now shared
 * with `ObjectActionStrip.tsx`, because a popover cannot live inside a
 * `() => void`) and the Inventory starter chips. The row-based
 * `QuickActionChips` itself is gone; `ObjectActionStrip` / `ObjectActionMenu`
 * replaced both of its call sites and added the disabled-with-a-reason gate.
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

import { Button } from './primitives';
import { Popover } from './overlays';
import { cn } from './utils';
import {
  inventoryQuickActionChips,
  type InventoryQuickActionCollection,
  type QuickActionChip,
  type QuickActionValues,
} from '@core/lib/admin/quick-actions';
import type { InventoryChatSelectionItem } from '@core/lib/admin/inventory-chat';

const POPOVER_GAP = 6;
const VIEWPORT_MARGIN = 8;
const POPOVER_WIDTH = 256;

// ─── the single-field popover ───────────────────────────────────────────────

/**
 * One field, one confirm. Dismissed by Escape, an outside click, or a scroll
 * that would leave it stranded — the dismissal idiom `menus.tsx` already
 * uses, minus the keyboard roving a single radio group does not need.
 *
 * ASV2-W3.1: exported so `ObjectActionStrip.tsx` renders the SAME popover
 * rather than a second one. The registry decides that a one-parameter action
 * is collected in a popover (`executionFor`); there should be exactly one
 * thing that popover looks like, whichever surface opened it.
 */
export function QuickActionPopover({
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

/**
 * ASV2-W5: `QuickActionChips` (the row/button chip row) was DELETED here.
 *
 * W3 replaced both of its call sites with `ObjectActionStrip` /
 * `ObjectActionMenu` (`ObjectActionStrip.tsx`), which resolve the same
 * registry through `object-action-strip.ts` and add the disabled-with-a-reason
 * gate the chip row never had. Verified with `rg` across the repo before
 * removing (AGENTS.md §3.4): zero importers of `QuickActionChips` or
 * `QuickActionChipsProps` remained. `QuickActionChipButton` below is kept —
 * `InventoryQuickActionChips` still renders through it — and
 * `QuickActionPopover` is kept because W3.1 exported it for the strip, so
 * there is one popover, not two.
 */

// ─── Inventory starter chips (T5) ───────────────────────────────────────────

/** No-op stand-ins for the popover machinery `QuickActionChipButton` still
 *  accepts — an inventory starter is always `chat-handoff`, so `open` never
 *  turns true and neither callback is ever invoked. Kept as one shared
 *  reference rather than a fresh closure per render. */
const noop = () => {};

export interface InventoryQuickActionChipsProps {
  /** Which collection's starter to offer — `admin/InventoryPage.tsx` picks
   *  this from the inspected row (Drawer) or the selection's shared
   *  collection (bulk toolbar; omitted for a mixed-collection selection). */
  collection: InventoryQuickActionCollection;
  /** The rows the starter's prompt is built over — the inspected hit alone,
   *  or the whole bulk selection. May be empty (a hit not yet selected still
   *  gets to offer its collection's starter; its fenced block is just empty
   *  until something is picked). */
  items: readonly InventoryChatSelectionItem[];
  /** Seeds the Inventory page's OWN chat composer — never sends anything by
   *  itself, exactly like the row-based `QuickActionChips`' `onSeedComposer`. */
  onSeedComposer: (prompt: string) => void;
  variant?: 'pill' | 'button';
  className?: string;
}

/**
 * The three collection starters — one per collection, for the reason
 * `inventoryQuickActionChips` documents (BRIEF.md's Design section and its
 * T5 task row disagree on the count; the task row wins) — rendered through
 * the same chip button the
 * row-based registry uses — a starter and a governed-object chip should look
 * identical on screen, since both are "click to hand this off to chat".
 * `inventoryQuickActionChips` always resolves to exactly one chip for a
 * given `collection`, but this stays a `.map` rather than hard-coding that,
 * matching `QuickActionChips` above.
 */
export function InventoryQuickActionChips({
  collection,
  items,
  onSeedComposer,
  variant = 'button',
  className,
}: InventoryQuickActionChipsProps) {
  const chips = inventoryQuickActionChips(collection, items, {
    handOff: (chip) => onSeedComposer(chip.prompt ?? ''),
  });

  if (!chips.length) return null;

  return (
    <span className={cn('flex flex-wrap items-center gap-1', className)}>
      {chips.map((chip) => (
        <QuickActionChipButton key={chip.id} chip={chip} variant={variant} open={false} busy={false} onConfirm={noop} onCancel={noop} />
      ))}
    </span>
  );
}
