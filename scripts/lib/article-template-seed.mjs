/**
 * T2.7 — seeding the generic, schema'd `article_brochure_v1` pdf-tool
 * template into a tenant (ruling D-B). Every DECISION here is a pure
 * function; the only I/O (the three pdf-tool bridge calls) lives in
 * `scripts/seed-article-pdf-template.mjs`, which calls these and nothing
 * else to decide what to send.
 *
 * WHY PLAIN .mjs, NOT TypeScript under `packages/core/lib/`: this module's
 * only consumer is an operational genesis SCRIPT (`site-genesis-drive.mjs`
 * imports it directly and runs unmodified, exactly like `roundtrip-reconcile.mjs`
 * / `object-store-client.mjs`), and this repo's scripts run as plain Node
 * ESM with no build step — a `.ts` module compiled only by `tsconfig.test.json`
 * (into a throwaway `.tmp/ci-test` that is deleted after `npm test`) is not
 * importable from a script that runs directly via `node scripts/foo.mjs`.
 * Tested the same way `site-genesis-drive.mjs`'s own decisions are: plain
 * `node:test` files under `tests/scripts/`.
 *
 * ── Why a brand swap, not a brand-baked template ────────────────────────
 * `article_brochure_v1`'s `templateJson` is brand-PARAMETRIC: its Liquid
 * reads `{{ brand.colors[...] }}` / `{{ brand.fonts.* }}` from the render
 * DATA at render time, not from the template body (confirmed against the
 * vendored source below). The bridge already injects the right `brand`
 * object into every render job from the site's own `brandTokens`
 * (`packages/core/server/lib/pdf-render-brand.ts`, BRIEF §2) — that part
 * needs no seeding. What's missing is a per-tenant TEMPLATE RECORD at all:
 * `templateJson`/`renderDataSchema` travel verbatim, and only
 * `sampleData.brand` is swapped for the tenant's real brand, so that
 * (a) the template's own sample renders in the tenant's real palette rather
 * than the pdf-tool repo's generic placeholder colors, and (b) publish-time
 * validation (pdf-tool's hard gate on chromium templates) proves the exact
 * shape this tenant's renders will actually carry, not a stand-in's.
 * `pdfRenderBrandFromSiteBody` below MIRRORS
 * `packages/core/server/lib/pdf-render-brand.ts`'s function of the same
 * name value-for-value (same shape: `{colors, fonts:{sans,serif,heading,mono?},logo?}`,
 * same "no usable brandTokens -> undefined, never fabricate" rule) — kept
 * as a small, deliberate port rather than a cross-module import for the
 * reason above; `article-template-seed.test.mjs` pins it against fixtures
 * that match that module's own test fixtures so the two cannot silently
 * diverge unnoticed.
 *
 * ── Idempotency rule ─────────────────────────────────────────────────────
 * Genesis and `site_duplicate` re-run. A template id that already exists in
 * the tenant's pdf-tool template list is left COMPLETELY alone — this module
 * never diffs, patches, or republishes an existing record. That is the only
 * rule that can't clobber a template an editor has since hand-tuned: seeding
 * is a one-time "create if absent" op, never a "reconcile to the generic
 * source" op.
 */
import { validateAgainstSchema } from './json-schema-subset.mjs';

const isRecord = (value) => Boolean(value && typeof value === 'object' && !Array.isArray(value));

const toNonEmptyString = (value) => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/** pdf-tool's own assetId grammar (article_brochure_v1's renderDataSchema `$defs.assetId`). */
const RENDER_ASSET_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

/**
 * `site_drlurie` -> `drlurie_article_v1`; a siteId with no `site_` prefix
 * (a fixture, or a future convention change) falls back to using it whole
 * rather than mangling it. Pure derivation, no I/O -- the one place the
 * naming rule lives so a test can pin it.
 */
export const articleTemplateIdForSite = (siteId) => {
  const trimmed = String(siteId).trim();
  const slug = trimmed.startsWith('site_') ? trimmed.slice('site_'.length) : trimmed;
  return `${slug}_article_v1`;
};

/**
 * Reads `{ colors, fonts, logo? }` off a site.v1 body, in the exact shape
 * article_brochure_v1's renderDataSchema requires -- see the module doc
 * comment: this MIRRORS `pdf-render-brand.ts`'s function of the same name.
 * Returns undefined when the site carries no usable brandTokens (absent, no
 * colors, or missing a required font family) -- the caller must refuse to
 * seed in that case, never invent a partial/fabricated brand block.
 */
export const pdfRenderBrandFromSiteBody = (body) => {
  const tokens = isRecord(body?.brandTokens) ? body.brandTokens : undefined;
  if (!tokens) return undefined;

  const rawColors = isRecord(tokens.colors) ? tokens.colors : undefined;
  const colors = {};
  if (rawColors) {
    for (const [key, value] of Object.entries(rawColors)) {
      if (typeof value === 'string' && value.trim().length > 0) colors[key] = value;
    }
  }
  if (Object.keys(colors).length === 0) return undefined;

  const rawFonts = isRecord(tokens.fonts) ? tokens.fonts : undefined;
  const sans = toNonEmptyString(rawFonts?.sans);
  const serif = toNonEmptyString(rawFonts?.serif);
  const heading = toNonEmptyString(rawFonts?.heading);
  if (!sans || !serif || !heading) return undefined;
  const mono = toNonEmptyString(rawFonts?.mono);

  const logo = isRecord(body?.logo) ? body.logo : undefined;
  const imageAssetRef = toNonEmptyString(logo?.imageAssetRef);
  const assetId = imageAssetRef && RENDER_ASSET_ID_RE.test(imageAssetRef) ? imageAssetRef : undefined;

  return {
    colors,
    fonts: { sans, serif, heading, ...(mono ? { mono } : {}) },
    ...(assetId ? { logo: assetId } : {}),
  };
};

/**
 * Whether `templateId` needs to be created in this tenant's pdf-tool
 * template list. `existingTemplateIds` is whatever `list_pdf_templates`
 * (or `get_pdf_template`) already reported -- this never re-derives that
 * list itself, only decides from it.
 */
export const planArticleTemplateSeed = (templateId, existingTemplateIds) => {
  if (existingTemplateIds.includes(templateId)) {
    return {
      action: 'already_seeded',
      templateId,
      reason: `'${templateId}' already exists in this tenant's pdf-tool template list -- left untouched (idempotent no-op), including any edits made since it was seeded.`,
    };
  }
  return {
    action: 'create',
    templateId,
    reason: `'${templateId}' is not in this tenant's pdf-tool template list yet.`,
  };
};

/**
 * The seeded template BODY for a given site: `source` (article_brochure_v1,
 * see `pdf-templates/article_brochure_v1.json`) verbatim (`templateJson`,
 * `renderDataSchema`, `sampleAssets` untouched -- the template is
 * brand-parametric, see the module doc comment), with `sampleData.brand`
 * replaced by this site's own brand.
 *
 * Returns `undefined` when the site has no usable `brandTokens` -- exactly
 * `pdfRenderBrandFromSiteBody`'s own "don't fabricate a brand" rule -- so a
 * caller can refuse to seed rather than publish a template whose sample
 * silently falls back to the generic placeholder palette under this
 * tenant's name.
 */
export const buildBrandedArticleTemplateSeed = ({ templateId, source, siteBody }) => {
  const brand = pdfRenderBrandFromSiteBody(siteBody);
  if (!brand) return undefined;

  const sampleData = isRecord(source.sampleData) ? { ...source.sampleData } : {};
  const branded = {
    ...sampleData,
    brand: {
      colors: { ...brand.colors },
      fonts: { ...brand.fonts },
      ...(brand.logo ? { logo: brand.logo } : {}),
    },
  };

  return {
    templateId,
    renderer: source.renderer,
    label: source.label,
    tags: [...source.tags],
    templateJson: source.templateJson,
    renderDataSchema: source.renderDataSchema,
    sampleData: branded,
    sampleAssets: source.sampleAssets,
  };
};

/**
 * Acceptance: "the drlurie-branded template's sampleData validates against
 * its own renderDataSchema". Runs the branded seed's `sampleData` back
 * through its OWN `renderDataSchema` -- the same contract pdf-tool's
 * `validate_pdf_template` / publish-time gate enforces -- using the
 * repo-local schema-subset interpreter (no live pdf-tool call).
 */
export const validateSeedSampleData = (seed) => {
  if (!isRecord(seed.renderDataSchema)) {
    return { valid: false, errors: ['renderDataSchema is not an object'] };
  }
  return validateAgainstSchema(seed.renderDataSchema, seed.sampleData);
};
