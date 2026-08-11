/**
 * The canvas's single affordance state machine (T17.14a) — the pure half.
 *
 * **One block shows one affordance.** Hovering, focusing or working on a block
 * reveals exactly one surface for it — its margin bubble — plus its gutter
 * marker. Before this module the canvas ran TWO machines with no shared state:
 * the W7 hover chip (0ms reveal, `hotRegion` + `chipHideTimer`) and the T17.3
 * rail bubble (120ms reveal, `revealedRegion` / `pinnedRegion` / `pinnedKey` +
 * two more timers). They coordinated only by one reading the other's rendered
 * height, `focusin` drove the rail alone, and a keyboard user therefore got a
 * bubble and no chip — i.e. no pencil, no image, no role, no delete.
 *
 * Everything here is a function of plain data so the transition table, the
 * timer selection and the invariants are unit-tested headlessly — the same
 * discipline rail-layout.ts / attention.ts / draft-provenance.ts follow in this
 * directory (the repo has no DOM test harness on purpose). ui.ts owns the DOM
 * and the actual `setTimeout`s; this owns *what should happen*.
 *
 * Spec: docs/design/marginalia-affordance-model.md §4 (§4.1 the state, §4.2 the
 * timers, §4.3 the transition table, §4.4 keyboard parity).
 */

/** `hidden` — nothing beside the block. `revealed` — decays. `pinned` — stays. */
export type AffordancePhase = 'hidden' | 'revealed' | 'pinned';

/** What put the affordance in its phase. Drives timing: pointers wait, keyboards do not. */
export type AffordanceSource = 'pointer' | 'keyboard' | 'programmatic';

/** §4.2 — the pointer's reveal debounce. The chip's 0ms reveal is deleted with the chip. */
export const REVEAL_MS = 120;
/** §4.2 — the dismiss grace period, unchanged from T17.3's `RAIL_DISMISS_MS`. */
export const DISMISS_MS = 250;

/**
 * §4.2's whole table: a pointer reveal is debounced, a keyboard focus is not
 * (a focus is deliberate, so there is nothing to debounce), and a programmatic
 * reveal — an opened panel, a list row — is immediate for the same reason.
 */
export const revealDelayFor = (source: AffordanceSource): number => (source === 'pointer' ? REVEAL_MS : 0);

/**
 * §4.1. `region` is the block element in ui.ts and a plain string in the
 * tests, hence the type parameter: nothing here touches the DOM.
 */
export type AffordanceState<R = unknown> = {
  phase: AffordancePhase;
  /** The block the affordance addresses; undefined iff phase === 'hidden'. */
  region?: R;
  /** Its anchor key — rail-layout.ts's `marginaliaAnchorKey`, the rail's identity. */
  key?: string;
  source: AffordanceSource;
  /** The footer chevron's drawer. Reset to false on every region change. */
  drawerOpen: boolean;
};

export type AffordanceEvent<R = unknown> =
  /** The pointer (or a focus, with `source: 'keyboard'`) landed on a block. */
  | { kind: 'hover'; region: R; key: string; source: AffordanceSource }
  /** The pointer is over the rail, a bubble, the drawer, the gutter or the panel. */
  | { kind: 'hoverSurface' }
  /** The pointer resolved to no block and no canvas surface. */
  | { kind: 'hoverAway' }
  /** A scheduled reveal came due (or an undebounced one fired straight away). */
  | { kind: 'reveal'; region: R; key: string; source: AffordanceSource }
  /** The dismiss timer came due. */
  | { kind: 'dismissDue' }
  | { kind: 'pin'; region: R; key: string; source: AffordanceSource; focusComposer?: boolean }
  /** Click / Enter / Space on the block's gutter marker — a toggle. */
  | { kind: 'markerActivate'; region: R; key: string }
  /** The footer chevron. */
  | { kind: 'toggleDrawer' }
  | { kind: 'escape' }
  /** A click outside the bubble; `region`/`key` when it landed on another block. */
  | { kind: 'outsideClick'; region?: R; key?: string }
  /** The docked panel opened for a block — it pins, and the rail yields (§5.1). */
  | { kind: 'panelOpen'; region: R; key: string }
  /** Edit mode off, or a remount: back to nothing. */
  | { kind: 'reset' };

/** What ui.ts should do with a timer: leave it, clear it, or (re)start it. */
export type TimerCommand = 'keep' | 'cancel' | { after: number };

/** Focus is moved on an explicit pin and on Escape — never on a hover reveal (§4.4). */
export type FocusCommand = 'none' | 'composer' | 'marker';

export type AffordanceStep<R = unknown> = {
  state: AffordanceState<R>;
  reveal: TimerCommand;
  dismiss: TimerCommand;
  focus: FocusCommand;
};

/**
 * §4.1 invariant 4: while a block is inline-edited its bubble stays pinned and
 * no other block may leave `hidden` — comments about the thing you are editing
 * are the point, comments about its neighbour are an interruption.
 */
export type AffordanceContext = { inlineEditKey?: string };

export const hiddenAffordance = <R = unknown>(): AffordanceState<R> => ({
  phase: 'hidden',
  source: 'programmatic',
  drawerOpen: false,
});

const revealedAt = <R>(region: R, key: string, source: AffordanceSource): AffordanceState<R> => ({
  phase: 'revealed',
  region,
  key,
  source,
  drawerOpen: false,
});

const pinnedAt = <R>(
  state: AffordanceState<R>,
  region: R,
  key: string,
  source: AffordanceSource
): AffordanceState<R> => ({
  phase: 'pinned',
  region,
  key,
  source,
  // Pinning a DIFFERENT block resets the drawer (§4.3, last rows); re-pinning
  // the one already pinned — a click inside its own bubble — must not close it.
  drawerOpen: state.phase === 'pinned' && state.key === key ? state.drawerOpen : false,
});

const step = <R>(
  state: AffordanceState<R>,
  reveal: TimerCommand = 'keep',
  dismiss: TimerCommand = 'keep',
  focus: FocusCommand = 'none'
): AffordanceStep<R> => ({ state, reveal, dismiss, focus });

/** True while `key` is the block the canvas is currently addressing. */
export const affordanceAddresses = <R>(state: AffordanceState<R>, key: string | undefined): boolean =>
  state.phase !== 'hidden' && key !== undefined && state.key === key;

/** The pinned key, or undefined — the rail's "which bubble is sticky" question. */
export const pinnedAffordanceKey = <R>(state: AffordanceState<R>): string | undefined =>
  state.phase === 'pinned' ? state.key : undefined;

/**
 * §4.1's invariants, as a list of violations so a test can name the one that
 * broke. Invariant 1 ("at most one non-hidden region on the page") is
 * structural — there is one state object — and is proven by the reducer never
 * producing a second one, which the transition tests walk.
 */
export const affordanceInvariantViolations = <R>(state: AffordanceState<R>): string[] => {
  const violations: string[] = [];
  if ((state.phase === 'hidden') !== (state.region === undefined)) {
    violations.push('invariant 2: phase === "hidden" must be exactly when there is no region');
  }
  if ((state.region === undefined) !== (state.key === undefined)) {
    violations.push('invariant 2: a region and its anchor key travel together');
  }
  if (state.drawerOpen && state.phase !== 'pinned') {
    violations.push('invariant 3: a drawer cannot live on a surface that decays under the pointer');
  }
  return violations;
};

/**
 * The §4.3 transition table, one `switch`. Returns the next state plus what to
 * do with the two timers and the focus — ui.ts performs those; nothing is
 * performed here.
 */
export const affordanceReduce = <R>(
  state: AffordanceState<R>,
  event: AffordanceEvent<R>,
  context: AffordanceContext = {}
): AffordanceStep<R> => {
  const editing = context.inlineEditKey;
  switch (event.kind) {
    case 'hover': {
      // Inline edit holds the surface: a neighbour may not take it (invariant 4).
      if (editing !== undefined && editing !== event.key) return step(state, 'cancel', 'cancel');
      // Pinning is what survives the pointer — a hover elsewhere never opens a
      // second card, which is the whole one-affordance rule (invariant 1).
      if (state.phase === 'pinned') return step(state, 'cancel', 'cancel');
      if (state.phase === 'revealed' && state.key === event.key) return step(state, 'cancel', 'cancel');
      // A pending reveal for another block is REPLACED, not queued; the block
      // already revealed stays up until the new one is due.
      return step(state, { after: revealDelayFor(event.source) }, 'cancel');
    }
    case 'reveal': {
      if (editing !== undefined && editing !== event.key) return step(state, 'cancel', 'cancel');
      if (state.phase === 'pinned') return step(state, 'cancel', 'cancel');
      if (state.phase === 'revealed' && state.key === event.key) return step(state, 'cancel', 'cancel');
      return step(revealedAt(event.region, event.key, event.source), 'cancel', 'cancel');
    }
    case 'hoverSurface':
      // The pointer is on the affordance itself: nothing decays, nothing new opens.
      return step(state, 'cancel', 'cancel');
    case 'hoverAway': {
      if (state.phase === 'revealed') return step(state, 'cancel', { after: DISMISS_MS });
      return step(state, 'cancel', 'cancel');
    }
    case 'dismissDue': {
      if (state.phase !== 'revealed') return step(state, 'keep', 'cancel');
      return step(hiddenAffordance<R>(), 'cancel', 'cancel');
    }
    case 'pin':
      return step(
        pinnedAt(state, event.region, event.key, event.source),
        'cancel',
        'cancel',
        event.focusComposer ? 'composer' : 'none'
      );
    case 'markerActivate': {
      // The marker is a toggle: pressing the open block's marker closes it.
      if (state.phase === 'pinned' && state.key === event.key) return step(hiddenAffordance<R>(), 'cancel', 'cancel');
      return step(pinnedAt(state, event.region, event.key, 'keyboard'), 'cancel', 'cancel', 'composer');
    }
    case 'toggleDrawer': {
      if (state.phase === 'hidden' || state.region === undefined || state.key === undefined) return step(state);
      if (state.phase === 'revealed') {
        // A drawer on a decaying surface violates invariant 3, so one click
        // does two things: pin, then open.
        return step(
          { ...pinnedAt(state, state.region, state.key, state.source), drawerOpen: true },
          'cancel',
          'cancel'
        );
      }
      return step({ ...state, drawerOpen: !state.drawerOpen }, 'cancel', 'cancel');
    }
    case 'escape': {
      // First Escape closes the drawer; the second unpins and hands focus back
      // to the gutter marker (never to the region — a display:contents article
      // wrapper may not be focusable, which T17.8's build log flagged).
      if (state.phase === 'pinned' && state.drawerOpen) return step({ ...state, drawerOpen: false }, 'keep', 'keep');
      if (state.phase === 'pinned') return step(hiddenAffordance<R>(), 'cancel', 'cancel', 'marker');
      if (state.phase === 'revealed') return step(hiddenAffordance<R>(), 'cancel', 'cancel');
      return step(state);
    }
    case 'outsideClick': {
      if (state.phase !== 'pinned') return step(state);
      // The click landed on ANOTHER block: unpin and reveal that one straight
      // away, rather than leaving the canvas blank until the pointer moves.
      if (event.region !== undefined && event.key !== undefined) {
        return step(revealedAt(event.region, event.key, 'pointer'), 'cancel', 'cancel');
      }
      return step(hiddenAffordance<R>(), 'cancel', 'cancel');
    }
    case 'panelOpen':
      return step(pinnedAt(state, event.region, event.key, 'programmatic'), 'cancel', 'cancel');
    case 'reset':
      return step(hiddenAffordance<R>(), 'cancel', 'cancel');
  }
};
