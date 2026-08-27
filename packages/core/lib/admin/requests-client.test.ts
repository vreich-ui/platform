import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pollIntervalWithBackoff, requestPollIntervalFor } from './requests-client.js';

describe('pollIntervalWithBackoff', () => {
  it('returns the base interval while the tab is visible', () => {
    assert.equal(pollIntervalWithBackoff(5_000, false), 5_000);
    assert.equal(pollIntervalWithBackoff(30_000, false), 30_000);
  });

  it('arms nothing at all while the tab is hidden — the strongest backoff', () => {
    assert.equal(pollIntervalWithBackoff(5_000, true), undefined);
    assert.equal(pollIntervalWithBackoff(30_000, true), undefined);
  });

  it('is a pure function of its two arguments, not of wall-clock time', () => {
    // Calling it twice with the same inputs must never drift — a caller
    // reschedules from this value and a store-level test would otherwise be
    // unable to assert on it deterministically.
    assert.equal(pollIntervalWithBackoff(7_500, false), pollIntervalWithBackoff(7_500, false));
  });
});

describe('requestPollIntervalFor', () => {
  it('polls fastest while anything can move under us', () => {
    assert.equal(requestPollIntervalFor([{ status: 'running' }, { status: 'done' }]), 5_000);
    assert.equal(requestPollIntervalFor([{ status: 'queued' }]), 5_000);
  });

  it('slows down for a row waiting on a person or stalled', () => {
    assert.equal(requestPollIntervalFor([{ status: 'needs_you' }]), 15_000);
    assert.equal(requestPollIntervalFor([{ status: 'stalled' }]), 15_000);
  });

  it('backs all the way off once nothing on the page can move on its own', () => {
    assert.equal(requestPollIntervalFor([{ status: 'done' }, { status: 'cancelled' }]), 30_000);
    assert.equal(requestPollIntervalFor([]), 30_000);
  });
});
