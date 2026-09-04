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

// ─── D-3 (BRIEF-W2.md §3, T2.2): the `[object Object]` regression ──────────
//
// The bug: this bridge used to inject `data.brand = {colors, fonts}` into
// ANY template-render pdf job that carried a templateId, with no regard for
// what that template's OWN renderDataSchema slots `brand` AS. A template
// whose Liquid renders `{{ brand }}` directly (a plain string slot) got the
// literal string "[object Object]" instead — twice, per the 2026-09-03
// incident report (BRIEF §0). The fix is to ask the template first.

export type RenderDataBrandSlot = 'object' | 'string' | 'none';

/**
 * Resolves ONE level of a local JSON-Schema `$ref` (`#/$defs/...` or
 * `#/definitions/...` — the only two forms pdf-tool's own templates use,
 * per BRIEF §2's `article_brochure_v1` contract). Any other ref shape (a
 * remote URL, a fragment that does not resolve) returns undefined — the
 * caller's cue to classify conservatively as 'none' rather than guess.
 */
const resolveLocalSchemaRef = (root: Record<string, unknown>, ref: string): Record<string, unknown> | undefined => {
  if (!ref.startsWith('#/')) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split('/')) {
    const segment = decodeURIComponent(rawSegment.replace(/~1/g, '/').replace(/~0/g, '~'));
    if (!isRecord(node)) return undefined;
    node = node[segment];
  }
  return isRecord(node) ? node : undefined;
};

/**
 * D-3: classifies a template's `renderDataSchema.properties.brand` as the
 * structured object shape (`{colors, fonts, logo?}` — article_brochure_v1's
 * own contract), a plain string slot, or 'none' when the schema does not
 * declare a usable `brand` slot at all (no schema, no `properties.brand`,
 * or an unresolved `$ref`). Deliberately conservative on every ambiguous
 * case — 'none' means "inject nothing", never "guess object like before".
 */
export const classifyRenderDataBrandSlot = (renderDataSchema: unknown): RenderDataBrandSlot => {
  if (!isRecord(renderDataSchema)) return 'none';
  const properties = getRecordValue(renderDataSchema.properties);
  const brandSchema = getRecordValue(properties?.brand);
  if (!brandSchema) return 'none';

  let resolved = brandSchema;
  if (typeof resolved.$ref === 'string') {
    const target = resolveLocalSchemaRef(renderDataSchema, resolved.$ref);
    if (!target) return 'none';
    resolved = target;
  }

  if (resolved.type === 'string') return 'string';
  if (resolved.type === 'object') return 'object';
  // No explicit `type` but the resolved schema still describes an object
  // (has its own `properties`) — the JSON-Schema-implicit-object case.
  if (resolved.type === undefined && isRecord(resolved.properties)) return 'object';
  return 'none';
};

/**
 * The string-slot sibling of `pdfRenderBrandFromSiteBody`: for a template
 * that slots `{{ brand }}` as a plain string, the site's display name is
 * the honest analog of "the brand" — never fabricated, just the one field
 * every site body already carries (`name`, required by site-v1.ts).
 */
export const pdfRenderBrandNameFromSiteBody = (body: Record<string, unknown> | undefined): string | undefined =>
  toNonEmptyString(body?.name);

/**
 * String-slot sibling of `injectPdfRenderDataBrand`: fills `data.brand` with
 * the site's display name for a template whose renderDataSchema types `brand`
 * as a plain string. Same caller-wins / non-object-data-untouched rules as the
 * object injector.
 *
 * W2 REVIEW — IT WRITES `brand`, NOT `brandName`. As shipped, D-3's string
 * branch wrote `data.brandName` and left `data.brand` empty, which fails a
 * template that declares a string `brand` TWICE over: these renderDataSchemas
 * are `additionalProperties: false`, so an undeclared `brandName` key fails
 * W1's RENDER_DATA_INVALID at job creation, and `{{ brand }}` stays unbound, so
 * strict binding fails the render with DATA_BINDING_ERROR. That turns an ugly-
 * but-rendering `[object Object]` into a hard double failure — strictly worse
 * than the defect the ruling was written to fix. The slot the template declares
 * is `brand`; the fix is to fill it with a value of the type it declares.
 * (Ratified 2026-09-04, W2 review; the rulings doc's D-3 row carries it.)
 */
export const injectPdfRenderDataBrandString = (
  siteBody: Record<string, unknown> | undefined,
  data: unknown
): unknown => {
  if (data !== undefined && !isRecord(data)) return data;

  const existing = getRecordValue(data);
  if (existing && existing.brand !== undefined) return data;

  const brandName = pdfRenderBrandNameFromSiteBody(siteBody);
  if (!brandName) return data;

  return { ...(existing ?? {}), brand: brandName };
};

/**
 * D-3's top-level decision, and the one function mcp-tool-handlers.ts calls:
 * given the RESOLVED brand-slot classification for a job's templateId, inject
 * the object shape, the string shape, or nothing at all. The caller never
 * has to know which of the two injectors above applies, or duplicate the
 * 'none' no-op case.
 */
export const injectPdfRenderDataBrandForSlot = (
  slot: RenderDataBrandSlot,
  siteBody: Record<string, unknown> | undefined,
  data: unknown
): unknown => {
  if (slot === 'object') return injectPdfRenderDataBrand(siteBody, data);
  if (slot === 'string') return injectPdfRenderDataBrandString(siteBody, data);
  return data;
};
