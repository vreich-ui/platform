import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Keep this CLI directly runnable; theme.test.ts asserts these emitted values against the TS registry.
const THEME_COLOR_KEYS = [
  'primary',
  'secondary',
  'accent',
  'gold',
  'text-heading',
  'text-default',
  'text-muted',
  'bg-page',
  'bg-surface',
  'bg-page-dark',
];
const FALLBACK_COLORS = {
  primary: 'rgb(46 111 149)',
  secondary: 'rgb(37 90 120)',
  accent: 'rgb(94 140 138)',
  gold: 'rgb(194 168 120)',
  'text-heading': 'rgb(22 26 29)',
  'text-default': 'rgb(36 41 46)',
  'text-muted': 'rgb(58 65 73 / 76%)',
  'bg-page': 'rgb(252 251 248)',
  'bg-surface': 'rgb(247 245 240)',
  'bg-page-dark': 'rgb(3 6 32)',
};
const FALLBACK_FONTS = {
  sans: "'Inter Variable'",
  serif: "'Source Serif 4', Georgia, serif",
  heading: "'Playfair Display', 'Times New Roman', serif",
};

const TRANSPARENT = new Set(['transparent', 'rgba(0, 0, 0, 0)', 'rgba(0,0,0,0)']);
const cssColor = (value) =>
  value?.replace(/rgba?\(([^)]+)\)/, (_match, channels) => `rgb(${channels.replace(/,/g, ' ')})`) ?? null;
const nearest = (value, choices, fallback) =>
  choices.reduce(
    (best, choice) => (Math.abs(value - choice[0]) < Math.abs(value - best[0]) ? choice : best),
    fallback
  )[1];

function styles(snapshot) {
  return snapshot.pages.flatMap((page) => page.blocks.flatMap((block) => Object.values(block.computedStyles ?? {})));
}

function pick(values, fallback) {
  const counts = new Map();
  for (const value of values) if (value && !TRANSPARENT.has(value)) counts.set(value, (counts.get(value) ?? 0) + 1);
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best
    ? { value: cssColor(best[0]), confidence: Math.min(0.9, best[1] / Math.max(values.length, 1)), evidence: true }
    : { value: fallback, confidence: 0, evidence: false };
}
const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]
  );

/** Extract only bounded theme values; captured page content is never interpreted as instructions. */
export function extractTheme(snapshot, { name = 'Captured site theme' } = {}) {
  if (snapshot?.schemaVersion !== 'snapshot.v1' || !Array.isArray(snapshot.pages)) {
    throw new Error('Theme extractor input must be a snapshot.v1 document with pages.');
  }
  if ((snapshot.diagnostics?.quarantined?.length ?? 0) > 0) {
    throw new Error('Theme extractor refuses snapshots with quarantined pages.');
  }
  const samples = styles(snapshot);
  const text = pick(
    samples.map((s) => s.color),
    FALLBACK_COLORS['text-default']
  );
  const surface = pick(
    samples.map((s) => s.backgroundColor),
    FALLBACK_COLORS['bg-surface']
  );
  const colors = Object.fromEntries(
    THEME_COLOR_KEYS.map((key) => {
      const evidence = key === 'text-default' ? text : key === 'bg-surface' ? surface : null;
      return [key, evidence?.value ?? FALLBACK_COLORS[key]];
    })
  );
  const family = samples.map((s) => s.fontFamily).find(Boolean);
  const safeSans = family && /^[A-Za-z0-9,'" -]+$/.test(family) ? family : FALLBACK_FONTS.sans;
  const radius = Math.max(0, ...samples.map((s) => Number.parseFloat(s.borderRadius) || 0));
  const fontSize = Math.max(0, ...samples.map((s) => Number.parseFloat(s.fontSize) || 0));
  const weight = Math.max(0, ...samples.map((s) => Number.parseFloat(s.fontWeight) || 0));
  const widths = snapshot.pages.flatMap((page) =>
    page.blocks.map((block) => block.boundingBoxes?.desktop?.width).filter(Number.isFinite)
  );
  const padding = samples
    .flatMap((s) => s.padding ?? [])
    .map(Number.parseFloat)
    .filter(Number.isFinite);
  const axisEvidence = {
    containerWidth: widths.length > 0,
    sectionRhythm: padding.length > 0,
    radius: samples.some((s) => s.borderRadius),
    buttonShape: samples.some((s) => s.borderRadius),
    shadow: false,
    scale: samples.some((s) => s.fontSize),
    headingWeight: samples.some((s) => s.fontWeight),
  };
  const containerWidth = widths.length
    ? nearest(
        Math.max(...widths),
        [
          [896, 'narrow'],
          [1152, 'default'],
          [1280, 'wide'],
        ],
        [1152, 'default']
      )
    : 'default';
  const sectionRhythm = padding.length
    ? nearest(
        Math.max(...padding),
        [
          [40, 'compact'],
          [56, 'default'],
          [72, 'airy'],
        ],
        [56, 'default']
      )
    : 'default';
  const buttonShape = axisEvidence.buttonShape
    ? nearest(
        radius,
        [
          [6, 'rect'],
          [12, 'soft'],
          [999, 'pill'],
        ],
        [999, 'pill']
      )
    : 'pill';
  const tokens = {
    colors,
    fonts: { sans: safeSans, serif: FALLBACK_FONTS.serif, heading: FALLBACK_FONTS.heading },
    layout: { containerWidth, sectionRhythm },
    shape: {
      radius: nearest(
        radius,
        [
          [0, 'sharp'],
          [8, 'soft'],
          [16, 'round'],
          [24, 'pill'],
        ],
        [16, 'round']
      ),
      buttonShape,
      shadow: 'soft',
    },
    type: {
      scale: nearest(
        fontSize,
        [
          [16, 'compact'],
          [18, 'default'],
          [19, 'editorial'],
        ],
        [18, 'default']
      ),
      headingWeight: nearest(
        weight,
        [
          [400, 'regular'],
          [500, 'medium'],
          [700, 'bold'],
        ],
        [700, 'bold']
      ),
    },
  };
  const swatches = THEME_COLOR_KEYS.map((key) => {
    const sample = key === 'text-default' ? text : key === 'bg-surface' ? surface : null;
    return { key, value: colors[key], confidence: sample?.confidence ?? 0, fallback: !sample?.evidence };
  });
  const gaps = [
    ...swatches
      .filter((entry) => entry.fallback)
      .map((entry) => `No computed-style evidence for ${entry.key}; using fallback.`),
    family
      ? `Computed font stack inferred: ${family}. No font file is shipped from a snapshot.`
      : 'No computed font family evidence; no font file is shipped from a snapshot.',
    'Imagery style is intentionally not written to brandImagery; review separately.',
  ];
  return {
    body: {
      name,
      description: 'Bounded theme draft extracted from captured computed styles.',
      whenToUse: 'Use only for this captured site after human swatch review.',
      scope: 'one_off',
      tokens,
    },
    report: {
      swatches,
      gaps,
      axes: Object.fromEntries(
        Object.entries({ ...tokens.layout, ...tokens.shape, ...tokens.type }).map(([key, value]) => [
          key,
          { value, confidence: axisEvidence[key] ? 0.7 : 0, evidence: Boolean(axisEvidence[key]) },
        ])
      ),
    },
  };
}

export function renderThemeReport(extraction) {
  const rows = extraction.report.swatches
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.key)}</td><td><span style="display:inline-block;width:2rem;height:1rem;background:${escapeHtml(s.value)}"></span> ${escapeHtml(s.value)}</td><td>${s.confidence.toFixed(2)}</td><td>${s.fallback ? 'fallback' : 'evidence'}</td></tr>`
    )
    .join('');
  const axes = Object.entries(extraction.report.axes)
    .map(
      ([key, axis]) =>
        `<tr><td>${escapeHtml(key)}</td><td>${escapeHtml(axis.value)}</td><td>${axis.confidence.toFixed(2)}</td><td>${axis.evidence ? 'evidence' : 'default'}</td></tr>`
    )
    .join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Theme extraction report</title></head><body><h1>Theme extraction specimen</h1><table><thead><tr><th>Role</th><th>Swatch</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${rows}</tbody></table><h2>Typography specimen</h2><p style="font-family:${escapeHtml(extraction.body.tokens.fonts.sans)}">The quick brown fox jumps over the lazy dog.</p><h2>Quantized axes</h2><table><thead><tr><th>Axis</th><th>Value</th><th>Confidence</th><th>Source</th></tr></thead><tbody>${axes}</tbody></table><h2>Gaps</h2><ul>${extraction.report.gaps.map((gap) => `<li>${escapeHtml(gap)}</li>`).join('')}</ul></body></html>`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [input, outputDirectory] = process.argv.slice(2);
  if (!input || !outputDirectory) throw new Error('Usage: node theme.mjs <snapshot.json> <output-directory>');
  const extraction = extractTheme(JSON.parse(await readFile(input, 'utf8')));
  await mkdir(outputDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(outputDirectory, 'theme.v1.json'), `${JSON.stringify(extraction.body, null, 2)}\n`),
    writeFile(path.join(outputDirectory, 'theme-report.html'), renderThemeReport(extraction)),
  ]);
}
