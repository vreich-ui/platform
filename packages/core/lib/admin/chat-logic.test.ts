import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { groupChatEvents, toolLabel, toolLabelForName } from './chat-logic.js';
import type { ChatEventView } from './chat-client.js';

const event = (seq: number, type: ChatEventView['type'], detail: Record<string, unknown> = {}): ChatEventView => ({
  seq,
  type,
  detail,
  at: `2026-08-07T00:00:0${seq}.000Z`,
});

describe('quiet chat activity', () => {
  it('collapses consecutive successful tool calls and results into one timeline item', () => {
    const items = groupChatEvents([
      event(1, 'assistant_text', { text: 'I will check.' }),
      event(2, 'tool_call', { tool: 'object_get' }),
      event(3, 'tool_result', { tool: 'object_get' }),
      event(4, 'tool_call', { tool: 'object_validate' }),
      event(5, 'tool_result', { tool: 'object_validate' }),
      event(6, 'assistant_text', { text: 'Done.' }),
    ]);
    assert.equal(items.length, 3);
    assert.equal(items[1]?.kind, 'activity');
    if (items[1]?.kind === 'activity') assert.equal(items[1].events.length, 4);
  });

  it('keeps failed tools visible instead of hiding them in quiet activity', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'patch' }),
      event(2, 'tool_result', { tool: 'patch', is_error: true }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity', 'event']
    );
  });

  it('uses human labels for known tools', () => {
    assert.equal(toolLabel(event(1, 'tool_call', { tool: 'object_validate' })), 'Check readiness');
  });

  it('has a shared human label for every guardrails tool', () => {
    for (const tool of [
      'get_object',
      'get_contract',
      'list_objects',
      'inventory',
      'validate',
      'search_artifacts',
      'checkout',
      'patch',
      'checkin',
      'refresh_lock',
      'create_object',
      'create_variant',
      'instantiate_template',
      'instantiate_section_template',
      'submit_review',
      'publish',
      'discard',
      'apply_theme',
    ]) {
      assert.doesNotMatch(toolLabelForName(tool), /_/);
    }
  });
});
