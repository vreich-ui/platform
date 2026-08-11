/**
 * Edit-mode canvas — the on-page overlay (admin-only, loaded on demand).
 *
 * The site itself is the editing surface: every annotated section gets a
 * hover chip with "Ask AI"; a request opens a docked panel; the suggestion
 * previews IN PLACE as an amber draft; Accept persists it through the
 * reviewable object_patch path (checkout → patch, EditSession); Publish and
 * Release stay separate, deliberate acts in the pending tray — the same
 * draft → publish → release lifecycle every agent follows, driven by a human
 * on the live page.
 *
 * Article bodies: OBJECT-BACKED articles (content_item, W7.3) render each
 * node with data-cms-node-* identity, so article prose grows chips too —
 * node edits ride the SAME EditSession → update_node → publish path (the
 * OQ-8 stop line lifted at W7.8). Legacy .md posts carry no annotations and
 * stay read-only on the canvas.
 *
 * Remount-safe for Astro view transitions: a body swap removes the injected
 * chrome, so boot calls mountEditMode again — the previous mount's
 * document-level listeners die with its AbortController, and object sessions
 * (locks!) live at module scope so a swap never orphans a held lease.
 *
 * DOM-heavy by nature — the routing/merge logic it drives lives in the pure,
 * unit-tested modules (targets.ts, preview.ts, verbs-client.ts).
 */
import { captureObjectSelection } from '../admin/ask-ai-object-selection.js';
import {
  buildLearningEvidenceOp,
  buildManualRichTextEdits,
  scopeKeyFor,
  type AccumulatedProposal,
  type ManualRichTextEdit,
} from '../admin/agent-learning-trail.js';
import { SECTION_PALETTE, insertPositionFor } from './sections-palette.js';
import { NODE_PALETTE } from './nodes-palette.js';
import {
  changedFieldsOnly,
  deriveEditTarget,
  deriveNavTarget,
  deriveNodeTarget,
  suggestionToOps,
  summarizeFieldChanges,
  type EditTarget,
  type FieldChange,
} from './targets.js';
import {
  derivePrimaryInlineField,
  inlineEditOps,
  inlineToolbarModeFor,
  inlineValueBlockTexts,
  shouldCaptureSelection,
  NON_COPY_KEY_RE,
  type InlineField,
} from './inline-edit.js';
import type { InlineToolbarHandle, RichTextEditorHandle } from './richtext-editor.js';
import { applyNavChangesToBody, navChangesToOps, navEditFieldsFor, type NavEditField } from './nav-editor.js';
import type { NavigationBody } from '../../schema/bodies/navigation-v1.js';
import { activeMediaPolicy } from '../../lib/media-policy.js';
import { getSiteIdentity } from '../../lib/site-identity.js';
import {
  findBlockElements,
  previewFieldChange,
  restoreRegion,
  snapshotRegion,
  type RegionSnapshot,
} from './preview.js';
import { mountMarginaliaPanel, type MarginaliaPanelTarget } from './marginalia-panel.js';
import {
  blockAttentionCounts,
  gutterMarkerState,
  markerAriaLabel,
  pageAttentionTotal,
  type BlockAttention,
} from './attention.js';
import {
  collapseThreadStack,
  isBlockAnchor,
  marginaliaAnchorKey,
  packRailEntries,
  partitionRailThreads,
  railLeftFor,
  railWidthFor,
  selectRailLayoutMode,
  type RailLayoutMode,
  type RailMetrics,
  type RailPartition,
} from './rail-layout.js';
import { listMarginaliaThreads } from '../admin/marginalia-client.js';
import type { MarginaliaThreadWithComments } from '../../schema/marginalia-v1.js';
import {
  STYLES,
  ICON_SPARKLES,
  ICON_PENCIL,
  ICON_IMAGE,
  ICON_PLUS,
  ICON_TRASH,
  ICON_TAG,
  ICON_CHEVRON,
  ICON_CHECK,
  ICON_CLOSE,
  ICON_UPLOAD,
  ICON_UNDO,
  ICON_SEND,
  ICON_COMMENT,
} from './ui-chrome.js';
import {
  askAiSuggestion,
  callObjectVerb,
  canExecutePublish,
  EditSession,
  ensureBlobBackedImage,
  fetchPendingObjects,
  getObjectRecord,
  releaseToProduction,
  uploadImageArtifact,
  type GetToken,
  type PendingObjectRow,
} from './verbs-client.js';

const REGION_SELECTOR = '[data-cms-section-id]';
const NAV_SELECTOR = '[data-cms-nav-object]';
const NODE_SELECTOR = '[data-cms-node-id]';
const EMPTY_OBJECT_SELECTOR = '[data-cms-empty-object]';
const MODE_KEY = 'dl-edit-mode';

// Margin-rail geometry (T17.3) — the same numbers ui-chrome.ts declares as
// --dlem-rail-* tokens; the CSS paints with them, this module does the math.
const RAIL_W = 344;
/** The narrowest a `compact` rail gets before the ladder drops to markers-only. */
const RAIL_MIN_W = 260;
const RAIL_GAP = 24;
const RAIL_PAD = 8;
/** Vertical gap between packed bubbles, and the rail's top clearance under the bar. */
const RAIL_STACK_GAP = 8;
const RAIL_TOP = 46;
/** Below this viewport width there is no rail — the bottom sheet serves (spec §1.3). */
const RAIL_SHEET_FLOOR = 900;
/** Gutter-marker centre, left of the block's leading edge (spec §4.2). */
const GUTTER_X = 28;
/** The formatting bubble flips below the selection rather than hide under the bar. */
const INLINE_TOOLBAR_TOP_GUARD = RAIL_TOP;
/** Reveal on pointer enter; dismiss on leave (the value clearChipSoon already used). */
const RAIL_REVEAL_MS = 120;
const RAIL_DISMISS_MS = 250;

export type MountOptions = { email: string; roles: string[]; getToken: GetToken };

/**
 * What the panel is doing: AI chat, manual text form, the image tool, or the
 * role/annotation and article-settings editors. Comments left the panel in
 * T17.3 — they live in the margin rail now, not in an accordion section.
 */
type PanelMode = 'ai' | 'edit' | 'image' | 'role' | 'meta';

type PanelState = {
  target: EditTarget;
  region: HTMLElement;
  mode: PanelMode;
  /** The section's data in the DRAFT record (source of truth for diffs). */
  currentData: Record<string, unknown>;
  /** The instance id the PATCH scopes to (inner id for shared objects). */
  patchSectionId: string;
  selectedText?: string;
  /** Armed "Re: <image>" reference (AI chat image chips) — sent with every ask. */
  imageRef?: { field: string; name: string; url: string };
  /** Navigation targets: the object body the copy form edits (nav grammar ops). */
  navBody?: NavigationBody;
  /** Article-node targets: the node's current annotations (the role editor's before-state). */
  nodePrivate?: { strategy?: string; intent?: string; agentNotes?: string };
  /** Article targets: the body-level metadata the settings form edits (T9.20). */
  articleMeta?: Record<string, unknown>;
  suggestion?: Record<string, unknown>;
  changes?: FieldChange[];
  snapshot?: RegionSnapshot;
};

/** Section types whose data carries an image the image tool should offer. */
const IMAGE_SECTION_TYPES = new Set(['bio', 'content_split']);

const isImageValue = (value: unknown): value is { src: string; alt?: string } =>
  Boolean(value) &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  typeof (value as { src?: unknown }).src === 'string';

const imageBasename = (src: string): string => src.split('/').pop()?.split('?')[0] || src;

/** Every image a section's data carries, flattened (arrays → field.<index>). */
const imageEntriesFor = (data: Record<string, unknown>): Array<{ field: string; src: string; name: string }> => {
  const entries: Array<{ field: string; src: string; name: string }> = [];
  for (const [key, value] of Object.entries(data)) {
    if (isImageValue(value)) {
      entries.push({ field: key, src: value.src, name: imageBasename(value.src) });
    } else if (Array.isArray(value) && value.length > 0 && value.every(isImageValue)) {
      value.forEach((item, index) =>
        entries.push({ field: `${key}.${index}`, src: item.src, name: imageBasename(item.src) })
      );
    }
  }
  return entries;
};

// Locks survive view-transition remounts: sessions are module state, not mount state.
const sessions = new Map<string, EditSession>();
let activeController: AbortController | undefined;

// S4x (2/2): every Ask-AI round the editor asks for, per object/section/node,
// held ONLY in memory — never sent anywhere on its own. A save for the same
// scope ships the tagged trail alongside the patch it already sends
// (attachLearningTrail/clearLearningTrail below); nothing here survives a
// navigate-away without a save, same lifetime discipline as `sessions`.
const proposalTrails = new Map<string, AccumulatedProposal[]>();

/**
 * Append the tagged learning trail (if this scope has accumulated any
 * pending Ask-AI proposals) as one extra entry in the ops array a save is
 * about to send — the SAME object_patch call, never a separate request.
 * `savedFields` is whatever fields this particular save actually persists,
 * used to determine which (if any) accumulated proposal it used.
 */
const attachLearningTrail = (
  target: EditTarget,
  ops: Array<Record<string, unknown>>,
  savedFields: Record<string, unknown> | undefined,
  manualEdits: readonly ManualRichTextEdit[] = []
): void => {
  const trailOp = buildLearningEvidenceOp(proposalTrails.get(scopeKeyFor(target)), savedFields, manualEdits);
  if (trailOp) ops.push(trailOp);
};

/** Call once a save for this scope has actually landed: its trail has shipped: the next editing session starts fresh. */
const clearLearningTrail = (target: EditTarget): void => {
  proposalTrails.delete(scopeKeyFor(target));
};

/** Record one Ask-AI round (mandate #9) — appends, never replaces; re-asking keeps every prior round in the trail. */
const accumulateProposal = (target: EditTarget, instruction: string, suggestion: Record<string, unknown>): void => {
  const key = scopeKeyFor(target);
  const list = proposalTrails.get(key) ?? [];
  list.push({ instruction, suggestion, at: new Date().toISOString() });
  proposalTrails.set(key, list);
};

// The canvas chrome themes itself from the PROJECT it is editing (STYLES, in
// ui-chrome.ts): every color and font is the site's own --aw-* design token,
// so the overlay matches whatever site it runs on. See that file for the
// token-mapping rationale.

const escapeHtml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const shortValue = (value: unknown): string => {
  const text = typeof value === 'string' ? value.replace(/<[^>]*>/g, ' ') : JSON.stringify(value);
  const normalized = (text ?? '').replace(/\s+/g, ' ').trim();
  return normalized.length > 220 ? `${normalized.slice(0, 220)}…` : normalized;
};

/** Union of the child boxes — display:contents regions generate no box themselves. */
const regionRect = (region: HTMLElement): DOMRect | undefined => {
  let rect: DOMRect | undefined;
  for (const child of Array.from(region.children)) {
    const box = (child as HTMLElement).getBoundingClientRect();
    if (box.width === 0 && box.height === 0) continue;
    if (!rect) {
      rect = DOMRect.fromRect(box);
      continue;
    }
    const left = Math.min(rect.left, box.left);
    const top = Math.min(rect.top, box.top);
    const right = Math.max(rect.right, box.right);
    const bottom = Math.max(rect.bottom, box.bottom);
    rect = new DOMRect(left, top, right - left, bottom - top);
  }
  return rect;
};

/**
 * The layout viewport. `window.innerWidth` includes the classic scrollbar, so
 * every geometry decision made against it is off by the scrollbar's width —
 * enough, on a page whose only wide box is a full-bleed header, to read a
 * ~15px margin where the real one is hundreds of px.
 */
const viewportWidth = (): number => document.documentElement.clientWidth || window.innerWidth;

/**
 * A box at (or near) the viewport's own width is PAGE CHROME — a sticky
 * header, a full-bleed section band — not a content column. 0.9 leaves room
 * for a genuinely wide container to still count as a column.
 */
const FULL_BLEED_RATIO = 0.9;
/** How far `contentRect` descends before giving up and keeping what it has. */
const CONTENT_DESCENT_MAX = 6;

/** A box the element generates itself, falling back to its children's union. */
const ownRect = (element: HTMLElement): DOMRect | undefined => {
  const box = element.getBoundingClientRect();
  return box.width === 0 && box.height === 0 ? regionRect(element) : box;
};

/**
 * The CONTENT box of an annotated region: `regionRect`'s union is the region's
 * outermost box, which on a full-bleed section is the band spanning the whole
 * viewport rather than the `max-w-*` column inside it. Walk down through
 * single-child full-bleed wrappers until a box narrower than 90% of the
 * viewport appears — that is the column the rail hangs off and the one the
 * gutter marker sits beside (without this, a marker on a full-bleed section
 * pins to x=4 because the band's left edge is 0).
 */
const contentRect = (region: HTMLElement): DOMRect | undefined => {
  const limit = viewportWidth() * FULL_BLEED_RATIO;
  let rect = regionRect(region);
  let host = region;
  for (let depth = 0; rect && rect.width >= limit && depth < CONTENT_DESCENT_MAX; depth += 1) {
    const children = (Array.from(host.children) as HTMLElement[]).filter((child) => {
      const box = child.getBoundingClientRect();
      return box.width > 0 || box.height > 0;
    });
    if (children.length !== 1) break;
    host = children[0];
    const inner = ownRect(host);
    if (!inner || inner.width === 0) break;
    rect = inner;
  }
  return rect;
};

export const mountEditMode = (options: MountOptions): void => {
  if (document.querySelector('.dl-em-bar')) return; // singleton per document
  activeController?.abort();
  const controller = new AbortController();
  activeController = controller;
  const signal = controller.signal;

  const { email, roles, getToken } = options;
  const allowPublish = canExecutePublish(roles);

  if (!document.getElementById('dl-em-styles')) {
    const style = document.createElement('style');
    style.id = 'dl-em-styles';
    style.textContent = STYLES;
    document.head.append(style);
  }

  // ── chrome
  const bar = document.createElement('div');
  bar.className = 'dl-em-bar';
  bar.innerHTML =
    `<span class="dl-em-dot"></span><span>Edit mode</span>` +
    `<span class="dl-em-who">${escapeHtml(email)}</span>` +
    `<span class="dl-em-status" data-em-status></span>` +
    `<button class="dl-em-btn" data-em-tray-toggle>Pending<span class="dl-em-count" data-em-count>0</span></button>` +
    // Attention ≠ Pending: open comment threads on THIS page, versus objects
    // with unpublished changes anywhere. Both quantities, both controls
    // (spec §4.3; the toolbar's reduction to three pills is T17.6b, not this).
    `<button class="dl-em-btn" data-em-attention aria-pressed="false" title="Open comments on this page">` +
    `Attention<span class="dl-em-count" data-em-attention-count>0</span></button>` +
    `<button class="dl-em-btn dl-em-primary" data-em-release ${allowPublish ? '' : 'disabled title="Requires publisher role"'}>Release to production</button>` +
    `<button class="dl-em-btn" data-em-exit>Exit</button>`;
  document.body.append(bar);

  const fab = document.createElement('button');
  fab.className = 'dl-em-fab';
  fab.title = 'Edit this page (admin)';
  fab.setAttribute('aria-label', 'Enter edit mode');
  fab.textContent = '✎';
  document.body.append(fab);

  const chip = document.createElement('div');
  chip.className = 'dl-em-chip';
  document.body.append(chip);

  const panel = document.createElement('div');
  panel.className = 'dl-em-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Edit section');
  // The panel is one accordion: icon-led sections (Ask AI / Edit / Image),
  // one expanded at a time (the expanded one grows; the rest are just a head).
  // A chip tool opens its section; the heads switch between them; clicking the
  // open head collapses the body to a compact rail. Identity lives in the
  // header as a type + monospace id with tiny shared/draft dots — no prose.
  const accHead = (mode: string, icon: string, label: string): string =>
    `<button class="dl-em-acc-head" data-em-acc-head="${mode}" aria-label="${label}">` +
    `<span class="dl-em-ic">${icon}</span><span class="dl-em-lbl">${label}</span>${ICON_CHEVRON}</button>`;
  panel.innerHTML =
    `<header><div class="dl-em-ident" data-em-ident></div>` +
    `<button class="dl-em-close" data-em-panel-close aria-label="Close">${ICON_CLOSE}</button></header>` +
    `<div class="dl-em-accstack">` +
    `<section class="dl-em-acc" data-em-acc="ai">${accHead('ai', ICON_SPARKLES, 'Ask AI')}` +
    `<div class="dl-em-acc-body">` +
    `<div class="dl-em-log" data-em-log></div>` +
    `<div class="dl-em-actions" data-em-suggestion-actions hidden>` +
    `<button class="dl-em-btn dl-em-accept dl-em-ico" data-em-accept>${ICON_CHECK} Save draft</button>` +
    `<button class="dl-em-btn dl-em-ghost dl-em-ico" data-em-discard title="Discard" aria-label="Discard">${ICON_UNDO}</button></div>` +
    `<div class="dl-em-composer"><div class="dl-em-row">` +
    `<textarea data-em-input placeholder="Describe the change…"></textarea>` +
    `<button class="dl-em-btn dl-em-primary dl-em-send dl-em-ico" data-em-send aria-label="Send">${ICON_SEND}</button></div>` +
    `<div class="dl-em-hint">${ICON_SPARKLES}<span>Select text to scope · <kbd>⌘↵</kbd> send</span></div></div>` +
    `</div></section>` +
    `<section class="dl-em-acc" data-em-acc="edit">${accHead('edit', ICON_PENCIL, 'Edit text')}` +
    `<div class="dl-em-acc-body" data-em-acc-body="edit"></div></section>` +
    `<section class="dl-em-acc" data-em-acc="image">${accHead('image', ICON_IMAGE, 'Image')}` +
    `<div class="dl-em-acc-body" data-em-acc-body="image"></div></section>` +
    `<section class="dl-em-acc" data-em-acc="role">${accHead('role', ICON_TAG, 'Role & intent')}` +
    `<div class="dl-em-acc-body" data-em-acc-body="role"></div></section>` +
    `<section class="dl-em-acc" data-em-acc="meta">${accHead('meta', ICON_TAG, 'Article settings')}` +
    `<div class="dl-em-acc-body" data-em-acc-body="meta"></div></section>` +
    `</div>`;
  document.body.append(panel);
  // Single reusable form node, moved into whichever section (edit/image) is open.
  const formEl = document.createElement('div');
  formEl.className = 'dl-em-form';
  formEl.setAttribute('data-em-form', '');

  // Gap layer: the small "+" affordances between/around sections (edit mode
  // only — CSS hides the layer otherwise). Document-absolute so scrolling
  // never needs a reposition; rebuilt when content heights change.
  const gapLayer = document.createElement('div');
  gapLayer.className = 'dl-em-gaplayer';
  document.body.append(gapLayer);

  // The add-section palette popover (opened by a gap "+").
  const palette = document.createElement('div');
  palette.className = 'dl-em-pal';
  palette.style.display = 'none';
  document.body.append(palette);

  // The margin rail (T17.3): the concept's annotation surface. Appended after
  // the page content in DOM order so a screen reader reaches the article
  // first (spec §9); positioned against the content column, not the viewport.
  const rail = document.createElement('aside');
  rail.className = 'dl-em-rail';
  rail.setAttribute('role', 'complementary');
  rail.setAttribute('aria-label', 'Comments');
  document.body.append(rail);

  // The left gutter (T17.6): one marker per annotated block that has
  // something to say — the numeral badge the concept puts beside a block that
  // needs you. Fixed and pointer-transparent like the rail; the buttons
  // inside take pointer events.
  const gutter = document.createElement('div');
  gutter.className = 'dl-em-gutter';
  document.body.append(gutter);

  const tray = document.createElement('div');
  tray.className = 'dl-em-tray';
  tray.innerHTML =
    `<header>Pending changes</header>` +
    `<div class="dl-em-rows" data-em-rows></div>` +
    `<footer><span class="dl-em-deploy" data-em-deploy>Publish commits; Release deploys everything once.</span>` +
    `<button class="dl-em-btn dl-em-primary" data-em-tray-release ${allowPublish ? '' : 'disabled'}>Release</button></footer>`;
  document.body.append(tray);

  const q = <T extends HTMLElement>(root: ParentNode, selector: string): T => root.querySelector(selector) as T;
  const statusEl = q<HTMLElement>(bar, '[data-em-status]');
  const countEl = q<HTMLElement>(bar, '[data-em-count]');
  const identEl = q<HTMLElement>(panel, '[data-em-ident]');
  const logEl = q<HTMLElement>(panel, '[data-em-log]');
  const inputEl = q<HTMLTextAreaElement>(panel, '[data-em-input]');
  const suggestionActions = q<HTMLElement>(panel, '[data-em-suggestion-actions]');
  const rowsEl = q<HTMLElement>(tray, '[data-em-rows]');
  const deployEl = q<HTMLElement>(tray, '[data-em-deploy]');

  const setStatus = (text: string): void => {
    statusEl.textContent = text;
  };

  const log = (kind: 'user' | 'ai' | 'sys', html: string): HTMLElement => {
    const message = document.createElement('div');
    message.className = `dl-em-msg dl-em-${kind}`;
    message.innerHTML = html;
    logEl.append(message);
    logEl.scrollTop = logEl.scrollHeight;
    return message;
  };

  /** A sys log line with animated dots — remove() it when the wait ends. */
  const busy = (label: string): HTMLElement =>
    log('sys', `<span class="dl-em-busy"><i></i><i></i><i></i></span>${escapeHtml(label)}`);

  // ── save-button dirty state (Slice D)
  // A form's Save draft is disabled when the fields match the last-saved
  // baseline (nothing to save). Any edit enables it; a successful save
  // re-baselines to the just-saved values → disabled again (after a brief
  // "✓ Saved"). One serializer covers every form field kind.
  const serializeForm = (): string => {
    const parts: string[] = [];
    formEl
      .querySelectorAll<
        HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement
      >('[data-em-field],[data-em-role-field],[data-em-nav-field],[data-em-meta-field]')
      .forEach((el) => {
        const key =
          el.getAttribute('data-em-field') ??
          el.getAttribute('data-em-role-field') ??
          el.getAttribute('data-em-nav-field') ??
          el.getAttribute('data-em-meta-field');
        parts.push(`${key}${el.value}`);
      });
    return parts.join('');
  };
  let saveBaseline = '';
  const saveButtonEl = (): HTMLButtonElement | null => formEl.querySelector('[data-em-form-save]');
  const refreshSaveState = (): void => {
    const button = saveButtonEl();
    if (!button || button.classList.contains('dl-em-busybtn')) return;
    button.disabled = serializeForm() === saveBaseline;
  };
  const captureSaveBaseline = (): void => {
    saveBaseline = serializeForm();
    refreshSaveState();
  };
  // One delegated listener (formEl outlives every re-render).
  formEl.addEventListener('input', refreshSaveState);
  formEl.addEventListener('change', refreshSaveState);

  /** Busy → brief "✓ Saved" → re-baseline (disabled) on success; restore on failure. */
  const buttonBusy = (button: HTMLButtonElement | null): { done: (ok: boolean) => void } => {
    if (!button) return { done: () => {} };
    const original = button.innerHTML;
    button.disabled = true;
    button.classList.add('dl-em-busybtn');
    button.innerHTML = 'Saving…';
    return {
      done: (ok: boolean) => {
        button.classList.remove('dl-em-busybtn');
        if (!ok) {
          button.innerHTML = original;
          refreshSaveState();
          return;
        }
        button.innerHTML = `${ICON_CHECK} Saved`;
        window.setTimeout(() => {
          button.innerHTML = original;
          // The fields now equal what was saved → re-baseline → disabled.
          captureSaveBaseline();
        }, 900);
      },
    };
  };

  /** Destructive actions confirm first — promise resolves true on confirm. */
  const confirmDialog = (message: string, confirmLabel = 'Delete'): Promise<boolean> =>
    new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.className = 'dl-em-confirm';
      overlay.innerHTML =
        `<div class="dl-em-confirmcard" role="alertdialog" aria-modal="true">` +
        `<p>${escapeHtml(message)}</p><div class="dl-em-confirmrow">` +
        `<button class="dl-em-btn" data-em-cancel>Cancel</button>` +
        `<button class="dl-em-btn dl-em-danger" data-em-ok>${ICON_TRASH} ${escapeHtml(confirmLabel)}</button>` +
        `</div></div>`;
      const done = (value: boolean): void => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) done(false);
      });
      overlay.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Escape') done(false);
      });
      overlay.querySelector('[data-em-cancel]')?.addEventListener('click', () => done(false));
      overlay.querySelector('[data-em-ok]')?.addEventListener('click', () => done(true));
      document.body.append(overlay);
      overlay.querySelector<HTMLButtonElement>('[data-em-cancel]')?.focus();
    });

  /**
   * Over-budget image upload: a warning, not a block. Offer to shrink the image
   * in the browser or keep it as-is — the admin on the canvas decides. Resolves
   * 'smaller' | 'asis' | 'cancel'.
   */
  const chooseImageSize = (fileBytes: number, budgetBytes: number): Promise<'smaller' | 'asis' | 'cancel'> =>
    new Promise((resolve) => {
      const kb = (n: number): string => `${Math.max(1, Math.round(n / 1024))} KB`;
      const overlay = document.createElement('div');
      overlay.className = 'dl-em-confirm';
      overlay.innerHTML =
        `<div class="dl-em-confirmcard" role="alertdialog" aria-modal="true">` +
        `<p>This image is <strong>${kb(fileBytes)}</strong> — over the ${kb(budgetBytes)} web budget. ` +
        `Smaller images load faster and are easier on readers.</p>` +
        `<div class="dl-em-confirmrow">` +
        `<button class="dl-em-btn" data-em-cancel>Cancel</button>` +
        `<button class="dl-em-btn" data-em-asis>Use as is</button>` +
        `<button class="dl-em-btn dl-em-primary" data-em-smaller>Make smaller</button>` +
        `</div></div>`;
      const done = (value: 'smaller' | 'asis' | 'cancel'): void => {
        overlay.remove();
        resolve(value);
      };
      overlay.addEventListener('click', (event) => {
        if (event.target === overlay) done('cancel');
      });
      overlay.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Escape') done('cancel');
      });
      overlay.querySelector('[data-em-cancel]')?.addEventListener('click', () => done('cancel'));
      overlay.querySelector('[data-em-asis]')?.addEventListener('click', () => done('asis'));
      overlay.querySelector('[data-em-smaller]')?.addEventListener('click', () => done('smaller'));
      document.body.append(overlay);
      overlay.querySelector<HTMLButtonElement>('[data-em-smaller]')?.focus();
    });

  const blobToUploadFile = (blob: Blob, originalName: string, format: 'webp' | 'png'): File => {
    const base = originalName.replace(/\.[^./\\]+$/, '') || 'image';
    const ext = format === 'png' ? 'png' : 'webp';
    return new File([blob], `${base}.${ext}`, { type: blob.type || `image/${ext}` });
  };

  /**
   * Shrink an over-budget image in the browser (net-new — the canvas had no
   * client-side image processing). Re-encodes toward the site's preferred web
   * format, dropping quality then dimensions until it fits the byte budget.
   * Returns the smallest result it can make, or the original if the browser
   * can't decode/encode it.
   */
  const downscaleImage = async (file: File, budgetBytes: number, format: 'webp' | 'png'): Promise<File> => {
    const mime = format === 'png' ? 'image/png' : 'image/webp';
    const encode = (canvas: HTMLCanvasElement, quality: number | undefined): Promise<Blob | null> =>
      new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), mime, quality));

    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(file);
    } catch {
      return file;
    }

    let width = bitmap.width;
    let height = bitmap.height;
    const MAX_EDGE = 1600; // cap the longest side for web
    const longest = Math.max(width, height);
    if (longest > MAX_EDGE) {
      const scale = MAX_EDGE / longest;
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }

    const qualities = format === 'png' ? [undefined] : [0.82, 0.7, 0.6, 0.5, 0.4];
    let smallest: Blob | null = null;
    try {
      for (let pass = 0; pass < 5 && width >= 32 && height >= 32; pass++) {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) break;
        ctx.drawImage(bitmap, 0, 0, width, height);
        for (const quality of qualities) {
          const blob = await encode(canvas, quality);
          if (!blob) continue;
          if (!smallest || blob.size < smallest.size) smallest = blob;
          if (blob.size <= budgetBytes) return blobToUploadFile(blob, file.name, format);
        }
        width = Math.round(width * 0.75);
        height = Math.round(height * 0.75);
      }
    } finally {
      bitmap.close();
    }
    return smallest ? blobToUploadFile(smallest, file.name, format) : file;
  };

  // ── record cache (B4): entering edit mode preloads every object visible on
  // the page (one get per distinct object, in parallel) so panels and chips
  // open from memory; any successful write invalidates its entry.
  type RecordResult = { status: number; record?: Record<string, unknown> };
  const recordCache = new Map<string, Promise<RecordResult>>();
  const recordKey = (objectType: string, objectId: string): string => `${objectType}:${objectId}`;
  const cachedRecord = (objectType: string, objectId: string): Promise<RecordResult> => {
    const key = recordKey(objectType, objectId);
    let cached = recordCache.get(key);
    if (!cached) {
      // A failed fetch must not stick: drop it so the next open retries.
      cached = getObjectRecord(getToken, objectType, objectId).then(
        (result) => {
          if (result.status !== 200) recordCache.delete(key);
          return result;
        },
        (error: unknown) => {
          recordCache.delete(key);
          throw error;
        }
      );
      recordCache.set(key, cached);
    }
    return cached;
  };
  const invalidateRecord = (objectType: string, objectId: string): void => {
    recordCache.delete(recordKey(objectType, objectId));
    if (objectType === 'content_item') nodeRoleCache.delete(objectId);
  };

  // ── marginalia cache: same B4 discipline as the record cache above, applied
  // to comment threads — entering edit mode also warms every visible
  // object's threads, one list per distinct object, in parallel, so the
  // margin rail's first paint (and every bubble it opens) comes from memory
  // instead of paying a cold fetch.
  // A write through a bubble invalidates its own entry (mountMarginaliaPanel's
  // onWrite callback), the same way object writes invalidate recordCache.
  type MarginaliaThreadsResult = { threads: MarginaliaThreadWithComments[] };
  const marginaliaCache = new Map<string, Promise<MarginaliaThreadsResult>>();
  const cachedMarginaliaThreads = (objectType: string, objectId: string): Promise<MarginaliaThreadsResult> => {
    const key = recordKey(objectType, objectId);
    let cached = marginaliaCache.get(key);
    if (!cached) {
      cached = listMarginaliaThreads(getToken, objectType, objectId).then(
        (result) => ({ threads: result.threads }),
        (error: unknown) => {
          marginaliaCache.delete(key);
          throw error;
        }
      );
      marginaliaCache.set(key, cached);
    }
    return cached;
  };
  const invalidateMarginaliaThreads = (objectType: string, objectId: string): void => {
    marginaliaCache.delete(recordKey(objectType, objectId));
  };

  const preloadRecords = (): void => {
    const targets = new Map<string, { type: string; id: string }>();
    const note = (target: EditTarget | undefined): void => {
      if (target)
        targets.set(recordKey(target.objectType, target.objectId), { type: target.objectType, id: target.objectId });
    };
    document
      .querySelectorAll<HTMLElement>(REGION_SELECTOR)
      .forEach((region) => note(deriveEditTarget(region.dataset as Record<string, string>)));
    document
      .querySelectorAll<HTMLElement>(NODE_SELECTOR)
      .forEach((region) => note(deriveNodeTarget(region.dataset as Record<string, string>)));
    document
      .querySelectorAll<HTMLElement>(NAV_SELECTOR)
      .forEach((region) => note(deriveNavTarget(region.dataset as Record<string, string>)));
    for (const { type, id } of targets.values()) {
      void cachedRecord(type, id);
      void cachedMarginaliaThreads(type, id);
    }
    // The taxonomy registry backs the article-settings category/tag pickers
    // on EVERY content_item, regardless of what's on the current page — warm
    // it unconditionally so that panel's first open never pays a cold fetch.
    void cachedRecord('taxonomy', getSiteIdentity().taxonomyId);
  };

  const session = (objectType: string, objectId: string): EditSession => {
    const key = `${objectType}:${objectId}`;
    let existing = sessions.get(key);
    if (!existing) {
      existing = new EditSession(objectType, objectId, getToken);
      sessions.set(key, existing);
    }
    return existing;
  };

  let pendingRows: PendingObjectRow[] = [];
  const refreshPending = async (): Promise<void> => {
    pendingRows = await fetchPendingObjects(getToken);
    countEl.textContent = String(pendingRows.length);
    countEl.classList.toggle('dl-em-hot', pendingRows.length > 0);
    renderTray();
    markDraftRegions();
  };

  const targetObjectIdOf = (region: HTMLElement): string | undefined =>
    (region.dataset.cmsNodeId !== undefined
      ? deriveNodeTarget(region.dataset as Record<string, string>)
      : deriveEditTarget(region.dataset as Record<string, string>)
    )?.objectId;

  const markDraftRegions = (): void => {
    const draftIds = new Set(pendingRows.filter((row) => row.unpublished_changes).map((row) => row.object_id));
    document.querySelectorAll<HTMLElement>(`${REGION_SELECTOR}, ${NODE_SELECTOR}`).forEach((region) => {
      const objectId = targetObjectIdOf(region);
      region.classList.toggle('dl-em-draft', Boolean(objectId && draftIds.has(objectId)));
    });
    positionDraftChips(); // the inline "· draft" chip follows the same set (spec §10.2)
  };

  // ── tray (B5): rows say WHAT changed WHERE, not a req_* id
  // "object · verb · location": the label is the object's human name (title/
  // route/type) and the note summarizes the unpublished ops from the record's
  // history — "Image added to Resolution", "Text edited in Hook · +2 more".
  type HistoryEntry = {
    action?: string;
    details?: {
      op?: Record<string, unknown> & {
        node_id?: string;
        section_id?: string;
        fields?: Record<string, unknown>;
        node?: { kind?: string; private?: { strategy?: string } };
      };
      capture?: { before?: { value?: { private?: { strategy?: string }; kind?: string } } };
    };
  };

  const trayLabelFor = (row: PendingObjectRow, body: Record<string, unknown> | undefined): string => {
    if (!body) return row.object_id;
    if (row.object_type === 'content_item') return (body.title as string) ?? row.object_id;
    if (row.object_type === 'page') return (body.title as string) ?? (body.route as string) ?? row.object_id;
    if (row.object_type === 'section') {
      const inner = body.section as { type?: string } | undefined;
      return inner?.type ? `Shared section: ${inner.type}` : row.object_id;
    }
    if (row.object_type === 'navigation') {
      const role = body.role as string | undefined;
      return role ? `${role.charAt(0).toUpperCase()}${role.slice(1)} menu` : row.object_id;
    }
    if (row.object_type === 'product') {
      const presentation = body.presentation as { title?: string } | undefined;
      return presentation?.title ?? (body.slug as string) ?? row.object_id;
    }
    if (row.object_type === 'site') return 'Site settings';
    if (row.object_type === 'taxonomy') return 'Categories & tags';
    if (row.object_type === 'template') return (body.name as string) ?? row.object_id;
    return row.object_id;
  };

  /** The role (Hook/Proof/…) or kind of a node, for "…in <location>" phrasing. */
  const nodeLocation = (body: Record<string, unknown> | undefined, entry: HistoryEntry): string => {
    const nodeId = entry.details?.op?.node_id;
    const nodes = (body?.nodes ?? []) as Array<{ id: string; kind?: string; private?: { strategy?: string } }>;
    const node = nodes.find((candidate) => candidate.id === nodeId);
    const strategy =
      node?.private?.strategy ??
      entry.details?.op?.node?.private?.strategy ??
      entry.details?.capture?.before?.value?.private?.strategy;
    if (strategy) return STRATEGY_LABELS[strategy] ?? strategy;
    return node?.kind ?? entry.details?.op?.node?.kind ?? entry.details?.capture?.before?.value?.kind ?? 'block';
  };

  const phraseForEntry = (
    row: PendingObjectRow,
    body: Record<string, unknown> | undefined,
    entry: HistoryEntry
  ): string | undefined => {
    const action = entry.action ?? '';
    if (row.object_type === 'content_item') {
      const where = nodeLocation(body, entry);
      if (action === 'upsert_node') return `Block added (${where})`;
      if (action === 'remove_node') return `Block removed (${where})`;
      if (action === 'move_node') return `Block moved (${where})`;
      if (action === 'set_node_visibility') return `Block hidden/shown (${where})`;
      if (action === 'set_article_meta') return 'Article details edited';
      if (action === 'update_node') {
        const fields = (entry.details?.op?.fields ?? {}) as { public?: Record<string, unknown>; private?: unknown };
        const publicFields = fields.public ?? {};
        if ('media' in publicFields) {
          const media = publicFields.media as { src?: unknown } | null;
          return media === null
            ? `Image removed from ${where}`
            : `Image ${media && media.src ? 'added to' : 'changed in'} ${where}`;
        }
        if ('images' in publicFields) return `Gallery edited in ${where}`;
        if (fields.private && Object.keys(publicFields).length === 0) return `Role updated (${where})`;
        return `Text edited in ${where}`;
      }
      return undefined;
    }
    if (action === 'update_section_data') {
      const sectionId = entry.details?.op?.section_id;
      const sections = (body?.sections ?? []) as Array<{ id: string; type?: string }>;
      const type =
        sections.find((section) => section.id === sectionId)?.type ??
        (body?.section as { type?: string } | undefined)?.type;
      return type ? `Text edited (${type})` : 'Text edited';
    }
    if (action === 'upsert_section') return 'Section added';
    if (action === 'remove_section') return 'Section removed';
    if (action === 'move_section') return 'Section moved';
    if (action === 'set_page_meta') return 'Page details edited';
    if (/^(update_item|upsert_group|remove_group|upsert_action|remove_action|set_nav_meta|move_item)$/.test(action))
      return 'Menu copy edited';
    if (action === 'set_site_fields') return 'Site settings edited';
    if (action === 'set_site_brand_tokens') return 'Site palette applied';
    if (/product/.test(action)) return 'Product details edited';
    if (/term/.test(action)) return 'Vocabulary edited';
    return undefined;
  };

  /** Unpublished changes, newest first: history entries after the last publish. */
  const summarizeUnpublished = (row: PendingObjectRow, record: Record<string, unknown> | undefined): string => {
    const fallback = row.published_time ? 'changed since last publish' : 'never published';
    const history = (record?.history ?? []) as HistoryEntry[];
    const body = record?.body as Record<string, unknown> | undefined;
    const phrases: string[] = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const entry = history[index];
      if (entry.action === 'publish') break;
      if (entry.action === 'checkout' || entry.action === 'checkin' || entry.action === 'refresh_lock') continue;
      if (entry.action === 'create') {
        if (phrases.length === 0) phrases.push('New — never published');
        break;
      }
      const phrase = phraseForEntry(row, body, entry);
      if (phrase && !phrases.includes(phrase)) phrases.push(phrase);
    }
    if (phrases.length === 0) return fallback;
    return phrases[0] + (phrases.length > 1 ? ` · +${phrases.length - 1} more` : '');
  };

  const fillTrayRow = async (metaEl: HTMLElement, row: PendingObjectRow, extraNote: string): Promise<void> => {
    const { record } = await cachedRecord(row.object_type, row.object_id);
    const labelEl = metaEl.querySelector('[data-em-traylabel]');
    const noteEl = metaEl.querySelector('[data-em-traynote]');
    if (labelEl) labelEl.textContent = trayLabelFor(row, record?.body as Record<string, unknown> | undefined);
    if (noteEl) noteEl.textContent = `${summarizeUnpublished(row, record)}${extraNote}`;
  };

  const renderTray = (): void => {
    rowsEl.innerHTML = '';
    if (pendingRows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'dl-em-row2';
      empty.innerHTML =
        '<span class="dl-em-note">Nothing waiting. Accepted edits appear here as unpublished drafts.</span>';
      rowsEl.append(empty);
      return;
    }
    for (const row of pendingRows) {
      const rowEl = document.createElement('div');
      rowEl.className = 'dl-em-row2';
      const gateNote = row.requires_approval && row.review_state !== 'approved' ? ' · needs review approval' : '';
      const lockNote = row.lock.held ? ` · locked by ${row.lock.owner_label ?? 'someone'}` : '';
      // Render immediately with the id as a stopgap, then swap in the human
      // label + change summary from the (usually preloaded) record. The raw
      // id survives in the tooltip.
      rowEl.innerHTML =
        `<div class="dl-em-meta" title="${escapeHtml(row.object_id)}">` +
        `<div class="dl-em-oid" data-em-traylabel>${escapeHtml(row.object_id)}</div>` +
        `<div class="dl-em-note" data-em-traynote>${row.published_time ? 'changed since last publish' : 'never published'}${gateNote}${escapeHtml(lockNote)}</div></div>`;
      void fillTrayRow(rowEl, row, `${gateNote}${lockNote}`);
      const publishBtn = document.createElement('button');
      publishBtn.className = 'dl-em-btn';
      publishBtn.textContent = 'Publish';
      // T9.21 (capability #9): the readiness gate moves into the tray — the
      // button stays disabled until validate reports eligible; blockers show
      // inline in the human criterion text.
      publishBtn.disabled = true;
      publishBtn.title = 'Checking readiness…';
      const timeBtn = document.createElement('button');
      timeBtn.className = 'dl-em-btn dl-em-ghost';
      timeBtn.textContent = '🕓';
      timeBtn.title = 'Publish with an explicit timestamp';
      timeBtn.setAttribute('aria-label', 'Publish with an explicit timestamp');
      timeBtn.disabled = true;

      const doPublish = async (publishedTime?: string): Promise<void> => {
        publishBtn.disabled = true;
        timeBtn.disabled = true;
        publishBtn.textContent = 'Publishing…';
        const objectSession = session(row.object_type, row.object_id);
        const checkout = await objectSession.ensureCheckout();
        if (!checkout.ok) {
          publishBtn.textContent = 'Publish';
          publishBtn.disabled = false;
          timeBtn.disabled = false;
          setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again later.`);
          return;
        }
        const result = await objectSession.publish(publishedTime);
        await objectSession.checkin();
        if (result.status === 200) {
          invalidateRecord(row.object_type, row.object_id);
          setStatus(
            `${row.object_id} published${publishedTime ? ` (as of ${publishedTime})` : ''} — committed, not yet deployed. Release when ready.`
          );
          await refreshPending();
        } else {
          setStatus(`${row.object_id}: ${(result.body.error as string) ?? `publish failed (${result.status})`}`);
          publishBtn.textContent = 'Publish';
          publishBtn.disabled = false;
          timeBtn.disabled = false;
        }
      };

      publishBtn.addEventListener('click', () => void doPublish());
      timeBtn.addEventListener('click', () => {
        // Inline "publish as of" mini-form (capability #10) — surfaces only
        // what publish_by_time allows: now, or an explicit timestamp.
        const existing = rowEl.querySelector('[data-em-timeform]');
        if (existing) {
          existing.remove();
          return;
        }
        const form = document.createElement('div');
        form.setAttribute('data-em-timeform', '');
        form.className = 'dl-em-formrow';
        form.innerHTML =
          `<input type="datetime-local" data-em-time-input>` +
          `<button class="dl-em-btn" data-em-time-go>Publish at time</button>`;
        form.querySelector('[data-em-time-go]')?.addEventListener('click', () => {
          const value = form.querySelector<HTMLInputElement>('[data-em-time-input]')?.value;
          if (!value) return;
          form.remove();
          void doPublish(new Date(value).toISOString());
        });
        rowEl.append(form);
      });

      // Readiness check (async, per row): blockers hold the gate with the
      // criterion text; a clean validate arms both publish paths.
      void (async () => {
        try {
          const verdict = await callObjectVerb(getToken, {
            action: 'validate',
            object_type: row.object_type,
            object_id: row.object_id,
          });
          const summary = (verdict.body as { summary?: { eligible?: boolean; blockers?: string[] } }).summary;
          if (summary?.eligible === false) {
            const blockers = summary.blockers ?? [];
            publishBtn.title = blockers.join('\n') || 'Validation blockers.';
            const note = rowEl.querySelector('[data-em-traynote]');
            if (note) {
              const blockText = document.createElement('div');
              blockText.className = 'dl-em-note';
              blockText.style.color = 'var(--dlem-danger)';
              blockText.textContent = `Not ready: ${blockers[0] ?? 'validation blockers'}${blockers.length > 1 ? ` (+${blockers.length - 1} more)` : ''}`;
              note.append(blockText);
            }
            return; // stays disabled — the readiness gate
          }
          publishBtn.disabled = !allowPublish;
          timeBtn.disabled = !allowPublish;
          publishBtn.title = allowPublish ? '' : 'Requires publisher role';
        } catch {
          // Validation unreachable: fail open to the server gate (publish
          // re-validates) rather than wedging the tray.
          publishBtn.disabled = !allowPublish;
          timeBtn.disabled = !allowPublish;
          publishBtn.title = '';
        }
      })();

      rowEl.append(publishBtn, timeBtn);
      rowsEl.append(rowEl);
    }
  };

  const doRelease = async (button: HTMLButtonElement): Promise<void> => {
    button.disabled = true;
    deployEl.textContent = 'Build hook fired — deploy running…';
    setStatus('Releasing to production…');
    const release = await releaseToProduction(getToken);
    const status = release.result?.status ?? `HTTP ${release.status}`;
    deployEl.textContent =
      status === 'released'
        ? '✓ Live — the deploy is ready.'
        : `Release status: ${status}${release.result?.detail ? ` — ${release.result.detail}` : ''}`;
    setStatus(status === 'released' ? 'Released — the site is current.' : `Release: ${status}`);
    button.disabled = !allowPublish;
  };
  q<HTMLButtonElement>(tray, '[data-em-tray-release]').addEventListener('click', (event) =>
    doRelease(event.currentTarget as HTMLButtonElement)
  );
  q<HTMLButtonElement>(bar, '[data-em-release]').addEventListener('click', (event) => {
    tray.classList.add('dl-em-open');
    void doRelease(event.currentTarget as HTMLButtonElement);
  });
  q<HTMLButtonElement>(bar, '[data-em-tray-toggle]').addEventListener('click', () => {
    tray.classList.toggle('dl-em-open');
    panel.classList.remove('dl-em-open');
  });

  // ── edit-mode toggling
  const setEditMode = (on: boolean): void => {
    document.body.classList.toggle('dl-em-on', on);
    try {
      sessionStorage.setItem(MODE_KEY, on ? '1' : '0');
    } catch {
      /* ignored */
    }
    if (on) {
      void refreshPending();
      // Pay the wait up front (B4): warm the record cache for everything on
      // the page so every chip/panel/tool opens from memory.
      preloadRecords();
      scheduleGapRebuild();
      void refreshRailThreads();
      syncRegionFocusability(true);
    } else {
      cancelInlineEdit();
      syncRegionFocusability(false);
      chip.style.display = 'none';
      panel.classList.remove('dl-em-open');
      tray.classList.remove('dl-em-open');
      palette.style.display = 'none';
      revealedRegion = undefined;
      pinnedKey = undefined;
      pinnedRegion = undefined;
      renderRail(); // drops every bubble
      for (const objectSession of sessions.values()) void objectSession.checkin();
    }
  };
  fab.addEventListener('click', () => setEditMode(true));
  q<HTMLButtonElement>(bar, '[data-em-exit]').addEventListener('click', () => setEditMode(false));

  // ── gap "+" affordances: add a section (pages) or a block (articles)
  type Gap = {
    kind: 'section' | 'node';
    host: string;
    anchorId: string;
    where: 'before' | 'after';
    x: number;
    y: number;
  };

  const gapsFromRegions = (): Gap[] => {
    const regions = Array.from(document.querySelectorAll<HTMLElement>(REGION_SELECTOR))
      .map((region) => ({
        region,
        target: deriveEditTarget(region.dataset as Record<string, string>),
        rect: regionRect(region),
      }))
      .filter((entry): entry is { region: HTMLElement; target: EditTarget; rect: DOMRect } =>
        Boolean(entry.target && entry.rect)
      );
    const gaps: Gap[] = [];
    const scrollY = window.scrollY;
    for (let i = 0; i < regions.length; i += 1) {
      const { target, rect } = regions[i];
      // Inserts always land on the HOST page object, anchored by the page
      // instance id — a shared_ref region anchors by its reference on the page.
      const host = target.hostObjectId;
      const anchorId = target.shared
        ? (regions[i].region.dataset.cmsSectionId as string)
        : (target.sectionId as string);
      const previous = regions[i - 1];
      const next = regions[i + 1];
      const x = rect.left + rect.width / 2;
      if (!previous || previous.target.hostObjectId !== host) {
        gaps.push({ kind: 'section', host, anchorId, where: 'before', x, y: rect.top + scrollY - 12 });
      }
      if (next && next.target.hostObjectId === host) {
        gaps.push({
          kind: 'section',
          host,
          anchorId,
          where: 'after',
          x,
          y: (rect.bottom + next.rect.top) / 2 + scrollY,
        });
      } else {
        gaps.push({ kind: 'section', host, anchorId, where: 'after', x, y: rect.bottom + scrollY + 12 });
      }
    }
    // Object-EMPTY pages (e.g. page_article before its first section): the
    // zero-height marker ObjectSections leaves behind gets one "+" so the
    // FIRST section can be added from the canvas. anchorId '' → append (the
    // insert-position rule: unknown anchor appends; an empty list appends at 0).
    for (const marker of Array.from(document.querySelectorAll<HTMLElement>(EMPTY_OBJECT_SELECTOR))) {
      const host = marker.dataset.cmsEmptyObject as string;
      if (regions.some((entry) => entry.target.hostObjectId === host)) continue; // no longer empty (draft added)
      const rect = marker.getBoundingClientRect();
      gaps.push({
        kind: 'section',
        host,
        anchorId: '',
        where: 'after',
        x: rect.width > 0 ? rect.left + rect.width / 2 : window.innerWidth / 2,
        y: rect.top + scrollY,
      });
    }
    return gaps;
  };

  // Article bodies (W7.7): a "+" before the first block, between blocks of the
  // same article, and after the last — the node palette's anchor points.
  // Position math stays RECORD-based at insert time (internal/hidden nodes
  // occupy indices the DOM never shows) — the gap only names the anchor id.
  const nodeGapsFromRegions = (): Gap[] => {
    const regions = Array.from(document.querySelectorAll<HTMLElement>(NODE_SELECTOR))
      .map((region) => ({
        region,
        target: deriveNodeTarget(region.dataset as Record<string, string>),
        rect: regionRect(region),
      }))
      .filter((entry): entry is { region: HTMLElement; target: EditTarget; rect: DOMRect } =>
        Boolean(entry.target && entry.rect)
      );
    const gaps: Gap[] = [];
    const scrollY = window.scrollY;
    for (let i = 0; i < regions.length; i += 1) {
      const { target, rect } = regions[i];
      const host = target.objectId;
      const anchorId = target.nodeId as string;
      const previous = regions[i - 1];
      const next = regions[i + 1];
      const x = rect.left + rect.width / 2;
      if (!previous || previous.target.objectId !== host) {
        gaps.push({ kind: 'node', host, anchorId, where: 'before', x, y: rect.top + scrollY - 12 });
      }
      if (next && next.target.objectId === host) {
        gaps.push({ kind: 'node', host, anchorId, where: 'after', x, y: (rect.bottom + next.rect.top) / 2 + scrollY });
      } else {
        gaps.push({ kind: 'node', host, anchorId, where: 'after', x, y: rect.bottom + scrollY + 12 });
      }
    }
    return gaps;
  };

  const buildGaps = (): void => {
    // The rail rides the same rebuild cadence: content heights changed, so
    // the content column (and therefore the rail's x) may have too.
    layoutRail(true);
    gapLayer.innerHTML = '';
    if (!document.body.classList.contains('dl-em-on')) return;
    syncRegionFocusability(true); // freshly inserted draft blocks are editable too
    for (const gap of [...gapsFromRegions(), ...nodeGapsFromRegions()]) {
      const button = document.createElement('button');
      button.className = 'dl-em-gap';
      // Node gaps never surface the req_* id — worthless to an editor.
      button.title = gap.kind === 'node' ? 'Add an article block' : `Add a section to ${gap.host}`;
      button.setAttribute('aria-label', gap.kind === 'node' ? 'Add an article block here' : 'Add a section here');
      button.innerHTML = ICON_PLUS;
      button.style.left = `${gap.x}px`;
      button.style.top = `${gap.y}px`;
      button.addEventListener('click', (event) => {
        event.stopPropagation();
        openPalette(gap, button);
      });
      gapLayer.append(button);
    }
  };

  let gapRebuildTimer: number | undefined;
  const scheduleGapRebuild = (): void => {
    window.clearTimeout(gapRebuildTimer);
    gapRebuildTimer = window.setTimeout(buildGaps, 250);
  };
  window.addEventListener('resize', scheduleGapRebuild, { signal });
  window.addEventListener('load', scheduleGapRebuild, { signal });

  const openPalette = (gap: Gap, anchor: HTMLElement): void => {
    const entries: Array<{ label: string; hint: string }> = gap.kind === 'node' ? NODE_PALETTE : SECTION_PALETTE;
    palette.innerHTML =
      `<div class="dl-em-palhead">${gap.kind === 'node' ? 'Add an article block' : `Add to ${escapeHtml(gap.host)}`}</div>` +
      entries
        .map(
          (entry, index) =>
            `<button data-em-pal="${index}"><span class="dl-em-pallabel">${escapeHtml(entry.label)}</span>` +
            `<div class="dl-em-palhint">${escapeHtml(entry.hint)}</div></button>`
        )
        .join('');
    const rect = anchor.getBoundingClientRect();
    palette.style.display = 'block';
    palette.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
    palette.style.top = `${Math.min(rect.bottom + 6, window.innerHeight - 300)}px`;
    palette.querySelectorAll<HTMLButtonElement>('[data-em-pal]').forEach((button) => {
      button.addEventListener('click', () => {
        palette.style.display = 'none';
        const index = Number(button.dataset.emPal);
        if (gap.kind === 'node') void insertNode(gap, NODE_PALETTE[index]);
        else void insertSection(gap, SECTION_PALETTE[index]);
      });
    });
  };
  document.addEventListener(
    'click',
    (event) => {
      if (palette.style.display !== 'none' && !palette.contains(event.target as Node)) {
        const onGap = (event.target as HTMLElement).closest?.('.dl-em-gap');
        if (!onGap) palette.style.display = 'none';
      }
    },
    { signal }
  );

  const insertSection = async (gap: Gap, entry: (typeof SECTION_PALETTE)[number]): Promise<void> => {
    setStatus(`Adding ${entry.label.toLowerCase()} to ${gap.host}…`);
    const objectSession = session('page', gap.host);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again later.`);
      return;
    }
    // Position from the CURRENT record (hidden sections still occupy indices).
    const { record } = await getObjectRecord(getToken, 'page', gap.host);
    const sections = ((record?.body as Record<string, unknown> | undefined)?.sections ?? []) as Array<{ id: string }>;
    const position = insertPositionFor(sections, gap.anchorId, gap.where);
    const outcome = await objectSession.patch([
      { op: 'upsert_section', section: { type: entry.type, data: entry.starter }, position },
    ]);
    if (!outcome.ok) {
      setStatus(`Could not add: ${outcome.error}`);
      return;
    }
    const mintedId = outcome.minted.find((mint) => mint.field === 'section.id')?.id;
    invalidateRecord('page', gap.host);
    // A draft placeholder in place: the static page can't render the new
    // section until publish+release, so show an honest, immediately-editable
    // stand-in (it carries the annotation, so the chip tools work on it).
    // Anchor: the anchor section's region, or — first section on an
    // object-empty page — the page object's empty marker.
    const anchorRegion =
      document.querySelector<HTMLElement>(`[data-cms-section-id="${CSS.escape(gap.anchorId)}"]`) ??
      document.querySelector<HTMLElement>(`[data-cms-empty-object="${CSS.escape(gap.host)}"]`);
    if (anchorRegion && mintedId) {
      const placeholder = document.createElement('div');
      placeholder.dataset.cmsObjectId = gap.host;
      placeholder.dataset.cmsSectionId = mintedId;
      placeholder.dataset.cmsSectionType = entry.type;
      placeholder.className = 'dl-em-draft';
      placeholder.innerHTML =
        `<div class="dl-em-newsec-inner"><strong>${escapeHtml(entry.label)}</strong> — draft section ` +
        `<span class="dl-em-id">${escapeHtml(mintedId)}</span><br>` +
        `${escapeHtml(shortValue(Object.values(entry.starter).find((value) => typeof value === 'string') ?? entry.hint))}<br>` +
        `Hover to edit or ask the AI. Renders on the live page after publish + release.</div>`;
      if (gap.where === 'before') anchorRegion.before(placeholder);
      else anchorRegion.after(placeholder);
    }
    setStatus(`${entry.label} added to ${gap.host} as a draft.`);
    await refreshPending();
    scheduleGapRebuild();
  };

  // Article blocks (W7.7): the node-palette insert — same shape as sections
  // (checkout → record-derived position → upsert, id minted server-side →
  // honest draft placeholder), riding update-family verbs on the article.
  const insertNode = async (gap: Gap, entry: (typeof NODE_PALETTE)[number]): Promise<void> => {
    setStatus(`Adding ${entry.label.toLowerCase()} to the article…`);
    const objectSession = session('content_item', gap.host);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again later.`);
      return;
    }
    // Position from the CURRENT record (internal/hidden nodes occupy indices).
    const { record } = await getObjectRecord(getToken, 'content_item', gap.host);
    const nodes = ((record?.body as Record<string, unknown> | undefined)?.nodes ?? []) as Array<{ id: string }>;
    const position = insertPositionFor(nodes, gap.anchorId, gap.where);
    const outcome = await objectSession.patch([{ op: 'upsert_node', node: entry.node, position }]);
    if (!outcome.ok) {
      setStatus(`Could not add: ${outcome.error}`);
      return;
    }
    const mintedId = outcome.minted.find((mint) => mint.field === 'node.id')?.id;
    invalidateRecord('content_item', gap.host); // the new block's role must show on its chip
    const anchorRegion = document.querySelector<HTMLElement>(`[data-cms-node-id="${CSS.escape(gap.anchorId)}"]`);
    if (anchorRegion && mintedId) {
      const placeholder = document.createElement('div');
      placeholder.dataset.cmsObjectId = gap.host;
      placeholder.dataset.cmsNodeId = mintedId;
      placeholder.dataset.cmsNodeKind = (entry.node.kind as string) ?? 'content';
      placeholder.className = 'dl-em-draft';
      placeholder.innerHTML =
        `<div class="dl-em-newsec-inner"><strong>${escapeHtml(entry.label)}</strong> — draft block<br>` +
        `${escapeHtml(entry.hint)}<br>` +
        `Hover to edit, set its role, or ask the AI. Renders on the live page after publish + release.</div>`;
      if (gap.where === 'before') anchorRegion.before(placeholder);
      else anchorRegion.after(placeholder);
    }
    setStatus(`${entry.label} added to the article as a draft.`);
    await refreshPending();
    scheduleGapRebuild();
  };

  // ── delete (Slice C): remove an element as a reviewable draft op
  // Nodes → remove_node on the article. Sections — inline OR shared_ref — →
  // remove_section on the HOST page instance: deleting a shared section from
  // a page removes the page's REFERENCE; the sec_* object itself remains.
  const deleteRegion = async (target: EditTarget, region: HTMLElement): Promise<void> => {
    const isNode = target.objectType === 'content_item' && Boolean(target.nodeId);
    const what = isNode ? 'this article block' : `this ${target.sectionType} section`;
    const sharedNote = target.shared
      ? ' This is a shared section — deleting removes it from this page only; the shared object remains.'
      : '';
    const confirmed = await confirmDialog(
      `Delete ${what}? The removal is saved as a draft — nothing changes on the live site until you publish and release.${sharedNote}`
    );
    if (!confirmed) return;
    const objectType = isNode ? 'content_item' : 'page';
    const objectId = isNode ? target.objectId : (region.dataset.cmsObjectId as string);
    const op = isNode
      ? { op: 'remove_node', node_id: target.nodeId as string }
      : { op: 'remove_section', section_id: region.dataset.cmsSectionId as string };
    const objectSession = session(objectType, objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again later.`);
      return;
    }
    const outcome = await objectSession.patch([op]);
    if (!outcome.ok) {
      setStatus(`Could not delete: ${outcome.error}`);
      return;
    }
    invalidateRecord(objectType, objectId);
    region.classList.add('dl-em-removed');
    chip.style.display = 'none';
    if (panelRegion === region) closePanel();
    setStatus('Deleted — saved as a draft. Publish + release to make it real.');
    await refreshPending();
    scheduleGapRebuild();
  };

  // ── hover chip
  let hotRegion: HTMLElement | undefined;
  let chipHideTimer: number | undefined;
  /** The margin rail's current left edge (undefined = no rail up); set by layoutRail. */
  let railLeftPx: number | undefined;
  /** The rail's current width — RAIL_W, or the margin's worth in `compact`. */
  let railWidthPx = RAIL_W;

  /** The edit target a region addresses — nodes innermost, then sections, then chrome. */
  const targetFor = (region: HTMLElement): EditTarget | undefined =>
    region.dataset.cmsNavObject !== undefined
      ? deriveNavTarget(region.dataset as Record<string, string>)
      : region.dataset.cmsNodeId !== undefined
        ? deriveNodeTarget(region.dataset as Record<string, string>)
        : deriveEditTarget(region.dataset as Record<string, string>);

  const positionChip = (region: HTMLElement): void => {
    const rect = regionRect(region);
    if (!rect) return;
    chip.style.display = 'flex';
    chip.style.visibility = 'hidden';
    const width = chip.offsetWidth;
    // With the margin rail up, the chip right-aligns to the RAIL and sits
    // above the block's bubble, so the two never collide (spec §2.1).
    // Otherwise: just past the content column, top aligned with the object's
    // first line (the heading) — well clear of the centered "+" gap buttons.
    const gutter = rect.right + 14;
    const left =
      railLeftPx !== undefined
        ? railLeftPx + railWidthPx - width
        : gutter + width <= window.innerWidth - 8
          ? gutter
          : Math.max(8, window.innerWidth - width - 10);
    chip.style.left = `${Math.max(8, left)}px`;
    chip.style.top = `${Math.max(RAIL_TOP, rect.top)}px`;
    chip.style.visibility = 'visible';
  };

  /** Labels for the related-grid selection algorithms (chip dropdown). */
  const ALGORITHM_LABELS: Record<string, string> = {
    tag_similarity: 'Similar',
    same_category: 'Same category',
    latest: 'Latest',
    random: 'Random',
  };

  // ── article-block roles (Wolf, 2026-07-13): what an editor needs at the
  // moment of action is the block's STRATEGY (Hook, Proof, Resolution…), not
  // a req_* id. Strategy is deliberately absent from the built HTML (the leak
  // rule protects readers), so the roles come from the draft record — one
  // cached fetch per article, admin-gated like every canvas read.
  const STRATEGY_LABELS: Record<string, string> = {
    hook: 'Hook',
    agitation: 'Agitation',
    context: 'Context',
    explanation: 'Explanation',
    proof: 'Proof',
    example: 'Example',
    comparison: 'Comparison',
    myth: 'Myth',
    step: 'Step',
    recommendation: 'Recommendation',
    resolution: 'Resolution',
    summary: 'Summary',
  };
  const roleOf = (node: { private?: { strategy?: string; intent?: string } } | undefined): string | undefined => {
    const strategy = node?.private?.strategy;
    if (!strategy) return undefined;
    const label = STRATEGY_LABELS[strategy] ?? strategy;
    return node?.private?.intent ? `${label} · ${node.private.intent}` : label;
  };
  const nodeRoleCache = new Map<string, Promise<Map<string, string>>>();
  const nodeRoles = (objectId: string): Promise<Map<string, string>> => {
    let cached = nodeRoleCache.get(objectId);
    if (!cached) {
      cached = cachedRecord('content_item', objectId).then(({ record }) => {
        const roles = new Map<string, string>();
        const nodes =
          (record?.body as { nodes?: Array<{ id: string; private?: { strategy?: string; intent?: string } }> })
            ?.nodes ?? [];
        for (const node of nodes) {
          const role = roleOf(node);
          if (role) roles.set(node.id, role);
        }
        return roles;
      });
      nodeRoleCache.set(objectId, cached);
    }
    return cached;
  };

  const renderChip = (region: HTMLElement): void => {
    const isNav = region.dataset.cmsNavObject !== undefined;
    const isNode = region.dataset.cmsNodeId !== undefined;
    const target = targetFor(region);
    if (!target) return;
    const hasSelection = !isNav && Boolean(currentSelectionText && selectionRegion === region);
    const isDraft = region.classList.contains('dl-em-draft');
    // Article content nodes carry an optional media image (public.media).
    const hasImage = isNode
      ? region.dataset.cmsNodeKind === 'content'
      : !isNav && IMAGE_SECTION_TYPES.has(target.sectionType);
    // A `related` content_grid announces its algorithm — the chip offers the
    // selection dropdown inline with the AI tool (small footprint, no panel).
    const algorithm = region.dataset.cmsRelatedAlgorithm;
    // Article blocks: the ROLE is the identity — no type boilerplate, no
    // req_* id (worthless to an editor; Hook/Proof/Resolution is the point).
    const typeSlot = isNode
      ? `<span data-em-role>${escapeHtml(region.dataset.cmsNodeKind ?? 'block')}</span>`
      : `<span>${escapeHtml(target.sectionType)}</span>`;
    const idSlot = isNode ? '' : `<span class="dl-em-id">${escapeHtml(target.objectId)}</span>`;
    chip.innerHTML =
      typeSlot +
      idSlot +
      (target.shared ? `<span class="dl-em-shared">${isNav ? 'site-wide' : 'shared'}</span>` : '') +
      (isDraft ? `<span class="dl-em-draftflag">draft</span>` : '') +
      `<span class="dl-em-tools">` +
      (algorithm
        ? `<select class="dl-em-alg" data-em-alg title="Selection algorithm" aria-label="Selection algorithm">` +
          Object.entries(ALGORITHM_LABELS)
            .map(
              ([value, label]) => `<option value="${value}"${value === algorithm ? ' selected' : ''}>${label}</option>`
            )
            .join('') +
          `</select>` +
          // Tiles (limit) + columns — how many articles, how many per row.
          `<input class="dl-em-num" data-em-tiles type="number" min="1" max="12" ` +
          `value="${escapeHtml(region.dataset.cmsRelatedLimit ?? '4')}" title="Tiles" aria-label="Tiles">` +
          `<input class="dl-em-num" data-em-cols type="number" min="1" max="4" ` +
          `value="${escapeHtml(region.dataset.cmsRelatedColumns ?? '2')}" title="Columns" aria-label="Columns">`
        : '') +
      `<button class="dl-em-tool dl-em-edit" title="Edit text" aria-label="Edit text">${ICON_PENCIL}</button>` +
      (hasImage
        ? `<button class="dl-em-tool dl-em-img" title="Image" aria-label="Edit image">${ICON_IMAGE}</button>`
        : '') +
      (isNode
        ? `<button class="dl-em-tool dl-em-role" title="Role & intent" aria-label="Edit role and intent">${ICON_TAG}</button>`
        : '') +
      (isNav
        ? ''
        : `<button class="dl-em-tool dl-em-ask${hasSelection ? ' dl-em-sel' : ''}" ` +
          `title="Ask AI${hasSelection ? ' about selection' : ''}" aria-label="Ask AI">${ICON_SPARKLES}</button>`) +
      // Delete lives on every tile (chrome excepted — a menu is not an
      // element), rightmost, always behind a confirmation modal.
      (isNav ? '' : `<button class="dl-em-tool dl-em-del" title="Delete" aria-label="Delete">${ICON_TRASH}</button>`) +
      `</span>`;
    chip.querySelector('.dl-em-edit')?.addEventListener('click', () => void openPanel(target, region, 'edit'));
    chip.querySelector('.dl-em-img')?.addEventListener('click', () => void openPanel(target, region, 'image'));
    chip.querySelector('.dl-em-role')?.addEventListener('click', () => void openPanel(target, region, 'role'));
    chip.querySelector('.dl-em-ask')?.addEventListener('click', () => void openPanel(target, region, 'ai'));
    chip.querySelector('.dl-em-del')?.addEventListener('click', () => void deleteRegion(target, region));
    chip.querySelector<HTMLSelectElement>('[data-em-alg]')?.addEventListener('change', (event) => {
      void applyRelated(
        target,
        region,
        { source: { kind: 'related', algorithm: (event.target as HTMLSelectElement).value } },
        `selection “${ALGORITHM_LABELS[(event.target as HTMLSelectElement).value] ?? 'updated'}”`
      );
    });
    chip.querySelector<HTMLInputElement>('[data-em-tiles]')?.addEventListener('change', (event) => {
      const limit = Math.max(1, Math.min(12, Number((event.target as HTMLInputElement).value) || 4));
      region.dataset.cmsRelatedLimit = String(limit);
      void applyRelated(target, region, { limit }, `${limit} tiles`);
    });
    chip.querySelector<HTMLInputElement>('[data-em-cols]')?.addEventListener('change', (event) => {
      const columns = Math.max(1, Math.min(4, Number((event.target as HTMLInputElement).value) || 2));
      region.dataset.cmsRelatedColumns = String(columns);
      void applyRelated(target, region, { columns }, `${columns} columns`);
    });
    positionChip(region);
    if (isNode && target.nodeId) {
      const nodeId = target.nodeId;
      void nodeRoles(target.objectId).then((roles) => {
        if (hotRegion !== region) return; // the hover moved on — stale fill
        const role = roles.get(nodeId);
        const roleEl = chip.querySelector('[data-em-role]');
        if (role && roleEl) roleEl.textContent = role;
      });
    }
  };

  /**
   * Chip control → draft: patch a related grid's config (algorithm / tile
   * count / columns) through the normal reviewable path (checkout →
   * update_section_data). Fields deep-merge; `source` always re-sends
   * kind:'related' so the union stays key-stable. Shared grids route to their
   * sec_* object. `algorithm` mirrors to the data attribute so the algorithm
   * still renders on a re-hover without a record round-trip.
   */
  const applyRelated = async (
    target: EditTarget,
    region: HTMLElement,
    fields: Record<string, unknown>,
    label: string
  ): Promise<void> => {
    setStatus(`Setting ${label}…`);
    const objectSession = session(target.objectType, target.objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again when the lock frees.`);
      return;
    }
    let sectionId = target.sectionId;
    if (!sectionId) {
      // Shared grid: the patch scopes to the inner instance id on the sec_* object.
      const { record } = await cachedRecord(target.objectType, target.objectId);
      sectionId = ((record?.body as { section?: { id?: string } })?.section?.id ?? '') || undefined;
    }
    if (!sectionId) {
      setStatus('Could not resolve the section instance to patch.');
      return;
    }
    const outcome = await objectSession.patch([{ op: 'update_section_data', section_id: sectionId, fields }]);
    if (!outcome.ok) {
      setStatus(`Not saved: ${outcome.error}`);
      return;
    }
    const source = fields.source as { algorithm?: string } | undefined;
    if (source?.algorithm) region.dataset.cmsRelatedAlgorithm = source.algorithm;
    invalidateRecord(target.objectType, target.objectId);
    region.classList.add('dl-em-draft');
    setStatus(`Set ${label} — draft saved, not published.`);
    await refreshPending();
  };

  const clearChipSoon = (): void => {
    window.clearTimeout(chipHideTimer);
    chipHideTimer = window.setTimeout(() => {
      chip.style.display = 'none';
      hotRegion?.classList.remove('dl-em-hot');
      hotRegion = undefined;
    }, RAIL_DISMISS_MS);
  };

  // ── margin rail (T17.3) ─────────────────────────────────────────────────
  // Comments live BESIDE the block they annotate, revealed by hovering it —
  // not behind a panel step. The rail is one fixed, zero-height column of
  // absolutely-positioned bubbles; ui.ts owns the DOM, rail-layout.ts owns
  // every rule (mode selection, packing, thread bucketing) so those are
  // unit-tested headlessly. Spec: docs/design/marginalia-interaction-model.md
  // §§1, 2, 8.1, 8.2, 9.

  type RailThreadRow = { key: string; blockAnchored: boolean; thread: MarginaliaThreadWithComments };
  type RailEntry = {
    key: string;
    /** The block this entry annotates, when it has one. */
    region?: HTMLElement;
    el?: HTMLElement;
    build: () => HTMLElement;
  };

  /** Every thread on every object rendered on this page, keyed by anchor. */
  let railRows: RailThreadRow[] = [];
  let railPlan: RailEntry[] = [];
  const railNodes = new Map<string, HTMLElement>();
  /** Which anchors are currently rendered — read live by bubble thread filters. */
  const railPresence = { present: new Set<string>(), deleted: new Set<string>() };
  let revealedRegion: HTMLElement | undefined;
  let pinnedRegion: HTMLElement | undefined;
  let pinnedKey: string | undefined;
  /** T17.6: the rail shows every open thread on the page instead of block bubbles. */
  let railListMode = false;
  let railRevealTimer: number | undefined;
  let railHideTimer: number | undefined;
  let railColumnRight = 0;
  let railMode: RailLayoutMode = 'inset';
  /** False until the first measurement — the cold decision takes no hysteresis. */
  let railMeasured = false;

  const railMetrics = (): RailMetrics => ({
    viewportWidth: viewportWidth(),
    columnRight: railColumnRight,
    railWidth: RAIL_W,
    railMinWidth: RAIL_MIN_W,
    railGap: RAIL_GAP,
    railPad: RAIL_PAD,
    sheetFloor: RAIL_SHEET_FLOOR,
  });

  const annotatedRegions = (): HTMLElement[] =>
    Array.from(document.querySelectorAll<HTMLElement>(`${NODE_SELECTOR}, ${REGION_SELECTOR}, ${NAV_SELECTOR}`));

  const marginaliaTargetFor = (target: EditTarget): MarginaliaPanelTarget => ({
    objectType: target.objectType,
    objectId: target.objectId,
    ...(target.sectionId !== undefined ? { sectionId: target.sectionId } : {}),
    ...(target.nodeId !== undefined ? { nodeId: target.nodeId } : {}),
  });

  const anchorKeyForRegion = (region: HTMLElement): string | undefined => {
    const target = targetFor(region);
    return target ? marginaliaAnchorKey(marginaliaTargetFor(target)) : undefined;
  };

  /**
   * The content column the rail hangs off: the widest in-viewport annotated
   * CONTENT column (spec §1.2 — one rail x per page, never a ragged edge).
   *
   * Two things are deliberately not columns. The navigation object wraps the
   * sticky, full-bleed site header, which is in the viewport at every scroll
   * position — measuring it made `columnRight` the viewport width on every
   * page. And any box still spanning the viewport after `contentRect` has
   * descended is a full-bleed band, i.e. page chrome. Both are skipped, so
   * what is left is the reading column.
   *
   * Nothing writes page padding anymore (Wolf, 2026-08-11), so the measurement
   * can no longer be reading back its own output: the old remove-the-slide /
   * restore-the-slide dance around this loop went with the slide.
   */
  const measureColumnRight = (): number => {
    const width = viewportWidth();
    const limit = width * FULL_BLEED_RATIO;
    let inViewport = 0;
    let anywhere = 0;
    for (const region of annotatedRegions()) {
      if (region.matches(NAV_SELECTOR) || region.closest(NAV_SELECTOR)) continue;
      const rect = contentRect(region);
      if (!rect || rect.width === 0 || rect.width >= limit) continue;
      anywhere = Math.max(anywhere, rect.right);
      if (rect.bottom < 0 || rect.top > window.innerHeight) continue;
      inViewport = Math.max(inViewport, rect.right);
    }
    return inViewport || anywhere || width;
  };

  /** Where a bubble wants to sit: its block's top, below the chip when both show. */
  const desiredTopFor = (entry: RailEntry): number => {
    if (!entry.region) return RAIL_TOP;
    const rect = regionRect(entry.region);
    if (!rect) return RAIL_TOP;
    const chipOffset =
      hotRegion === entry.region && chip.style.display !== 'none' ? chip.offsetHeight + RAIL_STACK_GAP : 0;
    return Math.max(RAIL_TOP, rect.top + chipOffset);
  };

  /**
   * Re-derive the content column and, from it, the layout mode. Called on
   * activation, on resize, and on the content-rebuild cadence — and NOWHERE
   * else. Hover, focus, pinning and thread writes re-run `layoutRail` without
   * remeasuring, so a pointer cannot change the page's layout at all (Wolf,
   * 2026-08-11).
   */
  const remeasureRail = (): void => {
    railColumnRight = measureColumnRight();
    railMode = selectRailLayoutMode(railMetrics(), railMeasured ? railMode : undefined);
    railMeasured = true;
  };

  /**
   * Place the rail and pack its bubbles. `remeasure` re-derives the content
   * column and the mode (activation / resize / the gap layer's rebuild
   * cadence); every other pass reuses both and only re-runs the cheap packing.
   *
   * NOTHING here writes to `<body>` or `<html>`: the page stays exactly where
   * it is published at every width, and the rail is what adapts.
   */
  const layoutRail = (remeasure = false): void => {
    if (remeasure || !railMeasured) remeasureRail();
    const metrics = railMetrics();
    // `markers`: no rail column at all. The gutter markers are the surface,
    // and an opened marker's bubble shows as a popover anchored to it.
    const popover = railMode === 'markers';
    const popoverKey = pinnedKey ? `block:${pinnedKey}` : railListMode ? ATTENTION_LIST_KEY : undefined;
    const active =
      document.body.classList.contains('dl-em-on') &&
      railPlan.length > 0 &&
      (!popover || railPlan.some((entry) => entry.key === popoverKey));
    rail.classList.toggle('dl-em-rail-on', active);
    rail.classList.toggle('dl-em-rail-sheet', railMode === 'sheet');
    railLeftPx = undefined;
    if (!active) {
      rail.style.left = '';
      return;
    }
    // `compact` narrows the rail to the margin the page really has — a single
    // custom-property write, because .dl-em-rail is sized by --dlem-rail-w.
    railWidthPx = railWidthFor(railMode, metrics) ?? Math.min(RAIL_W, metrics.viewportWidth - 2 * RAIL_PAD);
    rail.style.setProperty('--dlem-rail-w', `${railWidthPx}px`);
    for (const entry of railPlan) {
      if (entry.el) entry.el.style.display = !popover || entry.key === popoverKey ? '' : 'none';
    }
    if (railMode === 'sheet') {
      // The sheet is normal flow: no absolute tops, no rail x, no connectors.
      rail.style.left = '';
      for (const entry of railPlan) {
        if (!entry.el) continue;
        entry.el.style.top = '';
        entry.el.querySelector<HTMLElement>('.dl-em-bubble-link')?.remove();
      }
      positionGutter();
      return;
    }
    if (popover) {
      const entry = railPlan.find((candidate) => candidate.key === popoverKey);
      const at = entry?.region ? markerPosition(entry.region) : undefined;
      const rightLimit = Math.max(RAIL_PAD, metrics.viewportWidth - RAIL_PAD - railWidthPx);
      rail.style.left = `${Math.max(RAIL_PAD, Math.min(at?.left ?? rightLimit, rightLimit))}px`;
      if (entry?.el) {
        entry.el.style.top = `${Math.max(RAIL_TOP, at?.top ?? RAIL_TOP)}px`;
        entry.el.querySelector<HTMLElement>('.dl-em-bubble-link')?.remove();
      }
      positionGutter();
      // The chip lags the rail by a frame unless it moves in the same pass.
      if (hotRegion && chip.style.display !== 'none') positionChip(hotRegion);
      return;
    }
    railLeftPx = railLeftFor(railMode, metrics);
    rail.style.left = `${railLeftPx ?? 0}px`;
    const ordered = [...railPlan].sort((a, b) => railOrder(a) - railOrder(b));
    const boxes = ordered.map((entry) => ({
      desiredTop: desiredTopFor(entry),
      height: entry.el?.offsetHeight ?? 0,
    }));
    const tops = packRailEntries(boxes, RAIL_STACK_GAP);
    ordered.forEach((entry, index) => {
      const el = entry.el;
      if (!el) return;
      el.style.top = `${tops[index]}px`;
      // A bubble the packer displaced draws a 1px line back to its block.
      const drop = tops[index] - boxes[index].desiredTop;
      let link = el.querySelector<HTMLElement>('.dl-em-bubble-link');
      if (entry.region && drop > 2) {
        if (!link) {
          link = document.createElement('div');
          link.className = 'dl-em-bubble-link';
          el.append(link);
        }
        link.style.top = `${-drop}px`;
        link.style.height = `${drop}px`;
      } else {
        link?.remove();
      }
    });
    positionGutter();
    // The chip right-aligns to the rail, so it has to move in the SAME pass —
    // otherwise it lags the rail by a frame on every relayout.
    if (hotRegion && chip.style.display !== 'none') positionChip(hotRegion);
  };

  /**
   * Scroll repositioning runs once per frame: layoutRail reads offsetHeight,
   * and doing that synchronously inside a scroll event forces a reflow per
   * event. rAF batches it to one read just before paint.
   */
  let railFrame: number | undefined;
  const scheduleRailFrame = (): void => {
    if (railFrame !== undefined) return;
    railFrame = window.requestAnimationFrame(() => {
      railFrame = undefined;
      layoutRail();
    });
  };

  /** Rail order: the attention list, whole-object groups, blocks in document order, orphans. */
  const railOrder = (entry: RailEntry): number => {
    if (entry.key === ATTENTION_LIST_KEY) return -2;
    if (entry.key.startsWith('whole:')) return -1;
    if (entry.key.startsWith('orphan:')) return Number.MAX_SAFE_INTEGER;
    return desiredTopFor(entry);
  };

  const threadsAtKey = (key: string): MarginaliaThreadWithComments[] =>
    railRows.filter((row) => row.key === key).map((row) => row.thread);

  const openThreadsOf = (threads: readonly MarginaliaThreadWithComments[]): MarginaliaThreadWithComments[] =>
    threads.filter((thread) => thread.status === 'open');

  type BubbleSpec = {
    key: string;
    title: string;
    target: MarginaliaPanelTarget;
    selectThreads: (threads: readonly MarginaliaThreadWithComments[]) => MarginaliaThreadWithComments[];
    emptyLabel: string;
    region?: HTMLElement;
    /** The ANCHOR key this bubble pins under; absent on whole-object/orphan groups, which always show. */
    pinKey?: string;
  };

  const buildBubble = (spec: BubbleSpec): HTMLElement => {
    const el = document.createElement('div');
    el.className = 'dl-em-bubble';
    el.dataset.emBubble = spec.key;
    // A block bubble is what its gutter marker's aria-controls points at.
    if (spec.pinKey) el.id = bubbleDomId(spec.pinKey);
    el.innerHTML =
      `<div class="dl-em-bubble-head">` +
      `<span class="dl-em-bubble-title">${escapeHtml(spec.title)}</span>` +
      `<span class="dl-em-bubble-open" hidden></span>` +
      `<button class="dl-em-close" data-em-bubble-close aria-label="Close">${ICON_CLOSE}</button>` +
      `</div><div class="dl-em-bubble-body"></div>`;
    const openEl = el.querySelector<HTMLElement>('.dl-em-bubble-open');
    const moreButton = document.createElement('button');
    moreButton.type = 'button';
    moreButton.className = 'dl-em-bubble-more';
    moreButton.hidden = true;
    let expanded = false;
    moreButton.addEventListener('click', (event) => {
      event.stopPropagation();
      expanded = true;
      moreButton.hidden = true;
      remountBubbleBody();
    });

    el.querySelector('[data-em-bubble-close]')?.addEventListener('click', (event) => {
      event.stopPropagation();
      unpinRail();
      revealedRegion = undefined;
      renderRail();
    });
    // Click or focus anywhere in a bubble pins it (spec §2.3) — a hover-only
    // bubble cannot host a composer.
    if (spec.pinKey) {
      const pinKey = spec.pinKey;
      el.addEventListener('mousedown', () => pinRail(pinKey, spec.region));
      el.addEventListener('focusin', () => pinRail(pinKey, spec.region));
    }

    const body = el.querySelector<HTMLElement>('.dl-em-bubble-body') as HTMLElement;
    const remountBubbleBody = (): void => {
      void mountMarginaliaPanel(
        body,
        getToken,
        spec.target,
        cachedMarginaliaThreads(spec.target.objectType, spec.target.objectId),
        () => {
          invalidateMarginaliaThreads(spec.target.objectType, spec.target.objectId);
          void refreshRailThreads();
        },
        {
          selectThreads: (threads) => {
            const mine = spec.selectThreads(threads);
            if (openEl) {
              const open = openThreadsOf(mine).length;
              openEl.hidden = open === 0;
              openEl.textContent = `${open} open`;
            }
            const { visible, hidden } = expanded ? { visible: [...mine], hidden: 0 } : collapseThreadStack(mine);
            moreButton.hidden = hidden === 0;
            moreButton.textContent = `+${hidden} earlier`;
            return visible;
          },
          emptyLabel: spec.emptyLabel,
          composerPlaceholder: 'Comment — a question, a change, an ask',
        }
      );
      body.append(moreButton);
    };
    remountBubbleBody();
    return el;
  };

  const wholeObjectLabel = (objectType: string): string =>
    objectType === 'content_item' ? 'Whole article' : objectType === 'page' ? 'Whole page' : 'Whole object';

  /** The set of bubbles the rail should be showing right now. */
  const railEntryPlan = (): RailEntry[] => {
    railPresence.present = new Set<string>();
    railPresence.deleted = new Set<string>();
    const regionByKey = new Map<string, HTMLElement>();
    for (const region of annotatedRegions()) {
      const key = anchorKeyForRegion(region);
      if (!key) continue;
      if (region.classList.contains('dl-em-removed')) {
        railPresence.deleted.add(key);
        continue;
      }
      railPresence.present.add(key);
      if (!regionByKey.has(key)) regionByKey.set(key, region);
    }

    const partition = partitionRailThreads<RailThreadRow>(
      railRows.map((row) => ({ key: row.key, blockAnchored: row.blockAnchored, thread: row })),
      railPresence.present
    );
    const plan: RailEntry[] = [];

    // 1 — whole-object threads pin to the rail top, one bubble per object (§3.1).
    const wholeByObject = new Map<string, { objectType: string; objectId: string }>();
    for (const row of partition.wholeObject) {
      wholeByObject.set(`${row.thread.anchor.objectType}:${row.thread.anchor.objectId}`, {
        objectType: row.thread.anchor.objectType,
        objectId: row.thread.anchor.objectId,
      });
    }
    for (const [id, object] of wholeByObject) {
      const key = `whole:${id}`;
      plan.push({
        key,
        build: () =>
          buildBubble({
            key,
            title: wholeObjectLabel(object.objectType),
            target: { objectType: object.objectType, objectId: object.objectId },
            selectThreads: (threads) => threads.filter((thread) => !isBlockAnchor(thread.anchor)),
            emptyLabel: 'No comments on the whole object yet.',
          }),
      });
    }

    // 1b — list mode (the `Attention N` control): every open thread on the
    //      page in one card, document order, orphans last (§4.3).
    if (railListMode) plan.push(attentionListEntry(partition, regionByKey));

    // 2 — the revealed and/or pinned block. A block with threads gets its
    //     bubble; one without gets the concept's ghost speech bubble, which
    //     opens an empty composer on click. A PINNED block always gets the
    //     real bubble — that is what pinning is for.
    const blockKeys = new Map<string, HTMLElement>();
    if (pinnedKey && pinnedRegion && pinnedRegion.isConnected) blockKeys.set(pinnedKey, pinnedRegion);
    if (revealedRegion?.isConnected) {
      const key = anchorKeyForRegion(revealedRegion);
      if (key && !blockKeys.has(key)) blockKeys.set(key, revealedRegion);
    }
    for (const [key, region] of blockKeys) {
      const target = targetFor(region);
      if (!target) continue;
      const pinned = key === pinnedKey;
      if (!pinned && threadsAtKey(key).length === 0) {
        plan.push({ key: `ghost:${key}`, region, build: () => buildGhostBubble(key, region) });
        continue;
      }
      plan.push({
        key: `block:${key}`,
        region,
        build: () =>
          buildBubble({
            key: `block:${key}`,
            title: blockLabel(region, target),
            target: marginaliaTargetFor(target),
            selectThreads: (threads) => threads.filter((thread) => marginaliaAnchorKey(thread.anchor) === key),
            emptyLabel: 'No comments on this block yet.',
            region,
            pinKey: key,
          }),
      });
    }

    // 3 — orphans: never dropped, never auto-resolved (§8.2). A draft-deleted
    //     block's threads are labelled separately, because the block comes
    //     back if the draft is discarded.
    const orphanObjects = new Map<string, { objectType: string; objectId: string; draftDeleted: boolean }>();
    for (const row of partition.orphans) {
      const draftDeleted = railPresence.deleted.has(row.key);
      const id = `${row.thread.anchor.objectType}:${row.thread.anchor.objectId}:${draftDeleted ? 'draft' : 'gone'}`;
      orphanObjects.set(id, {
        objectType: row.thread.anchor.objectType,
        objectId: row.thread.anchor.objectId,
        draftDeleted,
      });
    }
    for (const [id, object] of orphanObjects) {
      const key = `orphan:${id}`;
      plan.push({
        key,
        build: () =>
          buildBubble({
            key,
            title: object.draftDeleted ? 'Block deleted in a draft' : 'Not on this page anymore',
            target: { objectType: object.objectType, objectId: object.objectId },
            selectThreads: (threads) =>
              threads.filter((thread) => {
                if (!isBlockAnchor(thread.anchor)) return false;
                const anchorKey = marginaliaAnchorKey(thread.anchor);
                if (railPresence.present.has(anchorKey)) return false;
                return railPresence.deleted.has(anchorKey) === object.draftDeleted;
              }),
            emptyLabel: 'Nothing here anymore.',
          }),
      });
    }
    return plan;
  };

  /** A short, human name for the block a bubble annotates. */
  const blockLabel = (region: HTMLElement, target: EditTarget): string =>
    target.objectType === 'content_item'
      ? `Article ${region.dataset.cmsNodeKind ?? 'block'}`
      : target.sectionType || 'Block';

  const buildGhostBubble = (key: string, region: HTMLElement): HTMLElement => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'dl-em-ghostbubble';
    button.innerHTML = ICON_COMMENT;
    button.title = 'Comment on this block';
    button.setAttribute('aria-label', 'Comment on this block');
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      pinRail(key, region);
    });
    return button;
  };

  /** Reconcile the rail's DOM against the plan — existing bubbles are kept, never rebuilt. */
  const renderRail = (): void => {
    const plan = document.body.classList.contains('dl-em-on') ? railEntryPlan() : [];
    const wanted = new Set(plan.map((entry) => entry.key));
    for (const [key, el] of railNodes) {
      if (wanted.has(key)) continue;
      el.remove();
      railNodes.delete(key);
    }
    const pinnedEntryKey = pinnedKey ? `block:${pinnedKey}` : undefined;
    for (const entry of plan) {
      let el = railNodes.get(entry.key);
      if (!el) {
        el = entry.build();
        railNodes.set(entry.key, el);
        rail.append(el);
      }
      el.classList.toggle('dl-em-pinned', entry.key === pinnedEntryKey);
      entry.el = el;
    }
    railPlan = plan;
    layoutRail();
    renderGutter();
  };

  /** Every object rendered on this page, deduplicated — the rail's fetch set. */
  const pageObjects = (): Array<{ type: string; id: string }> => {
    const objects = new Map<string, { type: string; id: string }>();
    for (const region of annotatedRegions()) {
      const target = targetFor(region);
      if (target)
        objects.set(recordKey(target.objectType, target.objectId), { type: target.objectType, id: target.objectId });
    }
    return [...objects.values()];
  };

  /**
   * Re-read every page object's threads from the (preloaded) marginalia cache
   * and re-render. Called on activation and after every thread write — never
   * on a timer: there is no background polling in V1 (spec §8.5).
   */
  const refreshRailThreads = async (): Promise<void> => {
    const results = await Promise.all(
      pageObjects().map(async (object) => {
        try {
          return (await cachedMarginaliaThreads(object.type, object.id)).threads;
        } catch {
          return [] as MarginaliaThreadWithComments[];
        }
      })
    );
    railRows = results.flat().map((thread) => ({
      key: marginaliaAnchorKey(thread.anchor),
      blockAnchored: isBlockAnchor(thread.anchor),
      thread,
    }));
    updateAttentionCount();
    // List mode's rows are a snapshot of the plan, so a write has to rebuild
    // the card rather than keep it (reconciliation would preserve it by key).
    railNodes.get(ATTENTION_LIST_KEY)?.remove();
    railNodes.delete(ATTENTION_LIST_KEY);
    renderRail();
  };

  const pinRail = (key: string, region: HTMLElement | undefined): void => {
    if (pinnedKey === key) return;
    pinnedKey = key;
    pinnedRegion = region;
    window.clearTimeout(railHideTimer);
    renderRail();
  };

  const unpinRail = (): void => {
    if (!pinnedKey) return;
    pinnedKey = undefined;
    pinnedRegion = undefined;
    renderRail();
  };

  const scheduleRailReveal = (region: HTMLElement): void => {
    window.clearTimeout(railRevealTimer);
    window.clearTimeout(railHideTimer);
    // While a block is in inline edit (T17.8), other blocks' hover-reveal is
    // suppressed — the edited block's own bubble stays pinned (spec §5.3).
    if (inlineEdit && inlineEdit.region !== region) return;
    if (revealedRegion === region) return;
    railRevealTimer = window.setTimeout(() => {
      revealedRegion = region;
      renderRail();
    }, RAIL_REVEAL_MS);
  };

  const clearRailSoon = (): void => {
    window.clearTimeout(railRevealTimer);
    window.clearTimeout(railHideTimer);
    railHideTimer = window.setTimeout(() => {
      if (!revealedRegion) return;
      revealedRegion = undefined;
      renderRail();
    }, RAIL_DISMISS_MS);
  };

  // ── attention: gutter markers, the toolbar counter, list mode (T17.6) ────
  // The surface has to answer the question an editor actually has — what
  // needs me? — without opening anything. Every number here means ONE thing:
  // an open thread (attention.ts owns that definition and its tests).
  // Spec §4, §9, §10.2.

  const ATTENTION_LIST_KEY = 'list:attention';
  const attentionCountEl = q<HTMLElement>(bar, '[data-em-attention-count]');
  const attentionButton = q<HTMLButtonElement>(bar, '[data-em-attention]');
  const gutterMarkers = new Map<string, HTMLButtonElement>();
  /** Stable element ids so a marker's aria-controls can name its bubble. */
  const bubbleDomIds = new Map<string, string>();

  const bubbleDomId = (anchorKey: string): string => {
    let id = bubbleDomIds.get(anchorKey);
    if (!id) {
      id = `dl-em-bubble-${bubbleDomIds.size + 1}`;
      bubbleDomIds.set(anchorKey, id);
    }
    return id;
  };

  const updateAttentionCount = (): void => {
    const total = pageAttentionTotal(railRows);
    attentionCountEl.textContent = String(total);
    attentionCountEl.classList.toggle('dl-em-hot', total > 0);
  };

  /**
   * Where a marker sits: the block's own leading edge, one gutter step left.
   * `contentRect`, not `regionRect` — a full-bleed section's band starts at
   * x=0, which pinned every marker on such a block to the clamp at x=4.
   */
  const markerPosition = (region: HTMLElement): { left: number; top: number } | undefined => {
    const rect = contentRect(region);
    if (!rect) return undefined;
    return { left: Math.max(4, rect.left - GUTTER_X), top: Math.max(RAIL_TOP, rect.top) };
  };

  const markerRegions = new Map<string, HTMLElement>();

  const positionGutter = (): void => {
    for (const [key, marker] of gutterMarkers) {
      const region = markerRegions.get(key);
      const at = region ? markerPosition(region) : undefined;
      if (!at) {
        marker.style.display = 'none';
        continue;
      }
      marker.style.display = '';
      marker.style.left = `${at.left}px`;
      marker.style.top = `${at.top}px`;
    }
    positionDraftChips();
  };

  /**
   * One marker per annotated block that has something to show: any block with
   * threads, plus the hovered block (which gets the concept's accent dot as
   * its "you can comment here" affordance). Everything else draws nothing.
   */
  const renderGutter = (): void => {
    if (!document.body.classList.contains('dl-em-on')) {
      gutter.replaceChildren();
      gutterMarkers.clear();
      markerRegions.clear();
      return;
    }
    const counts = blockAttentionCounts(railRows);
    const wanted = new Map<string, { region: HTMLElement; counts: BlockAttention; hovered: boolean }>();
    for (const region of annotatedRegions()) {
      if (region.classList.contains('dl-em-removed')) continue;
      const key = anchorKeyForRegion(region);
      if (!key) continue;
      const blockCounts = counts.get(key) ?? { open: 0, resolved: 0 };
      const hovered = region === hotRegion || region === revealedRegion || key === pinnedKey;
      if (gutterMarkerState({ ...blockCounts, hovered }) === 'none') continue;
      if (!wanted.has(key)) wanted.set(key, { region, counts: blockCounts, hovered });
    }
    for (const [key, marker] of gutterMarkers) {
      if (wanted.has(key)) continue;
      marker.remove();
      gutterMarkers.delete(key);
      markerRegions.delete(key);
    }
    for (const [key, entry] of wanted) {
      let marker = gutterMarkers.get(key);
      if (!marker) {
        marker = document.createElement('button');
        marker.type = 'button';
        marker.className = 'dl-em-badge';
        marker.dataset.emRegionKey = key;
        marker.addEventListener('click', (event) => {
          event.stopPropagation();
          const region = markerRegions.get(key);
          if (pinnedKey === key) unpinRail();
          else pinRail(key, region);
        });
        gutter.append(marker);
        gutterMarkers.set(key, marker);
      }
      markerRegions.set(key, entry.region);
      const target = targetFor(entry.region);
      const state = gutterMarkerState({ ...entry.counts, hovered: entry.hovered });
      marker.classList.toggle('dl-em-badge-open', state === 'count');
      marker.classList.toggle('dl-em-badge-muted', state === 'muted');
      marker.classList.toggle('dl-em-badge-accent', state === 'accent');
      // Colour is never the only carrier of "needs attention" — the numeral is.
      marker.textContent = state === 'count' ? String(entry.counts.open) : '';
      marker.setAttribute(
        'aria-label',
        markerAriaLabel(state, entry.counts.open, target ? blockLabel(entry.region, target) : 'this block')
      );
      marker.setAttribute('aria-expanded', String(pinnedKey === key));
      marker.setAttribute('aria-controls', bubbleDomId(key));
    }
    positionGutter();
  };

  // The inline "· draft" chip (spec §10.2, folded in here): the PDF shows
  // draft state beside the block's heading, in the flow. It is drawn in the
  // gutter layer rather than injected into the heading, because inserting a
  // node into rendered copy would break previewFieldChange's exact-text match
  // — and the dashed .dl-em-draft outline stays exactly as it was.
  const draftChips = new Map<HTMLElement, HTMLElement>();

  /** The end of the block's title line, in viewport coordinates. */
  const draftChipAnchor = (region: HTMLElement): { left: number; top: number } | undefined => {
    const heading = region.querySelector<HTMLElement>('h1,h2,h3,h4,h5,h6') ?? undefined;
    const host = heading ?? (region.firstElementChild as HTMLElement | null) ?? undefined;
    if (!host) return undefined;
    const range = document.createRange();
    range.selectNodeContents(host);
    const rects = Array.from(range.getClientRects());
    const last = rects[rects.length - 1];
    if (!last || last.width === 0) return undefined;
    return { left: last.right + 8, top: last.top + last.height / 2 - 8 };
  };

  const positionDraftChips = (): void => {
    const drafts = new Set(
      Array.from(document.querySelectorAll<HTMLElement>(`${REGION_SELECTOR}.dl-em-draft, ${NODE_SELECTOR}.dl-em-draft`))
    );
    for (const [region, chipEl] of draftChips) {
      if (drafts.has(region) && region.isConnected) continue;
      chipEl.remove();
      draftChips.delete(region);
    }
    for (const region of drafts) {
      const at = draftChipAnchor(region);
      let chipEl = draftChips.get(region);
      if (!at) {
        chipEl?.remove();
        draftChips.delete(region);
        continue;
      }
      if (!chipEl) {
        chipEl = document.createElement('span');
        chipEl.className = 'dl-em-draftchip';
        chipEl.textContent = '· draft';
        chipEl.title = 'Unpublished draft';
        gutter.append(chipEl);
        draftChips.set(region, chipEl);
      }
      chipEl.style.left = `${at.left}px`;
      chipEl.style.top = `${at.top}px`;
    }
  };

  /**
   * List mode: every OPEN thread on the page in document order, whole-object
   * first, orphans last under their own heading. A row scrolls its block into
   * view and pins its bubble (§4.3).
   */
  const attentionListEntry = (
    partition: RailPartition<RailThreadRow>,
    regionByKey: Map<string, HTMLElement>
  ): RailEntry => ({
    key: ATTENTION_LIST_KEY,
    build: () => {
      const el = document.createElement('div');
      el.className = 'dl-em-bubble dl-em-bubble-list';
      el.innerHTML =
        `<div class="dl-em-bubble-head"><span class="dl-em-bubble-title">Needs you</span>` +
        `<button class="dl-em-close" data-em-list-close aria-label="Close">${ICON_CLOSE}</button></div>` +
        `<div class="dl-em-listrows"></div>`;
      el.querySelector('[data-em-list-close]')?.addEventListener('click', (event) => {
        event.stopPropagation();
        setListMode(false);
      });
      const rows = el.querySelector<HTMLElement>('.dl-em-listrows') as HTMLElement;
      const addRow = (label: string, thread: MarginaliaThreadWithComments, key?: string): void => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'dl-em-listrow';
        const first = thread.comments[0]?.body ?? '';
        button.innerHTML =
          `<span class="dl-em-listwhere">${escapeHtml(label)}</span>` +
          `<span class="dl-em-listbody">${escapeHtml(shortValue(first))}</span>`;
        if (key) {
          button.addEventListener('click', () => {
            const region = regionByKey.get(key);
            region?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            pinRail(key, region);
          });
        } else {
          button.disabled = true;
        }
        rows.append(button);
      };
      const openOnly = (list: readonly RailThreadRow[]): RailThreadRow[] =>
        list.filter((entry) => entry.thread.status === 'open');
      for (const entry of openOnly(partition.wholeObject)) addRow('Whole object', entry.thread);
      // Document order: walk the DOM, not the thread list.
      for (const region of annotatedRegions()) {
        const key = anchorKeyForRegion(region);
        if (!key) continue;
        const target = targetFor(region);
        for (const entry of openOnly(partition.blocks.get(key) ?? [])) {
          addRow(target ? blockLabel(region, target) : 'Block', entry.thread, key);
        }
      }
      const orphans = openOnly(partition.orphans);
      if (orphans.length > 0) {
        const heading = document.createElement('div');
        heading.className = 'dl-em-listhead';
        heading.textContent = 'Not on this page anymore';
        rows.append(heading);
        for (const entry of orphans) addRow('Orphaned', entry.thread);
      }
      if (rows.children.length === 0) {
        rows.innerHTML = `<div class="dl-em-msg dl-em-sys">Nothing open on this page.</div>`;
      }
      return el;
    },
  });

  const setListMode = (on: boolean): void => {
    if (railListMode === on) return;
    railListMode = on;
    attentionButton.setAttribute('aria-pressed', String(on));
    attentionButton.classList.toggle('dl-em-primary', on);
    // The list is rebuilt from scratch: its rows are a snapshot of the plan.
    railNodes.get(ATTENTION_LIST_KEY)?.remove();
    railNodes.delete(ATTENTION_LIST_KEY);
    renderRail();
  };

  attentionButton.addEventListener('click', () => {
    // Counts can be stale between actions — there is no background polling
    // (spec §8.5), so this click is one of the three refresh points.
    void refreshRailThreads();
    setListMode(!railListMode);
  });

  // Focus reveals exactly what hover reveals (spec §9) — keyboard users are
  // not second class.
  document.addEventListener(
    'focusin',
    (event) => {
      if (!document.body.classList.contains('dl-em-on')) return;
      const element = event.target as HTMLElement | null;
      if (!element || rail.contains(element) || chip.contains(element) || panel.contains(element)) return;
      const region =
        element.closest<HTMLElement>(NODE_SELECTOR) ??
        element.closest<HTMLElement>(REGION_SELECTOR) ??
        element.closest<HTMLElement>(NAV_SELECTOR);
      if (!region) return;
      window.clearTimeout(railHideTimer);
      if (revealedRegion === region) return;
      revealedRegion = region;
      renderRail();
    },
    { signal }
  );

  // Esc unpins and hands focus back to the block (spec §2.3, §9).
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !pinnedKey) return;
      const returnTo = pinnedRegion;
      unpinRail();
      revealedRegion = undefined;
      renderRail();
      if (returnTo?.isConnected) returnTo.focus?.();
    },
    { signal }
  );

  // A click outside both the bubble and its own block unpins (spec §2.3).
  document.addEventListener(
    'click',
    (event) => {
      if (!pinnedKey) return;
      const element = event.target as HTMLElement | null;
      if (!element) return;
      if (rail.contains(element) || panel.contains(element) || chip.contains(element)) return;
      if (pinnedRegion?.contains(element)) return;
      unpinRail();
    },
    { signal }
  );

  document.addEventListener(
    'mouseover',
    (event) => {
      if (!document.body.classList.contains('dl-em-on')) return;
      const element = event.target as HTMLElement;
      if (chip.contains(element)) {
        window.clearTimeout(chipHideTimer);
        window.clearTimeout(railHideTimer);
        return;
      }
      // The pointer inside the rail keeps everything up — the same guard
      // shape the chip has always had (spec §2.2).
      if (rail.contains(element)) {
        window.clearTimeout(chipHideTimer);
        window.clearTimeout(railHideTimer);
        window.clearTimeout(railRevealTimer);
        return;
      }
      // Article nodes first (innermost, inside the post body), then sections
      // (inside <main>), then chrome (header/footer wrap a nav object) — a
      // hover matches exactly one editable region.
      const region =
        element.closest<HTMLElement>(NODE_SELECTOR) ??
        element.closest<HTMLElement>(REGION_SELECTOR) ??
        element.closest<HTMLElement>(NAV_SELECTOR);
      if (!region) {
        clearChipSoon();
        clearRailSoon();
        return;
      }
      window.clearTimeout(chipHideTimer);
      if (region !== hotRegion) {
        hotRegion?.classList.remove('dl-em-hot');
        hotRegion = region;
        region.classList.add('dl-em-hot');
        renderChip(region);
        scheduleRailReveal(region);
        renderGutter(); // the hovered block's marker appears/changes state
      }
    },
    { signal }
  );
  document.addEventListener(
    'scroll',
    () => {
      if (hotRegion && chip.style.display !== 'none') positionChip(hotRegion);
      if (railPlan.length > 0) scheduleRailFrame();
    },
    { passive: true, signal }
  );

  // ── selection tracking
  let currentSelectionText: string | undefined;
  let selectionRegion: HTMLElement | undefined;
  document.addEventListener(
    'mouseup',
    (event) => {
      if (!document.body.classList.contains('dl-em-on')) return;
      // A mouseup on the chip itself must not re-render it: the click event
      // dispatches AFTER mouseup, and re-rendering would replace the Ask-AI
      // button before its click listener ever fires.
      if (chip.contains(event.target as Node)) return;
      // A double-click selects a word on its way into the inline editor
      // (T17.8) — that is a gesture, not an Ask-AI scope. Drop any scope that
      // was armed too, so a double-click can never leave one behind (§5.3).
      if (!shouldCaptureSelection(event.detail)) {
        currentSelectionText = undefined;
        selectionRegion = undefined;
        if (hotRegion) renderChip(hotRegion);
        return;
      }
      const selection = window.getSelection();
      const anchor = selection?.anchorNode;
      const anchorElement =
        anchor && anchor.nodeType === Node.ELEMENT_NODE ? (anchor as HTMLElement) : (anchor?.parentElement ?? null);
      const region =
        anchorElement?.closest<HTMLElement>(NODE_SELECTOR) ??
        anchorElement?.closest<HTMLElement>(REGION_SELECTOR) ??
        undefined;
      currentSelectionText = region ? captureObjectSelection(region) : undefined;
      selectionRegion = currentSelectionText ? region : undefined;
      if (hotRegion) renderChip(hotRegion);
    },
    { signal }
  );

  // ── the editable unit inside a record body
  // A region addresses one section instance or one article node. Both the
  // panel and the inline editor (T17.8) need the same resolution, and they
  // must not drift: one function, two callers.
  type ArticleNode = {
    id: string;
    public?: Record<string, unknown>;
    private?: { strategy?: string; intent?: string; agentNotes?: string };
  };
  type EditableUnit = { currentData: Record<string, unknown>; patchSectionId: string; node?: ArticleNode };

  const editableUnitFor = (target: EditTarget, body: Record<string, unknown>): EditableUnit | undefined => {
    if (target.objectType === 'page') {
      const sectionList = (body.sections as Array<{ id: string; data: Record<string, unknown> }> | undefined) ?? [];
      const instance = sectionList.find((entry) => entry.id === target.sectionId);
      return instance?.data && instance.id ? { currentData: instance.data, patchSectionId: instance.id } : undefined;
    }
    if (target.objectType === 'content_item') {
      // Article node (W7.8): the editable unit is the node's PUBLIC fields —
      // update_node scopes by target.nodeId (patchSectionId is unused there
      // but kept non-empty for the shared panel state shape).
      const nodes = (body.nodes as ArticleNode[] | undefined) ?? [];
      const node = nodes.find((entry) => entry.id === target.nodeId);
      return node?.public && node.id ? { currentData: node.public, patchSectionId: node.id, node } : undefined;
    }
    if (target.objectType === 'section') {
      const inner = body.section as { id: string; data: Record<string, unknown> } | undefined;
      return inner?.data && inner.id ? { currentData: inner.data, patchSectionId: inner.id } : undefined;
    }
    return undefined; // navigation edits through the nav grammar, never a data blob
  };

  // ── double-click to edit, inline (T17.8) ────────────────────────────────
  // Changing a word used to cost hover → chip → pencil → panel → field →
  // save. The concept removes all of it for the common case: double-click the
  // block, type, commit. The write is the SAME EditSession checkout → patch
  // the panel uses — there is deliberately no second write path (spec §5.2).
  type InlineEditState = {
    region: HTMLElement;
    target: EditTarget;
    field: InlineField;
    patchSectionId: string;
    /** The value at entry — what Esc reverts to and what a commit diffs against. */
    before: unknown;
    snapshot: RegionSnapshot;
    host: HTMLElement;
    richText?: RichTextEditorHandle;
    /** The formatting bubble, when the field takes one. */
    toolbar?: InlineToolbarHandle;
    committing: boolean;
  };
  let inlineEdit: InlineEditState | undefined;

  /** Read the surface back: a rich-text document, or the text the editor holds. */
  const inlineEditValue = (edit: InlineEditState): unknown => {
    if (edit.field.kind === 'doc') return edit.richText?.getRichTextV1();
    // innerText keeps line breaks (blank line = new paragraph for article
    // bodies); nbsp from contenteditable normalises back to a plain space.
    return (edit.host.innerText ?? '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\t ]+$/gm, '')
      .replace(/\n+$/, '');
  };

  /**
   * A commit is a round trip, so the surface outlives the keystroke that ends
   * it. Anything that would start a NEW edit waits on this, and every teardown
   * names the edit it tears down — otherwise a slow save could restore its own
   * snapshot over whatever the editor is doing by then.
   */
  let inlineCommitInFlight: Promise<void> = Promise.resolve();

  /** Leave inline edit, restoring the block's rendered content. */
  const finishInlineEdit = (edit: InlineEditState): void => {
    if (inlineEdit === edit) inlineEdit = undefined;
    edit.toolbar?.destroy();
    edit.richText?.destroy();
    restoreRegion(edit.snapshot);
    edit.region.classList.remove('dl-em-editing');
  };

  const cancelInlineEdit = (): void => {
    const edit = inlineEdit;
    if (!edit) return;
    edit.committing = true; // a late blur must not then save it
    finishInlineEdit(edit);
    setStatus('Edit cancelled — nothing saved.');
  };

  /**
   * Commit through the reviewable path: checkout → patch → invalidate → mark
   * the block a draft → refresh the pending tray. A held lock refuses with the
   * existing message and the block goes back to read-only, unwritten.
   */
  const runInlineCommit = async (edit: InlineEditState): Promise<void> => {
    const after = inlineEditValue(edit);
    if (after === undefined || JSON.stringify(after) === JSON.stringify(edit.before)) {
      finishInlineEdit(edit);
      return;
    }
    const objectSession = session(edit.target.objectType, edit.target.objectId);
    setStatus('Saving…');
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      // Refuse, keep nothing, hand the block back read-only.
      finishInlineEdit(edit);
      setStatus(`Locked by ${checkout.heldBy ?? 'another editor'} — try again when the lock frees.`);
      return;
    }
    const ops = inlineEditOps(edit.target, edit.field, after, edit.patchSectionId);
    const changed = { [edit.field.key]: after };
    const manualEdits =
      edit.field.kind === 'doc'
        ? []
        : buildManualRichTextEdits(
            edit.target,
            { [edit.field.key]: edit.before },
            changed,
            [edit.field.key],
            new Date().toISOString()
          );
    attachLearningTrail(edit.target, ops, changed, manualEdits);
    const outcome = await objectSession.patch(ops);
    finishInlineEdit(edit);
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? ` ${outcome.blockers.join(' ')}` : '';
      setStatus(`Not saved: ${outcome.error}${blockers}`);
      return;
    }
    clearLearningTrail(edit.target);
    invalidateRecord(edit.target.objectType, edit.target.objectId);
    // Show the saved value where it can be located unambiguously; where it
    // can't, the dashed draft outline and the tray remain the honest record —
    // the same contract the panel's saves have always had.
    if (edit.field.kind !== 'doc' && typeof edit.before === 'string' && typeof after === 'string') {
      previewFieldChange(edit.region, edit.field.kind === 'html' ? 'html' : 'string', edit.before, after);
    }
    edit.region.classList.add('dl-em-draft');
    setStatus(`${edit.target.objectId}: draft saved — not published.`);
    await refreshPending();
    scheduleGapRebuild();
  };

  const commitInlineEdit = (): Promise<void> => {
    const edit = inlineEdit;
    if (!edit || edit.committing) return inlineCommitInFlight;
    edit.committing = true;
    inlineCommitInFlight = runInlineCommit(edit);
    return inlineCommitInFlight;
  };

  /** Put the caret where the pointer was, so the gesture lands like a click in text. */
  const placeCaret = (host: HTMLElement, at?: { x: number; y: number }): void => {
    const selection = window.getSelection();
    if (!selection) return;
    const range =
      at && typeof document.caretRangeFromPoint === 'function' ? document.caretRangeFromPoint(at.x, at.y) : undefined;
    if (range && host.contains(range.startContainer)) {
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const end = document.createRange();
    end.selectNodeContents(host);
    end.collapse(false);
    selection.removeAllRanges();
    selection.addRange(end);
  };

  /**
   * Mount the editing surface IN the block, over the element(s) that actually
   * render the field — never over the block.
   *
   * The first cut swapped the region's whole child list for the host, which on
   * a `display:contents` article wrapper deleted the node's whole rendering (its
   * <h2>, eyebrow, <ul>, <figure> and CTA) and on a section deleted the
   * `<section class="dl-section">` itself, taking its padding, its 72rem
   * centring and the 720px reading column with it — everything below reflowed
   * the moment you double-clicked. Wolf, 2026-08-11: "make sure the main
   * target objects don't move … keep everything like it is published."
   *
   * So: locate the rendered element(s) with the SAME finder the in-place
   * preview uses, and swap in a host of the same tag carrying the same
   * classes, so the site's `:where(p, ul, h2 …)` typography keeps matching and
   * the block's siblings and section chrome stay on the page throughout.
   */
  const mountInlineHost = (region: HTMLElement, field: InlineField, before: unknown): HTMLElement | undefined => {
    const elements = findBlockElements(region, inlineValueBlockTexts(field, before));
    if (!elements) return undefined;
    const [first] = elements;
    const parent = first.parentNode;
    // A run spanning parents is not one box to replace — bail rather than
    // restructure the block.
    if (!parent || elements.some((element) => element.parentNode !== parent)) return undefined;
    // A rich_text.v1 surface emits its own <p>/<h2>/<ul> children, so its host
    // is a bare wrapper (the prose rules are descendant selectors and keep
    // matching). Every other surface IS the element it replaces.
    const richHost = field.kind === 'doc';
    const host = document.createElement(richHost ? 'div' : first.tagName.toLowerCase());
    if (!richHost && first.className) host.className = first.className;
    host.classList.add('dl-em-inline');
    if (richHost) host.classList.add('dl-em-inline-rich');
    host.setAttribute('role', 'textbox');
    host.setAttribute('aria-label', `Edit ${field.key}`);
    first.replaceWith(host);
    for (const element of elements.slice(1)) element.remove();
    return host;
  };

  const startInlineEdit = async (region: HTMLElement, at?: { x: number; y: number }): Promise<void> => {
    if (inlineEdit) {
      if (inlineEdit.region === region) return;
      void commitInlineEdit();
    }
    // Never start on top of a save still in flight: its teardown restores the
    // block's pre-edit HTML, which would wipe a surface mounted meanwhile.
    await inlineCommitInFlight;
    const target = targetFor(region);
    if (!target) return;
    const { status, record } = await cachedRecord(target.objectType, target.objectId);
    if (status !== 200 || !record) {
      setStatus(`Could not load ${target.objectId} (HTTP ${status}).`);
      return;
    }
    const unit = editableUnitFor(target, record.body as Record<string, unknown>);
    const field = unit ? derivePrimaryInlineField(unit.currentData, target.objectType) : undefined;
    if (!unit || !field) {
      // No single primary copy field (image node, grid, navigation chrome):
      // the double-click opens the panel it would have opened anyway (§5.1).
      void openPanel(target, region, 'edit');
      return;
    }
    const before = unit.currentData[field.key];
    const snapshot = snapshotRegion(region);
    const host = mountInlineHost(region, field, before);
    if (!host) {
      // The field's current value could not be located in the block's own
      // rendering (an empty value, or copy the component transforms). Editing
      // in place would mean guessing where to put the surface — and the one
      // thing this must never do is rebuild the block. The panel takes it.
      void openPanel(target, region, 'edit');
      return;
    }
    region.classList.add('dl-em-editing');

    const edit: InlineEditState = {
      region,
      target,
      field,
      patchSectionId: unit.patchSectionId,
      before,
      snapshot,
      host,
      committing: false,
    };
    inlineEdit = edit;

    const toolbarMode = inlineToolbarModeFor(field);
    const toolbarOptions = { anchor: () => edit.host, topGuard: INLINE_TOOLBAR_TOP_GUARD };

    if (field.kind === 'doc') {
      // The grammar-bound TipTap editor, imported only when one is needed so
      // @tiptap never enters the canvas's base bundle. Allowlist, paste
      // sanitizer and https-only links come with it, unchanged.
      const { createRichTextEditor } = await import('./richtext-editor.js');
      if (inlineEdit !== edit) return; // cancelled while the chunk loaded
      edit.richText = await createRichTextEditor({
        element: host,
        doc: before as Parameters<typeof createRichTextEditor>[0]['doc'],
      });
      if (inlineEdit !== edit) {
        edit.richText.destroy();
        return;
      }
      edit.toolbar = edit.richText.buildToolbar(toolbarMode, toolbarOptions);
      edit.richText.focus();
    } else {
      host.setAttribute('contenteditable', 'plaintext-only');
      host.textContent = typeof before === 'string' ? before : '';
      host.focus();
      placeCaret(host, at);
      // Belt and braces where contenteditable="plaintext-only" is not honoured:
      // a paste still lands as text, never as foreign markup.
      host.addEventListener('paste', (event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (text === undefined) return;
        event.preventDefault();
        document.execCommand('insertText', false, text);
      });
      if (toolbarMode !== 'none') {
        const { buildInlineToolbar } = await import('./richtext-editor.js');
        if (inlineEdit !== edit) return; // cancelled while the chunk loaded
        edit.toolbar = buildInlineToolbar(undefined, toolbarMode, toolbarOptions);
      }
    }

    host.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        cancelInlineEdit();
        region.focus?.();
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        event.stopPropagation();
        void commitInlineEdit();
      }
    });
    host.addEventListener('focusout', (event) => {
      const next = event.relatedTarget as Node | null;
      // The formatting bubble is part of the editing surface: focus landing in
      // it (the link popover's input) must not read as "clicked away, save".
      if (next && (host.contains(next) || edit.toolbar?.element.contains(next))) return;
      void commitInlineEdit();
    });

    // The block's own bubble stays up while it is edited (§5.3 collision 2) —
    // comments about the thing you are editing are the point.
    const anchorKey = anchorKeyForRegion(region);
    if (anchorKey) pinRail(anchorKey, region);
    chip.style.display = 'none';
    setStatus('Editing in place — ⌘↵ or click away to save, Esc to cancel.');
  };

  document.addEventListener(
    'dblclick',
    (event) => {
      if (!document.body.classList.contains('dl-em-on')) return;
      const element = event.target as HTMLElement | null;
      if (!element) return;
      if (rail.contains(element) || panel.contains(element) || chip.contains(element) || tray.contains(element)) return;
      if (inlineEdit?.host.contains(element)) return;
      const region =
        element.closest<HTMLElement>(NODE_SELECTOR) ??
        element.closest<HTMLElement>(REGION_SELECTOR) ??
        element.closest<HTMLElement>(NAV_SELECTOR);
      if (!region) return;
      event.preventDefault();
      void startInlineEdit(region, { x: event.clientX, y: event.clientY });
    },
    { signal }
  );

  // Keyboard equivalent (spec §9): Enter on a focused block edits it. A
  // mouse-only editing gesture would be the only one on the canvas.
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      if (!document.body.classList.contains('dl-em-on') || inlineEdit) return;
      const element = document.activeElement as HTMLElement | null;
      if (!element || element === document.body) return;
      if (rail.contains(element) || panel.contains(element) || chip.contains(element) || tray.contains(element)) return;
      if (bar.contains(element) || element.isContentEditable) return;
      if (/^(input|textarea|select|button|a|summary|details)$/i.test(element.tagName)) return;
      const region =
        element.closest<HTMLElement>(NODE_SELECTOR) ??
        element.closest<HTMLElement>(REGION_SELECTOR) ??
        element.closest<HTMLElement>(NAV_SELECTOR);
      if (!region) return;
      event.preventDefault();
      void startInlineEdit(region);
    },
    { signal }
  );

  // A click outside the surface commits it (§5.3 — every other autosaving
  // inline editor behaves this way), and an in-content link never navigates:
  // in edit mode a click on one almost always meant "put a cursor here".
  // Chrome (navigation objects) is exempt — an editor must still be able to
  // move around the site while edit mode is on.
  document.addEventListener(
    'mousedown',
    (event) => {
      if (!inlineEdit) return;
      const element = event.target as Node | null;
      if (
        element &&
        (inlineEdit.host.contains(element) ||
          inlineEdit.toolbar?.element.contains(element) ||
          panel.contains(element) ||
          rail.contains(element))
      ) {
        return;
      }
      void commitInlineEdit();
    },
    { signal }
  );
  document.addEventListener(
    'click',
    (event) => {
      if (!document.body.classList.contains('dl-em-on')) return;
      const anchor = (event.target as HTMLElement | null)?.closest?.<HTMLAnchorElement>('a[href]');
      if (!anchor || anchor.closest(NAV_SELECTOR)) return;
      if (!anchor.closest(`${NODE_SELECTOR}, ${REGION_SELECTOR}`)) return;
      event.preventDefault();
    },
    { signal }
  );

  /** Annotated blocks are focusable in edit mode only — never for a visitor. */
  const syncRegionFocusability = (on: boolean): void => {
    for (const region of annotatedRegions()) {
      if (on) {
        if (!region.hasAttribute('tabindex')) region.setAttribute('tabindex', '0');
      } else if (region.getAttribute('tabindex') === '0') {
        region.removeAttribute('tabindex');
      }
    }
  };

  // ── panel
  let panelState: PanelState | undefined;
  let panelTarget: EditTarget | undefined;
  let panelRegion: HTMLElement | undefined;

  const closePanel = (): void => {
    panel.classList.remove(
      'dl-em-open',
      'dl-em-mode-edit',
      'dl-em-mode-image',
      'dl-em-mode-role',
      'dl-em-has-image',
      'dl-em-nav',
      'dl-em-article',
      'dl-em-anchored'
    );
    panel.style.left = '';
    panel.style.top = '';
    panel.querySelectorAll('.dl-em-acc').forEach((section) => section.classList.remove('dl-em-open'));
    panelState?.region.classList.remove('dl-em-focus');
    panelState = undefined;
    panelTarget = undefined;
    panelRegion = undefined;
    formEl.remove();
    formEl.innerHTML = '';
  };
  q<HTMLButtonElement>(panel, '[data-em-panel-close]').addEventListener('click', closePanel);

  /** Expand one accordion section (collapse the rest); null collapses all. */
  const setActiveSection = (mode: PanelMode | null): void => {
    panel.querySelectorAll<HTMLElement>('.dl-em-acc').forEach((section) => {
      section.classList.toggle('dl-em-open', section.dataset.emAcc === mode);
    });
    panel.classList.toggle('dl-em-mode-edit', mode === 'edit');
    panel.classList.toggle('dl-em-mode-image', mode === 'image');
    panel.classList.toggle('dl-em-mode-role', mode === 'role' || mode === 'meta');
  };

  // Accordion heads switch tools on the SAME section; clicking the open head
  // collapses the panel body to the compact icon rail.
  panel.querySelectorAll<HTMLButtonElement>('[data-em-acc-head]').forEach((head) => {
    head.addEventListener('click', () => {
      const mode = head.dataset.emAccHead as PanelMode;
      const section = panel.querySelector(`.dl-em-acc[data-em-acc="${mode}"]`);
      if (section?.classList.contains('dl-em-open')) {
        setActiveSection(null);
      } else if (panelTarget && panelRegion) {
        void openPanel(panelTarget, panelRegion, mode);
      }
    });
  });

  // The tile → accordion mechanic (Slice C): the panel opens IN PLACE OF the
  // tile — right rail, top aligned with the object it belongs to — and a FLIP
  // container-transform plays the tile expanding into the accordion (the
  // material "container transform" idiom; reduced-motion users get an instant
  // open). Universal: every target kind shares this path. Mobile keeps the
  // bottom sheet.
  const anchorPanel = (region: HTMLElement): void => {
    if (window.innerWidth <= 720) return; // the bottom-sheet media query owns mobile
    const rect = regionRect(region);
    if (!rect) return;
    panel.classList.add('dl-em-anchored');
    const width = 372;
    const rail = rect.right + 14;
    const left = rail + width <= window.innerWidth - 8 ? rail : Math.max(8, window.innerWidth - width - 12);
    panel.style.left = `${left + window.scrollX}px`;
    panel.style.top = `${Math.max(50, rect.top + window.scrollY)}px`;
  };

  const morphFromTile = (): void => {
    if (window.innerWidth <= 720) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    if (chip.style.display === 'none') return;
    const source = chip.getBoundingClientRect();
    const dest = panel.getBoundingClientRect();
    if (source.width === 0 || dest.width === 0) return;
    const dx = source.left - dest.left;
    const dy = source.top - dest.top;
    const sx = Math.max(source.width / dest.width, 0.05);
    const sy = Math.max(source.height / dest.height, 0.05);
    panel.style.transformOrigin = 'top left';
    panel.animate(
      [
        { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.4, borderRadius: '9px' },
        { transform: 'none', opacity: 1, borderRadius: '14px' },
      ],
      { duration: 220, easing: 'cubic-bezier(.2, .8, .2, 1)' }
    );
  };

  const openPanel = async (target: EditTarget, region: HTMLElement, mode: PanelMode): Promise<void> => {
    // A tool press while the same tile's accordion is open just switches the
    // section in place — the morph plays only on a fresh open.
    const freshOpen = !panel.classList.contains('dl-em-open') || panelRegion !== region;
    if (panelState?.snapshot) restoreRegion(panelState.snapshot);
    closePanel();
    tray.classList.remove('dl-em-open');
    region.classList.add('dl-em-focus');
    panelTarget = target;
    panelRegion = region;
    logEl.innerHTML = '';
    suggestionActions.hidden = true;

    // Header identity: type + monospace id, with tiny shared/draft dots (no
    // prose). Article blocks show their ROLE instead of the req_* id (the id
    // survives in the tooltip for provenance).
    const isDraft = region.classList.contains('dl-em-draft');
    const isNodeTarget = target.objectType === 'content_item' && Boolean(target.nodeId);
    identEl.innerHTML =
      (isNodeTarget
        ? `<span class="dl-em-itype" data-em-role title="${escapeHtml(target.objectId)}">${escapeHtml(
            region.dataset.cmsNodeKind ?? 'block'
          )}</span>`
        : `<span class="dl-em-itype">${escapeHtml(target.sectionType)}</span>` +
          `<span class="dl-em-iid">${escapeHtml(target.objectId)}</span>`) +
      (target.shared ? `<span class="dl-em-idot dl-em-shd" title="Shared — affects every page using it"></span>` : '') +
      (isDraft ? `<span class="dl-em-idot dl-em-drf" title="Unpublished draft"></span>` : '');
    panel.classList.toggle(
      'dl-em-has-image',
      target.objectType === 'content_item'
        ? region.dataset.cmsNodeKind === 'content'
        : IMAGE_SECTION_TYPES.has(target.sectionType)
    );
    panel.classList.toggle('dl-em-article', target.objectType === 'content_item' && Boolean(target.nodeId));
    // Chrome (navigation objects) is a copy form only: no section grammar for
    // AI scoping, no images — the accordion shows just the Edit section.
    const isNav = target.objectType === 'navigation';
    panel.classList.toggle('dl-em-nav', isNav);
    if (isNav) mode = 'edit';
    setActiveSection(mode);
    if (mode !== 'ai') panel.querySelector(`[data-em-acc-body="${mode}"]`)?.append(formEl);

    const selected = mode === 'ai' && selectionRegion === region ? currentSelectionText : undefined;
    panel.classList.add('dl-em-open');
    anchorPanel(region);
    if (freshOpen) {
      morphFromTile();
      chip.style.display = 'none'; // the accordion replaces the tile
    }
    if (mode === 'ai') {
      inputEl.value = '';
      inputEl.focus();
    }

    const loading = busy('Loading…');
    const { status, record } = await cachedRecord(target.objectType, target.objectId);
    loading.remove();
    if (status !== 200 || !record) {
      log('sys', `Could not load ${escapeHtml(target.objectId)} (HTTP ${status}).`);
      return;
    }
    const body = record.body as Record<string, unknown>;
    if (isNav) {
      panelState = {
        target,
        region,
        mode: 'edit',
        currentData: {},
        patchSectionId: '',
        navBody: body as unknown as NavigationBody,
      };
      renderNavForm(panelState);
      return;
    }
    const unit = editableUnitFor(target, body);
    const currentData = unit?.currentData;
    const patchSectionId = unit?.patchSectionId;
    let nodePrivate: PanelState['nodePrivate'];
    let articleMeta: PanelState['articleMeta'];
    if (target.objectType === 'content_item') {
      nodePrivate = unit?.node?.private;
      articleMeta = {
        slug: body.slug,
        author: body.author,
        description: body.description,
        taxonomy: body.taxonomy,
        seo: body.seo,
      };
      // The record is in hand — fill the header role synchronously.
      const role = roleOf(unit?.node);
      const roleEl = identEl.querySelector('[data-em-role]');
      if (role && roleEl) roleEl.textContent = role;
    }
    if (!currentData || !patchSectionId) {
      log('sys', `Not in the draft record yet — edit via /admin/content/${escapeHtml(target.objectId)}.`);
      return;
    }
    panelState = {
      target,
      region,
      mode,
      currentData,
      patchSectionId,
      selectedText: selected,
      nodePrivate,
      articleMeta,
    };
    logEl.innerHTML = '';
    if (mode === 'ai') {
      inputEl.placeholder = selected ? 'Refine the selection…' : 'Describe the change…';
      log(
        'sys',
        `${ICON_SPARKLES} Editing ${escapeHtml(target.sectionType)}${selected ? ' · selection' : ''} — previews as a draft.`
      );
      renderImageRefChips(panelState);
    } else if (mode === 'role') {
      renderRoleForm(panelState);
    } else if (mode === 'meta') {
      void renderArticleMetaForm(panelState);
    } else {
      renderForm(panelState);
    }
  };

  // ── AI image references ("Re: portrait.png")
  // A section that carries images gets clickable chips in the chat. Arming a
  // chip guarantees the image has a blob-store copy with a public /img/* URL
  // (existing repo images are mirrored through the same upload pipeline —
  // storage only, the section's src is untouched) and every ask then carries
  // `image_ref` so the model — and any external image tooling, which needs a
  // public URL — knows exactly which bytes "the image" means. The copy-only
  // guard is unchanged: the AI still cannot write image fields.
  const renderImageRefChips = (state: PanelState): void => {
    const entries = imageEntriesFor(state.currentData);
    if (entries.length === 0) return;
    const container = log(
      'sys',
      `${ICON_IMAGE} Reference ${entries.length === 1 ? 'this image' : 'an image'} in the chat:`
    );
    const row = document.createElement('div');
    row.className = 'dl-em-imgrefs';
    for (const entry of entries) {
      const chipButton = document.createElement('button');
      chipButton.type = 'button';
      chipButton.className = 'dl-em-imgref';
      chipButton.innerHTML = `<img src="${escapeHtml(entry.src)}" alt=""> ${escapeHtml(entry.name)}`;
      chipButton.addEventListener('click', () => void armImageRef(state, entry, chipButton, row));
      row.append(chipButton);
    }
    container.append(row);
  };

  const armImageRef = async (
    state: PanelState,
    entry: { field: string; src: string; name: string },
    chipButton: HTMLButtonElement,
    row: HTMLElement
  ): Promise<void> => {
    chipButton.disabled = true;
    const note = /^\/img\//.test(entry.src) ? undefined : busy('Mirroring image into blobs…');
    const result = await ensureBlobBackedImage(getToken, state.target.objectId, entry.src);
    note?.remove();
    chipButton.disabled = false;
    if (!result.ok) {
      log('sys', `Could not reference image: ${escapeHtml(result.error)}`);
      return;
    }
    state.imageRef = {
      field: entry.field,
      name: entry.name,
      url: new URL(result.publicPath, window.location.origin).href,
    };
    row.querySelectorAll('.dl-em-imgref').forEach((el) => el.classList.remove('dl-em-armed'));
    chipButton.classList.add('dl-em-armed');
    inputEl.placeholder = `Re: ${entry.name} — describe the change…`;
    log(
      'sys',
      `<span class="dl-em-repill">Re: ${escapeHtml(entry.name)}</span> armed` +
        `${result.mirrored ? ' — mirrored into blobs' : ''}: <code>${escapeHtml(result.publicPath)}</code>. ` +
        'Requests now carry this image’s public URL.'
    );
    inputEl.focus();
  };

  // ── manual edit / image forms
  // What people are used to: click the pencil, type in fields, save. Save is
  // the same reviewable draft path the AI uses (checkout → patch) — publishing
  // stays a separate act. The image tool is the DELIBERATE way to change an
  // image; the AI is schema-blocked from ever doing it.
  type FormFieldKind = 'text' | 'richtext' | 'lines' | 'image-src' | 'image-alt' | 'asset';
  type FormField = {
    key: string;
    kind: FormFieldKind;
    imageField?: string;
    /** For image ARRAYS (content_split `images: [{src,alt}]`): the item index. */
    imageIndex?: number;
  };

  const formFieldsFor = (data: Record<string, unknown>, mode: PanelMode): FormField[] => {
    const fields: FormField[] = [];
    for (const [key, value] of Object.entries(data)) {
      if (mode === 'image') {
        if (isImageValue(value)) {
          fields.push({ key: `${key}.src`, kind: 'image-src', imageField: key });
          fields.push({ key: `${key}.alt`, kind: 'image-alt', imageField: key });
        } else if (Array.isArray(value) && value.length > 0 && value.every(isImageValue)) {
          // Image arrays (content_split): one src/alt pair per item, in order.
          value.forEach((_, index) => {
            fields.push({ key: `${key}.${index}.src`, kind: 'image-src', imageField: key, imageIndex: index });
            fields.push({ key: `${key}.${index}.alt`, kind: 'image-alt', imageField: key, imageIndex: index });
          });
        } else if (/assetref$|^ogimage$/i.test(key) && typeof value === 'string') {
          fields.push({ key, kind: 'asset' });
        }
        continue;
      }
      if (NON_COPY_KEY_RE.test(key)) continue;
      if (typeof value === 'string') {
        fields.push({ key, kind: /<[a-z][\s\S]*>/i.test(value) || key === 'body' ? 'richtext' : 'text' });
      } else if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        fields.push({ key, kind: 'lines' });
      }
      // Structured values (actions, quotes, faq items…) stay AI/admin work.
    }
    return fields;
  };

  const imageEntryFor = (data: Record<string, unknown>, field: FormField): { src: string; alt?: string } => {
    const holder = data[field.imageField as string];
    if (field.imageIndex !== undefined) {
      return (holder as Array<{ src: string; alt?: string }>)[field.imageIndex];
    }
    // A not-yet-created image (the node-media ADD path) edits an empty entry.
    return (holder as { src: string; alt?: string }) ?? { src: '' };
  };

  const formValueFor = (data: Record<string, unknown>, field: FormField): string => {
    if (field.kind === 'image-src') return imageEntryFor(data, field).src;
    if (field.kind === 'image-alt') return imageEntryFor(data, field).alt ?? '';
    const value = data[field.key];
    if (field.kind === 'lines') return ((value as string[]) ?? []).join('\n');
    return (value as string) ?? '';
  };

  /** Editor-facing field names — say what the field is, not its JSON key. */
  const FIELD_LABELS: Record<string, string> = {
    body: 'Text',
    items: 'Bullet points',
    title: 'Heading',
    eyebrow: 'Kicker',
    ctaText: 'Button text',
    ctaLink: 'Button link',
    'media.src': 'Image path',
    'media.alt': 'Image alt text',
  };

  const renderForm = (state: PanelState): void => {
    const fields = formFieldsFor(state.currentData, state.mode);
    const isContentNode = state.target.objectType === 'content_item' && state.region.dataset.cmsNodeKind === 'content';
    // Article content nodes without media yet: offer the ADD path — empty
    // src/alt rows (with Upload) that create `public.media` on save. Without
    // this, a node that has no image shows nothing and can never gain one.
    if (state.mode === 'image' && state.target.objectType === 'content_item' && fields.length === 0) {
      fields.push(
        { key: 'media.src', kind: 'image-src', imageField: 'media' },
        { key: 'media.alt', kind: 'image-alt', imageField: 'media' }
      );
    }
    // Bullet points are ALWAYS offered on a content block (B8): a text block
    // without items[] must be able to gain a list from the canvas — before
    // this, lists were only editable where they already existed.
    if (state.mode === 'edit' && isContentNode && !fields.some((field) => field.key === 'items')) {
      fields.push({ key: 'items', kind: 'lines' });
    }
    formEl.innerHTML = '';
    if (fields.length === 0) {
      formEl.innerHTML = `<div class="dl-em-fieldnote">No ${
        state.mode === 'image' ? 'image' : 'text'
      } fields on this section type.</div>`;
      return;
    }
    // Reported as "Save draft produces concatenated text": a pre-filled field
    // (below, every branch sets `value="${...}"` on render) is never
    // selected or focused, so the caret lands wherever a click happened to
    // land — typically the end — and the first character typed is INSERTED
    // there instead of replacing anything. Auto-selecting the FORM'S FIRST
    // field on render fixes the common "panel opens, I immediately start
    // typing" path outright (the field is already focused+selected, so
    // typing replaces). Only the first field: exactly one element can hold
    // focus/selection at a time, so selecting every field would just have
    // each one steal it back from the last, leaving only the final field
    // selected — worse than picking one deliberately. `.focus()`/`.select()`
    // fire neither `input` nor `change`, so this does not touch
    // `serializeForm()`'s output and cannot mark the form dirty against
    // `saveBaseline` (captured after this loop, from the DOM values, which
    // selection does not alter either way).
    let firstFieldSelected = false;
    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'dl-em-formrow';
      const value = formValueFor(state.currentData, field);
      const label = `<label>${escapeHtml(FIELD_LABELS[field.key] ?? field.key)}</label>`;
      if (field.kind === 'richtext' || field.kind === 'lines') {
        // Article node bodies are PLAIN TEXT (escaped at render; blank line =
        // new paragraph) — the HTML-tag hint belongs to section fields only.
        const richNote =
          state.target.objectType === 'content_item'
            ? '<span class="dl-em-fieldnote">Plain text — blank line starts a new paragraph</span>'
            : '<span class="dl-em-fieldnote">p · b · i · link · lists · h2–h3</span>';
        row.innerHTML =
          label +
          `<textarea data-em-field="${escapeHtml(field.key)}">${escapeHtml(value)}</textarea>` +
          (field.kind === 'lines' ? '<span class="dl-em-fieldnote">One per line</span>' : richNote);
      } else if (field.kind === 'image-src') {
        // src + Upload side by side: paste a path, or push a file into the
        // blobs artifacts store (pdf-tool pattern) and get its /img/* path.
        row.innerHTML =
          label +
          `<div class="dl-em-srcrow">` +
          `<input type="text" data-em-field="${escapeHtml(field.key)}" value="${escapeHtml(value)}">` +
          `<button type="button" class="dl-em-btn dl-em-upload dl-em-ico" data-em-upload ` +
          `title="Upload image" aria-label="Upload image">${ICON_UPLOAD}</button>` +
          `<input type="file" accept="image/png,image/jpeg,image/webp" hidden data-em-upload-file>` +
          `</div>`;
      } else {
        row.innerHTML =
          label + `<input type="text" data-em-field="${escapeHtml(field.key)}" value="${escapeHtml(value)}">`;
      }
      formEl.append(row);
      if (!firstFieldSelected) {
        firstFieldSelected = true;
        const firstControl = row.querySelector<HTMLInputElement | HTMLTextAreaElement>('[data-em-field]');
        firstControl?.focus();
        firstControl?.select();
      }
      if (field.kind === 'image-src') {
        // The thumbnail must never show the browser's broken-image glyph: it
        // stays hidden until the image actually loads; empty/unloadable srcs
        // show a neutral "no image yet" placeholder instead.
        const thumb = document.createElement('img');
        thumb.className = 'dl-em-imgthumb';
        thumb.alt = 'Preview';
        thumb.style.display = 'none';
        const placeholder = document.createElement('div');
        placeholder.className = 'dl-em-imgphold';
        placeholder.innerHTML = `${ICON_IMAGE}<span>No image yet — upload or paste a path</span>`;
        row.append(thumb, placeholder);
        thumb.addEventListener('load', () => {
          thumb.style.display = 'block';
          placeholder.style.display = 'none';
        });
        thumb.addEventListener('error', () => {
          thumb.style.display = 'none';
          placeholder.style.display = 'flex';
        });
        const syncThumb = (src: string): void => {
          if (src.trim()) thumb.src = src;
          else {
            thumb.removeAttribute('src');
            thumb.style.display = 'none';
            placeholder.style.display = 'flex';
          }
        };
        syncThumb(value);
        const srcInput = row.querySelector<HTMLInputElement>('[data-em-field]');
        srcInput?.addEventListener('input', () => {
          syncThumb(srcInput.value);
        });
        const uploadButton = row.querySelector<HTMLButtonElement>('[data-em-upload]');
        const fileInput = row.querySelector<HTMLInputElement>('[data-em-upload-file]');
        uploadButton?.addEventListener('click', () => fileInput?.click());
        fileInput?.addEventListener('change', () => {
          const file = fileInput.files?.[0];
          if (file && uploadButton && srcInput) void uploadImage(state, file, srcInput, uploadButton);
          fileInput.value = '';
        });
      }
    }
    // Gallery blocks (W7.7): grow the images array from the canvas — a new
    // empty row appears (upload or paste a path); an emptied src removes the
    // image on save.
    if (
      state.mode === 'image' &&
      state.target.objectType === 'content_item' &&
      Array.isArray(state.currentData.images)
    ) {
      const addButton = document.createElement('button');
      addButton.type = 'button';
      addButton.className = 'dl-em-btn dl-em-ico';
      addButton.innerHTML = `${ICON_PLUS} Add image`;
      addButton.addEventListener('click', () => {
        (state.currentData.images as Array<Record<string, unknown>>).push({ type: 'image', src: '', alt: '' });
        renderForm(state);
      });
      formEl.append(addButton);
      const note = document.createElement('span');
      note.className = 'dl-em-fieldnote';
      note.textContent = 'Empty src removes that image on save.';
      formEl.append(note);
    }
    const foot = document.createElement('div');
    foot.className = 'dl-em-formfoot';
    foot.innerHTML =
      `<button class="dl-em-btn dl-em-save dl-em-ico" data-em-form-save>${ICON_CHECK} Save draft</button>` +
      `<button class="dl-em-btn dl-em-ghost dl-em-ico" data-em-form-cancel title="Cancel" aria-label="Cancel">${ICON_CLOSE}</button>`;
    foot.querySelector('[data-em-form-save]')?.addEventListener('click', () => void saveForm(state, fields));
    foot.querySelector('[data-em-form-cancel]')?.addEventListener('click', closePanel);
    formEl.append(foot);
    captureSaveBaseline(); // starts disabled — nothing to save until an edit
  };

  // ── role / annotation editor (W7.7)
  // The semantic layer, editable where the block lives: strategy (the job the
  // block does in the story), intent (what it does to the reader), and agent
  // notes. Saves ride the SAME reviewable path (update_node on private
  // fields); readers never see any of it (the leak rule) — this panel is why
  // the vocabulary matters to a human, not just to agents.
  const INTENT_VALUES = ['educate', 'persuade', 'reassure', 'convert', 'navigate'];

  const renderRoleForm = (state: PanelState): void => {
    const current = state.nodePrivate ?? {};
    const options = (values: string[], selected: string | undefined, labels?: Record<string, string>): string =>
      `<option value=""${selected ? '' : ' selected'}>—</option>` +
      values
        .map(
          (value) =>
            `<option value="${escapeHtml(value)}"${value === selected ? ' selected' : ''}>${escapeHtml(
              labels?.[value] ?? value
            )}</option>`
        )
        .join('');
    formEl.innerHTML =
      `<div class="dl-em-formrow"><label>Role (strategy)</label>` +
      `<select data-em-role-field="strategy">${options(Object.keys(STRATEGY_LABELS), current.strategy, STRATEGY_LABELS)}</select>` +
      `<span class="dl-em-fieldnote">The job this block does in the story.</span></div>` +
      `<div class="dl-em-formrow"><label>Intent</label>` +
      `<select data-em-role-field="intent">${options(INTENT_VALUES, current.intent)}</select>` +
      `<span class="dl-em-fieldnote">What it should do to the reader.</span></div>` +
      `<div class="dl-em-formrow"><label>Notes for agents</label>` +
      `<textarea data-em-role-field="agentNotes">${escapeHtml(current.agentNotes ?? '')}</textarea>` +
      `<span class="dl-em-fieldnote">Never shown to readers.</span></div>`;
    const foot = document.createElement('div');
    foot.className = 'dl-em-formfoot';
    foot.innerHTML =
      `<button class="dl-em-btn dl-em-save dl-em-ico" data-em-form-save>${ICON_CHECK} Save draft</button>` +
      `<button class="dl-em-btn dl-em-ghost dl-em-ico" data-em-form-cancel title="Cancel" aria-label="Cancel">${ICON_CLOSE}</button>`;
    foot.querySelector('[data-em-form-save]')?.addEventListener('click', () => void saveRoleForm(state));
    foot.querySelector('[data-em-form-cancel]')?.addEventListener('click', closePanel);
    formEl.append(foot);
    captureSaveBaseline();
  };

  const saveRoleForm = async (state: PanelState): Promise<void> => {
    const read = (key: string): string =>
      formEl.querySelector<HTMLSelectElement | HTMLTextAreaElement>(`[data-em-role-field="${key}"]`)?.value ?? '';
    const before = state.nodePrivate ?? {};
    const fields: Record<string, unknown> = {};
    for (const key of ['strategy', 'intent', 'agentNotes'] as const) {
      const raw = read(key).trim();
      if (raw === (before[key] ?? '')) continue;
      fields[key] = raw === '' ? null : raw; // '' = clear the annotation (deep-merge null deletes)
    }
    if (Object.keys(fields).length === 0) {
      log('sys', 'No changes to save.');
      return;
    }
    const saveButton = buttonBusy(formEl.querySelector<HTMLButtonElement>('[data-em-form-save]'));
    const working = busy('Saving…');
    const objectSession = session(state.target.objectType, state.target.objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      working.remove();
      saveButton.done(false);
      log('sys', `Locked by ${escapeHtml(checkout.heldBy ?? 'another editor')} — try again when the lock frees.`);
      return;
    }
    const ops: Array<Record<string, unknown>> = [
      { op: 'update_node', node_id: state.target.nodeId, fields: { private: fields } },
    ];
    attachLearningTrail(state.target, ops, fields);
    const outcome = await objectSession.patch(ops);
    working.remove();
    saveButton.done(outcome.ok);
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? `<br>${outcome.blockers.map(escapeHtml).join('<br>')}` : '';
      log('sys', `Not saved: ${escapeHtml(outcome.error)}${blockers}`);
      return;
    }
    clearLearningTrail(state.target);
    state.nodePrivate = {
      ...before,
      ...Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value ?? undefined])),
    };
    // The chip/header roles come from the record — refresh both.
    invalidateRecord(state.target.objectType, state.target.objectId);
    const role = roleOf({ private: state.nodePrivate });
    const roleEl = identEl.querySelector('[data-em-role]');
    if (roleEl) roleEl.textContent = role ?? state.region.dataset.cmsNodeKind ?? 'block';
    state.region.classList.add('dl-em-draft');
    log('sys', `${ICON_CHECK} Role saved as a draft — <strong>not published</strong>. Readers never see annotations.`);
    setStatus(`${state.target.objectId}: annotation draft saved.`);
    await refreshPending();
  };

  // ── article settings form (T9.20, capability #3/#4; author: T9.23a)
  // Body-level metadata via set_article_meta under the SAME EditSession:
  // slug (contract-validated at edit time), author (free-text byline),
  // description, category + tags against the site taxonomy registry (novel
  // terms are FLAGGED here, before publish — the publish hook enforces), SEO
  // description with a counter. Publish date stays absent: the tray's
  // publish-time option (T9.21) owns it — the panel surfaces only what the
  // contract allows.

  const taxonomyRegistry = async (): Promise<{ categories: string[]; tags: string[] }> => {
    try {
      const result = await cachedRecord('taxonomy', getSiteIdentity().taxonomyId);
      const kinds = ((result.record?.body as Record<string, unknown> | undefined)?.kinds ?? {}) as Record<
        string,
        { terms?: Array<{ slug?: string }> }
      >;
      const slugs = (kind: string): string[] =>
        (kinds[kind]?.terms ?? []).map((term) => term.slug ?? '').filter(Boolean);
      return { categories: slugs('category'), tags: slugs('tag') };
    } catch {
      return { categories: [], tags: [] };
    }
  };

  const renderArticleMetaForm = async (state: PanelState): Promise<void> => {
    const meta = state.articleMeta ?? {};
    const taxonomy = (meta.taxonomy ?? {}) as { category?: string; tags?: string[] };
    const seo = (meta.seo ?? {}) as { description?: string };
    const registry = await taxonomyRegistry();
    if (panelState !== state) return; // panel moved on while the registry loaded
    const categoryOptions =
      `<option value=""${taxonomy.category ? '' : ' selected'}>—</option>` +
      [...new Set([...registry.categories, ...(taxonomy.category ? [taxonomy.category] : [])])]
        .map(
          (slug) =>
            `<option value="${escapeHtml(slug)}"${slug === taxonomy.category ? ' selected' : ''}>${escapeHtml(slug)}${
              registry.categories.includes(slug) ? '' : ' (not in registry)'
            }</option>`
        )
        .join('');
    formEl.innerHTML =
      `<div class="dl-em-formrow"><label>Slug</label>` +
      `<input type="text" data-em-meta-field="slug" value="${escapeHtml(String(meta.slug ?? ''))}" spellcheck="false">` +
      `<span class="dl-em-fieldnote" data-em-meta-slugnote>lowercase-hyphen; must be unique across articles.</span></div>` +
      `<div class="dl-em-formrow"><label>Author</label>` +
      `<input type="text" data-em-meta-field="author" value="${escapeHtml(String(meta.author ?? ''))}" maxlength="120">` +
      `<span class="dl-em-fieldnote">Shown as the byline; leave blank to omit.</span></div>` +
      `<div class="dl-em-formrow"><label>Description (deck)</label>` +
      `<textarea data-em-meta-field="description">${escapeHtml(String(meta.description ?? ''))}</textarea>` +
      `<span class="dl-em-fieldnote">Shown on listings.</span></div>` +
      `<div class="dl-em-formrow"><label>Category</label>` +
      `<select data-em-meta-field="category">${categoryOptions}</select>` +
      `<span class="dl-em-fieldnote">From the taxonomy registry.</span></div>` +
      `<div class="dl-em-formrow"><label>Tags</label>` +
      `<input type="text" data-em-meta-field="tags" value="${escapeHtml((taxonomy.tags ?? []).join(', '))}" spellcheck="false" list="dl-em-tag-list">` +
      `<datalist id="dl-em-tag-list">${registry.tags.map((tag) => `<option value="${escapeHtml(tag)}">`).join('')}</datalist>` +
      `<span class="dl-em-fieldnote" data-em-meta-tagnote>Comma-separated; registry terms resolve at publish.</span></div>` +
      `<div class="dl-em-formrow"><label>SEO description</label>` +
      `<textarea data-em-meta-field="seo_description">${escapeHtml(seo.description ?? '')}</textarea>` +
      `<span class="dl-em-fieldnote"><span data-em-meta-seocount>${(seo.description ?? '').length}</span>/160 characters.</span></div>`;

    const seoField = formEl.querySelector<HTMLTextAreaElement>('[data-em-meta-field="seo_description"]');
    const seoCount = formEl.querySelector<HTMLElement>('[data-em-meta-seocount]');
    seoField?.addEventListener('input', () => {
      if (seoCount) seoCount.textContent = String(seoField.value.length);
    });
    const slugField = formEl.querySelector<HTMLInputElement>('[data-em-meta-field="slug"]');
    const slugNote = formEl.querySelector<HTMLElement>('[data-em-meta-slugnote]');
    slugField?.addEventListener('input', () => {
      const ok = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slugField.value.trim());
      if (slugNote) {
        slugNote.textContent = ok
          ? 'lowercase-hyphen; must be unique across articles.'
          : 'Not a valid slug: lowercase letters, digits, single hyphens.';
        slugNote.style.color = ok ? '' : 'var(--dlem-danger, #b3261e)';
      }
    });
    const tagsField = formEl.querySelector<HTMLInputElement>('[data-em-meta-field="tags"]');
    const tagNote = formEl.querySelector<HTMLElement>('[data-em-meta-tagnote]');
    const flagNovelTerms = () => {
      const entered = (tagsField?.value ?? '')
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean);
      const novel = entered.filter((tag) => !registry.tags.includes(tag));
      if (tagNote) {
        tagNote.textContent =
          novel.length > 0
            ? `Not in the registry (will need it before publish): ${novel.join(', ')}`
            : 'Comma-separated; registry terms resolve at publish.';
        tagNote.style.color = novel.length > 0 ? 'var(--dlem-warning, #8a6d00)' : '';
      }
    };
    tagsField?.addEventListener('input', flagNovelTerms);
    flagNovelTerms();

    const foot = document.createElement('div');
    foot.className = 'dl-em-formfoot';
    foot.innerHTML =
      `<button class="dl-em-btn dl-em-save dl-em-ico" data-em-form-save>${ICON_CHECK} Save draft</button>` +
      `<button class="dl-em-btn dl-em-ghost dl-em-ico" data-em-form-cancel title="Cancel" aria-label="Cancel">${ICON_CLOSE}</button>`;
    foot.querySelector('[data-em-form-save]')?.addEventListener('click', () => void saveArticleMetaForm(state));
    foot.querySelector('[data-em-form-cancel]')?.addEventListener('click', closePanel);
    formEl.append(foot);
    captureSaveBaseline();
  };

  const saveArticleMetaForm = async (state: PanelState): Promise<void> => {
    const read = (key: string): string =>
      formEl.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`[data-em-meta-field="${key}"]`)
        ?.value ?? '';
    const before = state.articleMeta ?? {};
    const beforeTaxonomy = (before.taxonomy ?? {}) as { category?: string; tags?: string[] };
    const beforeSeo = (before.seo ?? {}) as { description?: string };

    const fields: Record<string, unknown> = {};
    const slug = read('slug').trim();
    if (slug && slug !== before.slug) fields.slug = slug;
    const author = read('author').trim();
    if (author !== (before.author ?? '')) fields.author = author === '' ? null : author;
    const description = read('description').trim();
    if (description !== (before.description ?? '')) fields.description = description === '' ? null : description;
    const category = read('category').trim();
    const tags = read('tags')
      .split(',')
      .map((tag) => tag.trim())
      .filter(Boolean);
    const taxonomyChanged =
      category !== (beforeTaxonomy.category ?? '') || tags.join('\n') !== (beforeTaxonomy.tags ?? []).join('\n');
    if (taxonomyChanged) {
      fields.taxonomy = {
        ...(category ? { category } : { category: null }),
        tags, // arrays replace wholesale under deep-merge
      };
    }
    const seoDescription = read('seo_description').trim();
    if (seoDescription !== (beforeSeo.description ?? '')) {
      fields.seo = { description: seoDescription === '' ? null : seoDescription };
    }
    if (Object.keys(fields).length === 0) {
      log('sys', 'No changes to save.');
      return;
    }

    const saveButton = buttonBusy(formEl.querySelector<HTMLButtonElement>('[data-em-form-save]'));
    const working = busy('Saving…');
    const objectSession = session(state.target.objectType, state.target.objectId);

    // Edit-time contract validation (no lock needed): slug uniqueness against
    // committed posts + format come back as blockers BEFORE anything persists.
    const candidate = await callObjectVerb(getToken, {
      action: 'validate',
      object_type: state.target.objectType,
      object_id: state.target.objectId,
      candidate_patch: [{ op: 'set_article_meta', fields }],
    });
    const eligible = (candidate.body as { eligible?: boolean }).eligible;
    if (candidate.status === 200 && eligible === false) {
      working.remove();
      saveButton.done(false);
      const groups = ((
        candidate.body as { validation?: Array<{ items?: Array<{ severity?: string; message?: string }> }> }
      ).validation ?? []) as Array<{ items?: Array<{ severity?: string; message?: string }> }>;
      const blockers = groups
        .flatMap((group) => group.items ?? [])
        .filter((item) => item.severity === 'block')
        .map((item) => item.message ?? '');
      log('sys', `Not saved — fix first:<br>${blockers.map(escapeHtml).join('<br>') || 'validation failed.'}`);
      return;
    }

    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      working.remove();
      saveButton.done(false);
      log('sys', `Locked by ${escapeHtml(checkout.heldBy ?? 'another editor')} — try again when the lock frees.`);
      return;
    }
    const ops: Array<Record<string, unknown>> = [{ op: 'set_article_meta', fields }];
    attachLearningTrail(state.target, ops, fields);
    const outcome = await objectSession.patch(ops);
    working.remove();
    saveButton.done(outcome.ok);
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? `<br>${outcome.blockers.map(escapeHtml).join('<br>')}` : '';
      log('sys', `Not saved: ${escapeHtml(outcome.error)}${blockers}`);
      return;
    }
    clearLearningTrail(state.target);
    state.articleMeta = {
      ...before,
      ...(fields.slug !== undefined ? { slug: fields.slug } : {}),
      ...(fields.author !== undefined ? { author: fields.author ?? undefined } : {}),
      ...(fields.description !== undefined ? { description: fields.description ?? undefined } : {}),
      ...(fields.taxonomy !== undefined ? { taxonomy: { category: category || undefined, tags } } : {}),
      ...(fields.seo !== undefined ? { seo: { description: seoDescription || undefined } } : {}),
    };
    invalidateRecord(state.target.objectType, state.target.objectId);
    state.region.classList.add('dl-em-draft');
    log('sys', `${ICON_CHECK} Article settings saved as a draft — <strong>not published</strong>.`);
    setStatus(`${state.target.objectId}: settings draft saved.`);
    await refreshPending();
  };

  // ── navigation copy form
  // Chrome edits ride the NAV grammar (set_nav_meta / update_item /
  // upsert_group / remove+upsert_action — nav-editor.ts), never page ops.
  // Copy only: item labels, group titles, brand text, footer note. Targets/
  // hrefs/icons stay admin/agent work — the same boundary the Ask-AI
  // protected-field list draws.
  const renderNavForm = (state: PanelState): void => {
    const fields = navEditFieldsFor(state.navBody as NavigationBody);
    formEl.innerHTML = '';
    if (fields.length === 0) {
      formEl.innerHTML = '<div class="dl-em-fieldnote">No editable copy on this navigation object.</div>';
      return;
    }
    for (const field of fields) {
      const row = document.createElement('div');
      row.className = 'dl-em-formrow';
      row.innerHTML =
        `<label>${escapeHtml(field.label)}</label>` +
        `<input type="text" data-em-nav-field="${escapeHtml(field.key)}" value="${escapeHtml(field.value)}">`;
      formEl.append(row);
    }
    const foot = document.createElement('div');
    foot.className = 'dl-em-formfoot';
    foot.innerHTML =
      `<button class="dl-em-btn dl-em-save dl-em-ico" data-em-form-save>${ICON_CHECK} Save draft</button>` +
      `<button class="dl-em-btn dl-em-ghost dl-em-ico" data-em-form-cancel title="Cancel" aria-label="Cancel">${ICON_CLOSE}</button>`;
    foot.querySelector('[data-em-form-save]')?.addEventListener('click', () => void saveNavForm(state, fields));
    foot.querySelector('[data-em-form-cancel]')?.addEventListener('click', closePanel);
    formEl.append(foot);
    captureSaveBaseline();
  };

  const saveNavForm = async (state: PanelState, fields: NavEditField[]): Promise<void> => {
    const body = state.navBody as NavigationBody;
    const changes: Record<string, string> = {};
    const previews: Array<{ before: string; after: string }> = [];
    for (const field of fields) {
      const input = formEl.querySelector<HTMLInputElement>(`[data-em-nav-field="${CSS.escape(field.key)}"]`);
      if (!input) continue;
      const raw = input.value;
      // Labels are schema-min(1): an emptied input is ignored, not saved.
      if (raw === field.value || !raw.trim()) continue;
      changes[field.key] = raw;
      previews.push({ before: field.value, after: raw });
    }
    if (Object.keys(changes).length === 0) {
      log('sys', 'No changes to save.');
      return;
    }
    let ops: Array<Record<string, unknown>>;
    try {
      ops = navChangesToOps(body, changes);
    } catch (error) {
      log('sys', escapeHtml(error instanceof Error ? error.message : String(error)));
      return;
    }
    const saveButton = buttonBusy(formEl.querySelector<HTMLButtonElement>('[data-em-form-save]'));
    const working = busy('Saving…');
    const objectSession = session('navigation', state.target.objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      working.remove();
      saveButton.done(false);
      log('sys', `Locked by ${escapeHtml(checkout.heldBy ?? 'another editor')} — try again when the lock frees.`);
      return;
    }
    attachLearningTrail(state.target, ops, changes);
    const outcome = await objectSession.patch(ops);
    working.remove();
    saveButton.done(outcome.ok);
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? `<br>${outcome.blockers.map(escapeHtml).join('<br>')}` : '';
      log('sys', `Not saved: ${escapeHtml(outcome.error)}${blockers}`);
      return;
    }
    clearLearningTrail(state.target);
    for (const preview of previews) previewFieldChange(state.region, 'string', preview.before, preview.after);
    // Keep the panel body in step with the draft record, then re-snapshot the
    // form (a later upsert_group resends whole groups — staleness reverts edits).
    state.navBody = applyNavChangesToBody(body, changes);
    invalidateRecord('navigation', state.target.objectId);
    renderNavForm(state);
    state.region.classList.add('dl-em-draft');
    log('sys', `${ICON_CHECK} Draft saved — <strong>not published</strong>. Changes apply site-wide on release.`);
    setStatus(`${state.target.objectId}: draft saved.`);
    await refreshPending();
  };

  /**
   * Upload → blobs artifacts store → fill the src input with the public
   * /img/* path. Storage only: nothing changes on the object until the human
   * hits Save draft, and nothing shows publicly until publish + release.
   */
  const uploadImage = async (
    state: PanelState,
    file: File,
    srcInput: HTMLInputElement,
    button: HTMLButtonElement
  ): Promise<void> => {
    let toUpload: File = file;
    // Over the per-site web budget? Offer to shrink in-browser or keep as-is — a
    // warning, not a block: the admin on the canvas keeps their own judgement.
    if (file.size > activeMediaPolicy().maxImageBytes) {
      const choice = await chooseImageSize(file.size, activeMediaPolicy().maxImageBytes);
      if (choice === 'cancel') return;
      if (choice === 'smaller') {
        toUpload = await downscaleImage(
          file,
          activeMediaPolicy().maxImageBytes,
          activeMediaPolicy().preferredImageFormat
        );
        const fits = toUpload.size <= activeMediaPolicy().maxImageBytes;
        log(
          'sys',
          `Resized to ${Math.round(toUpload.size / 1024)} KB${
            fits ? '' : ' — still over budget, the smallest the browser could make it'
          }.`
        );
      } else {
        log(
          'sys',
          `Using the full-size image (${Math.round(file.size / 1024)} KB) — over the ${Math.round(
            activeMediaPolicy().maxImageBytes / 1024
          )} KB web budget.`
        );
      }
    }
    button.disabled = true;
    button.classList.add('dl-em-loading');
    try {
      const result = await uploadImageArtifact(getToken, state.target.objectId, toUpload);
      if (!result.ok) {
        log('sys', `Upload failed: ${escapeHtml(result.error)}`);
        return;
      }
      srcInput.value = result.publicPath;
      srcInput.dispatchEvent(new Event('input', { bubbles: true }));
      log(
        'sys',
        `${ICON_CHECK} Image stored in blobs — <code>${escapeHtml(result.publicPath)}</code>. Save draft to use it.`
      );
    } catch (error) {
      log('sys', `Upload failed: ${escapeHtml(error instanceof Error ? error.message : String(error))}`);
    } finally {
      button.disabled = false;
      button.classList.remove('dl-em-loading');
    }
  };

  const saveForm = async (state: PanelState, fields: FormField[]): Promise<void> => {
    const changed: Record<string, unknown> = {};
    const previews: Array<{ kind: 'string' | 'html' | 'image' | 'list'; before: unknown; after: unknown }> = [];
    for (const field of fields) {
      const input = formEl.querySelector<HTMLInputElement | HTMLTextAreaElement>(
        `[data-em-field="${CSS.escape(field.key)}"]`
      );
      if (!input) continue;
      const before = formValueFor(state.currentData, field);
      const raw = input.value;
      if (raw === before) continue;
      if (field.kind === 'image-src' || field.kind === 'image-alt') {
        const imageKey = field.imageField as string;
        const property = field.kind === 'image-src' ? 'src' : 'alt';
        if (field.imageIndex !== undefined) {
          // Image ARRAY (content_split): patch the whole array (deep-merge
          // replaces arrays wholesale), editing only the touched item.
          const merged =
            (changed[imageKey] as Array<Record<string, unknown>>) ??
            (state.currentData[imageKey] as Array<Record<string, unknown>>).map((item) => ({ ...item }));
          merged[field.imageIndex][property] = raw;
          changed[imageKey] = merged;
        } else {
          // A brand-new node media entry must carry its discriminant: the
          // content_item media schema requires `type` (sections' image
          // objects are {src,alt}-strict — never add type there).
          const existing = state.currentData[imageKey] as Record<string, unknown> | undefined;
          const seed = existing
            ? ({ ...existing } as Record<string, unknown>)
            : state.target.objectType === 'content_item'
              ? ({ type: 'image' } as Record<string, unknown>)
              : ({} as Record<string, unknown>);
          const merged = (changed[imageKey] as Record<string, unknown>) ?? seed;
          merged[property] = raw;
          changed[imageKey] = merged;
        }
        if (field.kind === 'image-src') previews.push({ kind: 'image', before, after: raw });
      } else if (field.kind === 'lines') {
        const lines = raw
          .split('\n')
          .map((line) => line.trim())
          .filter(Boolean);
        changed[field.key] = lines;
        previews.push({ kind: 'list', before: state.currentData[field.key], after: lines });
      } else {
        changed[field.key] = raw;
        previews.push({ kind: field.kind === 'richtext' ? 'html' : 'string', before, after: raw });
      }
    }
    if (Object.keys(changed).length === 0) {
      log('sys', 'No changes to save.');
      return;
    }
    // Gallery discipline (content_item only): an entry whose src was emptied
    // (or never filled) is REMOVED, not saved as a blank image.
    if (state.target.objectType === 'content_item' && Array.isArray(changed.images)) {
      changed.images = (changed.images as Array<{ src?: string }>).filter((entry) => (entry.src ?? '') !== '');
    }
    const saveButton = buttonBusy(formEl.querySelector<HTMLButtonElement>('[data-em-form-save]'));
    const working = busy('Saving…');
    const objectSession = session(state.target.objectType, state.target.objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      working.remove();
      saveButton.done(false);
      log('sys', `Locked by ${escapeHtml(checkout.heldBy ?? 'another editor')} — try again when the lock frees.`);
      return;
    }
    const ops = suggestionToOps(state.target, changed, state.patchSectionId);
    const textFields = fields
      .filter((field) => field.kind === 'text' || field.kind === 'richtext')
      .map((field) => field.key);
    const manualEdits = buildManualRichTextEdits(
      state.target,
      state.currentData,
      changed,
      textFields,
      new Date().toISOString()
    );
    attachLearningTrail(state.target, ops, changed, manualEdits);
    const outcome = await objectSession.patch(ops);
    working.remove();
    saveButton.done(outcome.ok);
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? `<br>${outcome.blockers.map(escapeHtml).join('<br>')}` : '';
      log('sys', `Not saved: ${escapeHtml(outcome.error)}${blockers}`);
      return;
    }
    clearLearningTrail(state.target);
    // Show the saved draft in place where we can do so unambiguously.
    for (const preview of previews) {
      if (preview.kind === 'image') {
        // Swap a matching image in place; a NEW image (no match) previews as
        // an appended figure, an emptied one removes its element — the block
        // should never wait for publish+release to show what was saved.
        let matched = false;
        state.region.querySelectorAll<HTMLImageElement>('img').forEach((img) => {
          if (img.getAttribute('src') !== preview.before) return;
          matched = true;
          if ((preview.after as string).trim()) img.src = preview.after as string;
          else (img.closest('figure') ?? img).remove();
        });
        if (!matched && (preview.after as string).trim()) {
          const figure = document.createElement('figure');
          figure.className = 'dl-em-imgpreview';
          const img = document.createElement('img');
          img.src = preview.after as string;
          img.alt = '';
          figure.append(img);
          state.region.append(figure);
        }
      } else if (preview.kind === 'list') {
        // Bullet lists preview in place too (B8): update the block's <ul>,
        // create it if the block never had one, remove it when emptied.
        const after = (preview.after as string[]) ?? [];
        let list = state.region.querySelector('ul');
        if (after.length === 0) {
          list?.remove();
        } else {
          if (!list) {
            list = document.createElement('ul');
            state.region.append(list);
          }
          list.replaceChildren(
            ...after.map((item) => {
              const li = document.createElement('li');
              li.textContent = item;
              return li;
            })
          );
        }
      } else {
        previewFieldChange(state.region, preview.kind, preview.before, preview.after);
      }
    }
    Object.assign(state.currentData, changed);
    invalidateRecord(state.target.objectType, state.target.objectId);
    state.region.classList.add('dl-em-draft');
    log('sys', `${ICON_CHECK} Draft saved — <strong>not published</strong>.`);
    setStatus(`${state.target.objectId}: draft saved.`);
    await refreshPending();
    scheduleGapRebuild();
  };

  const renderDiff = (changes: FieldChange[], previewed: Map<string, boolean>): void => {
    const container = document.createElement('div');
    container.className = 'dl-em-msg dl-em-ai';
    for (const change of changes) {
      const entry = document.createElement('div');
      entry.className = 'dl-em-diff';
      entry.innerHTML =
        `<div class="dl-em-field">${escapeHtml(change.field)}</div>` +
        `<del>${escapeHtml(shortValue(change.before))}</del><br>` +
        `<ins>${escapeHtml(shortValue(change.after))}</ins>` +
        (previewed.get(change.field) === false
          ? '<div class="dl-em-noprev">Not previewable in place — shown here only; Accept still applies it.</div>'
          : '');
      container.append(entry);
    }
    logEl.append(container);
    logEl.scrollTop = logEl.scrollHeight;
  };

  const send = async (): Promise<void> => {
    const state = panelState;
    const instruction = inputEl.value.trim();
    if (!state || !instruction) return;
    if (state.snapshot) {
      restoreRegion(state.snapshot);
      state.snapshot = undefined;
      state.suggestion = undefined;
      state.changes = undefined;
      suggestionActions.hidden = true;
    }
    log(
      'user',
      (state.imageRef ? `<span class="dl-em-repill">Re: ${escapeHtml(state.imageRef.name)}</span> ` : '') +
        escapeHtml(instruction)
    );
    inputEl.value = '';
    const sendButton = q<HTMLButtonElement>(panel, '[data-em-send]');
    sendButton.disabled = true;
    const working = busy('Thinking…');

    const response = await askAiSuggestion(getToken, {
      object_type: state.target.objectType,
      object_id: state.target.objectId,
      ...(state.target.objectType === 'page' ? { section_id: state.target.sectionId } : {}),
      ...(state.target.objectType === 'content_item' ? { node_id: state.target.nodeId } : {}),
      ...(state.selectedText ? { selected_text: state.selectedText } : {}),
      ...(state.imageRef ? { image_ref: state.imageRef } : {}),
      instruction,
    });
    working.remove();
    sendButton.disabled = false;
    if (!response.ok || !response.suggestion) {
      log('sys', escapeHtml(response.error ?? `Ask-AI failed (HTTP ${response.status})`));
      return;
    }
    const changes = summarizeFieldChanges(state.currentData, response.suggestion);
    if (changes.length === 0) {
      accumulateProposal(state.target, instruction, {});
      log('ai', 'No changes — the content already satisfies that.');
      return;
    }
    state.suggestion = changedFieldsOnly(changes);
    accumulateProposal(state.target, instruction, state.suggestion);
    state.changes = changes;
    state.snapshot = snapshotRegion(state.region);
    const previewed = new Map<string, boolean>();
    for (const change of changes) {
      previewed.set(change.field, previewFieldChange(state.region, change.kind, change.before, change.after));
    }
    state.region.classList.add('dl-em-draft');
    log('ai', `Previewing ${changes.length} change${changes.length > 1 ? 's' : ''} in place.`);
    renderDiff(changes, previewed);
    suggestionActions.hidden = false;
    scheduleGapRebuild(); // previewed content can change section heights
  };
  q<HTMLButtonElement>(panel, '[data-em-send]').addEventListener('click', () => void send());
  inputEl.addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void send();
  });

  q<HTMLButtonElement>(panel, '[data-em-accept]').addEventListener('click', async () => {
    const state = panelState;
    if (!state?.suggestion) return;
    suggestionActions.hidden = true;
    const working = busy('Saving…');
    const objectSession = session(state.target.objectType, state.target.objectId);
    const checkout = await objectSession.ensureCheckout();
    if (!checkout.ok) {
      working.remove();
      log('sys', `Locked by ${escapeHtml(checkout.heldBy ?? 'another editor')} — try again when the lock frees.`);
      suggestionActions.hidden = false;
      return;
    }
    const ops = suggestionToOps(state.target, state.suggestion, state.patchSectionId);
    attachLearningTrail(state.target, ops, state.suggestion);
    const outcome = await objectSession.patch(ops);
    working.remove();
    if (!outcome.ok) {
      const blockers = outcome.blockers?.length ? `<br>${outcome.blockers.map(escapeHtml).join('<br>')}` : '';
      log('sys', `Not saved: ${escapeHtml(outcome.error)}${blockers}`);
      suggestionActions.hidden = false;
      return;
    }
    clearLearningTrail(state.target);
    Object.assign(state.currentData, state.suggestion);
    invalidateRecord(state.target.objectType, state.target.objectId);
    state.suggestion = undefined;
    state.changes = undefined;
    state.snapshot = undefined; // the preview is now the draft — keep it on screen
    log('sys', `${ICON_CHECK} Draft saved — <strong>not published</strong>.`);
    setStatus(`${state.target.objectId}: draft saved.`);
    await refreshPending();
  });

  q<HTMLButtonElement>(panel, '[data-em-discard]').addEventListener('click', () => {
    const state = panelState;
    if (!state) return;
    if (state.snapshot) restoreRegion(state.snapshot);
    state.snapshot = undefined;
    state.suggestion = undefined;
    state.changes = undefined;
    markDraftRegions(); // restore the true draft flags after the preview styling
    suggestionActions.hidden = true;
    log('sys', 'Discarded — nothing saved.');
  });

  // ── activation
  let savedMode = '0';
  try {
    savedMode = sessionStorage.getItem(MODE_KEY) ?? '0';
  } catch {
    /* ignored */
  }
  if (savedMode === '1') setEditMode(true);
};
