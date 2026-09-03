/**
 * Ask-AI tool-schema derivation (T1.6).
 *
 * The legacy article Ask-AI (admin-ask-ai-node.ts, A§1.4, retired T9.24)
 * hand-wrote the forced tool's `input_schema` as a literal listing the
 * editable node.public fields. That was exactly the per-type-agreement cost
 * the CMS design set out to remove (A§1.9): a seventh object type would mean
 * a seventh hand-maintained schema.
 *
 * Instead, the tool schema is DERIVED from the object type's own zod body
 * schema (the T0.2 modules) at request time. `deriveAskAiToolSchema` takes any
 * zod schema and produces a provider-agnostic forced-tool descriptor
 * (`{name, description, input_schema}` — plain JSON Schema, which the caller
 * hands to OpenAI as a function's `parameters`) — so adding a new object type
 * needs nothing here beyond its zod schema existing. The function
 * is deliberately type-agnostic; the only thing that knows the concrete types
 * is the `ASK_AI_BODY_SCHEMAS` registry below, which simply re-exports the
 * T0.2 schemas (content_item joined at W7.8 — whole-object asks serve the
 * admin surface; the canvas asks node-scoped via ask-ai-object.ts).
 *
 * "Partial" is the whole point: the AI returns ONLY the fields it changed, the
 * same contract the article tool states ("include only fields that should
 * change"). Dropping top-level `required` (via zod's `.partial()` where the
 * schema supports it, else by deleting the `required` array) encodes that.
 */
import { z } from 'zod';

import { contentItemBodySchema } from '../../schema/bodies/content-item-v1.js';
import { navigationBodySchema } from '../../schema/bodies/navigation-v1.js';
import { pageBodySchema } from '../../schema/bodies/page-v1.js';
import { productBodySchema } from '../../schema/bodies/product-v1.js';
import { sectionBodySchema, sectionInstanceSchema } from '../../schema/bodies/section-v1.js';
import { sectionTemplateBodySchema } from '../../schema/bodies/section-template-v1.js';
import { siteBodySchema } from '../../schema/bodies/site-v1.js';
import { taxonomyBodySchema } from '../../schema/bodies/taxonomy-v1.js';
import { templateBodySchema } from '../../schema/bodies/template-v1.js';
import { trackingConfigBodySchema } from '../../schema/bodies/tracking-config-v1.js';
import { themeBodySchema } from '../../schema/bodies/theme-v1.js';
import { editorialVoiceShapeSchema } from '../../schema/bodies/editorial-voice-v1.js';
import { visualStandardShapeSchema } from '../../schema/bodies/visual-standard-v1.js';
import type { ObjectType } from '../../schema/object-record-v1.js';

export type JsonSchema = Record<string, unknown>;

export interface AskAiTool {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Object types the generic Ask-AI serves — all nine since W7.3/W7.8. */
export type AskAiObjectType = ObjectType;

/**
 * Registry of T0.2 body schemas keyed by object type. This is the ONLY place a
 * concrete type list appears; `deriveAskAiToolSchema` itself never enumerates
 * types. A new type is registered here once its T0.2 schema exists — the
 * derivation code is untouched (the T1.6 acceptance property). content_item
 * joined at W7.8: whole-object asks serve the admin surface; the canvas asks
 * node-scoped (ask-ai-object.ts) against the node PUBLIC grammar.
 */
export const ASK_AI_BODY_SCHEMAS = {
  page: pageBodySchema,
  section: sectionBodySchema,
  navigation: navigationBodySchema,
  taxonomy: taxonomyBodySchema,
  site: siteBodySchema,
  template: templateBodySchema,
  section_template: sectionTemplateBodySchema,
  theme: themeBodySchema,
  product: productBodySchema,
  content_item: contentItemBodySchema,
  tracking_config: trackingConfigBodySchema,
  editorial_voice: editorialVoiceShapeSchema,
  // FIX-E: the unrefined SHAPE, exactly like editorial_voice above — zod
  // refuses `.partial()` on a schema carrying `.refine()`, which
  // `visualStandardBodySchema` now does (status/sampleSubjects invariant).
  visual_standard: visualStandardShapeSchema,
} satisfies Record<AskAiObjectType, z.ZodType>;

export const isAskAiObjectType = (value: string): value is AskAiObjectType =>
  Object.prototype.hasOwnProperty.call(ASK_AI_BODY_SCHEMAS, value);

export const bodySchemaForObjectType = (objectType: string): z.ZodType | undefined =>
  isAskAiObjectType(objectType) ? ASK_AI_BODY_SCHEMAS[objectType] : undefined;

/**
 * The `data` schema of one section-instance union member (section.v1), for
 * SECTION-SCOPED Ask-AI: when the editor asks about one section of a page,
 * the forced tool is derived from that section type's own data shape instead
 * of the whole page body — the model sees a small, exact grammar and its
 * partial answer maps 1:1 onto an `update_section_data` patch op. Generic by
 * construction: reads the discriminated union, never enumerates types, so a
 * new section type is served the moment its union member exists.
 */
export const sectionDataSchemaForType = (sectionType: string): z.ZodType | undefined =>
  sectionInstanceSchema.options.find((option) => option.shape.type.value === sectionType)?.shape.data;

const hasPartial = (schema: z.ZodType): schema is z.ZodType & { partial: () => z.ZodType } =>
  typeof (schema as { partial?: unknown }).partial === 'function';

export interface DeriveAskAiToolOptions {
  /** Forced-tool name; defaults to a stable generic name. */
  toolName?: string;
  /** Tool description shown to the model. */
  description?: string;
  /**
   * Remove protected (non-copy) fields — media/asset/reference/structure — from
   * the schema so the model can only edit text. Set for the edit-mode canvas
   * (section-scoped) path, where a copy edit must never touch an image or link;
   * left off for whole-object admin asks, which are a deliberate review surface.
   */
  protectFields?: boolean;
}

const DEFAULT_TOOL_NAME = 'propose_object_changes';
const DEFAULT_DESCRIPTION =
  'Return ONLY the fields of this object that should change to satisfy the instruction. ' +
  'Omit every field that stays the same. Preserve the existing voice, tone, and structure.';

/**
 * Fields the copy-editing Ask-AI must NEVER be able to change: media/asset
 * URLs (portrait, *AssetRef, logo, icon, ogImage…), object references and
 * bindings (source, products, contentItem, section, formName, actions/links
 * targets…), and structure/routing/config (route, pageType, sections, slug,
 * anchor, brandTokens…). None of these are "copy", and an LLM hallucinates
 * them — the 2026-07-12 About-portrait incident: asked to edit a heading, the
 * model also swapped a working local image for a made-up CDN URL, which broke
 * the page on publish. These keys are stripped from the tool schema (so the
 * model can't propose them) AND defensively from the returned suggestion
 * (ask-ai-object.ts). Changing an image/link is a deliberate action, never an
 * AI side-effect of a copy edit.
 */
const PROTECTED_FIELD_NAME_RE = /asset|image|portrait|logo|icon|favicon|media|src|url|href|ogimage/i;
const PROTECTED_FIELD_NAMES = new Set([
  'source',
  'products',
  'contentItem',
  'section',
  'formName',
  'indexRoute',
  'actions',
  'links',
  'action',
  'link',
  'target',
  'page_ref',
  'commerce',
  'fulfillment',
  'stripe',
  'stripe_test',
  'availability',
  'route',
  'pageType',
  'template',
  'navigationOverrides',
  'sections',
  'defaultNavigation',
  'urls',
  'blog',
  'brandTokens',
  'brandImagery',
  'chrome',
  'metadataDefaults',
  'slug',
  'anchor',
  'robots',
  // Article node public fields (W7.8): the CTA destination is a link, and the
  // node list is structure — copy asks never touch either.
  'ctaLink',
  'nodes',
]);

/** True when a field must not be rewritten by the copy-editing Ask-AI (see above). */
export const isProtectedAskAiField = (key: string): boolean =>
  PROTECTED_FIELD_NAME_RE.test(key) || PROTECTED_FIELD_NAMES.has(key);

/**
 * Derive a forced-tool descriptor from ANY zod schema. Generic by
 * construction: no per-type branching, so a new object type is served the
 * moment its zod schema exists (T1.6 acceptance property). With
 * `protectFields`, protected fields (isProtectedAskAiField —
 * media/asset/reference/structure) are removed from the properties so the
 * model literally cannot propose changing them.
 */
export const deriveAskAiToolSchema = (bodySchema: z.ZodType, options: DeriveAskAiToolOptions = {}): AskAiTool => {
  // The AI proposes a partial (only changed fields). `.partial()` drops the
  // top-level `required` list for object schemas; schemas that can't be made
  // partial (e.g. a union) fall through and have any `required` stripped below.
  const source = hasPartial(bodySchema) ? bodySchema.partial() : bodySchema;

  const jsonSchema = z.toJSONSchema(source, { unrepresentable: 'any', io: 'input' }) as JsonSchema;

  // The tool input_schema is a plain JSON Schema object (used verbatim as an
  // OpenAI function's `parameters`); the $schema dialect marker is noise
  // there. Strip it and any residual top-level
  // `required` (belt-and-suspenders for the non-partial fallback).
  delete jsonSchema.$schema;
  delete jsonSchema.required;

  // Copy-only (canvas): remove protected (non-copy) fields so the model can
  // only edit text — an image/link/reference is never changed by a copy edit.
  const properties = jsonSchema.properties as Record<string, unknown> | undefined;
  if (options.protectFields && properties) {
    for (const key of Object.keys(properties)) {
      if (isProtectedAskAiField(key)) delete properties[key];
    }
  }

  return {
    name: options.toolName ?? DEFAULT_TOOL_NAME,
    description: options.description ?? DEFAULT_DESCRIPTION,
    input_schema: jsonSchema,
  };
};

/** Convenience: derive the tool for a registered object type, or undefined if unknown. */
export const deriveAskAiToolForObjectType = (
  objectType: string,
  options?: DeriveAskAiToolOptions
): AskAiTool | undefined => {
  const schema = bodySchemaForObjectType(objectType);
  return schema ? deriveAskAiToolSchema(schema, options) : undefined;
};
