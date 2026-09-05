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

import { GALLERY_MAX_ITEMS, GALLERY_MAX_TEXT_LENGTH, GALLERY_MIN_ITEMS, groupGalleryItems } from './gallery-items.mjs';
import { withTestTrafficHeaders } from './test-traffic-header.mjs';

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

// T14.2 FAULT 3 — the repeated-figure rule lives in `./gallery-items.mjs`, which imports NOTHING,
// so its judgement is testable in a tree with no node_modules (this file's first import is
// playwright). The DOM-walking shell stays here; every decision about what the walk finds is made
// there. Re-exported so `browser.mjs` remains the one name a caller needs to know for capture.
export { GALLERY_MAX_ITEMS, GALLERY_MAX_TEXT_LENGTH, GALLERY_MIN_ITEMS, groupGalleryItems };

export async function extractPageModel(page) {
  const model = await page.evaluate(() => {
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

    // ── T12.23 STRUCTURED BLOCK EXTRACTION ────────────────────────────────────
    //
    // Until now a block carried `textContent` and nothing else: one flat string with every list
    // bullet, table cell and pull-quote melted into it. That single line is why the mapper could
    // only ever produce 10 of the platform's 24 section types — `faq`, `stats`, `timeline`,
    // `steps`, `testimonial` and `comparison_table` are all SHAPES, and the shape was thrown away
    // at crawl time. Recovering them from flat text means regexing prose, which is exactly the
    // brittle guessing a deterministic-first pipeline exists to avoid.
    //
    // So the structure is captured where it still exists — in the DOM — and the mapper reads it
    // instead of inferring it. Purely ADDITIVE: `text` is unchanged, and a snapshot without this
    // key maps exactly as it does today.
    //
    // BOUNDED ON EVERY AXIS. A snapshot is stored, versioned and re-read; an unbounded structure
    // key on a 200-row pricing table would dwarf the page it describes. Counts and lengths are
    // capped here rather than downstream, because the cost is the bytes crossing the wire.
    const S_MAX_ITEMS = 24;
    const S_MAX_GROUPS = 6;
    const S_MAX_LEN = 400;
    /** Transport bound on the raw descriptors, above the item cap so the true count stays visible. */
    const S_MAX_GALLERY_NODES = 120;
    const sClip = (value) => clean(value).slice(0, S_MAX_LEN);

    /**
     * T14.2 FAULT 1/2 — an image's own pixel dimensions, where the DOM exposes them.
     *
     * `naturalWidth`/`naturalHeight` are the dimensions of the bytes the browser ACTUALLY decoded
     * (i.e. of `currentSrc`), which on a transform-in-path CDN is the thumbnail, not the original
     * — that is precisely the fact the mapper needs to notice a 146px asset heading for a 1440px
     * slot. `width`/`height` attributes are the author's declaration and are used only when the
     * image has not decoded. Absent both, null: an unknown intrinsic is reported as unknown rather
     * than assumed adequate, and no dimension is ever inferred from the layout box (that measures
     * the SLOT, which would make every stretched image look correct by construction).
     */
    const intrinsicOf = (image) => {
      const naturalWidth = Number(image.naturalWidth) || 0;
      const naturalHeight = Number(image.naturalHeight) || 0;
      if (naturalWidth > 0 && naturalHeight > 0)
        return { width: naturalWidth, height: naturalHeight, source: 'natural' };
      const attributeWidth = Number.parseInt(image.getAttribute('width') ?? '', 10);
      const attributeHeight = Number.parseInt(image.getAttribute('height') ?? '', 10);
      if (attributeWidth > 0 && attributeHeight > 0)
        return { width: attributeWidth, height: attributeHeight, source: 'attribute' };
      return null;
    };
    // Only the nearest enclosing block owns a node — otherwise a <section> wrapping an <article>
    // reports the same list twice and the mapper sees two candidates for one piece of content.
    const ownsNode = (element, node) => node.closest('section, article, [role="region"], main > *, body > header, body > nav, body > footer') === element;

    const extractStructure = (element) => {
      const structure = {};

      const lists = [...element.querySelectorAll('ul, ol')]
        .filter((list) => ownsNode(element, list) && !list.querySelector('ul, ol'))
        .slice(0, S_MAX_GROUPS)
        .map((list) => ({
          ordered: list.tagName.toLowerCase() === 'ol',
          items: [...list.querySelectorAll(':scope > li')]
            .slice(0, S_MAX_ITEMS)
            .map((li) => sClip(li.textContent))
            .filter(Boolean),
        }))
        .filter((list) => list.items.length > 0);
      if (lists.length) structure.lists = lists;

      const tables = [...element.querySelectorAll('table')]
        .filter((table) => ownsNode(element, table))
        .slice(0, S_MAX_GROUPS)
        .map((table) => {
          const rowNodes = [...table.querySelectorAll('tr')].slice(0, S_MAX_ITEMS);
          const cellsOf = (row) => [...row.querySelectorAll('th, td')].slice(0, S_MAX_ITEMS).map((cell) => sClip(cell.textContent));
          // A header row is one whose cells are <th>; absent that, no headers are claimed rather
          // than promoting the first data row and mislabelling every column.
          const headerRow = rowNodes.find((row) => row.querySelector('th'));
          const headers = headerRow ? cellsOf(headerRow) : [];
          const rows = rowNodes.filter((row) => row !== headerRow).map(cellsOf).filter((row) => row.some(Boolean));
          return { headers, rows };
        })
        .filter((table) => table.rows.length > 0);
      if (tables.length) structure.tables = tables;

      const quotes = [...element.querySelectorAll('blockquote, figure > q')]
        .filter((node) => ownsNode(element, node))
        .slice(0, S_MAX_ITEMS)
        .map((node) => {
          // <cite> and <figcaption> are the two standard attribution idioms; the quote text must
          // exclude the attribution or it reads back as part of what the person said.
          const citeNode = node.querySelector('cite') || node.parentElement?.querySelector('figcaption');
          const attribution = citeNode ? sClip(citeNode.textContent) : '';
          let quote = clean(node.textContent);
          if (attribution && quote.endsWith(attribution)) quote = clean(quote.slice(0, quote.length - attribution.length));
          return { quote: sClip(quote), ...(attribution ? { attribution } : {}) };
        })
        .filter((entry) => entry.quote);
      if (quotes.length) structure.quotes = quotes;

      // Two disclosure idioms, one shape: <details><summary> accordions and <dl><dt><dd> lists.
      const qa = [];
      for (const node of [...element.querySelectorAll('details')].filter((n) => ownsNode(element, n))) {
        const summary = node.querySelector('summary');
        if (!summary) continue;
        const question = sClip(summary.textContent);
        const answer = sClip(clean(node.textContent).replace(clean(summary.textContent), ''));
        if (question && answer) qa.push({ q: question, a: answer });
      }
      for (const list of [...element.querySelectorAll('dl')].filter((n) => ownsNode(element, n))) {
        const children = [...list.children];
        for (let i = 0; i < children.length - 1; i += 1) {
          if (children[i].tagName.toLowerCase() !== 'dt') continue;
          if (children[i + 1].tagName.toLowerCase() !== 'dd') continue;
          const question = sClip(children[i].textContent);
          const answer = sClip(children[i + 1].textContent);
          if (question && answer) qa.push({ q: question, a: answer });
        }
      }
      if (qa.length) structure.qa = qa.slice(0, S_MAX_ITEMS);

      // ── T14.2 FAULT 3: the gallery WALK ──────────────────────────────────────
      //
      // Deliberately thin. This finds each image's item container and reports a plain descriptor;
      // it decides nothing. `groupGalleryItems` (./gallery-items.mjs, which imports nothing) makes
      // every judgement about those descriptors, out of the page and under test — see it for why.
      const galleryImages = [...element.querySelectorAll('img')].filter((image) => ownsNode(element, image));
      // More than one image is simply what "repeated" means; the authoritative threshold is
      // `groupGalleryItems`' own `minItems`, which re-checks it. This only keeps the walk from
      // shipping descriptors for a lone picture on every page that has one.
      if (galleryImages.length > 1) {
        // The item container is the LARGEST subtree around an image that still holds only that one
        // image — for `<figure><img><figcaption>` it is the figure; for a builder's nested card
        // divs it is the outermost of them. Growing stops at the element that would swallow a
        // sibling's picture, which is the gallery container itself.
        const itemContainerOf = (image) => {
          let node = image;
          while (node.parentElement && node.parentElement !== element) {
            if (node.parentElement.querySelectorAll('img').length > 1) break;
            node = node.parentElement;
          }
          return node;
        };
        // A transport bound on the descriptors themselves, above the item cap so the true count is
        // still observable. Both keys are consumed and removed the moment the page hands them back.
        structure.galleryNodes = galleryImages.slice(0, S_MAX_GALLERY_NODES).map((image) => {
          const container = itemContainerOf(image);
          const figcaption = container.querySelector('figcaption');
          const anchor = container.matches('a[href]') ? container : container.querySelector('a[href]');
          const intrinsic = intrinsicOf(image);
          return {
            src: absolute(image.currentSrc || image.getAttribute('src')),
            alt: clean(image.getAttribute('alt')) || null,
            text: sClip(container.textContent),
            figcaption: figcaption ? sClip(figcaption.textContent) : null,
            href: anchor ? absolute(anchor.getAttribute('href')) : null,
            intrinsic,
            containerPath: selectorFor(container),
            parentPath: container.parentElement ? selectorFor(container.parentElement) : null,
          };
        });
        structure.gallerySourceCount = galleryImages.length;
      }

      return Object.keys(structure).length > 0 ? structure : undefined;
    };

    const blocks = candidates.map((element, index) => {
      const structure = extractStructure(element);
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
        ...(structure ? { structure } : {}),
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
      const intrinsic = intrinsicOf(image);
      addAsset(image.currentSrc || image.getAttribute('src'), 'image', image, {
        srcset: image.getAttribute('srcset'),
        // T14.2: carried on the ASSET, so the mapper can compare it to the slot the section will
        // render it into without re-deriving anything from the DOM it no longer has.
        ...(intrinsic ? { intrinsic } : {}),
      });
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
  // T14.2: the page hands back per-image descriptors; the grouping decision is made HERE, by a pure
  // function that never saw a DOM. The transient keys are consumed and removed, so what a snapshot
  // stores is the recovered gallery (or nothing) and never the raw walk.
  for (const block of model.blocks) {
    if (!block.structure?.galleryNodes) continue;
    const { galleryNodes, gallerySourceCount } = block.structure;
    delete block.structure.galleryNodes;
    delete block.structure.gallerySourceCount;
    const gallery = groupGalleryItems(galleryNodes, { sourceCount: gallerySourceCount });
    if (gallery) block.structure.gallery = gallery;
    if (Object.keys(block.structure).length === 0) delete block.structure;
  }
  return model;
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
  const context = await browser.newContext(
    // R7.3: mark this navigation's traffic (including the tracking loader's
    // own beacon, if the page carries one) as test traffic for the sink.
    withTestTrafficHeaders({
      ...(userAgent ? { userAgent } : {}),
      viewport: { width: viewports[0].width, height: viewports[0].height },
      deviceScaleFactor: viewports[0].deviceScaleFactor,
    })
  );
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
