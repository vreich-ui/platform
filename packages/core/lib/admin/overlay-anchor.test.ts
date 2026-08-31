import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { anchorPosition, popoverReducer, INITIAL_POPOVER_STATE } from './overlay-anchor.js';
import type { PopoverState } from './overlay-anchor.js';

describe('popoverReducer', () => {
  it('opens on focus after the delay elapses (arms first, only opens once the timer fires)', () => {
    const armed = popoverReducer(INITIAL_POPOVER_STATE, { type: 'trigger-focus' });
    assert.deepEqual(armed, { open: false, armed: true });
    const opened = popoverReducer(armed, { type: 'delay-elapsed' });
    assert.deepEqual(opened, { open: true, armed: false });
  });

  it('hover arms a delay rather than opening immediately', () => {
    const state = popoverReducer(INITIAL_POPOVER_STATE, { type: 'trigger-enter' });
    assert.equal(state.open, false, 'must not open synchronously on enter');
    assert.equal(state.armed, true);
  });

  it('leaving before the delay elapses disarms it — a later delay-elapsed does nothing', () => {
    const armed = popoverReducer(INITIAL_POPOVER_STATE, { type: 'trigger-enter' });
    const left = popoverReducer(armed, { type: 'trigger-leave' });
    assert.deepEqual(left, { open: false, armed: false });
    const stale = popoverReducer(left, { type: 'delay-elapsed' });
    assert.deepEqual(stale, left, 'a stale timer callback must not reopen it');
  });

  it('blur closes an open tooltip', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.deepEqual(popoverReducer(open, { type: 'trigger-blur' }), { open: false, armed: false });
  });

  it('Esc closes whether open or merely armed', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.deepEqual(popoverReducer(open, { type: 'escape' }), { open: false, armed: false });
    const armed: PopoverState = { open: false, armed: true };
    assert.deepEqual(popoverReducer(armed, { type: 'escape' }), { open: false, armed: false });
  });

  it('outside click closes an open popover', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.deepEqual(popoverReducer(open, { type: 'outside' }), { open: false, armed: false });
  });

  it('click-toggle opens from closed and closes from open, without arming a delay', () => {
    const opened = popoverReducer(INITIAL_POPOVER_STATE, { type: 'click-toggle' });
    assert.deepEqual(opened, { open: true, armed: false });
    const closed = popoverReducer(opened, { type: 'click-toggle' });
    assert.deepEqual(closed, { open: false, armed: false });
  });

  /**
   * REGRESSION (FIX 2). A click-mode panel renders INSIDE the trigger
   * wrapper, so a click on the panel's own content bubbles to the same
   * listener the trigger's click reaches. The component tells the two apart
   * by containment; the reducer states what each one MEANS, so "using the
   * panel does not dismiss the panel" is pinned somewhere a DOM-less test
   * can reach it. Before this, the settings `Select` behind the gear
   * Popover on /admin/requests closed the panel on first click and could
   * never be changed.
   */
  it('a click INSIDE the open panel leaves it open — only the trigger toggles', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.deepEqual(popoverReducer(open, { type: 'inside' }), open, 'using the panel must not dismiss it');
    // Identity, not just equality: an inside click is a true no-op, so it
    // cannot even cause a re-render.
    assert.equal(popoverReducer(open, { type: 'inside' }), open);
  });

  it('inside and outside clicks on an open panel are opposites', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.equal(popoverReducer(open, { type: 'inside' }).open, true);
    assert.equal(popoverReducer(open, { type: 'outside' }).open, false);
    // …and the trigger's own click still closes it, which is what makes the
    // inside case a genuine third answer rather than a rename of `outside`.
    assert.equal(popoverReducer(open, { type: 'click-toggle' }).open, false);
  });

  it('entering again while already open is a no-op (no redundant arm)', () => {
    const open: PopoverState = { open: true, armed: false };
    assert.deepEqual(popoverReducer(open, { type: 'trigger-enter' }), open);
  });
});

describe('anchorPosition', () => {
  const viewport = { width: 1024, height: 768 };

  it('places the floating box below the trigger by default', () => {
    const trigger = { top: 100, left: 50, width: 80, height: 30 };
    const floating = { width: 200, height: 60 };
    const result = anchorPosition(trigger, floating, viewport, 'bottom');
    assert.equal(result.placement, 'bottom');
    assert.equal(result.top, 100 + 30 + 8); // trigger bottom + gap
    assert.equal(result.left, 50);
  });

  it('flips above when the floating box does not fit below', () => {
    // Trigger near the bottom of a short viewport: little room below, plenty above.
    const smallViewport = { width: 1024, height: 400 };
    const trigger = { top: 370, left: 50, width: 80, height: 20 };
    const floating = { width: 200, height: 150 };
    const result = anchorPosition(trigger, floating, smallViewport, 'bottom');
    assert.equal(result.placement, 'top');
    assert.equal(result.top, 370 - 8 - 150);
  });

  it('does not flip when there is even less room above than below', () => {
    // Trigger near the TOP of the viewport: below has more room than above,
    // so even an oversized floating box should stay below rather than flip
    // into a spot that is worse.
    const trigger = { top: 10, left: 50, width: 80, height: 20 };
    const floating = { width: 200, height: 700 };
    const result = anchorPosition(trigger, floating, viewport, 'bottom');
    assert.equal(result.placement, 'bottom');
  });

  it('clamps left so the floating box never runs past the right edge of the viewport', () => {
    const trigger = { top: 100, left: 900, width: 80, height: 30 };
    const floating = { width: 300, height: 60 };
    const result = anchorPosition(trigger, floating, viewport, 'bottom');
    // 1024 - 300 - 8 = 716
    assert.equal(result.left, 716);
  });

  it('honours an explicit top placement without flip logic', () => {
    const trigger = { top: 300, left: 50, width: 80, height: 30 };
    const floating = { width: 200, height: 60 };
    const result = anchorPosition(trigger, floating, viewport, 'top');
    assert.equal(result.placement, 'top');
    assert.equal(result.top, 300 - 8 - 60);
  });
});
