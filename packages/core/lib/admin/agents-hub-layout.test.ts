import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AGENT_SURFACE_LAYOUT,
  DOCK_PX,
  HUB_RAIL_PX,
  MIN_OBJECT_FRACTION,
  dockFitsBeside,
  minContentWidthForDockPx,
  objectColumnFraction,
  objectColumnWidthPx,
} from './agent-surface-layout.js';
import { AGENTS_HUB_LAYOUT, chatColumnFraction, chatColumnWidthPx } from './agents-hub-layout.js';

test('the rail is a fixed width, not a fraction of the viewport — and ASV2-W1 narrowed it to 220', () => {
  assert.equal(AGENTS_HUB_LAYOUT.railPx, 220);
  assert.equal(AGENTS_HUB_LAYOUT.railPx, HUB_RAIL_PX, 'one source of truth: agent-surface-layout.ts owns the number');
});

test('at a 1440px content width the chat column is at least 60% of it', () => {
  const fraction = chatColumnFraction(1440);
  assert.ok(fraction >= 0.6, `expected chat column fraction >= 0.6 at 1440px, got ${fraction}`);
});

test('chatColumnWidthPx subtracts the fixed rail and the gap from the content width', () => {
  assert.equal(chatColumnWidthPx(1440), 1440 - AGENTS_HUB_LAYOUT.railPx - AGENTS_HUB_LAYOUT.gapPx);
  assert.equal(chatColumnWidthPx(1440), 1200);
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

// ─── ASV2-W0.1: the universal dock's geometry (same file, per the repo's
// "extend the existing test, never add a parallel one" convention) ──────────

test('the dock is a fixed 384px (24rem) — there is no Resizable primitive, so it collapses rather than drags', () => {
  assert.equal(DOCK_PX, 384);
  assert.equal(AGENT_SURFACE_LAYOUT.dockPx, DOCK_PX);
});

test('an open dock never pushes the object below 60% of the content width at the widths it opens at', () => {
  assert.equal(MIN_OBJECT_FRACTION, 0.6);
  assert.ok(objectColumnFraction(1440, true) >= MIN_OBJECT_FRACTION);
  assert.ok(dockFitsBeside(1440));
});

test('a collapsed dock costs the object nothing', () => {
  assert.equal(objectColumnWidthPx(1440, false), 1440);
  assert.equal(objectColumnFraction(1440, false), 1);
});

test('objectColumnWidthPx subtracts the dock and the gap, and never goes negative', () => {
  assert.equal(objectColumnWidthPx(1440, true), 1440 - AGENT_SURFACE_LAYOUT.dockPx - AGENT_SURFACE_LAYOUT.gapPx);
  assert.equal(objectColumnWidthPx(1440, true), 1036);
  assert.equal(objectColumnWidthPx(100, true), 0);
  assert.equal(objectColumnFraction(0, true), 0);
});

test('below the promise width the dock is NOT a column — that is the Drawer branch, not a second breakpoint', () => {
  const min = minContentWidthForDockPx();
  assert.equal(min, 1010);
  assert.ok(dockFitsBeside(min), 'the boundary itself keeps the promise');
  assert.ok(!dockFitsBeside(min - 1), 'one pixel narrower and the object is starved');
  assert.ok(!dockFitsBeside(960));
});

test('the dock promise is arithmetic, not a guess: it holds for every width above the boundary', () => {
  for (const width of [1010, 1100, 1280, 1440, 1920, 2560]) {
    assert.ok(dockFitsBeside(width), `expected the dock to fit beside the object at ${width}px`);
  }
});
