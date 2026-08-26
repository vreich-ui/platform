/**
 * Tenant-safe labels used by the shared admin shell. The shell is fleet law,
 * so a client name must always come from the bound SiteIdentity rather than a
 * label left over from another publication.
 */
export const settingsNavigationLabel = (brandName: string | undefined): string => {
  const label = brandName?.trim();
  return label ? `Settings · ${label}` : 'Settings';
};

/**
 * Nav visibility rules (T4.3 nav fix). The audit's §2/§11.9 finding: the
 * client-side `NAV` array and the server ADMIN gate are independent — this
 * module governs the FORMER only (what shows in the sidebar/Cmd-K), never
 * access. A route with no nav link is still protected server-side by its own
 * function wall; hiding or showing a link here changes discoverability, not
 * authority.
 *
 * `ownerOnly` was previously a GROUP-level-only flag (`AdminShell.tsx`'s old
 * `NAV.filter(g => !g.ownerOnly || owner)`): an all-or-nothing gate on every
 * item in a group. That is what left `/admin/settings/admins` unlinked for a
 * non-owner Admin — `AdminUsers.tsx`'s `list` verb is admin-tier, not
 * owner-tier, but the Admins item lived inside the owner-only "Settings"
 * group with no way to say "this one item is different." `ownerOnly` is now
 * also a per-ITEM property; `visibleNavGroups` checks both levels, so a
 * group can mix owner-only and admin-visible items (a group itself may still
 * be marked `ownerOnly` to hide it in full, for a group with nothing
 * non-owners should ever see).
 */
export interface NavVisibilityNode {
  ownerOnly?: boolean;
}

export interface NavVisibilityGroup extends NavVisibilityNode {
  items: readonly NavVisibilityNode[];
}

/** One item/group is visible to an owner always, and to a non-owner unless it is marked `ownerOnly`. */
export const isNavVisible = (node: NavVisibilityNode, owner: boolean): boolean => owner || !node.ownerOnly;

/**
 * Filters a NAV tree for one viewer: drops `ownerOnly` groups outright for a
 * non-owner, then drops `ownerOnly` items within a surviving group, then
 * drops any group left with no items (a group that WAS only owner-only items
 * plus a non-owner viewer). Pure and generic over the item shape (a single
 * type param, with the item type pulled out via `G['items'][number]` rather
 * than a second free type param — TS cannot infer a param that appears only
 * inside another param's constraint) so the caller's real `NavItem`
 * (label/href/icon/…) round-trips unchanged; the sidebar list and the Cmd-K
 * command list (`AdminShell.tsx`) both call this rather than each
 * re-implementing the same two-level filter.
 */
export function visibleNavGroups<G extends NavVisibilityGroup>(
  groups: readonly G[],
  owner: boolean
): Array<Omit<G, 'items'> & { items: Array<G['items'][number]> }> {
  return groups
    .filter((group) => isNavVisible(group, owner))
    .map((group) => ({ ...group, items: group.items.filter((item) => isNavVisible(item, owner)) }))
    .filter((group) => group.items.length > 0);
}
