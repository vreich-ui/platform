/**
 * T8 (2026-08-25) — chat approval routing + the approve button.
 *
 * DEFECT this proves closed: an editor expressed approval/publish intent
 * about a workspace run in chat ("publish it", "approved, ship it") and the
 * agent replied as though the approval were already registered — no
 * `publish_workspace_run` call, so no approval card ever rendered
 * (`publish_workspace_run`'s `autonomyFloor: 'ask'`, tools.ts, is what turns
 * a proposed call into the card the editor clicks) and nothing actually
 * happened. Separately, a `no_go` readiness got paraphrased in the reply
 * instead of relayed, leaving the editor unable to act on the real blocker.
 *
 * These are scripted-conversation tests in the `registry-wiring.test.ts`
 * pattern: the "model" is a scripted `ProviderAdapter` standing in for what
 * Client Manager should do given engine.ts's `APPROVAL_NOTE` rule (Client
 * Manager owns its own prompt — see engine.ts's header comment — so its
 * actual reasoning is out of reach here; what IS provable end-to-end is the
 * WIRING: proposing `publish_workspace_run` really does pause the run at
 * `awaiting_approval` with a pending call the UI renders as a button, and a
 * `no_go` readiness's checklist/blockers really do reach the transcript
 * byte-for-byte, not summarized by any code in between).
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadChatDoc, saveChatDoc, type AgentChatStore, type ChatDoc, type RunProfile } from './chat-store.js';
import { providerEngine } from './engine.js';
import { runAgentLoop, startRun, type ProtocolDeps } from './loop.js';
import { resolveGeneratedAutonomy } from './generated-tools.js';
import type { ProviderAdapter } from './provider.js';
import type { ToolContext } from './tools.js';

const T0 = '2026-08-25T00:00:00.000Z';
const CHAT_ID = 'free:approval-routing';

const memoryStore = (): AgentChatStore => {
  const blobs = new Map<string, string>();
  return {
    async get(key) {
      return blobs.get(key) ?? null;
    },
    async setJSON(key, value) {
      blobs.set(key, JSON.stringify(value));
    },
    async list({ prefix }) {
      return { blobs: [...blobs.keys()].filter((key) => key.startsWith(prefix)).map((key) => ({ key })) };
    },
  };
};

const profile: RunProfile = {
  profile_id: 'prof_test',
  name: 'Test agent',
  provider: 'anthropic',
  model: 'test-model',
  system_prompt: 'Base prompt.',
};

const idleDoc = (): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: CHAT_ID,
  kind: 'free',
  title: 'Publish approval',
  created_by: 'editor@example.com',
  created_at: T0,
  updated_at: T0,
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
});

const REQ = 'req_agent_retinol_basics_20260825_01';

const NO_GO = {
  status: 'no_go',
  checklist: [
    { id: 'approval', ok: true },
    { id: 'taxonomy', ok: false, detail: 'tag "retinol" unknown — resolve it in the taxonomy registry first' },
  ],
  blockers: ['taxonomy_unresolved: tag "retinol" unknown — resolve it in the taxonomy registry first'],
};
const GO = { status: 'go', checklist: [{ id: 'approval', ok: true }], blockers: [] };

const toolContext = (respond: (name: string) => unknown, overrides: Partial<ToolContext> = {}): ToolContext =>
  ({
    roles: ['owner'],
    principal: { id: 'editor_1', email: 'editor@example.com' },
    agentAuthoredOps: () => new Set<string>(),
    contract: () => ({}),
    validateNewObject: async () => ({}),
    listArtifacts: async () => ({}),
    verb: async () => ({ status: 404, body: { not_found: true } }),
    cmsAgent: {
      projectId: 'platform',
      async callTool(name: string) {
        return { ok: true, data: respond(name) };
      },
    },
    ...overrides,
  }) as unknown as ToolContext;

describe('T8 — approval/publish intent proposes publish_workspace_run (the approval card)', () => {
  it('"Publish it, I approve" driving a proposed publish_workspace_run call pauses the run at awaiting_approval with the readiness result on the card', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const ctx = toolContext(() => GO);
    const protocol: ProtocolDeps = { chatStore, toolContext: ctx, nowIso: () => T0 };
    const autonomy = resolveGeneratedAutonomy(undefined, undefined);
    assert.equal(autonomy.publish_workspace_run, 'ask', 'the D2 floor must still hold');

    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'Publish it — I approve, ship it live.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      autonomy,
      false,
      undefined,
      false,
      'generated'
    );
    assert.ok(started.resume);

    // Standing in for what Client Manager should do given the editor's
    // approval intent, per APPROVAL_NOTE: PROPOSE the privileged call rather
    // than claim it happened.
    const adapter: ProviderAdapter = async () => ({
      outputTokens: 5,
      toolCalls: [{ id: 'c1', name: 'publish_workspace_run', args: { run_id: 'run_abc123', request_id: REQ } }],
    });
    const paused = await runAgentLoop(
      { chatStore, toolContext: ctx, engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    assert.equal(paused.status, 'awaiting_approval');

    const doc = await loadChatDoc(chatStore, CHAT_ID);
    // This IS the approval card: a pending call the UI renders as a button —
    // nothing "registers" until the human actually clicks it.
    assert.equal(doc!.run?.pending?.tool, 'publish_workspace_run');
    assert.deepEqual(doc!.run?.pending?.args, { run_id: 'run_abc123', request_id: REQ });
    const card = doc!.run?.pending?.dry_run as { readiness?: { status?: string } } | undefined;
    assert.equal(card?.readiness?.status, 'go');

    const approvalEvent = doc!.events.find((event) => event.type === 'tool_approval_required');
    assert.ok(approvalEvent, 'a tool_approval_required event is what the UI renders as the approve button');
    assert.equal(approvalEvent!.detail?.tool, 'publish_workspace_run');
  });
});

describe('T8 — a no_go readiness carries its blockers into the transcript verbatim', () => {
  it('check_workspace_run_readiness (auto, read-class) executes inline and its tool_result content is the exact checklist/blockers, unsummarized', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const ctx = toolContext(() => NO_GO);
    const protocol: ProtocolDeps = { chatStore, toolContext: ctx, nowIso: () => T0 };
    const autonomy = resolveGeneratedAutonomy(undefined, undefined);
    assert.equal(autonomy.check_workspace_run_readiness, 'auto');

    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'Is it ready to publish?',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      autonomy,
      false,
      undefined,
      false,
      'generated'
    );
    const adapter: ProviderAdapter = async () => ({
      outputTokens: 5,
      toolCalls: [{ id: 'c1', name: 'check_workspace_run_readiness', args: { run_id: 'run_abc123', request_id: REQ } }],
    });
    const result = await runAgentLoop(
      { chatStore, toolContext: ctx, engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    assert.equal(result.ok, true);

    const doc = await loadChatDoc(chatStore, CHAT_ID);
    const toolMsg = doc!.run!.transcript.find((msg) => msg.role === 'tool');
    assert.ok(toolMsg, 'the readiness result must reach the transcript the model reasons over');
    const body = JSON.parse((toolMsg as { content: string }).content) as typeof NO_GO;
    // Byte-for-byte, not "a few things need fixing": the exact blocker text
    // an editor could act on.
    assert.deepEqual(body.checklist, NO_GO.checklist);
    assert.deepEqual(body.blockers, NO_GO.blockers);
    assert.match(body.blockers[0]!, /tag "retinol" unknown/);

    // discloseResult (tools.ts) puts the same verbatim payload on the UI
    // event too, so the editor sees it even before any assistant prose.
    const resultEvent = doc!.events.find((event) => event.type === 'tool_result');
    assert.equal(resultEvent!.detail?.tool, 'check_workspace_run_readiness');
    const disclosed = JSON.parse(resultEvent!.detail!.output as string) as typeof NO_GO;
    assert.deepEqual(disclosed.blockers, NO_GO.blockers);
  });
});
