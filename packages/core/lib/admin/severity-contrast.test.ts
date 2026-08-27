/**
 * D4 contrast gate (T6.1) — WCAG AA over the real `--adm-*` severity tokens,
 * not a one-time audit.
 *
 * This reads `admin-tokens.css` off disk and parses the `:root` (light) and
 * `.dark` (dark) custom-property blocks itself, rather than hand-copying the
 * hex/rgba values into this file a second time — a token edited in the CSS
 * without updating a second, silently-drifting copy here is exactly the kind
 * of regression this test exists to catch. No color library: sRGB →
 * relative luminance → contrast ratio is implemented below, arithmetic only
 * (no new dependency), and unit-tested against W3C's own worked examples so
 * the maths itself is trustworthy before it's pointed at real tokens.
 *
 * What gets checked, per family (info/success/warning/danger) and per theme
 * (light/dark):
 *   - `<family>-text` on `<family>-soft` — the badge/pill/count-pill text —
 *     against the WCAG AA **4.5:1** normal-text floor (`severity.tsx`'s
 *     `PILL_TONE`, `primitives.tsx`'s `TONE_SOFT`, `approval.tsx` cause line).
 *   - the level's `<SeverityIcon>` tint (solid for info/success/danger,
 *     `-text` for warning — `severity.tsx`'s own `ICON_TONE`, "solid amber
 *     reads too light") against `--adm-surface-raised` (the level rendered
 *     directly on a card, e.g. `EmptyState`, `RequestActivity`'s glyphs) and
 *     against its own `<family>-soft` (the level rendered inside its icon
 *     chip, e.g. `ApprovalCard`) — both against the AA **3:1** floor for
 *     non-text/UI/graphical-object color (WCAG 2.1 SC 1.4.11).
 *
 * `-soft` tokens are `rgba(...)` with an alpha channel in the dark theme
 * (translucent tints over the surface behind them, not solid colors) — this
 * test alpha-composites them onto `--adm-surface-raised` before computing a
 * ratio, matching how they actually render (a badge/chip sitting on a card).
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

// ─── locate + parse admin-tokens.css ────────────────────────────────────────

// The compiled test runs from a temp dir (see package.json's `test` script);
// ascend to the repo root to read the real, committed token file — same
// pattern `site-identity.test.ts` uses for the same reason.
const findTokensCss = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 12; i += 1) {
    const candidate = join(dir, 'packages', 'core', 'app', 'styles', 'admin-tokens.css');
    if (existsSync(candidate)) return candidate;
    dir = dirname(dir);
  }
  throw new Error('could not locate packages/core/app/styles/admin-tokens.css');
};

type TokenMap = Record<string, string>;

/** Pulls every `--adm-<name>: <value>;` declaration out of one `{ ... }` block. */
function parseDeclarations(block: string): TokenMap {
  const tokens: TokenMap = {};
  const re = /--adm-([\w-]+)\s*:\s*([^;]+);/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(block))) {
    tokens[match[1]] = match[2].trim();
  }
  return tokens;
}

/** Splits admin-tokens.css into its `:root` (light) and `.dark` (dark) declaration blocks. */
function parseThemes(css: string): { light: TokenMap; dark: TokenMap } {
  const rootMatch = css.match(/:root\s*\{([^}]*)\}/);
  const darkMatch = css.match(/\.dark\s*\{([^}]*)\}/);
  if (!rootMatch || !darkMatch) throw new Error('admin-tokens.css: could not find :root and .dark blocks');
  const light = parseDeclarations(rootMatch[1]);
  // `.dark` only OVERRIDES a subset of tokens (e.g. `--adm-success-text` is
  // redefined, but a token with no dark-specific rule keeps its `:root`
  // value via cascade) — so dark is the light table with the overrides
  // layered on top, exactly like the browser resolves it.
  const dark = { ...light, ...parseDeclarations(darkMatch[1]) };
  return { light, dark };
}

const TOKENS_CSS = readFileSync(findTokensCss(), 'utf8');
const THEMES = parseThemes(TOKENS_CSS);

// ─── sRGB → relative luminance → WCAG contrast ratio ────────────────────────

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parses `#rgb`, `#rrggbb`, or `rgba(r, g, b, a)` into 0-255 channels + alpha (default 1). */
function parseColor(raw: string): Rgb & { a: number } {
  const value = raw.trim();
  const hexMatch = value.match(/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/);
  if (hexMatch) {
    let hex = hexMatch[1];
    if (hex.length === 3)
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    const num = parseInt(hex, 16);
    return { r: (num >> 16) & 255, g: (num >> 8) & 255, b: num & 255, a: 1 };
  }
  const rgbaMatch = value.match(/^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  if (rgbaMatch) {
    return {
      r: Number(rgbaMatch[1]),
      g: Number(rgbaMatch[2]),
      b: Number(rgbaMatch[3]),
      a: rgbaMatch[4] === undefined ? 1 : Number(rgbaMatch[4]),
    };
  }
  throw new Error(`severity-contrast.test: cannot parse color literal "${raw}" — admin-tokens.css's severity family
    tokens are expected to be plain #hex or rgba(), not var()/color-mix() (those are for the accent/ring tokens,
    outside this test's scope). Update the parser if that changes.`);
}

/** Alpha-composites `fg` (a translucent token, e.g. a dark-theme `-soft`) over an opaque `bg`. */
function compositeOver(fg: Rgb & { a: number }, bg: Rgb): Rgb {
  if (fg.a >= 1) return { r: fg.r, g: fg.g, b: fg.b };
  return {
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
  };
}

/** WCAG's sRGB → linear-light transfer function, applied per channel (0-255 in, 0-1 out). */
function srgbChannelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance, https://www.w3.org/TR/WCAG21/#dfn-relative-luminance */
function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * srgbChannelToLinear(r) + 0.7152 * srgbChannelToLinear(g) + 0.0722 * srgbChannelToLinear(b);
}

/** WCAG contrast ratio, https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio — always ≥ 1, order-independent. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const l1 = relativeLuminance(a);
  const l2 = relativeLuminance(b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Resolves a token's rendered color for a given theme, compositing translucent tokens over `--adm-surface-raised`. */
function resolveToken(theme: TokenMap, name: string): Rgb {
  const raw = theme[name];
  if (!raw) throw new Error(`severity-contrast.test: theme has no --adm-${name}`);
  const parsed = parseColor(raw);
  if (parsed.a >= 1) return parsed;
  const surface = parseColor(theme['surface-raised']);
  return compositeOver(parsed, surface);
}

// ─── the math itself, checked against W3C's published worked examples ──────
// (https://www.w3.org/TR/WCAG21/#dfn-contrast-ratio, and the well-known
// black-on-white / white-on-black identities) before trusting it on tokens.

describe('contrast ratio math', () => {
  it('is 21:1 for black on white (and white on black — order-independent)', () => {
    const black: Rgb = { r: 0, g: 0, b: 0 };
    const white: Rgb = { r: 255, g: 255, b: 255 };
    assert.ok(Math.abs(contrastRatio(black, white) - 21) < 0.01);
    assert.ok(Math.abs(contrastRatio(white, black) - 21) < 0.01);
  });

  it('is 1:1 for a color against itself', () => {
    const c: Rgb = { r: 37, g: 99, b: 235 };
    assert.ok(Math.abs(contrastRatio(c, c) - 1) < 1e-9);
  });

  it('matches the W3C worked example: #767676 on white is ~4.54:1 (the historical AA gray-on-white boundary)', () => {
    const gray: Rgb = { r: 0x76, g: 0x76, b: 0x76 };
    const white: Rgb = { r: 255, g: 255, b: 255 };
    const ratio = contrastRatio(gray, white);
    assert.ok(ratio > 4.5 && ratio < 4.6, `expected ~4.54, got ${ratio}`);
  });

  it('alpha-composites a translucent color over its backdrop before comparing', () => {
    // 50% white over black should land at mid-gray (~#808080), roughly the
    // same luminance either way you compute it.
    const half = compositeOver({ r: 255, g: 255, b: 255, a: 0.5 }, { r: 0, g: 0, b: 0 });
    assert.ok(Math.abs(half.r - 127.5) < 0.01);
  });
});

// ─── the actual D4 token pairs, both themes ─────────────────────────────────

const FAMILIES = ['info', 'success', 'warning', 'danger'] as const;
type Family = (typeof FAMILIES)[number];

/** Mirrors `severity.tsx`'s `ICON_TONE` exactly — warning is the one family whose
 * icon uses the darker `-text` token instead of the family's solid color. */
const ICON_TOKEN: Record<Family, string> = {
  info: 'info',
  success: 'success',
  warning: 'warning-text',
  danger: 'danger',
};

const AA_TEXT = 4.5;
const AA_NON_TEXT = 3.0;

for (const themeName of ['light', 'dark'] as const) {
  const theme = THEMES[themeName];

  describe(`D4 severity tokens — ${themeName} theme`, () => {
    for (const family of FAMILIES) {
      it(`${family}: "-text" on "-soft" clears the AA 4.5:1 text floor (badges, pills, count pills)`, () => {
        const fg = resolveToken(theme, `${family}-text`);
        const bg = resolveToken(theme, `${family}-soft`);
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= AA_TEXT,
          `--adm-${family}-text on --adm-${family}-soft (${themeName}) is only ${ratio.toFixed(2)}:1, need ${AA_TEXT}:1`
        );
      });

      it(`${family}: <SeverityIcon> on --adm-surface-raised clears the AA 3:1 non-text floor`, () => {
        const fg = resolveToken(theme, ICON_TOKEN[family]);
        const bg = resolveToken(theme, 'surface-raised');
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= AA_NON_TEXT,
          `--adm-${ICON_TOKEN[family]} on --adm-surface-raised (${themeName}) is only ${ratio.toFixed(2)}:1, need ${AA_NON_TEXT}:1`
        );
      });

      it(`${family}: <SeverityIcon> inside its own icon chip ("-soft" background) clears the AA 3:1 floor`, () => {
        const fg = resolveToken(theme, ICON_TOKEN[family]);
        const bg = resolveToken(theme, `${family}-soft`);
        const ratio = contrastRatio(fg, bg);
        assert.ok(
          ratio >= AA_NON_TEXT,
          `--adm-${ICON_TOKEN[family]} on --adm-${family}-soft chip (${themeName}) is only ${ratio.toFixed(2)}:1, need ${AA_NON_TEXT}:1`
        );
      });
    }
  });
}
