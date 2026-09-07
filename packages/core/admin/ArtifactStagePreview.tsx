import { useEffect, useMemo, useState } from 'react';

import { Button, EmptyState, Skeleton } from './primitives';
import { IconLibrary } from './icons';
import type { EditorialArtifact } from '@core/lib/admin/editorial-assets';
import { ArtifactPreviewFetchError, createArtifactPreviewLoader } from '@core/lib/admin/artifact-preview-loader';
import { describeArtifactPreviewError } from '@core/lib/admin/artifact-preview-error';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

/**
 * Card-sized rendering (mood board, examples strip, the library picker's
 * thumbnails) only ever needs ~512px on the longest edge; requesting the
 * full-size original for a card that shows it at a few hundred pixels is the
 * bulk of the mood board's "slow, and often not at all" defect (24 cards ×
 * full-size authenticated downloads at once). `admin-get-blob-image` honors
 * a bounded `w` and falls back to the original when it can't produce a
 * rendition, so this only ever narrows what's requested, never what's served
 * to a full-size view or a download path — those call `ArtifactStagePreview`
 * without `size`, which stays 'full'.
 */
export const ARTIFACT_PREVIEW_THUMBNAIL_WIDTH = 512;

/**
 * One loader for the whole admin page: every `ArtifactStagePreview` instance
 * shares its object-URL cache (a reference stays fetched once, across
 * remounts) and its concurrency queue (never more than
 * `DEFAULT_CONCURRENCY_LIMIT` authenticated preview fetches in flight at
 * once, however many cards mount at the same time). See
 * `@core/lib/admin/artifact-preview-loader` for the retry/timeout/queue/cache
 * policy itself and its `node:test` coverage — this file only wires it to
 * React state.
 */
const previewLoader = createArtifactPreviewLoader();

function previewCacheKey(artifact: EditorialArtifact, thumbnail: boolean): string {
  return thumbnail ? `${artifact.preview_url}#w=${ARTIFACT_PREVIEW_THUMBNAIL_WIDTH}` : artifact.preview_url;
}

function previewFetchUrl(artifact: EditorialArtifact, thumbnail: boolean): string {
  if (!thumbnail || artifact.kind !== 'image') return artifact.preview_url;
  const separator = artifact.preview_url.includes('?') ? '&' : '?';
  return `${artifact.preview_url}${separator}w=${ARTIFACT_PREVIEW_THUMBNAIL_WIDTH}`;
}

export interface ArtifactStagePreviewProps {
  artifact: EditorialArtifact;
  /**
   * 'thumbnail' requests the width-bounded rendition for card-sized
   * rendering (mood board / examples / library-picker grids). Leave at the
   * default 'full' anywhere the image is shown at or near its own size, or
   * is offered for download.
   */
  size?: 'full' | 'thumbnail';
}

export function ArtifactStagePreview({ artifact, size = 'full' }: ArtifactStagePreviewProps) {
  const thumbnail = size === 'thumbnail';
  const [source, setSource] = useState<string>();
  /**
   * The HTTP status the fetch failed with, kept so the error state can say
   * what actually happened (`describeArtifactPreviewError`). `null` is "failed
   * with no status" (timeout / dropped connection); `undefined` is "not
   * failed" — the two are different answers and must not collapse.
   */
  const [errorStatus, setErrorStatus] = useState<number | null>();
  const [attempt, setAttempt] = useState(0);
  const cacheKey = useMemo(() => previewCacheKey(artifact, thumbnail), [artifact, thumbnail]);
  const fetchUrl = useMemo(() => previewFetchUrl(artifact, thumbnail), [artifact, thumbnail]);

  useEffect(() => {
    let alive = true;
    setSource(undefined);
    setErrorStatus(undefined);
    (async () => {
      try {
        const token = await getToken();
        const objectUrl = await previewLoader.load(cacheKey, fetchUrl, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (alive) setSource(objectUrl);
      } catch (error) {
        if (!alive) return;
        setErrorStatus(error instanceof ArtifactPreviewFetchError && error.status !== undefined ? error.status : null);
      }
    })();
    return () => {
      alive = false;
      // No revoke here: `previewLoader` owns every object URL it hands out
      // and caches it by `cacheKey` for the page's lifetime — revoking on
      // unmount was exactly what forced a full re-fetch (bytes, auth call,
      // and all) on every remount. See artifact-preview-loader.ts.
    };
  }, [cacheKey, fetchUrl, attempt]);

  if (errorStatus !== undefined) {
    // Every word of this — and whether a retry control exists at all — is
    // decided in `artifact-preview-error.ts`, where node:test can see it.
    // A 404 (the mood-board reference whose bytes were never stored) must not
    // offer "Try again": the control would be a lie, so it does not render.
    const view = describeArtifactPreviewError(errorStatus ?? undefined);
    return (
      <EmptyState
        severity="error"
        title={view.title}
        message={view.message}
        {...(view.canRetry
          ? {
              action: (
                <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
                  Try preview again
                </Button>
              ),
            }
          : {})}
      />
    );
  }
  if (!source) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Preparing {artifact.kind === 'pdf' ? 'document' : 'image'} preview…
        </p>
        <Skeleton variant="rect" height={artifact.kind === 'pdf' ? 620 : 420} />
      </div>
    );
  }
  if (artifact.kind === 'pdf') {
    return (
      <iframe
        src={source}
        title={artifact.label}
        className="h-[min(68dvh,52rem)] w-full rounded-[var(--adm-radius-md)] border-0 bg-white"
      />
    );
  }
  return (
    <div className="grid min-h-[24rem] place-items-center">
      <img src={source} alt={artifact.label} className="max-h-[68dvh] max-w-full object-contain" />
    </div>
  );
}

export function ArtifactPreviewPlaceholder({ title }: { title: string }) {
  return <EmptyState icon={<IconLibrary size={28} />} title={title} message="No generated sample is linked yet." />;
}
