/**
 * Admin-editor preview support for image artifact references.
 *
 * A Major Key artifact ref (image/{requestId}/{sha256}.{ext}) is a blob-store key, not a
 * URL, so the admin renderer historically showed a placeholder. The identity-gated
 * admin-get-blob-image function CAN serve those bytes; this module builds the endpoint URL
 * and an authenticated loader the renderer uses to swap the placeholder for a real preview.
 *
 * Kept free of DOM APIs so it is unit-testable in Node.
 */

/**
 * TWO SHAPES, TWO STORES. Each constant below describes exactly one blob-key
 * shape and maps to exactly ONE backing store on the server; they are kept
 * deliberately separate (rather than merged into one looser pattern) because
 * "which store may these bytes come from" is an authorization decision, and a
 * single widened regex would silently let one shape reach the other's store.
 * The server (admin-get-blob-image.ts) makes the same distinction with its own
 * copies of these patterns and resolves the store from the shape — it never
 * takes a store name from the caller. Keep the two files in step.
 */

/** Mirrors admin-get-blob-image's artifactImageBlobKeyPattern → the `artifacts` store. */
export const ADMIN_PREVIEWABLE_IMAGE_REF_RE = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

/**
 * Mirrors admin-get-blob-image's templateThumbnailBlobKeyPattern → the
 * `pdf-templates` store. pdf-tool writes exactly
 * `thumbnails/<templateId>/v<n>.png` (pdf-template-store.ts's
 * `pdfTemplateThumbnailKey`), so this allows exactly that and nothing else.
 *
 * The id segment is bounded far more tightly than pdf-tool's own `safeSegment`
 * (which also permits `.`): no dot means no `.`/`..` segment can ever appear,
 * and no `/` means the key can never grow a third path segment — so
 * `thumbnails/../../secret.png` and `thumbnails/a/b/v1.png` both fail here
 * rather than relying on downstream path handling. The consequence is
 * deliberate and stated: a template whose id contains a dot is NOT previewable
 * through this gate.
 */
export const ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE = /^thumbnails\/[a-z0-9][a-z0-9_-]{0,127}\/v\d{1,9}\.png$/i;

/** Which store a previewable key resolves to; undefined = not previewable at all. */
export type AdminPreviewableBlobKeyShape = 'artifact' | 'template-thumbnail';

export const classifyAdminPreviewableBlobKey = (blobKey: string): AdminPreviewableBlobKeyShape | undefined => {
  const trimmed = blobKey.trim();
  if (ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(trimmed)) return 'artifact';
  if (ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test(trimmed)) return 'template-thumbnail';

  return undefined;
};

/**
 * Note there is no store/kind parameter on the URL: the server re-derives the
 * shape from `blobKey` itself. A caller therefore cannot ask for a key to be
 * read out of a store it does not belong to.
 */
export const getAdminBlobImageEndpoint = (blobKey: string): string | undefined => {
  const trimmed = blobKey.trim();
  if (!classifyAdminPreviewableBlobKey(trimmed)) return undefined;

  return `/.netlify/functions/admin-get-blob-image?blobKey=${encodeURIComponent(trimmed)}`;
};

export type ArtifactPreviewLoader = (blobKey: string) => Promise<string | undefined>;

type CreateLoaderOptions = {
  /** Returns a fresh Netlify Identity bearer token (publish.astro's getToken). */
  getToken: () => Promise<string>;
  fetchFn?: typeof fetch;
  createObjectUrl?: (blob: Blob) => string;
};

/**
 * Build a loader that fetches artifact bytes through admin-get-blob-image with the admin's
 * identity token and returns an object URL for an <img> src. Resolves undefined on any
 * failure so callers keep their placeholder instead of surfacing an error state.
 */
export const createAdminArtifactPreviewLoader = ({
  getToken,
  fetchFn = fetch,
  createObjectUrl = (blob) => URL.createObjectURL(blob),
}: CreateLoaderOptions): ArtifactPreviewLoader => {
  return async (blobKey: string) => {
    const endpoint = getAdminBlobImageEndpoint(blobKey);
    if (!endpoint) return undefined;

    try {
      const token = await getToken();
      const response = await fetchFn(endpoint, { headers: { Authorization: `Bearer ${token}` } });
      if (!response.ok) return undefined;

      return createObjectUrl(await response.blob());
    } catch {
      return undefined;
    }
  };
};
