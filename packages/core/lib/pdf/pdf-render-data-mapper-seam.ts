/**
 * D-2 seam (BRIEF-W2.md §3): the injection point for the article →
 * render-data mapper (BRIEF §1 ruling D-C — "the mapper lives in platform"),
 * `./render-data-mapper.ts`.
 *
 * WHAT T2.3 CLOSED (the "Join A" the wave left open). T2.2 wrote this seam
 * blind against a module that did not exist yet, and T2.1 landed that module
 * in a parallel worktree with no visibility into this file. The two did not
 * meet:
 *
 *   - the seam's loader looked for an export named
 *     `mapContentItemToPdfRenderData` with an async
 *     `({contentItem, templateId}) => {ok, data, assets?}` signature, through
 *     a deliberately COMPUTED dynamic-import specifier (so `tsc` could not
 *     fail on a file that was not there yet);
 *   - what T2.1 actually shipped is `buildRenderData(contentItem, opts?)`,
 *     pure and synchronous, returning `{data, assets, unfilled}`.
 *
 *   Nothing bridged the two, so `loadDefaultPdfRenderDataMapper` threw
 *   `PdfRenderDataMapperUnavailableError` on every single call and D-2 fell
 *   through to "mapper unavailable" forever: not one article was ever mapped
 *   on the bridge path, which is the entire point of the wave.
 *
 * The fix is here rather than in `render-data-mapper.ts` because that module
 * must stay PURE and must stay adoptable by cms-agent unchanged (D-C): it
 * owns the mapping, it does not owe this bridge an async adapter shaped like
 * this bridge's seam. `defaultPdfRenderDataMapper` below is that adapter, and
 * it is a plain static import — the module exists now, so the dynamic-import
 * dance (and the `tsc` hazard that motivated it) is gone with it.
 *
 * THREE THINGS THE SEAM NOW CARRIES that it could not before, each of which
 * was a real defect and not a nicety:
 *
 *   1. `templateSchema` — the target template's `renderDataSchema`. The
 *      mapper enforces the schema's own limits (maxLength, maxItems, the
 *      slot set). Without it every article was mapped against the generic
 *      `article_brochure_v1` contract regardless of the template actually
 *      being rendered, so a long article sailed past the real template's
 *      limits and then failed W1's `RENDER_DATA_INVALID` at job creation —
 *      the exact failure the mapper exists to prevent. The bridge already
 *      fetches this schema for D-3's brand-slot classification, so it costs
 *      no extra round trip.
 *   2. `brand` — the block `pdf-render-brand.ts` resolved for the site. The
 *      mapper never builds a brand (correctly), but it does place one it is
 *      given into the slot the TARGET schema declares, and it reports
 *      `missing:brand` when it has none. Passing it makes `unfilled[]`
 *      truthful instead of always accusing the bridge of a slot the bridge
 *      had in fact filled.
 *   3. `unfilled[]` — the mapper's first-class "what this article could not
 *      fill" output, previously dropped on the floor by a result shape that
 *      had nowhere to put it. A job created from a mapped article that
 *      silently dropped six figures has to SAY so; the bridge surfaces this
 *      on the job response and `render_article_pdf` puts it in the receipt.
 */
import { buildRenderData } from './render-data-mapper.js';

export type PdfRenderDataMapInput = {
  contentItem: Record<string, unknown>;
  templateId: string;
  /**
   * The target template's `renderDataSchema`, as the pdf-tool template
   * record carries it. Omitted ⇒ the mapper falls back to the generic
   * `article_brochure_v1` contract (its own documented default), which is
   * the honest behaviour for a template that declares no schema at all.
   */
  templateSchema?: unknown;
  /**
   * The `brand` block `pdf-render-brand.ts` built for this site, when the
   * template's schema slots `brand` as an object. Passed through verbatim.
   * Omitted for a string brand slot (which wants the site's NAME in the same
   * `brand` slot) or an absent one — D-3 owns that decision and injects those
   * itself, after mapping.
   */
  brand?: unknown;
};

export type PdfRenderDataMapResult =
  | {
      ok: true;
      data: Record<string, unknown>;
      assets?: { images?: unknown[] };
      /** Stable `<code>:<slot>[:<nodeId>]` codes — see UNFILLED_CODES. */
      unfilled?: string[];
    }
  | { ok: false; error: string; errorCode?: string };

export type PdfRenderDataMapper = (input: PdfRenderDataMapInput) => Promise<PdfRenderDataMapResult>;

/**
 * Thrown when an INJECTED mapper cannot be obtained. The default mapper can
 * no longer be unavailable — it is a static import — but the seam keeps the
 * typed failure so a caller that supplies its own mapper thunk (a test, or a
 * future lazily-resolved mapper) still gets a clear typed result rather than
 * a bare crash.
 */
export class PdfRenderDataMapperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PdfRenderDataMapperUnavailableError';
  }
}

/**
 * The real default mapper: T2.1's pure `buildRenderData`, adapted to this
 * seam's async result shape. It is a total function — `buildRenderData` reads
 * every input defensively and never throws on an unexpected article shape —
 * so this adapter has no `ok: false` branch of its own to invent. An article
 * that fills nothing comes back as EMPTY DATA PLUS A FULL `unfilled[]`, not
 * as a refusal: whether thin render data is worth rendering is the caller's
 * call (and W1's `RENDER_DATA_INVALID` is the real arbiter), not this seam's.
 */
export const defaultPdfRenderDataMapper: PdfRenderDataMapper = async (input) => {
  const mapped = buildRenderData(input.contentItem, {
    ...(input.templateSchema !== undefined ? { templateSchema: input.templateSchema } : {}),
    ...(input.brand !== undefined ? { brand: input.brand } : {}),
  });
  return {
    ok: true,
    data: mapped.data as unknown as Record<string, unknown>,
    assets: { images: mapped.assets.images },
    unfilled: mapped.unfilled,
  };
};

export type PdfJobRenderDataResolution =
  | { ok: true; data: Record<string, unknown>; assets?: { images?: unknown[] }; unfilled?: string[] }
  | { ok: false; reason: 'mapper_unavailable'; detail: string }
  | { ok: false; reason: 'mapper_refused'; error: string; errorCode?: string };

/**
 * D-2 (BRIEF §3): runs the injected mapper for a template-render pdf job
 * whose caller omitted `data` entirely. `getMapper` is a THUNK (not the
 * mapper itself) so that an unavailable mapper — a test injecting that
 * failure on purpose, or a future lazily-resolved one — is caught HERE, in
 * one place, rather than requiring every call site to guard it separately.
 * Any OTHER thrown error is a real bug in the mapper itself (or in obtaining
 * it) and is left to propagate — never silently swallowed.
 */
export async function resolvePdfJobRenderData(params: {
  contentItem: Record<string, unknown>;
  templateId: string;
  templateSchema?: unknown;
  brand?: unknown;
  getMapper: () => Promise<PdfRenderDataMapper>;
}): Promise<PdfJobRenderDataResolution> {
  let mapper: PdfRenderDataMapper;
  try {
    mapper = await params.getMapper();
  } catch (error) {
    if (error instanceof PdfRenderDataMapperUnavailableError) {
      return { ok: false, reason: 'mapper_unavailable', detail: error.message };
    }
    throw error;
  }

  const result = await mapper({
    contentItem: params.contentItem,
    templateId: params.templateId,
    ...(params.templateSchema !== undefined ? { templateSchema: params.templateSchema } : {}),
    ...(params.brand !== undefined ? { brand: params.brand } : {}),
  });
  if (result.ok) {
    return {
      ok: true,
      data: result.data,
      ...(result.assets ? { assets: result.assets } : {}),
      ...(result.unfilled ? { unfilled: result.unfilled } : {}),
    };
  }
  return {
    ok: false,
    reason: 'mapper_refused',
    error: result.error,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  };
}
