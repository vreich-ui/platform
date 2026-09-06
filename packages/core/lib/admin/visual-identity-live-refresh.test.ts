import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chatRunJustFinished,
  EXAMPLES_POLL_MAX_ATTEMPTS,
  examplesJobJustSettled,
  examplesPollAttempt,
  isActiveChatStatus,
  isPendingExamplesJob,
  isTerminalChatStatus,
  isTerminalExamplesJob,
  shouldContinuePollingExamples,
} from './visual-identity-live-refresh.js';
import type { ChatStatus } from './chat-client.js';

describe('isActiveChatStatus / isTerminalChatStatus', () => {
  it('treats queued/running/awaiting_* as active, idle/error/cancelled as terminal', () => {
    const active: ChatStatus[] = ['queued', 'running', 'awaiting_approval', 'awaiting_candidate'];
    const terminal: ChatStatus[] = ['idle', 'error', 'cancelled'];
    for (const status of active) {
      assert.equal(isActiveChatStatus(status), true, status);
      assert.equal(isTerminalChatStatus(status), false, status);
    }
    for (const status of terminal) {
      assert.equal(isActiveChatStatus(status), false, status);
      assert.equal(isTerminalChatStatus(status), true, status);
    }
  });

  it('treats undefined (no poll landed yet) as neither active nor terminal', () => {
    assert.equal(isActiveChatStatus(undefined), false);
    assert.equal(isTerminalChatStatus(undefined), false);
  });
});

describe('chatRunJustFinished', () => {
  it('fires only on the tick a run moves from active to terminal', () => {
    assert.equal(chatRunJustFinished('running', 'idle'), true);
    assert.equal(chatRunJustFinished('queued', 'error'), true);
    assert.equal(chatRunJustFinished('awaiting_approval', 'cancelled'), true);
  });

  it('is false when nothing was ever running', () => {
    assert.equal(chatRunJustFinished(undefined, 'idle'), false);
    assert.equal(chatRunJustFinished('idle', 'idle'), false);
  });

  it('fires exactly once across a full run, not on every tick', () => {
    const ticks: Array<ChatStatus | undefined> = [
      undefined,
      'queued',
      'running',
      'running',
      'idle',
      'idle',
      'idle',
    ];
    let previous: ChatStatus | undefined;
    let fired = 0;
    for (const next of ticks) {
      if (chatRunJustFinished(previous, next)) fired += 1;
      previous = next;
    }
    assert.equal(fired, 1);
  });

  it('fires once per run across two runs, not once total', () => {
    const ticks: Array<ChatStatus | undefined> = ['running', 'idle', 'idle', 'queued', 'running', 'idle'];
    let previous: ChatStatus | undefined;
    let fired = 0;
    for (const next of ticks) {
      if (chatRunJustFinished(previous, next)) fired += 1;
      previous = next;
    }
    assert.equal(fired, 2);
  });

  it('an error or cancellation still counts as the run finishing', () => {
    assert.equal(chatRunJustFinished('running', 'error'), true);
    assert.equal(chatRunJustFinished('awaiting_candidate', 'cancelled'), true);
  });
});

describe('isPendingExamplesJob / isTerminalExamplesJob', () => {
  it('pending is the only non-terminal status', () => {
    assert.equal(isPendingExamplesJob('pending'), true);
    assert.equal(isTerminalExamplesJob('pending'), false);
  });

  it('ready, partial, and failed are all terminal', () => {
    for (const status of ['ready', 'partial', 'failed'] as const) {
      assert.equal(isTerminalExamplesJob(status), true, status);
      assert.equal(isPendingExamplesJob(status), false, status);
    }
  });

  it('undefined (no job known yet) is neither', () => {
    assert.equal(isPendingExamplesJob(undefined), false);
    assert.equal(isTerminalExamplesJob(undefined), false);
  });
});

describe('examplesJobJustSettled', () => {
  it('fires only when a pending round lands on a terminal status', () => {
    assert.equal(examplesJobJustSettled('pending', 'ready'), true);
    assert.equal(examplesJobJustSettled('pending', 'partial'), true);
    assert.equal(examplesJobJustSettled('pending', 'failed'), true);
  });

  it('is false when nothing was pending, or the job is still pending', () => {
    assert.equal(examplesJobJustSettled(undefined, 'ready'), false);
    assert.equal(examplesJobJustSettled('ready', 'ready'), false);
    assert.equal(examplesJobJustSettled('pending', 'pending'), false);
  });

  it('fires exactly once across a poll sequence', () => {
    const ticks: Array<'pending' | 'partial' | 'ready' | 'failed' | undefined> = [
      'pending',
      'pending',
      'pending',
      'ready',
      'ready',
    ];
    let previous: 'pending' | 'partial' | 'ready' | 'failed' | undefined;
    let fired = 0;
    for (const next of ticks) {
      if (examplesJobJustSettled(previous, next)) fired += 1;
      previous = next;
    }
    assert.equal(fired, 1);
  });
});

describe('shouldContinuePollingExamples', () => {
  it('starts (schedules another tick) only while pending', () => {
    assert.equal(shouldContinuePollingExamples('pending', 0), true);
    assert.equal(shouldContinuePollingExamples('ready', 0), false);
    assert.equal(shouldContinuePollingExamples('partial', 0), false);
    assert.equal(shouldContinuePollingExamples('failed', 0), false);
    assert.equal(shouldContinuePollingExamples(undefined, 0), false);
  });

  it('stops on each terminal state regardless of how few attempts were made', () => {
    for (const status of ['ready', 'partial', 'failed'] as const) {
      assert.equal(shouldContinuePollingExamples(status, 1), false, status);
    }
  });

  it('respects the ceiling: continues right up to it, stops at it', () => {
    assert.equal(shouldContinuePollingExamples('pending', EXAMPLES_POLL_MAX_ATTEMPTS - 1), true);
    assert.equal(shouldContinuePollingExamples('pending', EXAMPLES_POLL_MAX_ATTEMPTS), false);
    assert.equal(shouldContinuePollingExamples('pending', EXAMPLES_POLL_MAX_ATTEMPTS + 5), false);
  });

  it('honors a custom ceiling', () => {
    assert.equal(shouldContinuePollingExamples('pending', 2, 3), true);
    assert.equal(shouldContinuePollingExamples('pending', 3, 3), false);
  });

  it('never polls forever: a permanently pending job stops at the ceiling', () => {
    let attempts = 0;
    const status: 'pending' | 'partial' | 'ready' | 'failed' = 'pending';
    while (shouldContinuePollingExamples(status, attempts)) {
      attempts += 1;
    }
    assert.equal(attempts, EXAMPLES_POLL_MAX_ATTEMPTS);
    assert.equal(status, 'pending');
  });
});

describe('examplesPollAttempt (W5 F6)', () => {
  it('counts up within one round', () => {
    assert.equal(examplesPollAttempt('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 0), 1);
    assert.equal(examplesPollAttempt('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z', 4), 5);
  });

  it('starts over when a NEW round opens', () => {
    assert.equal(examplesPollAttempt('2026-09-01T00:00:00.000Z', '2026-09-01T00:05:00.000Z', 30), 1);
  });

  it('treats the first tick of the session as a new round', () => {
    assert.equal(examplesPollAttempt(undefined, '2026-09-01T00:00:00.000Z', 0), 1);
  });

  it('keeps counting when the tick carries no round at all (no job record yet)', () => {
    assert.equal(examplesPollAttempt('2026-09-01T00:00:00.000Z', undefined, 3), 4);
  });

  it('a round that outran the ceiling does not disable polling for the next one', () => {
    // The bug: a spent per-STANDARD counter meant every later regenerate polled
    // once, saw the ceiling already reached, and scheduled nothing.
    let attempts = 0;
    const round = 'round-1';
    while (shouldContinuePollingExamples('pending', (attempts = examplesPollAttempt(round, round, attempts)))) {
      // burn the whole budget on round one
    }
    assert.equal(attempts, EXAMPLES_POLL_MAX_ATTEMPTS);

    const next = examplesPollAttempt(round, 'round-2', attempts);
    assert.equal(next, 1);
    assert.equal(shouldContinuePollingExamples('pending', next), true);
  });
});
