/**
 * T13.1 clone_conductor engine — Side A (CLONE-ENGINE-API.md), amended by T13.2 (CLONE-INTAKE-FIX.md):
 * `buildCloneIntake` now emits a BOUNDED BRIEFING DOCUMENT rather than a data bus, and the stages that
 * need whole bodies fetch them with `object_get` instead of riding on the envelope. See §1.
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
 * T13.2 (CLONE-INTAKE-FIX.md): the intake envelope is a BRIEFING DOCUMENT for the three AI nodes, not
 * a data bus.
 *
 * The live run measured the old envelope at 637,769 chars against the executor's 48,000-char
 * dependency bound — 13x over. Both AI nodes reported the starvation honestly instead of inventing,
 * so the prompts and the refusals held; the DATA was the defect. Its composition said everything:
 * `source.snapshot` 241,558, `source.mapping` 156,239, `emitted.report.media` 114,908 (295 records),
 * `registry` 32,694 — and `source.theme`, the part the theme node actually needed, 895.
 *
 * The correction: the deterministic stages (`recipe_mint`, `theme_bind`, `layout_restamp`) run in
 * engine code that HAS transport, so they `object_get` the page / site / theme bodies they need. Only
 * the AI nodes read this envelope, and they only ever needed shapes, slots and vocabulary — never the
 * raw snapshot, never the full mapping, never 295 media records, and never 32KB of Zod-derived JSON
 * Schema. `registry.sectionTypes` therefore carries FIELD NAMES ONLY: a designer composing a
 * blueprint needs to know that a `composition` holds `images[]` and `blocks[]`; it does not need the
 * schema of either to know that.
 */
const INTAKE_ARTIFACT = 'clone_intake.v1';
/** What a healthy briefing lands under. NOT enforced — exceeding it is legal and `budget.chars`
 *  reports the truth either way; it is the number a reviewer should look at first. Exported so a
 *  caller (and this module's own tests) can assert the target without re-typing the number. */
export const CLONE_INTAKE_TARGET_CHARS = 12000;
/** Enforced. Sits well inside the executor's 48,000-char dependency bound
 *  (DEFAULT_DEPENDENCY_OUTPUT_MAX_CHARS) with room for the prompt scaffolding a node wraps around it. */
export const CLONE_INTAKE_CAP_CHARS = 32000;
const MAX_GAPS_PER_PAGE = 5;
const MAX_PAGES = 20;
const MAX_RECIPES_PER_KIND = 20;

const sectionShape = (sections) =>
  (Array.isArray(sections) ? sections : []).map((section) => section?.type ?? 'unknown');

/**
 * The SOURCE page's own block sequence as the mapping accounted for it: the section type each source
 * block became, or the token `'gap'` where a block could not be mapped at all. Blocks the reconciler
 * dropped as non-content (nav chrome, cookie banners) are left out — they are not part of a page's
 * shape, and carrying them would only pad the briefing with noise the analyst must skip.
 */
function sourceShape(mappingPage) {
  const candidateTypes = new Map(
    (mappingPage?.candidates ?? []).map((candidate) => [candidate?.candidateId, candidate?.sectionType ?? 'unknown'])
  );
  const accounting = mappingPage?.blockAccounting;
  if (!Array.isArray(accounting)) {
    // A mapping without the per-block ledger (an older map, or a focused fixture) still orders its
    // candidates by source block, so reading them directly loses nothing except the gap positions —
    // which `pages[].gaps` reports anyway.
    return [...candidateTypes.values()];
  }
  const shape = [];
  for (const entry of accounting) {
    if (entry?.status === 'gap') {
      shape.push('gap');
      continue;
    }
    if (candidateTypes.has(entry?.candidateId)) shape.push(candidateTypes.get(entry.candidateId));
  }
  return shape;
}

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
function briefingPages(mapping, emissionReport) {
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
    pages.push({
      pageRef: entry.pageRef,
      objectId,
      route,
      sourceShape: sourceShape(mappingPage),
      // ORDERED, from the body emission actually wrote — not from the mapping. The two differ
      // precisely where emission dropped something (a section the platform refused, an asset that
      // never bound), and that difference is the whole reason `layout_analyst` reads this envelope.
      emittedShape: sectionShape(entry.body?.sections ?? mappingPage?.pageBody?.sections),
      gaps: (mappingPage?.gaps ?? []).map((gap) => ({
        gapId: gap?.gapId ?? null,
        why: gap?.why ?? null,
        nearestType: gap?.nearestType ?? null,
      })),
      // NOT in CLONE-INTAKE-FIX.md's sketch of the page shape; added deliberately, because without it
      // a documented behaviour dies silently. `buildRecipeMintPlan` carries a design's
      // `sourceCandidateIds` onto `rejected[]`, and `buildRestampOps` uses exactly those ids to SKIP a
      // page whole rather than half-restamp it (CLONE-ENGINE-API.md §5). A design can only cite an
      // identifier the briefing showed it — the mapping it used to come from is gone from this
      // envelope — so a briefing that hides the candidate ids makes `recipe_rejected_at_mint`
      // unreachable. One short id per emitted section is a cheap price for a refusal that works.
      candidateIds: (mappingPage?.candidates ?? [])
        .map((candidate) => candidate?.candidateId)
        .filter((candidateId) => typeof candidateId === 'string'),
    });
  }
  return pages;
}

/** One section type's data schema flattened to the two things a designer needs: which fields the type
 *  HAS and which of them it REQUIRES. Anything reachable through `$ref` is resolved first, and a type
 *  whose schema is a union contributes the union of its branches' fields but only the required keys
 *  EVERY branch demands — a key one legal shape can do without is not required of the type. */
function fieldContract(dataSchema) {
  const branches = schemaBranches(dataSchema, dataSchema, new Set());
  const fields = new Set();
  const requiredTally = new Map();
  for (const branch of branches) {
    for (const key of Object.keys(branch.properties ?? {})) fields.add(key);
    for (const key of branch.required ?? []) requiredTally.set(key, (requiredTally.get(key) ?? 0) + 1);
  }
  const required = [...requiredTally.entries()]
    .filter(([, count]) => count === branches.length)
    .map(([key]) => key)
    .sort();
  return { fields: [...fields].sort(), required };
}

/** The top-level object shapes a schema node can legally be, `$ref`s resolved and `anyOf`/`oneOf`
 *  flattened. `seen` guards the self-referential schemas a recursive component (a nested block list)
 *  produces — a briefing builder that can be made to hang by a legal registry is not a safe one. */
function schemaBranches(node, rootSchema, seen) {
  if (!isPlainObject(node)) return [];
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return [];
    seen.add(node.$ref);
    let resolved = rootSchema;
    for (const part of node.$ref.slice(2).split('/')) {
      resolved = isPlainObject(resolved) ? resolved[part] : undefined;
    }
    return schemaBranches(resolved, rootSchema, seen);
  }
  const alternatives = Array.isArray(node.anyOf) ? node.anyOf : Array.isArray(node.oneOf) ? node.oneOf : null;
  if (alternatives) return alternatives.flatMap((branch) => schemaBranches(branch, rootSchema, seen));
  return [node];
}

/** `registry_get(registry:'component')`'s `definitions` reduced to `{ [type]: {fields, required} }`.
 *  Field names (`type`, `data_schema`) matched against the real handler, `callRegistryGet` ->
 *  `listSectionTypeContracts()` in packages/core/lib/registry/object-contract.ts — not guessed. */
function sectionTypesFromRegistry(componentRegistry) {
  const definitions = Array.isArray(componentRegistry) ? componentRegistry : (componentRegistry?.definitions ?? []);
  const sectionTypes = {};
  for (const definition of definitions) {
    if (typeof definition?.type !== 'string' || !definition.type) continue;
    sectionTypes[definition.type] = fieldContract(definition.data_schema ?? definition.dataSchema ?? null);
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

/** The reuse-first recipe index, straight off `object_inventory`'s own `recipe` summary
 *  (`recipeSummaryFromBody`, packages/core/server/lib/object-inventory.ts) — the row already carries
 *  exactly the four or five fields a designer needs to decide "does this already exist?", so nothing
 *  here re-reads a recipe body it was never given. */
const recipeRowName = (row) =>
  row?.recipe?.name ?? row?.recipe_summary?.name ?? row?.recipeSummary?.name ?? row?.body?.name ?? row?.name ?? null;
const recipeRowField = (row, field) =>
  row?.recipe?.[field] ?? row?.recipe_summary?.[field] ?? row?.recipeSummary?.[field] ?? null;

function recipeIndex(rows, objectType) {
  return (Array.isArray(rows) ? rows : []).map((row) => {
    const summary = {
      objectId: row?.object_id ?? row?.objectId ?? null,
      name: recipeRowName(row),
      scope: recipeRowField(row, 'scope') ?? row?.body?.scope ?? null,
    };
    if (objectType === 'section_template') {
      return {
        ...summary,
        blueprint_type: recipeRowField(row, 'blueprint_type') ?? row?.body?.blueprint?.type ?? null,
      };
    }
    return {
      ...summary,
      applies_to: clone(recipeRowField(row, 'applies_to') ?? row?.body?.appliesTo ?? []),
      slot_count: recipeRowField(row, 'slot_count') ?? (Array.isArray(row?.body?.slots) ? row.body.slots.length : null),
    };
  });
}

/** The site BODY's palette slots, unwrapped whether the caller handed over the `object_get` RECORD or
 *  the body itself. Only `colors` and `fonts` travel: they are the only slots a theme proposal may
 *  address (`validateThemeProposal` below), and the site's layout/shape tokens would be briefing
 *  weight nothing downstream reads. */
function brandTokensFromSiteBody(siteBody) {
  const outer = isPlainObject(siteBody) ? siteBody : {};
  const body = isPlainObject(outer.brandTokens) ? outer : isPlainObject(outer.body) ? outer.body : outer;
  if (!isPlainObject(body.brandTokens)) return null;
  return {
    colors: clone(isPlainObject(body.brandTokens.colors) ? body.brandTokens.colors : {}),
    fonts: clone(isPlainObject(body.brandTokens.fonts) ? body.brandTokens.fonts : {}),
  };
}

/** The captured theme, unwrapped the same way, with its objectId taken from the record when the
 *  caller `object_get`'s one and from inventory when there is exactly one theme to mean.
 *
 *  T13.3 (credential-redactor collision): the briefing field is `palette`, not `tokens` — the
 *  executor's per-node prompt redactor (`OpenAINodeRunner.ts` / `AnthropicNodeRunner.ts`,
 *  `/token/i`) replaces any key matching it with "[REDACTED]" before the model ever sees it, and
 *  `tokens`/`brandTokens` both matched, silently blanking `theme_reconciler`'s whole palette. The
 *  real platform field this reads FROM (`body.tokens`, written by `set_theme_fields`) is
 *  unchanged — only the outgoing briefing key is renamed. */
function themeBriefing(theme, themeRows) {
  const outer = isPlainObject(theme) ? theme : {};
  const body = isPlainObject(outer.tokens) ? outer : isPlainObject(outer.body) ? outer.body : outer;
  const inventoryThemeId = themeRows.length === 1 ? (themeRows[0]?.object_id ?? themeRows[0]?.objectId ?? null) : null;
  return {
    objectId: outer.object_id ?? outer.objectId ?? inventoryThemeId,
    name: typeof body.name === 'string' ? body.name : null,
    // Whole, never degraded: it is ~900 chars, and it is the one thing `theme_reconciler` exists to
    // read. The 637KB envelope carried it faithfully and starved the node of everything around it.
    palette: clone(isPlainObject(body.tokens) ? body.tokens : { colors: {}, fonts: {} }),
  };
}

/**
 * Restate `budget.chars` until it describes the string that CONTAINS it. Writing the number changes
 * the serialized length by up to one digit, so this settles in a pass or two; the loop is bounded and
 * never lets the claim fall BELOW the measured length, because a briefing that under-reports its own
 * size is the exact failure this whole rewrite exists to make impossible.
 */
function settleBudgetChars(envelope) {
  let claimed = JSON.stringify(envelope).length;
  for (let pass = 0; pass < 5; pass += 1) {
    envelope.budget.chars = claimed;
    const actual = JSON.stringify(envelope).length;
    if (actual === claimed) return claimed;
    claimed = Math.max(actual, claimed);
  }
  envelope.budget.chars = claimed;
  return claimed;
}

// The FIXED degradation order (CLONE-INTAKE-FIX.md). Each step records what it removed in
// `budget.truncated` before the next is even considered, and the envelope is re-measured between
// steps so nothing is dropped that did not have to be. `site.palette`, `theme.palette` and
// `registry.pageTypes` appear in no step: they are never dropped, at any size.
const DEGRADATION_STEPS = [
  function dropGapsBeyondFivePerPage(envelope) {
    let kept = 0;
    let total = 0;
    for (const page of envelope.pages) {
      total += page.gaps.length;
      if (page.gaps.length > MAX_GAPS_PER_PAGE) page.gaps = page.gaps.slice(0, MAX_GAPS_PER_PAGE);
      kept += page.gaps.length;
    }
    if (kept !== total) {
      envelope.budget.truncated.push({
        field: 'pages[].gaps',
        kept,
        total,
        reason: 'gaps_capped_at_5_per_page',
      });
    }
  },
  function dropPagesBeyondTwenty(envelope) {
    const total = envelope.pages.length;
    if (total <= MAX_PAGES) return;
    envelope.pages = envelope.pages.slice(0, MAX_PAGES);
    envelope.budget.truncated.push({ field: 'pages', kept: MAX_PAGES, total, reason: 'pages_capped_at_20' });
  },
  function dropRecipesBeyondTwenty(envelope) {
    for (const kind of ['section_template', 'template']) {
      const total = envelope.recipes[kind].length;
      if (total <= MAX_RECIPES_PER_KIND) continue;
      envelope.recipes[kind] = envelope.recipes[kind].slice(0, MAX_RECIPES_PER_KIND);
      envelope.budget.truncated.push({
        field: `recipes.${kind}`,
        kept: MAX_RECIPES_PER_KIND,
        total,
        reason: 'recipes_capped_at_20',
      });
    }
  },
  function replaceSectionTypeFieldsWithACount(envelope) {
    let total = 0;
    for (const [type, contract] of Object.entries(envelope.registry.sectionTypes)) {
      if (!Array.isArray(contract.fields)) continue;
      total += contract.fields.length;
      // `required` survives — it is the shorter list and the one a blueprint is actually checked
      // against. The type itself never disappears: a designer that cannot see a type exists will
      // invent one, which is the failure `unknown_section_type` exists to prevent.
      envelope.registry.sectionTypes[type] = { fieldCount: contract.fields.length, required: contract.required };
    }
    if (total > 0) {
      envelope.budget.truncated.push({
        field: 'registry.sectionTypes[].fields',
        kept: 0,
        total,
        reason: 'fields_replaced_with_count',
      });
    }
  },
];

/**
 * Measure, degrade in the FIXED documented order, and refuse rather than ship a silently truncated
 * briefing. Steps run only while the envelope is still over cap, so a run that needs one drop takes
 * one drop; a run that needs none takes none and `budget.truncated` stays empty.
 */
function boundIntake(envelope) {
  if (settleBudgetChars(envelope) <= CLONE_INTAKE_CAP_CHARS) return envelope;
  for (const degrade of DEGRADATION_STEPS) {
    degrade(envelope);
    if (settleBudgetChars(envelope) <= CLONE_INTAKE_CAP_CHARS) return envelope;
  }
  // Every legal drop has been taken and it is still too big. A silently truncated briefing is exactly
  // what produced two starved AI nodes on run_1787508397978_8fyyst; it must not be reachable twice.
  throw new CloneError('intake_cannot_be_bounded');
}

/**
 * Assemble the bounded clone BRIEFING from already-fetched pieces (CLONE-ENGINE-API.md §1, amended by
 * CLONE-INTAKE-FIX.md).
 *
 * This is intake, not discovery: every argument is a value the CALLER already fetched (an emission
 * report, an inventory listing, a `registry_get` response, the `object_get` bodies of the site and the
 * captured theme). Nothing here reaches out for anything — that is exactly what makes it safe to call
 * repeatedly while a Side-B node retries.
 *
 * `siteBody` is the object_get BODY of the site, not its inventory row (CLONE-INTAKE-FIX.md Defect A):
 * an `object_inventory` row carries no `brandTokens`, so the live run's `theme_reconciler` had no
 * slots to enumerate and correctly refused with `theme_not_total` against an empty palette. The row
 * still supplies the site's objectId — and still has to be the ONE active site — but the palette now
 * comes from the body, and a body without one is refused here rather than three stages later.
 *
 * DROPPED ARGUMENTS: `snapshot` and `policy`. Neither appears anywhere in the briefing shape — the
 * snapshot was 241,558 of the 637,769 chars and no AI node ever read it, and the rights policy governs
 * capture and emission, both already finished by the time this envelope exists.
 */
export function buildCloneIntake({
  captureRunId,
  target,
  mapping,
  siteBody,
  theme,
  emissionReport,
  inventory,
  componentRegistry,
  pageTypeRegistry,
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

  const palette = brandTokensFromSiteBody(siteBody);
  // Fail closed, same posture as the empty registry above: without the site's own palette slots there
  // is nothing for a theme proposal to be TOTAL against, and `theme_not_total` becomes a refusal about
  // a missing fetch rather than about a missing color. That mistake has already been made once.
  if (!palette) {
    throw new CloneError(
      'Clone intake requires the site BODY (object_get) carrying brandTokens; an object_inventory row has none.'
    );
  }

  const envelope = {
    artifact: INTAKE_ARTIFACT,
    summary:
      `Bounded clone briefing for "${target}" from capture run ${captureRunId}. Shapes, slots and ` +
      'vocabulary only: the deterministic stages object_get the full page, site and theme bodies ' +
      'themselves. budget.truncated names everything this briefing had to leave out.',
    captureRunId,
    target,
    // T13.3: `palette`, not `brandTokens` — see the comment on `themeBriefing` above. The real
    // platform field this was read FROM (siteBody.brandTokens) is unchanged.
    site: { objectId: activeSites[0].object_id ?? activeSites[0].objectId ?? null, palette },
    theme: themeBriefing(theme, Array.isArray(inventory?.theme) ? inventory.theme : []),
    registry: { sectionTypes, pageTypes },
    pages: briefingPages(mapping, emissionReport),
    recipes: {
      section_template: recipeIndex(inventory?.section_template, 'section_template'),
      template: recipeIndex(inventory?.template, 'template'),
    },
    budget: { chars: 0, cap: CLONE_INTAKE_CAP_CHARS, truncated: [] },
  };

  return boundIntake(envelope);
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// 2. RECIPE VALIDATION
// ═══════════════════════════════════════════════════════════════════════════════════════════════

/**
 * T13.4 PART B — SUBSTITUTION AS A NORMAL OUTCOME, NOT A FAILURE.
 *
 * Wolf: "make any object that just doesn't fit select another existing or available style, this an
 * agentic judgement likely every time." `theme_reconciler` (an AI node this module never runs) already
 * does the right thing for fonts — it declines a webfont a theme token cannot load and picks an
 * existing, already-legal font stack instead, recording why. That behaviour generalises: a validator
 * in THIS module never chooses a substitute — choosing is the model's job (PART C, wired separately)
 * — it only ever says "this cannot be used, and here is what the live registry offers instead."
 *
 * THE LEDGER VOCABULARY. Every substitution outcome this module reports, from any validator, is the
 * same shape:
 *
 *   { kind: 'section_type' | 'font' | 'recipe' | 'page_type',
 *     wanted, chosen,            // chosen === null means declined, not substituted — ALWAYS null here
 *     reason,                    // why the wanted thing could not be used (an existing reason string)
 *     basis,                     // why these candidates (or why none fit)
 *     fidelityCost: 'none' | 'minor' | 'material',
 *     substitutable,             // true iff candidates.length > 0
 *     candidates }                // the registered alternatives that COULD stand in — never a choice
 *
 * `chosen` stays `null` everywhere in this file: nothing here is authorized to pick one of
 * `candidates` and call it the answer. `fidelityCost` is likewise a property of the SITUATION, not of
 * a chosen candidate this module never picks — 'minor' when at least one same-capability candidate
 * exists, 'material' when none does (the wanted thing is simply lost unless a human or a later model
 * step supplies one). `substitutionEntry` below is the one and only place a ledger entry is built, so
 * every caller produces the identical shape.
 */
function substitutionBasis({ kind, substitutable, candidateCount, wanted }) {
  if (!substitutable) {
    switch (kind) {
      case 'section_type':
        return `no live, allowed section type shares ${JSON.stringify(wanted)}'s compatibility class`;
      case 'page_type':
        return 'no other page type is registered on this site';
      case 'recipe':
        return 'no existing recipe of this kind is registered to reuse';
      case 'font':
        return "no other font value on this site's palette has a usable fallback stack to offer instead";
      default:
        return 'no compatible alternative is registered';
    }
  }
  switch (kind) {
    case 'section_type':
      return `${candidateCount} live, allowed section type(s) share ${JSON.stringify(wanted)}'s compatibility class`;
    case 'page_type':
      return `${candidateCount} other page type(s) are registered on this site`;
    case 'recipe':
      return `${candidateCount} existing recipe(s) of this kind are already registered and could be reused`;
    case 'font':
      return `${candidateCount} font value(s) already active on this site's palette have a usable fallback stack`;
    default:
      return `${candidateCount} registered alternative(s) are available`;
  }
}

/** The ONE constructor for a substitution ledger entry (see the vocabulary comment above). Every
 *  `substitutions[]` array in this module — `validateThemeProposal`'s, `buildRecipeMintPlan`'s,
 *  `buildCloneRunReport`'s — is built exclusively from entries this function returns, so the shape
 *  can never drift between kinds or between call sites. */
function substitutionEntry({ kind, wanted, reason, candidates }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const substitutable = list.length > 0;
  return {
    kind,
    wanted,
    chosen: null,
    reason,
    basis: substitutionBasis({ kind, substitutable, candidateCount: list.length, wanted }),
    fidelityCost: substitutable ? 'minor' : 'material',
    substitutable,
    candidates: list,
  };
}

/**
 * SECTION-TYPE COMPATIBILITY CLASSES — the hard boundary a substitution may never cross (PART B item
 * 3). A capability class groups section types that perform the SAME function for a visitor; two types
 * in different classes are not stylistic variants of one another, they are different capabilities, and
 * swapping one for the other is not a substitution, it is a silent deletion of whatever the original
 * did. The textbook case, named directly in the spec: `contact_form` collects a visitor's message
 * through a live FORM object; `prose` displays static text. A clone that "substitutes" prose for a
 * missing contact_form has not adapted the page — it has removed the page's only way to hear from a
 * visitor, and nothing downstream would ever be told that happened. That must be a DECLINE
 * (`chosen: null`, `fidelityCost: 'material'`), never a substitution.
 *
 * This table is deliberately CONSERVATIVE: most section types are their own one-member class, because
 * most of them do something no sibling in the registry also does (site search is not a FAQ list is not
 * a live product feed). A class only groups two or more types when the schema itself already documents
 * them as interchangeable presentations of the same capability — see the comment on each class.
 *
 * `classOfSectionType` and `substitutionCandidatesForSectionType` are the ONLY two ways this table is
 * ever read, and neither one — nor anything that calls them — may build a candidate list by any other
 * means (string similarity, fuzzy matching, a hand-picked override). That is what makes a cross-class
 * substitution IMPOSSIBLE rather than merely discouraged: the only door out of a class is membership in
 * that same class, and this table is the only place membership is declared. `assertSameCompatibilityClass`
 * below is the runtime guard a later, choosing caller (PART C) can — and must — run any (wanted, chosen)
 * pair through before treating a swap as legitimate.
 */
const SECTION_TYPE_COMPATIBILITY_CLASSES = {
  // Page/section openers: heading + supporting copy + optional actions. section-v1.ts documents `lede`
  // as literally "the same field shape as hero but a distinct, lighter presentation" — the one pair in
  // the registry the schema itself calls a presentation choice, not a capability difference.
  intro_banner: ['hero', 'lede'],
  // Pure reading content: conveys information as text, collects nothing, embeds nothing, links to
  // nothing external. Swapping among these changes HOW text is laid out, never what the page can do.
  narrative_text: ['prose', 'checklist', 'bio'],
  // Hand-authored internal navigation aids: a curated set of links/cards the visitor can browse.
  curated_links: ['content_grid', 'link_list'],
  // An ORDERED sequence shown to the visitor — order IS the content (a numbered process or a
  // chronology), unlike the unordered curated_links set above.
  ordered_sequence: ['steps', 'timeline'],
  // Structured/quantitative summary content presented as a table or figure set.
  structured_comparison: ['comparison_table', 'stats'],
  // Display-only social proof / brand association — no data collection, no live query.
  social_proof: ['testimonial', 'brand_row'],
  // Visitor-submitted data capture through a live FORM object. THE example this whole boundary exists
  // for: swapping either of these for anything outside this class deletes the page's ability to
  // receive visitor input — a function loss, not a style change.
  lead_capture: ['contact_form', 'newsletter_signup'],
  // Everything below performs a capability nothing else in the registry also performs, so each is its
  // own singleton class: one focused call-to-action moment, a specific question set, live commerce
  // data, plan/price data, bound first-party media, live site search, third-party embedded content
  // (its own risk surface), a post-submission acknowledgment tied to one specific form flow, a
  // free-form block-tree container, and a fixed text+media layout with no sibling in the registry.
  cta_moment: ['cta_banner'],
  reference_qa: ['faq'],
  commerce_feed: ['product_preview'],
  pricing_data: ['pricing_table'],
  bound_media: ['media'],
  site_search: ['search'],
  external_embed: ['content_embed'],
  form_result: ['form_confirmation'],
  free_composition: ['composition'],
  text_media_split: ['content_split'],
};

const SECTION_TYPE_CLASS_BY_TYPE = new Map(
  Object.entries(SECTION_TYPE_COMPATIBILITY_CLASSES).flatMap(([className, types]) =>
    types.map((type) => [type, className])
  )
);

/** The compatibility class a KNOWN section type belongs to, or `null` for a type this table has never
 *  heard of — which includes every type invented by a design that failed `unknown_section_type` for a
 *  name the live registry never registered either. A `null` class means "no basis to say what would
 *  stand in for it exists," not "anything will do." Exported so PART C (and this module's own tests)
 *  can introspect class membership without reaching into the table directly. */
export function classOfSectionType(type) {
  return SECTION_TYPE_CLASS_BY_TYPE.get(type) ?? null;
}

/**
 * The section types that COULD stand in for `wanted`, and nothing else: same compatibility class,
 * present in the LIVE registry (`registrySectionTypes`, i.e. `intake.registry.sectionTypes` — the
 * live registry is the only thing allowed to say a type exists, same discipline as everywhere else in
 * this module), and — when the caller is substituting into a page-type slot — present in that page
 * type's `allowed` list (`allowedTypes`; omit it, or pass `undefined`, when there is no slot to be
 * allowed into, e.g. a standalone section_template design). This function does not choose; it
 * enumerates. Choosing which candidate to use, if any, is the model's job (PART C) — this function's
 * only contract is that its output can never cross a class boundary, which is what makes the boundary
 * a hard one rather than a convention.
 */
export function substitutionCandidatesForSectionType(wanted, { registrySectionTypes, allowedTypes } = {}) {
  const className = classOfSectionType(wanted);
  if (!className) return [];
  const registryKeys = new Set(Object.keys(registrySectionTypes ?? {}));
  const allowedSet = Array.isArray(allowedTypes) ? new Set(allowedTypes) : null;
  return SECTION_TYPE_COMPATIBILITY_CLASSES[className].filter(
    (type) => type !== wanted && registryKeys.has(type) && (!allowedSet || allowedSet.has(type))
  );
}

/** The runtime guard behind "cross-class substitution impossible rather than merely discouraged": a
 *  caller that DOES choose a substitute (PART C, never this module) must run the (wanted, chosen) pair
 *  through this before treating the swap as legitimate. Throws — it does not return a boolean — because
 *  a cross-class swap is not a validation failure to report, it is a bug in the caller that must not be
 *  allowed to proceed. Two section types with the same, non-null class pass; anything else throws,
 *  INCLUDING wanted === chosen (a "substitution" that changes nothing is not one) and either side
 *  having no known class at all (nothing to prove the swap is safe). */
export function assertSameCompatibilityClass(wanted, chosen) {
  const wantedClass = classOfSectionType(wanted);
  const chosenClass = classOfSectionType(chosen);
  if (!wantedClass || !chosenClass || wantedClass !== chosenClass || wanted === chosen) {
    throw new CloneError(
      `assertSameCompatibilityClass: "${wanted}" and "${chosen}" are not a legal substitution — ` +
        'cross-class (or non-)substitution is not allowed.'
    );
  }
}

/**
 * Structural re-validation of a blueprint's `data` against one live section type's FIELD CONTRACT —
 * the `{fields, required}` pair `intake.registry.sectionTypes` now carries (CLONE-INTAKE-FIX.md
 * Defect B), not a JSON Schema.
 *
 * WHAT THIS STILL CATCHES, and why that is the right line to draw. CLONE-ENGINE-API.md §2 asks for
 * three checks: required keys present, no unknown key, enum members legal. The first two are exactly
 * what a list of field names can answer, and they are answered here, before a single MCP call is made.
 * The third is not: an enum's members are values, not field names, and the briefing that used to
 * carry them was 32,694 chars — 68% of the entire dependency budget — which is what starved both AI
 * nodes on the live run. An enum-illegal value now travels one stage further and is refused by
 * `object_validate` against the real zod schema server-side, which was always the authority on it
 * (see the note on drift below); a wrong FIELD, the far commoner design error, is still refused here.
 *
 * Deliberately NOT a JSON-schema engine, for the same reason it never was one: full semantic
 * validation (string formats, numeric bounds, cross-field refinements) belongs to `object_validate`,
 * and re-implementing it in a network-free module would either drift from the live schema the moment
 * either side changes or require vendoring zod itself.
 */
function fieldContractErrors(value, contract, path = 'data') {
  if (!isPlainObject(contract)) return [];
  if (!isPlainObject(value)) return [`${path}: expected an object`];
  const errors = [];
  for (const key of contract.required ?? []) {
    if (!(key in value)) errors.push(`${path}.${key}: required key is missing`);
  }
  // `fields` is absent only when the briefing was degraded to a bare `fieldCount` (step 4 of the
  // documented degradation order) — there is then no list to check a key against, and inventing one
  // would reject every legal design. The count still tells a reader the names were withheld, and
  // `budget.truncated` says so explicitly.
  if (Array.isArray(contract.fields) && contract.fields.length > 0) {
    for (const key of Object.keys(value)) {
      if (!contract.fields.includes(key)) errors.push(`${path}.${key}: is not a field of this section type`);
    }
  }
  return errors;
}

/** The reuse-first lookup CLONE-ENGINE-API.md §2's `name_collision` rule needs. Reads the briefing's
 *  own recipe index — already normalized to `{objectId, name, ...}` at intake — rather than raw
 *  inventory rows, so the several shapes an inventory row can take are decoded exactly once. */
const existingRecipeObjectId = (rows, name) =>
  (Array.isArray(rows) ? rows : []).find((row) => row?.name === name)?.objectId ?? null;

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
  // shape the platform already has an answer for. Not itself a "substitution" in the ledger sense —
  // the design was never going to be minted new — so it carries no candidates.
  if (existingRecipeObjectId(intake.recipes?.section_template, design.name)) {
    return {
      ok: false,
      reason: 'name_collision',
      detail: `a section_template named "${design.name}" already exists`,
      substitutable: false,
      candidates: [],
    };
  }

  const contract = intake.registry.sectionTypes[blueprint.type];
  if (contract === undefined) {
    // PART B item 2: this cannot be used — here is what the live registry offers instead, if
    // anything, from `blueprint.type`'s OWN compatibility class (item 3's hard boundary). This
    // function never chooses among `candidates`; see substitutionCandidatesForSectionType's doc.
    const candidates = substitutionCandidatesForSectionType(blueprint.type, {
      registrySectionTypes: intake.registry.sectionTypes,
    });
    return {
      ok: false,
      reason: 'unknown_section_type',
      detail: `"${blueprint.type}" is not in the live component registry`,
      wanted: blueprint.type,
      substitutable: candidates.length > 0,
      candidates,
    };
  }
  const errors = fieldContractErrors(blueprint.data ?? {}, contract);
  if (errors.length > 0) {
    // The TYPE is fine; the DATA is wrong. No compatibility-class candidate answers a field-shape
    // mismatch, so this stays a pure decline — see buildRecipeMintPlan's 'recipe'-kind substitution
    // for the higher-level "reuse an existing recipe instead" answer to a design that doesn't fit.
    return { ok: false, reason: 'blueprint_schema_mismatch', detail: errors, substitutable: false, candidates: [] };
  }

  // T13.4 PART B item 6: tolerant reader for the designer's `when_to_use` (its own outputSchema uses
  // snake_case), same discipline as `appliesTo`/`applies_to` in validateTemplateDesign below. An empty
  // result is refused OUTRIGHT rather than minted with `whenToUse: ''` — an empty whenToUse is a
  // warning that blocks PUBLISHING the recipe later (CLONE-ENGINE-API.md's own downstream gate), so a
  // recipe that cannot explain itself must not be minted in the first place.
  const camelWhenToUse = typeof design.whenToUse === 'string' ? design.whenToUse.trim() : '';
  const snakeWhenToUse = typeof design.when_to_use === 'string' ? design.when_to_use.trim() : '';
  const whenToUse = camelWhenToUse || snakeWhenToUse;
  if (!whenToUse) {
    return {
      ok: false,
      reason: 'recipe_metadata_incomplete',
      detail: 'a section_template design requires whenToUse (or when_to_use) explaining when to use it',
      substitutable: false,
      candidates: [],
    };
  }

  const normalized = clone(design);
  normalized.blueprint.id = normalized.blueprint.id || mintPlaceholderSectionId(design.name, blueprint.type);
  normalized.scope = normalized.scope || 'one_off';
  // Emit only the canonical name, same discipline as appliesTo/applies_to below.
  normalized.whenToUse = whenToUse;
  delete normalized.when_to_use;
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
  // TOLERANT READER (input only): a designer node may emit either `appliesTo` (canonical) or
  // `applies_to` (snake_case) — this is a normalization boundary, not a security boundary, so
  // accepting both protects any future caller. `appliesTo` wins when both are present and
  // non-empty. The CANONICAL name stays `appliesTo` everywhere downstream of this point (see
  // `normalized.appliesTo` below and `recipeBody`) — that is what the platform's own template
  // body carries (`row?.body?.appliesTo`), and nothing here writes `applies_to` to the platform.
  const camelAppliesTo = Array.isArray(design.appliesTo) ? design.appliesTo : [];
  const snakeAppliesTo = Array.isArray(design.applies_to) ? design.applies_to : [];
  const appliesTo = camelAppliesTo.length > 0 ? camelAppliesTo : snakeAppliesTo;
  if (appliesTo.length === 0) throw new CloneError('A template design requires at least one appliesTo page type.');
  const slots = Array.isArray(design.slots) ? design.slots : [];

  if (existingRecipeObjectId(intake.recipes?.template, design.name)) {
    return {
      ok: false,
      reason: 'name_collision',
      detail: `a template named "${design.name}" already exists`,
      substitutable: false,
      candidates: [],
    };
  }

  for (const pageType of appliesTo) {
    if (!(pageType in intake.registry.pageTypes)) {
      // The wanted PAGE TYPE doesn't exist; the "registered alternatives" are simply the other page
      // types the live registry does carry — page types have no sub-classification (item 3's hard
      // boundary is about section-type CAPABILITY classes; a page type is just a route pattern +
      // section policy), so every other registered id is offered and the model judges fit.
      const candidates = Object.keys(intake.registry.pageTypes).sort();
      return {
        ok: false,
        reason: 'applies_to_page_type_missing',
        detail: `page type "${pageType}" is not in the live page-type registry`,
        wanted: pageType,
        substitutable: candidates.length > 0,
        candidates,
      };
    }
  }

  // A section-type candidate for one SLOT must be legal for EVERY page type this template applies
  // to, or it would just fail slot_section_type_not_allowed against a different appliesTo entry next.
  // `null` means "no restriction from any appliesTo page type" (every one allows 'any'); a Set means
  // the intersection of what every restricting page type allows.
  let allowedAcrossAppliesTo = null;
  for (const pageType of appliesTo) {
    const allowed = intake.registry.pageTypes[pageType].allowed;
    if (allowed === 'any') continue;
    const set = new Set(allowed);
    allowedAcrossAppliesTo = allowedAcrossAppliesTo
      ? new Set([...allowedAcrossAppliesTo].filter((type) => set.has(type)))
      : set;
  }
  const allowedTypesForCandidates = allowedAcrossAppliesTo ? [...allowedAcrossAppliesTo] : undefined;

  for (const slot of slots) {
    const contract = intake.registry.sectionTypes[slot.sectionType];
    if (contract === undefined) {
      const candidates = substitutionCandidatesForSectionType(slot.sectionType, {
        registrySectionTypes: intake.registry.sectionTypes,
        allowedTypes: allowedTypesForCandidates,
      });
      return {
        ok: false,
        reason: 'unknown_section_type',
        detail: `slot "${slot.slotId ?? '(unnamed)'}" names "${slot.sectionType}", which is not in the live component registry`,
        wanted: slot.sectionType,
        substitutable: candidates.length > 0,
        candidates,
      };
    }
    if (slot.blueprint) {
      const errors = fieldContractErrors(slot.blueprint.data ?? {}, contract);
      if (errors.length > 0) {
        return { ok: false, reason: 'blueprint_schema_mismatch', detail: errors, substitutable: false, candidates: [] };
      }
    }
    for (const pageType of appliesTo) {
      const allowed = intake.registry.pageTypes[pageType].allowed;
      if (allowed !== 'any' && !allowed.includes(slot.sectionType)) {
        // The type IS real — it is simply not allowed in THIS page type's slot. This is exactly the
        // "existing object that just doesn't fit" case: offer same-class, live, allowed alternatives;
        // never a cross-class one (item 3 — a contact_form can never candidate-in for a prose slot).
        const candidates = substitutionCandidatesForSectionType(slot.sectionType, {
          registrySectionTypes: intake.registry.sectionTypes,
          allowedTypes: allowedTypesForCandidates,
        });
        return {
          ok: false,
          reason: 'slot_section_type_not_allowed',
          detail: `slot "${slot.slotId ?? '(unnamed)'}" places "${slot.sectionType}", which page type "${pageType}" does not allow`,
          wanted: slot.sectionType,
          substitutable: candidates.length > 0,
          candidates,
        };
      }
    }
  }

  const slottedTypes = new Set(slots.map((slot) => slot.sectionType));
  for (const pageType of appliesTo) {
    const missing = intake.registry.pageTypes[pageType].required.filter((type) => !slottedTypes.has(type));
    if (missing.length > 0) {
      // A gap, not a bad fit: nothing was proposed for the missing slot, so there is no "wanted" value
      // whose compatibility class could be searched. buildRecipeMintPlan's 'recipe'-kind substitution
      // still offers whole EXISTING templates as a higher-level alternative to designing a new one.
      return {
        ok: false,
        reason: 'required_section_not_covered',
        detail: `page type "${pageType}" requires ${missing.join(', ')}, which no slot in this template provides`,
        substitutable: false,
        candidates: [],
      };
    }
  }

  // T13.4 PART B item 6, same discipline as validateSectionTemplateDesign above and the same
  // appliesTo/applies_to tolerant-read pattern this function already uses.
  const camelWhenToUse = typeof design.whenToUse === 'string' ? design.whenToUse.trim() : '';
  const snakeWhenToUse = typeof design.when_to_use === 'string' ? design.when_to_use.trim() : '';
  const whenToUse = camelWhenToUse || snakeWhenToUse;
  if (!whenToUse) {
    return {
      ok: false,
      reason: 'recipe_metadata_incomplete',
      detail: 'a template design requires whenToUse (or when_to_use) explaining when to use it',
      substitutable: false,
      candidates: [],
    };
  }

  const normalized = clone(design);
  normalized.scope = normalized.scope || 'one_off';
  // Emit only the canonical name — a design that arrived as `applies_to` (or as both) normalizes
  // to `appliesTo` alone, so nothing downstream (recipeBody, the platform write) ever sees the
  // snake_case spelling.
  normalized.appliesTo = appliesTo;
  delete normalized.applies_to;
  normalized.slots = slots.map((slot, index) => ({ ...clone(slot), slotId: slot.slotId || `slot_${index}` }));
  normalized.whenToUse = whenToUse;
  delete normalized.when_to_use;
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
  // T13.4 PART B item 5: `object_create`'s schema REQUIRES `site` — omitting it is exactly the live
  // defect (a body the platform itself validated `eligible: true, blockers: []` was still rejected
  // `400: Invalid request fields` for lacking it). Guard here, belt and braces alongside PART A's
  // adapter (which throws at the wire boundary if `site` is absent from the engine object).
  if (!isPlainObject(intake.site) || typeof intake.site.objectId !== 'string' || !intake.site.objectId) {
    throw new CloneError('A recipe mint plan requires an intake carrying site.objectId.');
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
          // Shape parity with every other rejected entry (see below) — an authoring bug, not a "does
          // not fit" outcome, so always non-substitutable; never carried into `substitutions[]`.
          substitutable: false,
          candidates: [],
          ...(sourceCandidateIds ? { sourceCandidateIds } : {}),
        });
        continue;
      }

      if (!outcome.ok) {
        if (outcome.reason === 'name_collision') {
          reused.push({ objectType, name, objectId: existingRecipeObjectId(intake.recipes?.[objectType], name) });
        } else {
          rejected.push({
            kind: objectType,
            name,
            reason: outcome.reason,
            detail: outcome.detail,
            // PART B item 2: passed straight through from the validator — this function never adds to
            // or edits what a validator already determined about substitutability.
            ...(outcome.wanted !== undefined ? { wanted: outcome.wanted } : {}),
            substitutable: Boolean(outcome.substitutable),
            candidates: Array.isArray(outcome.candidates) ? outcome.candidates : [],
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
        // T13.4 PART B item 5: `site` travels on every create from here on — `object_create`'s schema
        // requires it, and `intake.site.objectId` is the one place a clone run's site id can come
        // from (buildCloneIntake's own single-authority guarantee — see the comment on `themeBriefing`
        // and `validateThemeProposal`).
        site: intake.site.objectId,
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

  // PART B items 1/2/3: the ledger. `malformed_design` (an authoring bug the validator never even
  // reached) and `recipe_metadata_incomplete` (item 6 — a completeness gate, not a fit problem) are
  // deliberately excluded: neither is "an object that doesn't fit", so neither belongs in a report of
  // compromises the run made. `blueprint_schema_mismatch` and `required_section_not_covered` have no
  // section-type-level candidate (the type was fine; the design around it wasn't), so they surface at
  // the RECIPE level instead — Wolf's "select another existing or available style", applied to whole
  // recipes: the candidates are existing recipes of the SAME objectType already registered on the
  // site. That objectType filter is itself a compatibility-class boundary — a section_template can
  // never candidate-in for a rejected template design, or vice versa.
  const substitutions = [];
  for (const entry of rejected) {
    if (entry.reason === 'malformed_design' || entry.reason === 'recipe_metadata_incomplete') continue;
    if (entry.reason === 'unknown_section_type' || entry.reason === 'slot_section_type_not_allowed') {
      substitutions.push(
        substitutionEntry({
          kind: 'section_type',
          wanted: entry.wanted,
          reason: entry.reason,
          candidates: entry.candidates,
        })
      );
    } else if (entry.reason === 'applies_to_page_type_missing') {
      substitutions.push(
        substitutionEntry({
          kind: 'page_type',
          wanted: entry.wanted,
          reason: entry.reason,
          candidates: entry.candidates,
        })
      );
    } else if (entry.reason === 'blueprint_schema_mismatch' || entry.reason === 'required_section_not_covered') {
      const existingRecipes = (intake.recipes?.[entry.kind] ?? []).map((row) => ({
        objectId: row.objectId,
        name: row.name,
      }));
      substitutions.push(
        substitutionEntry({ kind: 'recipe', wanted: entry.name, reason: entry.reason, candidates: existingRecipes })
      );
    }
  }

  return {
    schemaVersion: 'clone-mint-plan.v1',
    target,
    creates,
    rejected,
    reused,
    substitutions,
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

/** The site's OWN already-declared font values that could stand in for a `wanted` value this stage
 *  just dropped — "an existing or available style" (Wolf), read from `intake.site.palette.fonts`
 *  itself rather than invented. Deduplicated, excludes `wanted`, and re-checked against
 *  `hasFontFallbackStack` defensively: a captured site's raw computed style can still carry a bare
 *  single family in another slot (the same shape this function's caller just dropped), and offering
 *  an equally-broken candidate back would defeat the point. */
function existingFontCandidates(existingFontSlots, wanted) {
  const seen = new Set();
  const candidates = [];
  for (const value of Object.values(existingFontSlots ?? {})) {
    if (typeof value !== 'string' || value === wanted || seen.has(value) || !hasFontFallbackStack(value)) continue;
    seen.add(value);
    candidates.push(value);
  }
  return candidates;
}

/**
 * Re-validate a proposed theme token set against the site's OWN declared slots (CLONE-ENGINE-API.md
 * §4). `intake.site.palette` is the authority on which slots exist — the proposal supplies values,
 * never new slot names, because inventing a slot the renderer's CustomStyles.astro never emits a CSS
 * variable for would be a token nothing on the site ever reads.
 *
 * SIGNATURE (CLONE-INTAKE-FIX.md Defect A). The contract used to take `{ proposal, siteBody }` and the
 * caller was left to fetch a site body of its own; on the live run nobody did, the stage was handed an
 * `object_inventory` ROW instead — which carries no `brandTokens` at all — and the totality check
 * refused a palette it could not see. Reconciled by making the BRIEFING the single authority: intake
 * fetches the site body once, refuses outright if it has no palette, and publishes it as
 * `intake.site.palette`; this function reads it from there. There is now exactly one place a site
 * palette can enter a clone run, and it is the same place `buildCloneRunReport` reads the site's id
 * from — so a caller cannot validate a proposal against one site and report against another.
 *
 * FIELD NAME (T13.3): `palette`, not `brandTokens`/`tokens` — see the comment on `themeBriefing`
 * above. The executor's per-node prompt redactor treats any key matching `/token/i` as a credential
 * and replaces it with "[REDACTED]" before the model sees it; `intake.site.brandTokens` collided.
 */
export function validateThemeProposal({ proposal, intake }) {
  if (!isPlainObject(proposal)) throw new CloneError('A theme proposal is required.');
  if (!isPlainObject(intake?.site?.palette)) {
    throw new CloneError('A clone intake carrying site.palette is required to validate a theme proposal against.');
  }

  const applied = { colors: {}, fonts: {} };
  const dropped = [];
  const existingColorSlots = intake.site.palette.colors ?? {};
  const existingFontSlots = intake.site.palette.fonts ?? {};

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
  // PART B item 1/2/3, generalising the fix already proven for fonts (Wolf's own example: a webfont a
  // theme token cannot load is DECLINED and an existing, already-legal font stack is offered instead
  // — never chosen here; see substitutionEntry's doc comment). `unknown_slot` gets no candidates: the
  // proposal named a slot the site does not have at all, so there is no live thing to substitute INTO.
  // The other two font drop reasons name a REAL slot with a value that doesn't fit it, so the site's
  // own OTHER already-declared font values — "an existing or available style" — are exactly what a
  // caller (or PART C) should be told exists.
  const fontSubstitutions = [];
  for (const [slot, value] of Object.entries(proposal.fonts ?? {})) {
    if (!(slot in existingFontSlots)) {
      dropped.push({ slot, value, reason: 'unknown_slot' });
    } else if (typeof value === 'string' && CSS_URL_OR_IMPORT_RE.test(value)) {
      dropped.push({ slot, value, reason: 'external_reference_forbidden' });
      fontSubstitutions.push(
        substitutionEntry({
          kind: 'font',
          wanted: value,
          reason: 'external_reference_forbidden',
          candidates: existingFontCandidates(existingFontSlots, value),
        })
      );
    } else if (!hasFontFallbackStack(value)) {
      dropped.push({ slot, value, reason: 'no_fallback_stack' });
      fontSubstitutions.push(
        substitutionEntry({
          kind: 'font',
          wanted: value,
          reason: 'no_fallback_stack',
          candidates: existingFontCandidates(existingFontSlots, value),
        })
      );
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
  // drift-prone duplication this file avoids elsewhere (see `fieldContractErrors`'s doc comment). A
  // proposal that is itself total is a strictly stronger, and simpler to verify, guarantee.
  const missingKeys = Object.keys(existingColorSlots)
    .filter((slot) => !(slot in applied.colors))
    .sort();

  // PART B item 4: the ledger, as its own first-class field — `dropped[]` is left byte-for-byte as it
  // was (every existing caller/test that reads it is unaffected); `substitutions[]` is additive.
  return { applied, dropped, missingKeys, substitutions: fontSubstitutions };
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

/** A ledger-shaped rejection for an adjudicated `chosen` this engine will never apply — same shape
 *  every other substitution entry uses, `chosen: null` (it was NOT applied), with the model's
 *  rejected proposal named in `basis` so an operator sees exactly what was refused and why, never
 *  buried. `reason` is new (T13.4 PART C's closing instruction): the wanted thing still could not be
 *  used, and now neither could the model's proposed fix. */
function illegalSubstitutionRejection({ wanted, proposedChosen, candidates }) {
  const list = Array.isArray(candidates) ? candidates : [];
  const candidateList = list.length > 0 ? list.map((candidate) => JSON.stringify(candidate)).join(', ') : 'none';
  return {
    kind: 'section_type',
    wanted,
    chosen: null,
    reason: 'substitution_not_in_candidates',
    basis:
      `the model proposed ${JSON.stringify(proposedChosen)} for ${JSON.stringify(wanted)}, which is not ` +
      `one of this engine's own candidates (${candidateList}) — never applied`,
    fidelityCost: 'material',
    substitutable: list.length > 0,
    candidates: list,
  };
}

/**
 * T13.4 PART C: `fit_adjudicator` (an AI node this module never runs) reads this module's OWN
 * `substitutions[]` ledger and CHOOSES — that is its whole job, per the vocabulary's `chosen` field.
 * This function is the one place its choices are RE-VALIDATED before anything is applied, the same
 * advisory/re-validate posture this module already takes toward every other AI-node output
 * (CLONE-ENGINE-API.md's whole design). A `choices` entry of `kind: 'section_type'` is applied ONLY
 * when BOTH hold, checked in this order:
 *   1. `assertSameCompatibilityClass(wanted, chosen)` does not throw — the item-3 hard boundary,
 *      enforced again here rather than trusted from the model's own `kind` label;
 *   2. `chosen` is LITERALLY a member of the `candidates` THIS ENGINE computed for that `wanted` at
 *      mint time (`mintReport.substitutions`) — never a value the model invented, however plausible
 *      it looks. This is why the engine builds the candidate list in the first place.
 * Anything failing either check is REJECTED — `substitution_not_in_candidates` — and never applied;
 * the page section it would have touched keeps its original, uncoerced type. `declined` entries and
 * choices of any other kind are untouched here; they carry no restamp-time apply step.
 */
function resolveSectionTypeSubstitutions(mintReport, adjudication) {
  const applied = new Map(); // wanted -> chosen, validated
  const rejected = [];
  if (!isPlainObject(adjudication)) return { applied, rejected };

  const candidatesByWanted = new Map(
    (mintReport?.substitutions ?? [])
      .filter((entry) => isPlainObject(entry) && entry.kind === 'section_type')
      .map((entry) => [entry.wanted, Array.isArray(entry.candidates) ? entry.candidates : []])
  );

  for (const choice of adjudication.choices ?? []) {
    if (!isPlainObject(choice) || choice.kind !== 'section_type') continue;
    const { wanted, chosen } = choice;
    const candidates = candidatesByWanted.get(wanted) ?? [];
    let sameClass = true;
    try {
      assertSameCompatibilityClass(wanted, chosen);
    } catch {
      sameClass = false;
    }
    if (sameClass && candidates.includes(chosen)) {
      applied.set(wanted, chosen);
    } else {
      rejected.push(illegalSubstitutionRejection({ wanted, proposedChosen: chosen, candidates }));
    }
  }
  return { applied, rejected };
}

/**
 * Build the ops that restamp the site's already-emitted pages once mint has run (CLONE-ENGINE-API.md
 * §5). A page's final section list — already carrying whatever first-party asset paths emission bound
 * — is written back verbatim as a sequence of `upsert_section` ops (the same primitive emit.mjs's own
 * reuse path uses): nothing here re-derives a section's data, so nothing here can rewrite, drop or
 * synthesize an asset field. `assertNoRemoteAssetValues` is the belt to that braces: a regression
 * anywhere upstream that let a remote URL through is caught here, not shipped.
 *
 * SIGNATURE (CLONE-INTAKE-FIX.md Defect B): the page bodies arrive as an explicit `pageBodies`
 * argument, not through the envelope. The briefing carries page SHAPES — an ordered list of section
 * type names — because that is all the AI nodes ever read; full page bodies were part of the 156,239
 * chars of `source.mapping` that starved them. This stage is deterministic engine code WITH transport,
 * so it `object_get`s each body it is about to patch, which is also the more correct source: it
 * restamps what the page holds NOW, not what a mapping said it held when capture ran.
 *
 * `pageBodies` is `[{ objectId, body }]` (a bare `{ objectId, sections }` or a whole `object_get`
 * record are both accepted and unwrapped) — one entry per page the caller fetched, in any order.
 *
 * A page is SKIPPED — not partially restamped — when:
 *   - no body was supplied for it (`source_page_missing`): nothing to restamp from, exactly as when
 *     the mapping used to be missing its source page;
 *   - its section list is empty (`would_empty_page`): the same T12.28 refusal emit.mjs's
 *     `reuseOpsForPage` makes — an empty body is a fetch or mapping failure, never an instruction to
 *     blank a live page;
 *   - ANY of its capture-map candidates was the source of a recipe design that got REJECTED at mint
 *     (`recipe_rejected_at_mint`, keyed by the `sourceCandidateIds` `buildRecipeMintPlan` carries
 *     through onto `rejected[]`, matched against the `candidateIds` the briefing publishes per page):
 *     restamping the rest of the page while quietly leaving out the piece that depended on the failed
 *     recipe is exactly the "half-restamped" outcome the contract forbids, so the whole page is left
 *     untouched instead.
 *
 * `adjudication` (T13.4 PART C, OPTIONAL — every existing caller and test that omits it sees BYTE-
 * IDENTICAL output to before this argument existed): `fit_adjudicator`'s `clone_fit_adjudication.v1`
 * output, `{ choices: [{kind, wanted, chosen, basis, fidelityCost}], declined: [...] }`. Every
 * `choices` entry of `kind: 'section_type'` is RE-VALIDATED (see `resolveSectionTypeSubstitutions`)
 * before it is applied — a section whose captured type equals a validated choice's `wanted` is
 * stamped with `chosen` instead of its original type; a choice that fails re-validation is rejected
 * (`substitution_not_in_candidates`, returned in `substitutionRejections` for the report to surface)
 * and the section it would have touched keeps its original, uncoerced type. This module never trusts
 * the model's own claim of what is safe — it re-derives safety from its own candidate list every time.
 */
export function buildRestampOps({ intake, mintReport, pageBodies, adjudication }) {
  if (!isPlainObject(intake) || !Array.isArray(intake.pages)) {
    throw new CloneError('Restamp requires a clone intake carrying its briefed pages.');
  }
  if (!isPlainObject(mintReport)) throw new CloneError('Restamp requires an executed mint report.');

  const sectionsByObjectId = new Map(
    (Array.isArray(pageBodies) ? pageBodies : []).map((entry) => {
      const body = isPlainObject(entry?.body) ? entry.body : entry;
      return [entry?.objectId ?? entry?.object_id ?? null, Array.isArray(body?.sections) ? body.sections : []];
    })
  );
  const blockedCandidateIds = new Set((mintReport.rejected ?? []).flatMap((entry) => entry.sourceCandidateIds ?? []));
  const { applied: sectionTypeChoices, rejected: substitutionRejections } = resolveSectionTypeSubstitutions(
    mintReport,
    adjudication
  );

  const restamp = [];
  const skipped = [];

  for (const page of intake.pages) {
    const sections = sectionsByObjectId.get(page.objectId);
    if (!sections) {
      skipped.push({ objectId: page.objectId, reason: 'source_page_missing' });
      continue;
    }
    if ((page.candidateIds ?? []).some((candidateId) => blockedCandidateIds.has(candidateId))) {
      skipped.push({ objectId: page.objectId, reason: 'recipe_rejected_at_mint' });
      continue;
    }
    if (sections.length === 0) {
      skipped.push({ objectId: page.objectId, reason: 'would_empty_page' });
      continue;
    }

    const ops = sections.map((section, index) => {
      const stamped = clone(section);
      // The ONLY effect a validated adjudication has on restamp: a captured section's TYPE, and
      // nothing else about it, is swapped for the engine-validated `chosen` when its original type
      // was the `wanted` of a substitution this run's own ledger recorded.
      if (sectionTypeChoices.has(stamped.type)) stamped.type = sectionTypeChoices.get(stamped.type);
      return { op: 'upsert_section', section: stamped, position: index };
    });
    ops.forEach((op) => assertNoRemoteAssetValues(op.section, `${page.objectId}.sections.${op.position}`));
    restamp.push({ objectId: page.objectId, ops });
  }

  // Ground truth for buildCloneRunReport: exactly which (wanted -> chosen) swaps this run VALIDATED
  // (not merely what the model proposed — see resolveSectionTypeSubstitutions), and every choice that
  // failed re-validation. Reported regardless of whether the wanted type actually turned up on a
  // restamped page — the ledger is about what the RUN resolved, not only what got physically applied.
  const appliedSubstitutions = [...sectionTypeChoices.entries()].map(([wanted, chosen]) => ({ wanted, chosen }));

  return { restamp, skipped, appliedSubstitutions, substitutionRejections };
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
 *
 * `adjudication` (T13.4 PART C, OPTIONAL — omitted, the ledger is exactly what mint/theme produced,
 * byte-identical to before this argument existed): `fit_adjudicator`'s `clone_fit_adjudication.v1`
 * output. This function never RE-validates a `choices` entry itself — `buildRestampOps` already did
 * that, and its result (`restampReport.appliedSubstitutions` / `.substitutionRejections`) is the
 * ground truth of what this run actually resolved, summarized here rather than re-derived. For kinds
 * this module never applies (font/recipe/page_type — no engine code writes any of those yet), the
 * adjudicator's own `chosen`/`basis`/`fidelityCost` are relayed as reported, informationally.
 */
export function buildCloneRunReport({ intake, mintReport, themeReport, restampReport, design, adjudication }) {
  if (!isPlainObject(intake)) throw new CloneError('A clone run report requires the intake it was built from.');
  if (!isPlainObject(mintReport)) throw new CloneError('A clone run report requires an executed mint report.');
  if (!isPlainObject(themeReport)) throw new CloneError('A clone run report requires a theme bind report.');
  if (!isPlainObject(restampReport)) throw new CloneError('A clone run report requires a restamp report.');

  const siteId = intake.site?.objectId ?? null;
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

  // PART B item 4: every compromise the run made, in one place, with its fidelity cost — never buried
  // in `mint.rejected`/`theme.dropped` where a human reviewer would have to go hunting for it. Sourced
  // from the two stages that can produce one (mint's section_type/page_type/recipe substitutions,
  // theme's font substitutions); restamp itself is purely mechanical and never substitutes anything —
  // it only APPLIES a section_type substitution mint already recorded.
  const baseSubstitutions = [...(mintReport.substitutions ?? []), ...(themeReport.substitutions ?? [])];

  // PART C: fold the adjudicator's resolution into that same ledger, so a human sees ONE list of
  // every compromise, each with what stood in for it (or what was given up). `chosen` for a
  // `section_type` entry comes from `restampReport.appliedSubstitutions` — what this run actually
  // validated and applied, never from trusting `adjudication` directly a second time. Every other
  // kind (font/recipe/page_type) has no apply step in this module yet, so its `chosen` is the
  // adjudicator's own value, relayed informationally.
  const appliedChosenByWanted = new Map(
    (restampReport.appliedSubstitutions ?? []).map((entry) => [entry.wanted, entry.chosen])
  );
  const choiceByKey = new Map(
    (isPlainObject(adjudication) && Array.isArray(adjudication.choices) ? adjudication.choices : [])
      .filter(isPlainObject)
      .map((choice) => [`${choice.kind}:${choice.wanted}`, choice])
  );
  const declinedByKey = new Map(
    (isPlainObject(adjudication) && Array.isArray(adjudication.declined) ? adjudication.declined : [])
      .filter(isPlainObject)
      .map((decline) => [`${decline.kind}:${decline.wanted}`, decline])
  );

  const adjudicatedSubstitutions = baseSubstitutions.map((entry) => {
    const key = `${entry.kind}:${entry.wanted}`;
    if (entry.kind === 'section_type' && appliedChosenByWanted.has(entry.wanted)) {
      const choice = choiceByKey.get(key);
      return {
        ...entry,
        chosen: appliedChosenByWanted.get(entry.wanted),
        basis: choice?.basis ?? entry.basis,
        fidelityCost: choice?.fidelityCost ?? entry.fidelityCost,
      };
    }
    if (entry.kind !== 'section_type') {
      const choice = choiceByKey.get(key);
      if (choice) {
        return {
          ...entry,
          chosen: typeof choice.chosen === 'string' && choice.chosen ? choice.chosen : entry.chosen,
          basis: choice.basis ?? entry.basis,
          fidelityCost: choice.fidelityCost ?? entry.fidelityCost,
        };
      }
    }
    const declined = declinedByKey.get(key);
    if (declined) {
      return {
        ...entry,
        chosen: null,
        basis: declined.basis ?? entry.basis,
        fidelityCost: declined.fidelityCost ?? entry.fidelityCost,
      };
    }
    return entry;
  });

  // A model proposing an illegal swap is something the operator should see, not something to bury —
  // surfaced as its own entries (`reason: 'substitution_not_in_candidates'`), alongside, never instead
  // of, the original "this didn't fit" entry above.
  const substitutions = clone([...adjudicatedSubstitutions, ...(restampReport.substitutionRejections ?? [])]);

  return {
    schemaVersion: 'clone-run-report.v1',
    mint: clone(mintReport),
    theme: clone(themeReport),
    restamp: clone(restampReport),
    substitutions,
    capabilityBacklog: groupUnmetNeedsBySectionType(design?.unmetNeeds),
    reviewQueue,
    humanGate: {
      publishedByThisRun: false,
      note: 'Clone runs only ever write drafts. Publishing any object this run created or changed remains a separate, human-gated decision.',
    },
  };
}
