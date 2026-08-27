import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  dictationText,
  joinDictationText,
  startDictationBuffer,
  withFinalResult,
  withInterimResult,
} from './use-dictation.js';

describe('joinDictationText', () => {
  it('returns the addition untouched when appending to empty input', () => {
    assert.equal(joinDictationText('', 'hello world'), 'hello world');
  });

  it('strips a stray leading space from the very first segment', () => {
    assert.equal(joinDictationText('', ' hello world'), 'hello world');
  });

  it('adds a single space between existing text and a segment with no leading space', () => {
    assert.equal(joinDictationText('Notes:', 'here is the plan'), 'Notes: here is the plan');
  });

  it('does not double the space when the segment already carries a leading space', () => {
    assert.equal(joinDictationText('Notes:', ' here is the plan'), 'Notes: here is the plan');
  });

  it('does not double the space when the base already ends in whitespace', () => {
    assert.equal(joinDictationText('Notes: ', 'here is the plan'), 'Notes: here is the plan');
  });

  it('passes the base through unchanged when the addition is empty', () => {
    assert.equal(joinDictationText('My existing draft', ''), 'My existing draft');
  });

  it('loses no characters across a multi-word join', () => {
    const joined = joinDictationText('first part', 'second part');
    assert.equal(joined, 'first part second part');
    assert.equal(joined.length, 'first part'.length + 1 + 'second part'.length);
  });
});

describe('dictation buffer: appending after user-typed text', () => {
  it('starts a session on top of whatever the user already typed', () => {
    const buffer = startDictationBuffer('My existing draft');
    assert.equal(dictationText(buffer), 'My existing draft');
  });

  it('appends a final segment after hand-typed text with exactly one space', () => {
    const buffer = withFinalResult(startDictationBuffer('My existing draft'), 'and now the spoken part');
    assert.equal(dictationText(buffer), 'My existing draft and now the spoken part');
  });

  it('appending to a truly empty input produces just the spoken text', () => {
    const buffer = withFinalResult(startDictationBuffer(''), 'hello world');
    assert.equal(dictationText(buffer), 'hello world');
  });
});

describe('dictation buffer: interim replaced by final', () => {
  it('shows the interim preview live without committing it', () => {
    const started = startDictationBuffer('Notes:');
    const withPreview = withInterimResult(started, ' this is being spoken');
    assert.equal(dictationText(withPreview), 'Notes: this is being spoken');
    assert.equal(withPreview.committed, 'Notes:', 'interim must not have touched committed text');
  });

  it('replaces the interim preview with the finalized transcript once the segment finalizes', () => {
    const started = startDictationBuffer('Notes:');
    const withPreview = withInterimResult(started, ' this is being spo');
    const finalized = withFinalResult(withPreview, ' this is being spoken now');
    assert.equal(dictationText(finalized), 'Notes: this is being spoken now');
    assert.equal(finalized.interim, '', 'interim clears once a final result lands');
  });

  it('supports a second utterance after a final result without losing the first', () => {
    const afterFirst = withFinalResult(startDictationBuffer(''), 'first sentence.');
    const withSecondPreview = withInterimResult(afterFirst, ' second sentence in progress');
    assert.equal(dictationText(withSecondPreview), 'first sentence. second sentence in progress');
    const afterSecond = withFinalResult(withSecondPreview, ' second sentence done.');
    assert.equal(dictationText(afterSecond), 'first sentence. second sentence done.');
  });

  it('a trailing hand-typed edit after dictating is preserved by a later session (no double-space, no loss)', () => {
    const dictated = withFinalResult(startDictationBuffer(''), 'spoken text');
    const withTypedTail = { committed: `${dictated.committed} — edited by hand`, interim: '' };
    assert.equal(dictationText(withTypedTail), 'spoken text — edited by hand');
    const nextSession = withFinalResult(startDictationBuffer(dictationText(withTypedTail)), 'more speech');
    assert.equal(dictationText(nextSession), 'spoken text — edited by hand more speech');
  });
});
