/**
 * W19 T19.10 — the two pure halves of the pre-registry backfill, run directly
 * against the real script like schema-migration-gate.test.mjs. The walk itself
 * (chat store → request store) needs a live blob store and is proven by the
 * script's own dry run against a real site.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { isOlderThan, jobsFromChat } from '../../scripts/backfill-editorial-requests.mjs';

const runResult = (requestId, runId, at) => ({
  type: 'tool_result',
  at,
  detail: { tool: 'run_workspace_workflow', output: JSON.stringify({ request_id: requestId, run_id: runId }) },
});

test('jobsFromChat reads a job out of the only place a pre-W19 run was written down', () => {
  const { jobs, trimmed } = jobsFromChat({
    chat_id: 'obj:req_a',
    kind: 'object',
    created_by: 'editor@example.com',
    title: 'Retinol after 40',
    events: [
      { type: 'assistant_text', at: '2026-08-01T10:00:00.000Z' },
      runResult('req_a_x_20260801_01', 'run_123', '2026-08-01T10:01:00.000Z'),
    ],
  });
  assert.equal(trimmed, false);
  assert.deepEqual(jobs, [
    {
      requestId: 'req_a_x_20260801_01',
      runId: 'run_123',
      at: '2026-08-01T10:01:00.000Z',
      chatId: 'obj:req_a',
      chatKind: 'object',
      createdBy: 'editor@example.com',
      title: 'Retinol after 40',
    },
  ]);
});

test('jobsFromChat skips a FAILED launch — a run that never started is not a job', () => {
  const failed = runResult('req_b_x_20260801_01', 'run_456', '2026-08-01T10:00:00.000Z');
  failed.detail.is_error = true;
  assert.deepEqual(jobsFromChat({ events: [failed] }).jobs, []);
});

test('jobsFromChat ignores every other tool, and unparseable output, rather than guessing', () => {
  const { jobs } = jobsFromChat({
    events: [
      {
        type: 'tool_result',
        at: '2026-08-01T10:00:00.000Z',
        detail: { tool: 'publish', output: '{"request_id":"x"}' },
      },
      {
        type: 'tool_result',
        at: '2026-08-01T10:01:00.000Z',
        detail: { tool: 'run_workspace_workflow', output: 'not json' },
      },
      { type: 'tool_result', at: '2026-08-01T10:02:00.000Z', detail: { tool: 'run_workspace_workflow', output: '{}' } },
    ],
  });
  assert.deepEqual(jobs, []);
});

test('jobsFromChat keeps a job whose run id was never recorded, and says the id is unknown', () => {
  const { jobs } = jobsFromChat({
    events: [
      {
        type: 'tool_result',
        at: '2026-08-01T10:00:00.000Z',
        detail: { tool: 'run_workspace_workflow', output: { request_id: 'req_c_x_20260801_01' } },
      },
    ],
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].runId, undefined, 'absent, not invented — the row is registered without a workflow block');
});

test('jobsFromChat reports a TRIMMED chat, so a clean number is never read as a complete one', () => {
  const { trimmed } = jobsFromChat({
    events: [
      { type: 'events_trimmed', at: '2026-08-01T09:00:00.000Z' },
      runResult('req_d', 'run_1', '2026-08-01T10:00:00.000Z'),
    ],
  });
  assert.equal(trimmed, true);
});

test('isOlderThan archives history and leaves a RECENT job live for the sweeper to derive', () => {
  const cutoff = Date.parse('2026-08-15T00:00:00.000Z');
  assert.equal(isOlderThan('2026-07-01T00:00:00.000Z', cutoff), true);
  assert.equal(
    isOlderThan('2026-08-22T00:00:00.000Z', cutoff),
    false,
    'archiving a running job hides it permanently — the sweeper skips archived rows'
  );
});

test('isOlderThan treats an unreadable timestamp as old rather than as live', () => {
  assert.equal(isOlderThan(undefined, Date.parse('2026-08-15T00:00:00.000Z')), true);
  assert.equal(isOlderThan('not a date', Date.parse('2026-08-15T00:00:00.000Z')), true);
});
