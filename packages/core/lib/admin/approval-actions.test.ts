/**
 * T1.2 — pure state machine (`ActionRow`) and step formatting (`RunProgress`)
 * behind `@core/admin/approval`. See `approval-actions.ts`'s header for why
 * this logic lives here rather than in the `.tsx` component file.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canConfirmReason,
  DECISION_KEYS,
  DECISION_LABEL,
  DECISION_PENDING_LABEL,
  decisionFailedTitle,
  INITIAL_ACTION_ROW_STATE,
  isActionRowBusy,
  needsReasonCapture,
  reduceActionRow,
  runStepLabel,
  runStepPercent,
  type ActionRowState,
} from './approval-actions.js';

describe('reduceActionRow', () => {
  it('starts at rest — no reason capture, nothing pending', () => {
    assert.equal(INITIAL_ACTION_ROW_STATE.pending, undefined);
    assert.equal(INITIAL_ACTION_ROW_STATE.reasonFor, undefined);
    assert.equal(INITIAL_ACTION_ROW_STATE.reasonDraft, '');
  });

  it('clicking Reject/Modify swaps in the reason textarea, mirroring chat.tsx Decline', () => {
    const afterReject = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'reject' });
    assert.equal(afterReject.reasonFor, 'reject');
    assert.equal(afterReject.reasonDraft, '');

    const afterModify = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'modify' });
    assert.equal(afterModify.reasonFor, 'modify');
  });

  it('edit_reason updates the draft without leaving reason-capture mode', () => {
    const capturing = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'reject' });
    const edited = reduceActionRow(capturing, { type: 'edit_reason', text: 'needs another pass' });
    assert.equal(edited.reasonDraft, 'needs another pass');
    assert.equal(edited.reasonFor, 'reject');
  });

  it('cancel_reason returns to rest and drops the draft', () => {
    const capturing = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'modify' });
    const edited = reduceActionRow(capturing, { type: 'edit_reason', text: 'draft text' });
    const cancelled = reduceActionRow(edited, { type: 'cancel_reason' });
    assert.equal(cancelled.reasonFor, undefined);
    assert.equal(cancelled.reasonDraft, '');
  });

  it('begin marks a decision pending', () => {
    const pending = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'begin', action: 'approve' });
    assert.equal(pending.pending, 'approve');
    assert.equal(isActionRowBusy(pending), true);
  });

  it('settle always returns to a clean rest state, even mid reason-capture', () => {
    const capturing = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'reject' });
    const edited = reduceActionRow(capturing, { type: 'edit_reason', text: 'stale text' });
    const pending = reduceActionRow(edited, { type: 'begin', action: 'reject' });
    const settled = reduceActionRow(pending, { type: 'settle' });
    assert.deepEqual(settled, { reasonDraft: '' });
    assert.equal(isActionRowBusy(settled), false);
  });

  it('a decision in flight cannot be pre-empted — a rejected promise must settle first', () => {
    const pending: ActionRowState = { reasonDraft: '', pending: 'reject' };
    // None of these mutate state while something is in flight — this is the
    // structural guarantee behind "all three disabled while one is running".
    assert.deepEqual(reduceActionRow(pending, { type: 'begin', action: 'modify' }), pending);
    assert.deepEqual(reduceActionRow(pending, { type: 'request_reason', action: 'modify' }), pending);
    assert.deepEqual(reduceActionRow(pending, { type: 'edit_reason', text: 'x' }), pending);
    assert.deepEqual(reduceActionRow(pending, { type: 'cancel_reason' }), pending);
    // Only settle gets through.
    assert.notDeepEqual(reduceActionRow(pending, { type: 'settle' }), pending);
  });
});

describe('canConfirmReason', () => {
  it('optional requirement always allows Confirm, even with an empty draft', () => {
    const empty: ActionRowState = { reasonDraft: '' };
    const blank: ActionRowState = { reasonDraft: '   ' };
    assert.equal(canConfirmReason(empty, 'optional'), true);
    assert.equal(canConfirmReason(blank, 'optional'), true);
  });

  it('required requirement blocks Confirm until non-whitespace text exists', () => {
    const empty: ActionRowState = { reasonDraft: '' };
    const blank: ActionRowState = { reasonDraft: '   ' };
    const filled: ActionRowState = { reasonDraft: '  a real reason  ' };
    assert.equal(canConfirmReason(empty, 'required'), false);
    assert.equal(canConfirmReason(blank, 'required'), false);
    assert.equal(canConfirmReason(filled, 'required'), true);
  });

  it('a mechanism with nowhere to put a reason never blocks Confirm', () => {
    assert.equal(canConfirmReason({ reasonDraft: '' }, 'none'), true);
  });
});

describe('needsReasonCapture (T3.2)', () => {
  it('opens the textarea for the two requirements that can carry words', () => {
    assert.equal(needsReasonCapture('optional'), true);
    assert.equal(needsReasonCapture('required'), true);
  });

  it('skips it where the mechanism has no field for them — the workflow publish gate', () => {
    // `decisions.ts`'s `reasonDroppedNote`: that endpoint's whole body is
    // {request_id|run_id, action}. Prompting for a note there would be a lie.
    assert.equal(needsReasonCapture('none'), false);
  });
});

describe('decision copy tables', () => {
  it('uses the Approve/Reject/Modify vocabulary ruling, not the four legacy words', () => {
    assert.equal(DECISION_LABEL.approve, 'Approve');
    assert.equal(DECISION_LABEL.reject, 'Reject');
    assert.equal(DECISION_LABEL.modify, 'Modify');
    for (const key of ['approve', 'reject', 'modify'] as const) {
      assert.match(DECISION_PENDING_LABEL[key], /…$/);
      assert.equal(decisionFailedTitle(key), `${DECISION_LABEL[key]} failed`);
    }
  });
});

/**
 * A7's acceptance criterion, and the reason `DECISION_KEYS` exists. The chat's
 * own approval card is gone; every approval surface now renders THIS action
 * set with THESE words, so the invariant is asserted once, here, against the
 * module that owns the list — not restated per surface where it would drift
 * back into the "Decline"/"Deny"/"Request changes"/"Hold" spread
 * `docs/plan/ux-inventory.md` Table C catalogued.
 */
describe('the decision action set (A7 vocabulary invariant)', () => {
  it('is exactly approve | reject | modify, in row order', () => {
    assert.deepEqual([...DECISION_KEYS], ['approve', 'reject', 'modify']);
  });

  it('has a label, a pending label and a failure title for each key and nothing else', () => {
    assert.deepEqual(Object.keys(DECISION_LABEL).sort(), [...DECISION_KEYS].sort());
    assert.deepEqual(Object.keys(DECISION_PENDING_LABEL).sort(), [...DECISION_KEYS].sort());
  });

  it('calls the non-approve decision "Reject" — never Decline, Deny or Request changes', () => {
    assert.equal(DECISION_LABEL.reject, 'Reject');
    const copy = [
      ...DECISION_KEYS.map((key) => DECISION_LABEL[key]),
      ...DECISION_KEYS.map((key) => DECISION_PENDING_LABEL[key]),
      ...DECISION_KEYS.map((key) => decisionFailedTitle(key)),
    ].join(' | ');
    assert.doesNotMatch(copy, /declin|deny|denied|request changes|hold/i);
  });

  it('derives the Confirm copy from the same table the buttons use', () => {
    // `<ActionRow>` renders `Confirm ${label.toLowerCase()}` — asserted here
    // because the .tsx it lives in cannot be tested (BRIEF.md).
    assert.equal(`Confirm ${DECISION_LABEL.reject.toLowerCase()}`, 'Confirm reject');
    assert.equal(`Confirm ${DECISION_LABEL.modify.toLowerCase()}`, 'Confirm modify');
  });
});

describe('reduceActionRow — capture prefill and refusal (A7)', () => {
  it('opens the capture on a prefilled draft when one is given', () => {
    const opened = reduceActionRow(INITIAL_ACTION_ROW_STATE, {
      type: 'request_reason',
      action: 'modify',
      draft: '{\n  "path": "/x"\n}',
    });
    assert.equal(opened.reasonFor, 'modify');
    assert.equal(opened.reasonDraft, '{\n  "path": "/x"\n}');
    assert.equal(opened.draftError, undefined);
  });

  it('refuse_draft keeps the typed text and explains — it never settles the row', () => {
    const opened = reduceActionRow(INITIAL_ACTION_ROW_STATE, { type: 'request_reason', action: 'modify' });
    const typed = reduceActionRow(opened, { type: 'edit_reason', text: '{ bad json' });
    const refused = reduceActionRow(typed, { type: 'refuse_draft', message: 'Not valid JSON.' });
    assert.equal(refused.draftError, 'Not valid JSON.');
    // The whole point: the edit survives the refusal.
    assert.equal(refused.reasonDraft, '{ bad json');
    assert.equal(refused.reasonFor, 'modify');
    assert.equal(isActionRowBusy(refused), false);
  });

  it('the next keystroke clears the refusal, and beginning the decision does too', () => {
    const refused: ActionRowState = { reasonFor: 'modify', reasonDraft: '{ bad', draftError: 'Not valid JSON.' };
    assert.equal(reduceActionRow(refused, { type: 'edit_reason', text: '{}' }).draftError, undefined);
    assert.equal(reduceActionRow(refused, { type: 'begin', action: 'modify' }).draftError, undefined);
  });

  it('a fresh capture never inherits a previous one\'s refusal', () => {
    const refused: ActionRowState = { reasonFor: 'modify', reasonDraft: '{ bad', draftError: 'Not valid JSON.' };
    const cancelled = reduceActionRow(refused, { type: 'cancel_reason' });
    assert.deepEqual(cancelled, { reasonDraft: '' });
    const reopened = reduceActionRow(refused, { type: 'request_reason', action: 'reject' });
    assert.deepEqual(reopened, { reasonFor: 'reject', reasonDraft: '' });
  });
});

describe('runStepPercent', () => {
  it('computes a clamped whole percent', () => {
    assert.equal(runStepPercent(0, 10), 0);
    assert.equal(runStepPercent(5, 10), 50);
    assert.equal(runStepPercent(10, 10), 100);
    assert.equal(runStepPercent(3, 7), 43);
  });

  it('never exceeds the 0-100 range even with a step past total', () => {
    assert.equal(runStepPercent(12, 10), 100);
    assert.equal(runStepPercent(-2, 10), 0);
  });

  it('returns 0 for a zero or negative total rather than dividing by it', () => {
    assert.equal(runStepPercent(3, 0), 0);
    assert.equal(runStepPercent(3, -1), 0);
  });
});

describe('runStepLabel', () => {
  it('reads "Step n of m"', () => {
    assert.equal(runStepLabel(3, 7), 'Step 3 of 7');
    assert.equal(runStepLabel(0, 7), 'Step 0 of 7');
    assert.equal(runStepLabel(7, 7), 'Step 7 of 7');
  });

  it('falls back to a bare step count when totalSteps is unknown', () => {
    assert.equal(runStepLabel(4, 0), 'Step 4');
    assert.equal(runStepLabel(-1, 0), 'Step 0');
  });
});
