/**
 * ONE route resolver, across every namespace that can own a reader path
 * (KNOWN_ISSUES #40).
 *
 * THE BUG IT CLOSES. Four namespaces hand out reader paths and, until this
 * module, none of them could see the others:
 *
 *   - page objects            `body.route`            → `isRouteTaken`
 *   - content_item objects    `body.slug`             → `isArticleSlugTaken`
 *   - the redirect table      `redirects.json.from`   → nothing read it
 *   - file routes + reserved  `[...objectPage].astro` → build time only
 *
 * So `page_skincare_is_not_self_worth` published with `route:"/skincare-is-
 * not-self-worth"` while an article already owned that slug. It passed
 * write-time validation, released, and is not reachable: the build says so
 * every time (`[objectPage] NOT serving page_skincare_is_not_self_worth …
 * blog_slug`, `docs/DEPLOYMENT.md` §Verification run log) and nothing stops
 * the next one. The redirect-table case is the same hole one namespace over —
 * a page published onto a path `netlify.toml` forwards away from would be
 * just as invisible, and nothing read that table either.
 *
 * WHAT THIS IS. A pure function over a SNAPSHOT of the four namespaces. It
 * answers "who owns this path", not "is it taken", because the two callers
 * need different things from the same answer: the validator needs a message
 * naming the real owner, and the build-time catch-all needs a skip reason.
 *
 * WHAT IT DELIBERATELY DOES NOT DO. It does not read a store, a file or a
 * config. Every namespace arrives as data, because the two callers populate
 * them from completely different places — the validator from the object store
 * (via `object-validation-context.ts`), the build from `import.meta.glob` and
 * the content collections — and a resolver that tried to fetch either would be
 * usable by neither.
 *
 * KNOWN LIMIT, recorded rather than hidden: at WRITE time `fileRoutes` is
 * empty. A tenant's static `.astro` route files are a build-time glob that the
 * serverless validator cannot see, so a page route colliding with a
 * hand-written route file is still caught at build (where the catch-all warns)
 * rather than at write. The `reservedPrefixes` the validator does supply cover
 * the dynamic families, which is where the live collisions came from.
 */
import { contentItemRoute, DEFAULT_POST_PERMALINK_PATTERN } from '../../lib/tracking/experiments/arms.js';

export type RouteOwnerKind = 'page' | 'article' | 'redirect' | 'file_route' | 'reserved';

export type RouteOwner = {
  kind: RouteOwnerKind;
  /** The owning object id, or the reserved prefix / redirect source that claimed it. */
  id?: string;
};

export type RouteNamespaces = {
  /** Published and draft page objects, `body.route` as written. */
  pages: ReadonlyArray<{ objectId: string; route: string }>;
  /**
   * Article slugs — content_item bodies AND the committed legacy post stems,
   * which share one permalink space (W7.3).
   */
  articles: ReadonlyArray<{ objectId: string; slug: string }>;
  /** `from` values of the AGENT-written redirect table (`redirects.json`). A redirect beats a static file, so it owns the path. */
  redirectSources: readonly string[];
  /**
   * `from` values of the tenant's INFRASTRUCTURE redirect table
   * (`site.config.ts` ⇄ `netlify.toml`, supplied through
   * `lib/route-ownership.ts`). A trailing `/*` claims the whole family —
   * `/img/*` owns every path under `/img`, and `netlify.toml` rules beat both
   * static files and `_redirects`, so nothing a page object does can win one
   * back.
   */
  infraRedirects?: readonly string[];
  /** Path families owned by dynamic routes or tooling: blog bases, the topics hub, /admin. */
  reservedPrefixes: readonly string[];
  /** Static `.astro` route paths, trimmed. Empty at write time — see the header. */
  fileRoutes?: readonly string[];
  /** The site's post permalink pattern; defaults to the fleet default `/%slug%`. */
  postPermalinkPattern?: string;
};

/** `/a/b/` and `a/b` both normalize to `a/b`; `/` and `''` both to `''`. */
export const trimRoute = (value: string): string => value.replace(/^\/+/, '').replace(/\/+$/, '');

/**
 * Every path one article slug owns.
 *
 * TWO of them, on purpose. The permalink pattern lives in each tenant's
 * `config.yaml` (`apps.blog.post.permalink`), which the server cannot read, so
 * the resolver claims both the pattern's path and `<blog base>/<slug>`. Over-
 * claiming here is safe — the blog base is a reserved prefix anyway, so the
 * second form was already unavailable to a page — and under-claiming is how
 * `/skincare-is-not-self-worth` shipped twice.
 */
export const articlePathsFor = (
  slug: string,
  pattern: string = DEFAULT_POST_PERMALINK_PATTERN,
  reservedPrefixes: readonly string[] = []
): string[] => {
  const fromPattern = trimRoute(contentItemRoute(slug, pattern));
  const underBases = reservedPrefixes
    .map(trimRoute)
    .filter((prefix) => prefix.length > 0)
    .map((prefix) => `${prefix}/${trimRoute(slug)}`);
  return [...new Set([fromPattern, ...underBases])];
};

export type RouteResolver = (route: string) => RouteOwner | undefined;

/**
 * Build the resolver. `selfObjectId` is excluded from every namespace so an
 * object re-saving its own route is not a conflict with itself.
 */
export const createRouteResolver = (namespaces: RouteNamespaces, selfObjectId?: string): RouteResolver => {
  const pattern = namespaces.postPermalinkPattern ?? DEFAULT_POST_PERMALINK_PATTERN;
  const reserved = namespaces.reservedPrefixes.map(trimRoute).filter((prefix) => prefix.length > 0);

  const fileRoutes = new Set((namespaces.fileRoutes ?? []).map(trimRoute));

  const pages = new Map<string, string>();
  for (const page of namespaces.pages) {
    if (page.objectId === selfObjectId) continue;
    if (typeof page.route !== 'string' || !page.route) continue;
    pages.set(trimRoute(page.route), page.objectId);
  }

  const articles = new Map<string, string>();
  for (const article of namespaces.articles) {
    if (article.objectId === selfObjectId) continue;
    if (typeof article.slug !== 'string' || !article.slug) continue;
    for (const path of articlePathsFor(article.slug, pattern, reserved)) {
      if (!articles.has(path)) articles.set(path, article.objectId);
    }
  }

  const redirects = new Set(namespaces.redirectSources.map(trimRoute));

  const infraExact = new Set<string>();
  const infraSplats: string[] = [];
  for (const source of namespaces.infraRedirects ?? []) {
    if (typeof source !== 'string' || source.length === 0) continue;
    if (source.endsWith('/*')) {
      const prefix = trimRoute(source.slice(0, -2));
      if (prefix.length > 0) infraSplats.push(prefix);
      continue;
    }
    infraExact.add(trimRoute(source));
  }

  /**
   * Order matters and mirrors the build-time catch-all
   * (`object-page-routes.ts`): a static file wins, then the article permalink
   * space, then a reserved family. Page and redirect follow — neither is a
   * build-time owner, and both are new here.
   */
  return (route: string): RouteOwner | undefined => {
    if (typeof route !== 'string') return undefined;
    const param = trimRoute(route);

    if (fileRoutes.has(param)) return { kind: 'file_route', id: param };

    const article = articles.get(param);
    if (article) return { kind: 'article', id: article };

    const prefix = reserved.find((candidate) => param === candidate || param.startsWith(`${candidate}/`));
    if (prefix) return { kind: 'reserved', id: prefix };

    const page = pages.get(param);
    if (page) return { kind: 'page', id: page };

    if (redirects.has(param)) return { kind: 'redirect', id: `/${param}` };

    if (infraExact.has(param)) return { kind: 'redirect', id: `/${param}` };
    const splat = infraSplats.find((prefix) => param === prefix || param.startsWith(`${prefix}/`));
    if (splat) return { kind: 'redirect', id: `/${splat}/*` };

    return undefined;
  };
};

/** One sentence a model can act on, for each way a path can already be owned. */
export const describeRouteOwner = (route: string, owner: RouteOwner, subject: 'route' | 'slug' = 'route'): string => {
  switch (owner.kind) {
    case 'page':
      return `${subject} "${route}" is already used by page ${owner.id}.`;
    case 'article':
      return `${subject} "${route}" is already the permalink of article ${owner.id} — pages and articles share one path space.`;
    case 'redirect':
      return `${subject} "${route}" is the source of a site redirect (${owner.id}), so every reader is forwarded away from it before the page can render.`;
    case 'file_route':
      return `${subject} "${route}" is served by a hand-written route file, which always wins over a page object.`;
    case 'reserved':
      return `${subject} "${route}" falls under the reserved prefix "/${owner.id}", owned by a dynamic route or by /admin.`;
  }
};

/**
 * Path families that are reserved on EVERY tenant, independent of its blog
 * configuration: the admin app (injected into every site) and the topics hub.
 * The per-tenant blog/category/tag bases come from the site object's `blog`
 * block — see `reservedPrefixesFromSiteBlog`.
 *
 * This is the write-time mirror of the list each tenant's
 * `app/pages/[...objectPage].astro` passes to `computeObjectPageRoutes`
 * (`[BLOG_BASE, CATEGORY_BASE, TAG_BASE, 'learn/topics', 'admin']`). The two
 * are kept comparable by `tests/netlify/route-resolver.test.ts`, which reads
 * the tenant files rather than trusting this comment.
 */
export const FLEET_RESERVED_PREFIXES: readonly string[] = ['learn/topics', 'admin'];

/** The reserved list for one tenant: its blog families plus the fleet-wide ones. */
export const reservedPrefixesFromSiteBlog = (blog: unknown): string[] => {
  const read = (key: string): string | undefined => {
    if (!blog || typeof blog !== 'object') return undefined;
    const value = (blog as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
  };
  const bases = [read('listPath'), read('categoryBase'), read('tagBase')].filter(
    (base): base is string => base !== undefined
  );
  return [...new Set([...bases, ...FLEET_RESERVED_PREFIXES].map(trimRoute).filter((base) => base.length > 0))];
};
