import '../../../../../sites/drlurie/config/policy-bindings.js';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildAgentSystemPrompt } from './loop.js';
import type { ChatDoc, ChatRun, RunProfile } from './chat-store.js';

const profile: RunProfile = {
  profile_id: 'prof_test',
  name: 'Test agent',
  provider: 'anthropic',
  model: 'test-model',
  system_prompt: 'Base prompt.',
};

const baseRun = (overrides: Partial<ChatRun> = {}): ChatRun => ({
  run_id: 'run_1',
  started_at: '2026-08-12T00:00:00.000Z',
  principal: { kind: 'human', id: 'u1', email: 'editor@example.com' },
  profile,
  autonomy: {},
  learning_mode: false,
  diagnostics_requested: false,
  engine: 'provider',
  transcript: [],
  call_queue: [],
  provider_turns: 0,
  tool_calls_used: 0,
  output_tokens_used: 0,
  ...overrides,
});

const baseDoc = (overrides: Partial<ChatDoc> = {}): ChatDoc => ({
  schema_version: 'agent-chat.v1',
  chat_id: 'free:1',
  kind: 'free',
  title: 'Chat',
  created_by: 'u1',
  created_at: '2026-08-12T00:00:00.000Z',
  updated_at: '2026-08-12T00:00:00.000Z',
  status: 'idle',
  seq: 0,
  events: [],
  runs: [],
  ...overrides,
});

describe('buildAgentSystemPrompt — chat-interactive-controls protocol instruction', () => {
  it('teaches the agent to prefer a controls block for enumerable decisions', () => {
    const prompt = buildAgentSystemPrompt(baseDoc(), baseRun());
    assert.match(prompt, /```controls```/);
    assert.match(prompt, /radio.*checkbox.*toggle/s);
    assert.match(prompt, /at most one controls block per message/i);
  });

  it('teaches the agent to treat a Selections receipt as settled, not re-ask', () => {
    const prompt = buildAgentSystemPrompt(baseDoc(), baseRun());
    assert.match(prompt, /Selections \[controls:<id>\]/);
    assert.match(prompt, /without re-asking/i);
  });

  it('still carries the base profile prompt and object-binding instruction', () => {
    const prompt = buildAgentSystemPrompt(
      baseDoc({ kind: 'object', object_type: 'page', object_id: 'page_home' }),
      baseRun()
    );
    assert.match(prompt, /Base prompt\./);
    assert.match(prompt, /bound to the page object "page_home"/);
  });
});
