/**
 * Membership policy (W18 T18.1, plan §2.1 `MembershipPolicy`) — the committed
 * default every site starts from. An Owner can override fields at runtime
 * (`policy.json` in the site's `users` store — `getPolicy`/`setPolicy` in
 * `server/lib/membership/write.ts`); anything unset falls back to these values.
 *
 * Governing defaults (plan §9, R8): Owner+Admin may invite editor/viewer,
 * Owner alone the rest; `min_owners = 1` counted over stored active Owners +
 * env bootstrap Owners; identity is deleted on `remove` (T18.4) unless the
 * caller says otherwise.
 */
export interface MembershipPolicy {
  invite_ttl_hours: number;
  max_resends: number;
  allowed_email_domains?: string[];
  default_role: 'owner' | 'admin' | 'publisher' | 'editor' | 'viewer';
  min_owners: number;
  require_display_name: boolean;
  purge_grace_days: number;
  who_can_invite: 'owner' | 'owner_admin';
  roles_admin_may_grant: Array<'admin' | 'publisher' | 'editor' | 'viewer'>;
  /** Role a Netlify-UI invitee gets when an Owner grants from the unmanaged-identity list (T18.2). */
  default_role_for_external: 'viewer' | 'editor';
  /** T18.4: delete the GoTrue identity on `remove` unless `delete_identity:false` is passed. */
  delete_identity_on_remove: boolean;
}

export const DEFAULT_MEMBERSHIP_POLICY: MembershipPolicy = {
  invite_ttl_hours: 168,
  max_resends: 5,
  default_role: 'admin',
  min_owners: 1,
  require_display_name: true,
  purge_grace_days: 30,
  who_can_invite: 'owner_admin',
  roles_admin_may_grant: ['editor', 'viewer'],
  default_role_for_external: 'viewer',
  delete_identity_on_remove: true,
};
