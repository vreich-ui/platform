import assert from 'node:assert/strict';
import test from 'node:test';

import { railVisible } from './hub-focus.js';

// The decision table from the header comment, exhaustive over the three
// `userToggled` states × the two `activeId` states.
test('no conversation open: the rail is always visible, regardless of the toggle', () => {
  assert.equal(railVisible(undefined, undefined), true);
  assert.equal(railVisible(undefined, false), true);
  assert.equal(railVisible(undefined, true), true);
});

test('a conversation is open and the toggle was never touched: hidden', () => {
  assert.equal(railVisible('chat_1', undefined), false);
});

test('a conversation is open and the user explicitly asked the rail back: visible', () => {
  assert.equal(railVisible('chat_1', true), true);
});

test('a conversation is open and the user dismissed it again: hidden, not sticky-visible', () => {
  assert.equal(railVisible('chat_1', false), false);
});

test('an empty-string activeId is treated the same as "no conversation" (falsy, not a real id)', () => {
  assert.equal(railVisible('', undefined), true);
  assert.equal(railVisible('', true), true);
});
