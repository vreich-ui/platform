/**
 * Admin Inventory (T2) — pure logic shared by the search UI and the server
 * fan-out: facet counts for the rail, the two action-permission functions
 * the bulk toolbar and row menu both read, and the per-store-kind preview
 * summary extractors.
 *
 * No React, no I/O, no new deps — everything here is a function of its
 * arguments. `server/functions/admin-inventory.ts` (T1) owns fetching the
 * raw rows (`inventory` verb / artifact-index / `listManagedBlobStores`) AND
 * normalizing them into `InventoryHit` (`lib/admin/inventory-server-logic.ts`
 * — the canonical home for that type and for normalization); this file
 * consumes already-normalized hits and never re-normalizes them.
 * `lib/admin/inventory-client.ts` (T3) owns talking to that endpoint.
 *
 * Verb matrix (BRIEF.md "Design (ruled)"):
 *   - Objects  (owner+admin): archive (retire), validate, open-in-workspace.
 *   - Artifacts(owner+admin): delete, add-tag, remove-tag, download.
 *   - System stores: read (owner+admin); delete-blob / wipe-store / wipe-all
 *     are OWNER ONLY (the last two are store-wide — see `STORE_WIDE_ACTIONS`
 *     — and are offered one at a time, never from a bulk toolbar), per the
 *     same raw-delete rule `admin-blob-manager.ts`
 *     already enforces (BRIEF.md G0 note: that function gates its whole
 *     surface to `isOwner` today — Inventory keeps the raw-delete family at
 *     the same bar even though reads are admin-reachable here).
 *   - All collections: send-to-chat.
 * The whole Inventory surface is owner+admin only (BRIEF.md D2), so any
 * other role (editor/publisher/viewer, or no role) is allowed nothing here —
 * that gate is enforced again server-side, this is defense in depth plus
 * what drives the client bulk-toolbar's enabled set.
 */
import type { Role } from '../../server/lib/roles.js';
import type { InventoryCollection, InventoryHit } from './inventory-server-logic.js';

export type { Role };
export type { InventoryCollection, InventoryHit };

// ─── hit shape ───────────────────────────────────────────────────────────────

/**
 * Which bucket a hit's (canonical) `collection` falls into, for the verb
 * matrix. `'objects'` and `'artifacts'` pass through; every system-store hit
 * carries the closed-enum collection value `'stores'` (its specific store
 * name — `workflows`, `agent-chats`, … — lives on `hit.kind`, not here), per
 * `inventory-server-logic.ts`'s `InventoryCollection`.
 */
export type InventoryCollectionKind = InventoryCollection;

/** Which bucket a collection name falls into, for the verb matrix. */
export function collectionKind(collection: InventoryCollection): InventoryCollectionKind {
  return collection;
}

// ─── facets ──────────────────────────────────────────────────────────────────

export interface FacetCounts {
  collection: Record<string, number>;
  kind: Record<string, number>;
  status: Record<string, number>;
  /**
   * Keyed by the CASE-FOLDED tag (`inventoryTagKey`), not by the spelling a
   * row happened to store — see `tagLabels` for what to put on the chip.
   * Folding is not a style choice here: the by-tag pointer key is a path
   * segment compared case-insensitively, and `applyArtifactTagChanges`
   * already treats `Julia` and `julia` as one tag when adding and removing.
   * A facet that split them would offer two chips for one tag and let a
   * "remove Julia" quietly clear the rows filed under `julia`.
   */
  tag: Record<string, number>;
  /**
   * Folded tag key → the spelling to display for it.
   *
   * Chosen as the code-unit-smallest spelling among the variants seen rather
   * than the first one encountered, so the label does not change as more
   * pages load. The SELECTION keys on the folded key, so even if a later page
   * changes the label the active chip still matches.
   */
  tagLabels: Record<string, string>;
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

/**
 * The identity of a tag for facet, filter and selection purposes: trimmed and
 * lowercased, matching `applyArtifactTagChanges`' comparison and the by-tag
 * pointer key. Display spelling is preserved separately (`FacetCounts.tagLabels`).
 */
export const inventoryTagKey = (tag: string): string => tag.trim().toLowerCase();

/**
 * Counts hits per collection / kind / status / tag, for the facet rail chips.
 *
 * SCOPE — and this is the honest bit. Every count here is over the hits it was
 * handed, which is the page the surface has LOADED, not the collection. The
 * server reports its own per-collection match totals (`SearchResult.counts`)
 * and whether a sweep hit its scan cap (`SearchResult.truncated`) separately;
 * a surface rendering these chips must say which of the two it is showing.
 * That was already true of the three original facets and is not made truer or
 * falser by the tag facet — but tags carry one extra caveat: only artifacts
 * have them, so the tag chips describe the artifact rows and nothing else.
 */
export function facetCounts(hits: readonly InventoryHit[]): FacetCounts {
  const counts: FacetCounts = { collection: {}, kind: {}, status: {}, tag: {}, tagLabels: {} };
  for (const hit of hits) {
    bump(counts.collection, hit.collection);
    bump(counts.kind, hit.kind);
    bump(counts.status, hit.status);

    // Per HIT, not per tag occurrence: a row that somehow carries `Julia` and
    // `julia` is one row tagged Julia, and must count once.
    const seen = new Set<string>();
    for (const tag of hit.tags) {
      const key = inventoryTagKey(tag);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      bump(counts.tag, key);
      const label = tag.trim();
      const existing = counts.tagLabels[key];
      if (existing === undefined || label < existing) counts.tagLabels[key] = label;
    }
  }
  return counts;
}

// ─── facet filtering ────────────────────────────────────────────────────────

/**
 * One selected value per facet group, `null` for "this group is not
 * filtering". `tag` holds a FOLDED key (`inventoryTagKey`), the same key
 * `facetCounts` counts under, so a chip stays highlighted whichever spelling
 * the rows use.
 */
export interface InventoryFacetSelection {
  collection: string | null;
  kind: string | null;
  status: string | null;
  tag: string | null;
}

export const EMPTY_INVENTORY_FACETS: InventoryFacetSelection = {
  collection: null,
  kind: null,
  status: null,
  tag: null,
};

/** True when this hit carries `tag`, comparing case-insensitively both ways. */
export const hitHasTag = (hit: InventoryHit, tag: string): boolean => {
  const key = inventoryTagKey(tag);
  if (!key) return false;
  return hit.tags.some((candidate) => inventoryTagKey(candidate) === key);
};

/**
 * The four facet groups AND'ed together — an unselected group constrains
 * nothing. The tag group is not special-cased anywhere else: a row with no
 * tags simply fails a tag filter, which is how object and store rows drop out
 * when one is active.
 */
export const matchesInventoryFacets = (hit: InventoryHit, selection: InventoryFacetSelection): boolean =>
  (selection.collection === null || hit.collection === selection.collection) &&
  (selection.kind === null || hit.kind === selection.kind) &&
  (selection.status === null || hit.status === selection.status) &&
  (selection.tag === null || hitHasTag(hit, selection.tag));

/** `matchesInventoryFacets` over a list, preserving order. */
export const filterHitsByFacets = (
  hits: readonly InventoryHit[],
  selection: InventoryFacetSelection
): InventoryHit[] => hits.filter((hit) => matchesInventoryFacets(hit, selection));

/** True when any facet group is filtering — what a "Clear facets" affordance keys off. */
export const hasActiveFacets = (selection: InventoryFacetSelection): boolean =>
  selection.collection !== null || selection.kind !== null || selection.status !== null || selection.tag !== null;

// ─── verb matrix ─────────────────────────────────────────────────────────────

export type ActionId =
  | 'archive'
  | 'validate'
  | 'open-in-workspace'
  | 'delete'
  | 'add-tag'
  | 'remove-tag'
  | 'download'
  | 'read'
  | 'delete-blob'
  | 'wipe-store'
  | 'wipe-all'
  | 'send-to-chat';

const OBJECT_ACTIONS: readonly ActionId[] = ['archive', 'validate', 'open-in-workspace', 'send-to-chat'];
const ARTIFACT_ACTIONS: readonly ActionId[] = ['delete', 'add-tag', 'remove-tag', 'download', 'send-to-chat'];
const STORE_READ_ACTIONS: readonly ActionId[] = ['read', 'send-to-chat'];
const STORE_OWNER_ACTIONS: readonly ActionId[] = ['delete-blob', 'wipe-store', 'wipe-all'];

/** `roles` already carries `expandRole`'s output (owner → ['owner','admin','publisher']), per `server/lib/roles.ts`. */
const hasAdminAccess = (roles: readonly Role[]): boolean => roles.includes('admin') || roles.includes('owner');
const hasOwnerAccess = (roles: readonly Role[]): boolean => roles.includes('owner');

/**
 * The action ids a single hit supports for this role set, per the verb
 * matrix above. The whole Inventory surface is owner+admin only, so any
 * other role set gets nothing — never a partial "read-only" set — matching
 * how the page itself is gated (BRIEF.md D2, nav `adminOnly`).
 */
export function allowedActions(hit: InventoryHit, roles: readonly Role[]): ActionId[] {
  if (!hasAdminAccess(roles)) return [];

  switch (collectionKind(hit.collection)) {
    case 'objects':
      return [...OBJECT_ACTIONS];
    case 'artifacts':
      return [...ARTIFACT_ACTIONS];
    case 'stores':
      return hasOwnerAccess(roles) ? [...STORE_READ_ACTIONS, ...STORE_OWNER_ACTIONS] : [...STORE_READ_ACTIONS];
  }
}

/**
 * Actions whose SUBJECT is a whole store, not the row you invoked them from.
 * `wipe-store` empties every key in the row's store; `wipe-all` empties every
 * store on the site. They are legitimate owner verbs and stay in
 * `allowedActions`, but they must never reach a bulk toolbar: "apply to each
 * of the 12 selected rows" is meaningless for a verb that already covers all
 * of them, and running it once per row would be a confirmed-once,
 * executed-twelve-times foot-gun. A surface offers these one at a time, with
 * a typed confirm that names the store.
 */
const STORE_WIDE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>(['wipe-store', 'wipe-all']);

/** True when an action applies to the row it was invoked from, rather than to the row's whole store. */
export const isRowScopedAction = (action: ActionId): boolean => !STORE_WIDE_ACTIONS.has(action);

/**
 * Row-scoped verbs that are still SINGLE-SUBJECT: each one acts on the one row
 * you invoked it from and has no meaningful "apply to all twelve" form, so it
 * belongs in the row menu and the drawer, never in a bulk toolbar.
 *
 * WHY THIS SET EXISTS. `bulkActionsFor` returned all three of these for a
 * uniform selection while `bulkButtons()` rendered no button for any of them.
 * A tested function said the action was available and the surface silently
 * disagreed — the same class of defect as the toolbar that used to go quiet
 * with no explanation, and the reason `download` was reported. Fixed by
 * DROPPING them from the bulk set rather than growing three bulk buttons:
 *
 *   - `download`: "download 12 artifacts" is not one action, it is twelve
 *     authenticated byte fetches and twelve separate browser saves, which
 *     browsers block after the first couple with no error the page can see. A
 *     bulk button that reliably half-works is worse than none.
 *   - `open-in-workspace`: navigates to ONE object's workspace; the bulk form
 *     would be twelve tabs, and the popup blocker decides how many open.
 *   - `read`: opens the drawer inspector, which inspects one hit at a time by
 *     construction.
 *
 * All three stay in `allowedActions`, so the row menu and the drawer footer
 * still offer them per row — where `download` can also say when there are no
 * bytes to fetch (`inventoryPreviewPlan(hit).mode === 'json'`).
 */
const BULK_UNSAFE_ACTIONS: ReadonlySet<ActionId> = new Set<ActionId>([
  'download',
  'open-in-workspace',
  'read',
]);

/** True when an action is safe to offer over a whole selection at once. */
export const isBulkOfferableAction = (action: ActionId): boolean =>
  isRowScopedAction(action) && !BULK_UNSAFE_ACTIONS.has(action);

/**
 * The bulk-toolbar's enabled set: only actions valid for EVERY row in the
 * selection (BRIEF.md "Design (ruled)": "Bulk toolbar shows only verbs valid
 * for every selected row"). A mixed objects+artifacts selection intersects
 * down to `send-to-chat` only; an empty selection has no actions. The
 * store-wide verbs are excluded outright — see `STORE_WIDE_ACTIONS` — as is
 * `download`, which is row-scoped but not bulk-offerable (`BULK_UNSAFE_ACTIONS`).
 *
 * Every id this returns MUST have a button in the toolbar: this is the list
 * the surface renders from, so an id here with nothing behind it is the
 * function lying about what the page can do.
 */
export function bulkActionsFor(selection: readonly InventoryHit[], roles: readonly Role[]): ActionId[] {
  if (selection.length === 0) return [];
  const perHit = selection.map((hit) => allowedActions(hit, roles));
  const [first, ...rest] = perHit;
  const restSets = rest.map((actions) => new Set(actions));
  return first.filter((action) => isBulkOfferableAction(action) && restSets.every((set) => set.has(action)));
}

// ─── preview summaries ───────────────────────────────────────────────────────

export interface PreviewField {
  label: string;
  value: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** Renders any JSON value as a single short display string for a preview field. */
function formatPreviewValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return `${value.length} item${value.length === 1 ? '' : 's'}`;
  if (isRecord(value)) return `${Object.keys(value).length} field${Object.keys(value).length === 1 ? '' : 's'}`;
  return String(value);
}

/** `workflow_status` → `Workflow status` — for the default extractor's field labels. */
function humanizeKey(key: string): string {
  const spaced = key.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const first = (obj: Record<string, unknown>, ...keys: string[]): unknown => {
  for (const key of keys) {
    if (obj[key] !== undefined) return obj[key];
  }
  return undefined;
};

function workflowPreview(obj: Record<string, unknown>): PreviewField[] {
  const status = first(obj, 'workflow_status', 'status');
  const outputs = first(obj, 'agent_outputs', 'outputs');
  const nodeCount = isRecord(outputs) ? Object.keys(outputs).length : Array.isArray(outputs) ? outputs.length : 0;
  const updated = first(obj, 'updated_at', 'updatedAt');
  return [
    { label: 'Status', value: formatPreviewValue(status) },
    { label: 'Node count', value: String(nodeCount) },
    { label: 'Updated', value: formatPreviewValue(updated) },
  ];
}

function agentArtifactJobPreview(obj: Record<string, unknown>): PreviewField[] {
  const status = first(obj, 'status');
  const slot = first(obj, 'slot');
  const project = first(obj, 'projectId', 'project', 'project_id');
  return [
    { label: 'Status', value: formatPreviewValue(status) },
    { label: 'Slot', value: formatPreviewValue(slot) },
    { label: 'Project', value: formatPreviewValue(project) },
  ];
}

function agentChatPreview(obj: Record<string, unknown>): PreviewField[] {
  const title = first(obj, 'title');
  const events = first(obj, 'events');
  const turnCount = Array.isArray(events) ? events.length : 0;
  return [
    { label: 'Title', value: formatPreviewValue(title) },
    { label: 'Turns', value: String(turnCount) },
  ];
}

/** Fallback for any store `previewSummary` has no dedicated extractor for (D4): up to 4 of the JSON's own top-level keys. */
function defaultPreview(obj: Record<string, unknown>): PreviewField[] {
  return Object.keys(obj)
    .slice(0, 4)
    .map((key) => ({ label: humanizeKey(key), value: formatPreviewValue(obj[key]) }));
}

/**
 * Up to 4 {label, value} pairs summarizing a system-store JSON blob for the
 * search-result preview cell / drawer, per store kind (BRIEF.md row = "JSON
 * summary of 3–4 key fields"). Unrecognized stores — anything besides the
 * three named here — fall back to `defaultPreview`'s generic top-level-key
 * extraction (D4: "no special UI" for the long tail of stores).
 */
export function previewSummary(storeName: string, json: unknown): PreviewField[] {
  const obj = isRecord(json) ? json : {};
  switch (storeName) {
    case 'workflows':
      return workflowPreview(obj);
    case 'agent-artifact-jobs':
      return agentArtifactJobPreview(obj);
    case 'agent-chats':
      return agentChatPreview(obj);
    default:
      return defaultPreview(obj);
  }
}
