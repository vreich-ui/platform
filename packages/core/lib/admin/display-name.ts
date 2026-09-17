/**
 * Display-name identity module (T9.2) — the "no naked ref" rule made
 * executable. Every admin surface renders objects, history, and ids through
 * these three helpers instead of printing raw `req_*` / `sec_*` / node ids.
 *
 *   objectDisplayName(record) — a human title for any of the ten object types,
 *                               derived from the object's own body.
 *   verbToPhrase(entry)       — a history entry as a plain-language sentence.
 *   idTooltip(id)             — the raw id, framed for a title/tooltip only.
 *
 * Pure, dependency-free, and unit-tested against real seed bodies so the
 * derivation cannot silently drift from the shapes on disk.
 */
import type { HistoryEntry, Principal } from '../../schema/object-record-v1.js';

/**
 * M3.2 — `objectDisplayName`, `friendlyNameFromEmail`, `OBJECT_TYPE_LABELS`,
 * `objectTypeLabel` and `deSlug` moved to the leaf `display-name-core.ts` so
 * server code can reach the two derivations without the screen vocabulary
 * below. Re-exported whole: no call site changed.
 */
export {
  deSlug,
  friendlyNameFromEmail,
  objectDisplayName,
  objectTypeLabel,
  OBJECT_TYPE_LABELS,
} from './display-name-core.js';
import { friendlyNameFromEmail } from './display-name-core.js';

const titleCase = (text: string): string =>
  text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));

type Bag = Record<string, unknown>;
const asBag = (value: unknown): Bag => (value && typeof value === 'object' ? (value as Bag) : {});
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  approved: 'Approved',
  archived: 'Archived',
  cancelled: 'Cancelled',
  changes_requested: 'Changes requested',
  complete: 'Complete',
  draft: 'Draft',
  failed: 'Failed',
  idle: 'Ready',
  in_progress: 'In progress',
  missing: 'Needs attention',
  open: 'Open',
  optional: 'Optional',
  published: 'Published',
  running: 'Working',
  warning: 'Needs attention',
};

/** Human label for stored status values. Unknown values stay readable but never expose separators. */
export function statusLabel(status: string): string {
  return STATUS_LABELS[status] ?? titleCase(status.replace(/[_-]+/g, ' '));
}

const NAV_TARGET_LABELS: Record<string, string> = {
  page: 'Page in this publication',
  taxonomy: 'Topic or category',
  listing: 'Content list',
  external: 'External link',
  asset: 'File or feed',
  route: 'Site route',
};

/** Human label for a navigation target kind; raw kinds belong only in technical views. */
export function navigationTargetLabel(kind: string): string {
  return NAV_TARGET_LABELS[kind] ?? 'Link destination';
}


// ─── principals + history phrasing ───────────────────────────────────────

// D2(b) (2026-08-06): 'unattributed-agent' is the sentinel object-store.ts /
// mcp.ts persist when a tool call declares no agent_name (agent_name:
// declared || 'unattributed-agent'). Special-cased HERE, at the display
// layer, rather than by changing what gets stored: the sentinel is persisted
// data other code (and historical history[] entries already on disk) may
// match against, so the fix is in how it renders, not in what's written.
// Without this it title-cases straight through to "Unattributed-Agent
// (agent)" — technically routed through this same function, but still an
// internal string leaking into the activity feed.
const UNATTRIBUTED_AGENT_SENTINEL = 'unattributed-agent';

/** A human name for a principal — person's email local-part, or agent name. */
export function principalName(principal: Principal | undefined): string {
  if (!principal) return 'Someone';
  if (principal.kind === 'agent') {
    if (principal.agent_name === UNATTRIBUTED_AGENT_SENTINEL) return 'An unnamed agent';
    return `${titleCase(principal.agent_name.replace(/[_-]+/g, ' '))} (agent)`;
  }
  const email = str(principal.email);
  if (!email) return 'A signed-in user';
  return friendlyNameFromEmail(email);
}

/**
 * action → past-tense verb phrase (object-agnostic; the timeline supplies
 * context). Exported (not just used internally) so its key coverage can be
 * asserted directly against the real action-name surface in
 * display-name.test.ts — see that test for why this exists and what it
 * enumerates against.
 *
 * D2(a) (2026-08-06): this map was missing almost every `object-patch-ops.ts`
 * op name. Every `patch` op's own `op` literal (e.g. `move_section`,
 * `set_site_fields`) becomes the persisted `history[].action` verbatim —
 * object-patch-apply.ts: `action: op.op` — so EVERY entry in
 * `patchOpUnionSchema` (schema/object-patch-ops.ts) needs a phrase here, not
 * just the handful that happened to get one. Also added: `retire` (W14 F6)
 * and `refresh` (the ACTUAL history action object-lock.ts's refreshObjectLock
 * writes — `refresh_lock` below is the verb-level REQUEST action name, which
 * is a different string and was never the one landing in history).
 */
export const VERB_PHRASES: Record<string, string> = {
  create: 'created',
  object_create: 'created',
  create_request: 'created',
  create_variant: 'created a variant',
  instantiate: 'created from a template',
  instantiate_section: 'created a section from a template',
  checkout: 'checked out',
  checkout_request: 'requested checkout',
  admin_checkout: 'checked out',
  checkin: 'checked in',
  checkin_request: 'requested check-in',
  admin_checkin: 'checked in',
  patch: 'edited',
  validate: 'validated',
  publish: 'published',
  publish_by_time: 'published',
  set_published_time: 'scheduled publication',
  apply_theme: 'applied a theme',
  // U3 (brand-imagery wave): the imagery sibling of apply_theme, same reason
  // for existing here (see the file header — every action-name surface needs
  // a phrase, not just the ones observed in history so far).
  apply_brand_imagery: 'applied brand imagery',
  discard: 'discarded changes',
  refresh_lock: 'refreshed the lock',
  refresh: 'refreshed the lock',
  admin_refresh_lock: 'refreshed the lock',
  force_release: 'force-released the lock',
  admin_force_release: 'force-released the lock',
  mark_agent_complete: 'completed an agent stage',
  retire: 'retired',
  submit_review: 'submitted for review',
  review_decide: 'reviewed',

  // ─── object-patch-ops.ts op names (W15 patch grammar, C§2.0) ───────────
  // Pages / shared sections
  set_page_meta: 'updated page details',
  upsert_section: 'updated a section',
  update_section_data: 'updated section content',
  move_section: 'reordered a section',
  set_section_visibility: "changed a section's visibility",
  remove_section: 'removed a section',
  // Navigation
  set_nav_meta: 'updated navigation details',
  upsert_group: 'updated a navigation group',
  move_group: 'reordered a navigation group',
  remove_group: 'removed a navigation group',
  upsert_item: 'updated a navigation item',
  update_item: 'updated',
  move_item: 'reordered a navigation item',
  remove_item: 'removed a navigation item',
  upsert_action: 'updated a navigation action',
  remove_action: 'removed a navigation action',
  // Taxonomy terms
  add_term: 'added a taxonomy term',
  update_term: 'updated a taxonomy term',
  deprecate_term: 'deprecated a taxonomy term',
  reactivate_term: 'reactivated a taxonomy term',
  remove_term: 'removed a taxonomy term',
  // Site
  set_site_fields: 'updated site details',
  set_site_brand_tokens: 'updated the site palette',
  set_site_brand_imagery: 'updated the site visual-identity contract',
  // Product
  set_product_fields: 'updated product details',
  set_product_price: 'updated the product price',
  // Article (content_item)
  set_article_meta: 'updated article details',
  upsert_node: 'updated a content block',
  update_node: 'edited a block',
  admin_update_node: 'edited a block',
  move_node: 'reordered a content block',
  set_node_visibility: "changed a content block's visibility",
  remove_node: 'removed a content block',
  admin_save_draft: 'saved a draft',
  patch_agent_output: 'updated agent output',
  patch_canonical_input: 'updated the canonical input',
  // Page templates
  set_template_meta: 'updated template details',
  upsert_slot: 'updated a template slot',
  move_slot: 'reordered a template slot',
  remove_slot: 'removed a template slot',
  // Section templates
  set_section_template_meta: 'updated section template details',
  replace_blueprint: 'replaced the section blueprint',
  update_blueprint_data: 'updated the section blueprint',
  // Theme
  set_theme_fields: 'updated theme details',
  // Tracking config / editorial voice singletons
  set_tracking: 'updated tracking settings',
  set_tracking_config_fields: 'updated the tracker registry',
  set_voice_fields: 'updated the editorial voice',
  set_strategy_fields: 'updated the editorial strategy',
  // Visual standard (brand-imagery wave)
  set_visual_standard_fields: 'updated the visual standard',
};

/**
 * A history entry rendered as one plain sentence: "<Person> <did something>".
 * `review_decide` refines by the recorded decision when present.
 */
export function verbToPhrase(entry: Pick<HistoryEntry, 'action' | 'actor' | 'details'>): string {
  let verb = VERB_PHRASES[entry.action];

  if (entry.action === 'review_decide') {
    const decision = str(asBag(entry.details).decision);
    if (decision === 'approve') verb = 'approved the changes';
    else if (decision === 'request_changes') verb = 'requested changes';
  }

  if (!verb) verb = entry.action.replace(/[_.]+/g, ' ').trim();

  return `${principalName(entry.actor)} ${verb}`;
}

// ─── id tooltip ──────────────────────────────────────────────────────

/** Frames a raw id for a title/tooltip — the only sanctioned place an id shows. */
export function idTooltip(id: string | undefined): string {
  const value = str(id);
  return value ? `Internal id: ${value}` : 'No id assigned';
}
