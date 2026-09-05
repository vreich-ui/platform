/**
 * `visual_standard.v1` — the brand-imagery wave's thirteenth object type
 * (BRIEF.md §3.1, R1/R2). Pins: the body schema (reused brandImagery, bounds
 * on label/references/sampleSubjects/weight/region), the id shape (vis_<site>
 * house / vis_<site>_<slug> template), the kind:'house' singleton (409 on a
 * second ACTIVE house — a template create never trips it), the ordinary
 * set_visual_standard_fields patch op (apply + exact inverse), the published
 * contract (constraints, NOT governed), and — the point of the type — that it
 * is NOT publishable (outside approval-policy.ts governedObjectTypes; the
 * publish gate refuses it; object_publish never widens to cover it).
 */
import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for tests hitting active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  VISUAL_STANDARD_SCHEMA_VERSION,
  visualStandardBodySchema,
  type VisualStandardBody,
} from '../../packages/core/schema/bodies/visual-standard-v1.js';
import { brandImagerySchema } from '../../packages/core/schema/bodies/site-v1.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import { governedObjectTypes } from '../../packages/core/lib/approval-policy.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { mintId, visualStandardSeed } from '../../packages/core/lib/object-ids-mint.js';
import { templateSlug, visualStandardTemplateId } from '../../packages/core/lib/admin/visual-identity-imagery.js';
import { visualStandardIdFor } from '../../packages/core/cli/visual-standard-genesis.mjs';
import { objectRecordKey } from '../../packages/core/server/lib/object-store-keys.js';
import { patchOpNamesByObjectType } from '../../packages/core/schema/object-patch-ops.js';
import {
  applyPatchOps,
  derivePatchInverse,
  type PatchOpCapture,
} from '../../packages/core/lib/object-patch-apply.js';
import { checkPublishGate } from '../../packages/core/server/lib/publish-gate.js';
import {
  handleObjectVerb,
  type ObjectVerbRequest,
  type ObjectVerbStore,
} from '../../packages/core/server/lib/object-verbs.js';
import { buildStoreValidationContext } from '../../packages/core/server/lib/object-validation-context.js';
import { validateObject } from '../../packages/core/server/lib/object-validate.js';
import { objectTypes, type ObjectRecord, type Principal } from '../../packages/core/schema/object-record-v1.js';

const AGENT: Principal = { kind: 'agent', agent_name: 'vis-test', auth: 'publish_key' };
const HUMAN: Principal = { kind: 'human', id: 'wolf', email: 'wolf@example.com' };
const NOW = Date.parse('2026-09-01T12:00:00.000Z');
const AT = '2026-09-01T12:00:00.000Z';

const VALID_BRAND_IMAGERY: VisualStandardBody['brandImagery'] = {
  version: 1,
  medium: 'photograph',
  styleSentence: 'Clinical-clean skincare editorial photography with soft studio light.',
  palette: ['#2E5C42', '#C2A878'],
  negative: ['no stock-photo gloss'],
  aspectRatios: { article_header: '3:2' },
  seedBase: 100001,
};

const VALID: VisualStandardBody = {
  version: 1,
  kind: 'house',
  label: 'Dr. Lurié house look',
  description: 'The site-wide default image style.',
  brandImagery: VALID_BRAND_IMAGERY,
  references: [
    { id: 'ref_a1b2c3d4', blobKey: 'img/mood/1.jpg', note: 'the palette, not the subject', weight: 0.8 },
    { id: 'ref_e5f6g7h8', blobKey: 'img/mood/2.jpg', region: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } },
  ],
  sampleSubjects: ['a woman applying serum', 'a dermatologist consultation'],
  status: 'draft',
};

// ─── the type exists and is reachable the ordinary way ───────────────────────

test('visual_standard is a governed-surface object type but deliberately NOT a governed (publishable) one', () => {
  assert.ok((objectTypes as readonly string[]).includes('visual_standard'));
  assert.equal(objectTypes.length, 13);
  assert.ok(!(governedObjectTypes as readonly string[]).includes('visual_standard'));
});

test('the id shape is vis_<site> (house) or vis_<site>_<slug> (template) and nothing else', () => {
  assert.ok(validateObjectIdForType('visual_standard', 'vis_drlurie').ok);
  assert.ok(validateObjectIdForType('visual_standard', 'vis_drlurie_editorial').ok);
  assert.ok(!validateObjectIdForType('visual_standard', 'thm_drlurie').ok);
  assert.ok(!validateObjectIdForType('visual_standard', 'vis_Drlurie').ok);
});

test('brandImagery is REUSED verbatim from site-v1.ts — never forked', () => {
  assert.equal(visualStandardBodySchema.shape.brandImagery, brandImagerySchema);
});

test('object_contract("visual_standard") is reachable, NOT governed, and NOT publishable', () => {
  const contract = buildObjectContract('visual_standard');
  assert.equal(contract.object_type, 'visual_standard');
  assert.equal(contract.governed, false);
  assert.equal(contract.publish_policy.gated, false);
  assert.equal(contract.publish_policy.requires_approval, false);
  const properties = (contract.body_schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const field of ['kind', 'label', 'brandImagery', 'references', 'sampleSubjects', 'status']) {
    assert.ok(field in properties, `${field} must appear in the published body_schema`);
  }
  assert.deepEqual(patchOpNamesByObjectType.visual_standard, ['set_visual_standard_fields']);
  const op = contract.patch_ops.find((candidate) => candidate.op === 'set_visual_standard_fields');
  assert.ok(op?.arg_schema, 'set_visual_standard_fields must publish an arg_schema');
  // Never a tracked surface — the shared constraint must not be a false promise here.
  assert.ok(!contract.constraints.some((constraint) => constraint.id === 'tracking_attribute'));
  for (const id of [
    'visual_standard_brand_imagery_reused',
    'visual_standard_house_singleton',
    'visual_standard_not_publishable',
    // A2: mood-board reference id constraints (ref_<8> minted server-side,
    // req_visref_<site>_<yyyymmdd>_<nn> minted by the import endpoint).
    'reference_ids',
    'reference_import_request_ids',
  ]) {
    assert.ok(
      contract.constraints.some((constraint) => constraint.id === id),
      `${id} must be published`
    );
  }
});

// ─── shape + bounds ────────────────────────────────────────────────────────

test('a well-formed standard parses; unknown keys are refused (strict)', () => {
  assert.ok(visualStandardBodySchema.safeParse(VALID).success);
  assert.ok(!visualStandardBodySchema.safeParse({ ...VALID, extra: true }).success);
});

test('label is bounded to 80 chars', () => {
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, label: 'x'.repeat(80) }).success);
  assert.ok(!visualStandardBodySchema.safeParse({ ...VALID, label: 'x'.repeat(81) }).success);
});

test('references is bounded to 24 entries', () => {
  const makeRefs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: `ref_${String(i).padStart(8, '0')}`, blobKey: `img/${i}.jpg` }));
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, references: makeRefs(24) }).success);
  assert.ok(!visualStandardBodySchema.safeParse({ ...VALID, references: makeRefs(25) }).success);
});

test('sampleSubjects must have 1..6 entries once active/archived; a draft may start empty (FIX-E)', () => {
  // VALID is status:'draft' — a fresh clone (derivedFrom.method:'clone') may
  // start with zero sample subjects, since a page snapshot can say what a
  // picture looks like, never what it is OF.
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, sampleSubjects: [] }).success);
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, sampleSubjects: ['one'] }).success);
  assert.ok(
    visualStandardBodySchema.safeParse({ ...VALID, sampleSubjects: ['a', 'b', 'c', 'd', 'e', 'f'] }).success
  );
  // The 6-entry ceiling is unconditional — it never depended on status.
  assert.ok(
    !visualStandardBodySchema.safeParse({ ...VALID, sampleSubjects: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }).success
  );

  // The floor comes BACK the moment status leaves 'draft' — active and
  // archived (which was active once) both require 1..6.
  for (const status of ['active', 'archived'] as const) {
    const empty = visualStandardBodySchema.safeParse({ ...VALID, status, sampleSubjects: [] });
    assert.ok(!empty.success, `status:'${status}' with 0 sampleSubjects must be refused`);
    assert.ok(visualStandardBodySchema.safeParse({ ...VALID, status, sampleSubjects: ['one'] }).success);
  }
});

test('reference weight is bounded 0..1', () => {
  const withWeight = (weight: number) => ({
    ...VALID,
    references: [{ ...VALID.references[0]!, weight }],
  });
  assert.ok(visualStandardBodySchema.safeParse(withWeight(0)).success);
  assert.ok(visualStandardBodySchema.safeParse(withWeight(1)).success);
  assert.ok(!visualStandardBodySchema.safeParse(withWeight(1.01)).success);
  assert.ok(!visualStandardBodySchema.safeParse(withWeight(-0.01)).success);
});

test('reference region fractions are bounded 0..1', () => {
  const withRegion = (region: Record<string, number>) => ({
    ...VALID,
    references: [{ ...VALID.references[0]!, region }],
  });
  assert.ok(visualStandardBodySchema.safeParse(withRegion({ x: 0, y: 0, w: 1, h: 1 })).success);
  assert.ok(!visualStandardBodySchema.safeParse(withRegion({ x: -0.1, y: 0, w: 1, h: 1 })).success);
  assert.ok(!visualStandardBodySchema.safeParse(withRegion({ x: 0, y: 0, w: 1.1, h: 1 })).success);
});

test('kind is house or template, nothing else', () => {
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, kind: 'house' }).success);
  assert.ok(visualStandardBodySchema.safeParse({ ...VALID, kind: 'template', whenToUse: 'For guide PDFs.' }).success);
  assert.ok(!visualStandardBodySchema.safeParse({ ...VALID, kind: 'default' }).success);
});

test('schema_version constant matches the object type', () => {
  assert.equal(VISUAL_STANDARD_SCHEMA_VERSION, 'visual_standard.v1');
});

// ─── patch + inverse ──────────────────────────────────────────────────────

const visualStandardRecord = (body: unknown): ObjectRecord<unknown> => ({
  object_id: 'vis_drlurie',
  object_type: 'visual_standard',
  schema_version: VISUAL_STANDARD_SCHEMA_VERSION,
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

test('set_visual_standard_fields deep-merges and inverts exactly, including brandImagery and references', () => {
  const result = applyPatchOps(
    visualStandardRecord(VALID),
    [
      {
        op: 'set_visual_standard_fields',
        fields: { label: 'Updated look', brandImagery: { styleSentence: 'Warmer, softer light.' } },
      },
    ],
    { actor: { kind: 'agent', agent_name: 'writer', auth: 'mcp_token' }, at: AT }
  );
  const applied = result.record.body as VisualStandardBody;
  assert.equal(applied.label, 'Updated look');
  assert.equal(applied.brandImagery.styleSentence, 'Warmer, softer light.');
  // Untouched sibling fields survive the deep merge.
  assert.equal(applied.brandImagery.medium, VALID_BRAND_IMAGERY.medium);
  assert.equal(result.body_mutated, true);

  const entry = result.record.history.at(-1)!;
  const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
  const back = applyPatchOps(result.record, [inverse], { actor: HUMAN, at: AT });
  assert.deepEqual(back.record.body, VALID);
});

// ─── singleton refusal (verbs) — kind:'house' only ────────────────────────

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

test('create: a house is a singleton (409 on a second active house); templates are an ordinary, unbounded collection', async () => {
  const store = createMemoryStore();
  const call = async (request: ObjectVerbRequest, principal: Principal) => {
    const verbStore = store as unknown as ObjectVerbStore;
    const validationContext = await buildStoreValidationContext(verbStore);
    return handleObjectVerb(verbStore, request, principal, { nowMs: NOW, validationContext });
  };
  const createRequest = (id: string, body: VisualStandardBody): ObjectVerbRequest => ({
    action: 'create',
    object_type: 'visual_standard',
    site: 'site_drlurie',
    body,
    requested_id: id,
  });

  // Agents may create visual_standard objects (open by default — the writer
  // materializer must be able to mint/patch the house standard, R§3.5).
  const houseCreated = await call(createRequest('vis_drlurie', VALID), AGENT);
  assert.equal(houseCreated.status, 200, JSON.stringify(houseCreated.body));

  const secondHouse = await call(createRequest('vis_second', VALID), HUMAN);
  assert.equal(secondHouse.status, 409, 'a second active house is refused regardless of id');
  assert.match(JSON.stringify(secondHouse.body), /singleton|exactly one/i);

  // A template create never trips the house singleton...
  const template1 = await call(
    createRequest('vis_drlurie_editorial', { ...VALID, kind: 'template', whenToUse: 'For guide PDFs.' }),
    AGENT
  );
  assert.equal(template1.status, 200, JSON.stringify(template1.body));
  const template2 = await call(
    createRequest('vis_drlurie_seasonal', { ...VALID, kind: 'template', whenToUse: 'For seasonal campaigns.' }),
    AGENT
  );
  assert.equal(template2.status, 200, JSON.stringify(template2.body));

  // ...and, symmetrically, the two now-active templates never conflict with
  // (or count toward) the house singleton check.
  const objectValidate = await call(
    { action: 'validate', object_type: 'visual_standard', site: 'site_drlurie', body: VALID } as ObjectVerbRequest,
    HUMAN
  );
  assert.equal(objectValidate.status, 200);
  assert.ok(
    (objectValidate.body as { singleton_conflict?: unknown }).singleton_conflict,
    'a candidate house dry-run still reports the real existing-house conflict'
  );
});

// ─── REVIEW (brand-imagery wave): a mood board must be able to hold a REAL
// pdf-tool image key ─────────────────────────────────────────────────────────
//
// The fixture above uses `img/mood/1.jpg`, which is not a Major-Key artifact
// ref, so it never met `checkRenderableImageRefs` — the "raw artifact key in a
// renderable field breaks the build" guard. A real reference (what
// `import_images_from_url`, the admin's library picker via
// `blobKeyFromPreviewUrl`, and X1's example generator all produce) IS a Major
// Key, and it was refused 422 `render_image_ref` on every create and every
// patch: the mood-board Save button, the import flow, and the example writer
// were all dead against the one field the type exists to carry. Nothing
// renders a visual_standard, so the guard does not apply to it.
test('a mood board and its examples may hold real pdf-tool artifact keys (nothing renders a visual_standard)', async () => {
  const store = createMemoryStore();
  const verbStore = store as unknown as ObjectVerbStore;
  const sha = 'a'.repeat(64);
  const withRealKeys: VisualStandardBody = {
    ...VALID,
    references: [{ id: 'ref_a1b2c3d4', blobKey: `image/req_agent_mood_board_20260901_01/${sha}.webp` }],
    examples: [
      {
        usageContext: 'article_header',
        blobKey: `image/req_visimg_vis_drlurie_article_header_20260901_02/${sha}.png`,
        contractHash: sha,
      },
    ],
  };

  const created = await handleObjectVerb(
    verbStore,
    { action: 'create', object_type: 'visual_standard', site: 'site_drlurie', body: withRealKeys, requested_id: 'vis_drlurie' },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));

  // ...and the same body still fails the guard on a type something DOES
  // render, so the exemption is scoped, not a hole in the check.
  const renderable = validateObject(
    { objectType: 'theme', objectId: 'thm_drlurie_default', body: { imageAssetRefButRendered: `image/req_x_y_20260901_01/${sha}.webp` } },
    await buildStoreValidationContext(verbStore)
  );
  const imageRefCriterion = renderable
    .flatMap((group) => group.criteria)
    .find((criterion) => criterion.id === 'render_image_ref');
  assert.equal(imageRefCriterion?.status, 'missing', 'the guard still fires for a rendered type');
});

// ─── the point of the type: NOT publishable ───────────────────────────────

test('object_publish is refused for visual_standard — it is outside the generic publish gate', () => {
  const record = visualStandardRecord(VALID) as ObjectRecord;
  const result = checkPublishGate({ record, principal: HUMAN, roles: ['admin'], requested: {} });
  assert.equal(result.allow, false);
  if (!result.allow) {
    assert.equal(result.code, 'content_item_not_gated');
  }
});

// ─── id MINTING: the 2026-09 incident ─────────────────────────────────────
//
// A user asked the admin chat to create the site's house standard. The agent
// called object_validate with a realistic candidate body and the chat died on
// a raw, leaked store error: "Netlify Blobs has generated an internal error
// (400 status code, ID: cb90450d-…)".
//
// Cause: seedForCreate (object-verbs.ts) had no case for visual_standard — P1
// added the `vis` prefix to OBJECT_PREFIX without the matching seed rule — so
// it fell through to stringifying the WHOLE BODY as the id seed. A tiny probe
// body minted the (already absurd) id
// `vis_kind_house_label_probe_samplesubjects_a_hand_status_draft_version_1`
// and "worked"; a realistic one minted a several-hundred-character id that
// could not be a blob key.
//
// These pin both halves of the fix: the id is minted from the RULE (the site),
// and it agrees with every other implementation of that rule in the fleet.

/** The candidate body from the live dr-lurie incident, shape-for-shape. */
const INCIDENT_HOUSE_BODY: VisualStandardBody = {
  version: 1,
  kind: 'house',
  label: 'Dr. Lurié House Visual Standard',
  description:
    'The default image style for Dr. Lurié — evidence-led skin health. Applies to article headers, PDF covers and ' +
    'social cards unless a template overrides it.',
  brandImagery: {
    version: 1,
    medium: 'photograph',
    styleSentence:
      'Clinical-clean editorial photography with soft north-facing daylight, matte skin texture, shallow depth of ' +
      'field, muted sage and warm sand tones, and generous negative space — calm, unglamorised, closer to a ' +
      'dermatology journal than a cosmetics campaign.',
    palette: ['#2E5C42', '#C2A878', '#F4F1EC'],
    negative: ['no stock-photo gloss', 'no oversaturation', 'no visible branding', 'no text overlays'],
    aspectRatios: { article_header: '3:2', pdf_cover: '1:1', social_card: '16:9' },
    seedBase: 100001,
  },
  references: [],
  sampleSubjects: ['a hand applying serum to a forearm', 'a dermatologist reviewing a skin chart'],
  status: 'draft',
};

test('INCIDENT: the exact live body mints vis_drlurie — never an id derived from the body', async () => {
  const store = createMemoryStore();
  const verbStore = store as unknown as ObjectVerbStore;
  const call = async (request: ObjectVerbRequest) =>
    handleObjectVerb(verbStore, request, AGENT, {
      nowMs: NOW,
      validationContext: await buildStoreValidationContext(verbStore),
    });

  // object_create, the way the agent would have reached it.
  const created = await call({
    action: 'create',
    object_type: 'visual_standard',
    site: 'site_drlurie',
    body: INCIDENT_HOUSE_BODY,
  });
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const record = created.body.record as ObjectRecord;
  assert.equal(record.object_id, 'vis_drlurie');

  // The failing call itself: object_validate with a candidate body and no id.
  // The site is resolved from the store's own site singleton, so the incident
  // call needs nothing new from the caller to mint correctly.
  const withSite = createMemoryStore();
  await withSite.setJSON(objectRecordKey('site', 'site_drlurie'), { object_id: 'site_drlurie' });
  const dryRun = await handleObjectVerb(
    withSite as unknown as ObjectVerbStore,
    { action: 'validate', object_type: 'visual_standard', body: INCIDENT_HOUSE_BODY },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(withSite as unknown as ObjectVerbStore) }
  );
  assert.equal(dryRun.status, 200, JSON.stringify(dryRun.body));
  assert.equal(dryRun.body.object_id, 'vis_drlurie');

  // And the old behaviour is gone in the way that matters: nothing about the
  // body reaches the id.
  const mintedFromLabel = String(dryRun.body.object_id).includes('house') || String(dryRun.body.object_id).includes('label');
  assert.equal(mintedFromLabel, false, 'the id must carry no trace of the body');
});

test('a template mints vis_<site>_<slug> from its label; the house stays vis_<site>', async () => {
  const store = createMemoryStore();
  await store.setJSON(objectRecordKey('site', 'site_drlurie'), { object_id: 'site_drlurie' });
  const verbStore = store as unknown as ObjectVerbStore;
  const create = async (body: VisualStandardBody) =>
    handleObjectVerb(
      verbStore,
      { action: 'create', object_type: 'visual_standard', site: 'site_drlurie', body },
      AGENT,
      { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
    );

  const house = await create(INCIDENT_HOUSE_BODY);
  assert.equal(house.status, 200, JSON.stringify(house.body));
  assert.equal((house.body.record as ObjectRecord).object_id, 'vis_drlurie');

  const template = await create({
    ...INCIDENT_HOUSE_BODY,
    kind: 'template',
    label: 'Seasonal Campaign Look',
    whenToUse: 'For seasonal campaign PDFs.',
  });
  assert.equal(template.status, 200, JSON.stringify(template.body));
  assert.equal((template.body.record as ObjectRecord).object_id, 'vis_drlurie_seasonal_campaign_look');

  // A second template is an ordinary sibling, not a singleton conflict, and
  // gets its OWN id — the body-seeded minting could not have guaranteed that
  // for two templates whose bodies differed only in prose.
  const second = await create({
    ...INCIDENT_HOUSE_BODY,
    kind: 'template',
    label: 'Guide Covers',
    whenToUse: 'For downloadable guide covers.',
  });
  assert.equal(second.status, 200, JSON.stringify(second.body));
  assert.equal((second.body.record as ObjectRecord).object_id, 'vis_drlurie_guide_covers');
});

test('the minted id agrees with the CLI genesis rule and the admin studio rule across a table of slugs', () => {
  // Three independent implementations of BRIEF R2, none of which can import
  // the others (the genesis half is plain .mjs so bare `node` CLIs can load
  // it; the studio half is browser-safe and cannot pull in node:crypto), plus
  // CMS-Agent's visualStandardIds.ts outside this repo entirely. This table is
  // the joint that keeps them from drifting.
  for (const slug of ['drlurie', 'platform', 'zilberman', 'fernwell', 'acme2', 'a', 'dr_lurie_clinic']) {
    const site = `site_${slug}`;
    assert.equal(
      mintId({ kind: 'object', objectType: 'visual_standard' }, visualStandardSeed(site)),
      visualStandardIdFor(slug),
      `house id for ${site}`
    );
    for (const label of ['Seasonal Campaign', 'guide-covers', 'PDF Covers 2026']) {
      assert.equal(
        mintId({ kind: 'object', objectType: 'visual_standard' }, visualStandardSeed(site, label)),
        visualStandardTemplateId(slug, templateSlug(label)),
        `template id for ${site} / ${label}`
      );
    }
  }

  // Every id the rule produces is a legal visual_standard id, by the real validator.
  for (const id of [visualStandardIdFor('drlurie'), visualStandardTemplateId('drlurie', templateSlug('Guide Covers'))]) {
    assert.ok(validateObjectIdForType('visual_standard', id).ok, id);
  }
});

test('a create with no site to derive from is a readable refusal, never a body-seeded id', async () => {
  const store = createMemoryStore();
  const verbStore = store as unknown as ObjectVerbStore;
  // A dry-run against a store with no site singleton cannot resolve one.
  const res = await handleObjectVerb(
    verbStore,
    { action: 'validate', object_type: 'visual_standard', body: INCIDENT_HOUSE_BODY },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
  );
  assert.equal(res.status, 400, JSON.stringify(res.body));
  assert.match(String(res.body.detail), /derived from the site/i);
  assert.match(String(res.body.detail), /requested_id/);

  // Naming the site explicitly is all it takes.
  const withSite = await handleObjectVerb(
    verbStore,
    { action: 'validate', object_type: 'visual_standard', site: 'site_drlurie', body: INCIDENT_HOUSE_BODY },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
  );
  assert.equal(withSite.status, 200, JSON.stringify(withSite.body));
  assert.equal(withSite.body.object_id, 'vis_drlurie');
});

// ─── A2: mood-board reference id normalizer ────────────────────────────────
//
// set_visual_standard_fields was a plain deep-merge with no id minting of its
// own (object-patch-apply.ts's applyFieldsOp) and the contract said nothing
// about the rule (object-contract.ts) — so agents invented or omitted
// references[].id and patches either drifted or collided. The fix lives in
// object-verbs.ts's mintOpsIds, the SAME pre-engine normalizer that already
// mints term/section/nav/node ids: an id-less references[] entry is minted
// ref_<8 lowercase hex> from its own payload (and reported in minted[]); a
// resulting duplicate id — minted or caller-supplied — is refused (422)
// before the engine ever runs.

const createHouseForReferenceTests = async () => {
  const store = createMemoryStore();
  const verbStore = store as unknown as ObjectVerbStore;
  const created = await handleObjectVerb(
    verbStore,
    { action: 'create', object_type: 'visual_standard', site: 'site_drlurie', body: INCIDENT_HOUSE_BODY },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
  );
  assert.equal(created.status, 200, JSON.stringify(created.body));
  const checkout = await handleObjectVerb(
    verbStore,
    { action: 'checkout', object_type: 'visual_standard', object_id: 'vis_drlurie' },
    AGENT,
    { nowMs: NOW, validationContext: await buildStoreValidationContext(verbStore) }
  );
  assert.equal(checkout.status, 200, JSON.stringify(checkout.body));
  return {
    store,
    verbStore,
    lockToken: checkout.body.lockToken as string,
    version: checkout.body.record_version as number,
  };
};

test('a set_visual_standard_fields patch with no reference ids succeeds and returns the minted ids', async () => {
  const { verbStore, lockToken, version } = await createHouseForReferenceTests();

  const patch = await handleObjectVerb(
    verbStore,
    {
      action: 'patch',
      object_type: 'visual_standard',
      object_id: 'vis_drlurie',
      lock_token: lockToken,
      expected_record_version: version,
      ops: [
        {
          op: 'set_visual_standard_fields',
          fields: {
            references: [
              { blobKey: 'img/mood/1.jpg', note: 'the palette, not the subject' }, // no id
              { blobKey: 'img/mood/2.jpg' }, // no id
            ],
          },
        },
      ],
    },
    AGENT,
    { nowMs: NOW }
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  const minted = patch.body.minted as { index: number; field: string; id: string }[];
  assert.equal(minted.length, 2);
  assert.equal(minted[0]!.field, 'fields.references[0].id');
  assert.equal(minted[1]!.field, 'fields.references[1].id');
  for (const entry of minted) assert.match(entry.id, /^ref_[a-f0-9]{8}$/);
  assert.notEqual(minted[0]!.id, minted[1]!.id, 'distinct entries mint distinct ids');

  const after = await handleObjectVerb(
    verbStore,
    { action: 'get', object_type: 'visual_standard', object_id: 'vis_drlurie' },
    AGENT,
    { nowMs: NOW }
  );
  const body = (after.body.record as ObjectRecord).body as VisualStandardBody;
  assert.equal(body.references.length, 2);
  assert.equal(body.references[0]!.id, minted[0]!.id);
  assert.equal(body.references[1]!.id, minted[1]!.id);
});

test('a set_visual_standard_fields patch that omits an id on ONE entry mints only that one, leaving a supplied id untouched', async () => {
  const { verbStore, lockToken, version } = await createHouseForReferenceTests();

  const patch = await handleObjectVerb(
    verbStore,
    {
      action: 'patch',
      object_type: 'visual_standard',
      object_id: 'vis_drlurie',
      lock_token: lockToken,
      expected_record_version: version,
      ops: [
        {
          op: 'set_visual_standard_fields',
          fields: {
            references: [
              { id: 'ref_caller01', blobKey: 'img/mood/1.jpg' }, // caller-supplied — left alone
              { blobKey: 'img/mood/2.jpg' }, // no id — minted
            ],
          },
        },
      ],
    },
    AGENT,
    { nowMs: NOW }
  );
  assert.equal(patch.status, 200, JSON.stringify(patch.body));

  const minted = patch.body.minted as { index: number; field: string; id: string }[];
  assert.equal(minted.length, 1);
  assert.equal(minted[0]!.field, 'fields.references[1].id');

  const after = await handleObjectVerb(
    verbStore,
    { action: 'get', object_type: 'visual_standard', object_id: 'vis_drlurie' },
    AGENT,
    { nowMs: NOW }
  );
  const body = (after.body.record as ObjectRecord).body as VisualStandardBody;
  assert.equal(body.references[0]!.id, 'ref_caller01', 'the supplied id is never overwritten');
  assert.equal(body.references[1]!.id, minted[0]!.id);
});

test('a set_visual_standard_fields patch with duplicate reference ids is refused (422) and never persists', async () => {
  const { verbStore, lockToken, version } = await createHouseForReferenceTests();

  const patch = await handleObjectVerb(
    verbStore,
    {
      action: 'patch',
      object_type: 'visual_standard',
      object_id: 'vis_drlurie',
      lock_token: lockToken,
      expected_record_version: version,
      ops: [
        {
          op: 'set_visual_standard_fields',
          fields: {
            references: [
              { id: 'ref_dupe0001', blobKey: 'img/mood/1.jpg' },
              { id: 'ref_dupe0001', blobKey: 'img/mood/2.jpg' },
            ],
          },
        },
      ],
    },
    AGENT,
    { nowMs: NOW }
  );
  assert.equal(patch.status, 422, JSON.stringify(patch.body));
  assert.equal(patch.body.code, 'invalid_body');
  assert.match(String(patch.body.message), /duplicate reference id/i);

  // Nothing persisted — the record is exactly as checkout left it.
  const after = await handleObjectVerb(
    verbStore,
    { action: 'get', object_type: 'visual_standard', object_id: 'vis_drlurie' },
    AGENT,
    { nowMs: NOW }
  );
  assert.equal((after.body.record as ObjectRecord).version, version);
});
