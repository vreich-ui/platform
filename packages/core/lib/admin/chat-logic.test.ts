import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createdObjectsFromEvents, groupChatEvents, requestProgressCopy, toolLabel, toolLabelForName } from './chat-logic.js';
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

  it('A4: folds 5 consecutive request_progress events into the latest one', () => {
    const items = groupChatEvents([
      event(1, 'request_progress', { status: 'running', done: 1, total: 5 }),
      event(2, 'request_progress', { status: 'running', done: 2, total: 5 }),
      event(3, 'request_progress', { status: 'running', done: 3, total: 5 }),
      event(4, 'request_progress', { status: 'running', done: 4, total: 5 }),
      event(5, 'request_progress', { status: 'failed', done: 5, total: 5 }),
    ]);
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, 'event');
    if (items[0]?.kind === 'event') assert.equal(items[0].event.seq, 5, 'keeps the LATEST event, not the first');
  });

  it('A4: does not fold request_progress events separated by other activity', () => {
    const items = groupChatEvents([
      event(1, 'request_progress', { status: 'running' }),
      event(2, 'tool_call', { tool: 'patch' }),
      event(3, 'request_progress', { status: 'running' }),
    ]);
    assert.equal(items.length, 3);
    assert.deepEqual(
      items.map((item) => item.kind),
      ['event', 'activity', 'event']
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

// ─── request_progress (W19 bug fix) ────────────────────────────────────────

/**
 * Before `requestProgressCopy` existed, `chat.tsx` had no case for
 * `request_progress` and fell through to `<ToolCallCard>`, which reads
 * `event.detail.tool`/`is_error` — fields this event never carries — so it
 * always rendered `severity: 'ok'` regardless of what the sweeper had just
 * written. This is the exact `progressDetail()` shape (`sweep.ts`) for a run
 * that failed at `artifact_plan` with CMS-Agent's `budget_exceeded` guard —
 * a real production run read live on 2026-08-31 (`run_1788165644777_zuu2o1`).
 */
const REAL_BUDGET_EXCEEDED_DETAIL = {
  request_id: 'req_concern_skin_diary_20240608_01',
  status: 'failed',
  summary: 'The artifact plan step failed, so the job has stopped.',
  done: 17,
  total: 24,
  node: 'artifact_plan',
  blockers: [
    {
      node_id: 'artifact_plan',
      code: 'budget_exceeded',
      message:
        'Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after.',
      operator_action: 'Run budget 3 USD reached (spent 2.70755). Raise the budget or stop.',
    },
  ],
};

describe('requestProgressCopy', () => {
  it('reads a failed transition as blocked severity, never the ToolCallCard default ok', () => {
    const copy = requestProgressCopy(REAL_BUDGET_EXCEEDED_DETAIL, false);
    assert.equal(copy.status, 'failed');
    assert.equal(copy.level, 'blocked');
    assert.equal(copy.label, 'Failed');
    assert.equal(copy.progress, '17/24');
  });

  it('renders the structured blocker as code: message — operatorAction, same as run_error/RequestActivity', () => {
    const copy = requestProgressCopy(REAL_BUDGET_EXCEEDED_DETAIL, false);
    assert.ok(copy.failure);
    assert.equal(
      copy.failure?.text,
      'budget_exceeded: Node "artifact_plan" stopped before the model turn that would cross the node budget: estimated spend $2.70755 plus ~$0.32781 for the upcoming turn exceeds the $3 ceiling. Caught inside the agent loop before the turn ran, not after. — Run budget 3 USD reached (spent 2.70755). Raise the budget or stop.'
    );
    // `summary` is still carried (the sweeper's plain sentence), but the
    // renderer prefers `failure` over it so the structured text is never
    // duplicated underneath itself — see `RequestProgressLine` in chat.tsx.
    assert.equal(copy.summary, 'The artifact plan step failed, so the job has stopped.');
  });

  it('a non-failed transition (e.g. running/needs_you) shows the plain summary, never a failure line', () => {
    const copy = requestProgressCopy(
      { status: 'needs_you', summary: 'The draft is ready and waiting for your publish decision.', done: 20, total: 24 },
      false
    );
    assert.equal(copy.level, 'needs_you');
    assert.equal(copy.failure, undefined);
    assert.equal(copy.summary, 'The draft is ready and waiting for your publish decision.');
  });

  it('a failed transition with no structured blocker (older shape) falls back to the plain summary', () => {
    const copy = requestProgressCopy(
      { status: 'failed', summary: 'The job failed before it could finish.', blockers: [{ code: 'model_error', message: '' }] },
      false
    );
    assert.equal(copy.level, 'blocked');
    // Empty message never parses as structured detail — no half-built failure copy.
    assert.equal(copy.failure, undefined);
    assert.equal(copy.summary, 'The job failed before it could finish.');
  });

  it('defaults an unreadable/missing status to running, never a fabricated failed', () => {
    const copy = requestProgressCopy(undefined, false);
    assert.equal(copy.status, 'running');
    assert.equal(copy.level, 'info');
    assert.equal(copy.failure, undefined);
  });
});
