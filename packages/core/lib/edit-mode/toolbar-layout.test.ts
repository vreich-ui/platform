import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  fadeToast,
  postStatus,
  RELEASE_DISABLED_TITLE,
  RELEASE_TITLE,
  toolbarLayout,
  type ToolbarPlan,
} from './toolbar-layout.js';

const pillOf = (plan: ToolbarPlan, key: string) => plan.pills.find((pill) => pill.key === key);
const rowOf = (plan: ToolbarPlan, key: string) => plan.popoverRows.find((row) => row.key === key);

describe('toolbarLayout', () => {
  it('is four pills, in the PDF order plus Exit (Wolf, 2026-08-11: keep Exit visible)', () => {
    const plan = toolbarLayout({ pendingCount: 0, attentionCount: 0, canPublish: true });
    assert.deepEqual(
      plan.pills.map((pill) => pill.key),
      ['editing', 'attention', 'release', 'exit']
    );
  });

  it('never disables or hides Exit, regardless of role or counts', () => {
    for (const canPublish of [true, false]) {
      for (const pendingCount of [0, 3]) {
        const plan = toolbarLayout({ pendingCount, attentionCount: 0, canPublish });
        const exit = pillOf(plan, 'exit');
        assert.ok(exit, 'Exit must always be a pill');
        assert.equal(exit?.disabled, false, 'Exit must never be disabled');
      }
    }
  });

  it('a publisher sees Release enabled, titled with the full phrase', () => {
    const plan = toolbarLayout({ pendingCount: 0, attentionCount: 0, canPublish: true });
    const release = pillOf(plan, 'release');
    assert.equal(release?.disabled, false);
    assert.equal(release?.title, RELEASE_TITLE);
  });

  it('a non-publisher sees Release disabled, titled "Requires publisher role"', () => {
    const plan = toolbarLayout({ pendingCount: 0, attentionCount: 0, canPublish: false });
    const release = pillOf(plan, 'release');
    assert.equal(release?.disabled, true);
    assert.equal(release?.title, RELEASE_DISABLED_TITLE);
  });

  it('the Editing pill carries no badge when nothing is pending', () => {
    const plan = toolbarLayout({ pendingCount: 0, attentionCount: 0, canPublish: true });
    assert.equal(pillOf(plan, 'editing')?.badge, undefined);
  });

  it('the Editing pill carries the pending count once there is one', () => {
    const plan = toolbarLayout({ pendingCount: 3, attentionCount: 0, canPublish: true });
    assert.equal(pillOf(plan, 'editing')?.badge, 3);
  });

  it('the Attention pill always carries its count, zero included (unchanged behaviour)', () => {
    const zero = toolbarLayout({ pendingCount: 0, attentionCount: 0, canPublish: true });
    const some = toolbarLayout({ pendingCount: 0, attentionCount: 5, canPublish: true });
    assert.equal(pillOf(zero, 'attention')?.badge, 0);
    assert.equal(pillOf(some, 'attention')?.badge, 5);
  });

  it('the popover always offers email, status and a Pending row carrying the same count', () => {
    const plan = toolbarLayout({ pendingCount: 7, attentionCount: 0, canPublish: true });
    assert.deepEqual(
      plan.popoverRows.map((row) => row.key),
      ['email', 'status', 'pending']
    );
    assert.equal(rowOf(plan, 'pending')?.badge, 7);
    // Q1: no Exit row in the popover — it is its own pill, per Wolf's ruling.
    assert.equal(
      plan.popoverRows.some((row) => (row.key as string) === 'exit'),
      false
    );
  });
});

describe('the toast message-retention rule', () => {
  it('a status becomes a visible toast', () => {
    const toast = postStatus('Released — the site is current.');
    assert.equal(toast.visible, true);
    assert.equal(toast.message, 'Released — the site is current.');
  });

  it('an empty status posts as not visible (a clear, not a message)', () => {
    assert.equal(postStatus('').visible, false);
  });

  it('fading hides the toast but the message survives — a missed confirmation stays readable', () => {
    const shown = postStatus('Draft saved — not published.');
    const faded = fadeToast(shown);
    assert.equal(faded.visible, false);
    assert.equal(faded.message, shown.message, 'the message must not be cleared by the fade');
  });

  it('fading twice is stable', () => {
    const faded = fadeToast(fadeToast(postStatus('Saving…')));
    assert.equal(faded.visible, false);
    assert.equal(faded.message, 'Saving…');
  });
});
