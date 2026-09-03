/**
 * FIX-3 (brand-imagery wave, BRIEF.md §3.6/§3.9 area — found by the C2
 * sub-agent): `templates/article_brochure_v1.json` in pdf-tool requires
 * `brand` in its `renderDataSchema` (site colors and fonts), but nothing
 * supplied it. CMS-Agent's deterministic renderData mapper deliberately
 * refuses to invent it (reports `artifact_render_data_unfilled:<slot>:brand`)
 * and Platform's pdf-tool-client.ts passed the job's `data` straight through
 * unchanged. Platform is the layer that HAS the site's `brandTokens` (the
 * one governed, revertible source of a site's colors/fonts — see
 * brand-imagery-derive.ts's doc comment for the same posture applied to
 * image generation), so Platform fills `data.brand` for a template-render
 * job, unless the caller already supplied one.
 *
 * Shape mirrors exactly what `article_brochure_v1.json`'s renderDataSchema
 * requires (confirmed against that file, not guessed):
 *   { colors: Record<string,string>, fonts: { sans, serif, heading, mono? }, logo?: assetId }
 * `colors` there is `brandTokens.colors` verbatim -- the template's own
 * `{{ brand.colors['primary'] | default: ... }}` Liquid falls back to a
 * built-in default for any key the site doesn't carry, so no key remapping
 * is needed. `fonts` is `brandTokens.fonts` verbatim (same `{sans, serif,
 * heading, mono?}` shape, both required-key-for-key).
 *
 * `logo` is an ASSET ID, not a blob key. REVIEW (brand-imagery wave): this
 * used to forward `site.logo.imageAssetRef` verbatim, but that field holds a
 * platform Major-Key artifact ref (`image/<req>/<sha>.png`,
 * artifact-trust.ts) — it can never satisfy the template's own `assetId`
 * grammar (`^[a-zA-Z0-9._-]{1,128}$`: no slashes), and nothing put a matching
 * entry in the job's `assets.images` either, so `<img
 * src="https://render.assets.invalid/image/req_…/….png">` resolved to
 * nothing and every branded cover rendered a broken image. A `logo` is
 * therefore emitted ONLY when the site's ref is already a bare, valid asset
 * id — the honest subset. Actually shipping a platform-stored logo into a
 * render needs the §3.10 `assets.images[] {assetId, blobKey}` wiring
 * (pdf-tool's job-assets.ts resolves blobKey -> base64 -> the assets.invalid
 * URL); that is a feature this module deliberately does not fake.
 *
 * Deliberately conservative: a site with no (or malformed) brandTokens gets
 * NOTHING injected -- never fabricated colors -- and the render falls back to
 * the template's own baked-in defaults, exactly as it does today.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getRecordValue = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * pdf-tool's own `assetId` grammar (article_brochure_v1's renderDataSchema
 * `$defs.assetId`, and the id job-assets.ts binds at
 * `https://render.assets.invalid/<assetId>`). A platform Major-Key artifact
 * ref (`image/<req>/<sha>.png`) never matches it — see the module comment.
 */
const RENDER_ASSET_ID_RE = /^[a-zA-Z0-9._-]{1,128}$/;

export type PdfRenderBrand = {
  colors: Record<string, string>;
  fonts: { sans: string; serif: string; heading: string; mono?: string };
  logo?: string;
};

/**
 * Reads `{ colors, fonts, logo? }` off a site.v1 body, in the exact shape
 * article_brochure_v1's renderDataSchema requires. Returns undefined when the
 * site carries no usable brandTokens (absent, no colors, or missing a
 * required font family) -- the caller must leave the render data untouched in
 * that case, never invent a partial/fabricated brand block.
 */
export const pdfRenderBrandFromSiteBody = (body: Record<string, unknown> | undefined): PdfRenderBrand | undefined => {
  const tokens = getRecordValue(body?.brandTokens);
  if (!tokens) return undefined;

  const rawColors = getRecordValue(tokens.colors);
  const colors: Record<string, string> = {};
  if (rawColors) {
    for (const [key, value] of Object.entries(rawColors)) {
      if (typeof value === 'string' && value.trim().length > 0) colors[key] = value;
    }
  }
  if (Object.keys(colors).length === 0) return undefined;

  const rawFonts = getRecordValue(tokens.fonts);
  const sans = toNonEmptyString(rawFonts?.sans);
  const serif = toNonEmptyString(rawFonts?.serif);
  const heading = toNonEmptyString(rawFonts?.heading);
  if (!sans || !serif || !heading) return undefined;
  const mono = toNonEmptyString(rawFonts?.mono);

  const logo = getRecordValue(body?.logo);
  const imageAssetRef = toNonEmptyString(logo?.imageAssetRef);
  const assetId = imageAssetRef && RENDER_ASSET_ID_RE.test(imageAssetRef) ? imageAssetRef : undefined;

  return {
    colors,
    fonts: { sans, serif, heading, ...(mono ? { mono } : {}) },
    ...(assetId ? { logo: assetId } : {}),
  };
};

/**
 * Injects `brand` into a template-render job's `data` from the site's
 * brandTokens -- ONLY when the caller has not already supplied `data.brand`
 * (caller-supplied always wins, untouched) and only when the site actually
 * has usable brandTokens (no brandTokens ⇒ inject nothing, `data` returned
 * exactly as given, letting the template's own defaults carry the render).
 *
 * `data` is `unknown` on the wire (an agent-authored render-data blob); a
 * non-object `data` (including `undefined`) is handled by starting a fresh
 * `{ brand }` object when a brand IS derivable, so a template-render job
 * that supplied no data at all still gets one, and left byte-identical when
 * it isn't.
 */
export const injectPdfRenderDataBrand = (siteBody: Record<string, unknown> | undefined, data: unknown): unknown => {
  if (data !== undefined && !isRecord(data)) return data;

  const existing = getRecordValue(data);
  if (existing && existing.brand !== undefined) return data;

  const brand = pdfRenderBrandFromSiteBody(siteBody);
  if (!brand) return data;

  return { ...(existing ?? {}), brand };
};
