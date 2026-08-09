/**
 * Responsive admin workspace contract.
 *
 * The three-column object workspace is useful only once there is enough room
 * for all three working surfaces. Below `xl`, the Object Stage remains the
 * page's only persistent surface; publication navigation and the agent open
 * as modal drawers from compact controls.
 */
export const ADMIN_EXPANDED_NAV_BREAKPOINT = 'xl';
export const WORKSPACE_EXPANDED_BREAKPOINT = 'xl';
export const WORKSPACE_EXPANDED_MIN_WIDTH = 1280;

export const ADMIN_EXPANDED_NAV_CLASS = 'xl:flex';
export const ADMIN_COMPACT_NAV_CLASS = 'xl:hidden';
export const WORKSPACE_EXPANDED_GRID_CLASS = 'xl:grid-cols-[minmax(12rem,20%)_minmax(0,52%)_minmax(18rem,28%)]';
export const WORKSPACE_COMPACT_PANEL_CLASS = 'xl:hidden';
export const WORKSPACE_EXPANDED_PANEL_CLASS = 'hidden xl:block';
