import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const SNAPSHOT_SCHEMA_VERSION = 'snapshot.v1';

const requiredBoolean = (value, name) => {
  if (typeof value !== 'boolean') throw new Error(`${name} must be a boolean.`);
  return value;
};

const requiredString = (value, name) => {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string.`);
  return value;
};

export function normalizeOrigin(value) {
  const parsed = new URL(requiredString(value, 'origin'));
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error(`Unsupported crawl protocol: ${parsed.protocol}`);
  return parsed.origin;
}

export function validateCapturePolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Capture policy must be an object.');
  if (!Number.isSafeInteger(input.maxPages) || input.maxPages < 1) {
    throw new Error('capturePolicy.maxPages must be a positive safe integer.');
  }
  if (!Array.isArray(input.allowedCrawlOrigins) || input.allowedCrawlOrigins.length === 0) {
    throw new Error('capturePolicy.allowedCrawlOrigins must contain at least one origin.');
  }
  if (!Array.isArray(input.allowedPathPrefixes) || input.allowedPathPrefixes.length === 0) {
    throw new Error('capturePolicy.allowedPathPrefixes must contain at least one path prefix.');
  }
  if (!Number.isSafeInteger(input.concurrency) || input.concurrency < 1) {
    throw new Error('capturePolicy.concurrency must be a positive safe integer.');
  }
  if (!Number.isSafeInteger(input.delayMs) || input.delayMs < 0) {
    throw new Error('capturePolicy.delayMs must be a non-negative safe integer.');
  }

  const policy = {
    ...input,
    allowedCrawlOrigins: input.allowedCrawlOrigins.map(normalizeOrigin),
    allowedPathPrefixes: input.allowedPathPrefixes.map((prefix, index) => {
      requiredString(prefix, `capturePolicy.allowedPathPrefixes[${index}]`);
      if (!prefix.startsWith('/')) throw new Error(`Path prefix must start with "/": ${prefix}`);
      return prefix;
    }),
    sameOriginOnly: requiredBoolean(input.sameOriginOnly, 'capturePolicy.sameOriginOnly'),
    respectRobots: requiredBoolean(input.respectRobots, 'capturePolicy.respectRobots'),
  };

  // T12's spike is intentionally incapable of widening either boundary.
  if (!policy.sameOriginOnly) throw new Error('The capture spike requires sameOriginOnly=true.');
  if (!policy.respectRobots) throw new Error('The capture spike requires respectRobots=true.');
  if (policy.authenticatedAccess !== 'prohibited') {
    throw new Error('The capture spike requires authenticatedAccess="prohibited".');
  }

  return policy;
}

export function normalizeCrawlUrl(value) {
  const url = new URL(value);
  url.hash = '';
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  return url.href;
}

export function isLikelyHtmlPage(value) {
  const normalized = normalizeCrawlUrl(value);
  if (!normalized) return false;
  return !/\.(?:avif|bmp|css|csv|docx?|gif|ico|jpe?g|js|json|mp3|mp4|mpeg|pdf|png|pptx?|rar|svg|tiff?|txt|webm|webp|woff2?|xlsx?|xml|zip)$/i.test(
    new URL(normalized).pathname
  );
}

export function isUrlWithinPolicy(value, policy, seedOrigin) {
  const normalized = normalizeCrawlUrl(value);
  if (!normalized) return false;
  const url = new URL(normalized);
  if (policy.sameOriginOnly && url.origin !== seedOrigin) return false;
  if (!policy.allowedCrawlOrigins.includes(url.origin)) return false;
  return policy.allowedPathPrefixes.some((prefix) => url.pathname.startsWith(prefix));
}

export function stablePageId(value) {
  return `page_${createHash('sha256')
    .update(normalizeCrawlUrl(value) ?? value)
    .digest('hex')
    .slice(0, 12)}`;
}

export async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

const redact = (value) => (value ? `[redacted:${[...value].length} chars]` : value);

export function redactSnapshot(snapshot) {
  const result = structuredClone(snapshot);
  result.capture.redacted = true;
  result.capture.redaction = {
    text: 'replaced with length-preserving markers',
    screenshots: 'references retained; binary files omitted',
    assets: 'URL manifest retained; bytes never stored',
  };

  for (const page of result.pages) {
    page.title = redact(page.title);
    page.metaDescription = redact(page.metaDescription);
    for (const node of page.outline) node.text = redact(node.text);
    for (const item of [...page.navigation.primary, ...page.navigation.footer]) item.label = redact(item.label);
    for (const block of page.blocks) {
      block.text.value = redact(block.text.value);
      block.accessibleName = redact(block.accessibleName);
      for (const link of block.links) link.label = redact(link.label);
      for (const screenshot of block.screenshots) {
        delete screenshot.sha256;
        delete screenshot.byteLength;
        screenshot.committed = false;
      }
    }
    for (const asset of page.assets) {
      if ('alt' in asset) asset.alt = redact(asset.alt);
      if ('label' in asset) asset.label = redact(asset.label);
    }
    for (const screenshot of page.screenshots) {
      delete screenshot.sha256;
      delete screenshot.byteLength;
      screenshot.committed = false;
    }
  }

  return result;
}
