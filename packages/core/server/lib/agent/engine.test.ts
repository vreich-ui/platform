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
import {
  checkConverseBounds,
  dropOverBoundsOrigin,
  dropOverBoundsUiCapabilities,
  ORIGIN_BOUNDS,
  UI_CAPABILITIES_BOUNDS,
  type CmsAgentConverseRequest,
  type CmsAgentConverseResponse,
  type CmsAgentResolveResponse,
  type CmsAgentResult,
} from './cms-agent-client.js';
import {
  buildChatEngine,
  buildTurnOrigin,
  cmsAgentEngine,
  CmsAgentEngineError,
  CMS_AGENT_UNAVAILABLE_TEXT,
  humanCopyForCmsAgentError,
  MIN_AGENT_REV_FOR_ORIGIN,
  MIN_AGENT_REV_FOR_UI_CAPABILITIES,
  originAllowedAtRev,
  providerEngine,
  trimTranscriptForCmsAgent,
  uiCapabilitiesAllowedAtRev,
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
const resolvedAgent = (rev: number, ref = `agt_client_manager@${rev}`): CmsAgentResolveResponse => ({
  agent_ref: ref,
  name: 'Client Manager',
  rev,
  model: 'gpt-4.1',
  status: 'active',
});

/**
 * `revs` is the rev `agent_resolve` reports on each successive resolve —
 * ASV2-W4.3's `ui_capabilities` gate reads it, and the re-resolve path is
 * supposed to pick up a CHANGED rev, so the stub has to be able to change it.
 * Defaults to the gate's minimum so existing cases exercise the sending side.
 */
const stubClient = (
  script: Array<CmsAgentResult<CmsAgentConverseResponse>>,
  revs: number[] = [MIN_AGENT_REV_FOR_UI_CAPABILITIES]
) => {
  const converseCalls: CmsAgentConverseRequest[] = [];
  const invalidations: string[] = [];
  let resolves = 0;
  const client: CmsAgentTurnClient = {
    async resolveAgent() {
      resolves += 1;
      const rev = revs[Math.min(resolves - 1, revs.length - 1)]!;
      return { ok: true, data: resolvedAgent(rev, `agt_client_manager@${resolves}`) };
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

const engineWith = (
  script: Array<CmsAgentResult<CmsAgentConverseResponse>>,
  options: { revs?: number[]; roles?: readonly string[] } = {}
) => {
  const stub = stubClient(script, options.revs);
  const engine = cmsAgentEngine({
    client: stub.client,
    projectId: 'platform',
    siteId: 'site_platform',
    roles: options.roles ?? ['owner'],
  });
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

// ─── T8 (2026-08-25): approval_note carries the anti-hollow-approval rule ──

test("every turn's approval_note tells Client Manager to propose the privileged call, not just claim it, and to relay a no_go readiness verbatim", async () => {
  const { engine, converseCalls } = engineWith([okTurn()]);
  await engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });
  const note = converseCalls[0]!.context.approval_note!;
  assert.match(note, /never (say|claim)[^.]*"registered"/i);
  assert.match(note, /publish_workspace_run/);
  assert.match(note, /VERBATIM|verbatim/);
  assert.ok(note.length <= 1000, `approval_note must stay within the 1000-char contract bound, got ${note.length}`);
  assert.ok(checkConverseBounds(converseCalls[0]!) === undefined, 'the note must pass the pre-flight bound check');
});

// ─── ASV2-W4.3: context.ui_capabilities (chat-controls protocol §7) ────────

test('the rev gate opens at the rev CMS-Agent accepts the field, and only there', () => {
  assert.equal(MIN_AGENT_REV_FOR_UI_CAPABILITIES, 8, 'client_manager accepts ui_capabilities from rev 8 (ASV2-W4-CA.2)');
  assert.equal(uiCapabilitiesAllowedAtRev(MIN_AGENT_REV_FOR_UI_CAPABILITIES - 1), false);
  assert.equal(uiCapabilitiesAllowedAtRev(MIN_AGENT_REV_FOR_UI_CAPABILITIES), true);
  // `>=`, not `===`: ensureConversationalAgentSeeds() bumps a stored agent to
  // rev + 1 only when its prompt is byte-identical to a superseded text, so a
  // deployed workspace lands on rev >= 8 with no guarantee of the number.
  assert.equal(uiCapabilitiesAllowedAtRev(MIN_AGENT_REV_FOR_UI_CAPABILITIES + 5), true);
  // An unknown rev reads as below the gate — the closed side is the safe side.
  assert.equal(uiCapabilitiesAllowedAtRev(undefined), false);
  assert.equal(uiCapabilitiesAllowedAtRev('8'), false);
  assert.equal(uiCapabilitiesAllowedAtRev(Number.NaN), false);
});

test("a focused object's turn carries the rights-filtered quick actions of that object's type", async () => {
  const { engine, converseCalls } = engineWith([okTurn()], { roles: ['editor'] });
  await engine({ doc: chatDoc({ object_type: 'content_item', object_id: 'req_x' }), run: chatRun(), system: '', tools: TOOLS });

  const manifest = converseCalls[0]!.context.ui_capabilities!;
  assert.equal(manifest.v, 2);
  assert.ok(manifest.controls.includes('actions'), 'the kinds this build renders');
  assert.deepEqual(
    manifest.actions.map((action) => action.verb),
    ['object_validate', 'object_submit_review', 'object_create_variant', 'agent_chat'],
    "an editor's rights-filtered QUICK_ACTIONS for a content_item — object_publish needs PUBLISHING"
  );
  // The parameter schema travels with the verb: that is what lets §6.1's
  // executionFor(params) rule decide run / popover / hand-off client-side.
  assert.deepEqual(
    manifest.actions.find((action) => action.verb === 'object_create_variant')?.params,
    { mode: { type: 'enum', required: false } }
  );
  // A publisher on the same object gets the extra verb; nothing else changes.
  const publisher = engineWith([okTurn()], { roles: ['publisher'] });
  await publisher.engine({ doc: chatDoc({ object_type: 'content_item', object_id: 'req_x' }), run: chatRun(), system: '', tools: TOOLS });
  assert.ok(
    publisher.converseCalls[0]!.context.ui_capabilities!.actions.some((action) => action.verb === 'object_publish')
  );
  assert.equal(checkConverseBounds(converseCalls[0]!), undefined, 'the manifest must pass the pre-flight bounds');
});

test('a free chat carries the manifest with an empty actions list — the kinds, but nothing to act on', async () => {
  const { engine, converseCalls } = engineWith([okTurn()], { roles: ['owner'] });
  const doc = chatDoc({ chat_id: 'chat_free1', kind: 'free' });
  delete doc.object_type;
  delete doc.object_id;
  await engine({ doc, run: chatRun(), system: '', tools: [] });

  const manifest = converseCalls[0]!.context.ui_capabilities!;
  assert.deepEqual(manifest.actions, []);
  assert.ok(manifest.controls.length > 0);
});

test('below the minimum rev the field is absent and the context is byte-identical to the pre-W4.3 wire', async () => {
  const gated = engineWith([okTurn()], { revs: [MIN_AGENT_REV_FOR_UI_CAPABILITIES - 1], roles: ['owner'] });
  await gated.engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });
  const oldWire = gated.converseCalls[0]!.context;
  assert.equal('ui_capabilities' in oldWire, false, 'a tenant on an older agent rev degrades, never fails');

  // "Byte-identical to today's": the same context, key for key, that the turn
  // above the gate sends once its one added field is removed.
  const open = engineWith([okTurn()], { revs: [MIN_AGENT_REV_FOR_UI_CAPABILITIES], roles: ['owner'] });
  await open.engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });
  const { ui_capabilities: _added, ...withoutManifest } = open.converseCalls[0]!.context;
  assert.equal(JSON.stringify(oldWire), JSON.stringify(withoutManifest));
});

test('a re-resolve that reports a newer rev opens the gate for the retry', async () => {
  const stale: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'agent_unresolved',
    message: 'stale ref',
    retryableWithSameTurnId: false,
  };
  const { engine, converseCalls } = engineWith([stale, okTurn()], {
    revs: [MIN_AGENT_REV_FOR_UI_CAPABILITIES - 1, MIN_AGENT_REV_FOR_UI_CAPABILITIES],
    roles: ['owner'],
  });
  await engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });

  assert.equal(converseCalls.length, 2);
  assert.equal('ui_capabilities' in converseCalls[0]!.context, false, 'first attempt saw the old rev');
  assert.ok(converseCalls[1]!.context.ui_capabilities, 'the retry is gated on what the agent is now');
  assert.equal(converseCalls[1]!.turn_id, 't_run_pf2_1_r1', 'a validation-class rejection still mints a fresh id');
});

test('a deployment that rejects the manifest despite a passing rev gets one retry without it, under a fresh id', async () => {
  const rejected: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'invalid_turn_request',
    message: 'context: Unrecognized key "ui_capabilities"',
    retryableWithSameTurnId: false,
  };
  const { engine, converseCalls } = engineWith([rejected, okTurn()], { roles: ['owner'] });
  const turn = await engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });

  assert.equal(converseCalls.length, 2);
  assert.ok(converseCalls[0]!.context.ui_capabilities, 'the rev said it was safe to send');
  assert.equal('ui_capabilities' in converseCalls[1]!.context, false, 'the retry drops it');
  // The claim on the first id is already written upstream, so the retry must
  // mint a fresh one or it conflicts forever.
  assert.equal(converseCalls[0]!.turn_id, 't_run_pf2_1');
  assert.equal(converseCalls[1]!.turn_id, 't_run_pf2_1_nouc');
  assert.equal(turn.text, 'Here is a proposal.', 'the editor still gets an answer');
  // Everything else about the turn is unchanged.
  assert.equal(converseCalls[1]!.context.approval_note, converseCalls[0]!.context.approval_note);
});

test('the manifest retry fires at most once — a second rejection surfaces as the real error', async () => {
  const rejected: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'invalid_turn_request',
    message: 'messages: too many entries',
    retryableWithSameTurnId: false,
  };
  const { engine, converseCalls } = engineWith([rejected], { roles: ['owner'] });
  await assert.rejects(
    () => engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS }),
    (error: unknown) => error instanceof CmsAgentEngineError && error.code === 'cms_agent_invalid_turn_request'
  );
  assert.equal(converseCalls.length, 2, 'one retry, then the failure stands');
});

test('an over-bounds manifest is dropped whole, never truncated — the turn still goes', () => {
  const { engine: _engine } = engineWith([okTurn()]);
  const request = {
    agent_ref: 'agt_client_manager@8',
    project_id: 'platform',
    conversation_id: 'obj:page_home',
    turn_id: 't_run_pf2_1',
    actor: { kind: 'human', id: 'identity-wolf' },
    context: {
      site_id: 'site_platform',
      approval_note: 'note',
      ui_capabilities: {
        v: 2 as const,
        controls: ['radio'],
        actions: Array.from({ length: UI_CAPABILITIES_BOUNDS.maxActions + 1 }, (_unused, index) => ({
          verb: `verb_${index}`,
          label: 'Do it',
        })),
      },
    },
    messages: [{ role: 'user' as const, text: 'hi' }],
    tools: [],
    constraints: { ...{ max_tokens: 16_000, timeout_ms: 90_000 } },
  } satisfies CmsAgentConverseRequest;

  const dropped = dropOverBoundsUiCapabilities(request);
  assert.equal('ui_capabilities' in dropped.context, false, 'dropped, not truncated');
  assert.equal(dropped.turn_id, request.turn_id, 'the same turn_id still goes out — nothing is burned');
  assert.equal(checkConverseBounds(dropped), undefined, 'and the turn is still valid');
  // The original is untouched: the drop is a rebuild, not a mutation.
  assert.equal(request.context.ui_capabilities.actions.length, UI_CAPABILITIES_BOUNDS.maxActions + 1);
});

// ─── CHAT-ORIGIN: context.origin (client_manager rev 9) ─────────────────────

const ORIGIN_REV = MIN_AGENT_REV_FOR_ORIGIN;

/** A chat opened from the hub's "New article" starter, about a registered request. */
const originDoc = (over: Partial<ChatDoc> = {}): ChatDoc =>
  chatDoc({ origin_surface: 'agents', origin_starter: 'article', ...over });

test('the origin gate opens at the rev client_manager accepts the field, and only there', () => {
  assert.equal(MIN_AGENT_REV_FOR_ORIGIN, 9, 'client_manager accepts context.origin from rev 9');
  assert.ok(
    MIN_AGENT_REV_FOR_ORIGIN > MIN_AGENT_REV_FOR_UI_CAPABILITIES,
    'origin is the LATER field — a deployment that takes the manifest may still reject origin'
  );
  assert.equal(originAllowedAtRev(MIN_AGENT_REV_FOR_ORIGIN - 1), false);
  assert.equal(originAllowedAtRev(MIN_AGENT_REV_FOR_ORIGIN), true);
  assert.equal(originAllowedAtRev(MIN_AGENT_REV_FOR_ORIGIN + 4), true);
  // An unknown rev reads as below the gate — the closed side is the safe side.
  assert.equal(originAllowedAtRev(undefined), false);
  assert.equal(originAllowedAtRev('9'), false);
  assert.equal(originAllowedAtRev(Number.NaN), false);
});

test('a rev-9 workspace carries context.origin: surface + starter from the doc, request/run from the run', async () => {
  const { engine, converseCalls } = engineWith([okTurn()], { revs: [ORIGIN_REV] });
  await engine({
    doc: originDoc(),
    run: chatRun({ origin_request_id: 'req_article_topic_20260916_01', origin_run_id: 'run_42' }),
    system: '',
    tools: TOOLS,
  });

  assert.deepEqual(converseCalls[0]!.context.origin, {
    surface: 'agents',
    starter: 'article',
    request_id: 'req_article_topic_20260916_01',
    run_id: 'run_42',
  });
  assert.equal(checkConverseBounds(converseCalls[0]!), undefined, 'the origin must pass the pre-flight bounds');
});

test('below the origin gate the field is absent and the context is byte-identical to the pre-CHAT-ORIGIN wire', async () => {
  const gated = engineWith([okTurn()], { revs: [ORIGIN_REV - 1], roles: ['owner'] });
  await gated.engine({ doc: originDoc(), run: chatRun({ origin_request_id: 'req_1' }), system: '', tools: TOOLS });
  const oldWire = gated.converseCalls[0]!.context;
  assert.equal('origin' in oldWire, false, 'a tenant on an older agent rev degrades, never fails');
  // The manifest still rides at rev 8 — the two gates are independent.
  assert.ok(oldWire.ui_capabilities, 'rev 8 still carries ui_capabilities');

  const open = engineWith([okTurn()], { revs: [ORIGIN_REV], roles: ['owner'] });
  await open.engine({ doc: originDoc(), run: chatRun({ origin_request_id: 'req_1' }), system: '', tools: TOOLS });
  const { origin: _added, ...withoutOrigin } = open.converseCalls[0]!.context;
  assert.equal(JSON.stringify(oldWire), JSON.stringify(withoutOrigin));
});

test('a chat that knows nothing about where it came from sends no origin at all', async () => {
  const { engine, converseCalls } = engineWith([okTurn()], { revs: [ORIGIN_REV] });
  await engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS });
  assert.equal('origin' in converseCalls[0]!.context, false, 'absent, not an empty object');
});

test('buildTurnOrigin: the surface is required, so a pre-CHAT-ORIGIN doc with a resolved request falls back to admin', () => {
  // Nothing at all — no doc fields, no run fields.
  assert.equal(buildTurnOrigin(chatDoc(), chatRun()), undefined);
  // A chat doc minted before this change whose next send resolved a binding:
  // the request id is worth more than the unknown surface costs.
  assert.deepEqual(buildTurnOrigin(chatDoc(), chatRun({ origin_request_id: 'req_1' })), {
    surface: 'admin',
    request_id: 'req_1',
  });
  assert.deepEqual(buildTurnOrigin(originDoc(), chatRun()), { surface: 'agents', starter: 'article' });
});

test('buildTurnOrigin: an object chat never sends a selection — its pair already rides object_type/object_id', () => {
  const selection = { object_type: 'page', object_id: 'page_home' };
  const objectChat = buildTurnOrigin(
    originDoc({ origin_surface: 'objects' }),
    chatRun({ origin_selection: selection })
  );
  assert.equal(objectChat?.selection, undefined, 'the same fact twice would read as a NEW pick');

  const free = chatDoc({ chat_id: 'chat_free1', kind: 'free', origin_surface: 'objects' });
  delete free.object_type;
  delete free.object_id;
  assert.deepEqual(buildTurnOrigin(free, chatRun({ origin_selection: selection })), {
    surface: 'objects',
    selection,
  });
});

test('a deployment that rejects origin despite a passing rev drops BOTH gated fields in ONE retry', async () => {
  const rejected: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'invalid_turn_request',
    message: 'context: Unrecognized key "origin"',
    retryableWithSameTurnId: false,
  };
  const { engine, converseCalls } = engineWith([rejected, okTurn()], { revs: [ORIGIN_REV], roles: ['owner'] });
  const turn = await engine({
    doc: originDoc(),
    run: chatRun({ origin_request_id: 'req_1' }),
    system: '',
    tools: TOOLS,
  });

  assert.equal(converseCalls.length, 2, 'ONE retry — a second would burn another turn_id to learn the same thing');
  assert.ok(converseCalls[0]!.context.origin, 'the rev said it was safe to send');
  assert.ok(converseCalls[0]!.context.ui_capabilities);
  assert.equal('origin' in converseCalls[1]!.context, false, 'the retry drops origin');
  assert.equal('ui_capabilities' in converseCalls[1]!.context, false, 'and the manifest, in the same retry');
  assert.equal(converseCalls[0]!.turn_id, 't_run_pf2_1');
  assert.equal(converseCalls[1]!.turn_id, 't_run_pf2_1_nouc', 'a fresh id — the first claim is already written');
  assert.equal(turn.text, 'Here is a proposal.', 'the editor still gets an answer');
  assert.equal(converseCalls[1]!.context.approval_note, converseCalls[0]!.context.approval_note);
});

test('a re-resolve after the gated fields were rejected never puts them back', async () => {
  const rejected: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'invalid_turn_request',
    message: 'context: Unrecognized key "origin"',
    retryableWithSameTurnId: false,
  };
  const stale: CmsAgentResult<CmsAgentConverseResponse> = {
    ok: false,
    code: 'agent_unresolved',
    message: 'stale ref',
    retryableWithSameTurnId: false,
  };
  const { engine, converseCalls } = engineWith([rejected, stale, okTurn()], {
    revs: [ORIGIN_REV, ORIGIN_REV, ORIGIN_REV + 1],
    roles: ['owner'],
  });
  await engine({ doc: originDoc(), run: chatRun({ origin_request_id: 'req_1' }), system: '', tools: TOOLS });

  assert.equal(converseCalls.length, 3);
  assert.equal('origin' in converseCalls[2]!.context, false, 'the drop is one-way for the life of the run');
  assert.equal('ui_capabilities' in converseCalls[2]!.context, false);
});

test('an over-bounds origin is dropped whole — the turn still goes, under the same turn_id', () => {
  const request = {
    agent_ref: 'agt_client_manager@9',
    project_id: 'platform',
    conversation_id: 'obj:page_home',
    turn_id: 't_run_pf2_1',
    actor: { kind: 'human', id: 'identity-wolf' },
    context: {
      site_id: 'site_platform',
      approval_note: 'note',
      origin: { surface: 'agents', request_id: 'r'.repeat(ORIGIN_BOUNDS.maxChars) },
    },
    messages: [{ role: 'user' as const, text: 'hi' }],
    tools: [],
    constraints: { max_tokens: 16_000, timeout_ms: 90_000 },
  } satisfies CmsAgentConverseRequest;

  const dropped = dropOverBoundsOrigin(request);
  assert.equal('origin' in dropped.context, false, 'dropped, not truncated');
  assert.equal(dropped.turn_id, request.turn_id, 'nothing is burned');
  assert.equal(checkConverseBounds(dropped), undefined);
  // The original is untouched: the drop is a rebuild, not a mutation.
  assert.ok(request.context.origin.request_id.length > ORIGIN_BOUNDS.maxChars - 1);
  // An ordinary origin passes straight through, same object.
  const ordinary = { ...request, context: { ...request.context, origin: { surface: 'agents' } } };
  assert.equal(dropOverBoundsOrigin(ordinary), ordinary);
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

// Task B (provider-error-details): CMS-Agent's own structured detail must
// survive the wire -> CmsAgentEngineError hop unchanged, so the loop's
// run_error event (and from there, the chat and the "Stopped at …" card) can
// show WHY a provider call failed, not just that it did.
test('a provider_quota wire error carries operatorAction/providerStatus/providerMessage/fromJsonBody onto the thrown error', async () => {
  const { engine } = engineWith([
    {
      ok: false,
      code: 'provider_quota',
      message: 'Node "article_body" received 429 from openai: Your credit balance is too low.',
      retryableWithSameTurnId: false,
      operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body.",
      providerStatus: 429,
      providerMessage: 'Your credit balance is too low',
      fromJsonBody: true,
    },
  ]);
  await assert.rejects(
    () => engine({ doc: chatDoc(), run: chatRun(), system: '', tools: TOOLS }),
    (error: unknown) =>
      error instanceof CmsAgentEngineError &&
      error.code === 'cms_agent_provider_quota' &&
      error.providerStatus === 429 &&
      error.providerMessage === 'Your credit balance is too low' &&
      /Top up/.test(error.operatorAction ?? '') &&
      error.fromJsonBody === true
  );
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

test('humanCopyForCmsAgentError: every named class keeps its editor-safe copy, unaffected by a JSON body', () => {
  for (const code of [
    'cms_agent_not_configured',
    'cms_agent_auth_failed',
    'cms_agent_timeout',
    'cms_agent_model_timeout',
    'cms_agent_transcript_too_large',
    'cms_agent_budget_exceeded',
    'cms_agent_invalid_actor',
  ]) {
    const copy = humanCopyForCmsAgentError({ code, message: 'raw upstream text', fromJsonBody: true });
    assert.ok(copy.text.length > 20);
    assert.equal(/gpt|openai|anthropic|claude|agt_|schema/i.test(copy.text), false, `no internals in copy for ${code}`);
    assert.equal(copy.providerDetail, undefined);
  }
});

// Task B, case 1/4: "no JSON body" (connect error, timeout, HTML 5xx) — the
// generic sentence, and ONLY the generic sentence, with no raw detail leaked.
test('humanCopyForCmsAgentError: an unrecognized code with no JSON body gets the generic sentence', () => {
  const copy = humanCopyForCmsAgentError({ code: 'cms_agent_error', message: '<html>502 Bad Gateway</html>' });
  assert.equal(copy.text, CMS_AGENT_UNAVAILABLE_TEXT);
  assert.equal(copy.providerDetail, undefined);
});

// Task B, case 2/4: CMS-Agent DID answer with a parsed JSON error body — the
// real code/message/operatorAction render instead of the generic sentence.
// This is the 2026-08-29 incident itself: a provider_quota 429 must show WHY.
test('humanCopyForCmsAgentError: a JSON body with a code renders "<code>: <message> — <operatorAction>"', () => {
  const copy = humanCopyForCmsAgentError({
    code: 'provider_quota',
    message: 'Node "article_body" received 429 from openai: Your credit balance is too low.',
    operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body.",
    providerStatus: 429,
    providerMessage: 'Your credit balance is too low',
    fromJsonBody: true,
  });
  assert.equal(
    copy.text,
    'provider_quota: Node "article_body" received 429 from openai: Your credit balance is too low. — ' +
      "Top up openai credit for this project's key, then workflow.retry_node article_body."
  );
});

// Task B, cases 3+4/4: the provider line is Owner-only.
test('humanCopyForCmsAgentError: an Owner sees the provider detail line; an editor does not', () => {
  const error = {
    code: 'provider_quota',
    message: 'received 429 from openai',
    operatorAction: "Top up openai credit for this project's key, then workflow.retry_node article_body.",
    providerStatus: 429,
    providerMessage: 'Your credit balance is too low',
    fromJsonBody: true,
  };
  assert.equal(humanCopyForCmsAgentError(error, { isOwner: true }).providerDetail, 'provider 429: Your credit balance is too low');
  assert.equal(humanCopyForCmsAgentError(error, { isOwner: false }).providerDetail, undefined);
  assert.equal(humanCopyForCmsAgentError(error).providerDetail, undefined, 'isOwner defaults to false');
});
