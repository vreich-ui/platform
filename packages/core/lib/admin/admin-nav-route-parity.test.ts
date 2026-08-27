/**
 * The nav↔route parity guard (F2).
 *
 * `/admin/traffic` shipped a 404: `AdminShell.tsx`'s nav had the link, the
 * server function and the page component existed, but nobody registered the
 * route in `SHELL_ROUTES` (`packages/core/app/shell-routes.ts`) — so no site
 * ever injected it. Nothing checked the nav tree and the route table
 * against each other; this test is that check, run for real on every CI
 * build (`npm test`), not a human-read report someone has to remember to
 * run.
 *
 * Chosen home: `node --test`, not `scripts/audit-site-admin-parity.mjs`.
 * The audit script prints a pass/gap table for a human to read and is never
 * invoked by CI (`.github/workflows/actions.yaml` runs `npm test`, `npm run
 * check`, and the schema-migration gate — never the audit script). A test
 * that only a human remembers to run is exactly the gap that let
 * `/admin/traffic` ship. This file lives beside `admin-navigation.ts`,
 * compiles under `tsconfig.test.json`, and its failure fails `npm test`.
 *
 * Reads the REAL data on both sides — `NAV_ITEMS` (the actual tree
 * `AdminShell.tsx` renders, lifted to `admin-nav-items.ts` for exactly this
 * reason) and `SHELL_ROUTES`/`OVERRIDABLE_SHELL_ROUTES` (parsed out of the
 * real `shell-routes.ts` by `parseShellRoutePatterns`, the same parser
 * `admin-parity.mjs`'s own audit uses) — so neither side can drift from
 * what ships without this test noticing.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { NAV_ITEMS } from './admin-nav-items.js';
import { parseShellRoutePatterns, repoRoot } from '../../cli/admin-parity.mjs';

/**
 * True when `href` resolves to `pattern`. Patterns may carry Astro's
 * bracket placeholders (`[requestId]`, `[objectId]`) — matched positionally
 * per segment, not by literal string equality, so `/admin/requests/[requestId]`
 * matches a literal deep link like `/admin/requests/req_123` but a nav href
 * still has to match segment-for-segment (same segment count, same literal
 * text on every non-bracket segment).
 */
export const routeMatchesPattern = (pattern: string, href: string): boolean => {
  const patternSegments = pattern.split('/');
  const hrefSegments = href.split('/');
  if (patternSegments.length !== hrefSegments.length) return false;
  return patternSegments.every((segment, i) => {
    if (segment.startsWith('[') && segment.endsWith(']')) return true;
    return segment === hrefSegments[i];
  });
};

/** Extensions Astro will route from a `pages/` file (mirrors `shell-routes.ts`'s `PAGE_EXTENSIONS`). */
const PAGE_EXTENSIONS = ['.ts', '.js', '.mjs', '.astro'];

/** True when some `sites/<slug>/app/pages<href>{.ts,.js,.mjs,.astro}` exists — a site-owned page, not a shell route. */
const isSiteOwnedPage = (href: string): boolean => {
  const sitesDir = path.join(repoRoot, 'sites');
  if (!fs.existsSync(sitesDir)) return false;
  return fs.readdirSync(sitesDir, { withFileTypes: true }).some((entry) => {
    if (!entry.isDirectory()) return false;
    const pagesDir = path.join(sitesDir, entry.name, 'app', 'pages');
    return PAGE_EXTENSIONS.some((ext) => fs.existsSync(path.join(pagesDir, `${href}${ext}`)));
  });
};

const allNavItems = () => NAV_ITEMS.flatMap((group) => group.items);

test('every linked AdminShell nav href resolves to a real route (SHELL_ROUTES, OVERRIDABLE_SHELL_ROUTES, or a site-owned page)', () => {
  const routePatterns = parseShellRoutePatterns();
  const unresolved: string[] = [];
  for (const item of allNavItems()) {
    // `soon: true` items are deliberately shown-but-unlinked (no route
    // exists yet, and NavList.tsx never renders them as an <a>) — exempt by
    // design, per AdminShell.tsx's own NAV comment.
    if (item.soon) continue;
    const resolves =
      routePatterns.some((pattern) => routeMatchesPattern(pattern, item.href)) || isSiteOwnedPage(item.href);
    if (!resolves) unresolved.push(`${item.label} → ${item.href}`);
  }
  assert.deepEqual(
    unresolved,
    [],
    `nav link(s) with no matching route — this is exactly the /admin/traffic bug (add the pattern to SHELL_ROUTES in shell-routes.ts): ${unresolved.join(', ')}`
  );
});

/**
 * The reverse direction: a registered `/admin/*` shell route no nav item
 * reaches. `/admin/traffic` could have been caught from this side too — a
 * route present in `SHELL_ROUTES` with nothing in the sidebar pointing at
 * it is exactly as suspicious as a nav link with no route, just less
 * user-visible (a page nobody can find vs. a page that 404s).
 *
 * Not every route needs a sidebar entry, though — some are reached another
 * way on purpose. Those are named here, not silently ignored: any NEW
 * unreached `/admin/*` route fails this test until it is either linked from
 * NAV_ITEMS or added below with a reason.
 */
const ADMIN_ROUTES_INTENTIONALLY_UNREACHED_FROM_NAV = new Set<string>([
  '/admin/accept', // T18.0b — Identity e-mail token landing page, reached from an email link, not the sidebar
  '/admin/authorize', // W14 F10 — OAuth consent screen, reached mid-flow from an external client, not the sidebar
  '/admin/welcome', // T18.5 — one-time onboarding redirect target, not a place you navigate back to
  '/admin/content', // T2.1 D1(a) — superseded by /admin/objects; kept only as a netlify.toml redirect target
  '/admin/templates', // T2.1 D1(a) — superseded by /admin/objects; kept only as a netlify.toml redirect target
  '/admin/media', // T2.1 D1(a) — superseded by /admin/objects; kept only as a netlify.toml redirect target
  '/admin/studio', // T2.1 D1(a) — superseded by /admin/objects; kept only as a netlify.toml redirect target
  '/admin/requests/[requestId]', // W19 T19.4 — deep link only; /admin/requests is the nav entry
  '/admin/content/[objectId]', // deep link only; /admin/objects is the nav entry
]);

test('every registered /admin/* shell route is reached from AdminShell nav, or is a documented exception', () => {
  const routePatterns = parseShellRoutePatterns().filter((p) => p.startsWith('/admin'));
  const navHrefs = allNavItems().map((item) => item.href);
  const unreached = routePatterns.filter(
    (pattern) =>
      !ADMIN_ROUTES_INTENTIONALLY_UNREACHED_FROM_NAV.has(pattern) &&
      !navHrefs.some((href) => routeMatchesPattern(pattern, href))
  );
  assert.deepEqual(
    unreached,
    [],
    `admin route(s) with no nav link and no documented reason — either link them from NAV_ITEMS (admin-nav-items.ts) or add them to ADMIN_ROUTES_INTENTIONALLY_UNREACHED_FROM_NAV with why: ${unreached.join(', ')}`
  );
});

test('routeMatchesPattern: bracket segments match any literal, everything else must match exactly', () => {
  assert.equal(routeMatchesPattern('/admin/requests/[requestId]', '/admin/requests/req_123'), true);
  assert.equal(routeMatchesPattern('/admin/requests/[requestId]', '/admin/requests'), false);
  assert.equal(routeMatchesPattern('/admin/requests', '/admin/requests'), true);
  assert.equal(routeMatchesPattern('/admin/requests', '/admin/request'), false);
  assert.equal(routeMatchesPattern('/admin/content/[objectId]', '/admin/content/obj_abc/extra'), false);
});
