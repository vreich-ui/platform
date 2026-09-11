/**
 * Route derivation for the object-page catch-all (`app/pages/[...objectPage].astro`)
 * — the piece that makes agent-CREATED pages live end-to-end: a published Page
 * object whose route no hand-written file serves gets its path emitted here and
 * rendered through PageObjectRenderer, no code change per page.
 *
 * Pure function so the ownership rules are unit-testable offline. The catch-all
 * must NEVER fight another route for a path, so a page route is emitted only
 * when nobody else owns it:
 *
 *   - `file_route` — a static .astro route file already serves it (the 12
 *     originally converted pages each keep their thin loader file; file routes
 *     always win). Dynamic files (`[...]`) are ignored as owners here — their
 *     path sets are covered by the reserved prefixes below.
 *   - `blog_slug` — the article pipeline owns root-level post permalinks
 *     (`/%slug%`); a page route equal to one would collide at build.
 *   - `reserved_prefix` — path families owned by other dynamic routes or
 *     tooling: the blog list/category/tag bases, the topics hub, and /admin.
 *   - `loader_owned_page_type` — pageType 'listing' / 'content_detail' (W6):
 *     these page objects bind to the formalized listing loaders (the blog
 *     list/category/tag routes, the topics hub, the article route), which
 *     read their headings/SEO/extra sections directly. Their `route` fields
 *     are family patterns (e.g. '/category/[category]', '/%slug%'), never
 *     standalone paths — the catch-all must not mint literal pages for them.
 *   - `invalid_route` — not a string, not absolute, or empty.
 *
 * Skips are returned (not dropped) so the caller can `console.warn` each one —
 * an agent-published page that is NOT live must be loudly visible in the build
 * log, never silently truncated. (`file_route` and `loader_owned_page_type`
 * are the two exceptions a caller may keep quiet: both mean the page IS
 * served, just by a dedicated file, not by the catch-all.)
 */

export type PageExportLike = {
  /** Collection entry id — the page object id (filename minus .json). */
  objectId: string;
  /** body.route from the derived export (unknown until validated here). */
  route: unknown;
  /** body.pageType from the derived export (unknown until validated here). */
  pageType?: unknown;
};

export type ObjectPageRoutesInput = {
  /**
   * Route-file paths: the keys of the caller's import.meta.glob over every
   * .astro file under the site's `app/pages` (relative './about.astro' or
   * absolute '/sites/acme/app/pages/about.astro' both work).
   */
  routeFilePaths: string[];
  pageExports: PageExportLike[];
  /** Trimmed post permalinks from the article pipeline (e.g. 'my-post'). */
  postPermalinks: string[];
  /** Trimmed path prefixes owned elsewhere (e.g. 'learn/library', 'tag'). */
  reservedPrefixes: string[];
};

export type SkippedObjectPageRoute = {
  objectId: string;
  route: string;
  reason: 'file_route' | 'blog_slug' | 'reserved_prefix' | 'loader_owned_page_type' | 'invalid_route';
};

export type ObjectPageRoutes = {
  /** param is the rest-segment value (route minus the leading slash). */
  paths: Array<{ objectId: string; route: string; param: string }>;
  skipped: SkippedObjectPageRoute[];
};

const trimSlashes = (value: string) => value.replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * PageTypes whose objects bind to dedicated loader files, never the catch-all
 * (W6).
 *
 * Exported since W0 T0.3: the WRITE-time route resolver must skip the same
 * page types for the same reason. Their `route` fields are family patterns
 * (`/category/[category]`, `/%slug%`, `/learn/library`), not standalone paths,
 * so every one of them "collides" with the reserved prefix that owns its
 * family — by design. A uniqueness rule that did not know this would refuse
 * every existing listing page on every tenant.
 */
export const LOADER_OWNED_PAGE_TYPES: ReadonlySet<string> = new Set(['listing', 'content_detail']);

/**
 * '/sites/acme/app/pages/solutions/early-access.astro' | './index.astro'
 *   → 'solutions/early-access' | ''
 *
 * W14 T14.1: the pages root is per-site now, so the prefix cannot be the
 * literal `src/pages/` this used to strip. Anything up to and including the
 * LAST `/pages/` segment goes; a relative `./…` key (what the catch-all's own
 * `import.meta.glob` produces) just loses its `./`.
 */
const routeFileToPath = (filePath: string): string | undefined => {
  if (filePath.includes('[')) return undefined; // dynamic route: not a static owner
  const pagesRoot = filePath.lastIndexOf('/pages/');
  const withoutPrefix =
    pagesRoot === -1 ? filePath.replace(/^\.?\/+/, '') : filePath.slice(pagesRoot + '/pages/'.length);
  if (!withoutPrefix.endsWith('.astro')) return undefined;
  const path = withoutPrefix.slice(0, -'.astro'.length);
  return path === 'index' ? '' : path.endsWith('/index') ? path.slice(0, -'/index'.length) : path;
};

export const computeObjectPageRoutes = (input: ObjectPageRoutesInput): ObjectPageRoutes => {
  const fileOwned = new Set(
    input.routeFilePaths.map(routeFileToPath).filter((path): path is string => path !== undefined)
  );
  const blogOwned = new Set(input.postPermalinks.map(trimSlashes));
  const reserved = input.reservedPrefixes.map(trimSlashes).filter((prefix) => prefix.length > 0);

  const paths: ObjectPageRoutes['paths'] = [];
  const skipped: SkippedObjectPageRoute[] = [];

  for (const entry of input.pageExports) {
    const rawRoute = entry.route;
    if (typeof rawRoute !== 'string' || !rawRoute.startsWith('/')) {
      skipped.push({ objectId: entry.objectId, route: String(rawRoute), reason: 'invalid_route' });
      continue;
    }
    const param = trimSlashes(rawRoute);
    const route = `/${param}`;
    if (typeof entry.pageType === 'string' && LOADER_OWNED_PAGE_TYPES.has(entry.pageType)) {
      skipped.push({ objectId: entry.objectId, route, reason: 'loader_owned_page_type' });
      continue;
    }
    if (fileOwned.has(param)) {
      skipped.push({ objectId: entry.objectId, route, reason: 'file_route' });
      continue;
    }
    if (blogOwned.has(param)) {
      skipped.push({ objectId: entry.objectId, route, reason: 'blog_slug' });
      continue;
    }
    if (reserved.some((prefix) => param === prefix || param.startsWith(`${prefix}/`))) {
      skipped.push({ objectId: entry.objectId, route, reason: 'reserved_prefix' });
      continue;
    }
    paths.push({ objectId: entry.objectId, route, param });
  }

  return { paths, skipped };
};
