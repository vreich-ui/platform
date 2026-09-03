/**
 * Visual identity → Imagery tab: every decision the board makes, as pure
 * functions (U1, brand-imagery wave; BRIEF.md §3.1/§3.3/§3.5, R5/R6/R9).
 *
 * WHY A MODULE AND NOT THE COMPONENT. Platform admin tests are logic-first
 * `node:test` over `packages/core/lib/admin/*.ts` — `tsconfig.test.json`
 * excludes `packages/core/admin/**\/*.tsx` outright, so a decision that lives
 * in a component is a decision NOTHING tests. `ImageryBoard.tsx` therefore
 * owns markup, hooks and I/O only; the view model, the before/after diff,
 * region normalization, weight bounds, the op payloads and the chat intents
 * all live here.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It never fetches, never touches
 * the DOM, and never re-derives truth the server already owns:
 *
 *  - `site.brandImagery` is the APPLIED copy; a `visual_standard` is the
 *    draft/evolved artifact (R1). This module reads both and compares them —
 *    it never writes either. The only governed writer is
 *    `site_apply_brand_imagery` (R6), reachable from the browser as the
 *    `apply_brand_imagery` object verb; `buildApplyImageryVerb` builds that
 *    request body and nothing else.
 *  - The `brandImageryOverrides` guardrail (R5) is resolved server-side and
 *    read here as a value; the card that EDITS it is U2's, on
 *    `/admin/settings/guardrails`. `lock` never becomes an error — it
 *    disables the override-shaped affordances and explains why.
 *  - Examples are R9 (W5, last): the strip renders a declared empty state,
 *    not a fabricated grid. Task X1 fills it.
 */
import { getAdminBlobImageEndpoint } from './artifact-preview.js';
import type { EditorialArtifact } from './editorial-assets.js';
import type { StudioRecord } from './studio-client.js';

type Bag = Record<string, unknown>;

const asBag = (value: unknown): Bag =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Bag) : {};
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;
const num = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

/** Order-insensitive canonical JSON — the diff compares VALUES, not key order. */
export const stableJson = (value: unknown): string => {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const bag = value as Bag;
    return `{${Object.keys(bag)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(bag[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
};

// ─── Tabs ───────────────────────────────────────────────────────────────────
//
// Three tabs, ONE route (`/admin/settings/visual-identity`) — BRIEF §4 puts
// new admin routes out of scope, so the tab is a `?tab=` query round-trip on
// the page that already exists, exactly like `object-detail-tabs.ts`'s
// `parseDetailTab`. Lives in this module rather than the component for the
// reason at the top of the file: a component-local constant is untested.

export const VISUAL_IDENTITY_TABS = ['identity', 'imagery', 'pdf'] as const;
export type VisualIdentityTab = (typeof VISUAL_IDENTITY_TABS)[number];

export const VISUAL_IDENTITY_TAB_LABELS: Record<VisualIdentityTab, string> = {
  identity: 'Identity',
  imagery: 'Imagery',
  pdf: 'PDF templates',
};

const TAB_SET = new Set<string>(VISUAL_IDENTITY_TABS);

/** `?tab=` round-trip; anything unknown falls back to the brand board. */
export const parseVisualIdentityTab = (raw: string | null | undefined): VisualIdentityTab =>
  raw && TAB_SET.has(raw) ? (raw as VisualIdentityTab) : 'identity';

// ─── Bounds the schema already declares (visual-standard-v1.ts) ─────────────

/** `references` max 24 (visual-standard-v1.ts). */
export const MOOD_BOARD_MAX_REFERENCES = 24;
/** The node runner's image cap — a propose call carries at most 8 (BRIEF §3.9). */
export const PROPOSAL_MAX_REFERENCES = 8;
/** `sampleSubjects` is 1..6. */
export const MAX_SAMPLE_SUBJECTS = 6;

export const REFERENCE_WEIGHT_MIN = 0;
export const REFERENCE_WEIGHT_MAX = 1;
/** Midjourney `--sw` analogue: omitted means full strength. */
export const REFERENCE_WEIGHT_DEFAULT = 1;
export const REFERENCE_WEIGHT_STEP = 0.05;

/**
 * A slider hands back strings, a stale record can carry anything, and the
 * schema bounds `weight` to 0..1 — so every value entering the board goes
 * through here. Non-numeric input resolves to the schema's own default (1)
 * rather than 0: "unreadable" must never silently mean "ignore this
 * reference".
 */
export const clampReferenceWeight = (value: unknown): number => {
  // Deliberately NOT `Number(value)` on anything: `Number(null)` and
  // `Number('')` are 0, and 0 is a MEANINGFUL weight ("ignore this
  // reference"). Only a real number or a numeric string may produce one.
  const parsed =
    typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return REFERENCE_WEIGHT_DEFAULT;
  const bounded = Math.min(REFERENCE_WEIGHT_MAX, Math.max(REFERENCE_WEIGHT_MIN, parsed));
  // Two decimals: the slider's step is 0.05 and the store should not carry
  // float noise like 0.30000000000000004.
  return Math.round(bounded * 100) / 100;
};

export const referenceWeightLabel = (value: unknown): string =>
  `${Math.round(clampReferenceWeight(value) * 100)}% style weight`;

// ─── Region (the drag rectangle) ────────────────────────────────────────────

export interface ImageryRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Below this, a rectangle is a mis-click, not a crop. The writer crops to the
 * region server-side (brand-imagery-proxy.ts) — a 3-pixel region is a wasted
 * model call, so a too-small drag resolves to "whole image" (region absent).
 */
export const MIN_REGION_FRACTION = 0.02;

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4;

/**
 * Normalize anything region-shaped to the schema's 0..1 fractions, or
 * `undefined` for "the whole image" (visual-standard-v1.ts: an ABSENT region
 * means whole, so a full-bleed rectangle must normalize to absent rather than
 * to `{0,0,1,1}` — two encodings of one fact is how a mood board starts
 * disagreeing with itself).
 *
 * Handles the three ways a drag rectangle arrives wrong: negative extents (a
 * drag up/left), extents running past the edge, and non-finite numbers.
 */
export function normalizeRegion(input: unknown): ImageryRegion | undefined {
  const bag = asBag(input);
  let x = Number(bag.x);
  let y = Number(bag.y);
  let w = Number(bag.w);
  let h = Number(bag.h);
  if (![x, y, w, h].every((value) => Number.isFinite(value))) return undefined;

  // A drag that ran up/left arrives with negative extents — flip it.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  x = clamp01(x);
  y = clamp01(y);
  w = clamp01(w);
  h = clamp01(h);
  // Never let the rectangle run past the right/bottom edge.
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;

  if (w < MIN_REGION_FRACTION || h < MIN_REGION_FRACTION) return undefined;
  if (x <= 0 && y <= 0 && w >= 1 && h >= 1) return undefined;
  return { x: round4(x), y: round4(y), w: round4(w), h: round4(h) };
}

export interface DragPoint {
  x: number;
  y: number;
}

/**
 * Pixel drag → 0..1 fractions. `bounds` is the rendered image box
 * (`getBoundingClientRect()`); the component passes numbers, this does the
 * arithmetic, so the only untested thing left in the component is the
 * listener wiring.
 */
export function regionFromDrag(
  start: DragPoint,
  end: DragPoint,
  bounds: { width: number; height: number }
): ImageryRegion | undefined {
  const width = Number(bounds?.width);
  const height = Number(bounds?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return normalizeRegion({
    x: Math.min(start.x, end.x) / width,
    y: Math.min(start.y, end.y) / height,
    w: Math.abs(end.x - start.x) / width,
    h: Math.abs(end.y - start.y) / height,
  });
}

export type RegionScope = 'whole' | 'region';

export const regionScope = (region: ImageryRegion | undefined): RegionScope => (region ? 'region' : 'whole');

export const regionScopeLabel = (region: ImageryRegion | undefined): string =>
  region ? `Region ${Math.round(region.w * 100)}×${Math.round(region.h * 100)}%` : 'Whole image';

// ─── The contract card ──────────────────────────────────────────────────────

export const IMAGE_MEDIUM_LABELS: Record<string, string> = {
  photograph: 'Photography',
  digital_illustration: 'Digital illustration',
  flat_vector: 'Flat vector',
  editorial_collage: 'Editorial collage',
};

export const mediumLabel = (medium: unknown): string | undefined => {
  const key = str(medium);
  if (!key) return undefined;
  return IMAGE_MEDIUM_LABELS[key] ?? key.replace(/_/g, ' ');
};

export interface AspectRatioRow {
  context: string;
  contextLabel: string;
  ratio: string;
}

export interface CompositionRow {
  label: string;
  value: string;
}

export interface ImageryContractView {
  present: boolean;
  medium?: string;
  mediumLabel?: string;
  styleSentence?: string;
  palette: string[];
  negatives: string[];
  aspectRatios: AspectRatioRow[];
  composition: CompositionRow[];
  seedBase?: number;
  lora?: { version?: string; scale?: number; triggerPhrase?: string; url?: string };
}

const COMPOSITION_LABELS: Record<string, string> = {
  subjectScale: 'Subject scale',
  cropRule: 'Crop rule',
  depthOfField: 'Depth of field',
};

const humanizeContext = (key: string): string => key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

/** Project a `brandImagery` block (site's applied copy OR a standard's) for display. */
export function buildImageryContractView(imagery: unknown): ImageryContractView {
  const body = asBag(imagery);
  const present = Object.keys(body).length > 0;
  const lora = asBag(body.lora);
  const composition = asBag(body.composition);
  return {
    present,
    ...(str(body.medium) ? { medium: str(body.medium) } : {}),
    ...(mediumLabel(body.medium) ? { mediumLabel: mediumLabel(body.medium) } : {}),
    ...(str(body.styleSentence) ? { styleSentence: str(body.styleSentence) } : {}),
    palette: asArray(body.palette)
      .map(str)
      .filter((value): value is string => Boolean(value)),
    negatives: asArray(body.negative)
      .map(str)
      .filter((value): value is string => Boolean(value)),
    aspectRatios: Object.entries(asBag(body.aspectRatios))
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([context, ratio]) => ({ context, contextLabel: humanizeContext(context), ratio: (ratio as string).trim() }))
      .sort((a, b) => a.context.localeCompare(b.context)),
    composition: Object.entries(composition)
      .filter(([, value]) => typeof value === 'string' && value.trim())
      .map(([key, value]) => ({
        label: COMPOSITION_LABELS[key] ?? humanizeContext(key),
        value: (value as string).trim(),
      }))
      .sort((a, b) => a.label.localeCompare(b.label)),
    ...(num(body.seedBase) !== undefined ? { seedBase: num(body.seedBase) } : {}),
    ...(Object.keys(lora).length
      ? {
          lora: {
            ...(str(lora.version) ? { version: str(lora.version) } : {}),
            ...(num(lora.scale) !== undefined ? { scale: num(lora.scale) } : {}),
            ...(str(lora.triggerPhrase) ? { triggerPhrase: str(lora.triggerPhrase) } : {}),
            ...(str(lora.url) ? { url: str(lora.url) } : {}),
          },
        }
      : {}),
  };
}

// ─── The applied card's provenance ──────────────────────────────────────────

export type AppliedImagerySourceKind = 'visual_standard' | 'theme' | 'unrecorded';

export interface AppliedImageryView extends ImageryContractView {
  source: { kind: AppliedImagerySourceKind; id?: string; label: string };
  appliedAt?: string;
}

/**
 * Where the site's applied copy came from. `apply_brand_imagery` stamps
 * `applied_brand_imagery_source: { kind, id }` onto the history entry for its
 * `set_site_brand_imagery` op (object-verbs.ts), so the LAST such entry is the
 * answer — no new endpoint, no second source of truth. A site whose imagery
 * predates the verb (a genesis mint, a backfill) reports `unrecorded` rather
 * than guessing.
 */
export function readAppliedImagerySource(site: unknown): {
  kind: AppliedImagerySourceKind;
  id?: string;
  label: string;
  appliedAt?: string;
} {
  const history = asArray(asBag(site).history);
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const entry = asBag(history[index]);
    const source = asBag(asBag(entry.details).applied_brand_imagery_source);
    const kind = str(source.kind);
    const id = str(source.id);
    if (!kind || !id) continue;
    if (kind === 'visual_standard' || kind === 'theme') {
      return {
        kind,
        id,
        label: kind === 'theme' ? `Theme ${id}` : `Visual standard ${id}`,
        ...(str(entry.at) ? { appliedAt: str(entry.at) } : {}),
      };
    }
  }
  return { kind: 'unrecorded', label: 'Not recorded — set before the apply verb existed' };
}

// ─── Mood board ─────────────────────────────────────────────────────────────

export interface MoodBoardReferenceView {
  id: string;
  blobKey: string;
  note?: string;
  weight: number;
  weightLabel: string;
  region?: ImageryRegion;
  scope: RegionScope;
  scopeLabel: string;
  /** Present only when `admin-get-blob-image` can actually serve this key. */
  previewUrl?: string;
  previewUnavailableReason?: string;
}

/**
 * `admin-get-blob-image` only serves `image/<requestId>/<sha256>[.ext]` keys
 * (its `allowedImageBlobKeyPattern`). A reference pointing anywhere else is
 * still a valid mood-board entry — it just cannot be previewed in the admin,
 * and saying so is better than an <img> that 403s forever.
 */
export function buildMoodBoardReference(raw: unknown): MoodBoardReferenceView | undefined {
  const bag = asBag(raw);
  const id = str(bag.id);
  const blobKey = str(bag.blobKey);
  if (!id || !blobKey) return undefined;
  const region = normalizeRegion(bag.region);
  const weight = clampReferenceWeight(bag.weight ?? REFERENCE_WEIGHT_DEFAULT);
  const previewUrl = getAdminBlobImageEndpoint(blobKey);
  return {
    id,
    blobKey,
    ...(str(bag.note) ? { note: str(bag.note) } : {}),
    weight,
    weightLabel: referenceWeightLabel(weight),
    ...(region ? { region } : {}),
    scope: regionScope(region),
    scopeLabel: regionScopeLabel(region),
    ...(previewUrl
      ? { previewUrl }
      : { previewUnavailableReason: 'This image is not in the admin-previewable artifact store.' }),
  };
}

/**
 * The library picker hands back an `EditorialArtifact`, whose `preview_url` is
 * `admin-get-blob-image?blobKey=…` — the projection does not carry the raw
 * blob key, and reconstructing one from `id` + `request_id` would have to
 * guess the extension. Reading it back out of the URL the projection itself
 * built is the only lossless route, so it happens here, once, where a test can
 * see it.
 */
export function blobKeyFromPreviewUrl(previewUrl: string | undefined): string | undefined {
  if (!previewUrl) return undefined;
  const match = /[?&]blobKey=([^&]+)/.exec(previewUrl);
  if (!match?.[1]) return undefined;
  try {
    return decodeURIComponent(match[1]) || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `ref_<lowercase alphanumerics>` (visual-standard-v1.ts's `refIdSchema`). The
 * id is OPAQUE and per-reference on purpose: a reordered mood board must never
 * silently repoint an existing note/weight/region at a different image, which
 * is exactly what a positional id would do. `random` is injectable so the test
 * asserts the shape rather than the luck.
 */
export function mintReferenceId(random: () => number = Math.random): string {
  const body = Math.floor(random() * 0xfffffffff)
    .toString(36)
    .replace(/[^a-z0-9]/g, '')
    .padStart(8, '0')
    .slice(0, 8);
  return `ref_${body}`;
}

/** Adding one library image to a board, bounded by the schema's own ceiling. */
export function appendLibraryReference(
  references: readonly MoodBoardReferenceView[],
  input: { blobKey: string; note?: string; id?: string }
): { ok: true; references: MoodBoardReferenceView[] } | { ok: false; error: string } {
  if (references.length >= MOOD_BOARD_MAX_REFERENCES) {
    return { ok: false, error: `A mood board holds at most ${MOOD_BOARD_MAX_REFERENCES} references.` };
  }
  if (references.some((reference) => reference.blobKey === input.blobKey)) {
    return { ok: false, error: 'That image is already on this mood board.' };
  }
  const added = buildMoodBoardReference({
    id: input.id ?? mintReferenceId(),
    blobKey: input.blobKey,
    ...(input.note ? { note: input.note } : {}),
    weight: REFERENCE_WEIGHT_DEFAULT,
  });
  if (!added) return { ok: false, error: 'That image has no usable storage key.' };
  return { ok: true, references: [...references, added] };
}

/**
 * `ArtifactStagePreview` is the ONE authenticated preview component this admin
 * has (it fetches with the Identity bearer and object-URLs the bytes), and it
 * takes an `EditorialArtifact`. A mood-board entry is not an indexed artifact
 * projection, so this adapts one into the shape the component already
 * understands rather than growing a second preview component.
 */
export function moodBoardArtifact(reference: MoodBoardReferenceView): EditorialArtifact | undefined {
  if (!reference.previewUrl) return undefined;
  return {
    id: reference.id,
    kind: 'image',
    family: 'editorial',
    label: reference.note ?? 'Mood board reference',
    filename: reference.blobKey.split('/').pop() ?? reference.blobKey,
    preview_url: reference.previewUrl,
    created_at: '',
    size_bytes: 0,
    tags: [],
  };
}

// ─── Examples (X1, R9 — last, cosmetic) ─────────────────────────────────────
//
// The generator (server/lib/brand-imagery-examples.ts) writes plain
// `{usageContext, blobKey, contractHash}` entries into a standard's
// `examples[]`; this section is the read-only view over that array — the
// same `admin-get-blob-image` preview idiom `buildMoodBoardReference` and
// `moodBoardArtifact` already use for mood-board references, applied here
// instead to a GENERATED example. Nothing here writes; "Regenerate examples"
// is a chat intent (`buildRegenerateExamplesIntent`, below), not a verb this
// module calls directly — R9's example generator is server-side-only.

const EXAMPLE_USAGE_CONTEXT_LABELS: Record<string, string> = {
  article_header: 'Article header',
  article_body: 'Article body',
  category_page: 'Category page',
};

const exampleUsageContextLabel = (usageContext: string): string =>
  EXAMPLE_USAGE_CONTEXT_LABELS[usageContext] ?? usageContext;

export interface VisualStandardExampleView {
  usageContext: string;
  usageContextLabel: string;
  blobKey: string;
  /** Present only when `admin-get-blob-image` can actually serve this key —
   * the same posture as `MoodBoardReferenceView.previewUrl`. */
  previewUrl?: string;
  previewUnavailableReason?: string;
}

export function buildVisualStandardExample(raw: unknown): VisualStandardExampleView | undefined {
  const bag = asBag(raw);
  const usageContext = str(bag.usageContext);
  const blobKey = str(bag.blobKey);
  if (!usageContext || !blobKey) return undefined;
  const previewUrl = getAdminBlobImageEndpoint(blobKey);
  return {
    usageContext,
    usageContextLabel: exampleUsageContextLabel(usageContext),
    blobKey,
    ...(previewUrl
      ? { previewUrl }
      : { previewUnavailableReason: 'This image is not in the admin-previewable artifact store.' }),
  };
}

/** Adapts a generated example into the shape `ArtifactStagePreview` already
 * understands — the same adaptation `moodBoardArtifact` does for a
 * mood-board reference. */
export function exampleArtifact(example: VisualStandardExampleView): EditorialArtifact | undefined {
  if (!example.previewUrl) return undefined;
  return {
    id: `${example.usageContext}:${example.blobKey}`,
    kind: 'image',
    family: 'editorial',
    label: example.usageContextLabel,
    filename: example.blobKey.split('/').pop() ?? example.blobKey,
    preview_url: example.previewUrl,
    created_at: '',
    size_bytes: 0,
    tags: [],
  };
}

// ─── Standards ──────────────────────────────────────────────────────────────

export type VisualStandardKind = 'house' | 'template';
export type VisualStandardStatus = 'draft' | 'active' | 'archived';

export interface VisualStandardView {
  objectId: string;
  kind: VisualStandardKind;
  isHouse: boolean;
  label: string;
  description?: string;
  whenToUse?: string;
  status: VisualStandardStatus;
  references: MoodBoardReferenceView[];
  referenceCount: number;
  sampleSubjects: string[];
  contract: ImageryContractView;
  /** R9/X1: rendered examples this standard's generator has produced so
   * far — empty until the first apply/propose-accept/regenerate. */
  examples: VisualStandardExampleView[];
  derivedFrom?: { method: string; visualStandardId?: string; themeId?: string };
  /** True when this standard's brandImagery is byte-for-byte the site's applied copy. */
  appliedToSite: boolean;
  /** The mood board is full — "Add reference" must stop offering. */
  boardFull: boolean;
}

const readStatus = (value: unknown): VisualStandardStatus =>
  value === 'active' || value === 'archived' ? value : 'draft';

export function buildVisualStandardView(
  record: StudioRecord,
  appliedImageryKey: string
): VisualStandardView | undefined {
  const objectId = str(asBag(record).object_id);
  if (!objectId) return undefined;
  const body = asBag(record.body);
  const kind: VisualStandardKind = body.kind === 'house' ? 'house' : 'template';
  const references = asArray(body.references)
    .map(buildMoodBoardReference)
    .filter((value): value is MoodBoardReferenceView => value !== undefined);
  const derived = asBag(body.derivedFrom);
  return {
    objectId,
    kind,
    isHouse: kind === 'house',
    label: str(body.label) ?? objectId,
    ...(str(body.description) ? { description: str(body.description) } : {}),
    ...(str(body.whenToUse) ? { whenToUse: str(body.whenToUse) } : {}),
    status: readStatus(body.status),
    references,
    referenceCount: references.length,
    sampleSubjects: asArray(body.sampleSubjects)
      .map(str)
      .filter((value): value is string => Boolean(value)),
    contract: buildImageryContractView(body.brandImagery),
    examples: asArray(body.examples)
      .map(buildVisualStandardExample)
      .filter((value): value is VisualStandardExampleView => value !== undefined),
    ...(str(derived.method)
      ? {
          derivedFrom: {
            method: str(derived.method) as string,
            ...(str(derived.visualStandardId) ? { visualStandardId: str(derived.visualStandardId) } : {}),
            ...(str(derived.themeId) ? { themeId: str(derived.themeId) } : {}),
          },
        }
      : {}),
    appliedToSite: appliedImageryKey !== 'undefined' && stableJson(body.brandImagery) === appliedImageryKey,
    boardFull: references.length >= MOOD_BOARD_MAX_REFERENCES,
  };
}

// ─── The workspace view model ───────────────────────────────────────────────

export type BrandImageryOverridePolicy = 'allow' | 'lock';

export interface ImageryWorkspaceViewModel {
  applied: AppliedImageryView;
  /** `vis_<siteShortId>` — R2's house singleton id, so the empty state can name it. */
  houseId?: string;
  house?: VisualStandardView;
  templates: VisualStandardView[];
  /** House first, then templates by label — the order the list renders in. */
  standards: VisualStandardView[];
  selected?: VisualStandardView;
  selectedId?: string;
  overridePolicy: BrandImageryOverridePolicy;
  locked: boolean;
  lockNotice?: string;
  /** Applying is Owner-only for humans (object-verbs.ts re-checks server-side). */
  canApply: boolean;
  canEditBoard: boolean;
  emptyState?: { title: string; message: string };
  /** R9/X1: the SELECTED standard's rendered examples (the server-side
   * generator writes these; nothing here generates them). */
  examples: ImageryExamplesView;
}

export interface ImageryExamplesView {
  items: VisualStandardExampleView[];
  /** Whether "Regenerate examples" should be offered — the same board-edit
   * gate every other write affordance here uses; the generator itself is a
   * server-side cost-controlled decision, this is only whether to SHOW the
   * button. */
  canRegenerate: boolean;
  emptyState?: { title: string; message: string };
}

function buildExamplesView(selected: VisualStandardView | undefined, canEditBoard: boolean): ImageryExamplesView {
  if (!selected) {
    return {
      items: [],
      canRegenerate: false,
      emptyState: {
        title: 'No standard selected',
        message: 'Select a standard above to see its rendered examples.',
      },
    };
  }
  if (selected.examples.length > 0) {
    return { items: selected.examples, canRegenerate: canEditBoard };
  }
  return {
    items: [],
    canRegenerate: canEditBoard,
    emptyState:
      selected.sampleSubjects.length === 0
        ? {
            title: 'No sample subjects yet',
            message: 'Write a contract from the mood board first — examples render from its sampleSubjects.',
          }
        : {
            title: 'No examples yet',
            message:
              'Rendered examples appear here once this standard is applied, written from a proposal, or regenerated below.',
          },
  };
}

export function buildImageryWorkspace(input: {
  site: StudioRecord | undefined;
  standards: readonly StudioRecord[];
  overridePolicy?: BrandImageryOverridePolicy;
  isOwner?: boolean;
  isAdmin?: boolean;
  selectedStandardId?: string;
  siteShortId?: string;
}): ImageryWorkspaceViewModel {
  const siteBody = asBag(input.site?.body);
  const appliedImagery = siteBody.brandImagery;
  const appliedKey = stableJson(appliedImagery);
  const provenance = readAppliedImagerySource(input.site);

  const views = input.standards
    .map((record) => buildVisualStandardView(record, appliedKey))
    .filter((value): value is VisualStandardView => value !== undefined)
    .filter((view) => view.status !== 'archived');
  const house = views.find((view) => view.isHouse);
  const templates = views.filter((view) => !view.isHouse).sort((a, b) => a.label.localeCompare(b.label));
  const standards = [...(house ? [house] : []), ...templates];

  const selected =
    standards.find((view) => view.objectId === input.selectedStandardId) ?? house ?? standards[0] ?? undefined;

  const locked = input.overridePolicy === 'lock';
  const canApply = input.isOwner === true;
  const canEditBoard = input.isAdmin !== false;

  return {
    applied: {
      ...buildImageryContractView(appliedImagery),
      source: {
        kind: provenance.kind,
        ...(provenance.id ? { id: provenance.id } : {}),
        label: provenance.label,
      },
      ...(provenance.appliedAt ? { appliedAt: provenance.appliedAt } : {}),
    },
    ...(input.siteShortId ? { houseId: `vis_${input.siteShortId}` } : {}),
    ...(house ? { house } : {}),
    templates,
    standards,
    ...(selected ? { selected, selectedId: selected.objectId } : {}),
    overridePolicy: locked ? 'lock' : 'allow',
    locked,
    ...(locked
      ? {
          lockNotice:
            'Override is locked for this publication: agents cannot point a run or slot at a different standard, and a supplied style is ignored rather than refused. Templates below stay editable — only the per-run override channel is closed.',
        }
      : {}),
    canApply,
    canEditBoard,
    ...(standards.length
      ? {}
      : {
          emptyState: {
            title: 'No visual standard yet',
            message:
              'This publication has no house standard or template. Start a mood board, then ask the agent to write a contract from it.',
          },
        }),
    examples: buildExamplesView(selected, canEditBoard),
  };
}

// ─── The before/after diff card ─────────────────────────────────────────────

export interface ImageryDiffRow {
  field: string;
  label: string;
  before: string;
  after: string;
  changed: boolean;
}

export interface ImageryDiffModel {
  /** False when the site carries no applied copy at all — everything is an addition. */
  hasBefore: boolean;
  changed: boolean;
  changedFields: string[];
  rows: ImageryDiffRow[];
}

const EMPTY_CELL = '—';

const DIFF_FIELDS: Array<{ field: string; label: string; format: (value: unknown) => string }> = [
  { field: 'medium', label: 'Medium', format: (value) => mediumLabel(value) ?? EMPTY_CELL },
  { field: 'styleSentence', label: 'Style sentence', format: (value) => str(value) ?? EMPTY_CELL },
  {
    field: 'palette',
    label: 'Palette',
    format: (value) => {
      const list = asArray(value)
        .map(str)
        .filter((entry): entry is string => Boolean(entry));
      return list.length ? list.join(', ') : EMPTY_CELL;
    },
  },
  {
    field: 'negative',
    label: 'Never show',
    format: (value) => {
      const list = asArray(value)
        .map(str)
        .filter((entry): entry is string => Boolean(entry));
      return list.length ? list.join(', ') : EMPTY_CELL;
    },
  },
  {
    field: 'aspectRatios',
    label: 'Aspect ratios',
    format: (value) => {
      const rows = Object.entries(asBag(value))
        .filter(([, ratio]) => typeof ratio === 'string')
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([context, ratio]) => `${context} ${ratio as string}`);
      return rows.length ? rows.join(' · ') : EMPTY_CELL;
    },
  },
  {
    field: 'composition',
    label: 'Composition',
    format: (value) => {
      const rows = Object.entries(asBag(value))
        .filter(([, entry]) => typeof entry === 'string' && entry.trim())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => `${COMPOSITION_LABELS[key] ?? key}: ${(entry as string).trim()}`);
      return rows.length ? rows.join('; ') : EMPTY_CELL;
    },
  },
  {
    field: 'seedBase',
    label: 'Seed base',
    format: (value) => (num(value) === undefined ? EMPTY_CELL : String(num(value))),
  },
  {
    field: 'lora',
    label: 'LoRA',
    format: (value) => {
      const lora = asBag(value);
      if (!Object.keys(lora).length) return EMPTY_CELL;
      const version = str(lora.version);
      const scale = num(lora.scale);
      return [version ? `version ${version}` : 'configured', scale === undefined ? undefined : `scale ${scale}`]
        .filter(Boolean)
        .join(' · ');
    },
  },
];

/**
 * The proposal/apply diff, whole-block (R6 — this verb exposes no per-key diff
 * semantics, and BRIEF §4 puts per-key diff semantics out of scope). Rows are
 * a READING of the two blocks for a human; `changedFields` is computed from
 * canonical JSON of the raw values, never from the formatted strings, so two
 * different values that happen to render alike are still reported as changed.
 *
 * Serves both halves of the flow with one model: `before` = the site's applied
 * copy, `after` = either a `brand_imagery_proposal.v1`'s `brandImagery` (the
 * proposal card) or the `apply_brand_imagery` dry-run's `after` (the apply
 * card).
 */
export function buildImageryDiff(before: unknown, after: unknown): ImageryDiffModel {
  const beforeBag = asBag(before);
  const afterBag = asBag(after);
  const hasBefore = Object.keys(beforeBag).length > 0;
  const rows = DIFF_FIELDS.map(({ field, label, format }) => {
    const changed = stableJson(beforeBag[field]) !== stableJson(afterBag[field]);
    return { field, label, before: format(beforeBag[field]), after: format(afterBag[field]), changed };
  });
  const changedFields = rows.filter((row) => row.changed).map((row) => row.field);
  return { hasBefore, changed: changedFields.length > 0, changedFields, rows };
}

// ─── Op payloads and verb requests ──────────────────────────────────────────

export type PatchOp = {
  op: string;
  fields: Record<string, unknown>;
};

/**
 * The mood board is a small DECLARED SET: `set_visual_standard_fields` replaces
 * `references[]` wholesale on a partial merge (object-patch-ops.ts's
 * `editorial_voice.frameworks[]` posture, for the same reason). So a weight
 * nudge, a note edit, a region drag and an added reference are all ONE op
 * carrying the whole array — never a per-entry upsert grammar that does not
 * exist.
 */
export function buildReferencesOp(references: readonly MoodBoardReferenceView[]): PatchOp {
  return {
    op: 'set_visual_standard_fields',
    fields: {
      references: references.slice(0, MOOD_BOARD_MAX_REFERENCES).map((reference) => ({
        id: reference.id,
        blobKey: reference.blobKey,
        ...(reference.region ? { region: reference.region } : {}),
        ...(reference.note ? { note: reference.note } : {}),
        // The schema's default is 1; writing it explicitly keeps the record
        // self-describing and the inverse capture exact.
        weight: clampReferenceWeight(reference.weight),
      })),
    },
  };
}

export type ApplyImageryVerbRequest = {
  action: 'apply_brand_imagery';
  site_id: string;
  visual_standard_id?: string;
  theme_id?: string;
  dry_run?: boolean;
  lock_token?: string;
  expected_record_version?: number;
};

/**
 * `site_apply_brand_imagery` reaches the browser as the `apply_brand_imagery`
 * object verb on `admin-object` — an EXISTING verb, so no endpoint is added
 * for this page. Exactly one source (R6); dry-run needs no checkout, a real
 * apply needs both lock token and version (the handler 400s otherwise).
 */
export function buildApplyImageryVerb(input: {
  siteId: string;
  visualStandardId?: string;
  themeId?: string;
  dryRun?: boolean;
  lockToken?: string;
  expectedRecordVersion?: number;
}): ApplyImageryVerbRequest {
  const hasStandard = Boolean(input.visualStandardId);
  const hasTheme = Boolean(input.themeId);
  if (hasStandard === hasTheme) {
    throw new Error('Applying brand imagery needs exactly one of visualStandardId or themeId.');
  }
  return {
    action: 'apply_brand_imagery',
    site_id: input.siteId,
    ...(input.visualStandardId ? { visual_standard_id: input.visualStandardId } : {}),
    ...(input.themeId ? { theme_id: input.themeId } : {}),
    ...(input.dryRun ? { dry_run: true } : {}),
    ...(input.lockToken ? { lock_token: input.lockToken } : {}),
    ...(input.expectedRecordVersion !== undefined ? { expected_record_version: input.expectedRecordVersion } : {}),
  };
}

// ─── New template (clone) ───────────────────────────────────────────────────

/** Label → the `[a-z0-9]+(_[a-z0-9]+)*` segment grammar `object-ids.ts` enforces. */
export function templateSlug(label: string): string {
  return String(label ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .slice(0, 6)
    .join('_');
}

export const visualStandardTemplateId = (siteShortId: string, slug: string): string => `vis_${siteShortId}_${slug}`;

export interface NewTemplateDraft {
  objectId: string;
  body: Record<string, unknown>;
}

/**
 * "New template" is a CLONE, not a blank form: `visual_standard.v1` requires a
 * full `brandImagery` and at least one `sampleSubject`, so an empty draft
 * cannot be created at all. Cloning the currently-selected standard (or the
 * house) always yields a valid body a human can then edit, and records the
 * lineage the schema has a field for (`derivedFrom.method: 'clone'`).
 *
 * The mood board is deliberately NOT copied — a template's references are its
 * own argument for its look; inheriting the house's board would make every
 * template read as a copy of the house to the writer.
 */
export function buildNewTemplateDraft(input: {
  siteShortId: string;
  label: string;
  source: VisualStandardView | undefined;
  sourceBrandImagery: unknown;
  whenToUse?: string;
}): { ok: true; draft: NewTemplateDraft } | { ok: false; error: string } {
  const label = String(input.label ?? '').trim();
  if (!label) return { ok: false, error: 'Give the template a name.' };
  if (label.length > 80) return { ok: false, error: 'A template name is at most 80 characters.' };
  const slug = templateSlug(label);
  if (!slug) return { ok: false, error: 'That name has no letters or digits to build an id from.' };
  if (!input.siteShortId) return { ok: false, error: 'The publication id is unavailable — reload the page.' };
  const imagery = asBag(input.sourceBrandImagery);
  if (!Object.keys(imagery).length) {
    return {
      ok: false,
      error: 'A template starts from an existing contract. Write the house standard first, then clone it.',
    };
  }
  const sampleSubjects = input.source?.sampleSubjects.length
    ? input.source.sampleSubjects.slice(0, MAX_SAMPLE_SUBJECTS)
    : ['A representative subject for this publication'];
  return {
    ok: true,
    draft: {
      objectId: visualStandardTemplateId(input.siteShortId, slug),
      body: {
        version: 1,
        kind: 'template',
        label,
        ...(input.whenToUse?.trim() ? { whenToUse: input.whenToUse.trim() } : {}),
        brandImagery: imagery,
        references: [],
        sampleSubjects,
        derivedFrom: {
          method: 'clone',
          ...(input.source ? { visualStandardId: input.source.objectId } : {}),
        },
        status: 'draft',
      },
    },
  };
}

// ─── Import from URL ────────────────────────────────────────────────────────

export interface ParsedImportUrls {
  urls: string[];
  rejected: Array<{ value: string; reason: string }>;
}

/**
 * `import_images_from_url` takes a list; the form takes a textarea. https only
 * (the importer fetches server-side — an http URL is a downgrade nobody asked
 * for), deduped, and capped at the node runner's 8-image ceiling so the board
 * cannot be filled with more than one propose call can ever look at.
 */
export function parseImportUrls(raw: string, limit = PROPOSAL_MAX_REFERENCES): ParsedImportUrls {
  const urls: string[] = [];
  const rejected: ParsedImportUrls['rejected'] = [];
  const seen = new Set<string>();
  for (const line of String(raw ?? '').split(/[\s,]+/)) {
    const value = line.trim();
    if (!value) continue;
    if (!/^https:\/\//i.test(value)) {
      rejected.push({ value, reason: 'Only https:// addresses can be imported.' });
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    if (urls.length >= limit) {
      rejected.push({ value, reason: `At most ${limit} images can be imported at once.` });
      continue;
    }
    urls.push(value);
  }
  return { urls, rejected };
}

// ─── Chat intents (the U3 seam) ─────────────────────────────────────────────

/**
 * THE SEAM FOR U3. Three of this tab's actions — `import_images_from_url`,
 * `brand_imagery_propose` and `create_agent_artifact_job` — are MCP/chat tools
 * with NO browser-reachable admin endpoint (unlike `apply_brand_imagery`,
 * which is an object verb this page calls directly). The repo's established
 * answer for a tool-backed admin affordance is the docked agent chat:
 * `TemplatesWorkspace` renders "Render a sample for review." as a rail
 * suggestion, `ObjectWorkspace` passes `contextActions`, and R8 docks the
 * visual-identity chat on THIS page.
 *
 * So the buttons build a precise, deterministic intent here — the exact tool,
 * the exact arguments, spelled into composer text an approval card can then
 * govern — and hand it to whatever `onIntent` the host supplies. U3 wires that
 * to the rail; until then the page falls back to the starter deep link. No
 * client-side write path is invented, and the approval card stays in charge.
 */
export interface VisualIdentityChatIntent {
  /** Agent-starter key the rail opens with. R8 renames `retheme` → `visual-identity`, keeping `retheme` as an alias. */
  starter: 'visual-identity' | 'retheme';
  /** The tool this intent asks the agent to propose — recorded so the seam can assert on it. */
  tool: string;
  /** One-line label for the button that produced it. */
  label: string;
  /** Composer text. */
  prompt: string;
}

const intent = (tool: string, label: string, prompt: string): VisualIdentityChatIntent => ({
  starter: 'visual-identity',
  tool,
  label,
  prompt,
});

export function buildImportReferencesIntent(input: {
  standard: VisualStandardView | undefined;
  urls: readonly string[];
  note?: string;
}): VisualIdentityChatIntent | undefined {
  if (!input.urls.length) return undefined;
  const target = input.standard ? `the visual standard ${input.standard.objectId}` : 'the house visual standard';
  const note = input.note?.trim();
  return intent(
    'import_images_from_url',
    'Add reference',
    `Import these images into this publication's image store with import_images_from_url, then add each one to ${target}'s mood board (references[]) with set_visual_standard_fields, keeping the entries already there:\n${input.urls
      .map((url) => `- ${url}`)
      .join(
        '\n'
      )}${note ? `\n\nNote to record on each new reference: ${note}` : ''}\nDo not write anything else on the standard.`
  );
}

export function buildProposeContractIntent(input: {
  standard: VisualStandardView | undefined;
  mode: 'house' | 'template';
  brief?: string;
}): VisualIdentityChatIntent {
  const brief = input.brief?.trim();
  const board = input.standard
    ? `Use the mood board already on ${input.standard.objectId} (${input.standard.referenceCount} reference${
        input.standard.referenceCount === 1 ? '' : 's'
      }, with their regions, notes and weights).`
    : 'There is no mood board yet — work from the brief alone.';
  return intent(
    'brand_imagery_propose',
    'Write contract from mood board',
    `Call brand_imagery_propose with mode: '${input.mode}'${
      input.standard ? ` and visual_standard_id: '${input.standard.objectId}'` : ''
    }. ${board}${
      brief ? `\n\nBrief: ${brief}` : ''
    }\n\nShow me the returned brand_imagery_proposal.v1 as a diff against the site's current brandImagery before writing anything. Do not apply it without my approval.`
  );
}

export function buildApplyProposalIntent(standard: VisualStandardView): VisualIdentityChatIntent {
  return intent(
    'site_apply_brand_imagery',
    "Make this the site's imagery",
    `Run site_apply_brand_imagery with visual_standard_id: '${standard.objectId}' as a dry run first so I can see before/after, then wait for my approval before applying.`
  );
}

/**
 * R9/X1: there is no browser-reachable "regenerate" verb (the generator is
 * server-side only, gated on the standard's brandImagery hash — BRIEF §3.1)
 * — same posture as `buildProposeContractIntent`/`buildImportReferencesIntent`,
 * a precise instruction naming the exact tool + args for the approval card.
 * Clearing `examples[]` (rather than asking for generation directly) is
 * deliberate: it reuses the SAME `set_visual_standard_fields` op the mood
 * board already writes with and needs no new tool. Platform's object_patch
 * handler runs the example generator right after EVERY successful patch to
 * a visual_standard (mcp-tool-handlers.ts), so this one patch both clears
 * the stale examples AND is itself the trigger that regenerates them — an
 * empty `examples[]` is never "up to date" for any hash.
 */
export function buildRegenerateExamplesIntent(standard: VisualStandardView | undefined): VisualIdentityChatIntent | undefined {
  if (!standard) return undefined;
  return intent(
    'set_visual_standard_fields',
    'Regenerate examples',
    `Regenerate the rendered examples for visual standard ${standard.objectId}. Check it out, patch it with set_visual_standard_fields and fields: { examples: [] } to clear out the examples generated from its previous contract, then check it back in — do not change anything else on the standard. That one patch is also what triggers the example generator: it creates up to 3 image jobs (one per sample subject, for article_header/article_body/category_page) on flux and writes back whichever succeed.`
  );
}

/**
 * Fallback target for a tool-backed CTA when no rail is mounted.
 * REVIEW (brand-imagery wave): U1 wrote this before R8's rename landed, so it
 * still pointed at the RETIRED `retheme` key. That resolves today only
 * because `agentStarterByKey` keeps an alias for it — the alias exists for
 * links minted before the rename, not for links this repo mints now. Point at
 * the current key so the deep link stops depending on a compatibility shim.
 */
export const VISUAL_IDENTITY_STARTER_HREF = '/admin/agents?starter=visual-identity';
