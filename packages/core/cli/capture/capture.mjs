#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import robotsParser from 'robots-parser';

// The browser plane (viewports, extraction, screenshots) is shared with the
// draft-preview renderer — T12.10. Nothing about robots, policy, or the crawl
// queue lives there; nothing about a browser lives here.
import { CAPTURE_VIEWPORTS, capturePageSnapshot, launchCaptureBrowser } from './browser.mjs';
import {
  SNAPSHOT_SCHEMA_VERSION,
  isLikelyHtmlPage,
  isUrlWithinPolicy,
  normalizeCrawlUrl,
  redactSnapshot,
  stablePageId,
  validateCapturePolicy,
  writeJson,
} from './snapshot-v1.mjs';

const USER_AGENT = 'W12CaptureSpike/1.0';
const DEFAULT_VIEWPORTS = CAPTURE_VIEWPORTS;

function usage(message) {
  if (message) console.error(`Error: ${message}\n`);
  console.error(
    'Usage: node packages/core/cli/capture/capture.mjs --url <https://target/> --policy <capture-policy.json> --out <directory> [--browser-executable <path>] [--redacted-fixture <path>]'
  );
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--help') usage();
    if (!key.startsWith('--')) usage(`Unexpected argument: ${key}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) usage(`Missing value for ${key}`);
    args[key.slice(2)] = value;
    index += 1;
  }
  for (const required of ['url', 'policy', 'out']) if (!args[required]) usage(`Missing --${required}`);
  return args;
}

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function fetchSameOrigin(url, origin, init = {}) {
  let current = normalizeCrawlUrl(url);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!current || new URL(current).origin !== origin) {
      throw new Error(`Refusing cross-origin fetch: ${current ?? url}`);
    }
    const response = await fetch(current, { ...init, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error(`Redirect from ${current} omitted Location.`);
    current = normalizeCrawlUrl(new URL(location, current).href);
  }
  throw new Error(`Too many redirects while fetching ${url}.`);
}

async function fetchRobots(seed, policy) {
  const robotsUrl = new URL('/robots.txt', seed.origin).href;
  const response = await fetchSameOrigin(robotsUrl, seed.origin, { headers: { 'user-agent': USER_AGENT } });
  if (!response.ok) throw new Error(`robots.txt returned HTTP ${response.status}; refusing to crawl.`);
  const body = await response.text();
  const parsed = robotsParser(robotsUrl, body);
  const crawlDelaySeconds = parsed.getCrawlDelay(USER_AGENT) ?? parsed.getCrawlDelay('*') ?? 0;
  return {
    parsed,
    record: {
      url: robotsUrl,
      status: response.status,
      fetchedAt: new Date().toISOString(),
      sha256: createHash('sha256').update(body).digest('hex'),
      sitemaps: parsed.getSitemaps(),
      crawlDelayMs: Math.ceil(crawlDelaySeconds * 1000),
      respected: policy.respectRobots,
    },
  };
}

const decodeXml = (value) =>
  value
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'");

async function discoverSitemapPages({ sitemapUrls, robots, policy, seedOrigin, delayMs }) {
  const pending = [...sitemapUrls];
  const seenSitemaps = new Set();
  const pageUrls = [];
  const records = [];
  let lastRequestAt = Date.now();

  while (pending.length > 0 && seenSitemaps.size < 10) {
    const sitemapUrl = normalizeCrawlUrl(pending.shift());
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);
    if (!isUrlWithinPolicy(sitemapUrl, policy, seedOrigin) || robots.isAllowed(sitemapUrl, USER_AGENT) === false) {
      records.push({ url: sitemapUrl, skipped: true, reason: 'outside_policy_or_robots_disallowed' });
      continue;
    }
    const waitMs = Math.max(0, delayMs - (Date.now() - lastRequestAt));
    if (waitMs > 0) await sleep(waitMs);
    lastRequestAt = Date.now();
    const response = await fetchSameOrigin(sitemapUrl, seedOrigin, { headers: { 'user-agent': USER_AGENT } });
    if (!response.ok)
      throw new Error(`Sitemap ${sitemapUrl} returned HTTP ${response.status}; refusing partial discovery.`);
    const body = await response.text();
    const locations = [...body.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((match) =>
      normalizeCrawlUrl(decodeXml(match[1]))
    );
    records.push({
      url: sitemapUrl,
      status: response.status,
      sha256: createHash('sha256').update(body).digest('hex'),
      locations: locations.length,
    });
    for (const location of locations) {
      if (!location) continue;
      if (new URL(location).pathname.toLowerCase().endsWith('.xml')) pending.push(location);
      else if (isLikelyHtmlPage(location) && isUrlWithinPolicy(location, policy, seedOrigin)) pageUrls.push(location);
    }
  }

  return { pageUrls: [...new Set(pageUrls)], records, lastRequestAt };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedUrl = normalizeCrawlUrl(args.url);
  if (!seedUrl) throw new Error('The seed URL must use HTTP or HTTPS.');
  const seed = new URL(seedUrl);
  const policy = validateCapturePolicy(JSON.parse(await readFile(path.resolve(args.policy), 'utf8')));
  if (!isUrlWithinPolicy(seedUrl, policy, seed.origin))
    throw new Error('Seed URL is outside the supplied capture policy.');

  const outputRoot = path.resolve(args.out);
  await mkdir(outputRoot, { recursive: true });
  const robots = await fetchRobots(seed, policy);
  const effectiveDelayMs = Math.max(policy.delayMs, robots.record.crawlDelayMs);
  const sitemap = await discoverSitemapPages({
    sitemapUrls: robots.record.sitemaps,
    robots: robots.parsed,
    policy,
    seedOrigin: seed.origin,
    delayMs: effectiveDelayMs,
  });
  robots.record.sitemapFetches = sitemap.records;
  const { browser, executablePath: browserExecutable } = await launchCaptureBrowser(args['browser-executable']);
  const queue = [...new Set([seedUrl, ...sitemap.pageUrls])];
  const queued = new Set(queue);
  const capturedFinalUrls = new Set();
  const pages = [];
  const skipped = [];
  const quarantined = [];
  let lastNavigationAt = sitemap.lastRequestAt;

  try {
    while (queue.length > 0 && pages.length < policy.maxPages) {
      const url = queue.shift();
      if (robots.parsed.isAllowed(url, USER_AGENT) === false) {
        skipped.push({ url, reason: 'robots_disallowed' });
        continue;
      }
      const waitMs = Math.max(0, effectiveDelayMs - (Date.now() - lastNavigationAt));
      if (waitMs > 0) await sleep(waitMs);
      lastNavigationAt = Date.now();
      try {
        const captured = await capturePageSnapshot({
          browser,
          url,
          outputRoot,
          viewports: DEFAULT_VIEWPORTS,
          pageId: stablePageId(url),
          sameOriginNavigationOnly: seed.origin,
          userAgent: USER_AGENT,
        });
        if (!isUrlWithinPolicy(captured.url, policy, seed.origin)) {
          quarantined.push({ url, reason: 'redirected_outside_policy', finalUrl: captured.url });
          continue;
        }
        const finalUrl = normalizeCrawlUrl(captured.url);
        if (capturedFinalUrls.has(finalUrl)) {
          skipped.push({ url, reason: 'duplicate_redirect_target', finalUrl });
          continue;
        }
        capturedFinalUrls.add(finalUrl);
        pages.push(captured);
        for (const discovered of captured.discoveredLinks) {
          const normalized = normalizeCrawlUrl(discovered);
          if (!normalized || queued.has(normalized) || !isUrlWithinPolicy(normalized, policy, seed.origin)) continue;
          if (!isLikelyHtmlPage(normalized)) {
            skipped.push({ url: normalized, reason: 'non_html_resource' });
            queued.add(normalized);
            continue;
          }
          if (robots.parsed.isAllowed(normalized, USER_AGENT) === false) {
            skipped.push({ url: normalized, reason: 'robots_disallowed' });
            queued.add(normalized);
            continue;
          }
          queued.add(normalized);
          queue.push(normalized);
        }
      } catch (error) {
        quarantined.push({ url, reason: 'capture_failed', error: String(error.message ?? error).slice(0, 1000) });
      }
    }
  } finally {
    await browser.close();
  }

  const snapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    capture: {
      targetUrl: seedUrl,
      origin: seed.origin,
      capturedAt: new Date().toISOString(),
      localOnly: true,
      redacted: false,
      contentTreatment: 'page content was recorded as data and never interpreted as instructions',
      crawler: { userAgent: USER_AGENT, browserExecutable, concurrency: 1, delayMs: effectiveDelayMs },
      policy,
      robots: robots.record,
      viewports: DEFAULT_VIEWPORTS,
    },
    pages,
    diagnostics: {
      queuedUrls: queued.size,
      capturedPages: pages.length,
      skipped,
      quarantined,
      stoppedAtProjectMaxPages: pages.length === policy.maxPages && queue.length > 0,
    },
  };
  const snapshotPath = path.join(outputRoot, 'snapshot.v1.json');
  await writeJson(snapshotPath, snapshot);
  if (args['redacted-fixture']) await writeJson(path.resolve(args['redacted-fixture']), redactSnapshot(snapshot));

  console.log(
    JSON.stringify(
      {
        ok: quarantined.length === 0,
        snapshotPath,
        capturedPages: pages.length,
        skippedPages: skipped.length,
        quarantinedPages: quarantined.length,
        stoppedAtProjectMaxPages: snapshot.diagnostics.stoppedAtProjectMaxPages,
      },
      null,
      2
    )
  );
  if (quarantined.length > 0) process.exitCode = 2;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
