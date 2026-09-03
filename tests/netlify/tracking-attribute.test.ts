/**
 * T13.1 — the shared `tracking` attribute + the uniform `set_tracking` op
 * (12-object-tracking-and-analytics §2).
 *
 * Pins: the shape parses on ALL TEN bodies and pre-W13 fixtures still parse
 * (the additive guarantee); set_tracking applies + inverts EXACTLY on every
 * type — first-set inverts to removal, removal inverts to full restore,
 * merge inverts per-key (added keys unset); the seven open fields ops refuse
 * the `tracking` key (one-writer funnel); the validation criterion mirrors
 * the regex bounds and warns-at-draft / blocks-at-publish on a goal bound to
 * an activity the type cannot collect (§6 matrix); the contract lists the op
 * ×10 and carries the funnel constraint.
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import { checkStructuralInvariants } from '../../packages/core/server/lib/object-validate.js';
import {
  applyPatchOps,
  deepEqualJson,
  derivePatchInverse,
  type PatchOpCapture,
} from '../../packages/core/lib/object-patch-apply.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import {
  carriesTrackingAttribute,
  TRACKABLE_ACTIVITIES_BY_TYPE,
  trackingAttributeSchema,
} from '../../packages/core/schema/bodies/tracking-attribute-v1.js';
import { contentItemBodySchema } from '../../packages/core/schema/bodies/content-item-v1.js';
import { navigationBodySchema } from '../../packages/core/schema/bodies/navigation-v1.js';
import { pageBodySchema } from '../../packages/core/schema/bodies/page-v1.js';
import { sectionBodySchema } from '../../packages/core/schema/bodies/section-v1.js';
import { sectionTemplateBodySchema } from '../../packages/core/schema/bodies/section-template-v1.js';
import { siteBodySchema } from '../../packages/core/schema/bodies/site-v1.js';
import { taxonomyBodySchema } from '../../packages/core/schema/bodies/taxonomy-v1.js';
import { templateBodySchema } from '../../packages/core/schema/bodies/template-v1.js';
import { themeBodySchema } from '../../packages/core/schema/bodies/theme-v1.js';
import { editorialVoiceBodySchema } from '../../packages/core/schema/bodies/editorial-voice-v1.js';
import { visualStandardBodySchema } from '../../packages/core/schema/bodies/visual-standard-v1.js';
import { productBodySchema } from '../../packages/core/schema/bodies/product-v1.js';
import { trackingConfigBodySchema } from '../../packages/core/schema/bodies/tracking-config-v1.js';
import { patchOpSchema, patchOpNamesByObjectType } from '../../packages/core/schema/object-patch-ops.js';
import {
  objectTypes,
  type ObjectRecord,
  type ObjectType,
  type Principal,
} from '../../packages/core/schema/object-record-v1.js';
import { siteBody } from '../../sites/drlurie/seeds/site-seed-data.mjs';

const ACTOR: Principal = { kind: 'agent', agent_name: 'tracking-test', auth: 'publish_key' };
const AT = '2026-07-19T00:00:00.000Z';

const record = (objectType: ObjectType, body: unknown): ObjectRecord<unknown> => ({
  object_id: `obj_${objectType}`,
  object_type: objectType,
  schema_version: `${objectType}.v1`,
  site: 'site_drlurie',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body,
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

const apply = (objectType: ObjectType, body: unknown, ops: unknown[]) =>
  applyPatchOps(record(objectType, deepClone(body)), ops, { actor: ACTOR, at: AT });

const deepClone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const TRACKING = {
  enabled: true,
  label: 'Q3 push',
  tags: ['push'],
  goals: [{ goal: 'opt_in', on: 'form_submit', provider_conversions: [{ provider: 'google_ads', label: 'AbCd-123' }] }],
};

// Minimal schema-valid bodies for every governed type (apply-engine tests only
// need shape, not the full validation pipeline).
const minimalNav = {
  role: 'header',
  groups: [{ id: 'g_main', items: [{ id: 'i_home', label: 'Home', target: { kind: 'route', href: '/' } }] }],
};
const heroInstance = { id: 's_hero1', type: 'hero', data: { heading: 'Hi', actions: [] } };
const BODIES: Record<ObjectType, { schema: { safeParse: (v: unknown) => { success: boolean } }; body: unknown }> = {
  page: {
    schema: pageBodySchema,
    body: { route: '/x', pageType: 'standard', title: 'X', seo: {}, sections: [heroInstance] },
  },
  section: { schema: sectionBodySchema, body: { section: heroInstance } },
  navigation: { schema: navigationBodySchema, body: minimalNav },
  taxonomy: { schema: taxonomyBodySchema, body: { kinds: { category: { terms: [] }, tag: { terms: [] } } } },
  site: { schema: siteBodySchema, body: deepClone(siteBody) },
  template: { schema: templateBodySchema, body: { name: 'T', appliesTo: ['standard'], slots: [] } },
  section_template: { schema: sectionTemplateBodySchema, body: { name: 'S', blueprint: heroInstance } },
  theme: {
    schema: themeBodySchema,
    body: { name: 'Th', tokens: { colors: { primary: '#112233' }, fonts: { sans: 'A', serif: 'B', heading: 'C' } } },
  },
  product: {
    schema: productBodySchema,
    body: null, // resolved below — the product shape is bigger; parse-only test skips apply-shape needs
  },
  content_item: {
    schema: contentItemBodySchema,
    body: { slug: 'x', title: 'X', nodes: [{ id: 'n_a1', kind: 'content', public: { body: 'Hello.' } }] },
  },
  // tracking_config does NOT carry the attribute (schema-level) and does not
  // get set_tracking — covered by its own T13.2 test set.
  tracking_config: { schema: trackingConfigBodySchema, body: null },
  // editorial_voice likewise carries no tracking attribute (D1): a voice is
  // authoring law, never a tracked surface. Covered by editorial-voice.test.ts.
  editorial_voice: { schema: editorialVoiceBodySchema, body: null },
  // visual_standard likewise carries no tracking attribute (brand-imagery
  // wave, BRIEF.md §3.1): a mood board is never a reader-facing surface.
  // Covered by visual-standard.test.ts.
  visual_standard: { schema: visualStandardBodySchema, body: null },
};

test('the tracking shape parses on every attribute-carrying body; bodies without it still parse (additive guarantee)', () => {
  for (const objectType of objectTypes) {
    const fixture = BODIES[objectType];
    if (fixture.body === null) continue; // product: covered by the schema-level parse below
    assert.ok(fixture.schema.safeParse(fixture.body).success, `${objectType}: pre-W13 body parses`);
    const withTracking = { ...(fixture.body as Record<string, unknown>), tracking: TRACKING };
    assert.ok(fixture.schema.safeParse(withTracking).success, `${objectType}: body + tracking parses`);
    const withBadTracking = { ...(fixture.body as Record<string, unknown>), tracking: { enabled: 'yes' } };
    assert.ok(!fixture.schema.safeParse(withBadTracking).success, `${objectType}: bad tracking rejects`);
  }
  // product: the tracking key itself is schema-checked via the shared shape.
  assert.ok(trackingAttributeSchema.safeParse(TRACKING).success);
  assert.ok(!trackingAttributeSchema.safeParse({ goals: [{ goal: 'Bad Key!' }] }).success, 'goal slugs are bounded');
  assert.ok(
    !trackingAttributeSchema.safeParse({
      goals: [{ goal: 'ok_goal', provider_conversions: [{ provider: 'gtm', label: 'AbCd' }] }],
    }).success,
    'GTM is not a provider (permanently OUT per OQ-W13-3)'
  );
});

test('set_tracking is allowlisted on every attribute-carrying type — and NOT on the two that carry no attribute', () => {
  // tracking_config is the registry the attribute's goals resolve against;
  // editorial_voice (D1) is authoring law and never a tracked surface. Both
  // omit the attribute at the schema level, so allowlisting set_tracking there
  // would be a false promise.
  for (const objectType of objectTypes) {
    const allowed = (patchOpNamesByObjectType[objectType] as readonly string[]).includes('set_tracking');
    if (!carriesTrackingAttribute(objectType)) {
      assert.equal(allowed, false, `${objectType} does not carry the attribute`);
    } else {
      assert.ok(allowed, `${objectType} allows set_tracking`);
    }
  }
});

test('apply + exact inverse on every type: first-set inverts to removal', () => {
  for (const objectType of objectTypes.filter(carriesTrackingAttribute)) {
    const body = { plain: 'body' }; // engine is shape-agnostic; schema gating is the verb layer's job
    const forward = apply(objectType, body, [{ op: 'set_tracking', fields: TRACKING }]);
    const applied = forward.record.body as Record<string, unknown>;
    assert.ok(deepEqualJson(applied.tracking, TRACKING), `${objectType}: tracking set`);

    const entry = forward.record.history.at(-1)!;
    const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
    assert.equal((inverse as { fields: unknown }).fields, null, `${objectType}: first-set inverse is removal`);
    const reverted = applyPatchOps(forward.record, [inverse], { actor: ACTOR, at: AT }).record.body;
    assert.ok(deepEqualJson(reverted, body), `${objectType}: inverse restores the bare body exactly`);
  }
});

test('removal inverts to full restore; merge inverts per-key (added keys unset, changed keys restored)', () => {
  const start = { plain: 'body', tracking: deepClone(TRACKING) };

  // Removal → restore.
  const removed = apply('page', start, [{ op: 'set_tracking', fields: null }]);
  assert.ok(!('tracking' in (removed.record.body as Record<string, unknown>)));
  const removalEntry = removed.record.history.at(-1)!;
  const restore = derivePatchInverse(
    removalEntry.details!.op as never,
    removalEntry.details!.capture as PatchOpCapture
  );
  const restored = applyPatchOps(removed.record, [restore], { actor: ACTOR, at: AT }).record.body;
  assert.ok(deepEqualJson(restored, start), 'removal inverse restores the whole block byte-exactly');

  // Merge: change one key, add one key, replace the goals array.
  const merged = apply('page', start, [
    { op: 'set_tracking', fields: { label: 'renamed', enabled: false, goals: [{ goal: 'buy_click', on: 'view' }] } },
  ]);
  const mergedTracking = (merged.record.body as { tracking: Record<string, unknown> }).tracking;
  assert.equal(mergedTracking.label, 'renamed');
  assert.equal(mergedTracking.enabled, false);
  assert.ok(deepEqualJson(mergedTracking.tags, ['push']), 'untouched keys survive the merge');
  const mergeEntry = merged.record.history.at(-1)!;
  const mergeInverse = derivePatchInverse(
    mergeEntry.details!.op as never,
    mergeEntry.details!.capture as PatchOpCapture
  );
  const back = applyPatchOps(merged.record, [mergeInverse], { actor: ACTOR, at: AT }).record.body;
  assert.ok(deepEqualJson(back, start), 'merge inverse restores exactly');

  // Null-inside-fields unsets one key.
  const unset = apply('page', start, [{ op: 'set_tracking', fields: { label: null } }]);
  const unsetTracking = (unset.record.body as { tracking: Record<string, unknown> }).tracking;
  assert.ok(!('label' in unsetTracking));
  const unsetEntry = unset.record.history.at(-1)!;
  const unsetInverse = derivePatchInverse(
    unsetEntry.details!.op as never,
    unsetEntry.details!.capture as PatchOpCapture
  );
  const unsetBack = applyPatchOps(unset.record, [unsetInverse], { actor: ACTOR, at: AT }).record.body;
  assert.ok(deepEqualJson(unsetBack, start), 'key-unset inverse restores exactly');
});

test('the one-writer funnel: all seven open fields ops refuse the tracking key', () => {
  const cases: [string, Record<string, unknown>][] = [
    ['set_page_meta', {}],
    ['set_article_meta', {}],
    ['set_site_fields', {}],
    ['set_template_meta', {}],
    ['set_section_template_meta', {}],
    ['set_theme_fields', {}],
    ['set_product_fields', {}],
  ];
  for (const [op, extra] of cases) {
    const parsed = patchOpSchema.safeParse({ op, fields: { tracking: { enabled: false } }, ...extra });
    assert.ok(!parsed.success, `${op} must refuse 'tracking'`);
    const message = JSON.stringify(parsed.success ? '' : parsed.error.issues);
    assert.ok(message.includes('set_tracking'), `${op} refusal names the funnel`);
    const clean = patchOpSchema.safeParse({ op, fields: { someOtherField: 'x' }, ...extra });
    assert.ok(clean.success, `${op} still accepts non-tracking fields`);
  }
});

test('validation criterion: valid goals complete; non-collectable activity warns at draft, blocks at publish', () => {
  const ctx = {};
  const bodyWith = (tracking: unknown) => ({ section: heroInstance, tracking });

  const good = checkStructuralInvariants(
    'section',
    'sec_x',
    bodyWith({ goals: [{ goal: 'cta_goal', on: 'cta_click' }] }),
    ctx,
    false
  ).find((criterion) => criterion.id === 'tracking_attribute');
  assert.equal(good?.status, 'complete');

  // buy_click is not collectable on a section (§6 matrix).
  const draft = checkStructuralInvariants(
    'section',
    'sec_x',
    bodyWith({ goals: [{ goal: 'g_one', on: 'buy_click' }] }),
    ctx,
    false
  ).find((criterion) => criterion.id === 'tracking_attribute');
  assert.equal(draft?.status, 'warning');
  assert.match(draft!.message, /not collectable/);

  const publish = checkStructuralInvariants(
    'section',
    'sec_x',
    bodyWith({ goals: [{ goal: 'g_one', on: 'buy_click' }] }),
    ctx,
    true
  ).find((criterion) => criterion.id === 'tracking_attribute');
  assert.equal(publish?.status, 'missing');

  // Recipe types have NO collectable activities — any bound goal blocks at publish.
  const theme = checkStructuralInvariants(
    'theme',
    'thm_x',
    {
      name: 'T',
      tokens: { colors: {}, fonts: { sans: 'A', serif: 'B', heading: 'C' } },
      tracking: { goals: [{ goal: 'g_x', on: 'view' }] },
    },
    ctx,
    true
  ).find((criterion) => criterion.id === 'tracking_attribute');
  assert.equal(theme?.status, 'missing');
  assert.match(theme!.message, /no reader events/);

  // No tracking block → the criterion stays silent (absence is fine).
  const absent = checkStructuralInvariants('section', 'sec_x', { section: heroInstance }, ctx, true).find(
    (criterion) => criterion.id === 'tracking_attribute'
  );
  assert.equal(absent, undefined);

  // The matrix table covers EVERY governed type (renderer + validation share
  // it) — including the exempt ones, which map to [] rather than being absent.
  for (const objectType of objectTypes) {
    assert.ok(objectType in TRACKABLE_ACTIVITIES_BY_TYPE, `matrix covers ${objectType}`);
  }
});

test('the contract lists set_tracking on every attribute-carrying type and carries the funnel constraint', () => {
  for (const objectType of objectTypes.filter(carriesTrackingAttribute)) {
    const contract = buildObjectContract(objectType) as unknown as {
      patch_ops: { op: string }[];
      constraints: { id: string; description: string }[];
    };
    assert.ok(
      contract.patch_ops.some((entry) => entry.op === 'set_tracking'),
      `${objectType} contract lists set_tracking`
    );
    const constraint = contract.constraints.find((entry) => entry.id === 'tracking_attribute');
    assert.ok(constraint, `${objectType} carries the tracking constraint`);
    assert.match(constraint!.description, /one-writer funnel/);
  }
});
