/**
 * Extractable, framework-free component logic for the admin kit (T9.2).
 *
 * Kept out of the .tsx files so it can be unit-tested as plain TS (the .tsx
 * components import these). Covers: DataTable sorting, CommandPalette
 * filtering/ranking, status → tone mapping, and relative-time phrasing.
 */
import type { CriterionStatus } from '../lib/admin/readiness-criteria.js';

// ─── status tone ──────────────────────────────────────────────────────────────

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger' | 'info';

/** Readiness criterion status → a kit tone (drives Badge/StatusPill colors). */
export function statusTone(status: CriterionStatus | string): Tone {
  switch (status) {
    case 'complete':
      return 'success';
    case 'warning':
      return 'warning';
    case 'missing':
      return 'danger';
    case 'optional':
      return 'neutral';
    // common object lifecycle words reused across surfaces
    case 'active':
    case 'published':
    case 'approved':
      return 'success';
    case 'draft':
    case 'open':
    case 'in_progress':
      return 'info';
    case 'archived':
    case 'changes_requested':
      return 'warning';
    case 'failed':
      return 'danger';
    default:
      return 'neutral';
  }
}

// ─── DataTable sorting ────────────────────────────────────────────────────────

export type SortDirection = 'asc' | 'desc';

/**
 * Stable sort of `rows` by a derived comparable value. Strings compare with
 * locale awareness; numbers/booleans numerically; nullish sinks to the end
 * regardless of direction. Returns a new array — never mutates the input.
 */
export function sortRows<T>(rows: readonly T[], getValue: (row: T) => unknown, direction: SortDirection = 'asc'): T[] {
  const factor = direction === 'desc' ? -1 : 1;
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) => {
      const av = getValue(a.row);
      const bv = getValue(b.row);
      const an = av === null || av === undefined || av === '';
      const bn = bv === null || bv === undefined || bv === '';
      if (an && bn) return a.index - b.index;
      if (an) return 1; // nullish always last
      if (bn) return -1;
      let cmp: number;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else if (typeof av === 'boolean' && typeof bv === 'boolean') cmp = Number(av) - Number(bv);
      else cmp = String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: 'base' });
      if (cmp === 0) return a.index - b.index; // stable
      return cmp * factor;
    })
    .map((entry) => entry.row);
}

// ─── CommandPalette filtering ─────────────────────────────────────────────────

export interface CommandLike {
  id: string;
  label: string;
  keywords?: string[];
  group?: string;
}

/**
 * Filter + rank commands for a query. Empty query returns everything in the
 * original order. Otherwise ranks: label prefix (0) > word-boundary in label
 * (1) > substring in label (2) > keyword hit (3); ties keep original order.
 */
export function filterCommands<T extends CommandLike>(items: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];

  const scored: Array<{ item: T; rank: number; index: number }> = [];
  items.forEach((item, index) => {
    const label = item.label.toLowerCase();
    let rank = Number.POSITIVE_INFINITY;
    if (label.startsWith(q)) rank = 0;
    else if (new RegExp(`\\b${escapeRegExp(q)}`).test(label)) rank = 1;
    else if (label.includes(q)) rank = 2;
    else if (item.keywords?.some((k) => k.toLowerCase().includes(q))) rank = 3;
    if (rank !== Number.POSITIVE_INFINITY) scored.push({ item, rank, index });
  });

  return scored.sort((a, b) => (a.rank === b.rank ? a.index - b.index : a.rank - b.rank)).map((s) => s.item);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ─── relative time ────────────────────────────────────────────────────────────

/**
 * Compact human relative time for history timelines: "just now", "5m ago",
 * "3h ago", "2d ago", then an absolute date past a week. Future timestamps
 * read "just now" (clock skew shouldn't render "-3m ago").
 */
export function relativeTimeFromNow(iso: string | undefined, nowMs: number): string {
  if (!iso) return '';
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  const diff = nowMs - then;
  if (diff < 45_000) return 'just now';
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(diff / 3_600_000);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(diff / 86_400_000);
  if (days < 7) return `${days}d ago`;
  return new Date(then).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

// ─── membership (W18 T18.3a/b) ─────────────────────────────────────────────────

export type MembershipTier = 'owner' | 'admin' | 'publisher' | 'editor' | 'viewer';

/** Plan §6 — the role picker's labels + one-line descriptions, most powerful first. */
export const MEMBERSHIP_TIERS: ReadonlyArray<{ value: MembershipTier; label: string; description: string }> = [
  { value: 'owner', label: 'Owner', description: 'Everything — members, roles, guardrails, recipes, maintenance.' },
  {
    value: 'admin',
    label: 'Admin',
    description: 'Full content workflow: create, edit, publish, release, decide reviews; sees members.',
  },
  {
    value: 'publisher',
    label: 'Publisher',
    description: 'Edit, decide reviews, and publish/release. No member management.',
  },
  { value: 'editor', label: 'Editor', description: 'Create and edit drafts, decide reviews. Cannot publish.' },
  { value: 'viewer', label: 'Viewer', description: 'Read-only: browse objects and chat with read tools.' },
];

export const tierLabel = (tier: string): string =>
  MEMBERSHIP_TIERS.find((t) => t.value === tier)?.label ?? tier.charAt(0).toUpperCase() + tier.slice(1);

/** Subset of policy the client needs (mirrors DEFAULT_MEMBERSHIP_POLICY when the server sends nothing). */
export interface MembershipPolicyView {
  who_can_invite: 'owner' | 'owner_admin';
  roles_admin_may_grant: ReadonlyArray<'admin' | 'publisher' | 'editor' | 'viewer'>;
  max_resends: number;
}

export const DEFAULT_POLICY_VIEW: MembershipPolicyView = {
  who_can_invite: 'owner_admin',
  roles_admin_may_grant: ['editor', 'viewer'],
  max_resends: 5,
};

/**
 * Which tiers the ACTOR may grant (invite / change role to). Owner: all five.
 * Admin: `roles_admin_may_grant` when `who_can_invite === 'owner_admin'`,
 * else none. Everyone else: none. Pure — tested in logic.test.ts.
 */
export function grantableTiers(
  actorRoles: readonly string[],
  policy: MembershipPolicyView = DEFAULT_POLICY_VIEW
): MembershipTier[] {
  if (actorRoles.includes('owner')) return MEMBERSHIP_TIERS.map((t) => t.value);
  if (actorRoles.includes('admin') && policy.who_can_invite === 'owner_admin') {
    return MEMBERSHIP_TIERS.map((t) => t.value).filter((t) =>
      (policy.roles_admin_may_grant as readonly string[]).includes(t)
    );
  }
  return [];
}

/** Role options for the picker: every tier, `disabled` when the actor may not grant it (or it is the current role). */
export function roleOptionsFor(input: {
  actorRoles: readonly string[];
  policy?: MembershipPolicyView;
  currentRole?: string;
}): Array<{ value: MembershipTier; label: string; description: string; disabled: boolean; reason?: string }> {
  const allowed = new Set(grantableTiers(input.actorRoles, input.policy));
  return MEMBERSHIP_TIERS.map((t) => {
    if (t.value === input.currentRole) return { ...t, disabled: true, reason: 'Current role' };
    if (!allowed.has(t.value)) return { ...t, disabled: true, reason: 'An Owner must grant this role' };
    return { ...t, disabled: false };
  });
}

export interface MemberRowInput {
  email: string;
  role: string;
  /** v1 view status */
  status: 'invited' | 'active' | 'disabled';
  membership_status?: 'invited' | 'active' | 'suspended' | 'removed';
  source?: 'stored' | 'environment';
  membership_source?: string;
}

export type MemberAction = 'change_role' | 'suspend' | 'reinstate' | 'remove' | 'promote_bootstrap' | 'view_audit';

/**
 * Which row actions are available for a member, given who is acting. Env
 * (break-glass) rows: only Promote + audit. Self: audit only. Removed: audit
 * only. Non-owners: audit only (the page is read-only for them).
 */
export function memberActionsFor(input: {
  row: MemberRowInput;
  actorEmail: string;
  actorRoles: readonly string[];
}): MemberAction[] {
  // T18.6a: an Admin sees the list read-only (the audit stream is Owner-only) — no row actions at all.
  if (!input.actorRoles.includes('owner')) return [];
  const actions: MemberAction[] = ['view_audit'];
  const isSelf = input.row.email === input.actorEmail;
  if (isSelf) return actions;
  if (input.row.source === 'environment') return ['promote_bootstrap', ...actions];
  const status = input.row.membership_status ?? (input.row.status === 'disabled' ? 'suspended' : input.row.status);
  if (status === 'removed') return actions;
  actions.unshift('change_role');
  if (status === 'suspended') actions.push('reinstate');
  else actions.push('suspend');
  actions.push('remove');
  return actions;
}

/** Badge copy for the member's provenance. */
export function memberSourceLabel(row: Pick<MemberRowInput, 'source' | 'membership_source'>): string | null {
  if (row.source === 'environment') return 'Break-glass (env)';
  switch (row.membership_source) {
    case 'bootstrap_env':
      return 'Bootstrap';
    case 'invitation':
      return 'Invitation';
    case 'netlify_ui':
      return 'Netlify UI';
    case 'mcp':
      return 'MCP';
    case 'import':
      return 'Import';
    case 'legacy_v1':
      return null; // ordinary stored member from before v2 — no badge
    default:
      return null;
  }
}

/** "expires in 3d 4h" / "expires in 20m" / "expired" — for the invitations tab. */
export function formatExpiresIn(expiresAtIso: string, nowMs: number): string {
  const diff = Date.parse(expiresAtIso) - nowMs;
  if (!Number.isFinite(diff)) return '';
  if (diff <= 0) return 'expired';
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 60) return `expires in ${Math.max(1, minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `expires in ${hours}h`;
  const days = Math.floor(hours / 24);
  const remH = hours % 24;
  return remH ? `expires in ${days}d ${remH}h` : `expires in ${days}d`;
}

export interface InvitationRowInput {
  status: 'pending' | 'accepted' | 'expired' | 'revoked';
  send_count: number;
  gotrue_invited: boolean;
  gotrue_error?: string;
}

export type InvitationAction = 'resend' | 'revoke';

/** Resend/revoke availability by status and the resend cap. */
export function invitationActionsFor(
  row: InvitationRowInput,
  policy: MembershipPolicyView = DEFAULT_POLICY_VIEW
): {
  resend: { enabled: boolean; reason?: string };
  revoke: { enabled: boolean; reason?: string };
} {
  if (row.status !== 'pending') {
    const reason = row.status === 'expired' ? 'Expired — send a new invitation' : `Invitation ${row.status}`;
    return { resend: { enabled: false, reason }, revoke: { enabled: false, reason } };
  }
  if (row.send_count >= policy.max_resends) {
    return {
      resend: {
        enabled: false,
        reason: `Sent ${row.send_count}× (max ${policy.max_resends}) — revoke and invite again`,
      },
      revoke: { enabled: true },
    };
  }
  return { resend: { enabled: true }, revoke: { enabled: true } };
}

/** GoTrue send-status cell copy + the "how to fix" hint. */
export function invitationSendStatus(row: Pick<InvitationRowInput, 'gotrue_invited' | 'gotrue_error' | 'send_count'>): {
  label: string;
  tone: Tone;
  hint?: string;
} {
  if (row.gotrue_invited && !row.gotrue_error)
    return { label: row.send_count > 1 ? `Sent ${row.send_count}×` : 'Sent', tone: 'success' };
  if (row.gotrue_error === 'already_invited') {
    return {
      label: 'Already in Identity',
      tone: 'info',
      hint: 'Netlify Identity already has this address — they can sign in, or re-send from the Netlify UI.',
    };
  }
  if (row.gotrue_error && /token unavailable|identity_admin_unavailable/i.test(row.gotrue_error)) {
    return {
      label: 'Not sent',
      tone: 'warning',
      hint: 'Enable Netlify Identity on this site (console) — the invite e-mail could not be sent. Then Resend.',
    };
  }
  if (row.gotrue_error)
    return {
      label: 'Not sent',
      tone: 'danger',
      hint: `${row.gotrue_error} — fix, then Resend; or re-send from the Netlify UI Identity tab.`,
    };
  return { label: 'Not sent', tone: 'warning', hint: 'Resend to trigger the e-mail.' };
}

// ─── welcome gate (W18 T18.5) ─────────────────────────────────────────────────

/** Admin paths that never redirect to /admin/welcome (the page itself, the token landing page, the OAuth consent screen). */
export const WELCOME_EXEMPT_PATHS: ReadonlySet<string> = new Set([
  '/admin/welcome',
  '/admin/accept',
  '/admin/authorize',
]);

export type WelcomeGateDecision = 'render' | 'redirect' | 'forbidden';

/**
 * Pure gate predicate. `hasRecord` = the caller has a stored membership
 * (invited / Netlify-UI granted / bootstrap-materialised); `completed` =
 * `Person.onboarding.completed_at` is set. A caller with no roles is the
 * layout's forbidden panel, never a redirect (so `needs_grant` users cannot
 * loop into welcome); env Owners are materialised by their first `me`, so
 * they have a record and pass through welcome exactly once.
 */
export function welcomeGateDecision(input: {
  path: string;
  roles: readonly string[];
  hasRecord: boolean;
  completed: boolean;
  requireDisplayName: boolean;
}): WelcomeGateDecision {
  if (input.roles.length === 0) return 'forbidden';
  const path = input.path.replace(/\/+$/, '') || '/';
  if (WELCOME_EXEMPT_PATHS.has(path)) return 'render';
  if (!input.requireDisplayName) return 'render';
  if (!input.hasRecord) return 'render';
  return input.completed ? 'render' : 'redirect';
}
