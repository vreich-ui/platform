import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createdObjectsFromEvents, groupChatEvents, toolLabel, toolLabelForName } from './chat-logic.js';
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

  it('B8: keeps a held gate quiet even though is_error is true — classified severity decides prominence, not raw is_error', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'publish' }),
      event(2, 'tool_result', {
        tool: 'publish',
        is_error: true,
        output: JSON.stringify({ code: 'no_go' }),
      }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity']
    );
    if (items[0]?.kind === 'activity') assert.equal(items[0].events.length, 2);
  });

  it('B8: a human declining a proposed write also stays quiet (the same category error, one layer up)', () => {
    const items = groupChatEvents([
      event(1, 'tool_call', { tool: 'publish' }),
      event(2, 'tool_result', {
        tool: 'publish',
        is_error: true,
        output: JSON.stringify({ error: 'requires explicit approval' }),
      }),
    ]);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['activity']
    );
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

describe('createdObjectsFromEvents', () => {
  it('collects creation results, skipping errors and events without an object_id', () => {
    const created = createdObjectsFromEvents([
      event(1, 'tool_result', { tool: 'create_object', object_id: 'obj_1', object_type: 'page' }),
      event(2, 'tool_result', { tool: 'create_object', is_error: true, object_id: 'obj_2' }),
      event(3, 'tool_result', { tool: 'patch' }),
      event(4, 'tool_result', { tool: 'instantiate_template', object_id: 'obj_3' }),
    ]);
    assert.deepEqual(created, [{ id: 'obj_1', type: 'page' }, { id: 'obj_3' }]);
  });

  it('scopes to one run when runId is given', () => {
    const events = [
      event(1, 'tool_result', { run_id: 'run_1', tool: 'create_object', object_id: 'obj_1' }),
      event(2, 'tool_result', { run_id: 'run_2', tool: 'create_object', object_id: 'obj_2' }),
    ];
    assert.deepEqual(createdObjectsFromEvents(events, 'run_1'), [{ id: 'obj_1' }]);
    assert.deepEqual(createdObjectsFromEvents(events), [{ id: 'obj_1' }, { id: 'obj_2' }]);
  });
});
