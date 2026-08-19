/**
 * The capture browser plane — ONE screenshot/extraction implementation (T12.10).
 *
 * Everything in this file was `capture.mjs`'s private middle: viewport
 * definitions, browser discovery, the DOM extraction (`extractPageModel`), the
 * per-viewport box/style measurement, the screenshot writers, and the settle
 * rules. It moved here unchanged so that the crawler is not the only thing that
 * can drive a browser: the draft-preview renderer (`preview.mjs`) screenshots
 * the EMITTED side with the same code at the same viewports, which is the only
 * way a source-versus-preview pixel comparison means anything.
 *
 * Lineage: this is the module pdf-tool's `render-service/src/capture.ts`
 * (T12.8) was ported from — same viewports, same settle delays, same block
 * screenshot contract. When either changes, both change; there is no third
 * extraction. pdf-tool's plane is https-and-DNS-only by design (SSRF guard), so
 * it cannot be pointed at a LOCAL preview build — that is why the local plane
 * exists here rather than being replaced by a service call.
 *
 * `capture.mjs` keeps everything this file deliberately does NOT know about:
 * robots, the capture policy, the crawl queue, redaction, the snapshot
 * envelope. This module navigates and measures; it decides nothing about what
 * may be visited.
 */
import { createHash } from 'node:crypto';
import { access, mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { chromium } from 'playwright-core';

/**
 * The capture viewports. Source and preview MUST be screenshotted at exactly
 * these sizes or a per-block diff is comparing two different layouts and the
 * score is noise (T12.10 brief). Any change here is a change to both planes.
 */
export const CAPTURE_VIEWPORTS = Object.freeze([
  Object.freeze({ id: 'mobile', width: 390, height: 844, deviceScaleFactor: 1 }),
  Object.freeze({ id: 'desktop', width: 1440, height: 1000, deviceScaleFactor: 1 }),
]);

export const NAVIGATION_TIMEOUT_MS = 45_000;
export const NETWORK_IDLE_TIMEOUT_MS = 8_000;
/** Page builders can replace hydration placeholders shortly after network-idle. */
export const SETTLE_DELAY_MS = 1_000;
export const VIEWPORT_SETTLE_DELAY_MS = 250;
export const BLOCK_SCREENSHOT_TIMEOUT_MS = 10_000;

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

/** Discovery only — never downloads or installs a browser. */
export async function resolveBrowserExecutable(explicitPath) {
  return firstExisting([
    explicitPath,
    process.env.CAPTURE_BROWSER_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ]);
}

export async function launchCaptureBrowser(explicitPath) {
  const executablePath = await resolveBrowserExecutable(explicitPath);
  const browser = await chromium.launch({ executablePath, headless: true });
  return { browser, executablePath };
}

export async function hashFile(filePath) {
  const bytes = await readFile(filePath);
  const info = await stat(filePath);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: info.size };
}

/**
 * Scroll the whole document once and return to the top.
 *
 * Reveal-on-scroll is everywhere (the site shell's own `intersect` directive,
 * and every page builder's equivalent): an IntersectionObserver only fires for
 * content the viewport has actually reached. A full-page screenshot captures
 * beyond the viewport WITHOUT scrolling, so below-the-fold content is
 * photographed mid-reveal — half-faded, and differently faded on each run.
 * Walking the page first settles those observers, which makes the full-page
 * evidence both readable and reproducible. Per-BLOCK screenshots never needed
 * this (Playwright scrolls the element into view before shooting it).
 *
 * Bounded: a fixed number of viewport-height steps, then back to the top.
 */
export async function settleLazyContent(page, { maxSteps = 40, stepDelayMs = 60 } = {}) {
  await page.evaluate(
    async ({ steps, delay }) => {
      const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const step = window.innerHeight;
      for (let offset = 0, taken = 0; offset < document.body.scrollHeight && taken < steps; offset += step) {
        window.scrollTo(0, offset);
        taken += 1;
        await wait(delay);
      }
      window.scrollTo(0, 0);
      await wait(delay);
    },
    { steps: maxSteps, delay: stepDelayMs }
  );
  // The reveal TRANSITION still has to finish after its observer fires; the
  // hydration settle delay is the same order of magnitude and is reused here.
  await page.waitForTimeout(SETTLE_DELAY_MS);
}

/** Full-page screenshot → the snapshot's `{path, captured, committed, sha256, byteLength}` shape. */
export async function screenshotFullPage(page, outputRoot, relativePath) {
  const absolutePath = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await page.screenshot({ path: absolutePath, fullPage: true });
  return { path: relativePath, captured: true, committed: false, ...(await hashFile(absolutePath)) };
}

/** Element screenshot → the same shape; the per-block evidence both planes emit. */
export async function screenshotElement(locator, outputRoot, relativePath) {
  const absolutePath = path.join(outputRoot, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await locator.screenshot({ path: absolutePath, timeout: BLOCK_SCREENSHOT_TIMEOUT_MS });
  return { path: relativePath, captured: true, committed: false, ...(await hashFile(absolutePath)) };
}

/** Navigate, wait for network idle, then let late hydration settle. */
export async function gotoSettled(page, url) {
  const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  if (!response) throw new Error('Navigation produced no HTTP response.');
  const status = response.status();
  if (status >= 400) throw new Error(`Navigation returned HTTP ${status}.`);
  const contentType = response.headers()['content-type'] ?? '';
  if (!contentType.includes('text/html')) throw new Error(`Expected text/html, received ${contentType || 'unknown'}.`);
  await page.waitForLoadState('networkidle', { timeout: NETWORK_IDLE_TIMEOUT_MS }).catch(() => {});
  await page.waitForTimeout(SETTLE_DELAY_MS);
  return status;
}

export async function extractPageModel(page) {
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
    // T12.17: a srcset candidate URL may itself contain commas — every Wix transform URL does
    // (`.../v1/fill/w_146,h_194,q_75,enc_avif,quality_auto/file.jpg 1x, ...`). Splitting the
    // attribute on ',' truncated each candidate to `.../v1/fill/w_146`, a prefix Wix answers with
    // HTTP 403, so emission's bounded asset probe refused the whole run. Parse per the HTML
    // srcset grammar instead: a candidate's URL is the leading non-whitespace run with trailing
    // commas stripped, and its descriptor runs to the next comma.
    const srcsetCandidates = (value) => {
      const text = String(value ?? '');
      const urls = [];
      let index = 0;
      while (index < text.length) {
        while (index < text.length && /[\s,]/.test(text[index])) index += 1;
        if (index >= text.length) break;
        const start = index;
        while (index < text.length && !/\s/.test(text[index])) index += 1;
        const raw = text.slice(start, index);
        const url = raw.replace(/,+$/, '');
        // A token that ended in a comma WAS the whole candidate (no descriptor); otherwise the
        // descriptor still has to be consumed before the next candidate begins.
        if (raw === url) while (index < text.length && text[index] !== ',') index += 1;
        if (url) urls.push(url);
      }
      return urls;
    };
    for (const source of document.querySelectorAll('source')) {
      addAsset(source.getAttribute('src'), 'media', source);
      const firstSrcset = srcsetCandidates(source.getAttribute('srcset'))[0];
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
      for (const match of background.matchAll(/url\(("'?)?([^"')]+)["']?\)/g))
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

export async function measureBlocks(page, blocks, viewportId) {
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

/**
 * Navigate one URL and produce the snapshot.v1 PAGE payload: outline, blocks
 * with per-viewport boxes/styles, full-page + per-block screenshots.
 *
 * `sameOriginNavigationOnly` is a navigation guard, not a policy: when an
 * origin is supplied, a navigation request that leaves it is aborted. The
 * crawler passes its seed origin; the local preview plane passes its own
 * server origin.
 */
export async function capturePageSnapshot({
  browser,
  url,
  outputRoot,
  viewports,
  pageId,
  sameOriginNavigationOnly,
  userAgent,
}) {
  const context = await browser.newContext({
    ...(userAgent ? { userAgent } : {}),
    viewport: { width: viewports[0].width, height: viewports[0].height },
    deviceScaleFactor: viewports[0].deviceScaleFactor,
  });
  const page = await context.newPage();
  if (sameOriginNavigationOnly) {
    await page.route('**/*', async (route) => {
      const request = route.request();
      if (request.isNavigationRequest() && new URL(request.url()).origin !== sameOriginNavigationOnly) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
  }
  try {
    const status = await gotoSettled(page, url);

    const model = await extractPageModel(page);
    model.blocks.forEach((block, index) => {
      block.id = `${pageId}_block_${String(index + 1).padStart(3, '0')}`;
      block.boundingBoxes = {};
      block.computedStyles = {};
    });

    const pageScreenshots = [];
    for (const viewport of viewports) {
      await page.setViewportSize({ width: viewport.width, height: viewport.height });
      await page.waitForTimeout(VIEWPORT_SETTLE_DELAY_MS);
      const measured = await measureBlocks(page, model.blocks, viewport.id);
      for (const block of model.blocks) {
        const sample = measured.result[block.id];
        if (!sample) continue;
        block.boundingBoxes[viewport.id] = sample.box;
        block.computedStyles[viewport.id] = sample.style;
      }

      await settleLazyContent(page);
      pageScreenshots.push({
        viewportId: viewport.id,
        kind: 'full-page',
        ...(await screenshotFullPage(page, outputRoot, `pages/${pageId}/${viewport.id}/full-page.png`)),
      });
      for (const block of model.blocks) {
        const relativePath = `pages/${pageId}/${viewport.id}/blocks/${block.id}.png`;
        try {
          const locator = page.locator(block.selector).first();
          block.screenshots.push({
            viewportId: viewport.id,
            kind: 'block',
            ...(await screenshotElement(locator, outputRoot, relativePath)),
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
        .map((screenshot) => ({ blockId: block.id, viewportId: screenshot.viewportId, error: screenshot.error }))
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
