/**
 * Visual Identity is an aggregate lens, not a second theme/template catalog.
 * It reads the existing site singleton (active tokens), theme objects
 * (named alternatives), and safe artifact projections (available logos).
 */
import { useCallback, useEffect, useState } from 'react';

import { AdminShell } from './AdminShell';
import { ArtifactStagePreview } from './ArtifactStagePreview';
import { Badge, Button, Card, EmptyState, Skeleton } from './primitives';
import { IconAlertTriangle, IconExternalLink, IconPalette } from './icons';
import type { SiteIdentity } from '@core/lib/site-identity';
import type { StudioRecord } from '@core/lib/admin/studio-client';
import { fetchStudioData } from '@core/lib/admin/studio-client';
import { fetchEditorialAssets } from '@core/lib/admin/editorial-assets-client';
import { buildVisualIdentityViewModel, type VisualIdentityViewModel } from '@core/lib/admin/visual-identity';

async function getToken(): Promise<string> {
  const auth = await import('@core/lib/admin/goTrueClient');
  return (await auth.getAccessToken()) ?? '';
}

async function fetchSite(siteId: string): Promise<StudioRecord> {
  const { callObjectVerb } = await import('@core/lib/edit-mode/verbs-client');
  const result = await callObjectVerb(getToken, { action: 'get', object_type: 'site', object_id: siteId });
  if (result.status !== 200 || !result.body.record) {
    throw new Error(String(result.body.error ?? 'The publication identity could not be loaded.'));
  }
  return result.body.record as StudioRecord;
}

function Swatches({ colors }: { colors: VisualIdentityViewModel['colors'] }) {
  if (!colors.length)
    return (
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        No active color tokens are available yet.
      </p>
    );
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {colors.map((color) => (
        <div
          key={color.name}
          className="min-w-0 rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] p-2"
        >
          <span
            className="mb-2 block h-12 rounded-[var(--adm-radius-sm)] border border-black/10"
            style={{ backgroundColor: color.value }}
            aria-hidden="true"
          />
          <span className="block truncate text-[length:var(--adm-text-xs)] font-medium text-[var(--adm-text)]">
            {color.name}
          </span>
          <span className="block truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">
            {color.value}
          </span>
        </div>
      ))}
    </div>
  );
}

function Typography({ rows }: { rows: VisualIdentityViewModel['typography'] }) {
  if (!rows.length)
    return (
      <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
        No publication typography tokens are available yet.
      </p>
    );
  return (
    <div className="flex flex-col gap-3">
      {rows.map((row) => (
        <div
          key={row.name}
          className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface)] px-3 py-2"
        >
          <p className="text-[length:var(--adm-text-xs)] font-medium uppercase tracking-wide text-[var(--adm-text-muted)]">
            {row.name}
          </p>
          <p
            className="mt-1 text-[length:var(--adm-text-lg)] text-[var(--adm-text-heading)]"
            style={{ fontFamily: row.value }}
          >
            Evidence-led publishing for real readers.
          </p>
          <p className="truncate text-[length:var(--adm-text-xs)] text-[var(--adm-text-muted)]">{row.value}</p>
        </div>
      ))}
    </div>
  );
}

function IdentityBoard({ model, identity }: { model: VisualIdentityViewModel; identity: SiteIdentity }) {
  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[length:var(--adm-text-xs)] font-semibold uppercase tracking-wide text-[var(--adm-text-muted)]">
            Publication identity
          </p>
          <h1 className="mt-1 text-[length:var(--adm-text-2xl)] font-semibold text-[var(--adm-text-heading)]">
            Visual identity
          </h1>
          <p className="mt-1 max-w-2xl text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            The active visual system drawn from this publication’s site and theme objects.
          </p>
        </div>
        <a
          href={`/admin/content/${encodeURIComponent(identity.siteId)}?type=site`}
          className="adm-focusable inline-flex h-10 items-center gap-2 rounded-[var(--adm-radius-md)] border border-[var(--adm-border-strong)] bg-[var(--adm-surface-raised)] px-4 text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
        >
          Open publication settings <IconExternalLink size={15} />
        </a>
      </header>

      <div className="grid gap-4 xl:grid-cols-[minmax(18rem,0.82fr)_minmax(0,1.18fr)]">
        <Card kicker="Mark" title={model.logoText}>
          <div className="flex flex-col gap-3">
            <div className="rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-[var(--adm-surface-sunken)] p-5">
              <p className="text-[length:var(--adm-text-xl)] font-semibold tracking-[0.16em] text-[var(--adm-text-heading)]">
                {model.logoText}
              </p>
            </div>
            <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
              {model.logoImageConfigured
                ? 'An image logo is configured for the publication.'
                : 'This publication currently uses a text mark.'}
            </p>
            {model.availableLogo ? (
              <details>
                <summary className="cursor-pointer text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)]">
                  Available logo preview: {model.availableLogo.label}
                </summary>
                <div className="mt-3 max-h-72 overflow-auto rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] p-3">
                  <ArtifactStagePreview artifact={model.availableLogo} />
                </div>
              </details>
            ) : null}
          </div>
        </Card>

        <Card kicker="Live reference" title="Representative publication preview">
          {model.previewUrl ? (
            <div className="flex flex-col gap-3">
              <iframe
                title={`Live preview of ${model.publicationName}`}
                src={model.previewUrl}
                className="h-[22rem] w-full rounded-[var(--adm-radius-md)] border border-[var(--adm-border)] bg-white"
              />
              <a
                href={model.previewUrl}
                target="_blank"
                rel="noreferrer"
                className="adm-focusable inline-flex items-center gap-1 self-start text-[length:var(--adm-text-sm)] font-medium text-[var(--adm-accent)] hover:underline"
              >
                Open publication <IconExternalLink size={14} />
              </a>
            </div>
          ) : (
            <EmptyState
              title="Preview address unavailable"
              message="Add a valid publication base address to the site object to show a representative live preview."
            />
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card
          kicker="Active palette"
          title={model.activeThemeLabel ? `Applied from ${model.activeThemeLabel}` : 'Publication color tokens'}
        >
          <Swatches colors={model.colors} />
        </Card>
        <Card kicker="Typography" title="Publication type system">
          <Typography rows={model.typography} />
        </Card>
      </div>

      <Card kicker="Themes" title="Available named visual systems">
        {model.themes.length ? (
          <div className="flex flex-wrap gap-2">
            {model.themes.map((theme) => (
              <a
                key={theme.objectId}
                href={`/admin/content/${encodeURIComponent(theme.objectId)}?type=theme`}
                className="adm-focusable inline-flex items-center gap-2 rounded-[var(--adm-radius-pill)] border border-[var(--adm-border-strong)] px-3 py-1.5 text-[length:var(--adm-text-sm)] text-[var(--adm-text)] hover:bg-[var(--adm-surface-sunken)]"
              >
                <IconPalette size={15} /> {theme.label}
                {theme.active ? <Badge tone="success">active match</Badge> : null}
              </a>
            ))}
          </div>
        ) : (
          <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
            No named theme objects are available. The active tokens above still come directly from the publication
            object.
          </p>
        )}
      </Card>
    </div>
  );
}

function VisualIdentityBody({ identity }: { identity: SiteIdentity }) {
  const [owner, setOwner] = useState<boolean | null>(null);
  const [model, setModel] = useState<VisualIdentityViewModel | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { fetchMe } = await import('@core/lib/admin/users-client');
      const me = await fetchMe(getToken);
      const isOwner = me.roles.includes('owner');
      setOwner(isOwner);
      if (!isOwner) return;
      const [site, studio, assets] = await Promise.all([
        fetchSite(identity.siteId),
        fetchStudioData(getToken),
        fetchEditorialAssets(getToken),
      ]);
      setModel(
        buildVisualIdentityViewModel({
          site,
          themes: studio.themes,
          artifacts: assets.artifacts,
          fallbackName: identity.brandName,
        })
      );
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Visual identity could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, [identity.brandName, identity.siteId]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || owner === null) {
    return (
      <div className="flex flex-col gap-3" role="status" aria-live="polite">
        <p className="text-[length:var(--adm-text-sm)] text-[var(--adm-text-muted)]">
          Loading the publication’s visual system…
        </p>
        <Skeleton variant="rect" height={420} />
      </div>
    );
  }
  if (!owner) {
    return (
      <EmptyState
        title="Visual identity is Owner-only"
        message="Ask a publication Owner to review or change this visual system."
      />
    );
  }
  if (error || !model) {
    return (
      <EmptyState
        icon={<IconAlertTriangle size={26} />}
        title="Visual identity unavailable"
        message={error ?? 'The visual identity records could not be loaded.'}
        action={
          <Button variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        }
      />
    );
  }
  return <IdentityBoard model={model} identity={identity} />;
}

export default function VisualIdentityWorkspace({ identity }: { identity: SiteIdentity }) {
  return (
    <AdminShell currentPath="/admin/settings/visual-identity" title="Visual identity" identity={identity}>
      <VisualIdentityBody identity={identity} />
    </AdminShell>
  );
}
