/** Pure presentation rules shared by the admin-members surface. */
import type { UserView } from './users-client.js';

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
