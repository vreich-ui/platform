#!/usr/bin/env node
/**
 * W18 T18.9 Part A.3 — browser smoke for the site-wide Identity token router
 * (T18.0b): a real Chromium loads a BUILT tenant's home page with Netlify's
 * default mail hash (`/#invite_token=…`, `/#recovery_token=…`,
 * `/#confirmation_token=…`, `/#email_change_token=…`) and must land on
 * `/admin/accept#<same hash>`; a hash-less page and `/admin/accept` itself
 * must NOT be redirected. The unit half of this lives in
 * `goTrueClient.test.ts` (`detectIdentityToken` / `shouldRouteToAccept`);
 * this proves the wiring in `HeaderAuthButton.astro` actually runs on the
 * shipped page.
 *
 * OPT-IN (not part of `npm test` — needs a built site + Chromium):
 *   cd sites/platform && NODE_OPTIONS=--max-old-space-size=6144 npx astro build --config astro.config.ts && cd ../..
 *   E2E_BROWSER=1 node tests/e2e/accept-router.browser.mjs [--dist sites/platform/dist] [--chromium /path/to/chromium]
 *
 * Uses `playwright-core` (already a devDependency) with the preinstalled
 * Chromium (`PLAYWRIGHT_BROWSERS_PATH` / `--chromium`); prints one line per
 * case and exits 1 on the first failure. Serves `dist/` from a loopback
 * static server — no Netlify, no network.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};
const distDir = path.resolve(repoRoot, argOf('--dist', 'sites/platform/dist'));

if (!process.env.E2E_BROWSER) {
  console.log('[accept-router.browser] skipped — set E2E_BROWSER=1 (needs a built site + Chromium)');
  process.exit(0);
}
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.error(`[accept-router.browser] no build at ${distDir} — build the site first (see header)`);
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
        // Astro's build emits /admin/accept/index.html; anything else unknown → 404 page if present
        const notFound = path.join(distDir, '404.html');
        res.writeHead(404, { 'content-type': 'text/html' });
        return res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : 'not found');
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${server.address().port}` }));
  });

const main = async () => {
  const { chromium } = await import('playwright-core');
  const executablePath = argOf('--chromium', process.env.CHROMIUM_PATH);
  const { server, origin } = await serve();
  const browser = await chromium.launch(executablePath ? { executablePath } : {});
  const page = await browser.newPage();
  let failed = 0;
  const check = async (label, from, expectPath, expectHash) => {
    await page.goto(`${origin}${from}`, { waitUntil: 'load' });
    // the router runs from the header island's init; give client scripts one tick
    await page.waitForTimeout(400);
    const { pathname, hash } = await page.evaluate(() => ({
      pathname: location.pathname.replace(/\/+$/, '') || '/',
      hash: location.hash,
    }));
    const ok = pathname === expectPath && hash === expectHash;
    console.log(
      `${ok ? 'ok  ' : 'FAIL'} ${label}: ${from} → ${pathname}${hash}${ok ? '' : ` (expected ${expectPath}${expectHash})`}`
    );
    if (!ok) failed += 1;
  };
  await check('invite token routes to accept', '/#invite_token=abc', '/admin/accept', '#invite_token=abc');
  await check('recovery token routes to accept', '/#recovery_token=r1', '/admin/accept', '#recovery_token=r1');
  await check(
    'confirmation token routes to accept',
    '/#confirmation_token=c1',
    '/admin/accept',
    '#confirmation_token=c1'
  );
  await check(
    'email-change token routes to accept',
    '/#email_change_token=e1',
    '/admin/accept',
    '#email_change_token=e1'
  );
  await check('a plain page is left alone', '/', '/', '');
  await check('an unrelated hash is left alone', '/#section-2', '/', '#section-2');
  await check(
    'the accept page itself is not re-routed',
    '/admin/accept/#invite_token=abc',
    '/admin/accept',
    '#invite_token=abc'
  );
  await browser.close();
  server.close();
  process.exit(failed ? 1 : 0);
};

main().catch((error) => {
  console.error(`[accept-router.browser] FAILED: ${error instanceof Error ? error.stack : error}`);
  process.exit(1);
});
