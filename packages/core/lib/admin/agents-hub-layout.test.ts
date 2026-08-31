import assert from 'node:assert/strict';
import test from 'node:test';

import { AGENTS_HUB_LAYOUT, chatColumnFraction, chatColumnWidthPx } from './agents-hub-layout.js';

test('the rail is a fixed 260px, not a fraction of the viewport', () => {
  assert.equal(AGENTS_HUB_LAYOUT.railPx, 260);
});

test('at a 1440px content width the chat column is at least 60% of it', () => {
  const fraction = chatColumnFraction(1440);
  assert.ok(fraction >= 0.6, `expected chat column fraction >= 0.6 at 1440px, got ${fraction}`);
});

test('chatColumnWidthPx subtracts the fixed rail and the gap from the content width', () => {
  assert.equal(chatColumnWidthPx(1440), 1440 - AGENTS_HUB_LAYOUT.railPx - AGENTS_HUB_LAYOUT.gapPx);
  assert.equal(chatColumnWidthPx(1440), 1160);
});

test('the chat column gained roughly 25% width versus the old 1fr/2fr grid split', () => {
  // The old grid was `[minmax(0,1fr)_minmax(0,2fr)]` — the chat column held
  // 2 of every 3 shares, i.e. two-thirds of the content width.
  const oldFraction = 2 / 3;
  const oldWidthPx = 1440 * oldFraction;
  const newWidthPx = chatColumnWidthPx(1440);
  const gain = (newWidthPx - oldWidthPx) / oldWidthPx;
  assert.ok(gain > 0.15 && gain < 0.35, `expected roughly a +25% gain at 1440px, got ${gain}`);
});

test('never collapses to a negative width at a content width smaller than the rail + gap', () => {
  assert.equal(chatColumnWidthPx(100), 0);
  assert.equal(chatColumnFraction(0), 0);
});

test('the fraction climbs toward 1 as the content grows — a fixed rail matters least on a wide screen', () => {
  assert.ok(chatColumnFraction(2560) > chatColumnFraction(1440));
});
