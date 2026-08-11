/**
 * T17.6b — the edit-mode toolbar's reduction to floating pills (pure half).
 *
 * The PDF (`docs/design/marginalia-concept-b-final.pdf`) draws three pills at
 * the viewport's top right: `● Editing`, `Attention N`, `Release`. Wolf's
 * 2026-08-11 ruling on the brief's Q1 — *"keep 'exit' visible"* — keeps
 * `Exit` as its own always-visible pill rather than folding it into the
 * `● Editing` popover, so what is BUILT is four pills, not three: `Exit` is
 * never hidden behind a popover, a menu, or a hover state.
 *
 * `Pending N` and the signed-in email move into the `● Editing` popover (Q2,
 * proposed and built): the pill still shows a numeral when there is a count
 * worth surfacing, so the tray's contents are never invisible without opening
 * anything. The permanent centred status line becomes a transient toast (Q3,
 * proposed and built) — its timing model is `ToastState` below.
 *
 * Spec: docs/design/marginalia-affordance-model.md §7;
 * docs/cms-architecture/cms-pipeline/T17.6b-toolbar-reduction.md.
 */

export type ToolbarInputs = {
  /** Objects with unpublished changes anywhere — what the tray publishes. */
  pendingCount: number;
  /** Open comment threads on this page (attention.ts's `pageAttentionTotal`). */
  attentionCount: number;
  /** Whether this session's role can execute a release (`canExecutePublish`). */
  canPublish: boolean;
};

export type ToolbarPillKey = 'editing' | 'attention' | 'release' | 'exit';

export type ToolbarPill = {
  key: ToolbarPillKey;
  label: string;
  /** The numeral badge on the pill's face; absent when there is nothing to show. */
  badge?: number;
  disabled: boolean;
  /** The full phrase a shortened label keeps as its accessible/hover title. */
  title?: string;
};

export type ToolbarPopoverRowKey = 'email' | 'status' | 'pending';

export type ToolbarPopoverRow = {
  key: ToolbarPopoverRowKey;
  badge?: number;
};

export type ToolbarPlan = {
  pills: ToolbarPill[];
  popoverRows: ToolbarPopoverRow[];
};

/** `Release`'s full phrase, kept as its `title` once the label is shortened. */
export const RELEASE_TITLE = 'Release to production';
/** Matches today's `[data-em-release]` disabled title, unchanged by this task. */
export const RELEASE_DISABLED_TITLE = 'Requires publisher role';

/**
 * The whole toolbar, as a plan of pills plus the `● Editing` popover's rows —
 * what `mountEditMode` renders and updates, never computes ad hoc inline.
 *
 * Order is the PDF's, `Exit` appended per Wolf's ruling: `● Editing` ·
 * `Attention N` · `Release` · `Exit`.
 */
export const toolbarLayout = (inputs: ToolbarInputs): ToolbarPlan => {
  const { pendingCount, attentionCount, canPublish } = inputs;
  return {
    pills: [
      {
        key: 'editing',
        label: 'Editing',
        disabled: false,
        // Q2 (proposed, built): the pending count surfaces as a numeral on
        // the pill itself so it is never invisible without opening the
        // popover — but only when there is something to see; an empty badge
        // on every page would just be noise.
        ...(pendingCount > 0 ? { badge: pendingCount } : {}),
      },
      // Attention: unchanged behaviour and definition (spec §4.3) — restyled
      // as a pill, nothing else about it changes here.
      { key: 'attention', label: 'Attention', disabled: false, badge: attentionCount },
      {
        key: 'release',
        label: 'Release',
        disabled: !canPublish,
        title: canPublish ? RELEASE_TITLE : RELEASE_DISABLED_TITLE,
      },
      // Q1 — Wolf, 2026-08-11: "keep 'exit' visible." Its own pill, always
      // visible, always one click; never folded into the popover.
      { key: 'exit', label: 'Exit', disabled: false },
    ],
    popoverRows: [{ key: 'email' }, { key: 'status' }, { key: 'pending', badge: pendingCount }],
  };
};

// ── the status line's toast (spec §9; brief Q3, proposed and built) ────────

/** ~4s, per the brief's proposal. */
export const TOAST_VISIBLE_MS = 4000;

export type ToastState = {
  /** The status text. Never cleared by fading — that is the retention rule. */
  message: string;
  /** Whether the toast is currently shown; the message survives either way. */
  visible: boolean;
};

/** A new status arrives: it is shown immediately (or hidden, for an empty clear). */
export const postStatus = (message: string): ToastState => ({ message, visible: message.length > 0 });

/**
 * The toast fading after ~4s. Only `visible` changes — the message is
 * retained, which is what lets a missed confirmation still be read wherever
 * the popover shows the last status line.
 */
export const fadeToast = (state: ToastState): ToastState => ({ ...state, visible: false });
