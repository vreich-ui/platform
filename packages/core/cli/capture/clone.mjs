/**
 * T13.1 clone_conductor engine — Side A (CLONE-ENGINE-API.md).
 *
 * Pure functions only: no network, no fs, no Date.now(), no Math.random(). Everything a caller needs
 * that isn't already an argument (site/registry state, prior-stage reports) is READ, never fetched,
 * because determinism is the whole point of this module — the same intake replayed twice must produce
 * the same plan twice, so a re-run is inspectable and idempotent (T13.1's `requestedId` scheme below
 * depends on it).
 *
 * VOCABULARY (CLONE-ENGINE-API.md): a **recipe** (`section_template` / `template`) is DATA — an agent
 * may design and mint one. A **section type** is CODE — an `.astro` component + its Zod variant.
 * Nothing in this file creates, renames, or synthesizes one; every section-type name this module
 * accepts is checked against the LIVE registry handed in via `intake.registry`, never against a
 * compile-time list — the live registry is the only thing allowed to say a type exists.
 */
import { createHash } from 'node:crypto';

const sha = (value, length = 16) => createHash('sha256').update(value).digest('hex').slice(0, length);
const clone = (value) => JSON.parse(JSON.stringify(value));
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

export class CloneError extends Error {}

// Mirrors emit.mjs's (unexported) FORBIDDEN_VERBS exactly. Duplicated rather than imported because
// emit.mjs does not export it and this module must stay a standalone, dependency-free pure library —
// but the SET must never drift, so keep the two in lockstep by hand whenever either changes.
const FORBIDDEN_VERBS = new Set(['object_publish', 'release_to_production', 'trigger_netlify_build', 'deploy']);

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 1. INTAKE
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * Correlate the mapping's page-level shape with what emission actually wrote, using ONLY what the
 * emission report already carries — this function never re-derives a requestedId scheme that lives
 * in emit.mjs (a private, unexported implementation detail there).
 *
 * emit.mjs's `executeEmission` builds its report as `{ ...plan, ...outcome fields }`, so a report
 * carries the ORIGINAL `creates` array — including each page create's `pageRef` and deterministic
 * `requestedId` — verbatim alongside the outcome. That is the one reliable join key: a page's final
 * objectId is either its own requestedId (when the target MCP honored it, the normal case for a fresh
 * create) or the objectId of a REUSED object at the same route (T12.28's rerun path, keyed by route
 * since a reused page has no requestedId of its own). A page that was quarantined at emission — its
 * requestedId appears in neither list — is simply not carried into the clone workspace: there is
 * nothing at that pageRef for later stages to restamp.
 */
function pagesEmitted(mapping, emissionReport) {
  const pageCreates = (emissionReport?.creates ?? []).filter(
    (entry) => entry?.objectType === 'page' && typeof entry?.pageRef === 'string'
  );
  if (pageCreates.length === 0) return [];
  const createdPageIds = new Set(
    (emissionReport?.createdObjects ?? []).filter((row) => row?.objectType === 'page').map((row) => row.objectId)
  );
  const reusedPageIdByRoute = new Map(
    (emissionReport?.reusedObjects ?? [])
      .filter((row) => row?.objectType === 'page' && typeof row?.route === 'string')
      .map((row) => [row.route, row.objectId])
  );
  const mappingPageByRef = new Map((mapping.pages ?? []).map((page) => [page.pageRef, page]));

  const pages = [];
  for (const entry of pageCreates) {
    const mappingPage = mappingPageByRef.get(entry.pageRef);
    const route = mappingPage?.pageBody?.route ?? entry.body?.route ?? null;
    const objectId = createdPageIds.has(entry.requestedId)
      ? entry.requestedId
      : (route && reusedPageIdByRoute.get(route)) || null;
    if (!objectId) continue;
    const sectionTypes = [...new Set((mappingPage?.pageBody?.sections ?? []).map((section) => section.type))].sort();
    pages.push({ pageRef: entry.pageRef, objectId, route, sectionTypes });
  }
  return pages;
}

/** `registry_get(registry:'component')`'s `definitions` reduced to `{ [type]: dataSchema }`. Field
 *  names (`type`, `data_schema`) matched against the real handler, `callRegistryGet` ->
 *  `listSectionTypeContracts()` in packages/core/lib/registry/object-contract.ts — not guessed. */
function sectionTypesFromRegistry(componentRegistry) {
  const definitions = Array.isArray(componentRegistry) ? componentRegistry : (componentRegistry?.definitions ?? []);
  const sectionTypes = {};
  for (const definition of definitions) {
    if (typeof definition?.type !== 'string' || !definition.type) continue;
    sectionTypes[definition.type] = clone(definition.data_schema ?? definition.dataSchema ?? null);
  }
  return sectionTypes;
}

/** `registry_get(registry:'page_type')`'s `definitions` reduced to `{ [pageType]: {allowed, required} }`.
 *  Field names (`id`, `allowedSections`, `requiredSections`) matched against the real
 *  `PageTypeDefinition` shape in packages/core/lib/registry/page-types.ts (`listPageTypeDefinitions`)
 *  — not guessed. */
function pageTypesFromRegistry(pageTypeRegistry) {
  const definitions = Array.isArray(pageTypeRegistry) ? pageTypeRegistry : (pageTypeRegistry?.definitions ?? []);
  const pageTypes = {};
  for (const definition of definitions) {
    if (typeof definition?.id !== 'string' || !definition.id) continue;
    const allowedSections = definition.allowedSections ?? definition.allowed_sections;
    const requiredSections = definition.requiredSections ?? definition.required_sections ?? [];
    pageTypes[definition.id] = {
      allowed: allowedSections === 'any' ? 'any' : clone(Array.isArray(allowedSections) ? allowedSections : []),
      required: clone(Array.isArray(requiredSections) ? requiredSections : []),
    };
  }
  return pageTypes;
}

/**
 * Assemble the clone workspace envelope from already-fetched pieces (CLONE-ENGINE-API.md §1).
 *
 * This is intake, not discovery: every argument is a value the CALLER already fetched (an emission
 * report, an inventory listing, a `registry_get` response). Nothing here reaches out for anything —
 * that is exactly what makes it safe to call repeatedly while a Side-B node retries.
 */
export function buildCloneIntake({
  captureRunId,
  target,
  snapshot,
  mapping,
  theme,
  emissionReport,
  inventory,
  componentRegistry,
  pageTypeRegistry,
  policy,
}) {
  if (!target || typeof target !== 'string') throw new CloneError('A named clone target is required.');
  if (!captureRunId || typeof captureRunId !== 'string') {
    throw new CloneError('A captureRunId is required to bind this workspace to the capture run it clones.');
  }
  if (mapping?.schemaVersion !== 'capture-map.v1')
    throw new CloneError('Clone intake requires a capture-map.v1 mapping.');

  const sectionTypes = sectionTypesFromRegistry(componentRegistry);
  // "Nothing here may create a section type" only means anything if the registry that says what
  // EXISTS is trustworthy. An empty component registry is not "no section types happen to be
  // registered" (that never happens on a live platform) — it is a caller that forgot to fetch it, and
  // every REJECT rule in step 2 depends on this map being real. Fail closed rather than silently
  // validating every design against nothing and accepting all of them.
  if (Object.keys(sectionTypes).length === 0) {
    throw new CloneError('Clone intake requires a non-empty component registry; every recipe validation reads it.');
  }
  const pageTypes = pageTypesFromRegistry(pageTypeRegistry);

  const siteRows = Array.isArray(inventory?.site) ? inventory.site : [];
  const activeSites = siteRows.filter((row) => row?.object_type === 'site' && row?.status === 'active');
  if (activeSites.length !== 1) {
    throw new CloneError(
      `Clone intake requires exactly one active site object in inventory; found ${activeSites.length}.`
    );
  }

  return {
    schemaVersion: 'clone-intake.v1',
    captureRunId,
    target,
    source: { snapshot: clone(snapshot ?? null), mapping: clone(mapping), theme: clone(theme ?? null) },
    emitted: { report: clone(emissionReport ?? null), pages: pagesEmitted(mapping, emissionReport) },
    inventory: {
      page: clone(inventory?.page ?? []),
      template: clone(inventory?.template ?? []),
      section_template: clone(inventory?.section_template ?? []),
      theme: clone(inventory?.theme ?? []),
      navigation: clone(inventory?.navigation ?? []),
      // Collapsed to the ONE row, not the array it came in as — every later stage (theme bind,
      // review-queue assembly) needs "the site", and re-deriving the singleton from an array at every
      // call site is exactly the kind of repeated judgment call this envelope exists to make once.
      site: clone(activeSites[0]),
    },
    registry: { sectionTypes, pageTypes },
    policy: clone(policy ?? null),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. RECIPE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

function resolveRef(node, rootSchema) {
  if (!isPlainObject(node) || typeof node.$ref !== 'string') return node;
  if (!node.$ref.startsWith('#/')) return node;
  let target = rootSchema;
  for (const part of node.$ref.slice(2).split('/')) {
    target = isPlainObject(target) ? target[part] : undefined;
  }
  return isPlainObject(target) ? resolveRef(target, rootSchema) : node;
}

/**
 * Structural-only re-validation of `value` against one live section type's JSON-schema fragment.
 *
 * Deliberately NOT a full JSON-schema engine. CLONE-ENGINE-API.md asks for exactly three checks —
 * required keys present, no unknown key where the schema forbids it, enum members legal — because
 * full semantic validation (string formats, numeric bounds, cross-field refinements) is
 * `object_validate`'s job against the real zod schema server-side. Re-implementing that here in a
 * network-free module would either drift from the live schema the moment either side changes, or
 * require vendoring zod itself — both worse than the bounded, honest check the contract actually asks
 * for. A design that passes here can still be refused by `object_validate` later; a design that fails
 * here is refused before a single MCP call is made.
 */
function structuralErrors(value, schemaNode, rootSchema, path = 'data') {
  const schema = resolveRef(schemaNode, rootSchema);
  if (!isPlainObject(schema)) return [];
  const errors = [];

  if (Array.isArray(schema.enum)) {
    if (!schema.enum.includes(value))
      errors.push(`${path}: "${value}" is not a legal enum member (${schema.enum.join(', ')})`);
    return errors;
  }
  const branches = Array.isArray(schema.anyOf) ? schema.anyOf : Array.isArray(schema.oneOf) ? schema.oneOf : null;
  if (branches) {
    const branchErrors = branches.map((branch) => structuralErrors(value, branch, rootSchema, path));
    if (!branchErrors.some((list) => list.length === 0))
      errors.push(`${path}: value matches none of ${branches.length} legal shapes`);
    return errors;
  }
  if (schema.type === 'object' || isPlainObject(schema.properties)) {
    if (!isPlainObject(value)) {
      errors.push(`${path}: expected an object`);
      return errors;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) errors.push(`${path}.${key}: required key is missing`);
    }
    const properties = schema.properties ?? {};
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) errors.push(`${path}.${key}: key is not permitted by the schema`);
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (key in value) errors.push(...structuralErrors(value[key], propertySchema, rootSchema, `${path}.${key}`));
    }
    return errors;
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      errors.push(`${path}: expected an array`);
      return errors;
    }
    if (schema.items)
      value.forEach((item, index) =>
        errors.push(...structuralErrors(item, schema.items, rootSchema, `${path}.${index}`))
      );
    return errors;
  }
  // Scalars with no enum (string/number/boolean): structurally there is nothing further to say.
  return errors;
}

const recipeRowName = (row) =>
  row?.recipe?.name ?? row?.recipe_summary?.name ?? row?.recipeSummary?.name ?? row?.body?.name ?? row?.name ?? null;
const existingRecipeObjectId = (rows, name) => {
  const row = (rows ?? []).find((candidate) => recipeRowName(candidate) === name);
  return row ? (row.object_id ?? row.objectId ?? null) : null;
};

/** A deterministic placeholder section id. Re-minted at instantiation (section-template-v1.ts's own
 *  documented contract), so its exact value carries no meaning beyond "syntactically legal" — deriving
 *  it from the design's own name+type keeps it stable across a re-run without inventing content. */
const mintPlaceholderSectionId = (name, type) => `s_${sha(`${type}:${name}`, 10)}`;

/**
 * Total, deterministic re-validation of ONE designed section_template against the live registries
 * (CLONE-ENGINE-API.md §2). Returns `{ ok:true, normalized }` or `{ ok:false, reason, detail }` — it
 * NEVER coerces an invalid design into a valid one; a design this function cannot vouch for is
 * reported, not repaired.
 */
export function validateSectionTemplateDesign(design, intake) {
  if (!isPlainObject(design) || typeof design.name !== 'string' || !design.name.trim()) {
    throw new CloneError('A section_template design requires at least a name.');
  }
  const blueprint = design.blueprint;
  if (!isPlainObject(blueprint) || typeof blueprint.type !== 'string' || !blueprint.type) {
    throw new CloneError('A section_template design requires a blueprint naming its sectionType.');
  }

  // Reuse-first, same discipline as emit.mjs T12.28: a name collision is resolved by referencing the
  // object that already carries it, never by re-validating (and possibly rejecting) a design whose
  // shape the platform already has an answer for.
  if (existingRecipeObjectId(intake.inventory.section_template, design.name)) {
    return { ok: false, reason: 'name_collision', detail: `a section_template named "${design.name}" already exists` };
  }

  const dataSchema = intake.registry.sectionTypes[blueprint.type];
  if (dataSchema === undefined) {
    return {
      ok: false,
      reason: 'unknown_section_type',
      detail: `"${blueprint.type}" is not in the live component registry`,
    };
  }
  const errors = structuralErrors(blueprint.data ?? {}, dataSchema, dataSchema);
  if (errors.length > 0) return { ok: false, reason: 'blueprint_schema_mismatch', detail: errors };

  const normalized = clone(design);
  normalized.blueprint.id = normalized.blueprint.id || mintPlaceholderSectionId(design.name, blueprint.type);
  normalized.scope = normalized.scope || 'one_off';
  return { ok: true, normalized };
}

/**
 * Total, deterministic re-validation of ONE designed template against the live registries
 * (CLONE-ENGINE-API.md §2). `design.slots[]` names the CONCRETE `sectionType` this clone wants in
 * each slot (the template body's own `slots[].allowed` is an array per `templateSlotSchema`,
 * packages/core/schema/bodies/template-v1.ts — matched against that real schema, not guessed).
 * `buildRecipeMintPlan` below widens a design slot's single type into that one-element allowed set
 * when it builds the mintable body; validation works against the concrete choice actually being made).
 */
export function validateTemplateDesign(design, intake) {
  if (!isPlainObject(design) || typeof design.name !== 'string' || !design.name.trim()) {
    throw new CloneError('A template design requires at least a name.');
  }
  const appliesTo = Array.isArray(design.appliesTo) ? design.appliesTo : [];
  if (appliesTo.length === 0) throw new CloneError('A template design requires at least one appliesTo page type.');
  const slots = Array.isArray(design.slots) ? design.slots : [];

  if (existingRecipeObjectId(intake.inventory.template, design.name)) {
    return { ok: false, reason: 'name_collision', detail: `a template named "${design.name}" already exists` };
  }

  for (const pageType of appliesTo) {
    if (!(pageType in intake.registry.pageTypes)) {
      return {
        ok: false,
        reason: 'applies_to_page_type_missing',
        detail: `page type "${pageType}" is not in the live page-type registry`,
      };
    }
  }

  for (const slot of slots) {
    const dataSchema = intake.registry.sectionTypes[slot.sectionType];
    if (dataSchema === undefined) {
      return {
        ok: false,
        reason: 'unknown_section_type',
        detail: `slot "${slot.slotId ?? '(unnamed)'}" names "${slot.sectionType}", which is not in the live component registry`,
      };
    }
    if (slot.blueprint) {
      const errors = structuralErrors(slot.blueprint.data ?? {}, dataSchema, dataSchema);
      if (errors.length > 0) return { ok: false, reason: 'blueprint_schema_mismatch', detail: errors };
    }
    for (const pageType of appliesTo) {
      const allowed = intake.registry.pageTypes[pageType].allowed;
      if (allowed !== 'any' && !allowed.includes(slot.sectionType)) {
        return {
          ok: false,
          reason: 'slot_section_type_not_allowed',
          detail: `slot "${slot.slotId ?? '(unnamed)'}" places "${slot.sectionType}", which page type "${pageType}" does not allow`,
        };
      }
    }
  }

  const slottedTypes = new Set(slots.map((slot) => slot.sectionType));
  for (const pageType of appliesTo) {
    const missing = intake.registry.pageTypes[pageType].required.filter((type) => !slottedTypes.has(type));
    if (missing.length > 0) {
      return {
        ok: false,
        reason: 'required_section_not_covered',
        detail: `page type "${pageType}" requires ${missing.join(', ')}, which no slot in this template provides`,
      };
    }
  }

  const normalized = clone(design);
  normalized.scope = normalized.scope || 'one_off';
  normalized.slots = slots.map((slot, index) => ({ ...clone(slot), slotId: slot.slotId || `slot_${index}` }));
  return { ok: true, normalized };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 3. MINT PLAN
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const RECIPE_ID_PREFIX = { section_template: 'stpl_clone', template: 'tpl_clone' };

/** The mintable body for a normalized design — matches sectionTemplateBodySchema / templateBodySchema
 *  exactly (name/description/whenToUse/scope, plus the type-specific field), so what `creates` proposes
 *  is what `object_create` can actually accept. */
function recipeBody(objectType, normalized) {
  const shared = {
    name: normalized.name,
    description: normalized.description ?? '',
    whenToUse: normalized.whenToUse ?? '',
    scope: normalized.scope,
  };
  if (objectType === 'section_template') return { ...shared, blueprint: normalized.blueprint };
  return {
    ...shared,
    appliesTo: normalized.appliesTo,
    slots: normalized.slots.map((slot) => ({
      slotId: slot.slotId,
      allowed: [slot.sectionType],
      required: Boolean(slot.required),
      repeatable: Boolean(slot.repeatable),
      ...(slot.blueprint ? { blueprint: slot.blueprint } : {}),
    })),
  };
}

/**
 * Mint plan for a batch of designed recipes (CLONE-ENGINE-API.md §3). `design.sectionTemplates` and
 * `design.templates` are each re-validated with the exact same functions an isolated caller would use
 * (step 2) — batching never loosens the check a single design gets on its own.
 *
 * ONE malformed design (missing a name, a blueprint with no type — the guard-rail throws in step 2)
 * does not abort the whole batch: it is recorded as `rejected` with reason `malformed_design` and the
 * rest of the batch proceeds, the same T12.17 discipline emit.mjs applies to one bad asset.
 */
export function buildRecipeMintPlan({ intake, design }) {
  if (!isPlainObject(intake) || typeof intake.target !== 'string') {
    throw new CloneError('A recipe mint plan requires an intake with a target.');
  }
  const target = intake.target;
  const batches = [
    [
      'section_template',
      Array.isArray(design?.sectionTemplates) ? design.sectionTemplates : [],
      validateSectionTemplateDesign,
    ],
    ['template', Array.isArray(design?.templates) ? design.templates : [], validateTemplateDesign],
  ];

  const creates = [];
  const rejected = [];
  const reused = [];

  for (const [objectType, designs, validate] of batches) {
    for (const entryDesign of designs) {
      const name = isPlainObject(entryDesign) ? entryDesign.name : undefined;
      // `sourceCandidateIds` is an additive passthrough this module introduces — a DELIBERATE design
      // choice, not an accident, and not literal CLONE-ENGINE-API.md text: the capture-map
      // candidateId(s) a design was built from. CLONE-ENGINE-API.md §5 requires buildRestampOps to
      // SKIP a page whole, never half-restamp it, when a page depends on a recipe that got rejected at
      // mint — but §2/§3 never say how a page is known to "depend on" a given recipe design in the
      // first place. Re-deriving that link by re-running emit.mjs's shape-fingerprint grouping inside
      // this module would duplicate a piece of capture-EMISSION logic that this module has no business
      // owning (and would drift the moment that grouping changes). Carrying the link explicitly instead
      // — the design's author states which candidates it represents, once, at design time — is a
      // smaller, more honest surface: it costs one optional field on the design object, and it is what
      // makes the "skip vs. half-restamp" property in buildRestampOps below actually testable rather
      // than merely asserted.
      const sourceCandidateIds = Array.isArray(entryDesign?.sourceCandidateIds)
        ? entryDesign.sourceCandidateIds
        : undefined;

      let outcome;
      try {
        outcome = validate(entryDesign, intake);
      } catch (error) {
        rejected.push({
          kind: objectType,
          name: name ?? null,
          reason: 'malformed_design',
          detail: error instanceof Error ? error.message : String(error),
          ...(sourceCandidateIds ? { sourceCandidateIds } : {}),
        });
        continue;
      }

      if (!outcome.ok) {
        if (outcome.reason === 'name_collision') {
          reused.push({ objectType, name, objectId: existingRecipeObjectId(intake.inventory[objectType], name) });
        } else {
          rejected.push({
            kind: objectType,
            name,
            reason: outcome.reason,
            detail: outcome.detail,
            ...(sourceCandidateIds ? { sourceCandidateIds } : {}),
          });
        }
        continue;
      }

      const requestedId = `${RECIPE_ID_PREFIX[objectType]}_${sha(`${target}:${name}`, 12)}`;
      creates.push({
        verb: 'object_create',
        objectType,
        requestedId,
        body: recipeBody(objectType, outcome.normalized),
        rationale: entryDesign.rationale ?? `designed to satisfy a capability gap found while cloning ${target}`,
        ...(sourceCandidateIds ? { sourceCandidateIds } : {}),
      });
    }
  }

  // Defence in depth, same posture as emit.mjs's transport-level forbidden-verb guard: every entry
  // this function produces uses the fixed verb 'object_create', so this can never actually fire today
  // — but a future edit that starts emitting a second op kind must trip it rather than silently ship.
  for (const item of creates) {
    if (FORBIDDEN_VERBS.has(item.verb))
      throw new CloneError(`Recipe mint plan attempted a forbidden verb: ${item.verb}`);
  }

  return {
    schemaVersion: 'clone-mint-plan.v1',
    target,
    creates,
    rejected,
    reused,
    forbiddenVerbs: [...FORBIDDEN_VERBS].sort(),
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 4. THEME
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const CSS_URL_OR_IMPORT_RE = /url\(|@import/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNCTIONAL_COLOR_RE = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color)\([^)]*\)$/i;
const GENERIC_FONT_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);
// The CSS Color Module Level 4 named-color keyword set (plus 'transparent'/'currentcolor'), lower-
// cased for comparison. A curated list, not a bare `/^[a-z]+$/` — the latter would accept any English
// word as a "color", which is not a structural check, it is no check at all.
const CSS_NAMED_COLORS = new Set([
  'black',
  'silver',
  'gray',
  'white',
  'maroon',
  'red',
  'purple',
  'fuchsia',
  'green',
  'lime',
  'olive',
  'yellow',
  'navy',
  'blue',
  'teal',
  'aqua',
  'orange',
  'aliceblue',
  'antiquewhite',
  'aquamarine',
  'azure',
  'beige',
  'bisque',
  'blanchedalmond',
  'blueviolet',
  'brown',
  'burlywood',
  'cadetblue',
  'chartreuse',
  'chocolate',
  'coral',
  'cornflowerblue',
  'cornsilk',
  'crimson',
  'cyan',
  'darkblue',
  'darkcyan',
  'darkgoldenrod',
  'darkgray',
  'darkgreen',
  'darkgrey',
  'darkkhaki',
  'darkmagenta',
  'darkolivegreen',
  'darkorange',
  'darkorchid',
  'darkred',
  'darksalmon',
  'darkseagreen',
  'darkslateblue',
  'darkslategray',
  'darkslategrey',
  'darkturquoise',
  'darkviolet',
  'deeppink',
  'deepskyblue',
  'dimgray',
  'dimgrey',
  'dodgerblue',
  'firebrick',
  'floralwhite',
  'forestgreen',
  'gainsboro',
  'ghostwhite',
  'gold',
  'goldenrod',
  'greenyellow',
  'grey',
  'honeydew',
  'hotpink',
  'indianred',
  'indigo',
  'ivory',
  'khaki',
  'lavender',
  'lavenderblush',
  'lawngreen',
  'lemonchiffon',
  'lightblue',
  'lightcoral',
  'lightcyan',
  'lightgoldenrodyellow',
  'lightgray',
  'lightgreen',
  'lightgrey',
  'lightpink',
  'lightsalmon',
  'lightseagreen',
  'lightskyblue',
  'lightslategray',
  'lightslategrey',
  'lightsteelblue',
  'lightyellow',
  'limegreen',
  'linen',
  'magenta',
  'mediumaquamarine',
  'mediumblue',
  'mediumorchid',
  'mediumpurple',
  'mediumseagreen',
  'mediumslateblue',
  'mediumspringgreen',
  'mediumturquoise',
  'mediumvioletred',
  'midnightblue',
  'mintcream',
  'mistyrose',
  'moccasin',
  'navajowhite',
  'oldlace',
  'olivedrab',
  'orangered',
  'orchid',
  'palegoldenrod',
  'palegreen',
  'paleturquoise',
  'palevioletred',
  'papayawhip',
  'peachpuff',
  'peru',
  'pink',
  'plum',
  'powderblue',
  'rosybrown',
  'royalblue',
  'saddlebrown',
  'salmon',
  'sandybrown',
  'seagreen',
  'seashell',
  'sienna',
  'skyblue',
  'slateblue',
  'slategray',
  'slategrey',
  'snow',
  'springgreen',
  'steelblue',
  'tan',
  'thistle',
  'tomato',
  'turquoise',
  'violet',
  'wheat',
  'whitesmoke',
  'yellowgreen',
  'rebeccapurple',
  'transparent',
  'currentcolor',
]);

function isPlainCssColor(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  const trimmed = value.trim();
  return HEX_COLOR_RE.test(trimmed) || FUNCTIONAL_COLOR_RE.test(trimmed) || CSS_NAMED_COLORS.has(trimmed.toLowerCase());
}

/** True when `value` is a font-family LIST (a fallback stack), or a single value that is itself a
 *  generic CSS family keyword (the terminal fallback every stack ends in, so it needs no further
 *  fallback behind it). False for one bare named family with nothing behind it — the shape a captured
 *  site's own computed style reports before a human curates it. */
function hasFontFallbackStack(value) {
  if (typeof value !== 'string') return false;
  const families = value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (families.length >= 2) return true;
  if (families.length === 1) return GENERIC_FONT_FAMILIES.has(families[0].toLowerCase().replace(/^['"]|['"]$/g, ''));
  return false;
}

/**
 * Re-validate a proposed theme token set against the site's OWN declared slots (CLONE-ENGINE-API.md
 * §4). `siteBody.brandTokens` is the authority on which slots exist — the proposal supplies values,
 * never new slot names, because inventing a slot the renderer's CustomStyles.astro never emits a CSS
 * variable for would be a token nothing on the site ever reads.
 */
export function validateThemeProposal({ proposal, siteBody }) {
  if (!isPlainObject(proposal)) throw new CloneError('A theme proposal is required.');
  if (!isPlainObject(siteBody?.brandTokens))
    throw new CloneError('A siteBody with brandTokens is required to validate a theme proposal against.');

  const applied = { colors: {}, fonts: {} };
  const dropped = [];
  const existingColorSlots = siteBody.brandTokens.colors ?? {};
  const existingFontSlots = siteBody.brandTokens.fonts ?? {};

  for (const [slot, value] of Object.entries(proposal.colors ?? {})) {
    if (!(slot in existingColorSlots)) {
      dropped.push({ slot, value, reason: 'unknown_slot' });
    } else if (typeof value === 'string' && CSS_URL_OR_IMPORT_RE.test(value)) {
      dropped.push({ slot, value, reason: 'external_reference_forbidden' });
    } else if (!isPlainCssColor(value)) {
      dropped.push({ slot, value, reason: 'not_a_color' });
    } else {
      applied.colors[slot] = value;
    }
  }
  for (const [slot, value] of Object.entries(proposal.fonts ?? {})) {
    if (!(slot in existingFontSlots)) {
      dropped.push({ slot, value, reason: 'unknown_slot' });
    } else if (typeof value === 'string' && CSS_URL_OR_IMPORT_RE.test(value)) {
      dropped.push({ slot, value, reason: 'external_reference_forbidden' });
    } else if (!hasFontFallbackStack(value)) {
      dropped.push({ slot, value, reason: 'no_fallback_stack' });
    } else {
      applied.fonts[slot] = value;
    }
  }

  const proposedCount = Object.keys(proposal.colors ?? {}).length + Object.keys(proposal.fonts ?? {}).length;
  const appliedCount = Object.keys(applied.colors).length + Object.keys(applied.fonts).length;
  // An empty write is a REFUSAL, not a success: if the proposal named tokens at all and every single
  // one dropped, silently returning `{applied: {colors:{}, fonts:{}}}` would look, to a caller who
  // only checks for a thrown error, exactly like "nothing needed changing" — hiding a proposal that
  // was entirely illegitimate. A truly empty proposal (nothing proposed) is not this case: there is
  // nothing to have refused.
  if (proposedCount > 0 && appliedCount === 0) {
    throw new CloneError('Every proposed theme token was dropped; an empty write is a refusal, not a success.');
  }

  // TOTALITY. `site_apply_theme` computes an EXACT REPLACE of site.brandTokens.colors from the
  // theme's own colors — any key the site currently carries that the theme does not is UNSET, not
  // left alone. So a proposal that updates only SOME of the site's color slots is not "a partial
  // improvement", it is a plan to delete every color it didn't mention. `missingKeys` names exactly
  // those slots so `buildThemeApplyPlan` (below) can refuse before anything is ever written, rather
  // than after `site_apply_theme` has already unset them.
  //
  // This is checked against `applied.colors` — the PROPOSAL's own surviving keys — not against
  // whatever the theme record ends up holding after a merge patch. Re-deriving "will the merged
  // theme end up total" here would mean re-implementing `set_theme_fields`' own deep-merge semantics
  // (object-patch-ops.ts) a second time in a network-free module, which is exactly the kind of
  // drift-prone duplication this file avoids elsewhere (see `structuralErrors`'s doc comment). A
  // proposal that is itself total is a strictly stronger, and simpler to verify, guarantee.
  const missingKeys = Object.keys(existingColorSlots)
    .filter((slot) => !(slot in applied.colors))
    .sort();

  return { applied, dropped, missingKeys };
}

// Runtime-resolved placeholders. `buildThemeApplyPlan` is a PURE PLAN builder — it has no transport,
// so it cannot know the lock_token/expected_record_version a live `object_checkout` call would
// return. CLONE-ENGINE-API.md §4 itself writes the site's pair as the literal string
// `'<from site checkout>'` in its example rather than a resolved value, which is the tell that the
// EXECUTOR (Side B, which actually calls `object_checkout`) is expected to substitute the real
// value into these two fields before dispatching the corresponding step. The theme checkout/checkin
// pair needs the identical substitution and the contract's own step list elides it there purely for
// brevity (it is shown in full for the site's pair only) — extended here for both, consistently, so
// every step this function emits is one an executor can actually resolve and dispatch.
const FROM_THEME_CHECKOUT = '<from theme checkout>';
const FROM_SITE_CHECKOUT = '<from site checkout>';

/**
 * Build the plan that applies a validated theme to the site (CLONE-ENGINE-API.md §4) —
 * THIS SUPERSEDES THE EARLIER `buildThemeBindOps` CONTRACT, which is deleted.
 *
 * WHY THIS SHAPE: `brandTokens` is explicitly forbidden under `set_site_fields`
 * (packages/core/schema/object-patch-ops.ts, `setSiteFieldsSchema`), and its privileged replacement
 * `set_site_brand_tokens` is in `PRIVILEGED_PATCH_OPS` — no agent may hand-author it via
 * `object_patch`. The ONLY sanctioned palette writer is the `site_apply_theme` verb, which computes
 * that privileged op itself, server-side, under the caller's OWN site checkout. So this function
 * never constructs `set_site_brand_tokens` (nothing in this module does, anywhere) — it constructs
 * the surrounding, agent-legal steps: write the proposed tokens onto the THEME recipe (the one
 * object type an agent may freely patch, via the ordinary `set_theme_fields` op), then hand the
 * privileged copy-and-replace step to `site_apply_theme` itself, paired with the site checkout/
 * checkin that verb requires but never performs on its own.
 *
 * TOTALITY IS ENFORCED HERE, NOT DOWNSTREAM: when `missingKeys` (from `validateThemeProposal`) is
 * non-empty, applying would delete site color keys the proposal never mentioned. This function
 * refuses outright — `refusal: {reason:'theme_not_total', detail:{missingKeys}}` and an EMPTY
 * `steps` array — rather than emitting a truncated or partially-safe plan. It never backfills a
 * missing key from `siteRecord` or `themeRecord`: inventing a brand color the proposal never
 * supplied would be a worse outcome than refusing to apply one at all, exactly the same posture
 * `validateThemeProposal` takes toward a proposal that drops everything.
 *
 * `site_apply_theme` never auto-checkouts (its own tool description says so), so every call this
 * plan makes to it is paired with an explicit `object_checkout` / `object_checkin` on the SAME
 * object — the executor releasing that lock in a `finally` is what keeps a failed apply from
 * stranding a lease on a live site or theme.
 */
export function buildThemeApplyPlan({ siteId, themeId, siteRecord, themeRecord, applied, missingKeys }) {
  if (!siteId || typeof siteId !== 'string') throw new CloneError('A siteId is required to apply a theme.');
  if (!themeId || typeof themeId !== 'string') throw new CloneError('A themeId is required to apply a theme.');
  if (!isPlainObject(siteRecord) || !isPlainObject(themeRecord)) {
    throw new CloneError('A siteRecord and a themeRecord are required to apply a theme.');
  }

  const missing = Array.isArray(missingKeys) ? [...missingKeys] : [];
  if (missing.length > 0) {
    return {
      schemaVersion: 'clone-theme-apply.v1',
      siteId,
      themeId,
      refusal: { reason: 'theme_not_total', detail: { missingKeys: missing } },
      steps: [],
    };
  }

  // `set_theme_fields` is a MERGE op (the `set_site_fields` idiom, object-patch-ops.ts) — sending
  // only `applied`'s slots is enough; the theme's own untouched colors/fonts survive the patch
  // unchanged, exactly the merge-not-replace discipline the old site-side op used to provide.
  const tokensPatch = { colors: clone(applied?.colors ?? {}), fonts: clone(applied?.fonts ?? {}) };

  return {
    schemaVersion: 'clone-theme-apply.v1',
    siteId,
    themeId,
    refusal: null,
    steps: [
      { verb: 'object_checkout', arguments: { object_type: 'theme', object_id: themeId } },
      {
        verb: 'object_patch',
        arguments: {
          object_type: 'theme',
          object_id: themeId,
          lock_token: FROM_THEME_CHECKOUT,
          expected_record_version: FROM_THEME_CHECKOUT,
          ops: [{ op: 'set_theme_fields', fields: { tokens: tokensPatch } }],
        },
      },
      {
        verb: 'object_checkin',
        arguments: { object_type: 'theme', object_id: themeId, lock_token: FROM_THEME_CHECKOUT },
      },
      { verb: 'object_checkout', arguments: { object_type: 'site', object_id: siteId } },
      // Preview first: `site_apply_theme(dry_run:true)` needs neither lock_token nor
      // expected_record_version (its own tool description says so) — it returns the computed
      // `set_site_brand_tokens` op and full validation without persisting anything.
      { verb: 'site_apply_theme', arguments: { site_id: siteId, theme_id: themeId, dry_run: true } },
      {
        verb: 'site_apply_theme',
        arguments: {
          site_id: siteId,
          theme_id: themeId,
          dry_run: false,
          lock_token: FROM_SITE_CHECKOUT,
          expected_record_version: FROM_SITE_CHECKOUT,
        },
      },
      { verb: 'object_checkin', arguments: { object_type: 'site', object_id: siteId, lock_token: FROM_SITE_CHECKOUT } },
    ],
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 5. RESTAMP
// ═══════════════════════════════════════════════════════════════════════════════════════════════

const ASSET_REF_KEY_RE = /assetref$/i;
const REMOTE_URL_RE = /^https?:/i;

/** The same positive-shape asset scan emit.mjs runs as its last line of defence before a body reaches
 *  the wire (`assertAssetFieldsFirstParty`), narrowed to the ONE check this stage actually needs to
 *  make itself: restamp never MINTS a new asset reference, it only carries an already-bound one
 *  forward — so its only job is proving nothing it forwards regressed into a hotlink. */
function assertNoRemoteAssetValues(value, path) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRemoteAssetValues(item, `${path}.${index}`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, item] of Object.entries(value)) {
    const at = `${path}.${key}`;
    if (typeof item === 'string' && (key === 'src' || ASSET_REF_KEY_RE.test(key)) && REMOTE_URL_RE.test(item)) {
      throw new CloneError(
        `${at} carries a remote URL ("${item}"); restamp may never introduce a hotlink into an asset field.`
      );
    }
    assertNoRemoteAssetValues(item, at);
  }
}

/**
 * Build the ops that restamp the site's already-emitted pages once mint has run (CLONE-ENGINE-API.md
 * §5). A page's final section list — already carrying whatever first-party asset paths emission bound
 * — is written back verbatim as a sequence of `upsert_section` ops (the same primitive emit.mjs's own
 * reuse path uses): nothing here re-derives a section's data, so nothing here can rewrite, drop or
 * synthesize an asset field. `assertNoRemoteAssetValues` is the belt to that braces: a regression
 * anywhere upstream that let a remote URL through is caught here, not shipped.
 *
 * A page is SKIPPED — not partially restamped — when:
 *   - its source page is missing from the mapping (`source_page_missing`): nothing to restamp from;
 *   - its captured section list is empty (`would_empty_page`): the same T12.28 refusal emit.mjs's
 *     `reuseOpsForPage` makes — an empty capture is a mapping failure, never an instruction to blank a
 *     live page;
 *   - ANY of its capture-map candidates was the source of a recipe design that got REJECTED at mint
 *     (`recipe_rejected_at_mint`, keyed by the `sourceCandidateIds` `buildRecipeMintPlan` carries
 *     through onto `rejected[]`): restamping the rest of the page while quietly leaving out the piece
 *     that depended on the failed recipe is exactly the "half-restamped" outcome the contract forbids,
 *     so the whole page is left untouched instead.
 */
export function buildRestampOps({ intake, mintReport }) {
  if (!isPlainObject(intake) || !isPlainObject(intake.emitted) || !isPlainObject(intake.source?.mapping)) {
    throw new CloneError('Restamp requires a clone intake with emitted pages and its source mapping.');
  }
  if (!isPlainObject(mintReport)) throw new CloneError('Restamp requires an executed mint report.');

  const mappingPageByRef = new Map((intake.source.mapping.pages ?? []).map((page) => [page.pageRef, page]));
  const blockedCandidateIds = new Set((mintReport.rejected ?? []).flatMap((entry) => entry.sourceCandidateIds ?? []));

  const restamp = [];
  const skipped = [];

  for (const page of intake.emitted.pages ?? []) {
    const mappingPage = mappingPageByRef.get(page.pageRef);
    if (!mappingPage) {
      skipped.push({ objectId: page.objectId, reason: 'source_page_missing' });
      continue;
    }
    const blockedCandidate = (mappingPage.candidates ?? []).find((candidate) =>
      blockedCandidateIds.has(candidate.candidateId)
    );
    if (blockedCandidate) {
      skipped.push({ objectId: page.objectId, reason: 'recipe_rejected_at_mint' });
      continue;
    }
    const sections = mappingPage.pageBody?.sections ?? [];
    if (sections.length === 0) {
      skipped.push({ objectId: page.objectId, reason: 'would_empty_page' });
      continue;
    }

    const ops = sections.map((section, index) => ({ op: 'upsert_section', section: clone(section), position: index }));
    ops.forEach((op) => assertNoRemoteAssetValues(op.section, `${page.objectId}.sections.${op.position}`));
    restamp.push({ objectId: page.objectId, ops });
  }

  return { restamp, skipped };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 6. REPORT
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/** `design.unmetNeeds` — gaps that stayed gaps even after recipe design, because what's missing is a
 *  section TYPE (code), which no recipe can supply — grouped by that type so the backlog reads as "N
 *  clones want a `pricing_table` section type" rather than N separate, uncorrelated line items. */
function groupUnmetNeedsBySectionType(unmetNeeds) {
  const groups = new Map();
  for (const need of unmetNeeds ?? []) {
    const type = typeof need?.sectionType === 'string' && need.sectionType ? need.sectionType : 'unknown';
    groups.set(type, [...(groups.get(type) ?? []), clone(need)]);
  }
  return Object.fromEntries([...groups.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Assemble the terminal clone run report (CLONE-ENGINE-API.md §6). Everything this function does is
 * SUMMARIZE prior stages' already-computed outcomes — it creates, changes, and publishes nothing;
 * `humanGate.publishedByThisRun` is unconditionally `false` because nothing upstream of this file can
 * publish (`FORBIDDEN_VERBS` refuses `object_publish` before a create is even attempted).
 */
export function buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design }) {
  if (!isPlainObject(intake)) throw new CloneError('A clone run report requires the intake it was built from.');
  if (!isPlainObject(mintReport)) throw new CloneError('A clone run report requires an executed mint report.');
  if (!isPlainObject(themeReport)) throw new CloneError('A clone run report requires a theme bind report.');
  if (!isPlainObject(restampReport)) throw new CloneError('A clone run report requires a restamp report.');

  const siteId = intake.inventory?.site?.object_id ?? intake.inventory?.site?.objectId ?? null;
  const themeTokensApplied =
    Object.keys(themeReport.applied?.colors ?? {}).length + Object.keys(themeReport.applied?.fonts ?? {}).length;

  // Ordered site -> recipes -> pages, exactly as the contract specifies — a reviewer reads top-down
  // from "what changed about the site itself" through "what new data objects exist" to "what content
  // moved", which is also the order later stages depended on the earlier ones.
  const reviewQueue = [
    ...(themeTokensApplied > 0 && siteId ? [{ objectType: 'site', objectId: siteId, action: 'theme_bind' }] : []),
    ...(mintReport.createdObjects ?? [])
      .filter((entry) => entry.objectType === 'section_template' || entry.objectType === 'template')
      .map((entry) => ({ objectType: entry.objectType, objectId: entry.objectId, action: 'created' })),
    ...(restampReport.restamp ?? []).map((entry) => ({
      objectType: 'page',
      objectId: entry.objectId,
      action: 'restamped',
      opCount: entry.ops.length,
    })),
  ];

  return {
    schemaVersion: 'clone-run-report.v1',
    mint: clone(mintReport),
    theme: clone(themeReport),
    restamp: clone(restampReport),
    capabilityBacklog: groupUnmetNeedsBySectionType(design?.unmetNeeds),
    reviewQueue,
    humanGate: {
      publishedByThisRun: false,
      note: 'Clone runs only ever write drafts. Publishing any object this run created or changed remains a separate, human-gated decision.',
    },
  };
}
