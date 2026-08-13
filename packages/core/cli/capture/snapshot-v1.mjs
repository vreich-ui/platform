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

/**
 * The ONE capture policy shape (T12.7).
 *
 * `ProjectCapturePolicy` in the CMS-Agent project registry is canonical: the
 * engine is a consumer of it, not the author of a second dialect. Everything
 * below mirrors that type and its `capturePolicySchema` field-for-field and
 * bound-for-bound, so a policy the registry accepts is a policy this engine
 * accepts, and a policy this engine accepts is one the registry would too.
 * Nothing here may be relaxed to make a run pass — the registry's deny-all
 * default (`maxPages: 0`) is the floor a project has to explicitly raise.
 */
const CONTENT_RIGHTS = ['prohibited', 'retain_allowed_origin_content'];
const MEDIA_RIGHTS = ['prohibited', 'retain_referenced_allowed_origin_media'];
const FIDELITY_MODES = ['source_faithful', 'design_inspired'];
const SOURCE_DESIGN_TREATMENTS = ['source_content_and_design', 'source_content_with_design_inspiration_only'];
const CAPTURE_POLICY_KEYS = [
  'maxPages',
  'allowedCrawlOrigins',
  'allowedPathPrefixes',
  'sameOriginOnly',
  'respectRobots',
  'concurrency',
  'delayMs',
  'authenticatedAccess',
  'rights',
  'designReferences',
  'fidelity',
];

const requiredObject = (value, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object.`);
  return value;
};

const strictObject = (value, name, allowedKeys) => {
  requiredObject(value, name);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.includes(key)) throw new Error(`${name} has unknown field ${key}.`);
  }
  return value;
};

const enumValue = (value, name, allowed) => {
  if (!allowed.includes(value)) throw new Error(`${name} must be one of ${allowed.join(', ')}.`);
  return value;
};

const boundedInteger = (value, name, { min, max }) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a safe integer between ${min} and ${max}.`);
  }
  return value;
};

const boundedArray = (value, name, max) => {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array.`);
  if (value.length > max) throw new Error(`${name} may not exceed ${max} entries.`);
  return value;
};

/** An HTTPS origin with no path, query, or fragment — the registry's `httpsOriginSchema`. */
export function normalizeOrigin(value, name = 'origin') {
  const parsed = new URL(requiredString(value, name));
  if (parsed.protocol !== 'https:') throw new Error(`${name} must be an HTTPS origin: ${value}`);
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error(`${name} must have no path, query, or fragment: ${value}`);
  }
  return parsed.origin;
}

function parsePathPrefix(value, name) {
  requiredString(value, name);
  if (!/^\/(?!\/)[^?#]*$/.test(value)) {
    throw new Error(`${name} must be an absolute path prefix without query or fragment: ${value}`);
  }
  return value;
}

export function parseCaptureRights(input) {
  const rights = strictObject(input, 'capturePolicy.rights', ['content', 'media']);
  return {
    content: enumValue(rights.content, 'capturePolicy.rights.content', CONTENT_RIGHTS),
    media: enumValue(rights.media, 'capturePolicy.rights.media', MEDIA_RIGHTS),
  };
}

function parseDesignReferences(input) {
  const references = boundedArray(input, 'capturePolicy.designReferences', 32);
  return references.map((reference, index) => {
    const name = `capturePolicy.designReferences[${index}]`;
    strictObject(reference, name, ['origin', 'purpose', 'crawlAllowed', 'contentReuse', 'mediaReuse']);
    // A design reference is inspiration only: it is never crawled and neither
    // its content nor its media may be reused. These are literals, not enums.
    if (reference.purpose !== 'design_inspiration_only')
      throw new Error(`${name}.purpose must be "design_inspiration_only".`);
    if (reference.crawlAllowed !== false) throw new Error(`${name}.crawlAllowed must be false.`);
    if (reference.contentReuse !== 'prohibited') throw new Error(`${name}.contentReuse must be "prohibited".`);
    if (reference.mediaReuse !== 'prohibited') throw new Error(`${name}.mediaReuse must be "prohibited".`);
    return {
      origin: normalizeOrigin(reference.origin, `${name}.origin`),
      purpose: reference.purpose,
      crawlAllowed: reference.crawlAllowed,
      contentReuse: reference.contentReuse,
      mediaReuse: reference.mediaReuse,
    };
  });
}

/** Omitted means the pipeline's global coverage rubric applies. */
export function parseCoverageRubricOverride(input, name = 'capturePolicy.fidelity.coverageRubricOverride') {
  if (input === undefined) return undefined;
  strictObject(input, name, ['minimumMappedBlockCoverage', 'requireCompleteTokens', 'requireEnumeratedGaps']);
  const coverage = input.minimumMappedBlockCoverage;
  if (!Number.isFinite(coverage) || coverage < 0 || coverage > 1)
    throw new Error(`${name}.minimumMappedBlockCoverage must be in [0, 1].`);
  return {
    minimumMappedBlockCoverage: coverage,
    requireCompleteTokens: requiredBoolean(input.requireCompleteTokens, `${name}.requireCompleteTokens`),
    requireEnumeratedGaps: requiredBoolean(input.requireEnumeratedGaps, `${name}.requireEnumeratedGaps`),
  };
}

function parseFidelity(input) {
  const fidelity = strictObject(input, 'capturePolicy.fidelity', [
    'mode',
    'sourceDesignTreatment',
    'coverageRubricOverride',
  ]);
  const override = parseCoverageRubricOverride(fidelity.coverageRubricOverride);
  return {
    mode: enumValue(fidelity.mode, 'capturePolicy.fidelity.mode', FIDELITY_MODES),
    sourceDesignTreatment: enumValue(
      fidelity.sourceDesignTreatment,
      'capturePolicy.fidelity.sourceDesignTreatment',
      SOURCE_DESIGN_TREATMENTS
    ),
    ...(override ? { coverageRubricOverride: override } : {}),
  };
}

/**
 * Validate a `ProjectCapturePolicy` and return it normalized. This is the
 * shape gate only: `maxPages: 0` (the registry's deny-all default) is a
 * well-formed policy that simply authorizes no crawl, which
 * `validateCapturePolicy` is what refuses.
 */
export function parseCapturePolicy(input) {
  strictObject(input, 'capturePolicy', CAPTURE_POLICY_KEYS);
  return {
    maxPages: boundedInteger(input.maxPages, 'capturePolicy.maxPages', { min: 0, max: Number.MAX_SAFE_INTEGER }),
    allowedCrawlOrigins: boundedArray(input.allowedCrawlOrigins, 'capturePolicy.allowedCrawlOrigins', 32).map(
      (origin, index) => normalizeOrigin(origin, `capturePolicy.allowedCrawlOrigins[${index}]`)
    ),
    allowedPathPrefixes: boundedArray(input.allowedPathPrefixes, 'capturePolicy.allowedPathPrefixes', 128).map(
      (prefix, index) => parsePathPrefix(prefix, `capturePolicy.allowedPathPrefixes[${index}]`)
    ),
    sameOriginOnly: requiredBoolean(input.sameOriginOnly, 'capturePolicy.sameOriginOnly'),
    respectRobots: requiredBoolean(input.respectRobots, 'capturePolicy.respectRobots'),
    concurrency: boundedInteger(input.concurrency, 'capturePolicy.concurrency', { min: 1, max: 32 }),
    delayMs: boundedInteger(input.delayMs, 'capturePolicy.delayMs', { min: 0, max: 86_400_000 }),
    authenticatedAccess: enumValue(input.authenticatedAccess, 'capturePolicy.authenticatedAccess', ['prohibited']),
    rights: parseCaptureRights(input.rights),
    designReferences: parseDesignReferences(input.designReferences),
    fidelity: parseFidelity(input.fidelity),
  };
}

/**
 * Resolve the capture policy out of a project response. The CMS-Agent
 * `ProjectSummary` carries it as `capturePolicy`; `capture_policy` is accepted
 * because a snake_case MCP envelope costs nothing to keep reading. Returns
 * null when the response declares none — callers decide how to fail closed.
 */
export function readProjectCapturePolicy(result) {
  const value = result?.data ?? result?.structuredContent?.data ?? result?.structuredContent ?? result;
  const project = value?.project ?? value;
  const policy = project?.capturePolicy ?? project?.capture_policy ?? null;
  return policy && typeof policy === 'object' && !Array.isArray(policy) ? policy : null;
}

/** The crawl gate: a shape-valid policy that additionally authorizes a run. */
export function validateCapturePolicy(input) {
  const policy = parseCapturePolicy(input);
  if (policy.maxPages < 1) {
    throw new Error('capturePolicy.maxPages is 0: this project denies all capture (the registry default).');
  }
  if (policy.allowedCrawlOrigins.length === 0) {
    throw new Error('capturePolicy.allowedCrawlOrigins must contain at least one origin.');
  }
  if (policy.allowedPathPrefixes.length === 0) {
    throw new Error('capturePolicy.allowedPathPrefixes must contain at least one path prefix.');
  }

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
