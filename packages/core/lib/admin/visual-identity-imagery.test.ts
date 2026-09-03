/**
 * U1 acceptance: the imagery tab's view model, the before/after diff model,
 * region normalization and weight bounds. Logic-first `node:test` over the
 * pure module — `tsconfig.test.json` excludes `packages/core/admin/**` .tsx,
 * so this file is the only thing that can hold these behaviours honest.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { StudioRecord } from './studio-client.js';
import {
  MIN_REGION_FRACTION,
  appendLibraryReference,
  blobKeyFromPreviewUrl,
  mintReferenceId,
  MOOD_BOARD_MAX_REFERENCES,
  REFERENCE_WEIGHT_DEFAULT,
  buildApplyImageryVerb,
  buildImageryDiff,
  buildImageryWorkspace,
  buildImportReferencesIntent,
  buildNewTemplateDraft,
  buildProposeContractIntent,
  buildReferencesOp,
  buildRegenerateExamplesIntent,
  buildVisualStandardExample,
  clampReferenceWeight,
  exampleArtifact,
  moodBoardArtifact,
  normalizeRegion,
  parseImportUrls,
  parseVisualIdentityTab,
  referenceWeightLabel,
  regionFromDrag,
  regionScopeLabel,
  templateSlug,
} from './visual-identity-imagery.js';

const IMAGERY = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Quiet clinical daylight on matte surfaces.',
  palette: ['#2E5C42', '#F4F1EA'],
  negative: ['stock smiles', 'lens flare'],
  aspectRatios: { article_header: '3:2', pdf_cover: '1:1' },
  seedBase: 42,
};

const PREVIEWABLE = `image/req_abc/${'a'.repeat(64)}.png`;

const record = (
  objectId: string,
  body: Record<string, unknown>,
  history: Array<Record<string, unknown>> = []
): StudioRecord =>
  ({
    object_id: objectId,
    object_type: 'visual_standard',
    schema_version: 'visual_standard.v1',
    site: 'site_demo',
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    status: 'active',
    body,
    publication: {},
    history,
    version: 3,
    content_revision: 1,
  }) as unknown as StudioRecord;

const site = (body: Record<string, unknown>, history: Array<Record<string, unknown>> = []): StudioRecord =>
  ({
    ...(record('site_demo', body, history) as unknown as Record<string, unknown>),
    object_type: 'site',
  }) as StudioRecord;

// ─── tabs ───────────────────────────────────────────────────────────────────

test('the tab query round-trips the three tabs and falls back to identity', () => {
  assert.equal(parseVisualIdentityTab('imagery'), 'imagery');
  assert.equal(parseVisualIdentityTab('pdf'), 'pdf');
  assert.equal(parseVisualIdentityTab('identity'), 'identity');
  assert.equal(parseVisualIdentityTab('templates'), 'identity');
  assert.equal(parseVisualIdentityTab(null), 'identity');
  assert.equal(parseVisualIdentityTab(undefined), 'identity');
});

// ─── weight bounds ──────────────────────────────────────────────────────────

test('reference weight is bounded to 0..1 and defaults to full strength', () => {
  assert.equal(clampReferenceWeight(0.4), 0.4);
  assert.equal(clampReferenceWeight(0), 0);
  assert.equal(clampReferenceWeight(1), 1);
  assert.equal(clampReferenceWeight(1.7), 1, 'above the schema ceiling clamps down');
  assert.equal(clampReferenceWeight(-3), 0, 'below the floor clamps up');
});

test('an unreadable weight resolves to the schema default, never to zero', () => {
  // 0 means "ignore this reference"; silently demoting a corrupt record to 0
  // would quietly drop it from the writer's reading of the board.
  assert.equal(clampReferenceWeight(undefined), REFERENCE_WEIGHT_DEFAULT);
  assert.equal(clampReferenceWeight(null), REFERENCE_WEIGHT_DEFAULT);
  assert.equal(clampReferenceWeight('not a number'), REFERENCE_WEIGHT_DEFAULT);
  assert.equal(clampReferenceWeight(Number.NaN), REFERENCE_WEIGHT_DEFAULT);
  assert.equal(clampReferenceWeight(Number.POSITIVE_INFINITY), REFERENCE_WEIGHT_DEFAULT);
});

test('slider strings are accepted and float noise is rounded away', () => {
  assert.equal(clampReferenceWeight('0.35'), 0.35);
  assert.equal(clampReferenceWeight(0.1 + 0.2), 0.3);
  assert.equal(referenceWeightLabel(0.35), '35% style weight');
  assert.equal(referenceWeightLabel(undefined), '100% style weight');
});

// ─── region normalization ───────────────────────────────────────────────────

test('a region normalizes to bounded 0..1 fractions', () => {
  assert.deepEqual(normalizeRegion({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.4 });
});

test('a drag up-and-left arrives with negative extents and is flipped, not dropped', () => {
  assert.deepEqual(normalizeRegion({ x: 0.6, y: 0.8, w: -0.2, h: -0.3 }), { x: 0.4, y: 0.5, w: 0.2, h: 0.3 });
});

test('a region running past the edge is trimmed to the image', () => {
  assert.deepEqual(normalizeRegion({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }), { x: 0.8, y: 0.9, w: 0.2, h: 0.1 });
  assert.deepEqual(normalizeRegion({ x: -0.4, y: -0.4, w: 0.6, h: 0.6 }), { x: 0, y: 0, w: 0.6, h: 0.6 });
});

test('a full-bleed rectangle is "whole image" (absent), never {0,0,1,1}', () => {
  // visual-standard-v1.ts: an ABSENT region means the whole image. Two
  // encodings of one fact is how a mood board starts disagreeing with itself.
  assert.equal(normalizeRegion({ x: 0, y: 0, w: 1, h: 1 }), undefined);
  assert.equal(normalizeRegion({ x: -0.2, y: -0.2, w: 2, h: 2 }), undefined);
});

test('a mis-click smaller than the minimum fraction is not a crop', () => {
  assert.equal(normalizeRegion({ x: 0.5, y: 0.5, w: MIN_REGION_FRACTION / 2, h: 0.5 }), undefined);
  assert.equal(normalizeRegion({ x: 0.5, y: 0.5, w: 0.5, h: 0 }), undefined);
});

test('non-finite and non-object region input resolves to whole image', () => {
  assert.equal(normalizeRegion({ x: Number.NaN, y: 0, w: 0.5, h: 0.5 }), undefined);
  assert.equal(normalizeRegion(undefined), undefined);
  assert.equal(normalizeRegion('0.1,0.1,0.5,0.5'), undefined);
});

test('pixel drags become fractions against the rendered image box', () => {
  assert.deepEqual(regionFromDrag({ x: 100, y: 50 }, { x: 300, y: 150 }, { width: 400, height: 200 }), {
    x: 0.25,
    y: 0.25,
    w: 0.5,
    h: 0.5,
  });
  // Dragged from the bottom-right corner back to the top-left: same rectangle.
  assert.deepEqual(regionFromDrag({ x: 300, y: 150 }, { x: 100, y: 50 }, { width: 400, height: 200 }), {
    x: 0.25,
    y: 0.25,
    w: 0.5,
    h: 0.5,
  });
  assert.equal(regionFromDrag({ x: 0, y: 0 }, { x: 10, y: 10 }, { width: 0, height: 0 }), undefined);
});

test('the region badge names whole vs region', () => {
  assert.equal(regionScopeLabel(undefined), 'Whole image');
  assert.equal(regionScopeLabel({ x: 0.1, y: 0.1, w: 0.4, h: 0.25 }), 'Region 40×25%');
});

// ─── view model ─────────────────────────────────────────────────────────────

test('the view model joins a site with its standards and marks the applied one', () => {
  const model = buildImageryWorkspace({
    site: site({ name: 'Demo', brandImagery: IMAGERY }, [
      {
        at: '2026-08-20T09:00:00.000Z',
        action: 'set_site_brand_imagery',
        actor: { kind: 'human', id: 'u1' },
        details: { applied_brand_imagery_source: { kind: 'visual_standard', id: 'vis_demo' } },
      },
    ]),
    standards: [
      record('vis_demo_moody', {
        version: 1,
        kind: 'template',
        label: 'Moody',
        whenToUse: 'Long-form essays',
        status: 'active',
        brandImagery: { ...IMAGERY, styleSentence: 'Low-key, high-contrast.' },
        references: [{ id: 'ref_1', blobKey: PREVIEWABLE, weight: 0.5, note: 'the palette, not the subject' }],
        sampleSubjects: ['a consulting room'],
      }),
      record('vis_demo', {
        version: 1,
        kind: 'house',
        label: 'House look',
        status: 'active',
        brandImagery: IMAGERY,
        references: [],
        sampleSubjects: ['a clinician at a desk'],
      }),
    ],
    isOwner: true,
    siteShortId: 'demo',
  });

  assert.equal(model.house?.objectId, 'vis_demo');
  assert.equal(model.houseId, 'vis_demo');
  assert.equal(model.templates.length, 1);
  assert.deepEqual(
    model.standards.map((entry) => entry.objectId),
    ['vis_demo', 'vis_demo_moody'],
    'the house sorts first, templates follow'
  );
  assert.equal(model.house?.appliedToSite, true, "the house's imagery IS the site's applied copy");
  assert.equal(model.templates[0]?.appliedToSite, false);
  assert.equal(model.selected?.objectId, 'vis_demo', 'with no explicit selection the house is selected');
  assert.equal(model.canApply, true);
  assert.equal(model.emptyState, undefined);

  assert.equal(model.applied.present, true);
  assert.equal(model.applied.mediumLabel, 'Photography');
  assert.deepEqual(model.applied.palette, ['#2E5C42', '#F4F1EA']);
  assert.deepEqual(model.applied.negatives, ['stock smiles', 'lens flare']);
  assert.deepEqual(
    model.applied.aspectRatios.map((row) => `${row.context}=${row.ratio}`),
    ['article_header=3:2', 'pdf_cover=1:1'],
    'aspect ratios are sorted by context so the table never reorders between reads'
  );
  assert.equal(model.applied.source.kind, 'visual_standard');
  assert.equal(model.applied.source.id, 'vis_demo');
  assert.equal(model.applied.appliedAt, '2026-08-20T09:00:00.000Z');
});

test('an explicit selection wins, and an unknown selection falls back to the house', () => {
  const standards = [
    record('vis_demo', {
      version: 1,
      kind: 'house',
      label: 'House',
      status: 'active',
      brandImagery: IMAGERY,
      references: [],
      sampleSubjects: ['x'],
    }),
    record('vis_demo_moody', {
      version: 1,
      kind: 'template',
      label: 'Moody',
      status: 'active',
      brandImagery: IMAGERY,
      references: [],
      sampleSubjects: ['x'],
    }),
  ];
  assert.equal(
    buildImageryWorkspace({ site: site({ brandImagery: IMAGERY }), standards, selectedStandardId: 'vis_demo_moody' })
      .selected?.objectId,
    'vis_demo_moody'
  );
  assert.equal(
    buildImageryWorkspace({ site: site({ brandImagery: IMAGERY }), standards, selectedStandardId: 'vis_demo_gone' })
      .selected?.objectId,
    'vis_demo'
  );
});

test('archived standards never reach the board, and an empty board declares itself', () => {
  const model = buildImageryWorkspace({
    site: site({ name: 'Demo' }),
    standards: [
      record('vis_demo_old', {
        version: 1,
        kind: 'template',
        label: 'Retired',
        status: 'archived',
        brandImagery: IMAGERY,
        references: [],
        sampleSubjects: ['x'],
      }),
    ],
  });
  assert.deepEqual(model.standards, []);
  assert.equal(model.emptyState?.title, 'No visual standard yet');
  assert.equal(model.applied.present, false, 'a site with no brandImagery has no applied card');
  assert.equal(model.applied.source.kind, 'unrecorded');
  assert.equal(model.canApply, false, 'apply is Owner-only and nobody said this viewer is an Owner');
  assert.deepEqual(model.examples.items, [], 'no standards ⇒ nothing to show');
  assert.equal(model.examples.canRegenerate, false, 'nothing is selected, so there is nothing to regenerate');
  assert.equal(model.examples.emptyState?.title, 'No standard selected');
});

test('a site whose imagery predates the apply verb reports unrecorded rather than guessing', () => {
  const model = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }, [
      { at: '2026-01-01T00:00:00.000Z', action: 'create', actor: { kind: 'human', id: 'u1' } },
    ]),
    standards: [],
  });
  assert.equal(model.applied.source.kind, 'unrecorded');
  assert.equal(model.applied.appliedAt, undefined);
});

test('the last apply wins when a site has been re-applied', () => {
  const model = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }, [
      {
        at: '2026-02-01T00:00:00.000Z',
        action: 'set_site_brand_imagery',
        actor: { kind: 'human', id: 'u1' },
        details: { applied_brand_imagery_source: { kind: 'theme', id: 'thm_old' } },
      },
      {
        at: '2026-03-01T00:00:00.000Z',
        action: 'set_site_brand_imagery',
        actor: { kind: 'human', id: 'u1' },
        details: { applied_brand_imagery_source: { kind: 'visual_standard', id: 'vis_demo' } },
      },
    ]),
    standards: [],
  });
  assert.equal(model.applied.source.id, 'vis_demo');
  assert.equal(model.applied.appliedAt, '2026-03-01T00:00:00.000Z');
});

test('the mood board carries weight, region scope and a preview only when one can be served', () => {
  const model = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }),
    standards: [
      record('vis_demo', {
        version: 1,
        kind: 'house',
        label: 'House',
        status: 'active',
        brandImagery: IMAGERY,
        sampleSubjects: ['x'],
        references: [
          { id: 'ref_1', blobKey: PREVIEWABLE, weight: 0.25, region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
          { id: 'ref_2', blobKey: 'pdf/not-an-image-key' },
          { id: 'ref_no_key' },
        ],
      }),
    ],
  });
  const references = model.house?.references ?? [];
  assert.equal(references.length, 2, 'a reference with no blobKey is not a reference');
  assert.equal(references[0]?.weight, 0.25);
  assert.equal(references[0]?.scope, 'region');
  assert.match(String(references[0]?.previewUrl), /admin-get-blob-image/);
  assert.equal(references[1]?.weight, 1, 'an omitted weight reads as full strength');
  assert.equal(references[1]?.scope, 'whole');
  assert.equal(references[1]?.previewUrl, undefined);
  assert.match(String(references[1]?.previewUnavailableReason), /previewable/i);
  assert.equal(moodBoardArtifact(references[1]!), undefined);
  assert.equal(moodBoardArtifact(references[0]!)?.kind, 'image');
});

test('the lock guardrail is a notice, never an error', () => {
  const locked = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }),
    standards: [],
    overridePolicy: 'lock',
  });
  assert.equal(locked.locked, true);
  assert.equal(locked.overridePolicy, 'lock');
  assert.match(String(locked.lockNotice), /ignored rather than refused/);
  const open = buildImageryWorkspace({ site: site({ brandImagery: IMAGERY }), standards: [] });
  assert.equal(open.locked, false);
  assert.equal(open.lockNotice, undefined);
});

test('a standard with no site to compare against is never reported as applied', () => {
  const model = buildImageryWorkspace({
    site: undefined,
    standards: [
      record('vis_demo', {
        version: 1,
        kind: 'house',
        label: 'House',
        status: 'active',
        references: [],
        sampleSubjects: ['x'],
      }),
    ],
  });
  assert.equal(model.house?.appliedToSite, false);
});

// ─── diff model ─────────────────────────────────────────────────────────────

test('the before/after diff reports exactly the fields that moved', () => {
  const diff = buildImageryDiff(IMAGERY, {
    ...IMAGERY,
    styleSentence: 'Warmer daylight, softer edges.',
    palette: ['#2E5C42', '#F4F1EA', '#C9603A'],
  });
  assert.equal(diff.hasBefore, true);
  assert.equal(diff.changed, true);
  assert.deepEqual(diff.changedFields, ['styleSentence', 'palette']);
  const medium = diff.rows.find((row) => row.field === 'medium');
  assert.equal(medium?.changed, false);
  assert.equal(medium?.before, 'Photography');
  const palette = diff.rows.find((row) => row.field === 'palette');
  assert.equal(palette?.after, '#2E5C42, #F4F1EA, #C9603A');
});

test('an identical contract diffs to no change at all', () => {
  const diff = buildImageryDiff(IMAGERY, { ...IMAGERY });
  assert.equal(diff.changed, false);
  assert.deepEqual(diff.changedFields, []);
});

test('key order is not a change', () => {
  const reordered = {
    seedBase: 42,
    aspectRatios: { pdf_cover: '1:1', article_header: '3:2' },
    negative: ['stock smiles', 'lens flare'],
    palette: ['#2E5C42', '#F4F1EA'],
    styleSentence: IMAGERY.styleSentence,
    medium: 'photograph',
    version: 1,
  };
  assert.deepEqual(buildImageryDiff(IMAGERY, reordered).changedFields, []);
});

test('a first contract on a site with none is an addition, not a nothing', () => {
  const diff = buildImageryDiff(undefined, IMAGERY);
  assert.equal(diff.hasBefore, false);
  assert.equal(diff.changed, true);
  const style = diff.rows.find((row) => row.field === 'styleSentence');
  assert.equal(style?.before, '—');
  assert.equal(style?.after, IMAGERY.styleSentence);
  const lora = diff.rows.find((row) => row.field === 'lora');
  assert.equal(lora?.changed, false, 'both sides absent is not a change');
});

test('every field of the frozen contract has a diff row', () => {
  assert.deepEqual(
    buildImageryDiff(IMAGERY, IMAGERY).rows.map((row) => row.field),
    ['medium', 'styleSentence', 'palette', 'negative', 'aspectRatios', 'composition', 'seedBase', 'lora']
  );
});

test('nested aspectRatios and composition changes are caught and read as text', () => {
  const diff = buildImageryDiff(IMAGERY, {
    ...IMAGERY,
    aspectRatios: { article_header: '16:9', pdf_cover: '1:1' },
    composition: { cropRule: 'never crop a face', subjectScale: 'mid' },
  });
  assert.deepEqual(diff.changedFields, ['aspectRatios', 'composition']);
  assert.equal(diff.rows.find((row) => row.field === 'aspectRatios')?.after, 'article_header 16:9 · pdf_cover 1:1');
  assert.equal(
    diff.rows.find((row) => row.field === 'composition')?.after,
    'Crop rule: never crop a face; Subject scale: mid'
  );
});

// ─── op payloads and verb requests ──────────────────────────────────────────

test('the references op is one whole-array write with weights normalized', () => {
  const op = buildReferencesOp([
    {
      id: 'ref_1',
      blobKey: PREVIEWABLE,
      weight: 1.4,
      weightLabel: '',
      scope: 'region',
      scopeLabel: '',
      region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
      note: 'the palette',
    },
    { id: 'ref_2', blobKey: PREVIEWABLE, weight: Number.NaN, weightLabel: '', scope: 'whole', scopeLabel: '' },
  ]);
  assert.equal(op.op, 'set_visual_standard_fields');
  assert.deepEqual(op.fields.references, [
    { id: 'ref_1', blobKey: PREVIEWABLE, region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }, note: 'the palette', weight: 1 },
    { id: 'ref_2', blobKey: PREVIEWABLE, weight: 1 },
  ]);
});

test('the references op never writes more than the schema allows', () => {
  const many = Array.from({ length: MOOD_BOARD_MAX_REFERENCES + 5 }, (_, index) => ({
    id: `ref_${index}`,
    blobKey: PREVIEWABLE,
    weight: 1,
    weightLabel: '',
    scope: 'whole' as const,
    scopeLabel: '',
  }));
  assert.equal((buildReferencesOp(many).fields.references as unknown[]).length, MOOD_BOARD_MAX_REFERENCES);
});

test('the apply verb takes exactly one source and needs a checkout only for a real apply', () => {
  assert.deepEqual(buildApplyImageryVerb({ siteId: 'site_demo', visualStandardId: 'vis_demo', dryRun: true }), {
    action: 'apply_brand_imagery',
    site_id: 'site_demo',
    visual_standard_id: 'vis_demo',
    dry_run: true,
  });
  assert.deepEqual(
    buildApplyImageryVerb({
      siteId: 'site_demo',
      visualStandardId: 'vis_demo',
      lockToken: 'lock-1',
      expectedRecordVersion: 7,
    }),
    {
      action: 'apply_brand_imagery',
      site_id: 'site_demo',
      visual_standard_id: 'vis_demo',
      lock_token: 'lock-1',
      expected_record_version: 7,
    }
  );
  assert.throws(() => buildApplyImageryVerb({ siteId: 'site_demo' }), /exactly one/);
  assert.throws(
    () => buildApplyImageryVerb({ siteId: 'site_demo', visualStandardId: 'vis_demo', themeId: 'thm_x' }),
    /exactly one/
  );
});

// ─── new template ───────────────────────────────────────────────────────────

test('a new template clones a valid contract and mints the R2 id', () => {
  const source = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }),
    standards: [
      record('vis_demo', {
        version: 1,
        kind: 'house',
        label: 'House',
        status: 'active',
        brandImagery: IMAGERY,
        references: [{ id: 'ref_1', blobKey: PREVIEWABLE }],
        sampleSubjects: ['a clinician at a desk'],
      }),
    ],
  }).house;

  const result = buildNewTemplateDraft({
    siteShortId: 'demo',
    label: 'Moody Long Form',
    source,
    sourceBrandImagery: IMAGERY,
    whenToUse: 'Long essays',
  });
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.draft.objectId, 'vis_demo_moody_long_form');
  assert.equal(result.draft.body.kind, 'template');
  assert.equal(result.draft.body.status, 'draft');
  assert.deepEqual(
    result.draft.body.references,
    [],
    'a template argues its own look — the house board is not inherited'
  );
  assert.deepEqual(result.draft.body.sampleSubjects, ['a clinician at a desk']);
  assert.deepEqual(result.draft.body.derivedFrom, { method: 'clone', visualStandardId: 'vis_demo' });
});

test('a template cannot be created from nothing', () => {
  const blank = buildNewTemplateDraft({ siteShortId: 'demo', label: 'X', source: undefined, sourceBrandImagery: {} });
  assert.equal(blank.ok, false);
  assert.match(blank.ok ? '' : blank.error, /clone/i);

  const unnamed = buildNewTemplateDraft({
    siteShortId: 'demo',
    label: '   ',
    source: undefined,
    sourceBrandImagery: IMAGERY,
  });
  assert.equal(unnamed.ok, false);

  const unsluggable = buildNewTemplateDraft({
    siteShortId: 'demo',
    label: '——',
    source: undefined,
    sourceBrandImagery: IMAGERY,
  });
  assert.equal(unsluggable.ok, false);
  assert.match(unsluggable.ok ? '' : unsluggable.error, /letters or digits/);
});

test('slugs match the object-ids segment grammar', () => {
  assert.equal(templateSlug('Moody Long-Form!'), 'moody_long_form');
  assert.equal(templateSlug('  Éditorial  '), 'ditorial');
  assert.match(templateSlug('Warm 2026 Winter'), /^[a-z0-9]+(_[a-z0-9]+)*$/);
});

// ─── import form ────────────────────────────────────────────────────────────

test('import parsing keeps https, dedupes, and caps at the node runner image limit', () => {
  const parsed = parseImportUrls(
    [
      'https://a.example/1.png',
      'https://a.example/1.png',
      'http://insecure.example/2.png',
      'ftp://x.example/3.png',
    ].join('\n')
  );
  assert.deepEqual(parsed.urls, ['https://a.example/1.png']);
  assert.equal(parsed.rejected.length, 2);
  assert.match(parsed.rejected[0]!.reason, /https/);

  const many = parseImportUrls(Array.from({ length: 12 }, (_, i) => `https://a.example/${i}.png`).join(' '));
  assert.equal(many.urls.length, 8);
  assert.equal(many.rejected.length, 4);
});

// ─── chat intents (the U3 seam) ─────────────────────────────────────────────

test('the tool-backed buttons build a precise intent naming the real tool', () => {
  const standard = buildImageryWorkspace({
    site: site({ brandImagery: IMAGERY }),
    standards: [
      record('vis_demo', {
        version: 1,
        kind: 'house',
        label: 'House',
        status: 'active',
        brandImagery: IMAGERY,
        references: [{ id: 'ref_1', blobKey: PREVIEWABLE }],
        sampleSubjects: ['x'],
      }),
    ],
  }).house;

  const importIntent = buildImportReferencesIntent({ standard, urls: ['https://a.example/1.png'] });
  assert.equal(importIntent?.tool, 'import_images_from_url');
  assert.match(String(importIntent?.prompt), /vis_demo/);
  assert.equal(buildImportReferencesIntent({ standard, urls: [] }), undefined);

  const propose = buildProposeContractIntent({ standard, mode: 'house' });
  assert.equal(propose.tool, 'brand_imagery_propose');
  assert.equal(propose.starter, 'visual-identity');
  assert.match(propose.prompt, /1 reference/);
  assert.match(propose.prompt, /without my approval/);
});

// ─── library picker helpers ─────────────────────────────────────────────────

test('a blob key is read back out of the projection’s own preview url', () => {
  assert.equal(
    blobKeyFromPreviewUrl(`/.netlify/functions/admin-get-blob-image?blobKey=${encodeURIComponent(PREVIEWABLE)}`),
    PREVIEWABLE
  );
  assert.equal(blobKeyFromPreviewUrl('/.netlify/functions/admin-get-blob-image'), undefined);
  assert.equal(blobKeyFromPreviewUrl(undefined), undefined);
});

test('minted reference ids match the schema regex', () => {
  assert.match(
    mintReferenceId(() => 0.5),
    /^ref_[a-z0-9]+$/
  );
  assert.match(
    mintReferenceId(() => 0),
    /^ref_[a-z0-9]+$/
  );
  assert.match(
    mintReferenceId(() => 0.999999),
    /^ref_[a-z0-9]+$/
  );
});

test('adding a library image refuses duplicates and respects the board ceiling', () => {
  const first = appendLibraryReference([], { blobKey: PREVIEWABLE, note: 'the palette', id: 'ref_aaa' });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.equal(first.references[0]?.weight, 1);
  assert.equal(first.references[0]?.note, 'the palette');

  const duplicate = appendLibraryReference(first.references, { blobKey: PREVIEWABLE, id: 'ref_bbb' });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.ok ? '' : duplicate.error, /already on this mood board/);

  const full = Array.from({ length: MOOD_BOARD_MAX_REFERENCES }, (_, index) => ({
    id: `ref_${index}`,
    blobKey: `image/req_${index}/${'c'.repeat(64)}.png`,
    weight: 1,
    weightLabel: '',
    scope: 'whole' as const,
    scopeLabel: '',
  }));
  const overflow = appendLibraryReference(full, { blobKey: PREVIEWABLE, id: 'ref_zzz' });
  assert.equal(overflow.ok, false);
  assert.match(overflow.ok ? '' : overflow.error, /at most 24/);
});

// ─── examples (X1, R9) ───────────────────────────────────────────────────────

test('buildVisualStandardExample reads usageContext/blobKey and previews when the key is admin-servable', () => {
  const previewable = buildVisualStandardExample({
    usageContext: 'article_header',
    blobKey: PREVIEWABLE,
    contractHash: 'abc',
  });
  assert.equal(previewable?.usageContext, 'article_header');
  assert.equal(previewable?.usageContextLabel, 'Article header');
  assert.equal(previewable?.previewUrl, `/.netlify/functions/admin-get-blob-image?blobKey=${encodeURIComponent(PREVIEWABLE)}`);
  assert.equal(previewable?.previewUnavailableReason, undefined);

  const unpreviewable = buildVisualStandardExample({ usageContext: 'category_page', blobKey: 'not-a-servable-key', contractHash: 'abc' });
  assert.equal(unpreviewable?.previewUrl, undefined);
  assert.match(unpreviewable?.previewUnavailableReason ?? '', /not in the admin-previewable/);

  assert.equal(buildVisualStandardExample({ usageContext: 'article_header' }), undefined, 'no blobKey ⇒ not a usable example');
  assert.equal(buildVisualStandardExample({ blobKey: PREVIEWABLE }), undefined, 'no usageContext ⇒ not a usable example');
});

test('an unrecognized usage context falls back to itself as the label', () => {
  const example = buildVisualStandardExample({ usageContext: 'homepage_hero', blobKey: PREVIEWABLE, contractHash: 'abc' });
  assert.equal(example?.usageContextLabel, 'homepage_hero');
});

test('exampleArtifact adapts a previewable example for ArtifactStagePreview, and refuses an unpreviewable one', () => {
  const previewable = buildVisualStandardExample({ usageContext: 'article_body', blobKey: PREVIEWABLE, contractHash: 'abc' })!;
  const artifact = exampleArtifact(previewable);
  assert.equal(artifact?.kind, 'image');
  assert.equal(artifact?.label, 'Article body');
  assert.equal(artifact?.preview_url, previewable.previewUrl);

  const unpreviewable = buildVisualStandardExample({ usageContext: 'article_body', blobKey: 'nope', contractHash: 'abc' })!;
  assert.equal(exampleArtifact(unpreviewable), undefined);
});

test('buildVisualStandardView maps body.examples[] onto VisualStandardView.examples', () => {
  const standards = [
    record('vis_demo', {
      version: 1,
      kind: 'house',
      label: 'House',
      status: 'active',
      brandImagery: IMAGERY,
      references: [],
      sampleSubjects: ['a mug'],
      examples: [
        { usageContext: 'article_header', blobKey: PREVIEWABLE, contractHash: 'abc' },
        { usageContext: 'article_body', blobKey: 'not-servable', contractHash: 'abc' },
      ],
    }),
  ];
  const model = buildImageryWorkspace({ site: site({}), standards, isAdmin: true });
  assert.equal(model.house?.examples.length, 2);
  assert.equal(model.house?.examples[0]?.usageContext, 'article_header');
  assert.equal(model.house?.examples[0]?.previewUrl !== undefined, true);
  assert.equal(model.house?.examples[1]?.previewUrl, undefined);
});

test('the workspace examples view mirrors the SELECTED standard — items when present, a named empty state otherwise', () => {
  const withExamples = record('vis_demo', {
    version: 1,
    kind: 'house',
    label: 'House',
    status: 'active',
    brandImagery: IMAGERY,
    references: [],
    sampleSubjects: ['a mug'],
    examples: [{ usageContext: 'article_header', blobKey: PREVIEWABLE, contractHash: 'abc' }],
  });
  const withoutExamples = record('vis_demo_alt', {
    version: 1,
    kind: 'template',
    label: 'Alt',
    status: 'draft',
    brandImagery: IMAGERY,
    references: [],
    sampleSubjects: ['a mug'],
  });

  const selectedHasExamples = buildImageryWorkspace({
    site: site({}),
    standards: [withExamples, withoutExamples],
    isAdmin: true,
    selectedStandardId: 'vis_demo',
  });
  assert.equal(selectedHasExamples.examples.items.length, 1);
  assert.equal(selectedHasExamples.examples.canRegenerate, true);
  assert.equal(selectedHasExamples.examples.emptyState, undefined);

  const selectedHasNone = buildImageryWorkspace({
    site: site({}),
    standards: [withExamples, withoutExamples],
    isAdmin: true,
    selectedStandardId: 'vis_demo_alt',
  });
  assert.deepEqual(selectedHasNone.examples.items, []);
  assert.equal(selectedHasNone.examples.emptyState?.title, 'No examples yet');
});

test('a selected standard with no sample subjects gets a distinct empty-state reason', () => {
  const noSubjects = record('vis_demo', {
    version: 1,
    kind: 'house',
    label: 'House',
    status: 'draft',
    brandImagery: IMAGERY,
    references: [],
    sampleSubjects: [],
  });
  const model = buildImageryWorkspace({ site: site({}), standards: [noSubjects], isAdmin: true });
  assert.equal(model.examples.emptyState?.title, 'No sample subjects yet');
});

test('canRegenerate follows canEditBoard (isAdmin), independent of whether examples already exist', () => {
  const standard = record('vis_demo', {
    version: 1,
    kind: 'house',
    label: 'House',
    status: 'active',
    brandImagery: IMAGERY,
    references: [],
    sampleSubjects: ['a mug'],
  });
  const notAdmin = buildImageryWorkspace({ site: site({}), standards: [standard], isAdmin: false });
  assert.equal(notAdmin.examples.canRegenerate, false);
});

test('buildRegenerateExamplesIntent names the standard, the op, and never touches other fields', () => {
  const standard = record('vis_demo', {
    version: 1,
    kind: 'house',
    label: 'House',
    status: 'active',
    brandImagery: IMAGERY,
    references: [],
    sampleSubjects: ['a mug'],
  });
  const view = buildImageryWorkspace({ site: site({}), standards: [standard], isAdmin: true }).selected!;
  const regenIntent = buildRegenerateExamplesIntent(view);
  assert.equal(regenIntent?.tool, 'set_visual_standard_fields');
  assert.equal(regenIntent?.starter, 'visual-identity');
  assert.match(regenIntent?.prompt ?? '', /vis_demo/);
  assert.match(regenIntent?.prompt ?? '', /examples: \[\] \}/);
  assert.match(regenIntent?.prompt ?? '', /do not change anything else/i);

  assert.equal(buildRegenerateExamplesIntent(undefined), undefined);
});
