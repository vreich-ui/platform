import type sharpType from 'sharp';

// sharp's native libvips binding dominates cold-start module evaluation for
// every function that bundles this file (artifact-upload's endpoint
// included) — same rationale as image-validation.ts's loadSharp and
// brand-imagery-proxy.ts's loadSharp. Loaded on first raster-image bound
// instead of at import; cached per runtime instance. A caller (tests, in
// particular) may supply its own `loadSharpOverride` instead of pulling in
// the real native binding.
let cachedSharp: typeof sharpType | undefined;

const loadSharp = async (): Promise<typeof sharpType> => {
  if (!cachedSharp) {
    cachedSharp = (await import('sharp')).default;
  }
  return cachedSharp;
};

const normalizeContentType = (contentType: string) => contentType.toLowerCase().split(';')[0]?.trim() ?? '';

/**
 * Whether an uploaded artifact looks like a raster image worth bounding —
 * exactly the same test artifact-upload.ts's downstream saveArtifactBytes
 * validation (validateArtifactBytes in server/lib/artifact-upload.ts) uses
 * for its own image check. Keeping the two in lockstep means anything this
 * module touches is exactly what that validation also treats as an image;
 * anything it skips (PDFs, generic `data` artifacts, …) is guaranteed to
 * reach saveArtifactBytes byte-identical.
 */
export const isRasterImageArtifact = (artifactKind: string, contentType: string) =>
  artifactKind === 'image' || normalizeContentType(contentType).startsWith('image/');

export type ArtifactImageDimensions = { width: number; height: number };

export type BoundArtifactImageDimensionsInput = {
  bytes: Buffer;
  artifactKind: string;
  contentType: string;
  /** Longest-edge ceiling in pixels. Caller-supplied so this stays a pure
   * decision function — artifact-upload.ts reads the configured value. */
  maxDimensionPx: number;
  /** Test-only seam: inject a sharp-like loader instead of the real native
   * module. Production callers omit this and get the real lazy-loaded sharp. */
  loadSharpOverride?: () => Promise<typeof sharpType>;
};

export type BoundArtifactImageDimensionsResult = {
  /** The bytes to store: the original buffer, untouched (same reference),
   * whenever no resize was needed or possible. */
  bytes: Buffer;
  resized: boolean;
  /** Present whenever the source could be decoded, resized or not — absent
   * for non-image artifacts and for bytes sharp could not decode. */
  dimensions?: { original: ArtifactImageDimensions; stored: ArtifactImageDimensions };
};

/**
 * Bounds the longest edge of an uploaded raster image to `maxDimensionPx`,
 * preserving aspect ratio, using `fit: "inside"` + `withoutEnlargement: true`
 * — the same policy pdf-tool's import path uses. Never crops, never
 * upscales. Never touches a non-image artifact (PDFs included) or a small
 * image already within bound — both come back as the exact same input
 * buffer, byte-identical, with no round-trip through sharp. Output format is
 * whatever sharp's default `.toBuffer()` produces for the decoded input
 * (its own input format, absent an explicit `.toFormat()`/`.jpeg()`/etc
 * call, which this function deliberately never makes) — this never converts
 * format.
 *
 * Bytes sharp cannot decode also come back unchanged: this bound is an
 * optimization sitting in front of saveArtifactBytes' own image-bytes
 * validation, never a second, new way for an upload to fail. A decode
 * failure here — or a missing/broken sharp install — resolves with
 * `resized: false` rather than throwing.
 */
export const boundArtifactImageDimensions = async ({
  bytes,
  artifactKind,
  contentType,
  maxDimensionPx,
  loadSharpOverride,
}: BoundArtifactImageDimensionsInput): Promise<BoundArtifactImageDimensionsResult> => {
  if (!isRasterImageArtifact(artifactKind, contentType)) {
    return { bytes, resized: false };
  }

  let sharp: typeof sharpType;
  try {
    sharp = await (loadSharpOverride ?? loadSharp)();
  } catch {
    return { bytes, resized: false };
  }

  let width: number | undefined;
  let height: number | undefined;
  try {
    const metadata = await sharp(bytes, { failOn: 'error' }).metadata();
    width = metadata.width;
    height = metadata.height;
  } catch {
    return { bytes, resized: false };
  }

  if (!width || !height || width <= 0 || height <= 0) {
    return { bytes, resized: false };
  }

  const original: ArtifactImageDimensions = { width, height };

  if (Math.max(width, height) <= maxDimensionPx) {
    // Already within bound: hand back the original bytes untouched rather
    // than round-tripping through sharp for a resize withoutEnlargement
    // would refuse to perform anyway. Also what guarantees a small image
    // never gets upscaled.
    return { bytes, resized: false, dimensions: { original, stored: original } };
  }

  let resizedBytes: Buffer;
  try {
    resizedBytes = await sharp(bytes, { failOn: 'error' })
      .resize(maxDimensionPx, maxDimensionPx, { fit: 'inside', withoutEnlargement: true })
      .toBuffer();
  } catch {
    return { bytes, resized: false, dimensions: { original, stored: original } };
  }

  let stored: ArtifactImageDimensions = original;
  try {
    const storedMetadata = await sharp(resizedBytes).metadata();
    if (storedMetadata.width && storedMetadata.height) {
      stored = { width: storedMetadata.width, height: storedMetadata.height };
    }
  } catch {
    // Best-effort provenance only; the resize itself already succeeded.
  }

  return { bytes: resizedBytes, resized: true, dimensions: { original, stored } };
};
