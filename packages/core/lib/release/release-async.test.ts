/**
 * S5 — the release response contract.
 *
 * Two things are proven here, both of which the live 502s made expensive:
 *   1. The 202 shape a release answers with the moment the build hook has
 *      fired — the commit is present, `build_hook_fired` is true, and nothing
 *      in it claims a verification that has not happened.
 *   2. The 502 recovery shape: what the bridge wrapper reports when the
 *      release response is lost, for every answer deploy_status can give.
 *      Every branch must assert `release_retried:false` — the standing ruling
 *      is that a 502 release is NEVER re-issued, because the hook fires
 *      before the response and a retry can fire a second paid build.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  RELEASE_BUILDING_STATUS,
  RELEASE_LOST_WARNING,
  buildAsyncReleaseBody,
  buildLostReleaseResult,
  releaseHttpStatusFor,
} from './release-async.js';

const COMMIT = '6830febe1111222233334444555566667777aaaa';

// ── the 202 body ────────────────────────────────────────────────────────────

test('the 202 body carries the commit twice (commit + targetCommit) so either caller vocabulary works', () => {
  const body = buildAsyncReleaseBody({ targetCommit: COMMIT, buildTriggered: true });
  assert.equal(body.commit, COMMIT);
  assert.equal(body.targetCommit, COMMIT);
});

test('the 202 body says the hook fired and the build is running, and claims nothing else', () => {
  const body = buildAsyncReleaseBody({
    targetCommit: COMMIT,
    buildTriggered: true,
    triggeredAt: '2026-09-08T10:00:00Z',
  });
  assert.equal(body.build_hook_fired, true);
  assert.equal(body.status, RELEASE_BUILDING_STATUS);
  assert.equal(body.status, 'building');
  assert.equal(body.http_status, 202);
  assert.equal(body.triggeredAt, '2026-09-08T10:00:00Z');
  // The point of the restructure: no verification is asserted, because none happened.
  assert.equal(body.released, false);
  assert.equal(body.productionConfirmed, false);
  assert.equal(body.productionReflectsCommit, false);
  assert.equal('deploy' in body, false);
  assert.equal('publishedDeploy' in body, false);
});

test('the 202 body hands the caller the exact follow-up call and the stop condition', () => {
  const body = buildAsyncReleaseBody({ targetCommit: COMMIT, buildTriggered: true });
  assert.deepEqual(body.next, {
    tool: 'deploy_status',
    arguments: { commit: COMMIT },
    until: 'deployStatus is "ready" AND productionConfirmed is true',
  });
  assert.match(body.reason, /deploy_status/);
  assert.match(body.reason, /Do NOT call release_to_production again/);
});

test('triggeredAt is omitted rather than emitted as undefined when the hook was not fired', () => {
  const body = buildAsyncReleaseBody({ targetCommit: COMMIT, buildTriggered: false });
  assert.equal(body.build_hook_fired, false);
  assert.equal('triggeredAt' in body, false);
});

test('a caller-supplied reason wins, so the core keeps ownership of the wording', () => {
  const body = buildAsyncReleaseBody({ targetCommit: COMMIT, buildTriggered: true, reason: 'core said so' });
  assert.equal(body.reason, 'core said so');
});

// ── HTTP status mapping ─────────────────────────────────────────────────────

test('building maps to 202; config gaps stay 400; everything else stays 200', () => {
  assert.equal(releaseHttpStatusFor('building'), 202);
  assert.equal(releaseHttpStatusFor('build_hook_not_configured'), 400);
  assert.equal(releaseHttpStatusFor('deploy_lookup_not_configured'), 400);
  assert.equal(releaseHttpStatusFor('released'), 200);
  assert.equal(releaseHttpStatusFor('build_ready_not_published'), 200);
  assert.equal(releaseHttpStatusFor('build_not_confirmed_live'), 200);
  assert.equal(releaseHttpStatusFor('commit_unresolved'), 200);
});

// ── the lost-response recovery ──────────────────────────────────────────────

const lost = (deploy: Record<string, unknown> | null) =>
  buildLostReleaseResult({ commit: COMMIT, releaseError: 'HTTP 502 origin_bad_gateway', deploy });

test('EVERY lost-release branch reports that the release was not retried and no second hook fired', () => {
  const branches = [
    lost(null),
    lost({}),
    lost({ deployStatus: 'building' }),
    lost({ deployStatus: 'queued' }),
    lost({ deployStatus: 'ready', productionConfirmed: false }),
    lost({ deployStatus: 'ready', productionConfirmed: true }),
    lost({ deployStatus: 'failed' }),
  ];
  for (const branch of branches) {
    assert.equal(branch.release_retried, false, branch.status);
    assert.equal(branch.build_hook_refired, false, branch.status);
    assert.equal(branch.warning, RELEASE_LOST_WARNING);
    assert.equal(branch.target_commit, COMMIT);
    assert.equal(branch.release_error, 'HTTP 502 origin_bad_gateway');
  }
});

test('a build already running for the commit IS the release — landed, still building', () => {
  const result = lost({ deployStatus: 'building' });
  assert.equal(result.release_landed, true);
  assert.equal(result.status, 'building');
  assert.equal(result.released, false);
  assert.equal(result.deploy.status, 'building');
  assert.match(result.reason, /the release landed/);
});

test('deploy_status shapes that spell the field `status` are read too (bridge bodies vary)', () => {
  assert.equal(lost({ status: 'enqueued' }).release_landed, true);
  assert.equal(lost({ status: 'ENQUEUED' }).deploy.status, 'enqueued');
});

test('ready + productionConfirmed is the only branch that reports released:true', () => {
  const live = lost({ deployStatus: 'ready', productionConfirmed: true });
  assert.equal(live.released, true);
  assert.equal(live.status, 'released');
  assert.equal(live.release_landed, true);

  // Ready but NOT confirmed live (locked Auto Publishing) must not claim released.
  const ready = lost({ deployStatus: 'ready', productionConfirmed: false });
  assert.equal(ready.released, false);
  assert.equal(ready.status, 'building');
  assert.equal(ready.release_landed, true);
});

test('a failed build is still a landed release — it must not read as "nothing happened"', () => {
  const result = lost({ deployStatus: 'failed' });
  assert.equal(result.release_landed, true);
  assert.equal(result.status, 'build_failed');
  assert.equal(result.released, false);
  assert.match(result.reason, /do not re-release blindly/i);
});

test('no deploy record yet is UNKNOWN, never "failed" — Netlify takes seconds to create one', () => {
  for (const result of [lost(null), lost({}), lost({ deployStatus: '   ' })]) {
    assert.equal(result.release_landed, 'unknown');
    assert.equal(result.status, 'release_state_unknown');
    assert.equal(result.released, false);
    assert.equal(result.deploy.status, null);
    assert.match(result.reason, /poll deploy_status/);
    assert.match(result.reason, /NOT re-issued/);
  }
});

test('a null commit degrades to a readable answer rather than printing "null" at the reader', () => {
  const result = buildLostReleaseResult({ commit: null, releaseError: '502', deploy: null });
  assert.equal(result.target_commit, null);
  assert.match(result.reason, /the target commit/);
});
