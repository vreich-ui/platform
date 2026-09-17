/**
 * The display-name derivations the SERVER needs, split out of
 * `display-name.ts` in M3.2 for a cold-start reason the
 * `function-bundle-budget` test made concrete.
 *
 * `objectDisplayName` is reached from `object-inventory.ts` (through the
 * record-write choke point) and `friendlyNameFromEmail` from three membership
 * modules, so EVERY admin function that writes an object record or names a
 * person was carrying the whole display vocabulary with them: the status and
 * navigation label tables, `principalName`, `idTooltip`, and the hundred-line
 * `VERB_PHRASES` history-sentence table — nine kilobytes of copy for admin
 * SCREENS, in functions that render none.
 *
 * So the dependency runs one way and stops: this file holds the two
 * derivations and the helpers they share, and `display-name.ts` re-exports
 * every name from here so no client call site changed. Server code imports
 * THIS spelling; either compiles, only this one is on the diet.
 */
import type { ObjectRecord, ObjectType } from '../../schema/object-record-v1.js';

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
  visual_standard: 'Visual standard',
  editorial_strategy: 'Editorial strategy',
};

export function objectTypeLabel(type: ObjectType): string {
  return OBJECT_TYPE_LABELS[type] ?? titleCase(String(type).replace(/_/g, ' '));
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
/**
 * D3 (2026-08-06): the pure email → friendly-name derivation, extracted out
 * of principalName() so the server-side default-display-name sites
 * (admin-users.ts's synthesizedRecord, membership/invitations.ts's first-invite record)
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
