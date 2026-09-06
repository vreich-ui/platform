#!/usr/bin/env node
/**
 * R6.3 (T21.25) acceptance case, verbatim from the spec's build-order table
 * (analytics-dashboard-spec.md §10): "Playwright: hover chart A → chart B
 * legend updates" — the concrete proof that uPlot's `cursor.sync` wiring in
 * `AnalyticsCharts.tsx` actually works in a real browser, on the real built
 * page, not just in isolation.
 *
 * The own tab's "Over time" card renders two synced mini charts stacked —
 * "chart A" (`data-analytics-chart="visits"`) and "chart B"
 * (`data-analytics-chart="uniques"`). The fixture below sets
 * `uniques[i] === visits[i] / 10` for every bucket, so after hovering ONLY
 * chart A, reading chart B's own (untouched) legend value and multiplying by
 * 10 must equal chart A's legend value — that equality can only hold if
 * `cursor.sync` moved chart B's cursor to the SAME bucket chart A is
 * hovering, not merely "some" bucket. This is a stronger, pixel-position-
 * independent assertion than "the text changed".
 *
 * `/admin/analytics` is a real auth-gated admin page; rather than driving a
 * real Netlify Identity login, this intercepts the two endpoints the page
 * calls (`admin-users` for `fetchMe`, `admin-analytics` for both tabs' data)
 * with fixture responses — the SAME approach the sink/API contracts already
 * get proven against in the unit suite, just carried one layer up to prove
 * the wiring, not re-prove the contracts.
 *
 * OPT-IN (not part of `npm test` — needs a built site + Chromium):
 *   npm run build
 *   E2E_BROWSER=1 node tests/e2e/analytics-uplot-cursor-sync.browser.mjs [--dist dist] [--chromium /path/to/chromium]
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { withTestTrafficHeaders } from '../../packages/core/cli/capture/test-traffic-header.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const distDir = path.resolve(repoRoot, argOf('--dist', 'dist'));

if (!process.env.E2E_BROWSER) {
  console.log('[analytics-uplot-cursor-sync.browser] skipped — set E2E_BROWSER=1 (needs a built site + Chromium)');
  process.exit(0);
}
if (!fs.existsSync(path.join(distDir, 'admin', 'analytics', 'index.html'))) {
  console.error(`[analytics-uplot-cursor-sync.browser] no build at ${distDir} — run \`npm run build\` first`);
  process.exit(2);
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};
const serve = () =>
  new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      let file = path.join(distDir, decodeURIComponent(url.pathname));
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
      if (!fs.existsSync(file) && fs.existsSync(`${file}.html`)) file = `${file}.html`;
      if (!fs.existsSync(file)) {
        res.writeHead(404, { 'content-type': 'text/plain' });
        return res.end('not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });

// ─── fixtures ────────────────────────────────────────────────────────────────

const ME_FIXTURE = {
  ok: true,
  user: { email: 'runner@example.com', display_name: 'Runner', role: 'owner', status: 'active' },
  bootstrap: false,
  roles: ['owner'],
  onboarding: { completed_at: '2026-01-01T00:00:00.000Z', steps: {} },
  policy: { require_display_name: false },
};

// visits[i] / 10 === uniques[i] for every bucket, by construction — the
// property the cross-chart assertion below depends on.
const VISITS = [100, 150, 200, 250, 300, 350, 400];
const UNIQUES = VISITS.map((v) => v / 10);
const DATES = VISITS.map((_, i) => `2026-08-${String(20 + i).padStart(2, '0')}`);

const OWN_FIXTURE = {
  ok: true,
  configured: true,
  enabled: true,
  range: '7d',
  window: {
    from: Date.parse('2026-08-20T00:00:00.000Z'),
    to: Date.parse('2026-08-26T23:59:59.999Z'),
    resolution: 'day',
  },
  stats: {
    project_id: 'test',
    days: 7,
    totals: {
      events_by_kind: {},
      sessions: UNIQUES.reduce((a, b) => a + b, 0),
      visitors: UNIQUES.reduce((a, b) => a + b, 0),
      consented_sessions: 0,
      commerce_events: 0,
      member_links: 0,
    },
    daily: DATES.map((date, i) => ({
      date,
      pageviews: VISITS[i],
      sessions: UNIQUES[i],
      visitors: UNIQUES[i],
      buy_clicks: 0,
      purchases: 0,
    })),
    top_objects: [],
    top_sources: [],
    last_event_at: null,
  },
  object_directory: {},
  surfaces: [],
};

const NETLIFY_FIXTURE = {
  ok: true,
  configured: false,
  enabled: false,
  error_code: 'not_configured',
  message: 'Netlify Analytics is not connected for this test fixture.',
  range: '7d',
};

const main = async () => {
  const { chromium } = await import('playwright-core');
  const executablePath = argOf('--chromium', process.env.CHROMIUM_PATH);
  const { server, origin } = await serve();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const context = await browser.newContext(withTestTrafficHeaders({ viewport: { width: 1280, height: 900 } }));
  // AdminLayout's own gate script (independent of the React island) checks
  // Netlify Identity's client-side session, not just the two function
  // endpoints below — a signed-out session hides the whole workspace behind
  // "Admin login required" regardless of what the endpoints return. Seed the
  // localStorage key `goTrueClient.ts` reads (`<siteSlug>-gotrue-user`,
  // `dr-lurie` for this site) with a non-expired fake session before any page
  // script runs.
  await context.addInitScript((storageKey) => {
    localStorage.setItem(
      storageKey,
      JSON.stringify({
        id: 'runner-fixture',
        email: 'runner@example.com',
        token: {
          access_token: 'fixture-token',
          refresh_token: 'fixture-refresh',
          expires_at: Date.now() + 3_600_000,
          token_type: 'bearer',
        },
      })
    );
  }, 'dr-lurie-gotrue-user');
  const page = await context.newPage();
  let failed = 0;
  const fail = (msg) => {
    console.log(`FAIL ${msg}`);
    failed += 1;
  };
  const ok = (msg) => console.log(`ok   ${msg}`);

  // The gate's OWN admin check (AdminLayout.astro's inline script).
  await page.route('**/.netlify/functions/admin-auth-state', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ authenticated: true, isAdmin: true, email: 'runner@example.com', roles: ['owner'] }),
    })
  );
  // The React island's own `fetchMe` (useCurrentUser).
  await page.route('**/.netlify/functions/admin-users', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(ME_FIXTURE) })
  );
  await page.route('**/.netlify/functions/admin-analytics*', (route) => {
    const url = new URL(route.request().url());
    const body = url.searchParams.get('source') === 'own' ? OWN_FIXTURE : NETLIFY_FIXTURE;
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });

  const consoleErrors = [];
  page.on('pageerror', (err) => consoleErrors.push(String(err)));
  if (process.env.DEBUG_ANALYTICS_E2E) {
    page.on('console', (msg) => console.log('[console]', msg.type(), msg.text()));
    page.on('requestfailed', (req) => console.log('[requestfailed]', req.url(), req.failure()?.errorText));
  }

  await page.goto(`${origin}/admin/analytics`, { waitUntil: 'load' });
  if (process.env.DEBUG_ANALYTICS_E2E) {
    await page.waitForTimeout(3000);
    await page.screenshot({
      path: '/tmp/claude-0/-home-claude/b9f1e2a2-1a94-5a01-8578-56af8fe02274/scratchpad/real-test.png',
      fullPage: true,
    });
  }

  // The own tab's chart mounts uPlot via a dynamic import — wait for both
  // synced mini charts (and their legends) to actually appear.
  await page.waitForSelector('[data-analytics-chart="visits"] .u-legend', { timeout: 15_000 });
  await page.waitForSelector('[data-analytics-chart="uniques"] .u-legend', { timeout: 15_000 });
  ok('both synced charts mounted (uPlot loaded via dynamic import)');

  const readCurrentValue = async (metric) =>
    page
      .locator(`[data-analytics-chart="${metric}"] .u-legend .u-series .u-value`)
      .nth(1) // [0]=x/time, [1]=current period, [2]=previous-period ghost
      .innerText();

  const beforeB = await readCurrentValue('uniques');
  if (beforeB.trim() !== '—')
    fail(`expected chart B's legend to read the no-cursor placeholder before any hover, got "${beforeB}"`);
  else ok(`chart B legend shows the no-cursor placeholder before hovering ("${beforeB}")`);

  const overA = page.locator('[data-analytics-chart="visits"] .u-over');
  const box = await overA.boundingBox();
  if (!box) {
    fail('chart A has no bounding box to hover');
  } else {
    // Hover partway across chart A's plot area — which exact bucket this
    // lands on does not matter; the fixture's visits[i] = uniques[i] * 10
    // relationship is what the assertion below actually checks.
    await page.mouse.move(box.x + box.width * 0.6, box.y + box.height / 2);
    await page.waitForTimeout(150);

    const afterA = await readCurrentValue('visits');
    const afterB = await readCurrentValue('uniques');
    const numA = Number(afterA.replace(/[^0-9.-]/g, ''));
    const numB = Number(afterB.replace(/[^0-9.-]/g, ''));

    if (afterA.trim() === '—' || afterB.trim() === '—') {
      fail(`expected both legends to show real values after hovering chart A, got A="${afterA}" B="${afterB}"`);
    } else if (!Number.isFinite(numA) || !Number.isFinite(numB)) {
      fail(`could not parse legend values as numbers: A="${afterA}" B="${afterB}"`);
    } else if (numB * 10 !== numA) {
      fail(
        `cursor sync mismatch — hovering chart A (visits="${afterA}") should move chart B's OWN cursor to the same bucket (expected uniques=${numA / 10}, got "${afterB}")`
      );
    } else {
      ok(
        `hovering chart A (visits=${numA}) updated chart B's own legend to the matching bucket (uniques=${numB}) — cursor sync confirmed`
      );
    }
  }

  // Bonus coverage (not the spec's named acceptance case, but the other half
  // of the same interaction hook): a plain click on a bucket — a near-zero
  // drag, per `zoomAndClickPlugin` — sets the range to that single day.
  if (box) {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(150);
    const url = new URL(page.url());
    const isCustomDay =
      url.searchParams.get('range') === 'custom' &&
      DATES.includes(url.searchParams.get('from') ?? '') &&
      url.searchParams.get('from') === url.searchParams.get('to');
    if (isCustomDay) {
      ok(`clicking a bucket set the range to a single custom day (${url.searchParams.get('from')})`);
    } else {
      fail(`expected a bucket click to set range=custom&from=<day>&to=<same day>, got "${url.search}"`);
    }
  }

  if (consoleErrors.length > 0) {
    fail(`page threw ${consoleErrors.length} uncaught error(s): ${consoleErrors[0]}`);
  } else {
    ok('no uncaught page errors');
  }

  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(`[analytics-uplot-cursor-sync.browser] FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
