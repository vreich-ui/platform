/**
 * Ownership rules for the object-page catch-all (packages/core/app/utils/object-page-routes.ts)
 * — the derivation that makes agent-created pages live at their route while
 * never fighting an existing owner for a path:
 *
 *   - file routes always win (the hand-wired converted pages emit nothing);
 *   - article permalinks and reserved prefixes (blog bases, topics hub,
 *     /admin) are refused with a named reason, never silently dropped;
 *   - with today's exports (every page object file-owned) the emitted set is
 *     EMPTY — the build-diff-empty guarantee of the cutover commit.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { computeObjectPageRoutes } from '../../packages/core/app/utils/object-page-routes.js';

const ROUTE_FILES = [
  './index.astro',
  './about.astro',
  './404.astro',
  './solutions/early-access.astro',
  './learn/topics/index.astro',
  './learn/topics/[topicSlug].astro',
  './[...blog]/[...page].astro',
  './[...objectPage].astro',
];

const RESERVED = ['learn/library', 'category', 'tag', 'learn/topics', 'admin'];

test('a route served by a static file is skipped as file_route (root included)', () => {
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ROUTE_FILES,
    pageExports: [
      { objectId: 'page_home', route: '/' },
      { objectId: 'page_about', route: '/about' },
      { objectId: 'page_early_access', route: '/solutions/early-access' },
    ],
    postPermalinks: [],
    reservedPrefixes: RESERVED,
  });
  assert.deepEqual(paths, []);
  assert.deepEqual(
    skipped.map((skip) => [skip.objectId, skip.reason]),
    [
      ['page_home', 'file_route'],
      ['page_about', 'file_route'],
      ['page_early_access', 'file_route'],
    ]
  );
});

test('an unowned route is emitted with the leading slash stripped from the param', () => {
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ROUTE_FILES,
    pageExports: [
      { objectId: 'page_campaign', route: '/campaigns/spring-launch' },
      { objectId: 'page_faq', route: '/faq/' }, // trailing slash normalizes
    ],
    postPermalinks: [],
    reservedPrefixes: RESERVED,
  });
  assert.deepEqual(skipped, []);
  assert.deepEqual(paths, [
    { objectId: 'page_campaign', route: '/campaigns/spring-launch', param: 'campaigns/spring-launch' },
    { objectId: 'page_faq', route: '/faq', param: 'faq' },
  ]);
});

test('article permalinks and reserved prefixes are refused with named reasons', () => {
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ROUTE_FILES,
    pageExports: [
      { objectId: 'page_clash', route: '/my-existing-post' },
      { objectId: 'page_tagsquat', route: '/tag/retinoids' },
      { objectId: 'page_libroot', route: '/learn/library' },
      { objectId: 'page_admin', route: '/admin/backdoor' },
      { objectId: 'page_topics', route: '/learn/topics/skin-health' },
      { objectId: 'page_ok', route: '/learn/deep-dives' }, // sibling of a reserved prefix, not under it
    ],
    postPermalinks: ['my-existing-post', 'another-post'],
    reservedPrefixes: RESERVED,
  });
  assert.deepEqual(
    skipped.map((skip) => [skip.objectId, skip.reason]),
    [
      ['page_clash', 'blog_slug'],
      ['page_tagsquat', 'reserved_prefix'],
      ['page_libroot', 'reserved_prefix'],
      ['page_admin', 'reserved_prefix'],
      ['page_topics', 'reserved_prefix'],
    ]
  );
  assert.deepEqual(paths, [{ objectId: 'page_ok', route: '/learn/deep-dives', param: 'learn/deep-dives' }]);
});

test('listing/content_detail page objects are loader-owned — never emitted, even on free routes (W6)', () => {
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ROUTE_FILES,
    pageExports: [
      // Family-pattern routes (the real W6 objects' shape) …
      { objectId: 'page_category', route: '/category/[category]', pageType: 'listing' },
      { objectId: 'page_article', route: '/%slug%', pageType: 'content_detail' },
      // … and even a route nobody else owns: the pageType alone refuses it.
      { objectId: 'page_rogue_listing', route: '/totally-free-route', pageType: 'listing' },
      // A standard page on a free route still emits.
      { objectId: 'page_ok', route: '/another-free-route', pageType: 'standard' },
    ],
    postPermalinks: [],
    reservedPrefixes: RESERVED,
  });
  assert.deepEqual(
    skipped.map((skip) => [skip.objectId, skip.reason]),
    [
      ['page_category', 'loader_owned_page_type'],
      ['page_article', 'loader_owned_page_type'],
      ['page_rogue_listing', 'loader_owned_page_type'],
    ]
  );
  assert.deepEqual(paths, [{ objectId: 'page_ok', route: '/another-free-route', param: 'another-free-route' }]);
});

test('malformed routes are invalid_route, and dynamic files are never treated as owners', () => {
  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths: ROUTE_FILES,
    pageExports: [
      { objectId: 'page_norel', route: 'no-leading-slash' },
      { objectId: 'page_none', route: undefined },
      // '[...blog]' the file exists, but a dynamic file must not own arbitrary paths:
      { objectId: 'page_free', route: '/anything-not-a-post' },
    ],
    postPermalinks: [],
    reservedPrefixes: RESERVED,
  });
  assert.deepEqual(
    skipped.map((skip) => [skip.objectId, skip.reason]),
    [
      ['page_norel', 'invalid_route'],
      ['page_none', 'invalid_route'],
    ]
  );
  assert.deepEqual(paths, [{ objectId: 'page_free', route: '/anything-not-a-post', param: 'anything-not-a-post' }]);
});

test('the real committed exports emit ZERO paths today — every page object is file-owned', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  // Walk up from this file (source OR its .tmp/ci-test compiled copy) to the
  // repo root — the test runner's cwd is not guaranteed.
  let repoRoot = path.dirname(fileURLToPath(import.meta.url));
  while (!fs.existsSync(path.join(repoRoot, 'sites', 'drlurie', 'data', 'site', 'pages'))) {
    const parent = path.dirname(repoRoot);
    if (parent === repoRoot) throw new Error('repo root with sites/drlurie/data/site/pages not found');
    repoRoot = parent;
  }
  const pagesDir = path.join(repoRoot, 'sites', 'drlurie', 'data', 'site', 'pages');
  const pageExports = fs
    .readdirSync(pagesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => {
      const body = JSON.parse(fs.readFileSync(path.join(pagesDir, file), 'utf8')) as {
        route?: unknown;
        pageType?: unknown;
      };
      // Mirrors the real catch-all's mapping ([...objectPage].astro), which
      // passes pageType so listing/content_detail exports stay loader-owned.
      return { objectId: path.basename(file, '.json'), route: body.route, pageType: body.pageType };
    });
  const walk = (dir: string): string[] =>
    fs
      .readdirSync(dir, { withFileTypes: true })
      .flatMap((entry) => (entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]));
  const routeFilePaths = walk(path.join(repoRoot, 'sites', 'drlurie', 'app', 'pages'))
    .filter((file) => file.endsWith('.astro'))
    .map(
      (file) =>
        `/sites/drlurie/app/pages/${path
          .relative(path.join(repoRoot, 'sites', 'drlurie', 'app', 'pages'), file)
          .replace(/\\/g, '/')}`
    );

  const { paths, skipped } = computeObjectPageRoutes({
    routeFilePaths,
    pageExports,
    postPermalinks: [],
    reservedPrefixes: RESERVED,
  });
  // S2 made `page_shop` the first catch-all-served export; W5 (2026-07-12)
  // converted the last three hand-coded routes the same way — their route
  // files are deleted and the objects own the routes, zero code each.
  // 2026-07-13: `page_object_showcase` (a QA/dev surface, standard pageType on
  // a free route, robots-noindex, unwired from nav) is served the same way.
  // BASELINE_FREE_ROUTES is the permanent regression check for these — a
  // fixed, hand-converted set that migration must never re-file-own or
  // misclassify. It is deliberately NOT the full exact-match assertion:
  // this is an agentic publishing fleet, and any later agent-published
  // standard-pageType page on a free route (e.g. `page_skincare_is_not_
  // self_worth` / `/skincare-is-not-self-worth`, added 2026-08-09) is
  // EXPECTED to also start appearing here as content grows. Hardcoding the
  // full exact set would make this test fail on every future publish and
  // prove nothing the synthetic fixture tests above don't already cover —
  // the mechanism itself (routing rules, skip reasons) is what matters, not
  // today's exact page census (T16.6).
  const BASELINE_FREE_ROUTES = [
    { objectId: 'page_object_showcase', route: '/object-showcase', param: 'object-showcase' },
    { objectId: 'page_pricing', route: '/pricing', param: 'pricing' },
    { objectId: 'page_services', route: '/services', param: 'services' },
    { objectId: 'page_shop', route: '/shop', param: 'shop' },
    { objectId: 'page_shop_preview', route: '/solutions/shop-preview', param: 'solutions/shop-preview' },
  ];
  const sortedPaths = [...paths].sort((a, b) => a.route.localeCompare(b.route));
  for (const expected of BASELINE_FREE_ROUTES) {
    assert.deepEqual(
      sortedPaths.find((emitted) => emitted.objectId === expected.objectId),
      expected,
      `${expected.objectId} must still be served via the object-page catch-all: ${JSON.stringify(sortedPaths)}`
    );
  }
  // Anything emitted beyond the baseline is later-published content — still
  // required to be internally sane: no two pages fighting over one route.
  const extraPaths = sortedPaths.filter(
    (emitted) => !BASELINE_FREE_ROUTES.some((baseline) => baseline.objectId === emitted.objectId)
  );
  const extraRoutes = new Set(extraPaths.map((emitted) => emitted.route));
  assert.equal(extraRoutes.size, extraPaths.length, `duplicate routes among catch-all-served pages: ${JSON.stringify(extraPaths)}`);
  assert.equal(skipped.length, pageExports.length - paths.length);
  // Every other committed export is served by a dedicated file: the 12
  // originally converted pages by their thin loaders (file_route), and the
  // W6 listing/content_detail objects (+ S2's page_product_detail) by the
  // formalized loaders that read them (loader_owned_page_type). Any OTHER
  // reason means a committed export is unreachable — that must fail here.
  const servedElsewhere = new Set(['file_route', 'loader_owned_page_type']);
  assert.ok(
    skipped.every((skip) => servedElsewhere.has(skip.reason)),
    JSON.stringify(skipped.filter((skip) => !servedElsewhere.has(skip.reason)))
  );
});
