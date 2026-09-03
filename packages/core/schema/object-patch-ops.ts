/**
 * Typed patch grammar — the C§2.0 op families (T0.6).
 *
 * Agents edit objects through these typed operations, never free-form body
 * writes (03-mapping-and-agent-contract §2.0). Every op is designed to be
 * invertible: application (src/lib/object-patch-apply.ts) captures a
 * `{before, after}` snapshot per op, and `derivePatchInverse` produces the
 * compensating op the human-review Discard action applies (C§2.4).
 *
 * Payload shapes (sections, nav items, terms, slots) are minimally pinned
 * here — an identity key plus loose passthrough — because deep per-type
 * validation is the T0.2 body schemas' + T0.7 validation pipeline's job.
 * This module owns the op *structure*; the apply engine owns the mechanics.
 *
 * Grammar rules that ops rely on:
 * - Inside `fields` payloads, `null` means "unset this key". Body schemas
 *   (D§3.2–3.8) have no null-valued fields, so null is unambiguous as the
 *   deletion/absence marker, and captures encode "key was absent" as null.
 * - Plain-object `fields` values merge recursively; arrays and scalars
 *   replace wholesale.
 * - `guard` carries the expected current state of the unit an op touches
 *   (the originating op's captured `after`); the engine refuses the op when
 *   the draft has moved — the C§2.4 blind-revert rule. Inverse derivation
 *   always populates it; hand-written ops normally omit it.
 *
 * Deliberate grammar additions beyond the C§2.0 sketch (each required for
 * inverse completeness, per C§2.4's "any future op must define its inverse"):
 * - `remove_term` — C§2.4 names term removal as `add_term`'s inverse.
 * - `reactivate_term` — the inverse of deprecating an active term.
 * - `set_section_visibility` accepts `null` — restores the unset default,
 *   so setting visibility on a section that had none is exactly reversible.
 * - `remove_item`/`remove_action` carry `prune_empty` — restores absence of
 *   an optional container (`children`/`actions`) the forward upsert created.
 * - `upsert_item` carries `parent_item_id` — nav items live in a depth-≤2
 *   tree (D§3.8); removals inside a dropdown must be restorable in place.
 * - `update_term` carries `alias_term_id`/`mint_alias`/`restore_alias`/
 *   `consume_alias_expected` for the slug-rename auto-alias rule
 *   (C§2.3-taxonomy) and its exact, guarded inverse.
 *   `mint_alias: false` is engine-gated: only honored when the rename
 *   reverts to a slug this term previously owned (evidenced by consuming its
 *   own deprecated alias), so a drift-reintroducing aliasless rename is
 *   mechanically impossible, not just validation-rejected.
 */
import { z } from 'zod';
import { SECTION_INSTANCE_ID_RE } from '../lib/object-ids.js';
import type { ObjectType } from './object-record-v1.js';

// Term ids are opaque and stable (D§3.7); the shape is repeated here rather
// than imported so the grammar stays dependency-light (T0.2 owns the body
// schema; T0.3 owns object-level ids — term ids are body-internal).
export const TERM_ID_RE = /^t_[a-z0-9]+$/;

// Article node ids (article_body.v1 / content_item.v1) — opaque `n_*` ids,
// body-internal like term ids. The forbidden-strategy-words rule lives in the
// body schema (deep validation is T0.2/T0.7's job); the grammar pins shape.
export const NODE_ID_RE = /^n_[a-z0-9]+$/i;

// ——— shared primitives ———

export type PatchJsonValue = string | number | boolean | null | PatchJsonValue[] | { [key: string]: PatchJsonValue };

export const patchJsonValueSchema: z.ZodType<PatchJsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(patchJsonValueSchema),
    z.record(z.string(), patchJsonValueSchema),
  ])
);

// Deep-partial `fields` payload: plain objects merge, arrays/scalars replace,
// null unsets. Key restrictions per op are applied via superRefine below.
const fieldsSchema = z.record(z.string(), patchJsonValueSchema);

const forbidKeys =
  (forbidden: readonly string[], where: string) => (value: Record<string, unknown>, ctx: z.RefinementCtx) => {
    for (const key of forbidden) {
      if (key in value) {
        ctx.addIssue({ code: 'custom', message: `'${key}' cannot be patched via ${where}.` });
      }
    }
  };

// Expected current state of the unit this op touches, encoded exactly like
// the apply engine's captured snapshots (see PatchOpCapture in
// object-patch-apply.ts). Deep-equality-checked before the op applies;
// mismatch → blind_revert_refused (C§2.4).
export const patchOpGuardSchema = z.strictObject({ expected: z.unknown() });
export type PatchOpGuard = z.infer<typeof patchOpGuardSchema>;

const guard = { guard: patchOpGuardSchema.optional() };

const positionSchema = z.number().int().min(0);

// ——— payload shapes: identity key pinned, remainder passthrough (T0.2/T0.7 validate deeply) ———

const sectionPayloadSchema = z.looseObject({
  id: z.string().regex(SECTION_INSTANCE_ID_RE, { message: 'Section ids must match s_<lowercase alphanumerics>' }),
});
const navItemPayloadSchema = z.looseObject({ id: z.string().min(1) });
const nodePayloadSchema = z.looseObject({
  id: z.string().regex(NODE_ID_RE, { message: 'Node ids must match n_<alphanumerics>' }),
});
const navGroupPayloadSchema = z.looseObject({ id: z.string().min(1) });
const linkActionPayloadSchema = z.looseObject({ label: z.string().min(1) });
const templateSlotPayloadSchema = z.looseObject({ slotId: z.string().min(1) });

const taxonomyKindSchema = z.enum(['category', 'tag']);
export type PatchTaxonomyKind = z.infer<typeof taxonomyKindSchema>;

// Full Term shape (D§3.7) — small, stable, and correctness-critical, so it is
// pinned strictly rather than passthrough. `status` defaults to 'active' at
// apply time (C§2.0's "add_term … (status 'active')"); explicit values exist
// so remove_term's inverse can restore a deprecated term exactly.
//
// `term_id` is REQUIRED here because these are *canonical* ops, not raw agent
// input: like every other opaque id in this grammar (section `s_` ids, nav
// item/group ids, template slot ids), it is minted by the endpoint layer
// (T0.8) before the op reaches this schema. The documented agent request
// (C§2.5-C) sends `term:{slug,label}` and the term_id is "minted server-side"
// — that minting is T0.8's job (this task is apply/inverse mechanics only,
// with no endpoint wiring), which also keeps the apply engine pure and its
// inverse restores exact. See the T0.8 brief for the minting requirement.
const termPayloadSchema = z.strictObject({
  term_id: z.string().regex(TERM_ID_RE, { message: 'Term ids must match t_<lowercase alphanumerics>' }),
  slug: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['active', 'deprecated']).optional(),
  merged_into: z.string().regex(TERM_ID_RE).optional(),
});
export type TermPayload = z.infer<typeof termPayloadSchema>;

// ——— Pages / shared sections (C§2.0) ———

const setPageMetaSchema = z
  .strictObject({
    op: z.literal('set_page_meta'),
    fields: fieldsSchema
      .superRefine(forbidKeys(['sections'], 'set_page_meta (use the section ops)'))
      .superRefine(forbidKeys(['tracking'], 'set_page_meta (tracking changes only via set_tracking)')),
    ...guard,
  })
  .describe('Merge page meta fields (title/route/seo/…); sections are edited only via section ops.');

const upsertSectionSchema = z.strictObject({
  op: z.literal('upsert_section'),
  section: sectionPayloadSchema,
  // Insert position; ignored when a section with the same id already exists
  // (replace happens in place). Clamped to the array bounds.
  position: positionSchema.optional(),
  ...guard,
});

const updateSectionDataSchema = z.strictObject({
  op: z.literal('update_section_data'),
  section_id: z.string().regex(SECTION_INSTANCE_ID_RE),
  fields: fieldsSchema,
  ...guard,
});

const moveSectionSchema = z.strictObject({
  op: z.literal('move_section'),
  section_id: z.string().regex(SECTION_INSTANCE_ID_RE),
  to_index: positionSchema,
  ...guard,
});

const setSectionVisibilitySchema = z.strictObject({
  op: z.literal('set_section_visibility'),
  section_id: z.string().regex(SECTION_INSTANCE_ID_RE),
  // null restores the unset default (D§3.5's optional visibility), so the
  // inverse of setting visibility on a bare section is exact.
  visibility: z.union([z.enum(['public', 'hidden']), z.null()]),
  ...guard,
});

const removeSectionSchema = z.strictObject({
  op: z.literal('remove_section'),
  section_id: z.string().regex(SECTION_INSTANCE_ID_RE),
  ...guard,
});

// ——— Navigation (C§2.0) ———

const setNavMetaSchema = z.strictObject({
  op: z.literal('set_nav_meta'),
  // Exactly the C§2.0 surface: brand and footNote. role/groups/actions are
  // structural and have their own ops. Nested nulls unset individual brand
  // keys (the grammar's null=unset rule), so inverses of partial brand
  // writes stay expressible.
  fields: z.strictObject({
    brand: z
      .union([
        z.strictObject({
          text: z.union([z.string(), z.null()]).optional(),
          descriptor: z.union([z.string(), z.null()]).optional(),
        }),
        z.null(),
      ])
      .optional(),
    footNote: z.union([z.string(), z.null()]).optional(),
  }),
  ...guard,
});

const upsertGroupSchema = z.strictObject({
  op: z.literal('upsert_group'),
  group: navGroupPayloadSchema,
  position: positionSchema.optional(),
  ...guard,
});

const moveGroupSchema = z.strictObject({
  op: z.literal('move_group'),
  group_id: z.string().min(1),
  to_index: positionSchema,
  ...guard,
});

const removeGroupSchema = z.strictObject({
  op: z.literal('remove_group'),
  group_id: z.string().min(1),
  ...guard,
});

const upsertItemSchema = z.strictObject({
  op: z.literal('upsert_item'),
  group_id: z.string().min(1),
  item: navItemPayloadSchema,
  // Insert position within the target list; ignored on replace.
  position: positionSchema.optional(),
  // When set, the item is inserted into this item's `children` (created if
  // absent) instead of the group's top-level items. Ignored on replace —
  // an existing item is replaced wherever it lives.
  parent_item_id: z.string().min(1).optional(),
  ...guard,
});

const updateItemSchema = z.strictObject({
  op: z.literal('update_item'),
  group_id: z.string().min(1),
  item_id: z.string().min(1),
  fields: fieldsSchema.superRefine(forbidKeys(['id'], 'update_item (ids are stable)')),
  ...guard,
});

const moveItemSchema = z.strictObject({
  op: z.literal('move_item'),
  group_id: z.string().min(1),
  item_id: z.string().min(1),
  // Target index within the item's current list (top-level items or its
  // parent's children); cross-list moves are remove + upsert.
  to_index: positionSchema,
  ...guard,
});

const removeItemSchema = z.strictObject({
  op: z.literal('remove_item'),
  group_id: z.string().min(1),
  item_id: z.string().min(1),
  // When removal empties an optional `children` array, also remove the key —
  // set by inverse derivation to restore container-absence exactly.
  prune_empty: z.boolean().optional(),
  ...guard,
});

const upsertActionSchema = z.strictObject({
  op: z.literal('upsert_action'),
  // Actions carry no id (D§3.8); they are keyed by label. Changing a label is
  // remove_action + upsert_action.
  action: linkActionPayloadSchema,
  position: positionSchema.optional(),
  ...guard,
});

const removeActionSchema = z.strictObject({
  op: z.literal('remove_action'),
  label: z.string().min(1),
  // As remove_item.prune_empty, for the optional body-level `actions` array.
  prune_empty: z.boolean().optional(),
  ...guard,
});

// ——— Taxonomy (C§2.0 + C§2.3-taxonomy) ———

const addTermSchema = z.strictObject({
  op: z.literal('add_term'),
  kind: taxonomyKindSchema,
  term: termPayloadSchema,
  // Insert position; set by inverse derivation so remove_term round-trips
  // exactly. Appends by default.
  position: positionSchema.optional(),
  ...guard,
});

const updateTermSchema = z.strictObject({
  op: z.literal('update_term'),
  kind: taxonomyKindSchema,
  term_id: z.string().regex(TERM_ID_RE),
  fields: z.strictObject({
    label: z.string().min(1).optional(),
    description: z.union([z.string(), z.null()]).optional(),
    slug: z.string().min(1).optional(),
  }),
  // Slug-rename auto-alias controls (C§2.3-taxonomy). A slug change mints a
  // deprecated alias term {slug: <old slug>, merged_into: <this term>} in
  // the same op. `alias_term_id` names the minted alias's id (deterministic
  // minting when omitted). `mint_alias: false` suppresses the mint and is
  // honored only when the rename provably reverts a prior rename (the apply
  // engine enforces this); `restore_alias` re-inserts a previously consumed
  // alias. Both are populated by inverse derivation, not written by hand.
  alias_term_id: z.string().regex(TERM_ID_RE).optional(),
  mint_alias: z.boolean().optional(),
  restore_alias: z.strictObject({ term: termPayloadSchema, position: positionSchema }).optional(),
  // Exact snapshot of the alias this revert expects to consume (the forward
  // op's minted/restored alias). The engine deep-equal-checks it before the
  // consume — an alias edited or removed since the forward op refuses as a
  // blind revert (C§2.4). Populated by inverse derivation.
  consume_alias_expected: termPayloadSchema.optional(),
  ...guard,
});

const deprecateTermSchema = z.strictObject({
  op: z.literal('deprecate_term'),
  kind: taxonomyKindSchema,
  term_id: z.string().regex(TERM_ID_RE),
  // Omitted = deprecate without a merge target (validation decides whether
  // live usage requires one, C§2.3); always overwrites the stored value.
  merged_into: z.string().regex(TERM_ID_RE).optional(),
  ...guard,
});

const reactivateTermSchema = z.strictObject({
  op: z.literal('reactivate_term'),
  kind: taxonomyKindSchema,
  term_id: z.string().regex(TERM_ID_RE),
  ...guard,
});

const removeTermSchema = z.strictObject({
  op: z.literal('remove_term'),
  kind: taxonomyKindSchema,
  term_id: z.string().regex(TERM_ID_RE),
  ...guard,
});

// ——— Site (C§2.0) ———

// Deep-partial SiteBody; per-field validation is T0.7's job. `brandTokens` is
// NOT patchable here (Wolf 2026-07-15, theme-only palette governance): the
// palette changes ONLY through site_apply_theme, which emits the privileged
// set_site_brand_tokens op below — so every color edit goes through an
// auditable, revertible, maker-restrictable theme object. Exactly the
// set_product_fields ⇸ set_product_price funnel, applied to the site.
const setSiteFieldsSchema = z.strictObject({
  op: z.literal('set_site_fields'),
  fields: fieldsSchema
    .superRefine(forbidKeys(['brandTokens'], 'set_site_fields (the palette changes only via site_apply_theme)'))
    .superRefine(
      forbidKeys(
        ['brandImagery'],
        'set_site_fields (the visual-identity contract changes only via the privileged set_site_brand_imagery op)'
      )
    )
    .superRefine(forbidKeys(['tracking'], 'set_site_fields (tracking changes only via set_tracking)')),
  ...guard,
});

// The palette WRITER — the exact complement of set_site_fields' refusal:
// `fields` carries ONLY `brandTokens`. Constructed by the `site_apply_theme`
// verb (which copies a theme's tokens with exact-replace semantics) and by
// inverse derivation (the Discard path — "revert the theme"); marked
// agent_authored: false in the contract. Kept fields-shaped so its inverse is
// this same op with the captured before-tree, and so the body-level
// brand_token_values / theme_token_keys safety criteria gate it unchanged.
const setSiteBrandTokensSchema = z.strictObject({
  op: z.literal('set_site_brand_tokens'),
  fields: z.strictObject({ brandTokens: fieldsSchema }),
  ...guard,
});

// brandImagery's privileged writer (W16 C1) — the exact same funnel shape as
// set_site_brand_tokens: `fields` carries ONLY `brandImagery`, hand-authoring
// via object_patch is refused (PRIVILEGED_PATCH_OPS below), and the inverse is
// this same op with the captured before-tree. No verb constructs it yet (a
// follow-up task wires the writer that reads it into prompt assembly); it
// exists now so the grammar, discard/inverse handling, and write-time
// protection land in the same change as the site.v1 field.
//
// Unlike brandTokens (body-required, so its capture.before is always an
// object), brandImagery is body-OPTIONAL — a site's first-ever grant of it
// captures `before: null` (the unset marker). The pinned type here allows
// that top-level null alongside the ordinary object-merge shape so the
// inverse of a first set (a full unset) re-parses through this same op.
const setSiteBrandImagerySchema = z.strictObject({
  op: z.literal('set_site_brand_imagery'),
  fields: z.strictObject({ brandImagery: z.union([fieldsSchema, z.null()]) }),
  ...guard,
});

// ——— Product (06-shop-module-plan §1/§3) ———

// Deep-merge over the product body, like set_site_fields — with the §3
// canonicality funnel enforced at the grammar: the price display cache and
// the Stripe linkage (live + test mirror) are NOT agent-patchable. The ONLY
// price-edit path is the `product_set_price` MCP tool (S3), which creates the
// new Stripe Price server-side and writes linkage + cache in one governed
// patch — so drift between what an agent set and what Stripe charges is
// impossible by construction. Until that tool ships, price/linkage are set at
// object_create only.
const setProductFieldsSchema = z.strictObject({
  op: z.literal('set_product_fields'),
  fields: fieldsSchema
    .superRefine((value, ctx) => {
      const commerce = value.commerce;
      if (commerce === null) {
        ctx.addIssue({ code: 'custom', message: "'commerce' cannot be unset (products always carry it)." });
        return;
      }
      if (commerce === undefined || typeof commerce !== 'object' || Array.isArray(commerce)) return;
      for (const key of ['price', 'stripe', 'stripe_test'] as const) {
        if (key in commerce) {
          ctx.addIssue({
            code: 'custom',
            message: `'commerce.${key}' cannot be patched via set_product_fields — prices and Stripe linkage change only through product_set_price (§3).`,
          });
        }
      }
    })
    .superRefine(forbidKeys(['tracking'], 'set_product_fields (tracking changes only via set_tracking)')),
  ...guard,
});

// The §3 price-funnel WRITER — the exact complement of set_product_fields'
// refusal: `fields` may touch ONLY commerce.price / commerce.stripe /
// commerce.stripe_test, all shape-pinned. Constructed by the
// `product_set_price` MCP tool (which creates the new Stripe Price and
// archives the old one in the same move) and by inverse derivation (the
// Discard path — "re-point to the archived price", §3); marked
// agent_authored: false in the contract. Kept fields-shaped so its inverse
// is this same op with the captured before-tree.
const setProductPriceSchema = z.strictObject({
  op: z.literal('set_product_price'),
  fields: z.strictObject({
    commerce: z.strictObject({
      price: z
        .union([
          z.strictObject({
            amount_cents: z.number().int().positive(),
            currency: z.string().regex(/^[a-z]{3}$/),
          }),
          z.null(),
        ])
        .optional(),
      stripe: z
        .union([
          z.strictObject({
            product_id: z.string().regex(/^prod_[A-Za-z0-9]+$/),
            price_id: z.union([z.string().regex(/^price_[A-Za-z0-9]+$/), z.null()]).optional(),
          }),
          z.null(),
        ])
        .optional(),
      stripe_test: z
        .union([
          z.strictObject({
            product_id: z.string().regex(/^prod_[A-Za-z0-9]+$/),
            price_id: z.union([z.string().regex(/^price_[A-Za-z0-9]+$/), z.null()]).optional(),
          }),
          z.null(),
        ])
        .optional(),
    }),
  }),
  ...guard,
});

// ——— Content items / articles (08-articles-plan §2.2, W7.3) ———
//
// The node family mirrors the section family exactly: an article body is an
// ordered list of annotated nodes keyed by opaque `n_*` ids, and every op is
// invertible with the same element/fields/move capture mechanics. The
// annotation layer (private.strategy/intent, commercial, rendering, chat) is
// ordinary node data — `update_node` deep-merges over the WHOLE node, so
// "mark this block a hook" is one op: {fields: {private: {strategy: 'hook'}}}.

const setArticleMetaSchema = z
  .strictObject({
    op: z.literal('set_article_meta'),
    fields: fieldsSchema
      .superRefine(forbidKeys(['nodes'], 'set_article_meta (use the node ops)'))
      .superRefine(forbidKeys(['tracking'], 'set_article_meta (tracking changes only via set_tracking)')),
    ...guard,
  })
  .describe('Merge article meta fields (title/slug/author/taxonomy/seo/scores/…); nodes are edited only via node ops.');

const upsertNodeSchema = z.strictObject({
  op: z.literal('upsert_node'),
  node: nodePayloadSchema,
  // Insert position; ignored when a node with the same id already exists
  // (replace happens in place). Clamped to the array bounds.
  position: positionSchema.optional(),
  ...guard,
});

const updateNodeSchema = z.strictObject({
  op: z.literal('update_node'),
  node_id: z.string().regex(NODE_ID_RE),
  // Deep-merges over the node envelope itself (public/private/commercial/
  // rendering/chat/visibility) — null unsets, per the grammar rules above.
  fields: fieldsSchema.superRefine(forbidKeys(['id'], 'update_node (node ids are stable)')),
  ...guard,
});

const moveNodeSchema = z.strictObject({
  op: z.literal('move_node'),
  node_id: z.string().regex(NODE_ID_RE),
  to_index: positionSchema,
  ...guard,
});

const setNodeVisibilitySchema = z.strictObject({
  op: z.literal('set_node_visibility'),
  node_id: z.string().regex(NODE_ID_RE),
  // Article nodes have THREE visibility states (public/internal/hidden,
  // article-content-v1); null restores the unset default (= public), so the
  // inverse of setting visibility on a bare node is exact.
  visibility: z.union([z.enum(['public', 'internal', 'hidden']), z.null()]),
  ...guard,
});

const removeNodeSchema = z.strictObject({
  op: z.literal('remove_node'),
  node_id: z.string().regex(NODE_ID_RE),
  ...guard,
});

// ——— Template (C§2.0) ———

const setTemplateMetaSchema = z.strictObject({
  op: z.literal('set_template_meta'),
  fields: fieldsSchema
    .superRefine(forbidKeys(['slots'], 'set_template_meta (use the slot ops)'))
    .superRefine(forbidKeys(['tracking'], 'set_template_meta (tracking changes only via set_tracking)')),
  ...guard,
});

const upsertSlotSchema = z.strictObject({
  op: z.literal('upsert_slot'),
  slot: templateSlotPayloadSchema,
  position: positionSchema.optional(),
  ...guard,
});

const moveSlotSchema = z.strictObject({
  op: z.literal('move_slot'),
  slot_id: z.string().min(1),
  to_index: positionSchema,
  ...guard,
});

const removeSlotSchema = z.strictObject({
  op: z.literal('remove_slot'),
  slot_id: z.string().min(1),
  ...guard,
});

// ——— Section template (W8, 09-template-system-plan §2.3) ———
//
// A section_template body wraps exactly ONE blueprint (a full SectionInstance),
// so the family mirrors the shared-section wrapper's ops rather than a list
// family: meta fields, whole-blueprint replacement, and deep-merge over the
// blueprint's data. Changing the blueprint's TYPE is replace_blueprint with a
// new {type, data} — a whole-instance swap re-validates the union member.

const setSectionTemplateMetaSchema = z.strictObject({
  op: z.literal('set_section_template_meta'),
  fields: fieldsSchema
    .superRefine(forbidKeys(['blueprint'], 'set_section_template_meta (use the blueprint ops)'))
    .superRefine(forbidKeys(['tracking'], 'set_section_template_meta (tracking changes only via set_tracking)')),
  ...guard,
});

const replaceBlueprintSchema = z.strictObject({
  op: z.literal('replace_blueprint'),
  // The blueprint's s_* id is a placeholder (re-minted at instantiation);
  // omit it to have the endpoint mint one (MINTED_ID_FIELD).
  blueprint: sectionPayloadSchema,
  ...guard,
});

const updateBlueprintDataSchema = z.strictObject({
  op: z.literal('update_blueprint_data'),
  fields: fieldsSchema,
  ...guard,
});

// ——— Theme (W8.3, 09-template-system-plan §6) ———

// The set_site_fields idiom: deep-merge over the theme body (null unsets).
// The whole surface is one op — `tokens` is an open color record + a strict
// fonts trio + the T10.1 bounded axis groups, exactly siteBodySchema's
// brandTokens (one shared shape — axis enums validate at the body-schema
// level after merge, so this generic fields bag picks them up with zero
// hand-written drift). Applying a theme to the site is NOT a theme op:
// `site_apply_theme` computes ONE exact-replace set_site_brand_tokens op
// (colors, fonts, and axes — omitted axes unset) under the caller's site
// checkout.
const setThemeFieldsSchema = z.strictObject({
  op: z.literal('set_theme_fields'),
  fields: fieldsSchema.superRefine(
    forbidKeys(['tracking'], 'set_theme_fields (tracking changes only via set_tracking)')
  ),
  ...guard,
});

// ——— Tracking (W13, 12-object-tracking-and-analytics §2) ———

// The ONE writer of the shared `tracking` body attribute, uniform across all
// ten types (set_nav_meta is hand-pinned strict; taxonomy/section have no
// body-fields op — so piggybacking was impossible in three places, and one
// op keeps the contract story identical everywhere). Deep-merge into
// body.tracking (null-inside-fields unsets a key; arrays replace wholesale —
// goals[] has no stale-key trap). Top-level `fields: null` removes
// body.tracking entirely, so the inverse of a first-set on a bare object is
// exact — no prune machinery needed. Agent-submittable (NOT privileged);
// each type's normal publish gate still applies.
const setTrackingSchema = z.strictObject({
  op: z.literal('set_tracking'),
  fields: z.union([fieldsSchema, z.null()]),
  ...guard,
});

// ——— Tracking config (W13, 12-plan §3) ———

// The set_site_fields idiom for the tracker registry singleton: open
// deep-merge over the whole body (null unsets), NO forbidKeys — providers is
// a fixed-key strict object, so plain merge edits one provider block without
// upsert ops, and the body schema (regex-pinned IDs, env-var NAMES, the
// gtm-permanently-out refinement) gates the merged result. Inverse = the
// captured before-tree. This type does NOT get set_tracking and does NOT
// carry the per-object tracking attribute — it is the registry the
// attribute's goals resolve against.
const setTrackingConfigFieldsSchema = z.strictObject({
  op: z.literal('set_tracking_config_fields'),
  fields: fieldsSchema,
  ...guard,
});

// ——— Editorial voice (D1, 2026-07-28) ———

// The tracking_config idiom for the voice singleton: ONE open deep-merge op
// over the whole body (null unsets), no forbidKeys. A voice has no repeated
// child collection needing stable ids the way taxonomy terms or nav items do —
// `frameworks[]` is a small declared set that replaces wholesale, so upsert/
// move/remove ops would be ceremony without a guarantee. The body schema
// (strict shape, fw_ id regex, default_framework ∈ frameworks[]) and the
// voice_not_a_prompt constraint gate the MERGED result, so a partial edit can
// never leave the voice pointing at a framework it no longer declares.
// Inverse = the captured before-tree. Agent-submittable; the type's publish
// gate still applies.
const setVoiceFieldsSchema = z.strictObject({
  op: z.literal('set_voice_fields'),
  fields: fieldsSchema,
  ...guard,
});

// ——— Visual standard (brand-imagery wave, BRIEF.md §3.1) ———

// The set_voice_fields idiom, verbatim: ONE open deep-merge op over the whole
// body (null unsets), no forbidKeys. Unlike site.brandImagery's privileged
// funnel, `brandImagery` HERE is ordinary agent-writable — the governed thing
// is the site's APPLIED copy (set_site_brand_imagery), not this proposal a
// writer/human is still iterating on. `references[]`/`sampleSubjects[]` are
// small declared sets that replace wholesale on a partial merge — exactly the
// editorial_voice `frameworks[]` posture, for the same reason (upsert/move/
// remove ops would be ceremony without a guarantee a mood board needs).
// Inverse = the captured before-tree. Agent-submittable; NOT privileged.
const setVisualStandardFieldsSchema = z.strictObject({
  op: z.literal('set_visual_standard_fields'),
  fields: fieldsSchema,
  ...guard,
});

// ——— The grammar ———

// Union members stay plain object schemas (a zod discriminated-union
// requirement); cross-field rules live in the top-level superRefine below.
// Exported so the MCP object-contract serializer can enumerate per-op argument
// schemas (`.options`, keyed by each op's `op` literal) — `patchOpSchema` wraps
// this in a `.superRefine`, which hides `.options`.
export const patchOpUnionSchema = z.discriminatedUnion('op', [
  setPageMetaSchema,
  upsertSectionSchema,
  updateSectionDataSchema,
  moveSectionSchema,
  setSectionVisibilitySchema,
  removeSectionSchema,
  setNavMetaSchema,
  upsertGroupSchema,
  moveGroupSchema,
  removeGroupSchema,
  upsertItemSchema,
  updateItemSchema,
  moveItemSchema,
  removeItemSchema,
  upsertActionSchema,
  removeActionSchema,
  addTermSchema,
  updateTermSchema,
  deprecateTermSchema,
  reactivateTermSchema,
  removeTermSchema,
  setSiteFieldsSchema,
  setSiteBrandTokensSchema,
  setSiteBrandImagerySchema,
  setProductFieldsSchema,
  setProductPriceSchema,
  setArticleMetaSchema,
  upsertNodeSchema,
  updateNodeSchema,
  moveNodeSchema,
  setNodeVisibilitySchema,
  removeNodeSchema,
  setTemplateMetaSchema,
  upsertSlotSchema,
  moveSlotSchema,
  removeSlotSchema,
  setSectionTemplateMetaSchema,
  replaceBlueprintSchema,
  updateBlueprintDataSchema,
  setThemeFieldsSchema,
  setTrackingSchema,
  setTrackingConfigFieldsSchema,
  setVoiceFieldsSchema,
  setVisualStandardFieldsSchema,
]);

const requireMergedIntoOnlyWhenDeprecated = (term: TermPayload, ctx: z.RefinementCtx, path: (string | number)[]) => {
  if (term.merged_into !== undefined && (term.status ?? 'active') !== 'deprecated') {
    // An active term with a merge target is not a state the status ops can
    // reach or invert; keep it unmintable.
    ctx.addIssue({ code: 'custom', path, message: 'merged_into requires status deprecated.' });
  }
};

export const patchOpSchema = patchOpUnionSchema.superRefine((op, ctx) => {
  if (op.op === 'add_term') {
    requireMergedIntoOnlyWhenDeprecated(op.term, ctx, ['term']);
  }
  if (op.op === 'update_term' && op.restore_alias !== undefined) {
    requireMergedIntoOnlyWhenDeprecated(op.restore_alias.term, ctx, ['restore_alias', 'term']);
  }
  if (op.op === 'update_term') {
    if (
      op.fields.slug === undefined &&
      (op.alias_term_id !== undefined ||
        op.mint_alias !== undefined ||
        op.restore_alias !== undefined ||
        op.consume_alias_expected !== undefined)
    ) {
      ctx.addIssue({
        code: 'custom',
        message:
          'alias_term_id/mint_alias/restore_alias/consume_alias_expected are only meaningful when fields.slug is present.',
      });
    }
    if (op.restore_alias !== undefined && op.mint_alias !== false) {
      // Minting an alias for the vacated slug AND restoring one for the same
      // slug would double-claim it; restores only travel with mint_alias: false.
      ctx.addIssue({ code: 'custom', message: 'restore_alias requires mint_alias: false.' });
    }
    if (op.consume_alias_expected !== undefined && op.mint_alias !== false) {
      // Consumption expectations describe reverts; the organic (minting)
      // path consumes without an expectation by design.
      ctx.addIssue({ code: 'custom', message: 'consume_alias_expected requires mint_alias: false.' });
    }
  }
});

export type PatchOp = z.infer<typeof patchOpSchema>;
export type PatchOpName = PatchOp['op'];
export type PatchOpOfName<TName extends PatchOpName> = Extract<PatchOp, { op: TName }>;

export const patchOpsSchema = z.array(patchOpSchema);

// ——— Which object types accept which ops (C§2.0 families / C§2.2 matrix) ———
//
// A shared 'section' object is "a one-section page record in practice"
// (C§2.3-section): its body wraps exactly one SectionInstance, so it accepts
// the payload/visibility ops and whole-section replacement, but not
// move/remove (there is no list) and no page meta.
//
// content_item accepts the node family (W7.3, 08-articles-plan §2.2): the
// article body is an ordered list of annotated nodes, edited exactly the way
// a page's sections are — set_article_meta owns everything except `nodes`.
export const patchOpNamesByObjectType: Record<ObjectType, readonly PatchOpName[]> = {
  page: [
    'set_page_meta',
    'upsert_section',
    'update_section_data',
    'move_section',
    'set_section_visibility',
    'remove_section',
    'set_tracking',
  ],
  section: ['upsert_section', 'update_section_data', 'set_section_visibility', 'set_tracking'],
  navigation: [
    'set_nav_meta',
    'upsert_group',
    'move_group',
    'remove_group',
    'upsert_item',
    'update_item',
    'move_item',
    'remove_item',
    'upsert_action',
    'remove_action',
    'set_tracking',
  ],
  taxonomy: ['add_term', 'update_term', 'deprecate_term', 'reactivate_term', 'remove_term', 'set_tracking'],
  site: ['set_site_fields', 'set_tracking'],
  template: ['set_template_meta', 'upsert_slot', 'move_slot', 'remove_slot', 'set_tracking'],
  section_template: ['set_section_template_meta', 'replace_blueprint', 'update_blueprint_data', 'set_tracking'],
  theme: ['set_theme_fields', 'set_tracking'],
  product: ['set_product_fields', 'set_product_price', 'set_tracking'],
  content_item: [
    'set_article_meta',
    'upsert_node',
    'update_node',
    'move_node',
    'set_node_visibility',
    'remove_node',
    'set_tracking',
  ],
  tracking_config: ['set_tracking_config_fields'],
  // No set_tracking: a voice is authoring law, never a tracked surface (the
  // tracking_config precedent).
  editorial_voice: ['set_voice_fields'],
  // No set_tracking: a mood board is never a reader-facing surface (the same
  // exemption, same reason).
  visual_standard: ['set_visual_standard_fields'],
};

export const isPatchOpAllowedForObjectType = (objectType: ObjectType, opName: PatchOpName): boolean =>
  (patchOpNamesByObjectType[objectType] as readonly string[]).includes(opName);

// Ops that are valid in the grammar but NOT in any type's agent-facing
// allowlist: they exist ONLY as the output of a privileged verb (and its
// inverse, re-applied on Discard). `set_site_brand_tokens` is the palette
// writer — a hand-authored one via object_patch is refused (op_not_applicable),
// so the site palette changes solely through site_apply_theme (theme-only
// governance, Wolf 2026-07-15). `set_site_brand_imagery` (W16 C1) is the same
// funnel for the visual-identity contract — no verb produces it yet, but
// hand-authoring it is refused the same way so the field can never become an
// ordinary agent-writable one by accident. Unlike set_product_price (which
// stays agent-submittable and leans on the product review gate), the site is
// autonomous, so the op itself must be un-submittable. applyPatchOps accepts
// these only when a caller passes them as `privilegedOps`.
export const PRIVILEGED_PATCH_OPS: readonly PatchOpName[] = ['set_site_brand_tokens', 'set_site_brand_imagery'];
