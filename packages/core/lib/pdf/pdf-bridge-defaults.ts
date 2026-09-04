/**
 * Pure decision helpers for the pdf-tool artifact bridge's D-1/D-4 defaults
 * (BRIEF-W2.md §3, T2.2). Extracted out of
 * packages/core/server/lib/mcp-tool-handlers.ts's callCreateAgentArtifactJob
 * so each decision is testable with node:test, without a live bridge or
 * object store (repo convention — BRIEF-W2.md §4: "extract the decisions
 * ... into pure helpers").
 *
 * KIND, AND WHERE IT COMES FROM (D-1's own open question). site.v1's
 * `pdf.byKind` (site-v1.ts:165-183) keys an OPEN, caller-named set
 * ("article", "guide", "checklist", "sales_brochure", "lead_magnet", ... —
 * object-contract.ts's site_pdf_ordinary_write entry says so explicitly).
 * BRIEF §3/D-1 says "the content_item's own kind field is the obvious
 * source" — checked against content-item-v1.ts in full (envelope fields,
 * every node field, taxonomy, sources/claims/compliance) and there is NO
 * such field: a content_item is only ever an article today (see that
 * file's own header comment). So there is nothing on the content_item to
 * read. This resolver instead takes an explicit, optional `kind` argument —
 * sourced in mcp-tool-handlers.ts from create_agent_artifact_job's own
 * (currently undocumented — see this wave's report) `input.kind` — and
 * defaults it to 'article' when the caller supplies none, which is simply
 * true of every content_item-backed pdf job that exists in this platform
 * right now. A caller who DOES pass kind:'sales_brochure' or
 * kind:'lead_magnet' still gets routed through byKind correctly.
 */

export interface SitePdfDefaults {
  defaultTemplateId?: string;
  byKind?: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Reads `{ defaultTemplateId?, byKind? }` off a site.v1 body's `pdf` block.
 * A site with no `pdf` block at all (or one that somehow carries neither
 * field with a usable value) returns undefined — the caller's cue to
 * behave exactly as today: no templateId resolved, no defaults applied.
 */
export const readSitePdfDefaults = (siteBody: unknown): SitePdfDefaults | undefined => {
  if (!isRecord(siteBody)) return undefined;
  const pdf = siteBody.pdf;
  if (!isRecord(pdf)) return undefined;

  const defaultTemplateId = toNonEmptyString(pdf.defaultTemplateId);
  const rawByKind = isRecord(pdf.byKind) ? pdf.byKind : undefined;
  const byKind: Record<string, string> = {};
  if (rawByKind) {
    for (const [kind, templateId] of Object.entries(rawByKind)) {
      const id = toNonEmptyString(templateId);
      if (id) byKind[kind] = id;
    }
  }

  if (!defaultTemplateId && Object.keys(byKind).length === 0) return undefined;
  return {
    ...(defaultTemplateId ? { defaultTemplateId } : {}),
    ...(Object.keys(byKind).length > 0 ? { byKind } : {}),
  };
};

/**
 * D-1 (BRIEF §3): `byKind[kind] ?? defaultTemplateId`. A site with no
 * `site.pdf` at all (readSitePdfDefaults returned undefined) resolves to
 * undefined here — exactly today's behavior: no templateId is forwarded,
 * and pdf-tool's own error covers a job with neither a template nor a
 * prompt.
 */
export const resolvePdfDefaultTemplateId = (
  sitePdf: SitePdfDefaults | undefined,
  kind: string | undefined
): string | undefined => {
  const pinned = kind ? sitePdf?.byKind?.[kind] : undefined;
  return pinned ?? sitePdf?.defaultTemplateId;
};

/**
 * D-4 (BRIEF §3): `filename` ← the article's slug when the caller omitted
 * one. Caller-supplied always wins (the caller checks this before ever
 * calling in, but it is re-checked here defensively). The existing filename
 * normalization and FILENAME_TOO_GENERIC rule (agents-naming.ts, and
 * pdf-tool's own rule downstream) apply to the result exactly as they would
 * to a caller-supplied filename — this never fights them, it just supplies
 * a non-generic, article-specific stem (the slug) when the caller supplied
 * nothing at all. `.pdf` is appended because `filename` must include the
 * format-matching extension (mcp-tool-definitions.ts's own field
 * description) and a bare slug carries none.
 */
export const resolvePdfDefaultFilename = (
  explicitFilename: string | undefined,
  slug: string | undefined
): string | undefined => {
  if (explicitFilename) return explicitFilename;
  if (!slug) return undefined;
  return `${slug}.pdf`;
};

export const ARTICLE_PDF_REQUIREMENTS_DEFAULT = Object.freeze({
  format: 'A4',
  orientation: 'portrait',
  pageCount: Object.freeze({ min: 2 }),
  maxBytes: 8_000_000,
});

/**
 * D-4 (BRIEF §3): `requirements` ← the A4 article default, ONLY for
 * kind:"article" and ONLY when the caller supplied none AT ALL. A caller who
 * supplies even a partial requirements object always wins, completely
 * untouched — the same "caller wins" rule as every other default in this
 * file (and in pdf-render-brand.ts).
 */
export const resolvePdfRequirementsDefault = (
  kind: string | undefined,
  explicitRequirements: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  if (explicitRequirements !== undefined) return explicitRequirements;
  if (kind !== 'article') return explicitRequirements;
  return {
    format: ARTICLE_PDF_REQUIREMENTS_DEFAULT.format,
    orientation: ARTICLE_PDF_REQUIREMENTS_DEFAULT.orientation,
    pageCount: { ...ARTICLE_PDF_REQUIREMENTS_DEFAULT.pageCount },
    maxBytes: ARTICLE_PDF_REQUIREMENTS_DEFAULT.maxBytes,
  };
};

/**
 * D-1/D-4's `kind` signal — see this module's header for why 'article' is
 * the honest default rather than a guess.
 */
export const resolvePdfJobKind = (explicitKind: string | undefined): string => explicitKind ?? 'article';
