/**
 * Brand-token key registry + CSS-value safety (W8.3, 09-template-system-plan
 * §6.3) — the ONE source of truth for which token keys the renderer consumes
 * and which values are safe to interpolate.
 *
 * CustomStyles.astro emits exactly these custom properties, interpolating the
 * token VALUES raw into an inline <style> block — which makes token values an
 * injection/breakage surface: a value carrying `;`, `}` or `url(` could break
 * or extend the site's CSS from content. Validation (checkTheme + the site
 * structural check) and the renderer both read THIS module, so the enforced
 * key list and the emitted key list cannot drift, and no unsafe value reaches
 * the style tag through `set_theme_fields` (theme bodies) OR `set_site_brand_tokens` (the site palette writer emitted by site_apply_theme).
 *
 * Client-safe (no server imports): the Netlify function bundle and the .astro
 * renderer both import it.
 */

/** The light-block color keys CustomStyles emits (`--aw-color-<key>`). */
export const THEME_COLOR_KEYS = [
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
] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/**
 * The `.dark`-block override keys (`dark:<key>`). Every light key except
 * `bg-page-dark` (which IS the dark page color, emitted in the light block).
 * All optional: a missing dark key falls back to the light value.
 */
export const THEME_DARK_COLOR_KEYS = THEME_COLOR_KEYS.filter((key) => key !== 'bg-page-dark').map(
  (key) => `dark:${key}` as const
);

/**
 * The font-stack keys (`--aw-font-<key>`). `sans`/`serif`/`heading` are
 * required by the zod shape; `mono` (added for code/typewriter display) is
 * OPTIONAL there — an absent value falls back to `FALLBACK_FONTS.mono`,
 * which is the exact stack Tailwind's own preflight already assigns
 * `code`/`kbd`/`samp`/`pre`, so a theme that never sets it renders
 * byte-identically to today.
 */
export const THEME_FONT_KEYS = ['sans', 'serif', 'heading', 'mono'] as const;
export type ThemeFontKey = (typeof THEME_FONT_KEYS)[number];

/**
 * The pre-conversion literals — the values CustomStyles falls back to when
 * the site export is absent (W4) or a key is missing. Moved here verbatim
 * from CustomStyles.astro (byte-identity is the gate; the odd comma form in
 * `dark:text-heading` is the current literal — do not "fix" it).
 */
export const FALLBACK_COLORS: Record<string, string> = {
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
  'dark:text-heading': 'rgb(247, 248, 248)',
  'dark:text-default': 'rgb(229 236 246)',
  'dark:text-muted': 'rgb(229 236 246 / 66%)',
  'dark:bg-page': 'rgb(3 6 32)',
  'dark:bg-surface': 'rgb(19 24 46)',
};

export const FALLBACK_FONTS: Record<string, string> = {
  sans: "'Inter Variable'",
  serif: "'Source Serif 4', Georgia, serif",
  heading: "'Playfair Display', 'Times New Roman', serif",
  // Tailwind's own Preflight stack for code/kbd/samp/pre (v3 base reset) —
  // reused verbatim so an unset `mono` token renders byte-identically to the
  // browser/Tailwind default that already applies today.
  mono: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
};

// ─── Layer scale (W1 T1.2) ───────────────────────────────────────────────────
//
// One ordering for everything that stacks, as custom properties rather than
// as numbers typed into class lists. Before this, a sticky header said `z-40`
// in one file and a search overlay said `z-50` in another, and the ONLY way
// to know whether a future sticky CTA belonged above or below either was to
// grep for numbers — which is how a "z-index war" starts.
//
// DELIBERATELY NOT AGENT-WRITABLE. These are not `brandTokens`: they are not
// in the theme schema, no patch op reaches them, `site_apply_theme` does not
// touch them, and `resolveAxisVars` does not emit them. Stacking order is a
// rendering invariant — a tenant that could lower `--dl-layer-overlay` below
// `--dl-layer-sticky` would put its own header on top of its own mobile menu.
// CustomStyles.astro emits the whole set unconditionally, always the same
// bytes, for every tenant.
//
// The VALUES are the literals already in use (sticky 40, overlay 50), so the
// migration is byte-neutral in rendered output; `modal` and `toast` sit above
// them for the two layers that must never be covered. `behind` is the one
// negative tier, for decorative fills painted under their own container.
//
// Tailwind's `@layer base/components/utilities` in tailwind.css is the
// AT-RULE of the same name and an unrelated mechanism; native CSS cascade
// layers are deliberately NOT introduced here (W1 brief) — this scale is the
// ordering mechanism.
export const LAYER_TOKENS: Readonly<Record<string, string>> = {
  '--dl-layer-behind': '-1',
  '--dl-layer-base': '0',
  '--dl-layer-raised': '10',
  '--dl-layer-sticky': '40',
  '--dl-layer-overlay': '50',
  '--dl-layer-modal': '60',
  '--dl-layer-toast': '70',
};

/** The layer block exactly as CustomStyles.astro emits it, one declaration per line. */
export const layerTokenCss = (indent = '    '): string =>
  Object.entries(LAYER_TOKENS)
    .map(([name, value]) => `${indent}${name}: ${value};\n`)
    .join('');

// ─── Theme token axes (T10.1, 11-platformization-plan §1.1) ──────────────────
//
// Bounded enum axes widening brandTokens beyond colors + fonts: spacing
// rhythm, container width, radii, shadows, type scale, heading weight.
// Rule-6 mechanics: every axis VALUE maps to a pre-built code-side custom-
// property set below — the enum value itself never reaches CSS; it only
// indexes into these tables. The default value of every axis maps to the
// literals hardcoded in src/assets/styles/tailwind.css today (each tier
// there reads `var(--dl-…, <literal>)` with the SAME literal as fallback),
// so an absent axis — or one set to its default — renders byte-identically
// to the pre-T10.1 site. CustomStyles.astro emits vars ONLY for axes set to
// a non-default value, keeping the default inline <style> byte-exact.
//
// Axis semantics (what each var drives — the wired tiers in tailwind.css):
//   layout.containerWidth → `.dl-section` max-width
//   layout.sectionRhythm  → `.dl-section` vertical padding (base / ≥640px)
//   shape.radius          → `.dl-card` radius + form-control radius
//   shape.buttonShape     → `.btn` radius
//   shape.shadow          → `.dl-card` box-shadow
//   type.scale            → editorial-prose / dl-reading font size (base /
//                           ≥1024px) + line-height
//   type.headingWeight    → base h1–h3 + editorial-prose heading weight
//                           (explicit per-component weight utilities still
//                           win — the axis drives the DEFAULT weight)

type AxisSpec<Value extends string> = {
  readonly values: readonly Value[];
  readonly default: Value;
  /** Per-value custom-property sets; every value maps the SAME var names. */
  readonly vars: Readonly<Record<Value, Readonly<Record<string, string>>>>;
};

const axis = <const Value extends string>(spec: AxisSpec<Value>): AxisSpec<Value> => spec;

export const THEME_AXES = {
  layout: {
    containerWidth: axis({
      values: ['narrow', 'default', 'wide'],
      default: 'default',
      vars: {
        narrow: { '--dl-container-max': '56rem' },
        default: { '--dl-container-max': '72rem' }, // max-w-6xl, today's literal
        wide: { '--dl-container-max': '80rem' },
      },
    }),
    sectionRhythm: axis({
      values: ['compact', 'default', 'airy'],
      default: 'default',
      vars: {
        compact: { '--dl-section-py': '2.5rem', '--dl-section-py-sm': '3.5rem' },
        default: { '--dl-section-py': '3.5rem', '--dl-section-py-sm': '5rem' }, // py-14 sm:py-20
        airy: { '--dl-section-py': '4.5rem', '--dl-section-py-sm': '6.5rem' },
      },
    }),
  },
  shape: {
    radius: axis({
      values: ['sharp', 'soft', 'round', 'pill'],
      default: 'round',
      vars: {
        sharp: { '--dl-radius-card': '0px', '--dl-radius-control': '0px' },
        soft: { '--dl-radius-card': '0.5rem', '--dl-radius-control': '0.25rem' },
        round: { '--dl-radius-card': '1rem', '--dl-radius-control': '0.375rem' }, // rounded-2xl / rounded-md
        pill: { '--dl-radius-card': '1.5rem', '--dl-radius-control': '0.75rem' },
      },
    }),
    buttonShape: axis({
      values: ['rect', 'soft', 'pill'],
      default: 'pill',
      vars: {
        rect: { '--dl-radius-btn': '0.375rem' },
        soft: { '--dl-radius-btn': '0.75rem' },
        pill: { '--dl-radius-btn': '9999px' }, // rounded-full, today's literal
      },
    }),
    shadow: axis({
      values: ['none', 'soft', 'elevated'],
      default: 'soft',
      vars: {
        none: { '--dl-shadow-card': '0 0 #0000' },
        soft: { '--dl-shadow-card': '0 1px 2px 0 rgb(15 23 42 / 0.05)' }, // shadow-sm shadow-slate-900/5
        elevated: {
          '--dl-shadow-card': '0 10px 15px -3px rgb(15 23 42 / 0.08), 0 4px 6px -4px rgb(15 23 42 / 0.05)',
        },
      },
    }),
  },
  type: {
    scale: axis({
      values: ['compact', 'default', 'editorial'],
      default: 'default',
      vars: {
        compact: { '--dl-prose-size': '16px', '--dl-prose-size-lg': '18px', '--dl-prose-leading': '1.65' },
        default: { '--dl-prose-size': '18px', '--dl-prose-size-lg': '20px', '--dl-prose-leading': '1.82' }, // today's literals
        editorial: { '--dl-prose-size': '19px', '--dl-prose-size-lg': '21px', '--dl-prose-leading': '1.9' },
      },
    }),
    headingWeight: axis({
      values: ['regular', 'medium', 'bold'],
      default: 'bold',
      vars: {
        regular: { '--dl-heading-weight': '400' },
        medium: { '--dl-heading-weight': '500' },
        bold: { '--dl-heading-weight': '700' }, // UA/prose bold, today's computed weight
      },
    }),
  },
} as const;

export type ThemeAxisGroup = keyof typeof THEME_AXES;

export const THEME_AXIS_GROUPS = Object.keys(THEME_AXES) as ThemeAxisGroup[];

/** Dotted `group.axis` keys — the axis registry's key list (contract surface, T10.2). */
export const THEME_AXIS_KEYS = THEME_AXIS_GROUPS.flatMap((group) =>
  Object.keys(THEME_AXES[group]).map((key) => `${group}.${key}`)
) as readonly string[];

/**
 * Resolve the custom properties a brandTokens record's axes ask for.
 * Only axes set to a KNOWN, NON-DEFAULT value emit vars — absent axes,
 * explicit defaults, and unknown values (schema-rejected anyway; belt and
 * braces here) all resolve to nothing, so the default render stays
 * byte-identical. Values come exclusively from the code-owned tables above;
 * no input string is ever emitted.
 */
export const resolveAxisVars = (
  tokens:
    | {
        colors?: unknown;
        fonts?: unknown;
        layout?: Record<string, string | undefined>;
        shape?: Record<string, string | undefined>;
        type?: Record<string, string | undefined>;
      }
    | undefined
): Record<string, string> => {
  const resolved: Record<string, string> = {};
  if (!tokens) return resolved;
  for (const group of THEME_AXIS_GROUPS) {
    const groupValues = tokens[group];
    if (!groupValues) continue;
    for (const [axisKey, spec] of Object.entries(THEME_AXES[group]) as [string, AxisSpec<string>][]) {
      const value = groupValues[axisKey];
      if (value === undefined || value === spec.default) continue;
      const varSet = Object.prototype.hasOwnProperty.call(spec.vars, value) ? spec.vars[value] : undefined;
      if (!varSet) continue;
      Object.assign(resolved, varSet);
    }
  }
  return resolved;
};

// ─── CSS-value safety ─────────────────────────────────────────────────────────

// Hard floor for ANY token value: characters/constructs that could terminate
// the declaration, open a new rule, close the <style> tag, or fetch a
// resource. Checked case-insensitively; applies on top of the per-kind
// grammar so even a grammar gap can't smuggle these through.
const HARD_FLOOR_RE = /[;{}<>]|url\s*\(|@import|expression\s*\(/i;

// One CSS color: hex, a functional form with ONE paren level (rgb/rgba/hsl/
// hsla/oklch/color, modern or comma syntax), or a bare keyword (lavender,
// transparent). No nesting — calc()/var() chains don't belong in a token.
const COLOR_VALUE_RE = /^(#[0-9a-fA-F]{3,8}|(rgba?|hsla?|oklch|color)\(\s*[^()]*\s*\)|[a-zA-Z][a-zA-Z-]*)$/;

// A font stack: family names (quoted or bare) separated by commas — letters,
// digits, spaces, hyphens, and straight quotes only.
const FONT_STACK_RE = /^[A-Za-z0-9'" -]+(?:\s*,\s*[A-Za-z0-9'" -]+)*$/;

export type TokenValueCheck = { ok: true } | { ok: false; error: string };

export const checkBrandTokenValue = (kind: 'color' | 'font', value: string): TokenValueCheck => {
  const trimmed = value.trim();
  if (!trimmed) return { ok: false, error: 'empty value' };
  if (HARD_FLOOR_RE.test(trimmed)) {
    return {
      ok: false,
      error:
        'value carries a CSS-injection construct (;, {, }, <, >, url(, @import) — it would break or extend the inline style tag',
    };
  }
  if (kind === 'color' && !COLOR_VALUE_RE.test(trimmed)) {
    return {
      ok: false,
      error: 'not a recognized color value (hex, rgb()/rgba()/hsl()/hsla()/oklch()/color(), or a bare keyword)',
    };
  }
  if (kind === 'font' && !FONT_STACK_RE.test(trimmed)) {
    return { ok: false, error: 'not a plain font stack (family names separated by commas)' };
  }
  return { ok: true };
};
