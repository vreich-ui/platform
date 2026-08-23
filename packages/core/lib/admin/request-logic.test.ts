import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterRequestRows,
  nodeLabel,
  progressPhrase,
  relativeAge,
  requestStatusTone,
  sortRequestRows,
  summarizeRequestRows,
  type RequestRowLike,
  type RequestStatusName,
} from './request-logic.js';

const row = (
  request_id: string,
  status: RequestStatusName,
  overrides: Partial<RequestRowLike> = {}
): RequestRowLike => ({
  request_id,
  kind: 'article',
  title: `Article ${request_id}`,
  status,
  created_by: 'editor@example.com',
  updated_at: '2026-08-22T10:00:00.000Z',
  archived: status === 'archived',
  ...overrides,
});

describe('request list filtering', () => {
  const rows = [
    row('req_a_x_20260822_01', 'running'),
    row('req_b_x_20260822_01', 'needs_you', { created_by: 'Owner@Example.com' }),
    row('req_c_x_20260822_01', 'done', { kind: 'page', title: 'Contact page' }),
    row('req_d_x_20260822_01', 'archived'),
  ];

  it('hides archived rows unless the archived filter is explicitly on', () => {
    assert.deepEqual(
      filterRequestRows(rows, {}).map((item) => item.request_id),
      ['req_a_x_20260822_01', 'req_b_x_20260822_01', 'req_c_x_20260822_01']
    );
    assert.deepEqual(
      filterRequestRows(rows, { archived: false }).map((item) => item.request_id),
      ['req_a_x_20260822_01', 'req_b_x_20260822_01', 'req_c_x_20260822_01']
    );
    assert.deepEqual(
      filterRequestRows(rows, { archived: true }).map((item) => item.request_id),
      ['req_d_x_20260822_01']
    );
  });

  it('filters by status and by kind', () => {
    assert.equal(filterRequestRows(rows, { status: ['needs_you'] }).length, 1);
    assert.equal(filterRequestRows(rows, { status: ['running', 'needs_you'] }).length, 2);
    assert.equal(filterRequestRows(rows, { kind: ['page'] }).length, 1);
  });

  it('treats `mine` as a case-insensitive view, never a permission', () => {
    assert.deepEqual(
      filterRequestRows(rows, { mine: true, callerEmail: 'owner@example.com' }).map((item) => item.request_id),
      ['req_b_x_20260822_01']
    );
    // No caller e-mail means the view cannot be computed — it shows nothing
    // rather than silently showing everything.
    assert.equal(filterRequestRows(rows, { mine: true }).length, 0);
  });

  it('searches title and request id together, case-insensitively', () => {
    assert.equal(filterRequestRows(rows, { q: 'contact' }).length, 1);
    assert.equal(filterRequestRows(rows, { q: 'REQ_A' }).length, 1);
    assert.equal(filterRequestRows(rows, { q: 'nothing here' }).length, 0);
  });
});

describe('request list ordering', () => {
  it('is attention-first, not newest-first', () => {
    const rows = [
      row('req_done_x_20260822_01', 'done', { updated_at: '2026-08-22T12:00:00.000Z' }),
      row('req_run_x_20260822_01', 'running', { updated_at: '2026-08-22T11:00:00.000Z' }),
      row('req_fail_x_20260822_01', 'failed', { updated_at: '2026-08-22T09:00:00.000Z' }),
      row('req_need_x_20260822_01', 'needs_you', { updated_at: '2026-08-22T08:00:00.000Z' }),
      row('req_stall_x_20260822_01', 'stalled', { updated_at: '2026-08-22T07:00:00.000Z' }),
    ];
    assert.deepEqual(
      sortRequestRows(rows).map((item) => item.status),
      ['needs_you', 'stalled', 'failed', 'running', 'done']
    );
  });

  it('breaks ties by most recently updated', () => {
    const rows = [
      row('req_old_x_20260822_01', 'running', { updated_at: '2026-08-22T08:00:00.000Z' }),
      row('req_new_x_20260822_01', 'running', { updated_at: '2026-08-22T12:00:00.000Z' }),
    ];
    assert.deepEqual(
      sortRequestRows(rows).map((item) => item.request_id),
      ['req_new_x_20260822_01', 'req_old_x_20260822_01']
    );
  });

  it('does not mutate the input array', () => {
    const rows = [row('req_a_x_20260822_01', 'done'), row('req_b_x_20260822_01', 'needs_you')];
    const before = rows.map((item) => item.request_id);
    sortRequestRows(rows);
    assert.deepEqual(
      rows.map((item) => item.request_id),
      before
    );
  });
});

describe('shell pill counts', () => {
  it('counts working, needs-you and stalled, and never counts archived rows', () => {
    const counts = summarizeRequestRows([
      row('req_a_x_20260822_01', 'running'),
      row('req_b_x_20260822_01', 'queued'),
      row('req_c_x_20260822_01', 'needs_you'),
      row('req_d_x_20260822_01', 'stalled'),
      row('req_e_x_20260822_01', 'failed'),
      row('req_f_x_20260822_01', 'done'),
      row('req_g_x_20260822_01', 'archived'),
      // An archived row whose stored status still reads unhappy must not count.
      row('req_h_x_20260822_01', 'needs_you', { archived: true }),
    ]);
    assert.deepEqual(counts, { working: 2, needsYou: 1, stalled: 2 });
  });
});

describe('editor vocabulary', () => {
  it('maps known nodes to words and passes unknown ones through', () => {
    assert.equal(nodeLabel('draft_writer'), 'drafting');
    assert.equal(nodeLabel('publication_controller'), 'awaiting your approval');
    assert.equal(nodeLabel('some_new_node'), 'some_new_node');
    assert.equal(nodeLabel(undefined), undefined);
  });

  it('builds the shared progress phrase', () => {
    assert.equal(progressPhrase({ done: 14, total: 23 }, 'draft_writer'), '14 / 23 · drafting');
    assert.equal(progressPhrase({ done: 14, total: 23 }, undefined), '14 / 23');
    assert.equal(progressPhrase(undefined, 'research'), 'researching');
    assert.equal(progressPhrase({ done: 0, total: 0 }, undefined), undefined);
  });

  it('gives stalled and failed the danger tone — to an editor they are one sentence', () => {
    assert.equal(requestStatusTone('stalled'), 'danger');
    assert.equal(requestStatusTone('failed'), 'danger');
    assert.equal(requestStatusTone('needs_you'), 'warning');
    assert.equal(requestStatusTone('running'), 'info');
    assert.equal(requestStatusTone('done'), 'success');
    assert.equal(requestStatusTone('archived'), 'neutral');
  });

  it('phrases age coarsely and never throws on a bad timestamp', () => {
    const now = Date.parse('2026-08-22T12:00:00.000Z');
    assert.equal(relativeAge('2026-08-22T11:59:40.000Z', now), 'just now');
    assert.equal(relativeAge('2026-08-22T11:48:00.000Z', now), '12m');
    assert.equal(relativeAge('2026-08-22T09:00:00.000Z', now), '3h');
    assert.equal(relativeAge('2026-08-20T12:00:00.000Z', now), '2d');
    assert.equal(relativeAge('not a date', now), '');
  });
});
