/**
 * T15.8 — the page-type registry's `reviewPolicy` must be DERIVED from
 * approval-policy.ts, not an independent static copy, so `registry_get`
 * cannot contradict `publish-gate.ts`'s own resolution for the same
 * governed object type ('page').
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { getPageTypeDefinition, listPageTypeDefinitions, resolvePageTypeReviewPolicy } from './page-types.js';
import type { ApprovalPolicy } from '../approval-policy.js';

const allAutonomous: ApprovalPolicy = { master: 'all-autonomous', overrides: {} };
const allRequireApproval: ApprovalPolicy = { master: 'all-require-approval', overrides: {} };

describe('resolvePageTypeReviewPolicy', () => {
  it('required is false under an all-autonomous posture (matches every fleet site config)', () => {
    assert.equal(resolvePageTypeReviewPolicy(allAutonomous).required, false);
  });

  it('required is true under an all-require-approval posture', () => {
    assert.equal(resolvePageTypeReviewPolicy(allRequireApproval).required, true);
  });

  it('a page-type override beats the master, same as publish-gate.ts', () => {
    const pinned: ApprovalPolicy = { master: 'all-autonomous', overrides: { page: 'require-approval' } };
    assert.equal(resolvePageTypeReviewPolicy(pinned).required, true);
  });

  it('minApprovals and publishRoles are unaffected by the policy (only `required` is derived)', () => {
    const resolved = resolvePageTypeReviewPolicy(allAutonomous);
    assert.equal(resolved.minApprovals, 1);
    assert.deepEqual(resolved.publishRoles, ['admin', 'publisher']);
  });
});

describe('listPageTypeDefinitions / getPageTypeDefinition — policy threading', () => {
  it('with no policy argument, every definition keeps the static conservative default (required: true) — the client-safe fallback', () => {
    for (const definition of listPageTypeDefinitions()) {
      assert.equal(definition.reviewPolicy.required, true);
    }
    const clone = getPageTypeDefinition('clone');
    assert.ok(clone.ok);
    assert.equal(clone.ok && clone.definition.reviewPolicy.required, true);
  });

  it("with an all-autonomous policy, EVERY definition — including 'clone' — reflects the autonomous posture (acceptance: zilberman's clone page type)", () => {
    for (const definition of listPageTypeDefinitions(allAutonomous)) {
      assert.equal(definition.reviewPolicy.required, false, `${definition.id} should reflect all-autonomous`);
    }
    const clone = getPageTypeDefinition('clone', allAutonomous);
    assert.ok(clone.ok);
    assert.equal(clone.ok && clone.definition.reviewPolicy.required, false);
  });

  it('with an all-require-approval policy, every definition stays required', () => {
    for (const definition of listPageTypeDefinitions(allRequireApproval)) {
      assert.equal(definition.reviewPolicy.required, true);
    }
  });

  it('an unknown page type is still unknown_page_type regardless of policy', () => {
    const result = getPageTypeDefinition('not_a_real_type', allAutonomous);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, 'unknown_page_type');
  });
});
