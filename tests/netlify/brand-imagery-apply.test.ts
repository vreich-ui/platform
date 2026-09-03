/**
 * P3 — `site_apply_brand_imagery`, the imagery sibling of `site_apply_theme`
 * (BRIEF.md §3.3, R6). Same recipe: exact-replace under YOUR site checkout,
 * one atomic op with the source's provenance in history and an exact
 * inverse, dry_run open to any admin. The two differences from apply_theme
 * (§3.3): sources are EXACTLY ONE of `visual_standard_id` (house OR
 * template — promoting a template is intended) or `theme_id` (whose
 * brandImagery is optional, unlike a visual_standard's), and the dry_run
 * response is `{ before, after, changedFields[] }` rather than a raw op
 * preview.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11: register site providers (tests exercise the drlurie-bound core)
import assert from 'node:assert/strict';
import test from 'node:test';

import { handleObjectVerb, type ObjectVerbRequest, type ObjectVerbStore } from '../../packages/core/server/lib/object-verbs.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { applyPatchOps, derivePatchInverse, type PatchOpCapture } from '../../packages/core/lib/object-patch-apply.js';
import type { PatchOp } from '../../packages/core/schema/object-patch-ops.js';
import type { ThemeBody } from '../../packages/core/schema/bodies/theme-v1.js';
import type { VisualStandardBody } from '../../packages/core/schema/bodies/visual-standard-v1.js';
import type { BrandImagery, SiteBody } from '../../packages/core/schema/bodies/site-v1.js';
import type { ObjectRecord, Principal } from '../../packages/core/schema/object-record-v1.js';
import { siteBody } from '../../sites/drlurie/seeds/site-seed-data.mjs';
import { deriveBrandImageryFromTokens } from '../../packages/core/server/lib/brand-imagery-derive.js';

const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const AGENT: Principal = { kind: 'agent', agent_name: 'brand-imagery-test', auth: 'publish_key' };

const createMemoryStore = () => {
  const blobs = new Map<string, string>();
  return {
    blobs,
    async get(key: string) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key: string, value: unknown) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }: { prefix: string }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};
type Store = ReturnType<typeof createMemoryStore>;

const call = async (store: Store, request: ObjectVerbRequest, principal: Principal = AGENT) => {
  const verbStore = store as unknown as ObjectVerbStore;
  const validationContext = await buildStoreValidationContext(verbStore);
  return handleObjectVerb(verbStore, request, principal, { nowMs: NOW, validationContext });
};

const seedObject = async (store: Store, objectType: 'theme' | 'site' | 'navigation' | 'visual_standard', id: string, body: unknown) => {
  const res = await call(store, {
    action: 'create',
    object_type: objectType,
    site: 'site_drlurie',
    body,
    requested_id: id,
  });
  assert.equal(res.status, 200, `${id}: ${JSON.stringify(res.body)}`);
  return res.body.record as ObjectRecord;
};

// The site seed's defaultNavigation references must resolve (reference
// integrity is live in these tests), so seed minimal nav objects first.
const seedSite = async (store: Store) => {
  const navBody = (role: 'header' | 'footer') => ({
    role,
    groups: [{ id: 'g_main', items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }] }],
  });
  await seedObject(store, 'navigation', 'nav_header', navBody('header'));
  await seedObject(store, 'navigation', 'nav_footer', navBody('footer'));
  return seedObject(store, 'site', 'site_drlurie', siteBody);
};

const checkoutSite = async (store: Store, siteId = 'site_drlurie') => {
  const res = await call(store, { action: 'checkout', object_type: 'site', object_id: siteId });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return { lockToken: res.body.lockToken as string, recordVersion: res.body.record_version as number };
};

const loadSite = (store: Store, siteId = 'site_drlurie'): ObjectRecord =>
  JSON.parse(store.blobs.get(objectRecordKey('site', siteId))!) as ObjectRecord;

// A distinct, fully-populated brandImagery — every field present including
// the two optional nested shapes (composition/lora) so the exact-replace
// arithmetic (aspectRatios/composition/lora stale-unset) actually exercises.
const altBrandImagery = (): BrandImagery => ({
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42', '#C2A878'],
  negative: ['no stock-photo gloss', 'no oversaturation'],
  composition: { subjectScale: 'medium close-up', cropRule: 'rule of thirds' },
  aspectRatios: { article_header: '3:2', pdf_cover: '1:1' },
  seedBase: 100001,
  lora: { url: 'https://cdn.fal.ai/lora/drlurie.safetensors', scale: 0.8, version: 'v1' },
});

const altVisualStandard = (kind: 'house' | 'template' = 'house'): VisualStandardBody => ({
  version: 1,
  kind,
  label: kind === 'house' ? 'Dr. Lurié house look' : 'Seasonal campaign look',
  description: 'The site-wide default image style.',
  ...(kind === 'template' ? { whenToUse: 'For seasonal campaign PDFs.' } : {}),
  brandImagery: altBrandImagery(),
  references: [{ id: 'ref_a1b2c3d4', blobKey: 'img/mood/1.jpg', note: 'the palette, not the subject', weight: 0.8 }],
  sampleSubjects: ['a woman applying serum'],
  status: kind === 'house' ? 'active' : 'draft',
});

// A theme carrying brandTokens (required) AND a brandImagery preset
// (optional per theme-v1.ts) — a DIFFERENT brandImagery from
// altVisualStandard's, so apply-from-theme and apply-from-visual_standard
// tests are provably exercising distinct sources.
const themeWithImagery = (): ThemeBody => ({
  name: 'Editorial Theme',
  tokens: siteBody.brandTokens,
  brandImagery: {
    version: 1,
    medium: 'digital_illustration',
    styleSentence: 'Warm, hand-drawn editorial illustration.',
    palette: ['#8B5E3C'],
    negative: ['no photorealism'],
    aspectRatios: { article_header: '16:9' },
    seedBase: 77,
  },
});

const themeWithoutImagery = (): ThemeBody => ({
  name: 'Palette Only Theme',
  tokens: siteBody.brandTokens,
});

// ═══ dry-run diff shape ════════════════════════════════════════════════════

test('dry_run returns {before, after, changedFields}: before is null on a site with no brandImagery yet; NO checkout, NO persistence', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard());

  const beforeBody = JSON.stringify(loadSite(store).body);
  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.dry_run, true);
  assert.equal(res.body.before, null);
  assert.deepEqual(res.body.after, altBrandImagery());
  assert.deepEqual(
    new Set(res.body.changedFields as string[]),
    new Set(['version', 'medium', 'styleSentence', 'palette', 'negative', 'composition', 'aspectRatios', 'seedBase', 'lora']),
    'every field is "changed" against an absent site.brandImagery'
  );
  assert.equal(res.body.eligible, true);
  assert.equal(JSON.stringify(loadSite(store).body), beforeBody, 'nothing persisted');
});

test('dry_run against a site that ALREADY carries brandImagery reports only the fields that actually differ', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard());
  const { lockToken, recordVersion } = await checkoutSite(store);
  const applied = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));

  // A second standard that changes ONLY styleSentence + seedBase.
  const tweaked: VisualStandardBody = {
    ...altVisualStandard('template'),
    brandImagery: { ...altBrandImagery(), styleSentence: 'A slightly warmer sentence.', seedBase: 999 },
  };
  await seedObject(store, 'visual_standard', 'vis_drlurie_tweak', tweaked);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_tweak',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(new Set(res.body.changedFields as string[]), new Set(['styleSentence', 'seedBase']));
});

// ═══ apply from a visual_standard (house AND template) ═════════════════════

test('apply from a visual_standard (house): site.brandImagery EQUALS the source exactly, provenance + inverse', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard('house'));
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.applied_brand_imagery_source, {
    kind: 'visual_standard',
    id: 'vis_drlurie',
    // `imagery` says whether the block was READ off the source or derived from
    // a theme's tokens — always present, so neither case is the silent default.
    imagery: 'declared',
  });

  const site = loadSite(store);
  const imagery = (site.body as SiteBody).brandImagery;
  assert.deepEqual(imagery, altBrandImagery(), 'site.brandImagery EQUALS the visual_standard\'s brandImagery');

  const entry = site.history.at(-1)!;
  assert.equal(entry.action, 'set_site_brand_imagery');
  assert.deepEqual(entry.details?.applied_brand_imagery_source, {
    kind: 'visual_standard',
    id: 'vis_drlurie',
    imagery: 'declared',
  });

  // Reverting is a Discard: the exact inverse re-applies through the
  // PRIVILEGED path, never a raw agent object_patch.
  const inverse = derivePatchInverse(entry.details!.op as PatchOp, entry.details!.capture as PatchOpCapture) as {
    op: string;
  };
  assert.equal(inverse.op, 'set_site_brand_imagery', 'the imagery inverse is itself the privileged imagery op');
  const reverted = applyPatchOps(loadSite(store), [inverse], {
    actor: { kind: 'agent', agent_name: 'discard', auth: 'publish_key' },
    at: new Date(0).toISOString(),
    privilegedOps: ['set_site_brand_imagery'],
  });
  assert.equal(
    (reverted.record.body as SiteBody).brandImagery,
    undefined,
    'the privileged inverse restores exactly — back to no brandImagery at all'
  );
});

test('apply from a visual_standard (kind:"template") is a legitimate source — promoting a template is intended', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie_seasonal', altVisualStandard('template'));
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_seasonal',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((loadSite(store).body as SiteBody).brandImagery, altBrandImagery());
});

// ═══ apply from a theme ═════════════════════════════════════════════════════

test('apply from a theme\'s optional brandImagery preset: site.brandImagery EQUALS the theme\'s, provenance + inverse', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'theme', 'thm_editorial', themeWithImagery());
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_editorial',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.applied_brand_imagery_source, { kind: 'theme', id: 'thm_editorial', imagery: 'declared' });

  const site = loadSite(store);
  assert.deepEqual((site.body as SiteBody).brandImagery, themeWithImagery().brandImagery);
  const entry = site.history.at(-1)!;
  assert.equal(entry.action, 'set_site_brand_imagery');

  const inverse = derivePatchInverse(entry.details!.op as PatchOp, entry.details!.capture as PatchOpCapture);
  const reverted = applyPatchOps(loadSite(store), [inverse], {
    actor: { kind: 'agent', agent_name: 'discard', auth: 'publish_key' },
    at: new Date(0).toISOString(),
    privilegedOps: ['set_site_brand_imagery'],
  });
  assert.equal((reverted.record.body as SiteBody).brandImagery, undefined);
});

// ═══ deriving from a theme that declares no brandImagery ═══════════════════
//
// The other half of the 2026-09 incident. A user asked twice for "based on
// the current theme create the site's brandImagery" and no agent-reachable
// path did it: thm_drlurie_default carries `tokens` and no `brandImagery`, so
// this verb 422'd, and the site had no visual_standard yet either, so that
// source was empty too. `deriveBrandImageryFromTokens` already existed and is
// already what site genesis writes into every new site's house standard, and
// P4's resolver already treats derived-from-tokens as its last precedence
// tier — so the verb agreeing with them is consistency, not a new concept.

test('a theme with no brandImagery preset DERIVES one from its tokens, and the dry-run says it derived', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'theme', 'thm_palette_only', themeWithoutImagery());

  const res = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_palette_only',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  // It is the shipped derivation, byte for byte — not a second implementation.
  const expected = deriveBrandImageryFromTokens({ brandTokens: themeWithoutImagery().tokens }, 'site_drlurie');
  assert.deepEqual(res.body.after, expected);

  // A human approving this must be able to see it was DERIVED, not read.
  const source = res.body.source as { kind: string; id: string; imagery: string; note?: string };
  assert.equal(source.kind, 'theme');
  assert.equal(source.id, 'thm_palette_only');
  assert.equal(source.imagery, 'derived_from_theme_tokens');
  assert.match(String(source.note), /derived/i);
  assert.ok((res.body.changedFields as string[]).length > 0);

  // Still a dry run: nothing written.
  assert.equal(loadSite(store).body ? (loadSite(store).body as SiteBody).brandImagery : undefined, undefined);
});

test('the derived imagery applies for real, and the history entry records that it was derived', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'theme', 'thm_palette_only', themeWithoutImagery());
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_palette_only',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));

  const expected = deriveBrandImageryFromTokens({ brandTokens: themeWithoutImagery().tokens }, 'site_drlurie');
  assert.deepEqual((loadSite(store).body as SiteBody).brandImagery, expected);

  const provenance = res.body.applied_brand_imagery_source as { kind: string; id: string; imagery: string };
  assert.deepEqual(
    { kind: provenance.kind, id: provenance.id, imagery: provenance.imagery },
    { kind: 'theme', id: 'thm_palette_only', imagery: 'derived_from_theme_tokens' }
  );
  const entry = loadSite(store).history.at(-1)!;
  assert.equal(
    (entry.details as { applied_brand_imagery_source: { imagery: string } }).applied_brand_imagery_source.imagery,
    'derived_from_theme_tokens'
  );
});

test('a theme that DOES declare brandImagery is still used verbatim — derivation never overrides a declared preset', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'theme', 'thm_editorial', themeWithImagery());

  const res = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_editorial',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual(res.body.after, themeWithImagery().brandImagery);
  assert.equal((res.body.source as { imagery: string }).imagery, 'declared');
  // And it is NOT what the tokens would have derived — the two are provably distinct.
  assert.notDeepEqual(
    res.body.after,
    deriveBrandImageryFromTokens({ brandTokens: themeWithImagery().tokens }, 'site_drlurie')
  );
});

test('REJECTION: a theme with neither a preset nor a derivable palette is refused with a clear error naming it', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  // brandTokensSchema allows an EMPTY colors record, and the derivation needs
  // at least one parseable colour — the one theme shape that still has nothing
  // to offer either way.
  await seedObject(store, 'theme', 'thm_colourless', {
    name: 'Colourless Theme',
    tokens: { ...siteBody.brandTokens, colors: {} },
  } satisfies ThemeBody);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_colourless',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.match(String(res.body.error), /carries no brandImagery/);
  assert.match(String(res.body.error), /derived from its tokens/);
  assert.equal(res.body.theme_id, 'thm_colourless');
});

// ═══ an id in the wrong parameter slot ═════════════════════════════════════

test('a theme id passed as visual_standard_id names the parameter it belongs in, not "not found"', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'theme', 'thm_drlurie_default', themeWithoutImagery());

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'thm_drlurie_default',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  // The incident answer was 404 "Visual standard not found" — true, and
  // useless. Object ids are self-describing by prefix, so say so.
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error), /is a theme id/);
  assert.match(String(res.body.error), /pass it as theme_id/);
  assert.equal(res.body.use_parameter, 'theme_id');
  assert.equal(res.body.actual_object_type, 'theme');

  // Symmetric: a visual_standard id in the theme_id slot.
  const flipped = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(flipped.status, 400, JSON.stringify(flipped.body));
  assert.match(String(flipped.body.error), /is a visual_standard id/);
  assert.equal(flipped.body.actual_object_type, 'visual_standard');

  // A well-formed-but-absent visual_standard id is STILL an honest 404 — the
  // new check is about the wrong slot, never a substitute for not-found.
  const missing = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_nope',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(missing.status, 404, JSON.stringify(missing.body));
});

// ═══ exactly one of visual_standard_id / theme_id ══════════════════════════

test('REJECTION: both visual_standard_id and theme_id is a 400', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard());
  await seedObject(store, 'theme', 'thm_editorial', themeWithImagery());

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    theme_id: 'thm_editorial',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error), /exactly one/i);
});

test('REJECTION: neither visual_standard_id nor theme_id is a 400', async () => {
  const store = createMemoryStore();
  await seedSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.error), /exactly one/i);
});

// ═══ checkout / lock / owner discipline (mirrors apply_theme) ══════════════

test('a real apply REQUIRES the site checkout: missing fields 400, wrong lock 423, stale version 409', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard());

  const missing = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
  });
  assert.equal(missing.status, 400);

  const wrongLock = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    lock_token: 'nope',
    expected_record_version: 1,
  });
  assert.equal(wrongLock.status, 423);

  const { lockToken } = await checkoutSite(store);
  const stale = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: 0,
  });
  assert.equal(stale.status, 409);
});

test('a REAL apply by a human requires the owner role; dry_run stays open; agents unchanged', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  await seedObject(store, 'visual_standard', 'vis_drlurie', altVisualStandard());
  const verbStore = store as unknown as ObjectVerbStore;
  const validationContext = await buildStoreValidationContext(verbStore);
  const admin: Principal = { kind: 'human', id: 'id-adm', email: 'admin@example.com' };

  const denied = await handleObjectVerb(
    verbStore,
    {
      action: 'apply_brand_imagery',
      visual_standard_id: 'vis_drlurie',
      site_id: 'site_drlurie',
      lock_token: 'x',
      expected_record_version: 1,
    },
    admin,
    { nowMs: NOW, validationContext, roles: ['admin'] }
  );
  assert.equal(denied.status, 403);
  assert.match(String(denied.body.error), /Owner role/);

  const preview = await handleObjectVerb(
    verbStore,
    { action: 'apply_brand_imagery', visual_standard_id: 'vis_drlurie', site_id: 'site_drlurie', dry_run: true },
    admin,
    { nowMs: NOW, validationContext, roles: ['admin'] }
  );
  assert.equal(preview.status, 200);

  const ownerAttempt = await handleObjectVerb(
    verbStore,
    {
      action: 'apply_brand_imagery',
      visual_standard_id: 'vis_drlurie',
      site_id: 'site_drlurie',
      lock_token: 'x',
      expected_record_version: 1,
    },
    { kind: 'human', id: 'id-owner', email: 'owner@example.com' },
    { nowMs: NOW, validationContext, roles: ['owner', 'admin'] }
  );
  assert.equal(ownerAttempt.status, 423); // gate passed; lock check speaks

  const agentAttempt = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie',
    site_id: 'site_drlurie',
    lock_token: 'x',
    expected_record_version: 1,
  });
  assert.equal(agentAttempt.status, 423);
});

test('REJECTION: an agent cannot hand-author the privileged imagery op via object_patch', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'patch',
    object_type: 'site',
    object_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
    ops: [{ op: 'set_site_brand_imagery', fields: { brandImagery: altBrandImagery() } }],
  });
  assert.equal(res.status, 422, JSON.stringify(res.body));
  assert.equal(res.body.code, 'op_not_applicable');
});

test('a missing visual_standard is a 404 naming it; a missing theme is a 404 naming it', async () => {
  const store = createMemoryStore();
  await seedSite(store);

  const missingVs = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_ghost',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(missingVs.status, 404);
  assert.equal(missingVs.body.visual_standard_id, 'vis_ghost');

  const missingTheme = await call(store, {
    action: 'apply_brand_imagery',
    theme_id: 'thm_ghost',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(missingTheme.status, 404);
  assert.equal(missingTheme.body.theme_id, 'thm_ghost');
});

// ═══ FIX-E: a draft cloned standard can now be CREATED with 0 sampleSubjects
// (visual-standard-v1.ts's schema fix), but must never reach the SITE
// through this verb — dry_run or real — while it has none. ═══════════════

test('FIX-E: applying a draft standard with 0 sampleSubjects is refused (dry_run AND real apply), even though it now parses', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  // A page-snapshot clone: derivedFrom.method:'clone' deliberately omits
  // sampleSubjects (BRIEF §3.1's rationale — a snapshot can say what a
  // picture looks like, never what it is OF). This CREATE must succeed —
  // that's the bug FIX-E's schema change fixes for a draft.
  const cloned: VisualStandardBody = {
    ...altVisualStandard('template'),
    sampleSubjects: [],
    derivedFrom: { method: 'clone' },
  };
  const created = await seedObject(store, 'visual_standard', 'vis_drlurie_cloned', cloned);
  assert.equal((created.body as VisualStandardBody).sampleSubjects.length, 0);

  const { lockToken, recordVersion } = await checkoutSite(store);

  const dryRun = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_cloned',
    site_id: 'site_drlurie',
    dry_run: true,
  });
  assert.equal(dryRun.status, 422, JSON.stringify(dryRun.body));
  assert.match(String(dryRun.body.error), /sample subjects/i);

  const realApply = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_cloned',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(realApply.status, 422, JSON.stringify(realApply.body));
  assert.match(String(realApply.body.error), /sample subjects/i);
  // Nothing was written — the site never picked up the unusable contract.
  assert.equal((loadSite(store).body as SiteBody).brandImagery, undefined);
});

test('FIX-E: the same draft, once it gains a sample subject, applies exactly like any other source', async () => {
  const store = createMemoryStore();
  await seedSite(store);
  const cloned: VisualStandardBody = {
    ...altVisualStandard('template'),
    sampleSubjects: ['a woman applying serum'],
    derivedFrom: { method: 'clone' },
  };
  await seedObject(store, 'visual_standard', 'vis_drlurie_cloned', cloned);
  const { lockToken, recordVersion } = await checkoutSite(store);

  const res = await call(store, {
    action: 'apply_brand_imagery',
    visual_standard_id: 'vis_drlurie_cloned',
    site_id: 'site_drlurie',
    lock_token: lockToken,
    expected_record_version: recordVersion,
  });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.deepEqual((loadSite(store).body as SiteBody).brandImagery, altBrandImagery());
});
