/**
 * S5 — `release_workspace_run`, the chat bridge wrapper over
 * `release_to_production`.
 *
 * The behaviour under test is the one the live 502s made load-bearing: when
 * the release call comes back an error, the wrapper must NOT re-issue it. The
 * build hook fires before the response, so a retry can fire a second paid
 * production build. The sanctioned recovery is a single `deploy_status` read
 * for the same commit, returned to the caller with a `release_response_lost`
 * warning — a truthful answer in ONE call.
 *
 * Every case below asserts the exact sequence of operational calls, so a
 * future edit that reintroduces a retry fails here rather than in production
 * with a doubled build.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import test from 'node:test';

import { chatToolByName, type ToolContext } from './tools.js';

const COMMIT = 'aa11bb22cc33dd44ee55ff6677889900aabbccdd';

type Call = { name: string; args: Record<string, unknown> };

const releaseCtx = (
  respond: (name: string) => { content: string; is_error: boolean },
  calls: Call[],
  roles: string[] = ['owner']
): ToolContext =>
  ({
    roles,
    operational: {
      call: async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return respond(name);
      },
    },
  }) as unknown as ToolContext;

const releaseTool = () => {
  const tool = chatToolByName('release_workspace_run');
  assert.ok(tool, 'release_workspace_run must exist in the chat registry');
  return tool;
};

const run = async (
  respond: (name: string) => { content: string; is_error: boolean },
  args: Record<string, unknown>
) => {
  const calls: Call[] = [];
  const result = await releaseTool().execute(releaseCtx(respond, calls), args);
  const body = JSON.parse((result as { content: string }).content) as Record<string, unknown>;
  return { calls, result: result as { content: string; is_error?: boolean }, body };
};

// ── the 502 path ────────────────────────────────────────────────────────────

const gateway502 = { content: JSON.stringify({ error: 'HTTP 502 origin_bad_gateway' }), is_error: true };

test('a 502 from the release is recovered with deploy_status — and the release is NEVER re-issued', async () => {
  const { calls, body } = await run(
    (name) =>
      name === 'release_to_production'
        ? gateway502
        : { content: JSON.stringify({ deployStatus: 'building', commit: COMMIT }), is_error: false },
    { commit: COMMIT }
  );

  // Exactly two calls, in this order, and only ONE of them is the release.
  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.name, 'release_to_production');
  assert.equal(calls[1]?.name, 'deploy_status');
  assert.equal(calls.filter((call) => call.name === 'release_to_production').length, 1);
  assert.deepEqual(calls[1]?.args, { commit: COMMIT });

  assert.equal(body.warning, 'release_response_lost');
  assert.equal(body.release_retried, false);
  assert.equal(body.build_hook_refired, false);
});

test('a build already running for the commit is reported as a landed release, not a failure', async () => {
  const { result, body } = await run(
    (name) =>
      name === 'release_to_production'
        ? gateway502
        : { content: JSON.stringify({ deployStatus: 'building' }), is_error: false },
    { commit: COMMIT }
  );
  assert.equal(result.is_error, false, 'the recovered answer is the truthful result, not an error');
  assert.equal(body.release_landed, true);
  assert.equal(body.status, 'building');
  assert.equal(body.target_commit, COMMIT);
});

test('a live deploy for the commit is reported as released even though the response was lost', async () => {
  const { body } = await run(
    (name) =>
      name === 'release_to_production'
        ? gateway502
        : { content: JSON.stringify({ deployStatus: 'ready', productionConfirmed: true }), is_error: false },
    { commit: COMMIT }
  );
  assert.equal(body.released, true);
  assert.equal(body.status, 'released');
});

test('when deploy_status ALSO fails, the answer is "unknown" — still no retry of the release', async () => {
  const { calls, body } = await run(() => gateway502, { commit: COMMIT });
  assert.deepEqual(
    calls.map((call) => call.name),
    ['release_to_production', 'deploy_status']
  );
  assert.equal(body.release_landed, 'unknown');
  assert.equal(body.status, 'release_state_unknown');
  assert.equal(body.release_retried, false);
});

test('with no commit argument the recovery still runs, probing deploy_status with no filter', async () => {
  const { calls, body } = await run(() => gateway502, {});
  assert.equal(calls[1]?.name, 'deploy_status');
  assert.deepEqual(calls[1]?.args, {});
  assert.equal(body.target_commit, null);
  assert.equal(body.release_retried, false);
});

// ── the healthy path still works ────────────────────────────────────────────

test('a successful 202 release reports status "building" and reads deploy_status exactly once', async () => {
  const { calls, body } = await run(
    (name) =>
      name === 'release_to_production'
        ? {
            content: JSON.stringify({
              commit: COMMIT,
              targetCommit: COMMIT,
              build_hook_fired: true,
              status: 'building',
              released: false,
            }),
            is_error: false,
          }
        : { content: JSON.stringify({ deployStatus: 'queued', productionConfirmed: false }), is_error: false },
    { commit: COMMIT }
  );
  assert.deepEqual(
    calls.map((call) => call.name),
    ['release_to_production', 'deploy_status']
  );
  assert.equal(body.released, false);
  assert.equal(body.status, 'building');
  assert.equal(body.target_commit, COMMIT);
  assert.equal((body.deploy as Record<string, unknown>).status, 'queued');
  assert.equal(body.warning, undefined, 'a healthy release carries no lost-response warning');
});

test('the release is owner-only, and a non-owner never reaches the operational bridge at all', async () => {
  const calls: Call[] = [];
  const ctx = releaseCtx(() => ({ content: '{}', is_error: false }), calls, ['admin']);
  const result = (await releaseTool().execute(ctx, { commit: COMMIT })) as { is_error?: boolean };
  assert.equal(result.is_error, true);
  assert.equal(calls.length, 0);
});
