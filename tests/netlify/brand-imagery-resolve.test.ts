import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { BrandImageryRecord } from '../../packages/core/server/lib/brand-imagery-derive.js';
import {
  ALLOWED_IMAGE_SIZES,
  DEFAULT_USAGE_CONTEXT,
  getBrandImageryOverridePolicy,
  nearestAllowedSize,
  resolveEffectiveBrandImagery,
  resolveImageSizeForContext,
  resolveUsageContext,
  toStyleInput,
  type SiteForBrandImageryResolve,
} from '../../packages/core/server/lib/brand-imagery-resolve.js';
import { setLocalBlobsRootForTesting } from '../../packages/core/server/lib/local-blobs.js';
import { getGovernanceBlobStore, putGovernanceDoc } from '../../packages/core/server/lib/governance-store.js';

const brand = (overrides: Partial<BrandImageryRecord> = {}): BrandImageryRecord => ({
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42', '#C2A878'],
  negative: ['no stock-photo gloss'],
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
  ...overrides,
});

const SITE_BRAND = brand({ styleSentence: 'Site-declared style.', seedBase: 1 });
const STANDARD_BRAND = brand({ styleSentence: 'Visual-standard style.', seedBase: 2 });

// A site with brandTokens but NO declared brandImagery -- the derive-from-tokens
// fallback tier. Mirrors brand-imagery-derive.test.ts's PLATFORM_TOKENS fixture.
const TOKENS_ONLY_SITE: SiteForBrandImageryResolve = {
  siteId: 'site_tokens_only',
  body: {
    brandTokens: {
      colors: { primary: 'rgb(0 150 136)', 'bg-page': '#FFFFFF' },
      fonts: { sans: 'system-ui, sans-serif', serif: 'Georgia, serif', heading: 'Georgia, serif' },
    },
  },
};

const SITE_WITH_DECLARED: SiteForBrandImageryResolve = {
  siteId: 'site_declared',
  brandImagery: SITE_BRAND,
};

// A site with NEITHER a declared brandImagery NOR any brandTokens to derive
// from -- the bottom of every tier.
const BARE_SITE: SiteForBrandImageryResolve = { siteId: 'site_bare' };

test('precedence: override wins over a resolved visual_standard, the site\'s own brandImagery, and derived', () => {
  const resolved = resolveEffectiveBrandImagery(
    SITE_WITH_DECLARED,
    STANDARD_BRAND,
    { visualStandardId: 'vis_site_declared_hero', override: { styleSentence: 'Override style.' } },
    'allow'
  );
  assert.equal(resolved.styleSource, 'override');
  assert.equal(resolved.brandImagery?.styleSentence, 'Override style.');
  // Shallow merge (BRIEF §4: no per-key diff semantics): fields the override
  // did not name fall through from the base tier (visualStandardId's here).
  assert.equal(resolved.brandImagery?.seedBase, STANDARD_BRAND.seedBase);
  assert.deepEqual(resolved.overriddenFields, []);
});

test('precedence: visualStandardId wins over the site\'s own brandImagery when no override is given', () => {
  const resolved = resolveEffectiveBrandImagery(SITE_WITH_DECLARED, STANDARD_BRAND, { visualStandardId: 'vis_x' }, 'allow');
  assert.equal(resolved.styleSource, 'visual_standard');
  assert.deepEqual(resolved.brandImagery, STANDARD_BRAND);
});

test('precedence: the site\'s declared brandImagery wins over derived-from-tokens when no style is given', () => {
  const siteWithBoth: SiteForBrandImageryResolve = { ...SITE_WITH_DECLARED, body: TOKENS_ONLY_SITE.body };
  const resolved = resolveEffectiveBrandImagery(siteWithBoth, undefined, undefined, 'allow');
  assert.equal(resolved.styleSource, 'site');
  assert.deepEqual(resolved.brandImagery, SITE_BRAND);
});

test('precedence: a derived-from-tokens fallback applies when the site has no declared brandImagery', () => {
  const resolved = resolveEffectiveBrandImagery(TOKENS_ONLY_SITE, undefined, undefined, 'allow');
  assert.equal(resolved.styleSource, 'derived');
  assert.ok(resolved.brandImagery, 'a contract is derived from brandTokens');
  assert.equal(resolved.brandImagery?.version, 1);
  assert.deepEqual(resolved.overriddenFields, []);
});

test('precedence: nothing resolves for a bare site with no style, no brandImagery, and no brandTokens', () => {
  const resolved = resolveEffectiveBrandImagery(BARE_SITE, undefined, undefined, 'allow');
  assert.equal(resolved.brandImagery, undefined);
  assert.equal(resolved.styleSource, 'derived');
  assert.deepEqual(resolved.overriddenFields, []);
});

test('override with an unresolved visualStandardId (standard undefined) falls through to override-on-site', () => {
  // Caller passes standard:undefined because the id never resolved (unknown
  // id, store error) -- resolution degrades to the next tier, never errors.
  const resolved = resolveEffectiveBrandImagery(
    SITE_WITH_DECLARED,
    undefined,
    { visualStandardId: 'vis_does_not_exist', override: { seedBase: 999 } },
    'allow'
  );
  assert.equal(resolved.styleSource, 'override');
  assert.equal(resolved.brandImagery?.seedBase, 999);
  assert.equal(resolved.brandImagery?.styleSentence, SITE_BRAND.styleSentence);
});

test('guardrail lock: a supplied style (override) is ignored and reported, falling back to the site\'s own brandImagery', () => {
  const resolved = resolveEffectiveBrandImagery(
    SITE_WITH_DECLARED,
    STANDARD_BRAND,
    { override: { styleSentence: 'Should never apply.' } },
    'lock'
  );
  assert.equal(resolved.styleSource, 'site_locked');
  assert.deepEqual(resolved.brandImagery, SITE_BRAND);
  assert.deepEqual(resolved.overriddenFields, ['style']);
});

test('guardrail lock: a supplied visualStandardId is ignored and reported too, falling back to derived when the site has no declared brandImagery', () => {
  const resolved = resolveEffectiveBrandImagery(TOKENS_ONLY_SITE, STANDARD_BRAND, { visualStandardId: 'vis_x' }, 'lock');
  assert.equal(resolved.styleSource, 'site_locked');
  assert.ok(resolved.brandImagery, 'derived brandImagery still applies under lock');
  assert.deepEqual(resolved.overriddenFields, ['style']);
});

test('guardrail lock: nothing to ignore when the caller never supplied a style -- ordinary resolution, no report', () => {
  const resolved = resolveEffectiveBrandImagery(SITE_WITH_DECLARED, undefined, undefined, 'lock');
  assert.equal(resolved.styleSource, 'site');
  assert.deepEqual(resolved.brandImagery, SITE_BRAND);
  assert.deepEqual(resolved.overriddenFields, []);
});

test('toStyleInput: an absent, non-object, or all-empty style normalizes to undefined', () => {
  assert.equal(toStyleInput(undefined), undefined);
  assert.equal(toStyleInput(null), undefined);
  assert.equal(toStyleInput('not an object'), undefined);
  assert.equal(toStyleInput({}), undefined);
  assert.equal(toStyleInput({ override: {} }), undefined);
});

test('toStyleInput: parses visualStandardId/override/note, dropping anything else', () => {
  const parsed = toStyleInput({ visualStandardId: 'vis_x', override: { seedBase: 5 }, note: 'why', extra: 'ignored' });
  assert.deepEqual(parsed, { visualStandardId: 'vis_x', override: { seedBase: 5 }, note: 'why' });
});

// ─── aspectRatio -> nearest allowed size ─────────────────────────────────────

test('ALLOWED_IMAGE_SIZES is exactly pdf-tool\'s 5 supported sizes', () => {
  assert.deepEqual(
    [...ALLOWED_IMAGE_SIZES].sort(),
    ['1024x1024', '1024x1536', '1024x1792', '1536x1024', '1792x1024'].sort()
  );
});

test('nearestAllowedSize maps common aspect ratios to the nearest of the 5 allowed sizes', () => {
  assert.equal(nearestAllowedSize(1), '1024x1024'); // 1:1
  assert.equal(nearestAllowedSize(3 / 2), '1536x1024'); // 3:2, landscape
  assert.equal(nearestAllowedSize(2 / 3), '1024x1536'); // 2:3, portrait
  assert.equal(nearestAllowedSize(16 / 9), '1792x1024'); // 16:9-ish landscape, closer to 1792x1024 than 1536x1024
  assert.equal(nearestAllowedSize(9 / 16), '1024x1792'); // 9:16-ish portrait
});

test('resolveImageSizeForContext reads aspectRatios[usageContext] and maps it to the nearest allowed size', () => {
  assert.equal(resolveImageSizeForContext('article_header', { article_header: '3:2' }), '1536x1024');
  assert.equal(resolveImageSizeForContext('article_body', { article_header: '3:2' }), undefined, 'no ratio declared for this context');
  assert.equal(resolveImageSizeForContext('article_header', undefined), undefined, 'no aspectRatios at all');
  assert.equal(resolveImageSizeForContext('article_header', { article_header: 'not-a-ratio' }), undefined);
});

// ─── usageContext coercion against the image-model-policy's known keys ──────

test('resolveUsageContext coerces an unrecognized usageContext to article_body and warns', () => {
  const result = resolveUsageContext('newsletter_hero', ['article_header', 'article_body', 'category_page']);
  assert.equal(result.usageContext, DEFAULT_USAGE_CONTEXT);
  assert.deepEqual(result.warnings, ['usage_context_not_in_policy:newsletter_hero']);
});

test('resolveUsageContext passes a recognized usageContext through unchanged, with no warning', () => {
  const result = resolveUsageContext('article_header', ['article_header', 'article_body']);
  assert.equal(result.usageContext, 'article_header');
  assert.deepEqual(result.warnings, []);
});

test('resolveUsageContext defaults an omitted usageContext to article_body silently', () => {
  const result = resolveUsageContext(undefined, ['article_header']);
  assert.equal(result.usageContext, DEFAULT_USAGE_CONTEXT);
  assert.deepEqual(result.warnings, []);
});

test('resolveUsageContext skips the membership check entirely when policyContexts is unavailable', () => {
  const result = resolveUsageContext('anything_goes', undefined);
  assert.equal(result.usageContext, 'anything_goes');
  assert.deepEqual(result.warnings, []);
});

// ─── U2: the guardrail write is observed by getBrandImageryOverridePolicy ───
//
// getBrandImageryOverridePolicy does its own I/O (it opens the governance
// blob store itself rather than accepting one), so this is the one test in
// this file that is NOT pure -- it proves the admin GovernancePage's write
// path (putGovernanceDoc against the SAME 'governance' blob store, the doc
// admin-governance.ts's `set` verb writes to) is the exact thing this
// resolver reads, through the real store plumbing rather than a mock.

test('U2: writing brandImageryOverrides=lock through the governance store makes getBrandImageryOverridePolicy return lock', async () => {
  const root = await mkdtemp(join(tmpdir(), 'brand-imagery-guardrail-'));
  setLocalBlobsRootForTesting(root);
  try {
    const siteId = 'site_u2_guardrail_test';

    // Default: nothing written yet -> 'allow' (the same disaster-fallback
    // posture as an unset field or a store read failure).
    assert.equal(await getBrandImageryOverridePolicy(siteId), 'allow');

    const store = await getGovernanceBlobStore(undefined);
    await putGovernanceDoc(store, {
      schema_version: 'overrides.v1',
      brandImageryOverrides: 'lock',
      updated_by: 'owner@example.com',
      updated_at: '2026-09-01T00:00:00.000Z',
      history: [],
    });

    assert.equal(
      await getBrandImageryOverridePolicy(siteId),
      'lock',
      'the resolver reads the SAME doc the write just landed in -- no forked store'
    );

    // Reverting (clearing the field, same as admin-governance.ts's `revert`
    // verb) hands the guardrail back to the default.
    await putGovernanceDoc(store, {
      schema_version: 'overrides.v1',
      updated_by: 'owner@example.com',
      updated_at: '2026-09-01T00:01:00.000Z',
      history: [],
    });
    assert.equal(await getBrandImageryOverridePolicy(siteId), 'allow');
  } finally {
    setLocalBlobsRootForTesting(undefined);
    await rm(root, { recursive: true, force: true });
    await rm(`${root}-meta`, { recursive: true, force: true });
  }
});
