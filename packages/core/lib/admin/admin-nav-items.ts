/**
 * The AdminShell sidebar/Cmd-K nav tree, as plain data.
 *
 * This used to be a hardcoded array inside `AdminShell.tsx` (a `.tsx` file —
 * `tsconfig.test.json` excludes `packages/core/admin/**\/*.tsx` because that
 * tree resolves Astro/JSX concerns a `node --test` compile can't follow, see
 * that config's own comment). Lifted out here as a plain module — no React,
 * no icon components, just strings and booleans — so a test can import the
 * real nav tree and check every href against the real route tables, instead
 * of hand-copying the list into a fixture that silently drifts (which is how
 * `/admin/traffic` shipped a 404: the nav link was added, the route
 * registration was not, and nothing checked the two against each other).
 *
 * `icon` is a NAME, not a component reference, precisely so this module
 * stays free of `icons.tsx` (also excluded) and anything JSX. `AdminShell.tsx`
 * owns the name → component map (`NAV_ICON_MAP`) and renders from it; moving
 * the array here changes nothing about what renders, only where the data
 * lives.
 */
export type NavIconName =
  | 'home'
  | 'clock'
  | 'library'
  | 'layoutGrid'
  | 'chartBar'
  | 'rocket'
  | 'palette'
  | 'settings'
  | 'user'
  | 'wrench'
  | 'sparkles'
  | 'mail'
  | 'archive';

export interface NavItemData {
  label: string;
  href: string;
  icon: NavIconName;
  /** Shown but not linked — the route doesn't exist yet, so this is exempt from the nav↔route parity guard. */
  soon?: boolean;
  /** See `admin-navigation.ts`'s `isNavVisible` doc comment — per-item, not just per-group. */
  ownerOnly?: boolean;
  /**
   * T6: the owner+admin tier — visible to owner AND admin, hidden from
   * publisher/editor/viewer. Independent of `ownerOnly` (which stays
   * owner-only exactly as before); see `admin-navigation.ts`'s widened
   * `isNavVisible(item, owner, admin)`.
   */
  adminOnly?: boolean;
}

export interface NavGroupData {
  label?: string;
  items: NavItemData[];
  /** Hides the WHOLE group for a non-owner regardless of its items' own flags. */
  ownerOnly?: boolean;
}

// Target IA (plan §2). Routes not yet built are marked `soon` — shown but not
// linked — so the sidebar reflects the destination without dead links.
//
// T1.6 (admin latency plan) regrouped this from two groups (one unlabeled
// "everything editorial", one "Settings · brand") into five labelled ones —
// Work / Insight / Site / People / Developer — and moved Requests to the
// front of Work: it is the cheapest section to load and the one with the
// "needs you" pills, so it is also the new `/admin` landing target
// (`shell-routes.ts` + `admin/index.astro`'s redirect). Editorial's href
// moved off the bare `/admin` to `/admin/editorial` in the same change — see
// that route file for why (its data call is the single slowest thing in the
// admin). The retired `Email (soon)` item (G2, no route) was dropped rather
// than carried into a group, since `soon` items are exempt from the
// nav↔route parity guard and a stale placeholder is easy to lose track of.
export const NAV_ITEMS: NavGroupData[] = [
  {
    label: 'Work',
    items: [
      // Landing item (`/admin` redirects here) — cheapest section to load,
      // and the one with the "needs you" pills.
      { label: 'Requests', href: '/admin/requests', icon: 'clock' },
      { label: 'Editorial', href: '/admin/editorial', icon: 'home' },
      // T2.1 D1(a): Templates/Media/Content collapsed into the one objects
      // plane — the old three routes still exist (netlify.toml redirects
      // them here) but are no longer separate nav entries.
      { label: 'Objects', href: '/admin/objects', icon: 'library' },
      { label: 'Release', href: '/admin/release', icon: 'rocket' },
    ],
  },
  {
    label: 'Insight',
    items: [
      // T21.9b: renamed from "Traffic" — the section now carries engagement,
      // conversions, producers, and experiments, not just visits.
      { label: 'Analytics', href: '/admin/analytics', icon: 'chartBar' },
      // T4.4: article variant families + winner selection. Deliberately NOT
      // labelled "A/B tests" — nothing serves a traffic split today, so the
      // route never uses that phrase (see docs 12-object-tracking §15.4).
      { label: 'Variants', href: '/admin/variants', icon: 'layoutGrid' },
    ],
  },
  {
    label: 'Site',
    items: [
      { label: 'Visual identity', href: '/admin/settings/visual-identity', icon: 'palette', ownerOnly: true },
      { label: 'Guardrails', href: '/admin/settings/guardrails', icon: 'settings', ownerOnly: true },
      { label: 'Agents', href: '/admin/agents', icon: 'sparkles', ownerOnly: true },
      // W5.1: the per-tenant publishing-plugin bundle (skill + connector +
      // Actions schema) for Claude / ChatGPT / Gemini. Owner-only: promoting a
      // bundle is what puts a skill in front of a whole team.
      { label: 'Plugins', href: '/admin/plugins', icon: 'rocket', ownerOnly: true },
    ],
  },
  {
    label: 'People',
    items: [
      // T4.3: was inside the (then wholly owner-only) Settings group, so a
      // non-owner Admin — whom `AdminUsers.tsx` explicitly supports as a
      // read-only viewer (`list` is admin-tier, not owner-tier) — had no nav
      // link to this page at all, only a typed-URL path to it. The server
      // wall (`admin-users.ts`) is and remains the real boundary; this only
      // changes whether the link is shown.
      { label: 'Admins', href: '/admin/settings/admins', icon: 'user' },
      { label: 'Profile', href: '/admin/profile', icon: 'user', ownerOnly: true },
    ],
  },
  {
    // T1.6: parked last rather than collapsed — `NavList` (`AdminShell.tsx`)
    // has no collapsible-group support today, and adding one is out of
    // scope for this change.
    label: 'Developer',
    items: [
      // T6: Maintenance (owner-only blob browser) is retired — /admin/maintenance
      // 301s to /admin/inventory (netlify.toml). Inventory is owner+admin: it
      // searches every object/artifact/store and does bulk verbs; only the raw
      // store delete/wipe actions underneath stay owner-only (server-gated).
      { label: 'Inventory', href: '/admin/inventory', icon: 'archive', adminOnly: true },
      { label: 'Component kit', href: '/admin/kit', icon: 'library', ownerOnly: true },
    ],
  },
];
