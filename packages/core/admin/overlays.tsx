/**
 * Admin kit — overlays (T9.2, +Popover/Tooltip T0): Dialog, ConfirmDialog
 * (typed-confirm danger variant), Drawer, Toast (provider + useToast hook),
 * and Popover (one component, two modes — see below).
 *
 * Modals use the native <dialog> element (showModal gives a real top-layer,
 * focus trap, and Escape for free); we add previous-focus restore and
 * backdrop-click-to-close on top. Popover/Tooltip instead use the native
 * `popover` attribute (top layer without a z-index war, no focus trap needed
 * for either mode) plus `position: fixed` anchored off the trigger's own
 * rect — `popoverReducer`/`anchorPosition` (packages/core/lib/admin/
 * overlay-anchor.ts) hold the actual decision logic so it's unit-testable
 * per this repo's convention (no DOM test stack); the component here holds
 * only refs/timers and consumes both. All effects are client-only, so the
 * components server-render inertly and wire up on hydration.
 */
import { useCallback, createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, ReactNode } from 'react';

import { cn } from './utils';
import type { Tone } from './logic';
import { Button } from './primitives';
import { IconButton } from './primitives';
import { IconX, IconInfo, IconCheck, IconAlertTriangle } from './icons';
import { anchorPosition, popoverReducer, INITIAL_POPOVER_STATE, type Placement } from '@core/lib/admin/overlay-anchor';

// ─── Dialog ───────────────────────────────────────────────────────────────────

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  description?: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'md' | 'lg';
  children?: ReactNode;
  /** When false, clicking the backdrop won't close (e.g. destructive confirms). */
  dismissOnBackdrop?: boolean;
}

const DIALOG_SIZE = { sm: 'max-w-sm', md: 'max-w-lg', lg: 'max-w-2xl' } as const;

export function Dialog({
  open,
  onClose,
  title,
  description,
  footer,
  size = 'md',
  children,
  dismissOnBackdrop = true,
}: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  // Native close (Escape or el.close()) → notify parent + restore focus.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => {
      onClose();
      restoreFocus.current?.focus?.();
    };
    el.addEventListener('close', handleClose);
    return () => el.removeEventListener('close', handleClose);
  }, [onClose]);

  const onBackdrop = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (dismissOnBackdrop && event.target === ref.current) ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      className={cn(
        'adm-dialog adm-root adm-animate-in m-auto w-[calc(100vw-2rem)] rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-0 text-[var(--adm-text)] shadow-[var(--adm-shadow-lg)]',
        DIALOG_SIZE[size]
      )}
      aria-labelledby={title ? headingId : undefined}
      onClick={onBackdrop}
      onCancel={(e) => {
        // let native Escape run through the 'close' path
        void e;
      }}
    >
      <div className="flex items-start justify-between gap-3 px-5 pt-5">
        <div className="min-w-0">
          {title ? (
            <h2
              id={headingId}
              className="text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]"
            >
              {title}
            </h2>
          ) : null}
          {description ? (
            <p className="mt-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{description}</p>
          ) : null}
        </div>
        <IconButton label="Close dialog" icon={<IconX size={18} />} size="sm" onClick={() => ref.current?.close()} />
      </div>
      {children ? <div className="px-5 py-4">{children}</div> : null}
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-[var(--adm-border)] px-5 py-4">{footer}</div>
      ) : null}
    </dialog>
  );
}

// ─── ConfirmDialog ────────────────────────────────────────────────────────────

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: ReactNode;
  message?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: 'accent' | 'danger';
  /** Typed-confirm variant: user must type this exact phrase to enable confirm. */
  requireTyped?: string;
}

export function ConfirmDialog({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'accent',
  requireTyped,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const fieldId = useId();
  useEffect(() => {
    if (!open) setTyped('');
  }, [open]);

  const blocked = Boolean(requireTyped) && typed.trim() !== requireTyped;

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={title}
      size="sm"
      dismissOnBackdrop={tone !== 'danger'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            {cancelLabel}
          </Button>
          <Button variant={tone === 'danger' ? 'danger' : 'primary'} disabled={blocked} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {message ? <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text)]">{message}</p> : null}
      {requireTyped ? (
        <div className="mt-3 flex flex-col gap-1">
          <label htmlFor={fieldId} className="text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            Type <span className="font-mono font-semibold text-[var(--adm-text)]">{requireTyped}</span> to confirm
          </label>
          <input
            id={fieldId}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            className="adm-focusable h-9 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-3 text-[length:var(--adm-text-sm)] text-[var(--adm-text)]"
          />
        </div>
      ) : null}
    </Dialog>
  );
}

// ─── Drawer ───────────────────────────────────────────────────────────────────

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  side?: 'right' | 'left';
  width?: number;
  children?: ReactNode;
  footer?: ReactNode;
}

export function Drawer({ open, onClose, title, side = 'right', width = 420, children, footer }: DrawerProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const headingId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) {
      restoreFocus.current = document.activeElement as HTMLElement | null;
      el.showModal();
    } else if (!open && el.open) {
      el.close();
    }
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleClose = () => {
      onClose();
      restoreFocus.current?.focus?.();
    };
    el.addEventListener('close', handleClose);
    return () => el.removeEventListener('close', handleClose);
  }, [onClose]);

  const onBackdrop = (event: React.MouseEvent<HTMLDialogElement>) => {
    if (event.target === ref.current) ref.current?.close();
  };

  return (
    <dialog
      ref={ref}
      onClick={onBackdrop}
      className={cn(
        'adm-dialog adm-root h-full max-h-none border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-0 text-[var(--adm-text)] shadow-[var(--adm-shadow-lg)]',
        side === 'right' ? 'ml-auto mr-0' : 'ml-0 mr-auto'
      )}
      style={{ width, maxWidth: '100vw' }}
      aria-labelledby={title ? headingId : undefined}
    >
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between gap-3 border-b border-[var(--adm-border)] px-5 py-4">
          {title ? (
            <h2
              id={headingId}
              className="text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]"
            >
              {title}
            </h2>
          ) : (
            <span />
          )}
          <IconButton label="Close panel" icon={<IconX size={18} />} size="sm" onClick={() => ref.current?.close()} />
        </div>
        <div className="flex-1 overflow-auto px-5 py-4">{children}</div>
        {footer ? <div className="border-t border-[var(--adm-border)] px-5 py-4">{footer}</div> : null}
      </div>
    </dialog>
  );
}

// ─── Popover ──────────────────────────────────────────────────────────────────

/** How long a hover-mode tooltip waits, after enter/focus, before opening. */
const TOOLTIP_OPEN_DELAY_MS = 200;

/** Feature-detects the Popover API rather than assuming it (Safari < 17). The
 * component still positions and shows/hides the panel via plain CSS on an
 * unsupported browser — the native attribute is a top-layer nicety, not load
 * bearing. */
function supportsPopoverApi(el: HTMLElement): el is HTMLElement & { showPopover: () => void; hidePopover: () => void } {
  return typeof (el as { showPopover?: unknown }).showPopover === 'function';
}

/** A11y wiring the `trigger` render prop must spread onto the real
 * interactive element — never onto the wrapping span, which is only a hit
 * target/focus stop for the disabled case (see `disabled` below). */
export interface PopoverTriggerA11yProps {
  'aria-describedby'?: string;
  'aria-expanded'?: boolean;
  'aria-controls'?: string;
}

interface PopoverSharedProps {
  /** Render prop (same shape as `DropdownMenu`'s `trigger`) so the a11y
   * attributes land on the actual button/link, not the wrapper. */
  trigger: (a11y: PopoverTriggerA11yProps) => ReactNode;
  /** Side to prefer; flips vertically when the panel doesn't fit there. */
  placement?: Placement;
  /**
   * Convention D3: pass `true` when the rendered trigger is itself
   * `disabled`. A disabled <button> fires no pointer/focus events at all —
   * nothing bubbles, so hover/focus/click would never reach us — so this
   * wraps the trigger in a focusable span (`tabIndex=0`) that carries every
   * listener itself, with the trigger's own box made `pointer-events-none`
   * so clicks/hovers land on that span instead of being swallowed by the
   * disabled element. That span also takes `role="button"`, `aria-disabled`
   * and the panel's `aria-describedby` (FIX 8) — being focusable is not the
   * same as being announced, and it is the FOCUSED element that must carry
   * the description. This is the whole point of the component: the reason a
   * rights-gated action is unavailable must be reachable by keyboard and
   * touch, not just a mouse hovering a native `title`.
   */
  disabled?: boolean;
  className?: string;
}

export type PopoverProps =
  | (PopoverSharedProps & { mode: 'hover'; /** Text only — this is a tooltip. */ content: string })
  | (PopoverSharedProps & { mode: 'click'; /** Arbitrary content — this is a popover. */ content: ReactNode });

export function Popover({ mode, trigger, content, placement = 'bottom', disabled = false, className }: PopoverProps) {
  const [state, dispatch] = useReducer(popoverReducer, INITIAL_POPOVER_STATE);
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const floatingRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const panelId = useId();

  const clearOpenTimer = useCallback(() => {
    if (openTimer.current !== null) {
      window.clearTimeout(openTimer.current);
      openTimer.current = null;
    }
  }, []);
  useEffect(() => clearOpenTimer, [clearOpenTimer]);

  // Hover mode: enter/focus ARMS the delay (doesn't open immediately); any
  // leave/blur before it fires disarms it again.
  const armHover = useCallback(
    (type: 'trigger-enter' | 'trigger-focus') => {
      if (mode !== 'hover') return;
      dispatch({ type });
      clearOpenTimer();
      openTimer.current = window.setTimeout(() => {
        openTimer.current = null;
        dispatch({ type: 'delay-elapsed' });
      }, TOOLTIP_OPEN_DELAY_MS);
    },
    [mode, clearOpenTimer]
  );
  const disarmHover = useCallback(
    (type: 'trigger-leave' | 'trigger-blur') => {
      if (mode !== 'hover') return;
      clearOpenTimer();
      dispatch({ type });
    },
    [mode, clearOpenTimer]
  );

  // Esc closes in both modes, whether already open or merely armed.
  useEffect(() => {
    if (!state.open && !state.armed) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      clearOpenTimer();
      dispatch({ type: 'escape' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [state.open, state.armed, clearOpenTimer]);

  // Click mode only: outside click/pointerdown closes.
  useEffect(() => {
    if (mode !== 'click' || !state.open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (wrapperRef.current?.contains(target) || floatingRef.current?.contains(target)) return;
      dispatch({ type: 'outside' });
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [mode, state.open]);

  // Position + native top-layer show/hide, measured synchronously (pre-paint,
  // like `DropdownMenu`) so there's no visible jump from an unpositioned
  // frame. Visibility itself is plain CSS (`floatingStyle.display` below,
  // driven straight off `state.open`) — `showPopover`/`hidePopover` are only
  // for the top-layer benefit where the API exists; nothing depends on it.
  useLayoutEffect(() => {
    const el = floatingRef.current;
    if (!el) return;
    if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');

    if (!state.open) {
      if (supportsPopoverApi(el) && el.matches(':popover-open')) el.hidePopover();
      setPosition(null);
      return;
    }

    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    if (supportsPopoverApi(el) && !el.matches(':popover-open')) el.showPopover();
    const rect = wrapper.getBoundingClientRect();
    const anchored = anchorPosition(
      rect,
      { width: el.offsetWidth, height: el.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
      placement
    );
    setPosition({ top: anchored.top, left: anchored.left });
  }, [state.open, placement, content]);

  /**
   * FIX 2 — the panel is a DOM DESCENDANT of this wrapper (the native
   * `popover` top layer moves where it PAINTS, never where it sits in the
   * tree), so a click on a control inside the panel bubbles to exactly the
   * same listener a click on the trigger does. Treating those alike closed
   * the panel the instant anyone used it — the notification-settings
   * `Select` on /admin/requests could not be operated at all. The
   * `pointerdown` outside-handler above already draws this line correctly;
   * this is the same containment test, dispatching the reducer's no-op
   * `inside` rather than `click-toggle`.
   */
  const onWrapperClick = (event: React.MouseEvent<HTMLSpanElement>) => {
    if (mode !== 'click') return;
    if (floatingRef.current?.contains(event.target as Node)) {
      dispatch({ type: 'inside' });
      return;
    }
    dispatch({ type: 'click-toggle' });
  };

  const onWrapperKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    // Only needed for the disabled case: a plain focusable <span> (unlike a
    // <button>) doesn't synthesize a click on Enter/Space by itself, and
    // click mode's open/close is otherwise driven entirely by real clicks.
    if (mode !== 'click' || !disabled) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    dispatch({ type: 'click-toggle' });
  };

  /**
   * The wiring that says "this control is described by that panel".
   *
   * FIX 8 — it must land on the element that TAKES FOCUS. In the `disabled`
   * case that is the wrapper span, not the disabled trigger inside it: a
   * disabled <button> is not focusable, so `aria-describedby` on it is never
   * read, and the span the user actually lands on had no name and no
   * description. Tabbing to a rights-gated control announced nothing at all
   * — D3 was satisfied visually and not at all for a screen reader, which is
   * the audience it exists for.
   *
   * So when `disabled`, the span takes the description AND `role="button"`
   * with `aria-disabled` — which gives it a name from its own content (the
   * trigger's label text) and announces it as unavailable — and the trigger
   * is handed an empty payload, since attaching anything to an element
   * nobody can reach is how this went wrong in the first place.
   */
  const describedBy: PopoverTriggerA11yProps =
    mode === 'hover' ? { 'aria-describedby': state.open ? panelId : undefined } : { 'aria-expanded': state.open, 'aria-controls': panelId };
  const a11y: PopoverTriggerA11yProps = disabled ? {} : describedBy;
  const wrapperA11y = disabled ? { role: 'button', 'aria-disabled': true, ...describedBy } : {};

  const floatingStyle: CSSProperties = {
    position: 'fixed',
    top: position?.top ?? -9999,
    left: position?.left ?? -9999,
    margin: 0,
    // Independent of Popover API support (see the layout effect above): a
    // closed panel is `display: none` outright rather than merely
    // off-screen, so it's inert for hit-testing and the accessibility tree.
    display: state.open ? undefined : 'none',
  };

  return (
    <span
      ref={wrapperRef}
      tabIndex={disabled ? 0 : undefined}
      {...wrapperA11y}
      className={cn('adm-focusable inline-flex', disabled ? 'cursor-not-allowed' : undefined, className)}
      onMouseEnter={() => armHover('trigger-enter')}
      onMouseLeave={() => disarmHover('trigger-leave')}
      onFocus={() => armHover('trigger-focus')}
      onBlur={() => disarmHover('trigger-blur')}
      onClick={onWrapperClick}
      onKeyDown={onWrapperKeyDown}
    >
      <span className={disabled ? 'pointer-events-none' : 'contents'}>{trigger(a11y)}</span>
      {mode === 'hover' ? (
        <div
          ref={floatingRef}
          id={panelId}
          role="tooltip"
          style={floatingStyle}
          className="adm-root pointer-events-none z-[70] max-w-xs text-pretty rounded-[var(--adm-radius-sm)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] px-2.5 py-1.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text)] shadow-[var(--adm-shadow-md)]"
        >
          {content}
        </div>
      ) : (
        <div
          ref={floatingRef}
          id={panelId}
          role="dialog"
          style={floatingStyle}
          className="adm-root z-[70] rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] p-3 shadow-[var(--adm-shadow-lg)]"
        >
          {content}
        </div>
      )}
    </span>
  );
}

// ─── Toast ────────────────────────────────────────────────────────────────────

export interface ToastOptions {
  title: string;
  description?: string;
  tone?: Tone;
  duration?: number;
}

interface ToastItem extends ToastOptions {
  id: number;
}

interface ToastApi {
  toast: (options: ToastOptions) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const TOAST_ICON: Partial<Record<Tone, ReactNode>> = {
  success: <IconCheck size={18} />,
  danger: <IconAlertTriangle size={18} />,
  warning: <IconAlertTriangle size={18} />,
  info: <IconInfo size={18} />,
};

const TOAST_ACCENT: Record<Tone, string> = {
  neutral: 'border-l-[var(--adm-border-strong)] text-[var(--adm-text-muted)]',
  accent: 'border-l-[var(--adm-accent)] text-[var(--adm-accent)]',
  success: 'border-l-[var(--adm-success)] text-[var(--adm-success)]',
  warning: 'border-l-[var(--adm-warning)] text-[var(--adm-warning)]',
  danger: 'border-l-[var(--adm-danger)] text-[var(--adm-danger)]',
  info: 'border-l-[var(--adm-info)] text-[var(--adm-info)]',
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const remove = useCallback((id: number) => setItems((list) => list.filter((t) => t.id !== id)), []);

  const toast = useCallback(
    (options: ToastOptions) => {
      const id = (idRef.current += 1);
      setItems((list) => [...list, { ...options, id }]);
      const duration = options.duration ?? 4000;
      if (duration > 0) window.setTimeout(() => remove(id), duration);
    },
    [remove]
  );

  /**
   * T5.1 R12 (F16): `value={{ toast }}` allocated a NEW context object on
   * every `ToastProvider` render, and `items` changes on every toast show
   * and every toast expiry — so showing one toast re-rendered every
   * `useToast()` consumer in the tree (on the object workspace, the whole
   * page). `toast` itself is already stable, so memoising the wrapper is
   * enough to make a toast a local update again.
   */
  const value = useMemo(() => ({ toast }), [toast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div
        className="adm-root pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2"
        role="region"
        aria-label="Notifications"
      >
        {items.map((item) => {
          const tone = item.tone ?? 'neutral';
          return (
            <div
              key={item.id}
              role="status"
              aria-live="polite"
              className={cn(
                'adm-animate-in pointer-events-auto flex items-start gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] border-l-4 bg-[var(--adm-surface-raised)] px-3 py-2.5 shadow-[var(--adm-shadow-md)]',
                TOAST_ACCENT[tone]
              )}
            >
              {TOAST_ICON[tone] ? <span className="mt-0.5 shrink-0">{TOAST_ICON[tone]}</span> : null}
              <div className="min-w-0 flex-1">
                <p className="text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)]">{item.title}</p>
                {item.description ? (
                  <p className="mt-0.5 text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
                    {item.description}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                aria-label="Dismiss notification"
                onClick={() => remove(item.id)}
                className="adm-focusable -mr-1 rounded p-0.5 text-[var(--adm-text-muted)] hover:text-[var(--adm-text)]"
              >
                <IconX size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a <ToastProvider>');
  return ctx;
}
