import assert from 'node:assert/strict';
import test from 'node:test';
import { buildPublishPlan, executePublish, PUBLISH_FORBIDDEN_VERBS, PublishError } from './publish.mjs';

// The emission report shape this stage reads, reduced to the fields it actually consumes.
const reportFixture = () => ({
  target: 'zilberman',
  createdObjects: [{ objectType: 'page', objectId: 'page_new', draftVerified: true }],
  reusedObjects: [
    { objectType: 'page', objectId: 'page_home', mode: 'patched' },
    { objectType: 'page', objectId: 'page_broken', mode: 'patched' },
    { objectType: 'theme', objectId: 'thm_reused', reason: 'matching_recipe_summary' },
  ],
  quarantines: [{ objectId: 'page_emptied', objectType: 'page', reason: 'reuse_would_empty_page' }],
  validationStates: [
    { phase: 'precreate', requestedId: 'nav_capture_abc', valid: false, reason: 'requested_id_unavailable' },
    { phase: 'postpatch', objectId: 'page_home', valid: true, reason: null },
    { phase: 'postpatch', objectId: 'page_broken', valid: false, reason: 'schema_invalid' },
    { phase: 'postcreate', objectId: 'page_new', valid: true, reason: null },
  ],
});

test('publishes exactly what the emission validated, and names everything it withholds', () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  assert.deepEqual(plan.publish.map((entry) => entry.objectId).sort(), ['page_home', 'page_new']);
  assert.equal(plan.release, true);

  const withheld = Object.fromEntries(plan.withheld.map((entry) => [entry.objectId, entry.reason]));
  // Validation said no -> not live, and the reason travels with it.
  assert.equal(withheld.page_broken, 'validation_failed');
  // The emission never finished with it -> not live.
  assert.equal(withheld.page_emptied, 'quarantined_by_emission');
  // A silently dropped object is the failure this file exists to avoid: every object the emission
  // WROTE is either published or named. Four were written (page_new, page_home, page_broken,
  // page_emptied); thm_reused was matched, not written, so it is correctly absent from both lists.
  assert.equal(plan.publish.length + plan.withheld.length, 4);
});

test('a precreate failure is not a withheld object — nothing was ever written', () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  assert.equal(plan.withheld.some((entry) => entry.objectId === 'nav_capture_abc'), false);
  assert.equal(plan.publish.some((entry) => entry.objectId === 'nav_capture_abc'), false);
});

test('a reused RECIPE is never published by capture — that is a studio act', () => {
  const report = reportFixture();
  report.validationStates.push({ phase: 'postpatch', objectId: 'thm_reused', valid: true, reason: null });
  const plan = buildPublishPlan({ report });
  assert.equal(plan.publish.some((entry) => entry.objectId === 'thm_reused'), false);
  assert.equal(
    plan.withheld.find((entry) => entry.objectId === 'thm_reused')?.reason,
    'type_not_publishable_from_capture'
  );
});

test('a plan with nothing publishable does not ask production to rebuild', async () => {
  const report = reportFixture();
  report.validationStates = report.validationStates.map((state) => ({ ...state, valid: false }));
  const plan = buildPublishPlan({ report });
  assert.equal(plan.publish.length, 0);
  assert.equal(plan.release, false);

  const calls = [];
  const run = await executePublish({ plan, transport: { call: async (verb) => { calls.push(verb); return {}; } } });
  assert.deepEqual(calls, []);
  assert.equal(run.release.status, 'nothing_to_release');
});

test('the build verbs stay unreachable — a release is the only thing that may deploy', () => {
  assert.equal(PUBLISH_FORBIDDEN_VERBS.has('trigger_netlify_build'), true);
  assert.equal(PUBLISH_FORBIDDEN_VERBS.has('deploy'), true);
  assert.equal(PUBLISH_FORBIDDEN_VERBS.has('object_publish'), false);
  assert.equal(PUBLISH_FORBIDDEN_VERBS.has('release_to_production'), false);
});

test('checkout -> publish -> checkin per object, then ONE release for the whole plan', async () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  const calls = [];
  const transport = {
    async call(verb, args) {
      calls.push({ verb, objectId: args?.object_id ?? null });
      if (verb === 'object_checkout') return { lockToken: `lock-${args.object_id}` };
      if (verb === 'object_publish') return { published: true, published_time: 'T', receipt: { commit_sha: 'abc123' } };
      if (verb === 'release_to_production') return { released: true, status: 'released', productionConfirmed: true, deploy: { deployId: 'dep_1' } };
      return {};
    }
  };
  const run = await executePublish({ plan, transport });

  assert.deepEqual(run.published.map((entry) => entry.objectId).sort(), ['page_home', 'page_new']);
  assert.equal(run.release.released, true);
  assert.equal(run.release.deployId, 'dep_1');
  // Exactly one release, never one per object: each publish commits behind the skip marker and the
  // exports accumulate, so per-object releases would queue N builds to ship one change set.
  assert.equal(calls.filter((call) => call.verb === 'release_to_production').length, 1);
  // Every lease taken was returned.
  assert.equal(
    calls.filter((call) => call.verb === 'object_checkout').length,
    calls.filter((call) => call.verb === 'object_checkin').length
  );
});

test('one object failing to publish withholds neither the others nor the release', async () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  const transport = {
    async call(verb, args) {
      if (verb === 'object_checkout') return { lockToken: `lock-${args.object_id}` };
      if (verb === 'object_publish') {
        if (args.object_id === 'page_new') throw new Error('status 409: HTTP 409');
        return { published: true, published_time: 'T', receipt: { commit_sha: 'abc123' } };
      }
      if (verb === 'release_to_production') return { released: true, status: 'released', productionConfirmed: true };
      return {};
    }
  };
  const run = await executePublish({ plan, transport });
  assert.deepEqual(run.published.map((entry) => entry.objectId), ['page_home']);
  assert.equal(run.failed[0].objectId, 'page_new');
  assert.match(run.failed[0].detail, /409/);
  assert.equal(run.release.released, true);
});

test('the lease is returned even when the publish throws', async () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  const checkins = [];
  const transport = {
    async call(verb, args) {
      if (verb === 'object_checkout') return { lock_token: `lock-${args.object_id}` };  // snake_case reader
      if (verb === 'object_publish') throw new Error('boom');
      if (verb === 'object_checkin') { checkins.push(args.object_id); return {}; }
      return {};
    }
  };
  const run = await executePublish({ plan, transport });
  assert.deepEqual(checkins.sort(), ['page_home', 'page_new']);
  assert.equal(run.published.length, 0);
  assert.equal(run.release.status, 'nothing_to_release');
});

test('a failed release says the objects are published and the deploy is retryable', async () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  const transport = {
    async call(verb, args) {
      if (verb === 'object_checkout') return { lockToken: `lock-${args.object_id}` };
      if (verb === 'object_publish') return { published: true, published_time: 'T' };
      if (verb === 'release_to_production') throw new Error('MCP request failed with HTTP 504.');
      return {};
    }
  };
  const run = await executePublish({ plan, transport });
  assert.equal(run.published.length, 2);
  assert.equal(run.release.released, false);
  assert.equal(run.release.recoverable, true);
  assert.match(run.release.detail, /504/);
});

test('a publish the site did not confirm is a failure, not a success', async () => {
  const plan = buildPublishPlan({ report: reportFixture() });
  const transport = {
    async call(verb, args) {
      if (verb === 'object_checkout') return { lockToken: `lock-${args.object_id}` };
      if (verb === 'object_publish') return { published: false };
      return {};
    }
  };
  const run = await executePublish({ plan, transport });
  assert.equal(run.published.length, 0);
  assert.equal(run.failed.every((entry) => entry.reason === 'publish_not_confirmed'), true);
});

test('refuses to plan without a report or a target', () => {
  assert.throws(() => buildPublishPlan({}), PublishError);
  assert.throws(() => buildPublishPlan({ report: { validationStates: [] } }), PublishError);
});
