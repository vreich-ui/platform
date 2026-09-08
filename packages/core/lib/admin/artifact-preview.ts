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

/**
 * Mirrors admin-get-blob-image's artifactImageBlobKeyPattern → the `artifacts` store.
 *
 * The `<requestId>` segment stays deliberately loose on charset: keys in this
 * store are not all minted by `createArtifactBlobKey` (which validates the
 * segment against `agents-naming.ts`'s REQUEST_ID_RE), and pdf-tool writes
 * into the same store through a storage grant using its own
 * `safeRequestSegment` sanitiser. Narrowing the charset would refuse existing,
 * legitimate keys. What it does NOT stay loose about is traversal: the segment
 * is put through `isTraversalSafePathSegment` below, exactly as the thumbnail
 * id segment is.
 */
export const ADMIN_PREVIEWABLE_IMAGE_REF_RE = /^image\/[a-z0-9._-]+\/[a-f0-9]{64}(?:\.[a-z0-9]+)?$/i;

/**
 * Mirrors admin-get-blob-image's templateThumbnailBlobKeyPattern → the
 * `pdf-templates` store. pdf-tool writes exactly
 * `thumbnails/<templateId>/v<n>.png` (pdf-template-store.ts's
 * `pdfTemplateThumbnailKey`), so this allows exactly that and nothing else.
 *
 * The id segment now covers pdf-tool's real id space: its writer-side
 * `safeSegment` (pdf-tool netlify/lib/pdf-template-store.ts) sanitises an id
 * to `[a-zA-Z0-9._-]` — dots INCLUDED — so `drlurie.article.v1` is a legal
 * template id whose thumbnail this gate previously refused. Dots are
 * therefore admitted here, and the two dangerous spellings a dot enables
 * (`.`/`..`, and `..` anywhere inside the segment) are refused by
 * `isTraversalSafePathSegment` below rather than by this regex — a
 * traversal guard a reviewer should be able to read without parsing a
 * pattern.
 *
 * Everything ELSE about the shape is exactly as narrow as it was: the first
 * character must be a letter or digit (so no leading dot, dash or
 * underscore), the id is length-bounded, no `/` means the key can never grow
 * a third path segment, the version is digits only, and the extension is
 * `.png` — so `thumbnails/a/b/v1.png`, `thumbnails/tpl/vlatest.png` and
 * `thumbnails/tpl/v1.svg` all still fail here rather than relying on
 * downstream path handling.
 */
export const ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE = /^thumbnails\/[a-z0-9][a-z0-9._-]{0,127}\/v\d{1,9}\.png$/i;

/*
 * FOLLOW-UP (no tracker id — recorded here because this is the file that pays
 * for it): the accepted id shape above and pdf-tool's `safeSegment` id space
 * are the SAME contract maintained by hand in two repos, and they have now
 * drifted once (dots) and been reconciled by widening the reader. Widening
 * the reader is the cheap fix, not the durable one — it will be needed again
 * the next time the writer's charset moves. The durable fix is to converge
 * them at the source: pdf-tool mints and validates template ids against one
 * published shape, and both this gate and admin-get-blob-image.ts restate
 * that single shape instead of chasing it. That is a cross-repo contract
 * change, deliberately out of scope for a reader-side fix.
 *
 * The artifact key's `<requestId>` segment has the same shape of problem from
 * the other direction: the platform mints it through
 * `agents-naming.ts`'s `validateRequestId` (`[a-z0-9_]` only, so a dot cannot
 * survive), while pdf-tool writes into the same store with its own
 * `safeRequestSegment` and — absent a descriptor `requestIdPattern`, which
 * this platform does not send — no request-id grammar at all. That is why the
 * charset here stays loose and only traversal is guarded. The same
 * convergence would fix both segments: one published id shape, minted and
 * validated at the writers, restated by these readers.
 */

/**
 * The traversal guard, kept as its own predicate (and out of the regexes) so
 * it can be read and tested on its own. `.` and `..` are path-relative
 * segments, and a `..` ANYWHERE in the segment is refused too — not
 * sanitised — because this gate's job is to reject a key outright, before any
 * store is opened, rather than to repair one. An all-dots segment is covered
 * by the same three clauses: `.` is named, and every longer run of dots
 * contains `..`.
 *
 * ONE predicate for BOTH key shapes (hence the shape-neutral name): the
 * artifact key's `<requestId>` segment and the thumbnail key's `<templateId>`
 * segment are the same kind of thing — a caller-influenced middle path
 * segment — and neither may express traversal. Mirrored verbatim in
 * admin-get-blob-image.ts.
 */
export const isTraversalSafePathSegment = (segment: string): boolean =>
  segment !== '.' && segment !== '..' && !segment.includes('..');

/** The middle segment of a `<prefix>/<id>/<filename>` blob key (empty when there is none). */
const blobKeyIdSegment = (blobKey: string): string => blobKey.split('/')[1] ?? '';

/** Shape AND traversal guard — the only way a key becomes an artifact here. */
export const isAdminPreviewableArtifactKey = (blobKey: string): boolean =>
  ADMIN_PREVIEWABLE_IMAGE_REF_RE.test(blobKey) && isTraversalSafePathSegment(blobKeyIdSegment(blobKey));

/** Shape AND traversal guard — the only way a key becomes a template thumbnail here. */
export const isAdminPreviewableTemplateThumbnailKey = (blobKey: string): boolean =>
  ADMIN_PREVIEWABLE_TEMPLATE_THUMBNAIL_REF_RE.test(blobKey) &&
  isTraversalSafePathSegment(blobKeyIdSegment(blobKey));

/** Which store a previewable key resolves to; undefined = not previewable at all. */
export type AdminPreviewableBlobKeyShape = 'artifact' | 'template-thumbnail';

export const classifyAdminPreviewableBlobKey = (blobKey: string): AdminPreviewableBlobKeyShape | undefined => {
  const trimmed = blobKey.trim();
  if (isAdminPreviewableArtifactKey(trimmed)) return 'artifact';
  if (isAdminPreviewableTemplateThumbnailKey(trimmed)) return 'template-thumbnail';

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
