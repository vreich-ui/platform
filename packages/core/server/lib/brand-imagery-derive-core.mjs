/**
 * W16 C1 follow-up: derive a brandImagery contract from a site's brandTokens
 * when the site has not declared one.
 *
 * The declared `site.brandImagery` block stays the source of truth and is
 * always preferred. But most sites in the fleet have only ever had their
 * palette set (via a theme, the one governed brandTokens writer), and there is
 * no agent-facing verb that writes brandImagery — so without a fallback those
 * sites generate images with no visual identity at all, and every hero reads
 * as if it came from a different brand than the page around it.
 *
 * This module closes that gap WITHOUT inventing a second authoring path. It is
 * a pure, deterministic function of already-governed state: brandTokens (whose
 * only writer is the auditable, revertible theme-apply funnel) plus the site
 * id. Nothing is stored, nothing is written, and a later declared brandImagery
 * silently supersedes it. Governance-wise this is NOT an agent authoring the
 * style half — no agent input reaches it; the derivation is a fixed mapping
 * from the site's own committed palette and design axes.
 *
 * Intent is "visibly fits alongside the site", not "matches the UI". The
 * derived contract carries the site's own hues so imagery sits comfortably next
 * to the page chrome, and leans on conservative, widely-safe choices
 * (illustration over photography, restrained palettes, no bold stylistic
 * gambles) because a fallback should be the safe middle. `photograph` and
 * `editorial_collage` are deliberate aesthetic decisions and are therefore
 * never auto-selected — a human declares those.
 *
 * WHY THIS HALF IS PLAIN JAVASCRIPT: the derivation is the one piece of this
 * module that CLI code has to reach — `packages/core/cli/visual-standard-
 * genesis.mjs` (and through it `create-site.mjs` and
 * `scripts/backfill-visual-standard.mjs`) runs as plain `.mjs` under bare
 * `node`, with no build step and no TypeScript loader. Node 20 (the floor this
 * repo's `engines` declares, and a leg of the CI build matrix) cannot load a
 * `.ts` module at all. So the derivation lives here, in JavaScript both trees
 * can simply `import`, with its types carried by JSDoc; the typed parsing and
 * validation half — and the canonical type exports — stay in
 * `brand-imagery-derive.ts`, which re-exports everything below so every
 * TypeScript importer keeps one unchanged entry point.
 */

/** @typedef {'photograph' | 'digital_illustration' | 'flat_vector' | 'editorial_collage'} ImageMedium */

/**
 * @typedef {object} BrandImageryComposition
 * @property {string} [subjectScale]
 * @property {string} [cropRule]
 * @property {string} [depthOfField]
 */

/**
 * @typedef {object} BrandImageryLora
 * @property {string} url
 * @property {number} [scale]
 * @property {string} [triggerPhrase]
 * @property {string} [version]
 * @property {string} [modelEndpoint]
 */

/**
 * @typedef {object} BrandImageryRecord
 * @property {1} version
 * @property {ImageMedium} medium
 * @property {string} styleSentence
 * @property {string[]} palette
 * @property {string[]} negative
 * @property {BrandImageryComposition} [composition]
 * @property {Record<string, string>} [aspectRatios]
 * @property {number} seedBase
 * @property {BrandImageryLora} [lora]
 */

/**
 * A tiny non-cryptographic string hash (FNV-1a, 32-bit). Deterministic and
 * free of Date.now()/Math.random(), so every derived value that uses it is
 * reproducible across runs and across deploys.
 *
 * @param {string} input
 * @returns {number}
 */
export const fnv1aHash = (input) => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
};

/**
 * @typedef {{ r: number, g: number, b: number }} Rgb
 * @typedef {{ h: number, s: number, l: number }} Hsl
 */

/**
 * Exported (rather than kept private) because the typed half in
 * `brand-imagery-derive.ts` builds its `getRecordValue` on the same predicate —
 * one implementation, not two that can drift apart.
 *
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
export const isRecord = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * @param {number} n
 * @returns {number}
 */
const clampChannel = (n) => Math.min(255, Math.max(0, Math.round(n)));

/**
 * Parses the CSS colour forms brandTokens actually carries. The safe-CSS
 * grammar that gates brandTokens values (constraint `brand_token_values`)
 * already rejects anything exotic, so this handles hex and rgb()/rgba() in
 * both the modern space-separated and legacy comma-separated syntaxes,
 * including a trailing `/ <alpha>` which is discarded (imagery palettes are
 * opaque). Anything else returns undefined and is simply skipped.
 *
 * @param {string} raw
 * @returns {Rgb | undefined}
 */
const parseCssColor = (raw) => {
  const value = raw.trim().toLowerCase();

  const hexMatch = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(value);
  if (hexMatch) {
    const hex = hexMatch[1];
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map((char) => char + char)
            .join('')
        : hex;
    return {
      r: parseInt(full.slice(0, 2), 16),
      g: parseInt(full.slice(2, 4), 16),
      b: parseInt(full.slice(4, 6), 16),
    };
  }

  const rgbMatch = /^rgba?\(([^)]+)\)$/.exec(value);
  if (!rgbMatch) return undefined;
  const channels = rgbMatch[1].split('/')[0];
  const parts = channels.split(/[\s,]+/).filter(Boolean);
  if (parts.length < 3) return undefined;
  const nums = parts.slice(0, 3).map((part) => {
    const numeric = Number.parseFloat(part);
    if (!Number.isFinite(numeric)) return Number.NaN;
    return part.endsWith('%') ? (numeric / 100) * 255 : numeric;
  });
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  return { r: clampChannel(nums[0]), g: clampChannel(nums[1]), b: clampChannel(nums[2]) };
};

/**
 * @param {Rgb} rgb
 * @returns {string}
 */
const toHex = ({ r, g, b }) =>
  `#${[r, g, b]
    .map((n) => n.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase()}`;

/**
 * @param {Rgb} rgb
 * @returns {Hsl}
 */
const toHsl = ({ r, g, b }) => {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const delta = max - min;
  if (delta === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  /** @type {number} */
  let h;
  if (max === rn) h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return { h: h * 60, s, l };
};

// Plain-language hue names. These land in the styleSentence, which is prose an
// image model reads — "terracotta" steers generation far better than "#CC785C"
// alone, so the sentence names the hue and the palette clause carries the exact
// values.
/** @type {ReadonlyArray<{ below: number, name: string }>} */
const HUE_NAMES = [
  { below: 12, name: 'red' },
  { below: 33, name: 'terracotta' },
  { below: 42, name: 'amber' },
  { below: 66, name: 'gold' },
  { below: 100, name: 'olive' },
  { below: 160, name: 'green' },
  { below: 200, name: 'teal' },
  { below: 250, name: 'blue' },
  { below: 290, name: 'indigo' },
  { below: 330, name: 'violet' },
  { below: 361, name: 'rose' },
];

/**
 * @param {number} h
 * @returns {string}
 */
const hueName = (h) => {
  const normalized = ((h % 360) + 360) % 360;
  return HUE_NAMES.find((entry) => normalized < entry.below)?.name ?? 'red';
};

const NEUTRAL_SATURATION = 0.12;

/**
 * @param {Hsl} hsl
 * @returns {boolean}
 */
const isNeutral = (hsl) => hsl.s < NEUTRAL_SATURATION;

// Ordered so the most identity-bearing colours survive the palette cap. Keys the
// site does not carry are skipped; keys outside this list are appended after.
/** @type {readonly string[]} */
const PALETTE_KEY_PRIORITY = [
  'primary',
  'accent',
  'gold',
  'secondary',
  'text-heading',
  'text-default',
  'text-muted',
  'bg-page',
  'bg-surface',
  'bg-page-dark',
];

const MAX_PALETTE = 8;

// Matches the site.v1 negative cap (max 12 entries, each <= 120 chars). A
// conservative baseline of failure modes that spoil an article image regardless
// of brand.
/** @type {readonly string[]} */
const BASELINE_NEGATIVE = [
  'text, lettering, watermarks, or UI chrome',
  'distorted hands and faces',
  'photorealistic stock-photo gloss',
  'corporate handshakes or boardroom cliches',
  'neon or oversaturated colors',
  'cluttered composition or busy backgrounds',
  'lens flare, bokeh, heavy vignetting',
  '3D renders and glossy plastic surfaces',
  'hard black outlines and drop shadows',
  'cyberpunk, sci-fi, or circuit-board motifs',
  'gradient mesh backgrounds',
  'muddy low-contrast rendering',
];

/** @type {BrandImageryComposition} */
const DEFAULT_COMPOSITION = {
  subjectScale: 'single clear subject occupying 50-60% of the frame',
  cropRule: 'generous margins; never crop the subject at the frame edge',
  depthOfField: 'flat even focus throughout; no simulated shallow depth',
};

// Keys match the `usageContext` values the image model routing policy already
// keys on, so the two policies line up. Values map onto render sizes pdf-tool
// supports: 3:2 -> 1536x1024, 1:1 -> 1024x1024, 7:4 -> 1792x1024.
/** @type {Record<string, string>} */
const DEFAULT_ASPECT_RATIOS = {
  article_header: '3:2',
  article_body: '1:1',
  category_page: '7:4',
  social_og: '3:2',
};

const STYLE_SENTENCE_MAX = 400;

/**
 * Trims to the schema's 400-char cap on a word boundary, keeping a full stop.
 *
 * @param {string} sentence
 * @returns {string}
 */
const capStyleSentence = (sentence) => {
  if (sentence.length <= STYLE_SENTENCE_MAX) return sentence;
  const clipped = sentence.slice(0, STYLE_SENTENCE_MAX - 1);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${(lastSpace > 0 ? clipped.slice(0, lastSpace) : clipped).replace(/[,;:\s]+$/, '')}.`;
};

/**
 * "sans-serif" contains "serif", so strip it before testing. Named families are
 * checked too because a stack may list only concrete faces.
 *
 * @param {string | undefined} heading
 * @returns {boolean}
 */
const headingIsSerif = (heading) => {
  if (!heading) return false;
  const cleaned = heading.toLowerCase().replace(/sans-serif/g, '');
  return /\bserif\b|georgia|palatino|garamond|times|iowan|didot|baskerville|caslon|minion|charter/.test(cleaned);
};

/** @typedef {{ key: string, hex: string, hsl: Hsl }} ParsedColor */

/**
 * @param {Record<string, unknown>} colors
 * @returns {ParsedColor[]}
 */
const parseTokenColors = (colors) => {
  const orderedKeys = [
    ...PALETTE_KEY_PRIORITY.filter((key) => key in colors),
    ...Object.keys(colors).filter((key) => !PALETTE_KEY_PRIORITY.includes(key)),
  ];
  /** @type {ParsedColor[]} */
  const parsed = [];
  for (const key of orderedKeys) {
    const raw = colors[key];
    if (typeof raw !== 'string') continue;
    const rgb = parseCssColor(raw);
    if (!rgb) continue;
    parsed.push({ key, hex: toHex(rgb), hsl: toHsl(rgb) });
  }
  return parsed;
};

/**
 * @param {ParsedColor | undefined} page
 * @returns {string}
 */
const describeGround = (page) => {
  if (!page) return 'clean neutral ground';
  if (page.hsl.l < 0.35) return 'deep near-black ground';
  if (page.hsl.s >= 0.04 && page.hsl.h >= 15 && page.hsl.h < 75) return 'soft warm cream ground';
  if (page.hsl.s >= 0.04) return `soft tinted ${hueName(page.hsl.h)} ground`;
  return 'clean off-white ground';
};

/**
 * @param {ParsedColor[]} accents
 * @returns {string}
 */
const describeAccents = (accents) => {
  /** @type {string[]} */
  const names = [];
  for (const accent of accents) {
    const name = hueName(accent.hsl.h);
    if (!names.includes(name)) names.push(name);
    if (names.length === 2) break;
  }
  if (names.length === 0) return 'a restrained monochrome range';
  const qualifier = accents[0].hsl.s >= 0.6 ? 'confident' : 'restrained';
  return names.length === 1
    ? `${qualifier} ${names[0]} accents`
    : `${qualifier} ${names[0]} and muted ${names[1]} accents`;
};

/**
 * Derives a valid brandImagery contract from a site body's brandTokens.
 *
 * Returns undefined when the body carries no parseable colours — with nothing
 * to derive from, the caller falls back to today's behaviour (agent prompt
 * forwarded verbatim) rather than inventing an identity out of thin air.
 *
 * @param {Record<string, unknown> | undefined} body
 * @param {string} siteId
 * @returns {BrandImageryRecord | undefined}
 */
export const deriveBrandImageryFromTokens = (body, siteId) => {
  const tokens = isRecord(body?.brandTokens) ? body.brandTokens : undefined;
  if (!tokens) return undefined;
  const colors = isRecord(tokens.colors) ? tokens.colors : undefined;
  if (!colors) return undefined;

  const parsed = parseTokenColors(colors);
  if (parsed.length === 0) return undefined;

  const byKey = new Map(parsed.map((entry) => [entry.key, entry]));
  const chromatic = parsed.filter((entry) => !isNeutral(entry.hsl));

  // Accent selection: the declared brand colours first, then any other
  // chromatic token, so a site using non-standard key names still reads.
  const accentOrder = ['primary', 'accent', 'gold', 'secondary'];
  /** @type {ParsedColor[]} */
  const accents = [];
  for (const key of accentOrder) {
    const entry = byKey.get(key);
    if (entry && !isNeutral(entry.hsl) && !accents.some((a) => a.hex === entry.hex)) accents.push(entry);
  }
  for (const entry of chromatic) {
    if (!accents.some((a) => a.hex === entry.hex)) accents.push(entry);
    if (accents.length >= 3) break;
  }

  const page = byKey.get('bg-page') ?? byKey.get('bg-surface');
  const fonts = isRecord(tokens.fonts) ? tokens.fonts : undefined;
  const heading = typeof fonts?.heading === 'string' ? fonts.heading : undefined;
  const shape = isRecord(tokens.shape) ? tokens.shape : undefined;
  const layout = isRecord(tokens.layout) ? tokens.layout : undefined;
  const type = isRecord(tokens.type) ? tokens.type : undefined;

  // Only two media are ever auto-selected. `photograph` and `editorial_collage`
  // are strong aesthetic commitments and stay human-declared.
  /** @type {ImageMedium} */
  const medium = shape?.radius === 'sharp' && !headingIsSerif(heading) ? 'flat_vector' : 'digital_illustration';

  const warmth = accents[0]
    ? accents[0].hsl.h < 75 || accents[0].hsl.h >= 330
      ? 'Warm'
      : accents[0].hsl.h >= 160 && accents[0].hsl.h < 290
        ? 'Cool'
        : 'Fresh'
    : 'Quiet';

  const mediumPhrase =
    medium === 'flat_vector' ? `${warmth} flat vector illustration` : `${warmth} editorial digital illustration`;
  const texturePhrase =
    shape?.radius === 'sharp'
      ? 'crisp geometric shapes with clean straight edges'
      : 'matte textured shapes with softly rounded forms';
  const spacePhrase =
    layout?.sectionRhythm === 'airy'
      ? 'generous negative space'
      : layout?.sectionRhythm === 'compact'
        ? 'tight economical framing'
        : 'balanced negative space';
  const moodPhrase =
    type?.scale === 'editorial'
      ? 'calm, considered, print-magazine feel'
      : type?.scale === 'compact'
        ? 'crisp, utilitarian feel'
        : 'clear, modern editorial feel';

  const styleSentence = capStyleSentence(
    `${mediumPhrase} on a ${describeGround(page)}, built around ${describeAccents(accents)}; ` +
      `${texturePhrase}, ${spacePhrase}, soft diffuse light and no harsh shadows; ` +
      `${moodPhrase} with a deliberately limited palette.`
  );

  /** @type {string[]} */
  const palette = [];
  for (const entry of [...accents, ...parsed]) {
    if (!palette.includes(entry.hex)) palette.push(entry.hex);
    if (palette.length === MAX_PALETTE) break;
  }

  return {
    version: 1,
    medium,
    styleSentence,
    palette,
    negative: [...BASELINE_NEGATIVE],
    composition: { ...DEFAULT_COMPOSITION },
    aspectRatios: { ...DEFAULT_ASPECT_RATIOS },
    // Stable per site and free of wall-clock/random input: the same site always
    // derives the same base, so image seeds stay reproducible across deploys.
    seedBase: fnv1aHash(`brandImagery:${siteId}`),
  };
};
