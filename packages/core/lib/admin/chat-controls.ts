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
 */

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

export type ControlsField = ControlsRadioField | ControlsCheckboxField | ControlsToggleField;

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
    else values[field.id] = field.on ?? false;
  }
  return values;
}

// ─── submission brief + receipt marker ─────────────────────────────────────────

/** The machine-readable receipt embedded in the submission brief. */
export const controlsMarker = (blockId: string): string => `[controls:${blockId}]`;

function formatFieldValue(field: ControlsField, value: ControlsValues[string] | undefined): string {
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
  const parts = block.fields.map((field) => `${field.label}: ${formatFieldValue(field, values[field.id])}`);
  return `Selections ${controlsMarker(block.id)} — ${parts.join('; ')}`;
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
