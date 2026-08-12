import assert from 'node:assert/strict';
import test from 'node:test';

import { deriveBrandImageryFromTokens, fnv1aHash } from '../../packages/core/server/lib/brand-imagery-derive.js';
import { brandImagerySchema } from '../../packages/core/schema/bodies/site-v1.js';

// The live site_platform palette (theme thm_platform_anthropic): warm cream
// ground, terracotta primary, muted gold, editorial serif heading, airy rhythm.
const PLATFORM_TOKENS = {
  colors: {
    primary: 'rgb(204 120 92)',
    secondary: 'rgb(45 42 38)',
    accent: 'rgb(204 120 92)',
    gold: 'rgb(191 155 48)',
    'text-heading': 'rgb(30 27 24)',
    'text-default': 'rgb(45 42 38)',
    'text-muted': 'rgb(90 84 76 / 80%)',
    'bg-page': 'rgb(250 249 245)',
    'bg-surface': 'rgb(244 242 236)',
    'bg-page-dark': 'rgb(24 22 20)',
  },
  fonts: {
    sans: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif',
    serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
    heading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  },
  layout: { containerWidth: 'default', sectionRhythm: 'airy' },
  shape: { radius: 'soft', buttonShape: 'soft', shadow: 'soft' },
  type: { scale: 'editorial', headingWeight: 'medium' },
};

test('derived brandImagery satisfies the live site.v1 brandImagery schema', () => {
  const derived = deriveBrandImageryFromTokens({ brandTokens: PLATFORM_TOKENS }, 'site_platform');
  assert.ok(derived, 'a site with brandTokens derives a contract');
  // The real schema is the arbiter -- if this passes, the derived block is
  // writable/consumable exactly like a declared one.
  const parsed = brandImagerySchema.safeParse(derived);
  assert.ok(parsed.success, JSON.stringify((parsed as { error?: unknown }).error));
});

test('derived contract reflects the site palette and design axes', () => {
  const derived = deriveBrandImageryFromTokens({ brandTokens: PLATFORM_TOKENS }, 'site_platform');
  assert.ok(derived);

  // Terracotta primary leads the palette; hex conversion is exact.
  assert.equal(derived.palette[0], '#CC785C');
  assert.ok(derived.palette.includes('#BF9B30'), 'the gold token survives into the palette');
  assert.ok(derived.palette.length <= 8, 'palette respects the schema cap');
  assert.equal(new Set(derived.palette).size, derived.palette.length, 'palette is deduped');

  // Serif heading + soft radius -> illustration, never an auto photograph.
  assert.equal(derived.medium, 'digital_illustration');

  // The sentence names the hues in prose so the model can act on them.
  assert.match(derived.styleSentence, /terracotta/);
  assert.match(derived.styleSentence, /warm cream ground/);
  assert.match(derived.styleSentence, /generous negative space/, 'airy rhythm reaches the sentence');
  assert.match(derived.styleSentence, /print-magazine/, 'editorial type scale reaches the sentence');
  assert.ok(derived.styleSentence.length <= 400);
});

test('sharp-edged sans-serif sites derive flat vector instead', () => {
  const derived = deriveBrandImageryFromTokens(
    {
      brandTokens: {
        colors: { primary: '#3366CC', 'bg-page': '#FFFFFF' },
        fonts: { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', heading: 'system-ui, sans-serif' },
        shape: { radius: 'sharp' },
        type: { scale: 'compact' },
      },
    },
    'site_sharp'
  );
  assert.ok(derived);
  assert.equal(derived.medium, 'flat_vector');
  assert.match(derived.styleSentence, /blue/);
  assert.match(derived.styleSentence, /crisp geometric shapes/);
  assert.ok(brandImagerySchema.safeParse(derived).success);
});

test('dark-ground sites are described as such', () => {
  const derived = deriveBrandImageryFromTokens(
    { brandTokens: { colors: { primary: 'rgb(0 150 136)', 'bg-page': 'rgb(10 12 20)' } } },
    'site_dark'
  );
  assert.ok(derived);
  assert.match(derived.styleSentence, /deep near-black ground/);
  assert.match(derived.styleSentence, /teal/);
});

test('derivation is deterministic and site-scoped', () => {
  const a = deriveBrandImageryFromTokens({ brandTokens: PLATFORM_TOKENS }, 'site_platform');
  const b = deriveBrandImageryFromTokens({ brandTokens: PLATFORM_TOKENS }, 'site_platform');
  const other = deriveBrandImageryFromTokens({ brandTokens: PLATFORM_TOKENS }, 'site_other');
  assert.deepEqual(a, b, 'same inputs derive an identical contract -- no clock, no randomness');
  assert.equal(a?.seedBase, fnv1aHash('brandImagery:site_platform'));
  assert.notEqual(a?.seedBase, other?.seedBase, 'different sites get different seed bases');
});

test('parses every CSS colour form brandTokens can carry, and skips the rest', () => {
  const derived = deriveBrandImageryFromTokens(
    {
      brandTokens: {
        colors: {
          primary: '#c78',
          accent: 'rgb(10, 20, 30)',
          gold: 'rgba(191 155 48 / 80%)',
          secondary: 'not-a-color',
          'text-muted': 'var(--x)',
        },
      },
    },
    'site_forms'
  );
  assert.ok(derived);
  assert.ok(derived.palette.includes('#CC7788'), '3-digit hex expands');
  assert.ok(derived.palette.includes('#0A141E'), 'legacy comma rgb parses');
  assert.ok(derived.palette.includes('#BF9B30'), 'rgba with slash alpha parses, alpha dropped');
  assert.equal(derived.palette.length, 3, 'unparseable values are skipped, not guessed');
});

test('returns undefined when there is nothing to derive from', () => {
  assert.equal(deriveBrandImageryFromTokens(undefined, 'site_x'), undefined);
  assert.equal(deriveBrandImageryFromTokens({}, 'site_x'), undefined);
  assert.equal(deriveBrandImageryFromTokens({ brandTokens: {} }, 'site_x'), undefined);
  assert.equal(
    deriveBrandImageryFromTokens({ brandTokens: { colors: { primary: 'nope' } } }, 'site_x'),
    undefined,
    'no parseable colour means no derivation -- never an invented identity'
  );
});
