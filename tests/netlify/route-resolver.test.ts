// buildStoreValidationContext reaches the site-identity provider through the
// page-type registry; every test that builds a real context registers the
// bindings first (seed-objects-enforcement.test.ts does the same).
import '../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  articlePathsFor,
  createRouteResolver,
  describeRouteOwner,
  FLEET_RESERVED_PREFIXES,
  reservedPrefixesFromSiteBlog,
  trimRoute,
  type RouteNamespaces,
} from '../../packages/core/server/lib/route-resolver.js';
import { checkStructuralInvariants } from '../../packages/core/server/lib/object-validate.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import { computeObjectPageRoutes, LOADER_OWNED_PAGE_TYPES } from '../../packages/core/app/utils/object-page-routes.js';
import {
  activeRouteOwnership,
  resetRouteOwnershipProviderForTesting,
  setRouteOwnershipProvider,
} from '../../packages/core/lib/route-ownership.js';
import type { ReadinessCriterion } from '../../packages/core/lib/admin/readiness-criteria.js';

/**
 * W0 T0.3 acceptance — KNOWN_ISSUES #40, one route resolver across every
 * namespace that hands out a reader path.
 *
 * The live evidence this closes: `page_skincare_is_not_self_worth` published
 * onto an article's permalink, and `page_shop` published onto a route a 301
 * forwards away from. Both passed write-time validation because page routes,
 * article slugs, the redirect tables and the reserved families were four
 * separate answers to one question.
 */

/**
 * The compiled test runs from `.tmp/ci-test`, so the working directory is not
 * the repo root — ascend until the tenant tree is in view (the same walk
 * `seed-objects-enforcement.test.ts` uses).
 */
const repoRoot = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i += 1) {
    if (existsSync(join(dir, 'sites', 'drlurie', 'site.config.ts'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate the repo root from the compiled test');
};
const ROOT = repoRoot();

const NAMESPACES: RouteNamespaces = {
  pages: [
    { objectId: 'page_about', route: '/about' },
    { objectId: 'page_self', route: '/self' },
  ],
  articles: [{ objectId: 'req_agent_demo_20260101_01', slug: 'skincare-is-not-self-worth' }],
  redirectSources: ['/retired-page'],
  infraRedirects: ['/shop', '/img/*', '/mcp'],
  reservedPrefixes: ['learn/library', 'category', 'tag', 'learn/topics', 'admin'],
  fileRoutes: ['about-us'],
};

const resolve = createRouteResolver(NAMESPACES);

// ─── the four namespaces, one answer ─────────────────────────────────────────

test('a page route colliding with another PAGE is owned', () => {
  assert.deepEqual(resolve('/about'), { kind: 'page', id: 'page_about' });
});

test('a page route colliding with an ARTICLE permalink is owned — #40 case (a)', () => {
  assert.deepEqual(resolve('/skincare-is-not-self-worth'), {
    kind: 'article',
    id: 'req_agent_demo_20260101_01',
  });
});

test('a page route colliding with an INFRASTRUCTURE redirect is owned — #40 case (b)', () => {
  // `/shop` is a 301 in site.config.ts ⇄ netlify.toml, and toml rules beat
  // every static file: the page can never render, whatever it contains.
  assert.deepEqual(resolve('/shop'), { kind: 'redirect', id: '/shop' });
});

test('a splat infrastructure rule owns its whole family', () => {
  assert.deepEqual(resolve('/img/anything/deep.png'), { kind: 'redirect', id: '/img/*' });
  assert.deepEqual(resolve('/mcp'), { kind: 'redirect', id: '/mcp' });
});

test('a page route colliding with the AGENT-written redirect table is owned', () => {
  assert.deepEqual(resolve('/retired-page'), { kind: 'redirect', id: '/retired-page' });
});

test('a reserved family and a static route file both own their paths', () => {
  assert.deepEqual(resolve('/category/anything'), { kind: 'reserved', id: 'category' });
  assert.deepEqual(resolve('/admin'), { kind: 'reserved', id: 'admin' });
  assert.deepEqual(resolve('/about-us'), { kind: 'file_route', id: 'about-us' });
});

test('a path nobody owns is free, and slashes never change the answer', () => {
  assert.equal(resolve('/brand-new'), undefined);
  assert.equal(resolve('brand-new/'), undefined);
  assert.deepEqual(resolve('about/'), { kind: 'page', id: 'page_about' });
  assert.equal(trimRoute('/a/b/'), 'a/b');
});

test('the object under validation never collides with itself', () => {
  const selfAware = createRouteResolver(NAMESPACES, 'page_self');
  assert.equal(selfAware('/self'), undefined);
  // …and still sees everyone else.
  assert.deepEqual(selfAware('/about'), { kind: 'page', id: 'page_about' });
});

test('an article claims its permalink AND the path under each blog base', () => {
  // The permalink pattern lives in the tenant's config.yaml, which the server
  // cannot read — so both forms are claimed rather than guessing one.
  assert.deepEqual(articlePathsFor('my-post', '/%slug%', ['learn/library']), [
    'my-post',
    'learn/library/my-post',
  ]);
  assert.deepEqual(articlePathsFor('my-post', '/library/%slug%'), ['library/my-post']);
});

test('every owner kind explains itself in one actionable sentence', () => {
  for (const owner of [
    { kind: 'page' as const, id: 'page_about' },
    { kind: 'article' as const, id: 'req_x' },
    { kind: 'redirect' as const, id: '/shop' },
    { kind: 'file_route' as const, id: 'about-us' },
    { kind: 'reserved' as const, id: 'admin' },
  ]) {
    const sentence = describeRouteOwner('/x', owner);
    assert.ok(sentence.length > 20, JSON.stringify(owner));
    assert.match(sentence, /"\/x"/);
  }
  assert.match(describeRouteOwner('my-post', { kind: 'page', id: 'page_x' }, 'slug'), /^slug "my-post"/);
});

// ─── the reserved list, and its tenant mirror ────────────────────────────────

test('the reserved list is the site blog block plus the fleet-wide families', () => {
  assert.deepEqual(
    reservedPrefixesFromSiteBlog({ listPath: 'learn/library', categoryBase: 'category', tagBase: 'tag' }),
    ['learn/library', 'category', 'tag', 'learn/topics', 'admin']
  );
  // A site object with no blog block still reserves the fleet families.
  assert.deepEqual(reservedPrefixesFromSiteBlog(undefined), [...FLEET_RESERVED_PREFIXES]);
});

test('every tenant catch-all still reserves the fleet families — the build-time mirror', () => {
  for (const tenant of ['drlurie', 'platform', 'zilberman', 'fernwell', 'genesis-lab-2']) {
    const source = readFileSync(join(ROOT, 'sites', tenant, 'app', 'pages', '[...objectPage].astro'), 'utf8');
    const reserved = /reservedPrefixes:\s*\[([^\]]*)\]/.exec(source)?.[1] ?? '';
    for (const family of FLEET_RESERVED_PREFIXES) {
      assert.ok(
        reserved.includes(`'${family}'`),
        `${tenant}: the build-time reserved list dropped "${family}", so build and write-time disagree`
      );
    }
    // The blog families arrive as constants, not literals — pin the names so a
    // rename cannot silently narrow the list.
    for (const constant of ['BLOG_BASE', 'CATEGORY_BASE', 'TAG_BASE']) {
      assert.ok(reserved.includes(constant), `${tenant}: missing ${constant}`);
    }
  }
});

// ─── build time and write time agree ─────────────────────────────────────────

test('the resolver and the build-time catch-all agree on who owns what', () => {
  const namespaces: RouteNamespaces = {
    pages: [],
    articles: [{ objectId: 'req_post', slug: 'a-post' }],
    redirectSources: [],
    reservedPrefixes: ['tag'],
    fileRoutes: ['about'],
  };
  const resolver = createRouteResolver(namespaces);
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ['./about.astro'],
    pageExports: [
      { objectId: 'p_file', route: '/about' },
      { objectId: 'p_blog', route: '/a-post' },
      { objectId: 'p_reserved', route: '/tag/x' },
      { objectId: 'p_free', route: '/free' },
    ],
    postPermalinks: ['/a-post'],
    reservedPrefixes: ['tag'],
  });

  const reasonByOwner = { file_route: 'file_route', article: 'blog_slug', reserved: 'reserved_prefix' } as const;
  for (const skip of skipped) {
    const owner = resolver(skip.route);
    assert.ok(owner, `${skip.route}: the build skipped it and the resolver saw no owner`);
    assert.equal(reasonByOwner[owner.kind as keyof typeof reasonByOwner], skip.reason, skip.route);
  }
  assert.deepEqual(
    paths.map((path) => path.route),
    ['/free']
  );
  assert.equal(resolver('/free'), undefined, 'the build emitted it, so nobody may own it');
});

// ─── the validator, through the criterion it reports ─────────────────────────

const statusOf = (criteria: ReadinessCriterion[], id: string) => criteria.find((c) => c.id === id)?.status;

const pageBody = (route: string, pageType = 'standard') => ({
  route,
  pageType,
  title: 'A page',
  seo: { description: 'A description long enough to be real.', robots: { index: true, follow: true } },
  sections: [{ id: 's_prose', type: 'prose', data: { body: '<p>Hello.</p>' } }],
});

test('structure_route BLOCKS a page route owned by another namespace', () => {
  for (const [route, expected] of [
    ['/about', 'page'],
    ['/skincare-is-not-self-worth', 'article'],
    ['/shop', 'redirect'],
    ['/retired-page', 'redirect'],
    ['/category/x', 'reserved'],
  ] as const) {
    const criteria = checkStructuralInvariants('page', 'page_new', pageBody(route), { resolveRouteOwner: resolve }, false);
    assert.equal(statusOf(criteria, 'structure_route'), 'missing', route);
    assert.match(criteria.find((c) => c.id === 'structure_route')!.message, new RegExp(expected), route);
  }
});

test('structure_route PASSES a route nobody owns', () => {
  const criteria = checkStructuralInvariants('page', 'page_new', pageBody('/brand-new'), { resolveRouteOwner: resolve }, false);
  assert.equal(statusOf(criteria, 'structure_route'), 'complete');
});

test('a loader-owned pageType is exempt — its route is a family pattern, not a path', () => {
  for (const pageType of LOADER_OWNED_PAGE_TYPES) {
    // Every committed listing page on every tenant looks like this:
    // `/category/[category]`, `/%slug%`, `/learn/library`. Checking them would
    // refuse the page against the very prefix that serves it.
    const criteria = checkStructuralInvariants(
      'page',
      'page_listing',
      pageBody('/category/[category]', pageType),
      { resolveRouteOwner: resolve },
      false
    );
    assert.equal(statusOf(criteria, 'structure_route'), 'info', pageType);
  }
});

test('the old isRouteTaken callback still answers when it is the only one injected', () => {
  assert.equal(
    statusOf(checkStructuralInvariants('page', 'page_new', pageBody('/x'), { isRouteTaken: () => true }, false), 'structure_route'),
    'missing'
  );
  assert.equal(
    statusOf(checkStructuralInvariants('page', 'page_new', pageBody('/x'), {}, false), 'structure_route'),
    'optional'
  );
});

// ─── the retire round trip ───────────────────────────────────────────────────

test('a retired object is not blocked by the redirect its own retirement wrote', async () => {
  // object-retire.ts writes the forwarding rule for the route it just removed
  // and stamps it with `retired_object_id`. Reading the table by `from` alone
  // made the archived object's route owned by ITS OWN redirect, so every later
  // patch to it — including un-retiring it, which W14 F6 ruling 1 makes
  // explicitly reversible — would have failed structure_route with a 422.
  // drlurie and fernwell each carry exactly such a rule today.
  const records = new Map<string, string>([
    [
      'objects/page/by-id/page_retired.json',
      JSON.stringify({
        object_id: 'page_retired',
        object_type: 'page',
        body: { route: '/gone', pageType: 'standard', title: 'Gone', sections: [] },
        publication: { published_time: null },
      }),
    ],
    [
      'site/redirects.v1.json',
      JSON.stringify([
        { from: '/gone', to: '/', status: 301, retired_object_id: 'page_retired' },
        { from: '/somebody-elses', to: '/', status: 301, retired_object_id: 'page_other' },
      ]),
    ],
  ]);
  const store = {
    async get(key: string) {
      return records.get(key) ?? null;
    },
    async list({ prefix }: { prefix: string }) {
      return {
        blobs: [...records.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })),
        directories: [],
      };
    },
    async setJSON() {},
  } as never;

  const own = await buildStoreValidationContext(store, { selfObjectId: 'page_retired', selfObjectType: 'page' });
  assert.equal(own.resolveRouteOwner?.('/gone'), undefined, 'its own retirement redirect must not own its route');
  // …and the rest of the table is still a namespace, not dropped along with it.
  assert.deepEqual(own.resolveRouteOwner?.('/somebody-elses'), { kind: 'redirect', id: '/somebody-elses' });

  // A DIFFERENT object writing to that route is still blocked. It is reported
  // as the PAGE rather than the redirect because the archived record is still
  // in the store (retire archives, it does not delete — W14 F6 ruling 1) and
  // `page` outranks `redirect`. Either owner refuses the write; naming the
  // page is the more actionable of the two.
  const other = await buildStoreValidationContext(store, { selfObjectId: 'page_new', selfObjectType: 'page' });
  assert.deepEqual(other.resolveRouteOwner?.('/gone'), { kind: 'page', id: 'page_retired' });
});

// ─── the per-tenant seam ─────────────────────────────────────────────────────

test('route ownership fails soft when no tenant registered a provider', () => {
  resetRouteOwnershipProviderForTesting();
  assert.deepEqual(activeRouteOwnership(), { infraRedirectSources: [] });

  setRouteOwnershipProvider(() => {
    throw new Error('a tenant config that cannot be read');
  });
  assert.deepEqual(activeRouteOwnership(), { infraRedirectSources: [] }, 'a throwing provider must not fail a write');

  setRouteOwnershipProvider(() => ({ infraRedirectSources: ['/shop'] }));
  assert.deepEqual(activeRouteOwnership().infraRedirectSources, ['/shop']);
  resetRouteOwnershipProviderForTesting();
});

test('every tenant registers its infrastructure redirect table', () => {
  for (const tenant of ['drlurie', 'platform', 'zilberman', 'fernwell', 'genesis-lab-2']) {
    const source = readFileSync(join(ROOT, 'sites', tenant, 'config', 'policy-bindings.ts'), 'utf8');
    assert.match(source, /setRouteOwnershipProvider\(/, `${tenant} does not register route ownership (parity law P1)`);
    assert.match(source, /siteConfig\.redirects/, `${tenant} registers something other than its redirect table`);
  }
  // …and so does the scaffold a NEW tenant is minted from.
  const scaffold = readFileSync(join(ROOT, 'packages', 'core', 'cli', 'create-site.mjs'), 'utf8');
  assert.match(scaffold, /setRouteOwnershipProvider\(/, 'create-site.mjs would mint a tenant without the provider');
});
