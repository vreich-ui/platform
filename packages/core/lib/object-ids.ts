import { validateRequestId, type NamingValidationResult } from './agents-naming.js';
import type { ObjectType } from '../schema/object-record-v1.js';

export type ObjectIdValidationResult = NamingValidationResult;

export const OBJECT_ID_CEILING_RE = /^(site|page|tpl|stpl|sec|nav|tax|thm|prod|req|trk|voice|vis)_[a-z0-9_]+$/;
export const SECTION_INSTANCE_ID_RE = /^s_[a-z0-9]+$/;

const OBJECT_ID_PATTERNS = {
  site: /^site_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  page: /^page_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  section: /^sec_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  navigation: /^nav_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  taxonomy: /^tax_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  template: /^tpl_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  section_template: /^stpl_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  theme: /^thm_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  product: /^prod_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  tracking_config: /^trk_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  // D1: `voice_` spelled out rather than abbreviated — the id is read by agents
  // in contract output far more often than it is typed by a human.
  editorial_voice: /^voice_[a-z0-9]+(?:_[a-z0-9]+)*$/,
  // Brand-imagery wave (BRIEF.md §3.1, R2): `vis_<site>` (house, singleton) or
  // `vis_<site>_<slug>` (template) — the same generic segment grammar; the
  // house/template distinction is a body-level (`kind`) fact, not an id shape.
  visual_standard: /^vis_[a-z0-9]+(?:_[a-z0-9]+)*$/,
} satisfies Record<Exclude<ObjectType, 'content_item'>, RegExp>;

const OBJECT_TYPE_PREFIXES = {
  site: 'site_',
  page: 'page_',
  section: 'sec_',
  navigation: 'nav_',
  taxonomy: 'tax_',
  template: 'tpl_',
  section_template: 'stpl_',
  theme: 'thm_',
  product: 'prod_',
  content_item: 'req_',
  tracking_config: 'trk_',
  editorial_voice: 'voice_',
  visual_standard: 'vis_',
} satisfies Record<ObjectType, string>;

export const isObjectIdWithinCeiling = (value: string): boolean => OBJECT_ID_CEILING_RE.test(value);

/**
 * W15 S1 — reverse lookup: derive the object type from an id's prefix, for
 * surfaces that receive a bare id (e.g. a /admin/content/<id> deep link with
 * no `?type=`). Deliberately EXCLUDES content_item: `req_*` ids historically
 * also named canvas upload requests and legacy workflow records, so a `req_*`
 * id is resolved against the live inventory by the caller instead of assumed.
 * Returns undefined when no governed prefix matches (callers fall back to an
 * inventory lookup or an honest not-found).
 */
export const objectTypeFromId = (value: string): Exclude<ObjectType, 'content_item'> | undefined => {
  for (const [objectType, prefix] of Object.entries(OBJECT_TYPE_PREFIXES) as Array<[ObjectType, string]>) {
    if (objectType === 'content_item') continue;
    if (value.startsWith(prefix)) return objectType as Exclude<ObjectType, 'content_item'>;
  }
  return undefined;
};

const validatePattern = (value: string, objectType: Exclude<ObjectType, 'content_item'>): ObjectIdValidationResult => {
  const prefix = OBJECT_TYPE_PREFIXES[objectType];
  if (!value) return { ok: false, error: `${objectType} id is required.` };
  if (!OBJECT_ID_PATTERNS[objectType].test(value)) {
    return {
      ok: false,
      error: `${objectType} id must start with ${prefix} and use lowercase snake_case segments.`,
    };
  }
  return { ok: true, value };
};

export const validateObjectIdForType = (objectType: ObjectType, value: string): ObjectIdValidationResult => {
  if (objectType === 'content_item') return validateRequestId(value);
  return validatePattern(value, objectType);
};

export const isObjectIdForType = (objectType: ObjectType, value: string): boolean =>
  validateObjectIdForType(objectType, value).ok;

export const validateSectionInstanceId = (value: string): ObjectIdValidationResult => {
  if (!value) return { ok: false, error: 'section instance id is required.' };
  if (!SECTION_INSTANCE_ID_RE.test(value)) {
    return {
      ok: false,
      error: 'section instance id must match s_<lowercase-alphanumeric> with no underscores in the suffix.',
    };
  }
  return { ok: true, value };
};

export const isSectionInstanceId = (value: string): boolean => validateSectionInstanceId(value).ok;
