/**
 * Role resolution (T1.4 → T9.4 → W18 T18.1).
 *
 * PRECEDENCE (resolveRolesForPrincipalAsync — the one every Owner gate,
 * `publish-gate.ts` and the review/marginalia gates read):
 *   1. Agent principals → [] (a capability class, not a role — unchanged).
 *   2. `ADMIN_EMAILS` members → owner, ALWAYS (bootstrap Owner; a wiped or
 *      corrupt store, or a suspended record, can never lock them out).
 *   3. A membership record → its tier (below); `suspended` | `removed`
 *      (v1 `disabled`) ⇒ [] — loses all roles.
 *   4. No record → the legacy env allowlists (resolveHumanRoles).
 * A store read that throws is treated as "no record" so the store being
 * unavailable degrades to env rather than denying everyone.
 *
 * TIERS (T18.1, plan §6) and what `expandRole` hands the rest of the system:
 *   owner     → [owner, admin, publisher]   everything; the only tier that manages members
 *   admin     → [admin]                     full content workflow incl. publish
 *   publisher → [publisher]                 publish/release, decide reviews; no member management
 *   editor    → [editor]                    edit + decide reviews; cannot publish
 *   viewer    → [viewer]                    read-only admin; cannot decide reviews or edit
 * `publish-gate.ts` is byte-untouched: it only ever sees admin/publisher.
 *   - execute publish: admin, publisher (C§2.2 Tier 3 / Tier 2 human).
 *   - decide reviews (canDecideReview): owner|admin|publisher|editor — a
 *     HUMAN with only `viewer` (or no role) has no standing. Agents may
 *     decide without a role (review-state.ts decideReview) — the check is
 *     for humans only.
 *
 * Environment: humans get roles from ROLE_EMAILS_ADMIN / _PUBLISHER / _EDITOR
 * (trim + lowercase, exactly ADMIN_EMAILS semantics); every ADMIN_EMAILS
 * member is an admin even with ROLE_EMAILS_ADMIN unset (D§3.9/OQ-5). Agents
 * deliberately resolve to NO roles (D§3.9); per-agent credentials are OQ-3.
 */
import { parseAdminEmails } from './admin-auth.js';
import type { Principal } from '../../schema/object-record-v1.js';
import type { UserRecord, UserRole } from './users-store.js';

export type Role = 'owner' | 'admin' | 'publisher' | 'editor' | 'viewer';

export type RoleEnv = Partial<
  Record<'ROLE_EMAILS_ADMIN' | 'ROLE_EMAILS_PUBLISHER' | 'ROLE_EMAILS_EDITOR' | 'ADMIN_EMAILS', string>
>;

const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Environment principals in descending authority order. A normalized email is
 * returned once even when it appears in more than one allowlist.
 */
export const environmentRoleEntries = (env: RoleEnv = process.env as RoleEnv): Array<[string, Role]> => {
  const entries = new Map<string, Role>();
  const add = (value: string | undefined, role: Role) => {
    for (const email of parseAdminEmails(value)) {
      if (!entries.has(email)) entries.set(email, role);
    }
  };

  add(env.ADMIN_EMAILS, 'owner');
  add(env.ROLE_EMAILS_ADMIN, 'admin');
  add(env.ROLE_EMAILS_PUBLISHER, 'publisher');
  add(env.ROLE_EMAILS_EDITOR, 'editor');
  return [...entries.entries()];
};

export const environmentRoleForEmail = (email: string, env: RoleEnv = process.env as RoleEnv): Role | undefined => {
  const normalized = normalizeEmail(email);
  return environmentRoleEntries(env).find(([candidate]) => candidate === normalized)?.[1];
};

export const resolveHumanRoles = (email: string, env: RoleEnv = process.env as RoleEnv): Role[] => {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];

  const admins = new Set([...parseAdminEmails(env.ROLE_EMAILS_ADMIN), ...parseAdminEmails(env.ADMIN_EMAILS)]);
  const publishers = parseAdminEmails(env.ROLE_EMAILS_PUBLISHER);
  const editors = parseAdminEmails(env.ROLE_EMAILS_EDITOR);

  const roles: Role[] = [];
  if (admins.has(normalized)) roles.push('admin');
  if (publishers.includes(normalized)) roles.push('publisher');
  if (editors.includes(normalized)) roles.push('editor');
  return roles;
};

export const resolveRolesForPrincipal = (principal: Principal, env: RoleEnv = process.env as RoleEnv): Role[] =>
  principal.kind === 'human' ? resolveHumanRoles(principal.email, env) : [];

/**
 * A workspace tier expanded to the full role set the rest of the system reads.
 * `owner` implies admin + publisher so publish-gate.ts stays byte-untouched
 * (it only ever sees admin/publisher); the `owner` entry is additive for the
 * Owner-only gates. T18.1: publisher/editor/viewer are their own single role.
 */
export const expandRole = (role: UserRole): Role[] => {
  switch (role) {
    case 'owner':
      return ['owner', 'admin', 'publisher'];
    case 'admin':
      return ['admin'];
    case 'publisher':
      return ['publisher'];
    case 'editor':
      return ['editor'];
    case 'viewer':
      return ['viewer'];
    default:
      return [];
  }
};

export const isOwner = (roles: readonly Role[]): boolean => roles.includes('owner');

export interface AsyncRoleResolverDeps {
  env?: RoleEnv;
  /** Reads a users-store record by email; omit to resolve from env only. Throwing → treated as "no record" (env fallback). */
  getUserRecord?: (email: string) => Promise<UserRecord | null>;
}

/**
 * The T9.4 async resolver — precedence in the file header. `getUserRecord`
 * is the users-store adapter over membership v2 (T18.1): a `suspended` or
 * `removed` membership reads as `disabled` and resolves to [].
 */
export const resolveRolesForPrincipalAsync = async (
  principal: Principal,
  deps: AsyncRoleResolverDeps = {}
): Promise<Role[]> => {
  const env = deps.env ?? (process.env as RoleEnv);
  if (principal.kind !== 'human') return [];

  const normalized = normalizeEmail(principal.email);
  if (!normalized) return [];

  // (2) Bootstrap Owner — overrides the store entirely (lockout-impossible).
  const bootstrapOwners = new Set(parseAdminEmails(env.ADMIN_EMAILS));
  if (bootstrapOwners.has(normalized)) return expandRole('owner');

  // (3) Store record wins for everyone else.
  if (deps.getUserRecord) {
    let record: UserRecord | null = null;
    try {
      record = await deps.getUserRecord(normalized);
    } catch {
      record = null; // store unavailable/corrupt → fall through to env
    }
    if (record) {
      if (record.status === 'disabled') return [];
      return expandRole(record.role);
    }
  }

  // (4) Legacy env allowlists (never grants owner except via ADMIN_EMAILS above).
  return resolveHumanRoles(principal.email, env);
};

/** Publish execution authority (Tier 2 human path, Tier 3 always): admin or publisher. */
export const canExecutePublish = (roles: readonly Role[]): boolean =>
  roles.includes('admin') || roles.includes('publisher');

/** Roles with review standing (T18.1: `viewer` is read-only and excluded). */
const REVIEW_ROLES: ReadonlySet<Role> = new Set<Role>(['owner', 'admin', 'publisher', 'editor']);

/** A HUMAN review decision requires a role with standing — owner|admin|publisher|editor.
 *  (Agents are allowed to decide without a role — see review-state.ts decideReview.) */
export const canDecideReview = (roles: readonly Role[]): boolean => roles.some((role) => REVIEW_ROLES.has(role));
