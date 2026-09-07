/**
 * What a failed artifact preview actually says to an editor.
 *
 * WHY THIS IS A MODULE AND NOT JSX. `ArtifactStagePreview.tsx` used to hold
 * one hardcoded error state: "The artifact is still indexed, but its preview
 * bytes could not be loaded — even after automatic retries. Try again, or
 * check your connection."
 *
 * Two things were wrong with it, and both are decisions, not markup:
 *
 *   1. IT CLAIMED A RETRY THAT NEVER HAPPENED. `artifact-preview-loader.ts`'s
 *      `fetchWithRetry` fails a non-retryable status (any 4xx but 408/429)
 *      IMMEDIATELY, without spending its remaining attempts — "retrying a 403
 *      or 404 cannot make it succeed" is that function's own comment. So the
 *      one case the copy was most often shown for is precisely the case where
 *      no retry was attempted.
 *
 *   2. IT OFFERED "Try again" ON A PERMANENT FAILURE. A 404 from
 *      `admin-get-blob-image` means the blobKey names no artifact — a mood
 *      board reference whose bytes were never stored (see
 *      object-validate.ts's `checkVisualStandardAssetRefs` for how those
 *      landed). No amount of retrying fixes it, and "check your connection"
 *      sends the editor to debug their wifi over a data problem.
 *
 * This repo has no DOM/component test stack (`tsconfig.test.json` excludes
 * `packages/core/admin/**\/*.tsx`), so a decision made in JSX is a decision
 * nothing tests — the same rule `article-pdf-card.ts` exists under. The
 * component renders what this returns; `node:test` pins what that is.
 *
 * PROVABLE, NEVER CLAIMED: every branch below is keyed off the HTTP status
 * actually received. An error with no status (a network rejection, an abort,
 * a timeout) is genuinely unknown and is described as unknown — never
 * upgraded into a confident diagnosis.
 */

export interface ArtifactPreviewErrorView {
  title: string;
  message: string;
  /**
   * Whether to offer the "Try preview again" control at all. False means the
   * failure is permanent for this blobKey and a retry button would be a lie —
   * the control must not render (never render it disabled with an invented
   * reason).
   */
  canRetry: boolean;
}

/** Mirrors `isRetryableStatus` in artifact-preview-loader.ts. */
const isRetryableStatus = (status: number): boolean => status === 408 || status === 429 || status >= 500;

/**
 * `status` is the HTTP status the preview fetch failed with, or undefined
 * when it never got one (network rejection, abort, per-attempt timeout).
 */
export function describeArtifactPreviewError(status?: number): ArtifactPreviewErrorView {
  if (status === 404) {
    return {
      title: 'Image not in the store',
      message:
        'This reference points at an artifact that does not exist — nothing was ever stored under its key, or it ' +
        'has since been removed. Retrying cannot fix it: remove the reference and add the image again through ' +
        'Import references or the image library.',
      canRetry: false,
    };
  }
  if (status === 401 || status === 403) {
    return {
      title: 'Not allowed to load this preview',
      message:
        'Your session is not authorized to read this artifact. Sign in again, and if it keeps happening ask an ' +
        'owner to check your role.',
      canRetry: false,
    };
  }
  if (status === 409) {
    return {
      title: 'Preview is ambiguous',
      message:
        'More than one stored blob matches this reference, so the store cannot say which bytes are the right ' +
        'ones. Re-import the image to get a single canonical key.',
      canRetry: false,
    };
  }
  if (status === 422) {
    return {
      title: 'Image bytes are not usable',
      message:
        'The stored bytes for this reference did not pass image validation — they may be truncated or not an ' +
        'image at all. Re-import the image.',
      canRetry: false,
    };
  }
  if (status !== undefined && !isRetryableStatus(status)) {
    // A 4xx this admin has no specific copy for. Still permanent — say so
    // plainly rather than inventing a cause.
    return {
      title: 'Preview unavailable',
      message: `The preview request was rejected (HTTP ${status}). Retrying will not change that — re-import the image, or report this.`,
      canRetry: false,
    };
  }
  if (status !== undefined) {
    // 5xx / 408 / 429 — the loader DID exhaust its retries on these.
    return {
      title: 'Preview unavailable',
      message: `The artifact is indexed, but the store did not return its bytes (HTTP ${status}) after automatic retries. Try again in a moment.`,
      canRetry: true,
    };
  }
  return {
    title: 'Preview unavailable',
    message:
      'The preview did not load — the request timed out or the connection dropped. Automatic retries did not ' +
      'succeed either. Try again, or check your connection.',
    canRetry: true,
  };
}
