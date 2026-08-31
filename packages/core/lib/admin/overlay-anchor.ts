/**
 * Admin kit — Popover/Tooltip (T0): pure positioning + open/close logic,
 * extracted so it can be unit-tested without a DOM (this repo's test
 * convention — see BRIEF.md; `packages/core/admin/**\/*.tsx` is excluded from
 * `tsconfig.test.json`). `overlays.tsx`'s `Popover` component consumes both
 * `anchorPosition` and `popoverReducer` and holds only refs/timers on top.
 */

// ─── anchorPosition ───────────────────────────────────────────────────────────

/** A trigger's viewport-relative box, as `Element.getBoundingClientRect()` gives it. */
export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** The floating element's own (unpositioned) size. */
export interface Size {
  width: number;
  height: number;
}

export type Placement = 'top' | 'bottom';

export interface AnchoredPosition {
  top: number;
  left: number;
  /** The placement actually used — may differ from the requested one (flip). */
  placement: Placement;
}

/** Gap kept between the trigger and the floating element. */
const ANCHOR_GAP = 8;
/** Margin kept off the viewport edge on every side. */
const ANCHOR_VIEWPORT_MARGIN = 8;

/**
 * Where to place a `position: fixed` floating element relative to its
 * trigger. Defaults to below the trigger; flips above when the floating box
 * does not fit in the remaining space below (mirrors `DropdownMenu`'s flip
 * rule in menus.tsx, so the kit's two anchored-panel primitives agree) —
 * `above > below` guards against flipping into a spot with even less room.
 * Horizontal placement is left-aligned to the trigger, clamped so the panel
 * never runs past the viewport edge.
 */
export function anchorPosition(
  trigger: Rect,
  floating: Size,
  viewport: Size,
  placement: Placement = 'bottom'
): AnchoredPosition {
  const below = viewport.height - (trigger.top + trigger.height) - ANCHOR_GAP - ANCHOR_VIEWPORT_MARGIN;
  const above = trigger.top - ANCHOR_GAP - ANCHOR_VIEWPORT_MARGIN;
  const flip = placement === 'bottom' && floating.height > below && above > below;
  const finalPlacement: Placement = flip ? 'top' : placement;

  const top =
    finalPlacement === 'top'
      ? Math.max(ANCHOR_VIEWPORT_MARGIN, trigger.top - ANCHOR_GAP - floating.height)
      : trigger.top + trigger.height + ANCHOR_GAP;

  const maxLeft = Math.max(ANCHOR_VIEWPORT_MARGIN, viewport.width - floating.width - ANCHOR_VIEWPORT_MARGIN);
  const left = Math.min(Math.max(ANCHOR_VIEWPORT_MARGIN, trigger.left), maxLeft);

  return { top, left, placement: finalPlacement };
}

// ─── popoverReducer ───────────────────────────────────────────────────────────

export interface PopoverState {
  open: boolean;
  /** True while the hover-mode open delay is ticking (armed but not open yet). */
  armed: boolean;
}

export const INITIAL_POPOVER_STATE: PopoverState = { open: false, armed: false };

export type PopoverEvent =
  /** Hover mode: pointer entered the trigger. */
  | { type: 'trigger-enter' }
  /** Hover mode: the trigger received keyboard focus. Arms the same delay as
   * `trigger-enter` — a keyboard user gets the same open behaviour a mouse
   * user does, per the spec's "opens on hover AND on keyboard focus". */
  | { type: 'trigger-focus' }
  /** The component's own delay timer elapsed since the last enter/focus. */
  | { type: 'delay-elapsed' }
  /** Hover mode: pointer left the trigger/tooltip. */
  | { type: 'trigger-leave' }
  /** Hover mode: focus moved away from the trigger. */
  | { type: 'trigger-blur' }
  /** Esc while open (or armed) — both modes. */
  | { type: 'escape' }
  /** Click mode: a click/pointerdown landed outside the trigger and panel. */
  | { type: 'outside' }
  /**
   * Click mode: a click landed INSIDE the open panel — on a control the
   * panel exists to offer (a `Select`, a button). The panel is a DOM
   * descendant of the trigger wrapper, so such a click bubbles to the same
   * listener a trigger click does; without this event it read as
   * `click-toggle` and shut the panel the moment anyone tried to use it.
   * It is deliberately a NO-OP rather than an absent case: "using the panel
   * does not dismiss the panel" is a rule worth stating and testing, not an
   * accident of which events the component happens to send.
   */
  | { type: 'inside' }
  /** Click mode: the trigger was clicked. */
  | { type: 'click-toggle' };

/**
 * The open/close state machine shared by both `Popover` modes. Hover mode
 * arms a delay on enter/focus rather than opening immediately (200ms,
 * enforced by the component's timer — this reducer only tracks that the
 * delay is pending) and tears the delay down again on any leave/blur/Esc
 * before it fires. Click mode never arms; it toggles straight to `open`.
 */
export function popoverReducer(state: PopoverState, event: PopoverEvent): PopoverState {
  switch (event.type) {
    case 'trigger-enter':
    case 'trigger-focus':
      // Already open (e.g. pointer moved from trigger onto the tooltip
      // itself) — arming a redundant delay would do nothing useful.
      return state.open ? state : { open: false, armed: true };
    case 'delay-elapsed':
      // A leave/blur/Esc between arming and the timer firing already
      // disarmed this — the component also clears the timeout itself, but
      // the reducer stays correct even if a stale callback still fires.
      return state.armed ? { open: true, armed: false } : state;
    case 'trigger-leave':
    case 'trigger-blur':
    case 'escape':
    case 'outside':
      return state.open || state.armed ? { open: false, armed: false } : state;
    case 'inside':
      // The panel's own content was clicked — nothing changes. Only the
      // trigger toggles, and only an OUTSIDE click dismisses.
      return state;
    case 'click-toggle':
      return { open: !state.open, armed: false };
    default:
      return state;
  }
}
