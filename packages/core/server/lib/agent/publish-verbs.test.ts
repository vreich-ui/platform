/**
 * D2a (2026-08-17) — readiness / publish / release from chat.
 *
 * Proves, against a mocked CmsAgentClient: the exact payloads sent to
 * `workflow_publish_readiness` and `workflow_publish_run` (both artifact
 * reference forms in verifiedMediaRefs; approval pinned to the human
 * principal); refusal (no CMS-Agent publish call) when readiness is not
 * "go"; the request-id pattern + minting (nn bumps past an existing
 * content_item); the approval card carrying the readiness checklist; the
 * D2 risk floor on the two ask-gated verbs; and the release verb's
 * release_to_production → deploy_status sequence with a stored
 * idempotency key.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  chatToolByName,
  mintWorkspaceRequestId,
  REQUEST_ID_RE,
  resolveAutonomy,
  WORKSPACE_RUN_BUDGET_MS,
  type ToolContext,
} from './tools.js';
import { generatedChatToolByName, resolveGeneratedAutonomy } from './generated-tools.js';

type Call = { name: string; args: Record<string, unknown> };

const REQ = 'req_agent_retinol_basics_20260817_01';
const ARTIFACTS = [
  { blobKey: 'image/req_agent_retinol_basics_20260817_01/abc123.webp', sha256: 'abc123' },
  { blobKey: 'pdf/req_agent_retinol_basics_20260817_01/def456.pdf', sha256: 'def456' },
];
const EXPECTED_REFS = [
  'image/req_agent_retinol_basics_20260817_01/abc123.webp',
  '/img/req_agent_retinol_basics_20260817_01/abc123.webp',
  'pdf/req_agent_retinol_basics_20260817_01/def456.pdf',
  '/pdf/req_agent_retinol_basics_20260817_01/def456.pdf',
];

const GO = {
  status: 'go',
  checklist: [
    { id: 'approval', ok: true },
    { id: 'media', ok: true },
  ],
  blockers: [],
};
const NO_GO = {
  status: 'no_go',
  checklist: [
    { id: 'approval', ok: true },
    { id: 'taxonomy', ok: false, detail: 'tag "retinol" unknown' },
  ],
  blockers: ['taxonomy_unresolved'],
};

// THE SHAPE THE SERVER ACTUALLY RETURNS (2026-08-28, run_1787930929962_njffct).
//
// The two fixtures above are FLAT, and that is why nothing here ever failed while
// publish_workspace_run could not publish anything at all. cmsAgent.callTool
// unwraps the outer {ok:true,data}; what workflow_publish_readiness leaves behind
// is then TWO more levels deep — {readiness:{available, articleBodyValid,
// readiness:{status,...}}} — so reading `data.status` yielded undefined, which is
// not "no_go" but "no answer", and every caller treated it as a refusal. A run
// whose readiness was "go" with all twelve checks passing was refused every time
// it was asked, and the editor was told to go look at a checklist that had never
// been produced.
//
// These fixtures are the wire, verbatim in shape. Anything that reads readiness
// must satisfy them AND the flat ones above.
const nested = (verdict: Record<string, unknown>) => ({
  readiness: { available: true, articleBodyValid: true, readiness: verdict },
});
const GO_NESTED = nested(GO);
const NO_GO_NESTED = nested(NO_GO);

const makeCtx = (
  respond: (name: string, args: Record<string, unknown>) => unknown,
  calls: Call[],
  overrides: Partial<ToolContext> = {}
): ToolContext =>
  ({
    roles: ['owner'],
    principal: { id: 'u_editor', email: 'editor@example.com' },
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string, args: Record<string, unknown>) {
        calls.push({ name, args });
        return { ok: true, data: respond(name, args) };
      },
    },
    listArtifacts: async (requestId: string) => ({ request_id: requestId, artifacts: ARTIFACTS }),
    verb: async () => ({ status: 404, body: { not_found: true } }),
    ...overrides,
  }) as unknown as ToolContext;

// ─── request ids ─────────────────────────────────────────────────────────────────

test("REQUEST_ID_RE matches CMS-Agent's bound and mintWorkspaceRequestId bumps nn past an existing content_item", async () => {
  assert.match('req_agent_retinol_basics_20260817_01', REQUEST_ID_RE);
  assert.doesNotMatch('req_agent_Retinol_20260817_1', REQUEST_ID_RE);
  assert.doesNotMatch('retinol_20260817_01', REQUEST_ID_RE);

  const probed: string[] = [];
  const ctx = makeCtx(() => ({}), [], {
    verb: async (request: Record<string, unknown>) => {
      probed.push(request.object_id as string);
      // 01 already exists → 02 is free.
      return request.object_id === 'req_agent_retinol_basics_20260817_01'
        ? { status: 200, body: { record: {} } }
        : { status: 404, body: { not_found: true } };
    },
  } as unknown as Partial<ToolContext>);
  const minted = await mintWorkspaceRequestId(
    ctx,
    { input: { title: 'Retinol Basics!' } },
    new Date('2026-08-17T10:00:00Z')
  );
  assert.equal(minted, 'req_agent_retinol_basics_20260817_02');
  assert.match(minted, REQUEST_ID_RE);
  assert.deepEqual(probed, ['req_agent_retinol_basics_20260817_01', 'req_agent_retinol_basics_20260817_02']);
  // args.slug wins over the title.
  assert.equal(
    await mintWorkspaceRequestId(
      makeCtx(() => ({}), []),
      { slug: 'sun-care', input: { title: 'x' } },
      new Date('2026-08-17T00:00:00Z')
    ),
    'req_agent_sun_care_20260817_01'
  );
  assert.equal(WORKSPACE_RUN_BUDGET_MS, 45_000);
});

test('run_workspace_workflow rejects a malformed request_id at parse time', () => {
  const tool = chatToolByName('run_workspace_workflow')!;
  const bad = tool.parse(
    { input: { title: 't' }, request_id: 'req_agent_x_2026_1' },
    makeCtx(() => ({}), [])
  );
  assert.equal(bad.ok, false);
  const good = tool.parse(
    { input: { title: 't' }, request_id: REQ },
    makeCtx(() => ({}), [])
  );
  assert.equal(good.ok, true);
});

// ─── check_workspace_run_readiness ────────────────────────────────────────────────

test('check_workspace_run_readiness sends the exact workflow_publish_readiness payload (approval omitted, both media ref forms) and returns checklist + blockers verbatim', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(() => NO_GO, calls);
  const tool = chatToolByName('check_workspace_run_readiness')!;
  assert.equal(tool.toolClass, 'read');
  assert.equal(resolveAutonomy(undefined, undefined).check_workspace_run_readiness, 'auto');

  const parsed = tool.parse({ run_id: 'run_1', request_id: REQ, tags: ['retinol'] }, ctx);
  assert.equal(parsed.ok, true);
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ, tags: ['retinol'] });
  assert.equal(result.is_error, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.name, 'workflow_publish_readiness');
  assert.deepEqual(calls[0]!.args, {
    projectId: 'platform',
    runId: 'run_1',
    readiness: {
      releaseBehavior: 'publish_now',
      taxonomy: { tags: ['retinol'] },
      verifiedMediaRefs: EXPECTED_REFS,
    },
  });
  assert.equal('approval' in (calls[0]!.args.readiness as Record<string, unknown>), false);
  const body = JSON.parse(result.content) as typeof NO_GO;
  assert.equal(body.status, 'no_go');
  assert.deepEqual(body.checklist, NO_GO.checklist);
  assert.deepEqual(body.blockers, NO_GO.blockers);
});

// ─── publish_workspace_run ────────────────────────────────────────────────────────

test('publish_workspace_run: D2 floor (never auto), privileged, and the approval card carries the readiness checklist + failing checks', async () => {
  const tool = chatToolByName('publish_workspace_run')!;
  assert.equal(tool.toolClass, 'privileged');
  assert.equal(tool.autonomyFloor, 'ask');
  assert.equal(resolveAutonomy({ publish_workspace_run: 'auto' }, undefined).publish_workspace_run, 'ask');
  assert.equal(resolveAutonomy(undefined, { publish_workspace_run: 'auto' }).publish_workspace_run, 'ask');
  assert.equal(resolveGeneratedAutonomy({ publish_workspace_run: 'auto' }, undefined).publish_workspace_run, 'ask');
  assert.equal(generatedChatToolByName('publish_workspace_run'), tool, 'generated registry reuses the same tool');

  const calls: Call[] = [];
  const ctx = makeCtx(() => NO_GO, calls);
  const card = await tool.dryRun!(ctx, { run_id: 'run_1', request_id: REQ, tags: ['retinol'] });
  assert.equal(card.dry_run, true);
  assert.equal((card.readiness as { status: string }).status, 'no_go');
  assert.deepEqual((card.readiness as { checklist: unknown }).checklist, NO_GO.checklist);
  assert.deepEqual(card.failing_checks, [NO_GO.checklist[1]]);
  assert.equal(card.approver, 'editor@example.com');
  assert.match(String(card.note), /refused/);
  // The card is a readiness READ only — never a publish.
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness']
  );
});

test('publish_workspace_run refuses when readiness is not "go" — workflow_publish_run is never called', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(() => NO_GO, calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ, tags: ['retinol'] });
  assert.equal(result.is_error, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness']
  );
  const body = JSON.parse(result.content) as { error: string; readiness: { status: string } };
  assert.match(body.error, /not ready/);
  assert.equal(body.readiness.status, 'no_go');
});

test('readiness is read out of the envelope the server really sends, not the flat shape the old fixtures used', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(() => GO_NESTED, calls);
  const check = chatToolByName('check_workspace_run_readiness')!;
  const seen = JSON.parse((await check.execute(ctx, { run_id: 'run_1', request_id: REQ })).content) as {
    status: string;
    checklist: unknown;
    blockers: unknown;
  };
  assert.equal(seen.status, 'go', 'the verdict must survive the two levels of nesting');
  assert.deepEqual(seen.checklist, GO.checklist);
  assert.deepEqual(seen.blockers, GO.blockers);
});

// 2026-08-28, run_1787930929962_njffct — the chat said the article had published. It had not.
//
// workflow_publish_run returns ok({ publish: <PublishResult> }); callTool strips only the outer
// {ok,data}, so the result sits one key in — the same wrapper the readiness verdict hides behind.
// This read was `data.published ?? data.status ?? true` against the WRAPPED payload, so both
// operands were undefined and the `?? true` reported EVERY call as a successful publish, with
// is_error:false. The sequence had actually stopped at its second client call, leaving the object
// created, checked out and unpublished on the live site.
//
// A publish that did not happen must never read as one, and an unreadable result must never read as
// one either.
const BLOCKED_PUBLISH = {
  publish: {
    published: false,
    mode: 'blocked_for_publish_execution',
    publishCommitted: false,
    blocker: {
      code: 'publish_sequence_error',
      step: 'checkout_missing_lock_token',
      clientError: 'checkout_missing_lock_token: object_checkout returned a SUCCESS result that carries no lock_token.',
    },
    blockers: ['publish_sequence_error at checkout_missing_lock_token'],
    receipts: { toolSequence: ['object_create', 'object_checkout'], publishedTime: null },
  },
};
const LIVE_PUBLISH = {
  publish: {
    published: true,
    mode: 'live',
    objectId: 'req_conductor_x_20260828_01',
    result: { article_path: '/beauty-claim-playbook', receipt: { commit_sha: 'abc1234' } },
  },
};

test('publish_workspace_run reports a BLOCKED publish as an error, never as published', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx((name) => (name === 'workflow_publish_readiness' ? GO_NESTED : BLOCKED_PUBLISH), calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });
  assert.equal(result.is_error, true, 'a publish that did not happen must be an error');
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.published, false);
  assert.match(String(body.error), /did not complete/);
  assert.equal(body.mode, 'blocked_for_publish_execution');
  assert.deepEqual(body.tool_sequence, ['object_create', 'object_checkout'], 'say how far it actually got');
  assert.deepEqual(body.blockers, BLOCKED_PUBLISH.publish.blockers);
});

// The fabrication itself: an unreadable shape used to become `published: true`. It must now be an
// error that says the outcome is unknown — silence about an unreadable result is what cost the day.
test('publish_workspace_run refuses to invent a success from an unreadable result', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx((name) => (name === 'workflow_publish_readiness' ? GO_NESTED : { publish: { mode: 'mystery' } }), calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });
  assert.equal(result.is_error, true);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.published, false);
  assert.match(String(body.error), /could not be read/);
});

// THE LEDGER TRAP (2026-08-28, run_1787930929962_njffct). The idempotency ledger replays a stored
// result verbatim and calls nothing. Its own rule is that only a SUCCESSFUL write may be stored —
// but `isError` is a TRANSPORT verdict, and a refused publish arrives as a perfectly successful MCP
// call carrying published:false. So a failed publish was stored under `publish:<runId>` and every
// later attempt on that run replayed the refusal without calling anything: two separate fixes were
// deployed and verified live, and each retry returned the identical pre-fix error, with no new lock
// and no version bump on the client object. The failure looked like the fixes had not worked.
test('a failed publish never enters the idempotency ledger, so a retry is a real retry', async () => {
  const calls: Call[] = [];
  const stored: Array<{ tool: string; key: string }> = [];
  const ctx = makeCtx((name) => (name === 'workflow_publish_readiness' ? GO_NESTED : BLOCKED_PUBLISH), calls, {
    // Stands in for withIdempotentToolCall: it stores only results that are NOT isError.
    idempotent: async (toolName: string, key: string, run: () => Promise<Record<string, unknown>>) => {
      const outcome = await run();
      if (!outcome.isError) stored.push({ tool: toolName, key });
      return outcome;
    },
  } as unknown as Partial<ToolContext>);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });

  assert.equal(result.is_error, true);
  assert.deepEqual(stored, [], 'a refused publish must not be stored — storing it makes the run permanently unretryable');
  // And it must still report the client's own blocker, not a bare transport message.
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.published, false);
  assert.deepEqual(body.tool_sequence, ['object_create', 'object_checkout']);
});

test('a successful publish IS stored, and a replay of one says so', async () => {
  const stored: Array<{ tool: string; key: string }> = [];
  const ctx = makeCtx((name) => (name === 'workflow_publish_readiness' ? GO_NESTED : LIVE_PUBLISH), [], {
    idempotent: async (toolName: string, key: string, run: () => Promise<Record<string, unknown>>) => {
      const outcome = await run();
      if (!outcome.isError) stored.push({ tool: toolName, key });
      return outcome;
    },
  } as unknown as Partial<ToolContext>);
  const tool = chatToolByName('publish_workspace_run')!;
  assert.equal((await tool.execute(ctx, { run_id: 'run_1', request_id: REQ })).is_error, false);
  assert.deepEqual(stored, [{ tool: 'publish_workspace_run', key: 'publish:run_1' }]);

  // A replay published EARLIER and ran nothing now — the operator has to be able to tell.
  const replayCtx = makeCtx(() => GO_NESTED, [], {
    idempotent: async () => ({ ok: true, data: LIVE_PUBLISH, structuredContent: { replayed_from_idempotency_key: true } }),
  } as unknown as Partial<ToolContext>);
  const replay = await tool.execute(replayCtx, { run_id: 'run_1', request_id: REQ });
  assert.equal(replay.is_error, false);
  const body = JSON.parse(replay.content) as Record<string, unknown>;
  assert.equal(body.published, true);
  assert.equal(body.replayed_from_earlier_publish, true);
  assert.match(String(body.note), /REPLAYED/);
});

test('publish_workspace_run reports a real publish, with the receipt dug out of the nested result', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx((name) => (name === 'workflow_publish_readiness' ? GO_NESTED : LIVE_PUBLISH), calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });
  assert.equal(result.is_error, false, result.content);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.published, true);
  assert.equal(body.article_path, '/beauty-claim-playbook');
  assert.deepEqual(body.receipt, { commit_sha: 'abc1234' });
  // "Published" is not "live" and the copy must not let an editor believe otherwise.
  assert.match(String(body.note), /NOT live until an explicit release/);
});

test('publish_workspace_run PUBLISHES a nested "go" — the refusal that blocked every real publish', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(
    (name) =>
      name === 'workflow_publish_readiness' ? GO_NESTED : { published: true, commit: 'abc1234', receipt: { id: 'rcpt_1' } },
    calls
  );
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ, tags: ['retinol'] });
  assert.equal(result.is_error, false, result.content);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness', 'workflow_publish_run'],
    'a nested go must reach workflow_publish_run'
  );
});

test('publish_workspace_run still refuses a nested no_go, and reports its real blockers', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(() => NO_GO_NESTED, calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });
  assert.equal(result.is_error, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness'],
    'a no_go must never reach workflow_publish_run'
  );
  const body = JSON.parse(result.content) as { error: string; readiness: { status: string; blockers: unknown } };
  assert.match(body.error, /not ready to publish/);
  assert.equal(body.readiness.status, 'no_go');
  assert.deepEqual(body.readiness.blockers, NO_GO.blockers);
});

// A missing verdict and a no_go are different facts and must read differently: one
// is the checklist speaking, the other is nothing having judged the run at all.
// Conflating them is what made an envelope bug look like a content problem.
test('publish_workspace_run names a MISSING verdict as a system fault, not as "not ready"', async () => {
  const calls: Call[] = [];
  const ctx = makeCtx(() => ({ readiness: { available: false, articleBodyValid: true, readiness: null } }), calls);
  const tool = chatToolByName('publish_workspace_run')!;
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ });
  assert.equal(result.is_error, true);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness'],
    'no verdict must never reach workflow_publish_run either'
  );
  const body = JSON.parse(result.content) as { error: string };
  assert.match(body.error, /no readiness verdict/);
  assert.doesNotMatch(body.error, /not ready to publish/);
});

test('publish_workspace_run on "go" sends the exact workflow_publish_run payload with the approval pinned to the human, under a stored publish:<runId> idempotency key', async () => {
  const calls: Call[] = [];
  const idempotentCalls: Array<{ tool: string; key: string }> = [];
  const ctx = makeCtx(
    (name) =>
      name === 'workflow_publish_readiness' ? GO : { published: true, commit: 'abc1234', receipt: { id: 'rcpt_1' } },
    calls,
    {
      idempotent: async (toolName: string, key: string, run: () => Promise<Record<string, unknown>>) => {
        idempotentCalls.push({ tool: toolName, key });
        return run();
      },
    } as unknown as Partial<ToolContext>
  );
  const tool = chatToolByName('publish_workspace_run')!;
  const before = Date.now();
  const result = await tool.execute(ctx, { run_id: 'run_1', request_id: REQ, tags: ['retinol'] });
  assert.equal(result.is_error, false, result.content);
  assert.deepEqual(
    calls.map((call) => call.name),
    ['workflow_publish_readiness', 'workflow_publish_run']
  );
  const sent = calls[1]!.args as {
    readiness: { approval: { approvedBy: string; approvedAt: string; pinned: boolean } };
  } & Record<string, unknown>;
  const approvedAt = sent.readiness.approval.approvedAt;
  assert.ok(
    Date.parse(approvedAt) >= before - 1000 && Date.parse(approvedAt) <= Date.now() + 1000,
    'approvedAt is now (ISO)'
  );
  assert.deepEqual(sent, {
    runId: 'run_1',
    projectId: 'platform',
    requestId: REQ,
    approved: true,
    live: true,
    readiness: {
      approval: { approvedBy: 'editor@example.com', approvedAt, pinned: true },
      releaseBehavior: 'publish_now',
      taxonomy: { tags: ['retinol'] },
      verifiedMediaRefs: EXPECTED_REFS,
    },
  });
  assert.deepEqual(idempotentCalls, [{ tool: 'publish_workspace_run', key: 'publish:run_1' }]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.run_id, 'run_1');
  assert.equal(body.request_id, REQ);
  assert.equal(body.published, true);
  assert.equal(body.commit, 'abc1234');
  assert.equal(body.approved_by, 'editor@example.com');
});

test('publish_workspace_run refuses without a human principal and without the bridge', async () => {
  const tool = chatToolByName('publish_workspace_run')!;
  const noHuman = makeCtx(() => GO, [], { principal: undefined } as unknown as Partial<ToolContext>);
  const r1 = await tool.execute(noHuman, { run_id: 'run_1', request_id: REQ });
  assert.equal(r1.is_error, true);
  assert.match(r1.content, /human approver/);
  const noBridge = makeCtx(() => GO, [], { cmsAgent: undefined } as unknown as Partial<ToolContext>);
  const r2 = await tool.execute(noBridge, { run_id: 'run_1', request_id: REQ });
  assert.equal(r2.is_error, true);
});

// ─── release_workspace_run ────────────────────────────────────────────────────────

test('release_workspace_run: ask floor + Owner-only; on approval calls release_to_production (idempotency key) then ONE deploy_status read', async () => {
  const tool = chatToolByName('release_workspace_run')!;
  assert.equal(tool.autonomyFloor, 'ask');
  assert.equal(resolveAutonomy({ release_workspace_run: 'auto' }, undefined).release_workspace_run, 'ask');

  const opCalls: Call[] = [];
  const operational = {
    call: async (name: string, args: Record<string, unknown>) => {
      opCalls.push({ name, args });
      if (name === 'release_to_production') {
        return {
          content: JSON.stringify({ released: true, status: 'released', targetCommit: 'abc1234' }),
          is_error: false,
        };
      }
      return { content: JSON.stringify({ deployStatus: 'ready', productionConfirmed: true }), is_error: false };
    },
  };
  const ctx = makeCtx(() => ({}), [], { operational } as unknown as Partial<ToolContext>);
  const result = await tool.execute(ctx, { commit: 'abc1234', publish_receipt_from_run: 'run_1' });
  assert.equal(result.is_error, false, result.content);
  assert.deepEqual(opCalls, [
    { name: 'release_to_production', args: { commit: 'abc1234', idempotency_key: 'release:run_1' } },
    { name: 'deploy_status', args: { commit: 'abc1234' } },
  ]);
  const body = JSON.parse(result.content) as Record<string, unknown>;
  assert.equal(body.released, true);
  assert.equal(body.status, 'released');
  assert.equal(body.target_commit, 'abc1234');
  assert.deepEqual(body.deploy, { status: 'ready', production_confirmed: true });

  // Non-owner: refused at execution, no operational call.
  const nonOwner = makeCtx(() => ({}), [], { roles: ['admin'], operational } as unknown as Partial<ToolContext>);
  const refused = await tool.execute(nonOwner, {});
  assert.equal(refused.is_error, true);
  assert.equal(opCalls.length, 2);

  const card = await tool.dryRun!(ctx, { commit: 'abc1234' });
  assert.equal(card.dry_run, true);
  assert.equal(card.commit, 'abc1234');
});
