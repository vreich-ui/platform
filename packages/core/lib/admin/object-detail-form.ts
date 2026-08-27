/**
 * Object detail — the direct edit form, and the ONE reconciliation rule that
 * makes form editing and chat editing the same edit (T2.2, D1(a)/D2).
 *
 * Wolf's complaint this closes: the brand voice (`editorial_voice`) was
 * editable neither directly nor through chat. Both paths now exist and both
 * go through the SAME governed verbs — `checkout → patch(<type's fields op>)
 * → checkin` (`lib/edit-mode/verbs-client.ts`'s `EditSession`). There is no
 * side-channel write anywhere in this module: it only builds the `ops` array
 * a `patch` call carries, exactly like `inspector-ops.ts` does for the
 * canvas, and re-reads the record the same way a chat write does.
 *
 * Two halves:
 *
 *  1. **Descriptors.** Which object types get a direct form at all
 *     (`objectEditMode`), which patch op that type's scalar/prose fields go
 *     through (`OBJECT_FIELDS_OP` — read off `patchOpNamesByObjectType`'s
 *     per-type allowlist, never guessed), and which body fields the form
 *     shows (`objectFormFields`). Structured children — a page's `sections`,
 *     an article's `nodes`, a template's `slots`, a voice's `frameworks[]` —
 *     are deliberately NOT in the form: their own ops exist (and the meta
 *     ops explicitly `forbidKeys` them), so the form would be lying about
 *     what it can save. Chat edits those.
 *
 *  2. **Reconciliation.** The form holds a draft; the agent writes to the
 *     same record underneath it. `reconcileFormDraft` is the whole conflict
 *     policy, in one pure function, so it can be tested without a DOM:
 *
 *       - field the editor has not touched  → the agent's value is adopted
 *         silently (that is what "the chat edit is visible in the form" means)
 *       - field the editor touched, agent did not → the editor's draft stands
 *       - both touched, same value → agreement, nothing to report
 *       - both touched, different values → CONFLICT: the editor's draft is
 *         kept in the field (never silently overwritten mid-typing) and the
 *         field id is reported so the surface can show the agent's value and
 *         offer to take it. The record is the winner of record either way —
 *         the draft is unsaved text, and saving it re-reads and re-checks the
 *         record version through `EditSession.patch`'s
 *         `expected_record_version` (a real 409 → retry, not a lost update).
 */
import type { ObjectRecord, ObjectType } from '../../schema/object-record-v1.js';
import { isPlainObject } from './inspector-ops.js';

// ─── which types get a direct form ──────────────────────────────────────────

/**
 * Text-like types get a direct edit form AND chat. Everything else is
 * chat-only — the brief's "media objects" rule, generalized: a type whose
 * substance is not prose/scalar fields (a product's media stage, a
 * navigation tree, a taxonomy registry, a theme's tokens) has no honest
 * flat form, so it gets chips + chat rather than a form that can only edit
 * the shell around the thing the editor came to change.
 */
export const TEXT_LIKE_OBJECT_TYPES: readonly ObjectType[] = [
  'editorial_voice',
  'template',
  'section_template',
  'page',
  'content_item',
];

export type ObjectEditMode = 'form' | 'chat-only';

export const objectEditMode = (objectType: ObjectType): ObjectEditMode =>
  TEXT_LIKE_OBJECT_TYPES.includes(objectType) ? 'form' : 'chat-only';

/**
 * The type's deep-merge "fields" op — the one every scalar/prose edit on
 * that type goes through, form or chat. Mirrors
 * `schema/object-patch-ops.ts`'s `patchOpNamesByObjectType`; a type absent
 * here has no flat fields op and therefore no form (see `objectEditMode`).
 */
export const OBJECT_FIELDS_OP: Partial<Record<ObjectType, string>> = {
  editorial_voice: 'set_voice_fields',
  template: 'set_template_meta',
  section_template: 'set_section_template_meta',
  page: 'set_page_meta',
  content_item: 'set_article_meta',
};

// ─── field descriptors ──────────────────────────────────────────────────────

export type FormFieldKind = 'text' | 'textarea' | 'lines';

export interface FormFieldSpec {
  /** Dotted body path — also the field's stable id. */
  id: string;
  label: string;
  kind: FormFieldKind;
  hint?: string;
  /** Schema-required (`z.string().min(1)`): emptying it is refused client-side. */
  required?: boolean;
  /** Textarea row count; ignored for other kinds. */
  rows?: number;
}

const VOICE_FIELDS: readonly FormFieldSpec[] = [
  { id: 'name', label: 'Name', kind: 'text', required: true },
  {
    id: 'audience',
    label: 'Audience',
    kind: 'textarea',
    rows: 3,
    required: true,
    hint: 'Who this publication is written for, stated as a fact about the reader.',
  },
  { id: 'tone', label: 'Tone', kind: 'lines', required: true, hint: 'One adjective per line.' },
  {
    id: 'cadence',
    label: 'Cadence',
    kind: 'textarea',
    rows: 3,
    required: true,
    hint: 'Sentence and paragraph rhythm: length, density, person, tense.',
  },
  { id: 'lexicon.prefer', label: 'Preferred terms', kind: 'lines', hint: 'One per line.' },
  { id: 'lexicon.avoid', label: 'Avoided terms', kind: 'lines', hint: 'One per line.' },
  { id: 'claim_policy', label: 'Claim policy', kind: 'textarea', rows: 3, required: true },
  { id: 'cta_policy', label: 'Calls to action', kind: 'textarea', rows: 3, required: true },
  { id: 'reader_safety_notes', label: 'Reader safety', kind: 'textarea', rows: 3, required: true },
];

const RECIPE_FIELDS: readonly FormFieldSpec[] = [
  { id: 'name', label: 'Name', kind: 'text', required: true },
  { id: 'description', label: 'Description', kind: 'textarea', rows: 3, hint: 'What this recipe IS (agent-facing).' },
  {
    id: 'whenToUse',
    label: 'When to use',
    kind: 'textarea',
    rows: 3,
    hint: 'When to pick it over sibling recipes — use cases, not a restatement.',
  },
];

const PAGE_FIELDS: readonly FormFieldSpec[] = [
  { id: 'title', label: 'Title', kind: 'text', required: true },
  { id: 'route', label: 'Route', kind: 'text', required: true, hint: 'The path this page serves, e.g. /about.' },
  { id: 'seo.title', label: 'SEO title', kind: 'text' },
  { id: 'seo.description', label: 'SEO description', kind: 'textarea', rows: 2 },
];

const ARTICLE_FIELDS: readonly FormFieldSpec[] = [
  { id: 'title', label: 'Title', kind: 'text', required: true },
  { id: 'slug', label: 'Slug', kind: 'text', required: true, hint: 'Lowercase letters, digits, single hyphens.' },
  { id: 'description', label: 'Description (deck)', kind: 'textarea', rows: 2 },
  { id: 'author', label: 'Author', kind: 'text', hint: 'Shown as the byline; leave blank to omit.' },
  { id: 'seo.description', label: 'SEO description', kind: 'textarea', rows: 2 },
];

const FIELDS_BY_TYPE: Partial<Record<ObjectType, readonly FormFieldSpec[]>> = {
  editorial_voice: VOICE_FIELDS,
  template: RECIPE_FIELDS,
  section_template: RECIPE_FIELDS,
  page: PAGE_FIELDS,
  content_item: ARTICLE_FIELDS,
};

/** The flat fields the direct form edits. Empty for chat-only types. */
export const objectFormFields = (objectType: ObjectType): readonly FormFieldSpec[] => FIELDS_BY_TYPE[objectType] ?? [];

/**
 * The field the header's inline title edit writes — `title` where the type
 * has one, `name` for the recipe/voice family, `undefined` for a type with
 * neither (the pencil then renders disabled with a reason rather than
 * writing the wrong field).
 */
export const titleFieldId = (objectType: ObjectType): string | undefined => {
  const ids = new Set(objectFormFields(objectType).map((field) => field.id));
  if (ids.has('title')) return 'title';
  if (ids.has('name')) return 'name';
  return undefined;
};

/** The field the header's inline excerpt edit writes, when the type has one. */
export const excerptFieldId = (objectType: ObjectType): string | undefined =>
  objectFormFields(objectType).some((field) => field.id === 'description') ? 'description' : undefined;

/**
 * Structured children the form deliberately does not touch, named so the
 * surface can say WHY rather than leaving the editor hunting for them.
 */
export const structuredFieldNote = (objectType: ObjectType): string | undefined => {
  switch (objectType) {
    case 'editorial_voice':
      return 'Article frameworks are a structured set — ask the agent to add, reorder, or retire one.';
    case 'page':
      return 'Sections are edited through the section ops — ask the agent, or use the page canvas.';
    case 'content_item':
      return 'Article body nodes are edited through the node ops — ask the agent, or edit on site.';
    case 'template':
      return 'Slots are edited through the slot ops — ask the agent.';
    case 'section_template':
      return 'The blueprint is edited through the blueprint ops — ask the agent.';
    default:
      return undefined;
  }
};

// ─── values ─────────────────────────────────────────────────────────────────

/** Form state: every field's value as the editable STRING the control holds. */
export type FormValues = Record<string, string>;

const readPath = (body: unknown, path: string): unknown => {
  let cursor: unknown = body;
  for (const segment of path.split('.')) {
    if (!isPlainObject(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
};

const toDisplay = (value: unknown, kind: FormFieldKind): string => {
  if (kind === 'lines') return Array.isArray(value) ? value.map((item) => String(item)).join('\n') : '';
  if (value === null || value === undefined) return '';
  return typeof value === 'string' ? value : String(value);
};

/** The form's values for a record — the single reader used for both the initial draft and every re-read. */
export const readFormValues = (
  record: Pick<ObjectRecord<Record<string, unknown>>, 'object_type' | 'body'>
): FormValues => {
  const values: FormValues = {};
  for (const field of objectFormFields(record.object_type)) {
    values[field.id] = toDisplay(readPath(record.body, field.id), field.kind);
  }
  return values;
};

/** Field ids whose draft differs from the record snapshot it was read from. */
export const dirtyFields = (base: FormValues, draft: FormValues): string[] =>
  Object.keys(draft).filter((id) => draft[id] !== base[id]);

// ─── client-side validation (the server re-validates; this is not a gate) ────

export interface FormFieldError {
  id: string;
  message: string;
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const validateFormValues = (objectType: ObjectType, values: FormValues): FormFieldError[] => {
  const errors: FormFieldError[] = [];
  for (const field of objectFormFields(objectType)) {
    const raw = (values[field.id] ?? '').trim();
    if (field.required && raw === '') {
      errors.push({ id: field.id, message: `${field.label} is required.` });
      continue;
    }
    if (field.id === 'slug' && raw !== '' && !SLUG_PATTERN.test(raw)) {
      errors.push({ id: field.id, message: 'Lowercase letters, digits, single hyphens.' });
    }
    if (field.id === 'route' && raw !== '' && !raw.startsWith('/')) {
      errors.push({ id: field.id, message: 'A route starts with "/".' });
    }
  }
  return errors;
};

// ─── ops ────────────────────────────────────────────────────────────────────

export interface FieldsPatchOp {
  op: string;
  fields: Record<string, unknown>;
}

const parseValue = (raw: string, field: FormFieldSpec): unknown => {
  if (field.kind === 'lines') {
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
  }
  const trimmed = raw.trim();
  // Optional string fields unset with an explicit null — the fields ops
  // deep-merge, so `''` would persist an empty string instead of removing
  // the key (inspector-ops.ts's trap #2, same rule).
  if (trimmed === '') return field.required ? '' : null;
  return trimmed;
};

const assignPath = (target: Record<string, unknown>, path: string, value: unknown): void => {
  const segments = path.split('.');
  let cursor = target;
  for (const segment of segments.slice(0, -1)) {
    const next = cursor[segment];
    if (!isPlainObject(next)) cursor[segment] = {};
    cursor = cursor[segment] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
};

/**
 * The ops array for the changed fields — one deep-merge op for the type, or
 * `[]` when nothing changed. This is the ONLY thing this module hands to a
 * write path; `EditSession.patch` does the rest.
 */
export const buildFormPatchOps = (objectType: ObjectType, base: FormValues, draft: FormValues): FieldsPatchOp[] => {
  const op = OBJECT_FIELDS_OP[objectType];
  const changed = dirtyFields(base, draft);
  if (!op || changed.length === 0) return [];
  const specs = new Map(objectFormFields(objectType).map((field) => [field.id, field]));
  const fields: Record<string, unknown> = {};
  for (const id of changed) {
    const spec = specs.get(id);
    if (!spec) continue;
    assignPath(fields, id, parseValue(draft[id] ?? '', spec));
  }
  return Object.keys(fields).length > 0 ? [{ op, fields }] : [];
};

// ─── reconciliation (form ⇄ chat) ───────────────────────────────────────────

export interface ReconcileInput {
  /** Values as read from the record the current draft started from. */
  base: FormValues;
  /** What the editor has in the form right now. */
  draft: FormValues;
  /** Values read from the freshly re-fetched record (after a chat write, or a poll). */
  incoming: FormValues;
}

export interface ReconcileResult {
  /** The draft to render after the merge. */
  values: FormValues;
  /** The new baseline — always the incoming record, so a later save diffs against reality. */
  base: FormValues;
  /** Fields where the agent's value was taken in because the editor had not touched them. */
  adopted: string[];
  /**
   * Fields the editor and the agent both changed, to different values. The
   * editor's text is kept; `theirs` carries the agent's so the surface can
   * offer it. Nothing is written by this function.
   */
  conflicts: Array<{ id: string; mine: string; theirs: string }>;
}

export const reconcileFormDraft = ({ base, draft, incoming }: ReconcileInput): ReconcileResult => {
  const ids = new Set([...Object.keys(base), ...Object.keys(draft), ...Object.keys(incoming)]);
  const values: FormValues = {};
  const adopted: string[] = [];
  const conflicts: ReconcileResult['conflicts'] = [];

  for (const id of ids) {
    const baseValue = base[id] ?? '';
    const draftValue = draft[id] ?? '';
    const incomingValue = incoming[id] ?? '';
    const editorTouched = draftValue !== baseValue;
    const agentTouched = incomingValue !== baseValue;

    if (!editorTouched) {
      values[id] = incomingValue;
      if (agentTouched) adopted.push(id);
      continue;
    }
    // The editor has unsaved text here — never overwrite it mid-typing.
    values[id] = draftValue;
    if (agentTouched && incomingValue !== draftValue) {
      conflicts.push({ id, mine: draftValue, theirs: incomingValue });
    }
  }

  return { values, base: { ...incoming }, adopted, conflicts };
};

/** Take the agent's value for one conflicted field (the "use theirs" affordance). */
export const acceptIncomingField = (values: FormValues, id: string, theirs: string): FormValues => ({
  ...values,
  [id]: theirs,
});
