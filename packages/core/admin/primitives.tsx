/**
 * Admin kit — primitives (T9.2): Button, IconButton, Badge, StatusPill, Card,
 * StatCard, Avatar, Skeleton, EmptyState, Breadcrumbs.
 *
 * Styling: Tailwind utilities bound to the `--adm-*` token layer
 * (admin-tokens.css). Full class strings are written literally so Tailwind's
 * content scanner emits them. Keyboard focus uses the shared `.adm-focusable`
 * ring.
 */
import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, ComponentType, HTMLAttributes, ReactNode } from 'react';

import { cn } from './utils';
import type { Tone } from './logic';
import { statusTone } from './logic';
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCheck,
  IconChevronRight,
  IconInfo,
  IconOctagon,
  type IconProps,
} from './icons';
import { statusLabel } from '@core/lib/admin/display-name';
import { SEVERITY, type AdminSeverity, type SeverityIconKey, type SeverityTokenFamily } from '@core/lib/admin/severity';

// ─── tone maps (shared by Badge / StatusPill) ─────────────────────────────────

const TONE_SOFT: Record<Tone, string> = {
  neutral: 'bg-[var(--adm-surface-sunken)] text-[var(--adm-text-muted)]',
  accent: 'bg-[var(--adm-accent-soft)] text-[var(--adm-accent)]',
  success: 'bg-[var(--adm-success-soft)] text-[var(--adm-success-text)]',
  warning: 'bg-[var(--adm-warning-soft)] text-[var(--adm-warning-text)]',
  danger: 'bg-[var(--adm-danger-soft)] text-[var(--adm-danger-text)]',
  info: 'bg-[var(--adm-info-soft)] text-[var(--adm-info-text)]',
};

const TONE_DOT: Record<Tone, string> = {
  neutral: 'bg-[var(--adm-text-muted)]',
  accent: 'bg-[var(--adm-accent)]',
  success: 'bg-[var(--adm-success)]',
  warning: 'bg-[var(--adm-warning)]',
  danger: 'bg-[var(--adm-danger)]',
  info: 'bg-[var(--adm-info)]',
};

// ─── Button ───────────────────────────────────────────────────────────────────

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  primary:
    'bg-[var(--adm-accent)] text-[var(--adm-text-on-accent)] border-transparent hover:bg-[var(--adm-accent-hover)]',
  secondary:
    'bg-[var(--adm-surface-raised)] text-[var(--adm-text)] border-[var(--adm-border-strong)] hover:bg-[var(--adm-surface-sunken)]',
  ghost: 'bg-transparent text-[var(--adm-text)] border-transparent hover:bg-[var(--adm-accent-soft)]',
  danger: 'bg-[var(--adm-danger)] text-white border-transparent hover:opacity-90',
};

const BTN_SIZE: Record<ButtonSize, string> = {
  sm: 'h-8 px-3 text-[length:var(--adm-text-sm)] gap-1.5',
  md: 'h-10 px-4 text-[length:var(--adm-text-sm)] gap-2',
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', size = 'md', loading = false, leftIcon, rightIcon, disabled, className, children, ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        'adm-focusable inline-flex items-center justify-center rounded-[var(--adm-radius-md)] border font-medium',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        BTN_VARIANT[variant],
        BTN_SIZE[size],
        className
      )}
      {...rest}
    >
      {loading ? <Spinner /> : leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});

function Spinner() {
  return (
    <svg className="animate-spin" width={16} height={16} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

// ─── IconButton ───────────────────────────────────────────────────────────────

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required — icon-only controls must be labeled for screen readers. */
  label: string;
  icon: ReactNode;
  variant?: 'ghost' | 'secondary' | 'danger';
  size?: ButtonSize;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, icon, variant = 'ghost', size = 'md', className, ...rest },
  ref
) {
  const box = size === 'sm' ? 'h-8 w-8' : 'h-10 w-10';
  const variantClass =
    variant === 'secondary'
      ? 'border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] hover:bg-[var(--adm-surface-sunken)]'
      : variant === 'danger'
        ? 'border-transparent text-[var(--adm-danger)] hover:bg-[var(--adm-danger-soft)]'
        : 'border-transparent hover:bg-[var(--adm-accent-soft)]';
  return (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      title={label}
      className={cn(
        'adm-focusable inline-flex items-center justify-center rounded-[var(--adm-radius-md)] border text-[var(--adm-text)]',
        'transition-colors disabled:cursor-not-allowed disabled:opacity-50',
        box,
        variantClass,
        className
      )}
      {...rest}
    >
      {icon}
    </button>
  );
});

// ─── Badge / StatusPill ───────────────────────────────────────────────────────

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

export function Badge({ tone = 'neutral', className, children, ...rest }: BadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-[var(--adm-radius-pill)] px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium',
        TONE_SOFT[tone],
        className
      )}
      {...rest}
    >
      {children}
    </span>
  );
}

export interface StatusPillProps extends HTMLAttributes<HTMLSpanElement> {
  status: string;
  /** Override the auto-derived tone. */
  tone?: Tone;
  label?: string;
}

export function StatusPill({ status, tone, label, className, ...rest }: StatusPillProps) {
  const resolved = tone ?? statusTone(status);
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] px-2 py-0.5 text-[length:var(--adm-text-xs)] font-medium',
        TONE_SOFT[resolved],
        className
      )}
      {...rest}
    >
      <span className={cn('h-1.5 w-1.5 rounded-full', TONE_DOT[resolved])} aria-hidden="true" />
      {label ?? statusLabel(status)}
    </span>
  );
}

// ─── Card / StatCard ──────────────────────────────────────────────────────────

export interface CardProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  kicker?: ReactNode;
  title?: ReactNode;
  actions?: ReactNode;
  footer?: ReactNode;
  /**
   * Extra classes for the BODY wrapper (the padded div around `children`).
   * Needed by full-height flex layouts (e.g. the agents-hub chat panel): the
   * body div sits between the Card and its children, so without
   * `min-h-0 flex-1 flex flex-col` here, a child's own `overflow-y-auto`
   * never engages and content grows the page instead of scrolling.
   */
  bodyClassName?: string;
}

export function Card({ kicker, title, actions, footer, className, bodyClassName, children, ...rest }: CardProps) {
  const hasHeader = kicker || title || actions;
  return (
    <div
      className={cn(
        'rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] shadow-[var(--adm-shadow-sm)]',
        className
      )}
      {...rest}
    >
      {hasHeader ? (
        <div className="flex items-start justify-between gap-3 border-b border-[var(--adm-border)] px-5 py-4">
          <div className="min-w-0">
            {kicker ? (
              <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
                {kicker}
              </p>
            ) : null}
            {title ? (
              <h3 className="truncate text-[length:var(--adm-text-lg)] font-semibold text-[var(--adm-text-heading)]">
                {title}
              </h3>
            ) : null}
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn('px-5 py-4', bodyClassName)}>{children}</div>
      {footer ? <div className="border-t border-[var(--adm-border)] px-5 py-3">{footer}</div> : null}
    </div>
  );
}

export interface StatCardProps extends HTMLAttributes<HTMLDivElement> {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}

export function StatCard({ label, value, hint, tone = 'neutral', className, ...rest }: StatCardProps) {
  return (
    <div
      className={cn(
        'rounded-[var(--adm-radius-lg)] border border-[var(--adm-border)] bg-[var(--adm-surface-raised)] px-5 py-4 shadow-[var(--adm-shadow-sm)]',
        className
      )}
      {...rest}
    >
      <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
        {label}
      </p>
      <p className="mt-1 text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">{value}</p>
      {hint ? (
        <p
          className={cn(
            'mt-1 text-[length:var(--adm-text-sm)]',
            tone === 'neutral' ? 'text-[var(--adm-text-muted)]' : TONE_SOFT[tone],
            tone !== 'neutral' && 'inline-block rounded px-1.5'
          )}
        >
          {hint}
        </p>
      ) : null}
    </div>
  );
}

// ─── Avatar ───────────────────────────────────────────────────────────────────

export interface AvatarProps extends HTMLAttributes<HTMLSpanElement> {
  name: string;
  size?: number;
}

export function Avatar({ name, size = 32, className, ...rest }: AvatarProps) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-[var(--adm-accent-soft)] font-semibold text-[var(--adm-accent)]',
        className
      )}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      aria-hidden="true"
      title={name}
      {...rest}
    >
      {initials || '?'}
    </span>
  );
}

// ─── Skeleton ─────────────────────────────────────────────────────────────────

export interface SkeletonProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: 'text' | 'rect' | 'circle';
  width?: number | string;
  height?: number | string;
}

export function Skeleton({ variant = 'text', width, height, className, style, ...rest }: SkeletonProps) {
  const radius =
    variant === 'circle'
      ? 'rounded-full'
      : variant === 'text'
        ? 'rounded-[var(--adm-radius-sm)]'
        : 'rounded-[var(--adm-radius-md)]';
  const defaults = variant === 'text' ? { width: width ?? '100%', height: height ?? '0.9em' } : { width, height };
  return (
    <span
      aria-hidden="true"
      className={cn('adm-skeleton block', radius, className)}
      style={{ ...defaults, ...style }}
      {...rest}
    />
  );
}

// ─── EmptyState ───────────────────────────────────────────────────────────────

/** D4/B4: `EmptyState`'s own icon+color lookup, sourced from `SEVERITY`
 * (`@core/lib/admin/severity`) — not imported from `./severity.tsx`, which
 * itself imports `Badge` from this file; duplicating the tiny level→glyph map
 * here (same shape as `severity.tsx`'s own `ICON_COMPONENT`/`ICON_TONE`)
 * avoids a circular import between the two. Literal Tailwind color classes
 * for the same content-scanner reason `severity.tsx`'s header documents. */
const EMPTY_STATE_ICON_COMPONENT: Record<SeverityIconKey, ComponentType<IconProps>> = {
  info: IconInfo,
  check: IconCheck,
  'alert-triangle': IconAlertTriangle,
  'alert-circle': IconAlertCircle,
  octagon: IconOctagon,
};

const EMPTY_STATE_ICON_TONE: Record<SeverityTokenFamily, string> = {
  info: 'text-[var(--adm-info)]',
  success: 'text-[var(--adm-success)]',
  warning: 'text-[var(--adm-warning-text)]',
  danger: 'text-[var(--adm-danger)]',
};

export interface EmptyStateProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  /** Custom icon override. Ignored in favor of the level's own D4 glyph when `severity` is set. */
  icon?: ReactNode;
  /**
   * D4 (T1.1) / B4 fix: a genuine load/fetch failure must not render
   * identically to an ordinary empty list — both used to share the same flat
   * neutral-gray triangle regardless of which one actually happened. Set
   * `severity="error"` (or another D4 level) to render that level's real
   * glyph (red circle-! for `error`, not the neutral triangle) in its color;
   * omit entirely for a genuinely empty list — nothing broke, nothing to
   * decide, so it stays neutral/decorative exactly as before this prop
   * existed (e.g. `GovernancePage.tsx`'s "No chat tools").
   */
  severity?: AdminSeverity;
  title: ReactNode;
  message?: ReactNode;
  action?: ReactNode;
}

export function EmptyState({ icon, severity, title, message, action, className, ...rest }: EmptyStateProps) {
  const def = severity ? SEVERITY[severity] : undefined;
  const Glyph = def ? EMPTY_STATE_ICON_COMPONENT[def.icon] : undefined;
  const resolvedIcon = icon ?? (Glyph ? <Glyph size={28} title="" /> : undefined);
  const iconClass = def ? EMPTY_STATE_ICON_TONE[def.tokens.family] : 'text-[var(--adm-text-muted)]';
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center rounded-[var(--adm-radius-lg)] border border-dashed border-[var(--adm-border-strong)] px-6 py-10 text-center',
        className
      )}
      {...rest}
    >
      {resolvedIcon ? <div className={cn('mb-3', iconClass)}>{resolvedIcon}</div> : null}
      <p className="text-[length:var(--adm-text-base)] font-semibold text-[var(--adm-text-heading)]">{title}</p>
      {message ? (
        <p className="mt-1 max-w-sm text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">{message}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

// ─── Breadcrumbs ──────────────────────────────────────────────────────────────

export interface Crumb {
  label: string;
  href?: string;
}

export function Breadcrumbs({ items, className }: { items: Crumb[]; className?: string }) {
  return (
    <nav aria-label="Breadcrumb" className={className}>
      <ol className="flex flex-wrap items-center gap-1 text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        {items.map((item, index) => {
          const last = index === items.length - 1;
          return (
            <li key={`${item.label}-${index}`} className="inline-flex items-center gap-1">
              {item.href && !last ? (
                <a className="adm-focusable rounded hover:text-[var(--adm-text)] hover:underline" href={item.href}>
                  {item.label}
                </a>
              ) : (
                <span
                  aria-current={last ? 'page' : undefined}
                  className={last ? 'font-medium text-[var(--adm-text)]' : ''}
                >
                  {item.label}
                </span>
              )}
              {!last ? <IconChevronRight size={14} className="text-[var(--adm-text-muted)]" /> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
