/**
 * W19 T19.8c — the chat narrowing of the activity projection.
 *
 * The defect this closes: asked "where is it up to?", the client manager could
 * only say "still running, no errors reported". Every fact needed for a real
 * answer was already computed for the Requests page; the chat had no tool for
 * it. These tests pin what a tool result must carry for that answer to be
 * possible — and what it must NOT carry, because it is persisted in the event
 * log and re-sent on every later turn.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { CHAT_ACTIVITY_NODE_MAX, projectActivityForChat } from './activity-for-chat.js';

const NOW = Date.parse('2026-08-22T12:00:00.000Z');

const run = (overrides: Record<string, unknown> = {}) => ({
  runId: 'run_123',
  status: 'running',
  nodes: [
    {
      nodeId: 'topic_researcher',
      status: 'completed',
      startedAt: '2026-08-22T11:50:00.000Z',
      completedAt: '2026-08-22T11:52:00.000Z',
      durationMs: 120_000,
      produces: ['research_brief'],
      toolCalls: [{ toolId: 'search_images', status: 'completed', durationMs: 900 }],
    },
    {
      nodeId: 'article_body',
      status: 'running',
      startedAt: '2026-08-22T11:58:00.000Z',
      toolCalls: [
        { toolId: 'publish_workspace_run', status: 'failed', errorCode: 'approval_required', durationMs: 40 },
      ],
    },
    { nodeId: 'publication_controller', status: 'pending' },
  ],
  ...overrides,
});

const cost = {
  ledger: {
    stages: [
      { nodeId: 'topic_researcher', totalTokens: 4_000, costUsdEstimate: 0.04 },
      { nodeId: 'article_body', totalTokens: 9_000, costUsdEstimate: 0.11 },
    ],
    totalTokens: 13_000,
    totalInputTokens: 8_000,
    totalOutputTokens: 5_000,
    totalCostUsdEstimate: 0.15,
  },
  plan: {
    nodeTimingAggregates: {
      article_body: { p50DurationMs: 180_000, p95DurationMs: 300_000, count: 12 },
      publication_controller: { p50DurationMs: 20_000, p95DurationMs: 45_000, count: 12 },
    },
  },
};

describe('what the client manager can now say', () => {
  it('names EVERY step, in order, in editor words — not node ids and a status', () => {
    const view = projectActivityForChat(run(), cost, NOW)!;
    assert.equal(view.steps.length, 3);
    assert.deepEqual(
      view.steps.map((step) => step.status),
      ['completed', 'running', 'pending']
    );
    for (const step of view.steps) {
      assert.ok(step.step.length > 0, 'every step carries a human label');
      assert.ok(step.id.length > 0, 'and its raw id, so a retry can name it');
    }
  });

  it('says how long the running step has usually taken — the answer a spinner cannot give', () => {
    const view = projectActivityForChat(run(), cost, NOW)!;
    const body = view.steps.find((step) => step.id === 'article_body')!;
    assert.equal(body.usually_ms, 180_000);
    assert.equal(view.remaining?.based_on_runs, 12);
    assert.ok((view.remaining?.p50_ms ?? 0) > 0);
  });

  it('carries what a finished step produced, and what each one cost', () => {
    const view = projectActivityForChat(run(), cost, NOW)!;
    assert.equal(view.steps[0]!.produced, 'research_brief');
    assert.equal(view.steps[0]!.took_ms, 120_000);
    assert.equal(view.cost?.usd, 0.15);
  });

  it('keeps Wolf’s severity rule: a step that warned and carried on is NOT a failure', () => {
    const view = projectActivityForChat(
      run({
        nodes: [
          {
            nodeId: 'article_body',
            status: 'completed',
            warnings: ['tool_call_failed:publish_workspace_run'],
            toolCalls: [{ toolId: 'publish_workspace_run', status: 'failed', errorCode: 'approval_required' }],
          },
        ],
      }),
      cost,
      NOW
    )!;
    const step = view.steps[0]!;
    assert.notEqual(step.severity, 'failure', 'nothing broke — the run continued');
    assert.ok((step.warnings ?? []).length > 0, 'but it is still reported, as a warning');
    assert.deepEqual(step.tool_errors, ['publish_workspace_run (approval_required)']);
  });

  it('marks a step that DIED as a failure, and carries the recovery sentence with it', () => {
    const view = projectActivityForChat(
      run({
        status: 'failed',
        nodes: [{ nodeId: 'article_body', status: 'failed', errors: ['article_body:output_validation_failed'] }],
      }),
      { ...cost, plan: { ...cost.plan, strategy: 'resume_from_failed', reason: '14 completed stages intact.' } },
      NOW
    )!;
    assert.equal(view.severity, 'failure');
    assert.equal(view.steps[0]!.severity, 'failure');
    assert.deepEqual(view.steps[0]!.errors, ['article_body:output_validation_failed']);
    assert.match(view.recovery?.sentence ?? '', /14 completed stages/);
  });

  it('surfaces an approval gate as the headline — it is the one thing the editor must act on', () => {
    const view = projectActivityForChat(
      run({ approvalsRequired: [{ nodeId: 'publication_controller', reason: 'approval_required' }] }),
      cost,
      NOW
    )!;
    assert.match(view.headline, /approval/i);
    assert.equal(view.approvals?.length, 1);
  });

  it('flags a MOCK run, so a rehearsal is never described as a draft', () => {
    const view = projectActivityForChat(run({ executionMode: 'mock' }), cost, NOW)!;
    assert.equal(view.mock_run, true);
  });

  it('tells the model how to use it, inside the result where it is read at the right moment', () => {
    const view = projectActivityForChat(run(), cost, NOW)!;
    assert.match(view.how_to_answer, /specific step/i);
    assert.match(view.how_to_answer, /warning/i);
  });
});

describe('what it must not carry', () => {
  it('never passes a node’s output through — this result is persisted and re-sent every turn', () => {
    const huge = 'x'.repeat(200_000);
    const view = projectActivityForChat(
      run({ nodes: [{ nodeId: 'article_body', status: 'completed', output: huge, internalLedger: huge }] }),
      cost,
      NOW
    )!;
    assert.equal(JSON.stringify(view).includes(huge.slice(0, 200)), false);
    assert.ok(JSON.stringify(view).length < 4_000);
  });

  it('never names the provider', () => {
    const view = projectActivityForChat(
      run({ executionMode: 'openai', mode: { executionMode: 'openai' } }),
      cost,
      NOW
    )!;
    assert.equal(JSON.stringify(view).includes('openai'), false);
  });

  it('bounds a long run by dropping QUIET completed steps, never the ones that matter', () => {
    const many = Array.from({ length: CHAT_ACTIVITY_NODE_MAX + 20 }, (_, index) => ({
      nodeId: `node_${index}`,
      status: 'completed',
    }));
    many[3] = { nodeId: 'node_3', status: 'failed', errors: ['node_3:boom'] } as (typeof many)[number];
    many[many.length - 1] = { nodeId: 'node_last', status: 'running' } as (typeof many)[number];
    const view = projectActivityForChat(run({ nodes: many }), cost, NOW)!;
    assert.ok(view.steps.length <= CHAT_ACTIVITY_NODE_MAX);
    assert.ok(
      view.steps.some((step) => step.id === 'node_3'),
      'the failed step survives the bound'
    );
    assert.ok(
      view.steps.some((step) => step.id === 'node_last'),
      'so does the one running right now'
    );
    assert.ok((view.steps_omitted ?? 0) > 0, 'and the omission is declared, never silent');
  });

  it('returns nothing at all for an unreadable run rather than an empty-looking answer', () => {
    assert.equal(projectActivityForChat(undefined, undefined, NOW), undefined);
    assert.equal(projectActivityForChat({ status: 'running' }, undefined, NOW), undefined);
  });
});
