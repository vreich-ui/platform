/**
 * Task 3 — registry selection (registry.ts), the mid-deploy safety rule
 * (autonomyForCall's re-clamp), the loop.ts wiring that consumes them, and
 * the stored-key migration (generated-tools.ts's migrateAutonomyKeys).
 * Extends loop.test.ts / learning-mode-protocol.test.ts's own patterns.
 */
import '../../../../../sites/drlurie/config/policy-bindings.js'; // registers site providers — tools.ts resolves site identity at import

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearActivePublishingPolicyProviderForTests,
  setActivePublishingPolicyProvider,
} from '../../../lib/publishing-policy.js';

import {
  loadChatDoc,
  saveChatDoc,
  type AgentChatStore,
  type ChatDoc,
  type ChatRun,
  type RunProfile,
  type ToolAutonomy,
} from './chat-store.js';
import { CMS_AGENT_BOUNDS } from './cms-agent-client.js';
import { fitToolsToCmsAgentBound, providerEngine } from './engine.js';
import { approvePendingTool, runAgentLoop, startRun, type ProtocolDeps } from './loop.js';
import { autonomyForCall } from './registry.js';
import { migrateAutonomyKeys, resolveGeneratedAutonomy } from './generated-tools.js';
import type { ProviderAdapter, WireTool } from './provider.js';
import type { ToolContext } from './tools.js';

const T0 = '2026-08-12T00:00:00.000Z';
const CHAT_ID = 'obj:page_home';

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
  kind: 'object',
  object_type: 'page',
  object_id: 'page_home',
  title: 'Home page',
  created_by: 'editor@example.com',
  created_at: T0,
  updated_at: T0,
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
});

const toolContext = (overrides: Partial<ToolContext> = {}): ToolContext => ({
  roles: [],
  agentAuthoredOps: () => new Set(['set_fields']),
  contract: () => ({}),
  validateNewObject: async () => ({}),
  listArtifacts: async () => ({}),
  verb: async (request) => ({ status: 200, body: { saved: true, request } }),
  ...overrides,
});

const patchArgs = {
  object_type: 'page',
  object_id: 'page_home',
  lock_token: 'lock_1',
  expected_record_version: 1,
  ops: [{ op: 'set_fields', fields: { title: 'Hi' } }],
};

// ─── generated registry: read auto, write asks, approve executes ───────────

describe('generated registry — wiring', () => {
  it('a read tool executes auto; a write tool pauses for approval; approve executes it', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const protocol: ProtocolDeps = { chatStore, toolContext: toolContext(), nowIso: () => T0 };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'Read then patch the page.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      {}, // no frozen autonomy — every call falls through to the class default
      false,
      undefined,
      false,
      'generated'
    );
    assert.ok(started.resume);

    const adapter: ProviderAdapter = async () => ({
      outputTokens: 10,
      toolCalls: [
        { id: 'c1', name: 'object_get', args: { object_type: 'page', object_id: 'page_home' } },
        { id: 'c2', name: 'object_patch', args: patchArgs },
      ],
    });
    const paused = await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    assert.equal(paused.status, 'awaiting_approval');

    const afterFirstHop = await loadChatDoc(chatStore, CHAT_ID);
    const readResult = afterFirstHop!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'object_get');
    assert.ok(readResult, 'object_get should have executed automatically (read defaults to auto)');
    assert.equal(readResult!.detail?.is_error, false);
    assert.equal(afterFirstHop!.run?.pending?.tool, 'object_patch');

    const approved = await approvePendingTool(protocol, CHAT_ID, 'c2', { id: 'editor_1', email: 'editor@example.com' });
    assert.equal(approved.status, 200);
    // Task 5: approve defers EXECUTION to the next hop — it never runs the
    // tool inline any more (long operational tools could otherwise blow the
    // interactive function's invocation cap).
    assert.deepEqual(approved.body, { approved: true, executing: true });
    await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      approved.resume!.triggerToken
    );
    const afterApprove = await loadChatDoc(chatStore, CHAT_ID);
    const patchResult = afterApprove!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'object_patch');
    assert.ok(patchResult, 'object_patch should have executed on the resumed hop');
    assert.equal(patchResult!.detail?.is_error, false);
  });

  it('the default wire list excludes off-defaulted tools and stays within the present_candidates budget', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const protocol: ProtocolDeps = { chatStore, toolContext: toolContext(), nowIso: () => T0 };
    const autonomy = resolveGeneratedAutonomy(undefined, undefined);
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'hi',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      autonomy,
      true, // learning mode on — present_candidates should join the list
      undefined,
      false,
      'generated'
    );
    let receivedTools: WireTool[] = [];
    const adapter: ProviderAdapter = async ({ tools }) => {
      receivedTools = tools;
      return { outputTokens: 0, toolCalls: [] };
    };
    await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    const names = receivedTools.map((tool) => tool.name);
    // D2a (2026-08-17) added three workspace verbs; W19 T19.8 added four
    // editorial-request tools and raised the contract bound to 96, because the
    // registry had reached the old 64 with zero headroom. The wire is bounded
    // by the engine's family trim, which is what actually applies at send time.
    const bounded = fitToolsToCmsAgentBound(receivedTools).map((tool) => tool.name);
    assert.ok(
      bounded.length <= CMS_AGENT_BOUNDS.maxTools,
      `expected the wire to fit the CMS-Agent bound, got ${bounded.length}`
    );
    assert.ok(names.includes('present_candidates'));
    assert.ok(names.includes('object_get'));
    assert.ok(!names.includes('set_image_search_policy'), 'off-defaulted tools must not be wired by default');
  });
});

// ─── legacy registry: unchanged wire list ───────────────────────────────────────

describe('legacy registry — wiring', () => {
  it('chat_registry legacy wires the 30 legacy tools (+ present_candidates in learning mode)', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const protocol: ProtocolDeps = { chatStore, toolContext: toolContext(), nowIso: () => T0 };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'hi',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      {},
      true,
      undefined,
      false,
      'legacy'
    );
    let receivedTools: WireTool[] = [];
    const adapter: ProviderAdapter = async ({ tools }) => {
      receivedTools = tools;
      return { outputTokens: 0, toolCalls: [] };
    };
    await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    const names = receivedTools.map((tool) => tool.name);
    // W19 T19.8 added the four editorial-request tools to CHAT_TOOLS, so the
    // legacy registry carries them too — they ride the request store, not the
    // object verbs, and are registry-agnostic. P3 added apply_brand_imagery
    // alongside apply_theme.
    assert.equal(names.filter((name) => name !== 'present_candidates').length, 30);
    assert.ok(names.includes('present_candidates'));
    assert.ok(names.includes('patch'));
    assert.ok(!names.includes('object_patch'), 'the legacy registry must never wire a canonical generated name');
  });
});

// ─── in-flight legacy compatibility (no `registry` stamp) ───────────────────

describe('in-flight legacy compatibility', () => {
  it('a run with no `registry` stamp is treated as legacy: old-named calls still execute; apply_theme stays owner-gated', async () => {
    const chatStore = memoryStore();
    const run: ChatRun = {
      run_id: 'run_legacy_1',
      started_at: T0,
      principal: { kind: 'human', id: 'editor_1', email: 'editor@example.com' },
      profile,
      // Frozen BEFORE this deploy, keyed by the OLD chat-tool names — no
      // `registry` field at all.
      autonomy: { patch: 'auto', apply_theme: 'auto' },
      learning_mode: false,
      diagnostics_requested: false,
      engine: 'provider',
      trigger_token: 'trig_1',
      transcript: [{ role: 'user', text: 'Update the page.' }],
      call_queue: [],
      provider_turns: 0,
      tool_calls_used: 0,
      output_tokens_used: 0,
    };
    await saveChatDoc(chatStore, { ...idleDoc(), status: 'queued', run });
    assert.equal(run.registry, undefined);

    const adapter: ProviderAdapter = async () => ({
      outputTokens: 5,
      toolCalls: [
        { id: 'c1', name: 'patch', args: patchArgs },
        {
          id: 'c2',
          name: 'apply_theme',
          args: { theme_id: 'thm_x', site_id: 'site_x', lock_token: 'lock_1', expected_record_version: 1 },
        },
      ],
    });
    // roles: [] — no owner, so apply_theme's execution-time role wall fires
    // even though autonomy resolved 'auto'.
    await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: () => T0 },
      CHAT_ID,
      'trig_1'
    );

    const doc = await loadChatDoc(chatStore, CHAT_ID);
    const patchResult = doc!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'patch');
    assert.ok(patchResult, 'the old-named "patch" call must still resolve and execute under the legacy registry');
    assert.equal(patchResult!.detail?.is_error, false);

    const themeResult = doc!.events.find((e) => e.type === 'tool_result' && e.detail?.tool === 'apply_theme');
    assert.ok(themeResult);
    assert.equal(themeResult!.detail?.is_error, true, 'apply_theme must stay owner-gated regardless of autonomy');
    const themeTranscript = doc!.run!.transcript.find(
      (message) => message.role === 'tool' && message.tool_call_id === 'c2'
    );
    assert.match((themeTranscript as { content: string }).content, /Owner role/);
  });
});

// ─── mid-deploy safety: autonomyForCall's re-clamp ──────────────────────────

describe('mid-deploy safety — autonomyForCall', () => {
  it('a call missing from the frozen autonomy map resolves by class, never bypassing a floor', () => {
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: {} };
    // object_retire has no entry at all in the frozen map.
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'ask');
  });

  it('a floored tool with a stale "auto" in the frozen map re-clamps to "ask"', () => {
    const staleRun: Pick<ChatRun, 'autonomy'> = { autonomy: { object_retire: 'auto' as ToolAutonomy } };
    assert.equal(autonomyForCall('generated', staleRun, 'object_retire'), 'ask');
  });

  it('never resolves "auto" for a floored tool, no matter what the frozen map says', () => {
    for (const stored of ['auto', 'ask', undefined] as (ToolAutonomy | undefined)[]) {
      const run: Pick<ChatRun, 'autonomy'> = { autonomy: stored ? { object_retire: stored } : {} };
      assert.notEqual(autonomyForCall('generated', run, 'object_retire'), 'auto');
    }
  });
});

// ─── error split: unknown tool vs off-policy tool ───────────────────────────────

describe('error split', () => {
  it('an unknown tool name and an off-policy tool produce two distinct messages', async () => {
    const chatStore = memoryStore();
    await saveChatDoc(chatStore, idleDoc());
    const protocol: ProtocolDeps = { chatStore, toolContext: toolContext(), nowIso: () => T0 };
    const started = await startRun(
      protocol,
      (await loadChatDoc(chatStore, CHAT_ID))!,
      'Try two bad calls.',
      { id: 'editor_1', email: 'editor@example.com' },
      profile,
      { object_get: 'off' },
      false,
      undefined,
      false,
      'generated'
    );
    let turn = 0;
    const adapter: ProviderAdapter = async () => {
      turn += 1;
      if (turn > 1) return { outputTokens: 0, toolCalls: [] };
      return {
        outputTokens: 1,
        toolCalls: [
          { id: 'c1', name: 'not_a_real_tool', args: {} },
          { id: 'c2', name: 'object_get', args: { object_type: 'page', object_id: 'page_home' } },
        ],
      };
    };
    await runAgentLoop(
      { chatStore, toolContext: toolContext(), engine: providerEngine(adapter), nowIso: protocol.nowIso },
      CHAT_ID,
      started.resume!.triggerToken
    );
    const doc = await loadChatDoc(chatStore, CHAT_ID);
    const unknownMsg = doc!.run!.transcript.find((message) => message.role === 'tool' && message.tool_call_id === 'c1');
    const offMsg = doc!.run!.transcript.find((message) => message.role === 'tool' && message.tool_call_id === 'c2');
    assert.match((unknownMsg as { content: string }).content, /is not a capability of this workspace/);
    assert.match((offMsg as { content: string }).content, /is disabled by policy for this chat/);
  });
});

// ─── migrateAutonomyKeys ────────────────────────────────────────────────────────────

describe('migrateAutonomyKeys', () => {
  it('canonicalizes a legacy key', () => {
    const { map, changed } = migrateAutonomyKeys({ patch: 'off' });
    assert.equal(changed, true);
    assert.deepEqual(map, { object_patch: 'off' });
  });

  it('canonicalizes search_artifacts to its LEGACY meaning (list_artifacts_for_request), never the distinct MCP tool of the same name', () => {
    const { map, changed } = migrateAutonomyKeys({ search_artifacts: 'ask' });
    assert.equal(changed, true);
    assert.deepEqual(map, { list_artifacts_for_request: 'ask' });
  });

  it('an existing canonical key wins over a legacy-aliased key on collision, regardless of key order', () => {
    const legacyFirst = migrateAutonomyKeys({ patch: 'ask', object_patch: 'auto' });
    assert.equal(legacyFirst.changed, true);
    assert.deepEqual(legacyFirst.map, { object_patch: 'auto' });

    const canonicalFirst = migrateAutonomyKeys({ object_patch: 'auto', patch: 'ask' });
    assert.equal(canonicalFirst.changed, true);
    assert.deepEqual(canonicalFirst.map, { object_patch: 'auto' });
  });

  it('is a no-op on an already-canonical map', () => {
    const { map, changed } = migrateAutonomyKeys({ object_get: 'auto', release_to_production: 'ask' });
    assert.equal(changed, false);
    assert.deepEqual(map, { object_get: 'auto', release_to_production: 'ask' });
  });

  it('passes undefined through untouched (the stamp short-circuit at the call site never even reaches here)', () => {
    const { map, changed } = migrateAutonomyKeys(undefined);
    assert.equal(map, undefined);
    assert.equal(changed, false);
  });

  it('documents why the chat_tools_migrated / keys_migrated stamp must short-circuit this call: unconditionally re-running it would misread a deliberately-set canonical search_artifacts key as its legacy meaning', () => {
    // A post-migration owner sets the CANONICAL tool's own key...
    const postMigration = { search_artifacts: 'ask' as ToolAutonomy };
    // ...but calling migrateAutonomyKeys on it AGAIN (as would happen without
    // the stamp guarding the read call site) reinterprets it as the legacy
    // chat tool's meaning instead of leaving it alone.
    const reMigrated = migrateAutonomyKeys(postMigration);
    assert.notDeepEqual(reMigrated.map, postMigration);
    assert.deepEqual(reMigrated.map, { list_artifacts_for_request: 'ask' });
    // This is exactly why admin-agent-chat.ts / admin-governance.ts gate the
    // call behind `chat_tools_migrated` / `keys_migrated`: once stamped, the
    // stored map is used as-is, never re-migrated.
  });
});

// ─── T15.8: the ask floor consults publishingPolicy.autonomyMode ───────────

describe('T15.8 — one approval truth: autonomyForCall consults publishingPolicy.autonomyMode', () => {
  afterEach(() => {
    clearActivePublishingPolicyProviderForTests();
  });

  it('an autonomous project satisfies the floor with no human: no explicit override needed', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: {} };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'auto');
    assert.equal(autonomyForCall('generated', run, 'object_publish'), 'auto');
    assert.equal(autonomyForCall('generated', run, 'object_create'), 'auto');
  });

  it('an unconfigured project (no provider registered) still asks, even for the same floored tool', () => {
    // No setActivePublishingPolicyProvider call — this is every fleet site's
    // default state today.
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: {} };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'ask');
  });

  it('a project explicitly configured operator-gated still asks', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'operator-gated' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: {} };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'ask');
  });

  it('a withheld decision (explicit "off") halts an otherwise-autonomous project', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: { object_retire: 'off' as ToolAutonomy } };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'off');
  });

  it('an explicit "ask" override is respected even under an autonomous project (never silently promoted)', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: { object_retire: 'ask' as ToolAutonomy } };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'ask');
  });

  it('a stale governance "auto" is honored once the project is genuinely autonomous (it was only ever re-clamped for lack of policy evidence)', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: { object_retire: 'auto' as ToolAutonomy } };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'auto');
  });

  it('a bare governance "auto" override still cannot bypass the floor on an unconfigured/operator-gated project', () => {
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: { object_retire: 'auto' as ToolAutonomy } };
    assert.equal(autonomyForCall('generated', run, 'object_retire'), 'ask');
  });

  it('a non-floored (read) tool is unaffected by publishingPolicy.autonomyMode either way', () => {
    setActivePublishingPolicyProvider(() => ({ autonomyMode: 'autonomous' }));
    const run: Pick<ChatRun, 'autonomy'> = { autonomy: {} };
    assert.equal(autonomyForCall('generated', run, 'object_get'), 'auto');
  });
});

it('autonomyForCall: a legacy-alias call cannot bypass autonomy set on the canonical name', () => {
  // Owner disabled object_get on a generated run; the model calls the legacy
  // alias it learned from its transcript. The alias must resolve to the same
  // 'off', never to the read-class 'auto' default.
  const run = { autonomy: { object_get: 'off' as const } };
  assert.equal(autonomyForCall('generated', run, 'get_object'), 'off');
  assert.equal(autonomyForCall('generated', run, 'object_get'), 'off');
  // Same for an 'ask' tightening on a write.
  const run2 = { autonomy: { object_patch: 'off' as const } };
  assert.equal(autonomyForCall('generated', run2, 'patch'), 'off');
});
