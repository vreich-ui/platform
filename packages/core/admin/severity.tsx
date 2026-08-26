/**
 * D4 — the five-level severity standard, rendered (T1.1).
 *
 * Every color and glyph here comes from `SEVERITY`
 * (`@core/lib/admin/severity`) or an `--adm-*` CSS custom property — never a
 * literal Tailwind color class, never an inline hex. The class-string maps
 * below are written out in full (not built from the token names in
 * `SEVERITY`) because Tailwind's content scanner only picks up literal
 * `text-[var(--adm-…)]` strings that appear verbatim in source — the same
 * constraint `primitives.tsx`'s `TONE_SOFT`/`TONE_DOT` and
 * `RequestActivity.tsx`'s `GLYPH_TINT` already work under. Keep these in sync
 * with `SEVERITY`'s `tokens.family` values if a level's family ever changes.
 */
import type { ComponentType } from 'react';

import { SEVERITY, type AdminSeverity, type SeverityIconKey, type SeverityTokenFamily } from '@core/lib/admin/severity';
import { IconAlertCircle, IconAlertTriangle, IconCheck, IconInfo, IconOctagon, type IconProps } from './icons';
import { Badge, type BadgeProps } from './primitives';
import { cn } from './utils';

const ICON_COMPONENT: Record<SeverityIconKey, ComponentType<IconProps>> = {
  info: IconInfo,
  check: IconCheck,
  'alert-triangle': IconAlertTriangle,
  'alert-circle': IconAlertCircle,
  octagon: IconOctagon,
};

/** Icon tint per token family. `warning` uses the darker `-text` variant, matching the
 * existing precedent in `RequestActivity.tsx`'s `GLYPH_TINT` (solid amber reads too light). */
const ICON_TONE: Record<SeverityTokenFamily, string> = {
  info: 'text-[var(--adm-info)]',
  success: 'text-[var(--adm-success)]',
  warning: 'text-[var(--adm-warning-text)]',
  danger: 'text-[var(--adm-danger)]',
};

/** Header-pill soft background + text, one literal pair per family — same shape as the
 * three ad-hoc pills this replaces (`AdminShell.tsx:402-412`). */
const PILL_TONE: Record<SeverityTokenFamily, string> = {
  info: 'bg-[var(--adm-info-soft)] text-[var(--adm-info-text)]',
  success: 'bg-[var(--adm-success-soft)] text-[var(--adm-success-text)]',
  warning: 'bg-[var(--adm-warning-soft)] text-[var(--adm-warning-text)]',
  danger: 'bg-[var(--adm-danger-soft)] text-[var(--adm-danger-text)]',
};

// ─── SeverityIcon ────────────────────────────────────────────────────────────

export interface SeverityIconProps {
  level: AdminSeverity;
  size?: number;
  className?: string;
  /** Accessible name. Defaults to the level's label; pass `''` for a decorative icon. */
  title?: string;
}

/** Renders the right glyph in the right color for a level, from `SEVERITY` — nothing else. */
export function SeverityIcon({ level, size = 16, className, title }: SeverityIconProps) {
  const def = SEVERITY[level];
  const Glyph = ICON_COMPONENT[def.icon];
  return <Glyph size={size} className={cn(ICON_TONE[def.tokens.family], className)} title={title ?? def.label} />;
}

// ─── StatusBadge ─────────────────────────────────────────────────────────────

export interface StatusBadgeProps extends Omit<BadgeProps, 'tone'> {
  level: AdminSeverity;
  /** Set false to omit the leading glyph (label-only badge). Default true — D4 applies everywhere. */
  icon?: boolean;
}

/** Inline severity badge. A thin wrapper over the existing `Badge` primitive — its tone
 * vocabulary (`info`/`success`/`warning`/`danger`) already lines up with D4's token
 * families one-for-one, so nothing needed reimplementing. */
export function StatusBadge({ level, icon = true, children, className, ...rest }: StatusBadgeProps) {
  const def = SEVERITY[level];
  return (
    <Badge tone={def.tokens.family} className={cn('inline-flex items-center gap-1', className)} {...rest}>
      {icon ? <SeverityIcon level={level} size={12} title="" /> : null}
      {children ?? def.label}
    </Badge>
  );
}

// ─── SeverityCountPill ───────────────────────────────────────────────────────

export interface SeverityCountPillProps {
  level: AdminSeverity;
  count: number;
  /** Renders an `<a>` instead of a `<span>` when set, e.g. a deep link into a filtered list. */
  href?: string;
  /** Overrides the level's default label (e.g. "Needs you" vs. "Waiting for you"). */
  label?: string;
  className?: string;
}

/**
 * The header count pill (D4) — same markup shape as the three hand-written pills at
 * `AdminShell.tsx:402-412`, generalized across all five levels. Named `SeverityCountPill`
 * rather than `StatusPill`: `primitives.tsx` already exports a `StatusPill` (a per-row
 * dot+label badge driven by `statusTone()`, used across `RequestsWorkspace.tsx`,
 * `AdminUsers.tsx`, `ObjectWorkspace.tsx` and others) with an unrelated prop shape
 * (`status`/`tone`/`label`, no `count`, no `href`). Reusing that name for this
 * differently-shaped component would collide on import and shadow the existing one —
 * so this task's "header count pill" gets its own name instead.
 *
 * Does not hide itself at `count <= 0` — callers decide whether a zero-count pill
 * renders at all, matching how the three pills it replaces are gated today.
 */
export function SeverityCountPill({ level, count, href, label, className }: SeverityCountPillProps) {
  const def = SEVERITY[level];
  const classes = cn(
    'adm-focusable inline-flex items-center gap-1.5 rounded-[var(--adm-radius-pill)] px-2.5 py-1 text-[length:var(--adm-text-xs)] font-medium',
    PILL_TONE[def.tokens.family],
    className
  );
  const content = (
    <>
      <SeverityIcon level={level} size={12} title="" />
      {label ?? def.label} · {count}
    </>
  );
  return href ? (
    <a href={href} className={classes}>
      {content}
    </a>
  ) : (
    <span className={classes}>{content}</span>
  );
}
