import '../../../../../sites/drlurie/config/policy-bindings.js';

import { describe, it } from 'node:test';
import assert from 'node:assert';

import { loadChatDoc, saveChatDoc, type AgentChatStore, type ChatDoc, type RunProfile } from './chat-store.js';
import { providerEngine } from './engine.js';
import { approvePendingTool, choosePendingCandidate, runAgentLoop, startRun, type ProtocolDeps } from './loop.js';
import { exportPreferencePairs, type LearningEvidenceStore } from './preferences.js';
import type { ProviderAdapter, WireTool } from './provider.js';
import type { ToolContext } from './tools.js';

const memoryStore = (): AgentChatStore & LearningEvidenceStore => {
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
  profile_id: 'profile_editorial',
  name: 'Editorial agent',
  provider: 'openai',
  model: 'test-model',
  system_prompt: 'Help the editor improve public copy.',
};

const idleChat = (): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: 'obj:site_test',
  kind: 'object',
  object_type: 'site',
  object_id: 'site_test',
  title: 'Test publication',
  created_by: 'editor@example.com',
  created_at: '2026-08-07T12:00:00.000Z',
  updated_at: '2026-08-07T12:00:00.000Z',
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
});

const toolContext = (): ToolContext => ({
  roles: [],
  agentAuthoredOps: () => new Set(['set_site_fields']),
  contract: () => ({}),
  validateNewObject: async () => ({}),
  listArtifacts: async () => ({}),
  verb: async (request) => ({ status: 200, body: { saved: true, request } }),
});

const patchArgs = (name: string) => ({
  object_type: 'site',
  object_id: 'site_test',
  lock_token: 'lock_test',
  expected_record_version: 1,
  ops: [{ op: 'set_site_fields', fields: { name } }],
});

describe('governed learning-mode protocol', () => {
  it('pauses on 2–3 candidates, then routes the chosen version through approval and captures edits', async () => {
    const chatStore = memoryStore();
    const learningStore = memoryStore();
    await saveChatDoc(chatStore, idleChat());
    const protocol: ProtocolDeps = {
      chatStore,
      learningStore,
      siteId: 'site_test',
      toolContext: toolContext(),
      nowIso: () => '2026-08-07T12:01:00.000Z',
    };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, 'obj:site_test'))!,
      'Draft a warmer publication name.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      { patch: 'ask' },
      true,
      'Publication name'
    );
    assert.ok(started.resume);

    let receivedTools: WireTool[] = [];
    const adapter: ProviderAdapter = async ({ tools }) => {
      receivedTools = tools;
      return {
        outputTokens: 100,
        toolCalls: [
          {
            id: 'candidate_call',
            name: 'present_candidates',
            args: {
              candidates: ['Quiet confidence', 'Clinical clarity', 'Warm expertise'].map((content) => ({
                content,
                self_description: `${content} direction`,
                tool_name: 'patch',
                tool_args: patchArgs(content),
              })),
            },
          },
        ],
      };
    };
    const paused = await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      'obj:site_test',
      started.resume!.triggerToken
    );
    assert.strictEqual(paused.status, 'awaiting_candidate');
    assert.ok(receivedTools.some((tool) => tool.name === 'present_candidates'));
    const pendingChoice = await loadChatDoc(chatStore, 'obj:site_test');
    assert.strictEqual(pendingChoice?.run?.candidate_selection?.candidates.length, 3);

    const chosen = await choosePendingCandidate(protocol, 'obj:site_test', 'candidate_call', 'b', {
      id: 'editor_1',
      email: 'editor@example.com',
    });
    assert.ok(chosen.resume);
    const awaitingApproval = await runAgentLoop(
      {
        chatStore,
        toolContext: toolContext(),
        engine: providerEngine(async () => ({ outputTokens: 0, toolCalls: [] })),
        nowIso: protocol.nowIso,
      },
      'obj:site_test',
      chosen.resume!.triggerToken
    );
    assert.strictEqual(awaitingApproval.status, 'awaiting_approval');
    const pendingWrite = await loadChatDoc(chatStore, 'obj:site_test');
    const queuedOps = pendingWrite?.run?.pending?.args.ops as Array<{ fields: { name: string } }>;
    assert.strictEqual(queuedOps[0]?.fields.name, 'Clinical clarity');

    const approved = await approvePendingTool(
      protocol,
      'obj:site_test',
      'candidate_call_b',
      { id: 'editor_1', email: 'editor@example.com' },
      patchArgs('Clinical clarity, edited')
    );
    assert.strictEqual(approved.status, 200);
    const exported = await exportPreferencePairs(learningStore);
    assert.strictEqual(exported.count, 2);
    assert.match(exported.jsonl, /Clinical clarity, edited/);
  });

  it('does not expose the candidate tool while learning mode is off', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleChat());
    const started = await startRun(
      { chatStore, toolContext: toolContext() },
      (await loadChatDoc(chatStore, 'obj:site_test'))!,
      'Read this object.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      { get_object: 'auto' },
      false
    );
    let names: string[] = [];
    await runAgentLoop(
      {
        chatStore,
        toolContext: toolContext(),
        engine: providerEngine(async ({ tools }) => {
          names = tools.map((tool) => tool.name);
          return { outputTokens: 1, toolCalls: [] };
        }),
      },
      'obj:site_test',
      started.resume!.triggerToken
    );
    assert.ok(!names.includes('present_candidates'));
  });
});
