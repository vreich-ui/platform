/**
 * FIX 5 — the row may not claim a release scope it has not checked.
 *
 * W21.3's dialog was written from the ROW: it asserted that every pending
 * change would go live "— 'TITLE' among them" without ever reading what was
 * pending, and its Release could fire a forced production build with nothing
 * waiting at all. These pin the three shapes the facts allow, and that each
 * sentence is derived from the overview rather than from the row.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { releaseConfirmation, releaseScopeFrom } from './release-confirmation.js';
import type { ReleaseObjectView, ReleaseOverview } from './release-client.js';

const object = (id: string, state: ReleaseObjectView['state']): ReleaseObjectView => ({
  object_id: id,
  object_type: 'content_item',
  display_name: id,
  review_state: 'none',
  approval_state: 'none',
  requires_approval: false,
  state,
});

const overview = (objects: ReleaseObjectView[]): ReleaseOverview => ({
  deploy: {
    configured: true,
    state: 'ready',
    production_confirmed: true,
    live_commit: 'abc',
    latest: null,
    published: null,
  },
  objects,
  waiting_count: objects.filter((row) => row.state === 'published').length,
  pending_approval_count: 0,
});

const ROW = { object_id: 'obj_1', title: 'Retinol after 40' };

describe('releaseScopeFrom — the waiting set, as the release surface derives it', () => {
  it('counts only published-and-waiting objects, not everything in the library', () => {
    const scope = releaseScopeFrom(overview([object('obj_1', 'published'), object('obj_2', 'draft')]), ROW);
    assert.equal(scope.waitingCount, 1);
    assert.equal(scope.rowWaiting, true);
  });

  it('knows when the row that prompted this is NOT in the batch', () => {
    const scope = releaseScopeFrom(overview([object('obj_9', 'published')]), ROW);
    assert.equal(scope.waitingCount, 1);
    assert.equal(scope.rowWaiting, false, 'membership is checked, not assumed from the click');
  });

  it('a row with no object is never claimed as part of the batch', () => {
    const scope = releaseScopeFrom(overview([object('obj_1', 'published')]), { title: 'Untitled' });
    assert.equal(scope.rowWaiting, false);
  });
});

describe('releaseConfirmation — what the dialog is allowed to say', () => {
  it('nothing waiting: there is no release to confirm at all', () => {
    const confirmation = releaseConfirmation(releaseConfirmationScope(0, false));
    assert.equal(confirmation.kind, 'nothing_waiting', 'the confirm step is not reachable');
    assert.match(confirmation.message, /would send nothing/);
    assert.doesNotMatch(confirmation.message, /among them/);
  });

  it('THE REGRESSION: a release can no longer be started when nothing is pending', () => {
    // W21.3 offered "Release" here and would have forced a production build.
    for (const rowWaiting of [true, false]) {
      assert.equal(releaseConfirmation(releaseConfirmationScope(0, rowWaiting)).kind, 'nothing_waiting');
    }
  });

  it('states the REAL count, and says "among them" only when the row really is', () => {
    const inBatch = releaseConfirmation(releaseConfirmationScope(3, true));
    assert.equal(inBatch.kind, 'confirm');
    assert.match(inBatch.message, /3 published changes/);
    assert.match(inBatch.message, /is one of them/);
    assert.match(inBatch.message, /cannot be released on its own/);

    const outOfBatch = releaseConfirmation(releaseConfirmationScope(3, false));
    assert.match(outOfBatch.message, /NOT among them/);
    assert.doesNotMatch(outOfBatch.message, /is one of them/);
  });

  it('does not under-state a site-wide deploy, in either shape', () => {
    for (const rowWaiting of [true, false]) {
      const confirmation = releaseConfirmation(releaseConfirmationScope(2, rowWaiting));
      assert.match(confirmation.message, /builds and deploys the whole site/);
      assert.match(confirmation.message, /Release page/, 'and points at the surface that reviews the batch');
      assert.equal(confirmation.kind === 'confirm' && confirmation.confirmLabel, 'Release site');
    }
  });

  it('gets the singular right, so one change is not announced as "1 changes"', () => {
    const one = releaseConfirmation(releaseConfirmationScope(1, true));
    assert.match(one.message, /1 published change is waiting/);
    assert.doesNotMatch(one.message, /changes/);
  });
});

/** A scope with the row's title fixed, so the cases read as counts and membership. */
function releaseConfirmationScope(waitingCount: number, rowWaiting: boolean) {
  return { waitingCount, rowWaiting, rowTitle: 'Retinol after 40' };
}
