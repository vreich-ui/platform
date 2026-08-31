/**
 * Shell routes (W14 T14.1) — the routes that are LAW, injected into every
 * site's build rather than copied into each `sites/<client>/app/pages/`.
 *
 * The split is by what a route depends on:
 *
 *   INJECTED (here) — the `/admin/*` workspace. It renders from the object
 *   store and the user store at runtime, depends on no committed page export,
 *   and is identical for every tenant. A client that got its own copy would
 *   drift from the fleet the first time the console changed.
 *
 *   SITE-OWNED (`sites/<client>/app/pages/`) — every reader-facing route. Each
 *   one is a thin loader over a NAMED page object (`page_home`, `page_about`,
 *   the blog surfaces…), and `PageObjectRenderer` throws when that object is
 *   missing. Which pages exist is a property of the client's content, not of
 *   the shell, so the route files live with the content. A freshly scaffolded
 *   site starts with the routes its starter pack can actually serve.
 *
 * `[...objectPage].astro` stays site-owned for a second reason: it enumerates
 * file-owned routes with `import.meta.glob('./**\/*.astro')`, which only sees
 * the directory it lives in.
 *
 * W16 T16.4 adds a third category, OVERRIDABLE (`OVERRIDABLE_SHELL_ROUTES`):
 * routes core's own components depend on — `/rss.xml` (the Header's RSS link)
 * and `/search.json` (the Header's search overlay) — which every tenant must
 * therefore serve, but which a site may still take ownership of by shipping
 * its own `app/pages/<file>`. The site file WINS, enforced explicitly: the
 * injection is skipped when the file exists. This is deliberate rather than
 * left to Astro's route ordering — Astro 5 keeps BOTH a file route and an
 * injected route with the same pattern in the manifest, logs
 * "A static route cannot be defined more than once", and its own warning says
 * "a collision will result in a hard error in following versions of Astro"
 * (`node_modules/astro/dist/core/routing/manifest/create.js`, `detectRouteCollision`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AstroIntegration } from 'astro';

const ROUTES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'routes');

/** `pattern` → entrypoint file, relative to `packages/core/app/routes/`. */
export const SHELL_ROUTES: ReadonlyArray<{ pattern: string; entry: string }> = [
  { pattern: '/admin', entry: 'admin/index.astro' },
  // T18.0b: where every Netlify Identity e-mail token lands (invite /
  // confirmation / recovery / email change). No auth gate — the person has
  // no session yet; the page creates one.
  { pattern: '/admin/accept', entry: 'admin/accept.astro' },
  { pattern: '/admin/agents', entry: 'admin/agents.astro' },
  // W14 F10: the OAuth consent screen. Inside /admin because the decision needs
  // an authenticated admin, and that login already lives here.
  { pattern: '/admin/authorize', entry: 'admin/authorize.astro' },
  { pattern: '/admin/content', entry: 'admin/content/index.astro' },
  // T2.1 D1(a): the objects plane — canonical now; /admin/content,
  // /admin/templates, /admin/studio and /admin/media redirect here
  // (netlify.toml, force=true) but keep their own injected routes below so
  // shell-routes/admin-parity's route inventory stays satisfied.
  { pattern: '/admin/objects', entry: 'admin/objects/index.astro' },
  // W19 T19.4: the editorial request list, and its deep link. `[requestId]`
  // is the T9.9 placeholder pattern — the netlify.toml rewrite serves the
  // `__request` page for every /admin/requests/<id> and the island reads the
  // id client-side.
  { pattern: '/admin/requests', entry: 'admin/requests.astro' },
  { pattern: '/admin/requests/[requestId]', entry: 'admin/requests/[requestId].astro' },
  { pattern: '/admin/content/[objectId]', entry: 'admin/content/[objectId].astro' },
  // T18.5: one-time onboarding (name + "what your role can do") — the AdminShell gate sends new members here.
  { pattern: '/admin/welcome', entry: 'admin/welcome.astro' },
  { pattern: '/admin/templates', entry: 'admin/templates.astro' },
  // T4.4: article variant families + winner selection. Not an A/B monitor —
  // no traffic split exists (OQ-W7-2) and the page says so on its face.
  { pattern: '/admin/variants', entry: 'admin/variants.astro' },
  // T4.1: visits/sources/top-content dashboard, reading Netlify Analytics.
  { pattern: '/admin/traffic', entry: 'admin/traffic.astro' },
  { pattern: '/admin/media', entry: 'admin/media.astro' },
  { pattern: '/admin/release', entry: 'admin/release.astro' },
  { pattern: '/admin/kit', entry: 'admin/kit.astro' },
  { pattern: '/admin/maintenance', entry: 'admin/maintenance.astro' },
  // W5.1: the publishing-plugin bundle page (render / promote / per-platform
  // install cards). Core-owned — every tenant gets the same one, because the
  // bundle it renders is tenant-generic.
  { pattern: '/admin/plugins', entry: 'admin/plugins.astro' },
  { pattern: '/admin/profile', entry: 'admin/profile.astro' },
  { pattern: '/admin/settings/admins', entry: 'admin/settings/admins.astro' },
  { pattern: '/admin/settings/guardrails', entry: 'admin/settings/guardrails.astro' },
  { pattern: '/admin/settings/visual-identity', entry: 'admin/settings/visual-identity.astro' },
  { pattern: '/admin/studio', entry: 'admin/studio.astro' },
];

/**
 * Routes core's own shell depends on, injected into every site UNLESS that
 * site owns the equivalent page file (see `siteOwnsRoute`).
 *
 * `siteFile` is the path, relative to a site's `app/pages/`, whose presence
 * hands ownership back to the site. Extensions are probed (`.ts`, `.js`,
 * `.mjs`, `.astro`), so `rss.xml` matches `rss.xml.ts` or `rss.xml.astro`.
 */
export const OVERRIDABLE_SHELL_ROUTES: ReadonlyArray<{ pattern: string; entry: string; siteFile: string }> = [
  { pattern: '/rss.xml', entry: 'rss.xml.ts', siteFile: 'rss.xml' },
  { pattern: '/search.json', entry: 'search.json.ts', siteFile: 'search.json' },
];

/** Endpoint/page extensions Astro will route from a `pages/` file. */
const PAGE_EXTENSIONS = ['.ts', '.js', '.mjs', '.astro'] as const;

/**
 * True when `<pagesDir>/<siteFile>{.ts,.js,.mjs,.astro}` exists — i.e. the
 * site ships its own implementation and core must NOT inject over it.
 */
export const siteOwnsRoute = (pagesDir: string, siteFile: string): boolean =>
  PAGE_EXTENSIONS.some((extension) => fs.existsSync(path.join(pagesDir, `${siteFile}${extension}`)));

export const shellRoutes = (): AstroIntegration => ({
  name: 'platform-shell-routes',
  hooks: {
    'astro:config:setup': ({ config, injectRoute, logger }) => {
      for (const route of SHELL_ROUTES) {
        injectRoute({
          pattern: route.pattern,
          entrypoint: path.join(ROUTES_DIR, route.entry),
        });
      }

      // `srcDir` is `sites/<client>/app` for every site (site-astro-config.ts).
      const pagesDir = path.join(fileURLToPath(config.srcDir), 'pages');
      for (const route of OVERRIDABLE_SHELL_ROUTES) {
        if (siteOwnsRoute(pagesDir, route.siteFile)) {
          logger.info(`${route.pattern}: site file route found — keeping the site's own implementation`);
          continue;
        }
        injectRoute({
          pattern: route.pattern,
          entrypoint: path.join(ROUTES_DIR, route.entry),
        });
      }
    },
  },
});
