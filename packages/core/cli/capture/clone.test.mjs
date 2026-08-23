import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CloneError,
  buildCloneIntake,
  buildCloneRunReport,
  buildRecipeMintPlan,
  buildRestampOps,
  buildThemeApplyPlan,
  validateSectionTemplateDesign,
  validateTemplateDesign,
  validateThemeProposal,
} from './clone.mjs';

// ─── shared fixtures ──────────────────────────────────────────────────────────────────────────────

const HERO_DATA_SCHEMA = {
  type: 'object',
  properties: {
    heading: { type: 'string' },
    body: { type: 'string' },
    tone: { enum: ['light', 'dark'] },
  },
  required: ['heading'],
  additionalProperties: false,
};

const FAQ_DATA_SCHEMA = {
  type: 'object',
  properties: {
    heading: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { q: { type: 'string' }, a: { type: 'string' } },
        required: ['q', 'a'],
        additionalProperties: false,
      },
    },
  },
  required: ['items'],
  additionalProperties: false,
};

function componentRegistry() {
  return {
    registry: 'component',
    definitions: [
      { type: 'hero', component_bound: true, data_schema: HERO_DATA_SCHEMA },
      { type: 'faq', component_bound: true, data_schema: FAQ_DATA_SCHEMA },
    ],
  };
}

function pageTypeRegistry() {
  return {
    registry: 'page_type',
    definitions: [
      { id: 'clone', routePattern: '/**', allowedSections: 'any', requiredSections: [] },
      { id: 'home', routePattern: '/', allowedSections: ['hero'], requiredSections: ['hero'] },
    ],
  };
}

function mapping({ pages } = {}) {
  return {
    schemaVersion: 'capture-map.v1',
    generatedAt: '2026-08-01T00:00:00.000Z',
    pages: pages ?? [
      {
        pageRef: 'page_home',
        sourceUrl: 'https://example.com/',
        pageBody: {
          route: '/',
          pageType: 'clone',
          title: 'Home',
          sections: [{ id: 's_hero01', type: 'hero', data: { heading: 'Welcome', body: '<p>Hi</p>' } }],
        },
        candidates: [{ candidateId: 'candidate_hero01', sectionType: 'hero' }],
        gaps: [],
      },
    ],
    navigationCandidates: [],
  };
}

function emissionReport({ createdPageObjectId = 'page_capture_abc123' } = {}) {
  return {
    target: 'fixture-target',
    creates: [
      {
        kind: 'page',
        objectType: 'page',
        requestedId: createdPageObjectId,
        body: { route: '/' },
        pageRef: 'page_home',
      },
    ],
    createdObjects: [{ objectType: 'page', objectId: createdPageObjectId, draftVerified: true }],
    reusedObjects: [],
    quarantines: [],
  };
}

function inventory({ activeSites = 1 } = {}) {
  const site = Array.from({ length: activeSites }, (_, index) => ({
    object_id: `site_${index}`,
    object_type: 'site',
    status: 'active',
  }));
  return { page: [], template: [], section_template: [], theme: [], navigation: [], site };
}

function baseIntakeArgs(overrides = {}) {
  return {
    captureRunId: 'run_abc',
    target: 'fixture-target',
    snapshot: { schemaVersion: 'snapshot.v1', pages: [] },
    mapping: mapping(),
    theme: { name: 'Captured theme', tokens: { colors: {}, fonts: {} } },
    emissionReport: emissionReport(),
    inventory: inventory(),
    componentRegistry: componentRegistry(),
    pageTypeRegistry: pageTypeRegistry(),
    policy: { rights: { content: 'retain_allowed_origin_content', media: 'prohibited' } },
    ...overrides,
  };
}

function siteBodyFixture() {
  return {
    name: 'Fixture Site',
    brandTokens: {
      colors: { primary: 'rgb(46 111 149)', secondary: 'rgb(37 90 120)', accent: '#5e8c8a' },
      fonts: { sans: "'Inter Variable', system-ui", serif: 'Georgia, serif', heading: 'Playfair Display, serif' },
      layout: { containerWidth: 'default' },
      shape: { radius: 'round' },
    },
  };
}

// ─── 1. buildCloneIntake ──────────────────────────────────────────────────────────────────────────

test('buildCloneIntake assembles the envelope and never mutates its arguments', () => {
  const args = baseIntakeArgs();
  const pristineMapping = JSON.parse(JSON.stringify(args.mapping));
  const pristineInventory = JSON.parse(JSON.stringify(args.inventory));

  const intake = buildCloneIntake(args);

  assert.equal(intake.schemaVersion, 'clone-intake.v1');
  assert.equal(intake.captureRunId, 'run_abc');
  assert.equal(intake.target, 'fixture-target');
  assert.deepEqual(intake.source.mapping, args.mapping);
  assert.deepEqual(intake.emitted.pages, [
    { pageRef: 'page_home', objectId: 'page_capture_abc123', route: '/', sectionTypes: ['hero'] },
  ]);
  assert.deepEqual(intake.inventory.site, { object_id: 'site_0', object_type: 'site', status: 'active' });
  assert.deepEqual(intake.registry.sectionTypes, { hero: HERO_DATA_SCHEMA, faq: FAQ_DATA_SCHEMA });
  assert.deepEqual(intake.registry.pageTypes.clone, { allowed: 'any', required: [] });
  assert.deepEqual(intake.registry.pageTypes.home, { allowed: ['hero'], required: ['hero'] });

  // Deep clone, not a reference: mutating the caller's own objects after the call must not reach back
  // into the returned intake, and the arguments themselves must read exactly as they did going in.
  intake.source.mapping.pages[0].pageBody.title = 'MUTATED';
  assert.equal(args.mapping.pages[0].pageBody.title, 'Home');
  assert.deepEqual(args.mapping, pristineMapping);
  assert.deepEqual(args.inventory, pristineInventory);
});

test('buildCloneIntake drops a page that emission never actually wrote (quarantined)', () => {
  const args = baseIntakeArgs({
    emissionReport: {
      target: 'fixture-target',
      creates: emissionReport().creates,
      createdObjects: [],
      reusedObjects: [],
      quarantines: [{ reason: 'validation_or_create_failed' }],
    },
  });
  const intake = buildCloneIntake(args);
  assert.deepEqual(intake.emitted.pages, []);
});

test('buildCloneIntake correlates a REUSED page by route, not by requestedId', () => {
  const args = baseIntakeArgs({
    emissionReport: {
      target: 'fixture-target',
      creates: emissionReport().creates,
      createdObjects: [],
      reusedObjects: [{ objectType: 'page', objectId: 'page_existing_home', route: '/', mode: 'patched' }],
      quarantines: [],
    },
  });
  const intake = buildCloneIntake(args);
  assert.deepEqual(intake.emitted.pages, [
    { pageRef: 'page_home', objectId: 'page_existing_home', route: '/', sectionTypes: ['hero'] },
  ]);
});

test('buildCloneIntake throws CloneError for a non capture-map.v1 mapping', () => {
  assert.throws(
    () => buildCloneIntake(baseIntakeArgs({ mapping: { schemaVersion: 'other.v1', pages: [] } })),
    CloneError
  );
});

test('buildCloneIntake throws CloneError for an empty component registry', () => {
  assert.throws(() => buildCloneIntake(baseIntakeArgs({ componentRegistry: { definitions: [] } })), CloneError);
});

test('buildCloneIntake throws CloneError when inventory has zero active sites', () => {
  assert.throws(() => buildCloneIntake(baseIntakeArgs({ inventory: inventory({ activeSites: 0 }) })), CloneError);
});

test('buildCloneIntake throws CloneError when inventory has more than one active site', () => {
  assert.throws(() => buildCloneIntake(baseIntakeArgs({ inventory: inventory({ activeSites: 2 }) })), CloneError);
});

// ─── 2. validateSectionTemplateDesign / validateTemplateDesign ───────────────────────────────────

function intakeFixture(overrides = {}) {
  return buildCloneIntake(baseIntakeArgs(overrides));
}

test('validateSectionTemplateDesign accepts a legal design and normalizes it', () => {
  const intake = intakeFixture();
  const design = { name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.scope, 'one_off');
  assert.match(result.normalized.blueprint.id, /^s_[a-z0-9]+$/);
  // Never mutates the caller's design object.
  assert.equal(design.blueprint.id, undefined);
});

test('validateSectionTemplateDesign REJECTS unknown_section_type', () => {
  const intake = intakeFixture();
  const design = { name: 'Ghost recipe', blueprint: { type: 'pricing_table', data: {} } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.deepEqual(result.ok, false);
  assert.equal(result.reason, 'unknown_section_type');
});

test('validateSectionTemplateDesign REJECTS blueprint_schema_mismatch for a missing required key', () => {
  const intake = intakeFixture();
  const design = { name: 'Headless hero', blueprint: { type: 'hero', data: { body: '<p>no heading</p>' } } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.reason, 'blueprint_schema_mismatch');
  assert.ok(result.detail.some((line) => line.includes('heading')));
});

test('validateSectionTemplateDesign REJECTS blueprint_schema_mismatch for an unknown key', () => {
  const intake = intakeFixture();
  const design = { name: 'Overstuffed hero', blueprint: { type: 'hero', data: { heading: 'Hi', extra: 'nope' } } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.reason, 'blueprint_schema_mismatch');
  assert.ok(result.detail.some((line) => line.includes('extra')));
});

test('validateSectionTemplateDesign REJECTS blueprint_schema_mismatch for an illegal enum member', () => {
  const intake = intakeFixture();
  const design = { name: 'Off-tone hero', blueprint: { type: 'hero', data: { heading: 'Hi', tone: 'ultraviolet' } } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.reason, 'blueprint_schema_mismatch');
  assert.ok(result.detail.some((line) => line.includes('ultraviolet')));
});

test('validateSectionTemplateDesign REJECTS name_collision against an existing recipe', () => {
  const intake = intakeFixture({
    inventory: {
      ...inventory(),
      section_template: [{ object_id: 'stpl_existing', recipe_summary: { name: 'Captured hero recipe' } }],
    },
  });
  const design = { name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.reason, 'name_collision');
});

test('validateSectionTemplateDesign throws CloneError for a design with no name', () => {
  const intake = intakeFixture();
  assert.throws(() => validateSectionTemplateDesign({ blueprint: { type: 'hero', data: {} } }, intake), CloneError);
});

test('validateTemplateDesign accepts a legal design covering a required section', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Home template',
    appliesTo: ['home'],
    slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.slots[0].slotId, 'hero_slot');
});

test('validateTemplateDesign REJECTS unknown_section_type on a slot', () => {
  const intake = intakeFixture();
  const design = { name: 'Ghost template', appliesTo: ['clone'], slots: [{ sectionType: 'pricing_table' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'unknown_section_type');
});

test('validateTemplateDesign REJECTS slot_section_type_not_allowed', () => {
  const intake = intakeFixture();
  const design = { name: 'FAQ-on-home template', appliesTo: ['home'], slots: [{ sectionType: 'faq' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'slot_section_type_not_allowed');
});

test('validateTemplateDesign REJECTS required_section_not_covered', () => {
  const intake = intakeFixture({
    pageTypeRegistry: {
      definitions: [{ id: 'home', routePattern: '/', allowedSections: ['hero', 'faq'], requiredSections: ['hero'] }],
    },
  });
  const design = { name: 'Home template without a hero', appliesTo: ['home'], slots: [{ sectionType: 'faq' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'required_section_not_covered');
});

test('validateTemplateDesign REJECTS applies_to_page_type_missing', () => {
  const intake = intakeFixture();
  const design = { name: 'Nowhere template', appliesTo: ['landing'], slots: [{ sectionType: 'hero' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'applies_to_page_type_missing');
});

test('validateTemplateDesign REJECTS name_collision against an existing template', () => {
  const intake = intakeFixture({
    inventory: { ...inventory(), template: [{ object_id: 'tpl_existing', body: { name: 'Home template' } }] },
  });
  const design = { name: 'Home template', appliesTo: ['clone'], slots: [{ sectionType: 'hero' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'name_collision');
});

// ─── 3. buildRecipeMintPlan ───────────────────────────────────────────────────────────────────────

test('buildRecipeMintPlan mints idempotent requestedIds for the same target+name across two calls', () => {
  const intake = intakeFixture();
  const design = {
    sectionTemplates: [{ name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } }],
  };
  const first = buildRecipeMintPlan({ intake, design });
  const second = buildRecipeMintPlan({ intake, design });
  assert.equal(first.creates[0].requestedId, second.creates[0].requestedId);
  assert.match(first.creates[0].requestedId, /^stpl_clone_[0-9a-f]{12}$/);
  assert.equal(first.creates[0].verb, 'object_create');
  assert.equal(first.creates[0].objectType, 'section_template');
});

test('buildRecipeMintPlan mints a different requestedId for a different target (idempotency is per target)', () => {
  const design = {
    sectionTemplates: [{ name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } }],
  };
  const planA = buildRecipeMintPlan({ intake: intakeFixture({ target: 'target-a' }), design });
  const planB = buildRecipeMintPlan({ intake: intakeFixture({ target: 'target-b' }), design });
  assert.notEqual(planA.creates[0].requestedId, planB.creates[0].requestedId);
});

test('buildRecipeMintPlan records a rejected design with its reason and detail', () => {
  const intake = intakeFixture();
  const design = { sectionTemplates: [{ name: 'Ghost recipe', blueprint: { type: 'pricing_table', data: {} } }] };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.rejected, [
    {
      kind: 'section_template',
      name: 'Ghost recipe',
      reason: 'unknown_section_type',
      detail: '"pricing_table" is not in the live component registry',
    },
  ]);
});

test('buildRecipeMintPlan records a name collision as REUSED, not rejected', () => {
  const intake = intakeFixture({
    inventory: {
      ...inventory(),
      section_template: [{ object_id: 'stpl_existing', recipe_summary: { name: 'Captured hero recipe' } }],
    },
  });
  const design = {
    sectionTemplates: [{ name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } }],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates.length, 0);
  assert.equal(plan.rejected.length, 0);
  assert.deepEqual(plan.reused, [
    { objectType: 'section_template', name: 'Captured hero recipe', objectId: 'stpl_existing' },
  ]);
});

test('buildRecipeMintPlan carries sourceCandidateIds through onto both creates and rejected', () => {
  const intake = intakeFixture();
  const design = {
    sectionTemplates: [
      {
        name: 'Captured hero recipe',
        blueprint: { type: 'hero', data: { heading: 'Welcome' } },
        sourceCandidateIds: ['candidate_hero01'],
      },
      {
        name: 'Ghost recipe',
        blueprint: { type: 'pricing_table', data: {} },
        sourceCandidateIds: ['candidate_ghost01'],
      },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.deepEqual(plan.creates[0].sourceCandidateIds, ['candidate_hero01']);
  assert.deepEqual(plan.rejected[0].sourceCandidateIds, ['candidate_ghost01']);
});

test('buildRecipeMintPlan does not abort the batch on one malformed design', () => {
  const intake = intakeFixture();
  const design = {
    sectionTemplates: [
      { blueprint: { type: 'hero', data: { heading: 'No name here' } } }, // malformed: no name
      { name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].reason, 'malformed_design');
});

test('buildRecipeMintPlan builds a template body with each slot widened to an allowed[] array', () => {
  const intake = intakeFixture();
  const design = {
    templates: [
      {
        name: 'Home template',
        appliesTo: ['home'],
        slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
      },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates[0].objectType, 'template');
  assert.deepEqual(plan.creates[0].body.slots, [
    { slotId: 'hero_slot', allowed: ['hero'], required: true, repeatable: false },
  ]);
});

test('buildRecipeMintPlan exposes the same forbiddenVerbs set emit.mjs uses', () => {
  const plan = buildRecipeMintPlan({ intake: intakeFixture(), design: {} });
  assert.deepEqual(plan.forbiddenVerbs, ['deploy', 'object_publish', 'release_to_production', 'trigger_netlify_build']);
});

// ─── 4. validateThemeProposal / buildThemeApplyPlan ───────────────────────────────────────────────

test('validateThemeProposal applies legal tokens and names the still-uncovered color slots', () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#204060' }, fonts: { sans: "'New Sans', system-ui" } },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.applied, { colors: { primary: '#204060' }, fonts: { sans: "'New Sans', system-ui" } });
  assert.deepEqual(result.dropped, []);
  // `secondary` and `accent` are legal site color slots the proposal never mentioned — TOTALITY
  // (site_apply_theme's exact-replace semantics) means they would be DELETED if this proposal were
  // applied as-is, so they are named here regardless of the fact that nothing about them "dropped".
  assert.deepEqual(result.missingKeys, ['accent', 'secondary']);
});

test('validateThemeProposal DROPS unknown_slot', () => {
  const result = validateThemeProposal({
    proposal: { colors: { tertiary: '#204060', primary: '#204060' } },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.dropped, [{ slot: 'tertiary', value: '#204060', reason: 'unknown_slot' }]);
  assert.deepEqual(result.applied.colors, { primary: '#204060' });
});

test('validateThemeProposal DROPS external_reference_forbidden for url() and @import', () => {
  // A legal `secondary` color rides along so the proposal is not a TOTAL drop (covered separately
  // below) — this test isolates the external-reference rule itself.
  const result = validateThemeProposal({
    proposal: {
      colors: { primary: 'url(https://evil.example/bg.png)', secondary: '#204060' },
      fonts: { sans: "@import url('https://evil.example/f.css')" },
    },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.dropped.map((d) => d.reason).sort(), [
    'external_reference_forbidden',
    'external_reference_forbidden',
  ]);
  assert.deepEqual(result.applied.colors, { secondary: '#204060' });
});

test('validateThemeProposal DROPS not_a_color', () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: 'kind of blueish', secondary: '#204060' } },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.dropped, [{ slot: 'primary', value: 'kind of blueish', reason: 'not_a_color' }]);
});

test('validateThemeProposal DROPS no_fallback_stack for a single named family', () => {
  const result = validateThemeProposal({
    proposal: { fonts: { sans: 'Helvetica Neue', serif: 'Georgia, serif' } },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.dropped, [{ slot: 'sans', value: 'Helvetica Neue', reason: 'no_fallback_stack' }]);
});

test('validateThemeProposal accepts a single GENERIC font family with no further fallback', () => {
  const result = validateThemeProposal({ proposal: { fonts: { sans: 'serif' } }, siteBody: siteBodyFixture() });
  assert.deepEqual(result.applied.fonts, { sans: 'serif' });
});

test('validateThemeProposal THROWS CloneError when every proposed token drops', () => {
  assert.throws(
    () =>
      validateThemeProposal({ proposal: { colors: { primary: 'not a color at all' } }, siteBody: siteBodyFixture() }),
    CloneError
  );
});

test('validateThemeProposal does not throw on a genuinely empty proposal, but still names every color slot as missing', () => {
  const result = validateThemeProposal({ proposal: {}, siteBody: siteBodyFixture() });
  assert.deepEqual(result, {
    applied: { colors: {}, fonts: {} },
    dropped: [],
    missingKeys: ['accent', 'primary', 'secondary'],
  });
});

test('validateThemeProposal returns an empty missingKeys when every site color slot is covered', () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#111111', secondary: '#222222', accent: '#333333' } },
    siteBody: siteBodyFixture(),
  });
  assert.deepEqual(result.missingKeys, []);
});

// A theme/site record pair for buildThemeApplyPlan. Shape is deliberately minimal — this function
// only reads `isPlainObject(siteRecord/themeRecord)` as a presence guard; it never inspects their
// fields (see the "no backfill" test below), so the fixture just has to exist.
function siteRecordFixture() {
  return { object_id: 'site_0', record_version: 4, body: siteBodyFixture() };
}
function themeRecordFixture() {
  return {
    object_id: 'thm_captured',
    record_version: 1,
    body: { name: 'Captured theme', tokens: { colors: {}, fonts: {} } },
  };
}

test('buildThemeApplyPlan builds the paired checkout/patch/checkin -> checkout/dry-run/apply/checkin plan when the theme is total', () => {
  const applied = {
    colors: { primary: '#111111', secondary: '#222222', accent: '#333333' },
    fonts: { sans: "'New Sans', system-ui" },
  };
  const plan = buildThemeApplyPlan({
    siteId: 'site_0',
    themeId: 'thm_captured',
    siteRecord: siteRecordFixture(),
    themeRecord: themeRecordFixture(),
    applied,
    missingKeys: [], // every color slot covered — see the totality test above
  });

  assert.equal(plan.schemaVersion, 'clone-theme-apply.v1');
  assert.equal(plan.siteId, 'site_0');
  assert.equal(plan.themeId, 'thm_captured');
  assert.equal(plan.refusal, null);
  assert.deepEqual(
    plan.steps.map((step) => step.verb),
    [
      'object_checkout',
      'object_patch',
      'object_checkin',
      'object_checkout',
      'site_apply_theme',
      'site_apply_theme',
      'object_checkin',
    ]
  );

  const [themeCheckout, themePatch, themeCheckin, siteCheckout, dryRun, liveRun, siteCheckin] = plan.steps;
  assert.deepEqual(themeCheckout.arguments, { object_type: 'theme', object_id: 'thm_captured' });
  assert.equal(themePatch.arguments.object_type, 'theme');
  assert.equal(themePatch.arguments.object_id, 'thm_captured');
  assert.ok(themePatch.arguments.lock_token);
  assert.ok(themePatch.arguments.expected_record_version);
  // MERGE, not replace: `set_theme_fields` is the `set_site_fields` merge idiom, so the patch carries
  // only the tokens `applied` actually names — never the theme record's other, untouched fields.
  assert.deepEqual(themePatch.arguments.ops, [{ op: 'set_theme_fields', fields: { tokens: applied } }]);
  assert.equal(themeCheckin.arguments.object_type, 'theme');
  assert.equal(themeCheckin.arguments.lock_token, themePatch.arguments.lock_token);

  assert.deepEqual(siteCheckout.arguments, { object_type: 'site', object_id: 'site_0' });
  assert.deepEqual(dryRun.arguments, { site_id: 'site_0', theme_id: 'thm_captured', dry_run: true });
  assert.equal(dryRun.arguments.lock_token, undefined);
  assert.equal(liveRun.arguments.dry_run, false);
  assert.equal(liveRun.arguments.site_id, 'site_0');
  assert.equal(liveRun.arguments.theme_id, 'thm_captured');
  assert.ok(liveRun.arguments.lock_token);
  assert.ok(liveRun.arguments.expected_record_version);
  assert.equal(siteCheckin.arguments.object_type, 'site');
  assert.equal(siteCheckin.arguments.lock_token, liveRun.arguments.lock_token);

  // No step anywhere constructs the privileged op directly — the ONLY sanctioned palette writer this
  // plan ever calls is the `site_apply_theme` verb itself.
  const opsEverywhere = plan.steps.flatMap((step) => step.arguments.ops ?? []);
  assert.ok(opsEverywhere.every((op) => op.op !== 'set_site_brand_tokens'));
  assert.deepEqual(
    opsEverywhere.map((op) => op.op),
    ['set_theme_fields']
  );
});

test('buildThemeApplyPlan REFUSES theme_not_total and emits NO steps when the palette is incomplete', () => {
  const missingKeys = ['accent', 'secondary'];
  const plan = buildThemeApplyPlan({
    siteId: 'site_0',
    themeId: 'thm_captured',
    // The site and theme records BOTH already carry a value for `accent`/`secondary` — proving the
    // refusal below is not "there was nothing to copy", and that this function does not reach into
    // either record to invent the missing colors itself.
    siteRecord: siteRecordFixture(),
    themeRecord: themeRecordFixture(),
    applied: { colors: { primary: '#111111' }, fonts: {} },
    missingKeys,
  });
  assert.deepEqual(plan.refusal, { reason: 'theme_not_total', detail: { missingKeys } });
  assert.deepEqual(plan.steps, []);
});

test('buildThemeApplyPlan throws CloneError when siteId, themeId, siteRecord or themeRecord is missing', () => {
  const args = {
    siteId: 'site_0',
    themeId: 'thm_captured',
    siteRecord: siteRecordFixture(),
    themeRecord: themeRecordFixture(),
    applied: { colors: {}, fonts: {} },
    missingKeys: [],
  };
  assert.throws(() => buildThemeApplyPlan({ ...args, siteId: undefined }), CloneError);
  assert.throws(() => buildThemeApplyPlan({ ...args, themeId: undefined }), CloneError);
  assert.throws(() => buildThemeApplyPlan({ ...args, siteRecord: undefined }), CloneError);
  assert.throws(() => buildThemeApplyPlan({ ...args, themeRecord: undefined }), CloneError);
});

// ─── 5. buildRestampOps ───────────────────────────────────────────────────────────────────────────

function restampIntake(overrides = {}) {
  return buildCloneIntake(baseIntakeArgs(overrides));
}

test('buildRestampOps carries an already-bound first-party asset src through byte-identical', () => {
  const boundSrc = '/img/req_capture_fixture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg';
  const intake = restampIntake({
    mapping: mapping({
      pages: [
        {
          pageRef: 'page_home',
          sourceUrl: 'https://example.com/',
          pageBody: {
            route: '/',
            pageType: 'clone',
            title: 'Home',
            sections: [
              { id: 's_media01', type: 'media', data: { items: [{ kind: 'image', src: boundSrc, alt: 'A photo' }] } },
            ],
          },
          candidates: [{ candidateId: 'candidate_media01', sectionType: 'media' }],
          gaps: [],
        },
      ],
    }),
  });
  const mintReport = { rejected: [] };
  const result = buildRestampOps({ intake, mintReport });
  assert.equal(result.skipped.length, 0);
  assert.equal(result.restamp.length, 1);
  assert.equal(result.restamp[0].objectId, 'page_capture_abc123');
  assert.deepEqual(result.restamp[0].ops, [
    {
      op: 'upsert_section',
      position: 0,
      section: { id: 's_media01', type: 'media', data: { items: [{ kind: 'image', src: boundSrc, alt: 'A photo' }] } },
    },
  ]);
});

test('buildRestampOps SKIPS (never half-restamps) a page whose recipe was rejected at mint', () => {
  const intake = restampIntake();
  const mintReport = {
    rejected: [
      {
        kind: 'section_template',
        name: 'Captured hero recipe',
        reason: 'blueprint_schema_mismatch',
        sourceCandidateIds: ['candidate_hero01'],
      },
    ],
  };
  const result = buildRestampOps({ intake, mintReport });
  assert.deepEqual(result.restamp, []);
  assert.deepEqual(result.skipped, [{ objectId: 'page_capture_abc123', reason: 'recipe_rejected_at_mint' }]);
});

test('buildRestampOps SKIPS a page with no source mapping entry', () => {
  const intake = restampIntake();
  intake.emitted.pages.push({
    pageRef: 'page_missing',
    objectId: 'page_missing_obj',
    route: '/missing',
    sectionTypes: [],
  });
  const result = buildRestampOps({ intake, mintReport: { rejected: [] } });
  assert.ok(
    result.skipped.some((entry) => entry.objectId === 'page_missing_obj' && entry.reason === 'source_page_missing')
  );
});

test('buildRestampOps SKIPS rather than emptying a page whose captured section list is empty', () => {
  const intake = restampIntake({
    mapping: mapping({
      pages: [
        {
          pageRef: 'page_home',
          sourceUrl: 'https://example.com/',
          pageBody: { route: '/', pageType: 'clone', title: 'Home', sections: [] },
          candidates: [],
          gaps: [],
        },
      ],
    }),
  });
  const result = buildRestampOps({ intake, mintReport: { rejected: [] } });
  assert.deepEqual(result.restamp, []);
  assert.deepEqual(result.skipped, [{ objectId: 'page_capture_abc123', reason: 'would_empty_page' }]);
});

test('buildRestampOps THROWS CloneError when a section carries a remote URL in an asset field', () => {
  const intake = restampIntake({
    mapping: mapping({
      pages: [
        {
          pageRef: 'page_home',
          sourceUrl: 'https://example.com/',
          pageBody: {
            route: '/',
            pageType: 'clone',
            title: 'Home',
            sections: [
              {
                id: 's_media01',
                type: 'media',
                data: { items: [{ kind: 'image', src: 'https://evil.example/hotlink.jpg', alt: 'stolen' }] },
              },
            ],
          },
          candidates: [],
          gaps: [],
        },
      ],
    }),
  });
  assert.throws(() => buildRestampOps({ intake, mintReport: { rejected: [] } }), CloneError);
});

test('buildRestampOps THROWS CloneError for a remote URL under an *AssetRef field too', () => {
  const intake = restampIntake({
    mapping: mapping({
      pages: [
        {
          pageRef: 'page_home',
          sourceUrl: 'https://example.com/',
          pageBody: {
            route: '/',
            pageType: 'clone',
            title: 'Home',
            sections: [{ id: 's_bio01', type: 'bio', data: { portraitAssetRef: 'https://evil.example/portrait.jpg' } }],
          },
          candidates: [],
          gaps: [],
        },
      ],
    }),
  });
  assert.throws(() => buildRestampOps({ intake, mintReport: { rejected: [] } }), CloneError);
});

// ─── 6. buildCloneRunReport ───────────────────────────────────────────────────────────────────────

test('buildCloneRunReport orders the review queue site -> recipes -> pages and groups the capability backlog', () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [{ objectType: 'section_template', objectId: 'stpl_new01' }],
    rejected: [],
    reused: [],
  };
  const themeReport = { applied: { colors: { primary: '#204060' }, fonts: {} }, dropped: [] };
  const restampReport = {
    restamp: [{ objectId: 'page_capture_abc123', ops: [{ op: 'upsert_section' }] }],
    skipped: [],
  };
  const design = {
    unmetNeeds: [
      { sectionType: 'pricing_table', pageRef: 'page_home' },
      { sectionType: 'pricing_table', pageRef: 'page_other' },
      { sectionType: 'video_embed' },
    ],
  };

  const report = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design });

  assert.equal(report.schemaVersion, 'clone-run-report.v1');
  assert.deepEqual(
    report.reviewQueue.map((entry) => `${entry.objectType}:${entry.action}`),
    ['site:theme_bind', 'section_template:created', 'page:restamped']
  );
  assert.equal(report.capabilityBacklog.pricing_table.length, 2);
  assert.equal(report.capabilityBacklog.video_embed.length, 1);
  assert.deepEqual(report.humanGate, {
    publishedByThisRun: false,
    note: 'Clone runs only ever write drafts. Publishing any object this run created or changed remains a separate, human-gated decision.',
  });
});

test('buildCloneRunReport omits the site from the review queue when no theme tokens were applied', () => {
  const intake = restampIntake();
  const report = buildCloneRunReport({
    intake,
    mintReport: { createdObjects: [], rejected: [], reused: [] },
    themeReport: { applied: { colors: {}, fonts: {} }, dropped: [] },
    restampReport: { restamp: [], skipped: [] },
    design: {},
  });
  assert.deepEqual(report.reviewQueue, []);
  assert.deepEqual(report.capabilityBacklog, {});
});

test('buildCloneRunReport throws CloneError when a required prior-stage report is missing', () => {
  const intake = restampIntake();
  assert.throws(
    () =>
      buildCloneRunReport({
        intake,
        mintReport: { createdObjects: [], rejected: [], reused: [] },
        themeReport: { applied: { colors: {}, fonts: {} }, dropped: [] },
        restampReport: undefined,
        design: {},
      }),
    CloneError
  );
});
