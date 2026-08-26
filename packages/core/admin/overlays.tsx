/**
 * Admin kit — overlays (T9.2): Dialog, ConfirmDialog (typed-confirm danger
 * variant), Drawer, and Toast (provider + useToast hook).
 *
 * Modals use the native <dialog> element (showModal gives a real top-layer,
 * focus trap, and Escape for free); we add previous-focus restore and
 * backdrop-click-to-close on top. All effects are client-only, so the
 * components server-render inertly and wire up on hydration.
 */
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { cn } from './utils';
import type { Tone } from './logic';
import { Button } from './primitives';
import { IconButton } from './primitives';
import { IconX, IconInfo, IconCheck, IconAlertTriangle } from './icons';

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
