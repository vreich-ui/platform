/**
 * Deterministic server-side ID minting for the object verbs (T0.8).
 *
 * The T0.6 patch engine deliberately requires every ID to be present on the
 * op it receives — it never mints IDs, so that apply/inverse stays a pure,
 * provably-reversible function. Minting fresh IDs is therefore the endpoint's
 * job (C§2.5-C: taxonomy terms arrive as `{slug, label}` with the `term_id`
 * "minted server-side" — that server side is the verb endpoint). This module
 * is the single place that minting happens, so format and determinism rules
 * never drift across actions.
 *
 * Every minted ID is DETERMINISTIC in its seed (same seed → same ID, so
 * retries/replays are idempotent) and is verified against the real T0.3
 * validators (`validateObjectIdForType` / `validateSectionInstanceId`) or the
 * committed body-schema regexes before it is returned — a minted ID that would
 * fail validation is a bug and throws rather than being handed to the engine.
 *
 * Uniqueness note: minting is deterministic, not globally-unique-guaranteeing.
 * A term whose `term_id` collides is rejected downstream by the engine's
 * `add_term` duplicate check; an omitted section/nav/slot id is seeded from the
 * element payload (a content hash) so distinct elements get distinct ids and an
 * identical re-submission stays idempotent. A caller that needs a specific id
 * supplies it explicitly — minting only fills a genuinely absent id.
 */
import { createHash } from 'node:crypto';

import { siteShortId, validateObjectIdForType, validateSectionInstanceId } from './object-ids.js';
import { refIdSchema } from '../schema/bodies/visual-standard-v1.js';
import type { ObjectType } from '../schema/object-record-v1.js';

// Repeated from taxonomy-v1.ts / object-patch-ops.ts (term ids are body-internal
// — T0.3 has no term validator to import); kept in lockstep by the self-check below.
const TERM_ID_RE = /^t_[a-z0-9]+$/;
// Nav item/group ids and template slot ids are opaque non-empty strings in the
// T0.2 body schemas (no dedicated T0.3 validator); we still hold them to a
// clean, stable shape.
const OPAQUE_ID_RE = /^[a-z][a-z0-9_]*$/;

export class MintIdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MintIdError';
  }
}

/** Lowercase hex (⊂ [a-z0-9]) content hash — deterministic, collision-resistant. */
const shortHash = (seed: string, length = 12): string =>
  createHash('sha256').update(seed).digest('hex').slice(0, length);

/** Strip to bare lowercase alphanumerics (for the no-separator id shapes: t_/s_). */
const alnum = (seed: string): string => seed.toLowerCase().replace(/[^a-z0-9]/g, '');

/** Lowercase snake_case segments (for object ids like page_start_here). */
const snakeSegments = (seed: string): string =>
  seed
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');

/**
 * The mint targets. Object types mint envelope-level ids (`page_…`, `sec_…`,
 * `tax_…`, …); the others mint the body-internal ids the patch grammar carries.
 * `content_item` keeps the article pipeline's `req_*` request-id shape
 * verbatim (08-articles-plan §1.6 — artifact blobKeys embed the owning id),
 * so its mint is a dedicated target carrying the date segment the shape
 * requires; determinism is per (seed, date) — same-day retries are idempotent.
 * `article_node` mints the opaque `n_*` node ids (W7.3): a hex hash can never
 * contain the forbidden strategy words (hook/agitation/cta/… all need letters
 * outside a–f), so minted node ids satisfy the leak rule by construction.
 */
export type MintTarget =
  | { kind: 'object'; objectType: Exclude<ObjectType, 'content_item'> }
  | { kind: 'content_item'; yyyymmdd: string }
  | { kind: 'article_node' }
  | { kind: 'section_instance' }
  | { kind: 'taxonomy_term' }
  | { kind: 'nav_item' }
  | { kind: 'nav_group' }
  | { kind: 'template_slot' }
  | { kind: 'visual_standard_reference' };

const OBJECT_PREFIX: Record<Exclude<ObjectType, 'content_item'>, string> = {
  page: 'page',
  section: 'sec',
  navigation: 'nav',
  taxonomy: 'tax',
  site: 'site',
  template: 'tpl',
  section_template: 'stpl',
  theme: 'thm',
  product: 'prod',
  tracking_config: 'trk',
  editorial_voice: 'voice',
  visual_standard: 'vis',
};

/**
 * Mint a deterministic, validated ID for `target` from `seed`.
 *
 * - `object`   → `{prefix}_{snake segments}` (validated with the T0.3 per-type
 *                validator). Seed is a human hint (route/name/role).
 * - `taxonomy_term` → `t_{alnum(slug)}` (C§2.5-C's `{slug,label}` case). Seed is
 *                the slug, so the id reads `t_sunscreen` / `t_skinscience`.
 * - `section_instance` → `s_{hash}`; nav item → `i_{hash}`; nav group →
 *                `g_{hash}`; template slot → `slot_{hash}`. These have no external
 *                slug, so they hash the element payload the caller passes as seed.
 */
export const mintId = (target: MintTarget, seed: string): string => {
  const trimmed = (seed ?? '').trim();
  if (!trimmed) throw new MintIdError(`Cannot mint ${target.kind} id from an empty seed.`);

  switch (target.kind) {
    case 'object': {
      const prefix = OBJECT_PREFIX[target.objectType];
      const suffix = snakeSegments(trimmed) || shortHash(trimmed);
      const id = `${prefix}_${suffix}`;
      const check = validateObjectIdForType(target.objectType, id);
      if (!check.ok) throw new MintIdError(`Minted ${target.objectType} id "${id}" is invalid: ${check.error}`);
      return id;
    }
    case 'content_item': {
      // req_<flow>_<topic>_<yyyymmdd>_<nn> (validateRequestId, D§3.1). Flow is
      // pinned to 'agent' — the generic-verb creation path; the topic segments
      // come from the seed (slug/title). Deterministic in (seed, date); a
      // same-day duplicate collides on the store's existence check and the
      // caller retries with an explicit requested_id.
      if (!/^\d{8}$/.test(target.yyyymmdd)) {
        throw new MintIdError(`content_item mint needs a yyyymmdd date (got "${target.yyyymmdd}").`);
      }
      const topic = snakeSegments(trimmed) || shortHash(trimmed);
      const id = `req_agent_${topic}_${target.yyyymmdd}_01`;
      const check = validateObjectIdForType('content_item', id);
      if (!check.ok) throw new MintIdError(`Minted content_item id "${id}" is invalid: ${check.error}`);
      return id;
    }
    case 'article_node':
      return `n_${shortHash(trimmed)}`;
    case 'taxonomy_term': {
      const suffix = alnum(trimmed) || shortHash(trimmed);
      const id = `t_${suffix}`;
      if (!TERM_ID_RE.test(id)) throw new MintIdError(`Minted term id "${id}" is invalid.`);
      return id;
    }
    case 'section_instance': {
      const id = `s_${shortHash(trimmed)}`;
      const check = validateSectionInstanceId(id);
      if (!check.ok) throw new MintIdError(`Minted section instance id "${id}" is invalid: ${check.error}`);
      return id;
    }
    case 'nav_item':
      return assertOpaque(`i_${shortHash(trimmed)}`);
    case 'nav_group':
      return assertOpaque(`g_${shortHash(trimmed)}`);
    case 'template_slot':
      return assertOpaque(`slot_${shortHash(trimmed)}`);
    case 'visual_standard_reference': {
      // A2: mood-board reference ids (visual-standard-v1.ts's REF_ID_RE,
      // `ref_<lowercase alphanumerics>`) — agents must never invent one
      // (object-contract.ts's `reference_ids` constraint); the endpoint
      // mints one per id-less `references[]` entry from the element's own
      // payload, same idempotent-on-resubmission idiom as section/nav ids.
      const id = `ref_${shortHash(trimmed, 8)}`;
      const check = refIdSchema.safeParse(id);
      if (!check.success) throw new MintIdError(`Minted reference id "${id}" is invalid.`);
      return check.data;
    }
  }
};

/**
 * The seed for a value with no human-meaningful id hint: a short, deterministic
 * content hash rather than the value itself.
 *
 * Exported so `seedForCreate` (object-verbs.ts) can reach for it as its LAST
 * resort without hashing inline — hashing belongs to this module, and
 * object-store-auth.test.ts holds the verbs to that. The point is a bound: a
 * seed that goes through here can never grow an id past what a store key may
 * be, however large the value it was derived from. See seedForCreate for the
 * incident that made that a rule.
 */
export const opaqueSeed = (value: string): string => shortHash(value);

/**
 * The seed that mints a `visual_standard` id by its DECLARED rule (BRIEF.md
 * §3.1/R2) rather than from the candidate body.
 *
 * `vis_<site>` for the house standard (the `voice_<site>`/`trk_<site>`
 * singleton convention) and `vis_<site>_<slug>` for a template. Passed
 * through `mintId`'s ordinary object path, so the result is snake-normalised
 * and validated by the real T0.3 validator exactly like every other minted
 * id — this function only decides WHAT the id is derived from.
 *
 * This exists because the alternative is what shipped and broke: with no
 * per-type seed rule, `seedForCreate` fell through to stringifying the whole
 * body, so a realistic standard (a 230-character styleSentence, a palette, a
 * description) minted a several-hundred-character id that the blob store
 * refused with an opaque 400 — and an id short enough to "work" would still
 * have been an id nothing else in the fleet could ever find, since
 * `packages/core/cli/visual-standard-genesis.mjs` (`visualStandardIdFor`),
 * `packages/core/lib/admin/visual-identity-imagery.ts`
 * (`visualStandardTemplateId`) and CMS-Agent's `visualStandardIds.ts` all
 * already implement the rule above. Agreement with those is pinned by test
 * across a table of slugs, since they cannot all import one module (the
 * genesis half is plain `.mjs` for bare-node CLI use).
 */
export const visualStandardSeed = (site: string, templateSlug?: string): string => {
  const short = siteShortId((site ?? '').trim());
  if (!short) throw new MintIdError('Cannot mint a visual_standard id without the site it belongs to.');
  if (templateSlug === undefined) return short;
  // Byte-identical to `templateSlug()` in packages/core/lib/admin/
  // visual-identity-imagery.ts (the admin's "new template" flow), so an id
  // minted here for a template named in chat is the SAME id the studio would
  // have produced for the same name. That module stays a browser-safe leaf
  // and cannot import this one (node:crypto), so the two are pinned by test.
  const slug = String(templateSlug)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('_');
  if (!slug) {
    throw new MintIdError(
      'A template visual_standard id is vis_<site>_<slug>, built from templateSlug or the label — this one has no ' +
        'letters or digits to build a slug from. Give the template a name, or pass an explicit requested_id.'
    );
  }
  return `${short}_${slug}`;
};

const assertOpaque = (id: string): string => {
  if (!OPAQUE_ID_RE.test(id)) throw new MintIdError(`Minted opaque id "${id}" is invalid.`);
  return id;
};
