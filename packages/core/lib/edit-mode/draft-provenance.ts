/**
 * Per-block draft provenance (T17.14c) — the pure half.
 *
 * The defect this fixes: `markDraftRegions` used to mark by OBJECT id alone,
 * so one unpublished node edit on an article dashed-outlined and
 * `· draft`-chipped every block in it (an article is one `content_item`
 * object; every node shares its id). `docs/design/marginalia-concept-b-final.pdf`
 * shows exactly one block carrying the chip.
 *
 * The data already exists and is already read: the Pending tray's
 * `summarizeUnpublished` (ui.ts) walks a record's `history` backwards to the
 * last `publish` entry and reads `entry.details.op.node_id` /
 * `entry.details.op.section_id` off each op to phrase "Text edited in Hook".
 * `changedUnitsSince` is the SAME walk, generalised to a set instead of a
 * phrase, so the tray and the canvas can never disagree about which unit
 * changed — they read the same history.
 *
 * Spec: docs/design/marginalia-affordance-model.md §6.
 */
import type { EditTarget } from './targets.js';

/** Mirrors ui.ts's HistoryEntry — the record.history entry shape every op walk reads. */
export type HistoryEntry = {
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

export type ChangedUnits = {
  /** Ops that dirty the object as a whole (create, set_page_meta, set_site_fields, …). */
  wholeObject: boolean;
  nodeIds: Set<string>;
  sectionIds: Set<string>;
  /**
   * False when the history itself gave nothing to walk (missing/empty).
   * The caller MUST fall back to today's object-wide marking in that case —
   * losing a draft signal is worse than showing too many, and an unresolved
   * result is the one case where we genuinely don't know.
   */
  resolved: boolean;
};

/**
 * Node-scoped ops (article blocks) — every op ui.ts's `phraseForEntry` already
 * treats as "…in <role>" and therefore already reads `node_id` off. `remove_node`
 * is included for completeness — its region no longer renders (`.dl-em-removed`
 * already owns that), so recording its id here changes nothing observable.
 */
const NODE_ACTIONS = new Set(['update_node', 'upsert_node', 'remove_node', 'move_node', 'set_node_visibility']);

/** Section-scoped ops (page-owned or shared-section-owned sections). */
const SECTION_ACTIONS = new Set(['update_section_data', 'upsert_section', 'remove_section', 'move_section']);

/** Ops that dirty the whole object — no sub-object unit to narrow to. */
const WHOLE_OBJECT_ACTIONS = new Set([
  'set_page_meta',
  'set_site_fields',
  'set_site_brand_tokens',
  'set_article_meta',
  'update_item',
  'upsert_group',
  'remove_group',
  'upsert_action',
  'remove_action',
  'set_nav_meta',
  'move_item',
]);

const isProductOrTermAction = (action: string): boolean => /product/.test(action) || /term/.test(action);

/**
 * Identical loop shape to ui.ts's `summarizeUnpublished`: walk `history`
 * backwards, stop at the last `publish`, skip lock bookkeeping entries, and
 * treat `create` as dirtying the whole object (there is nothing to have
 * published yet). Every op is mapped to a unit; an op shape this mapping
 * does not recognise dirties the whole object too — it is never silently
 * dropped, because that would be a *less* safe fallback than today's
 * behaviour, not a more precise one.
 */
export const changedUnitsSince = (history: readonly HistoryEntry[]): ChangedUnits => {
  const nodeIds = new Set<string>();
  const sectionIds = new Set<string>();
  let wholeObject = false;

  if (history.length === 0) {
    return { wholeObject: false, nodeIds, sectionIds, resolved: false };
  }

  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = history[index];
    const action = entry.action ?? '';
    if (action === 'publish') break;
    if (action === 'checkout' || action === 'checkin' || action === 'refresh_lock') continue;
    if (action === 'create') {
      wholeObject = true;
      break;
    }
    if (NODE_ACTIONS.has(action)) {
      const nodeId = entry.details?.op?.node_id;
      if (nodeId) nodeIds.add(nodeId);
      else wholeObject = true; // an op of this shape with no node id to scope by
      continue;
    }
    if (SECTION_ACTIONS.has(action)) {
      const sectionId = entry.details?.op?.section_id;
      if (sectionId) sectionIds.add(sectionId);
      else wholeObject = true;
      continue;
    }
    if (WHOLE_OBJECT_ACTIONS.has(action) || isProductOrTermAction(action)) {
      wholeObject = true;
      continue;
    }
    // Unrecognised op shape — degrade honestly rather than ignore it.
    wholeObject = true;
  }

  return { wholeObject, nodeIds, sectionIds, resolved: true };
};

export type ProvenanceUnit = { kind: 'node'; id: string } | { kind: 'section'; id: string };

/**
 * Which unit of `changedUnitsSince`'s output a rendered region corresponds
 * to. A `content_item` node and a page-owned section carry their own id
 * directly on the target (`targets.ts`'s `deriveNodeTarget`/`deriveEditTarget`,
 * read off the page-side `data-cms-*` annotation). A SHARED section's target
 * (`deriveEditTarget`'s `objectType: 'section'` branch) carries none — the id
 * that scopes ops on THAT object is the shared record's own inner section id,
 * `record.body.section.id` (the same lookup ui.ts's `update_section_data`
 * chip handler already makes when `target.sectionId` is absent — a `section`
 * object wraps exactly one section, so this is a read of already-fetched
 * data, not a new one).
 *
 * `undefined` means "can't tell which unit this region is" — the caller must
 * fall back to whole-object marking rather than treat that as "no match";
 * losing a draft signal is worse than showing too many.
 */
export const provenanceUnitFor = (
  target: Pick<EditTarget, 'objectType' | 'nodeId' | 'sectionId'>,
  record: Record<string, unknown> | undefined
): ProvenanceUnit | undefined => {
  if (target.objectType === 'content_item') return target.nodeId ? { kind: 'node', id: target.nodeId } : undefined;
  if (target.objectType === 'page') return target.sectionId ? { kind: 'section', id: target.sectionId } : undefined;
  if (target.objectType === 'section') {
    const innerId = (record?.body as { section?: { id?: string } } | undefined)?.section?.id;
    return innerId ? { kind: 'section', id: innerId } : undefined;
  }
  return undefined;
};

/**
 * Whether one rendered region should carry the dashed `.dl-em-draft` outline
 * — the exact per-region decision `markDraftRegions` (ui.ts) makes, extracted
 * so it is unit-tested without a DOM. `unit` is `provenanceUnitFor`'s output
 * for this region.
 *
 * Fallback to whole-object marking (returns `true` whenever `pending` is
 * true) happens for three reasons, all deliberate: `changed` couldn't be
 * resolved at all (no/empty history), the change IS whole-object (a
 * `set_page_meta`-shaped op, `create`, …), or this particular region's unit
 * couldn't be determined (`unit === undefined` — e.g. a shared section whose
 * inner id didn't come back with the record). Object-wide is today's
 * behaviour; the fix can only ever be more precise than that, never less.
 */
export const regionIsDraft = (
  pending: boolean,
  changed: ChangedUnits | undefined,
  unit: ProvenanceUnit | undefined
): boolean => {
  if (!pending) return false;
  if (!changed || !changed.resolved || changed.wholeObject) return true;
  if (!unit) return true;
  return unit.kind === 'node' ? changed.nodeIds.has(unit.id) : changed.sectionIds.has(unit.id);
};
