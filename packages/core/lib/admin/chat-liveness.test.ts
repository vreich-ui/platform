import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  activeRunStartedAt,
  deriveLivenessChip,
  elapsedMsForChip,
  elapsedMsSince,
  hasKnownInverse,
  isStreamingNow,
  lastUndoableWriteTool,
  terminalReceiptInfo,
  undoPrompt,
} from './chat-liveness.js';
import type { ChatEventView, RunSummaryView } from './chat-client.js';

const event = (
  seq: number,
  type: ChatEventView['type'],
  detail: Record<string, unknown> = {},
  at?: string
): ChatEventView => ({
  seq,
  type,
  detail,
  at: at ?? `2026-08-07T00:00:0${seq}.000Z`,
});

const outcome = (over: Partial<RunSummaryView> = {}): RunSummaryView => ({
  run_id: 'run_1',
  started_at: '2026-08-07T00:00:00.000Z',
  finished_at: '2026-08-07T00:00:10.000Z',
  outcome: 'completed',
  chips: [],
  ...over,
});

describe('deriveLivenessChip — tier 1, the ambient chip', () => {
  it('maps queued/running to the working tier with no severity (working is not a severity)', () => {
    assert.equal(deriveLivenessChip('queued', null)?.tier, 'working');
    assert.equal(deriveLivenessChip('queued', null)?.severity, undefined);
    assert.equal(deriveLivenessChip('running', null)?.tier, 'working');
    assert.equal(deriveLivenessChip('running', null)?.severity, undefined);
  });

  it('maps awaiting_approval/awaiting_candidate to waiting/needs_you — a decision pending, never blocked', () => {
    assert.deepEqual(deriveLivenessChip('awaiting_approval', null), {
      tier: 'waiting',
      label: 'Needs you — approval',
      severity: 'needs_you',
    });
    assert.equal(deriveLivenessChip('awaiting_candidate', null)?.severity, 'needs_you');
  });

  it('maps a run-level error to blocked/red, distinct from working', () => {
    const chip = deriveLivenessChip('error', null);
    assert.equal(chip?.tier, 'blocked');
    assert.equal(chip?.severity, 'blocked');
  });

  it('maps cancelled to done but info-toned, not success — a human stop is not a receipt of finished work', () => {
    const chip = deriveLivenessChip('cancelled', null);
    assert.equal(chip?.tier, 'done');
    assert.equal(chip?.severity, 'info');
  });

  it('shows nothing for an idle chat that has never run', () => {
    assert.equal(deriveLivenessChip('idle', null), undefined);
    assert.equal(deriveLivenessChip('idle', undefined), undefined);
    assert.equal(deriveLivenessChip(undefined, null), undefined);
  });

  it('idle + a completed last run reads as a plain success receipt', () => {
    const chip = deriveLivenessChip('idle', outcome({ outcome: 'completed' }));
    assert.equal(chip?.tier, 'done');
    assert.equal(chip?.severity, 'success');
  });

  it('W19 F1: idle + a caps ending reads as info ("still alive"), never as a green finish line', () => {
    const chip = deriveLivenessChip('idle', outcome({ outcome: 'caps' }));
    assert.equal(chip?.tier, 'done');
    assert.equal(chip?.severity, 'info');
    assert.match(chip!.label, /continues/);
  });
});

describe('elapsed time', () => {
  it('elapsedMsSince computes a non-negative gap and tolerates missing/bad input', () => {
    assert.equal(elapsedMsSince('2026-08-07T00:00:00.000Z', Date.parse('2026-08-07T00:00:05.000Z')), 5000);
    assert.equal(elapsedMsSince(undefined, Date.now()), undefined);
    assert.equal(elapsedMsSince('not a date', Date.now()), undefined);
  });

  it('activeRunStartedAt finds the latest run_started event', () => {
    const events = [
      event(1, 'run_started', {}, '2026-08-07T00:00:00.000Z'),
      event(2, 'assistant_text', {}),
      event(3, 'run_finished', {}),
      event(4, 'run_started', {}, '2026-08-07T00:05:00.000Z'),
    ];
    assert.equal(activeRunStartedAt(events), '2026-08-07T00:05:00.000Z');
    assert.equal(activeRunStartedAt([]), undefined);
  });

  it('elapsedMsForChip ticks off the active run while working/waiting, and is fixed once done', () => {
    const events = [event(1, 'run_started', {}, '2026-08-07T00:00:00.000Z')];
    const nowMs = Date.parse('2026-08-07T00:00:07.000Z');
    assert.equal(elapsedMsForChip('working', events, null, nowMs), 7000);
    assert.equal(elapsedMsForChip('waiting', events, null, nowMs), 7000);
    assert.equal(elapsedMsForChip('done', [], outcome(), nowMs), 10000);
    assert.equal(elapsedMsForChip('done', [], null, nowMs), undefined);
  });
});

describe('isStreamingNow — distinct from working-but-silent', () => {
  it('is true only while running and a new event just landed', () => {
    assert.equal(isStreamingNow('running', 1000, 2000), true);
    assert.equal(isStreamingNow('running', 1000, 10000), false, 'stale — outside the window, silent');
    assert.equal(isStreamingNow('running', undefined, 2000), false, 'no event has ever landed');
    assert.equal(isStreamingNow('queued', 1000, 2000), false, 'not running at all');
    assert.equal(isStreamingNow('awaiting_approval', 1000, 2000), false);
  });
});

describe('terminalReceiptInfo — tier 4, the receipt headline', () => {
  it('gives every outcome a label and a D4 severity', () => {
    assert.deepEqual(terminalReceiptInfo('completed'), { label: 'Done', severity: 'success' });
    assert.deepEqual(terminalReceiptInfo('cancelled'), { label: 'Cancelled', severity: 'info' });
    assert.equal(terminalReceiptInfo('error').severity, 'blocked');
    assert.equal(terminalReceiptInfo('caps').severity, 'info');
    assert.match(terminalReceiptInfo('caps').label, /keeps going/);
  });
});

describe('undo — exact inverses only', () => {
  it('offers an undo prompt for patch, submit_review, and apply_theme', () => {
    assert.equal(hasKnownInverse('patch'), true);
    assert.equal(hasKnownInverse('submit_review'), true);
    assert.equal(hasKnownInverse('apply_theme'), true);
    assert.equal(typeof undoPrompt('patch'), 'string');
  });

  it('omits the link rather than rendering a dead one for tools with no exact inverse', () => {
    for (const tool of [
      'create_object',
      'create_variant',
      'instantiate_template',
      'instantiate_section_template',
      'publish',
      'discard',
    ]) {
      assert.equal(hasKnownInverse(tool), false, tool);
      assert.equal(undoPrompt(tool), undefined, tool);
    }
  });

  it('lastUndoableWriteTool finds the last successful undoable write scoped to one run', () => {
    const events = [
      event(1, 'tool_call', { run_id: 'run_1', tool: 'patch' }),
      event(2, 'tool_result', { run_id: 'run_1', tool: 'patch' }),
      event(3, 'tool_call', { run_id: 'run_1', tool: 'create_object' }),
      event(4, 'tool_result', { run_id: 'run_1', tool: 'create_object', object_id: 'obj_1' }),
    ];
    assert.equal(lastUndoableWriteTool(events, 'run_1'), 'patch');
    assert.equal(lastUndoableWriteTool(events, 'run_2'), undefined, 'wrong run');
    assert.equal(lastUndoableWriteTool(events, undefined), undefined);
  });

  it('does not offer undo for a failed write, or one whose tool has no inverse', () => {
    const events = [
      event(1, 'tool_call', { run_id: 'run_1', tool: 'patch' }),
      event(2, 'tool_result', { run_id: 'run_1', tool: 'patch', is_error: true }),
    ];
    assert.equal(lastUndoableWriteTool(events, 'run_1'), undefined);

    const created = [
      event(1, 'tool_call', { run_id: 'run_1', tool: 'create_object' }),
      event(2, 'tool_result', { run_id: 'run_1', tool: 'create_object', object_id: 'obj_1' }),
    ];
    assert.equal(lastUndoableWriteTool(created, 'run_1'), undefined);
  });
});
