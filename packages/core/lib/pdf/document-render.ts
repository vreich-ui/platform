/**
 * A8 Part 2 — an independent `document_render` recipe: render an existing article or
 * supported structured document standalone, without going through capture/clone/PDF-studio
 * prerequisites.
 *
 * resolve the actual owner and template → build and validate render data → create or reuse
 * the job → inspect its output → attach/export the verified result — exactly the steps A8
 * specifies, reusing existing machinery at every step rather than re-implementing it:
 *
 *   - owner + template resolution reuses `pdf-bridge-defaults.ts`'s `readSitePdfDefaults` /
 *     `resolvePdfDefaultTemplateId` / `resolvePdfJobKind`, unchanged.
 *   - "build render data" reuses `pdf-render-data-mapper-seam.ts`'s `resolvePdfJobRenderData`
 *     / `PdfRenderDataMapperUnavailableError` / `defaultPdfRenderDataMapper`, unchanged.
 *   - "validate render data" reuses `render-data-schema-check.ts`'s `checkRenderDataAgainstSchema`
 *     / `checkRenderDataAssets` — the same pure logic behind `validate_pdf_render_data` —
 *     unchanged.
 *   - "create or reuse the job → inspect its output → attach" reuses `article-pdf-render.ts`'s
 *     `renderArticlePdf`, unchanged, for the one document kind Platform's content model
 *     actually supports today (`article`, backed by a `content_item` — see
 *     `pdf-bridge-defaults.ts`'s own header: "a content_item is only ever an article today").
 *
 * THE CORRECTNESS REQUIREMENT THIS MODULE EXISTS TO ENFORCE: "newsletter and report data must
 * use their own declared mapping, not be forced into an article schema." Today's
 * `create_agent_artifact_job` bridge is KIND-BLIND for mapping purposes — `kind` only ever
 * selects a template id (`site.pdf.byKind`) and a requirements default; the render-data
 * MAPPER it runs is always the single default article mapper, regardless of what kind the
 * caller declared. Calling that bridge directly for a `kind:"newsletter"` document would
 * silently map newsletter content through the article schema — exactly the defect this recipe
 * must not have. `runDocumentRender` is the gate in front of that kind-blind infrastructure:
 * it resolves a mapper from an explicit, open `DocumentKindMapperRegistry` keyed by kind, and
 * for any kind with NO registered mapper (today: every kind except `article`) it refuses with
 * a named, typed `blocked` outcome and creates no job at all — it never falls through to the
 * article mapper by default. Registering a real `newsletter` or `report` mapper here (once
 * Platform's content model has an object shape for either — it does not today, verified
 * against `content-item-v1.ts` and the full site/object schema, see the A8 report) is the
 * exact, minimal extension point for that future work; nothing about this module's dispatch
 * needs to change to add one.
 *
 * PURE AND EFFECTS-INJECTED, matching `article-pdf-render.ts` and `template-preview.ts`.
 */
import {
  resolvePdfJobRenderData,
  PdfRenderDataMapperUnavailableError,
  defaultPdfRenderDataMapper,
  type PdfRenderDataMapper,
} from './pdf-render-data-mapper-seam.js';
import {
  readSitePdfDefaults,
  resolvePdfDefaultTemplateId,
  resolvePdfJobKind,
  type SitePdfDefaults,
} from './pdf-bridge-defaults.js';
import {
  checkRenderDataAgainstSchema,
  checkRenderDataAssets,
  type RenderDataSchemaError,
} from './render-data-schema-check.js';
import {
  renderArticlePdf,
  type RenderArticlePdfEffects,
  type RenderArticlePdfParams,
  type RenderArticlePdfReceipt,
} from './article-pdf-render.js';

export { readSitePdfDefaults, resolvePdfDefaultTemplateId, resolvePdfJobKind };

// ─── the kind → mapper registry ─────────────────────────────────────────────

export type DocumentKindMapperRegistry = Readonly<Record<string, PdfRenderDataMapper>>;

/** `article` is the only document kind Platform's content model has an owner shape and a
 *  mapper for today — reused unchanged. Extend this map (never the dispatch logic in
 *  `runDocumentRender`) when a real `newsletter`/`report` object shape and mapper exist. */
export const DEFAULT_DOCUMENT_KIND_MAPPERS: DocumentKindMapperRegistry = Object.freeze({
  article: defaultPdfRenderDataMapper,
});

export function getDocumentKindMapper(
  kind: string,
  registry: DocumentKindMapperRegistry = DEFAULT_DOCUMENT_KIND_MAPPERS
): PdfRenderDataMapper | undefined {
  return registry[kind];
}

// ─── owner + template resolution ────────────────────────────────────────────

export type DocumentRenderTemplateResolution =
  | { templateId: string; source: 'explicit' | 'site_default' }
  | { templateId: undefined; source: 'unresolved' };

/** D-1's own rule (`pdf-bridge-defaults.ts`), reused here as the explicit "resolve the
 *  template" step: caller-supplied always wins; otherwise `site.pdf.byKind[kind] ??
 *  site.pdf.defaultTemplateId`. */
export function resolveDocumentRenderTemplateId(
  explicitTemplateId: string | undefined,
  sitePdf: SitePdfDefaults | undefined,
  kind: string
): DocumentRenderTemplateResolution {
  if (explicitTemplateId) return { templateId: explicitTemplateId, source: 'explicit' };
  const fromSite = resolvePdfDefaultTemplateId(sitePdf, kind);
  return fromSite ? { templateId: fromSite, source: 'site_default' } : { templateId: undefined, source: 'unresolved' };
}

// ─── effects ────────────────────────────────────────────────────────────────

export type DocumentRenderEffectResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: { code?: string; message: string } };

/** Extends `RenderArticlePdfEffects` (reused unchanged for the create/poll/attach lifecycle)
 *  with the owner/template/schema reads this recipe's earlier steps need. */
export type DocumentRenderEffects = RenderArticlePdfEffects & {
  /** Resolves and reads the actual owning object — a `content_item` today. Scope/tenant
   *  checks (site match, existence) happen here, the same way `callBuildPdfRenderData` /
   *  `render_article_pdf` already check them. */
  readOwnerRecord: () => Promise<DocumentRenderEffectResult<Record<string, unknown>>>;
  readSitePdfDefaults: () => Promise<SitePdfDefaults | undefined>;
  /** The resolved template's own `renderDataSchema`, when the template exists and declares
   *  one — undefined skips the explicit pre-render validate step (the mapper/job creation
   *  path still validates against the generic article contract, exactly as
   *  `build_pdf_render_data` / `validate_pdf_render_data` already document). */
  readTemplateRenderDataSchema: (templateId: string) => Promise<unknown>;
  /**
   * The brand block to pre-flight WITH, given the resolved template's own render-data schema.
   *
   * The schema parameter is the whole point. A template's brand slot is an OBJECT on one
   * template and a plain site NAME on the next (pdf-render-brand.ts's `classifyRenderDataBrandSlot`
   * is the authority), and an implementation cannot pick the right shape without seeing it —
   * which is why this used to be left undefined, and why the pre-flight then validated a payload
   * with no brand against a schema that required one. Undefined still means "pre-flight without a
   * brand", which is correct for a caller that has none to resolve.
   */
  readSiteBrand?: (templateSchema: unknown) => Promise<unknown>;
};

export type DocumentRenderParams = {
  siteId: string;
  /** Only `content_item` has a real owner shape + mapper today; kept as an explicit literal
   *  (not a free string) so a caller cannot silently ask for an owner type this recipe has no
   *  support for at all — that failure mode belongs at the type level, not a runtime guess. */
  ownerObjectType: 'content_item';
  ownerObjectId: string;
  /** Defaults via `resolvePdfJobKind` (→ `'article'`), exactly like `create_agent_artifact_job`
   *  itself. */
  documentKind?: string;
  templateId?: string;
  attach: boolean;
  pollBudgetMs: number;
  pollIntervalMs?: number;
  articleTitle?: string;
  polling?: { tool: string; input: Record<string, unknown> };
  registry?: DocumentKindMapperRegistry;
};

export type DocumentRenderBlockedReason = 'no_template' | 'no_mapper_for_kind' | 'invalid_render_data';

export type DocumentRenderOutcome =
  | { ok: true; outcome: 'rendered'; documentKind: string; templateId: string; receipt: RenderArticlePdfReceipt }
  | {
      ok: true;
      outcome: 'blocked';
      documentKind: string;
      reason: DocumentRenderBlockedReason;
      detail: string;
      errors?: RenderDataSchemaError[];
      missingAssetIds?: string[];
    }
  | { ok: false; error: { code?: string; message: string } };

/**
 * The recipe, in the order A8 names it. Every "blocked" outcome is `ok: true` — it is a
 * legitimate, informative result, not a thrown error — and NONE of them create a job: a
 * blocked run costs nothing and leaves nothing to clean up.
 */
export async function runDocumentRender(
  params: DocumentRenderParams,
  effects: DocumentRenderEffects
): Promise<DocumentRenderOutcome> {
  const documentKind = resolvePdfJobKind(params.documentKind);

  // ── resolve the actual owner ──
  const owner = await effects.readOwnerRecord();
  if (!owner.ok) return { ok: false, error: owner.error };

  // ── resolve the actual template ──
  const sitePdf = await effects.readSitePdfDefaults();
  const templateResolution = resolveDocumentRenderTemplateId(params.templateId, sitePdf, documentKind);
  if (!templateResolution.templateId) {
    return {
      ok: true,
      outcome: 'blocked',
      documentKind,
      reason: 'no_template',
      detail: `No template_id was supplied and ${params.siteId} declares no PDF default for kind "${documentKind}" (site.pdf.byKind / site.pdf.defaultTemplateId).`,
    };
  }
  const templateId = templateResolution.templateId;

  const templateSchema = await effects.readTemplateRenderDataSchema(templateId);
  const brand = effects.readSiteBrand ? await effects.readSiteBrand(templateSchema) : undefined;

  // ── build render data, through the kind-scoped mapper — never a forced article fallback ──
  const mapped = await resolvePdfJobRenderData({
    contentItem: owner.value,
    templateId,
    ...(templateSchema !== undefined ? { templateSchema } : {}),
    ...(brand !== undefined ? { brand } : {}),
    getMapper: async () => {
      const mapper = getDocumentKindMapper(documentKind, params.registry);
      if (!mapper) {
        throw new PdfRenderDataMapperUnavailableError(
          `No render-data mapper is registered for document kind "${documentKind}". ` +
            (documentKind === 'newsletter' || documentKind === 'report'
              ? `${documentKind} content must use its own declared mapping and is never forced through the article schema — register one in DEFAULT_DOCUMENT_KIND_MAPPERS before rendering this kind.`
              : `Register a mapper for this kind before rendering it.`)
        );
      }
      return mapper;
    },
  });

  if (!mapped.ok) {
    if (mapped.reason === 'mapper_unavailable') {
      return { ok: true, outcome: 'blocked', documentKind, reason: 'no_mapper_for_kind', detail: mapped.detail };
    }
    return { ok: true, outcome: 'blocked', documentKind, reason: 'invalid_render_data', detail: mapped.error };
  }

  // ── validate render data against the template's own contract, before any job ──
  if (templateSchema !== undefined) {
    const check = checkRenderDataAgainstSchema(templateSchema, mapped.data);
    const assetCheck = checkRenderDataAssets(check.assetRefs, mapped.assets);
    if (!check.valid || assetCheck.missingAssetIds.length > 0) {
      return {
        ok: true,
        outcome: 'blocked',
        documentKind,
        reason: 'invalid_render_data',
        detail: `The mapped render data for ${params.ownerObjectId} does not satisfy template ${templateId}'s own render-data contract.`,
        errors: check.errors,
        missingAssetIds: assetCheck.missingAssetIds,
      };
    }
  }

  // ── create or reuse the job → inspect its output → attach the verified result ──
  // "Reuse the article helper where it applies": the resolved mapper above IS the default
  // article mapper (the only one registered today) and the owner IS a content_item, so the
  // rest of the lifecycle is `renderArticlePdf`, unchanged — its own createJob effect maps
  // the SAME content_item again internally through the real bridge; the explicit build+validate
  // above is this recipe's own safety gate in front of that kind-blind infrastructure, not a
  // replacement for what render_article_pdf already does.
  const articleParams: RenderArticlePdfParams = {
    siteId: params.siteId,
    contentItemId: params.ownerObjectId,
    attach: params.attach,
    pollBudgetMs: params.pollBudgetMs,
    ...(params.pollIntervalMs !== undefined ? { pollIntervalMs: params.pollIntervalMs } : {}),
    ...(params.articleTitle ? { articleTitle: params.articleTitle } : {}),
    ...(params.polling ? { polling: params.polling } : {}),
  };
  const outcome = await renderArticlePdf(articleParams, effects);
  if (!outcome.ok) return { ok: false, error: outcome.error };
  return { ok: true, outcome: 'rendered', documentKind, templateId, receipt: outcome.receipt };
}
