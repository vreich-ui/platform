/**
 * Baseline navigation SKELETON for 'site_genesis_lab_2' (T11.7 create-site
 * scaffold) — one header menu, one footer menu, each carrying a single
 * "Home" link to '/'. Real content replaces this before launch; it exists
 * so the site singleton's defaultNavigation refs resolve immediately and the
 * round-trip driver has a non-empty nav to drill.
 *
 * Driver contract for scripts/home-conversion-roundtrip.mjs:
 *   --site sites/genesis-lab-2 --seeds sites/genesis-lab-2/seeds/navigation-seed-data.mjs
 */

export const SEED_SITE = 'site_genesis_lab_2';

export const navHeaderBody = {
  role: 'header',
  groups: [
    {
      id: 'g_primary',
      items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
    },
    // W15 S3 follow-up: admin-only nav group, born with every new site so
    // the fleet-wide admin-nav gap (see ADMIN_NAV_GROUP's comment) can't
    // recur for a future client. Client sites remain free to relabel/move
    // this group; only its absence is the fleet-law problem.
    {
      "id": "g_admin",
      "title": "Admin",
      "adminOnly": true,
      "items": [
        {
          "id": "i_admin_dashboard",
          "label": "Dashboard",
          "description": "Admin home — overview and quick actions.",
          "target": {
            "kind": "route",
            "href": "/admin"
          }
        },
        {
          "id": "i_admin_content",
          "label": "Content library",
          "description": "Browse everything by human name — pages, articles, sections, and more.",
          "target": {
            "kind": "route",
            "href": "/admin/content"
          }
        },
        {
          "id": "i_admin_agents",
          "label": "Agents",
          "description": "Chat with CMS Agents across any object.",
          "target": {
            "kind": "route",
            "href": "/admin/agents"
          }
        },
        {
          "id": "i_admin_inventory",
          "label": "Inventory",
          "description": "Search, preview and act on every object, artifact and system store.",
          "target": {
            "kind": "route",
            "href": "/admin/inventory"
          }
        }
      ]
    },
  ],
};

export const navFooterBody = {
  role: 'footer',
  brand: { text: 'Genesis Lab 2' },
  groups: [
    {
      id: 'g_footer_primary',
      items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }],
    },
  ],
  footNote: '© Genesis Lab 2.',
};

export const CONVERSION_SEEDS = [
  { objectType: 'navigation', objectId: 'nav_header', body: navHeaderBody },
  { objectType: 'navigation', objectId: 'nav_footer', body: navFooterBody },
];
