/**
 * D4 — the five-level admin severity standard (T1.1), and the one place it is
 * defined.
 *
 * `activity-severity.ts` (W19) already owns run/node/tool-call classification
 * and is left untouched by this module — its four levels (`failure`,
 * `attention`, `notice`, `ok`) are mapped onto D4's five via
 * `severityFromActivity` below, not replaced. Every OTHER status vocabulary in
 * the admin (`request-logic.ts`, `editorial-state.ts`, `library-logic.ts`,
 * `admin/logic.ts`'s `statusTone`, `AdminUsers.tsx`'s `statusToneFor`) is out
 * of scope for this task — T0.3 (`docs/plan/ux-inventory.md`, Table C) flags
 * consolidating them onto this vocabulary as separate, later work.
 *
 * Five levels, one meaning each, no exceptions:
 *
 *   info      — FYI. A fact being reported, nothing to decide. Slate/blue.
 *   success   — done, a receipt. Green.
 *   needs_you — a decision or action is needed. The run PAUSES, it is not
 *               dead. Amber — never red.
 *   error     — failed, but a retry affordance exists. Red, circle-!.
 *   blocked   — a hard stop with no forward path. Red, octagon. The only
 *               level a red ✕/octagon may ever represent.
 *
 * Naming: `activity-severity.ts` already exports a `Severity` type (its own,
 * unrelated four-level union). This module's five-level union is named
 * `AdminSeverity` instead of reusing `Severity`, matching the convention
 * `requests-client.ts`/`RequestActivity.tsx` already established for the very
 * same reason (`ActivitySeverity`, aliased on import) — so the two can be
 * imported side by side (as the adapter below does) without a collision or a
 * silent shadow.
 */
import type { Severity as ActivitySeverity } from './activity-severity.js';

export type AdminSeverity = 'info' | 'success' | 'needs_you' | 'error' | 'blocked';

/** All five levels, worst-first — mirrors `activity-severity.ts`'s `SEVERITY_RANK` shape. */
export const ADMIN_SEVERITY_ORDER: readonly AdminSeverity[] = ['blocked', 'error', 'needs_you', 'info', 'success'];

/**
 * The token FAMILY a level draws its color from. `error` and `blocked` share
 * `danger` deliberately — D4 draws the Error/Blocked line with the icon
 * (circle-! vs octagon), never with a second red. `--adm-<family>`,
 * `--adm-<family>-soft`, `--adm-<family>-text` all already exist in
 * `admin-tokens.css` for all four families; T1.1 adds no new CSS tokens.
 */
export type SeverityTokenFamily = 'info' | 'success' | 'warning' | 'danger';

/** Which glyph (from `admin/icons.tsx`) a level renders. Every level's icon is unique. */
export type SeverityIconKey = 'info' | 'check' | 'alert-triangle' | 'alert-circle' | 'octagon';

export interface SeverityDefinition {
  key: AdminSeverity;
  /** Editor-facing default label — callers may override per surface. */
  label: string;
  /** The `--adm-*` family this level's solid/soft/text tokens come from. */
  tokens: { family: SeverityTokenFamily; solid: string; soft: string; text: string };
  icon: SeverityIconKey;
  /** True only for `blocked` — the sole level with no forward path. */
  blocking: boolean;
}

const family = (name: SeverityTokenFamily): SeverityDefinition['tokens'] => ({
  family: name,
  solid: `--adm-${name}`,
  soft: `--adm-${name}-soft`,
  text: `--adm-${name}-text`,
});

/** The one source of truth D4 asks for. Every consumer — icon, badge, pill, copy — reads this. */
export const SEVERITY: Record<AdminSeverity, SeverityDefinition> = {
  info: { key: 'info', label: 'Info', tokens: family('info'), icon: 'info', blocking: false },
  success: { key: 'success', label: 'Success', tokens: family('success'), icon: 'check', blocking: false },
  needs_you: {
    key: 'needs_you',
    label: 'Needs you',
    tokens: family('warning'),
    icon: 'alert-triangle',
    blocking: false,
  },
  error: { key: 'error', label: 'Error', tokens: family('danger'), icon: 'alert-circle', blocking: false },
  blocked: { key: 'blocked', label: 'Blocked', tokens: family('danger'), icon: 'octagon', blocking: true },
};

// ─── copy tone ─────────────────────────────────────────────────────────────

export interface SeverityCopyParts {
  /** What the message is about — "Publishing", "The draft", "This release". */
  subject?: string;
  /** The thing to do or that happened — used verbatim, so phrase it as asked (see level notes). */
  action?: string;
  /** Why — used by `blocked` ("the article has no signed-in approver"). */
  cause?: string;
  /** The way out — used by `error` (what a retry gets you) and `blocked` (the escape hatch). */
  escape?: string;
}

const sentence = (raw: string): string => {
  const text = raw.trim();
  if (!text) return text;
  const capitalized = text.charAt(0).toUpperCase() + text.slice(1);
  return /[.!?]$/.test(capitalized) ? capitalized : `${capitalized}.`;
};

const join = (...parts: Array<string | undefined>): string =>
  parts.filter((p): p is string => Boolean(p && p.trim())).join(' ');

/**
 * Renders the per-level copy-tone template D4 specifies. Callers supply the
 * parts relevant to the level being rendered (irrelevant parts are ignored,
 * not validated — this is a formatter, not a schema).
 *
 *   info      — neutral statement of fact: "{subject} {action}."
 *   success   — past-tense receipt, same shape as info, reporting a done thing.
 *   needs_you — IMPERATIVE, leading with the action verb. No subject preamble
 *               — `action` must already read as a command ("Approve the
 *               pending release", not "You should approve…").
 *   error     — what failed, then that a retry exists.
 *   blocked   — the cause, then the escape hatch.
 */
export const severityCopy = (level: AdminSeverity, parts: SeverityCopyParts = {}): string => {
  const { subject, action, cause, escape } = parts;
  switch (level) {
    case 'info':
    case 'success':
      return sentence(join(subject, action));
    case 'needs_you':
      return sentence(action ?? join(subject, action));
    case 'error': {
      const failed = sentence(join(subject, 'failed'));
      const retry = sentence(escape ?? 'A retry is available');
      return join(failed, retry);
    }
    case 'blocked': {
      const why = cause ? sentence(cause) : '';
      const way = escape ? sentence(escape) : '';
      return join(why, way);
    }
  }
};

// ─── adapter: activity-severity's four levels → D4's five ──────────────────

/**
 * T0.3 Table B row B1: `activity-severity.ts`'s `failure` conflates a
 * recoverable error (a "Retry this step" button sits right next to the ✕ on
 * the very same card, e.g. `RequestActivity.tsx`'s `onRetry`/`retryNodeId`)
 * with a genuine dead end. The split criterion is exactly that affordance:
 * a `failure` with a retry offered is `error`; one without is `blocked`.
 *
 * `activity-severity.ts` itself is NOT changed by this task — it has no
 * "is a retry offered" signal today (that lives in the UI layer), so this
 * adapter takes it as an explicit argument rather than inventing one.
 *
 *   ok        → success
 *   notice    → info      (T0.3: "notice needs to become Info" — the module's
 *                           deliberate under-coloring of `notice` relative to
 *                           the other levels is a UI-layer/prominence question
 *                           this task does not resolve; see B8)
 *   attention → needs_you
 *   failure   → error   (canRetry: true)
 *             → blocked (canRetry: false/omitted — the safer default: an
 *                         unknown recovery state is treated as a hard stop,
 *                         not silently offered a retry that isn't there)
 */
export const severityFromActivity = (
  activity: ActivitySeverity,
  options: { canRetry?: boolean } = {}
): AdminSeverity => {
  switch (activity) {
    case 'ok':
      return 'success';
    case 'notice':
      return 'info';
    case 'attention':
      return 'needs_you';
    case 'failure':
      return options.canRetry ? 'error' : 'blocked';
  }
};
