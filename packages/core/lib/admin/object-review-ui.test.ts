// W11 T11.4: this suite asserts behavior under the LIVE committed policy — register the site bindings (test carve-out).
import '../../../../sites/drlurie/config/policy-bindings.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { reviewerAvailableActions } from './object-review-ui.js';
import { governedObjectTypes, type ApprovalPolicy } from '../../lib/approval-policy.js';

const ALL_AUTONOMOUS: ApprovalPolicy = { master: 'all-autonomous', overrides: {} };
const ALL_REQUIRE: ApprovalPolicy = { master: 'all-require-approval', overrides: {} };

const approvedReview = (contentRevision: number) => ({
  state: 'approved' as const,
  decisions: [{ content_revision: contentRevision }],
});

describe('reviewerAvailableActions — autonomous types (policy: no approval required)', () => {
  it('offers Publish to a role-holding human with no review at all, for every governed type', () => {
    for (const objectType of governedObjectTypes) {
      const result = reviewerAvailableActions({
        objectType,
        principalKind: 'human',
        roles: ['admin'],
        hasActiveLock: false,
        review: undefined,
        contentRevision: 3,
        policy: ALL_AUTONOMOUS,
      });
      assert.equal(result.requiresApproval, false, objectType);
      assert.equal(result.canPublish, true, `${objectType}: autonomous types publish without approval`);
    }
  });

  it('still hides Publish from humans without a publish role, and from agents', () => {
    const editor = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: ['editor'],
      hasActiveLock: false,
      contentRevision: 1,
      policy: ALL_AUTONOMOUS,
    });
    assert.equal(editor.canPublish, false, 'publish authority (admin/publisher) is still required');

    const agent = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'agent',
      roles: [],
      hasActiveLock: true,
      contentRevision: 1,
      policy: ALL_AUTONOMOUS,
    });
    assert.equal(agent.canPublish, false, 'this surface is human-only; agents never see Publish here');
  });

  it('the committed config (dev default all-autonomous) is used when no policy is injected', () => {
    const result = reviewerAvailableActions({
      objectType: 'navigation',
      principalKind: 'human',
      roles: ['publisher'],
      hasActiveLock: false,
      review: undefined,
      contentRevision: 5,
    });
    assert.equal(result.requiresApproval, false);
    assert.equal(result.canPublish, true);
  });

  // Fixed defect: a caller with a server-confirmed `requires_approval` (e.g.
  // from a release-state row) must be able to use it directly without
  // resolving `activeApprovalPolicy()` again — the override wins outright.
  it('requiresApprovalOverride wins over the policy outright', () => {
    const gatedByOverride = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: ['admin'],
      hasActiveLock: false,
      review: undefined,
      contentRevision: 1,
      policy: ALL_AUTONOMOUS,
      requiresApprovalOverride: true,
    });
    assert.equal(gatedByOverride.requiresApproval, true, 'override gates even though the policy is autonomous');
    assert.equal(gatedByOverride.canPublish, false, 'gated with no approval yet — Publish stays hidden');

    const autonomousByOverride = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: ['admin'],
      hasActiveLock: false,
      review: undefined,
      contentRevision: 1,
      policy: ALL_REQUIRE,
      requiresApprovalOverride: false,
    });
    assert.equal(autonomousByOverride.requiresApproval, false, 'override frees Publish even though the policy is gated');
    assert.equal(autonomousByOverride.canPublish, true);
  });
});

describe('reviewerAvailableActions — gated types (policy: approval required)', () => {
  it('requires a CURRENT approval before offering Publish, for every governed type', () => {
    for (const objectType of governedObjectTypes) {
      const base = {
        objectType,
        principalKind: 'human' as const,
        roles: ['admin' as const],
        hasActiveLock: false,
        contentRevision: 4,
        policy: ALL_REQUIRE,
      };
      assert.equal(
        reviewerAvailableActions({ ...base, review: undefined }).canPublish,
        false,
        `${objectType}: no review`
      );
      assert.equal(
        reviewerAvailableActions({ ...base, review: approvedReview(4) }).canPublish,
        true,
        `${objectType}: current approval`
      );
      assert.equal(
        reviewerAvailableActions({ ...base, review: approvedReview(3) }).canPublish,
        false,
        `${objectType}: stale approval (content_revision moved)`
      );
    }
  });

  it('a per-type override gates exactly that type while the master stays autonomous', () => {
    const policy: ApprovalPolicy = { master: 'all-autonomous', overrides: { navigation: 'require-approval' } };
    const base = {
      principalKind: 'human' as const,
      roles: ['publisher' as const],
      hasActiveLock: false,
      review: undefined,
      contentRevision: 2,
      policy,
    };
    const nav = reviewerAvailableActions({ ...base, objectType: 'navigation' });
    assert.equal(nav.requiresApproval, true);
    assert.equal(nav.canPublish, false, 'gated navigation needs an approval first');
    const page = reviewerAvailableActions({ ...base, objectType: 'page' });
    assert.equal(page.requiresApproval, false);
    assert.equal(page.canPublish, true, 'page stays autonomous');
  });

  it('canPublish is false for an editor (no publish role) even with a current approval', () => {
    const result = reviewerAvailableActions({
      objectType: 'site',
      principalKind: 'human',
      roles: ['editor'],
      hasActiveLock: false,
      review: approvedReview(1),
      contentRevision: 1,
      policy: ALL_REQUIRE,
    });
    assert.equal(result.canPublish, false);
  });
});

describe('reviewerAvailableActions — review controls (policy-independent)', () => {
  it('canApprove/canRequestChanges require an open review and at least one human role', () => {
    const noRole = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: [],
      hasActiveLock: false,
      review: { state: 'open', decisions: [] },
      contentRevision: 1,
      policy: ALL_REQUIRE,
    });
    assert.equal(noRole.canApprove, false);
    assert.equal(noRole.canRequestChanges, false);

    const withRole = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: ['editor'],
      hasActiveLock: false,
      review: { state: 'open', decisions: [] },
      contentRevision: 1,
      policy: ALL_REQUIRE,
    });
    assert.equal(withRole.canApprove, true);
    assert.equal(withRole.canRequestChanges, true);

    const notOpen = reviewerAvailableActions({
      objectType: 'page',
      principalKind: 'human',
      roles: ['editor'],
      hasActiveLock: false,
      review: approvedReview(1),
      contentRevision: 1,
      policy: ALL_REQUIRE,
    });
    assert.equal(notOpen.canApprove, false);
    assert.equal(notOpen.canRequestChanges, false);
  });

  // Fixed defect: Approve was silently re-opening and self-approving an
  // object in `changes_requested` — with the model wired, an already-decided
  // review (a rejection, or a prior approval, current or stale) needs an
  // explicit new "open" step before a one-click re-decision is offered again.
  it('blocks a one-click re-decision once a review has already been decided, but not before one starts', () => {
    const base = {
      objectType: 'page' as const,
      principalKind: 'human' as const,
      roles: ['editor' as const],
      hasActiveLock: false,
      policy: ALL_REQUIRE,
    };

    const neverReviewed = reviewerAvailableActions({ ...base, review: undefined, contentRevision: 1 });
    assert.equal(neverReviewed.canApprove, true, 'nothing decided yet — direct approve is fine');

    const changesRequested = reviewerAvailableActions({
      ...base,
      review: { state: 'changes_requested', decisions: [] },
      contentRevision: 1,
    });
    assert.equal(changesRequested.canApprove, false, 'an explicit rejection must not be silently overridden');

    const staleApproval = reviewerAvailableActions({ ...base, review: approvedReview(1), contentRevision: 2 });
    assert.equal(staleApproval.canApprove, false, 'a stale approval (content moved) also needs a fresh open review');

    const currentApproval = reviewerAvailableActions({ ...base, review: approvedReview(2), contentRevision: 2 });
    assert.equal(currentApproval.canApprove, false, 'an already-current approval needs no re-decision either');
  });

  it('canSubmitForReview only reflects lock possession', () => {
    assert.equal(
      reviewerAvailableActions({
        objectType: 'page',
        principalKind: 'human',
        roles: [],
        hasActiveLock: true,
        contentRevision: 1,
        policy: ALL_AUTONOMOUS,
      }).canSubmitForReview,
      true
    );
    assert.equal(
      reviewerAvailableActions({
        objectType: 'page',
        principalKind: 'human',
        roles: [],
        hasActiveLock: false,
        contentRevision: 1,
        policy: ALL_AUTONOMOUS,
      }).canSubmitForReview,
      false
    );
  });
});
