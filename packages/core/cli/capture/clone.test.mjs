import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CLONE_INTAKE_CAP_CHARS,
  CLONE_INTAKE_TARGET_CHARS,
  CloneError,
  assertSameCompatibilityClass,
  buildCloneIntake,
  buildCloneRunReport,
  buildRecipeMintPlan,
  buildRestampOps,
  buildThemeApplyPlan,
  classOfSectionType,
  substitutionCandidatesForSectionType,
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

// ─── T13.4 PART B fixtures: a registry wide enough to exercise compatibility-class substitution ────

const TRIVIAL_DATA_SCHEMA = {
  type: 'object',
  properties: { heading: { type: 'string' } },
  required: [],
  additionalProperties: false,
};

/** Adds `lede` (same compatibility class as `hero`), `contact_form` and `newsletter_signup` (same
 *  class as each other) and `prose` (its own class) to the base fixture registry — enough types, in
 *  enough distinct classes, to prove both a same-class candidate list AND that a cross-class type
 *  never appears in it, even when that cross-class type is itself live and allowed. */
function substitutionComponentRegistry() {
  return {
    registry: 'component',
    definitions: [
      { type: 'hero', component_bound: true, data_schema: TRIVIAL_DATA_SCHEMA },
      { type: 'lede', component_bound: true, data_schema: TRIVIAL_DATA_SCHEMA },
      { type: 'faq', component_bound: true, data_schema: FAQ_DATA_SCHEMA },
      { type: 'contact_form', component_bound: true, data_schema: TRIVIAL_DATA_SCHEMA },
      { type: 'newsletter_signup', component_bound: true, data_schema: TRIVIAL_DATA_SCHEMA },
      { type: 'prose', component_bound: true, data_schema: TRIVIAL_DATA_SCHEMA },
    ],
  };
}

function substitutionPageTypeRegistry() {
  return {
    registry: 'page_type',
    definitions: [
      // `lede` is not allowed here, but its intro_banner classmate `hero` is.
      { id: 'landing', routePattern: '/**', allowedSections: ['hero', 'faq'], requiredSections: [] },
      // `contact_form` is not allowed here, but `prose` (a DIFFERENT class) and `newsletter_signup`
      // (the SAME class as contact_form) both are — the case that proves cross-class exclusion even
      // when a same-registry, same-page-type-allowed, wrong-class type is sitting right there.
      { id: 'blog', routePattern: '/blog/**', allowedSections: ['prose', 'newsletter_signup'], requiredSections: [] },
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
    mapping: mapping(),
    // The object_get BODY of the site, not its inventory row — CLONE-INTAKE-FIX.md Defect A.
    siteBody: siteBodyFixture(),
    theme: { object_id: 'thm_captured', body: { name: 'Captured theme', tokens: { colors: {}, fonts: {} } } },
    emissionReport: emissionReport(),
    inventory: inventory(),
    componentRegistry: componentRegistry(),
    pageTypeRegistry: pageTypeRegistry(),
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

// A section-type vocabulary the size of a real platform's, with realistic field names. The REGISTRY
// argument is always the raw `registry_get` response — JSON Schema and all — because that is what the
// caller actually fetches; reducing it to field names is this module's job, not the caller's.
const SECTION_TYPE_NAMES = [
  'hero',
  'faq',
  'composition',
  'media_gallery',
  'testimonial',
  'pricing_table',
  'cta_banner',
  'rich_text',
  'feature_grid',
  'team_grid',
  'logo_wall',
  'stat_band',
  'timeline',
  'accordion',
  'contact_form',
  'map_embed',
  'video_embed',
  'pull_quote',
  'breadcrumb_trail',
  'product_grid',
  'article_list',
  'newsletter_signup',
  'split_feature',
  'footer_cta',
];
const FIELD_NAMES = [
  'heading',
  'subheading',
  'body',
  'items',
  'images',
  'blocks',
  'tone',
  'alignment',
  'ctaLabel',
  'ctaHref',
];

function generatedComponentRegistry({ typeCount = SECTION_TYPE_NAMES.length, fieldCount = 4 } = {}) {
  return {
    registry: 'component',
    definitions: Array.from({ length: typeCount }, (_, index) => {
      const properties = {};
      for (let field = 0; field < fieldCount; field += 1) {
        // Names cycle through the realistic list and then extend it, so a deliberately oversized
        // registry stays made of plausible identifiers rather than filler.
        const name =
          field < FIELD_NAMES.length ? FIELD_NAMES[field] : `${FIELD_NAMES[field % FIELD_NAMES.length]}${field}`;
        properties[name] = { type: 'string', description: 'A description that has no business in a briefing.' };
      }
      return {
        type: SECTION_TYPE_NAMES[index] ?? `${SECTION_TYPE_NAMES[index % SECTION_TYPE_NAMES.length]}_${index}`,
        component_bound: true,
        data_schema: { type: 'object', properties, required: ['heading'], additionalProperties: false },
      };
    }),
  };
}

const pseudoHash = (seed, length = 16) => (seed + 1).toString(16).padStart(length, '0').slice(-length);

/** A mapping + emission-report pair of a given size, shaped exactly like the real ones: emit.mjs's
 *  page requestedIds, map.mjs's candidateIds and gapIds. */
function generatedCapture({ pageCount, sectionsPerPage, gapsPerPage }) {
  const pages = [];
  const creates = [];
  const createdObjects = [];
  for (let index = 0; index < pageCount; index += 1) {
    const pageRef = `page_${pseudoHash(index, 12)}`;
    const objectId = `page_capture_${pseudoHash(index)}`;
    const sections = Array.from({ length: sectionsPerPage }, (_, slot) => ({
      id: `s_${pseudoHash(index * 100 + slot, 10)}`,
      type: SECTION_TYPE_NAMES[(index + slot) % SECTION_TYPE_NAMES.length],
      data: { heading: `Section ${slot} of page ${index}` },
    }));
    pages.push({
      pageRef,
      sourceUrl: `https://example.com/page-${index}`,
      pageBody: { route: index === 0 ? '/' : `/page-${index}`, pageType: 'clone', title: `Page ${index}`, sections },
      candidates: sections.map((section, slot) => ({
        candidateId: `candidate_${pseudoHash(index * 100 + slot)}`,
        sectionType: section.type,
        data: section.data,
        section,
        confidence: 0.9,
        mappingReason: 'a mapping reason string that the briefing has no room for',
      })),
      gaps: Array.from({ length: gapsPerPage }, (_, gap) => ({
        gapId: `gap_${pseudoHash(index * 100 + gap)}`,
        blockRef: `block_${index}_${gap}`,
        screenshotRef: `screenshots/page-${index}-block-${gap}.png`,
        why: 'no_matching_section_type',
        nearestType: SECTION_TYPE_NAMES[gap % SECTION_TYPE_NAMES.length],
        missingCapability: 'a long prose explanation of what the platform would need to build for this',
      })),
    });
    creates.push({
      kind: 'page',
      objectType: 'page',
      requestedId: objectId,
      body: { route: index === 0 ? '/' : `/page-${index}`, sections },
      pageRef,
    });
    createdObjects.push({ objectType: 'page', objectId, draftVerified: true });
  }
  return {
    mapping: {
      schemaVersion: 'capture-map.v1',
      generatedAt: '2026-08-01T00:00:00.000Z',
      pages,
      navigationCandidates: [],
    },
    emissionReport: { target: 'fixture-target', creates, createdObjects, reusedObjects: [], quarantines: [] },
  };
}

function generatedRecipeRows(count) {
  return {
    section_template: Array.from({ length: count }, (_, index) => ({
      object_id: `stpl_${pseudoHash(index)}`,
      object_type: 'section_template',
      recipe: {
        name: `Section recipe ${index}`,
        scope: 'one_off',
        blueprint_type: SECTION_TYPE_NAMES[index % SECTION_TYPE_NAMES.length],
        description: 'prose the briefing does not carry',
        when_to_use: 'more prose the briefing does not carry',
      },
    })),
    template: Array.from({ length: count }, (_, index) => ({
      object_id: `tpl_${pseudoHash(index)}`,
      object_type: 'template',
      recipe: { name: `Page template ${index}`, scope: 'evergreen', applies_to: ['clone'], slot_count: 4 },
    })),
  };
}

/** A capture the size of a real small-site clone: 10 pages of 6 sections, a gap apiece, 24 live
 *  section types, 8 recipes already on the site, and a whole captured theme (the live run measured
 *  its own at 895 chars — the ONE thing in the old 637KB envelope that was the right size). */
function realisticThemeTokens() {
  return {
    colors: {
      primary: 'rgb(46 111 149)',
      secondary: 'rgb(37 90 120)',
      accent: '#5e8c8a',
      surface: '#f7f5f1',
      surfaceMuted: '#ece7df',
      ink: '#1d2733',
      inkMuted: '#5a6672',
      border: '#d8d2c8',
      success: '#2f7d4f',
      warning: '#b8791f',
      danger: '#a83232',
      inverse: '#ffffff',
    },
    fonts: {
      sans: "'Inter Variable', system-ui, sans-serif",
      serif: "'Source Serif 4', Georgia, serif",
      heading: "'Playfair Display', Georgia, serif",
      mono: "'IBM Plex Mono', ui-monospace, monospace",
    },
    layout: { containerWidth: 'default', sectionRhythm: 'roomy' },
    shape: { radius: 'round', borderWeight: 'hairline' },
  };
}

function realisticIntakeArgs() {
  const capture = generatedCapture({ pageCount: 10, sectionsPerPage: 6, gapsPerPage: 1 });
  return baseIntakeArgs({
    ...capture,
    theme: { object_id: 'thm_captured', body: { name: 'Captured theme', tokens: realisticThemeTokens() } },
    componentRegistry: generatedComponentRegistry({ fieldCount: 5 }),
    inventory: { ...inventory(), ...generatedRecipeRows(8) },
  });
}

/** Deliberately far over the cap in every degradable dimension at once, so all four documented steps
 *  have to run and the ledger records all four. */
function oversizedIntakeArgs({ pageCount = 60, recipeCount = 100, sectionTypeCount = 60, fieldCount = 40 } = {}) {
  const capture = generatedCapture({ pageCount, sectionsPerPage: 3, gapsPerPage: 40 });
  return baseIntakeArgs({
    ...capture,
    theme: {
      object_id: 'thm_captured',
      body: { name: 'Captured theme', tokens: { colors: { primary: '#204060' }, fonts: {} } },
    },
    componentRegistry: generatedComponentRegistry({ typeCount: sectionTypeCount, fieldCount }),
    inventory: { ...inventory(), ...generatedRecipeRows(recipeCount) },
  });
}

// ─── 1. buildCloneIntake ──────────────────────────────────────────────────────────────────────────

test('buildCloneIntake emits a bounded briefing and never mutates its arguments', () => {
  const args = baseIntakeArgs();
  const pristineSiteBody = JSON.parse(JSON.stringify(args.siteBody));
  const pristineInventory = JSON.parse(JSON.stringify(args.inventory));

  const intake = buildCloneIntake(args);

  assert.equal(intake.artifact, 'clone_intake.v1');
  assert.equal(intake.captureRunId, 'run_abc');
  assert.equal(intake.target, 'fixture-target');
  assert.match(intake.summary, /fixture-target/);

  // Defect A: the site's own palette slots reach the envelope, from the object_get BODY. The site's
  // layout/shape tokens do not — no stage downstream may propose them.
  // T13.3: `palette`, not `brandTokens`/`tokens` — the executor's per-node prompt redactor treats
  // any key matching `/token/i` as a credential and replaces it with "[REDACTED]" before the model
  // ever sees it, so the old field names silently blanked this whole briefing section.
  assert.deepEqual(intake.site, {
    objectId: 'site_0',
    palette: {
      colors: { primary: 'rgb(46 111 149)', secondary: 'rgb(37 90 120)', accent: '#5e8c8a' },
      fonts: { sans: "'Inter Variable', system-ui", serif: 'Georgia, serif', heading: 'Playfair Display, serif' },
    },
  });
  assert.deepEqual(intake.theme, {
    objectId: 'thm_captured',
    name: 'Captured theme',
    palette: { colors: {}, fonts: {} },
  });

  // Defect B, the heart of it: FIELD NAMES, never the JSON Schema those names came from.
  assert.deepEqual(intake.registry.sectionTypes, {
    hero: { fields: ['body', 'heading', 'tone'], required: ['heading'] },
    faq: { fields: ['heading', 'items'], required: ['items'] },
  });
  assert.equal(JSON.stringify(intake.registry.sectionTypes).includes('additionalProperties'), false);
  assert.deepEqual(intake.registry.pageTypes.clone, { allowed: 'any', required: [] });
  assert.deepEqual(intake.registry.pageTypes.home, { allowed: ['hero'], required: ['hero'] });

  assert.deepEqual(intake.pages, [
    {
      pageRef: 'page_home',
      objectId: 'page_capture_abc123',
      route: '/',
      sourceShape: ['hero'],
      emittedShape: ['hero'],
      gaps: [],
      candidateIds: ['candidate_hero01'],
    },
  ]);
  assert.deepEqual(intake.recipes, { section_template: [], template: [] });

  // The envelope measures ITSELF: `budget.chars` describes the string that contains it.
  assert.equal(intake.budget.chars, JSON.stringify(intake).length);
  assert.equal(intake.budget.cap, CLONE_INTAKE_CAP_CHARS);
  assert.deepEqual(intake.budget.truncated, []);

  // Nothing excluded by CLONE-INTAKE-FIX.md rides along under another name.
  const serialized = JSON.stringify(intake);
  for (const excluded of ['snapshot', 'createdArtifacts', 'assetBindings', 'assetPlans', 'preflight', 'inventory']) {
    assert.equal(serialized.includes(excluded), false, `${excluded} must not appear in the briefing`);
  }

  // Deep clone, not a reference: mutating the returned intake must not reach back into the caller's
  // own objects, and the arguments themselves must read exactly as they did going in.
  intake.site.palette.colors.primary = 'MUTATED';
  intake.theme.palette.colors.invented = '#000000';
  assert.deepEqual(args.siteBody, pristineSiteBody);
  assert.deepEqual(args.inventory, pristineInventory);
});

test('buildCloneIntake keeps a realistic capture briefing under the 12,000-char target', () => {
  const intake = buildCloneIntake(realisticIntakeArgs());

  assert.ok(
    intake.budget.chars < CLONE_INTAKE_TARGET_CHARS,
    `realistic briefing measured ${intake.budget.chars} chars, over the ${CLONE_INTAKE_TARGET_CHARS} target`
  );
  assert.equal(intake.budget.chars, JSON.stringify(intake).length);
  assert.deepEqual(intake.budget.truncated, []);
  // Bounded, not gutted: every page, every registry entry, the whole palette and the whole captured
  // theme are still there.
  assert.equal(intake.pages.length, 10);
  assert.deepEqual(intake.theme.palette, realisticThemeTokens());
  assert.equal(Object.keys(intake.registry.sectionTypes).length, 24);
  assert.equal(Object.keys(intake.site.palette.colors).length, 3);
  assert.ok(intake.pages.some((page) => page.gaps.length > 0));
});

test('buildCloneIntake degrades in the documented order and records every drop in budget.truncated', () => {
  const intake = buildCloneIntake(oversizedIntakeArgs());

  assert.ok(intake.budget.chars <= CLONE_INTAKE_CAP_CHARS);
  assert.equal(intake.budget.chars, JSON.stringify(intake).length);
  assert.deepEqual(
    intake.budget.truncated.map((entry) => entry.field),
    ['pages[].gaps', 'pages', 'recipes.section_template', 'recipes.template', 'registry.sectionTypes[].fields']
  );
  assert.deepEqual(
    intake.budget.truncated.map((entry) => entry.reason),
    [
      'gaps_capped_at_5_per_page',
      'pages_capped_at_20',
      'recipes_capped_at_20',
      'recipes_capped_at_20',
      'fields_replaced_with_count',
    ]
  );

  const [gapDrop, pageDrop, sectionTemplateDrop, templateDrop, fieldDrop] = intake.budget.truncated;
  assert.equal(gapDrop.total, 60 * 40);
  assert.equal(gapDrop.kept, 60 * 5);
  assert.ok(intake.pages.every((page) => page.gaps.length <= 5));
  assert.equal(pageDrop.total, 60);
  assert.equal(pageDrop.kept, 20);
  assert.equal(intake.pages.length, 20);
  assert.equal(sectionTemplateDrop.kept, 20);
  assert.equal(intake.recipes.section_template.length, 20);
  assert.equal(templateDrop.kept, 20);
  assert.equal(fieldDrop.kept, 0);

  // Step 4 replaces the field NAMES with a count and keeps the type itself: a designer that cannot see
  // a type exists invents one, which is the failure `unknown_section_type` exists to prevent.
  const contract = Object.values(intake.registry.sectionTypes)[0];
  assert.equal(contract.fields, undefined);
  assert.equal(typeof contract.fieldCount, 'number');

  // NEVER dropped, at any size.
  assert.equal(Object.keys(intake.site.palette.colors).length, 3);
  assert.deepEqual(intake.theme.palette, { colors: { primary: '#204060' }, fonts: {} });
  assert.equal(Object.keys(intake.registry.pageTypes).length, 2);
});

test('buildCloneIntake degrades no further than it must — one step, one ledger entry', () => {
  const args = oversizedIntakeArgs({ pageCount: 14, recipeCount: 4, sectionTypeCount: 6, fieldCount: 6 });
  const intake = buildCloneIntake(args);

  assert.deepEqual(
    intake.budget.truncated.map((entry) => entry.field),
    ['pages[].gaps']
  );
  assert.equal(intake.pages.length, 14);
  assert.ok(Array.isArray(Object.values(intake.registry.sectionTypes)[0].fields));
});

test('buildCloneIntake THROWS intake_cannot_be_bounded when every documented drop still leaves it over cap', () => {
  // A registry with more section TYPES than the cap can hold names for. Types are never dropped (only
  // their field names are), so no legal degradation can rescue this — and a silently truncated
  // briefing is exactly what this rewrite exists to make unreachable.
  const definitions = Array.from({ length: 4000 }, (_, index) => ({
    type: `section_type_${index}`,
    data_schema: { type: 'object', properties: { heading: { type: 'string' } }, required: ['heading'] },
  }));
  assert.throws(
    () => buildCloneIntake(baseIntakeArgs({ componentRegistry: { definitions } })),
    (error) => error instanceof CloneError && error.message === 'intake_cannot_be_bounded'
  );
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
  assert.deepEqual(intake.pages, []);
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
  assert.equal(intake.pages.length, 1);
  assert.equal(intake.pages[0].objectId, 'page_existing_home');
});

test('buildCloneIntake reports emittedShape from the emitted body, not from the mapping', () => {
  // Emission wrote only the hero: the faq the mapping recognized never made it onto the page. That
  // difference is the mismatch `layout_analyst` exists to notice, so the two shapes must not be the
  // same array read twice.
  const args = baseIntakeArgs({
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
              { id: 's_hero01', type: 'hero', data: { heading: 'Welcome' } },
              { id: 's_faq01', type: 'faq', data: { items: [] } },
            ],
          },
          candidates: [
            { candidateId: 'candidate_hero01', sectionType: 'hero' },
            { candidateId: 'candidate_faq01', sectionType: 'faq' },
          ],
          gaps: [
            {
              gapId: 'gap_abc',
              blockRef: 'block_9',
              screenshotRef: 'x.png',
              why: 'no_matching_type',
              nearestType: 'hero',
              missingCapability: 'a long explanation nobody needs in a briefing',
            },
          ],
        },
      ],
    }),
    emissionReport: {
      target: 'fixture-target',
      creates: [
        {
          kind: 'page',
          objectType: 'page',
          requestedId: 'page_capture_abc123',
          body: { route: '/', sections: [{ id: 's_hero01', type: 'hero' }] },
          pageRef: 'page_home',
        },
      ],
      createdObjects: [{ objectType: 'page', objectId: 'page_capture_abc123', draftVerified: true }],
      reusedObjects: [],
      quarantines: [],
    },
  });
  const intake = buildCloneIntake(args);
  assert.deepEqual(intake.pages[0].sourceShape, ['hero', 'faq']);
  assert.deepEqual(intake.pages[0].emittedShape, ['hero']);
  // A gap is briefed by id, reason and nearest type — never by its screenshot ref or its prose.
  assert.deepEqual(intake.pages[0].gaps, [{ gapId: 'gap_abc', why: 'no_matching_type', nearestType: 'hero' }]);
});

test('buildCloneIntake reads sourceShape from the block ledger, marking unmapped blocks as gaps', () => {
  const args = baseIntakeArgs({
    mapping: mapping({
      pages: [
        {
          pageRef: 'page_home',
          sourceUrl: 'https://example.com/',
          pageBody: {
            route: '/',
            pageType: 'clone',
            title: 'Home',
            sections: [{ id: 's_hero01', type: 'hero', data: { heading: 'Welcome' } }],
          },
          candidates: [{ candidateId: 'candidate_hero01', sectionType: 'hero' }],
          gaps: [{ gapId: 'gap_two', why: 'below_confidence_threshold', nearestType: 'faq' }],
          blockAccounting: [
            { blockRef: 'block_0', status: 'ignored_noncontent', reason: 'not_selected_after_reconciliation' },
            { blockRef: 'block_1', status: 'mapped', candidateId: 'candidate_hero01' },
            { blockRef: 'block_2', status: 'gap', gapId: 'gap_two' },
          ],
        },
      ],
    }),
  });
  const intake = buildCloneIntake(args);
  assert.deepEqual(intake.pages[0].sourceShape, ['hero', 'gap']);
});

test('buildCloneIntake summarizes existing recipes as a reuse index, never as recipe bodies', () => {
  const intake = buildCloneIntake(
    baseIntakeArgs({
      inventory: {
        ...inventory(),
        section_template: [
          {
            object_id: 'stpl_existing',
            object_type: 'section_template',
            recipe: { name: 'Captured hero recipe', scope: 'one_off', blueprint_type: 'hero', description: 'x' },
          },
        ],
        template: [
          {
            object_id: 'tpl_existing',
            object_type: 'template',
            recipe: { name: 'Home template', scope: 'evergreen', applies_to: ['home'], slot_count: 3 },
          },
        ],
      },
    })
  );
  assert.deepEqual(intake.recipes.section_template, [
    { objectId: 'stpl_existing', name: 'Captured hero recipe', scope: 'one_off', blueprint_type: 'hero' },
  ]);
  assert.deepEqual(intake.recipes.template, [
    { objectId: 'tpl_existing', name: 'Home template', scope: 'evergreen', applies_to: ['home'], slot_count: 3 },
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

test('buildCloneIntake throws CloneError when handed an inventory ROW instead of the site BODY', () => {
  // The exact Defect A failure: an object_inventory row has no brandTokens, so a run built on one
  // gives theme_reconciler nothing to enumerate. Refused here, three stages before the symptom.
  assert.throws(
    () =>
      buildCloneIntake(baseIntakeArgs({ siteBody: { object_id: 'site_0', object_type: 'site', status: 'active' } })),
    CloneError
  );
});

// ─── T13.3 guard: no briefing key collides with the credential redactor ───────────────────────────

// Copied from `src/agent/execution/runners/OpenAINodeRunner.ts` line 16 (and the identical line in
// `AnthropicNodeRunner.ts`) in the cms-agent repo — the executor's per-node prompt redactor. It is
// a GLOBAL security control run over every node's input in every workflow: any key at any depth
// whose NAME matches this pattern has its VALUE silently replaced with the literal string
// "[REDACTED]" before the model ever sees it — the model gets no signal that a substitution
// happened at all. `buildCloneIntake`'s old `site.brandTokens` and `theme.tokens` fields both
// matched `/token/i`, so `theme_reconciler` received a briefing whose whole palette read
// "[REDACTED]" and correctly, but uselessly, refused it. This module must never re-introduce a
// briefing key that collides with this pattern, for this field or any other — that is exactly what
// this test exists to catch before it ships again.
const REDACTOR_KEY_RE = /api[_-]?key|authorization|bearer|jwt|cookie|token|secret|blob.*credential/i;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Every `{key, path}` pair at every depth of `value`, arrays walked but not treated as keyed. */
function collectKeyPaths(value, path, out) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectKeyPaths(item, `${path}[${index}]`, out));
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    out.push({ key, path: `${path}.${key}` });
    collectKeyPaths(item, `${path}.${key}`, out);
  }
}

test('buildCloneIntake GUARD: no key at any depth of the briefing collides with the credential redactor', () => {
  // Two shapes: a normal realistic briefing, and the deliberately oversized one that exercises every
  // documented degradation step (fieldCount instead of fields, budget.truncated entries, etc) — a
  // colliding key introduced only by a degraded shape would otherwise slip past this guard.
  const briefings = [buildCloneIntake(realisticIntakeArgs()), buildCloneIntake(oversizedIntakeArgs())];

  const offenders = [];
  for (const briefing of briefings) {
    const keyPaths = [];
    collectKeyPaths(briefing, '$', keyPaths);
    for (const { key, path } of keyPaths) {
      if (REDACTOR_KEY_RE.test(key)) offenders.push(path);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    'briefing key(s) collide with the executor credential redactor (/token/i et al.) and will reach ' +
      `the model as the literal string "[REDACTED]": ${offenders.join(', ')}`
  );
});

// T13.4 PART B closing instruction: "substitutions and its fields must not introduce a colliding
// key" — the ledger vocabulary (kind/wanted/chosen/reason/basis/fidelityCost/substitutable/
// candidates) plus everywhere it now surfaces (buildRecipeMintPlan, validateThemeProposal,
// buildCloneRunReport), scanned the same way the briefing itself is scanned above.
test('T13.4 GUARD: no substitution-ledger key at any depth collides with the credential redactor', () => {
  const intake = intakeFixture({
    componentRegistry: substitutionComponentRegistry(),
    pageTypeRegistry: substitutionPageTypeRegistry(),
  });
  const mintPlan = buildRecipeMintPlan({
    intake,
    design: {
      templates: [{ name: 'Lede-on-landing template', appliesTo: ['landing'], slots: [{ sectionType: 'lede' }] }],
      sectionTemplates: [{ name: 'Headless hero', blueprint: { type: 'hero', data: { body: 'x' } } }],
    },
  });
  const themeResult = validateThemeProposal({
    proposal: { colors: { primary: '#204060' }, fonts: { sans: 'Helvetica Neue' } },
    intake,
  });
  const runReport = buildCloneRunReport({
    intake,
    mintReport: mintPlan,
    themeReport: themeResult,
    restampReport: { restamp: [], skipped: [] },
    design: {},
  });

  const offenders = [];
  for (const document of [mintPlan, themeResult, runReport]) {
    const keyPaths = [];
    collectKeyPaths(document, '$', keyPaths);
    for (const { key, path } of keyPaths) {
      if (REDACTOR_KEY_RE.test(key)) offenders.push(path);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `substitution-ledger key(s) collide with the credential redactor: ${offenders.join(', ')}`
  );
  // Sanity check the fixture actually exercised the ledger (a passing scan of nothing proves nothing).
  assert.ok(mintPlan.substitutions.length > 0);
  assert.ok(themeResult.substitutions.length > 0);
  assert.ok(runReport.substitutions.length > 0);
});

// ─── 2. validateSectionTemplateDesign / validateTemplateDesign ───────────────────────────────────

function intakeFixture(overrides = {}) {
  return buildCloneIntake(baseIntakeArgs(overrides));
}

test('validateSectionTemplateDesign accepts a legal design and normalizes it', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Captured hero recipe',
    blueprint: { type: 'hero', data: { heading: 'Welcome' } },
    whenToUse: 'Use for a homepage opener.',
  };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.scope, 'one_off');
  assert.match(result.normalized.blueprint.id, /^s_[a-z0-9]+$/);
  assert.equal(result.normalized.whenToUse, 'Use for a homepage opener.');
  // Never mutates the caller's design object.
  assert.equal(design.blueprint.id, undefined);
});

// T13.4 PART B item 6: the live-run defect — the designer's `when_to_use` (its own outputSchema
// spelling) was never mapped, so the mint plan emitted `whenToUse: ''`, which blocks PUBLISHING the
// recipe later. Same tolerant-reader discipline as appliesTo/applies_to: either spelling is accepted
// on input, `whenToUse` is the one canonical name normalized/emitted.
test('validateSectionTemplateDesign accepts when_to_use (snake_case) and normalizes it to whenToUse', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Captured hero recipe',
    blueprint: { type: 'hero', data: { heading: 'Welcome' } },
    when_to_use: 'Use for a homepage opener.',
  };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.whenToUse, 'Use for a homepage opener.');
  assert.equal(result.normalized.when_to_use, undefined);
});

test('validateSectionTemplateDesign REFUSES recipe_metadata_incomplete when whenToUse is missing or blank', () => {
  const intake = intakeFixture();
  const missing = validateSectionTemplateDesign(
    { name: 'Captured hero recipe', blueprint: { type: 'hero', data: { heading: 'Welcome' } } },
    intake
  );
  assert.equal(missing.reason, 'recipe_metadata_incomplete');
  assert.equal(missing.substitutable, false);
  assert.deepEqual(missing.candidates, []);

  const blank = validateSectionTemplateDesign(
    {
      name: 'Captured hero recipe',
      blueprint: { type: 'hero', data: { heading: 'Welcome' } },
      whenToUse: '   ',
    },
    intake
  );
  assert.equal(blank.reason, 'recipe_metadata_incomplete');
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

test('validateSectionTemplateDesign defers an illegal ENUM MEMBER to object_validate — the documented cost of a names-only registry', () => {
  // CLONE-INTAKE-FIX.md Defect B: the briefing carries field NAMES, never the schema those names came
  // from, because that schema was 32,694 chars — 68% of the whole dependency budget — and it starved
  // both AI nodes on the live run. An enum's members are values, not field names, so this one check of
  // CLONE-ENGINE-API.md §2's three is no longer answerable here. `tone` IS a legal field, so the
  // design passes this stage and is refused one stage later by `object_validate` against the real zod
  // schema, which was always the authority on it. This test pins that boundary so it stays deliberate.
  const intake = intakeFixture();
  const design = {
    name: 'Off-tone hero',
    blueprint: { type: 'hero', data: { heading: 'Hi', tone: 'ultraviolet' } },
    whenToUse: 'Use for a dramatic opener.',
  };
  const result = validateSectionTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  // The two checks a field-name list CAN answer are unchanged — see the two tests above.
  assert.equal(
    validateSectionTemplateDesign(
      { ...design, name: 'Invented field', blueprint: { type: 'hero', data: { heading: 'Hi', nope: 1 } } },
      intake
    ).reason,
    'blueprint_schema_mismatch'
  );
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
    whenToUse: 'Use for the site homepage.',
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.slots[0].slotId, 'hero_slot');
  assert.equal(result.normalized.whenToUse, 'Use for the site homepage.');
});

test('validateTemplateDesign accepts when_to_use (snake_case) and normalizes it to whenToUse', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Home template',
    appliesTo: ['home'],
    slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
    when_to_use: 'Use for the site homepage.',
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.equal(result.normalized.whenToUse, 'Use for the site homepage.');
  assert.equal(result.normalized.when_to_use, undefined);
});

test('validateTemplateDesign REFUSES recipe_metadata_incomplete when whenToUse is missing', () => {
  const intake = intakeFixture();
  const result = validateTemplateDesign(
    {
      name: 'Home template',
      appliesTo: ['home'],
      slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
    },
    intake
  );
  assert.equal(result.reason, 'recipe_metadata_incomplete');
  assert.equal(result.substitutable, false);
  assert.deepEqual(result.candidates, []);
});

// T13.3 TOLERANT READER: run_1787567551705_e1qp0l's `recipe_designer` emitted `applies_to`
// (snake_case, per its own outputSchema at the time) into a validator that only ever read
// `appliesTo` (camelCase) — a good design was rejected `malformed_design` for a mismatch that had
// nothing to do with the design's actual content. Fixed by accepting either spelling on INPUT
// while keeping `appliesTo` the one CANONICAL name emitted/normalized — that is what the
// platform's own template body carries (`row?.body?.appliesTo`), so nothing here ever writes
// `applies_to` anywhere downstream.
test('validateTemplateDesign accepts appliesTo (camelCase)', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Home template',
    appliesTo: ['home'],
    slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
    whenToUse: 'Use for the site homepage.',
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized.appliesTo, ['home']);
  assert.equal(result.normalized.applies_to, undefined);
});

test('validateTemplateDesign accepts applies_to (snake_case) identically to appliesTo', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Home template',
    applies_to: ['home'],
    slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
    whenToUse: 'Use for the site homepage.',
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  // Normalizes to the SAME canonical shape appliesTo would have produced.
  assert.deepEqual(result.normalized.appliesTo, ['home']);
  assert.equal(result.normalized.applies_to, undefined);
});

test('validateTemplateDesign REJECTS with neither appliesTo nor applies_to, exact existing message', () => {
  const intake = intakeFixture();
  const design = { name: 'Homeless template', slots: [{ slotId: 'hero_slot', sectionType: 'hero' }] };
  assert.throws(() => validateTemplateDesign(design, intake), {
    message: 'A template design requires at least one appliesTo page type.',
  });
});

test('validateTemplateDesign PREFERS appliesTo when both appliesTo and applies_to are present and non-empty', () => {
  const intake = intakeFixture();
  const design = {
    name: 'Home template',
    appliesTo: ['home'],
    applies_to: ['clone'], // deliberately different, to prove which one wins
    slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
    whenToUse: 'Use for the site homepage.',
  };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.ok, true);
  assert.deepEqual(result.normalized.appliesTo, ['home']);
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

// ─── 2b. T13.4 PART B: compatibility classes and the substitution channel ─────────────────────────

test('classOfSectionType groups documented lookalikes and singletons everything else', () => {
  assert.equal(classOfSectionType('hero'), classOfSectionType('lede'));
  assert.equal(classOfSectionType('contact_form'), classOfSectionType('newsletter_signup'));
  // The spec's own textbook example: contact_form and prose are never the same class.
  assert.notEqual(classOfSectionType('contact_form'), classOfSectionType('prose'));
  // An unrecognized/invented type has no class at all — nothing to search a substitute within.
  assert.equal(classOfSectionType('totally_invented_type'), null);
});

test('substitutionCandidatesForSectionType never crosses a compatibility class boundary', () => {
  const registrySectionTypes = substitutionComponentRegistry().definitions.reduce((acc, d) => {
    acc[d.type] = {};
    return acc;
  }, {});
  // Same class (intro_banner), both registered, none excluded by an allow-list: lede -> [hero].
  assert.deepEqual(substitutionCandidatesForSectionType('lede', { registrySectionTypes }), ['hero']);
  // The wanted type itself is never offered as its own candidate.
  assert.ok(!substitutionCandidatesForSectionType('lede', { registrySectionTypes }).includes('lede'));
  // contact_form's candidates are drawn ONLY from lead_capture (newsletter_signup) — prose, faq, hero,
  // lede are all live and registered here too, and NONE of them may ever appear.
  const contactFormCandidates = substitutionCandidatesForSectionType('contact_form', { registrySectionTypes });
  assert.deepEqual(contactFormCandidates, ['newsletter_signup']);
  for (const crossClassType of ['prose', 'faq', 'hero', 'lede']) {
    assert.ok(
      !contactFormCandidates.includes(crossClassType),
      `${crossClassType} must never candidate for contact_form`
    );
  }
  // A type with no live registry entry offers nothing, even though its class has a member.
  assert.deepEqual(substitutionCandidatesForSectionType('lede', { registrySectionTypes: { faq: {} } }), []);
  // A class-of-one offers nothing, ever.
  assert.deepEqual(substitutionCandidatesForSectionType('faq', { registrySectionTypes }), []);
});

test('substitutionCandidatesForSectionType additionally filters by allowedTypes (page-type slot)', () => {
  const registrySectionTypes = substitutionComponentRegistry().definitions.reduce((acc, d) => {
    acc[d.type] = {};
    return acc;
  }, {});
  // hero is the only intro_banner member allowed here anyway.
  assert.deepEqual(
    substitutionCandidatesForSectionType('lede', { registrySectionTypes, allowedTypes: ['hero', 'faq'] }),
    ['hero']
  );
  // Restrict the allow-list to exclude even the one legal candidate: nothing survives.
  assert.deepEqual(substitutionCandidatesForSectionType('lede', { registrySectionTypes, allowedTypes: ['faq'] }), []);
});

test('assertSameCompatibilityClass passes same-class pairs and throws for everything else', () => {
  assert.doesNotThrow(() => assertSameCompatibilityClass('hero', 'lede'));
  assert.doesNotThrow(() => assertSameCompatibilityClass('contact_form', 'newsletter_signup'));
  // THE hard boundary itself: contact_form standing in for prose (or vice versa) must be impossible,
  // not merely discouraged — this function is what a later, CHOOSING caller (PART C) must run every
  // (wanted, chosen) pair through before treating a swap as legitimate.
  assert.throws(() => assertSameCompatibilityClass('contact_form', 'prose'), CloneError);
  assert.throws(() => assertSameCompatibilityClass('prose', 'contact_form'), CloneError);
  // A no-op "substitution" is not one.
  assert.throws(() => assertSameCompatibilityClass('hero', 'hero'), CloneError);
  // Unclassified types prove nothing about safety, so they never pass either.
  assert.throws(() => assertSameCompatibilityClass('hero', 'invented_type'), CloneError);
});

test('validateTemplateDesign REPORTS a same-class, live, allowed candidate for slot_section_type_not_allowed', () => {
  const intake = intakeFixture({
    componentRegistry: substitutionComponentRegistry(),
    pageTypeRegistry: substitutionPageTypeRegistry(),
  });
  // `lede` is not allowed on `landing`; its intro_banner classmate `hero` is, and is live.
  const design = { name: 'Lede-on-landing template', appliesTo: ['landing'], slots: [{ sectionType: 'lede' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'slot_section_type_not_allowed');
  assert.equal(result.wanted, 'lede');
  assert.equal(result.substitutable, true);
  assert.deepEqual(result.candidates, ['hero']);
});

test('validateTemplateDesign NEVER offers a cross-class candidate, even when it is live and allowed', () => {
  const intake = intakeFixture({
    componentRegistry: substitutionComponentRegistry(),
    pageTypeRegistry: substitutionPageTypeRegistry(),
  });
  // `contact_form` is not allowed on `blog`; `prose` IS allowed there but is a DIFFERENT capability
  // class (display text vs. data capture) and must never appear. `newsletter_signup` — the SAME class
  // as contact_form — is also allowed on `blog`, so it is exactly what should appear instead.
  const design = { name: 'Contact-on-blog template', appliesTo: ['blog'], slots: [{ sectionType: 'contact_form' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'slot_section_type_not_allowed');
  assert.equal(result.wanted, 'contact_form');
  assert.deepEqual(result.candidates, ['newsletter_signup']);
  assert.ok(!result.candidates.includes('prose'));
});

test('validateTemplateDesign REPORTS substitutable:false for unknown_section_type when nothing shares its class', () => {
  const intake = intakeFixture();
  const design = { name: 'Ghost template', appliesTo: ['clone'], slots: [{ sectionType: 'pricing_table' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'unknown_section_type');
  assert.equal(result.wanted, 'pricing_table');
  assert.equal(result.substitutable, false);
  assert.deepEqual(result.candidates, []);
});

test('validateTemplateDesign REPORTS other registered page types as candidates for applies_to_page_type_missing', () => {
  const intake = intakeFixture({
    componentRegistry: substitutionComponentRegistry(),
    pageTypeRegistry: substitutionPageTypeRegistry(),
  });
  const design = { name: 'Nowhere template', appliesTo: ['nowhere'], slots: [{ sectionType: 'hero' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'applies_to_page_type_missing');
  assert.equal(result.wanted, 'nowhere');
  assert.deepEqual(result.candidates, ['blog', 'landing']);
  assert.equal(result.substitutable, true);
});

test('validateTemplateDesign REPORTS substitutable:false for required_section_not_covered (a gap, not a bad fit)', () => {
  const intake = intakeFixture({
    pageTypeRegistry: {
      definitions: [{ id: 'home', routePattern: '/', allowedSections: ['hero', 'faq'], requiredSections: ['hero'] }],
    },
  });
  const design = { name: 'Home template without a hero', appliesTo: ['home'], slots: [{ sectionType: 'faq' }] };
  const result = validateTemplateDesign(design, intake);
  assert.equal(result.reason, 'required_section_not_covered');
  assert.equal(result.substitutable, false);
  assert.deepEqual(result.candidates, []);
});

// ─── 3. buildRecipeMintPlan ───────────────────────────────────────────────────────────────────────

const HERO_RECIPE_DESIGN = {
  name: 'Captured hero recipe',
  blueprint: { type: 'hero', data: { heading: 'Welcome' } },
  whenToUse: 'Use for a homepage opener.',
};

test('buildRecipeMintPlan mints idempotent requestedIds for the same target+name across two calls', () => {
  const intake = intakeFixture();
  const design = { sectionTemplates: [HERO_RECIPE_DESIGN] };
  const first = buildRecipeMintPlan({ intake, design });
  const second = buildRecipeMintPlan({ intake, design });
  assert.equal(first.creates[0].requestedId, second.creates[0].requestedId);
  assert.match(first.creates[0].requestedId, /^stpl_clone_[0-9a-f]{12}$/);
  assert.equal(first.creates[0].verb, 'object_create');
  assert.equal(first.creates[0].objectType, 'section_template');
  // T13.4 PART B item 5: the live defect — `object_create` requires `site` and the mint plan used to
  // omit it. `intake.site.objectId` is the one place a clone run's site id lives.
  assert.equal(first.creates[0].site, 'site_0');
});

test('buildRecipeMintPlan mints a different requestedId for a different target (idempotency is per target)', () => {
  const design = { sectionTemplates: [HERO_RECIPE_DESIGN] };
  const planA = buildRecipeMintPlan({ intake: intakeFixture({ target: 'target-a' }), design });
  const planB = buildRecipeMintPlan({ intake: intakeFixture({ target: 'target-b' }), design });
  assert.notEqual(planA.creates[0].requestedId, planB.creates[0].requestedId);
});

test('buildRecipeMintPlan THROWS CloneError when the intake carries no site.objectId', () => {
  const intake = intakeFixture();
  const brokenIntake = { ...intake, site: { ...intake.site, objectId: null } };
  assert.throws(
    () => buildRecipeMintPlan({ intake: brokenIntake, design: { sectionTemplates: [HERO_RECIPE_DESIGN] } }),
    CloneError
  );
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
      // `pricing_table` IS a recognized capability class (pricing_data) but it is a CLASS OF ONE, so
      // even a fully-populated live registry offers nothing to stand in for it.
      wanted: 'pricing_table',
      substitutable: false,
      candidates: [],
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
      { ...HERO_RECIPE_DESIGN, sourceCandidateIds: ['candidate_hero01'] },
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
      HERO_RECIPE_DESIGN,
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates.length, 1);
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].reason, 'malformed_design');
  // Shape parity with every other rejected entry — an authoring bug carries no candidates.
  assert.equal(plan.rejected[0].substitutable, false);
  assert.deepEqual(plan.rejected[0].candidates, []);
});

test('buildRecipeMintPlan builds a template body with each slot widened to an allowed[] array', () => {
  const intake = intakeFixture();
  const design = {
    templates: [
      {
        name: 'Home template',
        appliesTo: ['home'],
        slots: [{ slotId: 'hero_slot', sectionType: 'hero', required: true }],
        whenToUse: 'Use for the site homepage.',
      },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates[0].objectType, 'template');
  assert.equal(plan.creates[0].site, 'site_0');
  assert.deepEqual(plan.creates[0].body.slots, [
    { slotId: 'hero_slot', allowed: ['hero'], required: true, repeatable: false },
  ]);
  assert.equal(plan.creates[0].body.whenToUse, 'Use for the site homepage.');
});

test('buildRecipeMintPlan exposes the same forbiddenVerbs set emit.mjs uses', () => {
  const plan = buildRecipeMintPlan({ intake: intakeFixture(), design: {} });
  assert.deepEqual(plan.forbiddenVerbs, ['deploy', 'object_publish', 'release_to_production', 'trigger_netlify_build']);
});

// ─── 3b. T13.4 PART B item 4: buildRecipeMintPlan's substitutions[] ledger ────────────────────────

test('buildRecipeMintPlan surfaces a section_type-kind ledger entry for a rejected template slot', () => {
  const intake = intakeFixture({
    componentRegistry: substitutionComponentRegistry(),
    pageTypeRegistry: substitutionPageTypeRegistry(),
  });
  const design = {
    templates: [
      {
        name: 'Lede-on-landing template',
        appliesTo: ['landing'],
        slots: [{ sectionType: 'lede' }],
        whenToUse: 'Use for a landing page.',
      },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.creates.length, 0);
  assert.deepEqual(plan.substitutions, [
    {
      kind: 'section_type',
      wanted: 'lede',
      chosen: null,
      reason: 'slot_section_type_not_allowed',
      basis: '1 live, allowed section type(s) share "lede"\'s compatibility class',
      fidelityCost: 'minor',
      substitutable: true,
      candidates: ['hero'],
    },
  ]);
  // This module NEVER chooses — `chosen` is always null, everywhere in the ledger.
  assert.ok(plan.substitutions.every((entry) => entry.chosen === null));
});

test('buildRecipeMintPlan surfaces a recipe-kind ledger entry — Wolf\'s "select an existing style" — for a design whose blueprint doesn\'t fit', () => {
  const intake = intakeFixture({
    inventory: {
      ...inventory(),
      section_template: [
        { object_id: 'stpl_existing_a', recipe_summary: { name: 'Existing hero A' } },
        { object_id: 'stpl_existing_b', recipe_summary: { name: 'Existing hero B' } },
      ],
    },
  });
  const design = {
    sectionTemplates: [
      { name: 'Headless hero', blueprint: { type: 'hero', data: { body: 'no heading' } }, whenToUse: 'x' },
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.rejected[0].reason, 'blueprint_schema_mismatch');
  assert.deepEqual(plan.substitutions, [
    {
      kind: 'recipe',
      wanted: 'Headless hero',
      chosen: null,
      reason: 'blueprint_schema_mismatch',
      basis: '2 existing recipe(s) of this kind are already registered and could be reused',
      fidelityCost: 'minor',
      substitutable: true,
      candidates: [
        { objectId: 'stpl_existing_a', name: 'Existing hero A' },
        { objectId: 'stpl_existing_b', name: 'Existing hero B' },
      ],
    },
  ]);
  // The recipe-level boundary: a section_template rejection is never offered a TEMPLATE as a
  // candidate, and vice versa — candidates come only from intake.recipes[the SAME objectType].
  assert.ok(plan.substitutions[0].candidates.every((c) => c.objectId.startsWith('stpl_')));
});

test('buildRecipeMintPlan excludes malformed_design and recipe_metadata_incomplete from substitutions', () => {
  const intake = intakeFixture();
  const design = {
    sectionTemplates: [
      { blueprint: { type: 'hero', data: { heading: 'No name here' } } }, // malformed_design
      { name: 'No explanation', blueprint: { type: 'hero', data: { heading: 'Hi' } } }, // recipe_metadata_incomplete
    ],
  };
  const plan = buildRecipeMintPlan({ intake, design });
  assert.equal(plan.rejected.length, 2);
  assert.deepEqual(
    plan.rejected.map((entry) => entry.reason),
    ['malformed_design', 'recipe_metadata_incomplete']
  );
  assert.deepEqual(plan.substitutions, []);
});

// ─── 4. validateThemeProposal / buildThemeApplyPlan ───────────────────────────────────────────────

test('validateThemeProposal applies legal tokens and names the still-uncovered color slots', () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#204060' }, fonts: { sans: "'New Sans', system-ui" } },
    intake: intakeFixture(),
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
    intake: intakeFixture(),
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
    intake: intakeFixture(),
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
    intake: intakeFixture(),
  });
  assert.deepEqual(result.dropped, [{ slot: 'primary', value: 'kind of blueish', reason: 'not_a_color' }]);
});

test('validateThemeProposal DROPS no_fallback_stack for a single named family', () => {
  const result = validateThemeProposal({
    proposal: { fonts: { sans: 'Helvetica Neue', serif: 'Georgia, serif' } },
    intake: intakeFixture(),
  });
  assert.deepEqual(result.dropped, [{ slot: 'sans', value: 'Helvetica Neue', reason: 'no_fallback_stack' }]);
});

// T13.4 PART B items 1-3, generalising the fix already proven for fonts: a dropped font proposal
// gets a substitution-ledger entry whose candidates are the site's OWN already-declared font values
// ("an existing or available style", Wolf) — this module never chooses among them.
test("validateThemeProposal REPORTS the site's own existing font values as substitution candidates for no_fallback_stack", () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#204060' }, fonts: { sans: 'Helvetica Neue' } },
    intake: intakeFixture(),
  });
  assert.deepEqual(result.substitutions, [
    {
      kind: 'font',
      wanted: 'Helvetica Neue',
      chosen: null,
      reason: 'no_fallback_stack',
      basis: "3 font value(s) already active on this site's palette have a usable fallback stack",
      fidelityCost: 'minor',
      substitutable: true,
      candidates: ["'Inter Variable', system-ui", 'Georgia, serif', 'Playfair Display, serif'],
    },
  ]);
});

test('validateThemeProposal REPORTS a font substitution candidate list for external_reference_forbidden too', () => {
  const result = validateThemeProposal({
    proposal: {
      colors: { primary: '#204060' },
      fonts: { sans: "@import url('https://evil.example/f.css')" },
    },
    intake: intakeFixture(),
  });
  assert.equal(result.substitutions.length, 1);
  assert.equal(result.substitutions[0].kind, 'font');
  assert.equal(result.substitutions[0].reason, 'external_reference_forbidden');
  assert.equal(result.substitutions[0].chosen, null);
  assert.ok(result.substitutions[0].candidates.length > 0);
});

test('validateThemeProposal offers NO font substitution candidates for unknown_slot (nothing to substitute INTO)', () => {
  // `primary` rides along so the proposal is not a total drop (see the analogous colors test above).
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#204060' }, fonts: { invented_slot: 'Helvetica Neue' } },
    intake: intakeFixture(),
  });
  assert.deepEqual(
    result.dropped.filter((d) => d.slot === 'invented_slot'),
    [{ slot: 'invented_slot', value: 'Helvetica Neue', reason: 'unknown_slot' }]
  );
  assert.deepEqual(result.substitutions, []);
});

test('validateThemeProposal accepts a single GENERIC font family with no further fallback', () => {
  const result = validateThemeProposal({ proposal: { fonts: { sans: 'serif' } }, intake: intakeFixture() });
  assert.deepEqual(result.applied.fonts, { sans: 'serif' });
});

test('validateThemeProposal THROWS CloneError when every proposed token drops', () => {
  assert.throws(
    () => validateThemeProposal({ proposal: { colors: { primary: 'not a color at all' } }, intake: intakeFixture() }),
    CloneError
  );
});

test('validateThemeProposal does not throw on a genuinely empty proposal, but still names every color slot as missing', () => {
  const result = validateThemeProposal({ proposal: {}, intake: intakeFixture() });
  assert.deepEqual(result, {
    applied: { colors: {}, fonts: {} },
    dropped: [],
    missingKeys: ['accent', 'primary', 'secondary'],
    substitutions: [],
  });
});

test('validateThemeProposal returns an empty missingKeys when every site color slot is covered', () => {
  const result = validateThemeProposal({
    proposal: { colors: { primary: '#111111', secondary: '#222222', accent: '#333333' } },
    intake: intakeFixture(),
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

/** The page bodies the restamp stage now `object_get`s for itself (CLONE-INTAKE-FIX.md Defect B):
 *  one `{ objectId, body }` per page it is about to patch, never read out of the envelope. */
const pageBodiesFor = (objectId, sections) => [{ objectId, body: { route: '/', sections } }];

test('buildRestampOps carries an already-bound first-party asset src through byte-identical', () => {
  const boundSrc = '/img/req_capture_fixture/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.jpg';
  const sections = [
    { id: 's_media01', type: 'media', data: { items: [{ kind: 'image', src: boundSrc, alt: 'A photo' }] } },
  ];
  const intake = restampIntake();
  const result = buildRestampOps({
    intake,
    mintReport: { rejected: [] },
    pageBodies: pageBodiesFor('page_capture_abc123', sections),
  });
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
  // Never mutates the fetched body it was handed.
  result.restamp[0].ops[0].section.data.items[0].src = 'MUTATED';
  assert.equal(sections[0].data.items[0].src, boundSrc);
});

test('buildRestampOps SKIPS (never half-restamps) a page whose recipe was rejected at mint', () => {
  const intake = restampIntake();
  // The briefing publishes each page's candidateIds precisely so a rejected design can be traced back
  // to the page that depended on it once the mapping is no longer in the envelope.
  assert.deepEqual(intake.pages[0].candidateIds, ['candidate_hero01']);
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
  const result = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [{ id: 's_hero01', type: 'hero', data: { heading: 'Welcome' } }]),
  });
  assert.deepEqual(result.restamp, []);
  assert.deepEqual(result.skipped, [{ objectId: 'page_capture_abc123', reason: 'recipe_rejected_at_mint' }]);
});

test('buildRestampOps SKIPS a page whose body was never fetched', () => {
  const intake = restampIntake();
  intake.pages.push({
    pageRef: 'page_missing',
    objectId: 'page_missing_obj',
    route: '/missing',
    sourceShape: [],
    emittedShape: [],
    gaps: [],
    candidateIds: [],
  });
  const result = buildRestampOps({
    intake,
    mintReport: { rejected: [] },
    pageBodies: pageBodiesFor('page_capture_abc123', [{ id: 's_hero01', type: 'hero', data: { heading: 'Welcome' } }]),
  });
  assert.ok(
    result.skipped.some((entry) => entry.objectId === 'page_missing_obj' && entry.reason === 'source_page_missing')
  );
});

test('buildRestampOps SKIPS rather than emptying a page whose fetched section list is empty', () => {
  const intake = restampIntake();
  const result = buildRestampOps({
    intake,
    mintReport: { rejected: [] },
    pageBodies: pageBodiesFor('page_capture_abc123', []),
  });
  assert.deepEqual(result.restamp, []);
  assert.deepEqual(result.skipped, [{ objectId: 'page_capture_abc123', reason: 'would_empty_page' }]);
});

test('buildRestampOps THROWS CloneError when a section carries a remote URL in an asset field', () => {
  const intake = restampIntake();
  assert.throws(
    () =>
      buildRestampOps({
        intake,
        mintReport: { rejected: [] },
        pageBodies: pageBodiesFor('page_capture_abc123', [
          {
            id: 's_media01',
            type: 'media',
            data: { items: [{ kind: 'image', src: 'https://evil.example/hotlink.jpg', alt: 'stolen' }] },
          },
        ]),
      }),
    CloneError
  );
});

test('buildRestampOps THROWS CloneError for a remote URL under an *AssetRef field too', () => {
  const intake = restampIntake();
  assert.throws(
    () =>
      buildRestampOps({
        intake,
        mintReport: { rejected: [] },
        pageBodies: pageBodiesFor('page_capture_abc123', [
          { id: 's_bio01', type: 'bio', data: { portraitAssetRef: 'https://evil.example/portrait.jpg' } },
        ]),
      }),
    CloneError
  );
});

test('buildRestampOps throws CloneError without a briefing to restamp against', () => {
  assert.throws(() => buildRestampOps({ intake: {}, mintReport: {}, pageBodies: [] }), CloneError);
  assert.throws(() => buildRestampOps({ intake: restampIntake(), mintReport: undefined, pageBodies: [] }), CloneError);
});

// ─── 5b. T13.4 PART C: applying fit_adjudicator's adjudication ────────────────────────────────────
//
// fit_adjudicator (cms-agent's cloneConductorNodes.ts, AI judgment 4/4) reads THIS module's own
// `substitutions[]` ledger and emits `clone_fit_adjudication.v1`: `{ choices: [{kind, wanted, chosen,
// basis, fidelityCost}], declined: [...] }`. These tests exercise the re-validation contract — the
// model's output is advisory, never trusted, exactly like every other AI-node output this module
// already re-checks.

function sectionTypeLedgerEntry({ wanted, candidates }) {
  return {
    kind: 'section_type',
    wanted,
    chosen: null,
    reason: 'slot_section_type_not_allowed',
    basis: 'engine-computed basis',
    fidelityCost: candidates.length > 0 ? 'minor' : 'material',
    substitutable: candidates.length > 0,
    candidates,
  };
}

test("buildRestampOps APPLIES a validated choice — the section's type becomes `chosen`, nothing else about it changes", () => {
  const intake = restampIntake();
  const mintReport = {
    rejected: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'lede', candidates: ['hero'] })],
  };
  const adjudication = {
    artifact: 'clone_fit_adjudication.v1',
    summary: 'x',
    choices: [
      {
        kind: 'section_type',
        wanted: 'lede',
        chosen: 'hero',
        basis: 'hero is the closest live opener',
        fidelityCost: 'minor',
      },
    ],
    declined: [],
  };
  const originalSection = { id: 's_lede01', type: 'lede', data: { heading: 'Welcome' } };
  const result = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [originalSection]),
    adjudication,
  });
  assert.equal(result.skipped.length, 0);
  assert.deepEqual(result.restamp[0].ops[0].section, { id: 's_lede01', type: 'hero', data: { heading: 'Welcome' } });
  assert.deepEqual(result.appliedSubstitutions, [{ wanted: 'lede', chosen: 'hero' }]);
  assert.deepEqual(result.substitutionRejections, []);
  // The caller's own design object is never mutated by the swap.
  assert.equal(originalSection.type, 'lede');
});

test('buildRestampOps REJECTS a cross-class choice (substitution_not_in_candidates) and leaves the page untouched', () => {
  const intake = restampIntake();
  const mintReport = {
    rejected: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'contact_form', candidates: ['newsletter_signup'] })],
  };
  // `prose` is live nowhere near contact_form's class — a model hallucinating "prose is close enough"
  // is exactly the failure item 3's hard boundary exists to make impossible.
  const adjudication = {
    choices: [
      {
        kind: 'section_type',
        wanted: 'contact_form',
        chosen: 'prose',
        basis: 'looked close enough',
        fidelityCost: 'minor',
      },
    ],
    declined: [],
  };
  const result = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [{ id: 's_cf01', type: 'contact_form', data: {} }]),
    adjudication,
  });
  assert.equal(result.restamp[0].ops[0].section.type, 'contact_form'); // uncoerced
  assert.deepEqual(result.appliedSubstitutions, []);
  assert.equal(result.substitutionRejections.length, 1);
  assert.deepEqual(result.substitutionRejections[0], {
    kind: 'section_type',
    wanted: 'contact_form',
    chosen: null,
    reason: 'substitution_not_in_candidates',
    basis:
      'the model proposed "prose" for "contact_form", which is not one of this engine\'s own candidates ' +
      '("newsletter_signup") — never applied',
    fidelityCost: 'material',
    substitutable: true,
    candidates: ['newsletter_signup'],
  });
});

test('buildRestampOps REJECTS a same-class choice that was never actually offered as a candidate', () => {
  const intake = restampIntake();
  // `prose`'s real compatibility class (narrative_text) has THREE members — checklist and bio — but
  // this run's own mint-time candidate list only ever offered `checklist` (say, because `bio` was not
  // live in the registry that run). `assertSameCompatibilityClass('prose','bio')` would PASS on its
  // own; this test proves the SECOND check (membership in what THIS run actually offered) is applied
  // independently and still refuses it.
  const mintReport = {
    rejected: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'prose', candidates: ['checklist'] })],
  };
  assert.doesNotThrow(() => assertSameCompatibilityClass('prose', 'bio'));
  const adjudication = {
    choices: [
      { kind: 'section_type', wanted: 'prose', chosen: 'bio', basis: 'bio reads fine here too', fidelityCost: 'minor' },
    ],
    declined: [],
  };
  const result = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [{ id: 's_prose01', type: 'prose', data: {} }]),
    adjudication,
  });
  assert.equal(result.restamp[0].ops[0].section.type, 'prose');
  assert.deepEqual(result.appliedSubstitutions, []);
  assert.equal(result.substitutionRejections[0].reason, 'substitution_not_in_candidates');
  assert.deepEqual(result.substitutionRejections[0].candidates, ['checklist']);
});

test('buildRestampOps leaves the page exactly as-is for a DECLINED ledger entry', () => {
  const intake = restampIntake();
  const mintReport = { rejected: [], substitutions: [sectionTypeLedgerEntry({ wanted: 'faq', candidates: [] })] };
  const adjudication = {
    choices: [],
    declined: [
      {
        kind: 'section_type',
        wanted: 'faq',
        basis: 'nothing else preserves a question/answer set',
        fidelityCost: 'material',
      },
    ],
  };
  const originalSection = { id: 's_faq01', type: 'faq', data: { items: [] } };
  const result = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [originalSection]),
    adjudication,
  });
  assert.deepEqual(result.restamp[0].ops[0].section, originalSection);
  assert.deepEqual(result.appliedSubstitutions, []);
  assert.deepEqual(result.substitutionRejections, []);
});

test('buildRestampOps: an OMITTED adjudication is byte-identical to calling it with none at all', () => {
  const intake = restampIntake();
  const sections = [{ id: 's_hero01', type: 'hero', data: { heading: 'Welcome' } }];
  const omitted = buildRestampOps({
    intake,
    mintReport: { rejected: [] },
    pageBodies: pageBodiesFor('page_capture_abc123', sections),
  });
  const explicitUndefined = buildRestampOps({
    intake,
    mintReport: { rejected: [] },
    pageBodies: pageBodiesFor('page_capture_abc123', sections),
    adjudication: undefined,
  });
  assert.deepEqual(omitted.restamp, explicitUndefined.restamp);
  assert.deepEqual(omitted.skipped, explicitUndefined.skipped);
  assert.deepEqual(omitted.appliedSubstitutions, []);
  assert.deepEqual(omitted.substitutionRejections, []);
  // And nothing about the section itself is touched when there is nothing to adjudicate.
  assert.equal(omitted.restamp[0].ops[0].section.type, 'hero');
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
  // A run whose mint/theme reports carry no `.substitutions` (hand-built fixtures, or an older report
  // shape) still gets the field, empty rather than missing.
  assert.deepEqual(report.substitutions, []);
  assert.deepEqual(report.humanGate, {
    publishedByThisRun: false,
    note: 'Clone runs only ever write drafts. Publishing any object this run created or changed remains a separate, human-gated decision.',
  });
});

// T13.4 PART B item 4: substitutions[] as a first-class REPORT section — every compromise the run
// made, in one place, never buried inside mint.rejected or theme.dropped.
test('buildCloneRunReport surfaces substitutions[] from BOTH the mint and theme stages, first-class', () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [],
    rejected: [],
    reused: [],
    substitutions: [
      {
        kind: 'section_type',
        wanted: 'lede',
        chosen: null,
        reason: 'slot_section_type_not_allowed',
        basis: '1 live, allowed section type(s) share "lede"\'s compatibility class',
        fidelityCost: 'minor',
        substitutable: true,
        candidates: ['hero'],
      },
    ],
  };
  const themeReport = {
    applied: { colors: {}, fonts: {} },
    dropped: [],
    substitutions: [
      {
        kind: 'font',
        wanted: 'Helvetica Neue',
        chosen: null,
        reason: 'no_fallback_stack',
        basis: "3 font value(s) already active on this site's palette have a usable fallback stack",
        fidelityCost: 'minor',
        substitutable: true,
        candidates: ["'Inter Variable', system-ui", 'Georgia, serif', 'Playfair Display, serif'],
      },
    ],
  };
  const restampReport = { restamp: [], skipped: [] };

  const report = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design: {} });

  assert.equal(report.substitutions.length, 2);
  assert.deepEqual(
    report.substitutions.map((entry) => entry.kind),
    ['section_type', 'font']
  );
  assert.ok(report.substitutions.every((entry) => entry.chosen === null));
  // A deep clone, not a shared reference — mutating the report must not reach the caller's report.
  report.substitutions[0].candidates.push('MUTATED');
  assert.deepEqual(mintReport.substitutions[0].candidates, ['hero']);
});

// ─── 6b. T13.4 PART C: folding fit_adjudicator's adjudication into substitutions[] ─────────────────

test('buildCloneRunReport fills in chosen/basis/fidelityCost for an APPLIED section_type entry, from restampReport (never re-trusting adjudication directly)', () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [],
    rejected: [],
    reused: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'lede', candidates: ['hero'] })],
  };
  const themeReport = { applied: { colors: {}, fonts: {} }, dropped: [] };
  // What buildRestampOps actually validated and applied — the ground truth this function reads.
  const restampReport = {
    restamp: [{ objectId: 'page_capture_abc123', ops: [{ op: 'upsert_section' }] }],
    skipped: [],
    appliedSubstitutions: [{ wanted: 'lede', chosen: 'hero' }],
    substitutionRejections: [],
  };
  const adjudication = {
    choices: [
      {
        kind: 'section_type',
        wanted: 'lede',
        chosen: 'hero',
        basis: 'hero is the closest live opener',
        fidelityCost: 'minor',
      },
    ],
    declined: [],
  };

  const report = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design: {}, adjudication });

  assert.equal(report.substitutions.length, 1);
  assert.deepEqual(report.substitutions[0], {
    kind: 'section_type',
    wanted: 'lede',
    chosen: 'hero',
    reason: 'slot_section_type_not_allowed',
    basis: 'hero is the closest live opener',
    fidelityCost: 'minor',
    substitutable: true,
    candidates: ['hero'],
  });
});

test("buildCloneRunReport carries a DECLINED entry through with chosen:null, overlaying the model's own basis", () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [],
    rejected: [],
    reused: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'faq', candidates: [] })],
  };
  const themeReport = { applied: { colors: {}, fonts: {} }, dropped: [] };
  const restampReport = { restamp: [], skipped: [], appliedSubstitutions: [], substitutionRejections: [] };
  const adjudication = {
    choices: [],
    declined: [
      {
        kind: 'section_type',
        wanted: 'faq',
        basis: 'nothing else preserves a question/answer set',
        fidelityCost: 'material',
      },
    ],
  };

  const report = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design: {}, adjudication });

  assert.equal(report.substitutions.length, 1);
  assert.equal(report.substitutions[0].chosen, null);
  assert.equal(report.substitutions[0].basis, 'nothing else preserves a question/answer set');
  assert.equal(report.substitutions[0].fidelityCost, 'material');
});

test('buildCloneRunReport SURFACES a substitution_not_in_candidates rejection — an illegal model swap is never buried', () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [],
    rejected: [],
    reused: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'contact_form', candidates: ['newsletter_signup'] })],
  };
  const themeReport = { applied: { colors: {}, fonts: {} }, dropped: [] };
  const adjudication = {
    choices: [
      {
        kind: 'section_type',
        wanted: 'contact_form',
        chosen: 'prose',
        basis: 'looked close enough',
        fidelityCost: 'minor',
      },
    ],
    declined: [],
  };
  // The restamp stage already ran this same adjudication and rejected it — buildRestampOps and
  // buildCloneRunReport are wired to the SAME real pipeline output here, not independently re-derived.
  const restampReport = buildRestampOps({
    intake,
    mintReport,
    pageBodies: pageBodiesFor('page_capture_abc123', [{ id: 's_cf01', type: 'contact_form', data: {} }]),
    adjudication,
  });

  const report = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design: {}, adjudication });

  // Both the original "didn't fit" entry (chosen still null) AND the illegal-swap entry appear.
  assert.equal(report.substitutions.length, 2);
  assert.deepEqual(
    report.substitutions.map((entry) => ({ reason: entry.reason, chosen: entry.chosen })),
    [
      { reason: 'slot_section_type_not_allowed', chosen: null },
      { reason: 'substitution_not_in_candidates', chosen: null },
    ]
  );
});

test('buildCloneRunReport: an OMITTED adjudication produces a substitutions[] byte-identical to before this argument existed', () => {
  const intake = restampIntake();
  const mintReport = {
    createdObjects: [],
    rejected: [],
    reused: [],
    substitutions: [sectionTypeLedgerEntry({ wanted: 'lede', candidates: ['hero'] })],
  };
  const themeReport = { applied: { colors: {}, fonts: {} }, dropped: [] };
  const restampReport = { restamp: [], skipped: [] }; // no appliedSubstitutions/substitutionRejections at all

  const withoutArg = buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design: {} });
  const withUndefined = buildCloneRunReport({
    intake,
    mintReport,
    themeReport,
    restampReport,
    design: {},
    adjudication: undefined,
  });

  assert.deepEqual(withoutArg.substitutions, mintReport.substitutions);
  assert.deepEqual(withoutArg.substitutions, withUndefined.substitutions);
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
