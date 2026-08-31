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
  receiptLine,
  runCardStatesStatus,
  terminalReceiptInfo,
  threadStatusVisibility,
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

  /**
   * REGRESSION (FIX 1). `ChatStateChip` renders `null` when this returns
   * `undefined`, so this function is what decides whether that component
   * takes its early return — and every hook in it must therefore sit ABOVE
   * that bail-out. A chat's very first turn walks exactly this transition:
   * `idle` with no outcome (no chip) → `queued` (a chip). When a hook lived
   * below the `if (!chip) return null`, that one transition changed the
   * component's hook count from 2 to 3 and React threw "Rendered more hooks
   * than during the previous render", unmounting `/admin/agents`.
   *
   * This is the pure, named cause. If the `undefined` branch below ever goes
   * away, the hazard goes with it — and if it stays, the ordering comment in
   * `chat.tsx`'s `ChatStateChip` is what keeps the component honest.
   */
  it('a never-run chat has NO chip, and its first turn gives it one (the hook-order trigger)', () => {
    assert.equal(deriveLivenessChip('idle', null), undefined, 'a chat that has never run shows nothing');
    assert.equal(deriveLivenessChip('idle', undefined), undefined);
    assert.equal(deriveLivenessChip(undefined, undefined), undefined, 'no status at all shows nothing');
    // …and the very next poll, once the turn starts, does return a chip.
    assert.notEqual(deriveLivenessChip('queued', null), undefined, 'the first turn flips it to a chip');
    assert.notEqual(deriveLivenessChip('running', null), undefined);
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

describe('threadStatusVisibility — A2: the chip is the single live indicator', () => {
  it('never renders the retired trailing line, regardless of inputs', () => {
    assert.equal(threadStatusVisibility({ running: true, hasRunCard: false }).trailingLine, false);
    assert.equal(threadStatusVisibility({ running: true, hasRunCard: true }).trailingLine, false);
    assert.equal(threadStatusVisibility({ running: false, hasRunCard: false }).trailingLine, false);
  });

  it('shows the trailing activity group’s live RunProgress only while running and with no RequestActivity card mounted', () => {
    assert.equal(threadStatusVisibility({ running: true, hasRunCard: false }).activityProgress, true);
    assert.equal(threadStatusVisibility({ running: true, hasRunCard: true }).activityProgress, false, 'the run card already live-renders this run’s progress');
    assert.equal(threadStatusVisibility({ running: false, hasRunCard: false }).activityProgress, false, 'nothing live to show');
    assert.equal(threadStatusVisibility({ running: false, hasRunCard: true }).activityProgress, false);
  });
});

/**
 * FIX 5 — the invariant, over every combination there is.
 *
 * `hasRunCard` used to be `Boolean(chat.request)` at the call site: "a
 * request is bound". A `RequestActivity` is a Skeleton until its first poll
 * resolves and a degraded notice ("we could not reach the workspace") when
 * that poll comes back `cms_agent_unavailable` / `no_workflow_run` — in both
 * it states no run status, while `Boolean(chat.request)` stayed true and the
 * thread stayed silenced on its behalf. A chat bound to such a request,
 * whose last run ended in `run_error`, showed the failure NOWHERE.
 */
describe('runCardStatesStatus — the thread is never silenced by a silent card', () => {
  const ALL = [true, false];

  it('only a mounted, loaded card with an activity view counts as stating the status', () => {
    assert.equal(runCardStatesStatus({ mounted: true, loaded: true, hasActivity: true }), true);
    // The three silent states, one per field.
    assert.equal(runCardStatesStatus({ mounted: false, loaded: true, hasActivity: true }), false, 'no card at all');
    assert.equal(runCardStatesStatus({ mounted: true, loaded: false, hasActivity: true }), false, 'still a Skeleton');
    assert.equal(
      runCardStatesStatus({ mounted: true, loaded: true, hasActivity: false }),
      false,
      'a degraded notice states no run status'
    );
  });

  it('INVARIANT: the card is never silent while the thread has been silenced', () => {
    for (const mounted of ALL) {
      for (const loaded of ALL) {
        for (const hasActivity of ALL) {
          for (const running of ALL) {
            for (const outcome of ['error', 'completed'] as const) {
              const hasRunCard = runCardStatesStatus({ mounted, loaded, hasActivity });
              const where = `mounted=${mounted} loaded=${loaded} hasActivity=${hasActivity} running=${running}`;
              if (hasRunCard) continue;
              // A silent card must leave every one of the thread's own
              // status channels open.
              assert.equal(
                threadStatusVisibility({ running, hasRunCard }).activityProgress,
                running,
                `${where}: a silent card must not suppress the thread's progress`
              );
              assert.equal(
                receiptLine({ outcome, chips: [], message: 'it broke', hasRunCard }).showFailureText,
                true,
                `${where}: a silent card must not suppress the run's failure text`
              );
            }
          }
        }
      }
    }
  });

  it('and when the card IS stating the status, the thread does defer to it', () => {
    const hasRunCard = runCardStatesStatus({ mounted: true, loaded: true, hasActivity: true });
    assert.equal(hasRunCard, true);
    assert.equal(threadStatusVisibility({ running: true, hasRunCard }).activityProgress, false);
    assert.equal(receiptLine({ outcome: 'error', chips: [], message: 'it broke', hasRunCard }).showFailureText, false);
    // …but only for the failure the card would restate. A completed run's
    // own text was never the card's to state.
    assert.equal(
      receiptLine({ outcome: 'completed', chips: [], message: 'note', hasRunCard }).showFailureText,
      true
    );
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

describe('receiptLine — A3: one muted line, the failure stated exactly once', () => {
  it('drops a lone "no changes" chip — it carries no information the headline doesn’t already', () => {
    assert.deepEqual(receiptLine({ outcome: 'completed', chips: ['no changes'], hasRunCard: false }).visibleChips, []);
  });

  it('keeps chips that actually say something', () => {
    assert.deepEqual(
      receiptLine({ outcome: 'completed', chips: ['created 1 object', 'published 1'], hasRunCard: false }).visibleChips,
      ['created 1 object', 'published 1']
    );
  });

  it('shows the run’s own failure text when no RequestActivity card is mounted for it', () => {
    const decision = receiptLine({ outcome: 'error', chips: [], message: 'boom', hasRunCard: false });
    assert.equal(decision.showFailureText, true);
  });

  it('suppresses the failure text once a RequestActivity card is mounted — that card already states this failure', () => {
    const decision = receiptLine({ outcome: 'error', chips: [], message: 'boom', hasRunCard: true });
    assert.equal(decision.showFailureText, false);
  });

  it('a mounted run card only suppresses the ERROR outcome’s text — a non-failed outcome has nothing duplicated to hide', () => {
    const decision = receiptLine({ outcome: 'completed', chips: [], message: 'irrelevant here', hasRunCard: true });
    assert.equal(decision.showFailureText, true);
  });

  it('there is nothing to show when there is no message at all', () => {
    assert.equal(receiptLine({ outcome: 'completed', chips: [], hasRunCard: false }).showFailureText, false);
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
