/**
 * The single affordance state machine (T17.14a) — every row of the §4.3
 * transition table, the §4.2 timer selection, and the §4.1 invariants.
 *
 * Spec: docs/design/marginalia-affordance-model.md §4.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  affordanceAddresses,
  affordanceInvariantViolations,
  affordanceReduce,
  DISMISS_MS,
  hiddenAffordance,
  pinnedAffordanceKey,
  REVEAL_MS,
  revealDelayFor,
  type AffordanceEvent,
  type AffordanceState,
} from './affordance-state.js';

/** Regions are opaque to the reducer, so the tests use their keys as regions. */
type S = AffordanceState<string>;
const hidden = (): S => hiddenAffordance<string>();

const run = (state: S, events: Array<AffordanceEvent<string>>, context = {}): S => {
  let next = state;
  for (const event of events) {
    next = affordanceReduce(next, event, context).state;
    assert.deepEqual(affordanceInvariantViolations(next), [], `invariant broke after ${event.kind}`);
  }
  return next;
};

const hover = (key: string, source: 'pointer' | 'keyboard' = 'pointer'): AffordanceEvent<string> => ({
  kind: 'hover',
  region: key,
  key,
  source,
});
const reveal = (key: string, source: 'pointer' | 'keyboard' = 'pointer'): AffordanceEvent<string> => ({
  kind: 'reveal',
  region: key,
  key,
  source,
});

describe('the affordance timers (§4.2)', () => {
  it('debounces a pointer and never a keyboard', () => {
    assert.equal(revealDelayFor('pointer'), REVEAL_MS);
    assert.equal(REVEAL_MS, 120);
    assert.equal(revealDelayFor('keyboard'), 0, 'a focus is deliberate — there is nothing to debounce');
    assert.equal(revealDelayFor('programmatic'), 0);
    assert.equal(DISMISS_MS, 250);
  });

  it('schedules the reveal at the source’s own delay, and only the reveal', () => {
    const pointer = affordanceReduce(hidden(), hover('a', 'pointer'));
    assert.deepEqual(pointer.reveal, { after: REVEAL_MS });
    assert.equal(pointer.dismiss, 'cancel', 'a hover always cancels a pending dismiss');
    assert.equal(pointer.state.phase, 'hidden', 'the pointer reveal has not happened yet');
    const keyboard = affordanceReduce(hidden(), hover('a', 'keyboard'));
    assert.deepEqual(keyboard.reveal, { after: 0 });
  });

  it('starts the dismiss timer only when something is revealed', () => {
    const revealed = run(hidden(), [reveal('a')]);
    assert.deepEqual(affordanceReduce(revealed, { kind: 'hoverAway' }).dismiss, { after: DISMISS_MS });
    assert.equal(affordanceReduce(hidden(), { kind: 'hoverAway' }).dismiss, 'cancel');
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]);
    assert.equal(affordanceReduce(pinned, { kind: 'hoverAway' }).dismiss, 'cancel', 'pinning survives hover-out');
    assert.equal(affordanceReduce(pinned, { kind: 'hoverAway' }).state.phase, 'pinned');
  });

  it('keeps everything up while the pointer is on the affordance itself', () => {
    const revealed = run(hidden(), [reveal('a')]);
    const onSurface = affordanceReduce(revealed, { kind: 'hoverSurface' });
    assert.equal(onSurface.dismiss, 'cancel');
    assert.equal(onSurface.reveal, 'cancel');
    assert.equal(onSurface.state, revealed, 'hovering the rail changes no state');
  });
});

describe('reveal and dismiss (§4.3)', () => {
  it('reveals one block and dismisses it when the pointer leaves', () => {
    const revealed = run(hidden(), [hover('a'), reveal('a')]);
    assert.equal(revealed.phase, 'revealed');
    assert.equal(revealed.key, 'a');
    assert.equal(revealed.source, 'pointer');
    const gone = run(revealed, [{ kind: 'hoverAway' }, { kind: 'dismissDue' }]);
    assert.deepEqual(gone, hidden());
  });

  it('replaces a pending reveal for another block rather than queueing it', () => {
    const revealed = run(hidden(), [reveal('a')]);
    const pending = affordanceReduce(revealed, hover('b'));
    assert.deepEqual(pending.reveal, { after: REVEAL_MS });
    assert.equal(pending.state.key, 'a', 'the first block stays up until the second is due');
    assert.equal(run(revealed, [reveal('b')]).key, 'b');
  });

  it('never opens a second card: at most one block is ever non-hidden', () => {
    const state = run(hidden(), [reveal('a'), reveal('b'), hover('c')]);
    assert.equal(state.key, 'b');
    assert.equal(state.phase, 'revealed');
    assert.equal(affordanceAddresses(state, 'b'), true);
    assert.equal(affordanceAddresses(state, 'a'), false);
    assert.equal(affordanceAddresses(hidden(), 'b'), false, 'a hidden affordance addresses nothing');
  });

  it('does not re-reveal the block already revealed', () => {
    const revealed = run(hidden(), [reveal('a')]);
    const again = affordanceReduce(revealed, hover('a'));
    assert.equal(again.state, revealed);
    assert.equal(again.reveal, 'cancel');
  });

  it('lets a hover-out with nothing revealed change nothing', () => {
    assert.deepEqual(run(hidden(), [{ kind: 'hoverAway' }, { kind: 'dismissDue' }]), hidden());
  });
});

describe('pinning (§4.3)', () => {
  it('is not displaced by hovering or focusing another block', () => {
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]);
    assert.equal(pinnedAffordanceKey(pinned), 'a');
    assert.equal(run(pinned, [hover('b'), reveal('b')]).key, 'a');
    assert.equal(run(pinned, [hover('b', 'keyboard'), reveal('b', 'keyboard')]).key, 'a');
  });

  it('moves focus into the composer only when the pin is explicit', () => {
    assert.equal(
      affordanceReduce(hidden(), { kind: 'pin', region: 'a', key: 'a', source: 'keyboard', focusComposer: true }).focus,
      'composer'
    );
    assert.equal(
      affordanceReduce(hidden(), { kind: 'pin', region: 'a', key: 'a', source: 'pointer' }).focus,
      'none',
      'a click INSIDE the bubble pins it — stealing focus back to the composer would fight the user'
    );
    assert.equal(affordanceReduce(run(hidden(), [reveal('a')]), hover('a')).focus, 'none');
  });

  it('toggles from the gutter marker, and focuses the composer when it opens', () => {
    const opened = affordanceReduce(hidden(), { kind: 'markerActivate', region: 'a', key: 'a' });
    assert.equal(opened.state.phase, 'pinned');
    assert.equal(opened.focus, 'composer');
    const closed = affordanceReduce(opened.state, { kind: 'markerActivate', region: 'a', key: 'a' });
    assert.deepEqual(closed.state, hidden(), 'the marker is a toggle');
    const moved = affordanceReduce(opened.state, { kind: 'markerActivate', region: 'b', key: 'b' });
    assert.equal(moved.state.key, 'b', 'another block’s marker moves the pin');
  });

  it('unpins on an outside click, and reveals the block that click landed on', () => {
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]);
    assert.deepEqual(run(pinned, [{ kind: 'outsideClick' }]), hidden());
    const moved = run(pinned, [{ kind: 'outsideClick', region: 'b', key: 'b' }]);
    assert.equal(moved.phase, 'revealed');
    assert.equal(moved.key, 'b');
    const revealed = run(hidden(), [reveal('a')]);
    assert.equal(run(revealed, [{ kind: 'outsideClick' }]).key, 'a', 'an outside click only ever unpins');
  });

  it('pins when the docked panel opens for a block (§5.1)', () => {
    const panel = run(hidden(), [{ kind: 'panelOpen', region: 'a', key: 'a' }]);
    assert.equal(panel.phase, 'pinned');
    assert.equal(panel.source, 'programmatic');
  });

  it('drops everything on reset', () => {
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }, { kind: 'toggleDrawer' }]);
    assert.deepEqual(run(pinned, [{ kind: 'reset' }]), hidden());
  });
});

describe('the block drawer (§4.3, invariant 3)', () => {
  it('pins first and opens second when the chevron is pressed on a revealed bubble', () => {
    const revealed = run(hidden(), [reveal('a')]);
    const opened = run(revealed, [{ kind: 'toggleDrawer' }]);
    assert.equal(opened.phase, 'pinned', 'a drawer may not live on a surface that decays under the pointer');
    assert.equal(opened.drawerOpen, true);
  });

  it('toggles on a pinned bubble and does nothing on a hidden one', () => {
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]);
    const opened = run(pinned, [{ kind: 'toggleDrawer' }]);
    assert.equal(opened.drawerOpen, true);
    assert.equal(run(opened, [{ kind: 'toggleDrawer' }]).drawerOpen, false);
    assert.deepEqual(run(hidden(), [{ kind: 'toggleDrawer' }]), hidden());
  });

  it('resets when the pin moves to another block, and survives re-pinning the same one', () => {
    const opened = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }, { kind: 'toggleDrawer' }]);
    const samePin = run(opened, [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]);
    assert.equal(samePin.drawerOpen, true, 'clicking inside the bubble re-pins it — that must not close the drawer');
    const moved = run(opened, [{ kind: 'pin', region: 'b', key: 'b', source: 'pointer' }]);
    assert.equal(moved.drawerOpen, false);
    const marker = run(opened, [{ kind: 'markerActivate', region: 'b', key: 'b' }]);
    assert.equal(marker.drawerOpen, false);
  });
});

describe('Escape (§4.3, §4.4)', () => {
  it('closes the drawer first and unpins second, returning focus to the marker', () => {
    const opened = run(hidden(), [
      { kind: 'pin', region: 'a', key: 'a', source: 'keyboard' },
      { kind: 'toggleDrawer' },
    ]);
    const first = affordanceReduce(opened, { kind: 'escape' });
    assert.equal(first.state.phase, 'pinned');
    assert.equal(first.state.drawerOpen, false);
    assert.equal(first.focus, 'none');
    const second = affordanceReduce(first.state, { kind: 'escape' });
    assert.deepEqual(second.state, hidden());
    assert.equal(second.focus, 'marker', 'a display:contents wrapper may not be focusable — the marker always is');
  });

  it('dismisses a revealed bubble and is a no-op on a hidden one', () => {
    assert.deepEqual(affordanceReduce(run(hidden(), [reveal('a')]), { kind: 'escape' }).state, hidden());
    const idle = affordanceReduce(hidden(), { kind: 'escape' });
    assert.deepEqual(idle.state, hidden());
    assert.equal(idle.focus, 'none');
  });
});

describe('inline edit holds the surface (invariant 4)', () => {
  it('suppresses every other block’s reveal while a block is being edited', () => {
    const editing = { inlineEditKey: 'a' };
    const pinned = run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'programmatic' }], editing);
    const hovered = affordanceReduce(pinned, hover('b'), editing);
    assert.equal(hovered.reveal, 'cancel', 'no reveal may even be scheduled for a neighbour');
    assert.equal(hovered.state.key, 'a');
    assert.equal(affordanceReduce(hidden(), reveal('b'), editing).state.phase, 'hidden');
    assert.equal(
      affordanceReduce(hidden(), hover('a'), editing).reveal !== 'cancel',
      true,
      'the edited block itself is fine'
    );
  });
});

describe('the §4.1 invariants', () => {
  it('names each violation it can see', () => {
    assert.deepEqual(affordanceInvariantViolations(hidden()), []);
    assert.match(
      affordanceInvariantViolations({
        phase: 'hidden',
        region: 'a',
        key: 'a',
        source: 'pointer',
        drawerOpen: false,
      })[0],
      /invariant 2/
    );
    assert.match(
      affordanceInvariantViolations({
        phase: 'revealed',
        region: 'a',
        key: 'a',
        source: 'pointer',
        drawerOpen: true,
      })[0],
      /invariant 3/
    );
    assert.match(
      affordanceInvariantViolations({ phase: 'revealed', region: 'a', source: 'pointer', drawerOpen: false })[0],
      /travel together/
    );
  });

  it('holds across every event from every phase', () => {
    const events: Array<AffordanceEvent<string>> = [
      hover('b'),
      hover('b', 'keyboard'),
      reveal('b'),
      { kind: 'hoverSurface' },
      { kind: 'hoverAway' },
      { kind: 'dismissDue' },
      { kind: 'pin', region: 'b', key: 'b', source: 'pointer' },
      { kind: 'markerActivate', region: 'b', key: 'b' },
      { kind: 'toggleDrawer' },
      { kind: 'escape' },
      { kind: 'outsideClick' },
      { kind: 'panelOpen', region: 'b', key: 'b' },
      { kind: 'reset' },
    ];
    const phases: S[] = [
      hidden(),
      run(hidden(), [reveal('a')]),
      run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }]),
      run(hidden(), [{ kind: 'pin', region: 'a', key: 'a', source: 'pointer' }, { kind: 'toggleDrawer' }]),
    ];
    for (const start of phases) {
      for (const first of events) {
        for (const second of events) run(start, [first, second]);
      }
    }
  });
});
