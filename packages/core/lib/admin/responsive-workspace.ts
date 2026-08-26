/**
 * Responsive admin workspace contract.
 *
 * The three-column object workspace is useful only once there is enough room
 * for all three working surfaces. Below `xl`, the Object Stage remains the
 * page's only persistent surface; publication navigation and the agent open
 * as modal drawers from compact controls.
 *
 * T2.2 note: the object DETAIL view is now two columns (content + agent
 * dock) — the library column moved out to the objects plane (`/admin/objects`,
 * T2.1) — so it consumes `WORKSPACE_EXPANDED_MIN_WIDTH` only. The three
 * `WORKSPACE_*_CLASS` constants below currently have no component consumer;
 * they are left in place (with their tests) rather than deleted, because
 * deciding whether the three-column contract is dead belongs with the
 * remaining workspace surfaces, not with this one rebuild.
 */
export const ADMIN_EXPANDED_NAV_BREAKPOINT = 'xl';
export const WORKSPACE_EXPANDED_BREAKPOINT = 'xl';
export const WORKSPACE_EXPANDED_MIN_WIDTH = 1280;

export const ADMIN_EXPANDED_NAV_CLASS = 'xl:flex';
export const ADMIN_COMPACT_NAV_CLASS = 'xl:hidden';
export const WORKSPACE_EXPANDED_GRID_CLASS = 'xl:grid-cols-[minmax(12rem,20%)_minmax(0,52%)_minmax(18rem,28%)]';
export const WORKSPACE_COMPACT_PANEL_CLASS = 'xl:hidden';
export const WORKSPACE_EXPANDED_PANEL_CLASS = 'hidden xl:block';
