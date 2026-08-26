/** Pure presentation rules shared by the admin-members surface. */
import type { MembershipStatus, UserRole, UserView } from './users-client.js';

type CurrentUserIdentity = Pick<UserView, 'email' | 'display_name'> | null | undefined;

const normalizedEmail = (email: string): string => email.trim().toLowerCase();

/** Prefer the signed-in identity returned by `me` for that member's own row. */
export function canonicalMemberDisplayName(member: UserView, currentUser: CurrentUserIdentity): string {
  if (
    currentUser &&
    normalizedEmail(member.email) === normalizedEmail(currentUser.email) &&
    currentUser.display_name.trim()
  ) {
    return currentUser.display_name;
  }
  return member.display_name;
}

export type LastSeenPresentation =
  | { kind: 'relative' }
  | { kind: 'not_tracked'; label: 'Activity not tracked' }
  | { kind: 'not_seen'; label: 'Not signed in yet' };

/** Environment-managed principals have no activity feed until they sign in. */
export function presentLastSeen(member: Pick<UserView, 'source' | 'last_seen_at'>): LastSeenPresentation {
  if (member.last_seen_at) return { kind: 'relative' };
  if (member.source === 'environment') return { kind: 'not_tracked', label: 'Activity not tracked' };
  return { kind: 'not_seen', label: 'Not signed in yet' };
}

// ─── T4.3: member list search / filter ─────────────────────────────────────

/**
 * The real v2 membership status, resolved even from a v1 VIEW row where
 * `status` only distinguishes `invited|active|disabled` (`disabled` covers
 * both `suspended` and `removed` — `membership_status`, when present, is
 * authoritative). Mirrors the inline helper `AdminUsers.tsx` carried before
 * T4.3; extracted here so the members-table toolbar can filter by the same
 * status the Status column renders.
 */
export function resolveMembershipStatus(member: Pick<UserView, 'status' | 'membership_status'>): MembershipStatus {
  return member.membership_status ?? (member.status === 'disabled' ? 'suspended' : member.status);
}

const normalizeSearchText = (text: string): string => text.trim().toLowerCase();

/** Free-text match over display name and e-mail (case-insensitive, substring). An empty/blank query matches everyone. */
export function memberMatchesQuery(member: Pick<UserView, 'display_name' | 'email'>, query: string): boolean {
  const q = normalizeSearchText(query);
  if (!q) return true;
  return normalizeSearchText(member.display_name).includes(q) || normalizeSearchText(member.email).includes(q);
}

export interface MemberListFilters {
  query?: string;
  role?: UserRole | 'all';
  status?: MembershipStatus | 'all';
}

/** Role/status dropdown match; `'all'` (or omitted) passes everything on that axis. */
export function memberMatchesFilters(
  member: Pick<UserView, 'role' | 'status' | 'membership_status'>,
  filters: Pick<MemberListFilters, 'role' | 'status'>
): boolean {
  if (filters.role && filters.role !== 'all' && member.role !== filters.role) return false;
  if (filters.status && filters.status !== 'all' && resolveMembershipStatus(member) !== filters.status) return false;
  return true;
}

/** The members table toolbar's combined predicate: search AND role AND status. */
export function filterMembers<
  T extends Pick<UserView, 'display_name' | 'email' | 'role' | 'status' | 'membership_status'>,
>(members: readonly T[], filters: MemberListFilters): T[] {
  return members.filter((m) => memberMatchesQuery(m, filters.query ?? '') && memberMatchesFilters(m, filters));
}
