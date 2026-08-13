/**
 * Screenshot normalization for the capture fidelity diff (T12.10).
 *
 * The pixel twin of `scripts/lib/html-normalize.mjs`, and it follows that
 * file's discipline exactly: two screenshots of the "same" block are compared
 * only after both sides pass through `normalizeScreenshotPair`, which removes
 * exactly the classes of difference that carry no meaning to a reader —
 *
 *   1. alpha — both sides are flattened onto white and reduced to three
 *      channels. A block screenshot over a transparent page background and the
 *      same block over an opaque white one are the same picture; the alpha
 *      channel is a compositing artifact, not content.
 *   2. raster — both sides are resized to ONE comparison raster, derived from
 *      the SOURCE's aspect ratio at a fixed width. This is what makes the diff
 *      a comparison of *pictures* rather than of pixel grids: an emitted block
 *      is legitimately a different height than the source block it maps to, and
 *      without a common raster the comparison is undefined (the pre-T12.10
 *      scorer resized only the preview, which made a 1-px height difference
 *      shear every row below it). Resampling to a common raster also averages
 *      away sub-pixel text antialiasing and font hinting — the differences a
 *      reader cannot see and NOBODY may chase with CSS (T12.10 non-goal).
 *
 * Everything else — hue, contrast, proportion, the presence or absence of an
 * element, where things sit inside the frame — is content and is deliberately
 * left alone: a difference there MUST lower the score. Notably NOT done, and
 * not to be added: blurring, per-channel tolerance, color quantization, and
 * ignore-regions. Each of those hides a real difference, and the rules here are
 * the ceiling of allowed variance, not a place to park an inconvenient diff.
 *
 * Determinism is a requirement, not a nicety: the fidelity score must be
 * reproducible across two runs on the same input, so the raster is a pure
 * function of the source dimensions and the resampling kernel is pinned.
 */
import sharp from 'sharp';

/** Fixed comparison-raster width, in pixels. Pinned: it is part of the score. */
export const COMPARISON_RASTER_WIDTH = 320;
/** Upper bound on raster height, so a full-page column cannot blow up the diff. */
export const COMPARISON_RASTER_MAX_HEIGHT = 4_096;
/** Pinned resampling kernel — changing it changes every score. */
export const COMPARISON_RASTER_KERNEL = sharp.kernel.lanczos3;
export const NORMALIZATION_ID = 'flatten_rgb_common_raster.v1';

export class ScreenshotNormalizeError extends Error {}

/** The comparison raster for a source block: fixed width, source aspect ratio. */
export function comparisonRaster({ width, height }) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0)
    throw new ScreenshotNormalizeError('Screenshot dimensions are unavailable.');
  const scaled = Math.round((COMPARISON_RASTER_WIDTH * height) / width);
  return {
    width: COMPARISON_RASTER_WIDTH,
    height: Math.min(COMPARISON_RASTER_MAX_HEIGHT, Math.max(1, scaled)),
  };
}

const toRaster = (image, raster) =>
  image
    .flatten({ background: '#ffffff' })
    .resize(raster.width, raster.height, { fit: 'fill', kernel: COMPARISON_RASTER_KERNEL })
    .removeAlpha()
    .raw()
    .toBuffer();

/**
 * Read both screenshots and return their normalized raw RGB buffers plus the
 * raster they share. Buffer lengths are guaranteed equal.
 */
export async function normalizeScreenshotPair(sourcePath, previewPath) {
  const [sourceMeta, previewMeta] = await Promise.all([sharp(sourcePath).metadata(), sharp(previewPath).metadata()]);
  if (!sourceMeta.width || !sourceMeta.height || !previewMeta.width || !previewMeta.height)
    throw new ScreenshotNormalizeError('Screenshot dimensions are unavailable.');
  const raster = comparisonRaster({ width: sourceMeta.width, height: sourceMeta.height });
  const [source, preview] = await Promise.all([
    toRaster(sharp(sourcePath), raster),
    toRaster(sharp(previewPath), raster),
  ]);
  if (source.length !== preview.length) throw new ScreenshotNormalizeError('Normalized screenshot lengths differ.');
  return {
    source,
    preview,
    raster,
    normalization: NORMALIZATION_ID,
    dimensions: {
      source: { width: sourceMeta.width, height: sourceMeta.height },
      preview: { width: previewMeta.width, height: previewMeta.height },
    },
  };
}
