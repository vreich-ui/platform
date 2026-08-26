import { useEffect, useState } from 'react';

import { Button, EmptyState, Skeleton } from './primitives';
import { IconLibrary } from './icons';
import type { EditorialArtifact } from '@core/lib/admin/editorial-assets';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

export function ArtifactStagePreview({ artifact }: { artifact: EditorialArtifact }) {
  const [source, setSource] = useState<string>();
  const [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    let objectUrl: string | undefined;
    setSource(undefined);
    setError(false);
    (async () => {
      try {
        const token = await getToken();
        const response = await fetch(artifact.preview_url, { headers: { Authorization: `Bearer ${token}` } });
        if (!response.ok) throw new Error('preview unavailable');
        objectUrl = URL.createObjectURL(await response.blob());
        if (alive) setSource(objectUrl);
      } catch {
        if (alive) setError(true);
      }
    })();
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, artifact.preview_url, attempt]);

  if (error) {
    return (
      <EmptyState
        severity="error"
        title="Preview unavailable"
        message="The artifact is still indexed, but its preview bytes could not be loaded. Try again without changing the asset."
        action={
          <Button variant="secondary" onClick={() => setAttempt((value) => value + 1)}>
            Try preview again
          </Button>
        }
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
