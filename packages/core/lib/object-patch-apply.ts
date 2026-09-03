/**
 * Patch apply + inverse engine (T0.6).
 *
 * Applies typed patch ops (src/schema/object-patch-ops.ts) to an
 * ObjectRecord, capturing a `{before, after}` snapshot per op into history,
 * and derives the compensating inverse op the human-review Discard action
 * applies (C§2.4). Mechanics only: per-type body validation, reference
 * integrity, and the other C§2.0 safety checks are the validation pipeline's
 * job (T0.7).
 *
 * Contract highlights:
 * - **Pure**: the input record is never mutated; a successful call returns a
 *   fresh record. A batch is atomic — any failing op rejects the whole call.
 * - **Envelope counters** (D§3.1): `version` bumps once per applied op;
 *   `content_revision` bumps only for ops that actually mutated `body` —
 *   a no-op write (same value, same index) bumps `version` but not
 *   `content_revision`.
 * - **History**: one entry per op — `{at, action: <op name>, actor,
 *   details: {op, capture}}`. `derivePatchInverse(op, capture)` reconstructs
 *   the inverse from exactly what history stores.
 * - **Blind-revert refusal** (C§2.4): ops may carry `guard.expected` — the
 *   unit snapshot the draft is expected to still hold (inverse derivation
 *   sets it to the forward op's captured `after`). A mismatch, including the
 *   unit having been removed, throws `blind_revert_refused`. Removal
 *   inverses additionally pin the container's post-removal identity order,
 *   so restoring at a saved index into a since-reordered list refuses
 *   rather than silently re-shuffling intervening edits.
 * - **Slug-rename auto-alias** (C§2.3-taxonomy): an `update_term` that
 *   changes `slug` atomically mints a deprecated alias term
 *   `{slug: <old slug>, merged_into: <this term>}` so old references keep
 *   resolving; renaming back to a slug the term previously owned consumes
 *   that alias instead of colliding with it. An alias-less rename is
 *   mechanically impossible: `mint_alias: false` is honored only when the
 *   application consumes such an alias or exactly restores the vacated
 *   slug's alias (`restore_alias`) — i.e. only when the rename is a revert.
 *   Revert consumption is itself guarded: the inverse records the alias it
 *   expects to consume (`consume_alias_expected`), and an alias edited,
 *   removed, or unexpectedly present since the forward op refuses as a
 *   blind revert rather than silently destroying the intervening change.
 *
 * The engine touches bodies through minimal structural contracts mirroring
 * D§3.2–3.8 (sections arrays, nav group/item trees, taxonomy term
 * registries, template slots). The T0.2 body schemas satisfy these shapes
 * structurally; the engine asserts the containers it needs at runtime and
 * throws `invalid_body` rather than corrupting unrecognized data.
 */
import { ZodError } from 'zod';
import {
  patchOpSchema,
  patchOpNamesByObjectType,
  PRIVILEGED_PATCH_OPS,
  type PatchJsonValue,
  type PatchOp,
  type PatchOpOfName,
  type PatchTaxonomyKind,
  type TermPayload,
} from '../schema/object-patch-ops.js';
import type { HistoryEntry, ObjectRecord, ObjectType, Principal } from '../schema/object-record-v1.js';
import {
  MediaTypeError,
  normalizeArticleNodeMedia,
  normalizeArticleNodeMediaFields,
} from './article-content/media-type.js';

// ——— errors ———

export type PatchApplyErrorCode =
  | 'invalid_op'
  | 'op_not_applicable'
  | 'invalid_body'
  | 'target_not_found'
  | 'duplicate_target'
  | 'blind_revert_refused'
  | 'alias_required'
  | 'alias_conflict';

export class PatchApplyError extends Error {
  readonly code: PatchApplyErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: PatchApplyErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'PatchApplyError';
    this.code = code;
    this.details = details;
  }
}

// ——— JSON helpers ———
// Bodies are JSON (Netlify Blobs records); `undefined`-valued keys are
// treated as absent everywhere so in-memory and serialized states agree.

type UnknownRecord = Record<string, unknown>;

const isPlainObject = (value: unknown): value is UnknownRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const deepCloneJson = <T>(value: T): T => {
  if (Array.isArray(value)) return value.map((entry) => deepCloneJson(entry)) as T;
  if (isPlainObject(value)) {
    const out: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry !== undefined) out[key] = deepCloneJson(entry);
    }
    return out as T;
  }
  return value;
};

export const deepEqualJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, i) => deepEqualJson(entry, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a).filter((key) => a[key] !== undefined);
    const keysB = Object.keys(b).filter((key) => b[key] !== undefined);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => deepEqualJson(a[key], b[key]));
  }
  return false;
};

const insertAt = <T>(list: T[], position: number | undefined, element: T): number => {
  const index = Math.min(position ?? list.length, list.length);
  list.splice(index, 0, element);
  return index;
};

const moveTo = <T>(list: T[], from: number, toIndex: number): number => {
  const [element] = list.splice(from, 1);
  const index = Math.min(toIndex, list.length);
  list.splice(index, 0, element as T);
  return index;
};

// ——— capture shapes (what history stores per op) ———

/**
 * Deep-partial tree mirroring a merge op's `fields`: leaves hold the value
 * at that path, with `null` encoding "key absent" (the grammar's null=unset
 * rule; body schemas have no null-valued fields, so this is unambiguous).
 */
export type FieldsTree = { [key: string]: PatchJsonValue };

export type ElementSnapshot =
  | { exists: false }
  | { exists: true; value: PatchJsonValue; index: number; parent_item_id?: string };

export interface MoveSnapshot {
  index: number;
  parent_item_id?: string;
}

export interface AliasCapture {
  /** Auto-alias appended for the vacated slug. */
  minted?: { term: TermPayload; index: number };
  /** Deprecated self-alias holding the new slug, removed to avoid a collision. */
  consumed?: { term: TermPayload; index: number };
  /** Alias re-inserted via `restore_alias` (inverse application). */
  restored?: { term: TermPayload; index: number };
}

export type PatchOpCapture =
  | { kind: 'fields'; before: FieldsTree; after: FieldsTree; alias?: AliasCapture }
  | {
      kind: 'element';
      before: ElementSnapshot;
      after: ElementSnapshot;
      /** The optional container (`children`/`actions`) was created by this op. */
      container_created?: boolean;
      /** The optional container was removed because the op emptied it (`prune_empty`). */
      container_pruned?: boolean;
      /**
       * Ordered identity list (ids/labels/slotIds/term_ids) of the container
       * AFTER a remove_* op. The removal inverse embeds it in its guard so a
       * restore into a since-reordered list refuses instead of silently
       * re-shuffling intervening order (C§2.4).
       */
      container_after?: string[];
    }
  | { kind: 'move'; before: MoveSnapshot; after: MoveSnapshot };

export interface AppliedPatchOp {
  op: PatchOp;
  capture: PatchOpCapture;
  body_mutated: boolean;
}

export interface ApplyPatchOptions {
  actor: Principal;
  /** ISO timestamp recorded on history entries and `updated_at`. */
  at: string;
  /**
   * Extra details merged into every history entry this batch writes (before
   * the reserved `op`/`capture` keys, which always win). Used by verbs that
   * compose patch ops on the caller's behalf to record provenance — e.g.
   * instantiate_section stamps `instantiated_from: stpl_*` (W8.2).
   */
  entryDetails?: Record<string, unknown>;
  /**
   * Ops to accept beyond the object type's agent-facing allowlist — the
   * privileged, non-submittable ops (PRIVILEGED_PATCH_OPS). ONLY the verb that
   * constructs them (site_apply_theme → set_site_brand_tokens) and the Discard
   * path (re-applying an already-authorized inverse) pass them; a plain
   * object_patch passes none, so a hand-authored privileged op is rejected
   * op_not_applicable. Defaults to none.
   */
  privilegedOps?: readonly string[];
}

export interface ApplyPatchResult {
  record: ObjectRecord<unknown>;
  applied: AppliedPatchOp[];
  body_mutated: boolean;
}

const captureMutatedBody = (capture: PatchOpCapture): boolean => {
  if (capture.kind === 'fields') {
    if (capture.alias && (capture.alias.minted || capture.alias.consumed || capture.alias.restored)) return true;
    return !deepEqualJson(capture.before, capture.after);
  }
  if (capture.kind === 'element')
    return !deepEqualJson(capture.before, capture.after) || capture.container_pruned === true;
  return capture.before.index !== capture.after.index;
};

// ——— guard checking (the C§2.4 blind-revert rule) ———

const checkGuard = (op: PatchOp, actual: unknown): void => {
  if (op.guard === undefined) return;
  if (!deepEqualJson(op.guard.expected, actual)) {
    throw new PatchApplyError(
      'blind_revert_refused',
      `Refusing ${op.op}: the draft no longer matches the state this op expects (C§2.4 blind-revert rule); resolve manually.`,
      { expected: op.guard.expected, actual }
    );
  }
};

/**
 * A guarded op whose target unit is gone is a stale revert, not a lookup
 * mistake — surface it as blind-revert refusal. Without a guard it is an
 * ordinary bad address.
 */
const targetMissing = (op: PatchOp, what: string): PatchApplyError => {
  if (op.guard !== undefined) {
    return new PatchApplyError(
      'blind_revert_refused',
      `Refusing ${op.op}: ${what} no longer exists in the draft (C§2.4 blind-revert rule); resolve manually.`,
      { expected: op.guard.expected, actual: { missing: true } }
    );
  }
  return new PatchApplyError('target_not_found', `${op.op}: ${what} not found.`);
};

// ——— fields merge (shared by every *_meta / update_* / set_*_fields op) ———
//
// Plain-object values merge recursively (only when the current value is also
// a plain object); arrays and scalars replace wholesale; null deletes the
// key. Returns before/after trees mirroring the fields shape.

/**
 * Normalize an object subtree being written wholesale into a body: null
 * object keys mean "unset" at every depth (the grammar rule), so they are
 * omitted rather than stored — bodies never contain null. Null array
 * elements have no unset meaning and are rejected.
 */
const stripNullUnsetsDeep = (value: PatchJsonValue): PatchJsonValue => {
  if (Array.isArray(value)) {
    return value.map((element) => {
      if (element === null) {
        throw new PatchApplyError(
          'invalid_op',
          'null array elements are not allowed; null is only meaningful as an object-key unset marker.'
        );
      }
      return stripNullUnsetsDeep(element);
    });
  }
  if (isPlainObject(value)) {
    const out: UnknownRecord = {};
    for (const [key, entry] of Object.entries(value)) {
      if (entry === null || entry === undefined) continue;
      out[key] = stripNullUnsetsDeep(entry as PatchJsonValue);
    }
    return out as PatchJsonValue;
  }
  return value;
};

/**
 * Element payloads (upsert_* bodies) replace wholesale, so null has no unset
 * meaning there — reject it rather than writing null into a body.
 */
const assertNoNullValues = (value: unknown, what: string): void => {
  if (value === null) {
    throw new PatchApplyError(
      'invalid_op',
      `${what} must not contain null values; null is reserved as the fields unset marker.`
    );
  }
  if (Array.isArray(value)) {
    for (const element of value) assertNoNullValues(element, what);
    return;
  }
  if (isPlainObject(value)) {
    for (const entry of Object.values(value)) {
      if (entry !== undefined) assertNoNullValues(entry, what);
    }
  }
};

const snapshotFields = (target: UnknownRecord | undefined, fields: UnknownRecord): FieldsTree => {
  const snapshot: FieldsTree = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const current = target?.[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      snapshot[key] = snapshotFields(current, value);
      continue;
    }
    snapshot[key] = current === undefined ? null : (deepCloneJson(current) as PatchJsonValue);
  }
  return snapshot;
};

const mergeFields = (target: UnknownRecord, fields: UnknownRecord): { before: FieldsTree; after: FieldsTree } => {
  const before: FieldsTree = {};
  const after: FieldsTree = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    const current = target[key];
    if (isPlainObject(value) && isPlainObject(current)) {
      const nested = mergeFields(current, value);
      before[key] = nested.before;
      after[key] = nested.after;
      continue;
    }
    before[key] = current === undefined ? null : (deepCloneJson(current) as PatchJsonValue);
    if (value === null) {
      delete target[key];
      after[key] = null;
    } else {
      // A subtree replacing a non-object target still honors the null=unset
      // rule at every depth: null keys are omitted, never stored.
      const normalized = stripNullUnsetsDeep(deepCloneJson(value) as PatchJsonValue);
      target[key] = normalized;
      after[key] = deepCloneJson(normalized);
    }
  }
  return { before, after };
};

const applyFieldsOp = (op: PatchOp, unit: UnknownRecord, fields: UnknownRecord): PatchOpCapture => {
  checkGuard(op, snapshotFields(unit, fields));
  const { before, after } = mergeFields(unit, fields);
  return { kind: 'fields', before, after };
};

// ——— structural body contracts (mirroring D§3.2–3.8; deep shapes are T0.2/T0.7's) ———

interface SectionLike extends UnknownRecord {
  id: string;
}
interface NavItemLike extends UnknownRecord {
  id: string;
  children?: NavItemLike[];
}
interface NavGroupLike extends UnknownRecord {
  id: string;
  items: NavItemLike[];
}
interface LinkActionLike extends UnknownRecord {
  label: string;
}
interface TermLike extends UnknownRecord {
  term_id: string;
  slug: string;
  label: string;
  status: 'active' | 'deprecated';
  merged_into?: string;
}
interface TemplateSlotLike extends UnknownRecord {
  slotId: string;
}
interface ArticleNodeLike extends UnknownRecord {
  id: string;
}

/**
 * A media object whose type cannot be inferred from its src, or whose explicit
 * type contradicts the src, refuses the WHOLE op as an unprocessable body —
 * never silently defaulted to 'image' (the broken-<img>-for-a-PDF defect).
 */
const withMediaTypeRefusal = (run: () => void): void => {
  try {
    run();
  } catch (error) {
    if (error instanceof MediaTypeError) {
      throw new PatchApplyError('invalid_body', error.message, { path: error.path, reason: error.reason });
    }
    throw error;
  }
};

const expectPlainObject = (value: unknown, what: string): UnknownRecord => {
  if (!isPlainObject(value)) {
    throw new PatchApplyError('invalid_body', `Expected ${what} to be an object.`);
  }
  return value;
};

const expectArray = <T>(value: unknown, what: string): T[] => {
  if (!Array.isArray(value)) {
    throw new PatchApplyError('invalid_body', `Expected ${what} to be an array.`);
  }
  return value as T[];
};

const getSections = (body: UnknownRecord): SectionLike[] => expectArray<SectionLike>(body.sections, 'body.sections');
const getGroups = (body: UnknownRecord): NavGroupLike[] => expectArray<NavGroupLike>(body.groups, 'body.groups');
const getSlots = (body: UnknownRecord): TemplateSlotLike[] => expectArray<TemplateSlotLike>(body.slots, 'body.slots');
const getNodes = (body: UnknownRecord): ArticleNodeLike[] => expectArray<ArticleNodeLike>(body.nodes, 'body.nodes');
const getTerms = (body: UnknownRecord, kind: PatchTaxonomyKind): TermLike[] => {
  const kinds = expectPlainObject(body.kinds, 'body.kinds');
  const registry = expectPlainObject(kinds[kind], `body.kinds.${kind}`);
  return expectArray<TermLike>(registry.terms, `body.kinds.${kind}.terms`);
};

const elementSnapshot = (value: unknown, index: number, parentItemId?: string): ElementSnapshot => ({
  exists: true,
  value: deepCloneJson(value) as PatchJsonValue,
  index,
  ...(parentItemId !== undefined ? { parent_item_id: parentItemId } : {}),
});

const ABSENT: ElementSnapshot = { exists: false };

/**
 * Actual state for an insert-path guard check. When the guard's expectation
 * carries a `container` order (set by removal-inverse derivation), the
 * actual includes the container's current identity order so a restore into
 * a since-reordered list refuses; plain `{exists: false}` guards keep
 * element-only semantics.
 */
const absentGuardActual = (op: PatchOp, containerIds: () => string[]): unknown => {
  const expected = op.guard?.expected;
  if (isPlainObject(expected) && expected.exists === false && 'container' in expected) {
    return { exists: false, container: containerIds() };
  }
  return ABSENT;
};

// ——— nav item tree addressing (depth ≤ 2 in practice, D§3.8) ———

interface ItemLocation {
  list: NavItemLike[];
  owner?: NavItemLike;
  index: number;
}

const findItemLocation = (list: NavItemLike[], itemId: string, owner?: NavItemLike): ItemLocation | undefined => {
  for (let index = 0; index < list.length; index++) {
    const item = list[index];
    if (item.id === itemId) return { list, owner, index };
    if (Array.isArray(item.children)) {
      const found = findItemLocation(item.children, itemId, item);
      if (found) return found;
    }
  }
  return undefined;
};

// ——— section addressing: a 'page' owns a sections array; a shared 'section'
//     object wraps exactly one instance (C§2.3-section) ———

interface SectionLocation {
  kind: 'list' | 'wrapper';
  section: SectionLike;
  index: number;
}

const findSection = (objectType: ObjectType, body: UnknownRecord, sectionId: string): SectionLocation | undefined => {
  if (objectType === 'section') {
    const section = expectPlainObject(body.section, 'body.section') as SectionLike;
    return section.id === sectionId ? { kind: 'wrapper', section, index: 0 } : undefined;
  }
  const sections = getSections(body);
  const index = sections.findIndex((section) => section.id === sectionId);
  return index === -1 ? undefined : { kind: 'list', section: sections[index], index };
};

// ——— taxonomy alias helpers (C§2.3-taxonomy) ———

const mintAliasTermId = (terms: TermLike[], oldSlug: string): string => {
  const base = oldSlug.toLowerCase().replace(/[^a-z0-9]/g, '') || 'alias';
  let candidate = `t_${base}`;
  let suffix = 2;
  while (terms.some((term) => term.term_id === candidate)) {
    candidate = `t_${base}${suffix}`;
    suffix += 1;
  }
  return candidate;
};

// ——— per-op application ———

type ElementCapture = Extract<PatchOpCapture, { kind: 'element' }>;

const applyUpsertIntoList = <T extends UnknownRecord>(
  op: PatchOp,
  list: T[],
  matchIndex: number,
  payload: T,
  position: number | undefined,
  idOf: (element: T) => string
): ElementCapture => {
  if (matchIndex !== -1) {
    const before = elementSnapshot(list[matchIndex], matchIndex);
    checkGuard(op, before);
    list[matchIndex] = deepCloneJson(payload);
    return { kind: 'element', before, after: elementSnapshot(list[matchIndex], matchIndex) };
  }
  checkGuard(
    op,
    absentGuardActual(op, () => list.map(idOf))
  );
  const index = insertAt(list, position, deepCloneJson(payload));
  return { kind: 'element', before: ABSENT, after: elementSnapshot(list[index], index) };
};

const applyRemoveFromList = <T extends UnknownRecord>(
  op: PatchOp,
  list: T[],
  matchIndex: number,
  idOf: (element: T) => string
): ElementCapture => {
  const before = elementSnapshot(list[matchIndex], matchIndex);
  checkGuard(op, before);
  list.splice(matchIndex, 1);
  return { kind: 'element', before, after: ABSENT, container_after: list.map(idOf) };
};

const applyMoveInList = <T extends UnknownRecord>(
  op: PatchOp,
  list: T[],
  matchIndex: number,
  toIndex: number,
  parentItemId?: string
): PatchOpCapture => {
  const before: MoveSnapshot = {
    index: matchIndex,
    ...(parentItemId !== undefined ? { parent_item_id: parentItemId } : {}),
  };
  checkGuard(op, before);
  const finalIndex = moveTo(list, matchIndex, toIndex);
  const after: MoveSnapshot = {
    index: finalIndex,
    ...(parentItemId !== undefined ? { parent_item_id: parentItemId } : {}),
  };
  return { kind: 'move', before, after };
};

const applyUpdateTerm = (op: PatchOpOfName<'update_term'>, body: UnknownRecord): PatchOpCapture => {
  const terms = getTerms(body, op.kind);
  const termIndex = terms.findIndex((term) => term.term_id === op.term_id);
  if (termIndex === -1) throw targetMissing(op, `term '${op.term_id}' in kind '${op.kind}'`);
  const term = terms[termIndex];

  const fields = op.fields as UnknownRecord;
  checkGuard(op, snapshotFields(term, fields));

  const oldSlug = term.slug;
  const oldLabel = term.label;
  const { before, after } = mergeFields(term, fields);
  const newSlug = term.slug;
  const slugChanged = op.fields.slug !== undefined && newSlug !== oldSlug;

  if (!slugChanged) {
    if (
      op.mint_alias !== undefined ||
      op.alias_term_id !== undefined ||
      op.restore_alias !== undefined ||
      op.consume_alias_expected !== undefined
    ) {
      throw new PatchApplyError(
        'invalid_op',
        `update_term: alias controls were provided but the slug did not change (current slug '${oldSlug}').`
      );
    }
    return { kind: 'fields', before, after };
  }

  const alias: AliasCapture = {};

  // A deprecated self-alias already holding the new slug proves this rename
  // reverts an earlier one; consume it so the term and its alias never claim
  // the same slug (C§2.3-taxonomy).
  const consumeIndex = terms.findIndex(
    (candidate) =>
      candidate !== term &&
      candidate.slug === newSlug &&
      candidate.status === 'deprecated' &&
      candidate.merged_into === term.term_id
  );

  if (op.mint_alias === false) {
    // Revert path (engine-gated). The alias about to be consumed is part of
    // the unit the forward op touched, so consumption must be exact: an
    // alias edited, removed, or unexpectedly present since the forward op
    // makes this a blind revert (C§2.4).
    const expected = op.consume_alias_expected;
    if (expected !== undefined) {
      if (consumeIndex === -1) {
        throw new PatchApplyError(
          'blind_revert_refused',
          `Refusing update_term: the alias '${expected.term_id}' (slug '${expected.slug}') this revert expects to consume is no longer present as recorded; resolve manually.`,
          { expected }
        );
      }
      if (!deepEqualJson(terms[consumeIndex], expected)) {
        throw new PatchApplyError(
          'blind_revert_refused',
          `Refusing update_term: alias '${expected.term_id}' was edited after the rename this revert undoes; resolve manually.`,
          { expected, actual: deepCloneJson(terms[consumeIndex]) }
        );
      }
    } else if (consumeIndex !== -1) {
      throw new PatchApplyError(
        'blind_revert_refused',
        `Refusing update_term: an alias holding slug '${newSlug}' exists but this revert recorded none; resolve manually.`,
        { actual: deepCloneJson(terms[consumeIndex]) }
      );
    }
    const restoresVacatedSlug =
      op.restore_alias !== undefined &&
      op.restore_alias.term.slug === oldSlug &&
      op.restore_alias.term.status === 'deprecated' &&
      op.restore_alias.term.merged_into === op.term_id;
    if (expected === undefined && !restoresVacatedSlug) {
      throw new PatchApplyError(
        'alias_required',
        `update_term: renaming '${oldSlug}' → '${newSlug}' without the auto-alias is only allowed when the rename reverts a prior rename (C§2.3-taxonomy).`
      );
    }
    if (consumeIndex !== -1) {
      alias.consumed = { term: deepCloneJson(terms[consumeIndex]) as TermPayload, index: consumeIndex };
      terms.splice(consumeIndex, 1);
    }
  } else {
    // Organic path: a forward edit under review may consume its own prior
    // alias without an expectation — the reviewer sees the diff.
    if (consumeIndex !== -1) {
      alias.consumed = { term: deepCloneJson(terms[consumeIndex]) as TermPayload, index: consumeIndex };
      terms.splice(consumeIndex, 1);
    }
    const aliasTermId = op.alias_term_id ?? mintAliasTermId(terms, oldSlug);
    if (terms.some((candidate) => candidate.term_id === aliasTermId)) {
      throw new PatchApplyError(
        'alias_conflict',
        `update_term: alias term id '${aliasTermId}' already exists in kind '${op.kind}'.`
      );
    }
    const aliasTerm: TermLike = {
      term_id: aliasTermId,
      slug: oldSlug,
      label: oldLabel,
      status: 'deprecated',
      merged_into: term.term_id,
    };
    terms.push(aliasTerm);
    alias.minted = { term: deepCloneJson(aliasTerm) as TermPayload, index: terms.length - 1 };
  }

  if (op.restore_alias !== undefined) {
    if (terms.some((candidate) => candidate.term_id === op.restore_alias!.term.term_id)) {
      throw new PatchApplyError(
        'alias_conflict',
        `update_term: restore_alias term id '${op.restore_alias.term.term_id}' already exists in kind '${op.kind}'.`
      );
    }
    const restored = deepCloneJson(op.restore_alias.term) as TermLike;
    const index = insertAt(terms, op.restore_alias.position, restored);
    alias.restored = { term: deepCloneJson(restored) as TermPayload, index };
  }

  return { kind: 'fields', before, after, alias };
};

const termStatusSnapshot = (term: TermLike): FieldsTree => ({
  status: term.status,
  merged_into: term.merged_into === undefined ? null : (deepCloneJson(term.merged_into) as PatchJsonValue),
});

const applyOp = (objectType: ObjectType, body: UnknownRecord, op: PatchOp): PatchOpCapture => {
  switch (op.op) {
    // ——— page / shared-section family ———
    case 'set_page_meta':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    case 'upsert_section': {
      assertNoNullValues(op.section, 'upsert_section payload');
      if (objectType === 'section') {
        // The wrapper holds exactly one section; upsert replaces it.
        const current = expectPlainObject(body.section, 'body.section');
        const before = elementSnapshot(current, 0);
        checkGuard(op, before);
        body.section = deepCloneJson(op.section);
        return { kind: 'element', before, after: elementSnapshot(body.section, 0) };
      }
      const sections = getSections(body);
      const index = sections.findIndex((section) => section.id === op.section.id);
      return applyUpsertIntoList(op, sections, index, op.section as SectionLike, op.position, (section) => section.id);
    }

    case 'update_section_data': {
      const located = findSection(objectType, body, op.section_id);
      if (!located) throw targetMissing(op, `section '${op.section_id}'`);
      const data = expectPlainObject(located.section.data, `section '${op.section_id}' data`);
      return applyFieldsOp(op, data, op.fields as UnknownRecord);
    }

    case 'move_section': {
      const sections = getSections(body);
      const index = sections.findIndex((section) => section.id === op.section_id);
      if (index === -1) throw targetMissing(op, `section '${op.section_id}'`);
      return applyMoveInList(op, sections, index, op.to_index);
    }

    case 'set_section_visibility': {
      const located = findSection(objectType, body, op.section_id);
      if (!located) throw targetMissing(op, `section '${op.section_id}'`);
      const snapshot: FieldsTree = {
        visibility: located.section.visibility === undefined ? null : (located.section.visibility as PatchJsonValue),
      };
      checkGuard(op, snapshot);
      if (op.visibility === null) delete located.section.visibility;
      else located.section.visibility = op.visibility;
      return { kind: 'fields', before: snapshot, after: { visibility: op.visibility } };
    }

    case 'remove_section': {
      const sections = getSections(body);
      const index = sections.findIndex((section) => section.id === op.section_id);
      if (index === -1) throw targetMissing(op, `section '${op.section_id}'`);
      return applyRemoveFromList(op, sections, index, (section) => section.id);
    }

    // ——— content-item / article node family (W7.3) ———
    // Mirrors the section family: an article body owns an ordered `nodes`
    // list keyed by opaque n_* ids (08-articles-plan §2.2).
    case 'set_article_meta':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    case 'upsert_node': {
      assertNoNullValues(op.node, 'upsert_node payload');
      const nodes = getNodes(body);
      const index = nodes.findIndex((node) => node.id === op.node.id);
      // Media type discipline (media-type.ts): the payload's public.media /
      // images[] get their `type` inferred from the src when absent, and an
      // explicit type must agree with the src — normalized BEFORE the element
      // capture so history (and the derived inverse) carry the resolved node.
      const payload = deepCloneJson(op.node) as ArticleNodeLike;
      withMediaTypeRefusal(() => normalizeArticleNodeMedia(payload, 'upsert_node node'));
      return applyUpsertIntoList(op, nodes, index, payload, op.position, (node) => node.id);
    }

    case 'update_node': {
      const nodes = getNodes(body);
      const node = nodes.find((candidate) => candidate.id === op.node_id);
      if (!node) throw targetMissing(op, `node '${op.node_id}'`);
      // Same discipline against the node the fields merge INTO: a src change
      // without a type re-derives it (a stale 'image' must not survive a PDF
      // landing here); an explicit type is checked against the effective src.
      const fields = deepCloneJson(op.fields) as UnknownRecord;
      withMediaTypeRefusal(() => normalizeArticleNodeMediaFields(node, fields, 'update_node fields'));
      return applyFieldsOp(op, node, fields);
    }

    case 'move_node': {
      const nodes = getNodes(body);
      const index = nodes.findIndex((node) => node.id === op.node_id);
      if (index === -1) throw targetMissing(op, `node '${op.node_id}'`);
      return applyMoveInList(op, nodes, index, op.to_index);
    }

    case 'set_node_visibility': {
      const nodes = getNodes(body);
      const node = nodes.find((candidate) => candidate.id === op.node_id);
      if (!node) throw targetMissing(op, `node '${op.node_id}'`);
      const snapshot: FieldsTree = {
        visibility: node.visibility === undefined ? null : (node.visibility as PatchJsonValue),
      };
      checkGuard(op, snapshot);
      if (op.visibility === null) delete node.visibility;
      else node.visibility = op.visibility;
      return { kind: 'fields', before: snapshot, after: { visibility: op.visibility } };
    }

    case 'remove_node': {
      const nodes = getNodes(body);
      const index = nodes.findIndex((node) => node.id === op.node_id);
      if (index === -1) throw targetMissing(op, `node '${op.node_id}'`);
      return applyRemoveFromList(op, nodes, index, (node) => node.id);
    }

    // ——— navigation family ———
    case 'set_nav_meta':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    case 'upsert_group': {
      assertNoNullValues(op.group, 'upsert_group payload');
      const groups = getGroups(body);
      const index = groups.findIndex((group) => group.id === op.group.id);
      return applyUpsertIntoList(op, groups, index, op.group as NavGroupLike, op.position, (group) => group.id);
    }

    case 'move_group': {
      const groups = getGroups(body);
      const index = groups.findIndex((group) => group.id === op.group_id);
      if (index === -1) throw targetMissing(op, `group '${op.group_id}'`);
      return applyMoveInList(op, groups, index, op.to_index);
    }

    case 'remove_group': {
      const groups = getGroups(body);
      const index = groups.findIndex((group) => group.id === op.group_id);
      if (index === -1) throw targetMissing(op, `group '${op.group_id}'`);
      return applyRemoveFromList(op, groups, index, (group) => group.id);
    }

    case 'upsert_item': {
      assertNoNullValues(op.item, 'upsert_item payload');
      const groups = getGroups(body);
      const group = groups.find((candidate) => candidate.id === op.group_id);
      if (!group) throw targetMissing(op, `group '${op.group_id}'`);
      const items = expectArray<NavItemLike>(group.items, `group '${op.group_id}' items`);
      const existing = findItemLocation(items, op.item.id);
      if (existing) {
        // Replace in place, wherever the item lives; position/parent_item_id
        // apply to inserts only.
        const before = elementSnapshot(existing.list[existing.index], existing.index, existing.owner?.id);
        checkGuard(op, before);
        existing.list[existing.index] = deepCloneJson(op.item) as NavItemLike;
        return {
          kind: 'element',
          before,
          after: elementSnapshot(existing.list[existing.index], existing.index, existing.owner?.id),
        };
      }
      if (op.parent_item_id !== undefined) {
        const parentLocation = findItemLocation(items, op.parent_item_id);
        if (!parentLocation) throw targetMissing(op, `parent item '${op.parent_item_id}' in group '${op.group_id}'`);
        const parent = parentLocation.list[parentLocation.index];
        checkGuard(
          op,
          absentGuardActual(op, () => (Array.isArray(parent.children) ? parent.children : []).map((item) => item.id))
        );
        const containerCreated = !Array.isArray(parent.children);
        if (containerCreated) parent.children = [];
        const index = insertAt(parent.children as NavItemLike[], op.position, deepCloneJson(op.item) as NavItemLike);
        return {
          kind: 'element',
          before: ABSENT,
          after: elementSnapshot((parent.children as NavItemLike[])[index], index, parent.id),
          ...(containerCreated ? { container_created: true } : {}),
        };
      }
      checkGuard(
        op,
        absentGuardActual(op, () => items.map((item) => item.id))
      );
      const index = insertAt(items, op.position, deepCloneJson(op.item) as NavItemLike);
      return { kind: 'element', before: ABSENT, after: elementSnapshot(items[index], index) };
    }

    case 'update_item': {
      const groups = getGroups(body);
      const group = groups.find((candidate) => candidate.id === op.group_id);
      if (!group) throw targetMissing(op, `group '${op.group_id}'`);
      const located = findItemLocation(
        expectArray<NavItemLike>(group.items, `group '${op.group_id}' items`),
        op.item_id
      );
      if (!located) throw targetMissing(op, `item '${op.item_id}' in group '${op.group_id}'`);
      return applyFieldsOp(op, located.list[located.index], op.fields as UnknownRecord);
    }

    case 'move_item': {
      const groups = getGroups(body);
      const group = groups.find((candidate) => candidate.id === op.group_id);
      if (!group) throw targetMissing(op, `group '${op.group_id}'`);
      const located = findItemLocation(
        expectArray<NavItemLike>(group.items, `group '${op.group_id}' items`),
        op.item_id
      );
      if (!located) throw targetMissing(op, `item '${op.item_id}' in group '${op.group_id}'`);
      return applyMoveInList(op, located.list, located.index, op.to_index, located.owner?.id);
    }

    case 'remove_item': {
      const groups = getGroups(body);
      const group = groups.find((candidate) => candidate.id === op.group_id);
      if (!group) throw targetMissing(op, `group '${op.group_id}'`);
      const located = findItemLocation(
        expectArray<NavItemLike>(group.items, `group '${op.group_id}' items`),
        op.item_id
      );
      if (!located) throw targetMissing(op, `item '${op.item_id}' in group '${op.group_id}'`);
      const before = elementSnapshot(located.list[located.index], located.index, located.owner?.id);
      checkGuard(op, before);
      located.list.splice(located.index, 1);
      let containerPruned = false;
      if (op.prune_empty === true && located.owner !== undefined && located.list.length === 0) {
        // `children` is optional (D§3.8); pruning restores its absence.
        // Top-level `items` is required and is never pruned.
        delete located.owner.children;
        containerPruned = true;
      }
      return {
        kind: 'element',
        before,
        after: ABSENT,
        ...(containerPruned ? { container_pruned: true } : {}),
        container_after: located.list.map((item) => item.id),
      };
    }

    case 'upsert_action': {
      assertNoNullValues(op.action, 'upsert_action payload');
      const actions =
        body.actions === undefined ? undefined : expectArray<LinkActionLike>(body.actions, 'body.actions');
      const index = actions === undefined ? -1 : actions.findIndex((action) => action.label === op.action.label);
      if (actions !== undefined && index !== -1) {
        return applyUpsertIntoList(
          op,
          actions,
          index,
          op.action as LinkActionLike,
          op.position,
          (action) => action.label
        );
      }
      checkGuard(
        op,
        absentGuardActual(op, () => (actions ?? []).map((action) => action.label))
      );
      const containerCreated = actions === undefined;
      const list = actions ?? [];
      if (containerCreated) body.actions = list;
      const insertedAt = insertAt(list, op.position, deepCloneJson(op.action) as LinkActionLike);
      return {
        kind: 'element',
        before: ABSENT,
        after: elementSnapshot(list[insertedAt], insertedAt),
        ...(containerCreated ? { container_created: true } : {}),
      };
    }

    case 'remove_action': {
      const actions =
        body.actions === undefined ? undefined : expectArray<LinkActionLike>(body.actions, 'body.actions');
      const index = actions === undefined ? -1 : actions.findIndex((action) => action.label === op.label);
      if (actions === undefined || index === -1) throw targetMissing(op, `action '${op.label}'`);
      const capture = applyRemoveFromList(op, actions, index, (action) => action.label);
      if (op.prune_empty === true && actions.length === 0) {
        // `actions` is optional on the navigation body (D§3.8).
        delete body.actions;
        return { ...capture, container_pruned: true };
      }
      return capture;
    }

    // ——— taxonomy family ———
    case 'add_term': {
      const terms = getTerms(body, op.kind);
      const index = terms.findIndex((term) => term.term_id === op.term.term_id);
      const snapshot =
        index === -1
          ? absentGuardActual(op, () => terms.map((term) => term.term_id))
          : elementSnapshot(terms[index], index);
      checkGuard(op, snapshot);
      if (index !== -1) {
        throw new PatchApplyError(
          'duplicate_target',
          `add_term: term '${op.term.term_id}' already exists in kind '${op.kind}'.`
        );
      }
      const term: TermLike = { ...(deepCloneJson(op.term) as TermPayload), status: op.term.status ?? 'active' };
      const insertedAt = insertAt(terms, op.position, term);
      return { kind: 'element', before: ABSENT, after: elementSnapshot(terms[insertedAt], insertedAt) };
    }

    case 'update_term':
      return applyUpdateTerm(op, body);

    case 'deprecate_term': {
      const terms = getTerms(body, op.kind);
      const term = terms.find((candidate) => candidate.term_id === op.term_id);
      if (!term) throw targetMissing(op, `term '${op.term_id}' in kind '${op.kind}'`);
      const before = termStatusSnapshot(term);
      checkGuard(op, before);
      term.status = 'deprecated';
      if (op.merged_into === undefined) delete term.merged_into;
      else term.merged_into = op.merged_into;
      return { kind: 'fields', before, after: termStatusSnapshot(term) };
    }

    case 'reactivate_term': {
      const terms = getTerms(body, op.kind);
      const term = terms.find((candidate) => candidate.term_id === op.term_id);
      if (!term) throw targetMissing(op, `term '${op.term_id}' in kind '${op.kind}'`);
      const before = termStatusSnapshot(term);
      checkGuard(op, before);
      term.status = 'active';
      delete term.merged_into;
      return { kind: 'fields', before, after: termStatusSnapshot(term) };
    }

    case 'remove_term': {
      const terms = getTerms(body, op.kind);
      const index = terms.findIndex((term) => term.term_id === op.term_id);
      if (index === -1) throw targetMissing(op, `term '${op.term_id}' in kind '${op.kind}'`);
      return applyRemoveFromList(op, terms, index, (term) => term.term_id);
    }

    // ——— site family ———
    case 'set_site_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // The palette writer (theme-only governance): same deep-merge mechanics as
    // set_site_fields, but the grammar restricts `fields` to `brandTokens`, so
    // only site_apply_theme (and inverse derivation) ever produces it.
    case 'set_site_brand_tokens':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // The visual-identity writer (W16 C1, theme-only-style governance): same
    // deep-merge mechanics; the grammar restricts `fields` to `brandImagery`.
    case 'set_site_brand_imagery':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // ——— product family ———
    // Same deep-merge mechanics as set_site_fields; the grammar already
    // refuses commerce.price / commerce.stripe / commerce.stripe_test
    // payloads (the §3 canonicality funnel), so no engine-side key checks.
    case 'set_product_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // The funnel's writer (§3): fields restricted BY THE GRAMMAR to the
    // price cache + linkage blocks; mechanically the same deep merge.
    case 'set_product_price':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // ——— template family ———
    case 'set_template_meta':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    case 'upsert_slot': {
      assertNoNullValues(op.slot, 'upsert_slot payload');
      const slots = getSlots(body);
      const index = slots.findIndex((slot) => slot.slotId === op.slot.slotId);
      return applyUpsertIntoList(op, slots, index, op.slot as TemplateSlotLike, op.position, (slot) => slot.slotId);
    }

    case 'move_slot': {
      const slots = getSlots(body);
      const index = slots.findIndex((slot) => slot.slotId === op.slot_id);
      if (index === -1) throw targetMissing(op, `slot '${op.slot_id}'`);
      return applyMoveInList(op, slots, index, op.to_index);
    }

    case 'remove_slot': {
      const slots = getSlots(body);
      const index = slots.findIndex((slot) => slot.slotId === op.slot_id);
      if (index === -1) throw targetMissing(op, `slot '${op.slot_id}'`);
      return applyRemoveFromList(op, slots, index, (slot) => slot.slotId);
    }

    // ——— theme family (W8.3) ———
    case 'set_theme_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // W13 (12-plan §3): the tracker-registry singleton — the set_site_fields
    // idiom, open deep-merge over the whole body.
    case 'set_tracking_config_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // D1 (2026-07-28): the editorial-voice singleton — same open deep-merge
    // idiom. `frameworks[]` is an array, so it replaces wholesale (no stale-key
    // trap), which is exactly the semantics a declared set wants.
    case 'set_voice_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // Brand-imagery wave (BRIEF.md §3.1): the visual-standard singleton/
    // template family — same open deep-merge idiom as set_voice_fields.
    case 'set_visual_standard_fields':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    // ——— tracking (W13, 12-plan §2) ———
    // The uniform writer of the shared `tracking` block on all ten types.
    // Captures are WHOLE-BLOCK ({tracking: <tree|null>} on both sides, null =
    // absent) so removal, first-set, and merge all invert exactly — the
    // inverse derivation computes the precise merge tree (or fields: null)
    // from the two snapshots. Guards are whole-block shaped for the same
    // reason: the unit this op touches is the block, not individual keys.
    case 'set_tracking': {
      const snapshot = (): FieldsTree => ({
        tracking: body.tracking === undefined ? null : (deepCloneJson(body.tracking) as PatchJsonValue),
      });
      const before = snapshot();
      checkGuard(op, before);
      if (op.fields === null) {
        delete body.tracking;
      } else {
        if (body.tracking === undefined) body.tracking = {};
        const unit = expectPlainObject(body.tracking, 'body.tracking');
        mergeFields(unit, op.fields as UnknownRecord);
      }
      return { kind: 'fields', before, after: snapshot() };
    }

    // ——— section-template family (W8) ———
    // The body wraps exactly ONE blueprint (a SectionInstance), so the family
    // mirrors the shared-section wrapper: fields on the envelope, whole-unit
    // replacement, and fields on the blueprint's data.
    case 'set_section_template_meta':
      return applyFieldsOp(op, body, op.fields as UnknownRecord);

    case 'replace_blueprint': {
      assertNoNullValues(op.blueprint, 'replace_blueprint payload');
      const current = expectPlainObject(body.blueprint, 'body.blueprint');
      const before = elementSnapshot(current, 0);
      checkGuard(op, before);
      body.blueprint = deepCloneJson(op.blueprint);
      return { kind: 'element', before, after: elementSnapshot(body.blueprint, 0) };
    }

    case 'update_blueprint_data': {
      const blueprint = expectPlainObject(body.blueprint, 'body.blueprint');
      const data = expectPlainObject(blueprint.data, 'blueprint data');
      return applyFieldsOp(op, data, op.fields as UnknownRecord);
    }
  }
};

// ——— the public apply entry point ———

export const applyPatchOps = (
  record: ObjectRecord<unknown>,
  ops: readonly unknown[],
  options: ApplyPatchOptions
): ApplyPatchResult => {
  // Parse and family-check everything first so a malformed batch fails
  // before any work happens (the batch is atomic either way — mutations
  // happen on a clone).
  const parsedOps: PatchOp[] = ops.map((rawOp, index) => {
    let parsed: PatchOp;
    try {
      parsed = patchOpSchema.parse(rawOp);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new PatchApplyError(
          'invalid_op',
          `ops[${index}] is not a valid patch op: ${error.issues[0]?.message ?? 'invalid'}`,
          {
            issues: error.issues,
          }
        );
      }
      throw error;
    }
    const allowed = patchOpNamesByObjectType[record.object_type] as readonly string[];
    const privileged = options.privilegedOps ?? [];
    if (!allowed.includes(parsed.op) && !privileged.includes(parsed.op)) {
      throw new PatchApplyError(
        'op_not_applicable',
        record.object_type === 'content_item'
          ? `ops[${index}]: content_item is served by the existing article tool surface (C§2.0); generic patch ops do not apply.`
          : parsed.op === 'set_site_brand_tokens'
            ? `ops[${index}]: op '${parsed.op}' is tool-authored (not hand-authorable) — the palette changes only through site_apply_theme.`
            : PRIVILEGED_PATCH_OPS.includes(parsed.op as never)
              ? `ops[${index}]: op '${parsed.op}' is tool-authored (not hand-authorable).`
              : `ops[${index}]: op '${parsed.op}' does not apply to object_type '${record.object_type}'.`
      );
    }
    return parsed;
  });

  if (parsedOps.length === 0) {
    return { record: { ...record, history: [...record.history] }, applied: [], body_mutated: false };
  }

  const body = expectPlainObject(deepCloneJson(record.body), 'body');
  const applied: AppliedPatchOp[] = [];
  const entries: HistoryEntry[] = [];

  for (const op of parsedOps) {
    const capture = applyOp(record.object_type, body, op);
    const bodyMutated = captureMutatedBody(capture);
    applied.push({ op, capture, body_mutated: bodyMutated });
    entries.push({
      at: options.at,
      action: op.op,
      actor: options.actor,
      details: deepCloneJson({ ...options.entryDetails, op, capture }) as Record<string, unknown>,
    });
  }

  const mutatedOps = applied.filter((entry) => entry.body_mutated).length;
  const next: ObjectRecord<unknown> = {
    ...record,
    body,
    updated_at: options.at,
    history: [...record.history, ...entries],
    // Every op application bumps `version`; `content_revision` moves only
    // with actual body mutation (D§3.1 / C§2.0).
    version: record.version + applied.length,
    content_revision: record.content_revision + mutatedOps,
  };
  return { record: next, applied, body_mutated: mutatedOps > 0 };
};

// ——— inverse derivation (C§2.4 Discard) ———

const invalidInverse = (op: PatchOp, reason: string): PatchApplyError =>
  new PatchApplyError('invalid_op', `Cannot derive inverse of ${op.op}: ${reason}`);

const expectCaptureKind = <TKind extends PatchOpCapture['kind']>(
  op: PatchOp,
  capture: PatchOpCapture,
  kind: TKind
): Extract<PatchOpCapture, { kind: TKind }> => {
  if (capture.kind !== kind) throw invalidInverse(op, `capture kind '${capture.kind}' does not match the op.`);
  return capture as Extract<PatchOpCapture, { kind: TKind }>;
};

/**
 * The exact merge tree that turns `after` back into `before` under the
 * grammar's deep-merge rules (set_tracking inverse): keys the forward op
 * added become explicit nulls (unset), changed plain-object keys recurse,
 * changed arrays/scalars restore the before value wholesale.
 */
const trackingInverseTree = (after: UnknownRecord, before: UnknownRecord): FieldsTree => {
  const out: FieldsTree = {};
  for (const key of Object.keys(after)) {
    if (!(key in before)) out[key] = null;
  }
  for (const [key, beforeValue] of Object.entries(before)) {
    const afterValue = after[key];
    if (deepEqualJson(afterValue, beforeValue)) continue;
    if (isPlainObject(afterValue) && isPlainObject(beforeValue)) {
      out[key] = trackingInverseTree(afterValue, beforeValue);
    } else {
      out[key] = deepCloneJson(beforeValue) as PatchJsonValue;
    }
  }
  return out;
};

const guardOf = (expected: unknown): { guard: { expected: unknown } } => ({
  guard: { expected: deepCloneJson(expected) },
});

const inverseOfUpsert = (
  capture: Extract<PatchOpCapture, { kind: 'element' }>,
  restore: (value: PatchJsonValue) => PatchOp,
  remove: (after: Extract<ElementSnapshot, { exists: true }>) => PatchOp
): PatchOp => {
  if (capture.before.exists) {
    // Conditional-upsert inverse (C§2.4): the op replaced an existing
    // element — restore the stored `before`; a blind remove would delete
    // pre-existing content the op merely modified.
    return { ...restore(deepCloneJson(capture.before.value)), ...guardOf(capture.after) } as PatchOp;
  }
  if (!capture.after.exists) throw new PatchApplyError('invalid_op', 'upsert capture has neither before nor after.');
  // True insert — the inverse removes it.
  return { ...remove(capture.after), ...guardOf(capture.after) } as PatchOp;
};

const inverseOfRemove = (
  capture: Extract<PatchOpCapture, { kind: 'element' }>,
  restore: (before: Extract<ElementSnapshot, { exists: true }>) => PatchOp
): PatchOp => {
  if (!capture.before.exists) throw new PatchApplyError('invalid_op', 'remove capture has no before element.');
  // The guard pins the element's absence AND the container's post-removal
  // order: restoring at a saved index into a since-reordered list would
  // silently re-shuffle intervening edits, so it refuses instead (C§2.4).
  const expected =
    capture.container_after !== undefined ? { exists: false, container: capture.container_after } : ABSENT;
  return { ...restore(capture.before), ...guardOf(expected) } as PatchOp;
};

/**
 * Derive the compensating op for an applied patch op, from exactly what its
 * history entry stores (`details: {op, capture}`). The returned op carries a
 * `guard` pinning the state it expects (the forward op's captured `after`),
 * so applying it through `applyPatchOps` enforces the C§2.4 blind-revert
 * rule automatically.
 */
export const derivePatchInverse = (op: PatchOp, capture: PatchOpCapture): PatchOp => {
  switch (op.op) {
    // Fields ops invert to THEMSELVES with the captured before-tree. For
    // set_product_price that IS the §3 "re-point to the archived price"
    // Discard semantics: the old price_id + cache are restored, and the
    // archived Stripe Price remains chargeable when re-pointed.
    case 'set_page_meta':
    case 'set_nav_meta':
    case 'set_site_fields':
    case 'set_site_brand_tokens':
    case 'set_site_brand_imagery':
    case 'set_product_fields':
    case 'set_product_price':
    case 'set_article_meta':
    case 'set_template_meta':
    case 'set_section_template_meta':
    case 'update_blueprint_data':
    case 'set_tracking_config_fields':
    case 'set_voice_fields':
    case 'set_visual_standard_fields':
    case 'set_theme_fields': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({ op: op.op, fields: fieldsCapture.before, ...guardOf(fieldsCapture.after) });
    }

    case 'set_tracking': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      const beforeTracking = fieldsCapture.before.tracking;
      const afterTracking = fieldsCapture.after.tracking;
      // Absent before → the exact inverse of a first-set is whole-block
      // removal. Absent after (forward removal) → merging the full prior
      // tree onto the now-absent block reproduces it exactly. Otherwise →
      // the computed merge tree that turns the after-tree back into the
      // before-tree (nulls unset keys the forward op added).
      const fields =
        beforeTracking === null || beforeTracking === undefined
          ? null
          : afterTracking === null || afterTracking === undefined
            ? deepCloneJson(beforeTracking)
            : trackingInverseTree(
                expectPlainObject(afterTracking, 'set_tracking capture.after.tracking'),
                expectPlainObject(beforeTracking, 'set_tracking capture.before.tracking')
              );
      return patchOpSchema.parse({ op: 'set_tracking', fields, ...guardOf(fieldsCapture.after) });
    }

    case 'replace_blueprint': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      if (!elementCapture.before.exists) throw invalidInverse(op, 'capture has no before blueprint.');
      // The blueprint always exists (the body schema requires it), so the
      // inverse is always a restore — never a remove.
      return patchOpSchema.parse({
        op: 'replace_blueprint',
        blueprint: deepCloneJson(elementCapture.before.value),
        ...guardOf(elementCapture.after),
      });
    }

    case 'update_node': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({
        op: op.op,
        node_id: op.node_id,
        fields: fieldsCapture.before,
        ...guardOf(fieldsCapture.after),
      });
    }

    case 'set_node_visibility': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({
        op: op.op,
        node_id: op.node_id,
        visibility: fieldsCapture.before.visibility ?? null,
        ...guardOf(fieldsCapture.after),
      });
    }

    case 'upsert_node': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_node', node: value }) as unknown as PatchOp,
          () => ({ op: 'remove_node', node_id: op.node.id }) as unknown as PatchOp
        )
      );
    }

    case 'remove_node': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) => ({ op: 'upsert_node', node: before.value, position: before.index }) as unknown as PatchOp
        )
      );
    }

    case 'update_section_data': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({
        op: op.op,
        section_id: op.section_id,
        fields: fieldsCapture.before,
        ...guardOf(fieldsCapture.after),
      });
    }

    case 'update_item': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({
        op: op.op,
        group_id: op.group_id,
        item_id: op.item_id,
        fields: fieldsCapture.before,
        ...guardOf(fieldsCapture.after),
      });
    }

    case 'set_section_visibility': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      return patchOpSchema.parse({
        op: op.op,
        section_id: op.section_id,
        visibility: fieldsCapture.before.visibility ?? null,
        ...guardOf(fieldsCapture.after),
      });
    }

    case 'upsert_section': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_section', section: value }) as unknown as PatchOp,
          () => ({ op: 'remove_section', section_id: op.section.id }) as unknown as PatchOp
        )
      );
    }

    case 'remove_section': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) => ({ op: 'upsert_section', section: before.value, position: before.index }) as unknown as PatchOp
        )
      );
    }

    case 'upsert_group': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_group', group: value }) as unknown as PatchOp,
          () => ({ op: 'remove_group', group_id: op.group.id }) as unknown as PatchOp
        )
      );
    }

    case 'remove_group': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) => ({ op: 'upsert_group', group: before.value, position: before.index }) as unknown as PatchOp
        )
      );
    }

    case 'upsert_item': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_item', group_id: op.group_id, item: value }) as unknown as PatchOp,
          () =>
            ({
              op: 'remove_item',
              group_id: op.group_id,
              item_id: op.item.id,
              ...(elementCapture.container_created === true ? { prune_empty: true } : {}),
            }) as unknown as PatchOp
        )
      );
    }

    case 'remove_item': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) =>
            ({
              op: 'upsert_item',
              group_id: op.group_id,
              item: before.value,
              position: before.index,
              ...(before.parent_item_id !== undefined ? { parent_item_id: before.parent_item_id } : {}),
            }) as unknown as PatchOp
        )
      );
    }

    case 'upsert_action': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_action', action: value }) as unknown as PatchOp,
          () =>
            ({
              op: 'remove_action',
              label: op.action.label,
              ...(elementCapture.container_created === true ? { prune_empty: true } : {}),
            }) as unknown as PatchOp
        )
      );
    }

    case 'remove_action': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) => ({ op: 'upsert_action', action: before.value, position: before.index }) as unknown as PatchOp
        )
      );
    }

    case 'upsert_slot': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfUpsert(
          elementCapture,
          (value) => ({ op: 'upsert_slot', slot: value }) as unknown as PatchOp,
          () => ({ op: 'remove_slot', slot_id: op.slot.slotId }) as unknown as PatchOp
        )
      );
    }

    case 'remove_slot': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      return patchOpSchema.parse(
        inverseOfRemove(
          elementCapture,
          (before) => ({ op: 'upsert_slot', slot: before.value, position: before.index }) as unknown as PatchOp
        )
      );
    }

    case 'move_section':
    case 'move_group':
    case 'move_item':
    case 'move_node':
    case 'move_slot': {
      const moveCapture = expectCaptureKind(op, capture, 'move');
      return patchOpSchema.parse({ ...op, to_index: moveCapture.before.index, ...guardOf(moveCapture.after) });
    }

    case 'add_term': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      if (!elementCapture.after.exists) throw invalidInverse(op, 'capture has no inserted term.');
      // C§2.4: add_term inverts to term removal.
      return patchOpSchema.parse({
        op: 'remove_term',
        kind: op.kind,
        term_id: op.term.term_id,
        ...guardOf(elementCapture.after),
      });
    }

    case 'remove_term': {
      const elementCapture = expectCaptureKind(op, capture, 'element');
      if (!elementCapture.before.exists) throw invalidInverse(op, 'capture has no removed term.');
      return patchOpSchema.parse({
        op: 'add_term',
        kind: op.kind,
        term: elementCapture.before.value,
        position: elementCapture.before.index,
        ...guardOf(
          elementCapture.container_after !== undefined
            ? { exists: false, container: elementCapture.container_after }
            : ABSENT
        ),
      });
    }

    case 'deprecate_term':
    case 'reactivate_term': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      const beforeStatus = fieldsCapture.before.status;
      const beforeMerged = fieldsCapture.before.merged_into ?? null;
      if (beforeStatus === 'active' && beforeMerged === null) {
        return patchOpSchema.parse({
          op: 'reactivate_term',
          kind: op.kind,
          term_id: op.term_id,
          ...guardOf(fieldsCapture.after),
        });
      }
      if (beforeStatus === 'deprecated') {
        return patchOpSchema.parse({
          op: 'deprecate_term',
          kind: op.kind,
          term_id: op.term_id,
          ...(beforeMerged !== null ? { merged_into: beforeMerged } : {}),
          ...guardOf(fieldsCapture.after),
        });
      }
      // 'active' + merged_into is unreachable through this grammar; refuse
      // rather than restore it approximately.
      throw invalidInverse(
        op,
        `prior term state {status: ${String(beforeStatus)}, merged_into: ${String(beforeMerged)}} is not expressible.`
      );
    }

    case 'update_term': {
      const fieldsCapture = expectCaptureKind(op, capture, 'fields');
      const slugChanged =
        fieldsCapture.before.slug !== undefined &&
        fieldsCapture.after.slug !== undefined &&
        !deepEqualJson(fieldsCapture.before.slug, fieldsCapture.after.slug);
      if (!slugChanged) {
        return patchOpSchema.parse({
          op: 'update_term',
          kind: op.kind,
          term_id: op.term_id,
          fields: fieldsCapture.before,
          ...guardOf(fieldsCapture.after),
        });
      }
      // Slug rename inverse (C§2.3-taxonomy): restoring the old slug
      // consumes the alias the forward op created for its vacated slug (its
      // mint, or its restore), because that alias holds exactly the slug
      // being restored — and it must still match the captured snapshot
      // (consume_alias_expected), or the alias was edited since and the
      // revert is blind (C§2.4). mint_alias:false suppresses an alias for
      // the slug being vacated; a forward-consumed alias is re-inserted
      // verbatim via restore_alias.
      const consumed = fieldsCapture.alias?.consumed;
      const vacatedSlugAlias = fieldsCapture.alias?.minted ?? fieldsCapture.alias?.restored;
      return patchOpSchema.parse({
        op: 'update_term',
        kind: op.kind,
        term_id: op.term_id,
        fields: fieldsCapture.before,
        mint_alias: false,
        ...(consumed !== undefined ? { restore_alias: { term: consumed.term, position: consumed.index } } : {}),
        ...(vacatedSlugAlias !== undefined ? { consume_alias_expected: vacatedSlugAlias.term } : {}),
        ...guardOf(fieldsCapture.after),
      });
    }
  }
};
