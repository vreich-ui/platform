/**
 * GENESIS MANIFEST — the one staged source of truth for what a tenant is born
 * with (T16.0; law: `docs/cms-architecture/16-genesis-parity-plan.md` §2).
 *
 * The genesis seam used to be enforced in three unsynchronized lists —
 * `buildPlan()`'s seed-file block and `DATA_SITE_SUBDIRS` in
 * `packages/core/cli/create-site.mjs`, and `SEED_MODULES` in
 * `scripts/site-genesis-drive.mjs`. Both 2026-08-05 addenda were the same
 * failure: added to one list, forgotten in the others. This module ends that
 * class. Every consumer derives its list from here, and
 * `tests/scripts/genesis-manifest.test.mjs` fails the moment a consumer
 * disagrees with the manifest or a site is missing something the manifest
 * says it must carry.
 *
 * ADD A GENESIS ITEM HERE, NOT IN A CONSUMER. Forgetting a consumer turns CI
 * red instead of shipping a tenant that quietly lacks the thing.
 *
 * Pure data + tiny accessors: no fs, no network, no side effects, importable
 * from a CLI, a driver script, an audit, or a test.
 *
 * ── Stages (plan §2, the four-stage line) ───────────────────────────────────
 *   scaffold   — repo files `create-site --name <client>` writes.
 *   genesis    — store objects `site-genesis-drive.mjs` births through the
 *                site's own /mcp, in dependency order.
 *   onboarding — client identity (voice, tracking, products, real branding).
 *                `create-site` emits the skeleton seed FILE so the shape is
 *                fleet-uniform; genesis never invents the content (Wolf's
 *                2026-08-05 types-not-instances ruling).
 *   content    — articles, pages, sections. Never genesis's business.
 * Genesis owns `scaffold` + `genesis` and nothing else. `content` is listed
 * so the export tree below can be tagged truthfully; nothing derives a
 * genesis action from it.
 *
 * ── `todo` entries ──────────────────────────────────────────────────────────
 * An entry carrying `todo: '<task>'` is a KNOWN, RECORDED gap: the manifest
 * states the target, the fleet does not meet it yet, and the named task
 * closes it. Accessors that feed live consumers skip `todo` entries (so this
 * module changes no behavior today); the drift test asserts each one still
 * fails and tells you to delete the annotation once it doesn't.
 */

/** Every stage name that may appear on an entry, in birth order. */
export const STAGES = ['scaffold', 'genesis', 'onboarding', 'content'];

/**
 * CANONICAL PACKS (T14.1) — a shared library of brand-neutral recipe BODIES
 * (`portability: 'canonical'`, packages/core/schema/bodies/
 * recipe-metadata-v1.ts), imported by ONE seed module in SEED_MODULES below
 * rather than restated per-site the way the pre-T14.1 fleet restated its
 * "same" five section-template recipes three times over.
 *
 * A pack is NOT itself a seed FILE — no `sites/<client>/seeds/` entry exists
 * for it, it never appears in SEED_MODULES, and it carries no stage or
 * driveOrder of its own; it rides whichever seed module's `file` names it in
 * `consumedBy`. It is listed here, separately, purely so the drift test can
 * assert BOTH directions the manifest promises elsewhere: every canonical id
 * actually reaches every site (nothing quietly missing one), and no site
 * restates a canonical body as its own local literal instead of importing it
 * — the exact failure `packages/core/cli/canonical-seed-data.mjs` exists to
 * end. `idsExport` names the export on `module` that lists membership (an
 * array of object ids) — the smallest hook a generic accessor needs.
 * `entriesExport` names the export carrying the actual `{ objectId, body }`
 * pairs, which the drift test needs to prove a site's CONVERSION_SEEDS entry
 * for a canonical id is the SAME object the pack exports (imported), not a
 * separate literal that merely looks the same (restated).
 *
 * A second pack (templates, themes, …) gets its own row here, not a widened
 * one — `consumedBy` names exactly one SEED_MODULES `file`.
 */
export const CANONICAL_PACKS = [
  {
    module: 'packages/core/cli/canonical-seed-data.mjs',
    idsExport: 'CANONICAL_SECTION_TEMPLATE_IDS',
    entriesExport: 'CANONICAL_SECTION_TEMPLATES',
    consumedBy: 'section-templates-seed-data.mjs',
  },
];

/**
 * The seed pack. Listed in SCAFFOLD order (the order `create-site` writes the
 * files, which the committed dry-run fixture pins); `driveOrder` gives the
 * GENESIS order, which is different and is law:
 *
 *   navigation FIRST, then the site singleton (its defaultNavigation refs must
 *   resolve), then everything else — pinned by
 *   tests/netlify/site-genesis.e2e.test.ts. Creating the site before its navs
 *   fails reference integrity with a 422; that is correct behavior.
 *
 * `driveOrder` is undefined for anything genesis does not drive.
 */
export const SEED_MODULES = [
  {
    file: 'site-seed-data.mjs',
    objectTypes: ['site'],
    stage: 'genesis',
    driveOrder: 2,
  },
  {
    file: 'navigation-seed-data.mjs',
    objectTypes: ['navigation'],
    stage: 'genesis',
    driveOrder: 1, // LAW: navs before the site singleton.
  },
  {
    file: 'taxonomy-seed-data.mjs',
    objectTypes: ['taxonomy'],
    stage: 'genesis',
    driveOrder: 3,
  },
  {
    file: 'themes-seed-data.mjs',
    objectTypes: ['theme'],
    stage: 'genesis',
    driveOrder: 4,
  },
  {
    file: 'section-templates-seed-data.mjs',
    objectTypes: ['section_template'],
    stage: 'genesis',
    driveOrder: 5,
  },
  {
    file: 'templates-seed-data.mjs',
    objectTypes: ['template'],
    stage: 'genesis',
    driveOrder: 6, // W15 S3 follow-up: starter page-template recipes.
  },
  {
    // T16.1: joined the manifest. Onboarding stage — the skeleton file is
    // fleet-uniform (create-site scaffolds it for every new client, same as
    // every existing tenant already carries it), the CONTENT is the
    // client's: genesis never invents editorial voice (Wolf's 2026-08-05
    // types-not-instances ruling).
    file: 'voice-seed-data.mjs',
    objectTypes: ['editorial_voice'],
    stage: 'onboarding',
  },
  {
    // T16.1: joined the manifest alongside voice, same shape and same
    // ruling — onboarding stage, skeleton file fleet-uniform, content is the
    // client's. drlurie and platform carry the file; fernwell does not yet
    // (see the KNOWN_GAPS row in the drift test — out of T16.1's backfill
    // scope, left as a recorded gap for a fast-follow rather than invented
    // here).
    file: 'tracking-config-seed-data.mjs',
    objectTypes: ['tracking_config'],
    stage: 'onboarding',
  },
];

/**
 * The committed-export tree: `sites/<client>/data/site/<name>/`. Every subdir
 * is created empty at SCAFFOLD time (`.gitkeep`) on every site; `stage` says
 * which stage POPULATES it, not when the directory appears.
 */
export const DATA_SITE_SUBDIRS = [
  { name: 'navigation', stage: 'genesis' },
  { name: 'pages', stage: 'genesis' }, // bootstrap pages at genesis, more at content
  { name: 'products', stage: 'onboarding' },
  { name: 'section-templates', stage: 'genesis' },
  { name: 'sections', stage: 'content' },
  { name: 'templates', stage: 'genesis' },
  { name: 'themes', stage: 'genesis' },
  { name: 'articles', stage: 'content' },
  // T16.1: joined the manifest — every tenant now carries the directory
  // (fernwell's was backfilled with a .gitkeep in the same change).
  { name: 'voice', stage: 'onboarding' },
];

/**
 * The scaffold output, grouped. `pattern` matches a plan path RELATIVE to
 * `sites/<client>/`. Descriptive rather than generative — `buildPlan()` builds
 * these from templates — but complete: the drift test asserts every file
 * create-site emits falls in exactly one group, so a new scaffold family
 * cannot appear without being declared here first.
 */
export const SCAFFOLD_GROUPS = [
  { id: 'config-bundle', stage: 'scaffold', pattern: '^config/[^/]+\\.ts$' },
  { id: 'site-config', stage: 'scaffold', pattern: '^site\\.config\\.ts$' },
  { id: 'netlify-toml', stage: 'scaffold', pattern: '^netlify\\.toml$' },
  { id: 'package-json', stage: 'scaffold', pattern: '^package\\.json$' },
  // The seed FILES are scaffold output; what each one is FOR is staged
  // per-entry in SEED_MODULES above.
  { id: 'seed-pack', stage: 'scaffold', pattern: '^seeds/[^/]+\\.mjs$' },
  { id: 'export-tree', stage: 'scaffold', pattern: '^data/site/[^/]+/\\.gitkeep$' },
  { id: 'post-shelf', stage: 'scaffold', pattern: '^data/post/\\.gitkeep$' },
  { id: 'build-entry', stage: 'scaffold', pattern: '^(astro\\.config\\.ts|config\\.yaml|app/content/config\\.ts)$' },
  { id: 'app-routes', stage: 'scaffold', pattern: '^app/pages/.+\\.astro$' },
  { id: 'function-shims', stage: 'scaffold', pattern: '^netlify/functions/[^/]+\\.ts$' },
  { id: 'static-roots', stage: 'scaffold', pattern: '^(public|assets/images)/\\.gitkeep$' },
  {
    // Placeholder exports so the shell can render before the drive runs; the
    // genesis drive replaces them with store-backed objects.
    id: 'bootstrap-exports',
    stage: 'scaffold',
    pattern: '^data/site/(site\\.json|navigation/[^/]+\\.json|pages/[^/]+\\.json)$',
  },
];

// ─── publishability (the genesis drive's one exception) ────────────────────
//
// REVIEW (brand-imagery wave): the genesis drive's write loop is
// create -> checkout -> object_publish -> checkin for EVERY object in the
// plan, because until now every seeded type was publishable. P6 added a
// `visual_standard` entry to `site-seed-data.mjs`'s CONVERSION_SEEDS, and
// `visual_standard` is deliberately OUTSIDE the generic publish gate
// (BRIEF.md rule 4 / `governedObjectTypes` in packages/core/lib/
// approval-policy.ts) — `object_publish` on it is refused with
// `content_item_not_gated`. Left unhandled, every genesis run (and every
// re-run, since the object never records a published_time) reported one
// FAIL and exited non-zero on a site that was in fact fully seeded.
//
// Kept HERE rather than imported from approval-policy.ts so the ops scripts
// stay plain `.mjs` with no TypeScript-interop dependency; the two are
// pinned together by tests/scripts/genesis-manifest.test.mjs, which reads
// `governedObjectTypes` from that module and fails if this list drifts.
export const NON_PUBLISHABLE_OBJECT_TYPES = Object.freeze(['visual_standard']);

/** Whether the genesis drive should attempt `object_publish` on this type. */
export const isPublishableObjectType = (objectType) => !NON_PUBLISHABLE_OBJECT_TYPES.includes(objectType);

// ─── accessors (tiny, pure) ─────────────────────────────────────────────────

/** Seed files `create-site` must scaffold, in the order it writes them. */
export const scaffoldSeedFiles = () => SEED_MODULES.filter((entry) => !entry.todo).map((entry) => entry.file);

/** Seed files the genesis drive must load, in dependency order. */
export const genesisSeedFiles = () =>
  SEED_MODULES.filter((entry) => entry.stage === 'genesis' && !entry.todo)
    .sort((a, b) => a.driveOrder - b.driveOrder)
    .map((entry) => entry.file);

/** Export-tree subdirs every scaffolded site carries. */
export const dataSiteSubdirs = () => DATA_SITE_SUBDIRS.filter((entry) => !entry.todo).map((entry) => entry.name);

/** The CANONICAL_PACKS row a given seed-module file consumes, if any. */
export const canonicalPackFor = (seedFile) => CANONICAL_PACKS.find((pack) => pack.consumedBy === seedFile);

/** Every entry that records a known gap, with the task that closes it. */
export const pendingEntries = () =>
  [
    ...SEED_MODULES.map((entry) => ({ kind: 'seed-module', id: entry.file, ...entry })),
    ...DATA_SITE_SUBDIRS.map((entry) => ({ kind: 'data-site-subdir', id: entry.name, ...entry })),
  ].filter((entry) => entry.todo);
