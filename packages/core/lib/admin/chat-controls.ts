/**
 * Interactive controls blocks in agent chats (owner request: "less typing,
 * more clicking"). The agent opts in by emitting a fenced code block with
 * info-string `controls` containing JSON — see
 * `docs/cms-architecture/chat-controls-protocol.md` for the full spec.
 *
 * Every function here is pure: parsing, validation, default-value derivation,
 * brief formatting, and submitted-state derivation from the transcript. No
 * DOM, no React — the renderer (`ControlsCard.tsx`) is the only consumer that
 * touches the UI. This keeps the protocol boundary testable without a DOM
 * harness and matches the house pattern in `chat-logic.ts`.
 *
 * ASV2-W4 adds §6's v2 kinds (`actions`, `select_object`, `confirm`) and §6.4's
 * offered-verb gate. §1-§5 (the form block) are untouched: a v1 block still
 * parses, still defaults, still briefs, still derives its submitted state
 * exactly as before.
 *
 * ASV2-W5: the field KINDS moved to the leaf `controls-kinds.ts` (re-exported
 * below) so that `ui-capabilities.ts` — which SERVER code
 * (`server/lib/agent/engine.ts`) imports — can read them without pulling this
 * file's parser and prose into a function's cold start. This module is still
 * pure and still server-safe (no React, no DOM, no `window`); it is simply no
 * longer on the server's graph.
 */
import { CONTROLS_ACTION_KINDS } from './controls-kinds.js';
import type { ControlState } from './object-detail-actions.js';

// ─── schema ─────────────────────────────────────────────────────────────────

export const CONTROLS_FENCE_LANG = 'controls';

export interface ControlsOption {
  value: string;
  label: string;
}

export interface ControlsRadioField {
  kind: 'radio';
  id: string;
  label: string;
  options: ControlsOption[];
  /** Default selection — must match an option's value or is dropped. */
  value?: string;
}

export interface ControlsCheckboxField {
  kind: 'checkbox';
  id: string;
  label: string;
  options: ControlsOption[];
  /** Default selections — entries that don't match an option's value are dropped. */
  values?: string[];
}

export interface ControlsToggleField {
  kind: 'toggle';
  id: string;
  label: string;
  on?: boolean;
}

/** v1's three, gathered by a submit button (§6: a FORM block). */
export type ControlsFormField = ControlsRadioField | ControlsCheckboxField | ControlsToggleField;

// ─── v2 (§6.1-§6.3) — the click IS the submission ───────────────────────────

/** §6.1 — one button. `verb` must already exist in `quick-actions.ts`; a block
 *  never widens the verb surface, and §6.4 is what enforces that at render. */
export interface ControlsActionEntry {
  verb: string;
  label: string;
  /** Pre-filled parameters for the run. Anything the editor must still supply
   *  is collected by the same `executionFor(params)` path the strip uses. */
  args?: Record<string, unknown>;
  /** `danger` only; `default` is spelled by omitting the key. */
  tone?: 'danger';
}

export interface ControlsActionsField {
  kind: 'actions';
  id: string;
  label: string;
  actions: ControlsActionEntry[];
}

/** §6.2 — one candidate object. The bounds are the wire's own, because the
 *  selection becomes the chat's `object_type`/`object_id` pair. */
export interface ControlsObjectEntry {
  object_type: string;
  object_id: string;
  title?: string;
  status?: string;
}

export interface ControlsSelectObjectField {
  kind: 'select_object';
  id: string;
  label: string;
  objects: ControlsObjectEntry[];
}

export interface ControlsConfirmField {
  kind: 'confirm';
  id: string;
  label: string;
  confirm_label?: string;
  decline_label?: string;
  tone?: 'danger';
}

/** §6: an ACTION block holds exactly one of these and no submit button. */
export type ControlsActionField = ControlsActionsField | ControlsSelectObjectField | ControlsConfirmField;

export type ControlsField = ControlsFormField | ControlsActionField;

/** §6.1: at most 6 buttons in one row. */
export const MAX_CONTROLS_ACTIONS = 6;
/** §6.2: at most 12 candidate objects. */
export const MAX_CONTROLS_OBJECTS = 12;
/** §6.2: the wire's own bounds on the pair the selection becomes. */
export const MAX_OBJECT_TYPE_CHARS = 128;
export const MAX_OBJECT_ID_CHARS = 256;

/**
 * ASV2-W5: the kinds now live in the leaf `controls-kinds.ts` and are
 * re-exported here, so every existing importer of this module is unchanged
 * while `ui-capabilities.ts` (which SERVER code imports) can read the array
 * without dragging this file's 25 KB of parser and prose into a function's
 * cold start. Still ONE declaration — see that module's header.
 */
export {
  CONTROLS_ACTION_KINDS,
  CONTROLS_FIELD_KINDS,
  CONTROLS_FORM_KINDS,
  type ControlsFieldKind,
} from './controls-kinds.js';

const ACTION_KINDS = new Set<string>(CONTROLS_ACTION_KINDS);

/** §6's shape question, answered off the field itself. */
export const isControlsActionField = (field: ControlsField): field is ControlsActionField =>
  ACTION_KINDS.has(field.kind);

/** The single action field of an ACTION block, or `undefined` for a form block. */
export function controlsActionField(block: ControlsBlock): ControlsActionField | undefined {
  const first = block.fields[0];
  return block.fields.length === 1 && first && isControlsActionField(first) ? first : undefined;
}

export interface ControlsBlock {
  /** Required, unique within the chat — also the `[controls:<id>]` receipt marker. */
  id: string;
  title?: string;
  /** Submit button label; defaults to "Submit" in the renderer. */
  submit?: string;
  fields: ControlsField[];
}

/** One field's live answer: a selected option value (radio), selected option
 *  values (checkbox), or on/off (toggle) — keyed by field id. */
export type ControlsValues = Record<string, string | string[] | boolean>;

// ─── validation (never throws) ──────────────────────────────────────────────────

const isNonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;

function validateOptions(value: unknown): ControlsOption[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  const options: ControlsOption[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const { value: optionValue, label } = raw as Record<string, unknown>;
    if (!isNonEmptyString(optionValue) || !isNonEmptyString(label)) return null;
    options.push({ value: optionValue, label });
  }
  return options;
}

/**
 * §6.1/§6.3's `tone`. An unrecognized value FAILS the field rather than
 * degrading to `default`: §1's forgiveness is scoped to a mismatched DEFAULT
 * ("a recoverable authoring slip"), and a tone is an enum on the field's own
 * shape, not a default. Falling back to a code block makes the authoring error
 * visible; silently redrawing a `danger` button as an ordinary one would not.
 */
function validateTone(value: unknown): { ok: true; tone?: 'danger' } | { ok: false } {
  if (value === undefined || value === 'default') return { ok: true };
  if (value === 'danger') return { ok: true, tone: 'danger' };
  return { ok: false };
}

/** A bounded, non-empty wire string. */
const isBoundedString = (value: unknown, max: number): value is string =>
  isNonEmptyString(value) && value.length <= max;

function validateActions(value: unknown): ControlsActionEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTROLS_ACTIONS) return null;
  const actions: ControlsActionEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (!isNonEmptyString(entry.verb) || !isNonEmptyString(entry.label)) return null;
    const tone = validateTone(entry.tone);
    if (!tone.ok) return null;
    let args: Record<string, unknown> | undefined;
    if (entry.args !== undefined) {
      if (!entry.args || typeof entry.args !== 'object' || Array.isArray(entry.args)) return null;
      args = { ...(entry.args as Record<string, unknown>) };
    }
    actions.push({
      verb: entry.verb,
      label: entry.label,
      ...(args ? { args } : {}),
      ...(tone.tone ? { tone: tone.tone } : {}),
    });
  }
  return actions;
}

function validateObjects(value: unknown): ControlsObjectEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CONTROLS_OBJECTS) return null;
  const objects: ControlsObjectEntry[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const entry = raw as Record<string, unknown>;
    if (!isBoundedString(entry.object_type, MAX_OBJECT_TYPE_CHARS)) return null;
    if (!isBoundedString(entry.object_id, MAX_OBJECT_ID_CHARS)) return null;
    const title = isNonEmptyString(entry.title) ? entry.title : undefined;
    const status = isNonEmptyString(entry.status) ? entry.status : undefined;
    objects.push({
      object_type: entry.object_type,
      object_id: entry.object_id,
      ...(title ? { title } : {}),
      ...(status ? { status } : {}),
    });
  }
  return objects;
}

function validateField(raw: unknown): ControlsField | null {
  if (!raw || typeof raw !== 'object') return null;
  const obj = raw as Record<string, unknown>;
  if (!isNonEmptyString(obj.id) || !isNonEmptyString(obj.label)) return null;

  if (obj.kind === 'radio') {
    const options = validateOptions(obj.options);
    if (!options) return null;
    const value =
      isNonEmptyString(obj.value) && options.some((option) => option.value === obj.value) ? obj.value : undefined;
    return { kind: 'radio', id: obj.id, label: obj.label, options, ...(value ? { value } : {}) };
  }

  if (obj.kind === 'checkbox') {
    const options = validateOptions(obj.options);
    if (!options) return null;
    const values = Array.isArray(obj.values)
      ? obj.values.filter(
          (candidate): candidate is string =>
            isNonEmptyString(candidate) && options.some((option) => option.value === candidate)
        )
      : undefined;
    return { kind: 'checkbox', id: obj.id, label: obj.label, options, ...(values ? { values } : {}) };
  }

  if (obj.kind === 'toggle') {
    const on = typeof obj.on === 'boolean' ? obj.on : undefined;
    return { kind: 'toggle', id: obj.id, label: obj.label, ...(on !== undefined ? { on } : {}) };
  }

  if (obj.kind === 'actions') {
    const actions = validateActions(obj.actions);
    if (!actions) return null;
    return { kind: 'actions', id: obj.id, label: obj.label, actions };
  }

  if (obj.kind === 'select_object') {
    const objects = validateObjects(obj.objects);
    if (!objects) return null;
    return { kind: 'select_object', id: obj.id, label: obj.label, objects };
  }

  if (obj.kind === 'confirm') {
    const tone = validateTone(obj.tone);
    if (!tone.ok) return null;
    const confirmLabel = isNonEmptyString(obj.confirm_label) ? obj.confirm_label : undefined;
    const declineLabel = isNonEmptyString(obj.decline_label) ? obj.decline_label : undefined;
    return {
      kind: 'confirm',
      id: obj.id,
      label: obj.label,
      ...(confirmLabel ? { confirm_label: confirmLabel } : {}),
      ...(declineLabel ? { decline_label: declineLabel } : {}),
      ...(tone.tone ? { tone: tone.tone } : {}),
    };
  }

  // Unknown kind — the whole block falls back to an ordinary code block.
  return null;
}

/** Validates an already-parsed JSON value against the controls schema. Returns
 *  `null` for anything malformed — including one bad field or an unknown
 *  `kind` — never throws. */
export function validateControlsBlock(json: unknown): ControlsBlock | null {
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!isNonEmptyString(obj.id)) return null;
  if (!Array.isArray(obj.fields) || obj.fields.length === 0) return null;

  const fields: ControlsField[] = [];
  for (const rawField of obj.fields) {
    const field = validateField(rawField);
    if (!field) return null;
    fields.push(field);
  }

  const title = isNonEmptyString(obj.title) ? obj.title : undefined;
  const submit = isNonEmptyString(obj.submit) ? obj.submit : undefined;

  // §6 — the form/action split. A card either GATHERS (one or more form
  // fields behind a submit button) or FIRES (exactly one action field, the
  // click being the submission). Mixing the two, or a second action field, or
  // a submit button on an action block, is invalid under §1's all-or-nothing
  // rule: a card cannot both gather and fire, so there is nothing coherent to
  // draw and the block falls back to an ordinary code block.
  if (fields.some(isControlsActionField) && (fields.length !== 1 || submit !== undefined)) return null;

  return { id: obj.id, fields, ...(title ? { title } : {}), ...(submit ? { submit } : {}) };
}

/** Parses + validates a raw JSON string (the fenced block's content). Returns
 *  `null` on invalid JSON or a schema violation — the caller falls back to
 *  rendering the block as an ordinary code block. */
export function parseControlsJson(raw: string): ControlsBlock | null {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateControlsBlock(json);
}

// ─── message splitting ────────────────────────────────────────────────────────────

export type ControlsSegment = { kind: 'text'; text: string } | { kind: 'controls'; block: ControlsBlock };

const CONTROLS_FENCE_RE = /```controls\r?\n([\s\S]*?)\r?\n```/g;

/**
 * Splits assistant text into text/controls segments. A `controls`-fenced
 * block that fails to parse or validate is left untouched inside its
 * surrounding text segment, so it renders as an ordinary fenced code block —
 * this function never drops or crashes on malformed input.
 */
export function splitControlsSegments(text: string): ControlsSegment[] {
  const segments: ControlsSegment[] = [];
  const re = new RegExp(CONTROLS_FENCE_RE);
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text))) {
    const block = parseControlsJson(match[1] ?? '');
    if (!block) continue; // leave the raw fence in the surrounding text
    if (match.index > lastIndex) segments.push({ kind: 'text', text: text.slice(lastIndex, match.index) });
    segments.push({ kind: 'controls', block });
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length || segments.length === 0) segments.push({ kind: 'text', text: text.slice(lastIndex) });
  return segments;
}

// ─── default values ────────────────────────────────────────────────────────────

/** The pre-filled answer state a fresh card starts from — the block's own
 *  declared defaults (falling back to the first option for radio groups). */
export function defaultControlsValues(block: ControlsBlock): ControlsValues {
  const values: ControlsValues = {};
  for (const field of block.fields) {
    if (field.kind === 'radio') values[field.id] = field.value ?? field.options[0]?.value ?? '';
    else if (field.kind === 'checkbox') values[field.id] = field.values ?? [];
    else if (field.kind === 'toggle') values[field.id] = field.on ?? false;
    // An action field gathers nothing — the click IS the submission (§6).
  }
  return values;
}

// ─── submission brief + receipt marker ─────────────────────────────────────────

/** The machine-readable receipt embedded in the submission brief. */
export const controlsMarker = (blockId: string): string => `[controls:${blockId}]`;

function formatFieldValue(field: ControlsFormField, value: ControlsValues[string] | undefined): string {
  if (field.kind === 'radio') {
    const selected = typeof value === 'string' ? value : undefined;
    const option = field.options.find((candidate) => candidate.value === selected);
    return option?.label ?? '(none selected)';
  }
  if (field.kind === 'checkbox') {
    const selected = Array.isArray(value) ? value : [];
    const labels = field.options.filter((option) => selected.includes(option.value)).map((option) => option.label);
    return labels.length > 0 ? labels.join(', ') : 'None';
  }
  return value === true ? 'on' : 'off';
}

/**
 * Composes the compact plain-text brief sent through the existing
 * user-message send path, e.g.:
 * `Selections [controls:tone-choice] — Tone: Warm; Include sections: CTA banner; Generate hero image: off`
 */
export function formatControlsBrief(block: ControlsBlock, values: ControlsValues): string {
  const parts = block.fields
    .filter((field): field is ControlsFormField => !isControlsActionField(field))
    .map((field) => `${field.label}: ${formatFieldValue(field, values[field.id])}`);
  return `Selections ${controlsMarker(block.id)} — ${parts.join('; ')}`;
}

// ─── v2 receipts (§6.1-§6.3) ────────────────────────────────────────────────

/**
 * The v2 receipts. Same `[controls:<id>]` marker as v1's brief, so
 * `isControlsSubmitted` already recognises them and a reopened chat
 * re-derives the answered state from the transcript with zero server changes.
 * Spelled exactly as §6.1-§6.3 specify.
 */
export const controlsRanLine = (blockId: string, verb: string): string => `${controlsMarker(blockId)} ran ${verb}`;

export const controlsSelectedLine = (blockId: string, objectId: string): string =>
  `${controlsMarker(blockId)} selected ${objectId}`;

export const controlsDecisionLine = (blockId: string, confirmed: boolean): string =>
  `${controlsMarker(blockId)} ${confirmed ? 'confirmed' : 'declined'}`;

/**
 * §6.1's "posts back `[controls:<id>] ran <verb>` ALONGSIDE the run's own
 * `[action:<verb>] …` trace line" — as ONE message, two lines.
 *
 * One message because `chat.send` is a turn: two sends for one click would
 * start two runs. The receipt leads so that the trace line is not swallowed
 * into a half-parsed prefix — `parseActionTraceLine` anchors at the start of
 * the text it is given, so it declines the combined message (honest: it is
 * not a bare trace line) and parses the second line on its own.
 */
export const controlsRanMessage = (blockId: string, verb: string, traceLine?: string): string =>
  traceLine ? `${controlsRanLine(blockId, verb)}\n${traceLine}` : controlsRanLine(blockId, verb);

/**
 * §6.1's `args`, narrowed to what `runQuickAction` takes
 * (`QuickActionValues = Record<string, string>`). Scalars are stringified;
 * anything else (an object, an array, null) is dropped rather than coerced to
 * `"[object Object]"` — a parameter the client cannot honestly pre-fill is a
 * parameter the editor is still asked for.
 */
export function controlsActionValues(action: ControlsActionEntry): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(action.args ?? {})) {
    if (typeof value === 'string') values[key] = value;
    else if (typeof value === 'number' && Number.isFinite(value)) values[key] = String(value);
    else if (typeof value === 'boolean') values[key] = String(value);
  }
  return values;
}

// ─── submitted-state derivation (from the transcript, never local state) ────

/** True when any later user message in the transcript carries this block's receipt marker. */
export function isControlsSubmitted(blockId: string, laterUserMessageTexts: readonly string[]): boolean {
  const marker = controlsMarker(blockId);
  return laterUserMessageTexts.some((text) => text.includes(marker));
}

/** The first later user message carrying this block's receipt marker, if any. */
export function findControlsSubmissionText(
  blockId: string,
  laterUserMessageTexts: readonly string[]
): string | undefined {
  const marker = controlsMarker(blockId);
  return laterUserMessageTexts.find((text) => text.includes(marker));
}

export interface ControlsBriefEntry {
  label: string;
  display: string;
}

/**
 * Parses a submission brief (our own `formatControlsBrief` output) back into
 * ordered `{label, display}` pairs, so the read-only card shows what was
 * actually sent — sourced from the transcript, not from component state that
 * a reload would have wiped. Returns `null` if the text doesn't look like a
 * brief this protocol produced.
 */
export function parseControlsBrief(text: string): ControlsBriefEntry[] | null {
  const dashIndex = text.indexOf(' — ');
  if (dashIndex === -1) return null;
  const rest = text.slice(dashIndex + 3).trim();
  if (!rest) return null;
  const entries: ControlsBriefEntry[] = [];
  for (const part of rest.split('; ')) {
    if (!part) continue;
    const sepIndex = part.indexOf(': ');
    if (sepIndex === -1) return null;
    entries.push({ label: part.slice(0, sepIndex), display: part.slice(sepIndex + 2) });
  }
  return entries.length > 0 ? entries : null;
}

/**
 * Every receipt this protocol produces, v1 and v2, read back out of the
 * transcript message that carries the block's marker.
 *
 * `parseControlsBrief` is unchanged and still owns the v1 shape — it is what
 * the `selections` case delegates to. The v2 receipts carry no ` — ` and so
 * already returned `null` there; this is the function that gives the read-only
 * card something to show for them instead. Line-wise, because §6.1's message
 * is the receipt line plus the run's trace line.
 */
export type ControlsReceipt =
  | { kind: 'selections'; entries: ControlsBriefEntry[] }
  | { kind: 'ran'; verb: string }
  | { kind: 'selected'; object_id: string }
  | { kind: 'decision'; confirmed: boolean };

export function parseControlsReceipt(blockId: string, text: string): ControlsReceipt | null {
  const marker = controlsMarker(blockId);
  for (const line of text.split('\n')) {
    const at = line.indexOf(marker);
    if (at === -1) continue;
    const rest = line.slice(at + marker.length).trim();
    if (rest === 'confirmed') return { kind: 'decision', confirmed: true };
    if (rest === 'declined') return { kind: 'decision', confirmed: false };
    const ran = /^ran\s+(\S+)$/.exec(rest);
    if (ran) return { kind: 'ran', verb: ran[1]! };
    const selected = /^selected\s+(.+)$/.exec(rest);
    if (selected) return { kind: 'selected', object_id: selected[1]!.trim() };
    const entries = parseControlsBrief(line);
    if (entries) return { kind: 'selections', entries };
  }
  return null;
}

// ─── §6.4 — the offered-verb gate ───────────────────────────────────────────

/** §6.4's copy, verbatim. Shown, never hidden. */
export const ACTION_NOT_OFFERED_REASON = 'not available here';

/**
 * §7's manifest, structurally — only the part this gate reads.
 *
 * Declared here rather than imported from `ui-capabilities.ts` so the parser
 * never depends on the manifest builder (the dependency runs one way, builder
 * → kinds, and this keeps it that way). `UiCapabilities` satisfies this shape
 * structurally.
 */
export interface ControlsActionManifest {
  actions: readonly { verb: string }[];
}

/**
 * §6.4 — may this button run?
 *
 * A verb absent from the manifest renders DISABLED WITH THE REASON, never
 * hidden (`resolveObjectControls`'s convention): the editor must be able to
 * see that the agent offered something this surface cannot do, rather than
 * see nothing at all. **No manifest at all means every button is disabled** —
 * §7's own degradation rule, and the honest reading of a surface with no
 * object in focus.
 *
 * WHICH manifest (ASV2-W5, and §6.4's own corrected wording): NOT the object
 * Platform sent on that turn. `ui_capabilities` travels Platform → CMS-Agent
 * and nothing returns it to the browser, so the caller passes a manifest
 * REBUILT locally by `buildUiCapabilities` from the same two inputs. Two
 * evaluations of one pure function, not one value — see the spec's §6.4.
 *
 * §6.4 spells this `allowedAction(block, manifest)`. The parameter is the
 * ACTION ENTRY rather than the block because the decision is per button — one
 * block may offer three verbs of which only two are on this turn's list — and
 * a per-block answer could not say which. Same decision, finer grain.
 *
 * DISPLAY ONLY, like every other gate in `lib/admin`: rights are enforced in
 * the verb itself and in `resolveObjectControls`, never by the presence of a
 * button (§6.4's closing line).
 */
export function allowedAction(
  action: Pick<ControlsActionEntry, 'verb'>,
  manifest: ControlsActionManifest | undefined
): ControlState {
  if (!manifest) return { enabled: false, reason: ACTION_NOT_OFFERED_REASON };
  return manifest.actions.some((offered) => offered.verb === action.verb)
    ? { enabled: true }
    : { enabled: false, reason: ACTION_NOT_OFFERED_REASON };
}
