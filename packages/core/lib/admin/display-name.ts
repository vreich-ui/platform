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
import type { ObjectRecord, ObjectType, HistoryEntry, Principal } from '../../schema/object-record-v1.js';

/** Human label for each object type — used for fallbacks and type badges. */
export const OBJECT_TYPE_LABELS: Record<ObjectType, string> = {
  page: 'Page',
  section: 'Section',
  navigation: 'Navigation',
  taxonomy: 'Taxonomy',
  site: 'Site',
  template: 'Page template',
  section_template: 'Section template',
  theme: 'Theme',
  product: 'Product',
  content_item: 'Article',
  tracking_config: 'Tracking config',
  editorial_voice: 'Editorial voice',
};

export function objectTypeLabel(type: ObjectType): string {
  return OBJECT_TYPE_LABELS[type] ?? titleCase(String(type).replace(/_/g, ' '));
}

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

// ─── generic helpers ─────────────────────────────────────────────────

type Bag = Record<string, unknown>;

const asBag = (value: unknown): Bag => (value && typeof value === 'object' ? (value as Bag) : {});
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** Title-cased, de-slugified copy: "barrier-repair-guide" → "Barrier Repair Guide". */
export function deSlug(slug: string | undefined): string | undefined {
  if (!slug) return undefined;
  const cleaned = slug
    .replace(/^\/+|\/+$/g, '')
    .replace(/[-_/]+/g, ' ')
    .trim();
  if (!cleaned) return undefined;
  return titleCase(cleaned);
}

function titleCase(text: string): string {
  return text.replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1));
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** First heading/strong text out of a section's stored HTML, tags stripped. */
function firstHeadingText(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const match = html.match(/<(h[1-6]|strong)[^>]*>([\s\S]*?)<\/\1>/i);
  const inner = match?.[2] ?? '';
  const text = inner
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return text || undefined;
}

// ─── object display name ──────────────────────────────────────────────

/**
 * A human title for an object, derived from its body. Never returns a raw
 * machine id; when nothing nameable exists it falls back to "Untitled <type>"
 * (the id belongs in a tooltip via {@link idTooltip}, not the visible label).
 */
export function objectDisplayName(record: Pick<ObjectRecord, 'object_type' | 'body' | 'object_id'>): string {
  const body = asBag(record.body);

  const named = str(body.name) ?? str(body.title) ?? str(asBag(body.presentation).title as unknown) ?? undefined;

  switch (record.object_type) {
    case 'site':
    case 'theme':
    case 'template':
    case 'section_template':
      return str(body.name) ?? fallback(record);

    case 'page':
      return str(body.title) ?? deSlug(str(body.route)) ?? fallback(record);

    case 'content_item':
      return str(body.title) ?? deSlug(str(body.slug)) ?? fallback(record);

    case 'product':
      return str(asBag(body.presentation).title) ?? deSlug(str(body.slug)) ?? fallback(record);

    case 'section': {
      const section = asBag(body.section);
      return (
        firstHeadingText(str(asBag(section.data).body)) ??
        str(section.heading) ??
        str(section.name) ??
        deSlug(str(section.id)) ??
        fallback(record)
      );
    }

    case 'navigation': {
      const role = str(body.role);
      const brand = str(asBag(body.brand).text);
      if (role) return `${capitalize(role)} navigation`;
      if (brand) return `${brand} navigation`;
      return fallback(record);
    }

    case 'taxonomy': {
      const kinds = Object.keys(asBag(body.kinds));
      return kinds.length ? `Taxonomy (${kinds.join(', ')})` : 'Site taxonomy';
    }

    default:
      return named ?? fallback(record);
  }
}

function fallback(record: Pick<ObjectRecord, 'object_type'>): string {
  return `Untitled ${objectTypeLabel(record.object_type).toLowerCase()}`;
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

/**
 * D3 (2026-08-06): the pure email → friendly-name derivation, extracted out
 * of principalName() so the server-side default-display-name sites
 * (admin-users.ts's synthesizedRecord, user-invite.ts's first-invite record)
 * can reuse the SAME derivation instead of writing a second one. This module
 * has no client-only dependencies (no browser globals — see the imports
 * above), so it's safe to import from server function code; audit-feed.ts
 * already does exactly that for objectDisplayName/verbToPhrase/idTooltip.
 *
 * The local part is plus-tag-stripped before title-casing
 * (`wolf+test@x.com` → "Wolf", not the un-word-boundaried "Wolf+test" the
 * un-stripped titleCase regex would produce — `+` isn't in the
 * separator-to-space set below, so it would otherwise ride along inside one
 * "word"). Dots/underscores/hyphens become spaces and title-case; a
 * non-name-like local part (`admin`, `no-reply`) still title-cases to
 * something readable ("Admin", "No Reply") — there's no signal in an email
 * address to do better than that.
 */
export function friendlyNameFromEmail(email: string): string {
  const local = email.split('@')[0]?.split('+')[0] ?? '';
  const cleaned = titleCase(local.replace(/[._-]+/g, ' ')).trim();
  return cleaned || email;
}

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
