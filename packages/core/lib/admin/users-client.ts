/**
 * Admin users client (T9.5/T9.6) — browser wrappers over the admin-users
 * verb endpoint. me/update_me are self-service (any admin); list / invite /
 * set_role / disable are Owner-only (the server 403s a non-owner).
 */
import type { GetToken } from '../edit-mode/verbs-client.js';

const ENDPOINT = '/.netlify/functions/admin-users';

/** The five workspace tiers (T18.1). */
export type UserRole = 'owner' | 'admin' | 'publisher' | 'editor' | 'viewer';
export type UserViewRole = UserRole;
/** The v1 VIEW status; `membership_status` carries the real v2 state (suspended|removed both view as `disabled`). */
export type UserStatus = 'invited' | 'active' | 'disabled';
export type MembershipStatus = 'invited' | 'active' | 'suspended' | 'removed';
export type MembershipSource = 'bootstrap_env' | 'invitation' | 'netlify_ui' | 'mcp' | 'import' | 'legacy_v1';

export interface UserAuditEntry {
  at: string;
  actor_email: string;
  action: string;
  detail?: string;
}

export interface UserView {
  email: string;
  display_name: string;
  avatar_artifact?: string;
  role: UserViewRole;
  status: UserStatus;
  source?: 'stored' | 'environment';
  invited_by?: string;
  created_at?: string;
  updated_at?: string;
  last_seen_at?: string;
  audit?: UserAuditEntry[];
  /** T18.1 (membership v2) */
  person_id?: string;
  membership_status?: MembershipStatus;
  membership_source?: MembershipSource;
}

async function post<T>(getToken: GetToken, body: Record<string, unknown>): Promise<T> {
  const token = await getToken();
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as T;
}

export const fetchMe = (getToken: GetToken) =>
  post<{ user: UserView; bootstrap: boolean; roles: string[] }>(getToken, { verb: 'me' });

export const updateMe = async (getToken: GetToken, fields: { display_name?: string; avatar_artifact?: string }) => {
  const result = await post<{ user: UserView }>(getToken, { verb: 'update_me', ...fields });
  if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('cms:user-updated', { detail: result.user }));
  return result;
};

export const listUsers = (getToken: GetToken, opts: { include_removed?: boolean } = {}) =>
  post<{ users: UserView[] }>(getToken, { verb: 'list', ...opts });

export const inviteUser = (getToken: GetToken, email: string, role: UserRole) =>
  post<{ user: UserView; invite: { sent: boolean } }>(getToken, { verb: 'invite', email, role });

export const setUserRole = (getToken: GetToken, email: string, role: UserRole) =>
  post<{ user: UserView }>(getToken, { verb: 'set_role', email, role });

/** T18.1: `suspend` (roles → [] until reinstated). `disableUser` remains as the alias for one release. */
export const suspendUser = (getToken: GetToken, email: string, reason?: string) =>
  post<{ user: UserView }>(getToken, { verb: 'suspend', email, ...(reason ? { reason } : {}) });

export const disableUser = (getToken: GetToken, email: string) => suspendUser(getToken, email);

export const reinstateUser = (getToken: GetToken, email: string) =>
  post<{ user: UserView }>(getToken, { verb: 'reinstate', email });

/** T18.1: give an ADMIN_EMAILS member a stored Owner membership (so the env row can be emptied later). */
export const promoteBootstrapOwner = (getToken: GetToken, email: string) =>
  post<{ user: UserView }>(getToken, { verb: 'promote_bootstrap', email });

/**
 * T18.0b — the accept page's verbs (server contract: T18.0a).
 * `acceptInvite` runs on the fresh session GoTrue's /verify returned: flips the
 * caller's invited record to active with the typed name; `needs_grant:true`
 * (user null) means no record exists — nothing was created or granted.
 */
export const acceptInvite = (getToken: GetToken, fields: { display_name: string }) =>
  post<{ user: UserView | null; needs_grant: boolean; bootstrap?: boolean }>(getToken, {
    verb: 'accept',
    display_name: fields.display_name,
  });

export interface InvitePreview {
  site: { name: string; slug: string };
  policy: { min_password: number };
}

/** Public (no session): site name + password policy for the accept page. The token is not validated server-side. */
export const invitePreview = async (token?: string): Promise<InvitePreview> => {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ verb: 'invite_preview', ...(token ? { token } : {}) }),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error((json.error as string) || `Request failed (${res.status}).`);
  return json as unknown as InvitePreview;
};

/** Resolve an image artifact reference (image/<id>/<sha>.<ext>) to its servable path. */
export const avatarSrc = (ref: string | undefined): string | undefined =>
  ref && ref.startsWith('image/') ? `/img/${ref.slice('image/'.length)}` : undefined;
