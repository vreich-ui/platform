/**
 * P4 (brand-imagery wave, BRIEF.md §3.4 + §3.7's overridePolicy read path):
 * the effective-brand resolver for the `style` override channel on
 * `create_agent_artifact_job`, plus the size-mapping table for the 5 allowed
 * image sizes and the guardrail reader.
 *
 * `resolveEffectiveBrandImagery` (and the size/usage-context helpers beside
 * it) are PURE — no I/O, deterministic given their inputs — so the full
 * precedence table is directly unit-testable without a store or a pdf-tool
 * stub. `getBrandImageryOverridePolicy` is the one function here that does
 * I/O (a governance blob-store read); it is co-located because it is the
 * other half of the same feature, not because it is pure.
 *
 * Precedence (R4): `override` > `visualStandardId` (its visual_standard's
 * brandImagery) > `site.brandImagery` (declared) > a contract derived from
 * `site.brandTokens`. Guardrail `lock` (R5) skips the whole `style` channel
 * (override AND visualStandardId) and falls straight to site/derived,
 * reporting `overriddenFields: ['style']` and `styleSource: 'site_locked'` —
 * never an error. `override` is a SHALLOW merge onto whichever base tier
 * applies (no per-key diff semantics — out of scope, BRIEF §4).
 */
import {
  deriveBrandImageryFromTokens,
  type BrandImageryRecord,
} from './brand-imagery-derive.js';
import { getGovernanceBlobStore, getGovernanceDoc } from './governance-store.js';

export type BrandImageryOverridePolicy = 'allow' | 'lock';

export type BrandImageryStyleInput = {
  visualStandardId?: string;
  override?: Partial<BrandImageryRecord>;
  note?: string;
};

export type StyleSource = 'override' | 'visual_standard' | 'site' | 'derived' | 'site_locked';

export type SiteForBrandImageryResolve = {
  siteId: string;
  /** The site's own DECLARED brandImagery (already parsed/validated), if any. */
  brandImagery?: BrandImageryRecord;
  /** Raw site body (for the brandTokens-derive fallback when brandImagery is
   *  absent). Only `body.brandTokens` is read. */
  body?: Record<string, unknown>;
};

export type ResolvedBrandImagery = {
  brandImagery: BrandImageryRecord | undefined;
  styleSource: StyleSource;
  /** Non-empty only when the guardrail actually blocked a supplied `style`
   *  (['style']) -- the resolver never uses this for anything else (no
   *  per-key diff, BRIEF §4). */
  overriddenFields: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

/**
 * Normalizes a raw `style` argument (create_agent_artifact_job input) into
 * BrandImageryStyleInput, or undefined when it carries nothing usable — an
 * empty/absent `style` and an all-empty one are indistinguishable to every
 * caller, which is exactly what lets `Boolean(styleInput)` stand in for "did
 * the caller actually try to use the style channel".
 */
export const toStyleInput = (value: unknown): BrandImageryStyleInput | undefined => {
  if (!isRecord(value)) return undefined;
  const visualStandardId = toNonEmptyString(value.visualStandardId);
  const override =
    isRecord(value.override) && Object.keys(value.override).length > 0
      ? (value.override as Partial<BrandImageryRecord>)
      : undefined;
  const note = toNonEmptyString(value.note);
  if (!visualStandardId && !override && !note) return undefined;
  return {
    ...(visualStandardId ? { visualStandardId } : {}),
    ...(override ? { override } : {}),
    ...(note ? { note } : {}),
  };
};

/**
 * The effective-brand resolver. `standard` is the ALREADY-RESOLVED
 * brandImagery of the visual_standard named by `style.visualStandardId`
 * (fetching that object is the caller's job — this module is pure); pass
 * undefined when no visualStandardId was given, or when it failed to
 * resolve (unknown id, store error) — degrading to the next tier rather than
 * erroring, same posture as every other brandImagery fallback in this wave.
 */
export const resolveEffectiveBrandImagery = (
  site: SiteForBrandImageryResolve,
  standard: BrandImageryRecord | undefined,
  style: BrandImageryStyleInput | undefined,
  policy: BrandImageryOverridePolicy
): ResolvedBrandImagery => {
  const siteBrand = site.brandImagery;
  const derivedBrand = siteBrand ? undefined : deriveBrandImageryFromTokens(site.body, site.siteId);
  const fallbackBrand = siteBrand ?? derivedBrand;
  const fallbackSource: StyleSource = siteBrand ? 'site' : 'derived';
  const styleAttempted = Boolean(style);

  if (policy === 'lock') {
    return {
      brandImagery: fallbackBrand,
      styleSource: styleAttempted ? 'site_locked' : fallbackSource,
      overriddenFields: styleAttempted ? ['style'] : [],
    };
  }

  const base = standard ?? fallbackBrand;
  const baseSource: StyleSource = standard ? 'visual_standard' : fallbackSource;

  if (style?.override) {
    // Shallow merge only (BRIEF §4: no per-key diff semantics) -- a field
    // present in `override` replaces the base field wholesale, absent fields
    // fall through unchanged.
    const merged = { ...(base ?? {}), ...style.override } as BrandImageryRecord;
    return { brandImagery: merged, styleSource: 'override', overriddenFields: [] };
  }

  return { brandImagery: base, styleSource: baseSource, overriddenFields: [] };
};

// ─── size mapping: aspectRatios[usageContext] -> requirements.image.size ────

/** The only 5 sizes pdf-tool's image requirements accept (agent-artifact-jobs.ts). */
export const ALLOWED_IMAGE_SIZES = ['1024x1024', '1024x1792', '1792x1024', '1536x1024', '1024x1536'] as const;
export type AllowedImageSize = (typeof ALLOWED_IMAGE_SIZES)[number];

const parseSizeRatio = (size: AllowedImageSize): number => {
  const [w, h] = size.split('x').map(Number);
  return w / h;
};

/** size -> its own W/H ratio, e.g. "1536x1024" -> 1.5. Exported as the
 *  size-mapping table the brief calls for. */
export const IMAGE_SIZE_RATIOS: Record<AllowedImageSize, number> = ALLOWED_IMAGE_SIZES.reduce(
  (acc, size) => ({ ...acc, [size]: parseSizeRatio(size) }),
  {} as Record<AllowedImageSize, number>
);

const parseAspectRatio = (value: string): number | undefined => {
  const match = /^(\d{1,2}):(\d{1,2})$/.exec(value.trim());
  if (!match) return undefined;
  const w = Number(match[1]);
  const h = Number(match[2]);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return undefined;
  return w / h;
};

/**
 * Nearest allowed size by aspect ratio, comparing in log-space so a
 * portrait/landscape pair the same "distance" apart lands symmetrically
 * (a linear diff would bias toward the wider landscape sizes). Ties break on
 * ALLOWED_IMAGE_SIZES' own (fixed, deterministic) order.
 */
export const nearestAllowedSize = (ratio: number): AllowedImageSize => {
  let best: AllowedImageSize = ALLOWED_IMAGE_SIZES[0];
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const size of ALLOWED_IMAGE_SIZES) {
    const distance = Math.abs(Math.log(ratio / IMAGE_SIZE_RATIOS[size]));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = size;
    }
  }
  return best;
};

/** aspectRatios[usageContext] (a "W:H" string) -> the nearest allowed size,
 *  or undefined when this usageContext has no declared ratio (nothing to map). */
export const resolveImageSizeForContext = (
  usageContext: string,
  aspectRatios: Record<string, string> | undefined
): AllowedImageSize | undefined => {
  const raw = aspectRatios?.[usageContext];
  if (!raw) return undefined;
  const ratio = parseAspectRatio(raw);
  return ratio === undefined ? undefined : nearestAllowedSize(ratio);
};

// ─── usageContext coercion against the image-model-policy's known keys ──────

export const DEFAULT_USAGE_CONTEXT = 'article_body';

/**
 * A caller-supplied usageContext not in this project's image-model-policy
 * keys (`get_image_model_policy`'s `contexts`) is coerced to article_body and
 * reported in `warnings` (never an error). An OMITTED usageContext silently
 * defaults to article_body with no warning -- there is nothing to warn about
 * when the caller never named one. `policyContexts` undefined (policy fetch
 * skipped or failed) means "no membership check" -- pass the value through.
 */
export const resolveUsageContext = (
  requested: string | undefined,
  policyContexts: string[] | undefined
): { usageContext: string; warnings: string[] } => {
  if (!requested) return { usageContext: DEFAULT_USAGE_CONTEXT, warnings: [] };
  if (!policyContexts || policyContexts.includes(requested)) return { usageContext: requested, warnings: [] };
  return { usageContext: DEFAULT_USAGE_CONTEXT, warnings: [`usage_context_not_in_policy:${requested}`] };
};

// ─── the guardrail reader (I/O -- the one non-pure export in this module) ───

/**
 * Reads the `brandImageryOverrides` guardrail from the SAME runtime-override
 * governance doc the admin GovernancePage's Visual identity guardrail card
 * edits (governance-store.ts's `overrides.v1` blob) — default 'allow' on
 * anything short of an explicit 'lock' (missing doc, missing field, or a
 * store read failure all degrade to 'allow', same disaster-fallback posture
 * every other governance override in this doc already has). `siteId` is
 * accepted for interface parity with the rest of this wave's per-site
 * lookups; the blob store itself is already scoped to this deployment's one
 * site, so it is not otherwise used to select a store. `event` is the
 * Lambda/Netlify Blobs context (optional — omit in tests, where the local
 * file-backed store is used instead).
 */
export const getBrandImageryOverridePolicy = async (
  siteId: string,
  event?: unknown
): Promise<BrandImageryOverridePolicy> => {
  void siteId;
  try {
    const store = await getGovernanceBlobStore(event);
    const doc = await getGovernanceDoc(store);
    return doc?.brandImageryOverrides === 'lock' ? 'lock' : 'allow';
  } catch {
    return 'allow';
  }
};
