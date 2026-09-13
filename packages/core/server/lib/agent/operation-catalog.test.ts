/**
 * A3 — pure unit tests for operation-catalog.ts: the wire parsers (tolerant
 * of malformed/partial payloads), the risk/registration helpers, and the
 * operationId → RequestKind map that fixes the article-stamping bug.
 * Integration with run_workspace_workflow is covered in
 * orchestration-tools.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  highestEffectRisk,
  needsDurableRegistration,
  operationRequestKind,
  parseOperationExecuteResult,
  parseOperationGet,
  parseOperationList,
  parseOperationPreflight,
  requestKindForWorkflow,
} from './operation-catalog.js';

// ─── parseOperationList ──────────────────────────────────────────────────────

test('parseOperationList reads the six live descriptors and drops anything unparsable rather than throwing', () => {
  const result = parseOperationList({
    operations: [
      { operationId: 'site_inventory', version: 1 },
      { operationId: 'pdf_template_family', version: 2, title: 'PDF family' },
      { operationId: 'no_version' }, // missing required `version` — dropped, not thrown
      'garbage',
      null,
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]!.operationId, 'site_inventory');
  assert.equal(result[1]!.title, 'PDF family');
});

test('parseOperationList degrades to an empty list for a malformed envelope', () => {
  assert.deepEqual(parseOperationList(undefined), []);
  assert.deepEqual(parseOperationList(null), []);
  assert.deepEqual(parseOperationList({}), []);
  assert.deepEqual(parseOperationList({ operations: 'not-an-array' }), []);
  assert.deepEqual(parseOperationList('garbage'), []);
});

// ─── parseOperationGet ───────────────────────────────────────────────────────

test('parseOperationGet reads a known descriptor', () => {
  const result = parseOperationGet({ known: true, descriptor: { operationId: 'document_render', version: 3 } });
  assert.ok(result?.known);
  assert.equal(result.known === true && result.descriptor.operationId, 'document_render');
});

test("parseOperationGet names the registered alternatives for an unknown operation — never echoes the caller's string as usable", () => {
  const result = parseOperationGet({ known: false, registeredOperationIds: ['site_inventory', 'pdf_template_family'] });
  assert.equal(result?.known, false);
  assert.deepEqual(result && !result.known ? result.registeredOperationIds : undefined, [
    'site_inventory',
    'pdf_template_family',
  ]);
});

test('parseOperationGet is undefined for an unreadable envelope, never a guess', () => {
  assert.equal(parseOperationGet(undefined), undefined);
  assert.equal(parseOperationGet({}), undefined);
  assert.equal(
    parseOperationGet({ known: true, descriptor: { version: 1 } }),
    undefined,
    'a descriptor missing operationId must not parse'
  );
});

test('parseOperationGet tolerates a missing registeredOperationIds array on the unknown branch', () => {
  const result = parseOperationGet({ known: false });
  assert.equal(result?.known, false);
  assert.deepEqual(result && !result.known ? result.registeredOperationIds : undefined, []);
});

// ─── parseOperationPreflight ─────────────────────────────────────────────────

test('parseOperationPreflight reads a full result and tolerates missing optional arrays', () => {
  const full = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    appliedDefaults: { locale: 'en' },
    missingRequired: [],
    blockers: [],
    capabilityGaps: [],
  });
  assert.equal(full?.operationId, 'pdf_template_family');
  assert.deepEqual(full?.appliedDefaults, { locale: 'en' });

  const minimal = parseOperationPreflight({ operationId: 'site_inventory', selectedVersion: 1 });
  assert.equal(minimal?.missingRequired, undefined);
});

test('parseOperationPreflight is undefined for a payload missing its required keys', () => {
  assert.equal(parseOperationPreflight({}), undefined);
  assert.equal(parseOperationPreflight({ operationId: 'x' }), undefined, 'selectedVersion is required');
  assert.equal(parseOperationPreflight(null), undefined);
});

// #313: `executable` and `binding` were added to CMS-Agent's wire payload
// after this schema was written — a tolerant parser that silently dropped
// them would reinstate the bug where an unbound operation's preflight looks
// indistinguishable from a bound one to everything downstream.
test('parseOperationPreflight round-trips executable: false and its capabilityGaps evidence, unmodified', () => {
  const wire = {
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    missingRequired: [],
    blockers: [],
    capabilityGaps: [
      {
        capability: 'workflow_binding',
        reason: 'not_supported',
        evidence: { operationId: 'pdf_template_family', implementingTask: 'A7' },
        remedy: 'Implement task A7 to bind pdf_template_family to a workflow.',
      },
    ],
    executable: false,
    binding: null,
  };
  const result = parseOperationPreflight(wire);
  assert.equal(result?.executable, false, 'executable must survive parsing, not be dropped');
  assert.equal(result?.binding, null);
  assert.deepEqual(result?.capabilityGaps, wire.capabilityGaps);
});

test('parseOperationPreflight round-trips executable: true with a populated binding', () => {
  const result = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    executable: true,
    binding: { workflowId: 'pdf_family_conductor' },
  });
  assert.equal(result?.executable, true);
  assert.deepEqual(result?.binding, { workflowId: 'pdf_family_conductor' });
});

test('parseOperationPreflight tolerates a payload with neither executable nor binding — an older CMS-Agent', () => {
  const result = parseOperationPreflight({ operationId: 'pdf_template_family', selectedVersion: 1 });
  assert.equal(result?.executable, undefined);
  assert.equal(result?.binding, undefined);
});

// dispatch-bound-workflow-id: binding.workflowId is the ONLY thing
// resolveCatalogOperation (tools.ts) may dispatch — an operation id is not a
// workflow id. These pin the typed shape (previously z.unknown()).
test('parseOperationPreflight reads a full binding — workflowId, operationId and an inputMapping', () => {
  const result = parseOperationPreflight({
    operationId: 'visual_identity_review_change',
    selectedVersion: 1,
    executable: true,
    binding: {
      workflowId: 'visual_identity',
      operationId: 'visual_identity_review_change',
      inputMapping: { tenantId: 'projectId', autoApply: 'apply' },
    },
  });
  assert.deepEqual(result?.binding, {
    workflowId: 'visual_identity',
    operationId: 'visual_identity_review_change',
    inputMapping: { tenantId: 'projectId', autoApply: 'apply' },
  });
});

test('parseOperationPreflight accepts a binding with only workflowId — operationId and inputMapping are optional', () => {
  const result = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    binding: { workflowId: 'pdf_family_conductor' },
  });
  assert.deepEqual(result?.binding, { workflowId: 'pdf_family_conductor' });
});

test('parseOperationPreflight rejects the WHOLE payload when a present binding is malformed (missing workflowId) — never silently drops it to "no binding"', () => {
  const result = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    binding: { inputMapping: { tenantId: 'projectId' } }, // no workflowId
  });
  assert.equal(result, undefined, 'a malformed binding must fail loud, not be silently treated as absent');
});

// ─── A4: executorBinding on operation.preflight ──────────────────────────────

test('parseOperationPreflight round-trips a populated executorBinding', () => {
  const result = parseOperationPreflight({
    operationId: 'site_inventory',
    selectedVersion: 1,
    executable: true,
    binding: null,
    executorBinding: {
      executorId: 'site_inventory_executor',
      operationId: 'site_inventory',
      inputSchema: { type: 'object', required: ['tenantId'] },
    },
  });
  assert.deepEqual(result?.executorBinding, {
    executorId: 'site_inventory_executor',
    operationId: 'site_inventory',
    inputSchema: { type: 'object', required: ['tenantId'] },
  });
  assert.equal(result?.binding, null, 'an operation is bound to at most one of the two kinds');
});

test('parseOperationPreflight tolerates executorBinding: null (an operation with neither kind of implementation)', () => {
  const result = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    executable: false,
    binding: null,
    executorBinding: null,
  });
  assert.equal(result?.binding, null);
  assert.equal(result?.executorBinding, null);
});

test('parseOperationPreflight tolerates a payload with no executorBinding field at all — a CMS-Agent predating A4', () => {
  const result = parseOperationPreflight({
    operationId: 'pdf_template_family',
    selectedVersion: 1,
    executable: true,
    binding: { workflowId: 'pdf_family_conductor' },
    // no executorBinding key at all
  });
  assert.equal(result?.executorBinding, undefined, 'absent must stay absent, never coerced to null');
  assert.deepEqual(result?.binding, { workflowId: 'pdf_family_conductor' });
});

test('parseOperationPreflight rejects the WHOLE payload when a present executorBinding is malformed (missing executorId)', () => {
  const result = parseOperationPreflight({
    operationId: 'site_inventory',
    selectedVersion: 1,
    executorBinding: { inputSchema: {} }, // no executorId
  });
  assert.equal(result, undefined, 'a malformed executorBinding must fail loud, not be silently treated as absent');
});

// ─── A4: operation.execute's envelope ─────────────────────────────────────────

test('parseOperationExecuteResult reads a successful execution — result + completion carried through unmodified', () => {
  const result = parseOperationExecuteResult({
    operationId: 'site_inventory',
    tenantId: 'platform',
    executed: true,
    refusal: null,
    result: { objects: [{ objectId: 'page_home' }] },
    completion: [{ id: 'inventory_returned', description: 'The inventory was returned.' }],
  });
  assert.equal(result?.executed, true);
  assert.equal(result?.refusal, null);
  assert.deepEqual(result?.result, { objects: [{ objectId: 'page_home' }] });
  assert.deepEqual(result?.completion, [{ id: 'inventory_returned', description: 'The inventory was returned.' }]);
});

test('parseOperationExecuteResult reads each real refusal shape — code/message/evidence never dropped', () => {
  for (const code of ['not_read_only', 'unknown_operation', 'no_executor_binding', 'executor_failed', 'input_invalid']) {
    const result = parseOperationExecuteResult({
      operationId: 'pdf_template_family',
      executed: false,
      refusal: { code, message: `refused: ${code}`, evidence: { detail: code } },
      result: null,
      completion: [],
    });
    assert.equal(result?.executed, false, code);
    assert.equal(result?.refusal?.code, code);
    assert.equal(result?.refusal?.message, `refused: ${code}`);
    assert.deepEqual(result?.refusal?.evidence, { detail: code });
  }
});

test('parseOperationExecuteResult tolerates a refusal with no evidence field', () => {
  const result = parseOperationExecuteResult({
    operationId: 'pdf_template_family',
    executed: false,
    refusal: { code: 'unknown_operation', message: 'not registered' },
  });
  assert.equal(result?.refusal?.code, 'unknown_operation');
  assert.equal(result?.refusal?.evidence, undefined);
});

test('parseOperationExecuteResult is undefined for a payload missing its required keys', () => {
  assert.equal(parseOperationExecuteResult({}), undefined, 'operationId/executed are required');
  assert.equal(parseOperationExecuteResult(null), undefined);
  assert.equal(parseOperationExecuteResult({ operationId: 'x' }), undefined, 'executed is required');
});

// ─── highestEffectRisk / needsDurableRegistration ────────────────────────────

test('highestEffectRisk picks the worst of several effects, publish over write over read', () => {
  assert.equal(
    highestEffectRisk([
      { kind: 'a', riskLevel: 'read' },
      { kind: 'b', riskLevel: 'publish' },
      { kind: 'c', riskLevel: 'write' },
    ]),
    'publish'
  );
  assert.equal(highestEffectRisk([{ kind: 'a', riskLevel: 'read' }]), 'read');
  assert.equal(highestEffectRisk([]), undefined);
  assert.equal(highestEffectRisk(undefined), undefined);
});

test('highestEffectRisk ignores an effect with an unrecognised riskLevel rather than crashing', () => {
  assert.equal(highestEffectRisk([{ kind: 'a', riskLevel: 'catastrophic' as unknown as 'read' }]), undefined);
});

test('needsDurableRegistration is true only for write/publish — a pure read is answered inline, never registered', () => {
  assert.equal(needsDurableRegistration([{ kind: 'a', riskLevel: 'read' }]), false);
  assert.equal(needsDurableRegistration([{ kind: 'a', riskLevel: 'write' }]), true);
  assert.equal(needsDurableRegistration([{ kind: 'a', riskLevel: 'publish' }]), true);
  assert.equal(needsDurableRegistration(undefined), false);
  assert.equal(needsDurableRegistration([]), false);
});

// ─── operationRequestKind / requestKindForWorkflow (THE article-stamping fix) ─

test('operationRequestKind maps every one of the six live operations to its own kind, never article', () => {
  assert.equal(operationRequestKind('site_inventory'), 'other');
  assert.equal(operationRequestKind('visual_identity_review_change'), 'theme');
  assert.equal(operationRequestKind('pdf_template_family'), 'pdf');
  assert.equal(operationRequestKind('document_render'), 'pdf');
  assert.equal(operationRequestKind('asset_lookup_adopt'), 'media');
  assert.equal(operationRequestKind('image_template_revision'), 'page');
});

test('operationRequestKind falls back to "other" for an unrecognised id — never a silent "article"', () => {
  assert.equal(operationRequestKind('some_future_operation'), 'other');
  assert.notEqual(operationRequestKind('some_future_operation'), 'article');
});

test('requestKindForWorkflow: THE regression this module fixes — a PDF workflow id is never stamped article', () => {
  assert.equal(requestKindForWorkflow('pdf_template_family'), 'pdf');
  assert.equal(requestKindForWorkflow('document_render'), 'pdf');
});

test('requestKindForWorkflow: undefined and publishing_conductor ARE article, by construction (ART-1)', () => {
  assert.equal(requestKindForWorkflow(undefined), 'article');
  assert.equal(requestKindForWorkflow('publishing_conductor'), 'article');
});

test('requestKindForWorkflow: an unrecognised workflow id is "other", never a guessed "article"', () => {
  assert.equal(requestKindForWorkflow('some_custom_workflow'), 'other');
});
