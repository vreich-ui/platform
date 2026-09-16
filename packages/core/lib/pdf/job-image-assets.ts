/**
 * Merging two sources of render-job image assets.
 *
 * WHY THIS EXISTS. A template-render PDF job carries `data` (the slot values)
 * and `assets: {images: [...]}` (the bytes those slots address, as
 * `https://render.assets.invalid/<assetId>`). When the article mapper builds
 * the data, it ALLOCATES those ids itself, so its data and its assets are one
 * pair produced by one pass and are meaningless apart. A caller may
 * nonetheless supply assets of its own — a brand logo the template references
 * directly is the live case — and those must survive.
 *
 * So: the mapper's entries win on a shared id, because they are the ones its
 * data names; the caller's other entries are kept. Merging rather than
 * replacing is the whole point — replacing in either direction is what
 * produced a PDF with a broken hero on a job that reported success.
 *
 * pdf-tool reads an entry's id as `assetId ?? name ?? id` (job-assets.ts's
 * `entryId`), so that is the identity used here. An entry carrying none of
 * the three has no identity to collide on and is passed through untouched
 * rather than dropped — pdf-tool's own validation is the arbiter of a
 * malformed entry, not this merge.
 */

export type JobImageAssets = { images?: unknown[] };

const entryId = (entry: unknown): string | undefined => {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  for (const key of ['assetId', 'name', 'id'] as const) {
    const value = record[key];
    if (typeof value === 'string' && value.length > 0) return value;
  }
  return undefined;
};

const imagesOf = (assets: JobImageAssets | undefined): unknown[] =>
  Array.isArray(assets?.images) ? assets.images : [];

/**
 * `preferred` wins on a shared id. Returns undefined only when neither side
 * carries a single image — a job with no assets must send no `assets` key at
 * all rather than an empty one.
 */
export function mergeJobImageAssets(
  other: JobImageAssets | undefined,
  preferred: JobImageAssets | undefined
): JobImageAssets | undefined {
  const preferredImages = imagesOf(preferred);
  const otherImages = imagesOf(other);
  if (!preferredImages.length && !otherImages.length) return undefined;

  const claimed = new Set(preferredImages.map(entryId).filter((id): id is string => typeof id === 'string'));
  const extras = otherImages.filter((entry) => {
    const id = entryId(entry);
    return id === undefined || !claimed.has(id);
  });
  return { images: [...preferredImages, ...extras] };
}
