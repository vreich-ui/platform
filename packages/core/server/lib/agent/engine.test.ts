/**
 * PF2 — TurnEngine seam unit tests.
 *
 * providerEngine must be byte-identical to the pre-seam adapter call;
 * cmsAgentEngine must honor the as-built contract constraints (plan §5A):
 * actor shape (1), empty-actor refusal (2), turn_id discipline (3), the
 * second transcript bound with tool adjacency (4+5), explicit constraints
 * (6), paired object context (7), tools pass-through (8), and the
 * re-resolve-on-agent_unresolved rule (10). Transport/bounds behavior itself
 * is the PF1 client's and is tested in cms-agent-client.test.ts.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import type { ChatDoc, ChatMsg, ChatRun } from './chat-store.js';
import type {
  CmsAgentConverseRequest,
  CmsAgentConverseResponse,
  CmsAgentResult,
} from './cms-agent-client.js';
import {
  buildChatEngine,
  cmsAgentEngine,
  CmsAgentEngineError,
  humanCopyForCmsAgentError,
  providerEngine,
  trimTranscriptForCmsAgent,
  type CmsAgentTurnClient,
} from './engine.js';
import type { WireTool } from './provider.js';

const NOW_ISO = '2026-08-11T12:00:00.000Z';

const TOOLS: WireTool[] = [
  { name: 'patch', description: 'Propose a governed patch.', input_schema: { type: 'object' } },
  { name: 'get_object', description: 'Read an object.', input_schema: { type: 'object' } },
];

const chatDoc = (over: Partial<ChatDoc> = {}): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: 'obj:page_home',
  kind: 'object',
  object_type: 'page',
  object_id: 'page_home',
  title: 'page_home',
  created_by: 'wolf@example.com',
  created_at: NOW_ISO,
  updated_at: NOW_ISO,
  status: 'running',
  seq: 1,
  events: [],
  runs: [],
  ...over,
});

const chatRun = (over: Partial<ChatRun> = {}): ChatRun => ({
  run_id: 'run_pf2',
  started_at: NOW_ISO,
  principal: { kind: 'human', id: 'identity-wolf', email: 'wolf@example.com' },
  profile: {
    profile_id: 'prof_test',
    name: 'Test Agent',
    provider: 'openai',
    model: 'test-model',
    system_prompt: 'platform-side prompt (must never reach the wire)',
  },
  autonomy: {},
  learning_mode: false,
  diagnostics_requested: false,
  engine: 'provider',
  transcript: [{ role: 'user', text: 'Improve the hero heading.' }],
  call_queue: [],
  provider_turns: 1,
  tool_calls_used: 0,
  output_tokens_used: 0,
  ...over,
});

const okTurn = (over: Partial<CmsAgentConverseResponse> = {}): CmsAgentResult<CmsAgentConverseResponse> => ({
  ok: true,
  data: {
    assistant_text: 'Here is a proposal.',
    usage: { input_tokens: 120, output_tokens: 30, cost_usd: 0.0005 },
    agent_rev: 2,
    model: 'gpt-4.1',
    ...over,
  },
});

/** Scripted stand-in for the PF1 client: returns `script` responses in order. */
const stubClient = (script: Array<CmsAgentResult<CmsAgentConverseResponse>>) => {
  const converseCalls: CmsAgentConverseRequest[] = [];
  const invalidations: string[] = [];
  let resolves = 0;
  const client: CmsAgentTurnClient = {
    async resolveAgent() {
      resolves += 1;
      return { ok: true, data: `agt_client_manager@${resolves}` };
    },
    async converse(request) {
      converseCalls.push(structuredClone(request));
      return script[Math.min(converseCalls.length - 1, script.length - 1)]!;
    },
    invalidateAgentRef(role, projectId) {
      invalidations.push(`${role}:${projectId}`);
    },
  };
  return { client, converseCalls, invalidations, resolveCount: () => resolves };
};

const engineWith = (script: Array<CmsAgentResult<CmsAgentConverseResponse>>) => {
  const stub = stubClient(script);
  const engine = cmsAgentEngine({ client: stub.client, projectId: 'platform', siteId: 'site_platform' });
  return { engine, ...stub };
};

// ─── PF2.1 providerEngine ────────────────────────────────────────────────────

test('providerEngine passes system/transcript/tools through byte-identically and returns the adapter result untouched', async () => {
  const seen: unknown[] = [];
  const result = { text: 'ok', toolCalls: [{ id: 'c1', name: 'patch', args: { a: 1 } }], outputTokens: 7 };
  const engine = providerEngine(async (input) => {
    seen.push(input);
    return result;
  });
  const run = chatRun();
  const turn = await engine({ doc: chatDoc(), run, system: 'SYS', tools: TOOLS });
  assert.deepEqual(seen, [{ system: 'SYS', transcript: run.transcript, tools: TOOLS }]);
  // Same object, not a re-shape: nothing between the adapter and the loop.
  assert.equal(turn, result);
  assert.equal((seen[0] as { transcript: ChatMsg[] }).transcript, run.transcript);
});

// ─── constraint 1 + 6 + 7 + 8: the wire request ─────────────────────────────

test('cmsAgentEngine builds the strict request: {kind,id} actor (no email), explicit constraints, paired object context, tools passed through, no system prompt field', async () => {
  const { engine, converseCalls } = engineWith([okTurn()]);
  const run = chatRun();
  await engine({ doc: chatDoc(), run, system: 'SECRET-PLATFORM-PROMPT', tools: TOOLS });

  assert.equal(converseCalls.length, 1);
  const request = converseCalls[0]!;
  assert.deepEqual(request.actor, { kind: 'human', id: 'identity-wolf' });
  assert.equal(JSON.stringify(request).includes('wolf@example.com'), false, 'principal.email must be stripped');
  assert.equal(JSON.stringify(request).includes('SECRET-PLATFORM-PROMPT'), false, 'no system prompt on the wire');
  assert.deepEqual(request.constraints, { max_tokens: 16_000, timeout_ms: 90_000 });
  assert.equal(request.context.object_type, 'page');
  assert.equal(request.context.object_id, 'page_home');
  assert.equal(request.context.site_id, 'site_platform');
  assert.equal(request.context.learning_mode, false);
  assert.equal('diagnostics_requested' in request.context, false, 'only sent when the Owner flag is set');
  assert.deepEqual(request.tools, TOOLS);
  assert.equal(request.project_id, 'platform');
  assert.equal(request.conversation_id, 'obj:page_home');
  assert.equal(request.turn_id, 't_run_pf2_1');
});

test('a free chat sends neither object_type nor object_id; diagnostics_requested rides only when set', async () => {
  const { engine, converseCalls } = engineWith([okTurn()]);
  const doc = chatDoc({ chat_id: 'chat_free1', kind: 'free' });
  delete doc.object_type;
  delete doc.object_id;
  const run = chatRun({ diagnostics_requested: true, focus: 'General question' });
  await engine({ doc, run, system: '', tools: [] });

  const context = converseCalls[0]!.context;
  assert.equal('object_type' in context, false);
  assert.equal('object_id' in context, false);
  assert.equal(context.diagnostics_requested, true);
  assert.equal(context.focus, 'General question');
});

// ─── constraint 2: empty actor id ────────────────────────────────────────────

test('an empty principal id refuses the turn locally with cms_agent_invalid_actor — nothing is sent', async () => {
  const { engine, converseCalls } = engineWith([okTurn()]);
  const run = chatRun({ principal: { kind: 'human', id: '  ', email: 'wolf@example.com' } });
  await assert.rejects(
    () => engine({ doc: chatDoc(), run, system: '', tools: [] }),
    (error: unknown) => error instanceof CmsAgentEngineError && error.code === 'cms_agent_invalid_actor'
  );
  assert.equal(converseCalls.length, 0);
});

// ─── response mapping + run stamping ─────────────────────────────────────────

test('the response maps to the loop shape and the run is stamped with engine + agent_ref', async () => {
  const calls = [{ id: 'call_1', name: 'patch', args: { ops: [] } }];
  const { engine } = engineWith([okTurn({ assistant_text: undefined, tool_calls: calls })]);
  const run = chatRun();
  const turn = await engine({ doc: chatDoc(), run, system: '', tools: TOOLS });
  assert.deepEqual(turn, { toolCalls: calls, outputTokens: 30 });
  assert.equal(run.engine, 'cms_agent');
  assert.equal(run.agent_ref, 'agt_client_manager@1');
});

// ─── constraint 3 + 10: turn_id discipline on the two in-engine retries ──────

test('agent_unresolved re-resolves once and retries with a FRESH turn_id (validation-class claims pin forever)', async () => {
  const { engine, converseCalls, invalidations, resolveCount } = engineWith([
    { ok: false, code: 'agent_unresolved', message: 'stale rev', retryableWithSameTurnId: false },
    okTurn(),
  ]);
  const run = chatRun();
  const turn = await engine({ doc: chatDoc(), run, system: '', tools: TOOLS });
  assert.equal(turn.outputTokens, 30);
  assert.equal(converseCalls.length, 2);
  assert.equal(converseCalls[0]!.turn_id, 't_run_pf2_1');
  assert.equal(converseCalls[1]!.turn_id, 't_run_pf2_1_r1', 'the retry must not reuse the pinned id');
  assert.deepEqual(invalidations, ['client_manager:platform']);
  assert.equal(resolveCount(), 2);
  assert.equal(converseCalls[1]!.agent_ref, 'agt_client_manager@2', 'the fresh resolution is used');
});

test('an expired MCP session retries once with the SAME turn_id (byte-identical replay is free)', async () => {
  const { engine, converseCalls } = engineWith([
    {
      ok: false,
      code: 'cms_agent_protocol_error',
      message: 'The CMS-Agent MCP session expired; retry to open a new one.',
      retryableWithSameTurnId: true,
      statusCode: 404,
    },
    okTurn(),
  ]);
  const turn = await engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });
  assert.equal(turn.outputTokens, 30);
  assert.equal(converseCalls.length, 2);
  assert.equal(converseCalls[0]!.turn_id, converseCalls[1]!.turn_id);
});

// ─── constraint 9 / §5.5: everything else throws a stable cms_agent_* code ───

test('a wire error throws cms_agent_<code> after exactly one call — no blind retries', async () => {
  const { engine, converseCalls } = engineWith([
    { ok: false, code: 'unknown_project', message: 'no such project', retryableWithSameTurnId: false },
  ]);
  await assert.rejects(
    () => engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS }),
    (error: unknown) => error instanceof CmsAgentEngineError && error.code === 'cms_agent_unknown_project'
  );
  assert.equal(converseCalls.length, 1);
});

test('a transport code already carrying the prefix is not double-prefixed', async () => {
  const { engine } = engineWith([
    { ok: false, code: 'cms_agent_auth_failed', message: 'opaque 401', retryableWithSameTurnId: true, statusCode: 401 },
  ]);
  await assert.rejects(
    () => engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS }),
    (error: unknown) => error instanceof CmsAgentEngineError && error.code === 'cms_agent_auth_failed'
  );
});

// ─── constraints 4 + 5: the second transcript bound ──────────────────────────

test('trimTranscriptForCmsAgent trims oldest-first and never leaves a leading orphaned tool result', () => {
  const turnOf = (index: number): ChatMsg[] => [
    { role: 'assistant', tool_calls: [{ id: `call_${index}`, name: 'get_object', args: {} }] },
    { role: 'tool', tool_call_id: `call_${index}`, content: `result ${index}` },
  ];
  const transcript: ChatMsg[] = [{ role: 'user', text: 'start' }];
  for (let index = 0; index < 120; index += 1) transcript.push(...turnOf(index));
  assert.equal(transcript.length, 241); // over the 200-message bound

  const trimmed = trimTranscriptForCmsAgent(transcript);
  assert.ok(trimmed.length <= 200);
  assert.notEqual(trimmed[0]!.role, 'tool', 'a leading tool message would be invalid_turn_request upstream');
  // Adjacency survives: every tool message still answers the assistant message before it.
  trimmed.forEach((message, index) => {
    if (message.role !== 'tool') return;
    const previous = trimmed[index - 1]!;
    const openIds =
      previous.role === 'assistant'
        ? (previous.tool_calls ?? []).map((call) => call.id)
        : previous.role === 'tool'
          ? [] // consecutive results are checked against their shared assistant below
          : [];
    if (previous.role === 'assistant') assert.ok(openIds.includes(message.tool_call_id));
  });
  // The newest messages are the ones kept.
  assert.deepEqual(trimmed[trimmed.length - 1], transcript[transcript.length - 1]);
});

test('trimTranscriptForCmsAgent enforces the serialized-size bound too, and leaves small transcripts untouched', () => {
  const small: ChatMsg[] = [{ role: 'user', text: 'hello' }];
  assert.deepEqual(trimTranscriptForCmsAgent(small), small);

  const big = 'x'.repeat(60_000);
  const transcript: ChatMsg[] = [
    { role: 'user', text: big },
    { role: 'user', text: big },
    { role: 'user', text: big },
    { role: 'user', text: big },
    { role: 'user', text: big },
    { role: 'user', text: 'the newest message' },
  ];
  const trimmed = trimTranscriptForCmsAgent(transcript);
  assert.ok(JSON.stringify(trimmed).length <= 256_000);
  assert.deepEqual(trimmed[trimmed.length - 1], { role: 'user', text: 'the newest message' });
});

// ─── PF5: buildChatEngine — permanent Client Manager, fail closed ────────────

const failingClient = (): CmsAgentTurnClient => ({
  async resolveAgent() {
    return { ok: false, code: 'cms_agent_unreachable', message: 'down', retryableWithSameTurnId: true };
  },
  async converse() {
    return { ok: false, code: 'cms_agent_unreachable', message: 'down', retryableWithSameTurnId: true };
  },
  invalidateAgentRef() {},
});

test('buildChatEngine always uses Client Manager and records the CMS-Agent engine', async () => {
  const stub = stubClient([okTurn()]);
  const engine = buildChatEngine({
    client: stub.client,
    projectId: 'platform',
    siteId: 'site_platform',
  });
  const run = chatRun();
  const turn = await engine({ doc: chatDoc(), run, system: 'ignored Platform prompt', tools: [] });
  assert.equal(turn.text, 'Here is a proposal.');
  assert.equal(stub.converseCalls.length, 1);
  assert.equal(run.engine, 'cms_agent');
});

test('buildChatEngine fails closed when CMS-Agent is unavailable', async () => {
  const engine = buildChatEngine({
    client: failingClient(),
    projectId: 'platform',
    siteId: 'site_platform',
  });
  await assert.rejects(
    () => engine({ doc: chatDoc(), run: chatRun(), system: '', tools: [] }),
    (error: unknown) => error instanceof CmsAgentEngineError && error.code === 'cms_agent_unreachable'
  );
});

test('humanCopyForCmsAgentError: every named class gets editor-safe copy; unknown codes get the generic sentence', () => {
  for (const code of [
    'cms_agent_not_configured',
    'cms_agent_auth_failed',
    'cms_agent_timeout',
    'cms_agent_model_timeout',
    'cms_agent_transcript_too_large',
    'cms_agent_budget_exceeded',
    'cms_agent_invalid_actor',
    'cms_agent_something_new',
  ]) {
    const copy = humanCopyForCmsAgentError(code);
    assert.ok(copy.length > 20);
    assert.equal(/gpt|openai|anthropic|claude|agt_|schema/i.test(copy), false, `no internals in copy for ${code}`);
  }
});
