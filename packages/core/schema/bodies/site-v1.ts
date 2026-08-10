/**
 * Site body schema — 'site.v1' (D§3.2).
 *
 * Net-new object type: the blob-object → derived-export → build-time-injection
 * pattern applied to configuration. Replaces config.yaml site/metadata/blog
 * blocks (A§2.10), the Logo.astro hardcode and CustomStyles.astro literals
 * (A§2.13), and ad-hoc Header props (A§2.2). `defaultNavigation` is the ONLY
 * place default menus bind (D§5.4 consolidation); per-page variation goes
 * through page.navigationOverrides, never code.
 *
 * Referenced ObjectIds (navigation instances, announcement sectionRef) are
 * resolved by reference-integrity validation (T0.7), not this shape.
 */
import { z } from 'zod';

import { THEME_AXES } from '../../lib/registry/theme-tokens.js';
import { trackingAttributeShape } from './tracking-attribute-v1.js';

export const SITE_SCHEMA_VERSION = 'site.v1';

// Shared with theme.v1 (W8.3): a theme is a preset FOR this exact shape, so
// the two cannot drift. Colors are keyed by CSS var name minus `--aw-color-`
// (`dark:`-prefixed keys carry the .dark overrides); the consumed key list
// lives in src/lib/registry/theme-tokens.ts.
//
// T10.1: the layout/shape/type axis objects are additive-optional bounded
// enums (11-platformization-plan §1.1). The allowed values come from the
// THEME_AXES registry — the SAME module the renderer's var mappings live in —
// so schema and render cannot drift. An absent axis (or group) means "the
// default look"; no axis value ever carries CSS.
export const brandTokensSchema = z
  .object({
    colors: z.record(z.string(), z.string()),
    fonts: z
      .object({
        sans: z.string(),
        serif: z.string(),
        heading: z.string(),
        // Additive-optional (code/typewriter display): an absent value falls
        // back to the theme-tokens registry's Preflight-matching literal, so
        // no existing theme/site record needs migration.
        mono: z.string().optional(),
      })
      .strict(),
    layout: z
      .object({
        containerWidth: z.enum(THEME_AXES.layout.containerWidth.values).optional(),
        sectionRhythm: z.enum(THEME_AXES.layout.sectionRhythm.values).optional(),
      })
      .strict()
      .optional(),
    shape: z
      .object({
        radius: z.enum(THEME_AXES.shape.radius.values).optional(),
        buttonShape: z.enum(THEME_AXES.shape.buttonShape.values).optional(),
        shadow: z.enum(THEME_AXES.shape.shadow.values).optional(),
      })
      .strict()
      .optional(),
    type: z
      .object({
        scale: z.enum(THEME_AXES.type.scale.values).optional(),
        headingWeight: z.enum(THEME_AXES.type.headingWeight.values).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type BrandTokens = z.infer<typeof brandTokensSchema>;

// brandImagery (W16 C1, §4 vocabulary — Wolf 2026-08-10, supersedes the
// original styleDescriptors/seedStrategy/loras[]/referenceArtifactIds shape):
// the site-level visual-identity contract for AI image generation and image
// search — the STYLE half an agent must never author itself (agents supply
// SUBJECT; W16 C4 wires this into server-side prompt assembly). Optional and
// additive: a site that hasn't declared one carries no style constraint yet.
// Every field is bounded (capped array/string lengths) so nothing unbounded
// lands in the store — the posture brandTokens' CSS-value grammar enforces
// for the palette, applied here to keep the contract small and reviewable.
//
// `palette` is DELIBERATELY separate from brandTokens.colors: brandTokens is
// the site's UI palette (buttons, backgrounds, CSS custom properties), never
// consumed by image generation. FLUX.2 binds a hex value best when it is
// attached to a NAMED OBJECT in the prompt (e.g. "the jacket is #2E5C42"),
// a binding brandTokens' CSS-variable keys cannot express — so the two
// palettes live separately and are allowed to diverge.
//
// `lora` carries `version`/`modelEndpoint` alongside the fal CDN url so a
// forced retrain (fal's LoRA hosting has ~7d retention) is a config change —
// bump version, swap url/modelEndpoint — never archaeology through job
// history to work out which weights are actually live.
//
// `seedBase` gives deterministic PER-ARTIFACT seed derivation: W16 C4 derives
// the actual per-job seed from this plus a stable hash of job identity
// (never Date/Math.random), so the same site never reuses one fixed seed for
// every image yet stays reproducible for the same inputs.
const IMAGE_MEDIUMS = ['photograph', 'digital_illustration', 'flat_vector', 'editorial_collage'] as const;

const boundedString = (max: number) => z.string().trim().min(1).max(max);
const boundedStringArray = (maxItems: number, maxLen: number) => z.array(boundedString(maxLen)).max(maxItems);

const HEX_COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const hexColorSchema = z.string().regex(HEX_COLOR_PATTERN, 'must be a 6-digit hex color, e.g. #2E5C42');

// Per-context "W:H" ratio string, e.g. { article_header: "3:2", pdf_cover: "1:1" }.
// The key set is open (new contexts land without a schema change); each key
// is itself bounded so the record can't carry an unbounded number of
// arbitrarily long context names.
const ASPECT_RATIO_PATTERN = /^\d{1,2}:\d{1,2}$/;
const aspectRatioValueSchema = z.string().regex(ASPECT_RATIO_PATTERN, 'must be a "W:H" ratio string, e.g. "3:2"');
const aspectRatioContextKeySchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, 'context key must be lowercase snake_case, e.g. article_header');

export const brandImageryLoraSchema = z
  .object({
    // HTTPS URL of the trained LoRA .safetensors on fal's CDN.
    url: boundedString(2048),
    // LoRA strength; forwarded straight through to pdf-tool as `scale`.
    scale: z.number().finite().optional(),
    // Prompt phrase the LoRA was trained against, if any.
    triggerPhrase: boundedString(200).optional(),
    // Deliberate: a forced retrain bumps this (and usually url/modelEndpoint)
    // rather than requiring a reader to diff job history to find out which
    // weights are live.
    version: boundedString(60).optional(),
    modelEndpoint: boundedString(200).optional(),
  })
  .strict();
export type BrandImageryLora = z.infer<typeof brandImageryLoraSchema>;

export const brandImageryCompositionSchema = z
  .object({
    subjectScale: boundedString(120).optional(),
    cropRule: boundedString(120).optional(),
    depthOfField: boundedString(120).optional(),
  })
  .strict();
export type BrandImageryComposition = z.infer<typeof brandImageryCompositionSchema>;

export const brandImagerySchema = z
  .object({
    version: z.literal(1),
    medium: z.enum(IMAGE_MEDIUMS),
    // One sentence, prepended to every prompt server-side (W16 C4).
    styleSentence: boundedString(400),
    // Hex swatches bound to named objects per FLUX.2 guidance (see the
    // module doc comment above) — deliberately separate from brandTokens.
    palette: z.array(hexColorSchema).min(1).max(8),
    // What must never appear in the output.
    negative: boundedStringArray(12, 120),
    // Optional; sensible bounded strings, not a full camera-control grammar.
    composition: brandImageryCompositionSchema.optional(),
    // Required (unlike composition/lora): every site declaring brandImagery
    // must say what ratio each context renders at.
    aspectRatios: z.record(aspectRatioContextKeySchema, aspectRatioValueSchema),
    // zod's `.int()` already bounds this to the safe-integer range.
    seedBase: z.number().int().nonnegative(),
    // Layer 2 slot: at most one trained per-brand LoRA today.
    lora: brandImageryLoraSchema.optional(),
  })
  .strict();
export type BrandImagery = z.infer<typeof brandImagerySchema>;

export const siteBodySchema = z
  .object({
    // W13: shared tracking attribute (12-plan §2) — set_tracking is its one writer.
    ...trackingAttributeShape,
    name: z.string().min(1),
    logo: z
      .object({
        text: z.string(),
        imageAssetRef: z.string().optional(),
      })
      .strict(),
    urls: z
      .object({
        base: z.string().min(1),
        canonicalHost: z.string().min(1),
      })
      .strict(),
    metadataDefaults: z
      .object({
        titleTemplate: z.string(),
        description: z.string(),
        ogImage: z.string(),
        twitterHandle: z.string().optional(),
      })
      .strict(),
    brandTokens: brandTokensSchema,
    // W16 C1: additive-optional, privileged-write-only (see object-patch-ops.ts
    // set_site_brand_imagery) — not patchable via set_site_fields, same funnel
    // as brandTokens/site_apply_theme.
    brandImagery: brandImagerySchema.optional(),
    chrome: z
      .object({
        showRssFeed: z.boolean(),
        showThemeToggle: z.boolean(),
        announcement: z
          .object({
            enabled: z.boolean(),
            sectionRef: z.string().min(1).optional(), // shared section ObjectId
          })
          .strict()
          .optional(),
      })
      .strict(),
    defaultNavigation: z
      .object({
        header: z.string().min(1), // navigation ObjectIds
        footer: z.string().min(1),
        secondary: z.string().min(1).optional(),
        social: z.string().min(1).optional(),
      })
      .strict(),
    blog: z
      .object({
        listPath: z.string().min(1),
        postsPerPage: z.number().int().positive(),
        categoryBase: z.string(),
        tagBase: z.string(),
      })
      .strict(),
  })
  .strict();
export type SiteBody = z.infer<typeof siteBodySchema>;
