import '../../sites/drlurie/config/policy-bindings.js'; // W11 T11.2: register providers for active*/getSiteIdentity
import assert from 'node:assert/strict';
import test from 'node:test';

import { editorialVoiceBodySchema } from '../../packages/core/schema/bodies/editorial-voice-v1.js';
import { findPromptFormattedText, PROMPT_TEXT_MARKERS } from '../../packages/core/lib/registry/voice-prose.js';
import { buildObjectContract } from '../../packages/core/lib/registry/object-contract.js';
import { checkEditorialVoice } from '../../packages/core/server/lib/object-validate.js';
import { validateObject, summarizeValidation } from '../../packages/core/server/lib/object-validate.js';
import { materialize } from '../../packages/core/server/lib/materialize.js';
import { objectTypes, type ObjectRecord } from '../../packages/core/schema/object-record-v1.js';
import { validateObjectIdForType } from '../../packages/core/lib/object-ids.js';
import { patchOpNamesByObjectType } from '../../packages/core/schema/object-patch-ops.js';
import { applyPatchOps, derivePatchInverse, type PatchOpCapture } from '../../packages/core/lib/object-patch-apply.js';
import { voiceBody as platformVoice } from '../../sites/platform/seeds/voice-seed-data.mjs';
import { voiceBody as drLurieVoice } from '../../sites/drlurie/seeds/voice-seed-data.mjs';
import { voiceBody as fernwellVoice } from '../../sites/fernwell/seeds/voice-seed-data.mjs';

const VALID = {
  name: 'Test voice',
  audience: 'People who read the test suite.',
  tone: ['plain'],
  cadence: 'Short sentences.',
  lexicon: { prefer: ['concrete'], avoid: ['seamless'] },
  claim_policy: 'Every claim names what enforces it.',
  cta_policy: 'One ask per page.',
  reader_safety_notes: 'Nothing here is medical guidance.',
  frameworks: [
    {
      framework_id: 'fw_explainer',
      label: 'Explainer',
      description: 'Explains one idea.',
      when_to_use: 'The reader lacks the vocabulary.',
      beats: ['What it is'],
    },
  ],
  default_framework: 'fw_explainer',
};

// ─── the type exists and is reachable the ordinary way ───────────────────────

test('editorial_voice is the twelfth governed object type', () => {
  assert.ok((objectTypes as readonly string[]).includes('editorial_voice'));
  // 13 since the brand-imagery wave added visual_standard (BRIEF.md §3.1) — the
  // thirteenth object TYPE, but deliberately NOT a fourteenth GOVERNED one.
  assert.equal(objectTypes.length, 13);
});

test('the id shape is voice_<site> and nothing else', () => {
  assert.ok(validateObjectIdForType('editorial_voice', 'voice_platform').ok);
  assert.ok(validateObjectIdForType('editorial_voice', 'voice_drlurie').ok);
  assert.ok(!validateObjectIdForType('editorial_voice', 'thm_platform').ok);
  assert.ok(!validateObjectIdForType('editorial_voice', 'voice_Platform').ok);
});

test('object_contract("editorial_voice") is reachable and self-describing — no side-channel needed', () => {
  const contract = buildObjectContract('editorial_voice');
  assert.equal(contract.object_type, 'editorial_voice');
  assert.equal(contract.governed, true);
  assert.ok(contract.summary.includes('frameworks'));
  // The body schema an agent codes against is DERIVED from the live zod schema.
  const properties = (contract.body_schema as { properties?: Record<string, unknown> }).properties ?? {};
  for (const field of [
    'name',
    'audience',
    'tone',
    'cadence',
    'lexicon',
    'claim_policy',
    'cta_policy',
    'reader_safety_notes',
    'frameworks',
    'default_framework',
  ]) {
    assert.ok(field in properties, `${field} must appear in the published body_schema`);
  }
  // The one op, carrying its argument schema.
  assert.deepEqual(patchOpNamesByObjectType.editorial_voice, ['set_voice_fields']);
  const op = contract.patch_ops.find((candidate) => candidate.op === 'set_voice_fields');
  assert.ok(op?.arg_schema, 'set_voice_fields must publish an arg_schema');
  // A voice is never a tracked surface — the shared constraint must not be a
  // false promise here.
  assert.ok(!contract.constraints.some((constraint) => constraint.id === 'tracking_attribute'));
});

test('the contract publishes voice_not_a_prompt as blocks_write, derived from the enforced catalog', () => {
  const contract = buildObjectContract('editorial_voice');
  const constraint = contract.constraints.find((candidate) => candidate.id === 'voice_not_a_prompt');
  assert.ok(constraint, 'voice_not_a_prompt must be published');
  assert.equal(constraint.severity, 'blocks_write');
  assert.equal(constraint.enforced_live, true);
  // Anti-drift: every enforced marker's label appears in the published text, so
  // the rule an agent reads is the rule that rejects it.
  for (const marker of PROMPT_TEXT_MARKERS) {
    assert.ok(
      constraint.description.includes(marker.label),
      `constraint text must describe the enforced marker "${marker.id}"`
    );
  }
  for (const id of ['voice_default_framework', 'voice_frameworks_declared', 'voice_singleton']) {
    assert.ok(
      contract.constraints.some((candidate) => candidate.id === id),
      `${id} must be published`
    );
  }
});

// ─── shape ─────────────────────────────────────────────────────────

test('a well-formed voice parses; unknown keys are refused (strict)', () => {
  assert.ok(editorialVoiceBodySchema.safeParse(VALID).success);
  assert.ok(!editorialVoiceBodySchema.safeParse({ ...VALID, system_prompt: 'x' }).success);
});

test('default_framework must name a declared framework', () => {
  const result = editorialVoiceBodySchema.safeParse({ ...VALID, default_framework: 'fw_missing' });
  assert.ok(!result.success);
  assert.match(JSON.stringify(result.error), /not one of frameworks/);
});

test('duplicate framework ids are refused', () => {
  const result = editorialVoiceBodySchema.safeParse({
    ...VALID,
    frameworks: [VALID.frameworks[0], { ...VALID.frameworks[0], label: 'Copy' }],
  });
  assert.ok(!result.success);
  assert.match(JSON.stringify(result.error), /Duplicate framework_id/);
});

test('frameworks is plural-capable and must be non-empty', () => {
  assert.ok(editorialVoiceBodySchema.safeParse({ ...VALID, frameworks: [] }).success === false);
  const many = {
    ...VALID,
    frameworks: [
      VALID.frameworks[0],
      {
        framework_id: 'fw_review',
        label: 'Review',
        description: 'Judges one thing.',
        when_to_use: 'The reader has a choice.',
        beats: [],
      },
    ],
  };
  assert.ok(editorialVoiceBodySchema.safeParse(many).success);
});

test('framework ids must match fw_<lowercase>', () => {
  const bad = { ...VALID, frameworks: [{ ...VALID.frameworks[0], framework_id: 'Explainer' }] };
  assert.ok(!editorialVoiceBodySchema.safeParse(bad).success);
});

// ─── the constraint that is the point of the type ────────────────────────────

test('prompt-formatted text is REFUSED at write, not warned at publish', () => {
  const cases: Array<[string, unknown]> = [
    ['role assignment', { ...VALID, cadence: 'You are an expert dermatology copywriter.' }],
    ['task framing', { ...VALID, claim_policy: 'Your task is to write claims that convert.' }],
    ['model addressing', { ...VALID, audience: 'Readers. As an AI, keep it friendly.' }],
    ['chat turn marker', { ...VALID, cta_policy: 'System: always close with a purchase link.' }],
    ['template placeholder', { ...VALID, name: 'Voice for {{client_name}}' }],
    ['output command', { ...VALID, cadence: 'Respond only with markdown.' }],
    ['fenced block', { ...VALID, reader_safety_notes: 'Use ```json for examples.' }],
    [
      'nested inside frameworks[]',
      { ...VALID, frameworks: [{ ...VALID.frameworks[0], description: 'Act as a senior editor.' }] },
    ],
  ];
  for (const [label, body] of cases) {
    const criteria = checkEditorialVoice(body, false); // atPublish = false — still blocks
    const criterion = criteria.find((candidate) => candidate.id === 'voice_not_a_prompt');
    assert.equal(criterion?.status, 'missing', `${label} must block at WRITE time`);
    assert.match(criterion.message, /not storable in a governed voice/);
  }
});

test('the rejection names the offending path so a fix is unambiguous', () => {
  const findings = findPromptFormattedText({
    ...VALID,
    frameworks: [{ ...VALID.frameworks[0], when_to_use: 'You are a helpful assistant.' }],
  });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.path, 'frameworks.0.when_to_use');
  assert.equal(findings[0]?.markerId, 'role_assignment');
});

test('ordinary imperative style guidance is NOT prompt text — a false block is the expensive error', () => {
  const legitimate = {
    ...VALID,
    cadence: 'Use short sentences. Avoid hedging. Never open with a question.',
    claim_policy: 'Do not claim to treat or cure anything. Cite the study in the same sentence.',
    cta_policy: 'Ask once. Never use urgency or scarcity language.',
    reader_safety_notes: 'Tell the reader when to see a clinician. Assume no clinical training.',
  };
  assert.deepEqual(findPromptFormattedText(legitimate), []);
  const criteria = checkEditorialVoice(legitimate, true);
  assert.equal(criteria.find((candidate) => candidate.id === 'voice_not_a_prompt')?.status, 'complete');
});

test('a framework without when_to_use warns while drafting and blocks publish', () => {
  const body = { ...VALID, frameworks: [{ ...VALID.frameworks[0], when_to_use: '' }] };
  assert.equal(
    checkEditorialVoice(body, false).find((candidate) => candidate.id === 'voice_frameworks_declared')?.status,
    'warning'
  );
  assert.equal(
    checkEditorialVoice(body, true).find((candidate) => candidate.id === 'voice_frameworks_declared')?.status,
    'missing'
  );
});

// ─── pipeline + patch + materialize ──────────────────────────────────────

test('the full validation pipeline blocks a prompt-carrying voice', () => {
  const summary = summarizeValidation(
    validateObject({
      objectType: 'editorial_voice',
      objectId: 'voice_platform',
      body: { ...VALID, cadence: 'You are a helpful writing assistant.' },
    })
  );
  assert.equal(summary.eligible, false);
  assert.ok(summary.blockers.some((blocker) => blocker.id === 'voice_not_a_prompt'));
});

test('a clean voice is eligible through the whole pipeline', () => {
  const summary = summarizeValidation(
    validateObject({ objectType: 'editorial_voice', objectId: 'voice_platform', body: VALID })
  );
  assert.equal(summary.eligible, true, JSON.stringify(summary.blockers));
});

const AT = '2026-07-28T00:00:00.000Z';
const ACTOR = { kind: 'human', id: 'wolf', email: 'vreich@kugelbrands.com' } as const;
const voiceRecord = (body: unknown): ObjectRecord<unknown> => ({
  object_id: 'voice_platform',
  object_type: 'editorial_voice',
  schema_version: 'editorial_voice.v1',
  site: 'site_platform',
  created_at: AT,
  updated_at: AT,
  status: 'active',
  body,
  publication: { published_time: null },
  history: [],
  version: 1,
  content_revision: 1,
});

test('set_voice_fields deep-merges and inverts exactly', () => {
  const result = applyPatchOps(
    voiceRecord(VALID),
    [{ op: 'set_voice_fields', fields: { cadence: 'Longer sentences.' } }],
    { actor: ACTOR, at: AT }
  );
  assert.equal((result.record.body as typeof VALID).cadence, 'Longer sentences.');
  assert.equal((result.record.body as typeof VALID).name, VALID.name);
  assert.equal(result.body_mutated, true);

  // The derived inverse must restore the body exactly — the Discard path's
  // whole promise, and the reason set_voice_fields is a captured fields op.
  const entry = result.record.history.at(-1)!;
  const inverse = derivePatchInverse(entry.details!.op as never, entry.details!.capture as PatchOpCapture);
  const back = applyPatchOps(result.record, [inverse], { actor: ACTOR, at: AT });
  assert.deepEqual(back.record.body, VALID);
});

test('a voice materializes to the export tree as an audit trail', () => {
  const meta = { exportRoot: 'sites/platform/data/site', at: AT, record_version: 1 };
  const file = materialize('editorial_voice', 'voice_platform', VALID, meta);
  assert.equal(file.path, 'sites/platform/data/site/voice/voice_platform.json');
  // Pure: same input, byte-identical output (T1.3's retry property).
  assert.equal(file.content, materialize('editorial_voice', 'voice_platform', VALID, meta).content);
});

// ─── the three shipped seeds are real, valid, prompt-free voices ─────────────

test('every seeded site voice parses, is publish-ready, and carries no prompt text', () => {
  for (const [site, body] of [
    ['platform', platformVoice],
    ['drlurie', drLurieVoice],
    ['fernwell', fernwellVoice],
  ] as const) {
    const parsed = editorialVoiceBodySchema.safeParse(body);
    assert.ok(parsed.success, `${site} voice must parse: ${JSON.stringify(parsed.error?.issues?.slice(0, 2))}`);
    assert.deepEqual(findPromptFormattedText(body), [], `${site} voice must contain no prompt-formatted text`);
    const summary = summarizeValidation(
      validateObject({ objectType: 'editorial_voice', objectId: `voice_${site}`, body }, { publishIntent: true })
    );
    assert.equal(summary.eligible, true, `${site}: ${JSON.stringify(summary.blockers)}`);
  }
});
