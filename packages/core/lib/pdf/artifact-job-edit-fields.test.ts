import { strict as assert } from 'node:assert';
import test from 'node:test';
import { PDF_TOOL_EDIT_MODES, resolveArtifactJobEditFields } from './artifact-job-edit-fields.js';

/**
 * The exact input the live reproduction sent through
 * mcp__Kugel-Platform__create_agent_artifact_job on 2026-09-08 — the one that
 * came back with "edit jobs require sourceArtifact.artifactReference; …
 * expectedSha256; … editMode" because the bridge dropped these fields between
 * its own input and the pdf-tool call.
 */
const LIVE_REPRO_INPUT: Record<string, unknown> = {
  site_id: 'site_platform',
  request_id: 'req_agent_qa_image_pipeline_stress_test_round3_20260908_01',
  artifact_kind: 'image',
  operation: 'edit',
  filename: 's1-edit-forwarding-probe.webp',
  prompt: 'probe',
  sourceArtifact: {
    artifactReference: { kind: 'image', sha256: 'abc' },
    expectedSha256: 'abc',
  },
  editMode: 'masked_edit',
};

test('all five edit fields survive the bridge -> pdf-tool mapping', () => {
  const mapped = resolveArtifactJobEditFields({
    ...LIVE_REPRO_INPUT,
    maskRef: { artifactReference: { kind: 'image', sha256: 'mask' } },
    editInstructions: { change: 'warm the light', preserve: ['the jar label'], negativeInstructions: ['no text'] },
  });

  assert.deepEqual(mapped, {
    operation: 'edit',
    sourceArtifact: { artifactReference: { kind: 'image', sha256: 'abc' }, expectedSha256: 'abc' },
    editMode: 'masked_edit',
    maskRef: { artifactReference: { kind: 'image', sha256: 'mask' } },
    editInstructions: { change: 'warm the light', preserve: ['the jar label'], negativeInstructions: ['no text'] },
  });
});

test("the live repro's own input no longer loses sourceArtifact or editMode", () => {
  const mapped = resolveArtifactJobEditFields(LIVE_REPRO_INPUT);
  // These two were the fields pdf-tool reported missing. They are present now.
  assert.ok(mapped.sourceArtifact, 'sourceArtifact must reach pdf-tool');
  assert.ok(mapped.sourceArtifact?.artifactReference, 'sourceArtifact.artifactReference must reach pdf-tool');
  assert.equal(mapped.sourceArtifact?.expectedSha256, 'abc');
  assert.equal(mapped.editMode, 'masked_edit');
  // …and the two the caller did not send stay absent rather than being
  // fabricated as nulls, which pdf-tool's additionalProperties:false object
  // schemas would reject.
  assert.equal('maskRef' in mapped, false);
  assert.equal('editInstructions' in mapped, false);
});

test('an ordinary generate job is completely unchanged', () => {
  assert.deepEqual(resolveArtifactJobEditFields({ artifact_kind: 'image', prompt: 'a tile' }), {});
  assert.deepEqual(resolveArtifactJobEditFields({ operation: 'generate', prompt: 'a tile' }), {
    operation: 'generate',
  });
});

test('every editMode pdf-tool declares is forwarded verbatim', () => {
  for (const mode of PDF_TOOL_EDIT_MODES) {
    assert.equal(resolveArtifactJobEditFields({ operation: 'edit', editMode: mode }).editMode, mode);
  }
});

test('an unknown editMode is forwarded so pdf-tool names it, not silently dropped', () => {
  // Silently dropping it is precisely the failure mode this fix exists to
  // end: the caller would get "edit jobs require editMode" for a field they
  // DID supply. pdf-tool's enum rejection names the actual problem.
  assert.equal(resolveArtifactJobEditFields({ operation: 'edit', editMode: 'rotate_left' }).editMode, 'rotate_left');
});

test('a JSON-stringified object field is understood', () => {
  // An MCP client whose schema does not declare these fields commonly
  // stringifies them — the live reproduction had to.
  const mapped = resolveArtifactJobEditFields({
    operation: 'edit',
    sourceArtifact: '{"artifactReference":{"kind":"image"},"expectedSha256":"abc"}',
  });
  assert.deepEqual(mapped.sourceArtifact, { artifactReference: { kind: 'image' }, expectedSha256: 'abc' });
});

test('wrong-shaped values are dropped rather than forwarded as garbage', () => {
  const mapped = resolveArtifactJobEditFields({
    operation: 'edit',
    sourceArtifact: 'not json at all',
    maskRef: ['an array is not an object'],
    editInstructions: 42,
    editMode: '   ',
  });
  assert.deepEqual(mapped, { operation: 'edit' });
});

test('an operation outside pdf-tool\'s enum is dropped, not cast', () => {
  // The old code cast whatever string arrived straight to 'generate'|'edit'.
  assert.deepEqual(resolveArtifactJobEditFields({ operation: 'EDIT' }), {});
  assert.deepEqual(resolveArtifactJobEditFields({ operation: 'delete' }), {});
});
