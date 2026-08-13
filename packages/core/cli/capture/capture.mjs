#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';
import robotsParser from 'robots-parser';

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
const DEFAULT_VIEWPORTS = [
  { id: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 },
  { id: 'desktop', width: 1440, height: 1000, deviceScaleFactor: 1 },
];

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

async function firstExisting(paths) {
  for (const candidate of paths.filter(Boolean)) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Keep looking. Browser discovery never downloads or installs anything.
    }
  }
  throw new Error('No preinstalled Chromium-compatible browser was found. Pass --browser-executable.');
}

async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  const info = await stat(filePath);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: info.size };
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

async function extractPageModel(page) {
  return page.evaluate(() => {
    const clean = (value) => (value ?? '').replace(/\s+/g, ' ').trim();
    const absolute = (value) => {
      if (!value) return null;
      try {
        return new URL(value, document.baseURI).href;
      } catch {
        return null;
      }
    };
    const visible = (element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 1 && rect.height > 1 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    const selectorFor = (element) => {
      if (element.id) return `#${CSS.escape(element.id)}`;
      const parts = [];
      let current = element;
      while (current && current !== document.documentElement) {
        let part = current.tagName.toLowerCase();
        const siblings = [...(current.parentElement?.children ?? [])].filter(
          (item) => item.tagName === current.tagName
        );
        if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        parts.unshift(part);
        current = current.parentElement;
      }
      return `html > ${parts.join(' > ')}`;
    };
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    };
    const styleSample = (element) => {
      const style = getComputedStyle(element);
      return {
        display: style.display,
        position: style.position,
        color: style.color,
        backgroundColor: style.backgroundColor,
        backgroundImage: style.backgroundImage === 'none' ? null : style.backgroundImage,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        letterSpacing: style.letterSpacing,
        textAlign: style.textAlign,
        margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
        padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
        borderRadius: style.borderRadius,
      };
    };

    const semanticElements = [
      ...document.querySelectorAll(
        'header, nav, main, footer, article, section, aside, h1, h2, h3, h4, h5, h6, [role="banner"], [role="navigation"], [role="main"], [role="contentinfo"], [role="region"]'
      ),
    ];
    const outline = semanticElements.filter(visible).map((element) => ({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role'),
      level: /^H[1-6]$/.test(element.tagName) ? Number(element.tagName.slice(1)) : null,
      text: clean(element.textContent).slice(0, 500),
      selector: selectorFor(element),
    }));

    const candidateSet = new Set([
      ...document.querySelectorAll('body > header, body > nav, body > footer, section, article, [role="region"]'),
      ...document.querySelectorAll('main > *'),
    ]);
    const candidates = [...candidateSet].filter((element) => {
      if (!visible(element)) return false;
      const rect = element.getBoundingClientRect();
      return rect.height >= 48 && clean(element.textContent).length > 0;
    });

    const blocks = candidates.map((element, index) => {
      const links = [...element.querySelectorAll('a[href]')]
        .map((anchor) => ({
          label: clean(anchor.textContent).slice(0, 300),
          href: absolute(anchor.getAttribute('href')),
        }))
        .filter((link) => link.href);
      const text = clean(element.textContent);
      return {
        ordinal: index,
        tag: element.tagName.toLowerCase(),
        role: element.getAttribute('role'),
        accessibleName: clean(element.getAttribute('aria-label')) || null,
        selector: selectorFor(element),
        text: { value: text.slice(0, 12000), length: text.length, truncated: text.length > 12000 },
        links,
        boundingBoxes: {},
        computedStyles: {},
        screenshots: [],
        assetUrls: [],
      };
    });

    const assets = new Map();
    const addAsset = (rawUrl, kind, element, extra = {}) => {
      const url = absolute(rawUrl);
      if (!url || !/^https?:/.test(url)) return;
      const key = `${kind}:${url}`;
      if (!assets.has(key))
        assets.set(key, {
          url,
          kind,
          alt: clean(element?.getAttribute?.('alt')) || null,
          referencedBy: element ? selectorFor(element) : null,
          downloaded: false,
          ...extra,
        });
    };
    for (const image of document.querySelectorAll('img')) {
      addAsset(image.currentSrc || image.getAttribute('src'), 'image', image, { srcset: image.getAttribute('srcset') });
    }
    for (const source of document.querySelectorAll('source')) {
      addAsset(source.getAttribute('src'), 'media', source);
      const firstSrcset = source.getAttribute('srcset')?.split(',')[0]?.trim().split(/\s+/)[0];
      addAsset(firstSrcset, 'media', source, { srcset: source.getAttribute('srcset') });
    }
    for (const video of document.querySelectorAll('video')) {
      addAsset(video.getAttribute('src'), 'video', video);
      addAsset(video.getAttribute('poster'), 'poster', video);
    }
    for (const anchor of document.querySelectorAll('a[href]')) {
      const href = anchor.getAttribute('href');
      if (/\.(?:csv|docx?|mp3|mp4|pdf|pptx?|xlsx?|zip)(?:$|[?#])/i.test(href ?? '')) {
        addAsset(href, 'document', anchor, { label: clean(anchor.textContent).slice(0, 300) || null });
      }
    }
    for (const element of document.querySelectorAll('*')) {
      const background = getComputedStyle(element).backgroundImage;
      for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/g))
        addAsset(match[1], 'background-image', element);
    }

    for (const block of blocks) {
      const element = document.querySelector(block.selector);
      if (!element) continue;
      block.boundingBoxes.initial = box(element);
      block.computedStyles.initial = styleSample(element);
      block.assetUrls = [...assets.values()]
        .filter((asset) => {
          if (!asset.referencedBy) return false;
          const referenced = document.querySelector(asset.referencedBy);
          return referenced ? element.contains(referenced) : false;
        })
        .map((asset) => asset.url);
    }

    const navLinks = (selector) =>
      [...document.querySelectorAll(selector)]
        .map((anchor) => ({
          label: clean(anchor.textContent).slice(0, 300),
          href: absolute(anchor.getAttribute('href')),
        }))
        .filter((item) => item.href);
    const allLinks = [...document.querySelectorAll('a[href]')]
      .map((anchor) => absolute(anchor.getAttribute('href')))
      .filter(Boolean);

    return {
      title: document.title,
      lang: document.documentElement.lang || null,
      canonicalUrl: absolute(document.querySelector('link[rel="canonical"]')?.getAttribute('href')),
      metaDescription: document.querySelector('meta[name="description"]')?.getAttribute('content') ?? null,
      outline,
      blocks,
      assets: [...assets.values()],
      navigation: {
        primary: navLinks('header a[href], nav a[href], [role="navigation"] a[href]'),
        footer: navLinks('footer a[href], [role="contentinfo"] a[href]'),
      },
      discoveredLinks: [...new Set(allLinks)],
    };
  });
}

async function measureBlocks(page, blocks, viewportId) {
  return page.evaluate(
    ({ descriptors, viewport }) => {
      const result = {};
      for (const descriptor of descriptors) {
        const element = document.querySelector(descriptor.selector);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        result[descriptor.id] = {
          box: {
            x: Math.round(rect.x * 100) / 100,
            y: Math.round(rect.y * 100) / 100,
            width: Math.round(rect.width * 100) / 100,
            height: Math.round(rect.height * 100) / 100,
          },
          style: {
            display: style.display,
            position: style.position,
            color: style.color,
            backgroundColor: style.backgroundColor,
            backgroundImage: style.backgroundImage === 'none' ? null : style.backgroundImage,
            fontFamily: style.fontFamily,
            fontSize: style.fontSize,
            fontWeight: style.fontWeight,
            lineHeight: style.lineHeight,
            letterSpacing: style.letterSpacing,
            textAlign: style.textAlign,
            margin: [style.marginTop, style.marginRight, style.marginBottom, style.marginLeft],
            padding: [style.paddingTop, style.paddingRight, style.paddingBottom, style.paddingLeft],
            borderRadius: style.borderRadius,
          },
        };
      }
      return { viewport, result };
    },
    { descriptors: blocks.map(({ id, selector }) => ({ id, selector })), viewport: viewportId }
  );
}

async function captureScreenshot(page, outputRoot, relativePath, options) {
  const absolutePath = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, ...options });
  return { path: relativePath, captured: true, committed: false, ...(await hashFile(absolutePath)) };
}

async function capturePage({ browser, url, outputRoot, viewports, seedOrigin }) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: viewports[0].width, height: viewports[0].height },
    deviceScaleFactor: viewports[0].deviceScaleFactor,
  });
  const page = await context.newPage();
  await page.route('**/*', async (route) => {
    const request = route.request();
    if (request.isNavigationRequest() && new URL(request.url()).origin !== seedOrigin) {
      await route.abort('blockedbyclient');
      return;
    }
    await route.continue();
  });
  const pageId = stablePageId(url);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    if (!response) throw new Error('Navigation produced no HTTP response.');
    const status = response.status();
    if (status >= 400) throw new Error(`Navigation returned HTTP ${status}.`);
    const contentType = response.headers()['content-type'] ?? '';
    if (!contentType.includes('text/html'))
      throw new Error(`Expected text/html, received ${contentType || 'unknown'}.`);
    await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    // Page builders can replace hydration placeholders shortly after
    // network-idle. Capture only the settled DOM so every candidate selector
    // still names the block whose screenshots and styles we record.
    await page.waitForTimeout(1_000);

    const model = await extractPageModel(page);
    model.blocks.forEach((block, index) => {
      block.id = `${pageId}_block_${String(index + 1).padStart(3, '0')}`;
      block.boundingBoxes = {};
      block.computedStyles = {};
    });

    const pageScreenshots = [];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(250);
      const measured = await measureBlocks(page, model.blocks, viewport.id);
      for (const block of model.blocks) {
        const sample = measured.result[block.id];
        if (!sample) continue;
        block.boundingBoxes[viewport.id] = sample.box;
        block.computedStyles[viewport.id] = sample.style;
      }

      const fullRelative = `pages/${pageId}/${viewport.id}/full-page.png`;
      pageScreenshots.push({
        viewportId: viewport.id,
        kind: 'full-page',
        ...(await captureScreenshot(page, outputRoot, fullRelative, { fullPage: true })),
      });
      for (const block of model.blocks) {
        const relativePath = `pages/${pageId}/${viewport.id}/blocks/${block.id}.png`;
        try {
          const locator = page.locator(block.selector).first();
          block.screenshots.push({
            viewportId: viewport.id,
            kind: 'block',
            ...(await (async () => {
              const absolutePath = path.join(outputRoot, relativePath);
              await mkdir(path.dirname(absolutePath), { recursive: true });
              await locator.screenshot({ path: absolutePath, timeout: 10_000 });
              return { path: relativePath, captured: true, committed: false, ...(await hashFile(absolutePath)) };
            })()),
          });
        } catch (error) {
          block.screenshots.push({
            viewportId: viewport.id,
            kind: 'block',
            path: relativePath,
            captured: false,
            committed: false,
            error: String(error.message ?? error).slice(0, 500),
          });
        }
      }
    }

    const screenshotFailures = model.blocks.flatMap((block) =>
      block.screenshots
        .filter((screenshot) => !screenshot.captured)
        .map((screenshot) => ({
          blockId: block.id,
          viewportId: screenshot.viewportId,
          error: screenshot.error,
        }))
    );
    if (screenshotFailures.length > 0) {
      throw new Error(`Per-block screenshot validation failed: ${JSON.stringify(screenshotFailures).slice(0, 2_000)}`);
    }

    return {
      pageId,
      requestedUrl: url,
      url: page.url(),
      path: new URL(page.url()).pathname,
      status,
      capturedAt: new Date().toISOString(),
      ...model,
      screenshots: pageScreenshots,
    };
  } finally {
    await context.close();
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const seedUrl = normalizeCrawlUrl(args.url);
  if (!seedUrl) throw new Error('The seed URL must use HTTP or HTTPS.');
  const seed = new URL(seedUrl);
  const policy = validateCapturePolicy(JSON.parse(await readFile(path.resolve(args.policy), 'utf8')));
  if (!isUrlWithinPolicy(seedUrl, policy, seed.origin))
    throw new Error('Seed URL is outside the supplied capture policy.');

  const browserExecutable = await firstExisting([
    args['browser-executable'],
    process.env.CAPTURE_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]);
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
  const browser = await chromium.launch({ executablePath: browserExecutable, headless: true });
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
        const captured = await capturePage({
          browser,
          url,
          outputRoot,
          viewports: DEFAULT_VIEWPORTS,
          seedOrigin: seed.origin,
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
