// The availability logic reads the LIVE committed approval policy through
// object-review-ui.ts — register the site bindings, the same carve-out
// object-review-ui.test.ts uses.
import '../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  OBJECT_CONTROL_IDS,
  resolveObjectControls,
  reviewDecisionAvailability,
  type ObjectControlsInput,
} from './object-detail-actions.js';

const baseInput: ObjectControlsInput = {
  objectType: 'editorial_voice',
  roles: ['admin'],
  isOwner: true,
  releaseKnown: true,
  lockHeld: false,
  lockHeldByOther: false,
  review: undefined,
  contentRevision: 4,
  requiresApprovalOverride: false,
  status: 'active',
};

const input = (overrides: Partial<ObjectControlsInput> = {}): ObjectControlsInput => ({ ...baseInput, ...overrides });

describe('resolveObjectControls — A4: nothing is ever silently absent', () => {
  it('returns an entry for every control id, in every state', () => {
    const cases = [
      input(),
      input({ roles: [], isOwner: false }),
      input({ releaseKnown: false }),
      input({ status: 'archived' }),
      input({ objectType: 'product' }),
      input({ lockHeld: true, lockHeldByOther: true }),
    ];
    for (const candidate of cases) {
      const controls = resolveObjectControls(candidate);
      for (const id of OBJECT_CONTROL_IDS) {
        assert.ok(controls[id], `${id} must always be present`);
      }
    }
  });

  it('always gives a disabled control a reason to put in the tooltip', () => {
    const cases = [
      input(),
      input({ roles: [], isOwner: false }),
      input({ releaseKnown: false }),
      input({ status: 'archived' }),
      input({ objectType: 'product' }),
      input({ review: { state: 'changes_requested', decisions: [] } }),
      input({ review: { state: 'approved', decisions: [{ content_revision: 4 }] } }),
      input({ lockHeld: true, lockHeldByOther: true }),
    ];
    for (const candidate of cases) {
      const controls = resolveObjectControls(candidate);
      for (const id of OBJECT_CONTROL_IDS) {
        const state = controls[id]!;
        if (!state.enabled) {
          assert.ok(state.reason && state.reason.trim().length > 0, `${id} disabled with no reason`);
        }
      }
    }
  });

  it('says retire has no endpoint rather than blaming the viewer’s rights', () => {
    const owner = resolveObjectControls(input({ isOwner: true, roles: ['admin'] })).retire;
    assert.equal(owner.enabled, false);
    assert.match(owner.reason!, /no admin endpoint|only over MCP/i);
  });
});

describe('resolveObjectControls — rights → control mapping', () => {
  it('disables every decision for a role-less human, naming authority as the reason', () => {
    const controls = resolveObjectControls(input({ roles: [], isOwner: false }));
    assert.equal(controls.approve.enabled, false);
    assert.equal(controls.request_changes.enabled, false);
    assert.equal(controls.publish.enabled, false);
    assert.match(controls.approve.reason!, /authority/i);
  });

  it('fails closed on an unconfirmed release row', () => {
    const controls = resolveObjectControls(input({ releaseKnown: false }));
    for (const id of ['approve', 'request_changes', 'publish', 'reopen_review'] as const) {
      assert.equal(controls[id].enabled, false, id);
    }
    assert.match(controls.publish.reason!, /couldn't be confirmed/i);
  });

  it('offers the form only for a text-like type, and says why for the rest', () => {
    assert.equal(resolveObjectControls(input({ objectType: 'editorial_voice' })).edit_fields.enabled, true);
    const product = resolveObjectControls(input({ objectType: 'product' })).edit_fields;
    assert.equal(product.enabled, false);
    assert.match(product.reason!, /no flat fields|agent/i);
  });

  it('blocks the form and the discard while someone else holds the checkout', () => {
    const controls = resolveObjectControls(input({ lockHeld: true, lockHeldByOther: true }));
    assert.equal(controls.edit_fields.enabled, false);
    assert.match(controls.edit_fields.reason!, /holds the checkout/i);
    assert.equal(controls.discard.enabled, false);
  });

  it('offers Release lock only to an Owner, and only while a lock exists', () => {
    assert.equal(resolveObjectControls(input({ lockHeld: true, isOwner: true })).release_lock.enabled, true);
    assert.equal(resolveObjectControls(input({ lockHeld: true, isOwner: false })).release_lock.enabled, false);
    const idle = resolveObjectControls(input({ lockHeld: false, isOwner: true })).release_lock;
    assert.equal(idle.enabled, false);
    assert.match(idle.reason!, /Nothing holds a checkout/i);
  });

  it('offers New variant only for an article', () => {
    assert.equal(resolveObjectControls(input({ objectType: 'content_item' })).new_variant.enabled, true);
    const voice = resolveObjectControls(input({ objectType: 'editorial_voice' })).new_variant;
    assert.equal(voice.enabled, false);
    assert.match(voice.reason!, /articles/i);
  });

  it('disables everything writeable on an archived object', () => {
    const controls = resolveObjectControls(input({ status: 'archived', objectType: 'content_item' }));
    for (const id of ['edit_fields', 'approve', 'request_changes', 'publish', 'discard', 'new_variant'] as const) {
      assert.equal(controls[id].enabled, false, id);
      assert.match(controls[id].reason!, /archived/i, id);
    }
  });

  it('offers Submit for review to a role-holder — the handler takes its own checkout', () => {
    assert.equal(resolveObjectControls(input({ lockHeld: false })).submit_review.enabled, true);
    assert.equal(resolveObjectControls(input({ roles: [] })).submit_review.enabled, false);
  });

  it('blocks Submit for review while someone else holds the checkout', () => {
    const control = resolveObjectControls(input({ lockHeld: true, lockHeldByOther: true })).submit_review;
    assert.equal(control.enabled, false);
    assert.match(control.reason!, /holds the checkout/i);
  });
});

describe('reviewDecisionAvailability — A1/A2', () => {
  it('offers Reject (request_changes) exactly when the review is open and the viewer has a role', () => {
    const open = { state: 'open' as const, decisions: [] };
    assert.equal(reviewDecisionAvailability(input({ review: open })).canRequestChanges, true);
    assert.equal(reviewDecisionAvailability(input({ review: open, roles: [] })).canRequestChanges, false);
    assert.equal(reviewDecisionAvailability(input({ review: undefined })).canRequestChanges, false);
  });

  it('renders Reject as a real control, not just a computed flag (A2)', () => {
    const controls = resolveObjectControls(input({ review: { state: 'open', decisions: [] } }));
    assert.equal(controls.request_changes.enabled, true);
    assert.equal(controls.approve.enabled, true);
  });

  it('offers Re-open review exactly in changes_requested — the control A1’s copy names', () => {
    const requested = { state: 'changes_requested' as const, decisions: [] };
    assert.equal(reviewDecisionAvailability(input({ review: requested })).canReopenReview, true);
    assert.equal(resolveObjectControls(input({ review: requested })).reopen_review.enabled, true);
    assert.equal(
      reviewDecisionAvailability(input({ review: { state: 'open', decisions: [] } })).canReopenReview,
      false
    );
    assert.equal(reviewDecisionAvailability(input({ review: undefined })).canReopenReview, false);
    assert.equal(reviewDecisionAvailability(input({ review: requested, roles: [] })).canReopenReview, false);
  });

  it('explains a blocked Approve in changes_requested by pointing at the re-open step', () => {
    const controls = resolveObjectControls(input({ review: { state: 'changes_requested', decisions: [] } }));
    assert.equal(controls.approve.enabled, false);
    assert.match(controls.approve.reason!, /Re-open review/i);
    assert.equal(controls.reopen_review.enabled, true, 'the reason names a control that actually exists');
  });

  it('reports everything false when the release row is unknown', () => {
    const availability = reviewDecisionAvailability(
      input({ releaseKnown: false, review: { state: 'open', decisions: [] } })
    );
    assert.equal(availability.canApprove, false);
    assert.equal(availability.canRequestChanges, false);
    assert.equal(availability.canPublish, false);
    assert.equal(availability.canReopenReview, false);
  });

  it('honours the server-confirmed requires_approval override for Publish', () => {
    const approvedCurrent = { state: 'approved' as const, decisions: [{ content_revision: 4 }] };
    assert.equal(
      reviewDecisionAvailability(input({ requiresApprovalOverride: true, review: approvedCurrent })).canPublish,
      true
    );
    const stale = { state: 'approved' as const, decisions: [{ content_revision: 3 }] };
    assert.equal(
      reviewDecisionAvailability(input({ requiresApprovalOverride: true, review: stale })).canPublish,
      false
    );
    assert.equal(
      reviewDecisionAvailability(input({ requiresApprovalOverride: false, review: stale })).canPublish,
      true
    );
  });
});
