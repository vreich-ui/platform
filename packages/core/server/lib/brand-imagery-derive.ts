/**
 * The typed half of brandImagery: validating a STORED `brandImagery` block
 * into the same `BrandImageryRecord` shape the derivation produces, plus the
 * canonical type exports for both halves.
 *
 * The DERIVATION half — the colour maths, palette selection, style-sentence
 * construction and `deriveBrandImageryFromTokens` itself — lives next door in
 * `brand-imagery-derive-core.mjs`, as plain JavaScript with JSDoc types,
 * because CLI code (`packages/core/cli/visual-standard-genesis.mjs` and its
 * callers) has to `import` it under bare `node` with no build step, and Node
 * 20 — this repo's declared `engines` floor and a leg of the CI build matrix —
 * cannot load a `.ts` module. That file states the derivation's governance
 * posture in full; there is exactly ONE implementation of it, and this module
 * re-exports it below so every TypeScript importer keeps a single unchanged
 * entry point (`./brand-imagery-derive.js`) and its types.
 */

export type {
  ImageMedium,
  BrandImageryComposition,
  BrandImageryLora,
  BrandImageryRecord,
} from './brand-imagery-derive-core.mjs';

export { fnv1aHash, deriveBrandImageryFromTokens } from './brand-imagery-derive-core.mjs';

import { isRecord } from './brand-imagery-derive-core.mjs';
import type {
  BrandImageryComposition,
  BrandImageryLora,
  BrandImageryRecord,
  ImageMedium,
} from './brand-imagery-derive-core.mjs';

// Tiny local equivalents of mcp.ts's toNonEmptyString/getRecordValue -- kept
// here (rather than imported from mcp.ts) so this file stays a leaf both
// mcp-tool-handlers.ts and brand-imagery-resolve.ts (P4, brand-imagery wave)
// can import from without risking a cycle. Its only import is the derivation
// core beside it, which imports nothing at all.
const toNonEmptyString = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const getRecordValue = (value: unknown): Record<string, unknown> | undefined => (isRecord(value) ? value : undefined);

// ─── parseBrandImagery: validating a stored brandImagery block (declared, on
// site.v1 OR visual_standard.v1 -- the schema is REUSED verbatim, brief §3.1)
// into the same BrandImageryRecord shape deriveBrandImageryFromTokens
// produces. Moved here (from mcp-tool-handlers.ts, W16 C4) so brand-imagery-
// resolve.ts (P4, brand-imagery wave §3.4) can share it without importing the
// handler file — this module stays the one leaf all three brandImagery
// producers (declared-parse, derive-from-tokens, and the §3.4 resolver) sit
// on top of. ──────────────────────────────────────────────────────────────
const IMAGE_MEDIUMS = new Set<ImageMedium>(['photograph', 'digital_illustration', 'flat_vector', 'editorial_collage']);

export const toFiniteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toMedium = (value: unknown): ImageMedium | undefined => {
  const str = toNonEmptyString(value);
  return str && (IMAGE_MEDIUMS as Set<string>).has(str) ? (str as ImageMedium) : undefined;
};

const toStringArray = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
  return items.length > 0 ? items : undefined;
};

const toComposition = (value: unknown): BrandImageryComposition | undefined => {
  const record = getRecordValue(value);
  if (!record) return undefined;
  const composition: BrandImageryComposition = {};
  const subjectScale = toNonEmptyString(record.subjectScale);
  if (subjectScale) composition.subjectScale = subjectScale;
  const cropRule = toNonEmptyString(record.cropRule);
  if (cropRule) composition.cropRule = cropRule;
  const depthOfField = toNonEmptyString(record.depthOfField);
  if (depthOfField) composition.depthOfField = depthOfField;
  return Object.keys(composition).length > 0 ? composition : undefined;
};

const toAspectRatios = (value: unknown): Record<string, string> | undefined => {
  const record = getRecordValue(value);
  if (!record) return undefined;
  const ratios: Record<string, string> = {};
  for (const [key, raw] of Object.entries(record)) {
    const ratio = toNonEmptyString(raw);
    if (ratio) ratios[key] = ratio;
  }
  return Object.keys(ratios).length > 0 ? ratios : undefined;
};

const toLora = (value: unknown): BrandImageryLora | undefined => {
  const record = getRecordValue(value);
  const url = toNonEmptyString(record?.url);
  if (!url) return undefined;
  const scale = toFiniteNumber(record?.scale);
  const triggerPhrase = toNonEmptyString(record?.triggerPhrase);
  const version = toNonEmptyString(record?.version);
  const modelEndpoint = toNonEmptyString(record?.modelEndpoint);
  return {
    url,
    ...(scale === undefined ? {} : { scale }),
    ...(triggerPhrase ? { triggerPhrase } : {}),
    ...(version ? { version } : {}),
    ...(modelEndpoint ? { modelEndpoint } : {}),
  };
};

/**
 * Validates and normalizes a stored `brandImagery` block (found at
 * `body.brandImagery`) into a BrandImageryRecord. version/medium/
 * styleSentence/palette/seedBase are all REQUIRED by the site.v1 /
 * visual_standard.v1 schema (the same schema, reused) -- a stored record
 * missing one of them failed to write validly, so this degrades to "no
 * brandImagery" (additive contract, never a hard failure) instead of
 * half-applying an incomplete contract.
 */
export const parseBrandImagery = (body: Record<string, unknown> | undefined): BrandImageryRecord | undefined => {
  const raw = getRecordValue(body?.brandImagery);
  if (!raw) return undefined;
  const medium = toMedium(raw.medium);
  const styleSentence = toNonEmptyString(raw.styleSentence);
  const palette = toStringArray(raw.palette);
  const seedBase = toFiniteNumber(raw.seedBase);
  if (raw.version !== 1 || !medium || !styleSentence || !palette || seedBase === undefined) return undefined;
  return {
    version: 1,
    medium,
    styleSentence,
    palette,
    negative: toStringArray(raw.negative) ?? [],
    composition: toComposition(raw.composition),
    aspectRatios: toAspectRatios(raw.aspectRatios),
    seedBase,
    lora: toLora(raw.lora),
  };
};
