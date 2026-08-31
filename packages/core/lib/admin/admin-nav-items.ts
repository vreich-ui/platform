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
  | 'mail';

export interface NavItemData {
  label: string;
  href: string;
  icon: NavIconName;
  /** Shown but not linked — the route doesn't exist yet, so this is exempt from the nav↔route parity guard. */
  soon?: boolean;
  /** See `admin-navigation.ts`'s `isNavVisible` doc comment — per-item, not just per-group. */
  ownerOnly?: boolean;
}

export interface NavGroupData {
  label?: string;
  items: NavItemData[];
  /** Hides the WHOLE group for a non-owner regardless of its items' own flags. */
  ownerOnly?: boolean;
}

// Target IA (plan §2). Routes not yet built are marked `soon` — shown but not
// linked — so the sidebar reflects the destination without dead links.
export const NAV_ITEMS: NavGroupData[] = [
  {
    items: [
      { label: 'Editorial', href: '/admin', icon: 'home' },
      { label: 'Requests', href: '/admin/requests', icon: 'clock' },
      // T2.1 D1(a): Templates/Media/Content collapsed into the one objects
      // plane — the old three routes still exist (netlify.toml redirects
      // them here) but are no longer separate nav entries.
      { label: 'Objects', href: '/admin/objects', icon: 'library' },
      // T4.4: article variant families + winner selection. Deliberately NOT
      // labelled "A/B tests" — nothing serves a traffic split today, so the
      // route never uses that phrase (see docs 12-object-tracking §15.4).
      { label: 'Variants', href: '/admin/variants', icon: 'layoutGrid' },
      { label: 'Traffic', href: '/admin/traffic', icon: 'chartBar' },
      { label: 'Release', href: '/admin/release', icon: 'rocket' },
    ],
  },
  {
    label: 'Settings',
    items: [
      { label: 'Visual identity', href: '/admin/settings/visual-identity', icon: 'palette', ownerOnly: true },
      { label: 'Guardrails', href: '/admin/settings/guardrails', icon: 'settings', ownerOnly: true },
      // T4.3: was inside the (then wholly owner-only) Settings group, so a
      // non-owner Admin — whom `AdminUsers.tsx` explicitly supports as a
      // read-only viewer (`list` is admin-tier, not owner-tier) — had no nav
      // link to this page at all, only a typed-URL path to it. The server
      // wall (`admin-users.ts`) is and remains the real boundary; this only
      // changes whether the link is shown.
      { label: 'Admins', href: '/admin/settings/admins', icon: 'user' },
      { label: 'Profile', href: '/admin/profile', icon: 'user', ownerOnly: true },
      { label: 'Maintenance', href: '/admin/maintenance', icon: 'wrench', ownerOnly: true },
      { label: 'Component kit', href: '/admin/kit', icon: 'library', ownerOnly: true },
      { label: 'Agents', href: '/admin/agents', icon: 'sparkles', ownerOnly: true },
      // W5.1: the per-tenant publishing-plugin bundle (skill + connector +
      // Actions schema) for Claude / ChatGPT / Gemini. Owner-only: promoting a
      // bundle is what puts a skill in front of a whole team.
      { label: 'Plugins', href: '/admin/plugins', icon: 'rocket', ownerOnly: true },
      // G2 (email list administration, deferred): the nav entry exists so the
      // destination is discoverable, but it is deliberately inert — no
      // route, no page, no email API client. Visible to any admin (not
      // ownerOnly) since it does nothing yet regardless of role.
      { label: 'Email', href: '/admin/settings/email', icon: 'mail', soon: true },
    ],
  },
];
